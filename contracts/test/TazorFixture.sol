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

/// Shared Tazor fixture; concrete suites provide USDT and the WB Soul mirror (mocks or the real testnet ones).
abstract contract TazorFixture is Test {
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
        return _company(salt, address(0));
    }

    /// PaymentModule always; `extra` (if set) is installed as a second executor with empty init data.
    function _company(string memory salt, address extra) internal returns (address) {
        bytes[] memory admins = new bytes[](1);
        admins[0] = abi.encodePacked(alice.account);
        uint256 n = extra == address(0) ? 1 : 2;
        address[] memory executors = new address[](n);
        bytes[] memory data = new bytes[](n);
        executors[0] = address(pm);
        data[0] = abi.encode(REGISTRY, THRESHOLD);
        if (n == 2) executors[1] = extra;
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
}
