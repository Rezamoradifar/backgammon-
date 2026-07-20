"use client";

import * as React from "react";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";

import { apiFetch, type GameHistoryEntry } from "@/lib/api";
import { shortenAddress } from "@/lib/utils";

export default function HistoryPage() {
  const { address, isConnected } = useAccount();
  const [games, setGames] = React.useState<GameHistoryEntry[] | null>(null);

  React.useEffect(() => {
    if (!address) return;
    apiFetch<GameHistoryEntry[]>(`/games/history/${address}`).then(setGames).catch(() => setGames([]));
  }, [address]);

  if (!isConnected) {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-4 px-6 py-24 text-center">
        <p className="text-slate-300">Connect a wallet to see your game history.</p>
        <ConnectButton />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="mb-6 text-2xl font-semibold">Your game history</h1>
      {!games && <p className="text-slate-400">Loading...</p>}
      {games && games.length === 0 && <p className="text-slate-400">No completed games yet.</p>}
      <ul className="flex flex-col gap-3">
        {games?.map((g) => {
          const you = g.players.find((p) => p.address.toLowerCase() === address?.toLowerCase());
          const won = g.winner != null && you && g.winner === you.address;
          return (
            <li key={g.gameId} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm">
              <span>Game #{g.gameId}</span>
              <span className={won ? "text-emerald-400" : "text-red-400"}>
                {g.state === "CANCELLED" ? "Cancelled" : won ? "Won" : "Lost"}
              </span>
              <span className="text-slate-400">
                {g.players.map((p) => shortenAddress(p.address)).join(" vs ")}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
