export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
export const WS_BASE_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000";

export async function apiFetch<T>(path: string, options: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, headers, ...rest } = options;
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error ? JSON.stringify(body.error) : `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export interface LeaderboardRow {
  address: string;
  displayName: string | null;
  wins: number;
  losses: number;
  gamesPlayed: number;
  currentStreak: number;
  bestStreak: number;
}

export interface GameHistoryEntry {
  gameId: string;
  state: string;
  players: { address: string; color: "WHITE" | "BLACK" }[];
  winner: string | null;
  completedAt: string | null;
}
