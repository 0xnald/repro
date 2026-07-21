import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { assertPublicHttpUrl } from "./urlSafety.js";
import { buildReport } from "./report.js";

const desktop = { width: 1440, height: 1000 };
const mobile = { width: 390, height: 844, isMobile: true };

export async function reproduceBug(request) {
  const safeUrl = await assertPublicHttpUrl(request.url);
  const jobId = crypto.randomUUID();
  const artifactRoot = path.resolve(process.env.ARTIFACT_DIR || "./artifacts", jobId);
  await fs.mkdir(artifactRoot, { recursive: true });

  const viewports = request.viewport === "both"
    ? [{ name: "desktop", options: desktop }, { name: "mobile", options: mobile }]
    : [{ name: request.viewport === "mobile" ? "mobile" : "desktop", options: request.viewport === "mobile" ? mobile : desktop }];

  const allReports = [];
  for (const viewport of viewports) {
    allReports.push(await runViewport({ request: { ...request, url: safeUrl }, viewport, artifactRoot }));
  }

  if (allReports.length === 1) return allReports[0];

  return {
    product: "Repro",
    service: "Verified Bug Reproduction",
    generatedAt: new Date().toISOString(),
    input: {
      url: safeUrl,
      bugReport: request.bugReport,
      expectedBehavior: request.expectedBehavior || null,
      viewport: "both"
    },
    reproduced: allReports.some((report) => report.reproduced),
    confidence: Math.max(...allReports.map((report) => report.confidence)),
    severity: mergeSeverity(allReports.map((report) => report.severity)),
    reports: allReports
  };
}

async function runViewport({ request, viewport, artifactRoot }) {
  const viewportDir = path.join(artifactRoot, viewport.name);
  await fs.mkdir(viewportDir, { recursive: true });

  const browser = await launchBrowser();
  const context = await newContextWithOptionalVideo(browser, viewport, viewportDir);
  const page = await context.newPage();

  const observations = {
    steps: [],
    console: [],
    network: [],
    redirects: [],
    finalUrl: null,
    title: null,
    metadata: {}
  };

  page.on("console", (message) => {
    observations.console.push({
      type: message.type(),
      text: message.text(),
      location: message.location()
    });
  });

  page.on("requestfailed", (requestInfo) => {
    observations.network.push({
      url: requestInfo.url(),
      method: requestInfo.method(),
      failed: true,
      errorText: requestInfo.failure()?.errorText || "request failed"
    });
  });

  page.on("response", (response) => {
    const status = response.status();
    if (status >= 400) {
      observations.network.push({
        url: response.url(),
        method: response.request().method(),
        status,
        failed: false
      });
    }
  });

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) observations.redirects.push(frame.url());
  });

  try {
    observations.steps.push(`Open ${request.url} in ${viewport.name} Chromium`);
    await page.goto(request.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

    observations.title = await page.title();
    observations.finalUrl = page.url();
    observations.metadata = await collectMetadata(page);

    const beforePath = path.join(viewportDir, "before.png");
    await page.screenshot({ path: beforePath, fullPage: true });

    await performTargetedInteractions({ page, request, observations });

    const afterPath = path.join(viewportDir, "after.png");
    await page.screenshot({ path: afterPath, fullPage: true });

    const video = page.video();
    await context.close();
    await browser.close();

    const videoPath = video ? await video.path().catch(() => null) : null;
    const artifacts = {
      jobId: path.basename(artifactRoot),
      artifactRoot,
      screenshots: [beforePath, afterPath],
      video: videoPath
    };
    const regressionTest = generateRegressionTest({ request, observations });
    return buildReport({ request, observations, artifacts, regressionTest });
  } catch (error) {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

async function collectMetadata(page) {
  return page.evaluate(() => ({
    title: document.title,
    description: document.querySelector("meta[name='description']")?.getAttribute("content") || null,
    h1: [...document.querySelectorAll("h1")].map((node) => node.textContent?.trim()).filter(Boolean),
    forms: document.forms.length,
    buttons: document.querySelectorAll("button, input[type='button'], input[type='submit']").length,
    links: document.links.length
  }));
}

async function performTargetedInteractions({ page, request, observations }) {
  const keywords = extractKeywords(request.bugReport);
  await fillVisibleInputs({ page, request, observations });

  const candidates = page.locator("button, a, input[type='button'], input[type='submit'], [role='button']");
  const count = Math.min(await candidates.count(), 30);

  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;

    const label = await candidate.innerText().catch(async () => candidate.getAttribute("value"));
    const normalized = (label || "").toLowerCase();
    if (keywords.length > 0 && !keywords.some((keyword) => normalized.includes(keyword))) continue;

    observations.steps.push(`Click ${label || `interactive element ${index + 1}`}`);
    await candidate.click({ timeout: 5000 }).catch((error) => {
      observations.console.push({
        type: "error",
        text: `Interaction failed: ${error.message}`,
        location: {}
      });
    });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    return;
  }

  observations.steps.push("No bug-report-matching interactive element was found for a targeted click");
}

async function fillVisibleInputs({ page, request, observations }) {
  const values = request.testData || {};
  const inputs = page.locator("input:not([type='hidden']), textarea");
  const count = Math.min(await inputs.count(), 20);

  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    if (!(await input.isVisible().catch(() => false))) continue;

    const type = (await input.getAttribute("type").catch(() => "text")) || "text";
    const name = (await input.getAttribute("name").catch(() => "")) || "";
    const placeholder = (await input.getAttribute("placeholder").catch(() => "")) || "";
    const key = Object.keys(values).find((item) => `${name} ${placeholder}`.toLowerCase().includes(item.toLowerCase()));
    const value = key ? values[key] : defaultValue(type, name, placeholder, request.credentials);
    if (!value) continue;

    await input.fill(String(value), { timeout: 3000 }).catch(() => {});
    observations.steps.push(`Fill ${name || placeholder || type} field`);
  }
}

function defaultValue(type, name, placeholder, credentials) {
  const label = `${name} ${placeholder}`.toLowerCase();
  if (label.includes("user") || label.includes("email")) return credentials?.username || "qa@example.com";
  if (label.includes("pass")) return credentials?.password || null;
  if (type === "email") return "qa@example.com";
  if (type === "search") return "test";
  if (type === "text") return "QA Test";
  return null;
}

function extractKeywords(text = "") {
  const stop = new Set(["when", "after", "before", "click", "the", "and", "then", "page", "does", "not", "work"]);
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3 && !stop.has(word))
    .slice(0, 8);
}

function generateRegressionTest({ request, observations }) {
  const escapedUrl = JSON.stringify(request.url);
  const escapedReport = JSON.stringify(request.bugReport);
  const stepComments = observations.steps.map((step) => `  // ${step.replace(/\n/g, " ")}`).join("\n");

  return `import { test, expect } from '@playwright/test';

test('reproduces reported bug: ${request.bugReport.replace(/'/g, "\\'").slice(0, 80)}', async ({ page }) => {
  test.info().annotations.push({ type: 'bug-report', description: ${escapedReport} });
${stepComments}
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto(${escapedUrl}, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  expect(consoleErrors, 'No browser console errors should occur during this flow').toEqual([]);
});
`;
}

function mergeSeverity(values) {
  const rank = ["low", "medium", "high", "critical"];
  return values.sort((a, b) => rank.indexOf(b) - rank.indexOf(a))[0] || "low";
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (!/Executable doesn't exist|browserType.launch/i.test(error.message)) throw error;
    return chromium.launch({ channel: "chrome", headless: true });
  }
}

async function newContextWithOptionalVideo(browser, viewport, viewportDir) {
  const contextOptions = {
    viewport: viewport.options,
    recordVideo: { dir: viewportDir, size: { width: viewport.options.width, height: viewport.options.height } }
  };

  const context = await browser.newContext(contextOptions);
  try {
    const probe = await context.newPage();
    await probe.close();
    return context;
  } catch (error) {
    await context.close().catch(() => {});
    if (!/ffmpeg/i.test(error.message)) throw error;
    return browser.newContext({ viewport: viewport.options });
  }
}
