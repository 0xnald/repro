import { reproduceBug } from "./analyzer.js";
import { dequeueJob } from "./queue.js";
import { getJob, updateJob } from "./db.js";
import { ReproError } from "./errors.js";

let workerStarted = false;

export function startWorker({ inline = false } = {}) {
  if (workerStarted) return;
  workerStarted = true;
  void workerLoop({ inline });
}

async function workerLoop() {
  while (true) {
    const item = await dequeueJob({ blockSeconds: 5 }).catch(async (error) => {
      await pause(2500);
      return { error };
    });
    if (!item || item.error) continue;
    await processJob(item.jobId, item.payload);
  }
}

async function processJob(jobId, payload) {
  if (!payload) {
    await updateJob(jobId, {
      status: "failed",
      error: { code: "missing_payload", message: "Job payload expired before processing." }
    });
    return;
  }

  const existing = await getJob(jobId);
  if (!existing) return;

  await updateJob(jobId, { status: "running" });
  try {
    const report = await reproduceBug(payload, { jobId });
    await updateJob(jobId, {
      status: "completed",
      report,
      error: null
    });
  } catch (error) {
    await updateJob(jobId, {
      status: "failed",
      error: serializeError(error)
    });
  }
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

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
