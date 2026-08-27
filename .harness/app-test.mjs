// End-to-end harness for index.html.
//
// It loads the REAL page (the unmodified inline app script from index.html) in
// jsdom and drives it. Only third-party pieces are replaced:
//   • the @supabase/supabase-js CDN bundle → in-memory stub (supabase-stub.js)
//   • window.fetch → a programmable stand-in for the Groq proxy Worker
//   • alert/confirm/prompt, clipboard, createObjectURL, matchMedia
// Everything else — sendMessage(), settings, memory, PDF history, status chip —
// is the shipped code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const RAW_HTML = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
const SUPABASE_STUB = fs.readFileSync(path.join(here, 'supabase-stub.js'), 'utf8');
const SUPABASE_TAG = '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>';
if (!RAW_HTML.includes(SUPABASE_TAG)) throw new Error('supabase CDN tag not found in index.html');
const PAGE_HTML = RAW_HTML.replace(SUPABASE_TAG, `<script>${SUPABASE_STUB}</script>`);

const PROXY = 'https://groq-proxy.mr-hackerdon808.workers.dev/api/chat';

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`  \u2717 ${name}${detail ? ' :: ' + detail : ''}`); }
}
function section(title) { console.log(`\n\u2500\u2500 ${title}`); }
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function settle(win, ms = 120) { await tick(ms); await win.Promise.resolve(); await tick(10); }

// ---------------------------------------------------------------- boot a page
function makeDb(session = null) {
  return {
    tables: { chats: [], pdf_files: [], profiles: [{ id: 'user-1', username: 'tester' }] },
    session,
    password: 'secret123',
    userId: 'user-1',
    listeners: [],
    idSeq: 100
  };
}

async function bootPage({ db, storage = {}, proxy } = {}) {
  const state = {
    db: db || makeDb(),
    calls: [],            // every fetch made by the app
    scripts: [],          // every lazy <script> the app requested
    proxy: proxy || (() => ({ ok: true, status: 200, body: { choices: [{ message: { role: 'assistant', content: 'Hello! I am Your Friend.' } }] } })),
    alerts: [],
    prompts: [],
    confirms: [],
    promptAnswer: 'test',
    confirmAnswer: true,
    downloads: []
  };

  const vc = new VirtualConsole();
  const consoleErrors = [];
  vc.on('jsdomError', () => {});
  vc.on('error', (...args) => consoleErrors.push(args.map(String).join(' ')));
  state.consoleErrors = consoleErrors;

  const dom = new JSDOM(PAGE_HTML, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://ayushghbk-afk.github.io/ai/',
    virtualConsole: vc,
    beforeParse(window) {
      window.__db = state.db;
      Object.entries(storage).forEach(([k, v]) => window.localStorage.setItem(k, v));

      window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
      window.alert = (m) => state.alerts.push(String(m));
      window.confirm = (m) => { state.confirms.push(String(m)); return state.confirmAnswer; };
      window.prompt = (m, def) => { state.prompts.push(String(m)); return state.promptAnswer; };
      window.open = (u) => { state.downloads.push(u); return null; };
      window.URL.createObjectURL = () => 'blob:mock';
      window.URL.revokeObjectURL = () => {};
      Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
      window.HTMLCanvasElement.prototype.getContext = () => null;
      window.scrollTo = () => {};
      window.Element.prototype.scrollIntoView = () => {};

      // Intercept lazily injected <script src> tags (jsPDF / highlight.js).
      const realAppend = window.Node.prototype.appendChild;
      window.Node.prototype.appendChild = function (node) {
        if (node && node.tagName === 'SCRIPT' && node.src) {
          state.scripts.push(node.src);
          if (node.src.includes('jspdf')) {
            // jsPDF is never downloaded here; provide a no-op stand-in with the
            // few real surfaces the app reads, so the PDF path still executes.
            class JsPDFStub {
              constructor() {
                this.internal = { pageSize: { getWidth: () => 210, getHeight: () => 297 }, getNumberOfPages: () => 1 };
              }
              splitTextToSize(text) { return String(text).split('\n'); }
              output(type) {
                return type === 'blob'
                  ? new window.Blob(['%PDF-1.3 mock'], { type: 'application/pdf' })
                  : '%PDF-1.3 mock';
              }
            }
            const noop = () => {};
            window.jspdf = {
              jsPDF: new Proxy(JsPDFStub, {
                construct(Target, args) {
                  const inst = new Target(...args);
                  return new Proxy(inst, { get: (obj, key) => (key in obj ? obj[key] : noop) });
                }
              })
            };
          }
          if (node.src.includes('highlight')) {
            window.hljs = { getLanguage: () => true, highlight: (code) => ({ value: String(code).replace(/</g, '&lt;') }) };
          }
          if (node.onload) setTimeout(node.onload, 0);
          return node;
        }
        return realAppend.call(this, node);
      };

      window.fetch = async (url, opts = {}) => {
        const href = String(url);
        let body = null;
        try { body = opts.body ? JSON.parse(opts.body) : null; } catch { body = opts.body; }
        const record = { url: href, method: (opts.method || 'GET').toUpperCase(), body, signal: opts.signal };
        state.calls.push(record);

        // jsdom has no Response class; hand back a Response-shaped object.
        const respond = (status, payload) => {
          const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
          return {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: () => 'application/json' },
            text: async () => text,
            json: async () => JSON.parse(text),
            blob: async () => new window.Blob([text])
          };
        };

        if (href.startsWith(PROXY) && record.method === 'GET') {
          if (state.failHealth) { const e = new Error('Failed to fetch'); e.name = 'TypeError'; throw e; }
          return respond(200, { ok: true, service: 'groq-proxy', status: 'online', configured_keys: 4 });
        }
        if (href.startsWith(PROXY)) {
          if (opts.signal) {
            await new Promise((resolve, reject) => {
              const t = setTimeout(resolve, state.proxyDelay || 5);
              if (opts.signal.aborted) { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }
              opts.signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
            });
          }
          const result = typeof state.proxy === 'function' ? state.proxy(record) : state.proxy;
          if (result.throw) { const err = new Error('Failed to fetch'); err.name = 'TypeError'; throw err; }
          return respond(result.status ?? 200, result.body);
        }
        return respond(200, {});
      };
    }
  });

  await new Promise((resolve) => {
    if (dom.window.document.readyState === 'complete') return resolve();
    dom.window.addEventListener('load', resolve);
  });
  await settle(dom.window, 150);
  state.win = dom.window;
  state.doc = dom.window.document;
  state.dom = dom;
  return state;
}

function snapshotStorage(state) {
  const out = {};
  const ls = state.win.localStorage;
  for (let i = 0; i < ls.length; i++) { const k = ls.key(i); out[k] = ls.getItem(k); }
  return out;
}

async function login(state) {
  state.win.document.getElementById('email').value = 'tester@example.com';
  state.win.document.getElementById('password').value = 'secret123';
  await state.win.handleAuth();
  await settle(state.win, 200);
}

async function send(state, text) {
  state.win.document.getElementById('userInput').value = text;
  const p = state.win.sendMessage();
  return p;
}

// =============================================================== 1. LAZY LOAD
section('1. Heavy libraries are lazy-loaded (item 11)');
{
  const s = await bootPage();
  check('no jsPDF download on first paint', !s.scripts.some((u) => u.includes('jspdf')), s.scripts.join(','));
  check('no highlight.js download on first paint', !s.scripts.some((u) => u.includes('highlight')), s.scripts.join(','));
  check('page booted (sidebar + input present)', !!s.doc.getElementById('userInput') && !!s.doc.getElementById('historyList'));
  s.dom.window.close();
}

// ================================================== 2. AI STATUS + HEALTH (5)
section('2. AI status indicator + health probe (item 5)');
{
  const s = await bootPage();
  await settle(s.win, 200);
  const chip = s.doc.getElementById('aiStatusChip');
  const text = s.doc.getElementById('aiStatusText').textContent;
  check('health probe called the proxy with GET', s.calls.some((c) => c.url.startsWith(PROXY) && c.method === 'GET'));
  check(`chip reports online + model (got "${text}")`, /AI Online/.test(text) && /Llama 3\.3 70B/.test(text), text);
  check('chip data-state is online', chip.dataset.state === 'online', chip.dataset.state);
  const sub = s.doc.getElementById('aiStatusSubline').textContent;
  check(`settings panel shows provider count ("${sub}")`, /4 provider keys configured/.test(sub), sub);
  s.dom.window.close();
}

section('2b. Health probe failure must not break chat (graceful degradation)');
{
  const db = makeDb();
  const s = await bootPage({ db });
  s.failHealth = true;                 // e.g. CORS-blocked / cold Worker
  await s.win.checkAiHealth(true);
  await settle(s.win, 60);
  const chip = s.doc.getElementById('aiStatusChip');
  check('probe failure does not claim "online"', chip.dataset.state !== 'online', chip.dataset.state);
  check('probe failure still names the model', /Llama 3\.3 70B/.test(s.doc.getElementById('aiStatusText').textContent), s.doc.getElementById('aiStatusText').textContent);
  await login(s);
  await send(s, 'Still working?');
  await settle(s.win, 200);
  check('chat still works after a failed probe', s.doc.getElementById('chat-container').textContent.includes('Hello! I am Your Friend.'));
  check('chip recovers to online after a real reply', s.doc.getElementById('aiStatusChip').dataset.state === 'online', s.doc.getElementById('aiStatusChip').dataset.state);
  s.dom.window.close();
}

// ================================================ 3. HIDDEN STATES (item 3)
section('3. Loading / editing states stay hidden until active (item 3)');
{
  const s = await bootPage();
  const bar = s.doc.getElementById('generationStatus');
  const badge = s.doc.getElementById('editingBadge');
  check('generation bar hidden on load', bar.hidden === true);
  check('cancel button disabled on load', s.doc.getElementById('cancelGenerationBtn').disabled === true);
  check('editing badge not shown on load', !badge.classList.contains('show'));
  check('welcome screen visible on load', s.doc.getElementById('welcome-screen').hidden === false);
  s.dom.window.close();
}

// ============================================ 4. AUTH + LOGIN PERSISTENCE (6)
section('4. Auth, validation and login persistence (items 6 & 7)');
{
  const s = await bootPage();
  await login(s);
  check('logged in (welcome hidden)', s.doc.getElementById('welcome-screen').hidden === true);
  // jsdom does not implement innerText (the app assigns it), so read the
  // debug hook instead of the rendered text.
  check('username loaded from profile', s.win.__appDebug().currentUser === 'tester', String(s.win.__appDebug().currentUser));

  // wrong password
  const bad = await bootPage();
  bad.win.document.getElementById('email').value = 'tester@example.com';
  bad.win.document.getElementById('password').value = 'wrong-pass';
  await bad.win.handleAuth();
  await settle(bad.win, 120);
  check('wrong password is rejected with a message', bad.alerts.some((a) => /Invalid login credentials/i.test(a)), JSON.stringify(bad.alerts));
  bad.dom.window.close();

  // change settings, then "refresh"
  const st = s.win;
  st.document.getElementById('modelSelect').value = 'openai/gpt-oss-120b';
  st.document.getElementById('modelSelect').dispatchEvent(new st.Event('change'));
  st.setResponseLength(6144);
  st.togglePrivacyMode();
  st.toggleAnimations();
  st.toggleMemory();
  st.togglePdfPreview();
  st.setTheme('light');
  st.setChatFontSize(1.2);
  st.toggleCompactMode();
  st.toggleSound();
  st.toggleAutoScroll();
  st.toggleEnterToSend();
  await settle(st, 80);

  const saved = snapshotStorage(s);
  const s2 = await bootPage({ db: s.db, storage: saved });
  await settle(s2.win, 200);
  const d = s2.doc;
  check('after refresh: AI model select restored', d.getElementById('modelSelect').value === 'openai/gpt-oss-120b', d.getElementById('modelSelect').value);
  check('after refresh: response length restored', d.getElementById('responseLengthSelect').value === '6144', d.getElementById('responseLengthSelect').value);
  check('after refresh: privacy mode toggle restored', d.getElementById('privacyToggle').classList.contains('on'));
  check('after refresh: animations toggle restored (off)', !d.getElementById('animationToggle').classList.contains('on'));
  check('after refresh: memory toggle restored (off)', !d.getElementById('memoryToggle').classList.contains('on'));
  check('after refresh: pdf preview toggle restored (off)', !d.getElementById('pdfPreviewToggle').classList.contains('on'));
  check('after refresh: theme restored', d.documentElement.dataset.theme === 'light', d.documentElement.dataset.theme);
  check('after refresh: font size restored', d.getElementById('fontSizeRange').value === '1.2', d.getElementById('fontSizeRange').value);
  check('after refresh: compact mode restored', d.getElementById('compactToggle').classList.contains('on'));
  check('after refresh: sound toggle restored', d.getElementById('soundToggle').classList.contains('on'));
  check('after refresh: auto-scroll toggle restored (off)', !d.getElementById('autoScrollToggle').classList.contains('on'));
  check('after refresh: enter-to-send toggle restored (off)', !d.getElementById('enterSendToggle').classList.contains('on'));
  check('after refresh: status chip shows the saved model', /GPT OSS 120B/.test(d.getElementById('aiStatusText').textContent), d.getElementById('aiStatusText').textContent);
  s2.dom.window.close();
  s.dom.window.close();
}

// ============================================== 5. CHAT LIFECYCLE (items 2/10)
section('5. Chat lifecycle: send, count, refresh, search, delete, duplicates');
{
  const db = makeDb();
  const s = await bootPage({ db });
  await login(s);
  await send(s, 'Hi');
  await settle(s.win, 150);
  const bubbles = s.doc.querySelectorAll('#chat-container .message-row, #chat-container .message');
  const bodyText = s.doc.getElementById('chat-container').textContent;
  check('user message rendered', bodyText.includes('Hi'));
  check('assistant reply rendered', bodyText.includes('Hello! I am Your Friend.'), bodyText.slice(0, 120));
  check('request carried the chosen model', s.calls.filter((c) => c.method === 'POST').at(-1).body.model === 'llama-3.3-70b-versatile');
  check('message persisted to DB', db.tables.chats.some((r) => r.role === 'assistant'));
  check(`chat counter shows 1 chat (got "${s.doc.getElementById('historyCount').textContent}")`, s.doc.getElementById('historyCount').textContent === '1/1', s.doc.getElementById('historyCount').textContent);
  check('generation bar hidden again after reply', s.doc.getElementById('generationStatus').hidden === true);
  check('status chip back to online', s.doc.getElementById('aiStatusChip').dataset.state === 'online');

  // refresh keeps the chat
  const saved = snapshotStorage(s);
  const s2 = await bootPage({ db, storage: saved });
  await settle(s2.win, 250);
  check(`chat survives refresh (counter "${s2.doc.getElementById('historyCount').textContent}")`, s2.doc.getElementById('historyCount').textContent === '1/1', s2.doc.getElementById('historyCount').textContent);
  check('history survived refresh with its messages', s2.doc.getElementById('chat-container').textContent.includes('Hello! I am Your Friend.'));

  // search
  s2.doc.getElementById('historySearch').value = 'zzzz-no-match';
  s2.doc.getElementById('historySearch').dispatchEvent(new s2.win.Event('input'));
  await settle(s2.win, 30);
  check(`search filters chats (counter "${s2.doc.getElementById('historyCount').textContent}")`, s2.doc.getElementById('historyCount').textContent === '0/1', s2.doc.getElementById('historyCount').textContent);
  check('search shows an empty-state message', /No chats match your search/.test(s2.doc.getElementById('historyList').textContent));
  s2.doc.getElementById('historySearch').value = '';
  s2.doc.getElementById('historySearch').dispatchEvent(new s2.win.Event('input'));
  await settle(s2.win, 30);

  // duplicate "New Chat" guard
  const before = Object.keys(s2.win.__appDebug().userSessions || {}).length;
  s2.win.createNewChat();
  s2.win.createNewChat();
  await settle(s2.win, 40);
  const after = Object.keys(s2.win.__appDebug().userSessions).length;
  check(`two "New Chat" clicks add only one chat (${before} -> ${after})`, after === before + 1, `${before} -> ${after}`);

  // delete is permanent
  const sessions2 = s2.win.__appDebug().userSessions;
  const target = Object.keys(sessions2).find((id) => (sessions2[id].messages || []).some((m) => m.role === 'assistant'));
  await s2.win.deleteChat(target);
  await settle(s2.win, 80);
  check('delete asked for confirmation', s2.confirms.some((c) => /Delete/.test(c)), JSON.stringify(s2.confirms));
  check('chat removed from DB', !db.tables.chats.some((r) => r.session_id === target));
  const s3 = await bootPage({ db, storage: snapshotStorage(s2) });
  await settle(s3.win, 200);
  check(`deleted chat stays gone after refresh (rows=${db.tables.chats.length})`, !db.tables.chats.some((r) => r.session_id === target));
  s3.dom.window.close();
  s2.dom.window.close();
  s.dom.window.close();
}

// ================================================ 6. LONG + RAPID MESSAGES (1)
section('6. Long message, rapid sends, model switch, cancellation (item 1)');
{
  const db = makeDb();
  const seen = [];
  const s = await bootPage({ db, proxy: (rec) => { seen.push(rec.body); return { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } }; } });
  await login(s);

  const long = 'A very long question. '.repeat(12000); // ~264k characters
  await send(s, long);
  await settle(s.win, 200);
  const lastSent = seen.at(-1);
  const lastMsg = lastSent.messages.at(-1).content;
  const totalChars = lastSent.messages.reduce((n, m) => n + String(m.content || '').length, 0);
  check(`long message trimmed before sending (${lastMsg.length} chars)`, lastMsg.length <= 8200, String(lastMsg.length));
  check(`whole request fits the context budget (${totalChars} chars)`, totalChars < 96000, String(totalChars));
  check('system prompt still present', lastSent.messages[0].role === 'system' && lastSent.messages[0].content.includes('Your Friend'));
  check('tools still attached', Array.isArray(lastSent.tools) && lastSent.tools.length === 2);

  // many history turns get trimmed oldest-first
  for (let i = 0; i < 40; i++) {
    db.tables.chats.push({ id: 5000 + i, session_id: s.win.__appDebug().currentSessionId, user_id: 'user-1', role: i % 2 ? 'assistant' : 'user', message: 'Filler turn '.repeat(200), created_at: new Date(Date.now() + i).toISOString() });
  }
  await s.win.loadSessionMessagesFromSupabase(s.win.__appDebug().currentSessionId);
  await send(s, 'Now with a long history');
  await settle(s.win, 200);
  const trimmed = seen.at(-1);
  const historyChars = trimmed.messages.reduce((n, m) => n + String(m.content || '').length, 0);
  check(`long history trimmed too (${trimmed.messages.length} msgs, ${historyChars} chars)`, historyChars < 96000, String(historyChars));

  // model switch reaches the request
  s.win.document.getElementById('modelSelect').value = 'llama-3.1-8b-instant';
  s.win.document.getElementById('modelSelect').dispatchEvent(new s.win.Event('change'));
  await send(s, 'Which model are you?');
  await settle(s.win, 150);
  check('model switch reaches the request body', seen.at(-1).model === 'llama-3.1-8b-instant', seen.at(-1).model);
  check('status chip follows the model', /Llama 3\.1 8B/.test(s.doc.getElementById('aiStatusText').textContent), s.doc.getElementById('aiStatusText').textContent);

  // rapid duplicate sends
  const before = seen.length;
  s.win.document.getElementById('userInput').value = 'burst';
  s.win.sendMessage();
  s.win.sendMessage();
  s.win.sendMessage();
  await settle(s.win, 200);
  check(`3 rapid sends = 1 request (${seen.length - before})`, seen.length - before === 1, String(seen.length - before));

  // cancellation
  s.proxyDelay = 250;
  const pending = send(s, 'slow one');
  await tick(30);
  s.win.cancelGeneration();
  await pending;
  await settle(s.win, 60);
  check('cancel stops the request', s.doc.getElementById('chat-container').textContent.includes('Generation canceled'), s.doc.getElementById('chat-container').textContent.slice(-160));
  check('generation bar hidden after cancel', s.doc.getElementById('generationStatus').hidden === true);
  s.dom.window.close();
}

// ============================================ 7. FAILURE MODES + FRIENDLY TEXT
section('7. Provider failures produce friendly errors, never API details');
const SECRET = 'gsk_LIVE_KEY_DO_NOT_LEAK_abc123';
async function failureCase({ status, body, label, expectKind }) {
  const db = makeDb();
  const s = await bootPage({ db, proxy: () => ({ status, body }) });
  await login(s);
  await send(s, 'Hi there');
  await settle(s.win, 150);
  const chatText = s.doc.getElementById('chat-container').textContent;
  const chip = s.doc.getElementById('aiStatusChip');
  check(`${label}: raw provider text hidden from UI`, !chatText.includes(SECRET) && !/gsk_|HTTP \d{3}|groq/i.test(chatText), chatText.slice(-200));
  check(`${label}: retry button offered`, !!s.doc.querySelector('.retry-btn'));
  check(`${label}: chip state = ${expectKind} (got ${chip.dataset.state})`, chip.dataset.state === expectKind, chip.dataset.state);
  check(`${label}: chip text is user-facing`, /AI (busy|offline|·)/.test(s.doc.getElementById('aiStatusText').textContent), s.doc.getElementById('aiStatusText').textContent);
  check(`${label}: technical detail logged to console`, s.consoleErrors.some((e) => /\[AI proxy\]/.test(e)));
  s.dom.window.close();
  return chatText;
}
{
  const rateLimited = await failureCase({
    status: 429,
    body: { error: { message: `Rate limit reached for key ${SECRET}` } },
    label: '429 rate limit',
    expectKind: 'busy'
  });
  check('429: message says AI temporarily busy', /AI temporarily busy/i.test(rateLimited), rateLimited.slice(-160));

  const allKeys = await failureCase({
    status: 503,
    body: { error: { message: `All API keys are unavailable (${SECRET})` } },
    label: '503 all keys down',
    expectKind: 'busy'
  });
  check('all-keys-down: message points at providers', /provider|minute/i.test(allKeys), allKeys.slice(-180));

  const badPayload = await failureCase({
    status: 400,
    body: { error: { message: `Please reduce the length of the messages or completion. key=${SECRET}` } },
    label: '400 too long',
    expectKind: 'unknown'
  });
  check('400 too-long: suggests a new chat / shorter message', /too long|new chat|shorter/i.test(badPayload), badPayload.slice(-180));

  const serverErr = await failureCase({
    status: 500,
    body: `<html>Internal Server Error trace ${SECRET}</html>`,
    label: '500 html body',
    expectKind: 'busy'
  });
  check('500: friendly retry message', /temporary problem|try again/i.test(serverErr), serverErr.slice(-180));

  // network down
  const db = makeDb();
  const s = await bootPage({ db, proxy: () => ({ throw: true }) });
  await login(s);
  await send(s, 'Hi');
  await settle(s.win, 150);
  const txt = s.doc.getElementById('chat-container').textContent;
  check('network failure: no stack trace in UI', !/TypeError|Failed to fetch|stack/i.test(txt), txt.slice(-160));
  check('network failure: retry button offered', !!s.doc.querySelector('.retry-btn'));
  check('network failure: chip not "online"', s.doc.getElementById('aiStatusChip').dataset.state !== 'online', s.doc.getElementById('aiStatusChip').dataset.state);

  // retry actually re-sends and recovers
  s.proxy = () => ({ status: 200, body: { choices: [{ message: { role: 'assistant', content: 'Back online!' } }] } });
  const retryBtn = s.doc.querySelector('.retry-btn');
  retryBtn.click();
  await settle(s.win, 200);
  check('retry re-sends and recovers', s.doc.getElementById('chat-container').textContent.includes('Back online!'), s.doc.getElementById('chat-container').textContent.slice(-160));
  check('retry leaves chip online', s.doc.getElementById('aiStatusChip').dataset.state === 'online', s.doc.getElementById('aiStatusChip').dataset.state);
  const dbg = s.win.__appDebug();
  const dupeTurns = dbg.userSessions[dbg.currentSessionId].messages.filter((m) => m.role === 'user' && m.content === 'Hi').length;
  check(`retry does not duplicate the user turn (${dupeTurns})`, dupeTurns === 1, String(dupeTurns));
  s.dom.window.close();
}

// ======================================================= 8. MEMORY (item 8)
section('8. Memory: duplicates, limits, privacy mode, "what the AI receives"');
{
  const db = makeDb();
  const seen = [];
  const s = await bootPage({ db, proxy: (rec) => { seen.push(rec.body); return { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } }; } });
  await login(s);

  s.promptAnswer = 'I prefer dark mode and short answers';
  s.win.addMemoryItem();
  s.win.addMemoryItem();
  await settle(s.win, 50);
  const items = s.doc.querySelectorAll('#memoryList .memory-item');
  check(`duplicate memory added twice -> stored once (${items.length})`, items.length === 1, String(items.length));
  check('duplicate explained to the user', s.alerts.some((a) => /already saved/i.test(a)), JSON.stringify(s.alerts));
  check('memory rows have Edit + Delete buttons', items[0] && items[0].querySelectorAll('button').length === 2);

  // limit
  s.alerts.length = 0;
  for (let i = 0; i < 60; i++) { s.promptAnswer = `Memory number ${i}`; s.win.addMemoryItem(); }
  await settle(s.win, 60);
  const capped = s.doc.querySelectorAll('#memoryList .memory-item').length;
  check(`memory list capped at 40 (got ${capped})`, capped === 40, String(capped));
  check('limit explained to the user', s.alerts.some((a) => /limit of 40/i.test(a)), JSON.stringify(s.alerts.slice(-1)));

  // preview
  s.win.openMemoryEditor();
  s.win.showAiPayloadPreview();
  await settle(s.win, 30);
  const preview = s.doc.getElementById('aiPayloadPreview');
  check('preview panel visible on demand', preview.hidden === false);
  check('preview states memory IS included', /memory IS included/i.test(preview.textContent), preview.textContent.slice(0, 160));
  check('preview shows the model + token estimate', /Model: Llama 3\.3 70B/.test(preview.textContent) && /tokens/.test(preview.textContent));
  check('preview contains the real system prompt', preview.textContent.includes('LONG-TERM MEMORY') && preview.textContent.includes('RELEVANT LONG-TERM MEMORY CONTEXT'));

  // privacy mode must exclude memory from the request
  s.win.togglePrivacyMode();
  await send(s, 'Do you remember my preferences?');
  await settle(s.win, 150);
  const sys = seen.at(-1).messages[0].content;
  check('privacy mode: memory excluded from the request', !sys.includes('RELEVANT LONG-TERM MEMORY CONTEXT'), sys.slice(-200));
  s.win.showAiPayloadPreview();
  check('preview reflects privacy mode', /memory is NOT sent/i.test(s.doc.getElementById('aiPayloadPreview').textContent), s.doc.getElementById('aiPayloadPreview').textContent.slice(0, 160));

  s.win.togglePrivacyMode();
  await send(s, 'And now?');
  await settle(s.win, 150);
  check('privacy off: memory included again', seen.at(-1).messages[0].content.includes('RELEVANT LONG-TERM MEMORY CONTEXT'));
  s.dom.window.close();
}

// ===================================================== 9. PDF MANAGEMENT (9)
section('9. PDF backups: size, date, duplicates, rename, search, delete');
{
  const db = makeDb();
  db.tables.pdf_files.push(
    { id: 11, user_id: 'user-1', title: 'Roadmap', filename: 'roadmap.pdf', storage_path: 'p/roadmap.pdf', file_size: 24576, created_at: '2026-08-01T10:00:00.000Z' },
    { id: 12, user_id: 'user-1', title: 'Roadmap copy', filename: 'roadmap.pdf', storage_path: 'p/roadmap2.pdf', file_size: 24576, created_at: '2026-08-02T10:00:00.000Z' },
    { id: 13, user_id: 'user-1', title: 'Budget 2026', filename: 'budget.pdf', storage_path: 'p/budget.pdf', file_size: 1572864, created_at: '2026-08-03T10:00:00.000Z' }
  );
  const s = await bootPage({ db });
  await login(s);
  await settle(s.win, 150);
  const list = s.doc.getElementById('pdfBackupList');
  check(`PDF counter shows 3 (got "${s.doc.getElementById('pdfBackupCount').textContent}")`, s.doc.getElementById('pdfBackupCount').textContent === '3');
  check('file size shown (24 KB)', /24(\.0)? KB/.test(list.textContent), list.textContent.replace(/\s+/g, ' ').slice(0, 240));
  check('large size formatted as MB', /1\.5 MB/.test(list.textContent), list.textContent.replace(/\s+/g, ' ').slice(0, 240));
  check('duplicate detected', /duplicate/i.test(list.textContent), list.textContent.replace(/\s+/g, ' ').slice(0, 240));
  check('generation date shown', /2026/.test(list.textContent));
  check('rename button present', list.querySelectorAll('button[title="Rename PDF"]').length === 3);

  const roadmap = s.win.userPdfHistory.find((p) => p.id === 11);
  s.promptAnswer = 'Renamed Roadmap';
  await s.win.renamePdfBackup(roadmap);
  await settle(s.win, 60);
  check('rename persisted to DB', db.tables.pdf_files.find((p) => p.id === 11).title === 'Renamed Roadmap', db.tables.pdf_files.find((p) => p.id === 11).title);
  check('rename visible in list', list.textContent.includes('Renamed Roadmap'));

  s.doc.getElementById('pdfSearchInput').value = 'budget';
  s.doc.getElementById('pdfSearchInput').dispatchEvent(new s.win.Event('input'));
  await settle(s.win, 40);
  check('search filters PDF list', list.textContent.includes('Budget 2026') && !list.textContent.includes('Renamed Roadmap'), list.textContent.replace(/\s+/g, ' ').slice(0, 200));
  s.doc.getElementById('pdfSearchInput').value = '';
  s.doc.getElementById('pdfSearchInput').dispatchEvent(new s.win.Event('input'));
  await settle(s.win, 40);

  await s.win.deletePdfBackup(s.win.userPdfHistory.find((p) => p.id === 13));
  await settle(s.win, 60);
  check('delete asked for confirmation', s.confirms.some((c) => /Delete/.test(c)));
  check('deleted PDF gone from DB', !db.tables.pdf_files.some((p) => p.id === 13));
  check(`deleted PDF gone from list (counter "${s.doc.getElementById('pdfBackupCount').textContent}")`, s.doc.getElementById('pdfBackupCount').textContent === '2');
  s.dom.window.close();
}

// ======================================= 10. PDF PATH TRIGGERS THE LAZY LOADER
section('10. Creating a PDF pulls jsPDF in on demand');
{
  const db = makeDb();
  const s = await bootPage({
    db,
    proxy: () => ({
      status: 200,
      body: {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'create_pdf', arguments: JSON.stringify({ title: 'Test Doc', filename: 'test-doc.pdf', content: '# Test Doc\n\nHello world content.' }) } }]
          }
        }]
      }
    })
  });
  check('jsPDF not loaded before a PDF is requested', !s.scripts.some((u) => u.includes('jspdf')));
  await login(s);
  await send(s, 'Create a PDF about testing');
  await settle(s.win, 400);
  check('jsPDF fetched on demand', s.scripts.some((u) => u.includes('jspdf')), s.scripts.join(','));
  const pdfChat = s.doc.getElementById('chat-container').textContent;
  check('PDF tool ran without throwing', !/could not complete|Something went wrong/i.test(pdfChat), pdfChat.slice(-220) + ' || console: ' + s.consoleErrors.filter((e) => !/\[AI proxy\]/.test(e)).slice(-3).join(' | '));
  s.dom.window.close();
}

// ===================================================== 11. MARKDOWN + CODE UI
section('11. Markdown, code blocks and copy buttons (item 10)');
{
  const db = makeDb();
  const reply = 'Here you go:\n\n```js\nconst a = 1;\nconsole.log(a);\n```\n\n- point one\n- point two';
  const s = await bootPage({ db, proxy: () => ({ status: 200, body: { choices: [{ message: { role: 'assistant', content: reply } }] } }) });
  await login(s);
  await send(s, 'Show me code');
  await settle(s.win, 250);
  const chat = s.doc.getElementById('chat-container');
  check('code block rendered', !!chat.querySelector('.code-block pre code'), chat.textContent.slice(0, 120));
  check('copy + download buttons on the code block', chat.querySelectorAll('.code-block .code-copy-btn').length >= 2);
  check('markdown list rendered', /point one/.test(chat.textContent) && !!chat.querySelector('.markdown-content'));
  check('highlight.js loaded lazily after the code block', s.scripts.some((u) => u.includes('highlight')), s.scripts.join(','));
  check('message action toolbar present (copy/edit/regenerate/delete)', chat.querySelectorAll('.message-action-btn').length >= 4, String(chat.querySelectorAll('.message-action-btn').length));
  s.dom.window.close();
}

// ================================================================ 12. LOGOUT
section('12. Logout clears the workspace');
{
  const db = makeDb();
  db.tables.chats.push({ id: 77, session_id: 'sess-77', user_id: 'user-1', role: 'user', message: 'Old chat', created_at: '2026-08-04T10:00:00.000Z' });
  const s = await bootPage({ db });
  await login(s);
  check('chats loaded while logged in', s.doc.getElementById('historyCount').textContent === '1/1', s.doc.getElementById('historyCount').textContent);
  await s.win.logout();
  await settle(s.win, 120);
  check('session cleared', db.session === null);
  check('welcome screen back after logout', s.doc.getElementById('welcome-screen').hidden === false);
  check('chat list cleared after logout', s.doc.getElementById('historyList').children.length === 0);
  s.dom.window.close();
}

// =================================================================== summary
console.log(`\n${'='.repeat(60)}\nPASSED ${passed}   FAILED ${failed}`);
if (failed) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
