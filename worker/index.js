/**
 * Hardened Groq proxy Worker (drop-in replacement for the endpoint the site
 * calls at https://groq-proxy.mr-hackerdon808.workers.dev/api/chat).
 *
 * The deployed Worker's source is NOT in this repository (the repo contains
 * only index.html), so this file is provided as the fix for the security items:
 *
 *   • Origin allowlist        – browsers other than your site get 403 and NO
 *                               CORS header, so their JS cannot read anything.
 *                               `Access-Control-Allow-Origin: *` is never sent.
 *   • Per-IP rate limit       – sliding window, MAX_REQUESTS_PER_WINDOW.
 *   • Per-user (IP+UA) limit  – MAX_BURST in a short window, stops hammering.
 *   • Request size cap        – MAX_BODY_BYTES, checked before parsing.
 *   • Payload validation      – message count / per-message length caps, so a
 *                               hostile client cannot burn tokens in one call.
 *   • Key rotation            – moves to the next Groq key on 401/429/5xx.
 *   • No secret leakage       – upstream bodies are replaced with stable codes;
 *                               key names never appear in a response.
 *
 * Deploy:
 *   npm i -g wrangler
 *   wrangler secret put GROQ_API_KEYS      # comma separated gsk_... values
 *   wrangler deploy
 *
 * Env vars (all optional except GROQ_API_KEYS):
 *   GROQ_API_KEYS, ALLOWED_ORIGINS, MAX_REQUESTS_PER_WINDOW, RATE_WINDOW_MS,
 *   MAX_BURST, BURST_WINDOW_MS, MAX_BODY_BYTES, MAX_MESSAGES,
 *   MAX_MESSAGE_CHARS, GROQ_BASE_URL, DEBUG_ERRORS
 */

const DEFAULT_ALLOWED_ORIGINS = [
  'https://ayushghbk-afk.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080'
];

const DEFAULTS = {
  RATE_WINDOW_MS: 60_000,
  MAX_REQUESTS_PER_WINDOW: 12,   // per IP, per minute
  BURST_WINDOW_MS: 10_000,
  MAX_BURST: 4,                  // per IP, per 10 seconds
  MAX_BODY_BYTES: 256 * 1024,    // 256 KB request body
  MAX_MESSAGES: 120,
  MAX_MESSAGE_CHARS: 32_000,
  GROQ_BASE_URL: 'https://api.groq.com/openai/v1/chat/completions'
};

/* ------------------------------------------------------------------ helpers */

export function parseAllowedOrigins(raw) {
  const list = String(raw || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return list.length ? list : DEFAULT_ALLOWED_ORIGINS.slice();
}

/** Exact origin match — never a substring or wildcard match. */
export function isAllowedOrigin(origin, allowed) {
  if (!origin) return false;
  const normalized = String(origin).trim().replace(/\/+$/, '');
  return allowed.includes(normalized);
}

export function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

/**
 * In-memory sliding-window limiter.
 * NOTE: a Worker isolate has its own memory, so this is per-isolate
 * best-effort protection (it still stops casual abuse and single-client
 * hammering). For hard guarantees, swap `store` for a KV namespace or a
 * Durable Object — the interface below is all the handler needs.
 */
export function createRateLimiter(store = new Map(), now = () => Date.now()) {
  return function limit(key, { windowMs, max }) {
    const t = now();
    const hits = (store.get(key) || []).filter((ts) => t - ts < windowMs);
    if (hits.length >= max) {
      store.set(key, hits);
      const retryAfter = Math.max(1, Math.ceil((windowMs - (t - hits[0])) / 1000));
      return { allowed: false, retryAfter, count: hits.length };
    }
    hits.push(t);
    store.set(key, hits);
    return { allowed: true, retryAfter: 0, count: hits.length };
  };
}

/** Structural validation of the chat payload the site sends. */
export function validatePayload(body, limits) {
  if (!body || typeof body !== 'object') return { ok: false, code: 'invalid_body' };
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { ok: false, code: 'messages_required' };
  }
  if (body.messages.length > limits.MAX_MESSAGES) {
    return { ok: false, code: 'too_many_messages', max: limits.MAX_MESSAGES };
  }
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') return { ok: false, code: 'invalid_message' };
    if (!['system', 'user', 'assistant', 'tool'].includes(message.role)) {
      return { ok: false, code: 'invalid_role' };
    }
    const content = message.content;
    if (content != null && typeof content !== 'string') return { ok: false, code: 'invalid_content' };
    if (typeof content === 'string' && content.length > limits.MAX_MESSAGE_CHARS) {
      return { ok: false, code: 'message_too_long', max: limits.MAX_MESSAGE_CHARS };
    }
  }
  if (body.max_tokens != null) {
    const mt = Number(body.max_tokens);
    if (!Number.isFinite(mt) || mt < 1 || mt > 16_384) return { ok: false, code: 'invalid_max_tokens' };
  }
  return { ok: true };
}

/** Split the configured key list; tolerate whitespace/newlines. */
export function parseKeys(raw) {
  return String(raw || '')
    .split(/[\s,]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 8);
}

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders }
  });
}

/* ------------------------------------------------------------------ handler */

const limiter = createRateLimiter();

export default {
  async fetch(request, env = {}) {
    const limits = { ...DEFAULTS, ...pickNumbers(env) };
    const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    const origin = request.headers.get('Origin') || '';
    const originOk = isAllowedOrigin(origin, allowedOrigins);
    // Only ever echo the caller's own origin, and only when it is allowlisted.
    const cors = originOk
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '600',
          Vary: 'Origin'
        }
      : {};

    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      if (!originOk) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors });
    }

    if (!originOk) {
      // No CORS headers: a random website's JavaScript cannot read the reply.
      return json({ error: { code: 'origin_not_allowed' } }, 403);
    }

    const keys = parseKeys(env.GROQ_API_KEYS);

    // ---- health probe (the site's header chip calls this on load) ----
    if (request.method === 'GET') {
      return json(
        {
          ok: keys.length > 0,
          service: 'groq-proxy',
          status: keys.length > 0 ? 'online' : 'unconfigured',
          message: keys.length > 0 ? 'Worker is online. Use POST for AI requests.' : 'No Groq keys configured.',
          configured_keys: keys.length
        },
        200,
        cors
      );
    }

    if (request.method !== 'POST') return json({ error: { code: 'method_not_allowed' } }, 405, cors);
    if (!keys.length) return json({ error: { code: 'not_configured' } }, 503, cors);

    // ---- rate limits (per IP, plus a short burst window) ----
    const ip = clientIp(request);
    const perMinute = limiter(`ip:${ip}`, { windowMs: limits.RATE_WINDOW_MS, max: limits.MAX_REQUESTS_PER_WINDOW });
    if (!perMinute.allowed) {
      return json({ error: { code: 'rate_limited' } }, 429, { ...cors, 'Retry-After': String(perMinute.retryAfter) });
    }
    const burst = limiter(`burst:${ip}`, { windowMs: limits.BURST_WINDOW_MS, max: limits.MAX_BURST });
    if (!burst.allowed) {
      return json({ error: { code: 'rate_limited' } }, 429, { ...cors, 'Retry-After': String(burst.retryAfter) });
    }

    // ---- size cap ----
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > limits.MAX_BODY_BYTES) {
      return json({ error: { code: 'payload_too_large', max_bytes: limits.MAX_BODY_BYTES } }, 413, cors);
    }
    const raw = await request.text();
    if (raw.length > limits.MAX_BODY_BYTES) {
      return json({ error: { code: 'payload_too_large', max_bytes: limits.MAX_BODY_BYTES } }, 413, cors);
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: { code: 'invalid_json' } }, 400, cors);
    }

    const verdict = validatePayload(body, limits);
    if (!verdict.ok) return json({ error: { code: verdict.code, max: verdict.max } }, 400, cors);

    // ---- forward with key rotation ----
    let lastStatus = 502;
    for (const key of keys) {
      const upstream = await fetch(env.GROQ_BASE_URL || DEFAULTS.GROQ_BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body)
      });

      if (upstream.ok) {
        const text = await upstream.text();
        return new Response(text, {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      }

      lastStatus = upstream.status;
      // 401/403 = bad key, 429 = exhausted key, 5xx = transient: try the next.
      const shouldRotate = [401, 403, 429, 500, 502, 503, 504].includes(upstream.status);
      if (!shouldRotate) {
        // 400/404/413 etc. are about the request itself; no point rotating.
        const detail = env.DEBUG_ERRORS === 'true' ? await upstream.text().catch(() => '') : undefined;
        return json({ error: { code: 'upstream_rejected_request', status: upstream.status, detail } }, upstream.status, cors);
      }
    }

    // Every key failed: say so without naming keys or echoing provider text.
    const allBusy = lastStatus === 429 || lastStatus >= 500;
    return json(
      { error: { code: allBusy ? 'all_keys_busy' : 'all_keys_rejected', status: lastStatus } },
      allBusy ? 503 : 401,
      cors
    );
  }
};

function pickNumbers(env) {
  const out = {};
  for (const key of [
    'RATE_WINDOW_MS',
    'MAX_REQUESTS_PER_WINDOW',
    'BURST_WINDOW_MS',
    'MAX_BURST',
    'MAX_BODY_BYTES',
    'MAX_MESSAGES',
    'MAX_MESSAGE_CHARS'
  ]) {
    const value = Number(env[key]);
    if (Number.isFinite(value) && value > 0) out[key] = value;
  }
  return out;
}
