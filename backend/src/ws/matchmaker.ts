import type { WebSocket } from "ws";

interface QueuedPlayer {
  walletId: string;
  address: string;
  socket: WebSocket;
  /** Stake in wei (as a string, since it can exceed Number precision) the player wants to play for - "0" is a free match. */
  stake: string;
}

/**
 * In-memory matchmaking queue - pairs two waiting wallets and tells both
 * "go create/join the on-chain game with this opponent." This is purely a
 * pre-chain negotiation step; the actual Game record is created later by the
 * contract event indexer once the real createGame/joinGame transactions are
 * confirmed on-chain (see ARCHITECTURE.md - the chain is the source of
 * truth for who's actually playing whom).
 *
 * Single-process only, deliberately - horizontal scaling would need a
 * shared queue (e.g. Redis); not needed for this stage.
 */
export class Matchmaker {
  private queue: QueuedPlayer[] = [];
  /** walletId -> matched opponent, so a "gameCreated" message from one side can be relayed to the other. */
  private pairedOpponent = new Map<string, QueuedPlayer>();

  enqueue(player: QueuedPlayer): void {
    this.dequeue(player.walletId); // no duplicate entries for the same wallet
    this.queue.push(player);
    this.tryMatch();
  }

  dequeue(walletId: string): void {
    this.queue = this.queue.filter((p) => p.walletId !== walletId);
  }

  queueLength(): number {
    return this.queue.length;
  }

  getPairedOpponent(walletId: string): QueuedPlayer | undefined {
    return this.pairedOpponent.get(walletId);
  }

  clearPair(walletId: string): void {
    const opponent = this.pairedOpponent.get(walletId);
    if (opponent) this.pairedOpponent.delete(opponent.walletId);
    this.pairedOpponent.delete(walletId);
  }

  /**
   * Pairs players wanting the *same* stake - a player queued for a 0.1 BNB
   * match never gets matched against one queued for a free game, since
   * joinGame requires sending exactly the creator's stake.
   */
  private tryMatch(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < this.queue.length; i++) {
        const a = this.queue[i];
        if (a.socket.readyState !== a.socket.OPEN) {
          this.queue.splice(i, 1);
          progressed = true;
          break;
        }

        const jIndex = this.queue.findIndex((p, idx) => idx !== i && p.stake === a.stake);
        if (jIndex === -1) continue;
        const b = this.queue[jIndex];
        if (b.socket.readyState !== b.socket.OPEN) {
          this.queue.splice(jIndex, 1);
          progressed = true;
          break;
        }

        this.queue.splice(Math.max(i, jIndex), 1);
        this.queue.splice(Math.min(i, jIndex), 1);

        this.pairedOpponent.set(a.walletId, b);
        this.pairedOpponent.set(b.walletId, a);

        // Both clients independently derive the same "who creates the
        // on-chain game" answer from the same comparison, with no extra
        // round trip.
        const aIsCreator = a.address.toLowerCase() < b.address.toLowerCase();

        a.socket.send(
          JSON.stringify({
            type: "matched",
            opponentAddress: b.address,
            opponentWalletId: b.walletId,
            amICreator: aIsCreator,
            stake: a.stake,
          }),
        );
        b.socket.send(
          JSON.stringify({
            type: "matched",
            opponentAddress: a.address,
            opponentWalletId: a.walletId,
            amICreator: !aIsCreator,
            stake: b.stake,
          }),
        );

        progressed = true;
        break;
      }
    }
  }
}

export const matchmaker = new Matchmaker();
