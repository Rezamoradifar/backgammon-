"use client";

import * as React from "react";

import { apiFetch, type LeaderboardRow } from "@/lib/api";
import { shortenAddress } from "@/lib/utils";

export default function LeaderboardPage() {
  const [rows, setRows] = React.useState<LeaderboardRow[] | null>(null);

  React.useEffect(() => {
    apiFetch<LeaderboardRow[]>("/leaderboard").then(setRows).catch(() => setRows([]));
  }, []);

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="mb-6 text-2xl font-semibold">Leaderboard</h1>
      {!rows && <p className="text-slate-400">Loading...</p>}
      {rows && rows.length === 0 && <p className="text-slate-400">No completed games yet.</p>}
      {rows && rows.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead className="text-slate-400">
            <tr>
              <th className="pb-2">Player</th>
              <th className="pb-2">Wins</th>
              <th className="pb-2">Losses</th>
              <th className="pb-2">Streak</th>
              <th className="pb-2">Best streak</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.address} className="border-t border-white/10">
                <td className="py-2 font-mono">{row.displayName ?? shortenAddress(row.address)}</td>
                <td className="py-2">{row.wins}</td>
                <td className="py-2">{row.losses}</td>
                <td className="py-2">{row.currentStreak}</td>
                <td className="py-2">{row.bestStreak}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
