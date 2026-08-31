import type { Request, Response, NextFunction, RequestHandler } from "express";
import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import type { TollgateConfig } from "./config.js";
import { isFreePath } from "./config.js";
import { jsonError } from "./http.js";
import { mockUpstreamResponse } from "./upstream.js";

/** Headers that must not be forwarded to upstream. */
const STRIP_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  // Payment headers stay at the gateway.
  "payment-signature",
  "payment-required",
  "payment-response",
  "x-demo-payment",
]);

export function mockUpstreamHandler(req: Request, res: Response): void {
  const result = mockUpstreamResponse(
    req.method,
    req.path,
    req.query as Record<string, unknown>,
    req.body,
  );
  res.status(result.status).json(result.body);
}

export function createUpstreamHandler(config: TollgateConfig): RequestHandler {
  if (!config.upstreamUrl) {
    return (req, res, next) => {
      if (isFreePath(req.path)) {
        next();
        return;
      }
      mockUpstreamHandler(req, res);
    };
  }

  const proxy = createProxyMiddleware({
    target: config.upstreamUrl,
    changeOrigin: true,
    xfwd: true,
    on: {
      proxyReq: (proxyReq, req) => {
        for (const name of STRIP_REQUEST_HEADERS) {
          proxyReq.removeHeader(name);
        }
        // Re-apply body after express.json() consumed the stream.
        fixRequestBody(proxyReq, req);
      },
      error: (err, _req, res) => {
        const response = res as Response;
        if (!response.headersSent) {
          jsonError(response, 502, "upstream_error", err.message || "Upstream request failed");
        }
      },
    },
  });

  return (req: Request, res: Response, next: NextFunction) => {
    if (isFreePath(req.path)) {
      next();
      return;
    }
    return proxy(req, res, next);
  };
}
