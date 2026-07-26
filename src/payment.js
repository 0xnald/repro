import {
  paymentMiddleware,
  x402ResourceServer
} from "@okxweb3/x402-express";
import { OKXFacilitatorClient } from "@okxweb3/x402-core/facilitator";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";

const paymentRoutes = ["GET /v1/reproduce", "HEAD /v1/reproduce", "POST /v1/reproduce"];

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

  const resourceUrl = canonicalHttpUrl(env.X402_RESOURCE_URL);
  const routes = Object.fromEntries(paymentRoutes.map((route) => [
    route,
    {
      accepts: [{
        scheme: "exact",
        network: env.X402_NETWORK,
        payTo: env.PAY_TO_ADDRESS,
        price: env.REPRO_PRICE,
        maxTimeoutSeconds: Number(process.env.X402_MAX_TIMEOUT_SECONDS || 300)
      }],
      description: `${env.X402_RESOURCE_DESCRIPTION}. Required JSON fields: url, bugReport.`,
      mimeType: "application/json",
      resource: resourceUrl,
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: {
          product: "Repro",
          service: "Verified Bug Reproduction",
          inputRequired: true,
          fields: reproInputFields(),
          inputSchema: reproInputSchema(),
          example: {
            url: "https://example.com",
            bugReport: "Describe the bug or workflow to verify.",
            expectedBehavior: "Describe the expected behavior.",
            viewport: "desktop",
            credentials: {
              username: "optional",
              password: "optional"
            }
          }
        }
      }),
      extensions: {
        outputSchema: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "json",
            body: reproInputSchema()
          }
        }
      }
    }
  ]));

  const syncFacilitatorOnStart = process.env.X402_SYNC_ON_START !== "false";
  return paymentMiddleware(routes, server, undefined, undefined, syncFacilitatorOnStart);
}

export function paymentStatus() {
  const mode = paymentMode();
  return {
    mode,
    route: paymentRoutes.join(", "),
    price: process.env.REPRO_PRICE || null,
    network: process.env.X402_NETWORK || null,
    resourceUrl: canonicalPaymentResourceUrl() || null,
    payToConfigured: Boolean(process.env.PAY_TO_ADDRESS),
    facilitatorConfigured: Boolean(process.env.OKX_API_KEY && process.env.OKX_SECRET_KEY && process.env.OKX_PASSPHRASE)
  };
}

export function canonicalPaymentResourceUrl() {
  return canonicalHttpUrl(process.env.X402_RESOURCE_URL || "");
}

function reproInputFields() {
  return [
    {
      name: "url",
      type: "string",
      required: true,
      description: "Public website or app URL to reproduce against."
    },
    {
      name: "bugReport",
      type: "string",
      required: true,
      description: "Bug report, workflow, or behavior Repro should verify."
    },
    {
      name: "expectedBehavior",
      type: "string",
      required: false,
      description: "Expected correct behavior."
    },
    {
      name: "viewport",
      type: "desktop | mobile | both",
      required: false,
      description: "Browser viewport. Defaults to desktop."
    },
    {
      name: "credentials.username",
      type: "string",
      required: false,
      description: "Optional login username or email for test accounts."
    },
    {
      name: "credentials.password",
      type: "string",
      required: false,
      description: "Optional login password for test accounts."
    },
    {
      name: "testData",
      type: "object",
      required: false,
      description: "Optional structured data for the test flow."
    }
  ];
}

function reproInputSchema() {
  return {
    type: "object",
    required: ["url", "bugReport"],
    properties: {
      url: {
        type: "string",
        description: "Public website or app URL to reproduce against."
      },
      bugReport: {
        type: "string",
        description: "Required bug report, workflow, or behavior Repro should verify."
      },
      expectedBehavior: {
        type: "string",
        description: "Expected correct behavior."
      },
      viewport: {
        type: "string",
        enum: ["desktop", "mobile", "both"],
        description: "Browser viewport to use."
      },
      credentials: {
        type: "object",
        description: "Optional test login credentials.",
        properties: {
          username: { type: "string" },
          password: { type: "string" }
        }
      },
      testData: {
        type: "object",
        description: "Optional structured test data."
      }
    }
  };
}

function paymentMode() {
  return (process.env.PAYMENT_MODE || "free").toLowerCase();
}

function canonicalHttpUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return trimmed;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
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
