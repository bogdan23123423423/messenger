// Cloudflare Worker: мост между чатом SynvaSupport в Synva и почтой sonreaaivpn@gmail.com
//
// Роуты:
//   POST /send   — юзер написал в SynvaSupport → письмо на SUPPORT_EMAIL (через Resend)
//   GET  /poll   — клиент опрашивает "есть новые ответы?" (обычный short-poll раз в N секунд)
//   scheduled()  — раз в минуту читает Gmail через API, вытаскивает новые ответы, кладёт в KV
//
// Хранилище (KV, binding SUPPORT_KV):
//   replies:{threadId} -> JSON-массив [{id, text, ts}, ...] — ответы админа, id растёт монотонно
//   rate:{threadId}    -> {count, windowStart} — простой троттлинг /send

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Synva-Key'
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS)
  });
}

function checkKey(request, env) {
  return request.headers.get('X-Synva-Key') === env.CLIENT_KEY;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (url.pathname === '/send' && request.method === 'POST') {
      return handleSend(request, env);
    }
    if (url.pathname === '/poll' && request.method === 'GET') {
      return handlePoll(request, env, url);
    }
    return json({ error: 'not found' }, 404);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(pollGmailForReplies(env));
  }
};

/* ---------- POST /send: сообщение юзера -> письмо ---------- */

async function handleSend(request, env) {
  if (!checkKey(request, env)) return json({ error: 'unauthorized' }, 401);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ error: 'bad json' }, 400);
  }

  const threadId = String(body.threadId || '').trim();
  const username = String(body.username || 'user').slice(0, 80);
  const text = String(body.text || '').trim();

  if (!threadId || !text) return json({ error: 'threadId and text required' }, 400);
  if (text.length > 4000) return json({ error: 'text too long' }, 400);

  // Простой троттлинг — не больше 20 сообщений за 10 минут с одного
  // threadId. Не панацея (ключ виден в исходнике страницы), но отсекает
  // случайный/автоматический перебор.
  const rateKey = 'rate:' + threadId;
  const rateRaw = await env.SUPPORT_KV.get(rateKey);
  const rate = rateRaw ? JSON.parse(rateRaw) : { count: 0, windowStart: Date.now() };
  const windowMs = 10 * 60 * 1000;
  if (Date.now() - rate.windowStart > windowMs) {
    rate.count = 0;
    rate.windowStart = Date.now();
  }
  if (rate.count >= 20) return json({ error: 'rate limited' }, 429);
  rate.count += 1;
  await env.SUPPORT_KV.put(rateKey, JSON.stringify(rate), { expirationTtl: 900 });

  // [tid:...] в теме — единственный способ понять, из какого именно чата
  // пришёл ответ, когда письмо вернётся обратно в scheduled().
  const subject = 'Synva • ' + username + ' [tid:' + threadId + ']';

  const resendResp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to: env.SUPPORT_EMAIL,
      subject: subject,
      text:
        text +
        '\n\n---\nОтветьте прямо на это письмо, не меняя тему — ответ придёт в чат SynvaSupport у ' +
        username +
        '.'
    })
  });

  if (!resendResp.ok) {
    console.error('Resend error', resendResp.status, await resendResp.text());
    return json({ error: 'email send failed' }, 502);
  }

  return json({ ok: true });
}

/* ---------- GET /poll: клиент спрашивает новые ответы ---------- */

async function handlePoll(request, env, url) {
  if (!checkKey(request, env)) return json({ error: 'unauthorized' }, 401);

  const threadId = String(url.searchParams.get('threadId') || '').trim();
  const after = Number(url.searchParams.get('after') || '0') || 0;
  if (!threadId) return json({ error: 'threadId required' }, 400);

  const raw = await env.SUPPORT_KV.get('replies:' + threadId);
  const all = raw ? JSON.parse(raw) : [];
  const fresh = all.filter(function (r) { return r.id > after; });
  const cursor = all.length ? all[all.length - 1].id : after;

  return json({ replies: fresh, cursor: cursor });
}

/* ---------- scheduled: раз в минуту читаем Gmail ---------- */

async function getGmailAccessToken(env) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  if (!resp.ok) {
    throw new Error('gmail token refresh failed: ' + resp.status + ' ' + (await resp.text()));
  }
  const data = await resp.json();
  return data.access_token;
}

function decodeBase64Url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

// Достаёт текстовое тело письма из MIME-структуры Gmail API — тело может
// лежать прямо в payload или быть вложено в multipart/parts (рекурсивно).
function extractPlainText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const found = extractPlainText(part);
      if (found) return found;
    }
  }
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
    const html = decodeBase64Url(payload.body.data);
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

// Обрезает процитированную часть письма (историю переписки), оставляя
// только новый текст ответа. Эвристика — покрывает Gmail/Apple
// Mail/Outlook, но не гарантирует 100% чистоты на экзотических клиентах.
function stripQuotedReply(text) {
  const markers = [
    /\n\s*On .{0,120} wrote:\s*\n/i,
    /\n-{2,}\s*Original Message\s*-{2,}/i,
    /\n\s*От:\s.+\n/i,
    /\n>.*(\n>.*)*/
  ];
  let cut = text.length;
  for (const marker of markers) {
    const m = text.match(marker);
    if (m && m.index !== undefined && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut).trim();
}

async function pollGmailForReplies(env) {
  const accessToken = await getGmailAccessToken(env);

  const listResp = await fetch(
    'https://www.googleapis.com/gmail/v1/users/me/messages?q=' +
      encodeURIComponent('is:unread "[tid:"') +
      '&maxResults=20',
    { headers: { Authorization: 'Bearer ' + accessToken } }
  );
  if (!listResp.ok) {
    console.error('gmail list failed', listResp.status, await listResp.text());
    return;
  }
  const listData = await listResp.json();
  const messages = listData.messages || [];

  for (const item of messages) {
    const msgResp = await fetch(
      'https://www.googleapis.com/gmail/v1/users/me/messages/' + item.id + '?format=full',
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );
    if (!msgResp.ok) continue;
    const msg = await msgResp.json();

    const headers = (msg.payload && msg.payload.headers) || [];
    const subjectHeader = headers.find(function (h) { return h.name === 'Subject'; });
    const subject = subjectHeader ? subjectHeader.value : '';
    const tidMatch = subject.match(/\[tid:([A-Za-z0-9]+)\]/);

    // Не наше письмо (обычная почта без метки) — не трогаем вообще,
    // оставляем непрочитанным как было.
    if (!tidMatch) continue;

    const threadId = tidMatch[1];
    const rawText = extractPlainText(msg.payload);
    const replyText = stripQuotedReply(rawText);

    if (replyText) {
      const key = 'replies:' + threadId;
      const raw = await env.SUPPORT_KV.get(key);
      const list = raw ? JSON.parse(raw) : [];
      const nextId = list.length ? list[list.length - 1].id + 1 : 1;
      list.push({ id: nextId, text: replyText, ts: Date.now() });
      while (list.length > 200) list.shift(); // не даём расти бесконечно
      await env.SUPPORT_KV.put(key, JSON.stringify(list));
    }

    // Помечаем как прочитанное, чтобы не обработать повторно в следующий прогон.
    await fetch(
      'https://www.googleapis.com/gmail/v1/users/me/messages/' + item.id + '/modify',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ removeLabelIds: ['UNREAD'] })
      }
    );
  }
}
