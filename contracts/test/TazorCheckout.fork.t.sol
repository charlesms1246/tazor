// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TazorCheckout, IUSDT3009} from "../src/checkout/TazorCheckout.sol";

/// Runs against the real Whitechain Sepolia USDT (TetherTokenV2): forge test --match-contract TazorCheckoutFork --fork-url $WC_TESTNET_RPC
contract TazorCheckoutForkTest is Test {
    IUSDT3009 constant USDT = IUSDT3009(0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7);
    bytes32 constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    TazorCheckout checkout;
    uint256 payerKey = 0xA11CE;
    uint256 merchantKey = 0xB0B;
    address payer;
    address merchant;
    address relayer = address(0xBEEF);

    function setUp() public {
        if (block.chainid != 1874) {
            vm.skip(true);
            return;
        }
        payer = vm.addr(payerKey);
        merchant = vm.addr(merchantKey);
        checkout = new TazorCheckout(USDT);
        deal(address(USDT), payer, 100e6);
        deal(address(USDT), merchant, 10e6);
    }

    function _domain() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Tether USD"), keccak256("1"), block.chainid, address(USDT)
            )
        );
    }

    function _sign3009(uint256 key, uint256 value, uint256 validBefore, bytes32 nonce) internal view returns (bytes memory) {
        bytes32 h = keccak256(abi.encode(RECEIVE_TYPEHASH, vm.addr(key), address(checkout), value, 0, validBefore, nonce));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", _domain(), h)));
        return abi.encodePacked(r, s, v);
    }

    function _order(uint256 amount) internal view returns (TazorCheckout.Order memory) {
        return TazorCheckout.Order({merchant: merchant, amount: amount, ref: keccak256("BJ-1042"), deadline: uint64(block.timestamp + 1 hours)});
    }

    function test_domainMatchesToken() public view {
        (bool ok, bytes memory out) = address(USDT).staticcall(abi.encodeWithSignature("DOMAIN_SEPARATOR()"));
        assertTrue(ok);
        assertEq(abi.decode(out, (bytes32)), _domain());
    }

    function test_payByAnyoneGoesToMerchant() public {
        TazorCheckout.Order memory o = _order(1_550_000);
        bytes memory sig = _sign3009(payerKey, o.amount, block.timestamp + 1 hours, checkout.payNonce(o));
        uint256 before = USDT.balanceOf(merchant);
        vm.prank(relayer);
        bytes32 id = checkout.pay(o, payer, 0, block.timestamp + 1 hours, sig);
        assertEq(USDT.balanceOf(merchant) - before, o.amount);
        assertEq(USDT.balanceOf(address(checkout)), 0);
        (address m, address p, uint256 amount,,,) = checkout.payment(id);
        assertEq(m, merchant);
        assertEq(p, payer);
        assertEq(amount, o.amount);
    }

    function test_cannotRedirectSignatureToAnotherMerchant() public {
        TazorCheckout.Order memory o = _order(1e6);
        bytes memory sig = _sign3009(payerKey, o.amount, block.timestamp + 1 hours, checkout.payNonce(o));
        TazorCheckout.Order memory evil = o;
        evil.merchant = relayer;
        vm.expectRevert();
        checkout.pay(evil, payer, 0, block.timestamp + 1 hours, sig);
    }

    function test_cannotChangeAmount() public {
        TazorCheckout.Order memory o = _order(1e6);
        bytes memory sig = _sign3009(payerKey, o.amount, block.timestamp + 1 hours, checkout.payNonce(o));
        o.amount = 2e6;
        vm.expectRevert();
        checkout.pay(o, payer, 0, block.timestamp + 1 hours, sig);
    }

    function test_noDoublePay() public {
        TazorCheckout.Order memory o = _order(1e6);
        bytes memory sig = _sign3009(payerKey, o.amount, block.timestamp + 1 hours, checkout.payNonce(o));
        checkout.pay(o, payer, 0, block.timestamp + 1 hours, sig);
        vm.expectRevert(TazorCheckout.AlreadyPaid.selector);
        checkout.pay(o, payer, 0, block.timestamp + 1 hours, sig);
    }

    function test_expiredOrderReverts() public {
        TazorCheckout.Order memory o = _order(1e6);
        bytes memory sig = _sign3009(payerKey, o.amount, block.timestamp + 2 hours, checkout.payNonce(o));
        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert(TazorCheckout.Expired.selector);
        checkout.pay(o, payer, 0, block.timestamp + 2 hours, sig);
    }

    function _paid(uint256 amount) internal returns (bytes32 id) {
        TazorCheckout.Order memory o = _order(amount);
        id = checkout.pay(o, payer, 0, block.timestamp + 1 hours, _sign3009(payerKey, amount, block.timestamp + 1 hours, checkout.payNonce(o)));
    }

    function test_partialRefundsOnlyToPayerCapped() public {
        bytes32 id = _paid(1e6);
        uint256 before = USDT.balanceOf(payer);
        bytes memory s1 = _sign3009(merchantKey, 400_000, block.timestamp + 1 hours, checkout.refundNonce(id, 400_000, 0));
        vm.prank(relayer);
        checkout.refund(id, 400_000, 0, block.timestamp + 1 hours, s1);
        assertEq(USDT.balanceOf(payer) - before, 400_000);

        bytes memory s2 = _sign3009(merchantKey, 700_000, block.timestamp + 1 hours, checkout.refundNonce(id, 700_000, 1));
        vm.expectRevert(TazorCheckout.RefundTooLarge.selector);
        checkout.refund(id, 700_000, 0, block.timestamp + 1 hours, s2);

        bytes memory s3 = _sign3009(merchantKey, 600_000, block.timestamp + 1 hours, checkout.refundNonce(id, 600_000, 1));
        checkout.refund(id, 600_000, 0, block.timestamp + 1 hours, s3);
        (,,, uint256 refunded,, uint32 refunds) = checkout.payment(id);
        assertEq(refunded, 1e6);
        assertEq(refunds, 2);
    }

    function test_refundNeedsMerchantSignature() public {
        bytes32 id = _paid(1e6);
        bytes memory forged = _sign3009(payerKey, 1e6, block.timestamp + 1 hours, checkout.refundNonce(id, 1e6, 0));
        vm.expectRevert();
        checkout.refund(id, 1e6, 0, block.timestamp + 1 hours, forged);
    }

    function test_refundUnpaidReverts() public {
        vm.expectRevert(TazorCheckout.NotPaid.selector);
        checkout.refund(bytes32(uint256(1)), 1, 0, 1, "");
    }

    // ---------------------------------------------------------------- subscriptions

    function _plan() internal view returns (TazorCheckout.Plan memory) {
        return TazorCheckout.Plan({merchant: merchant, amount: 100_000, period: 7 days, cycles: 4, ref: keccak256("lane-weekly")});
    }

    function _permit(uint256 value, uint256 deadline) internal view returns (bytes memory) {
        (bool ok, bytes memory out) = address(USDT).staticcall(abi.encodeWithSignature("nonces(address)", payer));
        require(ok);
        bytes32 h = keccak256(abi.encode(PERMIT_TYPEHASH, payer, address(checkout), value, abi.decode(out, (uint256)), deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, keccak256(abi.encodePacked("\x19\x01", _domain(), h)));
        return abi.encodePacked(r, s, v);
    }

    function _subscribe() internal returns (bytes32 id) {
        TazorCheckout.Plan memory p = _plan();
        bytes memory first = _sign3009(payerKey, p.amount, block.timestamp + 1 hours, checkout.subNonce(p, payer));
        id = checkout.subscribe(
            p, payer, TazorCheckout.Auth(0, block.timestamp + 1 hours, first),
            TazorCheckout.Auth(300_000, block.timestamp + 1 hours, _permit(300_000, block.timestamp + 1 hours))
        );
    }

    function test_subscriptionLifecycle() public {
        uint256 before = USDT.balanceOf(merchant);
        bytes32 id = _subscribe();
        assertEq(USDT.balanceOf(merchant) - before, 100_000);

        vm.expectRevert(TazorCheckout.NotDue.selector);
        checkout.charge(id);

        vm.warp(block.timestamp + 7 days);
        vm.prank(relayer);
        checkout.charge(id);
        vm.warp(block.timestamp + 7 days);
        checkout.charge(id);
        vm.warp(block.timestamp + 7 days);
        checkout.charge(id);
        assertEq(USDT.balanceOf(merchant) - before, 400_000);
        assertEq(checkout.nextChargeAt(id), 0);

        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(TazorCheckout.NotActive.selector);
        checkout.charge(id);
    }

    function test_cancelBySigStopsPulls() public {
        bytes32 id = _subscribe();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, checkout.cancelDigest(id));
        vm.prank(relayer);
        checkout.cancelBySig(id, payer, abi.encodePacked(r, s, v));
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(TazorCheckout.NotActive.selector);
        checkout.charge(id);
    }

    function test_strangerCannotCancel() public {
        bytes32 id = _subscribe();
        vm.prank(relayer);
        vm.expectRevert(TazorCheckout.NotParty.selector);
        checkout.cancel(id);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xD00D, checkout.cancelDigest(id));
        vm.expectRevert(TazorCheckout.NotParty.selector);
        checkout.cancelBySig(id, vm.addr(0xD00D), abi.encodePacked(r, s, v));
    }

    function test_subscriptionTermsBoundToSignature() public {
        TazorCheckout.Plan memory p = _plan();
        bytes memory first = _sign3009(payerKey, p.amount, block.timestamp + 1 hours, checkout.subNonce(p, payer));
        p.period = 1; // a relayer trying to pull every second
        vm.expectRevert();
        checkout.subscribe(p, payer, TazorCheckout.Auth(0, block.timestamp + 1 hours, first), TazorCheckout.Auth(0, 0, ""));
    }
}
