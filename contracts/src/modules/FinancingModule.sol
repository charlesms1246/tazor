// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC7579Execution, IERC7579Module, MODULE_TYPE_EXECUTOR} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {ERC7579Utils, CallType} from "@openzeppelin/contracts/account/utils/draft-ERC7579Utils.sol";
import {IPaymentModuleV2Views} from "../interfaces/IPaymentModuleV2Views.sol";

interface ISoulRegistry {
    function soulOf(address addr) external view returns (uint256);
}

interface ISoulAttributes {
    function soulAttributeValue(uint256 soulId, address attribute) external view returns (bytes20);
}

/// @notice Invoice financing: a buyer company commits (with its approvers) to pay an invoice on its due
/// date. That mints a claim NFT to the supplier's chosen holder. Claims can only be held by WB Soul-verified
/// addresses or Tazor company accounts, can be sold for USDT at a discount, and at maturity anyone can
/// settle: the buyer's account pays the current holder through this executor.
contract FinancingModule is ERC721, EIP712, IERC7579Module {
    using SafeERC20 for IERC20;

    uint256 internal constant ROLE_APPROVER = 1 << 64;
    bytes20 internal constant VERIFIED = bytes20(uint160(1));
    bytes32 public constant FINANCED_INVOICE_TYPEHASH = keccak256(
        "FinancedInvoice(bytes32 invoiceHash,address account,address holder,uint256 amount,uint64 dueDate,uint256 nonce)"
    );

    struct FinancedInvoice {
        bytes32 invoiceHash;
        address account;
        address holder;
        uint256 amount;
        uint64 dueDate;
        uint256 nonce;
    }

    struct Claim {
        address account;
        uint64 dueDate;
        uint256 amount;
    }

    IPaymentModuleV2Views public immutable paymentModule;
    IERC20 public immutable usdt;

    mapping(uint256 tokenId => Claim) public claims;
    mapping(uint256 tokenId => uint256 price) public listings;

    event ClaimCommitted(uint256 indexed tokenId, address indexed account, address indexed holder, uint256 amount, uint64 dueDate);
    event ClaimListed(uint256 indexed tokenId, uint256 price);
    event ClaimSold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price);
    event ClaimSettled(uint256 indexed tokenId, address indexed holder, uint256 amount);

    error FinancingNotEnoughApprovers(uint256 required, uint256 provided);
    error FinancingInvalidApprover(address approver);
    error FinancingDuplicateSoul(uint256 soulId);
    error FinancingInvalidSignature(address approver);
    error FinancingHolderNotAllowed(address holder);
    error FinancingNotDue(uint64 dueDate);
    error FinancingNotListed(uint256 tokenId);
    error FinancingNotHolder(address caller);
    error FinancingBadTerms();
    error FinancingTransferFailed();

    constructor(IPaymentModuleV2Views paymentModule_) ERC721("Tazor Invoice Claim", "TIC") EIP712("Tazor", "2") {
        paymentModule = paymentModule_;
        usdt = IERC20(paymentModule_.usdt());
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_EXECUTOR;
    }

    function onInstall(bytes calldata) external {}

    function onUninstall(bytes calldata) external {}

    function financedDigest(FinancedInvoice calldata f) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(FINANCED_INVOICE_TYPEHASH, f.invoiceHash, f.account, f.holder, f.amount, f.dueDate, f.nonce))
        );
    }

    function isAllowedHolder(address a) public view returns (bool) {
        if (paymentModule.isTazorAccount(a)) return true;
        uint256 soulId = ISoulRegistry(paymentModule.soulRegistry()).soulOf(a);
        return soulId != 0
            && ISoulAttributes(paymentModule.attributeRegistry()).soulAttributeValue(soulId, paymentModule.isVerifiedAttribute()) == VERIFIED;
    }

    /// @notice Buyer approvers commit to pay `amount` on `dueDate` to whoever then holds the claim.
    function commit(FinancedInvoice calldata f, address[] calldata approvers, bytes[] calldata signatures)
        external
        returns (uint256 tokenId)
    {
        require(f.amount > 0 && f.dueDate > block.timestamp && approvers.length == signatures.length, FinancingBadTerms());
        require(isAllowedHolder(f.holder), FinancingHolderNotAllowed(f.holder));
        bytes32 digest = financedDigest(f);
        uint256 required = f.amount > paymentModule.twoApproverThresholdOf(f.account) ? 2 : 1;
        require(approvers.length >= required, FinancingNotEnoughApprovers(required, approvers.length));
        ISoulRegistry souls = ISoulRegistry(paymentModule.soulRegistry());
        uint256[] memory seen = new uint256[](approvers.length);
        for (uint256 i; i < approvers.length; ++i) {
            (uint256 roles, bool valid) = paymentModule.approverStatus(f.account, approvers[i]);
            require(valid && roles & ROLE_APPROVER != 0, FinancingInvalidApprover(approvers[i]));
            uint256 soulId = souls.soulOf(approvers[i]);
            for (uint256 j; j < i; ++j) {
                require(seen[j] != soulId, FinancingDuplicateSoul(soulId));
            }
            seen[i] = soulId;
            require(SignatureChecker.isValidSignatureNow(approvers[i], digest, signatures[i]), FinancingInvalidSignature(approvers[i]));
        }
        tokenId = uint256(digest);
        claims[tokenId] = Claim(f.account, f.dueDate, f.amount);
        _mint(f.holder, tokenId);
        emit ClaimCommitted(tokenId, f.account, f.holder, f.amount, f.dueDate);
    }

    /// @notice The holder offers the claim for `price` USDT (e.g. at a discount to face value).
    function list(uint256 tokenId, uint256 price) external {
        require(ownerOf(tokenId) == msg.sender, FinancingNotHolder(msg.sender));
        listings[tokenId] = price;
        emit ClaimListed(tokenId, price);
    }

    /// @notice A verified financier buys a listed claim; USDT goes straight to the seller.
    function buy(uint256 tokenId) external {
        uint256 price = listings[tokenId];
        require(price != 0, FinancingNotListed(tokenId));
        address seller = ownerOf(tokenId);
        delete listings[tokenId];
        usdt.safeTransferFrom(msg.sender, seller, price);
        _transfer(seller, msg.sender, tokenId);
        emit ClaimSold(tokenId, seller, msg.sender, price);
    }

    /// @notice At or after the due date, anyone can settle: the buyer's account pays the current holder.
    function settle(uint256 tokenId) external {
        Claim memory c = claims[tokenId];
        require(block.timestamp >= c.dueDate, FinancingNotDue(c.dueDate));
        address holder = ownerOf(tokenId);
        delete claims[tokenId];
        delete listings[tokenId];
        _burn(tokenId);
        bytes[] memory results = IERC7579Execution(c.account).executeFromExecutor(
            bytes32(CallType.unwrap(ERC7579Utils.CALLTYPE_SINGLE)),
            abi.encodePacked(address(usdt), uint256(0), abi.encodeCall(IERC20.transfer, (holder, c.amount)))
        );
        require(results[0].length == 0 || abi.decode(results[0], (bool)), FinancingTransferFailed());
        emit ClaimSettled(tokenId, holder, c.amount);
    }

    /// @dev Claims may only move to allowed holders (burns are always allowed).
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        require(to == address(0) || isAllowedHolder(to), FinancingHolderNotAllowed(to));
        return super._update(to, tokenId, auth);
    }
}
