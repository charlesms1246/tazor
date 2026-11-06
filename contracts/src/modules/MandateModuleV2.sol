// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ERC7579Utils, CallType} from "@openzeppelin/contracts/account/utils/draft-ERC7579Utils.sol";
import {IERC7579Execution, MODULE_TYPE_EXECUTOR} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {TazorRoles} from "../interfaces/IRoleCache.sol";
import {PaymentModuleV2} from "./PaymentModuleV2.sol";

/// @notice ERC-7579 executor for standing payment mandates (v2): approvers authorize a payee to receive up to
/// capPerPeriod USDT per period until expiry; anyone may trigger a pull, which always pays the mandate's payee.
/// Approver validity comes from PaymentModuleV2.approverStatus (WB Soul, revocation, contractor expiry,
/// cached or provisional roles), so the account must also have PaymentModuleV2 installed. Pulls are not
/// counted against PaymentModuleV2's limits.
contract MandateModuleV2 is EIP712 {
    bytes32 public constant MANDATE_TYPEHASH = keccak256(
        "Mandate(address account,address payee,uint256 capPerPeriod,uint64 period,uint64 expiry,uint256 nonce)"
    );
    bytes32 public constant CANCEL_TYPEHASH = keccak256("CancelMandate(bytes32 mandateId)");

    struct Mandate {
        address account;
        address payee;
        uint256 capPerPeriod;
        uint64 period;
        uint64 expiry;
        uint256 nonce;
    }

    /// @dev Three slots; a pull reads all three and rewrites only the last.
    struct State {
        address account;
        uint64 period;
        bool cancelled;
        address payee;
        uint64 start;
        uint64 cap;
        uint64 expiry;
        uint64 spent;
        uint32 periodIndex;
    }

    PaymentModuleV2 public immutable paymentModule;
    IERC20 public immutable usdt;

    mapping(bytes32 mandateId => State) private _mandates;
    mapping(address account => mapping(uint256 nonce => bool)) public nonceUsed;

    event MandateCreated(
        bytes32 indexed mandateId, address indexed account, address indexed payee, uint256 capPerPeriod, uint64 period, uint64 expiry
    );
    event MandatePulled(bytes32 indexed mandateId, uint256 amount, uint256 periodIndex);
    event MandateCancelled(bytes32 indexed mandateId, address by);

    error MandateNotConfigured(address account);
    error MandateInvalid();
    error MandateNonceUsed(uint256 nonce);
    error MandateUnknown(bytes32 mandateId);
    error MandateCancelledError(bytes32 mandateId);
    error MandateExpired(bytes32 mandateId);
    error MandateOverCap(uint256 available, uint256 requested);
    error MandateLengthMismatch();
    error MandateNotEnoughApprovers(uint256 required, uint256 provided);
    error MandateNotVerified(address approver);
    error MandateDuplicateSoul(address approver);
    error MandateMissingRole(address approver);
    error MandateInvalidSignature(address approver);
    error MandateTransferFailed();

    constructor(PaymentModuleV2 paymentModule_) EIP712("Tazor", "2") {
        paymentModule = paymentModule_;
        usdt = paymentModule_.usdt();
    }

    // ---- ERC-7579 module

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_EXECUTOR;
    }

    function onInstall(bytes calldata) external {}

    function onUninstall(bytes calldata) external {}

    // ---- mandates

    /// @notice Anyone may submit. Needs 2 approvers when capPerPeriod exceeds the account's two-approver
    /// threshold, otherwise 1. Returns the mandate id (its EIP-712 digest).
    function createMandate(Mandate calldata m, address[] calldata approvers, bytes[] calldata signatures)
        external
        returns (bytes32 mandateId)
    {
        PaymentModuleV2.Config memory config = paymentModule.configOf(m.account);
        require(config.registry != address(0), MandateNotConfigured(m.account));
        require(
            m.payee != address(0) && m.payee != m.account && m.period != 0 && m.capPerPeriod != 0
                && m.capPerPeriod <= type(uint64).max && m.expiry > block.timestamp
                && (m.expiry - block.timestamp) / m.period <= type(uint32).max,
            MandateInvalid()
        );
        require(!nonceUsed[m.account][m.nonce], MandateNonceUsed(m.nonce));

        mandateId = mandateDigest(m);
        uint256 required = m.capPerPeriod > config.twoApproverThreshold ? 2 : 1;
        _checkApprovers(m.account, config.registry, required, mandateId, approvers, signatures);

        nonceUsed[m.account][m.nonce] = true;
        _mandates[mandateId] = State({
            account: m.account,
            period: m.period,
            cancelled: false,
            payee: m.payee,
            start: uint64(block.timestamp),
            cap: uint64(m.capPerPeriod),
            expiry: m.expiry,
            spent: 0,
            periodIndex: 0
        });
        emit MandateCreated(mandateId, m.account, m.payee, m.capPerPeriod, m.period, m.expiry);
    }

    /// @notice Anyone may trigger; the funds always go to the mandate's payee. Periods are aligned to the
    /// mandate's creation time.
    function pull(bytes32 mandateId, uint256 amount) external {
        State storage s = _mandates[mandateId];
        address account = s.account;
        require(account != address(0), MandateUnknown(mandateId));
        require(!s.cancelled, MandateCancelledError(mandateId));
        require(block.timestamp <= s.expiry, MandateExpired(mandateId));

        // fits: createMandate bounds the number of periods before expiry to uint32
        uint32 index = uint32((block.timestamp - s.start) / s.period);
        uint256 spent = index == s.periodIndex ? s.spent : 0;
        require(spent + amount <= s.cap, MandateOverCap(s.cap - spent, amount));
        s.spent = uint64(spent + amount);
        s.periodIndex = index;

        bytes[] memory results = IERC7579Execution(account).executeFromExecutor(
            _mode(ERC7579Utils.CALLTYPE_SINGLE),
            abi.encodePacked(address(usdt), uint256(0), abi.encodeCall(IERC20.transfer, (s.payee, amount)))
        );
        require(results[0].length == 0 || abi.decode(results[0], (bool)), MandateTransferFailed());
        emit MandatePulled(mandateId, amount, index);
    }

    /// @notice The payee (as msg.sender) or one approver passing the usual checks may cancel; final.
    function cancel(bytes32 mandateId, address approver, bytes calldata signature) external {
        State storage s = _mandates[mandateId];
        require(s.account != address(0), MandateUnknown(mandateId));
        require(!s.cancelled, MandateCancelledError(mandateId));
        address by = msg.sender;
        if (msg.sender != s.payee) {
            address[] memory approvers = new address[](1);
            bytes[] memory signatures = new bytes[](1);
            approvers[0] = approver;
            signatures[0] = signature;
            address account = s.account;
            _checkApprovers(account, paymentModule.registryOf(account), 1, cancelDigest(mandateId), approvers, signatures);
            by = approver;
        }
        s.cancelled = true;
        emit MandateCancelled(mandateId, by);
    }

    // ---- views

    function mandateDigest(Mandate calldata m) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(MANDATE_TYPEHASH, m.account, m.payee, m.capPerPeriod, m.period, m.expiry, m.nonce))
        );
    }

    function cancelDigest(bytes32 mandateId) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CANCEL_TYPEHASH, mandateId)));
    }

    function mandateOf(bytes32 mandateId) external view returns (State memory) {
        return _mandates[mandateId];
    }

    /// @notice Amount still pullable in the current period (0 if cancelled, expired or unknown).
    function available(bytes32 mandateId) external view returns (uint256) {
        State memory s = _mandates[mandateId];
        if (s.account == address(0) || s.cancelled || block.timestamp > s.expiry) return 0;
        uint32 index = uint32((block.timestamp - s.start) / s.period);
        return s.cap - (index == s.periodIndex ? s.spent : 0);
    }

    // ---- internal

    function _checkApprovers(
        address account,
        address registry,
        uint256 required,
        bytes32 digest,
        address[] memory approvers,
        bytes[] memory signatures
    ) private view {
        require(registry != address(0), MandateNotConfigured(account));
        require(approvers.length == signatures.length, MandateLengthMismatch());
        require(approvers.length >= required, MandateNotEnoughApprovers(required, approvers.length));

        uint256[] memory souls = new uint256[](approvers.length);
        for (uint256 i; i < approvers.length; ++i) {
            address approver = approvers[i];
            (uint256 roles, bool valid) = paymentModule.approverStatus(account, approver);
            require(valid, MandateNotVerified(approver));
            uint256 soulId = paymentModule.soulRegistry().soulOf(approver);
            for (uint256 j; j < i; ++j) {
                require(souls[j] != soulId, MandateDuplicateSoul(approver));
            }
            souls[i] = soulId;
            require(roles & TazorRoles.ROLE_APPROVER != 0, MandateMissingRole(approver));
            require(
                SignatureChecker.isValidSignatureNow(approver, digest, signatures[i]), MandateInvalidSignature(approver)
            );
        }
    }

    function _mode(CallType callType) private pure returns (bytes32) {
        return bytes32(CallType.unwrap(callType));
    }
}
