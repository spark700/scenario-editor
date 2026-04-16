// Scenario Editor API — Cloudflare Worker + R2
// Routes:
//   GET    /projects            → { projects: {id: {name, updated}} }
//   GET    /projects/:id        → full project JSON
//   PUT    /projects/:id        → save project (body: {name, content, dict, updated})
//   DELETE /projects/:id        → delete project

const GOOGLE_TOKENINFO = 'https://oauth2.googleapis.com/tokeninfo?id_token=';
// Кеш перевірених токенів (Worker isolate time)
const tokenCache = new Map();

async function verifyToken(token, expectedAud) {
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
      user = await verifyToken(token, env.GOOGLE_CLIENT_ID);
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

const REFORMAT_SYSTEM = `You are a professional screenplay formatter. You receive raw text and split it into standard screenplay blocks.

Return a JSON array of blocks. Each block: {"type": "...", "text": "..."}

AVAILABLE TYPES (13):
- "scene-heading": location+time. INT./EXT./NAT. or Ukrainian ІНТ./НАТ./ЕКСТ. Example: "НАТ. ВЕЧІР. ВУЛИЦІ МІСТА"
- "cast-list": list of characters PRESENT in a scene, placed RIGHT AFTER scene-heading. Example: "МАРК (22), ЛЕСЯ (22)". Contains multiple names with ages/descriptions separated by commas. This is NOT a character name before dialogue!
- "action": scene description, what happens visually, b-roll descriptions, stage directions
- "character": single character name BEFORE their dialogue. UPPERCASE. May include (ЗК), (ПЗ), (V.O.), (O.S.)
- "dialogue": what a character says (lines after character name)
- "parenthetical": brief direction in parentheses between character and dialogue: "(тихо)", "(пошепки)"
- "transition": CUT TO, FADE, ЗАТЕМНЕННЯ, ПЕРЕХІД, КІНЕЦЬ
- "shot": camera direction. КРУПНИЙ ПЛАН, ЗАГАЛЬНИЙ ПЛАН, CLOSE UP, WIDE SHOT, POV, ANGLE ON, INSERT
- "super": on-screen text. Starts with ТИТР:, SUPER:, CHYRON:, TITLE:, CAPTION:
- "montage": montage sequence header. МОНТАЖ, MONTAGE, СЕРІЯ ПЛАНІВ
- "intercut": parallel editing. ІНТЕРКАТ, INTERCUT
- "flashback": time-shift marker. ПОЧАТОК/КІНЕЦЬ ФЛЕШБЕКУ, BEGIN/END FLASHBACK
- "act-break": structural division. АКТ ПЕРШИЙ, ACT ONE, etc.

CRITICAL RULES:

1. CAST LIST vs CHARACTER: If a line after scene-heading lists MULTIPLE people with ages like "Марк(22), Леся(22)" — this is "cast-list", NOT "character". "character" is ONLY a single name immediately before dialogue.

2. CHARACTER NAME NORMALIZATION:
- Lowercase/mixed → UPPERCASE: "Марк" → "МАРК", "Леся" → "ЛЕСЯ"
- Voice-over: "МАРК(ЗК-закадровий голос)" → "МАРК (ЗК)"
- Off-screen: "ЛЕСЯ(ПЗ)" → "ЛЕСЯ (ПЗ)"
- Age in cast-list stays: "МАРК (22), ЛЕСЯ (22)"
- Always space before parenthesis

3. After "character", next line is "dialogue" (unless parenthetical in between)
4. Multi-sentence dialogue = one "dialogue" block
5. Author's camera/stage directions in parentheses within action = keep as "action"
6. If a line has character name AND dialogue together, split into "character" + "dialogue"
7. b-roll descriptions = "action"
8. Title page elements (title, author name, adaptation credit) = "action"

Return ONLY valid JSON array. No markdown, no explanation.`;

function splitTextIntoChunks(text, maxSize) {
  if (text.length <= maxSize) return [text];
  const chunks = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';
  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxSize && current.length > 0) {
      chunks.push(current.trim());
      current = '';
    }
    current += (current ? '\n\n' : '') + para;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text.substring(0, maxSize)];
}

async function handleReformat(request, env, cors) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json({ error: 'unauthorized' }, 401, cors);

  try {
    await verifyToken(token, env.GOOGLE_CLIENT_ID);
  } catch (e) {
    return json({ error: 'invalid_token' }, 401, cors);
  }

  const body = await request.json();
  const text = body?.text;
  if (!text || typeof text !== 'string') {
    return json({ error: 'missing text' }, 400, cors);
  }
  if (text.length > 50000) {
    return json({ error: 'text too long (max 50000)' }, 400, cors);
  }

  const grokKey = env.GROK_API_KEY;
  if (!grokKey) return json({ error: 'AI not configured' }, 500, cors);

  try {
    // Розбиваємо на чанки по ~3000 символів (щоб вкластись в ліміт Groq free tier)
    const CHUNK_SIZE = 3000;
    const chunks = splitTextIntoChunks(text, CHUNK_SIZE);
    let allBlocks = [];

    for (const chunk of chunks) {
      const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + grokKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: REFORMAT_SYSTEM },
            { role: 'user', content: chunk },
          ],
          temperature: 0.1,
          max_tokens: 8000,
        }),
      });

      if (!aiRes.ok) {
        const errBody = await aiRes.text();
        return json({ error: 'ai_error', status: aiRes.status, detail: errBody.substring(0, 300) }, 502, cors);
      }

      const aiData = await aiRes.json();
      const content = aiData.choices?.[0]?.message?.content || '';

      let blocks;
      try {
        const jsonStr = content.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
        blocks = JSON.parse(jsonStr);
      } catch (e) {
        return json({ error: 'ai_parse_error', raw: content.substring(0, 500) }, 502, cors);
      }

      if (!Array.isArray(blocks)) {
        return json({ error: 'ai_bad_format', raw: content.substring(0, 500) }, 502, cors);
      }

      allBlocks = allBlocks.concat(blocks);

      // Пауза між чанками щоб не перевищити rate limit
      if (chunks.length > 1) await new Promise(r => setTimeout(r, 1500));
    }

    const blocks = allBlocks;
    const validTypes = new Set(['scene-heading', 'action', 'character', 'dialogue', 'parenthetical', 'transition', 'cast-list', 'shot', 'super', 'montage', 'intercut', 'flashback', 'act-break']);
    const cleaned = blocks
      .filter(b => b && typeof b.text === 'string' && b.text.trim())
      .map(b => ({
        type: validTypes.has(b.type) ? b.type : 'action',
        text: b.text.trim(),
      }));

    return json({ blocks: cleaned }, 200, cors);
  } catch (e) {
    return json({ error: 'ai_fetch_error', detail: e.message }, 502, cors);
  }
}
