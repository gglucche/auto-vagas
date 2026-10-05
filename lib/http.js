// Direct HTTP request to the job sites: no cookies (none of the user's accounts are used), with a timeout
// and with the errors already explained. This is what replaces opening a tab to read the page.
export async function fetchText(url, { method, headers = {}, body } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      body,
      credentials: 'omit',
      headers: { 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.6', ...headers },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new Error(`sem resposta (${e.message})`);
  }
  // 429 and LinkedIn's 999: the site asked us to slow down
  if (res.status === 429 || res.status === 999) throw Object.assign(new Error('limitou as consultas por agora'), { limited: true });
  if (!res.ok) throw new Error(`respondeu ${res.status}`);
  return res.text();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decode = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);

// Text of an HTML snippet, on a single line.
export const inline = (html) => decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Text of an HTML description, with line breaks and list items preserved.
export function htmlToText(html) {
  return decode(
    (html || '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<(br|\/p|\/div|\/li|\/ul|\/ol|\/h\d|\/tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Structured job data (schema.org JobPosting) embedded in the page, when present.
export function jobPosting(html) {
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].replace(/[\u0000-\u001f]+/g, ' '));
      const found = [].concat(data).find((d) => d?.['@type'] === 'JobPosting');
      if (found) return found;
    } catch {}
  }
  return null;
}
