// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice The parts of Whitechain's USDT (TetherTokenV2) this contract uses: EIP-3009 and EIP-2612 with
/// bytes signatures, which the token checks with SignatureChecker, so ERC-1271 wallets can sign too.
interface IUSDT3009 is IERC20 {
    function receiveWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature
    ) external;
    function permit(address owner, address spender, uint256 value, uint256 deadline, bytes calldata signature) external;
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/// @notice Gasless USDT checkout for any customer wallet on Whitechain.
/// - Pay: the customer signs one EIP-3009 ReceiveWithAuthorization whose nonce commits to the merchant, the
///   order and the amount. Anyone (a relayer paying WBT gas) submits it; the money can only reach that merchant.
/// - Refund: the merchant signs a 3009 authorization the same way. The money can only go back to the original
///   payer, and never more than was paid. Every refund is an event the customer can check.
/// - Subscribe: the first cycle is a 3009 payment whose nonce commits to the plan terms; later cycles are
///   pulled with an EIP-2612 allowance, never early, never more than the plan, and either side can cancel.
contract TazorCheckout is EIP712 {
    using SafeERC20 for IERC20;

    bytes32 internal constant PAY_TAG = keccak256("tazor.checkout.pay");
    bytes32 internal constant REFUND_TAG = keccak256("tazor.checkout.refund");
    bytes32 internal constant SUBSCRIBE_TAG = keccak256("tazor.checkout.subscribe");
    bytes32 public constant CANCEL_TYPEHASH = keccak256("Cancel(bytes32 subId)");

    struct Order {
        address merchant;
        uint256 amount;
        bytes32 ref;
        uint64 deadline;
    }

    struct Payment {
        address merchant;
        address payer;
        uint256 amount;
        uint256 refunded;
        uint64 paidAt;
        uint32 refunds;
    }

    struct Plan {
        address merchant;
        uint256 amount;
        uint32 period;
        uint16 cycles;
        bytes32 ref;
    }

    /// @notice A signed authorization. For a 3009 payment: (validAfter, validBefore, sig).
    /// For the subscription permit the two numbers are (permit value, permit deadline).
    struct Auth {
        uint256 validAfter;
        uint256 validBefore;
        bytes sig;
    }

    struct Subscription {
        address merchant;
        address payer;
        uint256 amount;
        uint32 period;
        uint16 cycles;
        uint16 charged;
        uint64 start;
        bool active;
    }

    IUSDT3009 public immutable usdt;

    mapping(bytes32 id => Payment) internal _payments;
    mapping(bytes32 id => Subscription) internal _subs;

    event OrderPaid(bytes32 indexed id, address indexed merchant, address indexed payer, uint256 amount, bytes32 ref);
    event Refunded(bytes32 indexed id, address indexed merchant, address indexed payer, uint256 amount, uint256 totalRefunded);
    event Subscribed(
        bytes32 indexed id, address indexed merchant, address indexed payer, uint256 amount, uint32 period, uint16 cycles, bytes32 ref
    );
    event Charged(bytes32 indexed id, uint16 cycle, uint256 amount);
    event Cancelled(bytes32 indexed id, address by);

    error Expired();
    error AlreadyPaid();
    error NotPaid();
    error RefundTooLarge();
    error NotDue();
    error NotActive();
    error NotParty();
    error BadPlan();
    error BadOrder();

    constructor(IUSDT3009 usdt_) EIP712("TazorCheckout", "1") {
        usdt = usdt_;
    }

    // ---------------------------------------------------------------- orders

    function orderId(Order calldata o) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), o.merchant, o.ref));
    }

    function payNonce(Order calldata o) public view returns (bytes32) {
        return keccak256(abi.encode(PAY_TAG, orderId(o), o.amount, o.deadline));
    }

    function refundNonce(bytes32 id, uint256 amount, uint256 refundNo) public pure returns (bytes32) {
        return keccak256(abi.encode(REFUND_TAG, id, amount, refundNo));
    }

    /// @notice Settle an order with the payer's signed authorization. Front-running is harmless: whoever submits,
    /// the same amount goes to the same merchant, because the signed nonce commits to both.
    function pay(Order calldata o, address payer, uint256 validAfter, uint256 validBefore, bytes calldata sig)
        external
        returns (bytes32 id)
    {
        if (o.merchant == address(0) || o.amount == 0 || payer == address(0)) revert BadOrder();
        if (block.timestamp > o.deadline) revert Expired();
        id = orderId(o);
        Payment storage p = _payments[id];
        if (p.payer != address(0)) revert AlreadyPaid();
        p.merchant = o.merchant;
        p.payer = payer;
        p.amount = o.amount;
        p.paidAt = uint64(block.timestamp);

        usdt.receiveWithAuthorization(payer, address(this), o.amount, validAfter, validBefore, payNonce(o), sig);
        IERC20(address(usdt)).safeTransfer(o.merchant, o.amount);
        emit OrderPaid(id, o.merchant, payer, o.amount, o.ref);
    }

    /// @notice Refund part or all of a paid order, signed by the merchant. Only the original payer can receive it.
    function refund(bytes32 id, uint256 amount, uint256 validAfter, uint256 validBefore, bytes calldata sig) external {
        Payment storage p = _payments[id];
        if (p.payer == address(0)) revert NotPaid();
        if (amount == 0 || p.refunded + amount > p.amount) revert RefundTooLarge();
        bytes32 nonce = refundNonce(id, amount, p.refunds);
        p.refunded += amount;
        p.refunds += 1;

        usdt.receiveWithAuthorization(p.merchant, address(this), amount, validAfter, validBefore, nonce, sig);
        IERC20(address(usdt)).safeTransfer(p.payer, amount);
        emit Refunded(id, p.merchant, p.payer, amount, p.refunded);
    }

    function payment(bytes32 id)
        external
        view
        returns (address merchant, address payer, uint256 amount, uint256 refunded, uint64 paidAt, uint32 refunds)
    {
        Payment storage p = _payments[id];
        return (p.merchant, p.payer, p.amount, p.refunded, p.paidAt, p.refunds);
    }

    // ---------------------------------------------------------------- subscriptions

    function subId(Plan calldata p, address payer) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), p, payer));
    }

    function subNonce(Plan calldata p, address payer) public view returns (bytes32) {
        return keccak256(abi.encode(SUBSCRIBE_TAG, subId(p, payer)));
    }

    /// @notice Start a subscription: cycle 1 is paid now, and the permit lets later cycles be pulled on schedule.
    /// The permit is best effort: if someone already used it (front-run), the allowance is in place either way.
    /// @param first the payer's 3009 authorization for cycle 1 (nonce = subNonce).
    /// @param allowance the payer's EIP-2612 permit for later cycles; an empty sig skips it.
    function subscribe(Plan calldata p, address payer, Auth calldata first, Auth calldata allowance)
        external
        returns (bytes32 id)
    {
        id = _open(p, payer);
        usdt.receiveWithAuthorization(payer, address(this), p.amount, first.validAfter, first.validBefore, subNonce(p, payer), first.sig);
        IERC20(address(usdt)).safeTransfer(p.merchant, p.amount);
        if (allowance.sig.length != 0) {
            try usdt.permit(payer, address(this), allowance.validAfter, allowance.validBefore, allowance.sig) {} catch {}
        }
        emit Subscribed(id, p.merchant, payer, p.amount, p.period, p.cycles, p.ref);
        emit Charged(id, 1, p.amount);
    }

    function _open(Plan calldata p, address payer) internal returns (bytes32 id) {
        if (p.merchant == address(0) || p.amount == 0 || p.period == 0 || p.cycles == 0 || payer == address(0)) revert BadPlan();
        id = subId(p, payer);
        Subscription storage s = _subs[id];
        if (s.payer != address(0)) revert AlreadyPaid();
        s.merchant = p.merchant;
        s.payer = payer;
        s.amount = p.amount;
        s.period = p.period;
        s.cycles = p.cycles;
        s.charged = 1;
        s.start = uint64(block.timestamp);
        s.active = p.cycles > 1;
    }

    /// @notice Pull the next cycle. Anyone may call it, but only once it is due and only for the plan's amount.
    function charge(bytes32 id) external {
        Subscription storage s = _subs[id];
        if (!s.active) revert NotActive();
        if (block.timestamp < uint256(s.start) + uint256(s.charged) * s.period) revert NotDue();
        s.charged += 1;
        if (s.charged >= s.cycles) s.active = false;
        IERC20(address(usdt)).safeTransferFrom(s.payer, s.merchant, s.amount);
        emit Charged(id, s.charged, s.amount);
    }

    function cancel(bytes32 id) external {
        _cancel(id, msg.sender);
    }

    /// @notice Cancel with a signature from the payer or the merchant, so neither needs WBT for gas.
    function cancelBySig(bytes32 id, address by, bytes calldata sig) external {
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CANCEL_TYPEHASH, id)));
        if (!SignatureChecker.isValidSignatureNow(by, digest, sig)) revert NotParty();
        _cancel(id, by);
    }

    function _cancel(bytes32 id, address by) internal {
        Subscription storage s = _subs[id];
        if (by != s.payer && by != s.merchant) revert NotParty();
        if (!s.active) revert NotActive();
        s.active = false;
        emit Cancelled(id, by);
    }

    function subscription(bytes32 id)
        external
        view
        returns (address merchant, address payer, uint256 amount, uint32 period, uint16 cycles, uint16 charged, uint64 start, bool active)
    {
        Subscription storage s = _subs[id];
        return (s.merchant, s.payer, s.amount, s.period, s.cycles, s.charged, s.start, s.active);
    }

    /// @notice When the next cycle can be pulled; 0 when the subscription is finished or cancelled.
    function nextChargeAt(bytes32 id) external view returns (uint64) {
        Subscription storage s = _subs[id];
        if (!s.active) return 0;
        return s.start + uint64(s.charged) * s.period;
    }

    function cancelDigest(bytes32 id) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CANCEL_TYPEHASH, id)));
    }
}
