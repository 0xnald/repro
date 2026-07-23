import pg from "pg";
import { getConfig } from "./config.js";

let pool;
let memoryJobs = new Map();

export function getPool(config = getConfig()) {
  if (!config.database.url) return null;
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.database.url,
      ssl: shouldUseSsl(config.database.url) ? { rejectUnauthorized: false } : undefined
    });
  }
  return pool;
}

export async function initDb(config = getConfig()) {
  const client = getPool(config);
  if (!client) return { mode: "memory" };
  await client.query(`
    create table if not exists repro_jobs (
      id uuid primary key,
      status text not null,
      request jsonb not null,
      report jsonb,
      error jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      completed_at timestamptz
    );
    create index if not exists repro_jobs_created_at_idx on repro_jobs (created_at desc);
  `);
  return { mode: "postgres" };
}

export async function createJob({ id, request }) {
  const client = getPool();
  const now = new Date().toISOString();
  if (!client) {
    memoryJobs.set(id, { id, status: "queued", request, report: null, error: null, created_at: now, updated_at: now, completed_at: null });
    return memoryJobs.get(id);
  }
  await client.query(
    "insert into repro_jobs (id, status, request) values ($1, $2, $3)",
    [id, "queued", request]
  );
  return getJob(id);
}

export async function updateJob(id, patch) {
  const client = getPool();
  const current = await getJob(id);
  if (!current) return null;
  const next = { ...current, ...patch, updated_at: new Date().toISOString() };
  if (patch.status === "completed" || patch.status === "failed") next.completed_at = new Date().toISOString();
  if (!client) {
    memoryJobs.set(id, next);
    return next;
  }
  await client.query(
    "update repro_jobs set status=$2, report=$3, error=$4, updated_at=now(), completed_at=$5 where id=$1",
    [id, next.status, next.report || null, next.error || null, next.completed_at || null]
  );
  return getJob(id);
}

export async function getJob(id) {
  const client = getPool();
  if (!client) return memoryJobs.get(id) || null;
  const result = await client.query("select * from repro_jobs where id=$1", [id]);
  return result.rows[0] || null;
}

export async function listJobs(limit = 20) {
  const client = getPool();
  if (!client) {
    return [...memoryJobs.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
  }
  const result = await client.query("select * from repro_jobs order by created_at desc limit $1", [limit]);
  return result.rows;
}

function shouldUseSsl(url) {
  return /^postgres(ql)?:\/\//.test(url) && !url.includes("localhost") && !url.includes("127.0.0.1");
}
