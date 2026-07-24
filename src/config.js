import { SystemDownError } from "./errors.js";

export function getConfig() {
  const reasoningRequired = readBoolean("REPRO_REASONING_REQUIRED", true);
  return {
    app: {
      nodeEnv: process.env.NODE_ENV || "development",
      port: Number(process.env.PORT || 8787),
      artifactDir: process.env.ARTIFACT_DIR || "./artifacts",
      publicBaseUrl: process.env.PUBLIC_BASE_URL || process.env.OPENROUTER_SITE_URL || "http://localhost:8787",
      startWorker: readBoolean("REPRO_START_WORKER", (process.env.PAYMENT_MODE || "free").toLowerCase() !== "x402"),
      syncCacheTtlSeconds: Number(process.env.REPRO_SYNC_CACHE_TTL_SECONDS || 86400)
    },
    reasoning: {
      required: reasoningRequired,
      allowStaticFallback: readBoolean("REPRO_ALLOW_STATIC_FALLBACK", false),
      apiKey: process.env.OPENROUTER_API_KEY || "",
      baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      siteUrl: process.env.OPENROUTER_SITE_URL || "http://localhost:8787",
      appName: process.env.OPENROUTER_APP_NAME || "Repro",
      plannerModel: process.env.REPRO_PLANNER_MODEL || "",
      reportModel: process.env.REPRO_REPORT_MODEL || "",
      testModel: process.env.REPRO_TEST_MODEL || "",
      visionModel: process.env.REPRO_VISION_MODEL || "",
      timeoutMs: Number(process.env.REPRO_REASONING_TIMEOUT_MS || 45000),
      visionEnabled: readBoolean("REPRO_VISION_ENABLED", true)
    },
    scan: {
      maxActions: Number(process.env.REPRO_MAX_ACTIONS || 12),
      maxScanSeconds: Number(process.env.MAX_SCAN_SECONDS || process.env.REPRO_MAX_SCAN_SECONDS || 120),
      allowFormSubmit: readBoolean("REPRO_ALLOW_FORM_SUBMIT", false),
      allowExternalNavigation: readBoolean("REPRO_ALLOW_EXTERNAL_NAVIGATION", false),
      allowDownloads: readBoolean("REPRO_ALLOW_DOWNLOADS", false),
      allowDestructiveActions: readBoolean("REPRO_ALLOW_DESTRUCTIVE_ACTIONS", false),
      recordVideo: readBoolean("REPRO_RECORD_VIDEO", false),
      fullPageScreenshots: readBoolean("REPRO_FULL_PAGE_SCREENSHOTS", false),
      artifactRetentionDays: Number(process.env.ARTIFACT_RETENTION_DAYS || 14)
    },
    database: {
      url: process.env.DATABASE_URL || ""
    },
    redis: {
      url: process.env.REDIS_URL || ""
    },
    storage: {
      endpoint: process.env.S3_ENDPOINT || "",
      bucket: process.env.S3_BUCKET || "",
      accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
      publicBaseUrl: process.env.S3_PUBLIC_BASE_URL || "",
      region: process.env.S3_REGION || "auto"
    }
  };
}

export function assertReasoningReady(config = getConfig()) {
  if (!config.reasoning.required) return;
  const missing = [];
  if (!config.reasoning.apiKey) missing.push("OPENROUTER_API_KEY");
  if (!config.reasoning.baseUrl) missing.push("OPENROUTER_BASE_URL");
  if (!config.reasoning.plannerModel) missing.push("REPRO_PLANNER_MODEL");
  if (!config.reasoning.reportModel) missing.push("REPRO_REPORT_MODEL");
  if (!config.reasoning.testModel) missing.push("REPRO_TEST_MODEL");
  if (config.reasoning.visionEnabled && !config.reasoning.visionModel) missing.push("REPRO_VISION_MODEL");
  if (config.reasoning.allowStaticFallback) missing.push("REPRO_ALLOW_STATIC_FALLBACK must be false");
  if (missing.length > 0) {
    throw new SystemDownError("Reasoning engine is not configured.", { missing });
  }
}

export function serviceReadiness(config = getConfig()) {
  const storageConfigured = Boolean(
    config.storage.endpoint &&
    config.storage.bucket &&
    config.storage.accessKeyId &&
    config.storage.secretAccessKey &&
    config.storage.publicBaseUrl
  );
  return {
    reasoningConfigured: Boolean(
      config.reasoning.apiKey &&
      config.reasoning.baseUrl &&
      config.reasoning.plannerModel &&
      config.reasoning.reportModel &&
      config.reasoning.testModel &&
      !config.reasoning.allowStaticFallback
    ),
    databaseConfigured: Boolean(config.database.url),
    redisConfigured: Boolean(config.redis.url),
    storageConfigured,
    maxActions: config.scan.maxActions,
    maxScanSeconds: config.scan.maxScanSeconds,
    artifactRetentionDays: config.scan.artifactRetentionDays
  };
}

function readBoolean(key, defaultValue) {
  const value = process.env[key];
  if (value == null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
