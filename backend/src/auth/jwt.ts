import jwt from "jsonwebtoken";

export interface SessionClaims {
  userId: string;
  walletId: string;
  address: string;
}

function secret(): string {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error("JWT_SECRET is not set");
  return value;
}

export function issueSessionToken(claims: SessionClaims): string {
  return jwt.sign(claims, secret(), { expiresIn: (process.env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"]) ?? "7d" });
}

export function verifySessionToken(token: string): SessionClaims {
  return jwt.verify(token, secret()) as SessionClaims;
}
