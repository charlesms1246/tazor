// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AddressAlias} from "../src/libraries/AddressAlias.sol";
import {TazorAccountFactory} from "../src/account/TazorAccountFactory.sol";
import {TazorAccount} from "../src/account/TazorAccount.sol";
import {PaymentModuleV2} from "../src/modules/PaymentModuleV2.sol";
import {MandateModuleV2} from "../src/modules/MandateModuleV2.sol";
import {EnsGate} from "../src/l1/EnsGate.sol";
import {MODULE_TYPE_EXECUTOR} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {TazorDeployLib} from "../script/TazorDeployLib.sol";
import {TazorDeployLibV2} from "../script/TazorDeployLibV2.sol";
import {DeployWhitechain} from "../script/DeployWhitechain.s.sol";
import {DeployEnsGate} from "../script/DeployEnsGate.s.sol";
import {DeployWhitechainV2} from "../script/DeployWhitechainV2.s.sol";
import {DeployEnsGateV2} from "../script/DeployEnsGateV2.s.sol";
import {CreateApprover} from "../script/CreateApprover.s.sol";
import {CreateCompany} from "../script/CreateCompany.s.sol";
import {ApproverAccountFactory} from "../src/account/ApproverAccountFactory.sol";
import {MockExecutor} from "./mocks/Mocks.sol";
import {ForkBlocks} from "./ForkBlocks.sol";

contract RecordingDeployEnsGateV2 is DeployEnsGateV2 {
    function _recordingEnabled() internal pure override returns (bool) {
        return true;
    }

    function _deploymentsFile() internal pure override returns (string memory) {
        return "/nonexistent";
    }
}

contract DeployV2Test is Test {
    uint256 pk = uint256(keccak256("tazor deploy test key"));
    uint256 whitechain;
    uint256 sepolia;

    function setUp() public {
        whitechain = vm.createFork("whitechain_testnet", ForkBlocks.WHITECHAIN_SEPOLIA);
        sepolia = vm.createFork(ForkBlocks.sepoliaRpc(), ForkBlocks.ETH_SEPOLIA);
    }

    function _params() internal view returns (TazorDeployLib.Params memory) {
        return TazorDeployLib.Params({
            deployer: vm.addr(pk), roleCache: 0x8AC436e5BB681aE4d576e0131391aE3AACA88BDe, l2GasLimit: 400_000
        });
    }

    function _deployAll()
        internal
        returns (TazorDeployLib.Addresses memory v1, TazorDeployLibV2.AddressesV2 memory wc, TazorDeployLibV2.AddressesV2 memory l1)
    {
        vm.selectFork(whitechain);
        v1 = new DeployWhitechain().deploy(pk, _params());
        DeployWhitechainV2 dw = new DeployWhitechainV2();
        TazorDeployLibV2.AddressesV2 memory predicted = dw.predictV2(_params());
        wc = dw.deploy(pk, _params());
        assertEq(abi.encode(predicted), abi.encode(wc), "Whitechain predicted == actual");

        vm.selectFork(sepolia);
        new DeployEnsGate().deploy(pk, _params());
        DeployEnsGateV2 de = new DeployEnsGateV2();
        predicted = de.predictV2(_params());
        l1 = de.deploy(pk, _params());
        assertEq(abi.encode(predicted), abi.encode(l1), "Sepolia predicted == actual");
        assertEq(abi.encode(wc), abi.encode(l1), "both chains agree");
    }

    function test_v2CrossLinkedAlongsideV1() public {
        (TazorDeployLib.Addresses memory v1, TazorDeployLibV2.AddressesV2 memory wc,) = _deployAll();

        vm.selectFork(sepolia);
        EnsGate gate = EnsGate(wc.ensGateV2);
        assertTrue(address(gate).code.length != 0);
        assertEq(gate.paymentModule(), wc.paymentModuleV2);
        assertEq(gate.l2GasLimit(), 400_000);
        assertTrue(wc.ensGateV2 != v1.ensGate, "v2 gate is a new address");
        assertEq(EnsGate(v1.ensGate).paymentModule(), v1.paymentModule, "v1 gate unchanged");

        vm.selectFork(whitechain);
        PaymentModuleV2 pm = PaymentModuleV2(wc.paymentModuleV2);
        assertEq(pm.ensGateAlias(), AddressAlias.applyL1ToL2Alias(address(gate)));
        assertEq(pm.tazorAccountCodeHash(), keccak256(abi.encodePacked(
            hex"363d3d373d3d3d363d73", TazorAccountFactory(v1.tazorAccountFactory).implementation(), hex"5af43d82803e903d91602b57fd5bf3"
        )));
        assertEq(address(MandateModuleV2(wc.mandateModuleV2).paymentModule()), wc.paymentModuleV2);
        assertTrue(wc.paymentModuleV2 != v1.paymentModule);
    }

    function test_v2RerunIsIdempotent() public {
        (, TazorDeployLibV2.AddressesV2 memory first,) = _deployAll();
        (, TazorDeployLibV2.AddressesV2 memory second,) = _deployAll();
        assertEq(abi.encode(first), abi.encode(second));
    }

    function test_createV2CompanyWithThreeExecutors() public {
        (TazorDeployLib.Addresses memory v1, TazorDeployLibV2.AddressesV2 memory wc,) = _deployAll();
        vm.selectFork(whitechain);
        address admin = new CreateApprover().create(pk, ApproverAccountFactory(v1.approverAccountFactory), makeAddr("admin-backup"));
        address financing = address(new MockExecutor());
        address[] memory admins = new address[](1);
        admins[0] = admin;
        address[] memory exits = new address[](1);
        exits[0] = makeAddr("treasury");
        PaymentModuleV2.ConfigV2 memory cfg = PaymentModuleV2.ConfigV2(
            address(0xE45), 5e6, 8e6, 20e6, 1 days, 3e6, 300, 3e6, exits, 7 days
        );
        CreateCompany cc = new CreateCompany();
        address account = cc.createV2(
            pk,
            TazorAccountFactory(v1.tazorAccountFactory),
            CreateCompany.Modules(PaymentModuleV2(wc.paymentModuleV2), wc.mandateModuleV2, financing),
            admins,
            1,
            cfg,
            keccak256("acme-v2")
        );
        TazorAccount company = TazorAccount(payable(account));
        assertTrue(company.isModuleInstalled(MODULE_TYPE_EXECUTOR, wc.paymentModuleV2, ""));
        assertTrue(company.isModuleInstalled(MODULE_TYPE_EXECUTOR, wc.mandateModuleV2, ""));
        assertTrue(company.isModuleInstalled(MODULE_TYPE_EXECUTOR, financing, ""));
        PaymentModuleV2 pm = PaymentModuleV2(wc.paymentModuleV2);
        assertTrue(pm.isTazorAccount(account), "the live factory's clones are recognised");
        PaymentModuleV2.ConfigV2 memory stored = pm.configV2Of(account);
        assertEq(stored.monthlyLimit, 20e6);
        assertEq(stored.exitAccounts[0], exits[0]);
        assertEq(stored.maxCacheAge, 300);
    }

    /// With WRITE_DEPLOYMENTS, the EnsGate v2 script must not record a gate it only simulated.
    function test_ensGateV2RecordingRequiresExistingCode() public {
        vm.selectFork(sepolia);
        RecordingDeployEnsGateV2 de = new RecordingDeployEnsGateV2();
        assertEq(de.predictV2(_params()).ensGateV2.code.length, 0);
        vm.expectRevert(bytes("deploy first via CreateX"));
        de.deploy(pk, _params());
    }
}
