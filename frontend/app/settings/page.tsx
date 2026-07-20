"use client";

import * as React from "react";
import { useAccount, useReadContract, useWriteContract, usePublicClient } from "wagmi";
import { formatEther } from "viem";
import { ConnectButton } from "@rainbow-me/rainbowkit";

import { useAuth } from "@/lib/auth";
import { shortenAddress } from "@/lib/utils";
import { GAME_MANAGER_ADDRESS } from "@/lib/wagmi";
import gameManagerAbi from "@/lib/abi/GameManager.json";

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

      {isConnected && <WithdrawableBalance address={address} />}

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

/**
 * Winnings, fees, referral commissions, and cancellation refunds all land
 * here as a pull-payment balance (see GameManager's NatSpec for why) - this
 * is the one place in the UI that claims it.
 */
function WithdrawableBalance({ address }: { address: `0x${string}` | undefined }) {
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [isWithdrawing, setIsWithdrawing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const { data: balance, refetch } = useReadContract({
    address: GAME_MANAGER_ADDRESS,
    abi: gameManagerAbi,
    functionName: "pendingWithdrawals",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(GAME_MANAGER_ADDRESS && address) },
  });

  async function withdraw() {
    if (!GAME_MANAGER_ADDRESS || !publicClient) return;
    setError(null);
    setIsWithdrawing(true);
    try {
      const hash = await writeContractAsync({ address: GAME_MANAGER_ADDRESS, abi: gameManagerAbi, functionName: "withdraw" });
      await publicClient.waitForTransactionReceipt({ hash });
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Withdrawal failed");
    } finally {
      setIsWithdrawing(false);
    }
  }

  if (!GAME_MANAGER_ADDRESS) return null;

  const amount = typeof balance === "bigint" ? balance : BigInt(0);

  return (
    <div className="mb-6 rounded-lg border border-white/10 bg-white/5 p-4">
      <p className="mb-2 text-sm font-medium">Withdrawable balance</p>
      <p className="mb-3 font-mono text-lg">{formatEther(amount)} BNB</p>
      <button
        onClick={() => void withdraw()}
        disabled={amount === BigInt(0) || isWithdrawing}
        className="rounded-full bg-indigo-500 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
      >
        {isWithdrawing ? "Withdrawing..." : "Withdraw"}
      </button>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
