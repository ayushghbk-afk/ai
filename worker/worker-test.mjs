// Tests for the hardened proxy Worker. Run: node worker/worker-test.mjs
// These execute the real exported fetch handler (Node 22 has Request/Response);
// only the upstream call to api.groq.com is stubbed.
import worker, {
  parseAllowedOrigins,
  isAllowedOrigin,
  validatePayload,
  parseKeys,
  createRateLimiter
} from './index.js';

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`  \u2717 ${name}${detail ? ' :: ' + detail : ''}`); }
}
const section = (t) => console.log(`\n\u2500\u2500 ${t}`);

const SITE = 'https://ayushghbk-afk.github.io';
const KEYS = 'gsk_key_one_1234567890, gsk_key_two_1234567890, gsk_key_three_12345678, gsk_key_four_1234567';
const env = { GROQ_API_KEYS: KEYS };

function req(method, { origin = SITE, body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (origin) init.headers.Origin = origin;
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  return new Request('https://groq-proxy.mr-hackerdon808.workers.dev/api/chat', init);
}

const chat = (text = 'Hi') => ({ messages: [{ role: 'user', content: text }], model: 'llama-3.3-70b-versatile', max_tokens: 512 });

/* ------------------------------------------------------------ pure helpers */
section('Origin allowlist');
{
  const allowed = parseAllowedOrigins(`${SITE}, https://example.com/`);
  check('trailing slash normalised', allowed.includes('https://example.com'), JSON.stringify(allowed));
  check('site origin allowed', isAllowedOrigin(SITE, allowed));
  check('exact match only (substring rejected)', !isAllowedOrigin('https://ayushghbk-afk.github.io.evil.com', allowed));
  check('missing origin rejected', !isAllowedOrigin('', allowed));
  check('default list used when unset', parseAllowedOrigins('').includes(SITE));
}

section('Key parsing + payload validation');
{
  check('keys parsed from csv', parseKeys(KEYS).length === 4, String(parseKeys(KEYS).length));
  check('short junk ignored', parseKeys('abc, ,def').length === 0);
  const limits = { MAX_MESSAGES: 3, MAX_MESSAGE_CHARS: 100 };
  check('valid payload accepted', validatePayload(chat(), limits).ok);
  check('missing messages rejected', validatePayload({}, limits).code === 'messages_required');
  check('too many messages rejected', validatePayload({ messages: Array.from({ length: 4 }, () => ({ role: 'user', content: 'x' })) }, limits).code === 'too_many_messages');
  check('over-long message rejected', validatePayload({ messages: [{ role: 'user', content: 'x'.repeat(101) }] }, limits).code === 'message_too_long');
  check('bad role rejected', validatePayload({ messages: [{ role: 'root', content: 'x' }] }, limits).code === 'invalid_role');
  check('absurd max_tokens rejected', validatePayload({ messages: [{ role: 'user', content: 'x' }], max_tokens: 999999 }, limits).code === 'invalid_max_tokens');
}

section('Rate limiter (sliding window)');
{
  let clock = 0;
  const limit = createRateLimiter(new Map(), () => clock);
  const opts = { windowMs: 1000, max: 3 };
  check('first 3 allowed', [1, 2, 3].every(() => limit('k', opts).allowed));
  const blocked = limit('k', opts);
  check('4th blocked', blocked.allowed === false);
  check('Retry-After provided', blocked.retryAfter >= 1, String(blocked.retryAfter));
  clock = 1500;
  check('window slides', limit('k', opts).allowed === true);
}

/* ------------------------------------------------------------- HTTP handler */
section('Worker handler: CORS + health');
{
  const res = await worker.fetch(req('GET'), env);
  const data = await res.json();
  check('GET health is 200', res.status === 200, String(res.status));
  check('health reports 4 configured keys', data.configured_keys === 4, JSON.stringify(data));
  check('health echoes the allowed origin only', res.headers.get('access-control-allow-origin') === SITE, String(res.headers.get('access-control-allow-origin')));
  check('Vary: Origin set', res.headers.get('vary') === 'Origin');
  check('never sends ACAO *', res.headers.get('access-control-allow-origin') !== '*');

  const pre = await worker.fetch(req('OPTIONS'), env);
  check('preflight from the site is 204', pre.status === 204, String(pre.status));
  check('preflight exposes Content-Type only', pre.headers.get('access-control-allow-headers') === 'Content-Type');

  const evilPre = await worker.fetch(req('OPTIONS', { origin: 'https://evil.example' }), env);
  check('preflight from a random site is 403', evilPre.status === 403, String(evilPre.status));
  check('random site gets no CORS header', evilPre.headers.get('access-control-allow-origin') === null);
}

section('Worker handler: abuse protection');
{
  const crossSite = await worker.fetch(req('POST', { origin: 'https://evil.example', body: chat() }), env);
  check('cross-site POST blocked with 403', crossSite.status === 403, String(crossSite.status));
  check('cross-site POST body is a code, not details', (await crossSite.json()).error.code === 'origin_not_allowed');

  const noOrigin = await worker.fetch(req('POST', { origin: null, body: chat() }), env);
  check('origin-less client (curl/script) blocked', noOrigin.status === 403, String(noOrigin.status));

  const huge = await worker.fetch(req('POST', { body: { messages: [{ role: 'user', content: 'x'.repeat(300 * 1024) }] } }), env);
  check('oversized body rejected with 413', huge.status === 413, String(huge.status));

  const badJson = await worker.fetch(req('POST', { body: '{not json' }), env);
  check('invalid JSON rejected with 400', badJson.status === 400, String(badJson.status));

  const noMessages = await worker.fetch(req('POST', { body: { model: 'x' } }), env);
  check('missing messages rejected with 400', noMessages.status === 400, String(noMessages.status));

  const many = await worker.fetch(req('POST', { body: { messages: Array.from({ length: 500 }, () => ({ role: 'user', content: 'spam' })) } }), env);
  check('message-count bomb rejected', many.status === 400, String(many.status));

  // per-IP limit: unique IP so other tests do not interfere.
  // Upstream is stubbed so the limiter (not the network) decides the status.
  const realFetchLimiter = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 });
  let statuses = [];
  for (let i = 0; i < 14; i++) {
    const r = await worker.fetch(req('POST', { body: chat(), headers: { 'cf-connecting-ip': '203.0.113.9' } }), env);
    statuses.push(r.status);
  }
  check('per-IP minute limit kicks in (429 seen)', statuses.includes(429), statuses.join(','));
  check('requests inside the limit still succeed', statuses[0] === 200, String(statuses[0]));
  const limited = await worker.fetch(req('POST', { body: chat(), headers: { 'cf-connecting-ip': '203.0.113.9' } }), env);
  check('429 carries Retry-After', Number(limited.headers.get('retry-after')) >= 1, String(limited.headers.get('retry-after')));

  let burstStatuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await worker.fetch(req('POST', { body: chat(), headers: { 'cf-connecting-ip': '203.0.113.10' } }), env);
    burstStatuses.push(r.status);
  }
  check('short burst limit kicks in', burstStatuses.includes(429), burstStatuses.join(','));
  globalThis.fetch = realFetchLimiter;

  const unconfigured = await worker.fetch(req('POST', { body: chat(), headers: { 'cf-connecting-ip': '203.0.113.11' } }), { GROQ_API_KEYS: '' });
  check('no keys configured -> 503', unconfigured.status === 503, String(unconfigured.status));
}

section('Worker handler: key rotation + no secret leakage');
{
  const seenKeys = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const key = init.headers.Authorization.replace('Bearer ', '');
    seenKeys.push(key);
    if (key.includes('one')) return new Response('{"error":{"message":"rate limit for gsk_key_one_1234567890"}}', { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hello from key two' } }] }), { status: 200 });
  };
  try {
    const res = await worker.fetch(req('POST', { body: chat(), headers: { 'cf-connecting-ip': '198.51.100.1' } }), env);
    const text = await res.text();
    check('rotates past an exhausted key', res.status === 200, String(res.status));
    check('second key was used', seenKeys.length === 2 && seenKeys[1].includes('two'), seenKeys.join(','));
    check('successful reply passes through', text.includes('Hello from key two'));
    check('reply has site CORS header', res.headers.get('access-control-allow-origin') === SITE);
  } finally {
    globalThis.fetch = realFetch;
  }

  const realFetch2 = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":{"message":"Invalid API key gsk_key_one_1234567890"}}', { status: 429 });
  try {
    const res = await worker.fetch(req('POST', { body: chat(), headers: { 'cf-connecting-ip': '198.51.100.2' } }), env);
    const body = await res.json();
    check('all keys exhausted -> 503', res.status === 503, String(res.status));
    check('error uses a stable code', body.error.code === 'all_keys_busy', JSON.stringify(body));
    check('no key material in the response', !JSON.stringify(body).includes('gsk_'), JSON.stringify(body));
  } finally {
    globalThis.fetch = realFetch2;
  }

  const realFetch3 = globalThis.fetch;
  globalThis.fetch = async () => new Response(`{"error":{"message":"Bad request: gsk_key_one_1234567890"}}`, { status: 400 });
  try {
    const res = await worker.fetch(req('POST', { body: chat(), headers: { 'cf-connecting-ip': '198.51.100.3' } }), env);
    const body = await res.json();
    check('400 from provider is forwarded as 400', res.status === 400, String(res.status));
    check('provider text hidden by default', !JSON.stringify(body).includes('gsk_'), JSON.stringify(body));
    const dbg = await worker.fetch(req('POST', { body: chat(), headers: { 'cf-connecting-ip': '198.51.100.4' } }), { ...env, DEBUG_ERRORS: 'true' });
    const dbgBody = await dbg.json();
    check('DEBUG_ERRORS reveals detail when enabled', typeof dbgBody.error.detail === 'string' && dbgBody.error.detail.includes('Bad request'), JSON.stringify(dbgBody).slice(0, 120));
  } finally {
    globalThis.fetch = realFetch3;
  }
}

console.log(`\n${'='.repeat(58)}\nPASSED ${passed}   FAILED ${failed}`);
if (failed) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
