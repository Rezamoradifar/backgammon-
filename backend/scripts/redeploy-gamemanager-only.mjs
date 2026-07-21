// Redeploys only GameManager, pointing at the EXISTING PlayerRegistry,
// MockRandomnessProvider, and MockUSDT contracts - used when only
// GameManager's own logic/constants change (e.g. a fee-split retune), so
// existing player registry stats and referral registrations aren't reset.
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

const previous = JSON.parse(readFileSync(join(__dirname, "deployed-addresses.testnet.json"), "utf8"));

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
const gameManagerArtifact = loadArtifact(join(artifactsBase, "GameManager.sol", "GameManager.json"));

const admin = account.address;
const arbiter = account.address;

console.log(`Deploying new GameManager from ${admin} on chain ${chain.id} (${RPC_URL})`);
console.log(`Reusing PlayerRegistry: ${previous.playerRegistryAddress}`);
console.log(`Reusing MockRandomnessProvider: ${previous.randomnessAddress}`);
console.log(`Reusing MockUSDT: ${previous.mockUsdtAddress}`);
console.log(`Fee wallets - owner: ${previous.ownerFeeWallet}, platform: ${previous.platformFeeWallet}, marketing: ${previous.marketingFeeWallet}`);

const gameManager = await deploy(gameManagerArtifact, [
  admin,
  arbiter,
  previous.playerRegistryAddress,
  previous.randomnessAddress,
  previous.ownerFeeWallet,
  previous.platformFeeWallet,
  previous.marketingFeeWallet,
]);
console.log("New GameManager:", gameManager.address, gameManager.hash);

const roleHash = await publicClient.readContract({
  address: previous.playerRegistryAddress,
  abi: playerRegistryArtifact.abi,
  functionName: "GAME_MANAGER_ROLE",
});
const grantHash = await walletClient.writeContract({
  address: previous.playerRegistryAddress,
  abi: playerRegistryArtifact.abi,
  functionName: "grantRole",
  args: [roleHash, gameManager.address],
});
await publicClient.waitForTransactionReceipt({ hash: grantHash });
console.log("Granted GAME_MANAGER_ROLE (on the existing PlayerRegistry) to the new GameManager");

const rewardRoleHash = await publicClient.readContract({
  address: gameManager.address,
  abi: gameManagerArtifact.abi,
  functionName: "REWARD_DISTRIBUTOR_ROLE",
});
const rewardGrantHash = await walletClient.writeContract({
  address: gameManager.address,
  abi: gameManagerArtifact.abi,
  functionName: "grantRole",
  args: [rewardRoleHash, previous.rewardDistributorAddress],
});
await publicClient.waitForTransactionReceipt({ hash: rewardGrantHash });
console.log(`Granted REWARD_DISTRIBUTOR_ROLE to ${previous.rewardDistributorAddress}`);

const allowUsdtHash = await walletClient.writeContract({
  address: gameManager.address,
  abi: gameManagerArtifact.abi,
  functionName: "setStakeTokenAllowed",
  args: [previous.mockUsdtAddress, true],
});
await publicClient.waitForTransactionReceipt({ hash: allowUsdtHash });
console.log(`Allowlisted MockUSDT (${previous.mockUsdtAddress}) as a stake token on the new GameManager`);

const output = {
  ...previous,
  gameManagerAddress: gameManager.address,
  deployedAt: new Date().toISOString(),
  note: "GameManager-only redeploy (fee split retune: owner 7.5%, platform 2.5%, marketing 2.5%, referral 7.5%) - PlayerRegistry/MockRandomnessProvider/MockUSDT unchanged from before",
};
const outputPath = join(__dirname, "deployed-addresses.testnet.json");
writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(`Addresses written to ${outputPath}`);
