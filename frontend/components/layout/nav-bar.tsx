"use client";

import Link from "next/link";
import { ConnectButton } from "@rainbow-me/rainbowkit";

const LINKS = [
  { href: "/lobby", label: "Play" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/history", label: "History" },
  { href: "/referral", label: "Referral" },
  { href: "/settings", label: "Settings" },
];

export function NavBar() {
  return (
    <header className="flex items-center justify-between border-b border-white/10 px-4 py-3 sm:px-6">
      <Link href="/" className="text-lg font-semibold tracking-tight">
        On-Chain Backgammon
      </Link>
      <nav className="hidden items-center gap-6 text-sm text-slate-300 md:flex">
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href} className="hover:text-white">
            {link.label}
          </Link>
        ))}
      </nav>
      <ConnectButton />
    </header>
  );
}
