-- CreateEnum
CREATE TYPE "CosmeticSlot" AS ENUM ('DICE', 'BOARD');

-- AlterTable
ALTER TABLE "wallets" ADD COLUMN     "equippedBoardSkin" TEXT,
ADD COLUMN     "equippedDiceSkin" TEXT;

-- CreateTable
CREATE TABLE "cosmetic_purchases" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "slot" "CosmeticSlot" NOT NULL,
    "txHash" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "token" TEXT NOT NULL,
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cosmetic_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cosmetic_purchases_txHash_key" ON "cosmetic_purchases"("txHash");

-- CreateIndex
CREATE INDEX "cosmetic_purchases_walletId_idx" ON "cosmetic_purchases"("walletId");

-- CreateIndex
CREATE UNIQUE INDEX "cosmetic_purchases_walletId_itemId_key" ON "cosmetic_purchases"("walletId", "itemId");

-- AddForeignKey
ALTER TABLE "cosmetic_purchases" ADD CONSTRAINT "cosmetic_purchases_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
