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

const REFORMAT_SYSTEM = `You are a professional screenplay formatter. You receive raw text that was copied from a document and needs to be split into screenplay blocks.

Analyze the text and return a JSON array of blocks. Each block has:
- "type": one of "scene-heading", "action", "character", "dialogue", "parenthetical", "transition"
- "text": the cleaned text content

Rules:
- "scene-heading": location and time lines like "INT. ROOM - DAY", "EXT. STREET - NIGHT" or their Ukrainian equivalents "ІНТ.", "НАТ.", "ЕКСТ."
- "character": character name before their dialogue. Usually short, often UPPERCASE. Can include age like "МАРК(22)"
- "dialogue": what a character says (lines AFTER a character name)
- "parenthetical": stage directions in parentheses within dialogue, like "(тихо)", "(шепотом)"
- "action": scene description, stage directions, what happens visually
- "transition": CUT TO, FADE OUT, ЗАТЕМНЕННЯ, ПЕРЕХІД, etc.

Key context clues:
- After a character name, the next non-empty line(s) are usually dialogue
- Short lines in caps/title case before dialogue = character names
- Lines describing what happens = action
- B-roll descriptions = action
- Title page elements (title, author) = action
- "(ЗК)" or "(V.O.)" after name = still character type, keep the annotation

Return ONLY valid JSON array, no markdown, no explanation.
Example: [{"type":"scene-heading","text":"INT. ROOM - NIGHT"},{"type":"character","text":"JOHN"},{"type":"dialogue","text":"Hello there."}]`;

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
    const aiRes = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + grokKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'grok-3-mini-fast',
        messages: [
          { role: 'system', content: REFORMAT_SYSTEM },
          { role: 'user', content: text },
        ],
        temperature: 0.1,
        max_tokens: 16000,
      }),
    });

    if (!aiRes.ok) {
      const errBody = await aiRes.text();
      return json({ error: 'ai_error', status: aiRes.status, detail: errBody.substring(0, 300) }, 502, cors);
    }

    const aiData = await aiRes.json();
    const content = aiData.choices?.[0]?.message?.content || '';

    // Витягаємо JSON з відповіді (може бути обгорнутий в ``` )
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

    const validTypes = new Set(['scene-heading', 'action', 'character', 'dialogue', 'parenthetical', 'transition']);
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
