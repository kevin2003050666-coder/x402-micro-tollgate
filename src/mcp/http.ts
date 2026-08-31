import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { TollgateConfig } from "../config.js";
import { createTollgateMcpServer } from "./server.js";
import { createMcpPaymentLayer, type McpPaymentLayer } from "./payment.js";

type AnyTransport = StreamableHTTPServerTransport | SSEServerTransport;

/**
 * Mount Streamable HTTP at /mcp and legacy SSE at /sse + /messages.
 * Shares one payment layer; creates per-session MCP servers as needed.
 */
export async function mountMcpTransports(
  app: Express,
  config: TollgateConfig,
  paymentLayer?: McpPaymentLayer,
): Promise<McpPaymentLayer> {
  const payment = paymentLayer ?? (await createMcpPaymentLayer(config));
  const transports: Record<string, AnyTransport> = {};

  // ---- Streamable HTTP (preferred) ----
  app.all("/mcp", async (req: Request, res: Response) => {
    try {
      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        const existing = transports[sessionId];
        if (!(existing instanceof StreamableHTTPServerTransport)) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: Session exists but uses a different transport protocol",
            },
            id: null,
          });
          return;
        }
        transport = existing;
      } else if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports[id] = transport;
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            delete transports[sid];
          }
        };
        const { server } = await createTollgateMcpServer(config, payment);
        await server.connect(transport);
      } else if (!sessionId && req.method === "POST") {
        // Stateless fallback: one-shot transport (no session) for simple clients/tests
        const { server } = await createTollgateMcpServer(config, payment);
        const stateless = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await server.connect(stateless);
        await stateless.handleRequest(req, res, req.body);
        res.on("close", () => {
          void stateless.close();
          void server.close();
        });
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP /mcp error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // ---- Legacy SSE (Claude Desktop / older clients) ----
  app.get("/sse", async (_req: Request, res: Response) => {
    try {
      const transport = new SSEServerTransport("/messages", res);
      transports[transport.sessionId] = transport;
      res.on("close", () => {
        delete transports[transport.sessionId];
      });
      const { server } = await createTollgateMcpServer(config, payment);
      await server.connect(transport);
    } catch (error) {
      console.error("MCP /sse error:", error);
      if (!res.headersSent) {
        res.status(500).end("SSE connection failed");
      }
    }
  });

  app.post("/messages", async (req: Request, res: Response) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    const existing = sessionId ? transports[sessionId] : undefined;
    if (!(existing instanceof SSEServerTransport)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No SSE transport for sessionId",
        },
        id: null,
      });
      return;
    }
    await existing.handlePostMessage(req, res, req.body);
  });

  return payment;
}
