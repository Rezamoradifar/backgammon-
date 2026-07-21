import { Router } from "express";
import { z } from "zod";
import {
  createPublicClient,
  http,
  parseEther,
  parseUnits,
  isAddress,
  type Chain,
} from "viem";

import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../auth/middleware.js";
import { SHOP_CATALOG, FREE_ITEM_IDS, findCatalogItem } from "../shop/catalog.js";

export const shopRouter = Router();

const {
  RPC_URL,
  CHAIN_ID,
  OWNER_FEE_WALLET,
  SHOP_TREASURY_ADDRESS,
  USDT_TOKEN_ADDRESS,
} = process.env;

// Defaults to the same owner-controlled wallet the contract already pays
// its fee cut into (see DEPLOYMENT.md) - no reason to stand up a second
// treasury address just for cosmetics.
const TREASURY_ADDRESS = (SHOP_TREASURY_ADDRESS ?? OWNER_FEE_WALLET ?? "").toLowerCase();
const USDT_ADDRESS = (USDT_TOKEN_ADDRESS ?? "").toLowerCase();
const USDT_DECIMALS = 6;
const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";

function getClient() {
  if (!RPC_URL) throw new Error("RPC_URL is not set");
  const chain: Chain = {
    id: Number(CHAIN_ID ?? 97),
    name: "configured-chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  };
  return createPublicClient({ chain, transport: http(RPC_URL) });
}

shopRouter.get("/items", (_req, res) => {
  res.json(SHOP_CATALOG);
});

shopRouter.get("/me", requireAuth, async (req, res) => {
  const wallet = await prisma.wallet.findUniqueOrThrow({
    where: { id: req.session!.walletId },
    include: { cosmeticPurchases: true },
  });

  res.json({
    owned: [...FREE_ITEM_IDS, ...wallet.cosmeticPurchases.map((p) => p.itemId)],
    equipped: {
      dice: wallet.equippedDiceSkin ?? "dice-classic",
      board: wallet.equippedBoardSkin ?? "board-classic",
    },
  });
});

const purchaseSchema = z.object({
  itemId: z.string().min(1),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Not a valid transaction hash"),
  token: z.enum(["BNB", "USDT"]),
});

/**
 * Grants a cosmetic item only after independently verifying a real
 * on-chain payment - the client-supplied txHash is never trusted at face
 * value. This is the same "read the chain ourselves" posture the contract
 * event indexer uses (see gameManagerIndexer.ts), just for a one-off
 * payment instead of a watched event stream.
 */
shopRouter.post("/purchase", requireAuth, async (req, res) => {
  const parsed = purchaseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (!TREASURY_ADDRESS || !isAddress(TREASURY_ADDRESS)) {
    res.status(500).json({ error: "Shop treasury address is not configured" });
    return;
  }

  const { itemId, txHash, token } = parsed.data;
  const item = findCatalogItem(itemId);
  if (!item || FREE_ITEM_IDS.includes(item.id)) {
    res.status(404).json({ error: "Unknown paid item" });
    return;
  }

  const walletId = req.session!.walletId;
  const buyerAddress = req.session!.address.toLowerCase();

  const existing = await prisma.cosmeticPurchase.findUnique({ where: { walletId_itemId: { walletId, itemId } } });
  if (existing) {
    res.status(409).json({ error: "Already owned" });
    return;
  }

  const alreadyRedeemed = await prisma.cosmeticPurchase.findUnique({ where: { txHash: txHash.toLowerCase() } });
  if (alreadyRedeemed) {
    res.status(409).json({ error: "This transaction has already been redeemed" });
    return;
  }

  const client = getClient();
  const receipt = await client
    .getTransactionReceipt({ hash: txHash as `0x${string}` })
    .catch(() => null);
  const tx = await client.getTransaction({ hash: txHash as `0x${string}` }).catch(() => null);
  if (!receipt || !tx || receipt.status !== "success") {
    res.status(400).json({ error: "Transaction not found or not confirmed on-chain" });
    return;
  }
  if (tx.from.toLowerCase() !== buyerAddress) {
    res.status(400).json({ error: "Transaction sender does not match your wallet" });
    return;
  }

  let paidAmount: bigint;
  let tokenAddress: string;

  if (token === "BNB") {
    const expected = parseEther(item.priceBnb);
    if (tx.to?.toLowerCase() !== TREASURY_ADDRESS || tx.value < expected) {
      res.status(400).json({ error: "Transaction does not pay the required BNB amount to the shop treasury" });
      return;
    }
    paidAmount = tx.value;
    tokenAddress = NATIVE_TOKEN;
  } else {
    if (!USDT_ADDRESS) {
      res.status(500).json({ error: "USDT token address is not configured" });
      return;
    }
    const expected = parseUnits(item.priceUsdt, USDT_DECIMALS);
    if (tx.to?.toLowerCase() !== USDT_ADDRESS) {
      res.status(400).json({ error: "Transaction was not sent to the USDT token contract" });
      return;
    }
    const transferLog = receipt.logs.find((log) => {
      if (log.address.toLowerCase() !== USDT_ADDRESS) return false;
      try {
        const decoded = decodeTransferLog(log);
        return (
          decoded &&
          decoded.from.toLowerCase() === buyerAddress &&
          decoded.to.toLowerCase() === TREASURY_ADDRESS &&
          decoded.value >= expected
        );
      } catch {
        return false;
      }
    });
    if (!transferLog) {
      res.status(400).json({ error: "No matching USDT transfer to the shop treasury was found in this transaction" });
      return;
    }
    const decoded = decodeTransferLog(transferLog)!;
    paidAmount = decoded.value;
    tokenAddress = USDT_ADDRESS;
  }

  try {
    await prisma.cosmeticPurchase.create({
      data: {
        walletId,
        itemId: item.id,
        slot: item.slot,
        txHash: txHash.toLowerCase(),
        amount: paidAmount,
        token: tokenAddress,
      },
    });
  } catch {
    // Unique constraint on txHash/walletId+itemId - another concurrent
    // request already redeemed this exact payment, which is fine.
    res.status(409).json({ error: "Already owned or transaction already redeemed" });
    return;
  }

  res.status(201).json({ ok: true, itemId: item.id });
});

const equipSchema = z.object({ itemId: z.string().min(1) });

shopRouter.post("/equip", requireAuth, async (req, res) => {
  const parsed = equipSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const item = findCatalogItem(parsed.data.itemId);
  if (!item) {
    res.status(404).json({ error: "Unknown item" });
    return;
  }

  const walletId = req.session!.walletId;
  const owned =
    FREE_ITEM_IDS.includes(item.id) ||
    Boolean(await prisma.cosmeticPurchase.findUnique({ where: { walletId_itemId: { walletId, itemId: item.id } } }));
  if (!owned) {
    res.status(403).json({ error: "You do not own this item" });
    return;
  }

  const wallet = await prisma.wallet.update({
    where: { id: walletId },
    data: item.slot === "DICE" ? { equippedDiceSkin: item.id } : { equippedBoardSkin: item.id },
  });

  res.json({ dice: wallet.equippedDiceSkin ?? "dice-classic", board: wallet.equippedBoardSkin ?? "board-classic" });
});

function decodeTransferLog(log: {
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
}): { from: string; to: string; value: bigint } | null {
  // Transfer(address indexed from, address indexed to, uint256 value)
  const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3) return null;
  const from = `0x${log.topics[1].slice(26)}`;
  const to = `0x${log.topics[2].slice(26)}`;
  const value = BigInt(log.data);
  return { from, to, value };
}
