// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {WBSoulMirror} from "./WBSoulMirror.sol";

/// @notice Least-privilege owner of the SIMULATED WB Soul mirror (testnet only).
/// It becomes the mirror's owner. Whitelisted operator keys (the hosted demo's sandbox operator) can only register a NEW
/// soul for an unused address (at most `dailyCap` per UTC day) and mark a soul THIS CONTRACT registered as verified.
/// They cannot revoke, reassign, change a primary address, or touch any other soul's attributes.
/// The owner (the deployer, who owned the mirror before) can forward any mirror call and take the mirror back.
contract MirrorOperator is Ownable {
    address public constant IS_VERIFIED = 0xd88fa142B67F561C5f2Cbf803bF5AE906a8f1e41;
    bytes20 public constant VERIFIED = bytes20(uint160(1));

    WBSoulMirror public immutable mirror;
    uint256 public dailyCap;
    mapping(address operator => bool) public isOperator;
    mapping(uint256 day => uint256 count) public verifiedOnDay;
    /// @notice Souls registered through this contract: the only ones an operator may mark verified.
    mapping(uint256 soulId => bool) public registeredHere;

    event OperatorSet(address indexed operator, bool allowed);
    event DailyCapSet(uint256 cap);
    event SoulVerified(uint256 indexed soulId, address indexed addr, address indexed operator);
    event Executed(bytes data, bytes result);

    error NotOperator(address caller);
    error NotRegisteredHere(uint256 soulId);
    error SoulExists(address addr, uint256 soulId);
    error DailyCapReached(uint256 day, uint256 cap);
    error ExecuteFailed(bytes reason);

    constructor(WBSoulMirror mirror_, address owner_, uint256 dailyCap_) Ownable(owner_) {
        mirror = mirror_;
        dailyCap = dailyCap_;
        emit DailyCapSet(dailyCap_);
    }

    // ---- operator: the only thing a hot key can do

    /// @notice Registers a NEW soul for `account` (counts toward the daily cap) and returns its id. If `account` already
    /// has a soul that this contract registered, it is a no-op returning that id (so a retry is safe); any other used
    /// address reverts, so an operator can never act on someone else's soul.
    function registerSoul(address account) public returns (uint256 soulId) {
        _onlyOperator();
        soulId = mirror.soulOf(account);
        if (soulId != 0) {
            if (!registeredHere[soulId]) revert SoulExists(account, soulId);
            return soulId;
        }
        uint256 day = block.timestamp / 1 days;
        if (verifiedOnDay[day] >= dailyCap) revert DailyCapReached(day, dailyCap);
        verifiedOnDay[day]++;
        mirror.registerSoul(account); // also reverts for a revoked (still "used") address
        soulId = mirror.soulOf(account);
        registeredHere[soulId] = true;
    }

    /// @notice Marks a soul verified (IsVerified = bytes20(1)); only souls registered through this contract.
    /// A soul that is already verified is left as it is.
    function setVerified(uint256 soulId) public {
        _onlyOperator();
        if (!registeredHere[soulId]) revert NotRegisteredHere(soulId);
        if (mirror.soulAttributeValue(soulId, IS_VERIFIED) == VERIFIED) return;
        mirror.setAttribute(soulId, IS_VERIFIED, VERIFIED);
        emit SoulVerified(soulId, mirror.soulPrimaryAddress(soulId), msg.sender);
    }

    /// @notice registerSoul + setVerified in one call.
    function registerVerified(address account) external returns (uint256 soulId) {
        soulId = registerSoul(account);
        setVerified(soulId);
    }

    function _onlyOperator() internal view {
        if (!isOperator[msg.sender]) revert NotOperator(msg.sender);
    }

    /// @notice How many more souls the operators may verify today.
    function remainingToday() external view returns (uint256) {
        uint256 used = verifiedOnDay[block.timestamp / 1 days];
        return used >= dailyCap ? 0 : dailyCap - used;
    }

    // ---- owner

    function setOperator(address operator, bool allowed) external onlyOwner {
        isOperator[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function setDailyCap(uint256 cap) external onlyOwner {
        dailyCap = cap;
        emit DailyCapSet(cap);
    }

    /// @notice Forwards any call to the mirror (revoke, assign, attributes…), as the previous owner could.
    function execute(bytes calldata data) external onlyOwner returns (bytes memory result) {
        bool ok;
        (ok, result) = address(mirror).call(data);
        if (!ok) revert ExecuteFailed(result);
        emit Executed(data, result);
    }

    /// @notice Hands the mirror's ownership back (to the deployer, or to WhiteBIT's real registry owner one day).
    function transferMirrorOwnership(address newOwner) external onlyOwner {
        mirror.transferOwnership(newOwner);
    }
}
