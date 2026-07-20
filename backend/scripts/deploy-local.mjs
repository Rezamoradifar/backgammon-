// Deploys PlayerRegistry, MockRandomnessProvider, and GameManager to a local
// Hardhat node for manual/local end-to-end testing. Never use this script -
// or the MockRandomnessProvider it deploys - against a real network. See
// README.md's "Local end-to-end testing" section for the full walkthrough
// (start the node, run this, then run the backend against the printed
// addresses).

import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8545";
// Well-known local Hardhat account #0 - public private key, local dev chain only.
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const chain = {
  id: 31337,
  name: "hardhat-local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

const account = privateKeyToAccount(DEPLOYER_KEY);
const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) });
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

function loadArtifact(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function deploy(artifact, args = []) {
  const hash = await walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return receipt.contractAddress;
}

const artifactsBase = join(__dirname, "..", "..", "contracts", "artifacts", "contracts");
const playerRegistryArtifact = loadArtifact(join(artifactsBase, "PlayerRegistry.sol", "PlayerRegistry.json"));
const mockRandomnessArtifact = loadArtifact(join(artifactsBase, "randomness", "MockRandomnessProvider.sol", "MockRandomnessProvider.json"));
const gameManagerArtifact = loadArtifact(join(artifactsBase, "GameManager.sol", "GameManager.json"));

const admin = account.address;
const arbiter = account.address;

const playerRegistryAddress = await deploy(playerRegistryArtifact, [admin]);
console.log("PlayerRegistry:", playerRegistryAddress);

const randomnessAddress = await deploy(mockRandomnessArtifact, []);
console.log("MockRandomnessProvider:", randomnessAddress);

const gameManagerAddress = await deploy(gameManagerArtifact, [admin, arbiter, playerRegistryAddress, randomnessAddress]);
console.log("GameManager:", gameManagerAddress);

const roleHash = await publicClient.readContract({
  address: playerRegistryAddress,
  abi: playerRegistryArtifact.abi,
  functionName: "GAME_MANAGER_ROLE",
});
const grantHash = await walletClient.writeContract({
  address: playerRegistryAddress,
  abi: playerRegistryArtifact.abi,
  functionName: "grantRole",
  args: [roleHash, gameManagerAddress],
});
await publicClient.waitForTransactionReceipt({ hash: grantHash });
console.log("Granted GAME_MANAGER_ROLE to GameManager");

const outputPath = join(__dirname, "deployed-addresses.local.json");
writeFileSync(outputPath, JSON.stringify({ playerRegistryAddress, randomnessAddress, gameManagerAddress, deployer: admin }, null, 2));
console.log(`Addresses written to ${outputPath}`);
