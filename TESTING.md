# Your Friend — Live Testing Guide

This guides you through the end-to-end checks that need a real browser and a real
Cloudflare Worker. The Worker is reachable and reports **4 configured keys**:

```
GET https://groq-proxy.mr-hackerdon808.workers.dev/
-> {"ok":true,"service":"groq-proxy","status":"online","configured_keys":4}
```

> The sandbox used for editing `index.html` has no outbound HTTPS, so automated
> POSTs could not be run from here. Run the browser steps below to verify the
> Worker path for real.

---

## 1. Worker health

Open the site, then in the browser DevTools console run:

```js
await fetch("https://groq-proxy.mr-hackerdon808.workers.dev/", { headers: { Accept: "application/json" } }).then(r => r.json())
```

Expect: `{ ok: true, status: "online", configured_keys: 4 }`.

On the page the new **AI status pill** (top right, next to Settings) should read:

- `● AI Online · Model: Llama 3.3 70B` after a successful check/message.
- `⚠ AI trying …` while a message is being sent.
- `⚠ AI temporarily busy · Trying another provider…` after a failed request.
- `AI status unknown · Send a message` if the GET health probe is blocked by
  CORS; this is **not** proof the POST path is down.

## 2. Real chat smoke tests

In the browser console (must be logged in), use this helper:

```js
async function send(raw) {
  const input = document.getElementById("userInput");
  input.value = raw;
  document.getElementById("sendBtn").click();
  await new Promise(r => setTimeout(r, 250));
}
```

Then run and observe:

| # | Test | Expected |
|---|------|----------|
| 1 | `send("Hi")` | Friendly reply, no red error, status pill goes online. |
| 2 | `send("Write a very long message...")` (pasted, 10k+ chars) | Request is sent; server replies or a **friendly** busy error appears, not raw key errors. |
| 3 | Send 5 messages quickly | No duplicate chat titles, no stuck "thinking" bar, no double-send. |
| 4 | Settings → switch model (Balanced/Fast/Advanced) | Status pill updates to the new model name; next request uses it. |
| 5 | Temporarily disable all providers in the Worker | UI shows "⚠ AI temporarily busy · Trying another provider…" and a friendly retry message, never API keys/stack traces. |
| 6 | Rate-limit one Groq key | Worker falls back to another provider; user may see a short "busy" notice but not raw `429`. |
| 7 | Stop generation | Cancel works, message row shows "Generation canceled. You can retry when ready." |

Use the Network panel and filter for `groq-proxy` to record the exact HTTP status.
If you see `HTTP 400`, compare the request body (messages model/tools) against the
Worker contract; the frontend already truncates long history segments and caps
`max_tokens`.

## 3. What changed in the frontend for these tests

- Added an **AI Online / busy / offline status pill** in the header.
- Added a `proxyFetch()` wrapper that updates the pill on every request and maps
  HTTP errors to friendly text (429/401/5xx/network) instead of leaking API details.
- `getErrorMessage()` now redacts API keys/bearer tokens and caps sneaky long
  payloads.
- jsPDF is no longer loaded on first paint; it lazy-loads the first time a PDF is
  generated.
- Chat sidebar now renders its empty state before login ("Sign in to see and start
  your chats") so "Search chats… 0" has context.
- Memory modal adds **Show what gets sent**, dedupe, 50-item cap, and 240-char
  per item limit.
- PDF Backups add search, rename, file size, generation date, and duplicate
  detection.

## 4. Remaining manual checklist

- [ ] Chat count updates after creating chats
- [ ] Refresh doesn't remove chats
- [ ] Chat search works for titles
- [ ] Deleted chats disappear permanently
- [ ] Memory delete/edit works and no duplicates are created
- [ ] PDF rename/delete survive refresh
- [ ] Image generator (prompt/batch/seed/reference/cancel) on a real device
- [ ] Settings each survive refresh (theme, font, compact, enter-to-send, sound,
  auto-scroll, memory, PDF preview, response length, language, model, animations,
  privacy mode)
- [ ] Login/signup validation + persistence + logout
