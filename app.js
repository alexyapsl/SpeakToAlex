const API_URL = document.querySelector('meta[name="speaktoalex-api"]')?.content?.trim();
const CHAT_URL = API_URL ? API_URL.replace(/\/route$/, "/chat/message") : null;
const TURNSTILE_SITE_KEY = document.querySelector('meta[name="turnstile-site-key"]')?.content?.trim();
const WHATSAPP_URL = "https://wa.me/85265356093?text=Help%20me%20Alex,%20you%20are%20my%20only%20hope%20";

const form = document.querySelector("#chat-form");
const textarea = document.querySelector("#message");
const button = document.querySelector("#submit");
const thread = document.querySelector("#thread");
const turnstileSlot = document.querySelector("#turnstile-slot");
let turnstileWidgetId = null;
let sessionId = null;
let finished = false;

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

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  }[char]));
}

function scrollToBottom() {
  thread.scrollTop = thread.scrollHeight;
}

function addBubble(role, html) {
  const bubble = document.createElement("div");
  bubble.className = `msg ${role}`;
  bubble.innerHTML = html;
  thread.appendChild(bubble);
  scrollToBottom();
  return bubble;
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
  if (Array.isArray(scoring.vip_matches) && scoring.vip_matches.length) {
    parts.push(`VIP: ${scoring.vip_matches.join(", ")} (+${scoring.vip_boost || 2})`);
  }
  if (!parts.length) return "";
  return `<div class="scoring">Jev &rarr; ${escapeHtml(parts.join(" \u00b7 "))}</div>`;
}

function setBusy(busy) {
  button.disabled = busy;
  textarea.disabled = busy;
  button.textContent = busy ? "..." : "Send";
  if (!busy) textarea.focus();
}

function finishConversation(data) {
  finished = true;
  form.classList.add("hidden");
  const scoring = scoringHtml(data.scoring);
  if (data.decision === "whatsapp") {
    const qrAvailable = typeof window.qrcode === "function";
    const bubble = addBubble(
      "agent end",
      `<strong>Wow this sounds serious — you can WhatsApp him directly (he is probably eating his Hakata Ramen though)</strong>
       <a class="whatsapp-button" href="${WHATSAPP_URL}" target="_blank" rel="noopener">WhatsApp Alex directly</a>
       ${qrAvailable ? '<div class="qr-row"><div class="qr-code"></div><div class="qr-hint">On a computer? Scan with your phone to open the chat</div></div>' : ""}
       <div class="ref">Reference: ${escapeHtml(data.id || "stored")}</div>
       ${scoring}`,
    );
    if (qrAvailable) {
      const qr = window.qrcode(0, "M");
      qr.addData(WHATSAPP_URL);
      qr.make();
      bubble.querySelector(".qr-code").innerHTML = qr.createImgTag(4, 8);
    }
  } else {
    addBubble(
      "agent end",
      `<strong>All set — I'll pass this along to Alex.</strong>
       <div class="ref">Reference: ${escapeHtml(data.id || "stored")}</div>
       ${scoring}`,
    );
  }
}

async function sendMessage(text) {
  setBusy(true);
  const typing = addBubble("agent typing", '<span class="dot"></span><span class="dot"></span><span class="dot"></span>');

  try {
    const turnstileToken = turnstileWidgetId != null ? window.turnstile?.getResponse(turnstileWidgetId) : undefined;
    const response = await fetch(CHAT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, sessionId, turnstileToken }),
    });
    const data = await response.json().catch(() => ({}));
    typing.remove();

    if (!response.ok) {
      if (data.error === "session_closed") {
        finishConversation({});
        return;
      }
      throw new Error(data.error || `Request failed with ${response.status}`);
    }

    if (data.sessionId) sessionId = data.sessionId;
    if (typeof data.reply === "string" && data.reply.trim()) {
      addBubble("agent", escapeHtml(data.reply));
    }

    if (data.done) finishConversation(data);
  } catch (error) {
    typing.remove();
    addBubble(
      "agent error",
      `<strong>Something went wrong.</strong><div>${escapeHtml(error.message || "Please try again in a moment.")}</div>`,
    );
  } finally {
    if (!finished) setBusy(false);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = textarea.value.trim();
  if (!text || finished) return;
  addBubble("user", escapeHtml(text));
  textarea.value = "";
  fitTextarea();
  sendMessage(text);
});

textarea.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

// Keep the textarea tall enough to show the full placeholder hint (short
// phone screens wrap it to several lines), and grow with the user's typing.
const TEXTAREA_MAX_HEIGHT = 200;
function fitTextarea() {
  if (textarea.disabled) return;
  const current = textarea.value;
  if (!current) textarea.value = textarea.placeholder; // measure the hint's wrapped height
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
  textarea.value = current;
}
textarea.addEventListener("input", fitTextarea);
window.addEventListener("resize", fitTextarea);
fitTextarea();

textarea.focus();
