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

/// @notice ERC-7579 executor that pays USDT invoices from a TazorAccount, one deployment for all accounts.
/// Each payment needs 1 approver, or 2 when the amount exceeds the account's twoApproverThreshold.
/// An approver is an ApproverAccount (ERC-1271) that is WB Soul verified, not revoked, and holds
/// ROLE_APPROVER in the account's ENS registry (via the role cache; on the L1 path EnsGate checked it).
/// Approvers are counted by distinct WB Soul id. Anyone may submit.
contract PaymentModule is IPaymentModule, EIP712 {
    using SafeCast for uint256;

    bytes32 public constant PAYMENT_RUN_TYPEHASH = keccak256("PaymentRun(bytes32[] authHashes)");
    bytes20 private constant VERIFIED = bytes20(uint160(1));

    struct Config {
        address registry;
        uint96 twoApproverThreshold;
    }

    IERC20 public immutable usdt;
    IWBSoulRegistry public immutable soulRegistry;
    IWBSoulAttributeRegistry public immutable attributeRegistry;
    address public immutable isVerifiedAttribute;
    IRoleCache public immutable roleCache;
    RevocationList public immutable revocationList;
    address public immutable ensGateAlias;

    mapping(address account => Config) private _configs;
    mapping(address account => mapping(uint256 word => uint256 bits)) public paidBitmap;

    event InvoicePaid(address indexed account, uint256 indexed nonce, address payee, uint256 amount, bool viaL1);

    error PaymentNotInstalled(address account);
    error PaymentAlreadyInstalled(address account);
    error PaymentZeroRegistry();
    error PaymentWrongAccount(address expected, address actual);
    error PaymentExpired(uint256 nonce);
    error PaymentNonceUsed(uint256 nonce);
    error PaymentLengthMismatch();
    error PaymentNotEnoughApprovers(uint256 required, uint256 provided);
    error PaymentInvalidSignature(address approver);
    error PaymentNotVerified(address approver);
    error PaymentRevoked(address approver);
    error PaymentMissingRole(address approver);
    error PaymentDuplicateSoul(address approver);
    error PaymentNotEnsGate(address sender);
    error PaymentWrongRegistry(address registry);
    error PaymentTransferFailed();
    error PaymentEmptyRun();

    constructor(
        IERC20 usdt_,
        IWBSoulRegistry soulRegistry_,
        IWBSoulAttributeRegistry attributeRegistry_,
        address isVerifiedAttribute_,
        IRoleCache roleCache_,
        address ensGateAlias_
    ) EIP712("Tazor", "1") {
        usdt = usdt_;
        soulRegistry = soulRegistry_;
        attributeRegistry = attributeRegistry_;
        isVerifiedAttribute = isVerifiedAttribute_;
        roleCache = roleCache_;
        ensGateAlias = ensGateAlias_;
        revocationList = new RevocationList();
    }

    // ---- ERC-7579 module

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_EXECUTOR;
    }

    /// @param data abi.encode(address registry, uint256 twoApproverThreshold)
    function onInstall(bytes calldata data) external {
        require(_configs[msg.sender].registry == address(0), PaymentAlreadyInstalled(msg.sender));
        (address registry, uint256 threshold) = abi.decode(data, (address, uint256));
        require(registry != address(0), PaymentZeroRegistry());
        _configs[msg.sender] = Config(registry, threshold.toUint96());
    }

    function onUninstall(bytes calldata) external {
        delete _configs[msg.sender];
    }

    // ---- payments

    function payOne(address account, InvoiceAuth calldata auth, address[] calldata approvers, bytes[] calldata signatures)
        external
    {
        Config memory config = _config(account);
        _checkApprovers(account, config, auth.amount, invoiceDigest(auth), approvers, signatures, true);
        _pay(account, auth, false);
    }

    function payFromL1(
        address registry,
        address account,
        InvoiceAuth calldata auth,
        address[] calldata approvers,
        bytes[] calldata signatures
    ) external {
        require(msg.sender == ensGateAlias, PaymentNotEnsGate(msg.sender));
        Config memory config = _config(account);
        require(registry == config.registry, PaymentWrongRegistry(registry));
        _checkApprovers(account, config, auth.amount, invoiceDigest(auth), approvers, signatures, false);
        _pay(account, auth, true);
    }

    /// @notice Approvers sign one PaymentRun digest over all invoices; the threshold uses the total amount.
    function payRun(
        address account,
        InvoiceAuth[] calldata auths,
        address[] calldata approvers,
        bytes[] calldata signatures
    ) external {
        require(auths.length != 0, PaymentEmptyRun());
        Config memory config = _config(account);
        uint256 total;
        Execution[] memory calls = new Execution[](auths.length);
        for (uint256 i; i < auths.length; ++i) {
            InvoiceAuth calldata auth = auths[i];
            _consume(account, auth);
            total += auth.amount;
            calls[i] = Execution(address(usdt), 0, abi.encodeCall(IERC20.transfer, (auth.payee, auth.amount)));
        }
        _checkApprovers(account, config, total, runDigest(auths), approvers, signatures, true);

        bytes[] memory results = IERC7579Execution(account).executeFromExecutor(
            _mode(ERC7579Utils.CALLTYPE_BATCH), ERC7579Utils.encodeBatch(calls)
        );
        for (uint256 i; i < auths.length; ++i) {
            _checkTransferResult(results[i]);
            emit InvoicePaid(account, auths[i].nonce, auths[i].payee, auths[i].amount, false);
        }
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

    function configOf(address account) external view returns (Config memory) {
        return _configs[account];
    }

    function registryOf(address account) external view returns (address) {
        return _configs[account].registry;
    }

    function isPaid(address account, uint256 nonce) public view returns (bool) {
        return paidBitmap[account][nonce >> 8] & (1 << (nonce & 0xff)) != 0;
    }

    function isSoulVerified(address approver) public view returns (bool) {
        return _soulIfVerified(approver) != 0;
    }

    // ---- internal

    function _config(address account) private view returns (Config memory config) {
        config = _configs[account];
        require(config.registry != address(0), PaymentNotInstalled(account));
    }

    function _soulIfVerified(address approver) private view returns (uint256 soulId) {
        soulId = soulRegistry.soulOf(approver);
        if (soulId != 0 && attributeRegistry.soulAttributeValue(soulId, isVerifiedAttribute) != VERIFIED) soulId = 0;
    }

    function _checkApprovers(
        address account,
        Config memory config,
        uint256 amount,
        bytes32 digest,
        address[] calldata approvers,
        bytes[] calldata signatures,
        bool checkRole
    ) private view {
        require(approvers.length == signatures.length, PaymentLengthMismatch());
        uint256 required = amount > config.twoApproverThreshold ? 2 : 1;
        require(approvers.length >= required, PaymentNotEnoughApprovers(required, approvers.length));

        uint256[] memory souls = new uint256[](approvers.length);
        for (uint256 i; i < approvers.length; ++i) {
            address approver = approvers[i];
            uint256 soulId = _soulIfVerified(approver);
            require(soulId != 0, PaymentNotVerified(approver));
            for (uint256 j; j < i; ++j) {
                require(souls[j] != soulId, PaymentDuplicateSoul(approver));
            }
            souls[i] = soulId;
            require(!revocationList.isRevoked(account, approver), PaymentRevoked(approver));
            if (checkRole) {
                (uint256 roles,) = roleCache.rolesOf(config.registry, approver);
                require(roles & TazorRoles.ROLE_APPROVER != 0, PaymentMissingRole(approver));
            }
            require(
                SignatureChecker.isValidSignatureNow(approver, digest, signatures[i]),
                PaymentInvalidSignature(approver)
            );
        }
    }

    function _consume(address account, InvoiceAuth calldata auth) private {
        require(auth.account == account, PaymentWrongAccount(account, auth.account));
        require(block.timestamp <= auth.expiry, PaymentExpired(auth.nonce));
        uint256 bit = 1 << (auth.nonce & 0xff);
        uint256 word = paidBitmap[account][auth.nonce >> 8];
        require(word & bit == 0, PaymentNonceUsed(auth.nonce));
        paidBitmap[account][auth.nonce >> 8] = word | bit;
    }

    function _pay(address account, InvoiceAuth calldata auth, bool viaL1) private {
        _consume(account, auth);
        bytes[] memory results = IERC7579Execution(account).executeFromExecutor(
            _mode(ERC7579Utils.CALLTYPE_SINGLE),
            abi.encodePacked(address(usdt), uint256(0), abi.encodeCall(IERC20.transfer, (auth.payee, auth.amount)))
        );
        _checkTransferResult(results[0]);
        emit InvoicePaid(account, auth.nonce, auth.payee, auth.amount, viaL1);
    }

    /// @dev Tokens that return nothing are accepted; tokens that return false are not.
    function _checkTransferResult(bytes memory result) private pure {
        require(result.length == 0 || abi.decode(result, (bool)), PaymentTransferFailed());
    }

    /// @dev ERC-7579 mode: call type in byte 0, default exec type, no selector or payload.
    function _mode(CallType callType) private pure returns (bytes32) {
        return bytes32(CallType.unwrap(callType));
    }
}
