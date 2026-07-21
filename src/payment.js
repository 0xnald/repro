import {
  paymentMiddleware,
  x402ResourceServer
} from "@okxweb3/x402-express";
import { OKXFacilitatorClient } from "@okxweb3/x402-core/facilitator";
import { ExactEvmScheme } from "@okxweb3/x402-evm";

const paymentRoute = "POST /v1/reproduce";

export function createPaymentMiddleware() {
  const mode = paymentMode();
  if (mode === "free") return null;
  if (mode !== "x402") {
    throw new Error("PAYMENT_MODE must be either free or x402");
  }

  const env = requiredPaymentEnv();
  const facilitator = new OKXFacilitatorClient({
    apiKey: env.OKX_API_KEY,
    secretKey: env.OKX_SECRET_KEY,
    passphrase: env.OKX_PASSPHRASE,
    baseUrl: process.env.OKX_FACILITATOR_URL || undefined,
    syncSettle: process.env.OKX_SYNC_SETTLE === "true"
  });

  const server = new x402ResourceServer(facilitator)
    .register(env.X402_NETWORK, new ExactEvmScheme());

  const routes = {
    [paymentRoute]: {
      accepts: [{
        scheme: "exact",
        network: env.X402_NETWORK,
        payTo: env.PAY_TO_ADDRESS,
        price: env.REPRO_PRICE,
        maxTimeoutSeconds: Number(process.env.X402_MAX_TIMEOUT_SECONDS || 300)
      }],
      description: env.X402_RESOURCE_DESCRIPTION,
      mimeType: "application/json",
      resource: env.X402_RESOURCE_URL
    }
  };

  return paymentMiddleware(routes, server);
}

export function paymentStatus() {
  const mode = paymentMode();
  return {
    mode,
    route: paymentRoute,
    price: process.env.REPRO_PRICE || null,
    network: process.env.X402_NETWORK || null,
    payToConfigured: Boolean(process.env.PAY_TO_ADDRESS),
    facilitatorConfigured: Boolean(process.env.OKX_API_KEY && process.env.OKX_SECRET_KEY && process.env.OKX_PASSPHRASE)
  };
}

function paymentMode() {
  return (process.env.PAYMENT_MODE || "free").toLowerCase();
}

function requiredPaymentEnv() {
  const keys = [
    "OKX_API_KEY",
    "OKX_SECRET_KEY",
    "OKX_PASSPHRASE",
    "PAY_TO_ADDRESS",
    "REPRO_PRICE",
    "X402_NETWORK",
    "X402_RESOURCE_URL",
    "X402_RESOURCE_DESCRIPTION"
  ];

  const values = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const missing = keys.filter((key) => !values[key]);
  if (missing.length > 0) {
    throw new Error(`PAYMENT_MODE=x402 requires real environment values: ${missing.join(", ")}`);
  }

  return values;
}
