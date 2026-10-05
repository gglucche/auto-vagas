// Consulta HTTP direta aos sites de vagas: sem cookies (não usa nenhuma conta do usuário), com tempo limite
// e com os erros já explicados. É o que substitui abrir uma aba para ler a página.
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
  // 429 e o 999 do LinkedIn: o site pediu para ir mais devagar
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

// Texto de um trecho de HTML em uma linha só.
export const inline = (html) => decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Texto de uma descrição em HTML, com quebras de linha e itens de lista preservados.
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

// Dados estruturados de vaga (schema.org JobPosting) embutidos na página, quando existem.
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
