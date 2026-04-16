// Scenario Editor API — Cloudflare Worker + R2
// Routes:
//   GET    /projects            → { projects: {id: {name, updated}} }
//   GET    /projects/:id        → full project JSON
//   PUT    /projects/:id        → save project (body: {name, content, dict, updated})
//   DELETE /projects/:id        → delete project

const GOOGLE_TOKENINFO = 'https://oauth2.googleapis.com/tokeninfo?id_token=';
// Кеш перевірених токенів (Worker isolate time)
const tokenCache = new Map();

async function verifyToken(token, expectedAud, env) {
  // Dev-mode: принимаем фиксированный DEV-токен без проверки Google.
  // Активно ТОЛЬКО когда env.DEV_MODE === 'true' (ставится через .dev.vars локально).
  if (env?.DEV_MODE === 'true' && token === 'DEV') {
    return {
      sub: 'dev-local',
      email: 'dev@local',
      email_verified: true,
      aud: expectedAud,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
  }

  const cached = tokenCache.get(token);
  if (cached && cached.exp * 1000 > Date.now()) return cached;

  const res = await fetch(GOOGLE_TOKENINFO + encodeURIComponent(token));
  if (!res.ok) throw new Error('invalid_token');
  const payload = await res.json();
  if (payload.aud !== expectedAud) throw new Error('bad_audience');
  if (!payload.email_verified) throw new Error('email_not_verified');
  if (parseInt(payload.exp) * 1000 < Date.now()) throw new Error('token_expired');

  tokenCache.set(token, payload);
  return payload;
}

function corsHeaders(origin, allowedList) {
  const allowed = allowedList.split(',').map(s => s.trim());
  const originOk = allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': originOk ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env.ALLOWED_ORIGINS);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // --- AI Reformat ---
    if (parts[0] === 'reformat' && request.method === 'POST') {
      return handleReformat(request, env, cors);
    }

    if (parts[0] !== 'projects') {
      return json({ error: 'not_found' }, 404, cors);
    }

    // Авторизація (header або query param для sendBeacon)
    const auth = request.headers.get('Authorization') || '';
    let token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) {
      token = url.searchParams.get('token') || null;
    }
    if (!token) return json({ error: 'unauthorized' }, 401, cors);

    let user;
    try {
      user = await verifyToken(token, env.GOOGLE_CLIENT_ID, env);
    } catch (e) {
      return json({ error: 'invalid_token', detail: e.message }, 401, cors);
    }

    const userId = user.sub;  // стабільний Google user id
    const userPrefix = `users/${userId}/`;

    // GET /projects → список
    if (parts.length === 1 && request.method === 'GET') {
      const list = await env.BUCKET.list({ prefix: userPrefix });
      const projects = {};
      for (const obj of list.objects) {
        const id = obj.key.slice(userPrefix.length).replace(/\.json$/, '');
        try {
          const meta = obj.customMetadata || {};
          projects[id] = {
            name: meta.name || '(без назви)',
            updated: parseInt(meta.updated) || obj.uploaded.getTime(),
            size: obj.size,
          };
        } catch {}
      }
      return json({ projects }, 200, cors);
    }

    const id = parts[1];
    if (!id || !/^[\w.-]+$/.test(id)) {
      return json({ error: 'bad_id' }, 400, cors);
    }
    const key = userPrefix + id + '.json';

    // GET /projects/:id
    if (request.method === 'GET') {
      const obj = await env.BUCKET.get(key);
      if (!obj) return json({ error: 'not_found' }, 404, cors);
      const data = await obj.json();
      return json(data, 200, cors);
    }

    // PUT /projects/:id
    if (request.method === 'PUT') {
      const body = await request.json();
      if (!body || typeof body !== 'object') {
        return json({ error: 'bad_body' }, 400, cors);
      }
      const payload = {
        name: String(body.name || '(без назви)').slice(0, 200),
        content: String(body.content || ''),
        dict: body.dict || { characters: {}, locations: {}, phrases: {} },
        updated: body.updated || Date.now(),
      };
      await env.BUCKET.put(key, JSON.stringify(payload), {
        customMetadata: {
          name: payload.name,
          updated: String(payload.updated),
        },
      });
      return json({ ok: true, updated: payload.updated }, 200, cors);
    }

    // DELETE /projects/:id
    if (request.method === 'DELETE') {
      await env.BUCKET.delete(key);
      return json({ ok: true }, 200, cors);
    }

    return json({ error: 'method_not_allowed' }, 405, cors);
  },
};

const CLASSIFY_SYSTEM = `You are a screenplay classifier. You receive a JSON array of lines. Return a JSON array of block types — EXACTLY ONE type per input line, same order, same length.

TYPES (13):
- "scene-heading": location+time, starts with INT./EXT./NAT./ІНТ./НАТ./ЕКСТ.
- "cast-list": multiple named characters with ages/descriptions, right after scene-heading. e.g. "Марк(22), Леся(22)"
- "action": scene description, b-rolls, stage directions, title-page items (title, author, adaptation credits)
- "character": SINGLE character name BEFORE their dialogue (may be lowercase in source — still character if followed by dialogue). May have (ЗК), (ПЗ), (V.O.), (O.S.)
- "dialogue": what a character says, usually on the line after "character"
- "parenthetical": brief direction in parens between character and dialogue: "(тихо)", "(пошепки)"
- "transition": CUT TO, FADE, ЗАТЕМНЕННЯ, ПЕРЕХІД, КІНЕЦЬ
- "shot": camera direction — КРУПНИЙ ПЛАН, ЗАГАЛЬНИЙ, CLOSE UP, WIDE, POV, INSERT
- "super": on-screen text — starts with ТИТР:, SUPER:, CHYRON:, TITLE:, CAPTION:
- "montage": МОНТАЖ, MONTAGE, СЕРІЯ ПЛАНІВ
- "intercut": ІНТЕРКАТ, INTERCUT
- "flashback": ПОЧАТОК/КІНЕЦЬ ФЛЕШБЕКУ, BEGIN/END FLASHBACK
- "act-break": АКТ, ACT

KEY RULES:
1. cast-list vs character: multiple names with ages/commas → cast-list; single name → character
2. A "character" block is ALWAYS SHORT: 1-3 words max, usually a single name (with optional (ЗК) / (V.O.)). It NEVER contains sentence punctuation (. ! ?). If a line has >3 words or ends with .!? — it is NEVER "character".
3. If a line has >3 words starting with a capitalized name (e.g. "Леся дуже здивована бачити його.") — this is "action" (a scene description about Леся), NOT character.
4. If a single line contains name + dialogue together — classify as "dialogue" (do not split; frontend handles cases where input is single-type-per-line)
5. b-roll/visual descriptions = "action"
6. IMPORTANT — CHARACTER → DIALOGUE CHAIN: If the immediately preceding block (in context or in this input) was "character", the current line is almost certainly "dialogue" — EVEN IF IT LOOKS LIKE A NAME (e.g. single-word "Марк" after character "ЛЕСЯ" = dialogue, she's calling him, NOT a new character). Only mark as "character" if preceded by non-character/non-dialogue block AND it's ALL CAPS.
7. DIALOGUE CONTINUES: After a dialogue line, the next line is usually still dialogue (same character) OR action (stage direction) OR parenthetical. It is NOT character unless the text is ALL CAPS name AND ≤3 words.

CRITICAL EXAMPLE (the name-as-dialogue case):
Context: [character] ЛЕСЯ
Input: ["Марк", "Леся посміхається.", "МАРК", "Як справи?"]
Correct output: ["dialogue", "action", "character", "dialogue"]
Explanation: "Марк" right after character ЛЕСЯ is her dialogue (she's calling him by name) — NOT a new character. "МАРК" (ALL CAPS) IS a new character header.

RULE OF THUMB: Two "character" blocks in a row without dialogue between them is ALMOST ALWAYS WRONG. If you're about to output character-character in sequence, reconsider — the second is probably dialogue.

OUTPUT: ONLY a JSON array of type strings. Length MUST equal input lines count. No markdown, no explanation.
Example input: ["ІНТ. КУХНЯ", "Марк готує каву", "марк", "Привіт"]
Example output: ["scene-heading", "action", "character", "dialogue"]`;

const CLASSIFY_CONTEXT_SYSTEM = `If you receive prior context (system message "PRIOR CONTEXT"), use it to decide types for the user's new lines. DO NOT classify or output types for context — only for the user's current array.`;

// --- Пул Groq ключів з round-robin та failover ---
function getApiKeys(env) {
  const keys = [];
  if (env.GROK_API_KEYS) {
    keys.push(...env.GROK_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean));
  }
  if (env.GROK_API_KEY) keys.push(env.GROK_API_KEY.trim());
  return [...new Set(keys)];
}

// Стан пулу ключів — живе в isolate (скидається при cold start). Достатньо для rate-limit розподілу.
const keyPool = {
  cursor: 0,
  failures: new Map(), // key → { retryAt: epoch ms }
};

function pickAvailableKey(keys) {
  const now = Date.now();
  for (let i = 0; i < keys.length; i++) {
    const idx = (keyPool.cursor + i) % keys.length;
    const key = keys[idx];
    const f = keyPool.failures.get(key);
    if (!f || f.retryAt <= now) {
      keyPool.cursor = (idx + 1) % keys.length;
      return { key, idx };
    }
  }
  return null;
}

function markKeyFailure(key, retryAfterSec) {
  const retryAt = Date.now() + Math.max(1, retryAfterSec) * 1000;
  keyPool.failures.set(key, { retryAt });
}

async function callGroqWithRotation(keys, body) {
  let lastDetail = null;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const pick = pickAvailableKey(keys);
    if (!pick) throw new Error('all_keys_throttled:' + (lastDetail || 'no-keys-available'));
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + pick.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status === 503) {
      // 429 — rate limit (чекаємо до retry-after), 503 — over capacity (короткий cooldown і пробуємо інший ключ)
      const retryAfter = parseInt(res.headers.get('retry-after') || (res.status === 503 ? '15' : '60'), 10);
      markKeyFailure(pick.key, retryAfter);
      lastDetail = (await res.text()).slice(0, 200);
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error('ai_http_' + res.status + ':' + body.slice(0, 200));
    }
    return await res.json();
  }
  throw new Error('all_keys_throttled:' + (lastDetail || 'all-rotated'));
}

async function handleReformat(request, env, cors) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json({ error: 'unauthorized' }, 401, cors);

  try {
    await verifyToken(token, env.GOOGLE_CLIENT_ID, env);
  } catch (e) {
    return json({ error: 'invalid_token' }, 401, cors);
  }

  const body = await request.json();
  const lines = body?.lines; // масив рядків — AI класифікує, текст зберігається клієнтом
  // context може бути масивом рядків (старий формат) АБО масивом {type, text} (новий, з типами)
  const contextRaw = body?.context;
  if (!Array.isArray(lines) || !lines.length) return json({ error: 'missing lines array' }, 400, cors);
  if (lines.length > 2000) return json({ error: 'too many lines (max 2000)' }, 400, cors);

  const keys = getApiKeys(env);
  if (!keys.length) return json({ error: 'AI not configured' }, 500, cors);

  const validTypes = new Set(['scene-heading', 'action', 'character', 'dialogue', 'parenthetical', 'transition', 'cast-list', 'shot', 'super', 'montage', 'intercut', 'flashback', 'act-break']);

  try {
    const messages = [{ role: 'system', content: CLASSIFY_SYSTEM }];
    if (Array.isArray(contextRaw) && contextRaw.length) {
      messages.push({ role: 'system', content: CLASSIFY_CONTEXT_SYSTEM });
      // Якщо контекст типізований (масив {type, text}) — форматуємо як "[type] text" для чіткості.
      let ctxRepr;
      if (typeof contextRaw[0] === 'object' && contextRaw[0] !== null && 'type' in contextRaw[0]) {
        ctxRepr = contextRaw.map((b) => `[${b.type}] ${String(b.text || '')}`).join('\n');
      } else {
        ctxRepr = JSON.stringify(contextRaw);
      }
      messages.push({ role: 'system', content: 'PRIOR CONTEXT (already classified, reference only, do not re-classify):\n' + ctxRepr });
    }
    messages.push({ role: 'user', content: JSON.stringify(lines) });
    const aiData = await callGroqWithRotation(keys, {
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature: 0.1,
      max_tokens: 2000, // типи компактні, не треба 8k
    });
    const content = aiData.choices?.[0]?.message?.content || '';
    let types;
    try {
      const jsonStr = content.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
      types = JSON.parse(jsonStr);
    } catch (e) {
      return json({ error: 'ai_parse_error', raw: content.substring(0, 500) }, 502, cors);
    }
    if (!Array.isArray(types)) {
      return json({ error: 'ai_bad_format', raw: content.substring(0, 500) }, 502, cors);
    }
    // Нормалізуємо: всі елементи — рядки з дозволеного набору, довжина = lines.length
    const normalized = [];
    for (let i = 0; i < lines.length; i++) {
      const t = types[i];
      normalized.push(validTypes.has(t) ? t : 'action');
    }
    return json({ types: normalized, keys: keys.length }, 200, cors);
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.startsWith('all_keys_throttled')) {
      return json({ error: 'all_keys_throttled', detail: msg }, 429, cors);
    }
    return json({ error: 'ai_error', detail: msg }, 502, cors);
  }
}
