// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RescueDelegate — "otak sementara" untuk Atomic Rescue (agent-7702)
/// @notice Delegate EIP-7702 minimal yang hanya menjalankan SATU hal:
///         mengeksekusi intent penyelamatan yang DITANDATANGANI pemilik
///         dompet itu sendiri (EIP-712). Aksi dibatasi bentuknya: transfer
///         native / ERC20 / ERC721 / ERC1155 ke SATU alamat tujuan yang
///         terkunci di dalam intent. Siapa pun boleh memanggil execute
///         (relayer membayar gas), tetapi tanpa tanda tangan pemilik atas
///         intent yang persis, tidak ada satu wei pun yang bergerak.
contract RescueDelegate {
    struct Action {
        uint8 kind; // 0 = native, 1 = ERC20, 2 = ERC721, 3 = ERC1155
        address token; // diabaikan untuk kind 0
        uint256 amount; // native: wei; ERC20: unit token; ERC1155: jumlah
        uint256 tokenId; // ERC721 / ERC1155
    }

    struct Intent {
        address to; // satu-satunya tujuan semua aksi
        uint256 nonce; // nonce intent (anti-replay, per dompet)
        uint256 expiry; // unix time; lewat ini intent mati
        Action[] actions;
    }

    event ActionDone(uint256 indexed index, uint8 kind, address token, uint256 amount, uint256 tokenId);
    event ActionFailed(uint256 indexed index, uint8 kind, address token);
    event RescueExecuted(address indexed wallet, address to, uint256 nonce, uint256 actionCount);

    error BadSignature();
    error Expired();
    error IntentAlreadyUsed();
    error EmptyIntent();
    error BadSignatureLength();

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant ACTION_TYPEHASH = keccak256("Action(uint8 kind,address token,uint256 amount,uint256 tokenId)");
    bytes32 private constant INTENT_TYPEHASH =
        keccak256("Intent(address to,uint256 nonce,uint256 expiry,Action[] actions)Action(uint8 kind,address token,uint256 amount,uint256 tokenId)");
    bytes32 private constant NAME_HASH = keccak256("Agent7702Rescue");
    bytes32 private constant VERSION_HASH = keccak256("1");

    // Slot penyimpanan bernama (gaya ERC-7201) — delegate hidup di storage
    // EOA pemilik, jadi WAJIB memakai slot acak yang tidak bertabrakan
    // dengan delegate lain: usedNonces menempati mapping di slot ini.
    uint256 private constant USED_SLOT = uint256(keccak256("agent7702.rescue.usedNonces")) - 1;

    receive() external payable {}

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function hashIntent(Intent calldata intent) public view returns (bytes32) {
        bytes32 actionsHash;
        {
            bytes32[] memory parts = new bytes32[](intent.actions.length);
            for (uint256 i = 0; i < intent.actions.length; i++) {
                Action calldata a = intent.actions[i];
                parts[i] = keccak256(abi.encode(ACTION_TYPEHASH, a.kind, a.token, a.amount, a.tokenId));
            }
            actionsHash = keccak256(abi.encodePacked(parts));
        }
        bytes32 structHash = keccak256(abi.encode(INTENT_TYPEHASH, intent.to, intent.nonce, intent.expiry, actionsHash));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function intentUsed(uint256 nonce) public view returns (bool) {
        uint256 slot = _usedSlot(nonce);
        uint256 v;
        assembly {
            v := sload(slot)
        }
        return v != 0;
    }

    function execute(Intent calldata intent, bytes calldata signature) external {
        if (intent.actions.length == 0) revert EmptyIntent();
        if (block.timestamp > intent.expiry) revert Expired();
        if (intentUsed(intent.nonce)) revert IntentAlreadyUsed();
        if (_recover(hashIntent(intent), signature) != address(this)) revert BadSignature();

        _markUsed(intent.nonce);

        for (uint256 i = 0; i < intent.actions.length; i++) {
            Action calldata a = intent.actions[i];
            bool ok = _run(a, intent.to);
            if (ok) {
                emit ActionDone(i, a.kind, a.token, a.amount, a.tokenId);
            } else {
                emit ActionFailed(i, a.kind, a.token);
            }
        }
        emit RescueExecuted(address(this), intent.to, intent.nonce, intent.actions.length);
    }

    function _run(Action calldata a, address to) internal returns (bool) {
        if (a.kind == 0) {
            (bool ok,) = payable(to).call{value: a.amount}("");
            return ok;
        }
        if (a.kind == 1) {
            return _callOk(a.token, abi.encodeWithSignature("transfer(address,uint256)", to, a.amount), true);
        }
        if (a.kind == 2) {
            return _callOk(a.token, abi.encodeWithSignature("transferFrom(address,address,uint256)", address(this), to, a.tokenId), false);
        }
        if (a.kind == 3) {
            return _callOk(
                a.token, abi.encodeWithSignature("safeTransferFrom(address,address,uint256,uint256,bytes)", address(this), to, a.tokenId, a.amount, ""), false
            );
        }
        return false;
    }

    /// @dev Sukses bila panggilan tidak revert; untuk ERC20 yang mengembalikan
    ///      bool, nilai false dianggap gagal. Returndata kosong diterima
    ///      (token lama tanpa nilai balik).
    function _callOk(address target, bytes memory data, bool checkBoolReturn) internal returns (bool) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) return false;
        if (checkBoolReturn && ret.length >= 32) {
            return abi.decode(ret, (bool));
        }
        return true;
    }

    function _usedSlot(uint256 nonce) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(nonce, USED_SLOT)));
    }

    function _markUsed(uint256 nonce) internal {
        uint256 slot = _usedSlot(nonce);
        assembly {
            sstore(slot, 1)
        }
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) revert BadSignatureLength();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }
}
