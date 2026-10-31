import { mainnet, base, bsc, arbitrum, optimism, polygon, sepolia } from "viem/chains";

// Chain yang didukung Doctor EIP-7702 CLI.
export const CHAINS = {
  ethereum: { chain: mainnet, rpc: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io" },
  mainnet: { chain: mainnet, rpc: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io" },
  base: { chain: base, rpc: "https://mainnet.base.org", explorer: "https://basescan.org" },
  bsc: { chain: bsc, rpc: "https://bsc-dataseed.binance.org", explorer: "https://bscscan.com" },
  arbitrum: { chain: arbitrum, rpc: "https://arb1.arbitrum.io/rpc", explorer: "https://arbiscan.io" },
  optimism: { chain: optimism, rpc: "https://mainnet.optimism.io", explorer: "https://optimistic.etherscan.io" },
  polygon: { chain: polygon, rpc: "https://polygon.drpc.org", explorer: "https://polygonscan.com" },
  sepolia: { chain: sepolia, rpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io" },
};

export const DEFAULT_CHAIN_NAMES = ["ethereum", "base", "bsc", "arbitrum", "optimism", "polygon", "sepolia"];

export function resolveChain(nameOrId) {
  if (nameOrId == null) return null;
  const byName = CHAINS[String(nameOrId).toLowerCase()];
  if (byName) return { name: String(nameOrId).toLowerCase(), ...byName };
  const id = Number(nameOrId);
  for (const [name, info] of Object.entries(CHAINS)) {
    if (info.chain.id === id) return { name, ...info };
  }
  return null;
}
