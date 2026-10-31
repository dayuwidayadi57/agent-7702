// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockERC20 {
    string public name = "Mock Token";
    string public symbol = "MOCK";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "saldo kurang");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "saldo kurang");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

contract MockBroken20 {
    function transfer(address, uint256) external pure returns (bool) {
        revert("token rusak");
    }

    function balanceOf(address) external pure returns (uint256) {
        return 1000 ether;
    }
}

contract MockERC721 {
    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 id) external {
        require(ownerOf[id] == address(0), "sudah ada");
        ownerOf[id] = to;
        balanceOf[to] += 1;
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "bukan pemilik");
        require(msg.sender == from, "hanya pemilik (mock sederhana)");
        ownerOf[id] = to;
        balanceOf[from] -= 1;
        balanceOf[to] += 1;
    }
}

contract MockERC1155 {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;

    function mint(address to, uint256 id, uint256 amount) external {
        balanceOf[to][id] += amount;
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata) external {
        require(balanceOf[from][id] >= amount, "saldo kurang");
        balanceOf[from][id] -= amount;
        balanceOf[to][id] += amount;
    }
}
