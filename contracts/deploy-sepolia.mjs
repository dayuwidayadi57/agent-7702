// Deploy lab Sepolia untuk fitur rescue agent-7702.
// Kunci deployer dibaca dari berkas (env DEPLOYER_KEY_FILE), tidak pernah dicetak.
// Menulis hasil ke contracts/sepolia-deployment.json.
import { createWalletClient, createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const W1 = "0xd676d6aE1D57106aB49338243C343D53548382a0"; // dompet uji (keys-w1-v2)
const key = readFileSync(process.env.DEPLOYER_KEY_FILE, "utf8").match(/0x[0-9a-fA-F]{64}/)[0];
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });

function artifact(path) {
  const j = JSON.parse(readFileSync(path, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

async function deploy(name, path) {
  const { abi, bytecode } = artifact(path);
  const hash = await wallet.deployContract({ abi, bytecode, account });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(name, receipt.contractAddress, hash);
  return { address: receipt.contractAddress, abi };
}

async function call(contract, fn, args) {
  const hash = await wallet.writeContract({ address: contract.address, abi: contract.abi, functionName: fn, args, account });
  await pub.waitForTransactionReceipt({ hash });
  console.log("  ", fn, JSON.stringify(args), hash);
}

const rescue = await deploy("RescueDelegate", new URL("./out/RescueDelegate.sol/RescueDelegate.json", import.meta.url).pathname);
const token = await deploy("MockERC20", new URL("./out/Mocks.sol/MockERC20.json", import.meta.url).pathname);
const nft = await deploy("MockERC721", new URL("./out/Mocks.sol/MockERC721.json", import.meta.url).pathname);
const multi = await deploy("MockERC1155", new URL("./out/Mocks.sol/MockERC1155.json", import.meta.url).pathname);

console.log("mint aset uji ke dompet uji", W1);
await call(token, "mint", [W1, 1000n * 10n ** 18n]);
await call(nft, "mint", [W1, 7n]);
await call(multi, "mint", [W1, 42n, 9n]);

const out = {
  chainId: 11155111,
  rescueDelegate: rescue.address,
  mockERC20: token.address,
  mockERC721: nft.address,
  mockERC1155: multi.address,
  testWallet: W1,
  deployer: account.address,
};
writeFileSync(new URL("./sepolia-deployment.json", import.meta.url).pathname, JSON.stringify(out, null, 2));
console.log("tersimpan:", JSON.stringify(out));
