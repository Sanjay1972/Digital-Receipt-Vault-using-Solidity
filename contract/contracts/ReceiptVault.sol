// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract ReceiptVault {
    struct Receipt {
        string cid;
        bytes32 receiptHash;
        bytes32 batchRoot;
        address issuer;
        address owner;
        uint256 issuedAt;
        uint256 claimedAt;
        uint256 transferCount;
    }

    struct IssuerProfile {
        bool registered;
        string companyName;
        uint256 registeredAt;
        uint256 batchCount;
    }

    address public immutable admin;

    mapping(address => IssuerProfile) private issuers;
    mapping(address => mapping(bytes32 => bool)) public issuerRoots;
    mapping(address => bytes32[]) private issuerRootHistory;
    mapping(bytes32 => Receipt) private receiptsById;
    mapping(bytes32 => bytes32) private receiptIdByLeaf;
    mapping(bytes32 => bytes32) private receiptIdByCidHash;
    mapping(address => bytes32[]) private ownerReceiptIds;
    mapping(bytes32 => uint256) private ownerReceiptIndex;

    event IssuerRegistered(
        address indexed issuer,
        string companyName,
        uint256 registeredAt
    );
    event BatchRootPublished(
        address indexed issuer,
        bytes32 indexed batchRoot,
        string batchId,
        uint256 leafCount,
        uint256 publishedAt
    );
    event ReceiptClaimed(
        bytes32 indexed receiptId,
        bytes32 indexed leaf,
        address indexed owner,
        address issuer,
        bytes32 batchRoot
    );
    event ReceiptTransferred(
        bytes32 indexed receiptId,
        address indexed from,
        address indexed to,
        uint256 transferCount
    );

    modifier onlyAdmin() {
        require(msg.sender == admin, "Admin only");
        _;
    }

    modifier onlyRegisteredIssuer() {
        require(issuers[msg.sender].registered, "Issuer not registered");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    function registerIssuer(
        address issuer,
        string calldata companyName
    ) external onlyAdmin {
        require(issuer != address(0), "Invalid issuer");
        require(bytes(companyName).length != 0, "Company name required");

        IssuerProfile storage profile = issuers[issuer];
        profile.registered = true;
        profile.companyName = companyName;
        if (profile.registeredAt == 0) {
            profile.registeredAt = block.timestamp;
        }

        emit IssuerRegistered(issuer, companyName, profile.registeredAt);
    }

    function publishBatchRoot(
        bytes32 batchRoot,
        string calldata batchId,
        uint256 leafCount
    ) external onlyRegisteredIssuer {
        require(batchRoot != bytes32(0), "Invalid root");
        require(!issuerRoots[msg.sender][batchRoot], "Root already published");
        require(leafCount != 0, "Empty batch");

        issuerRoots[msg.sender][batchRoot] = true;
        issuerRootHistory[msg.sender].push(batchRoot);
        issuers[msg.sender].batchCount += 1;

        emit BatchRootPublished(
            msg.sender,
            batchRoot,
            batchId,
            leafCount,
            block.timestamp
        );
    }

    function claimReceipt(
        address claimant,
        string calldata cid,
        bytes32 receiptHash,
        uint256 issuedAt,
        address issuer,
        bytes32 batchRoot,
        bytes32[] calldata merkleProof
    ) external {
        require(claimant != address(0), "Invalid claimant");
        require(issuers[issuer].registered, "Issuer not registered");
        require(issuerRoots[issuer][batchRoot], "Unknown batch root");

        bytes32 leaf = computeLeaf(cid, receiptHash, issuer, issuedAt);
        require(_verifyProof(merkleProof, batchRoot, leaf), "Invalid proof");
        require(receiptIdByLeaf[leaf] == bytes32(0), "Receipt already claimed");

        bytes32 receiptId = keccak256(abi.encodePacked(leaf, claimant));
        require(receiptIdByCidHash[keccak256(bytes(cid))] == bytes32(0), "CID already claimed");

        receiptsById[receiptId] = Receipt({
            cid: cid,
            receiptHash: receiptHash,
            batchRoot: batchRoot,
            issuer: issuer,
            owner: claimant,
            issuedAt: issuedAt,
            claimedAt: block.timestamp,
            transferCount: 0
        });

        receiptIdByLeaf[leaf] = receiptId;
        receiptIdByCidHash[keccak256(bytes(cid))] = receiptId;
        _addReceiptToOwner(claimant, receiptId);

        emit ReceiptClaimed(receiptId, leaf, claimant, issuer, batchRoot);
    }

    function transferReceipt(bytes32 receiptId, address newOwner) external {
        require(newOwner != address(0), "Invalid new owner");

        Receipt storage receipt = receiptsById[receiptId];
        require(receipt.owner != address(0), "Receipt not found");
        require(receipt.owner == msg.sender, "Not receipt owner");
        require(receipt.owner != newOwner, "Already owned");

        address previousOwner = receipt.owner;
        _removeReceiptFromOwner(previousOwner, receiptId);
        receipt.owner = newOwner;
        receipt.transferCount += 1;
        _addReceiptToOwner(newOwner, receiptId);

        emit ReceiptTransferred(
            receiptId,
            previousOwner,
            newOwner,
            receipt.transferCount
        );
    }

    function isIssuerRegistered(address issuer) external view returns (bool) {
        return issuers[issuer].registered;
    }

    function getIssuerProfile(
        address issuer
    )
        external
        view
        returns (
            bool registered,
            string memory companyName,
            uint256 registeredAt,
            uint256 batchCount
        )
    {
        IssuerProfile memory profile = issuers[issuer];
        return (
            profile.registered,
            profile.companyName,
            profile.registeredAt,
            profile.batchCount
        );
    }

    function getIssuerRoots(
        address issuer
    ) external view returns (bytes32[] memory) {
        return issuerRootHistory[issuer];
    }

    function getMyReceipts() external view returns (Receipt[] memory) {
        return _getReceiptsForOwner(msg.sender);
    }

    function getMyReceiptIds() external view returns (bytes32[] memory) {
        return ownerReceiptIds[msg.sender];
    }

    function getReceiptsOf(
        address owner
    ) external view returns (Receipt[] memory) {
        return _getReceiptsForOwner(owner);
    }

    function getReceiptIdsOf(
        address owner
    ) external view returns (bytes32[] memory) {
        return ownerReceiptIds[owner];
    }

    function getReceiptById(
        bytes32 receiptId
    ) external view returns (Receipt memory) {
        return receiptsById[receiptId];
    }

    function verifyByCID(
        string calldata cid
    )
        external
        view
        returns (
            bool valid,
            address issuer,
            address owner,
            uint256 issuedAt,
            uint256 claimedAt,
            uint256 transferCount,
            bytes32 batchRoot
        )
    {
        bytes32 receiptId = receiptIdByCidHash[keccak256(bytes(cid))];
        if (receiptId == bytes32(0)) {
            return (false, address(0), address(0), 0, 0, 0, bytes32(0));
        }

        Receipt memory receipt = receiptsById[receiptId];
        return (
            receipt.owner != address(0),
            receipt.issuer,
            receipt.owner,
            receipt.issuedAt,
            receipt.claimedAt,
            receipt.transferCount,
            receipt.batchRoot
        );
    }

    function computeLeaf(
        string memory cid,
        bytes32 receiptHash,
        address issuer,
        uint256 issuedAt
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(cid, receiptHash, issuer, issuedAt));
    }

    function _getReceiptsForOwner(
        address owner
    ) internal view returns (Receipt[] memory) {
        bytes32[] memory ids = ownerReceiptIds[owner];
        Receipt[] memory items = new Receipt[](ids.length);

        for (uint256 i = 0; i < ids.length; i++) {
            items[i] = receiptsById[ids[i]];
        }

        return items;
    }

    function _addReceiptToOwner(address owner, bytes32 receiptId) internal {
        ownerReceiptIndex[receiptId] = ownerReceiptIds[owner].length;
        ownerReceiptIds[owner].push(receiptId);
    }

    function _removeReceiptFromOwner(address owner, bytes32 receiptId) internal {
        uint256 index = ownerReceiptIndex[receiptId];
        uint256 lastIndex = ownerReceiptIds[owner].length - 1;

        if (index != lastIndex) {
            bytes32 swappedId = ownerReceiptIds[owner][lastIndex];
            ownerReceiptIds[owner][index] = swappedId;
            ownerReceiptIndex[swappedId] = index;
        }

        ownerReceiptIds[owner].pop();
        delete ownerReceiptIndex[receiptId];
    }

    function _verifyProof(
        bytes32[] calldata proof,
        bytes32 root,
        bytes32 leaf
    ) internal pure returns (bool) {
        bytes32 computedHash = leaf;

        for (uint256 i = 0; i < proof.length; i++) {
            computedHash = _hashPair(computedHash, proof[i]);
        }

        return computedHash == root;
    }

    function _hashPair(
        bytes32 a,
        bytes32 b
    ) internal pure returns (bytes32) {
        return a < b
            ? keccak256(abi.encodePacked(a, b))
            : keccak256(abi.encodePacked(b, a));
    }
}
