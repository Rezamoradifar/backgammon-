import { Router } from "express";

import { prisma } from "../lib/prisma.js";
import { computeLevel } from "../lib/level.js";

export const leaderboardRouter = Router();

leaderboardRouter.get("/", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 100);

  const entries = await prisma.leaderboardEntry.findMany({
    take: limit,
    orderBy: [{ wins: "desc" }, { bestStreak: "desc" }],
    include: { wallet: { include: { user: true } } },
  });

  res.json(
    entries.map((e) => ({
      address: e.wallet.address,
      displayName: e.wallet.user.displayName ?? null,
      wins: e.wins,
      losses: e.losses,
      gamesPlayed: e.gamesPlayed,
      currentStreak: e.currentStreak,
      bestStreak: e.bestStreak,
      level: computeLevel(e.gamesPlayed),
    })),
  );
});

leaderboardRouter.get("/:address", async (req, res) => {
  const address = req.params.address;
  // Lowercased for the lookup - Wallet rows are keyed by lowercase address
  // everywhere (see gameManagerIndexer.ts and auth.ts), since Postgres
  // string equality is case-sensitive and callers may pass a checksummed
  // address.
  const wallet = await prisma.wallet.findUnique({ where: { address: address.toLowerCase() }, include: { leaderboardRow: true } });
  if (!wallet?.leaderboardRow) {
    res.json({ address, wins: 0, losses: 0, gamesPlayed: 0, currentStreak: 0, bestStreak: 0, level: computeLevel(0) });
    return;
  }
  const row = wallet.leaderboardRow;
  res.json({
    address,
    wins: row.wins,
    losses: row.losses,
    gamesPlayed: row.gamesPlayed,
    currentStreak: row.currentStreak,
    bestStreak: row.bestStreak,
    level: computeLevel(row.gamesPlayed),
  });
});
