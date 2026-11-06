// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {WBSoulMirror} from "../src/mocks/WBSoulMirror.sol";
import {MirrorOperator} from "../src/mocks/MirrorOperator.sol";

/// Whitechain testnet: deploys MirrorOperator for the SIMULATED WB Soul mirror, whitelists OPERATOR, and (only with
/// TRANSFER_MIRROR=1) hands it the mirror's ownership. That transfer is the one trust change: afterwards the OPERATOR key
/// can register-and-verify NEW souls (DAILY_CAP per UTC day) and nothing else; the deployer keeps everything via execute()
/// and can take the mirror back with transferMirrorOwnership(deployer).
/// Env: PRIVATE_KEY (deployer = current mirror owner), OPERATOR (address); optional MIRROR, DAILY_CAP (default 40),
/// MIRROR_OPERATOR (reuse an existing deployment), TRANSFER_MIRROR (1 to transfer).
contract DeployMirrorOperator is Script {
    address constant MIRROR = 0x9822650A99bD33F29E383345F570dAE1e4E00928;

    function run() external returns (MirrorOperator op) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        WBSoulMirror mirror = WBSoulMirror(vm.envOr("MIRROR", MIRROR));
        address operator = vm.envAddress("OPERATOR");
        uint256 cap = vm.envOr("DAILY_CAP", uint256(40));
        address existing = vm.envOr("MIRROR_OPERATOR", address(0));
        bool transfer = vm.envOr("TRANSFER_MIRROR", uint256(0)) == 1;

        address owner = mirror.owner();
        require(owner == deployer || (existing != address(0) && owner == existing), "deployer does not own the mirror");

        vm.startBroadcast(pk);
        op = existing == address(0) ? new MirrorOperator(mirror, deployer, cap) : MirrorOperator(existing);
        require(op.owner() == deployer && address(op.mirror()) == address(mirror), "MirrorOperator mismatch");
        if (!op.isOperator(operator)) op.setOperator(operator, true);
        if (op.dailyCap() != cap) op.setDailyCap(cap);
        if (transfer && mirror.owner() == deployer) mirror.transferOwnership(address(op));
        vm.stopBroadcast();

        console2.log("MirrorOperator", address(op));
        console2.log("operator", operator);
        console2.log("dailyCap", cap);
        console2.log("mirror owner", mirror.owner());
    }
}
