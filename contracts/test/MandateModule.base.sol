// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Test.sol";
import {InvoiceAuth} from "../src/libraries/InvoiceAuth.sol";
import {TazorRoles} from "../src/interfaces/IRoleCache.sol";
import {MandateModule} from "../src/modules/MandateModule.sol";
import {TazorFixture} from "./TazorFixture.sol";

abstract contract MandateModuleBase is TazorFixture {
    MandateModule mm;
    address company;
    uint256 mandateNonce = 1;

    function setUp() public virtual override {
        super.setUp();
        mm = new MandateModule(pm);
        company = _company("mandate-co", address(mm));
        _fund(company, 8e6);
    }

    function _mandate(uint256 cap, uint64 period, uint64 duration) internal returns (MandateModule.Mandate memory) {
        return MandateModule.Mandate({
            account: company,
            payee: payee,
            capPerPeriod: cap,
            period: period,
            expiry: uint64(block.timestamp) + duration,
            nonce: mandateNonce++
        });
    }

    function _create(MandateModule.Mandate memory m, Approver memory a) internal returns (bytes32) {
        (address[] memory ap, bytes[] memory sg) = _approvals(a, mm.mandateDigest(m));
        return mm.createMandate(m, ap, sg);
    }

    function _create(MandateModule.Mandate memory m, Approver memory a, Approver memory b) internal returns (bytes32) {
        (address[] memory ap, bytes[] memory sg) = _approvals(a, b, mm.mandateDigest(m));
        return mm.createMandate(m, ap, sg);
    }

    // ---- create

    function test_typehash() public view {
        assertEq(
            mm.MANDATE_TYPEHASH(),
            keccak256(
                "Mandate(address account,address payee,uint256 capPerPeriod,uint64 period,uint64 expiry,uint256 nonce)"
            )
        );
    }

    function test_createOneApprover() public {
        MandateModule.Mandate memory m = _mandate(2e6, 1 days, 30 days);
        bytes32 id = _create(m, bob);
        assertEq(id, mm.mandateDigest(m));
        MandateModule.State memory s = mm.mandateOf(id);
        assertEq(s.account, company);
        assertEq(s.payee, payee);
        assertEq(s.cap, 2e6);
        assertEq(mm.available(id), 2e6);
        assertTrue(mm.nonceUsed(company, m.nonce));
    }

    function test_createTwoApproversAboveThreshold() public {
        MandateModule.Mandate memory m = _mandate(THRESHOLD + 1, 1 days, 30 days);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, mm.mandateDigest(m));
        vm.expectRevert(abi.encodeWithSelector(MandateModule.MandateNotEnoughApprovers.selector, 2, 1));
        mm.createMandate(m, ap, sg);
        bytes32 id = _create(m, alice, bob);
        assertEq(mm.available(id), THRESHOLD + 1);
    }

    function test_nonceCannotBeReused() public {
        MandateModule.Mandate memory m = _mandate(1e6, 1 days, 30 days);
        _create(m, bob);
        m.capPerPeriod = 2e6; // different mandate, same nonce
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, mm.mandateDigest(m));
        vm.expectRevert(abi.encodeWithSelector(MandateModule.MandateNonceUsed.selector, m.nonce));
        mm.createMandate(m, ap, sg);
    }

    function test_revokedApproverCannotCreate() public {
        _revoke(company, alice, bob.account);
        MandateModule.Mandate memory m = _mandate(1e6, 1 days, 30 days);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, mm.mandateDigest(m));
        vm.expectRevert(abi.encodeWithSelector(MandateModule.MandateRevoked.selector, bob.account));
        mm.createMandate(m, ap, sg);
    }

    function test_unverifiedSoulCannotCreate() public {
        Approver memory eve = _approver("eve", false, TazorRoles.ROLE_APPROVER);
        MandateModule.Mandate memory m = _mandate(1e6, 1 days, 30 days);
        (address[] memory ap, bytes[] memory sg) = _approvals(eve, mm.mandateDigest(m));
        vm.expectRevert(abi.encodeWithSelector(MandateModule.MandateNotVerified.selector, eve.account));
        mm.createMandate(m, ap, sg);
    }

    function test_missingRoleCannotCreate() public {
        MandateModule.Mandate memory m = _mandate(1e6, 1 days, 30 days);
        (address[] memory ap, bytes[] memory sg) = _approvals(dave, mm.mandateDigest(m));
        vm.expectRevert(abi.encodeWithSelector(MandateModule.MandateMissingRole.selector, dave.account));
        mm.createMandate(m, ap, sg);
    }

    function test_sameSoulTwiceCannotCreate() public {
        MandateModule.Mandate memory m = _mandate(THRESHOLD + 1, 1 days, 30 days);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, bob, mm.mandateDigest(m));
        vm.expectRevert(abi.encodeWithSelector(MandateModule.MandateDuplicateSoul.selector, bob.account));
        mm.createMandate(m, ap, sg);
    }

    function test_invalidSignatureCannotCreate() public {
        MandateModule.Mandate memory m = _mandate(1e6, 1 days, 30 days);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, mm.mandateDigest(m));
        m.payee = makeAddr("attacker"); // signed for `payee`
        vm.expectRevert(abi.encodeWithSelector(MandateModule.MandateInvalidSignature.selector, bob.account));
        mm.createMandate(m, ap, sg);
    }

    function test_invalidMandatesRejected() public {
        MandateModule.Mandate memory m = _mandate(1e6, 0, 30 days);
        vm.expectRevert(MandateModule.MandateInvalid.selector);
        mm.createMandate(m, new address[](0), new bytes[](0));
        m = _mandate(1e6, 1 days, 0);
        vm.expectRevert(MandateModule.MandateInvalid.selector);
        mm.createMandate(m, new address[](0), new bytes[](0));
        m = _mandate(uint256(type(uint64).max) + 1, 1 days, 1 days);
        vm.expectRevert(MandateModule.MandateInvalid.selector);
        mm.createMandate(m, new address[](0), new bytes[](0));
        m = _mandate(1e6, 1, uint64(type(uint32).max) + 1); // too many periods for the index
        vm.expectRevert(MandateModule.MandateInvalid.selector);
        mm.createMandate(m, new address[](0), new bytes[](0));
        m = _mandate(1e6, 1 days, 1 days);
        m.payee = company;
        vm.expectRevert(MandateModule.MandateInvalid.selector);
        mm.createMandate(m, new address[](0), new bytes[](0));
        m = _mandate(1e6, 1 days, 1 days);
        m.account = address(0xC0FFEE);
        vm.expectRevert(abi.encodeWithSelector(MandateModule.MandateNotConfigured.selector, address(0xC0FFEE)));
        mm.createMandate(m, new address[](0), new bytes[](0));
    }

    // ---- pull

    function test_pullWithinCapTwiceThenOverCapThenNextPeriod() public {
        bytes32 id = _create(_mandate(2e6, 1 days, 30 days), bob);
        vm.prank(makeAddr("anyone"));
        mm.pull(id, 1.5e6);
        uint256 g = gasleft();
        mm.pull(id, 0.5e6);
        console2.log("gas pull (warm mandate, same period)", g - gasleft());
        assertEq(usdt.balanceOf(payee), 2e6);
        assertEq(mm.available(id), 0);

        vm.expectRevert(abi.encodeWithSelector(MandateModule.MandateOverCap.selector, 0, 1));
        mm.pull(id, 1);

        vm.warp(block.timestamp + 1 days);
        assertEq(mm.available(id), 2e6);
        g = gasleft();
        mm.pull(id, 2e6);
        console2.log("gas pull (new period)", g - gasleft());
        assertEq(usdt.balanceOf(payee), 4e6);
        vm.expectRevert(abi.encodeWithSelector(MandateModule.MandateOverCap.selector, 0, 1));
        mm.pull(id, 1);
    }

    function test_periodsAlignToStart() public {
        bytes32 id = _create(_mandate(1e6, 1 days, 30 days), bob);
        vm.warp(block.timestamp + 1 days - 1);
        mm.pull(id, 1e6);
        vm.warp(block.timestamp + 1); // exactly one period after creation
        mm.pull(id, 1e6);
        assertEq(usdt.balanceOf(payee), 2e6);
    }

    function test_unusedCapDoesNotCarryOver() public {
        bytes32 id = _create(_mandate(1e6, 1 days, 30 days), bob);
        vm.warp(block.timestamp + 3 days);
        vm.expectRevert(abi.encodeWithSelector(MandateModule.MandateOverCap.selector, 1e6, 2e6));
        mm.pull(id, 2e6);
    }

    function test_pullAfterExpiryReverts() public {
        bytes32 id = _create(_mandate(1e6, 1 days, 2 days), bob);
        vm.warp(block.timestamp + 2 days);
        mm.pull(id, 1e6); // expiry itself is inclusive
        vm.warp(block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(MandateModule.MandateExpired.selector, id));
        mm.pull(id, 1);
        assertEq(mm.available(id), 0);
    }

    function test_pullUnknownReverts() public {
        vm.expectRevert(abi.encodeWithSelector(MandateModule.MandateUnknown.selector, bytes32(uint256(1))));
        mm.pull(bytes32(uint256(1)), 1);
    }

    /// pull has no payee argument: whoever calls it, the funds go to the mandate's payee.
    function test_wrongPayeeImpossibleByConstruction() public {
        bytes32 id = _create(_mandate(1e6, 1 days, 30 days), bob);
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        mm.pull(id, 1e6);
        assertEq(usdt.balanceOf(attacker), 0);
        assertEq(usdt.balanceOf(payee), 1e6);
    }

    function test_pullNeedsModuleInstalled() public {
        // the PaymentModule-only buyer account never installed MandateModule
        MandateModule.Mandate memory m = _mandate(1e6, 1 days, 30 days);
        m.account = buyer;
        bytes32 id = _create(m, bob);
        vm.expectRevert();
        mm.pull(id, 1);
    }

    // ---- cancel

    function test_cancelByApprover() public {
        bytes32 id = _create(_mandate(1e6, 1 days, 30 days), bob);
        mm.cancel(id, carol.account, _sign(carol, mm.cancelDigest(id)));
        assertTrue(mm.mandateOf(id).cancelled);
        vm.expectRevert(abi.encodeWithSelector(MandateModule.MandateCancelledError.selector, id));
        mm.pull(id, 1);
        assertEq(mm.available(id), 0);
    }

    function test_cancelByPayee() public {
        bytes32 id = _create(_mandate(1e6, 1 days, 30 days), bob);
        vm.prank(payee);
        mm.cancel(id, address(0), "");
        vm.expectRevert(abi.encodeWithSelector(MandateModule.MandateCancelledError.selector, id));
        mm.pull(id, 1);
    }

    function test_cancelRejectsOutsiders() public {
        bytes32 id = _create(_mandate(1e6, 1 days, 30 days), bob);
        // stranger without a signature
        vm.expectRevert(abi.encodeWithSelector(MandateModule.MandateNotVerified.selector, address(0)));
        mm.cancel(id, address(0), "");
        // verified person without the approver role
        bytes memory sig = _sign(dave, mm.cancelDigest(id));
        vm.expectRevert(abi.encodeWithSelector(MandateModule.MandateMissingRole.selector, dave.account));
        mm.cancel(id, dave.account, sig);
        // revoked approver
        _revoke(company, alice, carol.account);
        sig = _sign(carol, mm.cancelDigest(id));
        vm.expectRevert(abi.encodeWithSelector(MandateModule.MandateRevoked.selector, carol.account));
        mm.cancel(id, carol.account, sig);
        // signature for another mandate
        bytes32 other = _create(_mandate(1e6, 1 days, 30 days), bob);
        sig = _sign(bob, mm.cancelDigest(other));
        vm.expectRevert(abi.encodeWithSelector(MandateModule.MandateInvalidSignature.selector, bob.account));
        mm.cancel(id, bob.account, sig);
        assertFalse(mm.mandateOf(id).cancelled);
    }

    function test_paymentModuleStillWorksAlongside() public {
        bytes32 id = _create(_mandate(1e6, 1 days, 30 days), bob);
        mm.pull(id, 1e6);
        InvoiceAuth memory auth = _auth(company, payee, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        pm.payOne(company, auth, ap, sg);
        assertEq(usdt.balanceOf(payee), 2e6);
    }
}
