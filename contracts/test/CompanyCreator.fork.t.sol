// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {CompanyCreator, IVerifiableFactory, IEnsV2Registry} from "../src/ens/CompanyCreator.sol";
import {ForkBlocks} from "./ForkBlocks.sol";

interface IRegistryView {
    function roles(uint256 resource, address account) external view returns (uint256);
    function getSubregistry(string calldata label) external view returns (address);
    function getParent() external view returns (address, string memory);
    function findOwner(string calldata label) external view returns (address);
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
}

contract CompanyCreatorForkTest is Test {
    address constant FACTORY = 0xDa70306C98E97eCe36F997a21368e53298572991;
    address constant IMPL = 0x9BD8a88719068D09ecee662f36C0E3856708366a;
    address constant TAZ0R = 0x44007108C0Cca53498F19F259E73E70C2ebE900a;
    address constant RESOLVER = 0x9a268461Cd084FD5F973C465E3E0131Aa02AB673;
    address constant OWNER = 0xce4389ACb79463062c362fACB8CB04513fA3D8D8;
    uint256 constant ROLE_REGISTRAR = 1;
    uint256 constant ROLE_APPROVER = 1 << 64;

    CompanyCreator creator;

    function setUp() public {
        vm.createSelectFork(ForkBlocks.sepoliaRpc(), ForkBlocks.ETH_SEPOLIA);
        creator = new CompanyCreator(IVerifiableFactory(FACTORY), IMPL, IEnsV2Registry(TAZ0R), RESOLVER, OWNER);
        vm.prank(OWNER);
        IRegistryView(TAZ0R).grantRootRoles(ROLE_REGISTRAR, address(creator));
    }

    function test_createsCompanyInOneTransaction() public {
        address admin = makeAddr("admin");
        address[] memory approvers = new address[](2);
        approvers[0] = makeAddr("priya");
        approvers[1] = makeAddr("cfo");
        vm.prank(OWNER);
        uint256 g = gasleft();
        address registry = creator.createCompany("onetx-co", admin, approvers, 1888629000);
        console2.log("createCompany gas", g - gasleft());

        assertEq(IRegistryView(TAZ0R).getSubregistry("onetx-co"), registry);
        assertEq(IRegistryView(TAZ0R).findOwner("onetx-co"), admin);
        (address p, string memory l) = IRegistryView(registry).getParent();
        assertEq(p, TAZ0R);
        assertEq(l, "onetx-co");
        assertEq(IRegistryView(registry).roles(0, admin), creator.COMPANY_ADMIN_ROLES());
        assertEq(IRegistryView(registry).roles(0, approvers[0]), ROLE_APPROVER);
        assertEq(IRegistryView(registry).roles(0, approvers[1]), ROLE_APPROVER);
        assertEq(IRegistryView(registry).roles(0, address(creator)), 0, "creator keeps no roles");
    }

    function test_onlyOperator() public {
        vm.expectRevert(CompanyCreator.CompanyCreatorNotOperator.selector);
        creator.createCompany("x-co", address(1), new address[](0), 1888629000);
    }

    function test_adminCanManageApproversAfterwards() public {
        address admin = makeAddr("admin");
        vm.prank(OWNER);
        address registry = creator.createCompany("onetx-co2", admin, new address[](0), 1888629000);
        vm.prank(admin);
        IRegistryView(registry).grantRootRoles(ROLE_APPROVER, makeAddr("later"));
        assertEq(IRegistryView(registry).roles(0, makeAddr("later")), ROLE_APPROVER);
    }
}
