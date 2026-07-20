-- CreateEnum
CREATE TYPE "GameState" AS ENUM ('WAITING_FOR_PLAYER', 'CREATED', 'ACTIVE', 'AWAITING_RESULT', 'COMPLETED', 'CANCELLED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "PlayerColor" AS ENUM ('WHITE', 'BLACK');

-- CreateEnum
CREATE TYPE "ResultSource" AS ENUM ('CONFIRMED', 'TIMEOUT', 'ARBITER');

-- CreateEnum
CREATE TYPE "SecurityEventType" AS ENUM ('INVALID_MOVE_ATTEMPT', 'SIGNATURE_MISMATCH', 'RATE_LIMIT_EXCEEDED', 'SUSPICIOUS_MOVE_TIMING', 'UNAUTHORIZED_ACTION_ATTEMPT');

-- CreateEnum
CREATE TYPE "SecurityEventSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "displayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "authNonce" TEXT,
    "authNonceExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games" (
    "id" TEXT NOT NULL,
    "onChainGameId" BIGINT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "state" "GameState" NOT NULL DEFAULT 'WAITING_FOR_PLAYER',
    "firstToMoveColor" "PlayerColor",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_players" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "color" "PlayerColor" NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isReady" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "game_players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moves" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "turnNumber" INTEGER NOT NULL,
    "sequenceInTurn" INTEGER NOT NULL,
    "dieValue" INTEGER NOT NULL,
    "fromPoint" INTEGER,
    "toPoint" INTEGER,
    "wasHit" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dice_rolls" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "turnNumber" INTEGER NOT NULL,
    "values" INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dice_rolls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_results" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "winnerId" TEXT NOT NULL,
    "loserId" TEXT NOT NULL,
    "source" "ResultSource" NOT NULL,
    "resultHashOnChain" TEXT,
    "txHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leaderboard_entries" (
    "walletId" TEXT NOT NULL,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "gamesPlayed" INTEGER NOT NULL DEFAULT 0,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "bestStreak" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leaderboard_entries_pkey" PRIMARY KEY ("walletId")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "referrerWalletId" TEXT NOT NULL,
    "refereeWalletId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_events" (
    "id" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "eventName" TEXT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "args" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gameId" TEXT,

    CONSTRAINT "contract_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" TEXT NOT NULL,
    "type" "SecurityEventType" NOT NULL,
    "severity" "SecurityEventSeverity" NOT NULL DEFAULT 'LOW',
    "walletId" TEXT,
    "gameId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallets_address_key" ON "wallets"("address");

-- CreateIndex
CREATE INDEX "wallets_userId_idx" ON "wallets"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "games_onChainGameId_key" ON "games"("onChainGameId");

-- CreateIndex
CREATE INDEX "games_state_idx" ON "games"("state");

-- CreateIndex
CREATE INDEX "game_players_walletId_idx" ON "game_players"("walletId");

-- CreateIndex
CREATE UNIQUE INDEX "game_players_gameId_walletId_key" ON "game_players"("gameId", "walletId");

-- CreateIndex
CREATE UNIQUE INDEX "game_players_gameId_color_key" ON "game_players"("gameId", "color");

-- CreateIndex
CREATE INDEX "moves_gameId_idx" ON "moves"("gameId");

-- CreateIndex
CREATE UNIQUE INDEX "moves_gameId_turnNumber_sequenceInTurn_key" ON "moves"("gameId", "turnNumber", "sequenceInTurn");

-- CreateIndex
CREATE INDEX "dice_rolls_gameId_idx" ON "dice_rolls"("gameId");

-- CreateIndex
CREATE UNIQUE INDEX "dice_rolls_gameId_turnNumber_key" ON "dice_rolls"("gameId", "turnNumber");

-- CreateIndex
CREATE UNIQUE INDEX "game_results_gameId_key" ON "game_results"("gameId");

-- CreateIndex
CREATE INDEX "leaderboard_entries_wins_idx" ON "leaderboard_entries"("wins");

-- CreateIndex
CREATE INDEX "leaderboard_entries_currentStreak_idx" ON "leaderboard_entries"("currentStreak");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_refereeWalletId_key" ON "referrals"("refereeWalletId");

-- CreateIndex
CREATE INDEX "referrals_referrerWalletId_idx" ON "referrals"("referrerWalletId");

-- CreateIndex
CREATE INDEX "contract_events_contractAddress_eventName_idx" ON "contract_events"("contractAddress", "eventName");

-- CreateIndex
CREATE INDEX "contract_events_blockNumber_idx" ON "contract_events"("blockNumber");

-- CreateIndex
CREATE UNIQUE INDEX "contract_events_transactionHash_logIndex_key" ON "contract_events"("transactionHash", "logIndex");

-- CreateIndex
CREATE INDEX "security_events_walletId_idx" ON "security_events"("walletId");

-- CreateIndex
CREATE INDEX "security_events_type_idx" ON "security_events"("type");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moves" ADD CONSTRAINT "moves_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moves" ADD CONSTRAINT "moves_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "game_players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moves" ADD CONSTRAINT "moves_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dice_rolls" ADD CONSTRAINT "dice_rolls_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dice_rolls" ADD CONSTRAINT "dice_rolls_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "game_players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dice_rolls" ADD CONSTRAINT "dice_rolls_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_results" ADD CONSTRAINT "game_results_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_results" ADD CONSTRAINT "game_results_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_results" ADD CONSTRAINT "game_results_loserId_fkey" FOREIGN KEY ("loserId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leaderboard_entries" ADD CONSTRAINT "leaderboard_entries_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrerWalletId_fkey" FOREIGN KEY ("referrerWalletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_refereeWalletId_fkey" FOREIGN KEY ("refereeWalletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_events" ADD CONSTRAINT "contract_events_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE SET NULL ON UPDATE CASCADE;
