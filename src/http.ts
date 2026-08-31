import type { Request, Response, NextFunction } from "express";

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header("x-request-id")?.trim();
  const id = incoming && incoming.length > 0 ? incoming : crypto.randomUUID();
  req.requestId = id;
  res.setHeader("x-request-id", id);
  next();
}

export function jsonError(
  res: Response,
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  res.status(status).json({
    error: {
      code,
      message,
      ...(extra ?? {}),
    },
  });
}

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}
