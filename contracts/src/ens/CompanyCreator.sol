// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IVerifiableFactory {
    function deployProxy(address implementation, uint256 salt, bytes calldata data) external returns (address);
}

interface IEnsV2Registry {
    function register(string calldata label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry)
        external
        returns (uint256);
    function setParent(address parent, string calldata label) external;
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);
}

/// @notice Creates a Tazor company under taz0r.eth in one transaction: deploys the company's ENSv2
/// UserRegistry, registers `<label>.taz0r.eth` pointing at it, sets its parent, grants the initial
/// approvers, then drops its own temporary roles on the new registry.
contract CompanyCreator {
    struct Grant {
        address account;
        uint256 roleBitmap;
    }

    uint256 internal constant ROLE_SET_PARENT = 1 << 8;
    uint256 internal constant ROLE_APPROVER = 1 << 64;
    /// Root roles for the company admin: built-in registry roles (no UPGRADE) plus Tazor role admins.
    uint256 public constant COMPANY_ADMIN_ROLES = 0x100000000000111000000101111111101000000000000100000001001111111;
    /// Token roles on the company name: resolver and URI only, so the registry link stays fixed.
    uint256 public constant COMPANY_NAME_ROLES = 0x101100000000000000000000000000001001000000;
    /// Temporary roles this contract needs on the new registry.
    uint256 internal constant CREATOR_ROLES = ROLE_SET_PARENT | (ROLE_SET_PARENT << 128) | (ROLE_APPROVER << 128);

    IVerifiableFactory public immutable factory;
    address public immutable implementation;
    IEnsV2Registry public immutable parent;
    address public immutable resolver;
    address public immutable operator;

    event CompanyCreated(string label, address indexed registry, address indexed admin, uint256 approvers);

    error CompanyCreatorNotOperator();

    constructor(IVerifiableFactory factory_, address implementation_, IEnsV2Registry parent_, address resolver_, address operator_) {
        factory = factory_;
        implementation = implementation_;
        parent = parent_;
        resolver = resolver_;
        operator = operator_;
    }

    function createCompany(string calldata label, address admin, address[] calldata approvers, uint64 expiry)
        external
        returns (address registry)
    {
        require(msg.sender == operator, CompanyCreatorNotOperator());
        Grant[] memory grants = new Grant[](2);
        grants[0] = Grant(admin, COMPANY_ADMIN_ROLES);
        grants[1] = Grant(address(this), CREATOR_ROLES);
        registry = factory.deployProxy(
            implementation,
            uint256(keccak256(abi.encodePacked("taz0r.eth/company/", label))),
            abi.encodeWithSignature("initialize((address,uint256)[])", grants)
        );
        parent.register(label, admin, registry, resolver, COMPANY_NAME_ROLES, expiry);
        IEnsV2Registry(registry).setParent(address(parent), label);
        for (uint256 i; i < approvers.length; ++i) {
            IEnsV2Registry(registry).grantRootRoles(ROLE_APPROVER, approvers[i]);
        }
        IEnsV2Registry(registry).revokeRootRoles(CREATOR_ROLES, address(this));
        emit CompanyCreated(label, registry, admin, approvers.length);
    }
}
