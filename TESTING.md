# Your Friend AI — Testing Guide

## Automated (run this first)

The repo now has a real test suite. It loads the actual `index.html` into jsdom and
exercises the shipped functions — it does not reimplement them.

```bash
cd tests
npm install
npm test
```

Current result: **105 (app) + 83 (auth) + smoke — all green, 0 failed.**

`npm test` runs all three suites in order:

| Suite | Covers |
|---|---|
| `app.test.mjs` | memory, settings, images, proxy, navigation, markup |
| `auth.test.mjs` | sign-in / sign-up / session restore / first paint (added after the login bug) |
| `smoke.mjs` | the UI-list functions from §10 |

It covers:

- Saved Memory persists across chats; Conversation Context does not
- Saved Memory is isolated per user and never serves a stale cache on account switch
- Dedupe, the 50-item cap, and delete
- Privacy mode and the Memory toggle both suppress the memory blocks
- The exact system-prompt payload sent to the AI (`buildMemoryContextPreviewText`)
- Image quota: daily cap, cooldown, daily-limit message
- Reference-upload type and size validation
- `proxyFetch` attaches `Authorization: Bearer <token>` when signed in
- All 43 inline `onclick`/`oninput`/`onchange` handlers resolve in the live page
- **Auth (the bug that made login impossible):** `isValidEmail` accepts real
  addresses; a valid submit actually reaches `signInWithPassword` with the
  password untrimmed; invalid input shows an inline error and makes **no** network
  call; double-submit is locked; Supabase errors are translated; signup without a
  session tells the user to confirm their email; Escape/✕ return a signed-out user
  to the landing page; `TOKEN_REFRESHED` does not rebuild the shell; `data-theme`
  is set before first paint; the app still boots when the Supabase CDN is blocked
- Landing page: headline, CTA count, brand, `<title>`, meta description
- Settings: 3 basic rows visible, 3 collapsed groups, all 13 controls still present,
  destructive actions inside the danger group; live settings search (`filterSettings`)
  filters rows/groups and shows a no-results card
- List systems: chat history renders pinned/today/yesterday/week/month/older groups
  with hover-reveal actions; memory lists show numbered chips + capacity bars
  (`tests/smoke.mjs` covers the new UI functions)

Add a case to `tests/app.test.mjs` when you change memory, settings, images, or the proxy.

---

## Why the live checks below are still manual

This sandbox resolves DNS for the Worker but the TLS handshake is refused
(`OpenSSL SSL_connect: SSL_ERROR_SYSCALL`), so outbound calls to
`groq-proxy.mr-hackerdon808.workers.dev` cannot be made from here. Everything involving
the Worker, Supabase, or a real browser is therefore **unchecked** and needs a browser.

---

## 1. Worker health

In the browser DevTools console on the live site:

```js
await fetch("https://groq-proxy.mr-hackerdon808.workers.dev/", { headers: { Accept: "application/json" } }).then(r => r.json())
```

Expect: `{ ok: true, status: "online", configured_keys: 4 }`.

The AI status pill (top right) should read:

- `● AI Online · Model: Llama 3.3 70B` after a successful check/message
- `⚠ AI trying …` while sending
- `⚠ AI temporarily busy · Trying another provider…` after a failure
- `AI status unknown · Send a message` if the GET health probe is CORS-blocked — this is
  **not** proof the POST path is down

## 2. Chat smoke tests

Console helper (must be logged in):

```js
async function send(raw) {
  const input = document.getElementById("userInput");
  input.value = raw;
  document.getElementById("sendBtn").click();
  await new Promise(r => setTimeout(r, 250));
}
```

| # | Test | Expected |
|---|------|----------|
| 1 | `send("Hi")` | Friendly reply, no red error, pill goes online |
| 2 | Paste a 10k+ char message | Server replies or a friendly busy error, never raw key errors |
| 3 | Send 5 messages quickly | No duplicate titles, no stuck thinking bar, no double-send |
| 4 | Switch model in Settings → Advanced | Pill updates; next request uses the new model |
| 5 | Disable all providers in the Worker | "AI temporarily busy" + friendly retry, never API keys |
| 6 | Rate-limit one Groq key | Worker falls back; user sees "busy", not a raw `429` |
| 7 | Stop generation | Cancel works, row shows "Generation canceled." |

## 3. Memory — the new behaviour

This is the feature that changed, so test it deliberately:

1. Settings → Your data → Memory & prompt.
2. Under **📌 Saved Memory**, add "Lives in Pune".
3. Start a **new chat** and ask "Suggest a weekend plan."
   - Expected: the reply reflects Pune. Saved Memory survived the new chat.
4. Add something under **🧠 Conversation Context**, start another new chat.
   - Expected: it is gone. Conversation Context is per-chat by design.
5. Click **👁 Show what gets sent**.
   - Expected: a `SAVED MEMORY (saved by the user, applies to every chat):` block and a
     `THIS CHAT ONLY - CONVERSATION CONTEXT:` block, in that order.
6. Turn on **Privacy mode** (Settings → Advanced) and re-open the preview.
   - Expected: **both** memory blocks disappear.
7. Log out and log in as a different account.
   - Expected: the other account's Saved Memory is empty, not yours.
8. Refresh the page.
   - Expected: Saved Memory is still there.

## 4. Proxy auth — needs the Worker updated

The frontend now sends `Authorization: Bearer <Supabase access token>`.

**Before the Worker is updated**, `Access-Control-Allow-Headers` probably does not list
`Authorization`, so the browser preflight fails. The frontend detects that and retries
once without the header so the app keeps working. Check in the Network panel:

- [ ] Two POSTs to `/api/chat` for one message = preflight failed, fallback used → update
      the Worker's CORS headers
- [ ] One POST with `Authorization` present and `200` = Worker accepts it

**Once the Worker validates the token, remove the fallback retry in `proxyFetch`**,
otherwise it stays a bypass.

## 5. Image generator

- [ ] Batch of 4 generates; batch is capped at 4
- [ ] Generating twice within 4s shows "Please wait Ns…"
- [ ] After 40 images in a UTC day: "Daily image limit reached (40 images)"
- [ ] Uploading a `.exe` as a reference is rejected
- [ ] Uploading a >5 MB image is rejected
- [ ] Note: the reference file is **not** actually sent to the image endpoint — it is only
      mentioned in the text prompt. Implement or remove it.

## 6. Sign-in (the flow that was broken)

Run this in a real browser — the sandbox cannot reach Supabase or load a browser.

1. Hard-refresh the site. You should land on the landing page with **no theme
   flash** (previously a light-theme user saw a dark page repaint itself).
2. Click **Sign in**, type a real address and password, press **Enter** in the
   password field.
   - Expected: the button becomes "Signing in…" with a spinner, the dialog closes,
     your chats appear. A wrong password shows a red message **inside** the dialog
     ("Email or password is incorrect.") — not a browser alert.
3. Click **✕** or press **Escape**.
   - Expected: you return to the landing page. (Before this fix: an empty chat
     shell with no way back to the sign-in form.)
4. Click **Sign up** with a new address.
   - Expected: either you land in the app, or you are told to check your inbox for
     the confirmation link. If signup cannot complete, check
     `Authentication → Providers → Email` in Supabase.
5. Open the dialog, press Escape while the **Create** tab is open, then check the
   nav — Escape should never move you between screens.
6. DevTools → Network: one `POST /auth/v1/token?grant_type=password` per submit,
   with a JSON body containing the exact email and password. If you see **zero**
   requests, the form never reached Supabase — note the message in the dialog.
7. Turn off Wi-Fi and try to sign in. Expected: "Cannot reach the server. Check
   your connection and try again." — not a silent no-op.
8. Light theme + reload: the first frame should already be light (no dark flash).
9. Mobile (360px): the dialog fits, the on-screen keyboard's **Go** button submits.

## 7. Remaining manual checklist

- [ ] Chat count updates after creating chats; refresh keeps them
- [ ] Chat search by title; deleted chats stay deleted
- [ ] Memory edit/delete, no duplicates
- [ ] PDF rename/delete survive refresh
- [ ] All settings survive refresh (theme, font, compact, enter-to-send, sound,
      auto-scroll, memory, PDF preview, response length, language, model, animations,
      privacy mode)
- [ ] Login/signup validation, persistence across refresh, logout, expired session
- [ ] Mobile: sidebar, modals, and the input bar at 360px / 390px / 768px
