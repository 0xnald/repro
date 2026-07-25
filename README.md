# Repro

**Repro** is an autonomous Software Services ASP that reproduces real software bugs, captures verified evidence, and generates developer-ready regression tests.

This repository implements a real A2MCP-friendly HTTP service for OKX.AI. It does not use mock scan data: every report is generated from a live browser session against the submitted URL.

## What v1 Does

- Opens a real website/app URL in Chromium via Playwright.
- Captures page screenshots, console errors, failed network requests, redirects, metadata, and browser context.
- Uses OpenRouter as the required reasoning engine for planning, evidence judgment, report writing, screenshot reasoning, and regression test generation.
- Runs reproduction requests as Redis-backed jobs and stores report history in Postgres.
- Publishes screenshots/video artifacts to S3-compatible storage when configured.
- Produces a structured Verified Reproduction Package.
- Generates a developer-ready Playwright regression test from the actual browser steps performed.
- Protects `GET /v1/reproduce` and `POST /v1/reproduce` with the official OKX x402 seller middleware when `PAYMENT_MODE=x402`.
- Returns a fast structured `202` job acknowledgment for paid x402 calls, so OKX.AI replay clients do not time out while the real browser reproduction continues in the background.

## Run Locally

```powershell
npm run check
npm start
```

For local unpaid development only, override `PAYMENT_MODE=free`, then call:

```powershell
Invoke-RestMethod -Method Post http://localhost:8787/v1/reproduce -ContentType 'application/json' -Body '{
  "url": "https://example.com",
  "bugReport": "The page should load without console errors.",
  "viewport": "desktop"
}'
```

If your local `.env` points at production Postgres or Redis, keep `REPRO_START_WORKER=false` unless you intentionally want this machine to process jobs. For isolated local dashboard testing, use a separate development `REPRO_QUEUE_KEY` and set `REPRO_START_WORKER=true`.

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

For paid x402 calls, long browser work is asynchronous. A valid paid replay returns:

```json
{
  "jobId": "uuid",
  "status": "queued",
  "statusUrl": "https://repro-asp.up.railway.app/v1/jobs/uuid",
  "reportUrl": "https://repro-asp.up.railway.app/v1/reports/uuid",
  "message": "Repro accepted the paid request and started a real browser reproduction job. Poll statusUrl until status is completed, then fetch reportUrl."
}
```

When `statusUrl` returns `completed`, `reportUrl` returns the full Verified Reproduction Package. If a job fails, `statusUrl` returns a structured `error` object instead of dropping the connection.

## Production Configuration

The OKX A2MCP guide says free endpoints should return `HTTP 200` directly, while paid x402 endpoints should return `HTTP 402` with a payment challenge until paid. Repro uses the official OKX x402 seller SDK for paid mode and fails closed if required values are missing.

Required production environment:

```bash
PAYMENT_MODE=x402
REPRO_START_WORKER=false
REPRO_SYNC_CACHE_TTL_SECONDS=86400
OKX_API_KEY=<from OKX Developer Portal>
OKX_SECRET_KEY=<from OKX Developer Portal>
OKX_PASSPHRASE=<from OKX Developer Portal>
PAY_TO_ADDRESS=0xb6fE13c656087406a78Fb62D6d2948A5724Ac2A6
REPRO_PRICE=$0.001
X402_NETWORK=eip155:196
X402_RESOURCE_URL=https://repro-asp.up.railway.app/v1/reproduce
X402_RESOURCE_DESCRIPTION=Repro verified bug reproduction package
X402_MAX_TIMEOUT_SECONDS=300
OKX_SYNC_SETTLE=false
X402_SYNC_ON_START=true

REPRO_REASONING_REQUIRED=true
REPRO_ALLOW_STATIC_FALLBACK=false
OPENROUTER_API_KEY=<from OpenRouter>
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_SITE_URL=https://repro-asp.up.railway.app
OPENROUTER_APP_NAME=Repro
REPRO_PLANNER_MODEL=anthropic/claude-sonnet-4
REPRO_REPORT_MODEL=anthropic/claude-sonnet-4
REPRO_TEST_MODEL=openai/gpt-4.1-mini
REPRO_VISION_MODEL=google/gemini-2.5-flash
REPRO_VISION_ENABLED=true
REPRO_REASONING_TIMEOUT_MS=45000

DATABASE_URL=<postgres connection string>
REDIS_URL=<redis connection string>
S3_ENDPOINT=<s3-compatible endpoint>
S3_BUCKET=<bucket name>
S3_ACCESS_KEY_ID=<access key>
S3_SECRET_ACCESS_KEY=<secret key>
S3_PUBLIC_BASE_URL=<public artifact base url>

REPRO_MAX_ACTIONS=12
MAX_SCAN_SECONDS=120
ARTIFACT_RETENTION_DAYS=14
REPRO_ALLOW_FORM_SUBMIT=false
REPRO_ALLOW_EXTERNAL_NAVIGATION=false
REPRO_ALLOW_DOWNLOADS=false
REPRO_ALLOW_DESTRUCTIVE_ACTIONS=false
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
HTTP/2 202
PAYMENT-RESPONSE: <settlement receipt>
```

The response includes `jobId`, `statusUrl`, and `reportUrl`. The dashboard polls the job until the Verified Reproduction Package is ready.

## Deployment Recommendation

Use Railway with the included `Dockerfile`. Repro needs Playwright browser automation, which is a better fit for a container runtime than Vercel serverless.

## Keep OKX.AI Presence Online

The Repro API service and the OKX.AI presence worker should run as two separate Railway services from this same repository.

Keep the existing API service start command as:

```bash
pnpm start
```

Create a second Railway service for presence, using the same repo and Dockerfile, then set its start command to:

```bash
pnpm start:presence
```

Use `/health` as the Railway healthcheck path. The presence worker runs:

```bash
onchainos agent heartbeat --chain-index 196
```

every `OKX_PRESENCE_INTERVAL_MS` milliseconds, so #8594 can stay online even when your local PC is off. Configure the same OKX credential variables used by the API service, plus:

```bash
OKX_PRESENCE_CHAIN_INDEX=196
OKX_PRESENCE_INTERVAL_MS=120000
ONCHAINOS_BIN=onchainos
```

Do not change the API service to `pnpm start:presence`; the worker is only for OKX.AI presence. If the presence service healthcheck returns `503`, check Railway logs for the exact `onchainos` auth or heartbeat error and add the missing real OKX runtime value.

## Required Real Inputs Before Launch

- Public HTTPS deployment URL
- A real user-provided app/website URL for each reproduction run
- Optional test credentials for authenticated flows
- OKX Developer Portal credentials for x402 settlement
