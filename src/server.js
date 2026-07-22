import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reproduceBug } from "./analyzer.js";
import { createPaymentMiddleware, paymentStatus } from "./payment.js";

const port = Number(process.env.PORT || 8787);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");
const artifactDir = path.resolve(process.env.ARTIFACT_DIR || "./artifacts");
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir));
app.use("/artifacts", express.static(artifactDir));
app.use((_, res, next) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, payment, payment-signature, x-payment");
  next();
});

app.get("/health", (_, res) => {
  res.json({
    status: "ok",
    product: "Repro",
    service: "Verified Bug Reproduction",
    payment: paymentStatus()
  });
});

const paymentMiddleware = createPaymentMiddleware();
if (paymentMiddleware) {
  app.use(paymentMiddleware);
}

app.post("/v1/reproduce", async (req, res, next) => {
  try {
    const validationError = validateRequest(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    const report = await reproduceBug(req.body);
    return res.status(200).json(report);
  } catch (error) {
    return next(error);
  }
});

app.use((_, res) => {
  res.status(404).json({ error: "not found" });
});

app.use((error, _, res, __) => {
  res.status(500).json({
    error: error.message || "internal server error"
  });
});

app.listen(port, () => {
  console.log(`Repro ASP listening on http://localhost:${port}`);
});

function validateRequest(body) {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  if (!body.url || typeof body.url !== "string") return "url is required";
  if (!body.bugReport || typeof body.bugReport !== "string") return "bugReport is required";
  if (body.expectedBehavior && typeof body.expectedBehavior !== "string") return "expectedBehavior must be a string";
  if (body.viewport && !["desktop", "mobile", "both"].includes(body.viewport)) return "viewport must be desktop, mobile, or both";
  if (body.credentials && typeof body.credentials !== "object") return "credentials must be an object";
  if (body.testData && typeof body.testData !== "object") return "testData must be an object";
  return null;
}
