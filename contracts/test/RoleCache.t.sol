// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {RoleCache, IGatewayVerifier, GatewayRequest} from "../src/ens/RoleCache.sol";

contract MockGatewayVerifier is IGatewayVerifier {
    bytes32 public expectedOps;
    bytes32 public value;
    uint8 public exitCode;

    function set(bytes32 expectedOps_, bytes32 value_, uint8 exitCode_) external {
        (expectedOps, value, exitCode) = (expectedOps_, value_, exitCode_);
    }

    function getLatestContext() external pure returns (bytes memory) {
        return abi.encode(uint256(1));
    }

    function getStorageValues(bytes memory, GatewayRequest memory req, bytes memory)
        external
        view
        returns (bytes[] memory values, uint8 code)
    {
        require(keccak256(req.ops) == expectedOps, "unexpected request");
        values = new bytes[](1);
        values[0] = abi.encode(value);
        code = exitCode;
    }
}

contract RoleCacheTest is Test {
    address constant REGISTRY = 0x44007108C0Cca53498F19F259E73E70C2ebE900a;
    address constant ACCOUNT = 0xce4389ACb79463062c362fACB8CB04513fA3D8D8;
    // Produced by the TypeScript prover's GatewayRequest for the same target and slot.
    bytes constant OPS =
        hex"011444007108c0cca53498f19f259e73e70c2ebe900a32207bf565dba35a82a82194edff4de4ef1347be714ed7d034ac92b4599367e91374463c0033";

    MockGatewayVerifier verifier;
    RoleCache cache;
    bytes proof;
    uint64 proofBlock;
    bytes32 provenValue;

    function setUp() public {
        verifier = new MockGatewayVerifier();
        cache = new RoleCache(verifier);
        string memory json = vm.readFile("test/fixtures/roles-proof.json");
        proof = vm.parseJsonBytes(json, ".witness");
        proofBlock = uint64(vm.parseJsonUint(json, ".l1Block"));
        provenValue = vm.parseJsonBytes32(json, ".value");
    }

    function test_slotMatchesEnsLayout() public view {
        assertEq(cache.rolesSlot(ACCOUNT), 0x7bf565dba35a82a82194edff4de4ef1347be714ed7d034ac92b4599367e91374);
    }

    function test_requestMatchesTypeScriptEncoding() public view {
        assertEq(cache.request(REGISTRY, ACCOUNT).ops, OPS);
    }

    function test_provenBlockFromRealProof() public view {
        assertEq(cache.provenL1Block(proof), proofBlock);
    }

    function test_syncStoresRolesAndBlock() public {
        verifier.set(keccak256(OPS), provenValue, 0);
        cache.syncRoles(REGISTRY, ACCOUNT, proof);
        (uint256 roles, uint64 l1Block) = cache.rolesOf(REGISTRY, ACCOUNT);
        assertEq(bytes32(roles), provenValue);
        assertEq(l1Block, proofBlock);
    }

    function test_replaySameOrOlderProofReverts() public {
        verifier.set(keccak256(OPS), provenValue, 0);
        cache.syncRoles(REGISTRY, ACCOUNT, proof);
        verifier.set(keccak256(OPS), bytes32(0), 0);
        vm.expectRevert(abi.encodeWithSelector(RoleCache.RoleCacheStale.selector, proofBlock, proofBlock));
        cache.syncRoles(REGISTRY, ACCOUNT, proof);
    }

    function test_failedProofReverts() public {
        verifier.set(keccak256(OPS), provenValue, 1);
        vm.expectRevert(abi.encodeWithSelector(RoleCache.RoleCacheProofFailed.selector, uint8(1)));
        cache.syncRoles(REGISTRY, ACCOUNT, proof);
    }

    function test_otherAccountUsesOtherSlot() public {
        verifier.set(keccak256(OPS), provenValue, 0);
        vm.expectRevert("unexpected request");
        cache.syncRoles(REGISTRY, address(0xBEEF), proof);
    }
}
