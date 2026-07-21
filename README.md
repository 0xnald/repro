# Repro

**Repro** is an autonomous Software Services ASP that reproduces real software bugs, captures verified evidence, and generates developer-ready regression tests.

This repository implements a real A2MCP-friendly HTTP service for OKX.AI. It does not use mock scan data: every report is generated from a live browser session against the submitted URL.

## What v1 Does

- Opens a real website/app URL in Chromium via Playwright.
- Captures page screenshots, console errors, failed network requests, redirects, metadata, and browser context.
- Attempts to reproduce the submitted bug report by interacting with matching links, buttons, inputs, and forms.
- Produces a structured Verified Reproduction Package.
- Generates a developer-ready Playwright regression test from the actual browser steps performed.
- Protects `POST /v1/reproduce` with the official OKX x402 seller middleware when `PAYMENT_MODE=x402`.

## Run Locally

```powershell
npm run check
npm start
```

For local unpaid development only, set `PAYMENT_MODE=free`, then call:

```powershell
Invoke-RestMethod -Method Post http://localhost:8787/v1/reproduce -ContentType 'application/json' -Body '{
  "url": "https://example.com",
  "bugReport": "The page should load without console errors.",
  "viewport": "desktop"
}'
```

## Request Shape

```json
{
  "url": "https://your-real-app.example",
  "bugReport": "When I click Checkout after changing quantity, the page freezes.",
  "expectedBehavior": "Checkout should open.",
  "credentials": {
    "username": "optional-test-user",
    "password": "optional-test-password"
  },
  "testData": {
    "email": "qa@example.com",
    "name": "QA Test"
  },
  "viewport": "both"
}
```

## Response Shape

The service returns a Verified Reproduction Package:

- `reproduced`: whether hard evidence of failure was observed
- `confidence`: evidence-weighted confidence score
- `severity`: `low`, `medium`, `high`, or `critical`
- `summary`: concise finding
- `steps`: actual steps performed by the browser
- `evidence`: screenshots, console errors, network failures, redirects, and metadata
- `likelyCause`: deterministic hypothesis based only on collected evidence
- `regressionTest`: generated Playwright test
- `artifacts`: local artifact paths

## Paid OKX.AI Configuration

The OKX A2MCP guide says free endpoints should return `HTTP 200` directly, while paid x402 endpoints should return `HTTP 402` with a payment challenge until paid. Repro uses the official OKX x402 seller SDK for paid mode and fails closed if required values are missing.

Required production environment:

```bash
PAYMENT_MODE=x402
OKX_API_KEY=<from OKX Developer Portal>
OKX_SECRET_KEY=<from OKX Developer Portal>
OKX_PASSPHRASE=<from OKX Developer Portal>
PAY_TO_ADDRESS=0xb6fE13c656087406a78Fb62D6d2948A5724Ac2A6
REPRO_PRICE=$0.001
X402_NETWORK=eip155:196
X402_RESOURCE_URL=https://your-production-domain/v1/reproduce
X402_RESOURCE_DESCRIPTION=Repro verified bug reproduction package
X402_MAX_TIMEOUT_SECONDS=300
OKX_SYNC_SETTLE=false
```

Before listing on OKX.AI, deploy this service to a public HTTPS domain and self-check:

```bash
curl -i -X POST https://your-domain/v1/reproduce \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","bugReport":"Page should load cleanly."}'
```

Expected paid response before payment:

```text
HTTP/2 402
PAYMENT-REQUIRED: <base64 challenge>
```

Expected response after a valid OKX payment replay:

```text
HTTP/2 200
PAYMENT-RESPONSE: <settlement receipt>
```

## Deployment Recommendation

Use Railway with the included `Dockerfile`. Repro needs Playwright browser automation, which is a better fit for a container runtime than Vercel serverless.

## Required Real Inputs Before Launch

- Public HTTPS deployment URL
- A real app/website for the 90-second demo: `https://proovra.xyz`
- Optional test credentials for authenticated flows
- OKX Developer Portal credentials for x402 settlement
