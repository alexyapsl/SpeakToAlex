export async function verifyTurnstile(env, token, remoteIp) {
  if (!env.TURNSTILE_SECRET) return { ok: true, skipped: true };
  if (!token) return { ok: false, reason: "missing_token" };

  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET,
    response: token,
  });
  if (remoteIp) body.set("remoteip", remoteIp);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) return { ok: false, reason: `siteverify_${response.status}` };
  const data = await response.json();
  return data.success ? { ok: true } : { ok: false, reason: (data["error-codes"] || []).join(",") || "failed" };
}
