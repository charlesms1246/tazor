// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {TazorAccountFactory} from "../src/account/TazorAccountFactory.sol";
import {PaymentModuleV2} from "../src/modules/PaymentModuleV2.sol";
import {MandateModuleV2} from "../src/modules/MandateModuleV2.sol";
import {TazorDeployLibV2} from "./TazorDeployLibV2.sol";

/// Whitechain Sepolia (1874): PaymentModuleV2 and MandateModuleV2. Idempotent; the v1 stack must exist
/// (its TazorAccountFactory implementation is what isTazorAccount recognises).
/// Env: PRIVATE_KEY (same key as for EnsGate v2), optional ROLE_CACHE, WRITE_DEPLOYMENTS.
contract DeployWhitechainV2 is TazorDeployLibV2 {
    function run() external returns (AddressesV2 memory) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        return deploy(pk, _envParams(vm.addr(pk)));
    }

    function deploy(uint256 pk, Params memory p) public returns (AddressesV2 memory a) {
        require(block.chainid == WHITECHAIN_SEPOLIA, "not Whitechain Sepolia");
        require(p.deployer == vm.addr(pk), "deployer mismatch");
        Addresses memory v1 = predict(p);
        require(v1.tazorAccountFactory.code.length != 0, "v1 TazorAccountFactory missing");
        require(TazorAccountFactory(v1.tazorAccountFactory).implementation() == TAZOR_ACCOUNT_IMPL, "account impl");
        a = predictV2(p);

        vm.startBroadcast(pk);
        require(
            _deploy2V2("PaymentModule", _paymentModuleV2Init(p.roleCache, a.ensGateV2Alias)) == a.paymentModuleV2,
            "PaymentModuleV2"
        );
        require(_deploy2V2("MandateModule", _mandateModuleV2Init(a.paymentModuleV2)) == a.mandateModuleV2, "MandateModuleV2");
        vm.stopBroadcast();

        PaymentModuleV2 pm = PaymentModuleV2(a.paymentModuleV2);
        require(pm.ensGateAlias() == a.ensGateV2Alias && address(pm.roleCache()) == p.roleCache, "PaymentModuleV2 config");
        require(address(MandateModuleV2(a.mandateModuleV2).paymentModule()) == a.paymentModuleV2, "MandateModuleV2 config");

        _record("PaymentModuleV2", a.paymentModuleV2);
        _record("RevocationListV2", address(pm.revocationList()));
        _record("MandateModuleV2", a.mandateModuleV2);
        _record("EnsGateV2Alias", a.ensGateV2Alias);
        console2.log("PaymentModuleV2 ", a.paymentModuleV2);
        console2.log("RevocationListV2", address(pm.revocationList()));
        console2.log("MandateModuleV2 ", a.mandateModuleV2);
        console2.log("EnsGateV2 alias ", a.ensGateV2Alias);
    }
}
