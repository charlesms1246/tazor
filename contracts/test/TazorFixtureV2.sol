// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InvoiceAuth} from "../src/libraries/InvoiceAuth.sol";
import {AddressAlias} from "../src/libraries/AddressAlias.sol";
import {ApproverAccountFactory} from "../src/account/ApproverAccountFactory.sol";
import {TazorAccountFactory} from "../src/account/TazorAccountFactory.sol";
import {PolicyHook} from "../src/modules/PolicyHook.sol";
import {PaymentModuleV2} from "../src/modules/PaymentModuleV2.sol";
import {RevocationList} from "../src/modules/RevocationList.sol";
import {IRoleCache, TazorRoles} from "../src/interfaces/IRoleCache.sol";
import {IWBSoulRegistry, IWBSoulAttributeRegistry} from "../src/interfaces/IWBSoul.sol";
import {WBSoulMirror} from "../src/mocks/WBSoulMirror.sol";
import {MockRoleCacheV2, MockL1Block} from "./mocks/Mocks.sol";

/// Shared v2 fixture; concrete suites provide USDT and the WB Soul mirror (mocks or the real testnet ones).
abstract contract TazorFixtureV2 is Test {
    address constant IS_VERIFIED = 0xd88fa142B67F561C5f2Cbf803bF5AE906a8f1e41;
    address constant L1_BLOCK = 0x4200000000000000000000000000000000000015;
    address constant REGISTRY = address(0xE45);
    uint96 constant TWO_APPROVER = 5e6;
    uint96 constant PER_PAYMENT = 8e6;
    uint96 constant MONTHLY = 20e6;
    uint32 constant PAYEE_DELAY = 1 days;
    uint96 constant FRESH = 3e6;
    uint32 constant MAX_CACHE_AGE = 50;
    uint96 constant AGENT_CAP = 3e6;
    uint32 constant EXIT_DELAY = 7 days;

    IERC20 usdt;
    WBSoulMirror mirror;
    address whitebit;

    MockRoleCacheV2 roleCache;
    PaymentModuleV2 pm;
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
    Approver ann; // agent

    address buyer;
    address supplierAccount;
    address treasury = makeAddr("acme-treasury");
    address payee = makeAddr("payee");
    uint256 nextNonce = 1;

    function _deployTokenAndSoul() internal virtual;
    function _fund(address to, uint256 amount) internal virtual;

    function setUp() public virtual {
        _deployTokenAndSoul();
        if (L1_BLOCK.code.length == 0) {
            vm.etch(L1_BLOCK, address(new MockL1Block()).code);
            MockL1Block(L1_BLOCK).setNumber(1_000_000);
        }
        roleCache = new MockRoleCacheV2();
        ensGateAlias = AddressAlias.applyL1ToL2Alias(ensGate);
        approverFactory = new ApproverAccountFactory();
        accountFactory = new TazorAccountFactory(address(new PolicyHook()));
        pm = new PaymentModuleV2(
            usdt,
            IWBSoulRegistry(address(mirror)),
            IWBSoulAttributeRegistry(address(mirror)),
            IS_VERIFIED,
            IRoleCache(address(roleCache)),
            ensGateAlias,
            accountFactory.implementation()
        );
        revocations = pm.revocationList();

        alice = _approver("alice", true, TazorRoles.ROLE_APPROVER | TazorRoles.ROLE_TAZOR_ADMIN);
        bob = _approver("bob", true, TazorRoles.ROLE_APPROVER);
        carol = _approver("carol", true, TazorRoles.ROLE_APPROVER);
        dave = _approver("dave", true, 0);
        ann = _approver("ann", true, TazorRoles.ROLE_AGENT);

        buyer = _company("buyer", new address[](0));
        supplierAccount = _company("supplier", new address[](0));
        _fund(buyer, 22e6);
        _fund(supplierAccount, 3e6);
        // the two companies pay each other (invoices and credit notes); like any payee they must be added first
        _addPayee(buyer, supplierAccount, alice);
        _addPayee(supplierAccount, buyer, alice);
        vm.warp(block.timestamp + PAYEE_DELAY);
    }

    // ---- helpers

    function _l1Now() internal view returns (uint64) {
        return PaymentModuleV2(address(pm)).L1_BLOCK().number();
    }

    function _approver(string memory name, bool verified, uint256 roles) internal returns (Approver memory a) {
        (a.eoa, a.key) = makeAddrAndKey(string.concat(name, "-backup"));
        bytes[] memory signers = new bytes[](1);
        signers[0] = abi.encodePacked(a.eoa);
        a.account = approverFactory.createAccount(signers);
        vm.startPrank(whitebit);
        mirror.registerSoul(a.account);
        if (verified) mirror.setAttribute(mirror.soulOf(a.account), IS_VERIFIED, bytes20(uint160(1)));
        vm.stopPrank();
        roleCache.setRoles(REGISTRY, a.account, roles, _l1Now());
    }

    function _setRoles(Approver memory a, uint256 roles, uint64 l1Block) internal {
        roleCache.setRoles(REGISTRY, a.account, roles, l1Block);
    }

    function _configV2() internal view returns (PaymentModuleV2.ConfigV2 memory c) {
        address[] memory exits = new address[](1);
        exits[0] = treasury;
        c = PaymentModuleV2.ConfigV2({
            registry: REGISTRY,
            twoApproverThreshold: TWO_APPROVER,
            perPaymentLimit: PER_PAYMENT,
            monthlyLimit: MONTHLY,
            payeeDelay: PAYEE_DELAY,
            freshThreshold: FRESH,
            maxCacheAge: MAX_CACHE_AGE,
            agentMonthlyCap: AGENT_CAP,
            exitAccounts: exits,
            exitDelay: EXIT_DELAY
        });
    }

    /// PaymentModuleV2 first, then any extra executors (empty init data).
    function _company(string memory salt, address[] memory extra) internal returns (address) {
        bytes[] memory admins = new bytes[](1);
        admins[0] = abi.encodePacked(alice.account);
        address[] memory executors = new address[](1 + extra.length);
        bytes[] memory data = new bytes[](1 + extra.length);
        executors[0] = address(pm);
        data[0] = abi.encode(_configV2());
        for (uint256 i; i < extra.length; ++i) {
            executors[1 + i] = extra[i];
        }
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

    function _deadline() internal view returns (uint256) {
        return block.timestamp + 1 hours;
    }

    /// Admin alice adds `to` as a payee of `account` and waits out the delay.
    function _allowPayee(address account, address to) internal {
        _addPayee(account, to, alice);
        vm.warp(block.timestamp + PAYEE_DELAY);
    }

    function _addPayee(address account, address to, Approver memory admin) internal {
        uint256 d = _deadline();
        bytes32 digest = pm.typedDigest(keccak256(abi.encode(pm.ADD_PAYEE_TYPEHASH(), account, to, d)));
        pm.addPayee(account, to, admin.account, d, _sign(admin, digest));
    }

    function _grant(address account, Approver memory grantee, uint256 roles, uint64 validUntil) internal {
        uint256 d = _deadline();
        bytes32 digest = pm.typedDigest(
            keccak256(abi.encode(pm.PROVISIONAL_GRANT_TYPEHASH(), account, grantee.account, roles, validUntil, d))
        );
        pm.provisionalGrant(account, grantee.account, roles, validUntil, alice.account, d, _sign(alice, digest));
    }

    function _expiry(address account, Approver memory who, uint64 until) internal returns (bytes memory sig, uint256 d) {
        d = _deadline();
        sig = _sign(alice, pm.typedDigest(keccak256(abi.encode(pm.APPROVER_EXPIRY_TYPEHASH(), account, who.account, until, d))));
        pm.setApproverExpiry(account, who.account, until, alice.account, d, sig);
    }

    function _pay(address account, address to, uint256 amount, Approver memory a) internal returns (InvoiceAuth memory auth) {
        auth = _auth(account, to, amount);
        (address[] memory ap, bytes[] memory sg) = _approvals(a, pm.invoiceDigest(auth));
        pm.payOne(account, auth, ap, sg);
    }

    function _pay2(address account, address to, uint256 amount) internal returns (InvoiceAuth memory auth) {
        auth = _auth(account, to, amount);
        (address[] memory ap, bytes[] memory sg) = _approvals(alice, bob, pm.invoiceDigest(auth));
        pm.payOne(account, auth, ap, sg);
    }
}
