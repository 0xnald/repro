const form = document.querySelector("#repro-form");
const runButton = document.querySelector("#run-button");
const runLabel = document.querySelector("#run-label");
const paymentPill = document.querySelector("#payment-pill");
const statusPill = document.querySelector("#status-pill");
const emptyState = document.querySelector("#empty-state");
const results = document.querySelector("#results");

const fields = {
  url: document.querySelector("#url"),
  bugReport: document.querySelector("#bugReport"),
  expectedBehavior: document.querySelector("#expectedBehavior"),
  username: document.querySelector("#username"),
  password: document.querySelector("#password"),
  testData: document.querySelector("#testData")
};

let lastRegressionTest = "";

init();

async function init() {
  wireTabs();
  document.querySelector("#copy-test").addEventListener("click", copyRegressionTest);
  await loadHealth();
  form.addEventListener("submit", submitRepro);
}

async function loadHealth() {
  try {
    const response = await fetch("/health");
    const health = await response.json();
    const payment = health.payment || {};
    if (payment.mode === "x402") {
      paymentPill.textContent = payment.price ? `Paid ${payment.price}` : "Paid";
      paymentPill.className = "pill warn";
    } else {
      paymentPill.textContent = "Free local";
      paymentPill.className = "pill good";
    }
  } catch {
    paymentPill.textContent = "Offline";
    paymentPill.className = "pill bad";
  }
}

async function submitRepro(event) {
  event.preventDefault();
  setRunning(true);
  setStatus("Running", "warn");

  try {
    const payload = buildPayload();
    const response = await fetch("/v1/reproduce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (response.status === 402) {
      setStatus("Payment required", "warn");
      const body = await safeJson(response);
      showError("This endpoint is in paid x402 mode. Use a payment-capable client to replay the request with a valid payment header.", body);
      return;
    }

    const report = await response.json();
    if (!response.ok) {
      setStatus("Failed", "bad");
      showError(report.error || "Repro failed.", report);
      return;
    }

    renderReport(normalizeReport(report));
    setStatus(report.reproduced ? "Reproduced" : "No failure", report.reproduced ? "bad" : "good");
  } catch (error) {
    setStatus("Failed", "bad");
    showError(error.message || "Request failed.", null);
  } finally {
    setRunning(false);
  }
}

function buildPayload() {
  const viewport = new FormData(form).get("viewport") || "desktop";
  const payload = {
    url: fields.url.value.trim(),
    bugReport: fields.bugReport.value.trim(),
    expectedBehavior: fields.expectedBehavior.value.trim(),
    viewport
  };

  if (fields.username.value.trim() || fields.password.value.trim()) {
    payload.credentials = {
      username: fields.username.value.trim(),
      password: fields.password.value
    };
  }

  if (fields.testData.value.trim()) {
    payload.testData = JSON.parse(fields.testData.value);
  }

  return payload;
}

function normalizeReport(report) {
  if (!report.reports) return report;
  const primary = report.reports.find((item) => item.reproduced) || report.reports[0];
  return {
    ...primary,
    reproduced: report.reproduced,
    confidence: report.confidence,
    severity: report.severity,
    summary: primary.summary,
    reports: report.reports
  };
}

function renderReport(report) {
  emptyState.classList.add("hidden");
  results.classList.remove("hidden");

  document.querySelector("#metric-reproduced").textContent = report.reproduced ? "Yes" : "No";
  document.querySelector("#metric-confidence").textContent = `${report.confidence || 0}%`;
  document.querySelector("#metric-severity").textContent = titleCase(report.severity || "low");
  document.querySelector("#summary").textContent = report.summary || "-";
  document.querySelector("#final-url").textContent = report.evidence?.finalUrl || "-";
  document.querySelector("#page-title").textContent = report.evidence?.title || "-";
  document.querySelector("#likely-cause").textContent = report.likelyCause || "-";

  renderScreenshots(report.evidence?.screenshotUrls || []);
  renderSteps(report.steps || []);
  renderLogs(report.evidence?.consoleErrors || [], report.evidence?.failedRequests || []);

  lastRegressionTest = report.regressionTest || "";
  document.querySelector("#regression-test").textContent = lastRegressionTest || "No regression test generated.";
}

function renderScreenshots(urls) {
  const container = document.querySelector("#screenshots");
  container.innerHTML = "";
  if (urls.length === 0) {
    container.innerHTML = "<p>No screenshots were returned.</p>";
    return;
  }

  urls.forEach((url, index) => {
    const figure = document.createElement("figure");
    figure.className = "screenshot";
    const image = document.createElement("img");
    image.src = url;
    image.alt = index === 0 ? "Screenshot before reproduction steps" : "Screenshot after reproduction steps";
    const label = document.createElement("span");
    label.textContent = index === 0 ? "Before" : "After";
    figure.append(image, label);
    container.append(figure);
  });
}

function renderSteps(steps) {
  const list = document.querySelector("#steps-list");
  list.innerHTML = "";
  if (steps.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No steps were recorded.";
    list.append(item);
    return;
  }
  steps.forEach((step) => {
    const item = document.createElement("li");
    item.textContent = step;
    list.append(item);
  });
}

function renderLogs(consoleErrors, failedRequests) {
  document.querySelector("#console-log").textContent = consoleErrors.length
    ? JSON.stringify(consoleErrors, null, 2)
    : "No console errors captured.";
  document.querySelector("#network-log").textContent = failedRequests.length
    ? JSON.stringify(failedRequests, null, 2)
    : "No meaningful failed requests captured.";
}

function showError(message, details) {
  emptyState.classList.add("hidden");
  results.classList.remove("hidden");
  document.querySelector("#metric-reproduced").textContent = "-";
  document.querySelector("#metric-confidence").textContent = "-";
  document.querySelector("#metric-severity").textContent = "Error";
  document.querySelector("#summary").textContent = message;
  document.querySelector("#final-url").textContent = "-";
  document.querySelector("#page-title").textContent = "-";
  document.querySelector("#likely-cause").textContent = "-";
  document.querySelector("#screenshots").innerHTML = "";
  document.querySelector("#steps-list").innerHTML = "<li>Request did not complete.</li>";
  document.querySelector("#console-log").textContent = details ? JSON.stringify(details, null, 2) : message;
  document.querySelector("#network-log").textContent = "";
  lastRegressionTest = "";
  document.querySelector("#regression-test").textContent = "";
}

function wireTabs() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.tab;
      document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab === button));
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.classList.toggle("hidden", panel.id !== `tab-${target}`);
      });
    });
  });
}

async function copyRegressionTest() {
  if (!lastRegressionTest) return;
  await navigator.clipboard.writeText(lastRegressionTest);
  const button = document.querySelector("#copy-test");
  const original = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

function setRunning(isRunning) {
  runButton.disabled = isRunning;
  runLabel.textContent = isRunning ? "Running real browser scan" : "Run Repro";
}

function setStatus(text, tone) {
  statusPill.textContent = text;
  statusPill.className = `pill ${tone || "neutral"}`;
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function titleCase(value) {
  return String(value).slice(0, 1).toUpperCase() + String(value).slice(1);
}
