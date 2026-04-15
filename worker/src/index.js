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

    if (parts[0] !== 'projects') {
      return json({ error: 'not_found' }, 404, cors);
    }

    // Авторизація
    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
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
        updated: Date.now(),
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
