# agent-7702

A command-line tool for diagnosing and healing EIP-7702 wallet delegations —
built by an EIP-7702 drainer victim, for victims and the agents helping them.

EIP-7702 lets an ordinary wallet delegate its code to a contract. Attackers
abuse signed authorizations to install *drainer* delegates: from that moment
the attacker's code controls the wallet, anything deposited is swept within
seconds, and the owner cannot even pay gas to fight back. `agent7702` is the
countermeasure toolkit: diagnose any wallet across 7 chains, revoke a hostile
delegation with a relayer paying the gas, move whatever assets remain to a
safe address, and even claim an airdrop out of a still-delegated wallet —
atomically, before a drainer can grab it.

## Availability — read this first

Supported chains: Ethereum, Base, BSC, Arbitrum, Optimism, Polygon, Sepolia.

**Works on all 7 chains today**

- `check` — multichain delegation diagnosis with known-drainer labels
  (read-only; verified live against real delegated wallets on all 7 chains)
- `sign-revoke` / `revoke` / `submit` — revoke or install authorizations,
  delivered by a gas-paying relayer; revocation target is hard-locked to the
  zero address, installations are registry-gated (known drainers refused at
  both the signing and the submission layer)
- `sign-auth` / `delegate` — install a delegation to a chosen contract
  (e.g. a smart-account upgrade)
- `relayer new|status|sweep|burn` — relayers under a strict float-security
  model (small floats, balance preflight, ephemeral per-mission keys)
- `assets` / `topup` / `send-token` / `send-nft` / `rescue` — Path A asset
  rescue, with a mission journal so an interrupted rescue resumes without
  double-sending

**Sepolia only for now**

- `sign-intent` / `execute` / `atomic-rescue` — Atomic Rescue (Path B)
- `claim-check` / `claim-rescue` — Atomic Claim Rescue for airdrops

The RescueDelegate contracts are deployed per chain and listed in an
in-package registry; today that registry contains Sepolia only. On other
chains these commands refuse cleanly instead of improvising. All
state-changing flows are verified end-to-end on Sepolia (contract suites:
14/14 forge tests; every live figure cross-checked on-chain).

## Install

```bash
npm install -g agent-7702     # commands: agent7702 (alias: agent-7702)
agent7702 --version           # 0.4.0
# or without installing:
npx agent-7702 check 0xYourAddress
```

Requires Node.js ≥ 18. Keys are **always** read from files — never from
command-line arguments or chat.

## Quickstart

```bash
# 1. Diagnose a wallet across all chains
agent7702 check 0xVictimAddress

# 2. Revoke a hostile delegation on one chain (dry-run first; add --execute)
agent7702 revoke --chain base --wallet-file victim-key.txt --relayer-file relayer-key.txt

# 3. Rescue remaining assets to a safe address
agent7702 rescue --chain base --wallet-file victim-key.txt --relayer-file relayer-key.txt \
  --to 0xSafeAddress --assets mission.json --execute
```

The victim wallet never needs to hold any coin: in the atomic paths the
relayer pays for everything; in Path A the relayer pays the revocation and
sends gas dust — only *after* the wallet is clean, because funding a
still-delegated wallet feeds its drainer (`topup` refuses delegated targets).

## Safety model, briefly

- Revocation can only ever target the zero address — there is no flag,
  config, or code path that turns `sign-revoke` into an installation.
- Installations must target a deployed contract; known drainers are refused
  twice (signing and submission, including foreign authorization files).
- Claim calldata is committed by hash into the owner's signed intent; a
  relayer that substitutes different calldata achieves nothing.
- Relayers hold tiny floats with per-chain guidance, are topped up from a
  treasury, and can be swept and burned after a mission.

See **SKILL.md** (included) for the complete operating manual, workflows,
and safety rules; contract sources and their forge tests are under
`contracts/` for independent audit.

## History

The project began as `doctor7702` (revoke-only) and was unified by its owner
into `agent-7702` on 2026-10-31, keeping both directions in one tool behind
the guardrails above. Release history: `CHANGELOG.md`.

## License

MIT — see `LICENSE`.
