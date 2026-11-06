// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm, console} from "forge-std/Test.sol";
import {EnsGate} from "../src/l1/EnsGate.sol";
import {IPaymentModule} from "../src/l1/IPaymentModule.sol";
import {InvoiceAuth} from "../src/libraries/InvoiceAuth.sol";
import {AddressAlias} from "../src/libraries/AddressAlias.sol";
import {ForkBlocks} from "./ForkBlocks.sol";

interface IEacRegistry {
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function roles(uint256 resource, address account) external view returns (uint256);
    function getSubregistry(string calldata label) external view returns (address);
}

/// Forwards through the real taz0r.eth sub-registry and the real Whitechain Sepolia portal on a pinned Sepolia fork.
contract EnsGateForkTest is Test {
    address constant PORTAL = 0xFF9b597b0781457ae6aa7256Ca5ed5839bF7D0C3;
    address constant TAZ0R_REGISTRY = 0x44007108C0Cca53498F19F259E73E70C2ebE900a;
    address constant ACME = 0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1;
    address constant ACME_ADMIN = 0xce4389ACb79463062c362fACB8CB04513fA3D8D8;
    address constant MODULE = address(0x7000);
    address constant ACCOUNT = address(0xACC);
    address constant APPROVER1 = address(0xA11CE);
    address constant APPROVER2 = address(0xB0B);
    uint256 constant ROLE_APPROVER = 1 << 64;
    bytes32 constant TRANSACTION_DEPOSITED = keccak256("TransactionDeposited(address,address,uint256,bytes)");

    EnsGate gate;

    function setUp() public {
        vm.createSelectFork(ForkBlocks.sepoliaRpc(), ForkBlocks.ETH_SEPOLIA);
        assertEq(IEacRegistry(TAZ0R_REGISTRY).getSubregistry("acme"), ACME);
        vm.startPrank(ACME_ADMIN);
        if (IEacRegistry(ACME).roles(0, APPROVER1) & ROLE_APPROVER == 0) {
            IEacRegistry(ACME).grantRootRoles(ROLE_APPROVER, APPROVER1);
        }
        if (IEacRegistry(ACME).roles(0, APPROVER2) & ROLE_APPROVER == 0) {
            IEacRegistry(ACME).grantRootRoles(ROLE_APPROVER, APPROVER2);
        }
        vm.stopPrank();
        gate = new EnsGate(PORTAL, TAZ0R_REGISTRY, MODULE, 300_000);
    }

    function _auth() internal view returns (InvoiceAuth memory) {
        return InvoiceAuth(keccak256("inv"), ACCOUNT, address(0xBEEF), 1_250_500000, uint64(block.timestamp + 1 days), 7);
    }

    function _forward(uint256 n) internal returns (uint256 gasUsed, bytes memory data) {
        address[] memory l = new address[](n);
        bytes[] memory s = new bytes[](n);
        l[0] = APPROVER1;
        if (n == 2) l[1] = APPROVER2;
        for (uint256 i; i < n; ++i) s[i] = new bytes(256);
        InvoiceAuth memory auth = _auth();
        data = abi.encodeCall(IPaymentModule.payFromL1, (ACME, ACCOUNT, auth, l, s));

        vm.recordLogs();
        uint256 g = gasleft();
        gate.forward("acme", ACCOUNT, auth, l, s);
        gasUsed = g - gasleft();

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == PORTAL && logs[i].topics[0] == TRANSACTION_DEPOSITED) {
                assertEq(logs[i].topics[1], bytes32(uint256(uint160(AddressAlias.applyL1ToL2Alias(address(gate))))));
                assertEq(logs[i].topics[2], bytes32(uint256(uint160(MODULE))));
                bytes memory opaque = abi.decode(logs[i].data, (bytes));
                assertEq(opaque.length, 32 + 32 + 8 + 1 + data.length);
                found = true;
            }
        }
        assertTrue(found, "no TransactionDeposited");
    }

    function test_forwardOneApprover() public {
        (uint256 gasUsed, bytes memory data) = _forward(1);
        console.log("forward gas, 1 approver:", gasUsed, "l2 calldata bytes:", data.length);
    }

    function test_forwardTwoApprovers() public {
        (uint256 gasUsed, bytes memory data) = _forward(2);
        console.log("forward gas, 2 approvers:", gasUsed, "l2 calldata bytes:", data.length);
    }
}
