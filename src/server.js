import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, serviceReadiness } from "./config.js";
import { validateAndNormalizeRequest, sanitizeForStorage } from "./guardrails.js";
import { createPaymentMiddleware, paymentStatus } from "./payment.js";
import { initDb, createJob, getJob, listJobs } from "./db.js";
import { enqueueJob, queueStatus } from "./queue.js";
import { storageStatus } from "./storage.js";
import { startWorker } from "./worker.js";
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
    const normalized = await validateAndNormalizeRequest(req.body, config);
    const jobId = crypto.randomUUID();
    await createJob({ id: jobId, request: sanitizeForStorage(normalized) });
    await enqueueJob(jobId, normalized, config);
    res.status(202).json({
      jobId,
      status: "queued",
      statusUrl: `/v1/jobs/${jobId}`,
      reportUrl: `/v1/reports/${jobId}`
    });
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

startWorker();

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
