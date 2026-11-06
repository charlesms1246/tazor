// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TazorRoles} from "../src/interfaces/IRoleCache.sol";
import {MandateModuleV2} from "../src/modules/MandateModuleV2.sol";
import {TazorFixtureV2} from "./TazorFixtureV2.sol";

abstract contract MandateModuleV2Base is TazorFixtureV2 {
    MandateModuleV2 mm;
    address company;
    uint256 mandateNonce = 1;

    function setUp() public virtual override {
        super.setUp();
        mm = new MandateModuleV2(pm);
        address[] memory extra = new address[](1);
        extra[0] = address(mm);
        company = _company("mandate-co-v2", extra);
        _fund(company, 6e6);
    }

    function _mandate(uint256 cap) internal returns (MandateModuleV2.Mandate memory) {
        return MandateModuleV2.Mandate(company, payee, cap, 1 days, uint64(block.timestamp + 30 days), mandateNonce++);
    }

    function _create(MandateModuleV2.Mandate memory m, Approver memory a) internal returns (bytes32) {
        (address[] memory ap, bytes[] memory sg) = _approvals(a, mm.mandateDigest(m));
        return mm.createMandate(m, ap, sg);
    }

    function test_domainAndBinding() public view {
        (, string memory name, string memory version,, address vc,,) = mm.eip712Domain();
        assertEq(name, "Tazor");
        assertEq(version, "2");
        assertEq(vc, address(mm));
        assertEq(address(mm.paymentModule()), address(pm));
        assertEq(address(mm.usdt()), address(usdt));
    }

    function test_createOneAndTwoApproversThenPull() public {
        bytes32 id = _create(_mandate(2e6), bob);
        mm.pull(id, 1.5e6);
        mm.pull(id, 0.5e6);
        assertEq(usdt.balanceOf(payee), 2e6);
        vm.expectRevert(abi.encodeWithSelector(MandateModuleV2.MandateOverCap.selector, 0, 1));
        mm.pull(id, 1);

        MandateModuleV2.Mandate memory big = _mandate(TWO_APPROVER + 1);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, mm.mandateDigest(big));
        vm.expectRevert(abi.encodeWithSelector(MandateModuleV2.MandateNotEnoughApprovers.selector, 2, 1));
        mm.createMandate(big, ap, sg);
        (ap, sg) = _approvals(alice, bob, mm.mandateDigest(big));
        mm.createMandate(big, ap, sg);
    }

    /// Pulls are not counted against PaymentModuleV2 limits and need no payee approval.
    function test_pullsBypassPaymentLimitsByDesign() public {
        bytes32 id = _create(_mandate(2e6), bob);
        assertFalse(pm.isPayeeAllowed(company, payee));
        (uint256 before,) = pm.windowAvailable(company);
        mm.pull(id, 2e6);
        (uint256 afterPull,) = pm.windowAvailable(company);
        assertEq(afterPull, before);
    }

    function test_expiredContractorCannotCreate() public {
        _expiry(company, bob, uint64(block.timestamp + 10));
        vm.warp(block.timestamp + 11);
        MandateModuleV2.Mandate memory m = _mandate(1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, mm.mandateDigest(m));
        vm.expectRevert(abi.encodeWithSelector(MandateModuleV2.MandateNotVerified.selector, bob.account));
        mm.createMandate(m, ap, sg);
    }

    function test_revokedCannotCreate() public {
        uint256 deadline = block.timestamp + 1 hours;
        revocations.revoke(company, bob.account, alice.account, deadline, _sign(alice, revocations.revokeDigest(company, bob.account, deadline)));
        MandateModuleV2.Mandate memory m = _mandate(1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, mm.mandateDigest(m));
        vm.expectRevert(abi.encodeWithSelector(MandateModuleV2.MandateNotVerified.selector, bob.account));
        mm.createMandate(m, ap, sg);
    }

    function test_unverifiedAndRolelessCannotCreate() public {
        Approver memory eve = _approver("eve", false, TazorRoles.ROLE_APPROVER);
        MandateModuleV2.Mandate memory m = _mandate(1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(eve, mm.mandateDigest(m));
        vm.expectRevert(abi.encodeWithSelector(MandateModuleV2.MandateNotVerified.selector, eve.account));
        mm.createMandate(m, ap, sg);
        (ap, sg) = _approvals(dave, mm.mandateDigest(m));
        vm.expectRevert(abi.encodeWithSelector(MandateModuleV2.MandateMissingRole.selector, dave.account));
        mm.createMandate(m, ap, sg);
    }

    function test_provisionalGranteeCanCreate() public {
        _grant(company, dave, TazorRoles.ROLE_APPROVER, uint64(block.timestamp + 600));
        _create(_mandate(1e6), dave);
    }

    function test_cancelThenPullReverts() public {
        bytes32 id = _create(_mandate(1e6), bob);
        mm.cancel(id, carol.account, _sign(carol, mm.cancelDigest(id)));
        vm.expectRevert(abi.encodeWithSelector(MandateModuleV2.MandateCancelledError.selector, id));
        mm.pull(id, 1);
    }

    function test_expiryAndUnknown() public {
        bytes32 id = _create(_mandate(1e6), bob);
        vm.warp(block.timestamp + 30 days + 1);
        vm.expectRevert(abi.encodeWithSelector(MandateModuleV2.MandateExpired.selector, id));
        mm.pull(id, 1);
        vm.expectRevert(abi.encodeWithSelector(MandateModuleV2.MandateUnknown.selector, bytes32(uint256(7))));
        mm.pull(bytes32(uint256(7)), 1);
    }
}
