"use client";

import { cn } from "@/lib/utils";
import { Checker } from "./checker";
import type { PointState } from "@/lib/backgammonTypes";

const MAX_STACK_SHOWN = 5;

export function BoardPoint({
  point,
  state,
  orientation,
  selectable,
  selected,
  highlighted,
  onClick,
}: {
  point: number;
  state: PointState;
  orientation: "up" | "down";
  selectable: boolean;
  selected: boolean;
  highlighted: boolean;
  onClick: () => void;
}) {
  const isDark = point % 2 === 0;
  const overflow = state.count > MAX_STACK_SHOWN ? state.count - MAX_STACK_SHOWN : 0;
  const shown = Math.min(state.count, MAX_STACK_SHOWN);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!selectable}
      aria-label={`Point ${point}`}
      className={cn(
        "group relative flex w-full flex-1 flex-col items-center gap-0.5 px-0.5 outline-none",
        orientation === "down" ? "justify-start pt-1" : "justify-end pb-1 [flex-direction:column-reverse]",
        selectable && "cursor-pointer",
      )}
    >
      <div
        className={cn(
          "pointer-events-none absolute inset-x-1 h-full",
          orientation === "down" ? "top-0" : "bottom-0",
          isDark ? "opacity-90" : "opacity-60",
        )}
        style={{
          clipPath:
            orientation === "down"
              ? "polygon(0 0, 100% 0, 50% 92%)"
              : "polygon(0 100%, 100% 100%, 50% 8%)",
          background: isDark ? "#6366f1cc" : "#94a3b866",
        }}
      />
      {highlighted && (
        <div className="pointer-events-none absolute inset-1 rounded-md ring-2 ring-emerald-400/70" />
      )}
      {selected && <div className="pointer-events-none absolute inset-1 rounded-md ring-2 ring-indigo-400" />}

      <div
        className={cn(
          "relative z-10 flex w-full flex-1 gap-0.5",
          orientation === "down" ? "flex-col items-center" : "flex-col-reverse items-center",
        )}
      >
        {state.owner &&
          Array.from({ length: shown }).map((_, i) => <Checker key={i} owner={state.owner!} />)}
        {overflow > 0 && (
          <span className="z-20 text-[10px] font-semibold text-white">+{overflow}</span>
        )}
      </div>
    </button>
  );
}
