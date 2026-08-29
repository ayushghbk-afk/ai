import { JSDOM } from 'jsdom';
import fs from 'fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
let fails = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); if (!cond) fails++; };

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://localhost/',
  beforeParse(window) {
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
    window.alert = () => {};
    window.confirm = () => true;
    window.prompt = () => null;
    window.Element.prototype.scrollIntoView = function () {};
  }
});
const w = dom.window;
w.onerror = () => {};
await new Promise(r => setTimeout(r, 400));
const doc = w.document;
const ev = (code) => w.eval(code);

// --- settings modal ---
ev('openSettings()');
ok('settings modal opens (display flex)', doc.getElementById('settings-modal').style.display === 'flex');
const rows = [...doc.querySelectorAll('#settings-modal .settings-row')];
ok('13 rows total', rows.length === 13, String(rows.length));

ev("document.getElementById('settingsSearch').value = 'theme'; filterSettings('theme')");
ok('filter "theme" shows 1 row', rows.filter(r => r.style.display !== 'none').length === 1, String(rows.filter(r => r.style.display !== 'none').length));
ok('filter hides unrelated groups', doc.getElementById('settingsAdvanced').style.display === 'none');
const lbls = [...doc.querySelectorAll('#settings-modal .settings-section-label')].map(l => [l.textContent.trim(), l.style.display]);
ok('General label visible (theme is there)', lbls.some(([t, d]) => t.includes('General') && d !== 'none'), JSON.stringify(lbls));
ok('AI label hidden', lbls.some(([t, d]) => t.includes('AI') && d === 'none'), JSON.stringify(lbls));

ev("filterSettings('')");
ok('clear filter restores all rows', rows.every(r => r.style.display === ''));

ev("filterSettings('zzzznothing')");
ok('no-results hint shown', !doc.getElementById('settingsNoResults').hidden);
ev("filterSettings('')");
ok('no-results hint hidden after clear', doc.getElementById('settingsNoResults').hidden);
ev('closeSettings()');
ok('settings closes', doc.getElementById('settings-modal').style.display === 'none');
ok('backdrop handler exists', typeof w.closeSettingsOnBackdrop === 'function');

// --- history grouping ---
const now = Date.now();
ev(`userSessions = {
  a: { title: 'Weekend plans', messages: [{ role: 'user', content: 'hi' }], lastCreatedAtMs: ${now - 3600000} },
  b: { title: 'Work notes', messages: [{ role: 'user', content: 'x' }, { role: 'user', content: 'y' }], lastCreatedAtMs: ${now - 90000000} },
  c: { title: 'Old stuff', messages: [], lastCreatedAtMs: ${now - 20 * 86400000} },
}; currentUserId = 'u1'; currentSessionId = 'a'; renderHistorySidebar()`);
const labels = [...doc.querySelectorAll('#historyList .history-group-label')].map(l => l.textContent);
ok('history grouped Today / Yesterday / This month', JSON.stringify(labels) === JSON.stringify(['Today', 'Yesterday', 'This month']), JSON.stringify(labels));
ok('3 history items', doc.querySelectorAll('#historyList .history-item').length === 3);
ok('active item marked', doc.querySelector('#historyList .history-item.active') !== null);
ok('meta shows count + relative time', /1 message · 1h ago/.test(doc.querySelectorAll('#historyList .history-item .history-item-meta')[0]?.textContent), doc.querySelectorAll('#historyList .history-item .history-item-meta')[0]?.textContent);
ok('active row has 3 action buttons', doc.querySelectorAll('#historyList .history-item.active .history-icon').length === 3);
ok('row opens chat via button', doc.querySelector('#historyList .history-item-main')?.tagName === 'BUTTON');

ev("document.getElementById('historySearch').value='zzz'; renderHistorySidebar()");
ok('search empty state', doc.querySelector('#historyList .history-empty strong')?.textContent === 'No chats match your search.');
ev("document.getElementById('historySearch').value=''; renderHistorySidebar()");
ok('pinned group appears when pinned', (() => { w.localStorage.setItem('yf_chat_pinned_u1', JSON.stringify(['a'])); ev('renderHistorySidebar()'); return [...doc.querySelectorAll('#historyList .history-group-label')].map(l => l.textContent).includes('📌 Pinned'); })());

// --- memory lists ---
w.localStorage.setItem('yf_saved_memories_u1', JSON.stringify(['Lives in Pune', 'Likes coffee']));
ev('renderSavedMemoryList()');
ok('saved list 2 items', doc.getElementById('savedMemoryList').children.length === 2);
ok('item has number chip 01', doc.querySelector('#savedMemoryList .memory-item-num')?.textContent === '01');
ok('item has 2 action buttons', doc.querySelectorAll('#savedMemoryList .memory-item:first-child .memory-item-actions button').length === 2);
ok('saved progress bar fills', doc.getElementById('savedMemoryProgressBar').style.width === '4%', doc.getElementById('savedMemoryProgressBar').style.width);
w.localStorage.setItem('yf_saved_memories_u1', '[]');
ev('savedMemoryItems = null; renderSavedMemoryList()');
ok('saved list empty state has icon', doc.querySelector('#savedMemoryList .memory-list-empty .mle-icon') !== null);

// memory editor progress
ev("el.memoryEditor.value = 'x'.repeat(1500); updateMemoryCount()");
ok('editor progress bar updates', doc.getElementById('memoryProgressBar').style.width === '25%', doc.getElementById('memoryProgressBar').style.width);

// --- reset settings updates every control ---
ev("el.memoryToggle.classList.remove('on'); el.animationToggle.classList.remove('on'); el.privacyToggle.classList.add('on'); el.pdfPreviewToggle.classList.remove('on'); resetAllSettings()");
ok('reset turns memory toggle on', doc.getElementById('memoryToggle').classList.contains('on'));
ok('reset turns animations on', doc.getElementById('animationToggle').classList.contains('on'));
ok('reset turns privacy off', !doc.getElementById('privacyToggle').classList.contains('on'));
ok('reset turns pdf preview on', doc.getElementById('pdfPreviewToggle').classList.contains('on'));
ok('reset restores model select', doc.getElementById('modelSelect').value === 'llama-3.3-70b-versatile');

console.log(fails === 0 ? '\nSMOKE ALL GREEN' : `\n${fails} SMOKE FAILURES`);
process.exit(fails === 0 ? 0 : 1);
