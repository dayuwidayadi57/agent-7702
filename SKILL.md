---
name: agent-7702
description: Operate EIP-7702 authorizations with the agent7702 CLI — diagnose any EVM address for an active delegation across Ethereum, Base, BSC, Arbitrum, Optimism, Polygon and Sepolia; revoke a delegation safely (sign-revoke, target hard-locked to the zero address); install a delegation to a chosen contract (sign-auth, e.g. upgrading an EOA to a Smart Account) behind a two-way trust registry that refuses known drainers at both the signing and the submission layer; and submit any authorization through a gas-paying relayer run under a strict float-security model. Formerly named doctor7702 (revoke-only); the owner unified both directions into this one tool on 2026-10-31.
---

# agent-7702 — agent skill

> Current CLI version **0.6.0** — check with `agent7702 --version`; release history lives in the package's `CHANGELOG.md`. The EIP-712 intent domain versions ("1" for v1 / "2" for v2 / "3" for v3 / "4" for v4) are contract protocol versions, separate from the CLI version.

## What this is

EIP-7702 lets an EOA delegate its code to a contract (`0xef0100` + address).
The mechanism runs on one object: an **authorization** signed by the wallet
owner — `(chainId, address, nonce)`. The `address` field decides everything:

- `address = zeroAddress` → **revocation**: the delegation is erased, the
  wallet becomes a plain EOA again. This is how drained wallets are healed.
- `address = a contract` → **installation**: that contract's code now runs
  the wallet. This is how an EOA upgrades to a Smart Account — and also how
  drainers take wallets over when the contract is malicious.

`agent7702` covers both directions plus diagnosis, with the relayer pattern
throughout: the owner signs off-chain (free, key never leaves their machine),
a separate relayer wallet submits the type-4 transaction and pays gas (a
delegated wallet must never be funded — deposits get swept).

Built from a real drainer-victim case; every flow is verified live on Sepolia.

## Prerequisites

Install these before operating. Verify each one live — never assume a
session or binary survived an environment replacement.

1. **Node.js ≥ 18 + npm** — the CLI runtime (dependency: viem, installed by
   `npm install` below).
2. **Binance Agentic Wallet (`baw`) — the treasury.** In this skill's
   relayer security model the gas stock lives in an Agentic Wallet and
   relayers are topped up from it (see "Relayer security model"). Diagnosis
   and the authorizations themselves do not require BAW — any funding source
   works — but BAW is the assumed standard for holding the treasury.
   ```bash
   npm install -g @binance/agentic-wallet@1.12.0   # v1.12.0 = latest verified 2026-10-31; check for newer
   baw wallet status                               # must not say "Not logged in"
   ```
   On a fresh machine (or an environment that was reset) `baw` may be
   missing — reinstall it when `baw wallet status` cannot run at all. Pairing (the operator confirms in the Binance app) and all BAW
   operations are governed by the separate **binance-agentic-wallet** skill:
   load and follow that skill for anything BAW; do not improvise BAW
   commands from this document.
   *Why not relay directly from the Agentic Wallet? BAW's contract-call has
   no EIP-7702 support (no authorizationList / type-4), verified 2026-10-31 —
   it cannot originate these transactions. If Binance adds it, prefer that
   and retire key-file relayers.*
3. **Optional: Foundry (`cast`)** for independent on-chain verification of
   results (`cast code <address> --rpc-url <rpc>`):
   ```bash
   curl -L https://foundry.paradigm.xyz | bash   # then: foundryup
   export PATH="$HOME/.foundry/bin:$PATH"        # binaries live under ~ and persist
   ```
4. **State directories** (auto-created by the CLI, mode 700):
   `~/.agent7702/relayers/` for relayer key files (mode 600).

## Install

Requires Node.js ≥ 18 (single dependency: viem).

```bash
npm install -g agent-7702     # provides `agent7702` (alias: `agent-7702`)
agent7702 --version
# From a source checkout instead:
npm install && npm install -g .   # inside the package directory
# Or run without installing:
npx agent-7702 <command>          # via npm
node bin/agent7702.mjs <command>  # from a source checkout
```

## Commands

### Diagnose (read-only, no keys)
```bash
agent7702 check <address> [--chains ethereum,base,bsc,arbitrum,optimism,polygon,sepolia] [--json]
```
Exit codes: `0` = no delegation anywhere checked, `2` = at least one active
delegation, `1` = error. Delegates are labeled from the built-in registries
(known drainers; known-good implementations).

### Revoke — the healing direction (target hard-locked to zero)
```bash
agent7702 sign-revoke --chain <chain> --wallet-file <key-file> [--nonce <n>] [--json]
agent7702 revoke --chain <chain> --wallet-file <key-file> --relayer-file <key-file> [--execute] [--json]
```
`revoke` without `--execute` only previews (current code, current delegate,
the exact authorization payload). With `--execute` it submits via the
relayer and reports `SEMBUH: YA` only when the code is verified back to `0x`.

### Install — the powerful direction (registry-gated)
```bash
agent7702 sign-auth --chain <chain> --to <contract> --wallet-file <key-file> [--any-chain] [--nonce <n>] [--json]
agent7702 delegate --chain <chain> --to <contract> --wallet-file <key-file> --relayer-file <key-file> [--execute] [--json]
```
Hard gates, enforced in code (not policy):
- A target listed in the **known-drainer registry is refused** — at signing
  AND again at submission (an auth file produced by any other tool is
  refused by `submit` too).
- The target **must be a deployed contract** on the chosen chain (empty code
  is refused). The zero address is refused here — that is revocation's job.
- **Chain is explicit.** `--any-chain` (chainId 0, valid on every chain)
  exists only as an explicit flag and is always printed with a warning.
- Unknown targets are allowed (this is the owner's own wallet tool) but the
  preview labels them `TIDAK DIKENAL` and states plainly that the target's
  code will control the wallet. Known-good targets show their registry
  label. `delegate` without `--execute` is a full dry-run preview.

### Submit a signed authorization (relayer pays gas)
```bash
agent7702 submit --chain <chain> --relayer-file <key-file> --auth <auth.json|->
```
Works for revocations and installations signed anywhere (including by the
owner on another machine). Refuses known-drainer targets and chainId
mismatches, runs the relayer balance preflight, waits for the receipt, and
verifies the authority's resulting code.

### Relayer management
```bash
agent7702 relayer new --chain <chain> [--ephemeral] [--json]
agent7702 relayer status [--chains a,b,c] [--json]
agent7702 relayer sweep --chain <chain> --relayer-file <key-file> --to <treasury-address> [--json]
agent7702 relayer burn --file <file-inside-relayer-dir> [--json]
```
Keys live in `~/.agent7702/relayers/` (dir 700, files 600) and are never
printed. `submit`/`revoke`/`delegate` with `--execute` run a **balance
preflight** and refuse to send when the relayer float cannot cover the
estimated cost.

### Asset rescue — Path A (after the wallet is clean)
```bash
agent7702 assets <address> --chain <chain> [--token <addr> ...] [--json]
agent7702 topup --chain <chain> --relayer-file <key-file> --to <clean-wallet> [--amount <n>] [--json]
agent7702 send-token --chain <chain> --wallet-file <key-file> --token <addr> --to <dest> (--amount <n>|--all) [--execute] [--json]
agent7702 send-nft --chain <chain> --wallet-file <key-file> --token <addr> --id <n> [--amount <n>] --to <dest> [--execute] [--json]
agent7702 rescue --chain <chain> --wallet-file <key-file> --relayer-file <key-file> --to <safe> --assets <file.json> [--execute] [--json]
```
`topup` **refuses any target whose code is not `0x`** — funding a delegated
wallet feeds its drainer. Asset moves are always signed by the owner wallet
itself; the relayer only pays for the revocation and the gas dust. The
assets file lists actions as `{kind, token, amount(raw units), tokenId}`
(kind 0 native, 1 ERC20, 2 ERC721, 3 ERC1155). `rescue` orchestrates:
revoke (if delegated) → topup (skipped when the wallet already holds enough
native) → per-action sends → native sweep → final check. **Mission journal:** `rescue` records every confirmed action in `<assets>.journal.json` (created next to the assets file, updated immediately after each send). Re-running the same mission skips journal-completed actions and a recorded native sweep, so an interrupted rescue can be resumed safely without double-sending. The journal is bound to (chain, wallet, destination) — a mismatch is refused; start a genuinely new mission with `--fresh` or by deleting the journal file.

### Mission — the UNIFIED rescue (RescueDelegateV4, primary path)

```bash
agent7702 mission --chain <chain> --wallet-file <key-file> --relayer-file <key-file> --to <safe> --assets <mission.json> [--ttl <minutes>] [--execute] [--json]
```

One command, one intent, one delegate for every rescue shape that used
to need three separate flows. The mission file is the usual
`{actions: [...]}` JSON, and a single intent may mix **all** action
kinds: 0 native, 1 ERC20, 2 ERC721, 3 ERC1155 (transfers), 4 CLAIM
(`claim: {contract, data}` — entire gain of the reward token forwarded),
and 5 CALL (`call: {contract, data}`, `forward: [tokens]` — gains
forwarded), executed atomically by **RescueDelegateV4** (EIP-712 domain
version `"4"`). New in V4: a kind-5 call may carry a **committed native
value** (`value`, wei as a string, default `"0"`) — the exact amount the
call spends from the wallet's own balance, locked into the signed intent
so no relayer can alter it; forwarding is computed net of that committed
spend, and a value the balance cannot cover fails that one action in
isolation while the rest of the mission runs. This covers
pay-to-unlock / fee-gated functions the earlier delegates could not
touch (value was locked to 0 there).

The discipline is unchanged and enforced before any signature: blocked
selectors (`approve`, `increaseAllowance`, `setApprovalForAll`,
`transfer`, `transferFrom`, `safeTransferFrom`) are refused while the
intent is being built, and **every kind-4/5 call must pass an `eth_call`
simulation from the wallet's address** or the mission is cancelled —
even for a dry run. Without `--execute`, `mission` prints the full
preview (per-action lines, simulation verdicts). With `--execute` it
runs the atomic type-4 transaction, then the closing `revoke`, then
reports the destination's verified gains.

Registry: `RESCUE_DELEGATES_V4` in `lib/rescue.mjs` — deployed on
**BSC mainnet** (`0x23c35334fd72302C6A58e379591d9c2F0833709D`, deployed
2026-11-05 via the canonical CREATE2 deployer with salt
`keccak256("RESCUEDELEGATE-V4")`; on-chain bytecode verified
byte-for-byte against the build artifact; see
`contracts/mainnet-deployment-v4.json`) and on **Sepolia**
(`0x759bcEFaF488CcbD652f6114a8bddCd6D4440464`, deployed 2026-11-04;
bytecode likewise verified, and a live mixed mission — claim +
committed-value call + sweep — executed end-to-end through `mission`
itself; see `contracts/sepolia-deployment-v4.json` and DESIGN §14).
The command refuses cleanly on any chain without a registered V4
delegate. The three flows below remain functional for Sepolia V1–V3
missions and are kept as **legacy**.

### Atomic Rescue — Path B (harvest during a benign-delegation window) — legacy, Sepolia
```bash
agent7702 sign-intent --chain <chain> --wallet-file <key-file> --to <safe> --assets <file.json> [--ttl <minutes>] [--json]
agent7702 execute --chain <chain> --relayer-file <key-file> --auth <file> --intent <file> [--json]
agent7702 atomic-rescue --chain <chain> --wallet-file <key-file> --relayer-file <key-file> --to <safe> --assets <file.json> [--ttl <minutes>] [--execute] [--json]
```
The RescueDelegate contract (source: `contracts/src/RescueDelegate.sol` in
the package repo; per-chain addresses in `lib/rescue.mjs`) executes ONLY an
EIP-712 intent signed by the wallet owner: one destination, an intent
nonce, an expiry, and transfer-only actions (native/ERC20/ERC721/ERC1155).
`execute` sends ONE type-4 transaction whose authorization installs the
RescueDelegate and whose call harvests — atomically, leaving no gap for a
drainer holding spare authorizations to interleave. `atomic-rescue` is the
one-shot form (sign-auth + sign-intent → atomic execute → closing revoke →
verification).

### Atomic Claim Rescue — claiming an airdrop from a drained wallet — legacy, Sepolia

*Legacy: new claim missions should use `mission` (kind-4 actions) on
RescueDelegateV4 where it is registered; this V2 flow stays for Sepolia.*
```bash
agent7702 claim-check <contract> --chain <chain> --wallet <address> [--allocation <file.json>] [--out <assets.json>] [--json]
agent7702 claim-rescue --chain <chain> --wallet-file <key-file> --relayer-file <key-file> --to <safe> --assets <file.json> [--ttl <minutes>] [--execute] [--json]
```
The case this defeats: an airdrop becomes claimable by a wallet that is
delegated to a drainer — claiming credits the wallet, and the drainer's
code sweeps whatever lands (the owner's real ERA/Caldera loss).
`claim-check` is the read-only recon step: it identifies the reward token
and claim function (verified ABI from Blockscout; if unverified, common
claim shapes — MerkleDistributor first — are proven by eth_call
simulation), reads the already-claimed status, and, given an allocation
file `{index, amount, proof}` from the project's data, **verifies the
allocation by simulation** and writes a ready-to-use assets file holding
one kind-4 (CLAIM) action. Never sign an allocation that has not passed
this simulation.
`claim-rescue` runs the mission against **RescueDelegateV2** (per-chain
registry in `lib/rescue.mjs`; domain version "2"): the intent commits
{claim contract, reward token, keccak256(calldata)}; the delegate calls
the claim AS the wallet itself and forwards the entire balance GAIN of
the reward token to the destination — the claimed tokens never rest in
the delegated wallet, and the relayer cannot substitute different
calldata (hash mismatch = the action fails, nothing moves). The closing
revoke follows as usual. Other tokens a claim might also send are NOT
touched by a claim action; a follow-up `rescue` handles them.

**Protocol fact (verified live on Sepolia):** if the atomic transaction's
call reverts (e.g. expired intent), the **delegation install is NOT rolled
back** — the wallet stays delegated to the RescueDelegate and the intent's
authorization nonce is consumed. This is safe with our delegate (inert
without an owner signature) but the closing `revoke` is then MANDATORY,
and any retry needs a freshly signed authorization (new nonce).

### Relay-Call — a general contract call, owner-committed and relayed — legacy, Sepolia

*Legacy: new general-call missions should use `mission` (kind-5
actions, optionally with a committed `value`) on RescueDelegateV4 where
it is registered; this V3 flow stays for Sepolia.*

For contract functions the Claim Rescue templates don't cover — a custom
claim shape, an unstake, a withdraw — `relay-call` generalizes the claim
action: the call runs **as the wallet**, a relayer pays the gas, and the
call's contents are locked by the owner's signature. It is NOT a free-form
contract call like a general wallet's; the guardrails below are the feature.

`call-check <target> --chain <chain> --wallet <addr> --data <0x…> [--forward <token,token>] [--signature "releaseVested()"]`
is the read-only gate: it verifies the target is a deployed contract and
not a known drainer, classifies the selector, and simulates the exact
calldata with `eth_call` from the wallet's address. Verdicts: `DITOLAK`
(hard guardrail), `SIMULASI GAGAL`, `LOLOS`. **Never sign a call that has
not passed simulation** — the same rule as claim allocations.

`relay-call --chain sepolia --wallet-file <file> --relayer-file <file> --to <safe-address> --target <contract> --data <0x…> [--forward <token,token>] [--execute]`
runs the one-shot mission through **RescueDelegateV3** (EIP-712 domain
version `"3"`, action kind 5 = CALL). The intent commits the target,
`keccak256(calldata)`, and the hash of the forward-token list; the value is
locked to 0. The delegate calls the target as the wallet, then forwards
only the **gains** — native plus each listed token's balance increase —
to the intent's destination; the wallet's own funds are untouched, and
gains in unlisted tokens stay in the wallet for a follow-up mission. A
relayer that substitutes calldata or the forward list fails the hash
check and moves nothing. The closing `revoke` follows as usual, and the
protocol fact above applies unchanged.

**Blocked selectors (refused in code, before any signing):** `approve`,
`increaseAllowance`, `setApprovalForAll`, `transfer`, `transferFrom`,
`safeTransferFrom` — approvals have no place in a rescue mission, and
asset transfers have their own explicit commands. Unknown selectors are
labeled `TIDAK DIKENAL` and proceed only after a passing simulation and
the operator's explicit confirmation.

Registry: RescueDelegateV3 is deployed on **Sepolia only**
(`0xdF057afC121D0c4c29255a86992d924fD334a8C4`); the commands refuse
cleanly on chains without a registered delegate.

### Smart Wallet Batch — one signed batch for everything (BatchCallDelegationV2)

Where the rescue delegates are one-shot mission tools, `batch` turns the
wallet into a **persistent smart account**: BatchCallDelegationV2 stays
installed, and every later action is an owner-signed batch executed by a
relayer. This is the CLI's single smart-wallet execution method — sends,
claims with known amounts, and general calls are all just templates that
build one `Call[]`; there are no separate execution commands per action.

- `batch --chain sepolia --wallet-file <file> [--send <to> <amount>] [--send-token <token> <to> <amount>] [--send-token-raw <token> <to> <raw-units>] [--send-nft <token> <id> <to>] [--send-1155 <token> <id> <amount> <to>] [--call <to> <value> <data-hex>] [--calls <file.json>] [--ttl <minutes, default 30>] [--batch-nonce <n>] [--install] [--sign-only] [--execute --relayer-file <file>]`
- `batch --chain sepolia --intent <file.json> [--execute --relayer-file <file>]` — execute (or preview) a previously signed intent.
- A `--calls` file is a JSON array of `{"to", "value", "data"}` with
  `value` in wei as a string — the way to express mixed batches such as
  claim-then-forward (`claim(...)` on a distributor, then `transfer(...)`
  of the exact claimed amount).

How it works: the owner signs an EIP-712 `Execute` intent (domain
`"BatchCallDelegation"`, version `"2"`, bound to the account and the
chain) committing the exact calls, a batch nonce, and a deadline. When
the delegate is already installed, the CLI cross-checks its locally
computed digest against the account's `getDigest()` before signing.
Execution is always simulation-first: an installed account is simulated
with `eth_call`; the one-shot `--install` form is simulated as a complete
type-4 transaction (authorization list + `executeSigned` calldata) and
then sent as that single type-4 transaction. A stale nonce, an expired
deadline, or a reverting batch is refused **before** anything is sent —
replaying a consumed intent fails the same check.

Rules that differ from the rescue flows, on purpose:

- The delegation is **persistent** — there is no closing revoke. Heal
  with `revoke` when the owner wants the plain EOA back. The batch nonce
  lives in ERC-7201 namespaced storage and **survives revoke and
  re-install**; when signing for an account that used the delegate
  before but is currently clean, pass the correct `--batch-nonce`
  (simulation catches a wrong guess before any transaction is sent).
- The CLI refuses to install the batch delegate over a foreign
  delegation, and the contract refuses batches whose calls target the
  account itself.
- Sensitive selectors inside a batch (`approve`, `setApprovalForAll`,
  `transferFrom`, `permit`, …) are legitimate here — the owner's
  signature is the authority — but they are always surfaced as warnings
  in the preview. **Read every warning before executing.**
- Amounts known only after execution (dynamic claim gains) do NOT
  belong in a batch: transfer amounts are committed at signing time.
  Use `claim-rescue` / `relay-call` for gain-forwarding semantics.

Registry: BatchCallDelegationV2 is deployed on **BSC mainnet**
(`0x40417919600bc4819B975a09992938a409495934`, deployed 2026-11-04 via
CREATE2 with salt `keccak256("BATCHCALLDELEGATION-V2")` — the same salt
and init code produce this same address on any other mainnet chain) and
on **Sepolia** (`0x1591DdA47F3b34a3441d8a4213C1bB51401108a8`); the
command refuses cleanly on chains without a registered delegate.
Further mainnet deployments are a separate owner decision.

## Relayer security model (operator standard)

The relayer is both the gas provider and the executor, so treat its key like
the key to a nearly-empty safe:

1. **Tiny float, treasury elsewhere.** The bulk of the gas money stays in
   the operator's custodial wallet (e.g. a Binance Agentic Wallet — pairing
   + app confirmation, no key files). Standing relayers hold only enough
   for a few operations (per-chain caps are printed by `relayer new` and
   watched by `relayer status`: KOSONG / MENIPIS / MELEBIHI CAP levels).
   Top up just-in-time; `sweep` returns leftovers to the treasury.
2. **One key, one job.** A relayer key is used ONLY by agent7702. Never
   reuse a relayer key for deploys, mints, or other tools. Use a separate
   standing relayer per chain.
3. **Ephemeral relayers for expensive chains.** Per mission: `relayer new
   --ephemeral` → fund the exact estimate → operate → `sweep` → `burn` (the
   burn overwrites the key file with random bytes, then deletes it, and
   refuses any file outside the relayer directory).
4. **Watchdog.** `scripts/watchdog.mjs` snapshots standing relayers
   (address/balance/nonce per chain) to `~/.agent7702/watchdog-state.json`
   and reports diffs as JSON. Wire it to a cron/hook: any nonce or balance
   change that does not match an operation you ran is an alarm — assume the
   key leaked, sweep what remains from a fresh wallet, and rotate.

## Standard workflows

**Heal a drained wallet (per delegated chain, repeat per chain):**
1. `check` the victim address on all chains; note every delegated chain.
2. `revoke` **without** `--execute`; show the owner the preview.
3. Only on the owner's explicit confirmation, re-run with `--execute`
   (relayer funded per the model above).
4. Re-run `check`; report the verified final state per chain. Advise:
   a revocation holds only if the attacker holds no other unused signed
   authorizations (sequential nonces / chainId-0 wildcards) — re-check
   periodically, never reuse the wallet for large funds.

**Upgrade an EOA to a Smart Account:**
1. `check` the wallet (confirm current state) and identify the target
   implementation's registry label; if `unknown`, present the raw facts
   (address, code size, chain) and the control warning before proceeding.
2. `delegate` without `--execute`; show the full preview.
3. On explicit confirmation, `--execute`; verify the code became
   `0xef0100` + target. The universal exit remains `revoke` — if anything
   about the installation misbehaves, revoke to zero and reassess clean.

## Safety rules (non-negotiable)

- **Keys come from files only** (mode 600). Never ask the user to paste a
  private key or seed phrase in chat, never print key material, never pass
  a key as a command-line argument.
- The victim/owner wallet needs **no funds** at any point — do not tell the
  user to top it up; deposits into a still-delegated wallet get swept. The
  relayer pays all gas.
- Signing/transactions follow the user's standing rules: preview first,
  execute only on explicit confirmation for that task.
- A signed authorization file is sensitive while its nonce is unused:
  treat it like a key file; delete after submission.

## Registries

- `lib/drainers.mjs` — known drainer delegates per chain (seeded from
  verified real cases, incl. the Binance sweeper and a 2025 victim case).
- `lib/known-good.mjs` — known-good implementations per chain. Admission:
  verified source, public audit/track record, bytecode hash checked
  on-chain. Currently: Sepolia entries (an internal test delegate,
  BenignDelegate, plus agent-7702's own verified delegates
  RescueDelegate V1/V2/V3, BatchCallDelegationV2, and
  RescueDelegateV4) and the first
  mainnet entry — BatchCallDelegationV2 on BSC (deployed 2026-11-04
  via CREATE2, bytecode verified on-chain). Mainnet smart-account
  implementations are added one at a time, verified.
  **RescueDelegateV4** (the unified mission delegate, DESIGN §14) is
  built and forge-verified — full suite 51/51 including 17 V4 tests —
  and **deployed on BSC mainnet**
  (`0x23c35334fd72302C6A58e379591d9c2F0833709D`, 2026-11-05, via
  CREATE2) and on **Sepolia**
  (`0x759bcEFaF488CcbD652f6114a8bddCd6D4440464`, 2026-11-04), both
  with on-chain bytecode verification, and a live mixed mission
  (claim + committed-value call + sweep) executed through the
  `mission` command itself on Sepolia.

## Data files

- Relayer keys and watchdog state: `~/.agent7702/` (operator-local, mode
  700/600; never part of the package and never printed).
- Rescue mission journals: written next to each mission's assets file as
  `<assets>.journal.json` (see the mission-journal note under Path A).
- Contract sources and their forge test suites ship in this package under
  `contracts/` so the delegates' behavior can be audited independently.
