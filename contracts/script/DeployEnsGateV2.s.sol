// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {EnsGate} from "../src/l1/EnsGate.sol";
import {TazorDeployLibV2} from "./TazorDeployLibV2.sol";

/// Ethereum Sepolia (11155111): EnsGate v2 (same code) via CreateX CREATE3, pointing at PaymentModuleV2.
/// Env: PRIVATE_KEY, optional ROLE_CACHE, L2_GAS_LIMIT (default 400000), WRITE_DEPLOYMENTS.
/// Live Sepolia charges ~4.4M gas for this CREATE3; forge's estimate is far lower, so broadcast with
/// `cast send <CreateX> <CREATEX_CALLDATA> --gas-limit 5500000` using the calldata this script prints.
contract DeployEnsGateV2 is TazorDeployLibV2 {
    function run() external returns (AddressesV2 memory) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        return deploy(pk, _envParams(vm.addr(pk)));
    }

    function deploy(uint256 pk, Params memory p) public returns (AddressesV2 memory a) {
        require(block.chainid == ETH_SEPOLIA, "not Ethereum Sepolia");
        require(p.deployer == vm.addr(pk), "deployer mismatch");
        a = predictV2(p);
        bytes memory initCode = _ensGateInit(a.paymentModuleV2, p.l2GasLimit);
        console2.log("CREATEX", address(CREATEX));
        console2.log("CREATEX_CALLDATA", vm.toString(abi.encodeCall(CREATEX.deployCreate3, (_ensGateSaltV2(p.deployer), initCode))));

        // Recording needs the gate to exist on chain already (live, it is deployed with cast send, see above);
        // otherwise a simulation would record an address that has no code.
        bool existed = a.ensGateV2.code.length != 0;
        require(existed || !_recordingEnabled(), "deploy first via CreateX");
        if (!existed) {
            vm.startBroadcast(pk);
            address deployed = CREATEX.deployCreate3(_ensGateSaltV2(p.deployer), initCode);
            vm.stopBroadcast();
            require(deployed == a.ensGateV2, "EnsGate v2 address");
        }
        EnsGate gate = EnsGate(a.ensGateV2);
        require(gate.paymentModule() == a.paymentModuleV2, "EnsGate v2 paymentModule");
        require(gate.l2GasLimit() == p.l2GasLimit, "EnsGate v2 l2GasLimit");
        require(address(gate.portal()) == OPTIMISM_PORTAL && address(gate.taz0rRegistry()) == TAZ0R_REGISTRY, "EnsGate v2");

        _record("EnsGateV2", a.ensGateV2);
        _record("PaymentModuleV2L2", a.paymentModuleV2);
        console2.log("EnsGateV2      ", a.ensGateV2);
        console2.log("PaymentModuleV2", a.paymentModuleV2);
    }
}
