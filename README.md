<h1 align="center">agent-7702</h1>

<p align="center">
  <em>Diagnose and heal EIP-7702 wallet delegations — from the command line.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agent-7702"><img src="https://img.shields.io/npm/v/agent-7702" alt="npm version"></a>
  <a href="https://github.com/dayuwidayadi57/agent-7702/blob/main/LICENSE"><img src="https://img.shields.io/github/license/dayuwidayadi57/agent-7702" alt="License: MIT"></a>
  <img src="https://img.shields.io/node/v/agent-7702" alt="Node >= 18">
</p>

A command-line tool for diagnosing and healing EIP-7702 wallet delegations —
**built by an EIP-7702 drainer victim, for victims and the agents helping them.**

EIP-7702 lets an ordinary wallet delegate its code to a contract. Attackers
abuse signed authorizations to install *drainer* delegates: from that moment
the attacker's code controls the wallet, anything deposited is swept within
seconds, and the owner cannot even pay gas to fight back. `agent7702` is the
countermeasure toolkit: diagnose any wallet across 7 chains, revoke a hostile
delegation with a relayer paying the gas, move whatever assets remain to a
safe address, and even claim an airdrop out of a still-delegated wallet —
atomically, before the sweeper can move.

## ⚠️ Availability — read this first

| Capability | Availability |
|---|---|
| Diagnosis (`check`) | Ethereum, Base, BSC, Arbitrum, Optimism, Polygon, Sepolia |
| Revoke / delegate / submit | All 7 chains |
| Asset rescue — Path A (`assets`, `topup`, `send-token`, `send-nft`, `rescue`) | All 7 chains |
| Atomic Rescue — Path B (`sign-intent`, `execute`, `atomic-rescue`) | **Sepolia only** (RescueDelegate is deployed there; mainnet deployment is a maintainer decision) |
| Atomic Claim Rescue (`claim-check`, `claim-rescue`) | **Sepolia only** (same reason) |

Everything else in this README works on every supported chain today.

## 📦 Install

```bash
npm install -g agent-7702     # commands: agent7702 (alias: agent-7702)
agent7702 --version

# or without installing:
npx agent-7702 check 0xYourAddress
```

Requires Node.js ≥ 18. Keys are **always** read from files — never from
command-line arguments or chat.

## 🚀 Quickstart

```bash
# 1. Diagnose a wallet across all chains
agent7702 check 0xYourAddress

# 2. Revoke a hostile delegation on one chain (dry-run first; add --execute)
agent7702 revoke --chain base --wallet-file key.txt --relayer-file relayer.key

# 3. Rescue remaining assets to a safe address
agent7702 rescue --chain base --wallet-file key.txt --relayer-file relayer.key \
  --to 0xYourSafeAddress --assets assets.json --execute

# 4. Run a signed smart-wallet batch — sends, claims, any calls (Sepolia)
agent7702 batch --chain sepolia --wallet-file key.txt \
  --send-token 0xTokenAddress 0xRecipient 10 --install --execute --relayer-file relayer.key
```

Every state-changing command is a **dry run unless `--execute` is passed**.

## 🛡️ Safety model, briefly

- **Revoke is hard-locked.** The revoke path can only ever target the zero
  address — it can heal a wallet, never delegate it.
- **Install is registry-gated.** Delegation targets known to be drainers are
  refused at both the signing and the submission layer; unknown targets are
  labeled, never silently trusted.
- **Keys never travel.** Wallet keys sign off-chain from local files; a
  separate relayer key pays gas and holds only a tiny float under a strict
  security model (see SKILL.md).
- **Never fund a delegated wallet.** The tool refuses to top up a wallet
  that is still delegated — that money would be swept.
- **Failed atomics don't strand you.** The workflows always close with a
  revoke and an on-chain verification that the wallet's code is `0x`.

## 🤖 For AI agents

This package ships with a complete operator skill: **[SKILL.md](SKILL.md)**
in this repository (also included in the npm tarball). Point your agent at
it — it covers the full command reference, the relayer security model,
standard workflows, file formats, and the non-negotiable safety rules.

```text
Read and follow the SKILL.md of the agent-7702 package, then operate the agent7702 CLI accordingly.
```

## 📜 History

The tool began as **doctor7702**, a revoke-only healer. Installing a
*benign* delegation (for example upgrading an EOA to a Smart Account, or
the atomic-rescue flows) turned out to belong in the same hands, so both
directions were unified into **agent-7702** — with the install direction
kept behind the registry guardrails described above.

## License

MIT — see [LICENSE](LICENSE).
