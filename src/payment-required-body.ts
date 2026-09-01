import type { TollgateConfig } from "./config.js";

export const PAYMENT_REQUIRED_DOC =
  "https://github.com/kevin2003050666-coder/x402-micro-tollgate";

/** Human-readable JSON for unpaid gated HTTP 402 responses (headers stay protocol). */
export function paymentRequiredJsonBody(config: TollgateConfig): {
  error: string;
  price: string;
  doc: string;
  message: string;
} {
  const price = config.price.trim();
  const priceLabel = /usdc/i.test(price) ? price : `${price} USDC`;
  return {
    error: "Payment Required",
    price: priceLabel,
    doc: PAYMENT_REQUIRED_DOC,
    message:
      "To bypass this paywall or host your own tollgate, see docs.",
  };
}
