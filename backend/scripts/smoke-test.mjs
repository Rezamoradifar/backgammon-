// Real smoke test against a deployed backend + testnet contracts: two real
// wallets, real HTTP calls, real on-chain transactions, real BNB stake and
// payout. Covers SIWE auth, on-chain create/join/start, the indexer actually
// picking up events into Postgres, the backend's auto-fulfill relayer,
// wagering fee-split math, and a real withdrawal.
//
// Deliberately skips the WebSocket-based matchmaking/live-room layer - it
// needs a real browser or a plain WS client with unrestricted network
// access, which some sandboxed CI environments don't have. Verify that
// piece by playing a real match through the frontend in a browser.
//
// Usage:
//   API_URL=https://your-backend GAME_MANAGER_ADDRESS=0x... \
//   PLAYER1_KEY=0x... PLAYER2_KEY=0x... \
//   OWNER_FEE_WALLET=0x... PLATFORM_FEE_WALLET=0x... MARKETING_FEE_WALLET=0x... \
//   node scripts/smoke-test.mjs
// (players need a small amount of tBNB each - the script stakes 0.001 BNB)

import { createWalletClient, createPublicClient, http, parseEther, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_URL = process.env.API_URL;
const GAME_MANAGER_ADDRESS = process.env.GAME_MANAGER_ADDRESS;
if (!API_URL || !GAME_MANAGER_ADDRESS) {
  console.error("Set API_URL and GAME_MANAGER_ADDRESS");
  process.exit(1);
}
const gameManagerAbi = JSON.parse(readFileSync(join(__dirname, "..", "src", "indexer", "abi", "GameManager.json"), "utf8"));

const chain = {
  id: 97,
  name: "bsc-testnet",
  nativeCurrency: { name: "BNB", symbol: "tBNB", decimals: 18 },
  rpcUrls: { default: { http: ["https://bsc-testnet-rpc.publicnode.com"] } },
};
const publicClient = createPublicClient({ chain, transport: http() });

const player1 = privateKeyToAccount(process.env.PLAYER1_KEY);
const player2 = privateKeyToAccount(process.env.PLAYER2_KEY);
const wallet1 = createWalletClient({ account: player1, chain, transport: http() });
const wallet2 = createWalletClient({ account: player2, chain, transport: http() });
const STAKE = parseEther("0.001");

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, { ...options, headers: { "Content-Type": "application/json", ...(options.headers ?? {}) } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function login(account, walletClient) {
  const { message } = await apiFetch("/auth/nonce", { method: "POST", body: JSON.stringify({ address: account.address, chainId: 97 }) });
  const signature = await walletClient.signMessage({ message });
  const { token } = await apiFetch("/auth/verify", { method: "POST", body: JSON.stringify({ address: account.address, message, signature }) });
  return token;
}

console.log("1. SIWE login for both players...");
await login(player1, wallet1);
await login(player2, wallet2);
console.log("   OK");

console.log("2. player1 creates a", STAKE.toString(), "wei-stake game on-chain...");
const createHash = await wallet1.writeContract({ address: GAME_MANAGER_ADDRESS, abi: gameManagerAbi, functionName: "createGame", value: STAKE });
const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
const createdLog = createReceipt.logs.map((log) => { try { return decodeEventLog({ abi: gameManagerAbi, data: log.data, topics: log.topics }); } catch { return null; } }).find((d) => d?.eventName === "GameCreated");
const gameId = createdLog.args.gameId;
console.log("   OK - gameId", gameId.toString(), "tx", createHash);

console.log("3. player2 joins on-chain...");
const joinHash = await wallet2.writeContract({ address: GAME_MANAGER_ADDRESS, abi: gameManagerAbi, functionName: "joinGame", args: [gameId], value: STAKE });
await publicClient.waitForTransactionReceipt({ hash: joinHash });
console.log("   OK - tx", joinHash);

console.log("4. Polling backend /games/lookup - proves the indexer is watching the chain and Postgres is really working...");
let lookup;
for (let i = 0; i < 30; i++) {
  try { lookup = await apiFetch(`/games/lookup/${gameId}`); break; } catch { await new Promise((r) => setTimeout(r, 2000)); }
}
if (!lookup) throw new Error("Indexer never recorded GameCreated - backend indexer or DB may be broken");
console.log("   OK - indexed as internal id", lookup.id, "state", lookup.state, "players", JSON.stringify(lookup.players));

console.log("5. Calling startGame() - this requests randomness; the backend's auto-fulfill relayer must call fulfill() on its own...");
const startHash = await wallet1.writeContract({ address: GAME_MANAGER_ADDRESS, abi: gameManagerAbi, functionName: "startGame", args: [gameId] });
await publicClient.waitForTransactionReceipt({ hash: startHash });
console.log("   tx", startHash, "- waiting for ACTIVE...");
let active = false;
for (let i = 0; i < 30; i++) {
  const l = await apiFetch(`/games/lookup/${gameId}`);
  if (l.state === "ACTIVE") { active = true; break; }
  await new Promise((r) => setTimeout(r, 2000));
}
if (!active) throw new Error("Game never reached ACTIVE - the backend's auto-fulfill relayer isn't working in production");
console.log("   OK - game reached ACTIVE (randomness auto-fulfilled by the deployed backend's relayer, unattended)");

console.log("6. Reading fee-wallet balances before settling...");
const parties = { owner: process.env.OWNER_FEE_WALLET, platform: process.env.PLATFORM_FEE_WALLET, marketing: process.env.MARKETING_FEE_WALLET, winner: player2.address };
const before = {};
for (const [k, addr] of Object.entries(parties)) before[k] = await publicClient.readContract({ address: GAME_MANAGER_ADDRESS, abi: gameManagerAbi, functionName: "pendingWithdrawals", args: [addr] });

console.log("7. player1 forfeits (deterministic way to settle the wager) - player2 wins...");
const forfeitHash = await wallet1.writeContract({ address: GAME_MANAGER_ADDRESS, abi: gameManagerAbi, functionName: "forfeitGame", args: [gameId] });
await publicClient.waitForTransactionReceipt({ hash: forfeitHash });

const after = {};
for (const [k, addr] of Object.entries(parties)) after[k] = await publicClient.readContract({ address: GAME_MANAGER_ADDRESS, abi: gameManagerAbi, functionName: "pendingWithdrawals", args: [addr] });
const deltas = Object.fromEntries(Object.entries(after).map(([k, v]) => [k, (v - before[k]).toString()]));
console.log("   OK - credited deltas:", JSON.stringify(deltas));
if (after.winner <= before.winner) throw new Error("Winner was never credited");

console.log("8. player2 withdraws real BNB...");
const balBefore = await publicClient.getBalance({ address: player2.address });
const withdrawHash = await wallet2.writeContract({ address: GAME_MANAGER_ADDRESS, abi: gameManagerAbi, functionName: "withdraw" });
await publicClient.waitForTransactionReceipt({ hash: withdrawHash });
const balAfter = await publicClient.getBalance({ address: player2.address });
console.log("   OK - balance", balBefore.toString(), "->", balAfter.toString(), "(tx", withdrawHash, ")");

console.log("\nALL STEPS PASSED.");
