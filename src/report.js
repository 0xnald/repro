export function buildReport({ request, observations, artifacts, regressionTest }) {
  const consoleErrors = observations.console.filter((entry) => ["error", "assert"].includes(entry.type));
  const failedRequests = observations.network.filter((entry) => isMeaningfulNetworkFailure(entry));
  const crashSignals = consoleErrors.filter((entry) =>
    /exception|error|undefined|null|hydration|failed|cannot|crash/i.test(entry.text)
  );

  const reproduced = crashSignals.length > 0 || failedRequests.some((entry) => entry.status >= 500 || entry.failed);
  const confidence = Math.min(99, 35 + consoleErrors.length * 12 + failedRequests.length * 10 + observations.steps.length * 3);
  const severity = chooseSeverity({ reproduced, consoleErrors, failedRequests });

  return {
    product: "Repro",
    service: "Verified Bug Reproduction",
    generatedAt: new Date().toISOString(),
    input: {
      url: request.url,
      bugReport: request.bugReport,
      expectedBehavior: request.expectedBehavior || null,
      viewport: request.viewport || "desktop"
    },
    reproduced,
    confidence,
    severity,
    summary: summarize({ reproduced, consoleErrors, failedRequests, request }),
    steps: observations.steps,
    evidence: {
      finalUrl: observations.finalUrl,
      title: observations.title,
      redirects: observations.redirects,
      consoleErrors,
      failedRequests,
      metadata: observations.metadata,
      screenshots: artifacts.screenshots,
      video: artifacts.video || null
    },
    likelyCause: likelyCause({ consoleErrors, failedRequests }),
    regressionTest,
    artifacts,
    disclaimer: "This report is based only on evidence collected during the automated browser session."
  };
}

function chooseSeverity({ reproduced, consoleErrors, failedRequests }) {
  if (failedRequests.some((entry) => entry.status >= 500)) return "critical";
  if (reproduced && consoleErrors.length > 0) return "high";
  if (failedRequests.length > 0 || consoleErrors.length > 0) return "medium";
  return "low";
}

function summarize({ reproduced, consoleErrors, failedRequests, request }) {
  if (reproduced) {
    return `Repro observed failure evidence while testing: ${request.bugReport}`;
  }
  if (consoleErrors.length > 0 || failedRequests.length > 0) {
    return "Repro did not conclusively reproduce the described bug, but collected runtime evidence that developers should inspect.";
  }
  return "Repro did not observe failure evidence in this run.";
}

function likelyCause({ consoleErrors, failedRequests }) {
  if (consoleErrors.length > 0) {
    return `The strongest signal is a browser console error: ${consoleErrors[0].text.slice(0, 240)}`;
  }
  if (failedRequests.length > 0) {
    const first = failedRequests[0];
    return `The strongest signal is a failed network request to ${first.url} with ${first.failed ? first.errorText : `HTTP ${first.status}`}.`;
  }
  return "No deterministic root-cause signal was collected. Add credentials, test data, or a narrower bug report to improve reproduction.";
}

function isMeaningfulNetworkFailure(entry) {
  if (entry.status >= 400) return true;
  if (!entry.failed) return false;
  if (entry.method === "HEAD" && /ERR_ABORTED/i.test(entry.errorText || "")) return false;
  return !/ERR_ABORTED|NS_BINDING_ABORTED/i.test(entry.errorText || "");
}
