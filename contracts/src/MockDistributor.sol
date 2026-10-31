// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockDistributor — distributor airdrop gaya OpenZeppelin
///        MerkleDistributor, untuk pengujian Atomic Claim Rescue.
/// @notice Permukaan yang disengaja dibuat kompatibel dengan distributor
///         sungguhan: token(), isClaimed(index[, account]) dan
///         claim(index, account, amount, merkleProof) dengan daun
///         keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))))
///         dan verifikasi pasangan terurut (sorted pairs) ala OZ MerkleProof.
interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract MockDistributor {
    address public token;
    bytes32 public merkleRoot;
    mapping(uint256 => bool) private _claimed;
    mapping(uint256 => address) public claimantOf;

    event Claimed(uint256 index, address account, uint256 amount);

    constructor(address token_, bytes32 merkleRoot_) {
        token = token_;
        merkleRoot = merkleRoot_;
    }

    function isClaimed(uint256 index) public view returns (bool) {
        return _claimed[index];
    }

    function isClaimed(uint256 index, address account) public view returns (bool) {
        return _claimed[index] && claimantOf[index] == account;
    }

    function claim(uint256 index, address account, uint256 amount, bytes32[] calldata merkleProof) external {
        require(!_claimed[index], "sudah diklaim");
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
        require(_verify(merkleProof, merkleRoot, leaf), "proof tidak valid");
        _claimed[index] = true;
        claimantOf[index] = account;
        require(IERC20Minimal(token).transfer(account, amount), "transfer gagal");
        emit Claimed(index, account, amount);
    }

    function _verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            computed = computed <= p
                ? keccak256(abi.encodePacked(computed, p))
                : keccak256(abi.encodePacked(p, computed));
        }
        return computed == root;
    }
}
