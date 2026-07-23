import { assertPublicHttpUrl } from "./urlSafety.js";
import { GuardrailError, ValidationError } from "./errors.js";
import { getConfig } from "./config.js";

const destructiveTerms = [
  "delete",
  "remove account",
  "close account",
  "purchase",
  "buy now",
  "send payment",
  "transfer",
  "withdraw",
  "drain",
  "submit payment",
  "cancel subscription"
];

export async function validateAndNormalizeRequest(body, config = getConfig()) {
  if (!body || typeof body !== "object") throw new ValidationError("body must be a JSON object");
  if (!body.url || typeof body.url !== "string") throw new ValidationError("url is required");
  if (!body.bugReport || typeof body.bugReport !== "string") throw new ValidationError("bugReport is required");
  if (body.expectedBehavior && typeof body.expectedBehavior !== "string") {
    throw new ValidationError("expectedBehavior must be a string");
  }
  if (body.viewport && !["desktop", "mobile", "both"].includes(body.viewport)) {
    throw new ValidationError("viewport must be desktop, mobile, or both");
  }
  if (body.credentials && typeof body.credentials !== "object") throw new ValidationError("credentials must be an object");
  if (body.testData && typeof body.testData !== "object") throw new ValidationError("testData must be an object");

  const safeUrl = await assertPublicHttpUrl(body.url);
  const combinedText = `${body.bugReport} ${body.expectedBehavior || ""}`.toLowerCase();
  if (!config.scan.allowDestructiveActions && destructiveTerms.some((term) => combinedText.includes(term))) {
    throw new GuardrailError("This request appears to involve a destructive or payment-like action. Use a sandbox flow or enable explicit destructive-action testing.");
  }

  return {
    url: safeUrl,
    bugReport: body.bugReport.trim(),
    expectedBehavior: body.expectedBehavior?.trim() || "",
    viewport: body.viewport || "desktop",
    credentials: sanitizeCredentials(body.credentials),
    testData: body.testData || {},
    authorizationConfirmed: Boolean(body.authorizationConfirmed)
  };
}

export function sanitizeForStorage(request) {
  return {
    ...request,
    credentials: request.credentials ? {
      username: request.credentials.username ? "[provided]" : "",
      password: request.credentials.password ? "[provided]" : ""
    } : undefined
  };
}

function sanitizeCredentials(credentials) {
  if (!credentials) return undefined;
  return {
    username: typeof credentials.username === "string" ? credentials.username : "",
    password: typeof credentials.password === "string" ? credentials.password : ""
  };
}

export function isActionAllowed(action, config = getConfig()) {
  const text = `${action.reason || ""} ${action.selector || ""} ${action.value || ""}`.toLowerCase();
  if (!config.scan.allowDestructiveActions && destructiveTerms.some((term) => text.includes(term))) return false;
  if (action.type === "navigate" && !config.scan.allowExternalNavigation) return false;
  if (action.type === "download" && !config.scan.allowDownloads) return false;
  return true;
}
