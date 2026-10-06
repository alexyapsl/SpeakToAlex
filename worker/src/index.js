import { buildTypeSafeRequest, decideRoute } from "./routing.js";
import { storeMessage } from "./githubStorage.js";
import { verifyTurnstile } from "./turnstile.js";
import { rateLimit } from "./rateLimit.js";

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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/route" || request.method !== "POST") {
      return json(env, request, 404, { error: "not_found" });
    }

    const allowedOrigin = env.ALLOWED_ORIGIN || "*";
    const origin = request.headers.get("Origin");
    if (allowedOrigin !== "*" && origin !== allowedOrigin) {
      return json(env, request, 403, { error: "forbidden_origin" });
    }

    const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
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
      });
    } catch (error) {
      if (record.decision === "whatsapp") {
        return json(env, request, 200, {
          id,
          decision: record.decision,
          high_urgency: true,
          stored: false,
          warning: "storage_failed",
        });
      }
      return json(env, request, 502, { error: "storage_failed" });
    }
  },
};
