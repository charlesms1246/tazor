// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Test.sol";
import {InvoiceAuth} from "../src/libraries/InvoiceAuth.sol";
import {PaymentModuleV2} from "../src/modules/PaymentModuleV2.sol";
import {TazorRoles} from "../src/interfaces/IRoleCache.sol";
import {TazorFixtureV2} from "./TazorFixtureV2.sol";

/// Calls payOne several times in one transaction (as a relayer multicall would), to exercise the
/// transient status cache.
contract BatchPayer {
    function payMany(
        PaymentModuleV2 pm,
        address account,
        InvoiceAuth[] calldata auths,
        address[][] calldata approvers,
        bytes[][] calldata sigs
    ) external returns (uint256[] memory gasUsed) {
        gasUsed = new uint256[](auths.length);
        for (uint256 i; i < auths.length; ++i) {
            uint256 g = gasleft();
            pm.payOne(account, auths[i], approvers[i], sigs[i]);
            gasUsed[i] = g - gasleft();
        }
    }
}

abstract contract PaymentModuleV2Base is TazorFixtureV2 {
    // ---- basics carried over from v1

    function test_payOneToAddedTazorAccount() public {
        _pay(buyer, supplierAccount, 1e6, bob);
        assertEq(usdt.balanceOf(supplierAccount), 4e6);
    }

    /// Being a Tazor account is not enough: anyone can create one, so it must be added like any payee.
    function test_freshTazorAccountPayeeNotAddedIsRefused() public {
        address fresh = _company("attacker-co", new address[](0));
        assertTrue(pm.isTazorAccount(fresh));
        assertFalse(pm.isPayeeAllowed(buyer, fresh));
        InvoiceAuth memory auth = _auth(buyer, fresh, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentPayeeNotAllowed.selector, fresh));
        pm.payOne(buyer, auth, ap, sg);
        // same for runs, the L1 path and agents
        InvoiceAuth[] memory run = new InvoiceAuth[](1);
        run[0] = auth;
        (ap, sg) = _approvals(bob, pm.runDigest(run));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentPayeeNotAllowed.selector, fresh));
        pm.payRun(buyer, run, ap, sg);
        (ap, sg) = _approvals(dave, pm.invoiceDigest(auth));
        vm.prank(ensGateAlias);
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentPayeeNotAllowed.selector, fresh));
        pm.payFromL1(REGISTRY, buyer, auth, ap, sg);
        bytes memory agentSig = _sign(ann, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentPayeeNotAllowed.selector, fresh));
        pm.payAsAgent(buyer, auth, ann.account, agentSig);
        // added, but before the delay: still refused; after the delay: paid
        _addPayee(buyer, fresh, alice);
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentPayeeNotAllowed.selector, fresh));
        pm.payAsAgent(buyer, auth, ann.account, agentSig);
        vm.warp(block.timestamp + PAYEE_DELAY);
        pm.payAsAgent(buyer, auth, ann.account, agentSig);
        assertEq(usdt.balanceOf(fresh), 1e6);
    }

    function test_domainIsVersion2() public view {
        (, string memory name, string memory version,, address vc,,) = pm.eip712Domain();
        assertEq(name, "Tazor");
        assertEq(version, "2");
        assertEq(vc, address(pm));
    }

    function test_viewsForOtherModules() public view {
        (uint256 roles, bool valid) = pm.approverStatus(buyer, bob.account);
        assertEq(roles, TazorRoles.ROLE_APPROVER);
        assertTrue(valid);
        (roles, valid) = pm.approverStatus(buyer, dave.account);
        assertEq(roles, 0);
        assertTrue(valid);
        assertTrue(pm.isTazorAccount(buyer));
        assertFalse(pm.isTazorAccount(bob.account), "ApproverAccount clones are not company accounts");
        assertFalse(pm.isTazorAccount(payee));
        assertEq(pm.twoApproverThresholdOf(buyer), TWO_APPROVER);
        assertEq(pm.configOf(buyer).registry, REGISTRY);
        assertEq(pm.configOf(buyer).twoApproverThreshold, TWO_APPROVER);
        assertEq(pm.registryOf(buyer), REGISTRY);
        assertEq(address(pm.usdt()), address(usdt));
        assertEq(address(pm.soulRegistry()), address(mirror));
        assertEq(address(pm.attributeRegistry()), address(mirror));
        assertEq(pm.isVerifiedAttribute(), IS_VERIFIED);
        PaymentModuleV2.ConfigV2 memory c = pm.configV2Of(buyer);
        assertEq(c.exitAccounts.length, 1);
        assertEq(c.exitAccounts[0], treasury);
        assertEq(c.monthlyLimit, MONTHLY);
    }

    function test_invalidConfigRejected() public {
        PaymentModuleV2.ConfigV2 memory c = _configV2();
        c.monthlyLimit = c.perPaymentLimit - 1;
        vm.prank(makeAddr("some-account"));
        vm.expectRevert(PaymentModuleV2.PaymentInvalidConfig.selector);
        pm.onInstall(abi.encode(c));
    }

    // ---- 1. limits

    function test_perPaymentLimit() public {
        InvoiceAuth memory auth = _auth(buyer, supplierAccount, PER_PAYMENT + 1);
        (address[] memory ap, bytes[] memory sg) = _approvals(alice, bob, pm.invoiceDigest(auth));
        vm.expectRevert(
            abi.encodeWithSelector(PaymentModuleV2.PaymentOverPerPaymentLimit.selector, PER_PAYMENT, PER_PAYMENT + 1)
        );
        pm.payOne(buyer, auth, ap, sg);
    }

    function test_monthlyLimitThenNextWindow() public {
        _pay2(buyer, supplierAccount, 8e6);
        _pay2(buyer, supplierAccount, 8e6);
        InvoiceAuth memory auth = _auth(buyer, supplierAccount, 5e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(alice, bob, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentOverMonthlyLimit.selector, 4e6, 5e6));
        pm.payOne(buyer, auth, ap, sg);
        (uint256 company,) = pm.windowAvailable(buyer);
        assertEq(company, 4e6);

        vm.warp(block.timestamp + 30 days);
        auth = _auth(buyer, supplierAccount, 5e6);
        (ap, sg) = _approvals(alice, bob, pm.invoiceDigest(auth));
        pm.payOne(buyer, auth, ap, sg);
        (company,) = pm.windowAvailable(buyer);
        assertEq(company, 15e6);
    }

    function test_payRunCountsTotalAgainstMonthlyLimit() public {
        _pay2(buyer, supplierAccount, 8e6);
        _pay2(buyer, supplierAccount, 8e6);
        InvoiceAuth[] memory auths = new InvoiceAuth[](5);
        for (uint256 i; i < 5; i++) {
            auths[i] = _auth(buyer, supplierAccount, 1e6);
        }
        (address[] memory ap, bytes[] memory sg) = _approvals(alice, bob, pm.runDigest(auths));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentOverMonthlyLimit.selector, 4e6, 5e6));
        pm.payRun(buyer, auths, ap, sg);
    }

    function test_payRunPerInvoiceLimit() public {
        InvoiceAuth[] memory auths = new InvoiceAuth[](2);
        auths[0] = _auth(buyer, supplierAccount, 1e6);
        auths[1] = _auth(buyer, supplierAccount, PER_PAYMENT + 1);
        (address[] memory ap, bytes[] memory sg) = _approvals(alice, bob, pm.runDigest(auths));
        vm.expectRevert(
            abi.encodeWithSelector(PaymentModuleV2.PaymentOverPerPaymentLimit.selector, PER_PAYMENT, PER_PAYMENT + 1)
        );
        pm.payRun(buyer, auths, ap, sg);
    }

    function test_payFromL1CountsAgainstLimits() public {
        _pay2(buyer, supplierAccount, 8e6);
        _pay2(buyer, supplierAccount, 8e6);
        InvoiceAuth memory auth = _auth(buyer, supplierAccount, 5e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(alice, bob, pm.invoiceDigest(auth));
        vm.prank(ensGateAlias);
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentOverMonthlyLimit.selector, 4e6, 5e6));
        pm.payFromL1(REGISTRY, buyer, auth, ap, sg);

        auth = _auth(buyer, supplierAccount, 4e6);
        (ap, sg) = _approvals(dave, pm.invoiceDigest(auth)); // no cached role: EnsGate checked ENS
        vm.prank(ensGateAlias);
        pm.payFromL1(REGISTRY, buyer, auth, ap, sg);
    }

    function test_payFromL1Guards() public {
        InvoiceAuth memory auth = _auth(buyer, supplierAccount, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentNotEnsGate.selector, address(this)));
        pm.payFromL1(REGISTRY, buyer, auth, ap, sg);
        vm.prank(ensGateAlias);
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentWrongRegistry.selector, address(0xBAD)));
        pm.payFromL1(address(0xBAD), buyer, auth, ap, sg);
    }

    // ---- 2. new-payee delay

    function test_unknownPayeeRejected() public {
        InvoiceAuth memory auth = _auth(buyer, payee, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentPayeeNotAllowed.selector, payee));
        pm.payOne(buyer, auth, ap, sg);
    }

    function test_addedPayeeAfterDelay() public {
        _addPayee(buyer, payee, alice);
        assertFalse(pm.isPayeeAllowed(buyer, payee));
        InvoiceAuth memory auth = _auth(buyer, payee, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentPayeeNotAllowed.selector, payee));
        pm.payOne(buyer, auth, ap, sg);

        vm.warp(block.timestamp + PAYEE_DELAY);
        assertTrue(pm.isPayeeAllowed(buyer, payee));
        auth = _auth(buyer, payee, 1e6);
        (ap, sg) = _approvals(bob, pm.invoiceDigest(auth));
        pm.payOne(buyer, auth, ap, sg);
        assertEq(usdt.balanceOf(payee), 1e6);
        assertFalse(pm.isPayeeAllowed(supplierAccount, payee), "payees are per account");
    }

    function test_addPayeeOnlyByAdmin() public {
        uint256 d = _deadline();
        bytes32 digest = pm.typedDigest(keccak256(abi.encode(pm.ADD_PAYEE_TYPEHASH(), buyer, payee, d)));
        bytes memory sig = _sign(bob, digest);
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentMissingRole.selector, bob.account));
        pm.addPayee(buyer, payee, bob.account, d, sig);
        // a provisional grant can never make someone an admin
        vm.expectRevert(PaymentModuleV2.PaymentInvalidGrant.selector);
        pm.provisionalGrant(buyer, bob.account, TazorRoles.ROLE_TAZOR_ADMIN, uint64(block.timestamp + 60), alice.account, d, "");
    }

    function test_adminSignaturesAreSingleUse() public {
        uint256 d = _deadline();
        bytes32 digest = pm.typedDigest(keccak256(abi.encode(pm.ADD_PAYEE_TYPEHASH(), buyer, payee, d)));
        bytes memory sig = _sign(alice, digest);
        pm.addPayee(buyer, payee, alice.account, d, sig);
        vm.expectRevert(PaymentModuleV2.PaymentSignatureUsed.selector);
        pm.addPayee(buyer, payee, alice.account, d, sig);
        vm.warp(d + 1);
        bytes32 late = pm.typedDigest(keccak256(abi.encode(pm.ADD_PAYEE_TYPEHASH(), buyer, makeAddr("p2"), d)));
        sig = _sign(alice, late);
        vm.expectRevert(PaymentModuleV2.PaymentDeadlinePassed.selector);
        pm.addPayee(buyer, makeAddr("p2"), alice.account, d, sig);
    }

    function test_revokedAdminCannotAddPayee() public {
        uint256 deadline = block.timestamp + 1 hours;
        revocations.revoke(
            buyer, alice.account, alice.account, deadline,
            _sign(alice, revocations.revokeDigest(buyer, alice.account, deadline))
        );
        uint256 d = _deadline();
        bytes32 digest = pm.typedDigest(keccak256(abi.encode(pm.ADD_PAYEE_TYPEHASH(), buyer, payee, d)));
        bytes memory sig = _sign(alice, digest);
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentNotVerified.selector, alice.account));
        pm.addPayee(buyer, payee, alice.account, d, sig);
    }

    // ---- 3. fresh-proof rule

    function test_freshRuleAboveThreshold() public {
        _setRoles(bob, TazorRoles.ROLE_APPROVER, _l1Now() - MAX_CACHE_AGE - 1);
        InvoiceAuth memory auth = _auth(buyer, supplierAccount, FRESH + 1);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        vm.expectRevert(
            abi.encodeWithSelector(
                PaymentModuleV2.PaymentStaleRoles.selector, bob.account, _l1Now() - MAX_CACHE_AGE - 1, _l1Now() - MAX_CACHE_AGE
            )
        );
        pm.payOne(buyer, auth, ap, sg);
        // at or below the threshold a stale cache is fine
        _pay(buyer, supplierAccount, FRESH, bob);
        // exactly maxCacheAge old is still fresh (new transaction)
        _setRoles(bob, TazorRoles.ROLE_APPROVER, _l1Now() - MAX_CACHE_AGE);
        vm.warp(block.timestamp + 1);
        _pay(buyer, supplierAccount, FRESH + 1, bob);
    }

    function test_provisionalRolesDoNotSatisfyFreshRule() public {
        _grant(buyer, dave, TazorRoles.ROLE_APPROVER, uint64(block.timestamp + 600));
        InvoiceAuth memory auth = _auth(buyer, supplierAccount, FRESH + 1);
        (address[] memory ap, bytes[] memory sg) = _approvals(dave, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentMissingRole.selector, dave.account));
        pm.payOne(buyer, auth, ap, sg);
        _pay(buyer, supplierAccount, FRESH, dave);
    }

    // ---- 4. provisional grants

    function test_provisionalGrantForTenMinutes() public {
        InvoiceAuth memory auth = _auth(buyer, supplierAccount, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(dave, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentMissingRole.selector, dave.account));
        pm.payOne(buyer, auth, ap, sg);

        _grant(buyer, dave, TazorRoles.ROLE_APPROVER, uint64(block.timestamp + 600));
        (uint256 roles,) = pm.approverStatus(buyer, dave.account);
        assertEq(roles, TazorRoles.ROLE_APPROVER);
        vm.warp(block.timestamp + 590);
        pm.payOne(buyer, _reauth(auth), _one(dave.account), _oneSig(dave, _reauth(auth)));

        vm.warp(block.timestamp + 11);
        InvoiceAuth memory late = _auth(buyer, supplierAccount, 1e6);
        (ap, sg) = _approvals(dave, pm.invoiceDigest(late));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentMissingRole.selector, dave.account));
        pm.payOne(buyer, late, ap, sg);
        (roles,) = pm.approverStatus(buyer, dave.account);
        assertEq(roles, 0);
    }

    function test_provisionalGrantBounds() public {
        uint256 d = _deadline();
        vm.expectRevert(PaymentModuleV2.PaymentInvalidGrant.selector);
        pm.provisionalGrant(buyer, dave.account, TazorRoles.ROLE_APPROVER, uint64(block.timestamp + 601), alice.account, d, "");
        uint64 until = uint64(block.timestamp + 300);
        bytes32 digest = pm.typedDigest(
            keccak256(abi.encode(pm.PROVISIONAL_GRANT_TYPEHASH(), buyer, dave.account, TazorRoles.ROLE_APPROVER, until, d))
        );
        bytes memory sig = _sign(bob, digest);
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentMissingRole.selector, bob.account));
        pm.provisionalGrant(buyer, dave.account, TazorRoles.ROLE_APPROVER, until, bob.account, d, sig);
    }

    // ---- 5. contractor expiry

    function test_contractorExpiry() public {
        _expiry(buyer, bob, uint64(block.timestamp + 1 hours));
        _pay(buyer, supplierAccount, 1e6, bob);
        vm.warp(block.timestamp + 1 hours + 1);
        InvoiceAuth memory auth = _auth(buyer, supplierAccount, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentNotVerified.selector, bob.account));
        pm.payOne(buyer, auth, ap, sg);
        (uint256 roles, bool valid) = pm.approverStatus(buyer, bob.account);
        assertEq(roles, TazorRoles.ROLE_APPROVER, "the ENS role remains");
        assertFalse(valid);
        // per account: bob still approves for the supplier
        _pay(supplierAccount, buyer, 1e6, bob);
    }

    function test_oldExpirySignatureCannotBeReplayed() public {
        (bytes memory farSig, uint256 d) = _expiry(buyer, bob, uint64(block.timestamp + 365 days));
        _expiry(buyer, bob, uint64(block.timestamp)); // fire the contractor now
        vm.expectRevert(PaymentModuleV2.PaymentSignatureUsed.selector);
        pm.setApproverExpiry(buyer, bob.account, uint64(block.timestamp + 365 days), alice.account, d, farSig);
    }

    // ---- 6. agents

    function test_agentPaysWithinCap() public {
        InvoiceAuth memory auth = _auth(buyer, supplierAccount, 2e6);
        pm.payAsAgent(buyer, auth, ann.account, _sign(ann, pm.invoiceDigest(auth)));
        (, uint256 agents) = pm.windowAvailable(buyer);
        assertEq(agents, 1e6);

        auth = _auth(buyer, supplierAccount, 1e6 + 1);
        bytes memory sig = _sign(ann, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentOverAgentCap.selector, 1e6, 1e6 + 1));
        pm.payAsAgent(buyer, auth, ann.account, sig);

        vm.warp(block.timestamp + 30 days);
        auth = _auth(buyer, supplierAccount, 3e6);
        pm.payAsAgent(buyer, auth, ann.account, _sign(ann, pm.invoiceDigest(auth)));
        assertTrue(pm.isPaid(buyer, auth.nonce), "same paid bitmap");
    }

    function test_agentRules() public {
        InvoiceAuth memory auth = _auth(buyer, supplierAccount, 1e6);
        bytes memory sig = _sign(bob, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentMissingRole.selector, bob.account));
        pm.payAsAgent(buyer, auth, bob.account, sig);
        // forged signature
        sig = _sign(bob, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentInvalidSignature.selector, ann.account));
        pm.payAsAgent(buyer, auth, ann.account, sig);
        // payee rule applies to agents
        InvoiceAuth memory toNew = _auth(buyer, payee, 1e6);
        sig = _sign(ann, pm.invoiceDigest(toNew));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentPayeeNotAllowed.selector, payee));
        pm.payAsAgent(buyer, toNew, ann.account, sig);
        // revoked agent
        uint256 deadline = block.timestamp + 1 hours;
        revocations.revoke(buyer, ann.account, alice.account, deadline, _sign(alice, revocations.revokeDigest(buyer, ann.account, deadline)));
        sig = _sign(ann, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentNotVerified.selector, ann.account));
        pm.payAsAgent(buyer, auth, ann.account, sig);
    }

    function test_provisionalAgent() public {
        _grant(buyer, dave, TazorRoles.ROLE_AGENT, uint64(block.timestamp + 600));
        InvoiceAuth memory auth = _auth(buyer, supplierAccount, 1e6);
        pm.payAsAgent(buyer, auth, dave.account, _sign(dave, pm.invoiceDigest(auth)));
    }

    // ---- 7. transient cache

    function test_transientStatusCacheInOneTransaction() public {
        BatchPayer batch = new BatchPayer();
        uint256 n = 4;
        InvoiceAuth[] memory auths = new InvoiceAuth[](n);
        address[][] memory ap = new address[][](n);
        bytes[][] memory sg = new bytes[][](n);
        for (uint256 i; i < n; i++) {
            auths[i] = _auth(buyer, supplierAccount, 1e6);
            (ap[i], sg[i]) = _approvals(bob, pm.invoiceDigest(auths[i]));
        }
        uint256[] memory gasUsed = batch.payMany(pm, buyer, auths, ap, sg);
        console2.log("payOne #1 in tx (status + payee computed)", gasUsed[0]);
        console2.log("payOne #2 in tx (status + payee from transient cache)", gasUsed[1]);
        console2.log("payOne #3 in tx", gasUsed[2]);
        assertLt(gasUsed[1], gasUsed[0]);
        assertEq(usdt.balanceOf(supplierAccount), 3e6 + 4e6);
    }

    /// A successful payment caches bob as valid; an expiry set later in the same tx must still apply.
    function test_expiryInvalidatesCachedStatusInSameTransaction() public {
        vm.warp(block.timestamp + 1000);
        BatchPayExpirePay helper = new BatchPayExpirePay();
        InvoiceAuth memory a1 = _auth(buyer, supplierAccount, 1e6);
        InvoiceAuth memory a2 = _auth(buyer, supplierAccount, 1e6);
        uint64 until = uint64(block.timestamp - 1);
        uint256 d = _deadline();
        bytes memory expirySig = _sign(
            alice, pm.typedDigest(keccak256(abi.encode(pm.APPROVER_EXPIRY_TYPEHASH(), buyer, bob.account, until, d)))
        );
        bool secondPaid = helper.run(
            pm,
            BatchPayExpirePay.Args(
                buyer, a1, a2, bob.account, _sign(bob, pm.invoiceDigest(a1)), _sign(bob, pm.invoiceDigest(a2)),
                alice.account, until, d, expirySig
            )
        );
        assertTrue(pm.isPaid(buyer, a1.nonce));
        assertFalse(secondPaid, "stale cached status must not be reused");
        assertFalse(pm.isPaid(buyer, a2.nonce));
    }

    function test_payRun10Gas() public {
        InvoiceAuth[] memory auths = new InvoiceAuth[](10);
        for (uint256 i; i < 10; i++) {
            auths[i] = _auth(buyer, supplierAccount, 1e6);
        }
        (address[] memory ap, bytes[] memory sg) = _approvals(alice, bob, pm.runDigest(auths));
        uint256 g = gasleft();
        pm.payRun(buyer, auths, ap, sg);
        console2.log("v2 payRun(10) same payee, per invoice", (g - gasleft()) / 10);
    }

    // ---- 8. time-locked exit

    function _requestExit(Approver memory who) internal returns (bytes memory sig, uint256 d) {
        d = _deadline();
        sig = _sign(who, pm.typedDigest(keccak256(abi.encode(pm.REQUEST_EXIT_TYPEHASH(), buyer, uint256(0), d))));
        pm.requestExit(buyer, 0, who.account, d, sig);
    }

    function _cancelExit(Approver memory who) internal {
        uint256 d = _deadline();
        bytes memory sig = _sign(who, pm.typedDigest(keccak256(abi.encode(pm.CANCEL_EXIT_TYPEHASH(), buyer, d))));
        pm.cancelExit(buyer, who.account, d, sig);
    }

    function test_exitRequestThenCancel() public {
        (bytes memory sig, uint256 d) = _requestExit(bob);
        (address to,) = pm.pendingExit(buyer);
        assertEq(to, treasury);
        _cancelExit(carol);
        (to,) = pm.pendingExit(buyer);
        assertEq(to, address(0));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentNoExit.selector, buyer));
        pm.executeExit(buyer);
        // the request signature cannot be replayed to re-open it
        vm.expectRevert(PaymentModuleV2.PaymentSignatureUsed.selector);
        pm.requestExit(buyer, 0, bob.account, d, sig);
    }

    function test_exitExecutesAfterDelay() public {
        _requestExit(bob);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentModuleV2.PaymentExitTooEarly.selector, uint64(block.timestamp + EXIT_DELAY))
        );
        pm.executeExit(buyer);
        uint256 balance = usdt.balanceOf(buyer);
        vm.warp(block.timestamp + EXIT_DELAY);
        vm.prank(makeAddr("anyone"));
        pm.executeExit(buyer);
        assertEq(usdt.balanceOf(treasury), balance);
        assertEq(usdt.balanceOf(buyer), 0);
    }

    function test_exitWhenWhiteBitRevokedEveryone() public {
        uint256 soul = mirror.soulOf(bob.account);
        vm.prank(whitebit);
        mirror.setAttribute(soul, IS_VERIFIED, bytes20(0));
        _requestExit(bob); // soul status ignored for the request
        // but an unverified approver can't cancel
        uint256 d = _deadline();
        bytes memory sig = _sign(bob, pm.typedDigest(keccak256(abi.encode(pm.CANCEL_EXIT_TYPEHASH(), buyer, d))));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentNotVerified.selector, bob.account));
        pm.cancelExit(buyer, bob.account, d, sig);
    }

    function test_exitRequestRules() public {
        uint256 d = _deadline();
        bytes memory sig = _sign(dave, pm.typedDigest(keccak256(abi.encode(pm.REQUEST_EXIT_TYPEHASH(), buyer, uint256(0), d))));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentMissingRole.selector, dave.account));
        pm.requestExit(buyer, 0, dave.account, d, sig);
        // a provisional approver is not enough: the cached role is required
        _grant(buyer, dave, TazorRoles.ROLE_APPROVER, uint64(block.timestamp + 600));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentMissingRole.selector, dave.account));
        pm.requestExit(buyer, 0, dave.account, d, sig);
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentBadExitIndex.selector, 1));
        pm.requestExit(buyer, 1, bob.account, d, "");
        _requestExit(bob);
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentExitPending.selector, buyer));
        pm.requestExit(buyer, 0, carol.account, d, "");
    }

    // ---- unchanged rules

    function test_replayAndDistinctSouls() public {
        InvoiceAuth memory auth = _pay(buyer, supplierAccount, 1e6, bob);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentNonceUsed.selector, auth.nonce));
        pm.payOne(buyer, auth, ap, sg);
        auth = _auth(buyer, supplierAccount, 6e6);
        (ap, sg) = _approvals(bob, bob, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModuleV2.PaymentDuplicateSoul.selector, bob.account));
        pm.payOne(buyer, auth, ap, sg);
    }

    // ---- helpers

    function _reauth(InvoiceAuth memory a) internal pure returns (InvoiceAuth memory) {
        return a;
    }

    function _one(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function _oneSig(Approver memory a, InvoiceAuth memory auth) internal view returns (bytes[] memory r) {
        r = new bytes[](1);
        r[0] = _sign(a, pm.invoiceDigest(auth));
    }
}

/// payOne (caches status), setApproverExpiry, payOne again, all in one transaction.
contract BatchPayExpirePay {
    struct Args {
        address account;
        InvoiceAuth a1;
        InvoiceAuth a2;
        address approver;
        bytes sig1;
        bytes sig2;
        address admin;
        uint64 until;
        uint256 deadline;
        bytes expirySig;
    }

    function run(PaymentModuleV2 pm, Args calldata x) external returns (bool secondPaid) {
        address[] memory ap = new address[](1);
        bytes[] memory sg = new bytes[](1);
        ap[0] = x.approver;
        sg[0] = x.sig1;
        pm.payOne(x.account, x.a1, ap, sg);
        pm.setApproverExpiry(x.account, x.approver, x.until, x.admin, x.deadline, x.expirySig);
        sg[0] = x.sig2;
        try pm.payOne(x.account, x.a2, ap, sg) {
            secondPaid = true;
        } catch {}
    }
}
