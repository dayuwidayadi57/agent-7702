#!/usr/bin/env node
// Watchdog relayer Doctor EIP-7702: membandingkan status relayer tetap
// (saldo + nonce per chain) dengan potret terakhir di
// ~/.agent7702/watchdog-state.json, lalu melaporkan perubahannya sebagai
// JSON. Dirancang untuk dipasang ke hook/cron operator: setiap kenaikan
// nonce / penurunan saldo yang TIDAK cocok dengan misi penyembuhan yang
// sedang berjalan harus diperlakukan sebagai alarm (kunci mungkin bocor).
//
// Pemakaian: node scripts/watchdog.mjs [--init]
//   --init  tulis potret awal tanpa melaporkan perubahan.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { relayerStatus } from "../lib/core.mjs";

const STATE = join(homedir(), ".agent7702", "watchdog-state.json");
const init = process.argv.includes("--init");

const rows = await relayerStatus();
const snapshot = {};
for (const r of rows) if (r.exists) snapshot[r.chain] = { address: r.address, balance: r.balance, nonce: r.nonce };

let prev = null;
try { prev = JSON.parse(readFileSync(STATE, "utf8")); } catch { /* belum ada potret */ }

const changes = [];
if (prev && !init) {
  for (const [chain, cur] of Object.entries(snapshot)) {
    const old = prev[chain];
    if (!old) { changes.push({ chain, kind: "relayer-baru", address: cur.address }); continue; }
    if (old.address !== cur.address) changes.push({ chain, kind: "alamat-berubah", from: old.address, to: cur.address });
    if (cur.nonce !== old.nonce) changes.push({ chain, kind: "nonce-berubah", from: old.nonce, to: cur.nonce, address: cur.address });
    if (cur.balance !== old.balance) changes.push({ chain, kind: "saldo-berubah", from: old.balance, to: cur.balance, address: cur.address });
  }
  for (const chain of Object.keys(prev)) if (!snapshot[chain]) changes.push({ chain, kind: "relayer-hilang" });
}

mkdirSync(dirname(STATE), { recursive: true, mode: 0o700 });
writeFileSync(STATE, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), baseline: init || !prev ? "ditulis" : "dibandingkan", changes }, null, 2));
