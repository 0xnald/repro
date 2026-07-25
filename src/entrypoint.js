const processType = (process.env.REPRO_PROCESS || "api").toLowerCase();

if (processType === "presence") {
  await import("./presence.js");
} else if (processType === "api") {
  await import("./server.js");
} else {
  throw new Error(`Unsupported REPRO_PROCESS value: ${process.env.REPRO_PROCESS}`);
}
