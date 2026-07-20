-- AlterTable
ALTER TABLE "games" ADD COLUMN     "stake" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "weekly_reward_distributions" (
    "id" TEXT NOT NULL,
    "weekId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "wageredVolume" BIGINT NOT NULL,
    "amount" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_reward_distributions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "weekly_reward_distributions_weekId_idx" ON "weekly_reward_distributions"("weekId");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_reward_distributions_weekId_walletId_key" ON "weekly_reward_distributions"("weekId", "walletId");

-- AddForeignKey
ALTER TABLE "weekly_reward_distributions" ADD CONSTRAINT "weekly_reward_distributions_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
