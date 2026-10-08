const API_URL = document.querySelector('meta[name="speaktoalex-api"]')?.content?.trim();
const TURNSTILE_SITE_KEY = document.querySelector('meta[name="turnstile-site-key"]')?.content?.trim();
const WHATSAPP_URL = "https://wa.me/85265356093?text=Help%20me%20Alex,%20you%20are%20my%20only%20hope%20";

const form = document.querySelector("#request-form");
const textarea = document.querySelector("#message");
const button = document.querySelector("#submit");
const result = document.querySelector("#result");
const turnstileSlot = document.querySelector("#turnstile-slot");
let turnstileWidgetId = null;

if (TURNSTILE_SITE_KEY) {
  const script = document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  script.async = true;
  script.defer = true;
  script.onload = () => {
    turnstileWidgetId = window.turnstile?.render(turnstileSlot, { sitekey: TURNSTILE_SITE_KEY });
  };
  document.head.appendChild(script);
}

function showResult(html) {
  result.hidden = false;
  result.innerHTML = html;
  result.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  }[char]));
}

function scoringHtml(scoring) {
  if (!scoring) return "";
  if (scoring.routing_status && scoring.routing_status !== "routed") {
    return `<div class="scoring">Jev scoring unavailable (${escapeHtml(scoring.routing_status)})</div>`;
  }
  const parts = [];
  if (scoring.branch) parts.push(`branch: ${scoring.branch}`);
  const label = scoring.labels && (scoring.labels.work_area || scoring.labels.personal_fun);
  if (label) parts.push(`label: ${label}`);
  if (scoring.urgency && typeof scoring.urgency.rounded === "number") {
    const raw = typeof scoring.urgency.raw === "number" ? ` (raw ${scoring.urgency.raw.toFixed(2)})` : "";
    parts.push(`urgency: ${scoring.urgency.rounded}/10${raw}`);
  }
  const domainConfidence = scoring.confidence && scoring.confidence.request_domain;
  if (typeof domainConfidence === "number") {
    parts.push(`confidence: ${Math.round(domainConfidence * 100)}%`);
  }
  if (scoring.needs_review) parts.push("needs review");
  if (!parts.length) return "";
  return `<div class="scoring">Jev &rarr; ${escapeHtml(parts.join(" \u00b7 "))}</div>`;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = textarea.value.trim();
  if (!message) return;

  button.disabled = true;
  button.textContent = "Routing...";
  result.hidden = true;

  try {
    const turnstileToken = turnstileWidgetId != null ? window.turnstile?.getResponse(turnstileWidgetId) : undefined;
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, turnstileToken }),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `Request failed with ${response.status}`);
    }

    if (data.decision === "whatsapp") {
      showResult(`
        <strong>Wow this sounds serious, you can whatsapp him directly (he is probably eating his Hakata Ramen though )</strong>
        <div>Reference: ${escapeHtml(data.id || "stored")}</div>
        ${scoringHtml(data.scoring)}
        <a class="whatsapp-button" href="${WHATSAPP_URL}" target="_blank" rel="noopener">WhatsApp Alex directly</a>
      `);
      form.reset();
      if (turnstileWidgetId != null) window.turnstile?.reset(turnstileWidgetId);
      return;
    }

    showResult(`<strong>I will pass along your message to Alex.</strong><div>Reference: ${escapeHtml(data.id || "stored")}</div>${scoringHtml(data.scoring)}`);
    form.reset();
    if (turnstileWidgetId != null) window.turnstile?.reset(turnstileWidgetId);
  } catch (error) {
    showResult(`<strong>Something went wrong.</strong><div>${escapeHtml(error.message || "Please try again in a moment.")}</div>`);
  } finally {
    button.disabled = false;
    button.textContent = "Send";
  }
});
