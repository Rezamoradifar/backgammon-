"use client";

import * as React from "react";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";

import { useAuth } from "@/lib/auth";
import { shortenAddress } from "@/lib/utils";

export default function SettingsPage() {
  const { address, isConnected } = useAccount();
  const { isAuthenticated, logout } = useAuth();

  return (
    <div className="mx-auto max-w-lg px-4 py-10">
      <h1 className="mb-6 text-2xl font-semibold">Settings</h1>

      <div className="mb-6 rounded-lg border border-white/10 bg-white/5 p-4">
        <p className="mb-2 text-sm font-medium">Wallet</p>
        {isConnected ? (
          <p className="font-mono text-sm text-slate-300">{address ? shortenAddress(address) : ""}</p>
        ) : (
          <ConnectButton />
        )}
      </div>

      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <p className="mb-2 text-sm font-medium">Session</p>
        <p className="mb-3 text-sm text-slate-300">{isAuthenticated ? "Signed in" : "Not signed in"}</p>
        {isAuthenticated && (
          <button onClick={logout} className="rounded-full border border-white/20 px-4 py-1.5 text-sm hover:bg-white/5">
            Sign out
          </button>
        )}
      </div>
    </div>
  );
}
