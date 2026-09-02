import path from "node:path";
import { readFile } from "node:fs/promises";
import express, { type Express, type Request, type Response, type RequestHandler } from "express";
import cors from "cors";
import type { TollgateConfig } from "./config.js";
import { loadConfig, isGatedPath } from "./config.js";
import { requestIdMiddleware, jsonError } from "./http.js";
import { createPaymentLayer, type PaymentLayer } from "./payment.js";
import { createUpstreamHandler } from "./proxy.js";
import { createFetchMdHandler } from "./fetch-md.js";
import { mountMcpTransports } from "./mcp/http.js";
import type { McpPaymentLayer } from "./mcp/payment.js";
import { resolvePublicDir } from "./static.js";
import { listMerchantsPublic } from "./merchants.js";

export interface AppOptions {
  config?: TollgateConfig;
  /** Inject HTTP payment layer (tests). When omitted, built from config. */
  paymentLayer?: PaymentLayer;
  /** Inject MCP payment layer (tests). */
  mcpPaymentLayer?: McpPaymentLayer;
  /** Inject upstream handler (tests). */
  upstreamHandler?: RequestHandler;
  /** Inject paid GET /v1/fetch-md handler (tests). */
  fetchMdHandler?: RequestHandler;
  /** Skip mounting MCP transports (unit tests that only need HTTP). */
  disableMcp?: boolean;
}

export interface CreatedApp {
  app: Express;
  config: TollgateConfig;
  payment: PaymentLayer;
  mcpPayment?: McpPaymentLayer;
  publicDir: string;
}

export async function createApp(options: AppOptions = {}): Promise<CreatedApp> {
  const config = options.config ?? loadConfig();
  const payment = options.paymentLayer ?? (await createPaymentLayer(config));
  const upstream = options.upstreamHandler ?? createUpstreamHandler(config);
  const publicDir = resolvePublicDir();

  const app = express();
  app.disable("x-powered-by");
  // Honor X-Forwarded-Proto behind TLS terminators (Render). Only when
  // PUBLIC_BASE_URL is https so local http://127.0.0.1 tests stay unchanged.
  // @x402/express ExpressAdapter.getUrl() uses req.protocol — without this,
  // live 402 resource.url is advertised as http:// and Bazaar rejects it.
  if (/^https:\/\//i.test(config.publicBaseUrl)) {
    app.set("trust proxy", 1);
  }
  app.use(cors());
  app.use(requestIdMiddleware);

  // Lenient JSON: empty/malformed bodies on gated paths must still reach x402 → 402
  // (Bazaar crawlers often probe with odd/empty bodies; never answer those with 400).
  app.use((req, res, next) => {
    express.json({ limit: "1mb" })(req, res, (err: unknown) => {
      if (err && isGatedPath(req.path, config.gatedPrefix)) {
        req.body = undefined;
        next();
        return;
      }
      next(err);
    });
  });
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      service: "x402-micro-tollgate",
      mode: payment.mode,
      environment: config.environment,
      network: config.network,
      gatedPrefix: config.gatedPrefix || "*",
      upstream: config.upstreamUrl ?? "mock",
      payTo: payment.payToEvmAddress ?? null,
      publicBaseUrl: config.publicBaseUrl,
      feeCollector: config.feeCollector,
      defaultMerchant: config.defaultMerchant,
      mcp: {
        streamableHttp: "/mcp",
        sse: "/sse",
      },
    });
  });

  // Free merchant registry listing (no secrets). Also served at /v1/merchants via FREE_PATHS.
  const sendMerchants = (_req: Request, res: Response) => {
    res.status(200).json({
      feeCollector: config.feeCollector,
      defaultMerchant: config.defaultMerchant,
      merchants: listMerchantsPublic(config.merchants),
    });
  };
  app.get("/merchants", sendMerchants);
  app.get("/v1/merchants", sendMerchants);

  // Developer landing (free). Inject contact email; /zh prefers Chinese via client script.
  const sendLanding = (_req: Request, res: Response) => {
    const filePath = path.join(publicDir, "index.html");
    readFile(filePath, "utf8")
      .then((html) => {
        const injected = html.replaceAll("__CONTACT_EMAIL__", config.contactEmail);
        res.status(200).type("html").send(injected);
      })
      .catch(() => {
        if (!res.headersSent) {
          jsonError(res, 500, "landing_missing", "Landing page not found. Did you package public/?");
        }
      });
  };
  app.get("/", sendLanding);
  app.get("/zh", sendLanding);

  app.use(express.static(publicDir, { index: false, fallthrough: true }));

  // MCP transports (own payment loop) — mount before HTTP x402 gate / upstream proxy.
  let mcpPayment: McpPaymentLayer | undefined;
  if (!options.disableMcp) {
    mcpPayment = await mountMcpTransports(app, config, options.mcpPaymentLayer);
  }

  // HTTP Payment gate — free paths pass through; gated paths require x402 payment.
  app.use(payment.middleware);

  // In-process paid demo (same gate as /v1/quote) — before upstream proxy.
  app.get("/v1/fetch-md", options.fetchMdHandler ?? createFetchMdHandler());

  // After payment (or free path), forward to upstream / mock.
  app.use(upstream);

  app.use((req: Request, res: Response) => {
    if (isGatedPath(req.path, config.gatedPrefix) || !res.headersSent) {
      jsonError(res, 404, "not_found", `No route for ${req.method} ${req.path}`);
      return;
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : "Internal error";
    if (!res.headersSent) {
      jsonError(res, 500, "internal_error", message);
    }
  });

  return { app, config, payment, mcpPayment, publicDir };
}
