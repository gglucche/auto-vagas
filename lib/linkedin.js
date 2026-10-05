// Vagas do LinkedIn pela busca pública do site — a que qualquer pessoa vê sem login. Não abre janela, não
// usa a conta do usuário (as consultas vão sem cookies) e não depende de a página estar visível.
import { fetchText, inline, htmlToText } from './http.js';

const API = 'https://www.linkedin.com/jobs-guest';
export const WORLD = { geoId: '92000000', name: 'Mundialmente' };
export const PAGE = 10; // vagas por página da busca pública

const get = (path, params) => fetchText(`${API}${path}?${new URLSearchParams(params)}`);
const norm = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// Converte o lugar digitado pelo usuário no código de região do LinkedIn. Sem isso o LinkedIn chuta:
// "Brasil" em texto livre devolve vagas dos Estados Unidos. Devolve { geoId, name } ou null.
export async function resolvePlace(text) {
  const parts = (text || '').split(/[,;/|]/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  let best = null;
  for (const query of new Set([parts[0], parts.join(', ')])) {
    let hits = [];
    try {
      hits = JSON.parse(await get('/api/typeaheadHits', { origin: 'jserp', typeaheadType: 'GEO', geoTypes: 'POPULATED_PLACE,ADMIN_DIVISION_2,MARKET_AREA,COUNTRY_REGION', query }));
    } catch (e) {
      if (e.limited) throw e;
    }
    hits.forEach((h, i) => {
      // prefere o resultado que contém mais partes do que foi digitado; em empate, o primeiro da lista
      const score = parts.filter((p) => norm(h.displayName || '').includes(norm(p))).length * 10 - i;
      if (h.id && (!best || score > best.score)) best = { geoId: String(h.id), name: h.displayName, score };
    });
  }
  return best && { geoId: best.geoId, name: best.name };
}

// Uma página da busca. seconds = idade máxima do anúncio; start = deslocamento (0, 10, 20…).
export async function searchJobs({ keywords, geoId, remote, seconds, start = 0 }) {
  const html = await get('/jobs/api/seeMoreJobPostings/search', {
    keywords,
    ...(geoId && { geoId }),
    f_TPR: `r${Math.round(seconds)}`,
    ...(remote && { f_WT: '2' }),
    sortBy: 'DD',
    start: String(start),
  });
  return html
    .split(/<li[\s>]/)
    .slice(1)
    .map((card) => ({
      id: /urn:li:jobPosting:(\d+)/.exec(card)?.[1],
      title: inline(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/.exec(card)?.[1]),
      company: inline(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/.exec(card)?.[1]),
      location: inline(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/.exec(card)?.[1]),
      postedAt: Date.parse(/datetime="([^"]+)"/.exec(card)?.[1]) || undefined,
    }))
    .filter((j) => j.id && j.title);
}

// Texto completo de um anúncio.
export async function jobDetails(id) {
  const html = await get(`/jobs/api/jobPosting/${id}`, {});
  const criteria = [...html.matchAll(/description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/g)].map((m) => inline(m[1])).filter(Boolean);
  const description = htmlToText(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>\s*<button/.exec(html)?.[1] || /show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1]);
  return {
    title: inline(/top-card-layout__title[^>]*>([\s\S]*?)<\/h[1-3]>/.exec(html)?.[1]),
    company: inline(/topcard__org-name-link[^>]*>([\s\S]*?)<\/a>/.exec(html)?.[1]),
    location: inline(/topcard__flavor topcard__flavor--bullet[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1]),
    description: description + (criteria.length ? `\n\n${criteria.join(' · ')}` : ''),
    // "onsite" = candidatura simplificada, feita dentro do LinkedIn; "offsite" = no site da empresa
    easyApply: /apply-link-onsite/.test(html) ? 'sim' : /apply-link-offsite/.test(html) ? 'nao' : '',
  };
}
