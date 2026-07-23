import fs from "node:fs/promises";
import { getConfig, assertReasoningReady } from "./config.js";
import { SystemDownError } from "./errors.js";

export class OpenRouterReasoner {
  constructor(config = getConfig()) {
    this.config = config;
    assertReasoningReady(config);
  }

  async plan({ request, observation }) {
    return this.jsonCompletion({
      model: this.config.reasoning.plannerModel,
      system: plannerSystemPrompt(),
      user: {
        bugReport: request.bugReport,
        expectedBehavior: request.expectedBehavior || null,
        url: request.url,
        viewport: request.viewport || "desktop",
        observation
      },
      schemaName: "repro_plan"
    });
  }

  async judge({ request, observations, finalObservation, screenshotPaths }) {
    const messages = [
      { role: "system", content: reportSystemPrompt() },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              bugReport: request.bugReport,
              expectedBehavior: request.expectedBehavior || null,
              url: request.url,
              observations,
              finalObservation
            })
          }
        ]
      }
    ];

    if (this.config.reasoning.visionEnabled && screenshotPaths?.length > 0) {
      for (const filePath of screenshotPaths.slice(-2)) {
        messages[1].content.push({
          type: "image_url",
          image_url: { url: await imageDataUrl(filePath) }
        });
      }
    }

    return this.chatJson({
      model: this.config.reasoning.visionEnabled ? this.config.reasoning.visionModel : this.config.reasoning.reportModel,
      messages,
      schemaName: "repro_judgment"
    });
  }

  async generateTest({ request, report, observations }) {
    return this.jsonCompletion({
      model: this.config.reasoning.testModel,
      system: testSystemPrompt(),
      user: {
        bugReport: request.bugReport,
        expectedBehavior: request.expectedBehavior || null,
        url: request.url,
        report,
        actions: observations.actionTrace,
        consoleErrors: observations.consoleErrors,
        failedRequests: observations.failedRequests
      },
      schemaName: "playwright_test"
    });
  }

  async jsonCompletion({ model, system, user, schemaName }) {
    return this.chatJson({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) }
      ],
      schemaName
    });
  }

  async chatJson({ model, messages, schemaName }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.reasoning.timeoutMs);
    try {
      const response = await fetch(`${this.config.reasoning.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${this.config.reasoning.apiKey}`,
          "http-referer": this.config.reasoning.siteUrl,
          "x-title": this.config.reasoning.appName
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.1,
          response_format: { type: "json_object" }
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new SystemDownError("Reasoning engine is unavailable.", {
          provider: "openrouter",
          status: response.status,
          body: text.slice(0, 500)
        });
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new SystemDownError("Reasoning engine returned an empty response.", { provider: "openrouter" });
      }

      try {
        return parseJsonObject(content);
      } catch (error) {
        throw new SystemDownError("Reasoning engine returned invalid JSON.", {
          provider: "openrouter",
          schemaName,
          parseError: error.message,
          body: content.slice(0, 500)
        });
      }
    } catch (error) {
      if (error instanceof SystemDownError) throw error;
      throw new SystemDownError("Reasoning engine is unavailable.", {
        provider: "openrouter",
        cause: error.message
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseJsonObject(content) {
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  return JSON.parse(trimmed);
}

async function imageDataUrl(filePath) {
  const bytes = await fs.readFile(filePath);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function plannerSystemPrompt() {
  return `You are Repro's production bug reproduction planner.
Return only JSON. Do not invent facts.
You receive a bug report and a compact browser observation.
Create a safe action plan to reproduce the bug with real browser actions.
Allowed action types: click, fill, wait, press, navigate.
Use selectors only from provided candidates. Do not choose destructive actions.
If the report is too vague, still propose safe exploration steps.
JSON shape:
{
  "goal": "short goal",
  "risk": "low|medium|high",
  "actions": [
    {"type":"click|fill|wait|press|navigate","selector":"optional selector","value":"optional value","reason":"why this action helps"}
  ],
  "stopSignals": ["observable signals that would prove the bug"]
}`;
}

function reportSystemPrompt() {
  return `You are Repro's evidence judge.
Return only JSON. Use only supplied evidence and screenshots.
Do not claim a bug is reproduced unless the evidence supports it.
If OpenRouter cannot reason, the system handles failure; you must not provide fallback guesses.
JSON shape:
{
  "reproduced": true|false,
  "confidence": 0-100,
  "severity": "low|medium|high|critical",
  "summary": "concise evidence-based summary",
  "actualBehavior": "what happened",
  "expectedBehavior": "expected behavior or null",
  "likelyCause": "evidence-based hypothesis or 'Not enough evidence'",
  "evidenceTimeline": [{"step":"step text","evidence":"observed evidence"}],
  "relatedBugIdeas": ["nearby safe flows worth checking"],
  "githubIssue": {"title":"issue title","body":"issue body"}
}`;
}

function testSystemPrompt() {
  return `You are Repro's Playwright regression test generator.
Return only JSON. Generate a developer-ready Playwright test based on actual observed steps and evidence.
Do not use unsupported selectors. Prefer stable selectors from observed action trace.
JSON shape:
{
  "filename": "repro.spec.ts",
  "code": "complete Playwright test code"
}`;
}
