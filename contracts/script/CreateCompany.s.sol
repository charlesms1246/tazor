// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {Script} from "forge-std/Script.sol";
import {TazorAccountFactory} from "../src/account/TazorAccountFactory.sol";
import {TazorAccount} from "../src/account/TazorAccount.sol";
import {PaymentModule} from "../src/modules/PaymentModule.sol";
import {MODULE_TYPE_EXECUTOR} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";

/// Whitechain: creates (or returns) a company TazorAccount with PaymentModule installed.
/// Env: PRIVATE_KEY (payer only), ADMINS (comma-separated ApproverAccount addresses), THRESHOLD,
/// REGISTRY (company ENS registry on Ethereum Sepolia), TWO_APPROVER_THRESHOLD (USDT base units),
/// SALT (string). Factory and module addresses come from deployments/1874.json.
contract CreateCompany is Script {
    struct Company {
        address[] admins;
        uint64 threshold;
        address registry;
        uint256 twoApproverThreshold;
        bytes32 salt;
    }

    function run() external returns (address) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments/1874.json"));
        Company memory c = Company({
            admins: vm.envAddress("ADMINS", ","),
            threshold: uint64(vm.envUint("THRESHOLD")),
            registry: vm.envAddress("REGISTRY"),
            twoApproverThreshold: vm.envUint("TWO_APPROVER_THRESHOLD"),
            salt: keccak256(bytes(vm.envString("SALT")))
        });
        return create(
            vm.envUint("PRIVATE_KEY"),
            TazorAccountFactory(vm.parseJsonAddress(json, ".TazorAccountFactory")),
            PaymentModule(vm.parseJsonAddress(json, ".PaymentModule")),
            c
        );
    }

    function create(uint256 pk, TazorAccountFactory factory, PaymentModule pm, Company memory c)
        public
        returns (address account)
    {
        bytes[] memory admins = new bytes[](c.admins.length);
        for (uint256 i; i < admins.length; ++i) {
            admins[i] = abi.encodePacked(c.admins[i]);
        }
        address[] memory executors = new address[](1);
        executors[0] = address(pm);
        bytes[] memory data = new bytes[](1);
        data[0] = abi.encode(c.registry, c.twoApproverThreshold);
        TazorAccountFactory.Config memory config = TazorAccountFactory.Config(admins, c.threshold, executors, data);

        vm.startBroadcast(pk);
        account = factory.createAccount(config, c.salt);
        vm.stopBroadcast();

        require(account == factory.predictAddress(config, c.salt), "company address");
        require(TazorAccount(payable(account)).isModuleInstalled(MODULE_TYPE_EXECUTOR, address(pm), ""), "module");
        require(pm.registryOf(account) == c.registry, "registry");
        console2.log("TazorAccount", account);
    }
}
