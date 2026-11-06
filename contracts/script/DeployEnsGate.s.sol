// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {EnsGate} from "../src/l1/EnsGate.sol";
import {TazorDeployLib} from "./TazorDeployLib.sol";

/// Ethereum Sepolia (11155111): EnsGate via CreateX CREATE3, pointing at the predicted Whitechain PaymentModule.
/// Env: PRIVATE_KEY (same key as the Whitechain run), optional ROLE_CACHE (same value as the Whitechain run), optional L2_GAS_LIMIT,
/// WRITE_DEPLOYMENTS.
contract DeployEnsGate is TazorDeployLib {
    function run() external returns (Addresses memory) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        return deploy(pk, _envParams(vm.addr(pk)));
    }

    function deploy(uint256 pk, Params memory p) public returns (Addresses memory a) {
        require(block.chainid == ETH_SEPOLIA, "not Ethereum Sepolia");
        require(p.deployer == vm.addr(pk), "deployer mismatch");
        a = predict(p);

        if (a.ensGate.code.length == 0) {
            vm.startBroadcast(pk);
            address deployed = CREATEX.deployCreate3(_ensGateSalt(p.deployer), _ensGateInit(a.paymentModule, p.l2GasLimit));
            vm.stopBroadcast();
            require(deployed == a.ensGate, "EnsGate address");
        }
        EnsGate gate = EnsGate(a.ensGate);
        require(gate.paymentModule() == a.paymentModule, "EnsGate paymentModule");
        require(gate.l2GasLimit() == p.l2GasLimit, "EnsGate l2GasLimit");
        require(address(gate.portal()) == OPTIMISM_PORTAL && address(gate.taz0rRegistry()) == TAZ0R_REGISTRY, "EnsGate");

        _record("EnsGate", a.ensGate);
        _record("PaymentModuleL2", a.paymentModule);
        console2.log("EnsGate      ", a.ensGate);
        console2.log("PaymentModule", a.paymentModule);
    }
}
