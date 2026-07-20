import type { WebSocket } from "ws";

interface QueuedPlayer {
  walletId: string;
  address: string;
  socket: WebSocket;
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

  private tryMatch(): void {
    while (this.queue.length >= 2) {
      const [a, b] = this.queue.splice(0, 2);
      if (a.socket.readyState !== a.socket.OPEN) {
        this.queue.unshift(b);
        continue;
      }
      if (b.socket.readyState !== b.socket.OPEN) {
        this.queue.unshift(a);
        continue;
      }

      const payload = (opponent: QueuedPlayer) =>
        JSON.stringify({ type: "matched", opponentAddress: opponent.address, opponentWalletId: opponent.walletId });

      a.socket.send(payload(b));
      b.socket.send(payload(a));
    }
  }
}

export const matchmaker = new Matchmaker();
