"use client";

import { cn } from "@/lib/utils";
import { BoardPoint } from "./point";
import { Checker } from "./checker";
import type { GameState, Move, MoveSource, Player } from "@/lib/backgammonTypes";

const TOP_LEFT = [13, 14, 15, 16, 17, 18];
const TOP_RIGHT = [19, 20, 21, 22, 23, 24];
const BOTTOM_LEFT = [12, 11, 10, 9, 8, 7];
const BOTTOM_RIGHT = [6, 5, 4, 3, 2, 1];

export function Board({
  state,
  selected,
  legalMoves,
  legalDestinations,
  isInteractive,
  onSelectPoint,
  onSelectBar,
  onMoveToPoint,
  onBearOff,
}: {
  state: GameState;
  selected: MoveSource | null;
  legalMoves: Move[];
  legalDestinations: Move[];
  isInteractive: boolean;
  onSelectPoint: (point: number) => void;
  onSelectBar: () => void;
  onMoveToPoint: (point: number) => void;
  onBearOff: () => void;
}) {
  const selectablePoints = new Set(
    legalMoves.filter((m) => m.source.type === "point").map((m) => (m.source as { point: number }).point),
  );
  const destinationPoints = new Set(
    legalDestinations.filter((m) => m.to !== null).map((m) => m.to as number),
  );
  const canBearOff = legalDestinations.some((m) => m.to === null);
  const barIsSelectable = legalMoves.some((m) => m.source.type === "bar");

  function handlePointClick(point: number) {
    if (!isInteractive) return;
    if (destinationPoints.has(point)) {
      onMoveToPoint(point);
      return;
    }
    if (selectablePoints.has(point)) {
      onSelectPoint(point);
    }
  }

  function renderPoint(point: number, orientation: "up" | "down") {
    return (
      <BoardPoint
        key={point}
        point={point}
        state={state.points[point - 1]}
        orientation={orientation}
        selectable={isInteractive && (selectablePoints.has(point) || destinationPoints.has(point))}
        selected={selected?.type === "point" && selected.point === point}
        highlighted={destinationPoints.has(point)}
        onClick={() => handlePointClick(point)}
      />
    );
  }

  return (
    <div className="w-full landscape:flex landscape:justify-center">
      <div
        className="mx-auto flex w-full flex-col gap-2 rounded-xl border border-white/10 bg-[#2b1d12] p-3 shadow-inner landscape:h-[min(78vh,560px)] landscape:w-auto"
        style={{ aspectRatio: "16 / 10" }}
      >
        <div className="flex flex-1 gap-1">
          <div className="flex flex-1 gap-1">{TOP_LEFT.map((p) => renderPoint(p, "down"))}</div>
          <BarColumn
            side="top"
            state={state}
            selectable={isInteractive && barIsSelectable}
            selected={selected?.type === "bar"}
            onClick={onSelectBar}
          />
          <div className="flex flex-1 gap-1">{TOP_RIGHT.map((p) => renderPoint(p, "down"))}</div>
          <BearOffTray
            player="black"
            count={state.borneOff.black}
            selectable={isInteractive && canBearOff && state.turn === "black"}
            onClick={onBearOff}
          />
        </div>
        <div className="h-px bg-white/10" />
        <div className="flex flex-1 gap-1">
          <div className="flex flex-1 gap-1">{BOTTOM_LEFT.map((p) => renderPoint(p, "up"))}</div>
          <BarColumn
            side="bottom"
            state={state}
            selectable={isInteractive && barIsSelectable}
            selected={selected?.type === "bar"}
            onClick={onSelectBar}
          />
          <div className="flex flex-1 gap-1">{BOTTOM_RIGHT.map((p) => renderPoint(p, "up"))}</div>
          <BearOffTray
            player="white"
            count={state.borneOff.white}
            selectable={isInteractive && canBearOff && state.turn === "white"}
            onClick={onBearOff}
          />
        </div>
      </div>
    </div>
  );
}

function BarColumn({
  side,
  state,
  selectable,
  selected,
  onClick,
}: {
  side: "top" | "bottom";
  state: GameState;
  selectable: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  const primary: Player = side === "top" ? "black" : "white";
  const count = state.bar[primary];

  return (
    <button
      type="button"
      disabled={!selectable}
      onClick={onClick}
      className={cn(
        "relative flex w-8 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border border-white/10 bg-black/20",
        selectable && "cursor-pointer",
      )}
    >
      {selected && <div className="pointer-events-none absolute inset-0.5 rounded-md ring-2 ring-indigo-400" />}
      {count > 0 ? (
        <>
          <Checker owner={primary} />
          {count > 1 && <span className="text-[10px] font-semibold text-white">×{count}</span>}
        </>
      ) : (
        <span className="text-[9px] text-white/50">BAR</span>
      )}
    </button>
  );
}

function BearOffTray({
  player,
  count,
  selectable,
  onClick,
}: {
  player: Player;
  count: number;
  selectable: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!selectable}
      onClick={onClick}
      className={cn(
        "flex w-9 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-white/20 text-xs text-white",
        selectable && "cursor-pointer ring-2 ring-emerald-400/70",
      )}
    >
      <Checker owner={player} className="opacity-70" />
      <span className="font-semibold">{count}</span>
    </button>
  );
}
