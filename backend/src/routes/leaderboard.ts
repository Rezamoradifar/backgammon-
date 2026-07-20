import { Router } from "express";

import { prisma } from "../lib/prisma.js";

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
    })),
  );
});

leaderboardRouter.get("/:address", async (req, res) => {
  const address = req.params.address;
  const wallet = await prisma.wallet.findUnique({ where: { address }, include: { leaderboardRow: true } });
  if (!wallet?.leaderboardRow) {
    res.json({ address, wins: 0, losses: 0, gamesPlayed: 0, currentStreak: 0, bestStreak: 0 });
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
  });
});
