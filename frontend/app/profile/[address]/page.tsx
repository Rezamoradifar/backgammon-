"use client";

import * as React from "react";
import { useParams } from "next/navigation";

import { apiFetch, type LeaderboardRow, type GameHistoryEntry } from "@/lib/api";
import { shortenAddress } from "@/lib/utils";

export default function ProfilePage() {
  const params = useParams<{ address: string }>();
  const address = params.address;
  const [stats, setStats] = React.useState<LeaderboardRow | null>(null);
  const [games, setGames] = React.useState<GameHistoryEntry[] | null>(null);

  React.useEffect(() => {
    apiFetch<LeaderboardRow>(`/leaderboard/${address}`).then(setStats).catch(() => setStats(null));
    apiFetch<GameHistoryEntry[]>(`/games/history/${address}`).then(setGames).catch(() => setGames([]));
  }, [address]);

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <h1 className="mb-6 text-2xl font-semibold font-mono">{shortenAddress(address)}</h1>

      {stats && (
        <div className="mb-6 grid grid-cols-4 gap-3">
          <Stat label="Wins" value={stats.wins} />
          <Stat label="Losses" value={stats.losses} />
          <Stat label="Streak" value={stats.currentStreak} />
          <Stat label="Best streak" value={stats.bestStreak} />
        </div>
      )}

      <p className="mb-2 text-sm font-medium">Recent games</p>
      <ul className="flex flex-col gap-2">
        {games?.map((g) => (
          <li key={g.gameId} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm">
            Game #{g.gameId} - {g.state}
          </li>
        ))}
        {games?.length === 0 && <p className="text-sm text-slate-400">No completed games yet.</p>}
      </ul>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-center">
      <p className="text-lg font-semibold">{value}</p>
      <p className="text-xs text-slate-400">{label}</p>
    </div>
  );
}
