import http from "node:http";
import { spawn } from "node:child_process";

const port = Number(process.env.PORT || 8788);
const chainIndex = process.env.OKX_PRESENCE_CHAIN_INDEX || "196";
const intervalMs = Number(process.env.OKX_PRESENCE_INTERVAL_MS || 120000);
const command = process.env.ONCHAINOS_BIN || "onchainos";

const state = {
  status: "starting",
  lastHeartbeatAt: null,
  lastSuccessAt: null,
  lastError: null,
  consecutiveFailures: 0,
  running: false
};

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      service: "Repro OKX Presence",
      chainIndex,
      intervalMs,
      ...state
    }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, () => {
  console.log(`Repro OKX presence worker listening on :${port}`);
});

void heartbeat();
setInterval(() => {
  void heartbeat();
}, intervalMs);

async function heartbeat() {
  if (state.running) return;
  state.running = true;
  state.lastHeartbeatAt = new Date().toISOString();
  try {
    const result = await run(command, ["agent", "heartbeat", "--chain-index", chainIndex]);
    state.status = "ok";
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
    state.consecutiveFailures = 0;
    if (result.stdout) console.log(result.stdout.trim());
  } catch (error) {
    state.status = "error";
    state.lastError = error.message;
    state.consecutiveFailures += 1;
    console.error(`OKX heartbeat failed: ${error.message}`);
  } finally {
    state.running = false;
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: process.env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error((stderr || stdout || `command exited with ${code}`).trim()));
      }
    });
  });
}
