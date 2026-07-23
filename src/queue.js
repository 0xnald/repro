import Redis from "ioredis";
import { getConfig } from "./config.js";
import { SystemDownError } from "./errors.js";

const queueKey = process.env.REPRO_QUEUE_KEY || "repro:jobs:v2";
let redis;
let memoryQueue = [];
let memoryPayloads = new Map();

export function getRedis(config = getConfig()) {
  if (!config.redis.url) return null;
  if (!redis) {
    redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: 2,
      lazyConnect: true
    });
  }
  return redis;
}

export async function enqueueJob(jobId, payload, config = getConfig()) {
  const client = getRedis(config);
  if (!client) {
    memoryQueue.push(jobId);
    memoryPayloads.set(jobId, payload);
    return;
  }
  try {
    if (client.status === "wait") await client.connect();
    await client.set(payloadKey(jobId), JSON.stringify(payload), "EX", config.scan.maxScanSeconds + 600);
    await client.rpush(queueKey, jobId);
  } catch (error) {
    throw new SystemDownError("Queue is unavailable.", { cause: error.message });
  }
}

export async function dequeueJob({ blockSeconds = 5 } = {}, config = getConfig()) {
  const client = getRedis(config);
  if (!client) {
    const jobId = memoryQueue.shift();
    if (!jobId) return null;
    const payload = memoryPayloads.get(jobId) || null;
    memoryPayloads.delete(jobId);
    return { jobId, payload };
  }
  try {
    if (client.status === "wait") await client.connect();
    const result = await client.blpop(queueKey, blockSeconds);
    if (!result?.[1]) return null;
    const jobId = result[1];
    const raw = await client.get(payloadKey(jobId));
    if (!raw) return { jobId, payload: null };
    await client.del(payloadKey(jobId));
    return { jobId, payload: JSON.parse(raw) };
  } catch (error) {
    throw new SystemDownError("Queue is unavailable.", { cause: error.message });
  }
}

export async function queueStatus(config = getConfig()) {
  const client = getRedis(config);
  if (!client) return { mode: "memory", length: memoryQueue.length };
  try {
    if (client.status === "wait") await client.connect();
    return { mode: "redis", length: await client.llen(queueKey), status: client.status };
  } catch {
    return { mode: "redis", status: "unavailable" };
  }
}

function payloadKey(jobId) {
  return `repro:job:${jobId}:payload`;
}
