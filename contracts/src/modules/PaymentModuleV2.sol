// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ERC7579Utils, Execution, CallType} from "@openzeppelin/contracts/account/utils/draft-ERC7579Utils.sol";
import {IERC7579Execution, MODULE_TYPE_EXECUTOR} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {InvoiceAuth, InvoiceAuthLib} from "../libraries/InvoiceAuth.sol";
import {IPaymentModule} from "../l1/IPaymentModule.sol";
import {IRoleCache, TazorRoles} from "../interfaces/IRoleCache.sol";
import {IWBSoulRegistry, IWBSoulAttributeRegistry} from "../interfaces/IWBSoul.sol";
import {RevocationList} from "./RevocationList.sol";

interface IL1Block {
    function number() external view returns (uint64);
}

/// @notice ERC-7579 executor that pays USDT invoices from a TazorAccount, with company policy:
/// per-payment and 30-day limits, a new-payee delay on every payee, fresh-role proofs for large payments, 10-minute
/// provisional grants, contractor expiry, capped agents, and a time-locked exit to the company's own accounts.
/// One deployment serves all accounts. Mandate pulls (MandateModuleV2) are not counted against the limits.
contract PaymentModuleV2 is IPaymentModule, EIP712 {
    using SafeCast for uint256;

    bytes32 public constant PAYMENT_RUN_TYPEHASH = keccak256("PaymentRun(bytes32[] authHashes)");
    bytes32 public constant ADD_PAYEE_TYPEHASH = keccak256("AddPayee(address account,address payee,uint256 deadline)");
    bytes32 public constant PROVISIONAL_GRANT_TYPEHASH = keccak256(
        "ProvisionalGrant(address account,address grantee,uint256 roles,uint64 validUntil,uint256 deadline)"
    );
    bytes32 public constant APPROVER_EXPIRY_TYPEHASH =
        keccak256("ApproverExpiry(address account,address approver,uint64 until,uint256 deadline)");
    bytes32 public constant REQUEST_EXIT_TYPEHASH =
        keccak256("RequestExit(address account,uint256 exitIndex,uint256 deadline)");
    bytes32 public constant CANCEL_EXIT_TYPEHASH = keccak256("CancelExit(address account,uint256 deadline)");

    uint256 public constant WINDOW = 30 days;
    uint256 public constant MAX_GRANT_DURATION = 600;
    /// Provisional grants can carry these roles only (never ROLE_TAZOR_ADMIN).
    uint256 public constant PROVISIONAL_ROLES = TazorRoles.ROLE_APPROVER | TazorRoles.ROLE_AGENT;
    IL1Block public constant L1_BLOCK = IL1Block(0x4200000000000000000000000000000000000015);
    bytes20 private constant VERIFIED = bytes20(uint160(1));

    struct ConfigV2 {
        address registry;
        uint96 twoApproverThreshold;
        uint96 perPaymentLimit;
        uint96 monthlyLimit;
        uint32 payeeDelay;
        uint96 freshThreshold;
        uint32 maxCacheAge;
        uint96 agentMonthlyCap;
        address[] exitAccounts;
        uint32 exitDelay;
    }

    /// v1-shaped view, so modules written against v1's configOf keep decoding it.
    struct Config {
        address registry;
        uint96 twoApproverThreshold;
    }

    /// @dev Hot fields in four slots; exitAccounts separately.
    struct Stored {
        address registry; // slot 0
        uint32 payeeDelay;
        uint32 maxCacheAge;
        uint32 exitDelay;
        uint96 twoApproverThreshold; // slot 1
        uint96 perPaymentLimit;
        uint64 installedAt;
        uint96 monthlyLimit; // slot 2
        uint96 freshThreshold;
        uint96 agentMonthlyCap; // slot 3
    }

    struct Window {
        uint32 index;
        uint96 spent;
        uint32 agentIndex;
        uint96 agentSpent;
    }

    struct Grant {
        uint192 roles;
        uint64 validUntil;
    }

    struct Exit {
        address to;
        uint64 executeAfter;
    }

    IERC20 public immutable usdt;
    IWBSoulRegistry public immutable soulRegistry;
    IWBSoulAttributeRegistry public immutable attributeRegistry;
    address public immutable isVerifiedAttribute;
    IRoleCache public immutable roleCache;
    RevocationList public immutable revocationList;
    address public immutable ensGateAlias;
    /// @notice Runtime code hash of an ERC-1167 clone of the TazorAccount implementation (isTazorAccount).
    /// Informational for other modules; it does not exempt a payee from the payee delay.
    bytes32 public immutable tazorAccountCodeHash;

    mapping(address account => Stored) private _configs;
    mapping(address account => address[]) private _exitAccounts;
    mapping(address account => Window) private _windows;
    mapping(address account => mapping(uint256 word => uint256 bits)) public paidBitmap;
    mapping(address account => mapping(address payee => uint64)) public payeeAddedAt;
    mapping(address account => mapping(address grantee => Grant)) public provisionalGrants;
    mapping(address account => mapping(address approver => uint64)) public approverExpiry;
    mapping(address account => Exit) public pendingExit;
    mapping(bytes32 digest => bool) public signatureUsed;

    event InvoicePaid(address indexed account, uint256 indexed nonce, address payee, uint256 amount, bool viaL1);
    event AgentPaid(address indexed account, uint256 indexed nonce, address indexed agent);
    event PayeeAdded(address indexed account, address indexed payee, address admin, uint64 allowedFrom);
    event ProvisionalGranted(address indexed account, address indexed grantee, uint256 roles, uint64 validUntil);
    event ApproverExpirySet(address indexed account, address indexed approver, uint64 until);
    event ExitRequested(address indexed account, address indexed to, uint64 executeAfter, address requester);
    event ExitCancelled(address indexed account, address approver);
    event ExitExecuted(address indexed account, address indexed to, uint256 amount);

    error PaymentNotInstalled(address account);
    error PaymentAlreadyInstalled(address account);
    error PaymentInvalidConfig();
    error PaymentWrongAccount(address expected, address actual);
    error PaymentExpired(uint256 nonce);
    error PaymentNonceUsed(uint256 nonce);
    error PaymentLengthMismatch();
    error PaymentNotEnoughApprovers(uint256 required, uint256 provided);
    error PaymentInvalidSignature(address signer);
    error PaymentNotVerified(address approver);
    error PaymentMissingRole(address approver);
    error PaymentStaleRoles(address approver, uint64 cachedAt, uint64 required);
    error PaymentDuplicateSoul(address approver);
    error PaymentNotEnsGate(address sender);
    error PaymentWrongRegistry(address registry);
    error PaymentTransferFailed();
    error PaymentEmptyRun();
    error PaymentOverPerPaymentLimit(uint256 limit, uint256 amount);
    error PaymentOverMonthlyLimit(uint256 available, uint256 amount);
    error PaymentOverAgentCap(uint256 available, uint256 amount);
    error PaymentPayeeNotAllowed(address payee);
    error PaymentDeadlinePassed();
    error PaymentSignatureUsed();
    error PaymentInvalidGrant();
    error PaymentNoExit(address account);
    error PaymentExitPending(address account);
    error PaymentExitTooEarly(uint64 executeAfter);
    error PaymentBadExitIndex(uint256 index);

    constructor(
        IERC20 usdt_,
        IWBSoulRegistry soulRegistry_,
        IWBSoulAttributeRegistry attributeRegistry_,
        address isVerifiedAttribute_,
        IRoleCache roleCache_,
        address ensGateAlias_,
        address tazorAccountImplementation
    ) EIP712("Tazor", "2") {
        usdt = usdt_;
        soulRegistry = soulRegistry_;
        attributeRegistry = attributeRegistry_;
        isVerifiedAttribute = isVerifiedAttribute_;
        roleCache = roleCache_;
        ensGateAlias = ensGateAlias_;
        tazorAccountCodeHash = keccak256(
            abi.encodePacked(hex"363d3d373d3d3d363d73", tazorAccountImplementation, hex"5af43d82803e903d91602b57fd5bf3")
        );
        revocationList = new RevocationList();
    }

    // ---- ERC-7579 module

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_EXECUTOR;
    }

    /// @param data abi.encode(ConfigV2)
    function onInstall(bytes calldata data) external {
        require(_configs[msg.sender].registry == address(0), PaymentAlreadyInstalled(msg.sender));
        ConfigV2 memory c = abi.decode(data, (ConfigV2));
        require(
            c.registry != address(0) && c.perPaymentLimit != 0 && c.monthlyLimit >= c.perPaymentLimit
                && (c.exitAccounts.length == 0 || c.exitDelay != 0),
            PaymentInvalidConfig()
        );
        _configs[msg.sender] = Stored({
            registry: c.registry,
            payeeDelay: c.payeeDelay,
            maxCacheAge: c.maxCacheAge,
            exitDelay: c.exitDelay,
            twoApproverThreshold: c.twoApproverThreshold,
            perPaymentLimit: c.perPaymentLimit,
            installedAt: uint64(block.timestamp),
            monthlyLimit: c.monthlyLimit,
            freshThreshold: c.freshThreshold,
            agentMonthlyCap: c.agentMonthlyCap
        });
        _exitAccounts[msg.sender] = c.exitAccounts;
    }

    function onUninstall(bytes calldata) external {
        delete _configs[msg.sender];
        delete _exitAccounts[msg.sender];
        delete _windows[msg.sender];
        delete pendingExit[msg.sender];
    }

    // ---- payments

    function payOne(address account, InvoiceAuth calldata auth, address[] calldata approvers, bytes[] calldata signatures)
        external
    {
        Stored memory c = _config(account);
        _consume(account, auth);
        _checkPayee(account, c, auth.payee);
        _spend(account, c, auth.amount);
        _checkApprovers(account, c, auth.amount, invoiceDigest(auth), approvers, signatures, true);
        _transfer(account, auth.payee, auth.amount);
        emit InvoicePaid(account, auth.nonce, auth.payee, auth.amount, false);
    }

    /// @notice L2 leg of the Ethereum fallback: EnsGate already checked the ENS approver roles live,
    /// so the role cache (and its freshness) is not consulted; every other rule applies.
    function payFromL1(
        address registry,
        address account,
        InvoiceAuth calldata auth,
        address[] calldata approvers,
        bytes[] calldata signatures
    ) external {
        require(msg.sender == ensGateAlias, PaymentNotEnsGate(msg.sender));
        Stored memory c = _config(account);
        require(registry == c.registry, PaymentWrongRegistry(registry));
        _consume(account, auth);
        _checkPayee(account, c, auth.payee);
        _spend(account, c, auth.amount);
        _checkApprovers(account, c, auth.amount, invoiceDigest(auth), approvers, signatures, false);
        _transfer(account, auth.payee, auth.amount);
        emit InvoicePaid(account, auth.nonce, auth.payee, auth.amount, true);
    }

    /// @notice One PaymentRun approval for N invoices; limits and the two-approver rule use the total.
    function payRun(
        address account,
        InvoiceAuth[] calldata auths,
        address[] calldata approvers,
        bytes[] calldata signatures
    ) external {
        require(auths.length != 0, PaymentEmptyRun());
        Stored memory c = _config(account);
        uint256 total;
        Execution[] memory calls = new Execution[](auths.length);
        for (uint256 i; i < auths.length; ++i) {
            InvoiceAuth calldata auth = auths[i];
            _consume(account, auth);
            _checkPayee(account, c, auth.payee);
            require(auth.amount <= c.perPaymentLimit, PaymentOverPerPaymentLimit(c.perPaymentLimit, auth.amount));
            total += auth.amount;
            calls[i] = Execution(address(usdt), 0, abi.encodeCall(IERC20.transfer, (auth.payee, auth.amount)));
        }
        _spendWindow(account, c, total);
        _checkApprovers(account, c, total, runDigest(auths), approvers, signatures, true);

        bytes[] memory results = IERC7579Execution(account).executeFromExecutor(
            _mode(ERC7579Utils.CALLTYPE_BATCH), ERC7579Utils.encodeBatch(calls)
        );
        for (uint256 i; i < auths.length; ++i) {
            _checkTransferResult(results[i]);
            emit InvoicePaid(account, auths[i].nonce, auths[i].payee, auths[i].amount, false);
        }
    }

    /// @notice A single agent (ROLE_AGENT) pays within the agent's 30-day cap, plus all company limits.
    function payAsAgent(address account, InvoiceAuth calldata auth, address agent, bytes calldata signature) external {
        Stored memory c = _config(account);
        _consume(account, auth);
        _checkPayee(account, c, auth.payee);
        _spend(account, c, auth.amount);
        _spendAgent(account, c, auth.amount);
        uint64 required = auth.amount > c.freshThreshold ? _freshFloor(c) : 0;
        _checkSigner(account, agent, TazorRoles.ROLE_AGENT, true, required);
        require(
            SignatureChecker.isValidSignatureNow(agent, invoiceDigest(auth), signature), PaymentInvalidSignature(agent)
        );
        _transfer(account, auth.payee, auth.amount);
        emit InvoicePaid(account, auth.nonce, auth.payee, auth.amount, false);
        emit AgentPaid(account, auth.nonce, agent);
    }

    // ---- admin actions (one ROLE_TAZOR_ADMIN signature each; every signature is single-use)

    function addPayee(address account, address payee, address admin, uint256 deadline, bytes calldata sig) external {
        Stored memory c = _config(account);
        _checkAdmin(account, admin, keccak256(abi.encode(ADD_PAYEE_TYPEHASH, account, payee, deadline)), deadline, sig);
        if (payeeAddedAt[account][payee] != 0) return;
        payeeAddedAt[account][payee] = uint64(block.timestamp);
        emit PayeeAdded(account, payee, admin, uint64(block.timestamp) + c.payeeDelay);
    }

    /// @notice Up to 10 minutes of ROLE_APPROVER and/or ROLE_AGENT for `grantee` before the ENS role reaches
    /// the role cache. Never satisfies the fresh-proof rule.
    function provisionalGrant(
        address account,
        address grantee,
        uint256 roles,
        uint64 validUntil,
        address admin,
        uint256 deadline,
        bytes calldata sig
    ) external {
        _config(account);
        require(
            roles != 0 && roles & ~PROVISIONAL_ROLES == 0 && validUntil > block.timestamp
                && validUntil <= block.timestamp + MAX_GRANT_DURATION,
            PaymentInvalidGrant()
        );
        _checkAdmin(
            account,
            admin,
            keccak256(abi.encode(PROVISIONAL_GRANT_TYPEHASH, account, grantee, roles, validUntil, deadline)),
            deadline,
            sig
        );
        provisionalGrants[account][grantee] = Grant(uint192(roles), validUntil);
        _forgetStatus(account, grantee);
        emit ProvisionalGranted(account, grantee, roles, validUntil);
    }

    /// @notice After `until` the approver is invalid for this account even if the ENS role remains (0 clears).
    function setApproverExpiry(
        address account,
        address approver,
        uint64 until,
        address admin,
        uint256 deadline,
        bytes calldata sig
    ) external {
        _config(account);
        _checkAdmin(
            account,
            admin,
            keccak256(abi.encode(APPROVER_EXPIRY_TYPEHASH, account, approver, until, deadline)),
            deadline,
            sig
        );
        approverExpiry[account][approver] = until;
        _forgetStatus(account, approver);
        emit ApproverExpirySet(account, approver, until);
    }

    // ---- time-locked exit

    /// @notice Any cached ROLE_APPROVER (not revoked, not expired) may start an exit to one of the company's
    /// own exit accounts. WB Soul status is ignored on purpose: this is the path if WhiteBIT revokes everyone.
    function requestExit(address account, uint256 exitIndex, address requester, uint256 deadline, bytes calldata sig)
        external
    {
        Stored memory c = _config(account);
        address[] storage exits = _exitAccounts[account];
        require(exitIndex < exits.length, PaymentBadExitIndex(exitIndex));
        require(pendingExit[account].to == address(0), PaymentExitPending(account));
        (uint256 cached,) = roleCache.rolesOf(c.registry, requester);
        require(cached & TazorRoles.ROLE_APPROVER != 0, PaymentMissingRole(requester));
        require(!revocationList.isRevoked(account, requester) && !_expired(account, requester), PaymentNotVerified(requester));
        _useSignature(requester, keccak256(abi.encode(REQUEST_EXIT_TYPEHASH, account, exitIndex, deadline)), deadline, sig);

        uint64 executeAfter = uint64(block.timestamp) + c.exitDelay;
        pendingExit[account] = Exit(exits[exitIndex], executeAfter);
        emit ExitRequested(account, exits[exitIndex], executeAfter, requester);
    }

    /// @notice Any currently fully valid approver can cancel a pending exit.
    function cancelExit(address account, address approver, uint256 deadline, bytes calldata sig) external {
        _config(account);
        require(pendingExit[account].to != address(0), PaymentNoExit(account));
        _checkSigner(account, approver, TazorRoles.ROLE_APPROVER, true, 0);
        _useSignature(approver, keccak256(abi.encode(CANCEL_EXIT_TYPEHASH, account, deadline)), deadline, sig);
        delete pendingExit[account];
        emit ExitCancelled(account, approver);
    }

    /// @notice Anyone, after the delay: moves the account's whole USDT balance to the requested exit account.
    function executeExit(address account) external {
        Exit memory e = pendingExit[account];
        require(e.to != address(0), PaymentNoExit(account));
        require(block.timestamp >= e.executeAfter, PaymentExitTooEarly(e.executeAfter));
        delete pendingExit[account];
        uint256 amount = usdt.balanceOf(account);
        _transfer(account, e.to, amount);
        emit ExitExecuted(account, e.to, amount);
    }

    // ---- views

    function invoiceDigest(InvoiceAuth calldata auth) public view returns (bytes32) {
        return _hashTypedDataV4(InvoiceAuthLib.hash(auth));
    }

    function runDigest(InvoiceAuth[] calldata auths) public view returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](auths.length);
        for (uint256 i; i < auths.length; ++i) {
            hashes[i] = InvoiceAuthLib.hash(auths[i]);
        }
        return _hashTypedDataV4(keccak256(abi.encode(PAYMENT_RUN_TYPEHASH, keccak256(abi.encodePacked(hashes)))));
    }

    /// @notice EIP-712 digest an admin or approver signs for the given struct hash (AddPayee, ProvisionalGrant,
    /// ApproverExpiry, RequestExit, CancelExit).
    function typedDigest(bytes32 structHash) external view returns (bytes32) {
        return _hashTypedDataV4(structHash);
    }

    function configOf(address account) external view returns (Config memory) {
        Stored storage s = _configs[account];
        return Config(s.registry, s.twoApproverThreshold);
    }

    function configV2Of(address account) external view returns (ConfigV2 memory c) {
        Stored storage s = _configs[account];
        c = ConfigV2({
            registry: s.registry,
            twoApproverThreshold: s.twoApproverThreshold,
            perPaymentLimit: s.perPaymentLimit,
            monthlyLimit: s.monthlyLimit,
            payeeDelay: s.payeeDelay,
            freshThreshold: s.freshThreshold,
            maxCacheAge: s.maxCacheAge,
            agentMonthlyCap: s.agentMonthlyCap,
            exitAccounts: _exitAccounts[account],
            exitDelay: s.exitDelay
        });
    }

    function installedAt(address account) external view returns (uint64) {
        return _configs[account].installedAt;
    }

    function registryOf(address account) external view returns (address) {
        return _configs[account].registry;
    }

    function twoApproverThresholdOf(address account) external view returns (uint256) {
        return _configs[account].twoApproverThreshold;
    }

    /// @notice Amount still spendable in the current 30-day window (company-wide and by agents).
    function windowAvailable(address account) external view returns (uint256 company, uint256 agents) {
        Stored storage s = _configs[account];
        if (s.registry == address(0)) return (0, 0);
        Window memory w = _windows[account];
        uint32 index = _windowIndex(s.installedAt);
        company = s.monthlyLimit - (w.index == index ? w.spent : 0);
        agents = s.agentMonthlyCap - (w.agentIndex == index ? w.agentSpent : 0);
    }

    function isPaid(address account, uint256 nonce) public view returns (bool) {
        return paidBitmap[account][nonce >> 8] & (1 << (nonce & 0xff)) != 0;
    }

    function isSoulVerified(address approver) public view returns (bool) {
        return _soulIfVerified(approver) != 0;
    }

    function isTazorAccount(address a) public view returns (bool) {
        return a.codehash == tazorAccountCodeHash;
    }

    /// @notice Every payee, including other Tazor accounts, must have been added via addPayee at least
    /// payeeDelay ago (the account factory is permissionless, so being a Tazor account proves nothing).
    function isPayeeAllowed(address account, address payee) public view returns (bool) {
        uint64 added = payeeAddedAt[account][payee];
        return added != 0 && block.timestamp >= uint256(added) + _configs[account].payeeDelay;
    }

    /// @notice roles = cached ENS roles | active provisional roles; valid = WB Soul verified, not revoked
    /// for this account, not past its contractor expiry.
    function approverStatus(address account, address approver) external view returns (uint256 roles, bool valid) {
        (uint256 cached,) = roleCache.rolesOf(_configs[account].registry, approver);
        Grant memory g = provisionalGrants[account][approver];
        roles = cached | (g.validUntil >= block.timestamp ? g.roles : 0);
        valid = _soulIfVerified(approver) != 0 && !revocationList.isRevoked(account, approver)
            && !_expired(account, approver);
    }

    // ---- internal: config, nonces, limits, payees

    function _config(address account) private view returns (Stored memory c) {
        c = _configs[account];
        require(c.registry != address(0), PaymentNotInstalled(account));
    }

    function _consume(address account, InvoiceAuth calldata auth) private {
        require(auth.account == account, PaymentWrongAccount(account, auth.account));
        require(block.timestamp <= auth.expiry, PaymentExpired(auth.nonce));
        uint256 bit = 1 << (auth.nonce & 0xff);
        uint256 word = paidBitmap[account][auth.nonce >> 8];
        require(word & bit == 0, PaymentNonceUsed(auth.nonce));
        paidBitmap[account][auth.nonce >> 8] = word | bit;
    }

    function _windowIndex(uint64 since) private view returns (uint32) {
        return uint32((block.timestamp - since) / WINDOW);
    }

    function _spend(address account, Stored memory c, uint256 amount) private {
        require(amount <= c.perPaymentLimit, PaymentOverPerPaymentLimit(c.perPaymentLimit, amount));
        _spendWindow(account, c, amount);
    }

    function _spendWindow(address account, Stored memory c, uint256 amount) private {
        Window storage w = _windows[account];
        uint32 index = _windowIndex(c.installedAt);
        uint256 spent = w.index == index ? w.spent : 0;
        require(spent + amount <= c.monthlyLimit, PaymentOverMonthlyLimit(c.monthlyLimit - spent, amount));
        w.index = index;
        w.spent = uint96(spent + amount);
    }

    function _spendAgent(address account, Stored memory c, uint256 amount) private {
        Window storage w = _windows[account];
        uint32 index = _windowIndex(c.installedAt);
        uint256 spent = w.agentIndex == index ? w.agentSpent : 0;
        require(spent + amount <= c.agentMonthlyCap, PaymentOverAgentCap(c.agentMonthlyCap - spent, amount));
        w.agentIndex = index;
        w.agentSpent = uint96(spent + amount);
    }

    /// @dev Allowed payees are cached in transient storage for the rest of the transaction (keys include
    /// block.timestamp, which is constant within a transaction).
    function _checkPayee(address account, Stored memory c, address payee) private {
        bytes32 slot = keccak256(abi.encode(account, payee, block.timestamp, "tazor.v2.payee"));
        uint256 cached;
        assembly ("memory-safe") {
            cached := tload(slot)
        }
        if (cached == 1) return;
        uint64 added = payeeAddedAt[account][payee];
        bool allowed = added != 0 && block.timestamp >= uint256(added) + c.payeeDelay;
        require(allowed, PaymentPayeeNotAllowed(payee));
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
    }

    // ---- internal: approvers

    function _soulIfVerified(address approver) private view returns (uint256 soulId) {
        soulId = soulRegistry.soulOf(approver);
        if (soulId != 0 && attributeRegistry.soulAttributeValue(soulId, isVerifiedAttribute) != VERIFIED) soulId = 0;
    }

    function _expired(address account, address approver) private view returns (bool) {
        uint64 until = approverExpiry[account][approver];
        return until != 0 && block.timestamp > until;
    }

    function _freshFloor(Stored memory c) private view returns (uint64) {
        uint64 known = L1_BLOCK.number();
        return known > c.maxCacheAge ? known - c.maxCacheAge : 1;
    }

    /// @dev Per-transaction status of (account, signer), cached in transient storage:
    /// bit 255 present, bit 254 valid, bits 192..253 cached role bits >> 64 (APPROVER, ADMIN, AGENT kept),
    /// bits 128..191 provisional role bits, bits 64..127 cache L1 block, bits 0..63 soul id.
    function _status(address account, address signer)
        private
        returns (uint256 soulId, uint256 cachedRoles, uint256 provisionalRoles, uint64 cachedAt, bool valid)
    {
        bytes32 slot = keccak256(abi.encode(account, signer, block.timestamp, "tazor.v2.status"));
        uint256 packed;
        assembly ("memory-safe") {
            packed := tload(slot)
        }
        if (packed >> 255 == 1) {
            return (
                uint64(packed),
                _unpackRoles(packed >> 192),
                _unpackRoles(packed >> 128),
                uint64(packed >> 64),
                (packed >> 254) & 1 == 1
            );
        }
        uint256 cached;
        (cached, cachedAt) = roleCache.rolesOf(_configs[account].registry, signer);
        Grant memory g = provisionalGrants[account][signer];
        provisionalRoles = g.validUntil >= block.timestamp ? g.roles : 0;
        cachedRoles = cached;
        soulId = _soulIfVerified(signer);
        valid = soulId != 0 && !revocationList.isRevoked(account, signer) && !_expired(account, signer);
        if (soulId <= type(uint64).max) {
            packed = (1 << 255) | (valid ? 1 << 254 : 0) | (_packRoles(cachedRoles) << 192)
                | (_packRoles(provisionalRoles) << 128) | (uint256(cachedAt) << 64) | soulId;
            assembly ("memory-safe") {
                tstore(slot, packed)
            }
        }
    }

    /// @dev Drops the cached status after this contract changes a signer's grant or expiry.
    function _forgetStatus(address account, address signer) private {
        bytes32 slot = keccak256(abi.encode(account, signer, block.timestamp, "tazor.v2.status"));
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }

    function _packRoles(uint256 roles) private pure returns (uint256 p) {
        if (roles & TazorRoles.ROLE_APPROVER != 0) p |= 1;
        if (roles & TazorRoles.ROLE_TAZOR_ADMIN != 0) p |= 2;
        if (roles & TazorRoles.ROLE_AGENT != 0) p |= 4;
    }

    function _unpackRoles(uint256 p) private pure returns (uint256 roles) {
        if (p & 1 != 0) roles |= TazorRoles.ROLE_APPROVER;
        if (p & 2 != 0) roles |= TazorRoles.ROLE_TAZOR_ADMIN;
        if (p & 4 != 0) roles |= TazorRoles.ROLE_AGENT;
    }

    /// @param checkRole false on the L1 path (EnsGate checked ENS live).
    /// @param freshFloor 0 = no freshness rule; otherwise the cached role must be at or after this L1 block
    /// (provisional roles never satisfy it).
    function _checkSigner(address account, address signer, uint256 role, bool checkRole, uint64 freshFloor)
        private
        returns (uint256 soulId, uint256 cachedRoles)
    {
        uint256 provisionalRoles;
        uint64 cachedAt;
        bool valid;
        (soulId, cachedRoles, provisionalRoles, cachedAt, valid) = _status(account, signer);
        require(valid, PaymentNotVerified(signer));
        if (checkRole) {
            if (freshFloor != 0) {
                require(cachedRoles & role != 0, PaymentMissingRole(signer));
                require(cachedAt >= freshFloor, PaymentStaleRoles(signer, cachedAt, freshFloor));
            } else {
                require((cachedRoles | provisionalRoles) & role != 0, PaymentMissingRole(signer));
            }
        }
    }

    function _checkApprovers(
        address account,
        Stored memory c,
        uint256 amount,
        bytes32 digest,
        address[] calldata approvers,
        bytes[] calldata signatures,
        bool checkRole
    ) private {
        require(approvers.length == signatures.length, PaymentLengthMismatch());
        uint256 required = amount > c.twoApproverThreshold ? 2 : 1;
        require(approvers.length >= required, PaymentNotEnoughApprovers(required, approvers.length));
        uint64 floor = checkRole && amount > c.freshThreshold ? _freshFloor(c) : 0;

        uint256[] memory souls = new uint256[](approvers.length);
        for (uint256 i; i < approvers.length; ++i) {
            address approver = approvers[i];
            (uint256 soulId,) = _checkSigner(account, approver, TazorRoles.ROLE_APPROVER, checkRole, floor);
            for (uint256 j; j < i; ++j) {
                require(souls[j] != soulId, PaymentDuplicateSoul(approver));
            }
            souls[i] = soulId;
            require(
                SignatureChecker.isValidSignatureNow(approver, digest, signatures[i]), PaymentInvalidSignature(approver)
            );
        }
    }

    /// @dev Admin = cached ROLE_TAZOR_ADMIN (provisional roles never include it), soul-verified,
    /// not revoked, not expired.
    function _checkAdmin(address account, address admin, bytes32 structHash, uint256 deadline, bytes calldata sig)
        private
    {
        (, uint256 cachedRoles) = _checkSigner(account, admin, TazorRoles.ROLE_TAZOR_ADMIN, false, 0);
        require(cachedRoles & TazorRoles.ROLE_TAZOR_ADMIN != 0, PaymentMissingRole(admin));
        _useSignature(admin, structHash, deadline, sig);
    }

    function _useSignature(address signer, bytes32 structHash, uint256 deadline, bytes calldata sig) private {
        require(block.timestamp <= deadline, PaymentDeadlinePassed());
        bytes32 digest = _hashTypedDataV4(structHash);
        require(!signatureUsed[digest], PaymentSignatureUsed());
        require(SignatureChecker.isValidSignatureNow(signer, digest, sig), PaymentInvalidSignature(signer));
        signatureUsed[digest] = true;
    }

    // ---- internal: execution

    function _transfer(address account, address to, uint256 amount) private {
        bytes[] memory results = IERC7579Execution(account).executeFromExecutor(
            _mode(ERC7579Utils.CALLTYPE_SINGLE),
            abi.encodePacked(address(usdt), uint256(0), abi.encodeCall(IERC20.transfer, (to, amount)))
        );
        _checkTransferResult(results[0]);
    }

    function _checkTransferResult(bytes memory result) private pure {
        require(result.length == 0 || abi.decode(result, (bool)), PaymentTransferFailed());
    }

    function _mode(CallType callType) private pure returns (bytes32) {
        return bytes32(CallType.unwrap(callType));
    }
}
