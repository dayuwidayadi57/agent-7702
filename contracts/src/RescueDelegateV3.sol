// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RescueDelegateV3 — Atomic Rescue + Claim Rescue + Relay-Call (agent-7702)
/// @notice Penerus RescueDelegateV2 (v1/v2 tetap hidup). Perbedaan v3: aksi
///         kind 5 = CALL — generalisasi aksi CLAIM. Pemilik mengomitkan di
///         dalam intent {kontrak target, HASH calldata, HASH daftar token
///         yang gain-nya diteruskan}; saat eksekusi relayer menyerahkan
///         calldata + daftar token mentahnya dan kontrak MENOLAK bila hash
///         mana pun tidak sama. Delegate memanggil target dari konteks
///         dompet pemilik sendiri (msg.sender = dompet, value selalu 0) dan
///         meneruskan seluruh KENAIKAN saldo — koin native + setiap token
///         terdaftar — ke alamat tujuan intent. Dana lama dompet tidak
///         disentuh. Selector berbahaya (approve/transfer dst.) ditolak di
///         lapisan CLI sebelum intent pernah ditandatangani (DESIGN §12.4).
contract RescueDelegateV3 {
    struct Action {
        uint8 kind; // 0 = native, 1 = ERC20, 2 = ERC721, 3 = ERC1155, 4 = CLAIM, 5 = CALL
        address token; // kind 4: token HASIL claim (alamat nol = native)
        uint256 amount; // diabaikan untuk kind 4/5
        uint256 tokenId;
        address target; // kind 4/5: kontrak yang dipanggil
        bytes32 callHash; // kind 4/5: keccak256(calldata yang dikomitkan)
        bytes32 forwardHash; // kind 5: keccak256(abi.encode(address[] token yang gain-nya diteruskan))
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
    error BadCallData();

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant ACTION_TYPEHASH = keccak256(
        "Action(uint8 kind,address token,uint256 amount,uint256 tokenId,address target,bytes32 callHash,bytes32 forwardHash)"
    );
    bytes32 private constant INTENT_TYPEHASH = keccak256(
        "Intent(address to,uint256 nonce,uint256 expiry,Action[] actions)Action(uint8 kind,address token,uint256 amount,uint256 tokenId,address target,bytes32 callHash,bytes32 forwardHash)"
    );
    bytes32 private constant NAME_HASH = keccak256("Agent7702Rescue");
    bytes32 private constant VERSION_HASH = keccak256("3");

    // Slot terpisah dari v1/v2 agar ketiga versi tidak berbagi penanda nonce.
    uint256 private constant USED_SLOT = uint256(keccak256("agent7702.rescue.v3.usedNonces")) - 1;

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
                parts[i] = keccak256(
                    abi.encode(ACTION_TYPEHASH, a.kind, a.token, a.amount, a.tokenId, a.target, a.callHash, a.forwardHash)
                );
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

    /// @param datas calldata mentah untuk setiap aksi CLAIM (kind 4) dan CALL
    ///        (kind 5), berurutan sesuai urutan aksi-aksi itu di dalam intent.
    /// @param forwardSets daftar token penerus-gain untuk setiap aksi CALL,
    ///        berurutan sesuai urutan aksi CALL di dalam intent.
    function execute(Intent calldata intent, bytes calldata signature, bytes[] calldata datas, address[][] calldata forwardSets)
        external
    {
        if (intent.actions.length == 0) revert EmptyIntent();
        if (block.timestamp > intent.expiry) revert Expired();
        if (intentUsed(intent.nonce)) revert IntentAlreadyUsed();
        if (_recover(hashIntent(intent), signature) != address(this)) revert BadSignature();

        _validateCounts(intent, datas.length, forwardSets.length);

        _markUsed(intent.nonce);

        _runAll(intent, datas, forwardSets);
        emit RescueExecuted(address(this), intent.to, intent.nonce, intent.actions.length);
    }

    function _runAll(Intent calldata intent, bytes[] calldata datas, address[][] calldata forwardSets) internal {
        uint256 dataIdx = 0;
        uint256 callIdx = 0;
        for (uint256 i = 0; i < intent.actions.length; i++) {
            Action calldata a = intent.actions[i];
            bool ok;
            if (a.kind == 4) {
                ok = _runClaim(a, datas[dataIdx], intent.to);
                dataIdx++;
            } else if (a.kind == 5) {
                ok = _runCall(a, datas[dataIdx], forwardSets[callIdx], intent.to);
                dataIdx++;
                callIdx++;
            } else {
                ok = _run(a, intent.to);
            }
            if (ok) {
                emit ActionDone(i, a.kind, a.token, a.amount, a.tokenId);
            } else {
                emit ActionFailed(i, a.kind, a.token);
            }
        }
    }

    function _validateCounts(Intent calldata intent, uint256 datasLen, uint256 forwardSetsLen) internal pure {
        uint256 dataCount = 0;
        uint256 callCount = 0;
        for (uint256 i = 0; i < intent.actions.length; i++) {
            uint8 k = intent.actions[i].kind;
            if (k == 4 || k == 5) dataCount++;
            if (k == 5) callCount++;
        }
        if (datasLen != dataCount) revert BadCallData();
        if (forwardSetsLen != callCount) revert BadCallData();
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

    /// @dev Relay-Call: panggilan umum berpagar hash. Calldata dan daftar
    ///      token penerus diverifikasi terhadap hash yang dikomitkan pemilik;
    ///      panggilan berjalan sebagai dompet dengan value 0; sesudahnya
    ///      KENAIKAN saldo native + setiap token terdaftar diteruskan ke
    ///      tujuan. Token yang tidak terdaftar gain-nya tetap di dompet.
    ///      Berbeda dengan CLAIM: panggilan yang berhasil tanpa gain saldo
    ///      tetap dianggap berhasil (tujuannya bisa perubahan state).
    function _runCall(Action calldata a, bytes calldata data, address[] calldata forwardSet, address to) internal returns (bool) {
        if (a.target == address(0)) return false;
        if (a.target == address(this)) return false; // jangan memanggil dompet itu sendiri
        if (keccak256(data) != a.callHash) return false;
        if (keccak256(abi.encode(forwardSet)) != a.forwardHash) return false;

        uint256 n = forwardSet.length;
        uint256[] memory beforeBals = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            if (forwardSet[i] == address(0)) return false;
            (bool okB, bytes memory rb) = forwardSet[i].call(abi.encodeWithSignature("balanceOf(address)", address(this)));
            if (!okB || rb.length < 32) return false;
            beforeBals[i] = abi.decode(rb, (uint256));
        }
        uint256 nativeBefore = address(this).balance;

        (bool ok,) = a.target.call(data);
        if (!ok) return false;

        if (address(this).balance > nativeBefore) {
            uint256 gainedNative = address(this).balance - nativeBefore;
            (bool okSend,) = payable(to).call{value: gainedNative}("");
            if (!okSend) return false;
        }
        for (uint256 i = 0; i < n; i++) {
            (bool okA, bytes memory ra) = forwardSet[i].call(abi.encodeWithSignature("balanceOf(address)", address(this)));
            if (!okA || ra.length < 32) return false;
            uint256 afterBal = abi.decode(ra, (uint256));
            if (afterBal > beforeBals[i]) {
                uint256 gained = afterBal - beforeBals[i];
                if (!_callOk(forwardSet[i], abi.encodeWithSignature("transfer(address,uint256)", to, gained), true)) return false;
            }
        }
        return true;
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
