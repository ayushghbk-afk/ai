# Your Friend AI — Audit & Fix Log

Everything in this file was checked against the code in `index.html` (single-file app,
5,200+ lines) on branch `arena/01a04820-ai`. Where a claim in the original review was
wrong, that is called out explicitly rather than quietly accepted.

Verification harness: `tests/app.test.mjs` loads the real `index.html` in jsdom and
exercises the shipped functions. **51 passed, 0 failed.**

```
cd tests && npm install && npm test
```

---

## 1. The finding that matters more than anything in the review

**The "memory" feature did not actually persist.** The review assumed it did and
recommended relabelling it. It was wrong about the code.

Before this change, both the "Chat memory summary" and the "Saved memories" list were
written through `setMemorySummaryForSession(currentSessionId, …)` into
`yf_memory_<userId>_<sessionId>` (`index.html:4268`). Every saved memory was scoped to
one chat. Start a new chat and the AI forgot everything — including the things you had
explicitly told it to remember. The only cross-chat persistence was the system prompt.

Verified in the harness:

```
conversation context is per-chat (chat-1 has it)      PASS
conversation context resets for a new chat            PASS
saved memory is UNCHANGED by the new chat             PASS
```

This matters because the review's suggested tagline — *"The AI that remembers what
matters"* — was not true of the product. It is now.

**Fix:** a separate, user-scoped store.

| | Conversation Context | Saved Memory |
|---|---|---|
| Storage key | `yf_memory_<user>_<session>` | `yf_saved_memories_<user>` |
| Lifetime | This chat only | Until you delete it |
| Injected into the prompt as | `THIS CHAT ONLY - CONVERSATION CONTEXT` | `SAVED MEMORY (saved by the user, applies to every chat)` |
| Cap | 50 items / 6,000 chars | 50 items, 240 chars each |

Both blocks are suppressed by Privacy mode and by the Memory toggle, and the
"Show what gets sent" preview was updated to match the real payload byte-for-byte.

---

## 2. Where the review was right

| # | Claim | Verified? |
|---|---|---|
| 1 | Too much on the homepage | Yes — 3 CTAs, 3 feature cards, generic headline |
| 2 | Landing + app + auth + settings all in one DOM | Yes — one `index.html`, screens toggled with `hidden`; no routes |
| 3 | "Your Friend" is generic | Yes — `<title>` was `Your Friend - AI Assistant` |
| 4 | Settings overload | Yes — 13 controls + 7 buttons flat in one modal |
| 6 | Memory wording contradicts itself | Yes — two strings said "resets with every new chat" |
| 7 | Too many buttons | Yes — but in the **Settings modal**, not the header (header had 4) |
| 9 | AI proxy is the real vulnerability | **Confirmed and worse than described** — see §4 |

## 3. Where the review was wrong

**#10 — "image generation could destroy your API quota."** It cannot. Image generation
does not use a paid API. `buildPollinationsUrl()` (`index.html:1667`) builds a URL against
`https://image.pollinations.ai/prompt/…`, a free public endpoint, and the browser fetches
the image directly. There is no key and no bill. Guardrails were still added (§5) because
unbounded client-side image fetching is a bad experience, but the "quota destroyed"
premise does not apply.

**#10 — "reference images."** The reference upload is not sent anywhere. The code appends
`, use the uploaded reference image <name> for visual guidance` to the text prompt and
discards the file. It cannot influence the output. Worth either implementing or removing;
it is not a security risk.

**#6 — the suggested fix assumed Saved Memory already persisted.** It did not (§1).

**#7 — "the interface exposes buttons for…".** The chat header has 4 buttons (menu, AI
status, image tool, settings). The overload is inside the Settings modal. Fixing the
header would have changed nothing.

---

## 4. Security: what is real, what is not

### The AI proxy accepted unauthenticated requests — confirmed

Before this change `proxyFetch()` sent exactly one header:

```js
headers: { 'Content-Type': 'application/json' }
```

Anyone who opened DevTools got `PROXY_URL`
(`https://groq-proxy.mr-hackerdon808.workers.dev/api/chat`, `index.html:1502`) and could
drive your Groq keys from their own frontend. The review's warning was correct.

**Frontend half is now done:** the signed-in user's Supabase access token is attached as
`Authorization: Bearer <token>` (`index.html:4765`). Verified by intercepting `fetch`:

```
proxy called the configured PROXY_URL          PASS
Authorization Bearer header attached           PASS
```

**The Worker half is NOT done and cannot be done from this repo.** Until
`groq-proxy.mr-hackerdon808.workers.dev` validates that token, the proxy is still open.
The frontend header is a *claim*, not proof. Required in the Worker:

1. Verify the JWT against Supabase (`https://mxhmcapcmeatnmwiwnri.supabase.co/auth/v1`),
   reject requests with no or invalid token.
2. Rate limit per verified user id, not per IP.
3. Cap `max_tokens` and request body size server-side.
4. Reject requests whose `Origin` is not your GitHub Pages host — except keep in mind
   this only stops browsers, not scripts.

### One deliberate compatibility risk, handled

Adding `Authorization` makes the browser send a CORS preflight. If the Worker's
`Access-Control-Allow-Headers` does not yet list `Authorization`, every request would
break. `proxyFetch` therefore retries once without the header if the authenticated call
fails at the network layer, so the app keeps working while the Worker is updated.
**This retry must be removed once the Worker enforces auth**, or it becomes a bypass.

### Unchanged, and correct as-is

The Supabase key in the page (`sb_publishable_…`) is a publishable key. That is the
intended design and is not a leak.

### Not tested

Login persistence, logout, expired sessions, invalid tokens, and end-to-end rate limiting
all require a live browser and the live Worker. They are **unchecked**. `TESTING.md`
carries the manual steps.

---

## 5. What changed in this pass

**Landing page** — one promise, two CTAs (was three). Headline is now the memory claim.
Brand is `Your Friend AI`; the in-app personality is still "Your Friend". Added
`meta description` and `og:` tags, which the page had none of.

**Settings** — 13 controls reorganised into:

- **Visible:** Theme, Language, Enter to Send
- **Advanced** (collapsed): AI model, Response length, Memory, Privacy mode, Font size,
  Compact mode, Auto scroll, Animations, Sound, PDF preview
- **Your data** (collapsed): Memory & prompt, Share, Export chat, Export everything, Import
- **Reset & delete** (collapsed, red): Clear this chat, Reset settings

No control was removed — the harness asserts all 13 still exist.

**Memory modal** — the two kinds of memory are now separate labelled panels, so the
"resets with every new chat" line no longer sits next to a list that was supposed to
persist. Both contradictory strings are gone (0 occurrences).

**Image generation** — daily cap of 40 images, 4s cooldown, batch still capped at 4, and
reference uploads validated for type (PNG/JPEG/WebP/GIF) and size (<5 MB). The code
comments state plainly that these are UX courtesies, not a security boundary.

**Bug fixed** — `proxyFetch()` dereferenced `currentRequestController.signal` unguarded.
It was null outside `sendMessage()`, so any other caller threw a `TypeError`. It now
creates a controller if one is absent.

---

## 6. Correction to something I claimed earlier in this session

I reported that the PDF Backups "View" button called `openPdfHistory()`, which was
defined nowhere, and that clicking it threw a `ReferenceError`. **That was false.**
The handler exists — `window.openPdfHistory = async () => { … }` at line 5,200 of the
original committed file. My check only searched for `function name(` and
`const name = (` forms and missed assignment to `window`.

I removed the duplicate function I had added and restored the original button. The
harness now resolves every inline handler in the live page instead of pattern-matching
the source:

```
all 43 inline handlers resolve to a function   PASS
```

---

## 7. Core navigation — built

Per the decision to keep single-screen switching (no routes), the four-tab bar now drives
real screens inside the one file:

```
💬 Chat   🎨 Create   📁 Library   ⚙️ Settings
```

- **Chat** — `#chat-view`, holds `#chat-container` and the composer. Active on load.
- **Create** — `#create-view`. The image generator was promoted out of its overlay
  (`#image-modal` is gone) into a full screen with a heading and a description.
- **Library** — `#library-view`. PDF Backups and the image gallery were **moved out of the
  sidebar**, which now holds only chats. This is the concrete answer to review item #7.
- **Settings** — stays a modal, as the review recommended.

`switchView(name)` toggles `.is-active`, keeps `aria-current="page"` in sync, sets
`body[data-view]`, and falls back to Chat on an unknown name. Entering Library refreshes
both lists. `openImageModal()` / `closeImageModal()` are kept as thin wrappers so existing
callers and `window` bindings did not have to change.

The sidebar move was done by relocating the elements with their **original ids**, so
`renderPdfHistory()`, `renderImageHistory()` and the search listener work untouched.

## 8. Mobile pass

- Bottom nav: 52px tap targets, `env(safe-area-inset-bottom)`, 4 tabs.
- The header's Create button is hidden at ≤768px — the nav tab already does that job.
- `≤390px`: tighter cards and smaller tab type. `≤340px`: labels drop, icons only.
- Short landscape phones: the bar collapses to a single row so chat keeps its height.
- Create screen controls go full-width on phones instead of sitting in a 220px column.
- Modals already had `max-height: calc(100dvh - 32px)` + scroll; verified still present.

**Not visually verified.** Chromium could not be downloaded in this sandbox (the browser
CDN is blocked), so no screenshots were taken. What *was* verified is that the stylesheet
parses cleanly — 441 rules, 13 media queries, 0 unreadable sheets — and that every new
selector exists, including `.nav-tab` rules at all four breakpoints. Actual pixel layout
at 360/390/768px still needs your eyes.

---

## 9. Still open

| Item | Status | Why |
|---|---|---|
| #9 Worker-side auth, rate limits, quotas | **Not done** | The Worker is not in this repo. Highest remaining risk. |
| Remove the `proxyFetch` auth fallback | Blocked on the Worker | Until the Worker validates the token, removing it breaks the app. |
| Reference-image upload | Not done | The file is never sent — implement or remove. |
| Empty/loading/error states | Not done | Review item #9. |
| Dead CSS | Not done | `.image-tool-card` rules are now unused after the modal was promoted. |

---

## 10. Settings dialog + list UI pass (branch `arena/01a04dd3-ai`)

**The headline bug: the settings switches lied to you.** The blanket card rule
`.settings-card button` (specificity 0-1-1) beat `.toggle` (0-1-0) — but *not*
`.toggle.on` (0-2-0). Result: an **OFF** switch showed the full bright accent
gradient while an **ON** switch showed the faint translucent one. On and off were
visually inverted, and every switch carried the primary-button glow shadow
(verified in the jsdom cascade). The same leak hit the settings ✕ close button,
the memory modal's ＋Add buttons, and "Delete all saved memory" — all rendered as
white-on-gradient pills instead of ghost/subtle styles.

**Fix:** the blanket rule is now
`.settings-card :where(button:not(.toggle):not(.icon-btn):not(.memory-add-btn):not(.memory-link-danger))`.
`:where()` keeps its specificity at 0-1-0 so the utility classes always win;
plain buttons (Done, Save, toolbars) keep the gradient. Empirically verified:
switches/ghosts/links no longer inherit the shadow; the primary Done button
still does.

More of what changed:

- **Font-size slider** was styled like a text field (13px padding, border, box
  background). `input[type="range"]` now gets a clean slider treatment
  (`accent-color`, no box) plus a live `98%` readout.
- **Every switch** is a real ARIA switch (`role="switch"`, `aria-checked`,
  label) and all 8 state changes go through one helper (`setToggleState`), so
  the visual class and the ARIA state cannot drift.
- **`openSettings()` re-syncs everything** (`syncSettingsUI`) — before, it just
  showed the modal, so any state changed with the dialog closed (reset, account
  switch) left the controls lying. The Settings nav tab now shows active while
  its dialog is open, and clicking the backdrop closes the dialog (parity with
  Escape).
- **`resetAllSettings()` actually resets.** It now re-syncs the slider and its
  readout, re-applies compact spacing vars (`--chat-gap` stayed compact while
  the switch showed off), and clears the legacy unscoped `animations` key. The
  boot-time legacy reads of unscoped `responseLength` / `animations` are gone —
  the user-scoped `memoryKey(...)` copies are the single source of truth,
  synced by `loadPersonalAISettings()`.
- **History list & Library PDF list are a class system now.** Rows were 100%
  inline `style.cssText` strings: no hover states possible, and the white-alpha
  fills/borders vanished in the light theme. Now `.history-item[+:hover/.active]`,
  `.history-title`, `.history-actions`, `.history-pill`, `.history-empty` and
  `.pdf-item*`, all with light-theme variants. Row actions hide until
  hover/focus on precise pointers and stay visible on touch. Delete actions are
  marked `.danger`. Sidebar chrome (brand, New Chat, profile, logout) moved from
  inline styles to classes for the same light-theme reason.
- **Deleting the open chat** now continues in the *most recently active* chat,
  not the first key in insertion order.
- Conversation-context empty state no longer calls itself "saved memories".

Tests: 137 passed / 0 failed (was 105), including new coverage for the button
rule exclusions, ARIA switches, openSettings re-sync, reset re-sync, and the
class-based empty/history rendering.
