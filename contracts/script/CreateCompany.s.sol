// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {Script} from "forge-std/Script.sol";
import {TazorAccountFactory} from "../src/account/TazorAccountFactory.sol";
import {TazorAccount} from "../src/account/TazorAccount.sol";
import {PaymentModule} from "../src/modules/PaymentModule.sol";
import {MandateModule} from "../src/modules/MandateModule.sol";
import {PaymentModuleV2} from "../src/modules/PaymentModuleV2.sol";
import {MODULE_TYPE_EXECUTOR} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";

/// Whitechain: creates (or returns) a company TazorAccount with PaymentModule (and optionally MandateModule).
/// Env: PRIVATE_KEY (payer only), ADMINS (comma-separated ApproverAccount addresses), THRESHOLD,
/// REGISTRY (company ENS registry on Ethereum Sepolia), TWO_APPROVER_THRESHOLD (USDT base units),
/// SALT (string), optional EXECUTORS ("payment" default, or "payment,mandate", plus ",financing" for v2).
/// VERSION=2 uses PaymentModuleV2 / MandateModuleV2 with a ConfigV2 from env: PER_PAYMENT_LIMIT,
/// MONTHLY_LIMIT, PAYEE_DELAY, FRESH_THRESHOLD, MAX_CACHE_AGE, AGENT_MONTHLY_CAP, EXIT_ACCOUNTS
/// (comma-separated, optional), EXIT_DELAY, and FINANCING_MODULE when EXECUTORS includes financing.
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
        if (vm.envOr("VERSION", uint256(1)) == 2) return _runV2();
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

    // ---- v2

    struct Modules {
        PaymentModuleV2 payment;
        address mandate;
        address financing;
    }

    function _runV2() internal returns (address) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments/1874.json"));
        Modules memory mods = Modules(PaymentModuleV2(vm.parseJsonAddress(json, ".PaymentModuleV2")), address(0), address(0));
        string[] memory names = vm.split(vm.envOr("EXECUTORS", string("payment")), ",");
        bool hasPayment;
        for (uint256 i; i < names.length; ++i) {
            bytes32 n = keccak256(bytes(names[i]));
            if (n == keccak256("payment")) hasPayment = true;
            else if (n == keccak256("mandate")) mods.mandate = vm.parseJsonAddress(json, ".MandateModuleV2");
            else if (n == keccak256("financing")) mods.financing = vm.envAddress("FINANCING_MODULE");
            else revert(string.concat("unknown executor: ", names[i]));
        }
        require(hasPayment, "EXECUTORS must include payment");
        address[] memory none = new address[](0);
        PaymentModuleV2.ConfigV2 memory cfg = PaymentModuleV2.ConfigV2({
            registry: vm.envAddress("REGISTRY"),
            twoApproverThreshold: uint96(vm.envUint("TWO_APPROVER_THRESHOLD")),
            perPaymentLimit: uint96(vm.envUint("PER_PAYMENT_LIMIT")),
            monthlyLimit: uint96(vm.envUint("MONTHLY_LIMIT")),
            payeeDelay: uint32(vm.envOr("PAYEE_DELAY", uint256(1 days))),
            freshThreshold: uint96(vm.envUint("FRESH_THRESHOLD")),
            maxCacheAge: uint32(vm.envOr("MAX_CACHE_AGE", uint256(300))),
            agentMonthlyCap: uint96(vm.envOr("AGENT_MONTHLY_CAP", uint256(0))),
            exitAccounts: vm.envOr("EXIT_ACCOUNTS", ",", none),
            exitDelay: uint32(vm.envOr("EXIT_DELAY", uint256(7 days)))
        });
        return createV2(
            vm.envUint("PRIVATE_KEY"),
            TazorAccountFactory(vm.parseJsonAddress(json, ".TazorAccountFactory")),
            mods,
            vm.envAddress("ADMINS", ","),
            uint64(vm.envUint("THRESHOLD")),
            cfg,
            keccak256(bytes(vm.envString("SALT")))
        );
    }

    /// @param mods mandate / financing may be address(0) (not installed).
    function createV2(
        uint256 pk,
        TazorAccountFactory factory,
        Modules memory mods,
        address[] memory adminAccounts,
        uint64 threshold,
        PaymentModuleV2.ConfigV2 memory cfg,
        bytes32 salt
    ) public returns (address account) {
        bytes[] memory admins = new bytes[](adminAccounts.length);
        for (uint256 i; i < admins.length; ++i) {
            admins[i] = abi.encodePacked(adminAccounts[i]);
        }
        uint256 n = 1 + (mods.mandate == address(0) ? 0 : 1) + (mods.financing == address(0) ? 0 : 1);
        address[] memory executors = new address[](n);
        bytes[] memory data = new bytes[](n);
        executors[0] = address(mods.payment);
        data[0] = abi.encode(cfg);
        uint256 k = 1;
        if (mods.mandate != address(0)) {
            require(
                address(MandateModuleV2Like(mods.mandate).paymentModule()) == address(mods.payment),
                "mandate module bound to another PaymentModule"
            );
            executors[k++] = mods.mandate;
        }
        if (mods.financing != address(0)) executors[k++] = mods.financing;
        TazorAccountFactory.Config memory config = TazorAccountFactory.Config(admins, threshold, executors, data);

        vm.startBroadcast(pk);
        account = factory.createAccount(config, salt);
        vm.stopBroadcast();

        require(account == factory.predictAddress(config, salt), "company address");
        for (uint256 i; i < n; ++i) {
            require(TazorAccount(payable(account)).isModuleInstalled(MODULE_TYPE_EXECUTOR, executors[i], ""), "executor");
        }
        require(mods.payment.registryOf(account) == cfg.registry, "registry");
        console2.log("TazorAccount (v2)", account);
    }
}

interface MandateModuleV2Like {
    function paymentModule() external view returns (address);
}
