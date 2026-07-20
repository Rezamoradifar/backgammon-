import Link from "next/link";

export default function Home() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-6 py-24 text-center">
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Backgammon, free and on-chain</h1>
      <p className="max-w-xl text-lg text-slate-300">
        Play 1v1 against another wallet on BNB Smart Chain. No stakes, no
        wallet-held funds, no payouts - matches are created, joined, and
        recorded on-chain; the game itself is played move-by-move over a live
        connection, validated by the server so nobody can cheat.
      </p>
      <Link
        href="/lobby"
        className="rounded-full bg-indigo-500 px-8 py-3 text-base font-medium text-white transition hover:bg-indigo-400"
      >
        Play now
      </Link>
      <p className="text-sm text-slate-500">
        Free to play. This version has no wagering, entry fees, or payouts - see the project&apos;s
        ARCHITECTURE.md for why.
      </p>
    </div>
  );
}
