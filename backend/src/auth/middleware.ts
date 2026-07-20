import type { NextFunction, Request, Response } from "express";

import { verifySessionToken, type SessionClaims } from "./jwt.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionClaims;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  try {
    req.session = verifySessionToken(header.slice("Bearer ".length));
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session token" });
  }
}
