// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUSDT3009} from "./TazorCheckout.sol";

/// @notice A one-order deposit address. Only the checkout that created it can move what it holds.
contract OrderVault {
    address public immutable checkout;

    constructor() {
        checkout = msg.sender;
    }

    function sweep(IERC20 token, address to, uint256 amount) external {
        require(msg.sender == checkout, "only checkout");
        SafeERC20.safeTransfer(token, to, amount);
    }
}

/// @notice Pay by sending USDT to an address: for customers paying from an exchange (a WhiteBIT withdrawal),
/// a bank-app style wallet, or any wallet that can only "send". Nothing to sign and no WBT needed.
/// - Every order has its own counterfactual deposit address (CREATE2 clone of OrderVault), derived from the
///   merchant, the order, the amount, the deadline and the customer's refund address.
/// - Anyone can settle once the address holds the amount: the order amount goes to the merchant, anything
///   above it goes back to the refund address in the same transaction.
/// - Refunds are signed by the merchant (EIP-3009) and can only go to the refund address fixed in the order.
/// - Funds sent after the deadline, or too little before it, can always be returned to the refund address.
contract TazorDepositCheckout {
    using SafeERC20 for IERC20;

    bytes32 internal constant REFUND_TAG = keccak256("tazor.deposit.refund");

    struct DepositOrder {
        address merchant;
        uint256 amount;
        bytes32 ref;
        uint64 deadline;
        address refundTo;
    }

    struct Payment {
        address merchant;
        address refundTo;
        uint256 amount;
        uint256 refunded;
        uint64 paidAt;
        uint32 refunds;
    }

    IUSDT3009 public immutable usdt;
    address public immutable vaultImpl;
    mapping(bytes32 id => Payment) internal _payments;

    event DepositPaid(bytes32 indexed id, address indexed merchant, address indexed vault, uint256 amount, uint256 excess, bytes32 ref);
    event DepositRefunded(bytes32 indexed id, address indexed merchant, address indexed refundTo, uint256 amount, uint256 totalRefunded);
    event DepositReturned(bytes32 indexed id, address indexed refundTo, uint256 amount);

    error Expired();
    error AlreadyPaid();
    error NotPaid();
    error Underpaid(uint256 have, uint256 need);
    error RefundTooLarge();
    error BadOrder();
    error StillOpen();

    constructor(IUSDT3009 usdt_) {
        usdt = usdt_;
        vaultImpl = address(new OrderVault());
    }

    function orderId(DepositOrder calldata o) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), o));
    }

    /// @notice Where the customer sends USDT. Valid before anything is deployed there.
    function depositAddress(DepositOrder calldata o) public view returns (address) {
        return Clones.predictDeterministicAddress(vaultImpl, orderId(o), address(this));
    }

    function refundNonce(bytes32 id, uint256 amount, uint256 refundNo) public pure returns (bytes32) {
        return keccak256(abi.encode(REFUND_TAG, id, amount, refundNo));
    }

    function _vault(bytes32 id) internal returns (OrderVault v) {
        address a = Clones.predictDeterministicAddress(vaultImpl, id, address(this));
        if (a.code.length == 0) Clones.cloneDeterministic(vaultImpl, id);
        v = OrderVault(a);
    }

    /// @notice Settle an order once its deposit address holds at least the amount. Anyone can call it.
    function settle(DepositOrder calldata o) external returns (bytes32 id) {
        if (o.merchant == address(0) || o.refundTo == address(0) || o.amount == 0) revert BadOrder();
        if (block.timestamp > o.deadline) revert Expired();
        id = orderId(o);
        Payment storage p = _payments[id];
        if (p.paidAt != 0) revert AlreadyPaid();
        address addr = depositAddress(o);
        uint256 have = IERC20(address(usdt)).balanceOf(addr);
        if (have < o.amount) revert Underpaid(have, o.amount);
        p.merchant = o.merchant;
        p.refundTo = o.refundTo;
        p.amount = o.amount;
        p.paidAt = uint64(block.timestamp);

        OrderVault v = _vault(id);
        v.sweep(IERC20(address(usdt)), o.merchant, o.amount);
        uint256 excess = have - o.amount;
        if (excess != 0) v.sweep(IERC20(address(usdt)), o.refundTo, excess);
        emit DepositPaid(id, o.merchant, addr, o.amount, excess, o.ref);
    }

    /// @notice Return whatever sits at the deposit address to the refund address: anything sent after the order
    /// was paid, or a short or late payment once the order can no longer be settled. Anyone can call it.
    function returnFunds(DepositOrder calldata o) external {
        bytes32 id = orderId(o);
        if (_payments[id].paidAt == 0 && block.timestamp <= o.deadline) revert StillOpen();
        address addr = depositAddress(o);
        uint256 have = IERC20(address(usdt)).balanceOf(addr);
        if (have == 0) return;
        _vault(id).sweep(IERC20(address(usdt)), o.refundTo, have);
        emit DepositReturned(id, o.refundTo, have);
    }

    /// @notice A merchant-signed refund (EIP-3009, nonce = refundNonce) to the order's refund address.
    function refund(bytes32 id, uint256 amount, uint256 validAfter, uint256 validBefore, bytes calldata sig) external {
        Payment storage p = _payments[id];
        if (p.paidAt == 0) revert NotPaid();
        if (amount == 0 || p.refunded + amount > p.amount) revert RefundTooLarge();
        bytes32 nonce = refundNonce(id, amount, p.refunds);
        p.refunded += amount;
        p.refunds += 1;
        usdt.receiveWithAuthorization(p.merchant, address(this), amount, validAfter, validBefore, nonce, sig);
        IERC20(address(usdt)).safeTransfer(p.refundTo, amount);
        emit DepositRefunded(id, p.merchant, p.refundTo, amount, p.refunded);
    }

    function payment(bytes32 id)
        external
        view
        returns (address merchant, address refundTo, uint256 amount, uint256 refunded, uint64 paidAt, uint32 refunds)
    {
        Payment storage p = _payments[id];
        return (p.merchant, p.refundTo, p.amount, p.refunded, p.paidAt, p.refunds);
    }
}
