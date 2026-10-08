export const DEFAULT_MAX_FOLLOW_UPS = 3;
// Note: US providers (OpenAI/Anthropic/Gemini) are geo-blocked from HK on
// OpenRouter; Qwen instruct is cheap, fast, non-reasoning, and HK-friendly.
export const DEFAULT_CHAT_MODEL = "qwen/qwen3-30b-a3b-instruct-2507";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export function buildSystemPrompt(maxFollowUps = DEFAULT_MAX_FOLLOW_UPS) {
  return `You are the triage assistant on Alex Yap's contact page (SpeakToAlex). Visitors leave Alex a message; your job is to gather enough context so a separate scoring system can decide whether the request is urgent enough to interrupt Alex directly (WhatsApp) or should just land in his inbox.

Rules:
- The visitor's first message starts the conversation. You may ask up to ${maxFollowUps} short follow-up questions IN TOTAL, one per turn.
- Your FIRST follow-up question must always ask for the visitor's name (who they are), unless they already stated it. Even when the first message already contains enough context, still ask their name first; finalize only once the name is known, the visitor declines to give it, or you are out of follow-ups.
- Spend any remaining follow-ups only on what would materially change urgency: impact, scope, who is affected, deadlines, money/safety/legal exposure, whether it is blocked on Alex specifically.
- You do NOT make the final urgency decision and never reveal scores, thresholds, or internal reasoning.
- Never promise that Alex will do something specific. Be warm, concise, human. Plain text, one question per message, no lists, no small talk beyond a brief acknowledgment.
- When you have their name and enough context (or are out of follow-ups), finalize with a short closing message: if it sounds genuinely urgent, say Alex will be alerted directly right away; otherwise say Alex will read it later.

Respond with STRICT JSON only, no markdown fences:
{"action":"follow_up","reply":"<your single question>"}
or
{"action":"finalize","reply":"<short closing message to the visitor>"}`;
}

export function followUpsUsed(transcript) {
  return transcript.filter((entry) => entry.role === "assistant").length;
}

export function transcriptToMessages(transcript, maxFollowUps = DEFAULT_MAX_FOLLOW_UPS) {
  return [
    { role: "system", content: buildSystemPrompt(maxFollowUps) },
    ...transcript.map((entry) => ({ role: entry.role, content: entry.content })),
  ];
}

export function extractJson(text) {
  if (typeof text !== "string" || !text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseAgentDecision(text) {
  const parsed = extractJson(text);
  if (!parsed || typeof parsed.reply !== "string" || !parsed.reply.trim()) return null;
  return {
    action: parsed.action === "follow_up" ? "follow_up" : "finalize",
    reply: parsed.reply.trim().slice(0, 1000),
  };
}

export function buildNameExtractionMessages(transcript) {
  const lines = transcript
    .map((entry) => `${entry.role === "user" ? "Visitor" : "Assistant"}: ${entry.content}`)
    .join("\n");
  return [
    {
      role: "system",
      content:
        "You extract the visitor's name from a contact-page chat transcript. " +
        "Reply with STRICT JSON only, no markdown fences: " +
        '{"name":"<the visitor\'s name as they stated it>"} or {"name":null} when the visitor never stated their name. ' +
        "Use only what the visitor explicitly said about themselves — never guess, never take the assistant's words, never invent. " +
        "Keep the name exactly as given (no translation, no reformatting).",
    },
    { role: "user", content: lines },
  ];
}

export function parseNameExtraction(text) {
  const parsed = extractJson(text);
  if (!parsed || !("name" in parsed)) return null;
  if (typeof parsed.name !== "string") return null;
  const name = parsed.name.trim();
  if (!name || name.length > 120) return null;
  return name;
}

// Best-effort name extraction at finalize time. Never throws, never blocks
// finalization — returns null on any failure.
export async function extractVisitorName(env, transcript) {
  if (!env.OPENROUTER_API_KEY) return null;
  const model = env.CHAT_MODEL || DEFAULT_CHAT_MODEL;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
        "http-referer": "https://alexyapsl.github.io/SpeakToAlex",
        "x-title": "SpeakToAlex name extraction",
      },
      body: JSON.stringify({
        model,
        messages: buildNameExtractionMessages(transcript),
        temperature: 0,
        max_tokens: 60,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error("name_extraction_failed", `OpenRouter ${response.status}`);
      return null;
    }

    const data = await response.json();
    return parseNameExtraction(data?.choices?.[0]?.message?.content);
  } catch (error) {
    console.error("name_extraction_failed", String(error?.message || error));
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callChatModel(env, messages) {
  if (!env.OPENROUTER_API_KEY) throw new Error("missing OPENROUTER_API_KEY");
  const model = env.CHAT_MODEL || DEFAULT_CHAT_MODEL;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
        "http-referer": "https://alexyapsl.github.io/SpeakToAlex",
        "x-title": "SpeakToAlex triage",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.4,
        max_tokens: 300,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenRouter ${response.status}: ${text.slice(0, 300)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    const decision = parseAgentDecision(content);
    if (!decision) throw new Error("chat_model_unparseable_response");
    return decision;
  } finally {
    clearTimeout(timeout);
  }
}
