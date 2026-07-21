import { Router } from "express";
import { z } from "zod";
import { getAddress, isAddress } from "viem";

import { prisma } from "../lib/prisma.js";
import { buildAuthMessage, generateNonce, nonceExpiry, verifyAuthSignature } from "../auth/siwe.js";
import { issueSessionToken } from "../auth/jwt.js";

const AUTH_DOMAIN = process.env.AUTH_DOMAIN ?? "onchain-backgammon.local";

export const authRouter = Router();

const nonceRequestSchema = z.object({
  address: z.string().refine(isAddress, "Not a valid EVM address"),
  chainId: z.number().int().positive(),
});

/**
 * Step 1 of wallet-signature auth: issue a single-use, short-lived nonce and
 * the exact message the client should have the wallet sign. The backend
 * never sees or needs a private key at any point in this flow.
 */
authRouter.post("/nonce", async (req, res) => {
  const parsed = nonceRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  // Checksummed only for the human-readable text the wallet prompt shows -
  // every DB read/write below uses the lowercased form, matching the
  // on-chain event indexer's convention (see gameManagerIndexer.ts), since
  // Postgres string equality is case-sensitive and these must resolve to
  // the exact same Wallet row a player's on-chain games are recorded under.
  const address = getAddress(parsed.data.address);
  const normalizedAddress = address.toLowerCase();
  const nonce = generateNonce();

  const wallet = await prisma.wallet.upsert({
    where: { address: normalizedAddress },
    update: { authNonce: nonce, authNonceExpiresAt: nonceExpiry() },
    create: {
      address: normalizedAddress,
      chainId: parsed.data.chainId,
      authNonce: nonce,
      authNonceExpiresAt: nonceExpiry(),
      user: { create: {} },
    },
  });

  const message = buildAuthMessage({
    domain: AUTH_DOMAIN,
    address,
    nonce,
    chainId: wallet.chainId,
  });

  res.json({ message });
});

const verifyRequestSchema = z.object({
  address: z.string().refine(isAddress, "Not a valid EVM address"),
  message: z.string().min(1),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/, "Not a valid signature"),
});

/**
 * Step 2: the client sends back the message it had signed plus the
 * signature. We verify the signature cryptographically proves this address
 * signed exactly this text, and separately confirm the text embeds the
 * nonce we issued (and that nonce hasn't expired or been used already).
 */
authRouter.post("/verify", async (req, res) => {
  const parsed = verifyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const address = getAddress(parsed.data.address);
  const normalizedAddress = address.toLowerCase();
  const { message, signature } = parsed.data;

  const wallet = await prisma.wallet.findUnique({ where: { address: normalizedAddress } });
  if (!wallet?.authNonce || !wallet.authNonceExpiresAt) {
    res.status(401).json({ error: "No pending login challenge for this address" });
    return;
  }
  if (wallet.authNonceExpiresAt < new Date()) {
    res.status(401).json({ error: "Login challenge expired - request a new nonce" });
    return;
  }
  if (!message.includes(wallet.authNonce)) {
    res.status(401).json({ error: "Message does not contain the issued nonce" });
    return;
  }

  const isValidSignature = await verifyAuthSignature({
    address,
    message,
    signature: signature as `0x${string}`,
  });
  if (!isValidSignature) {
    res.status(401).json({ error: "Signature does not match address" });
    return;
  }

  // Single-use: clear the nonce so this exact signature can never authenticate again.
  await prisma.wallet.update({
    where: { address: normalizedAddress },
    data: { authNonce: null, authNonceExpiresAt: null },
  });

  const token = issueSessionToken({ userId: wallet.userId, walletId: wallet.id, address: normalizedAddress });
  res.json({ token });
});
