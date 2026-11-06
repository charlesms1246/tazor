// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AddressAlias} from "../src/libraries/AddressAlias.sol";
import {ApproverAccountFactory} from "../src/account/ApproverAccountFactory.sol";
import {TazorAccountFactory} from "../src/account/TazorAccountFactory.sol";
import {TazorAccount} from "../src/account/TazorAccount.sol";
import {PaymentModule} from "../src/modules/PaymentModule.sol";
import {MandateModule} from "../src/modules/MandateModule.sol";
import {MODULE_TYPE_EXECUTOR} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {EnsGate} from "../src/l1/EnsGate.sol";
import {TazorDeployLib} from "../script/TazorDeployLib.sol";
import {DeployWhitechain} from "../script/DeployWhitechain.s.sol";
import {DeployEnsGate} from "../script/DeployEnsGate.s.sol";
import {CreateApprover} from "../script/CreateApprover.s.sol";
import {CreateCompany} from "../script/CreateCompany.s.sol";
import {ForkBlocks} from "./ForkBlocks.sol";

contract RecordingDeployWhitechain is DeployWhitechain {
    string public file;

    constructor(string memory file_) {
        file = file_;
    }

    function _recordingEnabled() internal pure override returns (bool) {
        return true;
    }

    function _deploymentsFile() internal view override returns (string memory) {
        return file;
    }
}

/// Runs the real scripts against pinned forks of both chains.
contract DeployTest is Test {

    uint256 pk = uint256(keccak256("tazor deploy test key"));
    address roleCache = makeAddr("roleCache");
    uint256 whitechain;
    uint256 sepolia;

    function setUp() public {
        whitechain = vm.createFork("whitechain_testnet", ForkBlocks.WHITECHAIN_SEPOLIA);
        sepolia = vm.createFork(ForkBlocks.sepoliaRpc(), ForkBlocks.ETH_SEPOLIA);
    }

    function _params() internal view returns (TazorDeployLib.Params memory) {
        return TazorDeployLib.Params({deployer: vm.addr(pk), roleCache: roleCache, l2GasLimit: 400_000});
    }

    function _deployBoth() internal returns (TazorDeployLib.Addresses memory wc, TazorDeployLib.Addresses memory l1) {
        vm.selectFork(whitechain);
        DeployWhitechain dw = new DeployWhitechain();
        TazorDeployLib.Addresses memory predictedWc = dw.predict(_params());
        wc = dw.deploy(pk, _params());

        vm.selectFork(sepolia);
        DeployEnsGate de = new DeployEnsGate();
        TazorDeployLib.Addresses memory predictedL1 = de.predict(_params());
        l1 = de.deploy(pk, _params());

        // predicted == actual, and both chains agree on every address
        assertEq(abi.encode(predictedWc), abi.encode(wc));
        assertEq(abi.encode(predictedL1), abi.encode(l1));
        assertEq(abi.encode(wc), abi.encode(l1));
    }

    function test_deployBothChainsCrossLinked() public {
        (TazorDeployLib.Addresses memory wc, TazorDeployLib.Addresses memory l1) = _deployBoth();

        vm.selectFork(sepolia);
        assertTrue(l1.ensGate.code.length != 0);
        EnsGate gate = EnsGate(l1.ensGate);
        address gateActual = address(gate);

        vm.selectFork(whitechain);
        PaymentModule pm = PaymentModule(wc.paymentModule);
        assertTrue(address(pm).code.length != 0);
        assertEq(pm.ensGateAlias(), AddressAlias.applyL1ToL2Alias(gateActual));
        assertEq(address(pm.roleCache()), roleCache);
        assertEq(address(pm.usdt()), 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7);
        assertEq(address(pm.soulRegistry()), 0x9822650A99bD33F29E383345F570dAE1e4E00928);
        assertEq(address(pm.attributeRegistry()), 0x9822650A99bD33F29E383345F570dAE1e4E00928);
        assertEq(pm.isVerifiedAttribute(), 0xd88fa142B67F561C5f2Cbf803bF5AE906a8f1e41);
        assertEq(TazorAccountFactory(wc.tazorAccountFactory).policyHook(), wc.policyHook);
        assertTrue(wc.policyHook.code.length != 0 && wc.approverAccountFactory.code.length != 0);
        assertEq(address(MandateModule(wc.mandateModule).paymentModule()), wc.paymentModule);
        assertEq(address(MandateModule(wc.mandateModule).usdt()), 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7);

        vm.selectFork(sepolia);
        assertEq(gate.paymentModule(), address(pm));
        assertEq(address(gate.portal()), 0xFF9b597b0781457ae6aa7256Ca5ed5839bF7D0C3);
        assertEq(address(gate.taz0rRegistry()), 0x44007108C0Cca53498F19F259E73E70C2ebE900a);
        assertEq(gate.l2GasLimit(), 400_000);
    }

    function test_rerunIsIdempotent() public {
        (TazorDeployLib.Addresses memory first,) = _deployBoth();
        (TazorDeployLib.Addresses memory second,) = _deployBoth();
        assertEq(abi.encode(first), abi.encode(second));
    }

    function test_addressesDependOnDeployerAndRoleCache() public {
        vm.selectFork(whitechain);
        DeployWhitechain dw = new DeployWhitechain();
        TazorDeployLib.Params memory p = _params();
        TazorDeployLib.Addresses memory base = dw.predict(p);
        p.roleCache = address(0xBEEF);
        TazorDeployLib.Addresses memory otherCache = dw.predict(p);
        assertTrue(otherCache.paymentModule != base.paymentModule);
        assertEq(otherCache.ensGate, base.ensGate);
        p = _params();
        p.deployer = address(0xCAFE);
        TazorDeployLib.Addresses memory otherDeployer = dw.predict(p);
        assertTrue(otherDeployer.ensGate != base.ensGate);
        assertTrue(otherDeployer.paymentModule != base.paymentModule);
        assertEq(otherDeployer.policyHook, base.policyHook);
    }

    function test_ensGateCannotBeFrontRun() public {
        vm.selectFork(whitechain);
        TazorDeployLib.Addresses memory a = new DeployWhitechain().predict(_params());
        vm.selectFork(sepolia);
        DeployEnsGate de = new DeployEnsGate();
        bytes32 salt = bytes32(abi.encodePacked(vm.addr(pk), bytes1(0x00), bytes11(keccak256("tazor.v1.EnsGate"))));
        // Another sender reusing our salt gets a different address (CreateX hashes a foreign-sender salt)
        vm.prank(makeAddr("attacker"));
        (bool ok, bytes memory ret) = 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed.call(
            abi.encodeWithSignature(
                "deployCreate3(bytes32,bytes)",
                salt,
                abi.encodePacked(type(EnsGate).creationCode, abi.encode(address(1), address(2), address(3), uint64(1)))
            )
        );
        assertTrue(ok);
        assertTrue(abi.decode(ret, (address)) != a.ensGate, "attacker cannot land on the predicted address");
        assertEq(a.ensGate.code.length, 0);
        EnsGate gate = EnsGate(de.deploy(pk, _params()).ensGate);
        assertEq(address(gate), a.ensGate);
        assertEq(gate.paymentModule(), a.paymentModule);
    }

    function test_createApproverAndCompany() public {
        (TazorDeployLib.Addresses memory wc,) = _deployBoth();
        vm.selectFork(whitechain);

        CreateApprover ca = new CreateApprover();
        address alice = ca.create(pk, ApproverAccountFactory(wc.approverAccountFactory), makeAddr("alice-backup"));
        address bob = ca.create(pk, ApproverAccountFactory(wc.approverAccountFactory), makeAddr("bob-backup"));
        assertTrue(alice.code.length != 0 && bob.code.length != 0 && alice != bob);
        assertEq(ca.create(pk, ApproverAccountFactory(wc.approverAccountFactory), makeAddr("alice-backup")), alice);

        address[] memory admins = new address[](2);
        admins[0] = alice;
        admins[1] = bob;
        CreateCompany cc = new CreateCompany();
        CreateCompany.Company memory c = CreateCompany.Company({
            admins: admins,
            threshold: 2,
            registry: address(0xE45),
            twoApproverThreshold: 5e6,
            salt: keccak256("acme")
        });
        address account = cc.create(
            pk, TazorAccountFactory(wc.tazorAccountFactory), PaymentModule(wc.paymentModule), MandateModule(address(0)), c
        );

        TazorAccount company = TazorAccount(payable(account));
        assertEq(company.threshold(), 2);
        assertTrue(company.isSigner(abi.encodePacked(alice)) && company.isSigner(abi.encodePacked(bob)));
        assertEq(company.hook(), wc.policyHook);
        PaymentModule.Config memory cfg = PaymentModule(wc.paymentModule).configOf(account);
        assertEq(cfg.registry, address(0xE45));
        assertEq(cfg.twoApproverThreshold, 5e6);
        assertEq(
            cc.create(
                pk, TazorAccountFactory(wc.tazorAccountFactory), PaymentModule(wc.paymentModule), MandateModule(address(0)), c
            ),
            account
        );
        assertFalse(company.isModuleInstalled(MODULE_TYPE_EXECUTOR, wc.mandateModule, ""));

        // with EXECUTORS=payment,mandate
        c.salt = keccak256("acme-mandate");
        address withMandate = cc.create(
            pk,
            TazorAccountFactory(wc.tazorAccountFactory),
            PaymentModule(wc.paymentModule),
            MandateModule(wc.mandateModule),
            c
        );
        assertTrue(TazorAccount(payable(withMandate)).isModuleInstalled(MODULE_TYPE_EXECUTOR, wc.paymentModule, ""));
        assertTrue(TazorAccount(payable(withMandate)).isModuleInstalled(MODULE_TYPE_EXECUTOR, wc.mandateModule, ""));
        assertEq(PaymentModule(wc.paymentModule).registryOf(withMandate), address(0xE45));
    }

    /// Merges into a copy (under the gitignored cache dir) of the current deployments file, minus the keys this
    /// script owns (those differ for the test deployer), and checks every other key is unchanged.
    function test_deploymentsMergeKeepsExistingKeys() public {
        string memory current = vm.readFile(string.concat(vm.projectRoot(), "/deployments/1874.json"));
        string memory dir = string.concat(vm.projectRoot(), "/cache/deploy-test");
        vm.createDir(dir, true);
        string memory file = string.concat(dir, "/1874.json");
        vm.writeFile(file, "{}");
        string[] memory keys = vm.parseJsonKeys(current, "$");
        for (uint256 i; i < keys.length; i++) {
            if (_scriptOwned(keys[i])) continue;
            _copyKey(current, file, keys[i]);
        }
        string memory original = vm.readFile(file);

        TazorDeployLib.Params memory p = _params();
        if (vm.keyExistsJson(original, ".RoleCache")) p.roleCache = vm.parseJsonAddress(original, ".RoleCache");

        vm.selectFork(whitechain);
        RecordingDeployWhitechain dw = new RecordingDeployWhitechain(file);
        TazorDeployLib.Addresses memory a = dw.deploy(pk, p);

        string memory merged = vm.readFile(file);
        keys = vm.parseJsonKeys(original, "$");
        for (uint256 i; i < keys.length; i++) {
            string memory k = string.concat(".", keys[i]);
            assertEq(vm.parseJson(merged, k), vm.parseJson(original, k), keys[i]);
        }
        assertEq(vm.parseJsonAddress(merged, ".PaymentModule"), a.paymentModule);
        assertEq(vm.parseJsonAddress(merged, ".MandateModule"), a.mandateModule);
        assertEq(vm.parseJsonAddress(merged, ".EnsGateAlias"), a.ensGateAlias);
        assertEq(vm.parseJsonAddress(merged, ".TazorAccountFactory"), a.tazorAccountFactory);
        assertEq(vm.parseJsonAddress(merged, ".RoleCache"), p.roleCache);

        // re-running with the same addresses is a no-op; a different value for an existing key aborts
        dw.deploy(pk, p);
        vm.writeJson('"0x0000000000000000000000000000000000000001"', file, ".PolicyHook");
        vm.expectRevert("deployments key differs: PolicyHook");
        dw.deploy(pk, p);
        vm.removeFile(file);
    }

    function _scriptOwned(string memory key) internal pure returns (bool) {
        bytes32 k = keccak256(bytes(key));
        return k == keccak256("PolicyHook") || k == keccak256("ApproverAccountFactory")
            || k == keccak256("WebAuthnVerifier") || k == keccak256("TazorAccountFactory")
            || k == keccak256("PaymentModule") || k == keccak256("RevocationList") || k == keccak256("MandateModule")
            || k == keccak256("EnsGateAlias");
    }

    /// Copies a flat value (address, number or string) from `json` into `file`.
    function _copyKey(string memory json, string memory file, string memory key) internal {
        string memory k = string.concat(".", key);
        try vm.parseJsonAddress(json, k) returns (address a) {
            vm.writeJson(string.concat('"', vm.toString(a), '"'), file, k);
            return;
        } catch {}
        try vm.parseJsonUint(json, k) returns (uint256 u) {
            vm.writeJson(vm.toString(u), file, k);
            return;
        } catch {}
        vm.writeJson(string.concat('"', vm.parseJsonString(json, k), '"'), file, k);
    }
}
