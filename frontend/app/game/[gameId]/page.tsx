"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";

import { useAuth } from "@/lib/auth";
import { useGameSocket } from "@/lib/useGameSocket";
import { useServerBackgammon } from "@/lib/useServerBackgammon";
import { apiFetch } from "@/lib/api";
import { GAME_MANAGER_ADDRESS } from "@/lib/wagmi";
import { Board } from "@/components/backgammon/board";
import { DiceTray } from "@/components/backgammon/dice";
import gameManagerAbi from "@/lib/abi/GameManager.json";
import type { Player } from "@/lib/backgammonTypes";

interface GameLookup {
  id: string;
  state: string;
  players: { address: string; color: "WHITE" | "BLACK" }[];
}

export default function GamePage() {
  const params = useParams<{ gameId: string }>();
  const onChainGameId = params.gameId;

  const { address } = useAccount();
  const { token } = useAuth();
  const { onMessage, send } = useGameSocket(token);
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [lookup, setLookup] = React.useState<GameLookup | null>(null);
  const [myColor, setMyColor] = React.useState<Player | null>(null);
  const [isStarting, setIsStarting] = React.useState(false);
  const joinedRoomRef = React.useRef(false);

  // Poll the backend until the indexer has seen this game (createGame/joinGame confirmed on-chain).
  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const result = await apiFetch<GameLookup>(`/games/lookup/${onChainGameId}`);
        if (cancelled) return;
        setLookup(result);
        if (result.state !== "ACTIVE") {
          timer = setTimeout(poll, 2000);
        }
      } catch {
        if (!cancelled) timer = setTimeout(poll, 2000);
      }
    }
    void poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [onChainGameId]);

  // Once the game is ACTIVE, join the live WebSocket room.
  React.useEffect(() => {
    if (!lookup || lookup.state !== "ACTIVE" || joinedRoomRef.current) return;
    joinedRoomRef.current = true;
    send({ type: "joinRoom", gameId: lookup.id });
  }, [lookup, send]);

  React.useEffect(() => {
    return onMessage((message) => {
      if (message.type === "roomJoined") setMyColor(message.color);
    });
  }, [onMessage]);

  const game = useServerBackgammon({ gameId: lookup?.id ?? "", myColor, onMessage, send });

  async function startGame() {
    if (!GAME_MANAGER_ADDRESS || !publicClient) return;
    setIsStarting(true);
    try {
      const hash = await writeContractAsync({
        address: GAME_MANAGER_ADDRESS,
        abi: gameManagerAbi,
        functionName: "startGame",
        args: [BigInt(onChainGameId)],
      });
      await publicClient.waitForTransactionReceipt({ hash });
    } finally {
      setIsStarting(false);
    }
  }

  if (!lookup) {
    return <StatusScreen text="Looking up this match..." />;
  }

  if (lookup.state === "WAITING_FOR_PLAYER") {
    return <StatusScreen text="Waiting for an opponent to join..." />;
  }

  if (lookup.state === "CREATED") {
    return (
      <StatusScreen text="Both players are seated - either player can start the match.">
        <button
          onClick={() => void startGame()}
          disabled={isStarting}
          className="mt-4 rounded-full bg-indigo-500 px-6 py-2.5 font-medium text-white disabled:opacity-50"
        >
          {isStarting ? "Starting - confirm in your wallet..." : "Start game"}
        </button>
      </StatusScreen>
    );
  }

  if (!game.state) {
    return <StatusScreen text="Joining the live game..." />;
  }

  const opponentColor: Player = myColor === "white" ? "black" : "white";
  const opponent = lookup.players.find((p) => p.color.toLowerCase() === opponentColor);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
        <div>
          <p className="text-sm font-medium">
            {game.state.winner
              ? game.state.winner === myColor
                ? "You win!"
                : "You lose"
              : game.isMyTurn
                ? "Your turn"
                : `Opponent's turn${opponent ? ` (${opponent.address.slice(0, 6)}...)` : ""}`}
          </p>
          {game.message === "noMoves" && !game.state.winner && (
            <p className="text-xs text-red-400">No legal moves - turn skipped</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <DiceTray lastRoll={game.state.lastRoll} remaining={game.state.dice} />
          <button
            onClick={game.roll}
            disabled={!game.canRoll}
            className="rounded-full bg-indigo-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            Roll dice
          </button>
        </div>
      </div>

      <Board
        state={game.state}
        selected={game.selected}
        legalMoves={game.legalMoves}
        legalDestinations={game.legalDestinationsFromSelected}
        isInteractive={game.isInteractive}
        onSelectPoint={(point) => game.selectSource({ type: "point", point })}
        onSelectBar={() => game.selectSource({ type: "bar" })}
        onMoveToPoint={(point) => game.moveTo(point)}
        onBearOff={() => game.moveTo(null)}
      />

      <p className="text-center text-xs text-slate-500">
        You are playing as <span className="font-mono">{address ? `${address.slice(0, 6)}...` : ""}</span> ({myColor ?? "?"})
      </p>
    </div>
  );
}

function StatusScreen({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-2 px-6 py-24 text-center">
      <p className="text-slate-300">{text}</p>
      {children}
    </div>
  );
}
