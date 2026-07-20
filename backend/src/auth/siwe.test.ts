import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { buildAuthMessage, generateNonce, verifyAuthSignature } from "./siwe.js";

test("a wallet's real signature over the issued message verifies successfully", async () => {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  const nonce = generateNonce();
  const message = buildAuthMessage({
    domain: "onchain-backgammon.local",
    address: account.address,
    nonce,
    chainId: 97,
  });

  const signature = await account.signMessage({ message });

  const isValid = await verifyAuthSignature({ address: account.address, message, signature });
  assert.equal(isValid, true);
});

test("a signature from a different wallet does not verify against this address", async () => {
  const signerKey = generatePrivateKey();
  const signer = privateKeyToAccount(signerKey);
  const otherKey = generatePrivateKey();
  const other = privateKeyToAccount(otherKey);

  const message = buildAuthMessage({
    domain: "onchain-backgammon.local",
    address: other.address,
    nonce: generateNonce(),
    chainId: 97,
  });

  const signature = await signer.signMessage({ message });

  const isValid = await verifyAuthSignature({ address: other.address, message, signature });
  assert.equal(isValid, false);
});

test("a tampered message does not verify even with a genuinely valid signature", async () => {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  const message = buildAuthMessage({
    domain: "onchain-backgammon.local",
    address: account.address,
    nonce: generateNonce(),
    chainId: 97,
  });

  const signature = await account.signMessage({ message });
  const tamperedMessage = message.replace("Nonce:", "Nonce: tampered-");

  const isValid = await verifyAuthSignature({ address: account.address, message: tamperedMessage, signature });
  assert.equal(isValid, false);
});
