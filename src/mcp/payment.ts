import { x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
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
import { isEip155, isSolana } from "../networks.js";

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
function createDemoFacilitator(networks: Caip2Network[]): FacilitatorClient {
  return {
    async getSupported() {
      return {
        kinds: networks.map((network) => ({
          x402Version: 2,
          scheme: "exact" as const,
          network,
        })),
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
        network: networks[0]!,
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
  const networks = [
    ...new Set(
      (config.accepts.length > 0
        ? config.accepts.map((a) => a.network)
        : config.networks
      ).filter((n) => isEip155(n) || isSolana(n)),
    ),
  ] as Caip2Network[];
  if (networks.length === 0) {
    networks.push(config.network as Caip2Network);
  }

  const facilitator = config.useLiveFacilitator
    ? createCdpFacilitatorClient({
        apiKeyId: config.cdpApiKeyId,
        apiKeySecret: config.cdpApiKeySecret,
        ...(config.facilitatorUrl ? { baseUrl: config.facilitatorUrl } : {}),
      })
    : createDemoFacilitator(networks);

  const resourceServer = new x402ResourceServer(facilitator);
  for (const network of networks) {
    if (isEip155(network)) {
      resourceServer.register(network, new ExactEvmScheme());
    } else if (isSolana(network)) {
      // Experimental — scheme registers; live settle still facilitator-dependent.
      resourceServer.register(network, new ExactSvmScheme());
    }
  }
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
 * Builds one accept per config.accepts entry (multi-network / multi-asset).
 */
export async function createMcpPaymentLayer(config: TollgateConfig): Promise<McpPaymentLayer> {
  const { mode, resourceServer, payTo } = await buildResourceServer(config);
  const publicMcpUrl = `${config.publicBaseUrl}/mcp`;

  const accepts: PaymentRequirements[] = [];
  const specs =
    config.accepts.length > 0
      ? config.accepts
      : [
          {
            network: config.network,
            symbol: "USDC" as const,
            asset: payTo,
            decimals: 6,
            name: "USDC",
            version: "2",
            transferMethod: "eip3009" as const,
            status: "live" as const,
          },
        ];

  for (const spec of specs) {
    // buildPaymentRequirements expects EVM payTo for eip155; Solana uses SOLANA_PAY_TO.
    const entryPayTo =
      spec.payTo ??
      (isSolana(spec.network) ? config.solanaPayTo : undefined) ??
      payTo;
    if (!entryPayTo) continue;

    const extra: Record<string, unknown> = {
      name: spec.name,
      version: spec.version ?? "2",
    };
    if (spec.transferMethod === "permit2") {
      extra.assetTransferMethod = "permit2";
    }

    const built = await resourceServer.buildPaymentRequirements({
      scheme: "exact",
      network: spec.network as `${string}:${string}`,
      payTo: entryPayTo,
      price: config.price,
      extra,
    });
    // Prefer our catalog asset address when the builder defaults to USDC.
    for (const req of built) {
      req.asset = spec.asset;
      if (req.extra && typeof req.extra === "object") {
        Object.assign(req.extra, extra);
      } else {
        req.extra = extra;
      }
      accepts.push(req);
    }
  }

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
