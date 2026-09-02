import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadKeeperConfig, startFeeSplitterKeeper } from "./keeper.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, payment, mcpPayment } = await createApp({ config });

  // Optional FeeSplitter release keeper — OFF unless KEEPER_ENABLED=true.
  // Never enabled by default on Render; gas can dwarf 0.1% fees on sub-cent payments.
  const keeperConfig = loadKeeperConfig(process.env, config);
  const keeper = startFeeSplitterKeeper(keeperConfig);

  app.listen(config.port, () => {
    console.log(
      JSON.stringify({
        msg: "x402-micro-tollgate listening",
        port: config.port,
        mode: payment.mode,
        mcpMode: mcpPayment?.mode ?? null,
        environment: config.environment,
        network: config.network,
        price: config.price,
        gatedPrefix: config.gatedPrefix || "*",
        upstream: config.upstreamUrl ?? "mock",
        payTo: payment.payToEvmAddress ?? mcpPayment?.payTo ?? null,
        keeper: keeper
          ? { enabled: true, dryRun: keeperConfig.dryRun, intervalMs: keeperConfig.intervalMs }
          : { enabled: false },
        health: `http://127.0.0.1:${config.port}/health`,
        mcp: `http://127.0.0.1:${config.port}/mcp`,
        sse: `http://127.0.0.1:${config.port}/sse`,
      }),
    );

    if (payment.mode === "demo" || mcpPayment?.mode === "demo") {
      console.log(
        JSON.stringify({
          msg: "Running in demo mode (no CDP facilitator). HTTP gated routes and MCP paid tools still return PaymentRequired. Set CDP_API_KEY_ID, CDP_API_KEY_SECRET, and X402_PAY_TO for live settlement.",
        }),
      );
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
