// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {TazorDeployLib} from "./TazorDeployLib.sol";

/// Prints every deterministic address. Env: DEPLOYER (address), optional ROLE_CACHE (default: the live RoleCache), optional L2_GAS_LIMIT.
/// Run against either chain (needs CreateX for the CREATE3 address).
contract Predict is TazorDeployLib {
    function run() external view returns (Addresses memory a) {
        Params memory p = _envParams(vm.envAddress("DEPLOYER"));
        a = predict(p);
        console2.log("deployer              ", p.deployer);
        console2.log("roleCache             ", p.roleCache);
        console2.log("l2GasLimit            ", uint256(p.l2GasLimit));
        console2.log("PolicyHook            ", a.policyHook);
        console2.log("ApproverAccountFactory", a.approverAccountFactory);
        console2.log("TazorAccountFactory   ", a.tazorAccountFactory);
        console2.log("PaymentModule         ", a.paymentModule);
        console2.log("MandateModule         ", a.mandateModule);
        console2.log("EnsGate (Sepolia)     ", a.ensGate);
        console2.log("EnsGate L2 alias      ", a.ensGateAlias);
    }
}
