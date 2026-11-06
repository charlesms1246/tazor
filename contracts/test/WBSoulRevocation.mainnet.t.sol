// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InvoiceAuth} from "../src/libraries/InvoiceAuth.sol";
import {ApproverAccountFactory} from "../src/account/ApproverAccountFactory.sol";
import {TazorAccountFactory} from "../src/account/TazorAccountFactory.sol";
import {PolicyHook} from "../src/modules/PolicyHook.sol";
import {PaymentModule} from "../src/modules/PaymentModule.sol";
import {IRoleCache, TazorRoles} from "../src/interfaces/IRoleCache.sol";
import {IWBSoulRegistry, IWBSoulAttributeRegistry} from "../src/interfaces/IWBSoul.sol";
import {MockERC20, MockRoleCache} from "./mocks/Mocks.sol";
import {ForkBlocks} from "./ForkBlocks.sol";

interface ISoulRegistryAdmin {
    function owner() external view returns (address);
    function assignAddress(uint256 soulId, address addr) external;
    function revokeAddress(address addr) external;
    function soulOf(address addr) external view returns (uint256);
    function soulOfRevoked(address addr) external view returns (uint256);
    function soulAddresses(uint256 soulId) external view returns (address[] memory);
}

/// Whitechain MAINNET fork with WhiteBIT's real WB Soul: the real operator binds an ApproverAccount to a real,
/// IsVerified soul, a payment it approves succeeds, then the operator revokes the address and the next
/// payment it approves reverts. USDT is a mock (no USDT on Whitechain mainnet).
contract WBSoulRevocationMainnetTest is Test {
    address constant SOUL_REGISTRY = 0x0000000000000000000000000000000000002000;
    address constant ATTRIBUTE_REGISTRY = 0x0000000000000000000000000000000000002002;
    address constant IS_VERIFIED = 0xd88fa142B67F561C5f2Cbf803bF5AE906a8f1e41;
    address constant OPERATOR = 0xb358143EcCbD5c529668f0C0E65527b3d56F0ED9;
    address constant SOUL1_PRIMARY = 0xFD696AAF18c6eF43dDc14a6eB834c8b8037AF7bC;
    uint256 constant SOUL = 1;
    address constant REGISTRY = address(0xE45);

    ISoulRegistryAdmin souls = ISoulRegistryAdmin(SOUL_REGISTRY);
    MockERC20 usdt;
    PaymentModule pm;
    address approver;
    uint256 key;
    address company;
    address payee = makeAddr("payee");

    function setUp() public {
        vm.createSelectFork("whitechain", ForkBlocks.WHITECHAIN_MAINNET);
        assertEq(block.chainid, 1875);
        assertEq(souls.owner(), OPERATOR, "real WhiteBIT operator");
        assertEq(souls.soulOf(SOUL1_PRIMARY), SOUL);
        assertEq(
            IWBSoulAttributeRegistry(ATTRIBUTE_REGISTRY).soulAttributeValue(SOUL, IS_VERIFIED),
            bytes20(uint160(1)),
            "soul 1 IsVerified"
        );

        usdt = new MockERC20();
        MockRoleCache roleCache = new MockRoleCache();
        pm = new PaymentModule(
            IERC20(address(usdt)),
            IWBSoulRegistry(SOUL_REGISTRY),
            IWBSoulAttributeRegistry(ATTRIBUTE_REGISTRY),
            IS_VERIFIED,
            IRoleCache(address(roleCache)),
            makeAddr("ensGateAlias")
        );
        ApproverAccountFactory approverFactory = new ApproverAccountFactory();
        TazorAccountFactory accountFactory = new TazorAccountFactory(address(new PolicyHook()));

        address eoa;
        (eoa, key) = makeAddrAndKey("soul1-backup");
        bytes[] memory signers = new bytes[](1);
        signers[0] = abi.encodePacked(eoa);
        approver = approverFactory.createAccount(signers);
        roleCache.setRoles(REGISTRY, approver, TazorRoles.ROLE_APPROVER);

        bytes[] memory admins = new bytes[](1);
        admins[0] = abi.encodePacked(approver);
        address[] memory executors = new address[](1);
        executors[0] = address(pm);
        bytes[] memory data = new bytes[](1);
        data[0] = abi.encode(REGISTRY, uint256(1_000e6));
        company = accountFactory.createAccount(TazorAccountFactory.Config(admins, 1, executors, data), keccak256("acme"));
        usdt.mint(company, 100e6);
    }

    function _pay(uint256 nonce) internal view returns (InvoiceAuth memory auth, address[] memory ap, bytes[] memory sg) {
        auth = InvoiceAuth({
            invoiceHash: keccak256(abi.encode("invoice", nonce)),
            account: company,
            payee: payee,
            amount: 10e6,
            expiry: uint64(block.timestamp + 1 days),
            nonce: nonce
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, pm.invoiceDigest(auth));
        bytes[] memory inner = new bytes[](1);
        bytes[] memory innerSigner = new bytes[](1);
        inner[0] = abi.encodePacked(r, s, v);
        innerSigner[0] = abi.encodePacked(vm.addr(key));
        ap = new address[](1);
        sg = new bytes[](1);
        ap[0] = approver;
        sg[0] = abi.encode(innerSigner, inner);
    }

    function test_realOperatorBindsThenRevokes() public {
        assertEq(souls.soulOf(approver), 0, "not bound yet");
        (InvoiceAuth memory a0, address[] memory ap0, bytes[] memory sg0) = _pay(1);
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentNotVerified.selector, approver));
        pm.payOne(company, a0, ap0, sg0);

        // WhiteBIT's operator binds the ApproverAccount to soul 1 (KYC'd, IsVerified)
        vm.prank(OPERATOR);
        souls.assignAddress(SOUL, approver);
        assertEq(souls.soulOf(approver), SOUL);
        assertTrue(pm.isSoulVerified(approver));
        console2.log("operator", OPERATOR);
        console2.log("soul", SOUL);
        console2.log("soul addresses after bind", souls.soulAddresses(SOUL).length);

        pm.payOne(company, a0, ap0, sg0);
        assertEq(usdt.balanceOf(payee), 10e6);

        // next block: WhiteBIT revokes the address
        vm.roll(block.number + 1);
        vm.prank(OPERATOR);
        souls.revokeAddress(approver);
        assertEq(souls.soulOf(approver), 0);
        assertEq(souls.soulOfRevoked(approver), SOUL);
        assertFalse(pm.isSoulVerified(approver));

        // the same approver's next payment (new nonce) reverts
        vm.roll(block.number + 1);
        (InvoiceAuth memory a1, address[] memory ap1, bytes[] memory sg1) = _pay(2);
        vm.expectRevert(abi.encodeWithSelector(PaymentModule.PaymentNotVerified.selector, approver));
        pm.payOne(company, a1, ap1, sg1);
        assertEq(usdt.balanceOf(payee), 10e6);

        // and a revoked address cannot be bound to a different soul
        vm.prank(OPERATOR);
        vm.expectRevert("SoulRegistry: address has been already used");
        souls.assignAddress(2, approver);
    }

    function test_onlyOperatorCanBind() public {
        vm.expectRevert("Ownable: caller is not the owner");
        souls.assignAddress(SOUL, approver);
    }
}
