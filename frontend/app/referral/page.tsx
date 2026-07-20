"use client";

import * as React from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";

import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { shortenAddress } from "@/lib/utils";
import { PLAYER_REGISTRY_ADDRESS } from "@/lib/wagmi";
import playerRegistryAbi from "@/lib/abi/PlayerRegistry.json";

interface ReferralRow {
  refereeAddress: string;
  createdAt: string;
}

export default function ReferralPage() {
  const { address, isConnected } = useAccount();
  const { token, isAuthenticated, login, isSigningIn } = useAuth();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [referrals, setReferrals] = React.useState<ReferralRow[] | null>(null);
  const [claimInput, setClaimInput] = React.useState("");
  const [claimMessage, setClaimMessage] = React.useState<string | null>(null);
  const [isClaiming, setIsClaiming] = React.useState(false);

  React.useEffect(() => {
    if (!token) return;
    apiFetch<ReferralRow[]>("/referral/mine", { token }).then(setReferrals).catch(() => setReferrals([]));
  }, [token]);

  async function claim() {
    if (!token || !PLAYER_REGISTRY_ADDRESS || !publicClient) return;
    setClaimMessage(null);
    setIsClaiming(true);
    try {
      // The on-chain call is the one that actually matters (it's what future
      // wagers pay commission against) - the backend record is only for this
      // page's "wallets you referred" list, since the chain has no reverse
      // index for that.
      const hash = await writeContractAsync({
        address: PLAYER_REGISTRY_ADDRESS,
        abi: playerRegistryAbi,
        functionName: "setReferrer",
        args: [claimInput],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await apiFetch("/referral/claim", { method: "POST", token, body: JSON.stringify({ referrerAddress: claimInput }) })
        .catch(() => {}); // best-effort - the on-chain call above is the one that actually matters
      setClaimMessage("Referrer set on-chain - future wagers will pay them a commission.");
    } catch (err) {
      setClaimMessage(err instanceof Error ? err.message : "Failed to set referrer");
    } finally {
      setIsClaiming(false);
    }
  }

  if (!isConnected) {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-4 px-6 py-24 text-center">
        <p className="text-slate-300">Connect a wallet to use referrals.</p>
        <ConnectButton />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <h1 className="mb-2 text-2xl font-semibold">Referrals</h1>
      <p className="mb-6 text-sm text-slate-400">
        Setting a referrer is on-chain and one-time - once set it can&apos;t be changed. Your referrer (and theirs, up to 3
        levels up) earns a share of the platform fee on every wager you play, paid automatically when a match settles.
      </p>

      <div className="mb-6 rounded-lg border border-white/10 bg-white/5 p-4">
        <p className="mb-2 text-sm font-medium">Your referral link</p>
        <code className="block break-all rounded bg-black/30 p-2 text-xs">
          {typeof window !== "undefined" ? `${window.location.origin}/?ref=${address}` : ""}
        </code>
      </div>

      {!isAuthenticated ? (
        <button onClick={() => void login()} disabled={isSigningIn} className="rounded-full bg-indigo-500 px-6 py-2.5 font-medium text-white disabled:opacity-50">
          {isSigningIn ? "Check your wallet..." : "Sign in to manage referrals"}
        </button>
      ) : (
        <>
          <div className="mb-6 flex gap-2">
            <input
              value={claimInput}
              onChange={(e) => setClaimInput(e.target.value)}
              placeholder="Referrer wallet address"
              className="flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm"
            />
            <button
              onClick={() => void claim()}
              disabled={isClaiming || !claimInput}
              className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {isClaiming ? "Confirm in wallet..." : "Set as my referrer"}
            </button>
          </div>
          {claimMessage && <p className="mb-4 text-sm text-slate-300">{claimMessage}</p>}

          <p className="mb-2 text-sm font-medium">Wallets you referred</p>
          <ul className="flex flex-col gap-2">
            {referrals?.map((r) => (
              <li key={r.refereeAddress} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-mono">
                {shortenAddress(r.refereeAddress)}
              </li>
            ))}
            {referrals?.length === 0 && <p className="text-sm text-slate-400">No referrals yet.</p>}
          </ul>
        </>
      )}
    </div>
  );
}
