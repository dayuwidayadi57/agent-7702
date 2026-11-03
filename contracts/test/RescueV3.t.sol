// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RescueDelegateV3} from "../src/RescueDelegateV3.sol";
import {MockExoticVault} from "../src/MockExoticVault.sol";
import {MockERC20} from "./Mocks.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function prank(address msgSender) external;
    function deal(address account, uint256 newBalance) external;
    function etch(address target, bytes calldata newRuntimeBytecode) external;
    function expectRevert(bytes4 revertData) external;
}

/// @notice Dependency-free test suite (no forge-std), house style — v3 Relay-Call (kind 5).
contract RescueV3Test {
    Vm private constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    uint256 internal constant VICTIM_KEY = 0xA11CE;
    uint256 internal constant ATTACKER_KEY = 0xBAD;

    RescueDelegateV3 internal rescue;
    MockERC20 internal token; // aset biasa milik korban + token payout vault
    MockERC20 internal bonus; // token kedua (uji disiplin daftar penerus)
    MockExoticVault internal vault;

    address payable internal victim;
    address internal safe = address(0x5AFE);
    address internal relayer = address(0xBE11);
    address internal attacker;

    function setUp() public {
        rescue = new RescueDelegateV3();
        token = new MockERC20();
        bonus = new MockERC20();
        victim = payable(vm.addr(VICTIM_KEY));
        attacker = vm.addr(ATTACKER_KEY);
        vault = new MockExoticVault(address(token), address(bonus));
        token.mint(address(vault), 1000 ether);
        bonus.mint(address(vault), 500 ether);
        vm.deal(address(vault), 1 ether);
        token.mint(victim, 1000 ether); // dana milik korban sendiri — tidak boleh tersentuh
        vm.deal(victim, 1 ether);
        vm.etch(victim, abi.encodePacked(bytes3(0xef0100), bytes20(address(rescue))));
    }

    // ---------- helpers ----------
    function _fwd1(address t) internal pure returns (address[] memory) {
        address[] memory f = new address[](1);
        f[0] = t;
        return f;
    }

    function _callAction(bytes memory data, address[] memory fwd) internal view returns (RescueDelegateV3.Action memory) {
        return RescueDelegateV3.Action({
            kind: 5,
            token: address(0),
            amount: 0,
            tokenId: 0,
            target: address(vault),
            callHash: keccak256(data),
            forwardHash: keccak256(abi.encode(fwd))
        });
    }

    function _intent(RescueDelegateV3.Action[] memory acts, uint256 nonce) internal view returns (RescueDelegateV3.Intent memory) {
        return RescueDelegateV3.Intent({to: safe, nonce: nonce, expiry: block.timestamp + 1 hours, actions: acts});
    }

    function _sign(RescueDelegateV3.Intent memory it, uint256 key) internal returns (bytes memory) {
        bytes32 digest = RescueDelegateV3(victim).hashIntent(it);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _oneCall(bytes memory data, address[] memory fwd, uint256 nonce) internal view returns (RescueDelegateV3.Intent memory) {
        RescueDelegateV3.Action[] memory acts = new RescueDelegateV3.Action[](1);
        acts[0] = _callAction(data, fwd);
        return _intent(acts, nonce);
    }

    function _datas1(bytes memory d) internal pure returns (bytes[] memory) {
        bytes[] memory ds = new bytes[](1);
        ds[0] = d;
        return ds;
    }

    function _sets1(address[] memory f) internal pure returns (address[][] memory) {
        address[][] memory ss = new address[][](1);
        ss[0] = f;
        return ss;
    }

    function _assert(bool cond, string memory what) internal pure {
        if (!cond) revert(what);
    }

    // ---------- tests ----------
    function testRelayCallAtomik() public {
        bytes memory data = abi.encodeWithSignature("releaseVested()");
        address[] memory fwd = _fwd1(address(token));
        RescueDelegateV3.Intent memory it = _oneCall(data, fwd, 1);
        bytes memory sig = _sign(it, VICTIM_KEY);
        vm.prank(relayer);
        RescueDelegateV3(victim).execute(it, sig, _datas1(data), _sets1(fwd));
        _assert(token.balanceOf(safe) == 250 ether, "gain token harus tiba di tujuan");
        _assert(safe.balance == 0.01 ether, "gain native harus tiba di tujuan");
        _assert(token.balanceOf(victim) == 1000 ether, "dana token milik korban tidak boleh tersentuh");
        _assert(victim.balance == 1 ether, "native milik korban tidak boleh tersentuh");
        _assert(vault.released(victim), "vault harus menandai sudah rilis");
    }

    function testRelayCallCalldataDitukar() public {
        bytes memory legit = abi.encodeWithSignature("releaseVested()");
        address[] memory fwd = _fwd1(address(token));
        RescueDelegateV3.Intent memory it = _oneCall(legit, fwd, 2);
        bytes memory sig = _sign(it, VICTIM_KEY);
        // Relayer menyerahkan calldata LAIN (releaseBonus) — hash tidak cocok.
        RescueDelegateV3(victim).execute(it, sig, _datas1(abi.encodeWithSignature("releaseBonus()")), _sets1(fwd));
        _assert(!vault.released(victim), "calldata tertukar tidak boleh memanggil vault");
        _assert(!vault.bonusReleased(victim), "bonus tidak boleh rilis");
        _assert(token.balanceOf(safe) == 0 && safe.balance == 0, "tidak boleh ada yang tiba di tujuan");
    }

    function testRelayCallTargetRevertTerisolasi() public {
        bytes memory bad = abi.encodeWithSignature("brokenRelease()");
        address[] memory fwd = _fwd1(address(token));
        RescueDelegateV3.Action[] memory acts = new RescueDelegateV3.Action[](2);
        acts[0] = _callAction(bad, fwd);
        acts[1] = RescueDelegateV3.Action({
            kind: 1, token: address(token), amount: 100 ether, tokenId: 0, target: address(0), callHash: bytes32(0), forwardHash: bytes32(0)
        });
        RescueDelegateV3.Intent memory it = _intent(acts, 3);
        bytes memory sig = _sign(it, VICTIM_KEY);
        RescueDelegateV3(victim).execute(it, sig, _datas1(bad), _sets1(fwd));
        _assert(token.balanceOf(safe) == 100 ether, "aksi sehat harus tetap terpanen");
        _assert(!vault.released(victim), "panggilan revert tidak menandai apa pun");
    }

    function testForwardSetDitukar() public {
        bytes memory data = abi.encodeWithSignature("releaseVested()");
        address[] memory committed = _fwd1(address(token));
        RescueDelegateV3.Intent memory it = _oneCall(data, committed, 4);
        bytes memory sig = _sign(it, VICTIM_KEY);
        // Relayer mengganti daftar penerus dengan token bonus — hash gagal.
        RescueDelegateV3(victim).execute(it, sig, _datas1(data), _sets1(_fwd1(address(bonus))));
        _assert(!vault.released(victim), "daftar penerus tertukar: vault tidak boleh dipanggil");
        _assert(token.balanceOf(safe) == 0, "tidak boleh ada gain di tujuan");
    }

    function testGainTokenTakTerdaftarTetapDiDompet() public {
        bytes memory data = abi.encodeWithSignature("releaseBonus()");
        address[] memory fwd = _fwd1(address(token)); // bonus TIDAK didaftarkan
        RescueDelegateV3.Intent memory it = _oneCall(data, fwd, 5);
        bytes memory sig = _sign(it, VICTIM_KEY);
        RescueDelegateV3(victim).execute(it, sig, _datas1(data), _sets1(fwd));
        _assert(vault.bonusReleased(victim), "panggilan bonus harus berjalan");
        _assert(bonus.balanceOf(victim) == 40 ether, "gain tak terdaftar tetap di dompet");
        _assert(bonus.balanceOf(safe) == 0, "tujuan tidak menerima token tak terdaftar");
    }

    function testRelayCallReplayDitolak() public {
        bytes memory data = abi.encodeWithSignature("releaseVested()");
        address[] memory fwd = _fwd1(address(token));
        RescueDelegateV3.Intent memory it = _oneCall(data, fwd, 6);
        bytes memory sig = _sign(it, VICTIM_KEY);
        RescueDelegateV3(victim).execute(it, sig, _datas1(data), _sets1(fwd));
        vm.expectRevert(RescueDelegateV3.IntentAlreadyUsed.selector);
        RescueDelegateV3(victim).execute(it, sig, _datas1(data), _sets1(fwd));
    }

    function testRelayCallTandaTanganOrangLain() public {
        bytes memory data = abi.encodeWithSignature("releaseVested()");
        address[] memory fwd = _fwd1(address(token));
        RescueDelegateV3.Intent memory it = _oneCall(data, fwd, 7);
        bytes memory sig = _sign(it, ATTACKER_KEY);
        vm.expectRevert(RescueDelegateV3.BadSignature.selector);
        RescueDelegateV3(victim).execute(it, sig, _datas1(data), _sets1(fwd));
    }

    function testJumlahDatasSalahDitolak() public {
        bytes memory data = abi.encodeWithSignature("releaseVested()");
        address[] memory fwd = _fwd1(address(token));
        RescueDelegateV3.Intent memory it = _oneCall(data, fwd, 8);
        bytes memory sig = _sign(it, VICTIM_KEY);
        vm.expectRevert(RescueDelegateV3.BadCallData.selector);
        RescueDelegateV3(victim).execute(it, sig, new bytes[](0), _sets1(fwd));
    }

    function testJumlahForwardSetsSalahDitolak() public {
        bytes memory data = abi.encodeWithSignature("releaseVested()");
        address[] memory fwd = _fwd1(address(token));
        RescueDelegateV3.Intent memory it = _oneCall(data, fwd, 9);
        bytes memory sig = _sign(it, VICTIM_KEY);
        vm.expectRevert(RescueDelegateV3.BadCallData.selector);
        RescueDelegateV3(victim).execute(it, sig, _datas1(data), new address[][](0));
    }
}
