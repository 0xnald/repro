export class ReproError extends Error {
  constructor(message, { status = 500, code = "internal_error", details = null } = {}) {
    super(message);
    this.name = "ReproError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class SystemDownError extends ReproError {
  constructor(message, details = null) {
    super(message, { status: 503, code: "system_down", details });
    this.name = "SystemDownError";
  }
}

export class ValidationError extends ReproError {
  constructor(message, details = null) {
    super(message, { status: 400, code: "validation_error", details });
    this.name = "ValidationError";
  }
}

export class GuardrailError extends ReproError {
  constructor(message, details = null) {
    super(message, { status: 422, code: "guardrail_blocked", details });
    this.name = "GuardrailError";
  }
}
