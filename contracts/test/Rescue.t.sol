// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RescueDelegate} from "../src/RescueDelegate.sol";
import {MockERC20, MockBroken20, MockERC721, MockERC1155} from "./Mocks.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function prank(address msgSender) external;
    function deal(address account, uint256 newBalance) external;
    function etch(address target, bytes calldata newRuntimeBytecode) external;
    function warp(uint256 newTimestamp) external;
    function expectRevert(bytes4 revertData) external;
}

/// @notice Dependency-free test suite (no forge-std), house style.
contract RescueTest {
    Vm private constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    uint256 internal constant VICTIM_KEY = 0xA11CE;
    uint256 internal constant ATTACKER_KEY = 0xBAD;

    RescueDelegate internal rescue;
    MockERC20 internal token;
    MockBroken20 internal broken;
    MockERC721 internal nft;
    MockERC1155 internal multi;

    address payable internal victim;
    address internal safe = address(0x5AFE);
    address internal relayer = address(0xBE11);

    function setUp() public {
        rescue = new RescueDelegate();
        token = new MockERC20();
        broken = new MockBroken20();
        nft = new MockERC721();
        multi = new MockERC1155();
        victim = payable(vm.addr(VICTIM_KEY));
        token.mint(victim, 1000 ether);
        nft.mint(victim, 7);
        multi.mint(victim, 42, 9);
        vm.deal(victim, 1 ether);
        // Pasang designator delegasi 7702 pada korban -> RescueDelegate.
        vm.etch(victim, abi.encodePacked(bytes3(0xef0100), bytes20(address(rescue))));
    }

    // ---------- helpers ----------
    function _intent(uint256 nonce, uint256 expiry, address to) internal view returns (RescueDelegate.Intent memory it) {
        RescueDelegate.Action[] memory acts = new RescueDelegate.Action[](4);
        acts[0] = RescueDelegate.Action({kind: 1, token: address(token), amount: 400 ether, tokenId: 0});
        acts[1] = RescueDelegate.Action({kind: 2, token: address(nft), amount: 0, tokenId: 7});
        acts[2] = RescueDelegate.Action({kind: 3, token: address(multi), amount: 5, tokenId: 42});
        acts[3] = RescueDelegate.Action({kind: 0, token: address(0), amount: 0.25 ether, tokenId: 0});
        it = RescueDelegate.Intent({to: to, nonce: nonce, expiry: expiry, actions: acts});
    }

    function _sign(RescueDelegate.Intent memory it, uint256 key) internal returns (bytes memory) {
        bytes32 digest = RescueDelegate(victim).hashIntent(it);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _assert(bool cond, string memory what) internal pure {
        if (!cond) revert(what);
    }

    // ---------- tests ----------
    function testHarvestAtomik() public {
        RescueDelegate.Intent memory it = _intent(1, block.timestamp + 1 hours, safe);
        bytes memory sig = _sign(it, VICTIM_KEY);
        vm.prank(relayer);
        RescueDelegate(victim).execute(it, sig);
        _assert(token.balanceOf(safe) == 400 ether, "erc20 tujuan salah");
        _assert(token.balanceOf(victim) == 600 ether, "erc20 sisa salah");
        _assert(nft.ownerOf(7) == safe, "nft belum pindah");
        _assert(multi.balanceOf(safe, 42) == 5, "1155 tujuan salah");
        _assert(multi.balanceOf(victim, 42) == 4, "1155 sisa salah");
        _assert(safe.balance == 0.25 ether, "native tujuan salah");
        _assert(RescueDelegate(victim).intentUsed(1), "nonce intent belum tercatat");
    }

    function testReplayDitolak() public {
        RescueDelegate.Intent memory it = _intent(2, block.timestamp + 1 hours, safe);
        bytes memory sig = _sign(it, VICTIM_KEY);
        RescueDelegate(victim).execute(it, sig);
        vm.expectRevert(RescueDelegate.IntentAlreadyUsed.selector);
        RescueDelegate(victim).execute(it, sig);
    }

    function testTandaTanganOrangLainDitolak() public {
        RescueDelegate.Intent memory it = _intent(3, block.timestamp + 1 hours, safe);
        bytes memory sig = _sign(it, ATTACKER_KEY);
        vm.expectRevert(RescueDelegate.BadSignature.selector);
        RescueDelegate(victim).execute(it, sig);
    }

    function testKedaluwarsaDitolak() public {
        RescueDelegate.Intent memory it = _intent(4, block.timestamp - 1, safe);
        bytes memory sig = _sign(it, VICTIM_KEY);
        vm.expectRevert(RescueDelegate.Expired.selector);
        RescueDelegate(victim).execute(it, sig);
    }

    function testTujuanDiubahDitolak() public {
        RescueDelegate.Intent memory it = _intent(5, block.timestamp + 1 hours, safe);
        bytes memory sig = _sign(it, VICTIM_KEY);
        it.to = vm.addr(ATTACKER_KEY); // relayer jahat membelokkan tujuan
        vm.expectRevert(RescueDelegate.BadSignature.selector);
        RescueDelegate(victim).execute(it, sig);
    }

    function testSatuAsetRusakTidakMenggagalkanLainnya() public {
        RescueDelegate.Action[] memory acts = new RescueDelegate.Action[](2);
        acts[0] = RescueDelegate.Action({kind: 1, token: address(broken), amount: 10 ether, tokenId: 0});
        acts[1] = RescueDelegate.Action({kind: 1, token: address(token), amount: 100 ether, tokenId: 0});
        RescueDelegate.Intent memory it = RescueDelegate.Intent({to: safe, nonce: 6, expiry: block.timestamp + 1 hours, actions: acts});
        bytes memory sig = _sign(it, VICTIM_KEY);
        RescueDelegate(victim).execute(it, sig);
        _assert(token.balanceOf(safe) == 100 ether, "aset sehat harus tetap terpanen");
    }

    function testIntentKosongDitolak() public {
        RescueDelegate.Action[] memory acts = new RescueDelegate.Action[](0);
        RescueDelegate.Intent memory it = RescueDelegate.Intent({to: safe, nonce: 7, expiry: block.timestamp + 1 hours, actions: acts});
        bytes memory sig = _sign(it, VICTIM_KEY);
        vm.expectRevert(RescueDelegate.EmptyIntent.selector);
        RescueDelegate(victim).execute(it, sig);
    }
}
