// Deploys PlayerRegistry, MockRandomnessProvider, and GameManager to BSC
// Testnet (chainId 97). MockRandomnessProvider is dev/testnet-only (see its
// NatSpec) - this script must never be pointed at BSC mainnet.
//
// Required env vars:
//   TESTNET_DEPLOYER_KEY   - funded (testnet BNB) deployer private key
//   TESTNET_RPC_URL        - defaults to a public BSC testnet RPC

import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.TESTNET_RPC_URL ?? "https://bsc-testnet-rpc.publicnode.com";
const DEPLOYER_KEY = process.env.TESTNET_DEPLOYER_KEY;
if (!DEPLOYER_KEY) {
  console.error("TESTNET_DEPLOYER_KEY is required");
  process.exit(1);
}

const chain = {
  id: 97,
  name: "bsc-testnet",
  nativeCurrency: { name: "BNB", symbol: "tBNB", decimals: 18 },
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
  return { address: receipt.contractAddress, hash };
}

const artifactsBase = join(__dirname, "..", "..", "contracts", "artifacts", "contracts");
const playerRegistryArtifact = loadArtifact(join(artifactsBase, "PlayerRegistry.sol", "PlayerRegistry.json"));
const mockRandomnessArtifact = loadArtifact(join(artifactsBase, "randomness", "MockRandomnessProvider.sol", "MockRandomnessProvider.json"));
const gameManagerArtifact = loadArtifact(join(artifactsBase, "GameManager.sol", "GameManager.json"));

const admin = account.address;
const arbiter = account.address;

console.log(`Deploying from ${admin} on chain ${chain.id} (${RPC_URL})`);

const playerRegistry = await deploy(playerRegistryArtifact, [admin]);
console.log("PlayerRegistry:", playerRegistry.address, playerRegistry.hash);

const randomness = await deploy(mockRandomnessArtifact, []);
console.log("MockRandomnessProvider:", randomness.address, randomness.hash);

const gameManager = await deploy(gameManagerArtifact, [admin, arbiter, playerRegistry.address, randomness.address]);
console.log("GameManager:", gameManager.address, gameManager.hash);

const roleHash = await publicClient.readContract({
  address: playerRegistry.address,
  abi: playerRegistryArtifact.abi,
  functionName: "GAME_MANAGER_ROLE",
});
const grantHash = await walletClient.writeContract({
  address: playerRegistry.address,
  abi: playerRegistryArtifact.abi,
  functionName: "grantRole",
  args: [roleHash, gameManager.address],
});
await publicClient.waitForTransactionReceipt({ hash: grantHash });
console.log("Granted GAME_MANAGER_ROLE to GameManager");

const output = {
  chainId: chain.id,
  playerRegistryAddress: playerRegistry.address,
  randomnessAddress: randomness.address,
  gameManagerAddress: gameManager.address,
  deployer: admin,
  deployedAt: new Date().toISOString(),
};
const outputPath = join(__dirname, "deployed-addresses.testnet.json");
writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(`Addresses written to ${outputPath}`);
