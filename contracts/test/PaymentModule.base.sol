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

/// Shared scenario; concrete suites provide USDT and the WB Soul mirror (mocks or the real testnet ones).
abstract contract PaymentModuleBase is Test {
    address constant IS_VERIFIED = 0xd88fa142B67F561C5f2Cbf803bF5AE906a8f1e41;
    address constant REGISTRY = address(0xE45);
    uint256 constant THRESHOLD = 5e6;

    IERC20 usdt;
    WBSoulMirror mirror;
    address whitebit;

    MockRoleCache roleCache;
    PaymentModule pm;
    RevocationList revocations;
    ApproverAccountFactory approverFactory;
    TazorAccountFactory accountFactory;
    address ensGate = makeAddr("ensGate");
    address ensGateAlias;

    struct Approver {
        address account;
        address eoa;
        uint256 key;
    }

    Approver alice; // admin + approver
    Approver bob; // approver
    Approver carol; // approver
    Approver dave; // verified, no role

    address buyer;
    address supplierAccount;
    address payee = makeAddr("payee");
    uint256 nextNonce = 1;

    function _deployTokenAndSoul() internal virtual;
    function _fund(address to, uint256 amount) internal virtual;

    function setUp() public virtual {
        _deployTokenAndSoul();
        roleCache = new MockRoleCache();
        ensGateAlias = AddressAlias.applyL1ToL2Alias(ensGate);
        pm = new PaymentModule(
            usdt,
            IWBSoulRegistry(address(mirror)),
            IWBSoulAttributeRegistry(address(mirror)),
            IS_VERIFIED,
            IRoleCache(address(roleCache)),
            ensGateAlias
        );
        revocations = pm.revocationList();
        approverFactory = new ApproverAccountFactory();
        accountFactory = new TazorAccountFactory(address(new PolicyHook()));

        alice = _approver("alice", true, TazorRoles.ROLE_APPROVER | TazorRoles.ROLE_TAZOR_ADMIN);
        bob = _approver("bob", true, TazorRoles.ROLE_APPROVER);
        carol = _approver("carol", true, TazorRoles.ROLE_APPROVER);
        dave = _approver("dave", true, 0);

        buyer = _company("buyer");
        supplierAccount = _company("supplier");
        _fund(buyer, 25e6);
        _fund(supplierAccount, 2e6);
    }

    // ---- helpers

    function _approver(string memory name, bool verified, uint256 roles) internal returns (Approver memory a) {
        (a.eoa, a.key) = makeAddrAndKey(string.concat(name, "-backup"));
        bytes[] memory signers = new bytes[](1);
        signers[0] = abi.encodePacked(a.eoa);
        a.account = approverFactory.createAccount(signers);
        vm.startPrank(whitebit);
        mirror.registerSoul(a.account);
        if (verified) mirror.setAttribute(mirror.soulOf(a.account), IS_VERIFIED, bytes20(uint160(1)));
        vm.stopPrank();
        roleCache.setRoles(REGISTRY, a.account, roles);
    }

    function _company(string memory salt) internal returns (address) {
        bytes[] memory admins = new bytes[](1);
        admins[0] = abi.encodePacked(alice.account);
        address[] memory executors = new address[](1);
        executors[0] = address(pm);
        bytes[] memory data = new bytes[](1);
        data[0] = abi.encode(REGISTRY, THRESHOLD);
        return accountFactory.createAccount(
            TazorAccountFactory.Config(admins, 1, executors, data), keccak256(bytes(salt))
        );
    }

    function _auth(address account, address to, uint256 amount) internal returns (InvoiceAuth memory) {
        return InvoiceAuth({
            invoiceHash: keccak256(abi.encode("invoice", nextNonce)),
            account: account,
            payee: to,
            amount: amount,
            expiry: uint64(block.timestamp + 1 days),
            nonce: nextNonce++
        });
    }

    function _sign(Approver memory a, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(a.key, digest);
        bytes[] memory signers = new bytes[](1);
        bytes[] memory sigs = new bytes[](1);
        signers[0] = abi.encodePacked(a.eoa);
        sigs[0] = abi.encodePacked(r, s, v);
        return abi.encode(signers, sigs);
    }

    function _approvals(Approver memory a, bytes32 digest)
        internal
        pure
        returns (address[] memory approvers, bytes[] memory sigs)
    {
        approvers = new address[](1);
        sigs = new bytes[](1);
        approvers[0] = a.account;
        sigs[0] = _sign(a, digest);
    }

    function _approvals(Approver memory a, Approver memory b, bytes32 digest)
        internal
        pure
        returns (address[] memory approvers, bytes[] memory sigs)
    {
        approvers = new address[](2);
        sigs = new bytes[](2);
        approvers[0] = a.account;
        approvers[1] = b.account;
        sigs[0] = _sign(a, digest);
        sigs[1] = _sign(b, digest);
    }

    function _revoke(address account, Approver memory admin, address target) internal {
        uint256 deadline = block.timestamp + 1 hours;
        revocations.revoke(
            account, target, admin.account, deadline, _sign(admin, revocations.revokeDigest(account, target, deadline))
        );
    }

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
