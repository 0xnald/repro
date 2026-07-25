import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, serviceReadiness } from "./config.js";
import { validateAndNormalizeRequest, sanitizeForStorage } from "./guardrails.js";
import { createPaymentMiddleware, paymentStatus } from "./payment.js";
import { initDb, createJob, getJob, listJobs, updateJob } from "./db.js";
import { enqueueJob, queueStatus } from "./queue.js";
import { storageStatus } from "./storage.js";
import { processJob, startWorker } from "./worker.js";
import { reproduceBug, reproduceBugFast } from "./analyzer.js";
import { ReproError } from "./errors.js";

const config = getConfig();
const port = config.app.port;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");
const artifactDir = path.resolve(config.app.artifactDir);
const app = express();

await initDb(config);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir));
app.use("/artifacts", express.static(artifactDir));
app.use((_, res, next) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, payment, payment-signature, x-payment");
  next();
});

app.get("/health", async (_, res) => {
  res.json({
    status: "ok",
    product: "Repro",
    service: "Verified Bug Reproduction",
    payment: paymentStatus(),
    worker: { enabled: config.app.startWorker },
    readiness: serviceReadiness(config),
    queue: await queueStatus(config),
    storage: storageStatus(config)
  });
});

app.get("/v1/jobs", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const jobs = await listJobs(limit);
    res.json({ jobs: jobs.map(publicJob) });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/jobs/:id", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "job not found" });
    res.json(publicJob(job));
  } catch (error) {
    next(error);
  }
});

app.get("/v1/reports/:id", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "report not found" });
    if (job.status !== "completed") return res.status(409).json({ error: "report is not ready", status: job.status });
    res.json(job.report);
  } catch (error) {
    next(error);
  }
});

const paymentMiddleware = createPaymentMiddleware();
if (paymentMiddleware) {
  app.use(paymentMiddleware);
}

app.post("/v1/reproduce", async (req, res, next) => {
  try {
    const body = decodeTaskPayload(req.body);
    const job = await createReproJob(body, { waitForReport: shouldWaitForReport(req) });
    res.status(job.status === "completed" ? 200 : 202).json(job);
  } catch (error) {
    next(error);
  }
});

app.get("/v1/reproduce", async (req, res, next) => {
  try {
    const body = decodeTaskPayload(req.query);
    const job = await createReproJob(body, { waitForReport: shouldWaitForReport(req) });
    res.status(job.status === "completed" ? 200 : 202).json(job);
  } catch (error) {
    next(error);
  }
});

app.use((_, res) => {
  res.status(404).json({ error: "not found" });
});

app.use((error, _, res, __) => {
  if (error instanceof ReproError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      details: error.details
    });
  }
  res.status(500).json({
    error: error.message || "internal server error",
    code: "internal_error"
  });
});

if (config.app.startWorker) {
  startWorker();
}

app.listen(port, () => {
  console.log(`Repro ASP listening on http://localhost:${port}`);
});

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    request: job.request,
    report: job.report,
    error: job.error,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    completedAt: job.completed_at
  };
}

async function createReproJob(body, { waitForReport = false } = {}) {
  const normalized = await validateAndNormalizeRequest(body, config);
  const storedRequest = sanitizeForStorage(normalized);

  if (waitForReport) {
    const cached = await findFreshCompletedReport(storedRequest);
    if (cached) {
      return {
        jobId: cached.id,
        status: "completed",
        statusUrl: absoluteUrl(`/v1/jobs/${cached.id}`),
        reportUrl: absoluteUrl(`/v1/reports/${cached.id}`),
        cached: true,
        cachedAt: cached.completed_at,
        report: {
          ...cached.report,
          cache: {
            sourceJobId: cached.id,
            completedAt: cached.completed_at,
            freshnessSeconds: Math.max(0, Math.round((Date.now() - new Date(cached.completed_at || cached.updated_at).getTime()) / 1000))
          }
        }
      };
    }
  }

  const jobId = crypto.randomUUID();
  await createJob({ id: jobId, request: storedRequest });

  if (waitForReport) {
    await updateJob(jobId, { status: "running" });
    try {
      const report = shouldUseFastPaidReport() ? await reproduceBugFast(normalized, { jobId }) : await reproduceBug(normalized, { jobId });
      await updateJob(jobId, {
        status: "completed",
        report,
        error: null
      });
      return {
        jobId,
        status: "completed",
        statusUrl: absoluteUrl(`/v1/jobs/${jobId}`),
        reportUrl: absoluteUrl(`/v1/reports/${jobId}`),
        report
      };
    } catch (error) {
      await updateJob(jobId, {
        status: "failed",
        error: serializeError(error)
      });
      throw error;
    }
  }

  if (config.app.startWorker) {
    await enqueueJob(jobId, normalized, config);
  } else {
    void processJob(jobId, normalized);
  }
  return {
    jobId,
    status: "queued",
    statusUrl: absoluteUrl(`/v1/jobs/${jobId}`),
    reportUrl: absoluteUrl(`/v1/reports/${jobId}`),
    message: "Repro accepted the paid request and started a real browser reproduction job. Poll statusUrl until status is completed, then fetch reportUrl."
  };
}

async function findFreshCompletedReport(storedRequest) {
  if (!config.app.syncCacheTtlSeconds || config.app.syncCacheTtlSeconds <= 0) return null;
  const jobs = await listJobs(100);
  const requestKey = stableJson(storedRequest);
  const ttlMs = config.app.syncCacheTtlSeconds * 1000;
  return jobs.find((job) => {
    if (job.status !== "completed" || !job.report) return false;
    const completedAt = new Date(job.completed_at || job.updated_at).getTime();
    if (!Number.isFinite(completedAt) || Date.now() - completedAt > ttlMs) return false;
    return stableJson(job.request) === requestKey;
  }) || null;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function shouldWaitForReport(req) {
  if ((process.env.PAYMENT_MODE || "free").toLowerCase() === "x402") return true;
  if (String(req.query.async || "") === "1") return false;
  if (String(req.query.sync || "") === "1") return true;
  return false;
}

function shouldUseFastPaidReport() {
  if ((process.env.PAYMENT_MODE || "free").toLowerCase() !== "x402") return false;
  return process.env.REPRO_X402_FAST_REPORT !== "false";
}

function absoluteUrl(relativePath) {
  const base = String(config.app.publicBaseUrl || "").trim();
  const normalizedBase = /^https?:\/\//i.test(base) ? base : `https://${base}`;
  return new URL(relativePath, normalizedBase.endsWith("/") ? normalizedBase : `${normalizedBase}/`).toString();
}

function serializeError(error) {
  if (error instanceof ReproError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      details: error.details || null
    };
  }
  return {
    code: "internal_error",
    message: error.message || "Repro failed.",
    status: 500
  };
}

function decodeTaskPayload(query) {
  const payload = unwrapTaskPayload(query);
  if (typeof payload === "string") return payloadFromText(payload);

  const body = {
    url: payload.url || payload.websiteUrl || payload.appUrl || payload.targetUrl,
    bugReport: payload.bugReport || payload.report || payload.issue || payload.task || payload.prompt || payload.description,
    expectedBehavior: payload.expectedBehavior || payload.expected || payload.acceptanceCriteria,
    viewport: payload.viewport || payload.device
  };

  const credentials = payload.credentials || payload.login || payload.auth || {};
  const username = credentials.username || credentials.email || payload.username || payload.email;
  const password = credentials.password || payload.password;
  if (username || password) {
    body.credentials = { username, password };
  }

  if (payload.testData) {
    body.testData = typeof payload.testData === "string" ? parseJsonQuery(payload.testData, "testData") : payload.testData;
  }

  return body;
}

function parseJsonQuery(value, name) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    const error = new ReproError(`Invalid JSON in ${name}.`, {
      code: "invalid_request",
      status: 400,
      details: { field: name }
    });
    throw error;
  }
}

function unwrapTaskPayload(value) {
  if (value == null) return {};
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return {};
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return parseJsonQuery(trimmed, "body");
    return trimmed;
  }

  const wrappers = ["body", "serviceParams", "params", "parameters", "arguments", "input", "payload", "data"];
  for (const key of wrappers) {
    if (value[key] != null) return unwrapTaskPayload(value[key]);
  }

  return value;
}

function payloadFromText(text) {
  const match = text.match(/https?:\/\/[^\s<>"')]+/i);
  return {
    url: match?.[0],
    bugReport: text,
    expectedBehavior: undefined,
    viewport: /mobile/i.test(text) ? "mobile" : "desktop"
  };
}
