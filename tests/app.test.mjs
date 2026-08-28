import { JSDOM } from 'jsdom';
import fs from 'fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://localhost/',
  beforeParse(window) {
    // External CDN scripts are not loaded by jsdom; stub what the app touches.
    const fakeAuth = {
      getSession: async () => ({ data: { session: null } }),
      getUser: async () => ({ data: { user: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signInWithPassword: async () => ({ data: {}, error: new Error('stub') }),
      signUp: async () => ({ data: {}, error: new Error('stub') }),
      signOut: async () => ({ error: null })
    };
    const fakeFrom = () => {
      const chain = {
        select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
        single: async () => ({ data: null, error: null }),
        insert: () => chain, update: () => chain, upsert: () => chain, delete: () => chain,
        then: (res) => res({ data: [], error: null })
      };
      return chain;
    };
    window.supabase = { createClient: () => ({ auth: fakeAuth, from: fakeFrom }) };
    window.hljs = { highlightElement() {}, highlight: (c) => ({ value: c }), listLanguages: () => [] };
    window.HTMLCanvasElement.prototype.getContext = () => null;
    const origError = window.console.error;
    window.console.error = (...a) => { /* keep test output clean */ };
    window.__origError = origError;
    window.alert = () => {};
    window.confirm = () => true;
    window.prompt = () => null;
    window.Element.prototype.scrollIntoView = function () {};
    window.AudioContext = undefined;
    window.webkitAudioContext = undefined;
  }
});

const w = dom.window;
w.onerror = () => {};

// Let inline scripts finish.
await new Promise(r => setTimeout(r, 400));

const ev = (code) => w.eval(code);

console.log('\n== app booted ==');
ok('getSavedMemories is defined on the page', typeof w.getSavedMemories === 'function');
ok('addSavedMemoryItem is defined on the page', typeof w.addSavedMemoryItem === 'function');
ok('openPdfHistory is defined on the page', typeof w.openPdfHistory === 'function');
ok('savedMemoryList element exists', !!w.document.getElementById('savedMemoryList'));
ok('settingsAdvanced <details> exists', !!w.document.getElementById('settingsAdvanced'));
ok('settingsDanger <details> exists', !!w.document.getElementById('settingsDanger'));

console.log('\n== Saved Memory persists per user (the new killer feature) ==');
ev(`currentUserId = 'user-a';`);
ev(`savedMemoryItems = null; savedMemoryCacheKey = null;`);
w.localStorage.clear();
ev(`writeSavedMemories(['Lives in Pune', 'Works as a designer']);`);

ok('getSavedMemories returns 2 items', ev(`getSavedMemories().length`) === 2,
   JSON.stringify(ev(`getSavedMemories()`)));
ok('persisted to localStorage under user key',
   JSON.parse(w.localStorage.getItem('yf_saved_memories_user-a') || '[]').length === 2,
   w.localStorage.getItem('yf_saved_memories_user-a'));
ok('context block formats as bullet list',
   ev(`getSavedMemoryContext()`) === '- Lives in Pune\n- Works as a designer',
   JSON.stringify(ev(`getSavedMemoryContext()`)));

console.log('\n== Saved Memory survives a "new chat" (per-chat context does not) ==');
ev(`setMemorySummaryForSession('chat-1', '- talked about a roadmap');`);
const chat1 = ev(`getMemorySummaryForSession('chat-1')`);
const chat2 = ev(`getMemorySummaryForSession('chat-2')`);
ok('conversation context is per-chat (chat-1 has it)', chat1 === '- talked about a roadmap', chat1);
ok('conversation context resets for a new chat (chat-2 empty)', chat2 === '', JSON.stringify(chat2));
ok('saved memory is UNCHANGED by the new chat', ev(`getSavedMemories().length`) === 2);

console.log('\n== User isolation / no stale cache on account switch ==');
ev(`currentUserId = 'user-b';`);
ok('different user sees no memories', ev(`getSavedMemories().length`) === 0,
   JSON.stringify(ev(`getSavedMemories()`)));
ok('different user gets empty context', ev(`getSavedMemoryContext()`) === '');
ev(`currentUserId = 'user-a';`);
ok('switching back restores user-a memories', ev(`getSavedMemories().length`) === 2);

console.log('\n== Dedupe, cap, delete ==');
ev(`writeSavedMemories(['Alpha','alpha','ALPHA','Beta']);`);
ok('case-insensitive dedupe keeps 2', ev(`getSavedMemories().length`) === 2,
   JSON.stringify(ev(`getSavedMemories()`)));
ev(`writeSavedMemories(Array.from({length: 60}, (_, i) => 'item ' + i));`);
ok('caps at MAX_SAVED_MEMORIES (50)', ev(`getSavedMemories().length`) === 50,
   String(ev(`getSavedMemories().length`)));
ev(`deleteSavedMemoryItem(0)`);
ok('delete removes an item', ev(`getSavedMemories().length`) === 49);

console.log('\n== Privacy mode / memory toggle gate the context ==');
ev(`writeSavedMemories(['Lives in Pune']);`);
ok('normal mode sends memory', ev(`getSavedMemoryContext()`) === '- Lives in Pune');
ev(`settings.privacyMode = true;`);
ok('privacy mode suppresses saved memory', ev(`getSavedMemoryContext()`) === '',
   JSON.stringify(ev(`getSavedMemoryContext()`)));
ev(`settings.privacyMode = false; settings.memoryEnabled = false;`);
ok('memory off suppresses saved memory', ev(`getSavedMemoryContext()`) === '');
ev(`settings.memoryEnabled = true;`);

console.log('\n== Exact context sent to the AI (preview mirrors sendMessage) ==');
ev(`currentSessionId = 'chat-1'; memorySummary = '- talked about a roadmap';`);
const preview = ev(`buildMemoryContextPreviewText()`);
ok('preview includes SAVED MEMORY block', preview.includes('SAVED MEMORY (saved by the user, applies to every chat)'),
   preview.slice(0, 200));
ok('preview includes THIS CHAT ONLY block', preview.includes('THIS CHAT ONLY - CONVERSATION CONTEXT'));
ok('saved memory appears before chat context',
   preview.indexOf('SAVED MEMORY') < preview.indexOf('THIS CHAT ONLY'));
ev(`settings.privacyMode = true;`);
const previewPrivate = ev(`buildMemoryContextPreviewText()`);
ok('privacy mode removes BOTH memory blocks from the payload',
   !previewPrivate.includes('SAVED MEMORY') && !previewPrivate.includes('THIS CHAT ONLY'),
   previewPrivate.slice(0, 160));
ev(`settings.privacyMode = false;`);

console.log('\n== Memory modal renders both sections ==');
ev(`currentUserId = 'user-a';`);
ev(`openMemoryEditor()`);
ok('saved list rendered into #savedMemoryList',
   w.document.getElementById('savedMemoryList').children.length === 1,
   String(w.document.getElementById('savedMemoryList').children.length));
ok('saved counter shows "1 / 50 saved"',
   w.document.getElementById('savedMemoryCount').textContent === '1 / 50 saved',
   w.document.getElementById('savedMemoryCount').textContent);
ok('modal is visible', w.document.getElementById('memory-modal').style.display === 'flex');
ev(`closeMemoryEditor()`);

console.log('\n== Image quota guardrails ==');
w.localStorage.removeItem('yf_img_quota_user-a');
ok('first request allowed', ev(`checkImageQuota(2).ok`) === true);
ev(`consumeImageQuota(2)`);
ok('immediate second request blocked by cooldown', ev(`checkImageQuota(1).ok`) === false);
ok('cooldown message mentions seconds', /wait \d+s/.test(ev(`checkImageQuota(1).reason`)),
   ev(`checkImageQuota(1).reason`));
w.localStorage.setItem('yf_img_quota_user-a', JSON.stringify({ date: new Date().toISOString().slice(0,10), used: 40, lastMs: 0 }));
ok('daily limit blocks at 40 used', ev(`checkImageQuota(1).ok`) === false);
ok('daily limit message mentions limit', /Daily image limit/.test(ev(`checkImageQuota(1).reason`)),
   ev(`checkImageQuota(1).reason`));
w.localStorage.removeItem('yf_img_quota_user-a');

console.log('\n== Reference image validation ==');
w.document.getElementById('imgPromptInput').value = 'a cat';
const refInput = w.document.getElementById('imgReferenceInput');
let alerted = null;
w.alert = (m) => { alerted = m; };
Object.defineProperty(refInput, 'files', { value: [{ name: 'x.exe', type: 'application/x-msdownload', size: 10 }], configurable: true });
await ev(`generateImageFromModal()`);
ok('non-image upload rejected', /PNG, JPEG, WebP, or GIF/.test(String(alerted)), String(alerted));
Object.defineProperty(refInput, 'files', { value: [{ name: 'big.png', type: 'image/png', size: 9 * 1024 * 1024 }], configurable: true });
alerted = null;
await ev(`generateImageFromModal()`);
ok('oversized image rejected', /under 5 MB/.test(String(alerted)), String(alerted));
Object.defineProperty(refInput, 'files', { value: [], configurable: true });

console.log('\n== Proxy sends an Authorization header when signed in ==');
let captured = null;
w.fetch = async (url, opts) => { captured = { url, opts }; return { ok: true, status: 200, json: async () => ({}) }; };
w.eval(`supabaseClient = { auth: { getSession: async () => ({ data: { session: { access_token: 'TOKEN_ABC' } } }) } }`);
await ev(`proxyFetch({ messages: [] })`);
ok('proxy called the configured PROXY_URL', captured && /groq-proxy.*\/api\/chat$/.test(captured.url), captured && captured.url);
ok('Authorization Bearer header attached',
   captured && captured.opts.headers.Authorization === 'Bearer TOKEN_ABC',
   JSON.stringify(captured && captured.opts.headers));

console.log('\n== Every inline handler resolves at runtime ==');
const src = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const handlerNames = [...new Set([...src.matchAll(/on(?:click|input|change)="([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]))];
const unresolved = handlerNames.filter(n => w.eval(`typeof ${n}`) !== 'function');
ok(`all ${handlerNames.length} inline handlers resolve to a function`, unresolved.length === 0,
   'unresolved: ' + JSON.stringify(unresolved));
ok('openPdfHistory resolves (it is assigned as window.openPdfHistory)',
   w.eval('typeof openPdfHistory') === 'function');

console.log('\n== Landing page focus ==');
const h1 = w.document.getElementById('welcome-title').textContent;
ok('headline is the memory USP', /remembers what matters/i.test(h1), h1);
const welcomeBtns = [...w.document.querySelectorAll('#welcome-screen .welcome-btn')].map(b => b.textContent.trim());
ok('landing has exactly 2 CTAs (was 3)', welcomeBtns.length === 2, JSON.stringify(welcomeBtns));
ok('brand reads "Your Friend AI"',
   /Your Friend AI/.test(w.document.querySelector('#welcome-screen .welcome-brand').textContent));
ok('document title updated', w.document.title === 'Your Friend AI — The AI that remembers what matters', w.document.title);
ok('meta description present', !!w.document.querySelector('meta[name="description"]'));

console.log('\n== Settings simplified ==');
const basicRows = [...w.document.querySelectorAll('#settings-modal > .settings-card > .settings-row')];
ok('exactly 3 basic settings visible up top', basicRows.length === 3,
   basicRows.map(r => r.querySelector('.label')?.textContent).join(' | '));
ok('basic set is Theme / Language / Enter to Send',
   basicRows.map(r => r.querySelector('.label').textContent).join(',') === 'Theme,Language,Enter to Send');
const collapsed = [...w.document.querySelectorAll('#settings-modal details')];
ok('3 collapsible groups exist', collapsed.length === 3, String(collapsed.length));
ok('all groups start collapsed', collapsed.every(d => !d.open));
const totalControls = w.document.querySelectorAll('#settings-modal .settings-row').length;
ok('all 13 controls still present (nothing lost)', totalControls === 13, String(totalControls));
ok('destructive actions are inside the danger group',
   /clearCurrentChat|resetAllSettings/.test(w.document.getElementById('settingsDanger').innerHTML));
ok('export/import are NOT at top level',
   !/exportAppData/.test(basicRows.map(r => r.outerHTML).join('')));

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILURES PRESENT'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
