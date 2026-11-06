// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {IEntryPoint, PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {ERC7579Utils, Execution} from "@openzeppelin/contracts/account/utils/draft-ERC7579Utils.sol";
import {ApproverAccount} from "../src/account/ApproverAccount.sol";
import {ApproverAccountFactory} from "../src/account/ApproverAccountFactory.sol";
import {SoulQuotaPaymaster} from "../src/paymaster/SoulQuotaPaymaster.sol";
import {IWBSoulAttributeRegistry, IWBSoulRegistry} from "../src/interfaces/IWBSoul.sol";
import {ModeLib} from "./mocks/Mocks.sol";

interface IEntryPointV08Hash {
    function getUserOpHash(PackedUserOperation calldata userOp) external view returns (bytes32);
}

interface IMirrorAdmin {
    function registerSoul(address addr) external;
    function assignAddress(uint256 soulId, address addr) external;
    function setAttribute(uint256 soulId, address attribute, bytes20 value) external;
    function soulOf(address addr) external view returns (uint256);
}

/// Real EntryPoint v0.8 handleOps on a pinned Whitechain Sepolia fork, with the live ApproverAccountFactory
/// and the live WB Soul mirror (soul setup is done as the mirror's owner).
contract SoulQuotaPaymasterForkTest is Test {
    uint256 constant FORK_BLOCK = 12_351_283;
    IEntryPoint constant EP = IEntryPoint(0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108);
    ApproverAccountFactory constant FACTORY = ApproverAccountFactory(0xf15c31bCd909e08AAc394D1e2E4dbf6D11223D8e);
    address constant MIRROR = 0x9822650A99bD33F29E383345F570dAE1e4E00928;
    address constant MIRROR_OWNER = 0xce4389ACb79463062c362fACB8CB04513fA3D8D8;
    address constant IS_VERIFIED = 0xd88fa142B67F561C5f2Cbf803bF5AE906a8f1e41;
    uint256 constant MAX_OPS = 3;
    uint256 constant MAX_COST = 0.05 ether;
    bytes4 constant FAILED_OP_WITH_REVERT = bytes4(keccak256("FailedOpWithRevert(uint256,string,bytes)"));

    SoulQuotaPaymaster pm;
    address bundler = makeAddr("bundler");
    uint256 opCounter;

    function setUp() public {
        vm.createSelectFork("whitechain_testnet", FORK_BLOCK);
        pm = new SoulQuotaPaymaster(
            EP, IWBSoulRegistry(MIRROR), IWBSoulAttributeRegistry(MIRROR), IS_VERIFIED, FACTORY.implementation(),
            MAX_OPS, MAX_COST, address(this)
        );
        vm.deal(address(this), 10 ether);
        pm.deposit{value: 5 ether}();
    }

    // ---- helpers

    function _newApprover(string memory name) internal returns (ApproverAccount account, uint256 key) {
        address eoa;
        (eoa, key) = makeAddrAndKey(name);
        bytes[] memory signers = new bytes[](1);
        signers[0] = abi.encodePacked(eoa);
        account = ApproverAccount(payable(FACTORY.createAccount(signers)));
    }

    function _verifiedSoul(address primary) internal returns (uint256 soulId) {
        vm.startPrank(MIRROR_OWNER);
        IMirrorAdmin(MIRROR).registerSoul(primary);
        soulId = IMirrorAdmin(MIRROR).soulOf(primary);
        IMirrorAdmin(MIRROR).setAttribute(soulId, IS_VERIFIED, bytes20(uint160(1)));
        vm.stopPrank();
    }

    function _bind(uint256 soulId, address account) internal {
        vm.prank(MIRROR_OWNER);
        IMirrorAdmin(MIRROR).assignAddress(soulId, account);
    }

    function _addBackupOp(ApproverAccount account, uint256 key) internal returns (PackedUserOperation memory op, address backup) {
        backup = address(uint160(uint256(keccak256(abi.encode("backup", opCounter++)))));
        bytes[] memory add = new bytes[](1);
        add[0] = abi.encodePacked(backup);
        Execution[] memory calls = new Execution[](1);
        calls[0] = Execution(address(account), 0, abi.encodeCall(ApproverAccount.addSigners, (add)));
        op.sender = address(account);
        op.nonce = EP.getNonce(address(account), 0);
        op.callData = abi.encodeWithSignature("execute(bytes32,bytes)", ModeLib.mode(ERC7579Utils.CALLTYPE_BATCH), abi.encode(calls));
        op.accountGasLimits = bytes32(uint256(600_000) << 128 | uint256(200_000));
        op.preVerificationGas = 150_000;
        uint256 maxFee = block.basefee * 2 + 1 gwei;
        op.gasFees = bytes32(uint256(1 gwei) << 128 | maxFee);
        op.paymasterAndData = abi.encodePacked(address(pm), uint128(200_000), uint128(100_000));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, IEntryPointV08Hash(address(EP)).getUserOpHash(op));
        bytes[] memory signers = new bytes[](1);
        bytes[] memory sigs = new bytes[](1);
        signers[0] = abi.encodePacked(vm.addr(key));
        sigs[0] = abi.encodePacked(r, s, v);
        op.signature = abi.encode(signers, sigs);
    }

    function _handle(PackedUserOperation memory op) internal returns (bool ok, bytes memory err) {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        try EP.handleOps(ops, payable(bundler)) {
            ok = true;
        } catch (bytes memory e) {
            err = e;
        }
    }

    function _assertRefused(bytes memory err, bytes4 inner) internal pure {
        assertEq(bytes4(err), FAILED_OP_WITH_REVERT, "FailedOpWithRevert");
        bytes memory body = new bytes(err.length - 4);
        for (uint256 i; i < body.length; ++i) body[i] = err[i + 4];
        (, string memory reason, bytes memory revertData) = abi.decode(body, (uint256, string, bytes));
        assertEq(reason, "AA33 reverted");
        assertEq(bytes4(revertData), inner, "inner error");
    }

    // ---- tests

    function test_verifiedApproverIsSponsoredWithZeroBalance() public {
        (ApproverAccount account, uint256 key) = _newApprover("priya");
        _verifiedSoul(address(account));
        assertEq(address(account).balance, 0);
        assertEq(EP.balanceOf(address(account)), 0);
        uint256 depositBefore = EP.balanceOf(address(pm));

        (PackedUserOperation memory op, address backup) = _addBackupOp(account, key);
        vm.recordLogs();
        uint256 g = gasleft();
        (bool ok,) = _handle(op);
        uint256 handleGas = g - gasleft();
        assertTrue(ok, "handleOps");
        assertTrue(account.isSigner(abi.encodePacked(backup)), "backup added");
        assertEq(address(account).balance, 0, "user paid nothing");
        assertLt(EP.balanceOf(address(pm)), depositBefore, "paymaster paid");

        uint256 actualGasCost;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(pm) && logs[i].topics[0] == SoulQuotaPaymaster.Sponsored.selector) {
                actualGasCost = abi.decode(logs[i].data, (uint256));
            }
        }
        assertGt(actualGasCost, 0);
        (uint256 opsLeft, uint256 costLeft) = pm.remaining(IMirrorAdmin(MIRROR).soulOf(address(account)));
        assertEq(opsLeft, MAX_OPS - 1);
        assertEq(costLeft, MAX_COST - actualGasCost, "unused reservation refunded in postOp");
        console2.log("handleOps gas (addSigners, ECDSA approver):", handleGas);
        console2.log("paymaster charged wei:", actualGasCost);
    }

    function test_quotaPerSoulThenResetsNextWindow() public {
        (ApproverAccount account, uint256 key) = _newApprover("cfo");
        _verifiedSoul(address(account));
        for (uint256 i; i < MAX_OPS; ++i) {
            (PackedUserOperation memory op,) = _addBackupOp(account, key);
            (bool ok,) = _handle(op);
            assertTrue(ok, vm.toString(i));
        }
        (PackedUserOperation memory extra,) = _addBackupOp(account, key);
        (bool ok4, bytes memory err) = _handle(extra);
        assertFalse(ok4, "N+1th op refused");
        _assertRefused(err, SoulQuotaPaymaster.PaymasterQuotaExceeded.selector);

        vm.warp(block.timestamp + 1 days);
        (PackedUserOperation memory next,) = _addBackupOp(account, key);
        (bool ok5,) = _handle(next);
        assertTrue(ok5, "new window");
    }

    /// Wallet farm: unbound accounts get nothing; accounts bound to one soul share that soul's quota.
    function test_drain_walletFarmCannotExceedOneSoulQuota() public {
        uint256 sponsored;
        for (uint256 i; i < 10; ++i) {
            (ApproverAccount a, uint256 k) = _newApprover(string.concat("farm-", vm.toString(i)));
            (PackedUserOperation memory op,) = _addBackupOp(a, k);
            (bool ok, bytes memory err) = _handle(op);
            assertFalse(ok);
            _assertRefused(err, SoulQuotaPaymaster.PaymasterNotVerified.selector);
        }

        ApproverAccount[] memory farm = new ApproverAccount[](5);
        uint256[] memory keys = new uint256[](5);
        for (uint256 i; i < 5; ++i) (farm[i], keys[i]) = _newApprover(string.concat("bound-", vm.toString(i)));
        uint256 soulId = _verifiedSoul(address(farm[0]));
        for (uint256 i = 1; i < 5; ++i) _bind(soulId, address(farm[i]));

        uint256 depositBefore = EP.balanceOf(address(pm));
        for (uint256 round; round < 3; ++round) {
            for (uint256 i; i < 5; ++i) {
                (PackedUserOperation memory op,) = _addBackupOp(farm[i], keys[i]);
                (bool ok,) = _handle(op);
                if (ok) ++sponsored;
            }
        }
        assertEq(sponsored, MAX_OPS, "15 attempts from 5 bound accounts, only the soul's quota is paid");
        console2.log("wallet farm: attempts 25, sponsored", sponsored, "paymaster spent wei", depositBefore - EP.balanceOf(address(pm)));
    }

    function test_unverifiedSoulRefused() public {
        (ApproverAccount account, uint256 key) = _newApprover("ravi");
        vm.prank(MIRROR_OWNER);
        IMirrorAdmin(MIRROR).registerSoul(address(account));
        (PackedUserOperation memory op,) = _addBackupOp(account, key);
        (bool ok, bytes memory err) = _handle(op);
        assertFalse(ok);
        _assertRefused(err, SoulQuotaPaymaster.PaymasterNotVerified.selector);
    }

    function test_costQuotaCapsGasEvenUnderOpCount() public {
        SoulQuotaPaymaster tight = new SoulQuotaPaymaster(
            EP, IWBSoulRegistry(MIRROR), IWBSoulAttributeRegistry(MIRROR), IS_VERIFIED, FACTORY.implementation(),
            100, 1 wei, address(this)
        );
        tight.deposit{value: 1 ether}();
        pm = tight;
        (ApproverAccount account, uint256 key) = _newApprover("meera");
        _verifiedSoul(address(account));
        (PackedUserOperation memory op,) = _addBackupOp(account, key);
        (bool ok, bytes memory err) = _handle(op);
        assertFalse(ok);
        _assertRefused(err, SoulQuotaPaymaster.PaymasterQuotaExceeded.selector);
    }

    function test_onlyEntryPointAndOwnerOnlyTouchesOwnDeposit() public {
        PackedUserOperation memory op;
        vm.expectRevert(abi.encodeWithSelector(SoulQuotaPaymaster.PaymasterNotEntryPoint.selector, address(this)));
        pm.validatePaymasterUserOp(op, bytes32(0), 0);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        pm.withdrawTo(payable(address(1)), 1);
        uint256 before = EP.balanceOf(address(pm));
        pm.withdrawTo(payable(address(this)), 1 ether);
        assertEq(EP.balanceOf(address(pm)), before - 1 ether);
    }

    receive() external payable {}
}
