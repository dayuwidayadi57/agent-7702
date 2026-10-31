// Deploy lab Sepolia v2: RescueDelegateV2 + MockDistributor (kasus ERA).
import { createWalletClient, createPublicClient, http, keccak256, encodeAbiParameters } from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const W1 = "0xd676d6aE1D57106aB49338243C343D53548382a0";
const MOCK = "0x9206acb8eb0c0659dc0ebc023212b7a08824dfa8";
const CLAIM_AMOUNT = 500n * 10n ** 18n;
const key = readFileSync(process.env.DEPLOYER_KEY_FILE, "utf8").match(/0x[0-9a-fA-F]{64}/)[0];
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });

function artifact(path) { const j = JSON.parse(readFileSync(path, "utf8")); return { abi: j.abi, bytecode: j.bytecode.object }; }
async function deploy(name, path, args = []) {
  const { abi, bytecode } = artifact(path);
  const hash = await wallet.deployContract({ abi, bytecode, args, account });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(name, receipt.contractAddress, hash);
  return { address: receipt.contractAddress, abi };
}

const rescueV2 = await deploy("RescueDelegateV2", new URL("./out/RescueDelegateV2.sol/RescueDelegateV2.json", import.meta.url).pathname);
// Daun OZ untuk alokasi dompet uji: index 0, 500 MOCK, pohon satu daun (root = daun, proof = []).
const inner = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "uint256" }], [0n, W1, CLAIM_AMOUNT]));
const leaf = keccak256(inner);
const distributor = await deploy("MockDistributor", new URL("./out/MockDistributor.sol/MockDistributor.json", import.meta.url).pathname, [MOCK, leaf]);
const mockArt = artifact(new URL("./out/Mocks.sol/MockERC20.json", import.meta.url).pathname);
const mintHash = await wallet.writeContract({ address: MOCK, abi: mockArt.abi, functionName: "mint", args: [distributor.address, 1000n * 10n ** 18n], account });
await pub.waitForTransactionReceipt({ hash: mintHash });
console.log("distributor dibiayai 1000 MOCK, tx", mintHash);
const out = { chainId: 11155111, rescueDelegateV2: rescueV2.address, mockDistributor: distributor.address, mockERC20: MOCK, claimAllocation: { index: "0", account: W1, amount: CLAIM_AMOUNT.toString(), proof: [] }, deployer: account.address };
writeFileSync(new URL("./sepolia-deployment-v2.json", import.meta.url).pathname, JSON.stringify(out, null, 2));
console.log("tersimpan:", JSON.stringify(out));
