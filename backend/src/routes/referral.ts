import { Router } from "express";
import { z } from "zod";
import { getAddress, isAddress } from "viem";

import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../auth/middleware.js";

export const referralRouter = Router();

const claimSchema = z.object({
  referrerAddress: z.string().refine(isAddress, "Not a valid EVM address"),
});

/**
 * Records that the authenticated wallet was referred by another wallet.
 * Informational only in this version - no commission, no payout (see
 * ARCHITECTURE.md's "Future regulated modules"). A wallet can be referred
 * at most once, and never by itself.
 */
referralRouter.post("/claim", requireAuth, async (req, res) => {
  const parsed = claimSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const referrerAddress = getAddress(parsed.data.referrerAddress);
  const refereeWalletId = req.session!.walletId;

  // Lowercased for the lookup - Wallet rows are keyed by lowercase address
  // everywhere (see gameManagerIndexer.ts and auth.ts), since Postgres
  // string equality is case-sensitive.
  const referrerWallet = await prisma.wallet.findUnique({ where: { address: referrerAddress.toLowerCase() } });
  if (!referrerWallet) {
    res.status(404).json({ error: "Referrer wallet is not registered" });
    return;
  }
  if (referrerWallet.id === refereeWalletId) {
    res.status(400).json({ error: "A wallet cannot refer itself" });
    return;
  }

  const existing = await prisma.referral.findUnique({ where: { refereeWalletId } });
  if (existing) {
    res.status(409).json({ error: "This wallet has already been referred" });
    return;
  }

  const referral = await prisma.referral.create({
    data: { referrerWalletId: referrerWallet.id, refereeWalletId },
  });
  res.status(201).json({ id: referral.id, referrerAddress });
});

referralRouter.get("/mine", requireAuth, async (req, res) => {
  const referrals = await prisma.referral.findMany({
    where: { referrerWalletId: req.session!.walletId },
    include: { referee: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(referrals.map((r) => ({ refereeAddress: r.referee.address, createdAt: r.createdAt })));
});
