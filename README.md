# Your Friend — AI workspace

Single-file frontend (`index.html`, GitHub Pages) + a Cloudflare Worker that
proxies AI requests to Groq, with Supabase for auth, chat history and PDF
backups.

```
index.html          the whole app (UI + logic), no build step
worker/             hardened Groq proxy Worker (drop-in replacement, see below)
.harness/           jsdom test harness that drives the real index.html
```

---

## Tests

Two suites, both run with plain Node (no framework):

```bash
# 1. Frontend: loads the REAL index.html in jsdom and drives it.
#    Only the Supabase CDN bundle and window.fetch are replaced.
cd .harness && npm install && node app-test.mjs

# 2. Worker: executes the real exported fetch handler (Node 22 has
#    Request/Response); only the upstream call to api.groq.com is stubbed.
node worker/worker-test.mjs
```

Latest run: **122 frontend checks passed, 48 worker checks passed, 0 failed.**

What the frontend suite actually exercises (mapped to the review checklist):

| Area | Covered checks |
| --- | --- |
| AI reliability (1) | long message trimmed to the context budget, long history trimmed, model switch reaches the request, 3 rapid sends collapse to 1 request, cancellation, retry after failure (no duplicate user turn) |
| Failure handling (1) | 429 / 503-all-keys / 400-too-long / 500-HTML / network-down all produce a short human sentence, a Retry button, and a status-chip state — the provider's raw text and key names never reach the DOM, they go to `console.error` |
| Status indicator (5) | boot health probe, chip text/state, Settings panel, graceful degradation when the probe fails |
| Chat (2, 10) | send → render → persist, counter, survives refresh, search filter + empty state, delete is permanent across refresh, duplicate "New Chat" guard, message action toolbar, markdown + code blocks + copy buttons |
| Settings (7) | theme, font size, compact, enter-to-send, sound, auto-scroll, memory, PDF preview, response length, language, model, animations, privacy mode — every one verified to survive a simulated refresh |
| Memory (8) | edit/delete buttons, duplicate suppression, 40-item cap, privacy mode excludes memory from the real request, "what the AI receives" preview |
| PDFs (9) | size, timestamp, duplicate detection, rename (persisted), search, delete with confirmation |
| Performance (11) | jsPDF and highlight.js are **not** downloaded on first paint; jsPDF is fetched when a PDF is created, highlight.js when a code block renders |
| Auth (6) | login, wrong-password rejection, logout clears the workspace |

Known harness limits: it stubs Supabase (so RLS policies and Storage
permissions are **not** verified) and it cannot reach the real Groq API.

---

## Hardening the proxy Worker (`worker/`)

`worker/index.js` is a drop-in replacement for the deployed endpoint. The
deployed Worker's source is not in this repository, so the running endpoint is
**not** protected until this is deployed:

```bash
cd worker
wrangler secret put GROQ_API_KEYS   # "gsk_a,gsk_b,gsk_c,gsk_d"
wrangler deploy
```

Behaviour (all covered by `worker/worker-test.mjs`):

- **Origin allowlist** — `Access-Control-Allow-Origin` is only ever echoed back
  for an exact match against `ALLOWED_ORIGINS`
  (default `https://ayushghbk-afk.github.io`). `*` is never sent, and a
  non-allowlisted caller gets `403` with no CORS header, so its JavaScript
  cannot read the response.
- **Rate limits** — sliding window per client IP (default 12/min) plus a burst
  window (4/10 s), both answering `429` + `Retry-After`. In-memory per isolate;
  swap the store for KV or a Durable Object for hard guarantees.
- **Size + shape caps** — 256 KB body, ≤ 120 messages, ≤ 32 k chars/message,
  `max_tokens` sanity check.
- **Key rotation** — 401/403/429/5xx moves to the next Groq key; request-level
  errors (400/404/413) are returned immediately instead of burning every key.
- **No secret leakage** — upstream bodies are replaced with stable codes
  (`all_keys_busy`, `upstream_rejected_request`, …). Set `DEBUG_ERRORS=true`
  only while diagnosing.
- **Health probe** — `GET` returns
  `{ ok, service, status, message, configured_keys }`; the site's header chip
  reads `configured_keys` on load.

---

## Notes / open items

- Real end-to-end calls to Groq still need a manual pass from a browser on the
  live site (the CI sandbox has no route to `api.groq.com` or
  `*.workers.dev`); the frontend's handling of every documented failure shape
  is automated instead.
- Mobile devices (Samsung Internet, landscape, on-screen keyboard, slow
  networks) need manual device testing; the responsive pieces that can be
  checked statically are in place: viewport meta with `viewport-fit=cover`, a
  768 px media query, and a `visualViewport` resize handler that keeps the
  focused input visible.
- Component-level code splitting for the image tool / PDF panel would need a
  build step; today the two heavy libraries are lazy-loaded instead.
