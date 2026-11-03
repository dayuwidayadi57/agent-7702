// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVaultToken {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title MockExoticVault — target uji Relay-Call (agent-7702)
/// @notice Kontrak "brankas vesting" tiruan dengan fungsi berbentuk EKSOTIK
///         (bukan pola claim distributor): releaseVested() membayar token +
///         koin native ke pemanggil, sekali per alamat. Dipakai untuk
///         membuktikan relay-call (kind 5) di test forge dan di Sepolia.
///         Bukan kode produksi.
contract MockExoticVault {
    IVaultToken public immutable token;
    IVaultToken public immutable bonusToken;
    uint256 public constant TOKEN_PAYOUT = 250 ether;
    uint256 public constant BONUS_PAYOUT = 40 ether;
    uint256 public constant NATIVE_PAYOUT = 0.01 ether;

    mapping(address => bool) public released;
    mapping(address => bool) public bonusReleased;

    event Released(address indexed who, uint256 tokenAmount, uint256 nativeAmount);
    event BonusReleased(address indexed who, uint256 amount);

    error AlreadyReleased();
    error InsufficientFloat();

    constructor(address token_, address bonusToken_) {
        token = IVaultToken(token_);
        bonusToken = IVaultToken(bonusToken_);
    }

    receive() external payable {}

    /// @notice Fungsi eksotik: melepas vesting pemanggil — token + native.
    function releaseVested() external {
        if (released[msg.sender]) revert AlreadyReleased();
        released[msg.sender] = true;
        if (!token.transfer(msg.sender, TOKEN_PAYOUT)) revert InsufficientFloat();
        if (address(this).balance < NATIVE_PAYOUT) revert InsufficientFloat();
        (bool ok,) = payable(msg.sender).call{value: NATIVE_PAYOUT}("");
        if (!ok) revert InsufficientFloat();
        emit Released(msg.sender, TOKEN_PAYOUT, NATIVE_PAYOUT);
    }

    /// @notice Membayar token BONUS (untuk uji disiplin daftar penerus:
    ///         gain token yang tidak didaftarkan harus tetap di dompet).
    function releaseBonus() external {
        if (bonusReleased[msg.sender]) revert AlreadyReleased();
        bonusReleased[msg.sender] = true;
        if (!bonusToken.transfer(msg.sender, BONUS_PAYOUT)) revert InsufficientFloat();
        emit BonusReleased(msg.sender, BONUS_PAYOUT);
    }

    /// @notice Selalu revert — untuk uji kegagalan target yang terisolasi.
    function brokenRelease() external pure {
        revert("vault rusak");
    }
}
