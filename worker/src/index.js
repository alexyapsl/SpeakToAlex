import { buildTypeSafeRequest, decideRoute } from "./routing.js";
import { storeMessage } from "./githubStorage.js";
import { verifyTurnstile } from "./turnstile.js";
import { rateLimit } from "./rateLimit.js";
import {
  DEFAULT_MAX_FOLLOW_UPS,
  callChatModel,
  followUpsUsed,
  transcriptToMessages,
} from "./chat.js";

const SESSION_TTL_SECONDS = 60 * 60 * 24;
const MAX_TRANSCRIPT_ENTRIES = 30;

const MAX_MESSAGE_LENGTH = 4000;
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

function corsHeaders(env, request) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN || "*";
  const allowOrigin = allowed === "*" ? "*" : (origin === allowed ? origin : allowed);
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
}

function json(env, request, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(env, request),
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callTypeSafe(env, payload) {
  if (!env.TYPESAFE_API_KEY) throw new Error("missing TYPESAFE_API_KEY");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(TYPESAFE_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.TYPESAFE_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.ok) return await response.json();

      const text = await response.text();
      const error = new Error(`TypeSafe ${response.status}: ${text.slice(0, 300)}`);
      error.status = response.status;
      if ((response.status === 429 || response.status === 529) && attempt === 0) {
        await delay(700);
        continue;
      }
      throw error;
    } catch (error) {
      if (attempt === 0 && error?.name === "AbortError") {
        await delay(700);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("TypeSafe retry exhausted");
}

function buildScoring(record) {
  return {
    branch: record.branch,
    labels: record.labels,
    urgency: record.urgency,
    high_urgency: record.high_urgency,
    needs_review: record.needs_review,
    confidence: record.confidence,
    model: record.model,
    routing_status: record.routing_status,
  };
}

function buildRecord({ id, message, now, route, model, routingStatus = "routed", error = null }) {
  return {
    version: 1,
    id,
    received_at: now,
    message,
    branch: route?.branch ?? null,
    labels: route?.labels ?? {},
    urgency: route?.urgency ?? null,
    decision: route?.decision ?? "inbox",
    high_urgency: route?.high_urgency ?? false,
    needs_review: route ? route.needs_review : true,
    confidence: route?.confidence ?? {},
    model: model ?? null,
    routing_status: routingStatus,
    error,
    storage_status: "stored",
  };
}

async function loadSession(env, id) {
  if (!env.SESSIONS) throw new Error("missing SESSIONS KV binding");
  const session = await env.SESSIONS.get(`session:${id}`, "json");
  return session && typeof session === "object" ? session : null;
}

async function saveSession(env, session) {
  await env.SESSIONS.put(`session:${session.id}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  );
}

async function finalizeChat(request, env, session, agentReply) {
  const userText = session.transcript
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.content)
    .join("\n---\n");
  const firstMessage =
    session.transcript.find((entry) => entry.role === "user")?.content || "";

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  let record;
  try {
    const payload = buildTypeSafeRequest(userText, now);
    const typeSafeResponse = await callTypeSafe(env, payload);
    const route = decideRoute(typeSafeResponse.answers);
    record = buildRecord({ id, message: firstMessage, now, route, model: typeSafeResponse.model });
  } catch (error) {
    console.error("typesafe_routing_failed", String(error?.message || error));
    record = buildRecord({
      id,
      message: firstMessage,
      now,
      route: null,
      routingStatus: "unrouted_api_error",
      error: String(error?.message || error),
    });
  }
  record.version = 2;
  record.channel = "chat";
  record.transcript = session.transcript;
  record.follow_ups_used = followUpsUsed(session.transcript);

  const reply =
    agentReply ||
    (record.decision === "whatsapp"
      ? "This sounds urgent — Alex is being alerted directly right away."
      : "Thanks — I've got everything I need and will pass this along to Alex.");

  session.status = "finalized";
  session.finalized_at = now;
  try {
    await saveSession(env, session);
  } catch (error) {
    console.error("session_save_failed", String(error?.message || error));
  }

  try {
    const stored = await storeMessage(env, record);
    return json(env, request, 200, {
      sessionId: session.id,
      reply,
      done: true,
      id,
      decision: record.decision,
      high_urgency: record.high_urgency,
      stored: true,
      path: stored.path,
      scoring: buildScoring(record),
    });
  } catch (error) {
    console.error("github_storage_failed", String(error?.message || error));
    if (record.decision === "whatsapp") {
      return json(env, request, 200, {
        sessionId: session.id,
        reply,
        done: true,
        id,
        decision: record.decision,
        high_urgency: true,
        stored: false,
        warning: "storage_failed",
        scoring: buildScoring(record),
      });
    }
    return json(env, request, 502, { error: "storage_failed" });
  }
}

async function handleChatMessage(request, env) {
  const limited = await rateLimit(env, clientIp(request), { limit: 30 });
  if (!limited.ok) return json(env, request, 429, { error: "rate_limited" });

  let body;
  try {
    body = await request.json();
  } catch {
    return json(env, request, 400, { error: "invalid_json" });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return json(env, request, 400, { error: "message_required" });
  if (message.length > MAX_MESSAGE_LENGTH) {
    return json(env, request, 413, { error: "message_too_long" });
  }

  let session;
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
  if (sessionId) {
    session = await loadSession(env, sessionId);
    if (!session) return json(env, request, 404, { error: "session_not_found" });
    if (session.status === "finalized") {
      return json(env, request, 409, { error: "session_closed" });
    }
  } else {
    const turnstile = await verifyTurnstile(env, body.turnstileToken, clientIp(request));
    if (!turnstile.ok) return json(env, request, 403, { error: "turnstile_failed" });
    session = {
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      ip: clientIp(request) || null,
      transcript: [],
      status: "active",
    };
  }

  session.transcript.push({ role: "user", content: message, at: new Date().toISOString() });
  if (session.transcript.length > MAX_TRANSCRIPT_ENTRIES) {
    return json(env, request, 413, { error: "conversation_too_long" });
  }

  const parsedCap = Number.parseInt(env.MAX_FOLLOW_UPS ?? "", 10);
  const followUpCap = Number.isFinite(parsedCap) ? parsedCap : DEFAULT_MAX_FOLLOW_UPS;
  const outOfFollowUps = followUpsUsed(session.transcript) >= followUpCap;

  let agentReply = null;
  let mustFinalize = outOfFollowUps;

  if (!outOfFollowUps) {
    try {
      const decision = await callChatModel(
        env,
        transcriptToMessages(session.transcript, followUpCap),
      );
      agentReply = decision.reply;
      mustFinalize = decision.action === "finalize";
    } catch (error) {
      // Never lose the visitor's message: fall back to scoring what we have.
      console.error("chat_model_failed", String(error?.message || error));
      mustFinalize = true;
    }
  }

  if (!mustFinalize) {
    session.transcript.push({
      role: "assistant",
      content: agentReply,
      at: new Date().toISOString(),
    });
    await saveSession(env, session);
    return json(env, request, 200, {
      sessionId: session.id,
      reply: agentReply,
      done: false,
      followUpsLeft: followUpCap - followUpsUsed(session.transcript),
    });
  }

  return finalizeChat(request, env, session, agentReply);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    const url = new URL(request.url);
    const isRoute = url.pathname === "/route";
    const isChat = url.pathname === "/chat/message";
    if ((!isRoute && !isChat) || request.method !== "POST") {
      return json(env, request, 404, { error: "not_found" });
    }

    const allowedOrigin = env.ALLOWED_ORIGIN || "*";
    const origin = request.headers.get("Origin");
    if (allowedOrigin !== "*" && origin !== allowedOrigin) {
      return json(env, request, 403, { error: "forbidden_origin" });
    }

    if (isChat) return handleChatMessage(request, env);

    const ip = clientIp(request);
    const limited = await rateLimit(env, ip);
    if (!limited.ok) return json(env, request, 429, { error: "rate_limited" });

    let body;
    try {
      body = await request.json();
    } catch {
      return json(env, request, 400, { error: "invalid_json" });
    }

    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) return json(env, request, 400, { error: "message_required" });
    if (message.length > MAX_MESSAGE_LENGTH) return json(env, request, 413, { error: "message_too_long" });

    const turnstile = await verifyTurnstile(env, body.turnstileToken, ip);
    if (!turnstile.ok) return json(env, request, 403, { error: "turnstile_failed" });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    let record;

    try {
      const payload = buildTypeSafeRequest(message, now);
      const typeSafeResponse = await callTypeSafe(env, payload);
      const route = decideRoute(typeSafeResponse.answers);
      record = buildRecord({ id, message, now, route, model: typeSafeResponse.model });
    } catch (error) {
      console.error("typesafe_routing_failed", String(error?.message || error));
      record = buildRecord({
        id,
        message,
        now,
        route: null,
        routingStatus: "unrouted_api_error",
        error: String(error?.message || error),
      });
    }

    try {
      const stored = await storeMessage(env, record);
      return json(env, request, 200, {
        id,
        decision: record.decision,
        high_urgency: record.high_urgency,
        stored: true,
        path: stored.path,
        scoring: buildScoring(record),
      });
    } catch (error) {
      console.error("github_storage_failed", String(error?.message || error));
      if (record.decision === "whatsapp") {
        return json(env, request, 200, {
          id,
          decision: record.decision,
          high_urgency: true,
          stored: false,
          warning: "storage_failed",
          scoring: buildScoring(record),
        });
      }
      return json(env, request, 502, { error: "storage_failed" });
    }
  },
};
