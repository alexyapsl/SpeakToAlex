import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSystemPrompt,
  extractJson,
  followUpsUsed,
  parseAgentDecision,
  transcriptToMessages,
} from "../src/chat.js";

test("parseAgentDecision parses follow_up JSON", () => {
  const decision = parseAgentDecision('{"action":"follow_up","reply":"How many users are affected?"}');
  assert.equal(decision.action, "follow_up");
  assert.equal(decision.reply, "How many users are affected?");
});

test("parseAgentDecision parses finalize JSON wrapped in prose", () => {
  const decision = parseAgentDecision('Sure! {"action":"finalize","reply":"Thanks, passing to Alex."} done');
  assert.equal(decision.action, "finalize");
  assert.equal(decision.reply, "Thanks, passing to Alex.");
});

test("parseAgentDecision defaults unknown action to finalize", () => {
  const decision = parseAgentDecision('{"action":"banana","reply":"ok"}');
  assert.equal(decision.action, "finalize");
});

test("parseAgentDecision rejects garbage", () => {
  assert.equal(parseAgentDecision("no json here"), null);
  assert.equal(parseAgentDecision('{"action":"follow_up"}'), null);
  assert.equal(parseAgentDecision(""), null);
  assert.equal(parseAgentDecision(null), null);
});

test("extractJson handles markdown fences", () => {
  const parsed = extractJson('```json\n{"action":"follow_up","reply":"q?"}\n```');
  assert.equal(parsed.action, "follow_up");
});

test("followUpsUsed counts assistant turns", () => {
  const transcript = [
    { role: "user", content: "a" },
    { role: "assistant", content: "q1" },
    { role: "user", content: "b" },
    { role: "assistant", content: "q2" },
    { role: "user", content: "c" },
  ];
  assert.equal(followUpsUsed(transcript), 2);
});

test("buildSystemPrompt bakes in the follow-up cap", () => {
  const prompt = buildSystemPrompt(3);
  assert.match(prompt, /up to 3 short follow-up questions/);
  assert.match(prompt, /STRICT JSON/);
});

test("transcriptToMessages prepends system prompt", () => {
  const messages = transcriptToMessages([{ role: "user", content: "hi" }], 3);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].role, "user");
  assert.equal(messages.length, 2);
});
