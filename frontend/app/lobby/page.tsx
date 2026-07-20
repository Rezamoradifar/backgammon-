"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { decodeEventLog, parseEther, formatEther } from "viem";
import { ConnectButton } from "@rainbow-me/rainbowkit";

import { useAuth } from "@/lib/auth";
import { useGameSocket } from "@/lib/useGameSocket";
import { GAME_MANAGER_ADDRESS } from "@/lib/wagmi";
import { shortenAddress } from "@/lib/utils";
import gameManagerAbi from "@/lib/abi/GameManager.json";

type Status = "idle" | "queued" | "matched" | "creating" | "waitingForOpponentCreate" | "joining" | "error";

export default function LobbyPage() {
  const { isConnected } = useAccount();
  const { isAuthenticated, isSigningIn, login, token } = useAuth();
  const { onMessage, send } = useGameSocket(token);
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const router = useRouter();

  const [stakeInput, setStakeInput] = React.useState("0");
  const [status, setStatus] = React.useState<Status>("idle");
  const [opponentAddress, setOpponentAddress] = React.useState<string | null>(null);
  const [amICreator, setAmICreator] = React.useState(false);
  const [matchedStake, setMatchedStake] = React.useState<bigint>(BigInt(0));
  const [onChainGameId, setOnChainGameId] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    return onMessage((message) => {
      if (message.type === "matched") {
        setOpponentAddress(message.opponentAddress);
        setAmICreator(message.amICreator);
        setMatchedStake(BigInt(message.stake));
        setStatus("matched");
      }
      if (message.type === "gameCreated") {
        setOnChainGameId(message.onChainGameId);
      }
    });
  }, [onMessage]);

  // Creator: as soon as we're matched, create the on-chain game (staking the
  // amount both sides queued for) and tell the opponent its id.
  React.useEffect(() => {
    if (status !== "matched" || !amICreator || !GAME_MANAGER_ADDRESS || !publicClient) return;

    (async () => {
      setStatus("creating");
      try {
        const hash = await writeContractAsync({
          address: GAME_MANAGER_ADDRESS,
          abi: gameManagerAbi,
          functionName: "createGame",
          value: matchedStake,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        const createdLog = receipt.logs
          .map((log) => {
            try {
              return decodeEventLog({ abi: gameManagerAbi, data: log.data, topics: log.topics });
            } catch {
              return null;
            }
          })
          .find((decoded) => decoded?.eventName === "GameCreated");

        const gameId = (createdLog?.args as { gameId: bigint } | undefined)?.gameId;
        if (!gameId) throw new Error("Could not read the created game's id from the transaction");

        send({ type: "gameCreated", onChainGameId: gameId.toString() });
        router.push(`/game/${gameId.toString()}`);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "Failed to create the game");
        setStatus("error");
      }
    })();
  }, [status, amICreator, matchedStake, publicClient, writeContractAsync, send, router]);

  // Joiner: once we know the on-chain gameId the creator produced, join it,
  // sending exactly the stake both sides queued for (must match createGame's
  // msg.value exactly or the transaction reverts).
  React.useEffect(() => {
    if (status !== "matched" || amICreator || !onChainGameId || !GAME_MANAGER_ADDRESS || !publicClient) return;

    (async () => {
      setStatus("joining");
      try {
        const hash = await writeContractAsync({
          address: GAME_MANAGER_ADDRESS,
          abi: gameManagerAbi,
          functionName: "joinGame",
          args: [BigInt(onChainGameId)],
          value: matchedStake,
        });
        await publicClient.waitForTransactionReceipt({ hash });
        router.push(`/game/${onChainGameId}`);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "Failed to join the game");
        setStatus("error");
      }
    })();
  }, [status, amICreator, onChainGameId, matchedStake, publicClient, writeContractAsync, router]);

  function findMatch() {
    let stakeWei: bigint;
    try {
      stakeWei = parseEther(stakeInput || "0");
    } catch {
      setErrorMessage("Enter a valid BNB amount (or 0 for a free match)");
      setStatus("error");
      return;
    }
    send({ type: "queue", stake: stakeWei.toString() });
    setStatus("queued");
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-6 px-6 py-16 text-center">
      <h1 className="text-2xl font-semibold">Find a match</h1>

      {!isConnected && (
        <div className="flex flex-col items-center gap-3">
          <p className="text-slate-300">Connect a wallet to play.</p>
          <ConnectButton />
        </div>
      )}

      {isConnected && !isAuthenticated && (
        <button
          onClick={() => void login()}
          disabled={isSigningIn}
          className="rounded-full bg-indigo-500 px-6 py-2.5 font-medium text-white disabled:opacity-50"
        >
          {isSigningIn ? "Check your wallet..." : "Sign in to play"}
        </button>
      )}

      {isConnected && isAuthenticated && status === "idle" && (
        <div className="flex flex-col items-center gap-4">
          <div className="flex flex-col items-center gap-1">
            <label htmlFor="stake" className="text-sm text-slate-400">
              Stake per player (BNB) - 0 for a free match
            </label>
            <input
              id="stake"
              value={stakeInput}
              onChange={(e) => setStakeInput(e.target.value)}
              inputMode="decimal"
              placeholder="0"
              className="w-40 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-center text-sm"
            />
            <p className="text-xs text-slate-500">You&apos;ll only be matched with someone queuing the same stake.</p>
          </div>
          <button onClick={findMatch} className="rounded-full bg-indigo-500 px-8 py-3 font-medium text-white hover:bg-indigo-400">
            Find a match
          </button>
        </div>
      )}

      {status === "queued" && <p className="text-slate-300">Waiting for an opponent...</p>}

      {status === "matched" && opponentAddress && (
        <p className="text-slate-300">
          Matched with <span className="font-mono">{shortenAddress(opponentAddress)}</span>
          {matchedStake > BigInt(0) && <> for {formatEther(matchedStake)} BNB each</>} - preparing the match...
        </p>
      )}

      {status === "creating" && <p className="text-slate-300">Creating the on-chain match - confirm in your wallet...</p>}
      {status === "joining" && <p className="text-slate-300">Joining the on-chain match - confirm in your wallet...</p>}

      {status === "error" && (
        <div className="flex flex-col items-center gap-3">
          <p className="text-red-400">{errorMessage}</p>
          <button onClick={() => setStatus("idle")} className="rounded-full border border-white/20 px-6 py-2 text-sm">
            Try again
          </button>
        </div>
      )}

      {!GAME_MANAGER_ADDRESS && (
        <p className="text-xs text-amber-400">
          NEXT_PUBLIC_GAME_MANAGER_ADDRESS is not set - matchmaking can pair you with an opponent, but creating/joining the
          on-chain game will not work until it is configured.
        </p>
      )}
    </div>
  );
}
