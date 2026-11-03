// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BatchCallDelegationV2 — EIP-7702 batch delegate with owner-key authorization
/// @notice Advanced, hardened successor of the naive BatchCallDelegation pattern.
///
/// THE BUG IN V1: `executeForUser(user, calls)` performed arbitrary calls with
/// NO authentication at all. Once any EOA delegates to such a contract, anyone
/// in the world can drive that account (every inner call originates from the
/// account itself). The `user` parameter was decorative.
///
/// THE FIX IN V2 — nothing executes without the account key's authority:
///  1. Self path: `execute` only runs when the account itself originates the
///     call (msg.sender == address(this)); only the key holder can do that.
///  2. Relay path: `executeSigned` runs a batch authorized by an EIP-712
///     signature from the account's own key over the exact calls, a nonce and
///     a deadline. Anyone may relay (and optionally fund) it; nobody can forge
///     or alter it. Domain separation binds the signature to this account on
///     this chain, so signatures cannot be replayed across accounts/chains.
///  3. Replay protection: a monotonically increasing nonce in ERC-7201
///     namespaced storage (no slot collisions when the account switches
///     delegates), consumed exactly once per signed batch.
///  4. The V1 permit entry points are REMOVED on purpose: an ERC-2612 permit
///     call is just an ordinary call — it belongs INSIDE the signed batch,
///     where the signature covers it. A separate permit path would let
///     arbitrary calls hitchhike on a genuine permit signature.
///
/// Extras: ERC-1271 `isValidSignature` (the account can sign as a contract,
/// verified against its own key), a reentrancy lock, self-target ban for
/// batched calls, and view helpers (`getDigest`, `hashCalls`,
/// `domainSeparator`, `nonce`) so off-chain signers and tooling can build
/// the exact payload to sign.
contract BatchCallDelegationV2 {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    error NotSelf();
    error BadSignature();
    error BadNonce(uint256 expected, uint256 given);
    error Expired(uint256 deadline);
    error SelfTarget();
    error CallFailed(uint256 index);
    error Reentrant();

    event BatchExecuted(address indexed executor, uint256 indexed nonce, bool viaSignature, uint256 callCount);

    // --- EIP-712 ------------------------------------------------------------
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant CALL_TYPEHASH = keccak256("Call(address to,uint256 value,bytes data)");
    bytes32 private constant EXECUTE_TYPEHASH =
        keccak256("Execute(Call[] calls,uint256 nonce,uint256 deadline)Call(address to,uint256 value,bytes data)");
    bytes32 private constant NAME_HASH = keccak256("BatchCallDelegation");
    bytes32 private constant VERSION_HASH = keccak256("2");

    // --- ERC-7201 namespaced storage ---------------------------------------
    // slot = keccak256(abi.encode(uint256(keccak256("batchcalldelegation.storage")) - 1)) & ~bytes32(0xff)
    uint256 private constant STORAGE_SLOT = 0x0f735bcca6ec7646e83a04b9d22946c0f1412f4ef2a56772b03404b89a694200;

    struct Storage {
        uint256 nonce;
        bool locked;
    }

    function _storage() private pure returns (Storage storage s) {
        assembly {
            s.slot := STORAGE_SLOT
        }
    }

    uint256 private constant SECP256K1_HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    // --- Views ---------------------------------------------------------------
    function nonce() external view returns (uint256) {
        return _storage().nonce;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function hashCalls(Call[] calldata calls) public pure returns (bytes32) {
        bytes32[] memory parts = new bytes32[](calls.length);
        for (uint256 i = 0; i < calls.length; ++i) {
            parts[i] = keccak256(abi.encode(CALL_TYPEHASH, calls[i].to, calls[i].value, keccak256(calls[i].data)));
        }
        return keccak256(abi.encodePacked(parts));
    }

    /// @notice The exact EIP-712 digest the account key must sign for a batch.
    function getDigest(Call[] calldata calls, uint256 nonce_, uint256 deadline) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(EXECUTE_TYPEHASH, hashCalls(calls), nonce_, deadline));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    // --- Execution -----------------------------------------------------------
    /// @notice Self-driven batch: only the account itself may originate this.
    function execute(Call[] calldata calls) external payable {
        if (msg.sender != address(this)) revert NotSelf();
        _run(calls, _storage().nonce, false);
    }

    /// @notice Relayed batch: executes only with the account key's EIP-712
    /// signature over (calls, nonce, deadline). The nonce is consumed.
    function executeSigned(Call[] calldata calls, uint256 nonce_, uint256 deadline, bytes calldata signature)
        external
        payable
    {
        if (block.timestamp > deadline) revert Expired(deadline);
        Storage storage s = _storage();
        if (nonce_ != s.nonce) revert BadNonce(s.nonce, nonce_);
        if (_recover(getDigest(calls, nonce_, deadline), signature) != address(this)) revert BadSignature();
        s.nonce = nonce_ + 1;
        _run(calls, nonce_, true);
    }

    function _run(Call[] calldata calls, uint256 nonceForEvent, bool viaSignature) private {
        Storage storage s = _storage();
        if (s.locked) revert Reentrant();
        s.locked = true;
        for (uint256 i = 0; i < calls.length; ++i) {
            Call calldata c = calls[i];
            if (c.to == address(this)) revert SelfTarget();
            (bool ok,) = c.to.call{value: c.value}(c.data);
            if (!ok) revert CallFailed(i);
        }
        s.locked = false;
        emit BatchExecuted(msg.sender, nonceForEvent, viaSignature, calls.length);
    }

    // --- ERC-1271 --------------------------------------------------------------
    /// @notice Valid if signed by the account key (personal-sign form of `hash`).
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
        return _recover(digest, signature) == address(this) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x1626ba7e || interfaceId == 0x01ffc9a7;
    }

    // --- Signature helper ------------------------------------------------------
    /// @dev Returns address(0) for malformed/malleable signatures instead of reverting,
    /// so both the strict (executeSigned) and lenient (ERC-1271) paths can share it.
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > SECP256K1_HALF_N) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }

    receive() external payable {}
}
