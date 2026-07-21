# OKX.AI Listing Draft

## ASP Name

Repro

## Category

Software Services

## Service Name

Verified Bug Reproduction

## Short Description

Repro is an autonomous Software Services ASP that reproduces real software bugs, captures verified evidence, and generates developer-ready regression tests.

## Long Description

Repro turns a real bug report into a Verified Reproduction Package. Submit a website or app URL plus the issue description. Repro opens the app in a real browser, attempts the reported workflow, captures screenshots, console logs, network failures, redirects, and browser context, then returns exact reproduction steps and a Playwright regression test developers can use immediately.

## Inputs

- `url`: public website or web app URL
- `bugReport`: issue description, support ticket, or QA report
- `expectedBehavior`: optional expected result
- `credentials`: optional test login credentials
- `testData`: optional safe test values for forms
- `viewport`: `desktop`, `mobile`, or `both`

## Outputs

- reproduced status and confidence
- severity
- browser-tested reproduction steps
- screenshot evidence
- console error evidence
- failed network request evidence
- likely cause based on observed evidence
- developer-ready Playwright regression test

## Pricing

0.001 USDT-equivalent per reproduction call through OKX x402 on X Layer.

## Endpoint

`POST https://<production-domain>/v1/reproduce`

The final production domain must be updated after Railway deployment.

## Limitations

Repro only tests URLs the requester is authorized to test. It does not bypass authentication, CAPTCHAs, paywalls, or anti-bot controls. Reports are evidence-based and may require developer review for final root-cause confirmation.

## Demo Tagline

From bug report to verified repro in minutes.
