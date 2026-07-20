import { randomBytes } from "node:crypto";
import { verifyMessage } from "viem";
import type { Address } from "viem";

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes - short-lived, single-use

export function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

export function nonceExpiry(): Date {
  return new Date(Date.now() + NONCE_TTL_MS);
}

/**
 * A minimal SIWE-style (EIP-4361-flavored) message. Not a full SIWE library
 * dependency - just enough structure (domain, address, nonce, issued-at) to
 * bind a signature to exactly this login attempt and make it unambiguous to
 * a human reading the wallet's signing prompt.
 */
export function buildAuthMessage(params: {
  domain: string;
  address: Address;
  nonce: string;
  chainId: number;
}): string {
  return [
    `${params.domain} wants you to sign in with your Ethereum account:`,
    params.address,
    "",
    "Sign in to the free On-Chain Backgammon platform. This request will not trigger a blockchain transaction or cost any gas.",
    "",
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
}

export async function verifyAuthSignature(params: {
  address: Address;
  message: string;
  signature: `0x${string}`;
}): Promise<boolean> {
  return verifyMessage({
    address: params.address,
    message: params.message,
    signature: params.signature,
  });
}
