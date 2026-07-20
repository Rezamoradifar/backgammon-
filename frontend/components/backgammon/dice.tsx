"use client";

import { cn } from "@/lib/utils";

const PIP_LAYOUTS: Record<number, [number, number][]> = {
  1: [[50, 50]],
  2: [[25, 25], [75, 75]],
  3: [[25, 25], [50, 50], [75, 75]],
  4: [[25, 25], [25, 75], [75, 25], [75, 75]],
  5: [[25, 25], [25, 75], [50, 50], [75, 25], [75, 75]],
  6: [[25, 25], [25, 50], [25, 75], [75, 25], [75, 50], [75, 75]],
};

function Die({ value, used }: { value: number; used: boolean }) {
  return (
    <div
      className={cn(
        "relative h-9 w-9 shrink-0 rounded-md border bg-white shadow-sm transition-opacity",
        used && "opacity-30",
      )}
    >
      {PIP_LAYOUTS[value]?.map(([x, y], i) => (
        <span
          key={i}
          className="absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-900"
          style={{ left: `${x}%`, top: `${y}%` }}
        />
      ))}
    </div>
  );
}

export function DiceTray({ lastRoll, remaining }: { lastRoll: number[]; remaining: number[] }) {
  if (lastRoll.length === 0) return <div className="h-9" />;

  const usedCount = lastRoll.length - remaining.length;
  return (
    <div className="flex items-center gap-1.5">
      {lastRoll.map((value, i) => (
        <Die key={i} value={value} used={i < usedCount} />
      ))}
    </div>
  );
}
