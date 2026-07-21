-- DropIndex
DROP INDEX "games_onChainGameId_key";

-- CreateIndex
CREATE UNIQUE INDEX "games_contractAddress_onChainGameId_key" ON "games"("contractAddress", "onChainGameId");
