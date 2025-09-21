import { kv } from "@vercel/kv";

// Optional: a Zapier hook to notify on scan (non-blocking)
const ZAPIER_HOOK = process.env.ZAPIER_HOOK || "";
const REGEN_LINK = process.env.REGEN_LINK || "https://example.com/regenerate";

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        c
      ] || c)
  );
}

function coerceToObject(input) {
  if (!input) return {};
  if (typeof input === "object") return input;
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {}
    try {
      const obj = {};
      for (const [k, v] of new URLSearchParams(input)) obj[k] = v;
      if (Object.keys(obj).length) return obj;
    } catch {}
  }
  return { note: "Payload was not valid JSON" };
}

function humanizeKey(key) {
  return key
    .replace(/[_-]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatLabel(key) {
  return escapeHtml(humanizeKey(key));
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") {
    return '<span class="muted">—</span>';
  }
  const raw =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return escapeHtml(raw).replace(/\n/g, "<br>");
}

function formatDateTime(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function renderPage(res, statusCode, { status, title, subtitle, bodyHtml, footerHtml }) {
  const statusMeta = {
    success: { label: "Verified", className: "badge badge--success" },
    info: { label: "Status", className: "badge badge--info" },
    error: { label: "Attention", className: "badge badge--error" },
    default: { label: "Notice", className: "badge" },
  };

  const meta = statusMeta[status] || statusMeta.default;
  const safeTitle = escapeHtml(title);
  const safeSubtitle = subtitle ? escapeHtml(subtitle) : "";

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(statusCode).send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle} · Lasermax</title>
    <style>
      :root {
        color-scheme: dark;
        --bg-primary: rgba(15, 23, 42, 0.78);
        --border-color: rgba(148, 163, 184, 0.18);
        --text-primary: #f8fafc;
        --text-muted: #94a3b8;
      }
      *, *::before, *::after { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: clamp(20px, 4vw, 48px);
        font-family: "Inter", "SF Pro Display", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          radial-gradient(120% 120% at 50% 0%, rgba(56, 189, 248, 0.12), transparent 55%),
          linear-gradient(160deg, #0f172a, #020617 70%);
        color: rgba(226, 232, 240, 0.92);
      }
      .card {
        width: min(780px, 100%);
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 28px;
        padding: clamp(24px, 4vw, 44px);
        box-shadow: 0 45px 80px rgba(15, 23, 42, 0.45);
        backdrop-filter: blur(18px);
      }
      .card__header {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-bottom: clamp(20px, 3vw, 32px);
      }
      .badge {
        align-self: flex-start;
        font-size: 0.72rem;
        letter-spacing: 0.22em;
        text-transform: uppercase;
        padding: 6px 14px;
        border-radius: 999px;
        border: 1px solid rgba(148, 163, 184, 0.28);
        background: rgba(148, 163, 184, 0.1);
        color: rgba(226, 232, 240, 0.78);
        font-weight: 600;
      }
      .badge--success {
        background: rgba(34, 197, 94, 0.18);
        border-color: rgba(74, 222, 128, 0.3);
        color: #4ade80;
      }
      .badge--info {
        background: rgba(56, 189, 248, 0.16);
        border-color: rgba(56, 189, 248, 0.25);
        color: #38bdf8;
      }
      .badge--error {
        background: rgba(248, 113, 113, 0.16);
        border-color: rgba(248, 113, 113, 0.25);
        color: #f87171;
      }
      h1 {
        margin: 0;
        font-size: clamp(1.85rem, 1.4vw + 1.6rem, 2.35rem);
        font-weight: 600;
        color: var(--text-primary);
      }
      .subtitle {
        margin: 0;
        font-size: 0.95rem;
        color: var(--text-muted);
      }
      .card__body {
        display: flex;
        flex-direction: column;
        gap: clamp(16px, 2vw, 28px);
      }
      .details-list {
        display: flex;
        flex-direction: column;
        gap: clamp(12px, 1.6vw, 20px);
      }
      .detail-row {
        display: flex;
        flex-direction: column;
        gap: 8px;
        border-radius: 18px;
        border: 1px solid rgba(148, 163, 184, 0.18);
        background: rgba(148, 163, 184, 0.08);
        padding: clamp(14px, 1.4vw, 20px);
      }
      .detail-row__label {
        font-size: 0.68rem;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: rgba(148, 163, 184, 0.78);
      }
      .detail-row__value {
        font-size: 1rem;
        font-weight: 500;
        line-height: 1.55;
        color: rgba(226, 232, 240, 0.94);
        word-break: break-word;
      }
      .detail-row__value pre {
        margin: 0;
        white-space: pre-wrap;
      }
      .detail-row__value--datetime {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        justify-content: flex-start;
      }
      .datetime-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-radius: 999px;
        background: rgba(148, 163, 184, 0.14);
        border: 1px solid rgba(148, 163, 184, 0.22);
        color: rgba(226, 232, 240, 0.95);
        font-size: 0.9rem;
        font-weight: 500;
      }
      .icon {
        width: 16px;
        height: 16px;
        color: rgba(94, 234, 212, 0.9);
      }
      @media (min-width: 620px) {
        .detail-row {
          flex-direction: row;
          justify-content: space-between;
          align-items: center;
        }
        .detail-row__value {
          text-align: right;
        }
        .detail-row__value--datetime {
          justify-content: flex-end;
        }
      }
      .muted {
        color: rgba(148, 163, 184, 0.75);
      }
      .card__footer {
        margin-top: clamp(18px, 2vw, 28px);
        display: flex;
        flex-wrap: wrap;
        gap: 14px;
        align-items: center;
      }
      .action-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 11px 20px;
        border-radius: 999px;
        text-decoration: none;
        font-weight: 600;
        background: linear-gradient(135deg, #38bdf8, #0ea5e9);
        color: #ecfeff;
        border: 1px solid rgba(56, 189, 248, 0.35);
        transition: transform 0.2s ease, box-shadow 0.2s ease;
      }
      .action-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 20px 35px rgba(14, 165, 233, 0.25);
      }
      .note {
        font-size: 0.85rem;
        color: rgba(148, 163, 184, 0.78);
      }
      @media (max-width: 520px) {
        .card { border-radius: 22px; padding: 24px; }
        .details-grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="card">
      <header class="card__header">
        <span class="${meta.className}">${meta.label}</span>
        <h1>${safeTitle}</h1>
        ${safeSubtitle ? `<p class="subtitle">${safeSubtitle}</p>` : ""}
      </header>
      <div class="card__body">${bodyHtml}</div>
      ${footerHtml ? `<footer class="card__footer">${footerHtml}</footer>` : ""}
    </div>
  </body>
</html>`);
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const base = { ...payload };

  if (base.data) {
    const nested = coerceToObject(base.data);
    if (nested && typeof nested === "object") {
      Object.assign(base, nested);
    }
    delete base.data;
  }

  delete base.partner_id;
  delete base.partner;
  delete base.ttlSeconds;
  delete base.privacy;

  return Object.entries(base)
    .filter(([key]) => key !== "partner_id" && key !== "privacy")
    .map(([key, value]) => ({
      key,
      label: key === "numPeople" ? "Number of People" : humanizeKey(key),
      value,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function formatDateTimeParts(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return {
    date: date.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
    time: date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }),
  };
}

function renderDateTimeValue(value) {
  const parts = formatDateTimeParts(value);
  if (!parts) return formatValue(value);

  const calendarIcon =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M7 2a1 1 0 0 1 .993.883L8 3v1h8V3a1 1 0 0 1 1.993-.117L18 3v1h1a3 3 0 0 1 2.995 2.824L22 7v11a3 3 0 0 1-2.824 2.995L19 21H5a3 3 0 0 1-2.995-2.824L2 18V7a3 3 0 0 1 2.824-2.995L5 4h1V3a1 1 0 0 1 1-1Zm13 9H4v7a1 1 0 0 0 .883.993L5 19h14a1 1 0 0 0 .993-.883L20 18ZM7 6H5a1 1 0 0 0-.993.883L4 7v2h16V7a1 1 0 0 0-.883-.993L19 6h-2v1a1 1 0 0 1-1.993.117L15 7V6H9v1a1 1 0 0 1-1.993.117L7 7Z"/></svg>';
  const clockIcon =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 1a11 11 0 1 1 0 22a11 11 0 0 1 0-22Zm0 2a9 9 0 1 0 0 18a9 9 0 0 0 0-18Zm.75 3.5v5.19l3.72 2.23a1 1 0 0 1-1 1.74l-4.25-2.55a1 1 0 0 1-.495-.86V6.5a1 1 0 0 1 2 0Z"/></svg>';

  return `
    <span class="datetime-pill">
      ${calendarIcon}
      <span>${escapeHtml(parts.date)}</span>
    </span>
    <span class="datetime-pill">
      ${clockIcon}
      <span>${escapeHtml(parts.time)}</span>
    </span>
  `;
}

function renderDetailRow(entry) {
  const { key, label, value } = entry;
  const valueHtml =
    key === "preferredDateTime"
      ? renderDateTimeValue(value)
      : formatValue(value);
  const extraClass =
    key === "preferredDateTime" ? " detail-row__value--datetime" : "";

  return `
    <article class="detail-row">
      <span class="detail-row__label">${escapeHtml(label)}</span>
      <span class="detail-row__value${extraClass}">${valueHtml}</span>
    </article>
  `;
}

function renderSuccess(res, { email, payload, scannedAt }) {
  const entries = normalizePayload(payload);
  const list = entries.length
    ? `<div class="details-list">${entries.map(renderDetailRow).join("")}</div>`
    : '<p class="muted">No additional details were submitted with this code.</p>';

  const formattedScanTime = formatDateTime(scannedAt);
  const footerHtml = formattedScanTime
    ? `<p class="note">Scan recorded on <strong>${escapeHtml(
        formattedScanTime
      )}</strong>.</p>`
    : "";

  return renderPage(res, 200, {
    status: "success",
    title: "Check-in confirmed",
    subtitle: email,
    bodyHtml: list,
    footerHtml,
  });
}

function renderAlreadyUsed(res, { email, scannedAt }) {
  const formatted = formatDateTime(scannedAt);
  const bodyHtml = `<p class="muted">This QR code was already checked in${
    formatted ? ` on <strong>${escapeHtml(formatted)}</strong>` : " earlier"
  }. Only one scan is allowed.</p>`;

  const footerHtml = `<a class="action-btn" href="${escapeHtml(
    REGEN_LINK
  )}" target="_blank" rel="noopener">Request new access</a>`;

  return renderPage(res, 200, {
    status: "info",
    title: "Already checked in",
    subtitle: email,
    bodyHtml,
    footerHtml,
  });
}

export default async function handler(req, res) {
  // Accept either ?email=... or ?rid=... (request id from Zapier/Tilda flow)
  const query = req.method === "GET" ? req.query : req.query || {};
  const emailQ = (query.email || "").trim().toLowerCase();
  const rid = (query.rid || "").trim();

  // If rid provided, try to resolve a pending entry first
  let email = emailQ;
  if (!email && rid) {
    try {
      const pendKey = `pending:${rid}`;
      const pending = await kv.get(pendKey);
      if (pending && typeof pending === "object") {
        // pending may include verifyUrl, email, key, qrUrl
        if (pending.email) email = String(pending.email).trim().toLowerCase();
        // if server stored the actual key, use it below; otherwise derive from email
      }
    } catch (e) {
      console.warn("verify: pending lookup failed", String(e));
    }
  }

  if (!email) {
    return renderPage(res, 400, {
      status: "error",
      title: "Missing email",
      bodyHtml:
        '<p class="muted">We could not determine the email associated with this QR code.</p>',
      footerHtml: `<a class="action-btn" href="${escapeHtml(
        REGEN_LINK
      )}" target="_blank" rel="noopener">Request new access</a>`,
    });
  }

  const key = `qr:email:${email}`;

  // Look up stored record
  const rec = await kv.hgetall(key);

  if (!rec || (rec.email && String(rec.email).toLowerCase() !== email)) {
    return renderPage(res, 404, {
      status: "error",
      title: "Invalid or expired code",
      bodyHtml:
        '<p class="muted">This QR code is not recognized or may have expired.</p>',
      footerHtml: `<a class="action-btn" href="${escapeHtml(
        REGEN_LINK
      )}" target="_blank" rel="noopener">Request a new code</a>`,
    });
  }

  // Lightweight lock to avoid race on rapid double scans
  const lockKey = `${key}:lock`;
  const gotLock = await kv.set(lockKey, "1", { nx: true, ex: 10 });
  if (!gotLock) {
    return renderAlreadyUsed(res, {
      email: rec.email || email,
      scannedAt: rec.scannedAt,
    });
  }

  try {
    const used = String(rec.used || "").toLowerCase() === "true";
    if (used)
      return renderAlreadyUsed(res, {
        email: rec.email || email,
        scannedAt: rec.scannedAt,
      });

    // Mark as used (single-use)
    const scannedAtIso = new Date().toISOString();
    await kv.hset(key, { used: "true", scannedAt: scannedAtIso });

    // Notify Zapier (non-blocking)
    if (ZAPIER_HOOK) {
      const qs = new URLSearchParams({
        email: rec.email || email,
        scannedAt: scannedAtIso,
      }).toString();
      fetch(`${ZAPIER_HOOK}?${qs}`, { method: "GET" }).catch(() => {});
    }

    // Render payload (safely coerce stored payload)
    const payload = coerceToObject(rec.payload);
    if (payload && typeof payload === "object") {
      delete payload.formid;
      delete payload.formname;
      delete payload.tranid;
    }

    return renderSuccess(res, {
      email: rec.email || email,
      payload,
      scannedAt: scannedAtIso,
    });
  } finally {
    await kv.del(lockKey);
  }
}
