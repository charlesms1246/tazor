// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {Account as OZAccount} from "@openzeppelin/contracts/account/Account.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {ERC7579Utils, Execution, CallType} from "@openzeppelin/contracts/account/utils/draft-ERC7579Utils.sol";
import {
    MODULE_TYPE_VALIDATOR,
    MODULE_TYPE_EXECUTOR,
    MODULE_TYPE_FALLBACK,
    MODULE_TYPE_HOOK
} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {ApproverAccountFactory} from "../src/account/ApproverAccountFactory.sol";
import {TazorAccount} from "../src/account/TazorAccount.sol";
import {TazorAccountFactory} from "../src/account/TazorAccountFactory.sol";
import {PolicyHook} from "../src/modules/PolicyHook.sol";
import {MockERC20, MockExecutor, MockValidator, ModeLib} from "./mocks/Mocks.sol";

contract TazorAccountTest is Test {
    MockERC20 usdt;
    PolicyHook hook;
    TazorAccountFactory factory;
    ApproverAccountFactory approverFactory;
    MockExecutor executor;
    TazorAccount company;
    address ep;

    address approverA;
    address approverB;
    uint256 keyA;
    uint256 keyB;
    address supplier = makeAddr("supplier");
    bytes32 constant SALT = keccak256("acme");

    function setUp() public {
        usdt = new MockERC20();
        hook = new PolicyHook();
        factory = new TazorAccountFactory(address(hook));
        approverFactory = new ApproverAccountFactory();
        executor = new MockExecutor();

        address eoaA;
        address eoaB;
        (eoaA, keyA) = makeAddrAndKey("approverA-backup");
        (eoaB, keyB) = makeAddrAndKey("approverB-backup");
        approverA = approverFactory.createAccount(_one(abi.encodePacked(eoaA)));
        approverB = approverFactory.createAccount(_one(abi.encodePacked(eoaB)));

        bytes[] memory admins = new bytes[](2);
        admins[0] = abi.encodePacked(approverA);
        admins[1] = abi.encodePacked(approverB);
        address[] memory executors = new address[](1);
        executors[0] = address(executor);

        uint256 g = gasleft();
        company = TazorAccount(payable(factory.createAccount(_cfg(admins, 2, executors), SALT)));
        console2.log("gas TazorAccountFactory.createAccount (2 admins, 1 executor, hook)", g - gasleft());

        ep = address(company.entryPoint());
        usdt.mint(address(company), 1_000e6);
    }

    // ---- helpers

    function _cfg(bytes[] memory admins, uint64 threshold, address[] memory executors)
        internal
        pure
        returns (TazorAccountFactory.Config memory)
    {
        return TazorAccountFactory.Config(admins, threshold, executors, new bytes[](executors.length));
    }

    function _one(bytes memory b) internal pure returns (bytes[] memory a) {
        a = new bytes[](1);
        a[0] = b;
    }

    function _approverSig(uint256 key, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = abi.encodePacked(r, s, v);
        return abi.encode(_one(abi.encodePacked(vm.addr(key))), sigs);
    }

    function _adminSig(bytes32 hash, bool both) internal view returns (bytes memory) {
        uint256 n = both ? 2 : 1;
        bytes[] memory signers = new bytes[](n);
        bytes[] memory sigs = new bytes[](n);
        signers[0] = abi.encodePacked(approverA);
        sigs[0] = _approverSig(keyA, hash);
        if (both) {
            signers[1] = abi.encodePacked(approverB);
            sigs[1] = _approverSig(keyB, hash);
        }
        return abi.encode(signers, sigs);
    }

    function _validate(bytes32 opHash, bytes memory sig) internal returns (uint256) {
        PackedUserOperation memory op;
        op.sender = address(company);
        op.signature = sig;
        vm.prank(ep);
        return company.validateUserOp(op, opHash, 0);
    }

    /// Admin path: approvers authorize the userOp, then the EntryPoint calls execute.
    function _adminExecute(CallType callType, bytes memory executionCalldata) internal {
        bytes32 opHash = keccak256(abi.encode("op", callType, executionCalldata));
        assertEq(_validate(opHash, _adminSig(opHash, true)), 0, "admins authorize");
        vm.prank(ep);
        company.execute(ModeLib.mode(callType), executionCalldata);
    }

    function _single(address target, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(target, value, data);
    }

    function _selfSingle(bytes memory data) internal view returns (bytes memory) {
        return _single(address(company), 0, data);
    }

    // ---- P1-1

    function test_factoryAndModules() public {
        assertTrue(company.supportsModule(MODULE_TYPE_VALIDATOR));
        assertTrue(company.supportsModule(MODULE_TYPE_EXECUTOR));
        assertTrue(company.supportsModule(MODULE_TYPE_HOOK));
        assertFalse(company.supportsModule(MODULE_TYPE_FALLBACK));
        assertTrue(company.isModuleInstalled(MODULE_TYPE_EXECUTOR, address(executor), ""));
        assertTrue(company.isModuleInstalled(MODULE_TYPE_HOOK, address(hook), ""));
        assertEq(company.hook(), address(hook));
        assertEq(company.threshold(), 2);

        bytes[] memory admins = new bytes[](2);
        admins[0] = abi.encodePacked(approverA);
        admins[1] = abi.encodePacked(approverB);
        address[] memory executors = new address[](1);
        executors[0] = address(executor);
        assertEq(factory.predictAddress(_cfg(admins, 2, executors), SALT), address(company));
        assertEq(factory.createAccount(_cfg(admins, 2, executors), SALT), address(company));
        assertTrue(factory.predictAddress(_cfg(admins, 1, executors), SALT) != address(company));
        TazorAccountFactory.Config memory other = _cfg(admins, 2, executors);
        other.executorData[0] = hex"01";
        assertTrue(factory.predictAddress(other, SALT) != address(company), "salt binds executorData");

        address[] memory none = new address[](0);
        TazorAccount impl = TazorAccount(payable(factory.implementation()));
        vm.expectRevert();
        company.initialize(admins, 1, none, new bytes[](0), address(hook));
        vm.expectRevert();
        impl.initialize(admins, 1, none, new bytes[](0), address(hook));
    }

    function test_minimalCloneGas() public {
        address[] memory executors = new address[](1);
        executors[0] = address(executor);
        uint256 g = gasleft();
        factory.createAccount(_cfg(_one(abi.encodePacked(approverA)), 1, executors), keccak256("min"));
        console2.log("gas TazorAccountFactory.createAccount (1 admin, 1 executor, hook)", g - gasleft());
    }

    // ---- Gate

    function test_installedExecutorMovesTokens() public {
        executor.pay(address(company), address(usdt), supplier, 250e6);
        assertEq(usdt.balanceOf(supplier), 250e6);
    }

    function test_uninstalledExecutorReverts() public {
        MockExecutor rogue = new MockExecutor();
        vm.expectRevert(
            abi.encodeWithSelector(ERC7579Utils.ERC7579UninstalledModule.selector, MODULE_TYPE_EXECUTOR, address(rogue))
        );
        rogue.pay(address(company), address(usdt), supplier, 1);
    }

    function test_executorCannotTargetAccount() public {
        bytes memory data = _selfSingle(
            abi.encodeCall(company.installModule, (MODULE_TYPE_VALIDATOR, address(new MockValidator()), ""))
        );
        vm.expectRevert(abi.encodeWithSelector(PolicyHook.PolicyHookForbiddenTarget.selector, address(company)));
        executor.exec(address(company), ERC7579Utils.CALLTYPE_SINGLE, data);
    }

    function test_executorCannotDelegatecall() public {
        bytes memory data = abi.encodePacked(address(usdt), abi.encodeCall(ERC20.transfer, (supplier, 1)));
        vm.expectRevert(
            abi.encodeWithSelector(PolicyHook.PolicyHookForbiddenCallType.selector, ERC7579Utils.CALLTYPE_DELEGATECALL)
        );
        executor.exec(address(company), ERC7579Utils.CALLTYPE_DELEGATECALL, data);
    }

    function test_adminSelfCallUsdtTransferReverts() public {
        bytes memory data = _single(address(usdt), 0, abi.encodeCall(ERC20.transfer, (supplier, 1)));
        bytes32 opHash = keccak256("transfer");
        assertEq(_validate(opHash, _adminSig(opHash, true)), 0);
        vm.prank(ep);
        vm.expectRevert(abi.encodeWithSelector(PolicyHook.PolicyHookForbiddenTarget.selector, address(usdt)));
        company.execute(ModeLib.mode(ERC7579Utils.CALLTYPE_SINGLE), data);
    }

    function test_adminInstallValidatorOk() public {
        MockValidator v = new MockValidator();
        _adminExecute(
            ERC7579Utils.CALLTYPE_SINGLE,
            _selfSingle(abi.encodeCall(company.installModule, (MODULE_TYPE_VALIDATOR, address(v), "")))
        );
        assertTrue(company.isModuleInstalled(MODULE_TYPE_VALIDATOR, address(v), ""));
    }

    function test_adminConfigOk() public {
        address eoaC = makeAddr("approverC-backup");
        address approverC = approverFactory.createAccount(_one(abi.encodePacked(eoaC)));
        Execution[] memory calls = new Execution[](3);
        calls[0] = Execution(address(company), 0, abi.encodeCall(company.addSigners, (_one(abi.encodePacked(approverC)))));
        calls[1] = Execution(address(company), 0, abi.encodeCall(company.setThreshold, (3)));
        calls[2] = Execution(
            address(company), 0, abi.encodeCall(company.uninstallModule, (MODULE_TYPE_EXECUTOR, address(executor), ""))
        );
        _adminExecute(ERC7579Utils.CALLTYPE_BATCH, abi.encode(calls));
        assertEq(company.threshold(), 3);
        assertTrue(company.isSigner(abi.encodePacked(approverC)));
        assertFalse(company.isModuleInstalled(MODULE_TYPE_EXECUTOR, address(executor), ""));
    }

    function test_adminThresholdEnforced() public {
        bytes32 opHash = keccak256("op");
        assertEq(_validate(opHash, _adminSig(opHash, false)), 1, "1 of 2 fails");
        assertEq(_validate(opHash, _adminSig(keccak256("other"), true)), 1, "wrong hash fails");
        assertEq(_validate(opHash, _adminSig(opHash, true)), 0);
    }

    // ---- P1-17: no admin path moves funds

    function _expectAdminBlocked(CallType callType, bytes memory data) internal {
        uint256 before = usdt.balanceOf(address(company));
        uint256 nativeBefore = address(company).balance;
        vm.prank(ep);
        (bool ok,) = address(company).call(abi.encodeCall(company.execute, (ModeLib.mode(callType), data)));
        assertFalse(ok, "admin execution must revert");
        assertEq(usdt.balanceOf(address(company)), before);
        assertEq(address(company).balance, nativeBefore);
    }

    function test_noAdminPathMovesFunds() public {
        vm.deal(address(company), 1 ether);
        CallType single = ERC7579Utils.CALLTYPE_SINGLE;

        // direct token calls
        _expectAdminBlocked(single, _single(address(usdt), 0, abi.encodeCall(ERC20.transfer, (supplier, 1))));
        _expectAdminBlocked(single, _single(address(usdt), 0, abi.encodeCall(ERC20.approve, (supplier, 1))));
        _expectAdminBlocked(
            single, _single(address(usdt), 0, abi.encodeCall(ERC20.transferFrom, (address(company), supplier, 1)))
        );
        _expectAdminBlocked(
            single,
            _single(
                address(usdt),
                0,
                abi.encodeWithSignature(
                    "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
                    address(company),
                    supplier,
                    1,
                    type(uint256).max,
                    uint8(27),
                    bytes32(0),
                    bytes32(0)
                )
            )
        );
        // native value, to anyone including self
        _expectAdminBlocked(single, _single(supplier, 1, ""));
        _expectAdminBlocked(single, _single(address(company), 1, ""));
        // batch hiding a transfer behind a config call
        Execution[] memory calls = new Execution[](2);
        calls[0] = Execution(address(company), 0, abi.encodeCall(company.setThreshold, (2)));
        calls[1] = Execution(address(usdt), 0, abi.encodeCall(ERC20.transfer, (supplier, 1)));
        _expectAdminBlocked(ERC7579Utils.CALLTYPE_BATCH, abi.encode(calls));
        // nested execute through a self-call
        bytes memory inner = abi.encodeCall(
            company.execute,
            (
                ModeLib.mode(single),
                _single(address(usdt), 0, abi.encodeCall(ERC20.transfer, (supplier, 1)))
            )
        );
        _expectAdminBlocked(single, _selfSingle(inner));
        // delegatecall
        _expectAdminBlocked(
            ERC7579Utils.CALLTYPE_DELEGATECALL,
            abi.encodePacked(address(usdt), abi.encodeCall(ERC20.transfer, (supplier, 1)))
        );
        // add a new way to move funds: install an executor, remove the hook
        address rogue = address(new MockExecutor());
        _expectAdminBlocked(
            single,
            _selfSingle(abi.encodeCall(company.installModule, (MODULE_TYPE_EXECUTOR, rogue, "")))
        );
        _expectAdminBlocked(
            single, _selfSingle(abi.encodeCall(company.uninstallModule, (MODULE_TYPE_HOOK, address(hook), "")))
        );
        // direct installModule from the EntryPoint is gated by the hook too
        vm.startPrank(ep);
        vm.expectRevert(abi.encodeWithSelector(PolicyHook.PolicyHookForbiddenModule.selector, MODULE_TYPE_EXECUTOR));
        company.installModule(MODULE_TYPE_EXECUTOR, rogue, "");
        vm.expectRevert(abi.encodeWithSelector(PolicyHook.PolicyHookForbiddenModule.selector, MODULE_TYPE_HOOK));
        company.uninstallModule(MODULE_TYPE_HOOK, address(hook), "");
        vm.stopPrank();

        assertEq(usdt.balanceOf(address(company)), 1_000e6);
    }

    function testFuzz_adminCannotCallOutside(address target, uint256 value, bytes memory data) public {
        vm.assume(target != address(company));
        vm.deal(address(company), value);
        _expectAdminBlocked(ERC7579Utils.CALLTYPE_SINGLE, _single(target, value, data));
    }

    /// No ERC-1271 yes, so permit / EIP-3009 authorizations can never be signed by the account,
    /// even with valid admin signatures or an always-yes validator installed.
    function test_isValidSignatureAlwaysInvalid() public {
        bytes32 h = keccak256("permit digest");
        assertEq(company.isValidSignature(h, _adminSig(h, true)), bytes4(0xffffffff));
        MockValidator v = new MockValidator();
        _adminExecute(
            ERC7579Utils.CALLTYPE_SINGLE,
            _selfSingle(abi.encodeCall(company.installModule, (MODULE_TYPE_VALIDATOR, address(v), "")))
        );
        assertEq(company.isValidSignature(h, abi.encodePacked(address(v), "x")), bytes4(0xffffffff));
    }

    function test_strangersBlocked() public {
        vm.expectRevert(abi.encodeWithSelector(OZAccount.AccountUnauthorized.selector, address(this)));
        company.execute(ModeLib.mode(ERC7579Utils.CALLTYPE_SINGLE), _single(address(usdt), 0, ""));
        vm.expectRevert(abi.encodeWithSelector(OZAccount.AccountUnauthorized.selector, address(this)));
        company.installModule(MODULE_TYPE_EXECUTOR, address(this), "");
        vm.expectRevert(abi.encodeWithSelector(OZAccount.AccountUnauthorized.selector, address(this)));
        company.addSigners(_one(abi.encodePacked(address(this))));
        vm.expectRevert(abi.encodeWithSelector(PolicyHook.PolicyHookUnauthorizedSender.selector, address(this)));
        (bool ok,) = address(company).call(abi.encodeWithSignature("anything()"));
        ok;
        vm.expectRevert(PolicyHook.PolicyHookPermanent.selector);
        hook.onUninstall("");
    }
}
