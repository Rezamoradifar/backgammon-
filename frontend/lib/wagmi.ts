import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { metaMaskWallet, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets";
import type { WalletList } from "@rainbow-me/rainbowkit";
import { createConfig, http } from "wagmi";
import { bscTestnet, bsc } from "wagmi/chains";
import type { Chain } from "viem";

const hardhatLocal: Chain = {
  id: 31337,
  name: "Hardhat Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
};

const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

const chains: [Chain, ...Chain[]] =
  process.env.NODE_ENV === "development"
    ? [hardhatLocal, bscTestnet, bsc]
    : [bscTestnet, bsc];

// Only MetaMask + WalletConnect are wired up (as specified), rather than
// RainbowKit's full default wallet list. WalletConnect v2 hard-requires a
// Cloud projectId (https://cloud.walletconnect.com) - without one it throws
// at config time, which would take down local/CI builds that don't have that
// secret configured, so it's only added once a real projectId is present.
const wallets = walletConnectProjectId ? [metaMaskWallet, walletConnectWallet] : [metaMaskWallet];
const walletGroups: WalletList = [{ groupName: "Recommended", wallets }];

const connectors = connectorsForWallets(walletGroups, {
  appName: "On-Chain Backgammon",
  projectId: walletConnectProjectId || "unused-no-walletconnect-configured",
});

export const wagmiConfig = createConfig({
  chains,
  connectors,
  transports: Object.fromEntries(chains.map((chain) => [chain.id, http()])),
  ssr: true,
});

export const GAME_MANAGER_ADDRESS = process.env.NEXT_PUBLIC_GAME_MANAGER_ADDRESS as `0x${string}` | undefined;
export const PLAYER_REGISTRY_ADDRESS = process.env.NEXT_PUBLIC_PLAYER_REGISTRY_ADDRESS as `0x${string}` | undefined;
