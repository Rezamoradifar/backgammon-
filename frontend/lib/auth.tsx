"use client";

import * as React from "react";
import { useAccount, useConfig, useSignMessage } from "wagmi";
import { watchAccount } from "wagmi/actions";

import { apiFetch } from "./api";

const STORAGE_KEY = "onchain-backgammon:session:v1";

interface StoredSession {
  address: string;
  token: string;
}

interface AuthContextValue {
  token: string | null;
  isAuthenticated: boolean;
  isSigningIn: boolean;
  login: () => Promise<void>;
  logout: () => void;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

function readStoredSession(): StoredSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

function writeStoredSession(session: StoredSession | null) {
  try {
    if (session) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore private-mode / quota errors
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const config = useConfig();
  const [token, setToken] = React.useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = React.useState(false);

  // Sync the session with the wallet connection: restore a stored session
  // when it matches the newly-connected address, and drop it on disconnect
  // or when switching to a different wallet.
  React.useEffect(() => {
    return watchAccount(config, {
      onChange(account) {
        if (!account.isConnected || !account.address) {
          setToken(null);
          writeStoredSession(null);
          return;
        }
        const stored = readStoredSession();
        if (stored && stored.address.toLowerCase() === account.address.toLowerCase()) {
          setToken(stored.token);
        } else {
          setToken(null);
        }
      },
    });
  }, [config]);

  const login = React.useCallback(async () => {
    if (!address) return;
    setIsSigningIn(true);
    try {
      const { message } = await apiFetch<{ message: string }>("/auth/nonce", {
        method: "POST",
        body: JSON.stringify({ address, chainId: 97 }),
      });
      const signature = await signMessageAsync({ message });
      const { token: newToken } = await apiFetch<{ token: string }>("/auth/verify", {
        method: "POST",
        body: JSON.stringify({ address, message, signature }),
      });
      setToken(newToken);
      writeStoredSession({ address, token: newToken });
    } finally {
      setIsSigningIn(false);
    }
  }, [address, signMessageAsync]);

  const logout = React.useCallback(() => {
    setToken(null);
    writeStoredSession(null);
  }, []);

  const value = React.useMemo<AuthContextValue>(
    () => ({ token, isAuthenticated: token !== null, isSigningIn, login, logout }),
    [token, isSigningIn, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
