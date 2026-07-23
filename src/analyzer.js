import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { getConfig } from "./config.js";
import { OpenRouterReasoner } from "./openrouter.js";
import { validateAndNormalizeRequest, isActionAllowed } from "./guardrails.js";
import { publishArtifacts } from "./storage.js";
import { SystemDownError } from "./errors.js";

const desktop = { width: 1440, height: 1000 };
const mobile = { width: 390, height: 844, isMobile: true };

export async function reproduceBug(rawRequest, { jobId = crypto.randomUUID() } = {}) {
  const config = getConfig();
  const request = await validateAndNormalizeRequest(rawRequest, config);
  const reasoner = new OpenRouterReasoner(config);
  const artifactRoot = path.resolve(config.app.artifactDir, jobId);
  await fs.mkdir(artifactRoot, { recursive: true });

  const startedAt = Date.now();
  const viewports = request.viewport === "both"
    ? [{ name: "desktop", options: desktop }, { name: "mobile", options: mobile }]
    : [{ name: request.viewport === "mobile" ? "mobile" : "desktop", options: request.viewport === "mobile" ? mobile : desktop }];

  const reports = [];
  for (const viewport of viewports) {
    reports.push(await runViewport({ request, viewport, artifactRoot, jobId, reasoner, config, startedAt }));
  }

  if (reports.length === 1) return reports[0];
  return mergeViewportReports({ request, reports });
}

async function runViewport({ request, viewport, artifactRoot, jobId, reasoner, config, startedAt }) {
  const viewportDir = path.join(artifactRoot, viewport.name);
  await fs.mkdir(viewportDir, { recursive: true });

  const browser = await launchBrowser();
  const context = await newContextWithOptionalVideo(browser, viewport, viewportDir, config);
  const page = await context.newPage();
  const state = createObservationState();

  wirePageObservers(page, state);

  try {
    state.actionTrace.push({ type: "open", url: request.url, viewport: viewport.name, reason: "Start reproduction run" });
    await page.goto(request.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await boundedWaitForNetwork(page, state, 3000);

    state.title = await page.title();
    state.finalUrl = page.url();
    state.metadata = await collectMetadata(page);
    const beforePath = path.join(viewportDir, "before.png");
    await page.screenshot({ path: beforePath, fullPage: config.scan.fullPageScreenshots });
    state.screenshotPaths.push(beforePath);

    if (isCleanLoadIntent(request)) {
      await page.waitForTimeout(2500);
      state.actionTrace.push({ type: "wait", value: "2500", status: "executed", reason: "Capture delayed console errors and failed requests" });
      await boundedWaitForNetwork(page, state, 1500);
      state.actionTrace.push({ type: "stop", reason: "Clean-load evidence collected; moving to evidence judgment" });
    } else {
      for (let turn = 0; turn < config.scan.maxActions; turn += 1) {
        enforceScanDeadline(startedAt, config);
        if (shouldStopForCleanLoad(request, state, turn)) {
          state.actionTrace.push({ type: "stop", reason: "Clean-load evidence collected; moving to evidence judgment" });
          break;
        }
        const observation = await observePage(page, state);
        const plan = await reasoner.plan({ request, observation });
        state.plans.push(plan);

        const actions = Array.isArray(plan.actions) ? plan.actions : [];
        if (actions.length === 0) {
          state.actionTrace.push({ type: "stop", reason: "Planner returned no further actions" });
          break;
        }

        let executed = false;
        for (const action of actions.slice(0, 3)) {
          if (isLowValueRepeatedWait(action, state)) {
            state.actionTrace.push({ ...action, skipped: true, reason: "Repeated wait skipped to preserve scan deadline" });
            continue;
          }
          if (!isActionAllowed(action, config)) {
            state.actionTrace.push({ ...action, skipped: true, reason: "Blocked by Repro guardrails" });
            continue;
          }
          const result = await executeAction({ page, action, request, config });
          state.actionTrace.push({ ...action, ...result });
          executed = true;
          await boundedWaitForNetwork(page, state, 1500);
          break;
        }

        if (!executed) {
          state.actionTrace.push({ type: "stop", reason: "No planner action passed guardrails" });
          break;
        }
      }
    }

    state.title = await page.title().catch(() => state.title);
    state.finalUrl = page.url();
    state.metadata = await collectMetadata(page).catch(() => state.metadata);
    const afterPath = path.join(viewportDir, "after.png");
    await page.screenshot({ path: afterPath, fullPage: config.scan.fullPageScreenshots });
    state.screenshotPaths.push(afterPath);

    const video = page.video();
    await context.close();
    await browser.close();
    const videoPath = video ? await video.path().catch(() => null) : null;
    if (videoPath) state.videoPath = videoPath;

    const published = await publishArtifacts({ jobId, files: state.screenshotPaths.concat(videoPath ? [videoPath] : []) }, config);
    const screenshotUrls = published.filter((item) => item.path.endsWith(".png")).map((item) => item.url);
    const videoUrl = published.find((item) => item.path === videoPath)?.url || null;

    const finalObservation = await summarizeStateForReasoning(state);
    enforceScanDeadline(startedAt, config);
    const judgment = await reasoner.judge({
      request,
      observations: finalObservation,
      finalObservation,
      screenshotPaths: state.screenshotPaths
    });

    const reportDraft = buildEvidencePackage({
      request,
      viewport: viewport.name,
      judgment,
      state,
      artifactRoot,
      screenshotUrls,
      videoUrl
    });
    enforceScanDeadline(startedAt, config);
    const testResult = await reasoner.generateTest({
      request,
      report: reportDraft,
      observations: finalObservation
    });

    return {
      ...reportDraft,
      regressionTest: testResult.code,
      regressionTestFile: testResult.filename || "repro.spec.ts"
    };
  } catch (error) {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

async function boundedWaitForNetwork(page, state, timeoutMs) {
  await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {
    state.actionTrace.push({ type: "wait", status: "skipped", reason: `Network remained active after ${timeoutMs}ms` });
  });
}

function createObservationState() {
  return {
    actionTrace: [],
    plans: [],
    console: [],
    network: [],
    redirects: [],
    screenshotPaths: [],
    videoPath: null,
    finalUrl: null,
    title: null,
    metadata: {}
  };
}

function wirePageObservers(page, state) {
  page.on("console", (message) => {
    state.console.push({
      type: message.type(),
      text: redact(message.text()),
      location: message.location()
    });
  });

  page.on("requestfailed", (requestInfo) => {
    state.network.push({
      url: requestInfo.url(),
      method: requestInfo.method(),
      failed: true,
      errorText: requestInfo.failure()?.errorText || "request failed"
    });
  });

  page.on("response", (response) => {
    const status = response.status();
    if (status >= 400) {
      state.network.push({
        url: response.url(),
        method: response.request().method(),
        status,
        failed: false
      });
    }
  });

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) state.redirects.push(frame.url());
  });
}

async function observePage(page, state) {
  const dom = await page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const text = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 140);
    const selectorFor = (el, index) => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const testId = el.getAttribute("data-testid") || el.getAttribute("data-test");
      if (testId) return `[data-testid="${CSS.escape(testId)}"],[data-test="${CSS.escape(testId)}"]`;
      const aria = el.getAttribute("aria-label");
      if (aria) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria)}"]`;
      el.setAttribute("data-repro-candidate", String(index));
      return `[data-repro-candidate="${index}"]`;
    };
    const nodes = [...document.querySelectorAll("button,a,input,textarea,select,[role='button']")]
      .filter(visible)
      .slice(0, 60);
    return {
      url: location.href,
      title: document.title,
      bodyText: document.body.innerText.slice(0, 3000),
      candidates: nodes.map((el, index) => ({
        selector: selectorFor(el, index),
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        text: text(el),
        href: el.href || ""
      }))
    };
  });

  return {
    ...dom,
    actionTrace: state.actionTrace.slice(-8),
    consoleErrors: meaningfulConsoleErrors(state.console).slice(-8),
    failedRequests: meaningfulNetworkFailures(state.network).slice(-8)
  };
}

async function executeAction({ page, action, request, config }) {
  try {
    if (action.type === "wait") {
      await page.waitForTimeout(Math.min(Number(action.value || 1000), 5000));
      return { status: "executed" };
    }
    if (action.type === "press") {
      await page.keyboard.press(String(action.value || "Enter"));
      return { status: "executed" };
    }
    if (action.type === "navigate") {
      const next = new URL(action.value, request.url);
      const current = new URL(request.url);
      if (!config.scan.allowExternalNavigation && next.origin !== current.origin) {
        return { status: "skipped", error: "External navigation blocked" };
      }
      await page.goto(next.toString(), { waitUntil: "domcontentloaded", timeout: 15000 });
      return { status: "executed", url: next.toString() };
    }
    if (!action.selector) return { status: "skipped", error: "Missing selector" };
    const locator = page.locator(action.selector);
    const count = await locator.count();
    if (count !== 1) return { status: "skipped", error: `Selector matched ${count} elements` };
    if (action.type === "fill") {
      await locator.fill(String(resolveFillValue(action, request)), { timeout: 5000 });
      return { status: "executed" };
    }
    if (action.type === "click") {
      await locator.click({ timeout: 5000 });
      return { status: "executed" };
    }
    return { status: "skipped", error: `Unsupported action type ${action.type}` };
  } catch (error) {
    return { status: "failed", error: redact(error.message) };
  }
}

function resolveFillValue(action, request) {
  if (action.value) return action.value;
  const selector = `${action.selector || ""} ${action.reason || ""}`.toLowerCase();
  const testDataKey = Object.keys(request.testData || {}).find((key) => selector.includes(key.toLowerCase()));
  if (testDataKey) return request.testData[testDataKey];
  if (selector.includes("email") || selector.includes("user")) return request.credentials?.username || "qa@example.com";
  if (selector.includes("pass")) return request.credentials?.password || "";
  return "QA Test";
}

async function collectMetadata(page) {
  return page.evaluate(() => ({
    title: document.title,
    description: document.querySelector("meta[name='description']")?.getAttribute("content") || null,
    h1: [...document.querySelectorAll("h1")].map((node) => node.textContent?.trim()).filter(Boolean).slice(0, 5),
    forms: document.forms.length,
    buttons: document.querySelectorAll("button, input[type='button'], input[type='submit']").length,
    links: document.links.length
  }));
}

async function summarizeStateForReasoning(state) {
  return {
    finalUrl: state.finalUrl,
    title: state.title,
    redirects: state.redirects,
    metadata: state.metadata,
    actionTrace: state.actionTrace,
    plannerDecisions: state.plans,
    consoleErrors: compactEvidenceEntries(meaningfulConsoleErrors(state.console)),
    failedRequests: compactEvidenceEntries(meaningfulNetworkFailures(state.network))
  };
}

function buildEvidencePackage({ request, viewport, judgment, state, artifactRoot, screenshotUrls, videoUrl }) {
  return {
    product: "Repro",
    service: "Verified Bug Reproduction",
    generatedAt: new Date().toISOString(),
    input: {
      url: request.url,
      bugReport: request.bugReport,
      expectedBehavior: request.expectedBehavior || null,
      viewport
    },
    reproduced: Boolean(judgment.reproduced),
    confidence: Number(judgment.confidence || 0),
    severity: judgment.severity || "low",
    summary: judgment.summary || "",
    actualBehavior: judgment.actualBehavior || "",
    expectedBehavior: judgment.expectedBehavior || request.expectedBehavior || null,
    steps: state.actionTrace.map((item) => item.reason || `${item.type} ${item.selector || item.url || ""}`.trim()),
    actionTrace: state.actionTrace,
    evidenceTimeline: judgment.evidenceTimeline || [],
    relatedBugIdeas: judgment.relatedBugIdeas || [],
    githubIssue: judgment.githubIssue || null,
    evidence: {
      finalUrl: state.finalUrl,
      title: state.title,
      redirects: state.redirects,
      consoleErrors: compactEvidenceEntries(meaningfulConsoleErrors(state.console), 40),
      failedRequests: compactEvidenceEntries(meaningfulNetworkFailures(state.network), 40),
      metadata: state.metadata,
      screenshots: state.screenshotPaths,
      screenshotUrls,
      video: videoUrl
    },
    likelyCause: judgment.likelyCause || "Not enough evidence",
    artifacts: {
      artifactRoot,
      screenshots: state.screenshotPaths,
      screenshotUrls,
      video: videoUrl
    },
    disclaimer: "This report is based only on collected browser evidence and OpenRouter reasoning. Repro does not invent unsupported findings."
  };
}

function meaningfulConsoleErrors(entries) {
  return entries.filter((entry) => ["error", "assert"].includes(entry.type));
}

function meaningfulNetworkFailures(entries) {
  return entries.filter((entry) => {
    if (entry.status >= 400) return true;
    if (!entry.failed) return false;
    if (entry.method === "HEAD" && /ERR_ABORTED/i.test(entry.errorText || "")) return false;
    return !/ERR_ABORTED|NS_BINDING_ABORTED/i.test(entry.errorText || "");
  });
}

function shouldStopForCleanLoad(request, state, turn) {
  if (!isCleanLoadIntent(request)) return false;
  const waited = state.actionTrace.filter((item) => item.type === "wait" && item.status === "executed").length;
  return turn >= 2 && waited >= 1 && meaningfulConsoleErrors(state.console).length === 0 && meaningfulNetworkFailures(state.network).length === 0;
}

function isCleanLoadIntent(request) {
  const report = `${request.bugReport} ${request.expectedBehavior || ""}`.toLowerCase();
  return /load cleanly|console errors|failed requests|runtime errors|page loads/.test(report);
}

function compactEvidenceEntries(entries, limit = 20) {
  return entries.slice(0, limit).map((entry) => ({
    ...entry,
    url: entry.url ? redact(entry.url) : entry.url,
    text: entry.text ? redact(entry.text) : entry.text,
    location: entry.location ? { ...entry.location, url: redact(entry.location.url || "") } : entry.location
  }));
}

function isLowValueRepeatedWait(action, state) {
  if (action.type !== "wait") return false;
  const waits = state.actionTrace.filter((item) => item.type === "wait" && item.status === "executed").length;
  return waits >= 2;
}

function mergeViewportReports({ request, reports }) {
  const rank = ["low", "medium", "high", "critical"];
  return {
    product: "Repro",
    service: "Verified Bug Reproduction",
    generatedAt: new Date().toISOString(),
    input: {
      url: request.url,
      bugReport: request.bugReport,
      expectedBehavior: request.expectedBehavior || null,
      viewport: "both"
    },
    reproduced: reports.some((report) => report.reproduced),
    confidence: Math.max(...reports.map((report) => Number(report.confidence || 0))),
    severity: reports.map((report) => report.severity).sort((a, b) => rank.indexOf(b) - rank.indexOf(a))[0] || "low",
    reports
  };
}

function enforceScanDeadline(startedAt, config) {
  if (Date.now() - startedAt > config.scan.maxScanSeconds * 1000) {
    throw new SystemDownError("Scan exceeded the configured execution deadline.", { maxScanSeconds: config.scan.maxScanSeconds });
  }
}

function redact(value = "") {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9._-]+/g, "sk-[redacted]")
    .replace(/password=([^&\s]+)/gi, "password=[redacted]")
    .slice(0, 2000);
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (!/Executable doesn't exist|browserType.launch/i.test(error.message)) throw error;
    return chromium.launch({ channel: "chrome", headless: true });
  }
}

async function newContextWithOptionalVideo(browser, viewport, viewportDir, config) {
  const contextOptions = {
    viewport: viewport.options
  };
  if (config.scan.recordVideo) {
    contextOptions.recordVideo = { dir: viewportDir, size: { width: viewport.options.width, height: viewport.options.height } };
  }

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
