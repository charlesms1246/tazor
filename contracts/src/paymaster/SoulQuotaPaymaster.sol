// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IEntryPoint, IPaymaster, PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/draft-ERC4337Utils.sol";
import {IWBSoulAttributeRegistry, IWBSoulRegistry} from "../interfaces/IWBSoul.sol";

/// @notice ERC-4337 (EntryPoint v0.8) paymaster that sponsors userOps from Tazor ApproverAccounts bound to a
/// WhiteBIT-verified WB Soul, within a per-soul quota over fixed 24 h windows: at most `maxOpsPerWindow`
/// operations and `maxCostPerWindow` wei of gas per soul. Many accounts bound to one soul share that soul's quota.
/// The paymaster holds no user funds. The owner can only withdraw or stake the paymaster's own EntryPoint deposit.
contract SoulQuotaPaymaster is IPaymaster, Ownable {
    bytes20 private constant VERIFIED = bytes20(uint160(1));
    uint256 public constant WINDOW = 1 days;

    IEntryPoint public immutable entryPoint;
    IWBSoulRegistry public immutable soulRegistry;
    IWBSoulAttributeRegistry public immutable attributeRegistry;
    address public immutable isVerifiedAttribute;
    /// @dev Senders must be EIP-1167 clones of this ApproverAccount implementation.
    address public immutable approverImplementation;
    uint256 public immutable maxOpsPerWindow;
    uint256 public immutable maxCostPerWindow;

    struct Usage {
        uint64 window;
        uint64 ops;
        uint128 cost;
    }

    mapping(uint256 soulId => Usage) private _usage;

    event Sponsored(uint256 indexed soulId, address indexed sender, uint256 actualGasCost);

    error PaymasterNotEntryPoint(address caller);
    error PaymasterNotApproverAccount(address sender);
    error PaymasterNotVerified(address sender);
    error PaymasterQuotaExceeded(uint256 soulId, uint256 ops, uint256 cost);

    constructor(
        IEntryPoint entryPoint_,
        IWBSoulRegistry soulRegistry_,
        IWBSoulAttributeRegistry attributeRegistry_,
        address isVerifiedAttribute_,
        address approverImplementation_,
        uint256 maxOpsPerWindow_,
        uint256 maxCostPerWindow_,
        address owner_
    ) Ownable(owner_) {
        entryPoint = entryPoint_;
        soulRegistry = soulRegistry_;
        attributeRegistry = attributeRegistry_;
        isVerifiedAttribute = isVerifiedAttribute_;
        approverImplementation = approverImplementation_;
        maxOpsPerWindow = maxOpsPerWindow_;
        maxCostPerWindow = maxCostPerWindow_;
    }

    modifier onlyEntryPoint() {
        require(msg.sender == address(entryPoint), PaymasterNotEntryPoint(msg.sender));
        _;
    }

    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256 maxCost)
        external
        onlyEntryPoint
        returns (bytes memory context, uint256 validationData)
    {
        address sender = userOp.sender;
        require(isApproverAccount(sender), PaymasterNotApproverAccount(sender));
        uint256 soulId = verifiedSoulOf(sender);
        require(soulId != 0, PaymasterNotVerified(sender));

        uint64 window = uint64(block.timestamp / WINDOW);
        Usage memory u = _usage[soulId];
        if (u.window != window) u = Usage(window, 0, 0);
        uint256 ops = uint256(u.ops) + 1;
        uint256 cost = uint256(u.cost) + maxCost;
        require(ops <= maxOpsPerWindow && cost <= maxCostPerWindow, PaymasterQuotaExceeded(soulId, ops, cost));
        _usage[soulId] = Usage(window, uint64(ops), uint128(cost));

        context = abi.encode(soulId, window, maxCost, sender);
        validationData = ERC4337Utils.packValidationData(true, 0, uint48((uint256(window) + 1) * WINDOW - 1));
    }

    /// @dev Refunds the unused part of the reserved `maxCost` to the soul's quota.
    function postOp(PostOpMode, bytes calldata context, uint256 actualGasCost, uint256) external onlyEntryPoint {
        (uint256 soulId, uint64 window, uint256 maxCost, address sender) = abi.decode(context, (uint256, uint64, uint256, address));
        Usage storage u = _usage[soulId];
        if (u.window == window && actualGasCost < maxCost) u.cost -= uint128(maxCost - actualGasCost);
        emit Sponsored(soulId, sender, actualGasCost);
    }

    function isApproverAccount(address account) public view returns (bool) {
        return keccak256(account.code)
            == keccak256(abi.encodePacked(hex"363d3d373d3d3d363d73", approverImplementation, hex"5af43d82803e903d91602b57fd5bf3"));
    }

    function verifiedSoulOf(address account) public view returns (uint256 soulId) {
        soulId = soulRegistry.soulOf(account);
        if (soulId != 0 && attributeRegistry.soulAttributeValue(soulId, isVerifiedAttribute) != VERIFIED) soulId = 0;
    }

    /// @notice Remaining sponsored operations and gas budget (wei) for a soul in the current window.
    function remaining(uint256 soulId) external view returns (uint256 ops, uint256 cost) {
        Usage memory u = _usage[soulId];
        if (u.window != uint64(block.timestamp / WINDOW)) return (maxOpsPerWindow, maxCostPerWindow);
        return (maxOpsPerWindow - u.ops, maxCostPerWindow - u.cost);
    }

    function deposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    function withdrawTo(address payable to, uint256 amount) external onlyOwner {
        entryPoint.withdrawTo(to, amount);
    }

    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        entryPoint.addStake{value: msg.value}(unstakeDelaySec);
    }

    function unlockStake() external onlyOwner {
        entryPoint.unlockStake();
    }

    function withdrawStake(address payable to) external onlyOwner {
        entryPoint.withdrawStake(to);
    }
}
