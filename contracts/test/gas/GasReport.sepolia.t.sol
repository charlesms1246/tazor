// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EnsGate} from "../../src/l1/EnsGate.sol";
import {InvoiceAuth} from "../../src/libraries/InvoiceAuth.sol";
import {GasMeter} from "./GasMeter.sol";

interface IEacRegistry {
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function roles(uint256 resource, address account) external view returns (uint256);
}

/// Ethereum Sepolia fork: EnsGate.forward through the real taz0r.eth registry and the real portal.
/// forge models prague gas rules; Sepolia runs Glamsterdam, so live costs can differ.
contract GasReportSepoliaTest is GasMeter {
    uint256 constant FORK_BLOCK = 12074508;
    address constant PORTAL = 0xFF9b597b0781457ae6aa7256Ca5ed5839bF7D0C3;
    address constant TAZ0R_REGISTRY = 0x44007108C0Cca53498F19F259E73E70C2ebE900a;
    address constant ACME = 0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1;
    address constant ACME_ADMIN = 0xce4389ACb79463062c362fACB8CB04513fA3D8D8;
    uint256 constant ROLE_APPROVER = 1 << 64;

    EnsGate gate;
    address a1 = makeAddr("approver1");
    address a2 = makeAddr("approver2");

    function setUp() public {
        vm.createSelectFork("sepolia", FORK_BLOCK);
        vm.startPrank(ACME_ADMIN);
        IEacRegistry(ACME).grantRootRoles(ROLE_APPROVER, a1);
        IEacRegistry(ACME).grantRootRoles(ROLE_APPROVER, a2);
        vm.stopPrank();
        gate = new EnsGate(PORTAL, TAZ0R_REGISTRY, address(0x7000), 400_000);
    }

    /// Same shape as a real ApproverAccount ECDSA signature: abi.encode([20-byte signer], [65-byte sig]).
    function _sig(uint256 seed) internal pure returns (bytes memory) {
        bytes[] memory signers = new bytes[](1);
        bytes[] memory sigs = new bytes[](1);
        signers[0] = abi.encodePacked(address(uint160(uint256(keccak256(abi.encode(seed))))));
        sigs[0] = abi.encodePacked(keccak256(abi.encode(seed, 1)), keccak256(abi.encode(seed, 2)), uint8(27));
        return abi.encode(signers, sigs);
    }

    function _forward(uint256 n) internal view returns (bytes memory) {
        address[] memory l = new address[](n);
        bytes[] memory s = new bytes[](n);
        l[0] = a1;
        s[0] = _sig(1);
        if (n == 2) {
            l[1] = a2;
            s[1] = _sig(2);
        }
        InvoiceAuth memory auth =
            InvoiceAuth(keccak256("inv"), address(0xACC), address(0xBEEF), 1_250_500000, uint64(block.timestamp + 1 days), 7);
        return abi.encodeCall(EnsGate.forward, ("acme", address(0xACC), auth, l, s));
    }

    function test_gas_ensGateForward_1approver() public {
        _measure("EnsGate.forward (Sepolia), 1 approver", address(gate), _forward(1));
    }

    function test_gas_ensGateForward_2approvers() public {
        _measure("EnsGate.forward (Sepolia), 2 approvers", address(gate), _forward(2));
    }
}
