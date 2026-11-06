// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AddressAlias} from "../src/libraries/AddressAlias.sol";
import {PolicyHook} from "../src/modules/PolicyHook.sol";
import {PaymentModule} from "../src/modules/PaymentModule.sol";
import {ApproverAccountFactory} from "../src/account/ApproverAccountFactory.sol";
import {TazorAccountFactory} from "../src/account/TazorAccountFactory.sol";
import {EnsGate} from "../src/l1/EnsGate.sol";
import {IRoleCache} from "../src/interfaces/IRoleCache.sol";
import {IWBSoulRegistry, IWBSoulAttributeRegistry} from "../src/interfaces/IWBSoul.sol";

interface ICreateX {
    function deployCreate3(bytes32 salt, bytes memory initCode) external payable returns (address);
    function computeCreate3Address(bytes32 salt) external view returns (address);
}

/// Deterministic addresses for the whole stack.
/// Whitechain contracts: CREATE2 through the canonical deployer (address = f(salt, init code)).
/// EnsGate: CreateX CREATE3 with a deployer-guarded salt (address = f(deployer EOA, salt), independent of
/// its constructor args), which breaks the EnsGate <-> PaymentModule address cycle and stops front-running.
abstract contract TazorDeployLib is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    ICreateX internal constant CREATEX = ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);

    uint256 internal constant WHITECHAIN_SEPOLIA = 1874;
    uint256 internal constant ETH_SEPOLIA = 11155111;

    address internal constant USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;
    address internal constant WB_SOUL_MIRROR = 0x9822650A99bD33F29E383345F570dAE1e4E00928;
    address internal constant IS_VERIFIED = 0xd88fa142B67F561C5f2Cbf803bF5AE906a8f1e41;
    address internal constant OPTIMISM_PORTAL = 0xFF9b597b0781457ae6aa7256Ca5ed5839bF7D0C3;
    address internal constant TAZ0R_REGISTRY = 0x44007108C0Cca53498F19F259E73E70C2ebE900a;
    uint64 internal constant DEFAULT_L2_GAS_LIMIT = 400_000;
    address internal constant DEFAULT_ROLE_CACHE = 0x8AC436e5BB681aE4d576e0131391aE3AACA88BDe;

    struct Params {
        address deployer; // EOA that broadcasts; part of EnsGate's guarded salt
        address roleCache;
        uint64 l2GasLimit;
    }

    struct Addresses {
        address policyHook;
        address approverAccountFactory;
        address tazorAccountFactory;
        address paymentModule;
        address ensGate;
        address ensGateAlias;
    }

    function _salt(string memory name) internal pure returns (bytes32) {
        return keccak256(bytes(string.concat("tazor.v1.", name)));
    }

    /// CreateX permissioned salt: deployer in bytes 0..19, 0x00 (no cross-chain redeploy protection), 11 bytes.
    function _ensGateSalt(address deployer) internal pure returns (bytes32) {
        return bytes32(abi.encodePacked(deployer, bytes1(0x00), bytes11(_salt("EnsGate"))));
    }

    /// Mirrors CreateX's _guard for a msg.sender-permissioned salt without redeploy protection.
    function _ensGateGuardedSalt(address deployer) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes32(uint256(uint160(deployer))), _ensGateSalt(deployer)));
    }

    // ---- init codes

    function _policyHookInit() internal pure returns (bytes memory) {
        return type(PolicyHook).creationCode;
    }

    function _approverFactoryInit() internal pure returns (bytes memory) {
        return type(ApproverAccountFactory).creationCode;
    }

    function _tazorFactoryInit(address policyHook) internal pure returns (bytes memory) {
        return abi.encodePacked(type(TazorAccountFactory).creationCode, abi.encode(policyHook));
    }

    function _paymentModuleInit(address roleCache, address ensGateAlias) internal pure returns (bytes memory) {
        return abi.encodePacked(
            type(PaymentModule).creationCode,
            abi.encode(
                IERC20(USDT),
                IWBSoulRegistry(WB_SOUL_MIRROR),
                IWBSoulAttributeRegistry(WB_SOUL_MIRROR),
                IS_VERIFIED,
                IRoleCache(roleCache),
                ensGateAlias
            )
        );
    }

    function _ensGateInit(address paymentModule, uint64 l2GasLimit) internal pure returns (bytes memory) {
        return abi.encodePacked(
            type(EnsGate).creationCode, abi.encode(OPTIMISM_PORTAL, TAZ0R_REGISTRY, paymentModule, l2GasLimit)
        );
    }

    function _create2(string memory name, bytes memory initCode) internal pure returns (address) {
        return vm.computeCreate2Address(_salt(name), keccak256(initCode), CREATE2_DEPLOYER);
    }

    /// Requires CreateX code on the current chain (it is on both).
    function predict(Params memory p) public view returns (Addresses memory a) {
        a.policyHook = _create2("PolicyHook", _policyHookInit());
        a.approverAccountFactory = _create2("ApproverAccountFactory", _approverFactoryInit());
        a.tazorAccountFactory = _create2("TazorAccountFactory", _tazorFactoryInit(a.policyHook));
        a.ensGate = CREATEX.computeCreate3Address(_ensGateGuardedSalt(p.deployer));
        a.ensGateAlias = AddressAlias.applyL1ToL2Alias(a.ensGate);
        a.paymentModule = _create2("PaymentModule", _paymentModuleInit(p.roleCache, a.ensGateAlias));
    }

    function _envParams(address deployer) internal view returns (Params memory) {
        return Params({
            deployer: deployer,
            roleCache: vm.envOr("ROLE_CACHE", DEFAULT_ROLE_CACHE),
            l2GasLimit: uint64(vm.envOr("L2_GAS_LIMIT", uint256(DEFAULT_L2_GAS_LIMIT)))
        });
    }

    /// Idempotent CREATE2 through the canonical deployer; returns the existing contract if already there.
    function _deploy2(string memory name, bytes memory initCode) internal returns (address addr) {
        addr = _create2(name, initCode);
        if (addr.code.length == 0) {
            (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(_salt(name), initCode));
            require(ok && addr.code.length != 0, string.concat("CREATE2 failed: ", name));
        }
    }

    // ---- deployments JSON (merge only; an existing key with a different value aborts)

    function _recordingEnabled() internal view virtual returns (bool) {
        return vm.envOr("WRITE_DEPLOYMENTS", false);
    }

    function _deploymentsFile() internal view virtual returns (string memory) {
        return string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
    }

    function _record(string memory key, address value) internal {
        if (!_recordingEnabled()) return;
        string memory path = _deploymentsFile();
        string memory json = vm.readFile(path);
        string memory jsonKey = string.concat(".", key);
        if (vm.keyExistsJson(json, jsonKey)) {
            require(vm.parseJsonAddress(json, jsonKey) == value, string.concat("deployments key differs: ", key));
            return;
        }
        vm.writeJson(string.concat('"', vm.toString(value), '"'), path, jsonKey);
    }
}
