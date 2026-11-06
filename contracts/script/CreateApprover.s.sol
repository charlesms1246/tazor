// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {Script} from "forge-std/Script.sol";
import {ApproverAccountFactory} from "../src/account/ApproverAccountFactory.sol";

/// Whitechain: creates (or returns) the ApproverAccount whose only signer is an ECDSA backup EOA.
/// Env: PRIVATE_KEY (payer only), BACKUP_EOA, optional APPROVER_FACTORY (default: deployments/1874.json).
contract CreateApprover is Script {
    function run() external returns (address) {
        address factory = vm.envOr("APPROVER_FACTORY", address(0));
        if (factory == address(0)) {
            string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments/1874.json"));
            factory = vm.parseJsonAddress(json, ".ApproverAccountFactory");
        }
        return create(vm.envUint("PRIVATE_KEY"), ApproverAccountFactory(factory), vm.envAddress("BACKUP_EOA"));
    }

    function create(uint256 pk, ApproverAccountFactory factory, address backup) public returns (address account) {
        bytes[] memory signers = new bytes[](1);
        signers[0] = abi.encodePacked(backup);
        vm.startBroadcast(pk);
        account = factory.createAccount(signers);
        vm.stopBroadcast();
        require(account == factory.predictAddress(signers), "approver address");
        console2.log("ApproverAccount", account);
        console2.log("backup signer  ", backup);
    }
}
