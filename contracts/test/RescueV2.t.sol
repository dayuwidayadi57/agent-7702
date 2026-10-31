// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RescueDelegateV2} from "../src/RescueDelegateV2.sol";
import {MockDistributor} from "../src/MockDistributor.sol";
import {MockERC20} from "./Mocks.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function prank(address msgSender) external;
    function deal(address account, uint256 newBalance) external;
    function etch(address target, bytes calldata newRuntimeBytecode) external;
    function expectRevert(bytes4 revertData) external;
}

/// @notice Dependency-free test suite (no forge-std), house style — v2 CLAIM.
contract RescueV2Test {
    Vm private constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    uint256 internal constant VICTIM_KEY = 0xA11CE;
    uint256 internal constant ATTACKER_KEY = 0xBAD;

    RescueDelegateV2 internal rescue;
    MockERC20 internal token; // aset biasa milik korban
    MockERC20 internal reward; // token airdrop
    MockDistributor internal distributor;

    address payable internal victim;
    address internal safe = address(0x5AFE);
    address internal relayer = address(0xBE11);
    address internal attacker;

    uint256 internal constant CLAIM_AMOUNT = 500 ether;

    function setUp() public {
        rescue = new RescueDelegateV2();
        token = new MockERC20();
        reward = new MockERC20();
        victim = payable(vm.addr(VICTIM_KEY));
        attacker = vm.addr(ATTACKER_KEY);
        // Pohon satu daun: alokasi index 0 untuk korban.
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(uint256(0), victim, CLAIM_AMOUNT))));
        distributor = new MockDistributor(address(reward), leaf);
        reward.mint(address(distributor), 1000 ether);
        token.mint(victim, 1000 ether);
        vm.deal(victim, 1 ether);
        vm.etch(victim, abi.encodePacked(bytes3(0xef0100), bytes20(address(rescue))));
    }

    // ---------- helpers ----------
    function _claimData(address account, uint256 amount) internal pure returns (bytes memory) {
        bytes32[] memory proof = new bytes32[](0);
        return abi.encodeWithSignature("claim(uint256,address,uint256,bytes32[])", uint256(0), account, amount, proof);
    }

    function _claimAction(bytes memory data) internal view returns (RescueDelegateV2.Action memory) {
        return RescueDelegateV2.Action({
            kind: 4,
            token: address(reward),
            amount: 0,
            tokenId: 0,
            target: address(distributor),
            callHash: keccak256(data)
        });
    }

    function _intent(RescueDelegateV2.Action[] memory acts, uint256 nonce) internal view returns (RescueDelegateV2.Intent memory) {
        return RescueDelegateV2.Intent({to: safe, nonce: nonce, expiry: block.timestamp + 1 hours, actions: acts});
    }

    function _sign(RescueDelegateV2.Intent memory it, uint256 key) internal returns (bytes memory) {
        bytes32 digest = RescueDelegateV2(victim).hashIntent(it);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _oneClaim(bytes memory data, uint256 nonce) internal view returns (RescueDelegateV2.Intent memory) {
        RescueDelegateV2.Action[] memory acts = new RescueDelegateV2.Action[](1);
        acts[0] = _claimAction(data);
        return _intent(acts, nonce);
    }

    function _assert(bool cond, string memory what) internal pure {
        if (!cond) revert(what);
    }

    // ---------- tests ----------
    function testClaimAtomik() public {
        bytes memory data = _claimData(victim, CLAIM_AMOUNT);
        RescueDelegateV2.Intent memory it = _oneClaim(data, 1);
        bytes memory sig = _sign(it, VICTIM_KEY);
        bytes[] memory datas = new bytes[](1);
        datas[0] = data;
        vm.prank(relayer);
        RescueDelegateV2(victim).execute(it, sig, datas);
        _assert(reward.balanceOf(safe) == CLAIM_AMOUNT, "hasil claim harus tiba di tujuan");
        _assert(reward.balanceOf(victim) == 0, "token tidak boleh beristirahat di dompet korban");
        _assert(distributor.isClaimed(0, victim), "distributor harus menandai terklaim");
    }

    function testCalldataDitukarRelayer() public {
        bytes memory legit = _claimData(victim, CLAIM_AMOUNT);
        RescueDelegateV2.Intent memory it = _oneClaim(legit, 2);
        bytes memory sig = _sign(it, VICTIM_KEY);
        // Relayer jahat menyerahkan calldata yang mengklaim untuk penyerang.
        bytes[] memory datas = new bytes[](1);
        datas[0] = _claimData(attacker, CLAIM_AMOUNT);
        RescueDelegateV2(victim).execute(it, sig, datas);
        _assert(reward.balanceOf(safe) == 0, "calldata tertukar tidak boleh menghasilkan apa pun di tujuan");
        _assert(reward.balanceOf(attacker) == 0, "penyerang tidak boleh menerima hasil claim");
        _assert(!distributor.isClaimed(0), "klaim tidak boleh tercatat");
    }

    function testProofSalahTerisolasi() public {
        // Pemilik (tanpa sadar) mengomitkan calldata dengan jumlah yang salah
        // -> distributor menolak; aksi token biasa harus tetap berjalan.
        bytes memory badData = _claimData(victim, CLAIM_AMOUNT + 1);
        RescueDelegateV2.Action[] memory acts = new RescueDelegateV2.Action[](2);
        acts[0] = _claimAction(badData);
        acts[1] = RescueDelegateV2.Action({kind: 1, token: address(token), amount: 100 ether, tokenId: 0, target: address(0), callHash: bytes32(0)});
        RescueDelegateV2.Intent memory it = _intent(acts, 3);
        bytes memory sig = _sign(it, VICTIM_KEY);
        bytes[] memory datas = new bytes[](1);
        datas[0] = badData;
        RescueDelegateV2(victim).execute(it, sig, datas);
        _assert(token.balanceOf(safe) == 100 ether, "aksi sehat harus tetap terpanen");
        _assert(reward.balanceOf(safe) == 0, "claim gagal tidak meneruskan apa pun");
        _assert(!distributor.isClaimed(0), "klaim gagal tidak tercatat");
    }

    function testClaimPlusTransferCombo() public {
        bytes memory data = _claimData(victim, CLAIM_AMOUNT);
        RescueDelegateV2.Action[] memory acts = new RescueDelegateV2.Action[](2);
        acts[0] = _claimAction(data);
        acts[1] = RescueDelegateV2.Action({kind: 1, token: address(token), amount: 250 ether, tokenId: 0, target: address(0), callHash: bytes32(0)});
        RescueDelegateV2.Intent memory it = _intent(acts, 4);
        bytes memory sig = _sign(it, VICTIM_KEY);
        bytes[] memory datas = new bytes[](1);
        datas[0] = data;
        RescueDelegateV2(victim).execute(it, sig, datas);
        _assert(reward.balanceOf(safe) == CLAIM_AMOUNT, "claim combo salah");
        _assert(token.balanceOf(safe) == 250 ether, "transfer combo salah");
    }

    function testReplayIntentClaimDitolak() public {
        bytes memory data = _claimData(victim, CLAIM_AMOUNT);
        RescueDelegateV2.Intent memory it = _oneClaim(data, 5);
        bytes memory sig = _sign(it, VICTIM_KEY);
        bytes[] memory datas = new bytes[](1);
        datas[0] = data;
        RescueDelegateV2(victim).execute(it, sig, datas);
        vm.expectRevert(RescueDelegateV2.IntentAlreadyUsed.selector);
        RescueDelegateV2(victim).execute(it, sig, datas);
    }

    function testTandaTanganOrangLainDitolak() public {
        bytes memory data = _claimData(victim, CLAIM_AMOUNT);
        RescueDelegateV2.Intent memory it = _oneClaim(data, 6);
        bytes memory sig = _sign(it, ATTACKER_KEY);
        bytes[] memory datas = new bytes[](1);
        datas[0] = data;
        vm.expectRevert(RescueDelegateV2.BadSignature.selector);
        RescueDelegateV2(victim).execute(it, sig, datas);
    }

    function testJumlahClaimDatasSalahDitolak() public {
        bytes memory data = _claimData(victim, CLAIM_AMOUNT);
        RescueDelegateV2.Intent memory it = _oneClaim(data, 7);
        bytes memory sig = _sign(it, VICTIM_KEY);
        bytes[] memory datas = new bytes[](0);
        vm.expectRevert(RescueDelegateV2.BadClaimData.selector);
        RescueDelegateV2(victim).execute(it, sig, datas);
    }
}
