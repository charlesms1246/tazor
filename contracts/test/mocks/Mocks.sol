// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {
    IERC7579Execution,
    IERC7579Validator,
    MODULE_TYPE_EXECUTOR,
    MODULE_TYPE_VALIDATOR
} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {ERC7579Utils, CallType, ExecType} from
    "@openzeppelin/contracts/account/utils/draft-ERC7579Utils.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Tether USD", "USDT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/// Test-only executor: forwards arbitrary executions to an account.
contract MockExecutor {
    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_EXECUTOR;
    }

    function onInstall(bytes calldata) external {}
    function onUninstall(bytes calldata) external {}

    function pay(address account, address token, address to, uint256 amount) external {
        exec(
            account,
            ERC7579Utils.CALLTYPE_SINGLE,
            abi.encodePacked(token, uint256(0), abi.encodeCall(ERC20.transfer, (to, amount)))
        );
    }

    function exec(address account, CallType callType, bytes memory executionCalldata) public {
        IERC7579Execution(account).executeFromExecutor(
            ModeLib.mode(callType), executionCalldata
        );
    }
}

contract MockValidator is IERC7579Validator {
    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_VALIDATOR;
    }

    function onInstall(bytes calldata) external {}
    function onUninstall(bytes calldata) external {}

    function validateUserOp(PackedUserOperation calldata, bytes32) external pure returns (uint256) {
        return 0;
    }

    function isValidSignatureWithSender(address, bytes32, bytes calldata) external pure returns (bytes4) {
        return this.isValidSignatureWithSender.selector;
    }
}

library ModeLib {
    function mode(CallType callType) internal pure returns (bytes32) {
        return bytes32(
            abi.encodePacked(
                CallType.unwrap(callType),
                ExecType.unwrap(ERC7579Utils.EXECTYPE_DEFAULT),
                bytes4(0),
                bytes4(0),
                bytes22(0)
            )
        );
    }
}

contract MockRoleCache {
    mapping(address registry => mapping(address account => uint256)) public roles;

    function setRoles(address registry, address account, uint256 roles_) external {
        roles[registry][account] = roles_;
    }

    function rolesOf(address registry, address account) external view returns (uint256, uint64) {
        return (roles[registry][account], uint64(block.number));
    }
}

/// Role cache with an explicit proof block per entry (for the fresh-proof rule).
contract MockRoleCacheV2 {
    struct Entry {
        uint256 roles;
        uint64 l1Block;
    }

    mapping(address registry => mapping(address account => Entry)) public entries;

    function setRoles(address registry, address account, uint256 roles, uint64 l1Block) external {
        entries[registry][account] = Entry(roles, l1Block);
    }

    function rolesOf(address registry, address account) external view returns (uint256, uint64) {
        Entry memory e = entries[registry][account];
        return (e.roles, e.l1Block);
    }
}

/// Stand-in for the OP Stack L1Block predeploy when there is no fork.
contract MockL1Block {
    uint64 public number;

    function setNumber(uint64 n) external {
        number = n;
    }
}
