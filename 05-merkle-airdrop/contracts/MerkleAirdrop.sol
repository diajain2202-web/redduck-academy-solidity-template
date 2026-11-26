// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Merkle airdrop with two independent claim paths: a Merkle proof (your address
// is on the list committed to by `merkleRoot`) or a signature from the trusted
// `signer`. The two paths share `hasClaimed`.
contract MerkleAirdrop {
    uint256 private constant SECP256K1_N_DIV_2 =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    IERC20 public immutable token;
    bytes32 public immutable merkleRoot;
    address public immutable signer;

    mapping(address => bool) public hasClaimed;

    error AlreadyClaimed();
    error InvalidProof();
    error InvalidSignature();
    error TransferFailed();

    event Claimed(address indexed account, uint256 amount);

    constructor(IERC20 _token, bytes32 _merkleRoot, address _signer) {
        token = _token;
        merkleRoot = _merkleRoot;
        signer = _signer;
    }

    function claim(uint256 amount, bytes32[] calldata proof) external {
        if (hasClaimed[msg.sender]) revert AlreadyClaimed();

        // Double-hash the packed (account, amount) leaf to prevent second-preimage attacks.
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encodePacked(msg.sender, amount))));
        if (!_verify(proof, leaf)) revert InvalidProof();

        hasClaimed[msg.sender] = true;

        bool ok = token.transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();

        emit Claimed(msg.sender, amount);
    }

    function claimWithSignature(uint256 amount, uint8 v, bytes32 r, bytes32 s) external {
        if (hasClaimed[msg.sender]) revert AlreadyClaimed();

        // Enforce canonical signature values (EIP-2 lower-s and v in {27, 28}).
        if (v != 27 && v != 28) revert InvalidSignature();
        if (uint256(s) > SECP256K1_N_DIV_2) revert InvalidSignature();

        // Bind the signature to this exact contract instance, recipient, and amount.
        bytes32 messageHash = keccak256(abi.encodePacked(address(this), msg.sender, amount));
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );

        address recovered = ecrecover(ethSignedMessageHash, v, r, s);
        if (recovered == address(0) || recovered != signer) revert InvalidSignature();

        hasClaimed[msg.sender] = true;

        bool ok = token.transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();

        emit Claimed(msg.sender, amount);
    }

    // Verify that `proof` connects `leaf` to `merkleRoot` using sorted-pair hashing.
    function _verify(bytes32[] calldata proof, bytes32 leaf) internal view returns (bool) {
        bytes32 computedHash = leaf;
        uint256 len = proof.length;

        for (uint256 i = 0; i < len; i++) {
            bytes32 proofElement = proof[i];
            if (computedHash <= proofElement) {
                computedHash = keccak256(abi.encodePacked(computedHash, proofElement));
            } else {
                computedHash = keccak256(abi.encodePacked(proofElement, computedHash));
            }
        }

        return computedHash == merkleRoot;
    }
}