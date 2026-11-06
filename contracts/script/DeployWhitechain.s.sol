// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {ApproverAccountFactory} from "../src/account/ApproverAccountFactory.sol";
import {TazorAccountFactory} from "../src/account/TazorAccountFactory.sol";
import {PaymentModule} from "../src/modules/PaymentModule.sol";
import {MandateModule} from "../src/modules/MandateModule.sol";
import {TazorDeployLib} from "./TazorDeployLib.sol";

/// Whitechain Sepolia (1874): PolicyHook, ApproverAccountFactory, TazorAccountFactory, PaymentModule,
/// MandateModule. Already-deployed contracts are skipped.
/// Env: PRIVATE_KEY, optional ROLE_CACHE (default: the live RoleCache), optional L2_GAS_LIMIT (must match the EnsGate run), WRITE_DEPLOYMENTS.
contract DeployWhitechain is TazorDeployLib {
    function run() external returns (Addresses memory) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        return deploy(pk, _envParams(vm.addr(pk)));
    }

    function deploy(uint256 pk, Params memory p) public returns (Addresses memory a) {
        require(block.chainid == WHITECHAIN_SEPOLIA, "not Whitechain Sepolia");
        require(p.deployer == vm.addr(pk), "deployer mismatch");
        a = predict(p);

        vm.startBroadcast(pk);
        require(_deploy2("PolicyHook", _policyHookInit()) == a.policyHook, "PolicyHook");
        require(
            _deploy2("ApproverAccountFactory", _approverFactoryInit()) == a.approverAccountFactory,
            "ApproverAccountFactory"
        );
        require(
            _deploy2("TazorAccountFactory", _tazorFactoryInit(a.policyHook)) == a.tazorAccountFactory,
            "TazorAccountFactory"
        );
        require(
            _deploy2("PaymentModule", _paymentModuleInit(p.roleCache, a.ensGateAlias)) == a.paymentModule,
            "PaymentModule"
        );
        require(
            _deploy2("MandateModule", _mandateModuleInit(a.paymentModule)) == a.mandateModule, "MandateModule"
        );
        vm.stopBroadcast();

        PaymentModule pm = PaymentModule(a.paymentModule);
        require(pm.ensGateAlias() == a.ensGateAlias && address(pm.roleCache()) == p.roleCache, "PaymentModule config");
        require(TazorAccountFactory(a.tazorAccountFactory).policyHook() == a.policyHook, "factory hook");
        require(address(MandateModule(a.mandateModule).paymentModule()) == a.paymentModule, "MandateModule config");

        _record("PolicyHook", a.policyHook);
        _record("ApproverAccountFactory", a.approverAccountFactory);
        _record("WebAuthnVerifier", ApproverAccountFactory(a.approverAccountFactory).webAuthnVerifier());
        _record("TazorAccountFactory", a.tazorAccountFactory);
        _record("PaymentModule", a.paymentModule);
        _record("RevocationList", address(pm.revocationList()));
        _record("MandateModule", a.mandateModule);
        _record("RoleCache", p.roleCache);
        _record("EnsGateAlias", a.ensGateAlias);

        console2.log("PolicyHook            ", a.policyHook);
        console2.log("ApproverAccountFactory", a.approverAccountFactory);
        console2.log("TazorAccountFactory   ", a.tazorAccountFactory);
        console2.log("PaymentModule         ", a.paymentModule);
        console2.log("RevocationList        ", address(pm.revocationList()));
        console2.log("MandateModule         ", a.mandateModule);
        console2.log("EnsGate alias         ", a.ensGateAlias);
    }
}
