// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/BatchCallDelegationV2.sol";

interface Vm {
    function warp(uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function etch(address, bytes calldata) external;
    function deal(address, uint256) external;
    function prank(address) external;
}

/// Minimal forge-style assertions without forge-std (repo convention):
/// failures revert with a message, which fails the test.
contract BatchTarget {
    uint256 public pings;
    uint256 public lastValue;
    address public lastSender;

    function ping() external payable {
        pings++;
        lastValue = msg.value;
        lastSender = msg.sender;
    }

    function boom() external pure {
        revert("boom");
    }
}

contract ReentrantTarget {
    bytes public payload;
    bool public innerBlocked;

    function setPayload(bytes calldata p) external {
        payload = p;
    }

    function attack(address account) external {
        (bool ok,) = account.call(payload);
        if (!ok) innerBlocked = true;
    }
}

contract BatchCallDelegationV2Test {
    Vm private constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    uint256 internal constant PK = 0xA11CE;
    uint256 internal constant PK_OTHER = 0xB0B;

    address internal account;
    address internal relayer = address(0xBE11);
    BatchCallDelegationV2 internal acct;
    BatchTarget internal target;

    function setUp() public {
        vm.warp(1_000_000);
        account = vm.addr(PK);
        BatchCallDelegationV2 impl = new BatchCallDelegationV2();
        vm.etch(account, address(impl).code);
        acct = BatchCallDelegationV2(payable(account));
        target = new BatchTarget();
        vm.deal(account, 10 ether);
        vm.deal(relayer, 1 ether);
    }

    // --- helpers -------------------------------------------------------------
    function _calls1(address to, uint256 value, bytes memory data)
        internal
        pure
        returns (BatchCallDelegationV2.Call[] memory calls)
    {
        calls = new BatchCallDelegationV2.Call[](1);
        calls[0] = BatchCallDelegationV2.Call(to, value, data);
    }

    function _sign(uint256 pk, BatchCallDelegationV2.Call[] memory calls, uint256 nonce_, uint256 deadline)
        internal
        returns (bytes memory)
    {
        bytes32 digest = acct.getDigest(calls, nonce_, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _deadline() internal view returns (uint256) {
        return block.timestamp + 1 days;
    }

    function _eq(uint256 a, uint256 b, string memory m) internal pure {
        require(a == b, m);
    }

    function _ok(bool c, string memory m) internal pure {
        require(c, m);
    }

    // --- self path -------------------------------------------------------------
    function testSelfExecute() public {
        BatchCallDelegationV2.Call[] memory calls = _calls1(address(target), 1 ether, abi.encodeCall(BatchTarget.ping, ()));
        vm.prank(account);
        acct.execute{value: 0}(calls);
        _eq(target.pings(), 1, "ping count");
        _eq(target.lastValue(), 1 ether, "value forwarded");
        _ok(target.lastSender() == account, "calls originate from the account");
        _eq(account.balance, 9 ether, "account paid exactly the call value");
    }

    function testSelfExecuteFromStrangerReverts() public {
        BatchCallDelegationV2.Call[] memory calls = _calls1(address(target), 0, abi.encodeCall(BatchTarget.ping, ()));
        vm.prank(relayer);
        try acct.execute(calls) {
            revert("must revert");
        } catch (bytes memory e) {
            _ok(bytes4(e) == BatchCallDelegationV2.NotSelf.selector, "NotSelf expected");
        }
    }

    // --- signed path -------------------------------------------------------------
    function testSignedExecute() public {
        address friend = address(0xF21E);
        BatchCallDelegationV2.Call[] memory calls = new BatchCallDelegationV2.Call[](2);
        calls[0] = BatchCallDelegationV2.Call(address(target), 0.5 ether, abi.encodeCall(BatchTarget.ping, ()));
        calls[1] = BatchCallDelegationV2.Call(friend, 0.25 ether, "");
        bytes memory sig = _sign(PK, calls, 0, _deadline());
        vm.prank(relayer);
        acct.executeSigned(calls, 0, _deadline(), sig);
        _eq(target.pings(), 1, "ping via signed batch");
        _eq(friend.balance, 0.25 ether, "native leg moved");
        _eq(acct.nonce(), 1, "nonce consumed");
        _eq(account.balance, 10 ether - 0.75 ether, "account funded both legs");
    }

    function testReplayReverts() public {
        BatchCallDelegationV2.Call[] memory calls = _calls1(address(target), 0, abi.encodeCall(BatchTarget.ping, ()));
        bytes memory sig = _sign(PK, calls, 0, _deadline());
        vm.prank(relayer);
        acct.executeSigned(calls, 0, _deadline(), sig);
        vm.prank(relayer);
        try acct.executeSigned(calls, 0, _deadline(), sig) {
            revert("must revert");
        } catch (bytes memory e) {
            _ok(bytes4(e) == BatchCallDelegationV2.BadNonce.selector, "BadNonce expected on replay");
        }
    }

    function testWrongSignerReverts() public {
        BatchCallDelegationV2.Call[] memory calls = _calls1(address(target), 0, abi.encodeCall(BatchTarget.ping, ()));
        bytes memory sig = _sign(PK_OTHER, calls, 0, _deadline());
        vm.prank(relayer);
        try acct.executeSigned(calls, 0, _deadline(), sig) {
            revert("must revert");
        } catch (bytes memory e) {
            _ok(bytes4(e) == BatchCallDelegationV2.BadSignature.selector, "BadSignature expected");
        }
    }

    function testExpiredReverts() public {
        BatchCallDelegationV2.Call[] memory calls = _calls1(address(target), 0, abi.encodeCall(BatchTarget.ping, ()));
        uint256 past = block.timestamp - 1;
        bytes memory sig = _sign(PK, calls, 0, past);
        vm.prank(relayer);
        try acct.executeSigned(calls, 0, past, sig) {
            revert("must revert");
        } catch (bytes memory e) {
            _ok(bytes4(e) == BatchCallDelegationV2.Expired.selector, "Expired expected");
        }
    }

    function testWrongNonceReverts() public {
        BatchCallDelegationV2.Call[] memory calls = _calls1(address(target), 0, abi.encodeCall(BatchTarget.ping, ()));
        bytes memory sig = _sign(PK, calls, 5, _deadline());
        vm.prank(relayer);
        try acct.executeSigned(calls, 5, _deadline(), sig) {
            revert("must revert");
        } catch (bytes memory e) {
            _ok(bytes4(e) == BatchCallDelegationV2.BadNonce.selector, "BadNonce expected");
        }
    }

    function testSelfTargetReverts() public {
        BatchCallDelegationV2.Call[] memory calls = _calls1(account, 0, abi.encodeCall(BatchTarget.ping, ()));
        bytes memory sig = _sign(PK, calls, 0, _deadline());
        vm.prank(relayer);
        try acct.executeSigned(calls, 0, _deadline(), sig) {
            revert("must revert");
        } catch (bytes memory e) {
            _ok(bytes4(e) == BatchCallDelegationV2.SelfTarget.selector, "SelfTarget expected");
        }
    }

    function testBatchRevertsAtomicallyOnCallFailure() public {
        BatchCallDelegationV2.Call[] memory calls = new BatchCallDelegationV2.Call[](2);
        calls[0] = BatchCallDelegationV2.Call(address(target), 0, abi.encodeCall(BatchTarget.ping, ()));
        calls[1] = BatchCallDelegationV2.Call(address(target), 0, abi.encodeCall(BatchTarget.boom, ()));
        bytes memory sig = _sign(PK, calls, 0, _deadline());
        vm.prank(relayer);
        try acct.executeSigned(calls, 0, _deadline(), sig) {
            revert("must revert");
        } catch (bytes memory e) {
            _ok(bytes4(e) == BatchCallDelegationV2.CallFailed.selector, "CallFailed expected");
        }
        _eq(target.pings(), 0, "atomic: earlier call rolled back too");
        _eq(acct.nonce(), 0, "atomic: nonce not consumed on failure");
    }

    function testReentrantSecondBatchBlocked() public {
        ReentrantTarget rt = new ReentrantTarget();
        // Inner batch (nonce 1) signed and ready; the target tries to fire it
        // while the outer batch (nonce 0) is mid-execution.
        BatchCallDelegationV2.Call[] memory inner = _calls1(address(target), 0, abi.encodeCall(BatchTarget.ping, ()));
        bytes memory innerSig = _sign(PK, inner, 1, _deadline());
        rt.setPayload(abi.encodeCall(BatchCallDelegationV2.executeSigned, (inner, 1, _deadline(), innerSig)));
        BatchCallDelegationV2.Call[] memory outer = _calls1(address(rt), 0, abi.encodeCall(ReentrantTarget.attack, (account)));
        bytes memory outerSig = _sign(PK, outer, 0, _deadline());
        vm.prank(relayer);
        acct.executeSigned(outer, 0, _deadline(), outerSig);
        _ok(rt.innerBlocked(), "reentrant batch must be blocked by the lock");
        _eq(target.pings(), 0, "inner batch never ran");
        _eq(acct.nonce(), 1, "only the outer nonce consumed");
    }

    // --- ERC-1271 -------------------------------------------------------------
    function testERC1271() public {
        bytes32 h = keccak256("hello");
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        _ok(acct.isValidSignature(h, sig) == bytes4(0x1626ba7e), "magic value for owner signature");
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(PK_OTHER, digest);
        bytes memory bad = abi.encodePacked(r2, s2, v2);
        _ok(acct.isValidSignature(h, bad) == bytes4(0xffffffff), "reject stranger signature");
    }
}
