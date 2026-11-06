// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {TazorDeployLibV2} from "./TazorDeployLibV2.sol";

/// Prints the v2 addresses. Env: DEPLOYER (address), optional ROLE_CACHE. Run against either chain.
contract PredictV2 is TazorDeployLibV2 {
    function run() external view returns (AddressesV2 memory a) {
        Params memory p = _envParams(vm.envAddress("DEPLOYER"));
        a = predictV2(p);
        console2.log("deployer         ", p.deployer);
        console2.log("roleCache        ", p.roleCache);
        console2.log("PaymentModuleV2  ", a.paymentModuleV2);
        console2.log("MandateModuleV2  ", a.mandateModuleV2);
        console2.log("EnsGateV2 (L1)   ", a.ensGateV2);
        console2.log("EnsGateV2 alias  ", a.ensGateV2Alias);
    }
}
