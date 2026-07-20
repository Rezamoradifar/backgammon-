import { createPublicClient, createWalletClient, http, type Address, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { prisma } from "../lib/prisma.js";
import { previousCompletedWeek } from "../lib/isoWeek.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gameManagerAbi = JSON.parse(readFileSync(join(__dirname, "../indexer/abi/GameManager.json"), "utf8"));

/** Mirrors GameManager's PLATFORM_FEE_BPS - used only to *estimate* how much
 * of a week's settled wagering volume landed in platformFeeWallet, so the
 * job knows a reasonable amount to ask for. The contract itself is the
 * actual source of truth on available balance - see distributeWeeklyRewards'
 * InsufficientPlatformBalance check, which this job's request can never get
 * past regardless of how this estimate drifts from the exact on-chain figure
 * (e.g. from referral-fallback credits also landing in platformFeeWallet). */
const PLATFORM_FEE_BPS = 500n;
const BPS_DENOMINATOR = 10_000n;

/** Top-3 tiered split of the week's reward pool: 1st/2nd/3rd place shares. */
const TIER_SHARES = [0.5, 0.3, 0.2];

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly - cheap enough, and keeps the job self-healing after any downtime

export interface WeeklyRewardsConfig {
  rpcUrl: string;
  chain: Chain;
  gameManagerAddress: Address;
  distributorPrivateKey: `0x${string}`;
}

/** Starts an in-process scheduler that checks, roughly hourly, whether last
 * week's top-wagerer rewards have been distributed yet, and runs the job if
 * not. Checking on a fixed interval rather than scheduling a precise
 * once-a-week timer means a restart or missed tick just means "it runs
 * within an hour of when it should have" instead of silently skipping a
 * week - idempotency (the WeeklyRewardDistribution unique constraint on
 * [weekId, walletId], and the up-front existence check) is what actually
 * guarantees a week is never paid out twice. */
export function startWeeklyRewardsScheduler(config: WeeklyRewardsConfig): () => void {
  let stopped = false;

  const tick = async () => {
    try {
      await runWeeklyRewardsJobIfDue(config);
    } catch (err) {
      console.error("weeklyRewards job error:", err);
    }
  };

  void tick();
  const interval = setInterval(() => {
    if (!stopped) void tick();
  }, CHECK_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

export async function runWeeklyRewardsJobIfDue(config: WeeklyRewardsConfig): Promise<void> {
  const { weekId, start, end } = previousCompletedWeek(new Date());

  const alreadyDistributed = await prisma.weeklyRewardDistribution.findFirst({ where: { weekId } });
  if (alreadyDistributed) return; // already paid out - nothing to do

  const rankings = await computeWeeklyWageringRankings(start, end);
  const topWagerers = rankings.slice(0, 3);
  if (topWagerers.length === 0) return; // no settled, staked games that week

  const publicClient = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) });
  const platformFeeWallet = (await publicClient.readContract({
    address: config.gameManagerAddress,
    abi: gameManagerAbi,
    functionName: "platformFeeWallet",
  })) as Address;
  const availableBalance = (await publicClient.readContract({
    address: config.gameManagerAddress,
    abi: gameManagerAbi,
    functionName: "pendingWithdrawals",
    args: [platformFeeWallet],
  })) as bigint;

  const estimatedWeeklyFee = (rankings.reduce((sum, r) => sum + r.wageredVolume, 0n) * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
  const pool = estimatedWeeklyFee < availableBalance ? estimatedWeeklyFee : availableBalance;
  if (pool === 0n) return;

  const amounts = tieredSplit(pool, topWagerers.length);

  const account = privateKeyToAccount(config.distributorPrivateKey);
  const walletClient = createWalletClient({ account, chain: config.chain, transport: http(config.rpcUrl) });

  const hash = await walletClient.writeContract({
    address: config.gameManagerAddress,
    abi: gameManagerAbi,
    functionName: "distributeWeeklyRewards",
    args: [topWagerers.map((w) => w.address), amounts, BigInt(isoWeekIdToNumeric(weekId))],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  await prisma.$transaction(
    topWagerers.map((winner, i) =>
      prisma.weeklyRewardDistribution.create({
        data: {
          weekId,
          walletId: winner.walletId,
          rank: i + 1,
          wageredVolume: winner.wageredVolume,
          amount: amounts[i],
          txHash: hash,
        },
      }),
    ),
  );

  console.log(`Weekly rewards distributed for ${weekId}: ${topWagerers.length} winner(s), pool=${pool} wei, tx=${hash}`);
}

interface WalletVolume {
  walletId: string;
  address: string;
  wageredVolume: bigint;
}

/** Ranks players by total stake across games that actually settled (and
 * therefore actually paid a platform fee) within [start, end) - a cancelled
 * game refunds in full and never generates a fee, so it doesn't count as
 * "wagering volume" for this ranking. */
async function computeWeeklyWageringRankings(start: Date, end: Date): Promise<WalletVolume[]> {
  const games = await prisma.game.findMany({
    where: { state: "COMPLETED", completedAt: { gte: start, lt: end }, stake: { gt: 0n } },
    include: { players: { include: { wallet: true } } },
  });

  const byWallet = new Map<string, WalletVolume>();
  for (const game of games) {
    for (const gp of game.players) {
      const existing = byWallet.get(gp.walletId);
      if (existing) {
        existing.wageredVolume += game.stake;
      } else {
        byWallet.set(gp.walletId, { walletId: gp.walletId, address: gp.wallet.address, wageredVolume: game.stake });
      }
    }
  }

  return [...byWallet.values()].sort((a, b) => (a.wageredVolume < b.wageredVolume ? 1 : a.wageredVolume > b.wageredVolume ? -1 : 0));
}

export function tieredSplit(pool: bigint, winnerCount: number): bigint[] {
  const shares = TIER_SHARES.slice(0, winnerCount);
  const shareTotal = shares.reduce((sum, s) => sum + s, 0);
  const amounts = shares.map((share) => (pool * BigInt(Math.round((share / shareTotal) * 1_000_000))) / 1_000_000n);

  // Integer division can leave a few wei unallocated - give the remainder to 1st place
  // rather than leaving it stranded uncredited to anyone.
  const allocated = amounts.reduce((sum, a) => sum + a, 0n);
  amounts[0] += pool - allocated;
  return amounts;
}

/** GameManager.distributeWeeklyRewards' `weekId` param is a uint256, not a
 * string - encodes "YYYY-Www" as YYYYWW (e.g. "2026-W29" -> 202629) so it
 * still round-trips to something human-readable in block explorers/event logs. */
function isoWeekIdToNumeric(weekId: string): number {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekId);
  if (!match) throw new Error(`Unexpected weekId format: ${weekId}`);
  return Number(match[1]) * 100 + Number(match[2]);
}
