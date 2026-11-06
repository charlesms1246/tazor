// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InvoiceAuth, InvoiceAuthLib} from "../src/libraries/InvoiceAuth.sol";
import {AddressAlias} from "../src/libraries/AddressAlias.sol";
import {ApproverAccountFactory} from "../src/account/ApproverAccountFactory.sol";
import {TazorAccountFactory} from "../src/account/TazorAccountFactory.sol";
import {PolicyHook} from "../src/modules/PolicyHook.sol";
import {PaymentModule} from "../src/modules/PaymentModule.sol";
import {RevocationList} from "../src/modules/RevocationList.sol";
import {IRoleCache, TazorRoles} from "../src/interfaces/IRoleCache.sol";
import {IWBSoulRegistry, IWBSoulAttributeRegistry} from "../src/interfaces/IWBSoul.sol";
import {WBSoulMirror} from "../src/mocks/WBSoulMirror.sol";
import {MockRoleCache} from "./mocks/Mocks.sol";

import {TazorFixture} from "./TazorFixture.sol";

abstract contract PaymentModuleBase is TazorFixture {
    // ---- positive

    function test_payOneSingleApprover() public {
        InvoiceAuth memory auth = _auth(buyer, payee, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        vm.expectEmit(address(pm));
        emit PaymentModule.InvoicePaid(buyer, auth.nonce, payee, 1e6, false);
        vm.prank(makeAddr("anyone"));
        pm.payOne(buyer, auth, ap, sg);
        assertEq(usdt.balanceOf(payee), 1e6);
        assertTrue(pm.isPaid(buyer, auth.nonce));
    }

    function test_payOneTwoApprovers() public {
        InvoiceAuth memory auth = _auth(buyer, payee, 6e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(alice, bob, pm.invoiceDigest(auth));
        uint256 g = gasleft();
        pm.payOne(buyer, auth, ap, sg);
        console2.log("gas payOne (2 approvers)", g - gasleft());
        assertEq(usdt.balanceOf(payee), 6e6);
    }

    function test_payRun10() public {
        InvoiceAuth[] memory auths = new InvoiceAuth[](10);
        for (uint256 i; i < 10; i++) {
            auths[i] = _auth(buyer, vm.addr(0xBEEF00 + i), 1e6);
        }
        bytes32 digest = pm.runDigest(auths);
        // total 10e6 > threshold, so one approver is not enough
        (address[] memory one, bytes[] memory oneSig) = _approvals(bob, digest);
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentNotEnoughApprovers.selector, 2, 1));
        pm.payRun(buyer, auths, one, oneSig);

        (address[] memory ap, bytes[] memory sg) = _approvals(alice, bob, digest);
        uint256 g = gasleft();
        pm.payRun(buyer, auths, ap, sg);
        uint256 used = g - gasleft();
        console2.log("gas payRun(10) total", used);
        console2.log("gas payRun(10) per invoice", used / 10);
        for (uint256 i; i < 10; i++) {
            assertEq(usdt.balanceOf(vm.addr(0xBEEF00 + i)), 1e6);
            assertTrue(pm.isPaid(buyer, auths[i].nonce));
        }
    }

    function test_runDigestDefinition() public {
        InvoiceAuth[] memory auths = new InvoiceAuth[](2);
        auths[0] = _auth(buyer, payee, 1);
        auths[1] = _auth(buyer, payee, 2);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("PaymentRun(bytes32[] authHashes)"),
                keccak256(abi.encodePacked(InvoiceAuthLib.hash(auths[0]), InvoiceAuthLib.hash(auths[1])))
            )
        );
        (, string memory name, string memory version, uint256 chainId, address vc,,) = pm.eip712Domain();
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                vc
            )
        );
        assertEq(name, "Tazor");
        assertEq(pm.runDigest(auths), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }

    function test_creditNote() public {
        InvoiceAuth memory auth = _auth(supplierAccount, buyer, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(carol, pm.invoiceDigest(auth));
        uint256 before = usdt.balanceOf(buyer);
        pm.payOne(supplierAccount, auth, ap, sg);
        assertEq(usdt.balanceOf(buyer), before + 1e6);
    }

    function test_payFromL1SkipsRoleCache() public {
        InvoiceAuth memory auth = _auth(buyer, payee, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(dave, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentMissingRole.selector, dave.account));
        pm.payOne(buyer, auth, ap, sg);

        vm.expectEmit(address(pm));
        emit PaymentModule.InvoicePaid(buyer, auth.nonce, payee, 1e6, true);
        vm.prank(ensGateAlias);
        pm.payFromL1(REGISTRY, buyer, auth, ap, sg);
        assertEq(usdt.balanceOf(payee), 1e6);
    }

    // ---- negative

    function test_unverifiedSoul() public {
        Approver memory eve = _approver("eve", false, TazorRoles.ROLE_APPROVER);
        InvoiceAuth memory auth = _auth(buyer, payee, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(eve, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentNotVerified.selector, eve.account));
        pm.payOne(buyer, auth, ap, sg);
    }

    function test_noSoul() public {
        (address eoa, uint256 key) = makeAddrAndKey("nosoul");
        bytes[] memory signers = new bytes[](1);
        signers[0] = abi.encodePacked(eoa);
        Approver memory x = Approver(approverFactory.createAccount(signers), eoa, key);
        roleCache.setRoles(REGISTRY, x.account, TazorRoles.ROLE_APPROVER);
        InvoiceAuth memory auth = _auth(buyer, payee, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(x, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentNotVerified.selector, x.account));
        pm.payOne(buyer, auth, ap, sg);
    }

    function test_verificationRemovedAfterSigning() public {
        InvoiceAuth memory auth = _auth(buyer, payee, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        uint256 soul = mirror.soulOf(bob.account);
        vm.prank(whitebit);
        mirror.setAttribute(soul, IS_VERIFIED, bytes20(0));
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentNotVerified.selector, bob.account));
        pm.payOne(buyer, auth, ap, sg);
    }

    function test_missingRole() public {
        roleCache.setRoles(REGISTRY, bob.account, TazorRoles.ROLE_AGENT);
        InvoiceAuth memory auth = _auth(buyer, payee, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentMissingRole.selector, bob.account));
        pm.payOne(buyer, auth, ap, sg);
    }

    function test_revoked() public {
        _revoke(buyer, alice, bob.account);
        assertTrue(revocations.isRevoked(buyer, bob.account));
        InvoiceAuth memory auth = _auth(buyer, payee, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentRevoked.selector, bob.account));
        pm.payOne(buyer, auth, ap, sg);
        // scoped to that account: bob still approves for the supplier
        InvoiceAuth memory other = _auth(supplierAccount, payee, 1e6);
        (ap, sg) = _approvals(bob, pm.invoiceDigest(other));
        pm.payOne(supplierAccount, other, ap, sg);
    }

    function test_revokedAfterSignature() public {
        InvoiceAuth memory auth = _auth(buyer, payee, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        _revoke(buyer, alice, bob.account);
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentRevoked.selector, bob.account));
        pm.payOne(buyer, auth, ap, sg);
    }

    function test_revocationRules() public {
        uint256 deadline = block.timestamp + 1 hours;
        // a non-admin cannot revoke someone else
        bytes memory sig = _sign(bob, revocations.revokeDigest(buyer, carol.account, deadline));
        vm.expectRevert(abi.encodeWithSelector(RevocationList.RevocationInvalidAdmin.selector, bob.account));
        revocations.revoke(buyer, carol.account, bob.account, deadline, sig);
        // but can revoke itself
        _revoke(buyer, bob, bob.account);
        assertTrue(revocations.isRevoked(buyer, bob.account));
        // no double revoke, no expired deadline, no forged admin signature
        vm.expectRevert(abi.encodeWithSelector(RevocationList.RevocationAlreadyRevoked.selector, bob.account));
        revocations.revoke(buyer, bob.account, alice.account, deadline, "");
        sig = _sign(alice, revocations.revokeDigest(buyer, carol.account, deadline));
        vm.expectRevert(RevocationList.RevocationInvalidSignature.selector);
        revocations.revoke(buyer, carol.account, alice.account, deadline + 1, sig);
        vm.warp(deadline + 1);
        vm.expectRevert(RevocationList.RevocationExpired.selector);
        revocations.revoke(buyer, carol.account, alice.account, deadline, sig);
        // a revoked admin cannot revoke
        vm.warp(deadline - 1 hours);
        _revoke(buyer, alice, alice.account);
        deadline = block.timestamp + 1 hours;
        sig = _sign(alice, revocations.revokeDigest(buyer, carol.account, deadline));
        vm.expectRevert(abi.encodeWithSelector(RevocationList.RevocationInvalidAdmin.selector, alice.account));
        revocations.revoke(buyer, carol.account, alice.account, deadline, sig);
        // unknown account
        vm.expectRevert(abi.encodeWithSelector(RevocationList.RevocationUnknownAccount.selector, address(0x1234)));
        revocations.revoke(address(0x1234), carol.account, alice.account, deadline, sig);
    }

    function test_oneApproverOverThreshold() public {
        InvoiceAuth memory auth = _auth(buyer, payee, THRESHOLD + 1);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentNotEnoughApprovers.selector, 2, 1));
        pm.payOne(buyer, auth, ap, sg);
    }

    function test_duplicateApprover() public {
        InvoiceAuth memory auth = _auth(buyer, payee, 6e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, bob, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentDuplicateSoul.selector, bob.account));
        pm.payOne(buyer, auth, ap, sg);
    }

    function test_twoAccountsSameSoulCountOnce() public {
        (address eoa, uint256 key) = makeAddrAndKey("bob-second");
        bytes[] memory signers = new bytes[](1);
        signers[0] = abi.encodePacked(eoa);
        Approver memory bob2 = Approver(approverFactory.createAccount(signers), eoa, key);
        uint256 soul = mirror.soulOf(bob.account);
        vm.prank(whitebit);
        mirror.assignAddress(soul, bob2.account);
        roleCache.setRoles(REGISTRY, bob2.account, TazorRoles.ROLE_APPROVER);
        assertEq(mirror.soulOf(bob2.account), mirror.soulOf(bob.account));

        InvoiceAuth memory auth = _auth(buyer, payee, 6e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, bob2, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentDuplicateSoul.selector, bob2.account));
        pm.payOne(buyer, auth, ap, sg);
    }

    function test_replayedNonce() public {
        InvoiceAuth memory auth = _auth(buyer, payee, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        pm.payOne(buyer, auth, ap, sg);
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentNonceUsed.selector, auth.nonce));
        pm.payOne(buyer, auth, ap, sg);
        // a different invoice reusing the nonce is also refused
        auth.invoiceHash = keccak256("other");
        (ap, sg) = _approvals(bob, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentNonceUsed.selector, auth.nonce));
        pm.payOne(buyer, auth, ap, sg);
        // and via L1
        vm.prank(ensGateAlias);
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentNonceUsed.selector, auth.nonce));
        pm.payFromL1(REGISTRY, buyer, auth, ap, sg);
    }

    function test_duplicateNonceInRun() public {
        InvoiceAuth[] memory auths = new InvoiceAuth[](2);
        auths[0] = _auth(buyer, payee, 1e6);
        auths[1] = auths[0];
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.runDigest(auths));
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentNonceUsed.selector, auths[0].nonce));
        pm.payRun(buyer, auths, ap, sg);
    }

    function test_expired() public {
        InvoiceAuth memory auth = _auth(buyer, payee, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        vm.warp(uint256(auth.expiry) + 1);
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentExpired.selector, auth.nonce));
        pm.payOne(buyer, auth, ap, sg);
    }

    function test_wrongAccount() public {
        InvoiceAuth memory auth = _auth(supplierAccount, payee, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        vm.expectRevert(
            abi.encodeWithSelector(PaymentModule.PaymentWrongAccount.selector, buyer, supplierAccount)
        );
        pm.payOne(buyer, auth, ap, sg);
    }

    function test_invalidSignature() public {
        InvoiceAuth memory auth = _auth(buyer, payee, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        auth.amount = 2e6; // signed 1e6
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentInvalidSignature.selector, bob.account));
        pm.payOne(buyer, auth, ap, sg);
        auth.amount = 1e6;
        sg[0] = _sign(carol, pm.invoiceDigest(auth)); // carol's key under bob's account
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentInvalidSignature.selector, bob.account));
        pm.payOne(buyer, auth, ap, sg);
    }

    function test_payFromL1NotAlias() public {
        InvoiceAuth memory auth = _auth(buyer, payee, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentNotEnsGate.selector, ensGate));
        vm.prank(ensGate); // the unaliased L1 address
        pm.payFromL1(REGISTRY, buyer, auth, ap, sg);
    }

    function test_payFromL1WrongRegistry() public {
        InvoiceAuth memory auth = _auth(buyer, payee, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        vm.prank(ensGateAlias);
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentWrongRegistry.selector, address(0xBAD)));
        pm.payFromL1(address(0xBAD), buyer, auth, ap, sg);
    }

    function test_notInstalled() public {
        InvoiceAuth memory auth = _auth(address(0xC0FFEE), payee, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentNotInstalled.selector, address(0xC0FFEE)));
        pm.payOne(address(0xC0FFEE), auth, ap, sg);
    }

    function test_onInstallOncePerAccount() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentAlreadyInstalled.selector, buyer));
        pm.onInstall(abi.encode(address(0xBAD), uint256(0)));
        assertEq(pm.registryOf(buyer), REGISTRY);
    }
}
