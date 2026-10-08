import test from "node:test";
import assert from "node:assert/strict";
import { buildTypeSafeRequest, decideRoute, scoreToUrgency } from "../src/routing.js";

function answers({ domain = "work", domainConfidence = 0.95, workArea = "AX", personalFun = "fun", workScore = 0, personalScore = 0 }) {
  return {
    request_domain: { type: "choice", choice: domain, confidence: domainConfidence, probabilities: { work: domain === "work" ? domainConfidence : 1 - domainConfidence, personal: domain === "personal" ? domainConfidence : 1 - domainConfidence } },
    work_area: { type: "choice", choice: workArea, confidence: 0.9, probabilities: { AX: 0.9, eStore: 0.05, other: 0.05 } },
    work_urgency: { type: "score", score: workScore, confidence: 0.9, legend: {}, probabilities: {} },
    personal_fun: { type: "choice", choice: personalFun, confidence: 0.9, probabilities: { fun: 0.9, not_fun: 0.1 } },
    personal_urgency: { type: "score", score: personalScore, confidence: 0.9, legend: {}, probabilities: {} },
  };
}

test("work AX high urgency routes to WhatsApp", () => {
  const route = decideRoute(answers({ workScore: 8.2 }));
  assert.equal(route.branch, "work");
  assert.equal(route.labels.work_area, "AX");
  assert.equal(route.urgency.rounded, 9);
  assert.equal(route.high_urgency, true);
  assert.equal(route.decision, "whatsapp");
});

test("personal low urgency stays in inbox", () => {
  const route = decideRoute(answers({ domain: "personal", personalScore: 3.2 }));
  assert.equal(route.branch, "personal");
  assert.equal(route.labels.personal_fun, "fun");
  assert.equal(route.urgency.rounded, 4);
  assert.equal(route.high_urgency, false);
  assert.equal(route.decision, "inbox");
});

test("rounded score boundary: raw 5.5 maps to 7 and escalates", () => {
  const route = decideRoute(answers({ domain: "personal", personalScore: 5.5 }));
  assert.equal(route.urgency.mapped, 6.5);
  assert.equal(route.urgency.rounded, 7);
  assert.equal(route.decision, "whatsapp");
});

test("rounded score boundary: raw 5.49 stays below 7", () => {
  const route = decideRoute(answers({ domain: "personal", personalScore: 5.49 }));
  assert.equal(route.urgency.rounded, 6);
  assert.equal(route.decision, "inbox");
});

test("low-confidence domain defaults to inbox and needs review", () => {
  const route = decideRoute(answers({ domainConfidence: 0.4, workScore: 9.4 }));
  assert.equal(route.needs_review, true);
  assert.equal(route.high_urgency, true);
  assert.equal(route.decision, "inbox");
});

test("score can be derived from probabilities", () => {
  const urgency = scoreToUrgency({ type: "score", probabilities: { "7": 1 }, confidence: 1 });
  assert.equal(urgency.raw, 7);
  assert.equal(urgency.rounded, 8);
  assert.equal(urgency.threshold, 7);
});

test("TypeSafe request has ten urgency levels", () => {
  const request = buildTypeSafeRequest("payment failed on shop.samsung.com checkout", "2026-10-07T00:00:00.000Z");
  assert.equal(request.model, "jev-latest");
  assert.equal(request.questions.work_urgency.criteria.length, 10);
  assert.equal(request.questions.personal_urgency.criteria.length, 10);
  assert.equal(request.state.request.message.includes("shop.samsung.com"), true);
});
