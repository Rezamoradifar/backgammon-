/**
 * Cosmetics catalog - purely visual, no gameplay effect. Hardcoded rather
 * than a DB table since there's no admin UI to add items yet; the price is
 * quoted in both native BNB and the deployed stake-USDT token so the shop
 * page can offer either payment path without a live price feed.
 */
export type CosmeticSlot = "DICE" | "BOARD";

export interface CatalogItem {
  id: string;
  slot: CosmeticSlot;
  name: string;
  /** Human string, parsed with parseEther/parseUnits at the point of use. */
  priceBnb: string;
  priceUsdt: string;
  /** CSS color used to render the skin - see components/onchainBackgammon in dravon. */
  colorHex: string;
}

export const SHOP_CATALOG: CatalogItem[] = [
  { id: "dice-classic", slot: "DICE", name: "Classic Dice", priceBnb: "0", priceUsdt: "0", colorHex: "#ffffff" },
  { id: "dice-crimson", slot: "DICE", name: "Crimson Dice", priceBnb: "0.01", priceUsdt: "6", colorHex: "#dc2626" },
  { id: "dice-gold", slot: "DICE", name: "Gold Dice", priceBnb: "0.02", priceUsdt: "12", colorHex: "#eab308" },
  { id: "dice-neon", slot: "DICE", name: "Neon Dice", priceBnb: "0.02", priceUsdt: "12", colorHex: "#22d3ee" },
  { id: "board-classic", slot: "BOARD", name: "Classic Board", priceBnb: "0", priceUsdt: "0", colorHex: "#78350f" },
  { id: "board-walnut", slot: "BOARD", name: "Walnut Board", priceBnb: "0.03", priceUsdt: "18", colorHex: "#5c3a21" },
  { id: "board-emerald", slot: "BOARD", name: "Emerald Board", priceBnb: "0.03", priceUsdt: "18", colorHex: "#065f46" },
  { id: "board-obsidian", slot: "BOARD", name: "Obsidian Board", priceBnb: "0.05", priceUsdt: "30", colorHex: "#18181b" },
];

/** The two free defaults every wallet already "owns" without a purchase row. */
export const FREE_ITEM_IDS = ["dice-classic", "board-classic"];

export function findCatalogItem(itemId: string): CatalogItem | undefined {
  return SHOP_CATALOG.find((item) => item.id === itemId);
}
