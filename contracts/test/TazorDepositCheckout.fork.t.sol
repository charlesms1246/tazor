// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TazorDepositCheckout, OrderVault} from "../src/checkout/TazorDepositCheckout.sol";
import {IUSDT3009} from "../src/checkout/TazorCheckout.sol";

/// forge test --match-contract TazorDepositCheckoutFork --fork-url $WC_TESTNET_RPC
contract TazorDepositCheckoutForkTest is Test {
    IUSDT3009 constant USDT = IUSDT3009(0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7);
    bytes32 constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    TazorDepositCheckout dc;
    uint256 merchantKey = 0xB0B;
    address merchant;
    address customer = address(0xC0FFEE); // e.g. an exchange hot wallet: it can only send
    address refundTo = address(0xCAFE);

    function setUp() public {
        if (block.chainid != 1874) {
            vm.skip(true);
            return;
        }
        merchant = vm.addr(merchantKey);
        dc = new TazorDepositCheckout(USDT);
        deal(address(USDT), customer, 100e6);
    }

    function _order(uint256 amount) internal view returns (TazorDepositCheckout.DepositOrder memory) {
        return TazorDepositCheckout.DepositOrder({
            merchant: merchant, amount: amount, ref: keccak256("CAFE-77"), deadline: uint64(block.timestamp + 1 hours), refundTo: refundTo
        });
    }

    function _send(address to, uint256 amount) internal {
        vm.prank(customer);
        IERC20(address(USDT)).transfer(to, amount);
    }

    function test_plainTransferThenSettle() public {
        TazorDepositCheckout.DepositOrder memory o = _order(2e6);
        address a = dc.depositAddress(o);
        assertEq(a.code.length, 0);
        _send(a, 2e6);
        bytes32 id = dc.settle(o);
        assertEq(IERC20(address(USDT)).balanceOf(merchant), 2e6);
        assertEq(IERC20(address(USDT)).balanceOf(a), 0);
        (address m,, uint256 amount,, uint64 paidAt,) = dc.payment(id);
        assertEq(m, merchant);
        assertEq(amount, 2e6);
        assertGt(paidAt, 0);
        assertEq(OrderVault(a).checkout(), address(dc));
    }

    function test_overpaymentReturnedInSameTx() public {
        TazorDepositCheckout.DepositOrder memory o = _order(2e6);
        _send(dc.depositAddress(o), 2_500_000);
        dc.settle(o);
        assertEq(IERC20(address(USDT)).balanceOf(merchant), 2e6);
        assertEq(IERC20(address(USDT)).balanceOf(refundTo), 500_000);
    }

    function test_underpaidCannotSettleButCanBeReturnedAfterDeadline() public {
        TazorDepositCheckout.DepositOrder memory o = _order(2e6);
        address a = dc.depositAddress(o);
        _send(a, 1e6);
        vm.expectRevert(abi.encodeWithSelector(TazorDepositCheckout.Underpaid.selector, 1e6, 2e6));
        dc.settle(o);
        vm.expectRevert(TazorDepositCheckout.StillOpen.selector);
        dc.returnFunds(o);
        vm.warp(block.timestamp + 1 hours + 1);
        dc.returnFunds(o);
        assertEq(IERC20(address(USDT)).balanceOf(refundTo), 1e6);
    }

    function test_differentRefundAddressIsDifferentDepositAddress() public view {
        TazorDepositCheckout.DepositOrder memory o = _order(2e6);
        TazorDepositCheckout.DepositOrder memory evil = _order(2e6);
        evil.refundTo = address(0xBAD);
        assertTrue(dc.depositAddress(o) != dc.depositAddress(evil));
    }

    function test_noDoubleSettleAndLateDepositGoesBack() public {
        TazorDepositCheckout.DepositOrder memory o = _order(1e6);
        address a = dc.depositAddress(o);
        _send(a, 1e6);
        dc.settle(o);
        _send(a, 1e6);
        vm.expectRevert(TazorDepositCheckout.AlreadyPaid.selector);
        dc.settle(o);
        dc.returnFunds(o);
        assertEq(IERC20(address(USDT)).balanceOf(refundTo), 1e6);
    }

    function test_vaultOnlyMovesForCheckout() public {
        TazorDepositCheckout.DepositOrder memory o = _order(1e6);
        address a = dc.depositAddress(o);
        _send(a, 1e6);
        dc.settle(o);
        vm.expectRevert("only checkout");
        OrderVault(a).sweep(IERC20(address(USDT)), address(this), 0);
    }

    function test_merchantSignedRefundToRefundAddressOnly() public {
        TazorDepositCheckout.DepositOrder memory o = _order(1e6);
        _send(dc.depositAddress(o), 1e6);
        bytes32 id = dc.settle(o);
        bytes32 nonce = dc.refundNonce(id, 1e6, 0);
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Tether USD"), keccak256("1"), block.chainid, address(USDT)
            )
        );
        bytes32 h = keccak256(abi.encode(RECEIVE_TYPEHASH, merchant, address(dc), 1e6, 0, block.timestamp + 1 hours, nonce));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(merchantKey, keccak256(abi.encodePacked("\x19\x01", domain, h)));
        dc.refund(id, 1e6, 0, block.timestamp + 1 hours, abi.encodePacked(r, s, v));
        assertEq(IERC20(address(USDT)).balanceOf(refundTo), 1e6);
        vm.expectRevert(TazorDepositCheckout.RefundTooLarge.selector);
        dc.refund(id, 1, 0, block.timestamp + 1 hours, "");
    }
}
