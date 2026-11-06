// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IEntryPoint} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {SoulQuotaPaymaster} from "../src/paymaster/SoulQuotaPaymaster.sol";
import {ApproverAccountFactory} from "../src/account/ApproverAccountFactory.sol";
import {IWBSoulAttributeRegistry, IWBSoulRegistry} from "../src/interfaces/IWBSoul.sol";

/// Whitechain: SoulQuotaPaymaster via the deterministic CREATE2 deployer (salt "tazor.v2.SoulQuotaPaymaster"),
/// then an EntryPoint deposit. Idempotent: an existing deployment is verified and only topped up.
/// Env: PRIVATE_KEY; optional OWNER (default deployer), MAX_OPS (10), MAX_COST_WEI (0.05 ether), DEPOSIT_WEI (0.5 ether),
/// SOUL_REGISTRY / ATTRIBUTE_REGISTRY (default: the testnet mirror for both), APPROVER_FACTORY.
contract DeployPaymaster is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    IEntryPoint constant ENTRY_POINT = IEntryPoint(0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108);
    address constant MIRROR = 0x9822650A99bD33F29E383345F570dAE1e4E00928;
    address constant IS_VERIFIED = 0xd88fa142B67F561C5f2Cbf803bF5AE906a8f1e41;
    address constant APPROVER_FACTORY = 0xf15c31bCd909e08AAc394D1e2E4dbf6D11223D8e;
    bytes32 constant SALT = keccak256("tazor.v2.SoulQuotaPaymaster");

    struct Params {
        address owner;
        uint256 maxOps;
        uint256 maxCost;
        uint256 depositWei;
        address soulRegistry;
        address attributeRegistry;
        address implementation;
    }

    function run() external returns (SoulQuotaPaymaster pm) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        Params memory p = Params({
            owner: vm.envOr("OWNER", vm.addr(pk)),
            maxOps: vm.envOr("MAX_OPS", uint256(10)),
            maxCost: vm.envOr("MAX_COST_WEI", uint256(0.05 ether)),
            depositWei: vm.envOr("DEPOSIT_WEI", uint256(0.5 ether)),
            soulRegistry: vm.envOr("SOUL_REGISTRY", MIRROR),
            attributeRegistry: vm.envOr("ATTRIBUTE_REGISTRY", MIRROR),
            implementation: ApproverAccountFactory(vm.envOr("APPROVER_FACTORY", APPROVER_FACTORY)).implementation()
        });
        address predicted = predict(p);

        vm.startBroadcast(pk);
        pm = predicted.code.length == 0 ? _deploy(p) : SoulQuotaPaymaster(predicted);
        require(address(pm) == predicted, "CREATE2 address");
        if (p.depositWei != 0) pm.deposit{value: p.depositWei}();
        vm.stopBroadcast();

        require(address(pm.entryPoint()) == address(ENTRY_POINT) && pm.owner() == p.owner, "config");
        require(pm.approverImplementation() == p.implementation && pm.maxOpsPerWindow() == p.maxOps, "config");
        console2.log("SoulQuotaPaymaster", address(pm));
        console2.log("owner             ", p.owner);
        console2.log("EntryPoint deposit", ENTRY_POINT.balanceOf(address(pm)));
    }

    function predict(Params memory p) public pure returns (address) {
        bytes memory init = abi.encodePacked(
            type(SoulQuotaPaymaster).creationCode,
            abi.encode(ENTRY_POINT, p.soulRegistry, p.attributeRegistry, IS_VERIFIED, p.implementation, p.maxOps, p.maxCost, p.owner)
        );
        return vm.computeCreate2Address(SALT, keccak256(init), CREATE2_DEPLOYER);
    }

    function _deploy(Params memory p) internal returns (SoulQuotaPaymaster) {
        return new SoulQuotaPaymaster{salt: SALT}(
            ENTRY_POINT, IWBSoulRegistry(p.soulRegistry), IWBSoulAttributeRegistry(p.attributeRegistry), IS_VERIFIED,
            p.implementation, p.maxOps, p.maxCost, p.owner
        );
    }
}
