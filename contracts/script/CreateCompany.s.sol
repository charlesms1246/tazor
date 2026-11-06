// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {Script} from "forge-std/Script.sol";
import {TazorAccountFactory} from "../src/account/TazorAccountFactory.sol";
import {TazorAccount} from "../src/account/TazorAccount.sol";
import {PaymentModule} from "../src/modules/PaymentModule.sol";
import {MandateModule} from "../src/modules/MandateModule.sol";
import {MODULE_TYPE_EXECUTOR} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";

/// Whitechain: creates (or returns) a company TazorAccount with PaymentModule (and optionally MandateModule).
/// Env: PRIVATE_KEY (payer only), ADMINS (comma-separated ApproverAccount addresses), THRESHOLD,
/// REGISTRY (company ENS registry on Ethereum Sepolia), TWO_APPROVER_THRESHOLD (USDT base units),
/// SALT (string), optional EXECUTORS ("payment" default, or "payment,mandate").
/// Module and factory addresses come from deployments/1874.json. Executors can't be added later.
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
        MandateModule mandate;
        string[] memory names = vm.split(vm.envOr("EXECUTORS", string("payment")), ",");
        bool hasPayment;
        for (uint256 i; i < names.length; ++i) {
            bytes32 n = keccak256(bytes(names[i]));
            if (n == keccak256("payment")) hasPayment = true;
            else if (n == keccak256("mandate")) mandate = MandateModule(vm.parseJsonAddress(json, ".MandateModule"));
            else revert(string.concat("unknown executor: ", names[i]));
        }
        require(hasPayment, "EXECUTORS must include payment");
        return create(
            vm.envUint("PRIVATE_KEY"),
            TazorAccountFactory(vm.parseJsonAddress(json, ".TazorAccountFactory")),
            PaymentModule(vm.parseJsonAddress(json, ".PaymentModule")),
            mandate,
            c
        );
    }

    /// @param mandate address(0) for a PaymentModule-only company.
    function create(uint256 pk, TazorAccountFactory factory, PaymentModule pm, MandateModule mandate, Company memory c)
        public
        returns (address account)
    {
        bytes[] memory admins = new bytes[](c.admins.length);
        for (uint256 i; i < admins.length; ++i) {
            admins[i] = abi.encodePacked(c.admins[i]);
        }
        uint256 n = address(mandate) == address(0) ? 1 : 2;
        address[] memory executors = new address[](n);
        bytes[] memory data = new bytes[](n);
        executors[0] = address(pm);
        data[0] = abi.encode(c.registry, c.twoApproverThreshold);
        if (n == 2) {
            require(address(mandate.paymentModule()) == address(pm), "mandate module bound to another PaymentModule");
            executors[1] = address(mandate);
        }
        TazorAccountFactory.Config memory config = TazorAccountFactory.Config(admins, c.threshold, executors, data);

        vm.startBroadcast(pk);
        account = factory.createAccount(config, c.salt);
        vm.stopBroadcast();

        require(account == factory.predictAddress(config, c.salt), "company address");
        TazorAccount company = TazorAccount(payable(account));
        require(company.isModuleInstalled(MODULE_TYPE_EXECUTOR, address(pm), ""), "payment module");
        if (n == 2) require(company.isModuleInstalled(MODULE_TYPE_EXECUTOR, address(mandate), ""), "mandate module");
        require(pm.registryOf(account) == c.registry, "registry");
        console2.log("TazorAccount", account);
    }
}
