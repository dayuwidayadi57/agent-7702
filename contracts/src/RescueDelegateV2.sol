// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RescueDelegateV2 — Atomic Rescue + Atomic Claim Rescue (agent-7702)
/// @notice Penerus RescueDelegate (v1 tetap hidup untuk misi transfer murni).
///         Perbedaan v2: aksi kind 4 = CLAIM. Pemilik mengomitkan di dalam
///         intent {kontrak claim, token hasil, HASH calldata claim}; saat
///         eksekusi relayer menyerahkan calldata mentahnya dan kontrak
///         MENOLAK bila hash-nya tidak sama. Delegate lalu memanggil claim
///         dari konteks dompet pemilik sendiri (msg.sender = dompet) dan
///         meneruskan SELURUH kenaikan saldo token hasil claim ke alamat
///         tujuan intent. Seperti v1: tanpa tanda tangan pemilik atas
///         intent yang persis, tidak ada yang bergerak.
contract RescueDelegateV2 {
    struct Action {
        uint8 kind; // 0 = native, 1 = ERC20, 2 = ERC721, 3 = ERC1155, 4 = CLAIM
        address token; // kind 4: token HASIL claim (alamat nol = native)
        uint256 amount; // diabaikan untuk kind 4 (seluruh hasil diteruskan)
        uint256 tokenId;
        address target; // kind 4: kontrak claim yang dipanggil
        bytes32 callHash; // kind 4: keccak256(calldata claim yang dikomitkan)
    }

    struct Intent {
        address to;
        uint256 nonce;
        uint256 expiry;
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
    error BadClaimData();

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant ACTION_TYPEHASH =
        keccak256("Action(uint8 kind,address token,uint256 amount,uint256 tokenId,address target,bytes32 callHash)");
    bytes32 private constant INTENT_TYPEHASH = keccak256(
        "Intent(address to,uint256 nonce,uint256 expiry,Action[] actions)Action(uint8 kind,address token,uint256 amount,uint256 tokenId,address target,bytes32 callHash)"
    );
    bytes32 private constant NAME_HASH = keccak256("Agent7702Rescue");
    bytes32 private constant VERSION_HASH = keccak256("2");

    // Slot terpisah dari v1 agar kedua versi tidak berbagi penanda nonce.
    uint256 private constant USED_SLOT = uint256(keccak256("agent7702.rescue.v2.usedNonces")) - 1;

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
                parts[i] = keccak256(abi.encode(ACTION_TYPEHASH, a.kind, a.token, a.amount, a.tokenId, a.target, a.callHash));
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

    /// @param claimDatas calldata mentah untuk setiap aksi CLAIM, berurutan
    ///        sesuai urutan aksi claim di dalam intent.
    function execute(Intent calldata intent, bytes calldata signature, bytes[] calldata claimDatas) external {
        if (intent.actions.length == 0) revert EmptyIntent();
        if (block.timestamp > intent.expiry) revert Expired();
        if (intentUsed(intent.nonce)) revert IntentAlreadyUsed();
        if (_recover(hashIntent(intent), signature) != address(this)) revert BadSignature();

        uint256 claimCount = 0;
        for (uint256 i = 0; i < intent.actions.length; i++) {
            if (intent.actions[i].kind == 4) claimCount++;
        }
        if (claimDatas.length != claimCount) revert BadClaimData();

        _markUsed(intent.nonce);

        uint256 claimIdx = 0;
        for (uint256 i = 0; i < intent.actions.length; i++) {
            Action calldata a = intent.actions[i];
            bool ok;
            if (a.kind == 4) {
                ok = _runClaim(a, claimDatas[claimIdx], intent.to);
                claimIdx++;
            } else {
                ok = _run(a, intent.to);
            }
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

    /// @dev Claim dipanggil dari konteks dompet (address(this) = dompet),
    ///      lalu seluruh KENAIKAN saldo token hasil diteruskan ke tujuan.
    ///      Token lain yang mungkin ikut terkirim tidak disentuh — tetap di
    ///      dompet dan bisa diselamatkan misi berikutnya.
    function _runClaim(Action calldata a, bytes calldata data, address to) internal returns (bool) {
        if (a.target == address(0)) return false;
        if (keccak256(data) != a.callHash) return false;
        bool isNative = a.token == address(0);
        uint256 beforeBal;
        if (isNative) {
            beforeBal = address(this).balance;
        } else {
            (bool okB, bytes memory rb) = a.token.call(abi.encodeWithSignature("balanceOf(address)", address(this)));
            if (!okB || rb.length < 32) return false;
            beforeBal = abi.decode(rb, (uint256));
        }
        (bool ok,) = a.target.call(data);
        if (!ok) return false;
        uint256 afterBal;
        if (isNative) {
            afterBal = address(this).balance;
        } else {
            (bool okA, bytes memory ra) = a.token.call(abi.encodeWithSignature("balanceOf(address)", address(this)));
            if (!okA || ra.length < 32) return false;
            afterBal = abi.decode(ra, (uint256));
        }
        if (afterBal <= beforeBal) return false;
        uint256 gained = afterBal - beforeBal;
        if (isNative) {
            (bool okSend,) = payable(to).call{value: gained}("");
            return okSend;
        }
        return _callOk(a.token, abi.encodeWithSignature("transfer(address,uint256)", to, gained), true);
    }

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
