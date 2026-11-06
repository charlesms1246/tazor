// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AddressAlias} from "../src/libraries/AddressAlias.sol";
import {PaymentModuleV2} from "../src/modules/PaymentModuleV2.sol";
import {MandateModuleV2} from "../src/modules/MandateModuleV2.sol";
import {IRoleCache} from "../src/interfaces/IRoleCache.sol";
import {IWBSoulRegistry, IWBSoulAttributeRegistry} from "../src/interfaces/IWBSoul.sol";
import {TazorDeployLib} from "./TazorDeployLib.sol";

/// v2 stack, alongside the live v1: PaymentModuleV2 + MandateModuleV2 (CREATE2, salts "tazor.v2.<Name>") and
/// EnsGate v2 (CreateX CREATE3, deployer-guarded salt from "tazor.v2.EnsGate"). Shared v1 contracts
/// (PolicyHook, factories, RoleCache) are reused.
abstract contract TazorDeployLibV2 is TazorDeployLib {
    /// Implementation behind every TazorAccount clone of the live TazorAccountFactory (CREATE nonce 1 of it).
    address internal constant TAZOR_ACCOUNT_IMPL = 0x8d7bdBf585Cb292CEBBe7f5ebe78f356D0221dAd;

    struct AddressesV2 {
        address paymentModuleV2;
        address mandateModuleV2;
        address ensGateV2;
        address ensGateV2Alias;
    }

    function _saltV2(string memory name) internal pure returns (bytes32) {
        return keccak256(bytes(string.concat("tazor.v2.", name)));
    }

    function _ensGateSaltV2(address deployer) internal pure returns (bytes32) {
        return bytes32(abi.encodePacked(deployer, bytes1(0x00), bytes11(_saltV2("EnsGate"))));
    }

    function _ensGateGuardedSaltV2(address deployer) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes32(uint256(uint160(deployer))), _ensGateSaltV2(deployer)));
    }

    function _paymentModuleV2Init(address roleCache, address ensGateAlias) internal pure returns (bytes memory) {
        return abi.encodePacked(
            type(PaymentModuleV2).creationCode,
            abi.encode(
                IERC20(USDT),
                IWBSoulRegistry(WB_SOUL_MIRROR),
                IWBSoulAttributeRegistry(WB_SOUL_MIRROR),
                IS_VERIFIED,
                IRoleCache(roleCache),
                ensGateAlias,
                TAZOR_ACCOUNT_IMPL
            )
        );
    }

    function _mandateModuleV2Init(address paymentModuleV2) internal pure returns (bytes memory) {
        return abi.encodePacked(type(MandateModuleV2).creationCode, abi.encode(paymentModuleV2));
    }

    function _create2V2(string memory name, bytes memory initCode) internal pure returns (address) {
        return vm.computeCreate2Address(_saltV2(name), keccak256(initCode), CREATE2_DEPLOYER);
    }

    function predictV2(Params memory p) public view returns (AddressesV2 memory a) {
        a.ensGateV2 = CREATEX.computeCreate3Address(_ensGateGuardedSaltV2(p.deployer));
        a.ensGateV2Alias = AddressAlias.applyL1ToL2Alias(a.ensGateV2);
        a.paymentModuleV2 = _create2V2("PaymentModule", _paymentModuleV2Init(p.roleCache, a.ensGateV2Alias));
        a.mandateModuleV2 = _create2V2("MandateModule", _mandateModuleV2Init(a.paymentModuleV2));
    }

    function _deploy2V2(string memory name, bytes memory initCode) internal returns (address addr) {
        addr = _create2V2(name, initCode);
        if (addr.code.length == 0) {
            (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(_saltV2(name), initCode));
            require(ok && addr.code.length != 0, string.concat("CREATE2 failed: v2 ", name));
        }
    }
}
