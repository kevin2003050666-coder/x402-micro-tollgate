import { x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import {
  createPaymentWrapper,
  MCP_PAYMENT_META_KEY,
  MCP_PAYMENT_RESPONSE_META_KEY,
  type PaymentWrappedHandler,
  type MCPToolCallback,
  type PaymentRequirements,
} from "@x402/mcp";
import type { TollgateConfig } from "../config.js";
import {
  mcpGetQuoteBazaarExtension,
  mcpProxyRequestBazaarExtension,
} from "../bazaar.js";

export interface McpPaymentLayer {
  mode: "live" | "demo";
  resourceServer: x402ResourceServer;
  accepts: PaymentRequirements[];
  payTo: string;
  publicMcpUrl: string;
  /** Wrap a tool handler with verify+settle (live) or demo payment meta. */
  wrapPaid: <TArgs extends Record<string, unknown>>(
    toolName: string,
    description: string,
    handler: PaymentWrappedHandler<TArgs>,
  ) => MCPToolCallback<TArgs>;
}

type Caip2Network = `${string}:${string}`;

/** Demo facilitator: supports kinds locally; verify/settle always succeed. */
function createDemoFacilitator(network: Caip2Network): FacilitatorClient {
  return {
    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network }],
        extensions: ["bazaar"],
        signers: {} as Record<string, string[]>,
      };
    },
    async verify() {
      return { isValid: true, payer: "0xdemo" };
    },
    async settle() {
      return {
        success: true,
        transaction: "0xdemo-settled",
        network,
        payer: "0xdemo",
      };
    },
  };
}

async function buildResourceServer(config: TollgateConfig): Promise<{
  mode: "live" | "demo";
  resourceServer: x402ResourceServer;
  payTo: string;
}> {
  const payTo =
    config.payTo ??
    ("0x0000000000000000000000000000000000000001" as `0x${string}`);
  const network = config.network as Caip2Network;

  const facilitator = config.useLiveFacilitator
    ? createCdpFacilitatorClient({
        apiKeyId: config.cdpApiKeyId,
        apiKeySecret: config.cdpApiKeySecret,
      })
    : createDemoFacilitator(network);

  const resourceServer = new x402ResourceServer(facilitator);
  resourceServer.register(network, new ExactEvmScheme());
  // MCP path does NOT auto-declare Bazaar — register the resource-server extension.
  resourceServer.registerExtension(bazaarResourceServerExtension);
  await resourceServer.initialize();

  return {
    mode: config.useLiveFacilitator ? "live" : "demo",
    resourceServer,
    payTo,
  };
}

function bazaarForTool(toolName: string): Record<string, unknown> {
  if (toolName === "get_quote") return mcpGetQuoteBazaarExtension();
  if (toolName === "proxy_request") return mcpProxyRequestBazaarExtension();
  return mcpGetQuoteBazaarExtension();
}

/**
 * Creates the MCP-side x402 payment layer.
 * Live: CDP facilitator via createCdpFacilitatorClient.
 * Demo: stub facilitator so unpaid tools still return PaymentRequired without CDP keys.
 *
 * Resource URLs use PUBLIC_BASE_URL + /mcp (real http(s) URL required for Bazaar).
 */
export async function createMcpPaymentLayer(config: TollgateConfig): Promise<McpPaymentLayer> {
  const { mode, resourceServer, payTo } = await buildResourceServer(config);
  const publicMcpUrl = `${config.publicBaseUrl}/mcp`;

  const accepts = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network: config.network as `${string}:${string}`,
    payTo,
    price: config.price,
    extra: { name: "USDC", version: "2" },
  });

  if (!accepts.length) {
    throw new Error(`Failed to build payment requirements for network ${config.network}`);
  }

  const wrapPaid = <TArgs extends Record<string, unknown>>(
    toolName: string,
    description: string,
    handler: PaymentWrappedHandler<TArgs>,
  ): MCPToolCallback<TArgs> => {
    const paid = createPaymentWrapper(resourceServer, {
      accepts,
      resource: {
        // Real URL (not mcp:// display name) — Bazaar keys on (resource, toolName).
        url: publicMcpUrl,
        description,
        mimeType: "application/json",
        serviceName: "x402-micro-tollgate",
        tags: ["x402", "gateway", "proxy", "mcp", "bazaar"],
      },
      extensions: bazaarForTool(toolName),
    });
    return paid(handler);
  };

  return {
    mode,
    resourceServer,
    accepts,
    payTo,
    publicMcpUrl,
    wrapPaid,
  };
}

export { MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY };

/** Build a demo payment payload that the demo facilitator will accept. */
export function buildDemoPaymentPayload(
  toolName: string,
  accepts: PaymentRequirements[],
  publicMcpUrl = "http://127.0.0.1:8402/mcp",
): Record<string, unknown> {
  return {
    x402Version: 2,
    resource: { url: publicMcpUrl },
    accepted: accepts[0],
    payload: { demo: true, signature: "demo-settled", tool: toolName },
  };
}
