// Fontes de vagas lidas por consulta HTTP direta: sem abrir aba, sem login e sem chave de API. Cada fonte
// recebe um termo de busca e devolve as vagas no mesmo formato; o background filtra, deduplica e guarda.
//
//   list(term, ctx)  -> [{ url, title, company, location, description?, postedAt?, remote? }]
//   details(card)    -> campos que a lista não traz (uma consulta por vaga), quando a fonte precisa
//
// ctx: { geoId, seconds, remoteOnly, country, max }. country é "Brazil", "Portugal"… ou '' para o mundo todo.
import { fetchText, inline, htmlToText, jobPosting } from './http.js';
import { searchJobs, jobDetails, PAGE } from './linkedin.js';

const DAY = 86400e3;
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const place = (...parts) => parts.filter(Boolean).join(', ');
const inBrazil = (ctx) => !ctx.country || ctx.country === 'Brazil';

// Dados da vaga a partir do JobPosting embutido na página de detalhe.
function fromPosting(html) {
  const p = jobPosting(html);
  if (!p) return {};
  const address = [].concat(p.jobLocation || [])[0]?.address || {};
  return {
    title: inline(p.title),
    company: inline(p.hiringOrganization?.name),
    location: place(address.addressLocality, address.addressRegion),
    description: htmlToText(p.description),
    postedAt: Date.parse(p.datePosted) || undefined,
    remote: p.jobLocationType === 'TELECOMMUTE' ? true : undefined,
  };
}

export const SOURCES = [
  {
    id: 'linkedin_jobs',
    label: 'LinkedIn',
    setting: 'srcLinkedinJobs',
    // uma consulta por vez e com pausa: em rajada o LinkedIn responde "429" e corta as consultas por um tempo
    parallel: 1,
    pause: 350,
    // busca pública do site, em páginas de 10; o próprio LinkedIn aplica região, período e "remoto"
    async list(term, ctx) {
      const out = [];
      for (let start = 0; out.length < ctx.max; start += PAGE) {
        const page = await searchJobs({ keywords: term, geoId: ctx.geoId, remote: ctx.remoteOnly, seconds: ctx.seconds, start });
        out.push(...page.map((c) => ({ ...c, url: `https://www.linkedin.com/jobs/view/${c.id}/`, remote: ctx.remoteOnly || undefined })));
        if (page.length < PAGE) break;
      }
      return out;
    },
    details: (card) => jobDetails(card.id),
  },
  {
    id: 'gupy',
    label: 'Gupy',
    setting: 'srcBoards',
    // o portal já entrega a lista dentro da página, com a descrição completa
    async list(term, ctx) {
      if (!inBrazil(ctx)) return [];
      const html = await fetchText(`https://portal.gupy.io/job-search/term=${encodeURIComponent(term)}`);
      const data = JSON.parse(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] || '{}').props?.pageProps?.initialJobList?.data || [];
      return data.map((j) => ({
        url: j.jobUrl,
        title: j.name,
        company: j.careerPageName,
        location: place(j.city, j.state) || (j.workplaceType === 'remote' ? 'Remoto' : ''),
        description: htmlToText(j.description),
        postedAt: Date.parse(j.publishedDate) || undefined,
        remote: j.workplaceType ? j.workplaceType === 'remote' : undefined,
      }));
    },
  },
  {
    id: 'infojobs',
    label: 'InfoJobs',
    setting: 'srcBoards',
    parallel: 3,
    async list(term, ctx) {
      if (!inBrazil(ctx)) return [];
      const html = await fetchText(`https://www.infojobs.com.br/empregos.aspx?palabra=${encodeURIComponent(term)}`);
      return html
        .split('js_rowCard')
        .slice(1)
        .map((card) => ({
          url: 'https://www.infojobs.com.br' + (/data-href="(\/vaga-de-[^"]+)"/.exec(card)?.[1] || ''),
          title: inline(/js_vacancyTitle[^>]*>([\s\S]*?)<\/h2>/.exec(card)?.[1]),
          postedAt: Date.parse((/js_date"[^>]*data-value="([^"]+)"/.exec(card)?.[1] || '').replace(/\//g, '-')) || undefined,
        }))
        .filter((c) => c.title && c.url.includes('/vaga-de-'));
    },
    async details(card) {
      const { title, ...rest } = fromPosting(await fetchText(card.url)); // o título da lista é o do anúncio; o da página vem resumido
      return rest;
    },
  },
  {
    id: 'vagas',
    label: 'Vagas.com',
    setting: 'srcBoards',
    parallel: 3,
    async list(term, ctx) {
      if (!inBrazil(ctx)) return [];
      const html = await fetchText(`https://www.vagas.com.br/vagas-de-${slug(term)}`);
      return html
        .split(/<li[^>]*class="vaga[\s"]/)
        .slice(1)
        .map((card) => {
          const link = /class="link-detalhes-vaga"[^>]*?title="([^"]*)"[^>]*?href="([^"]+)"/.exec(card) || [];
          return {
            url: 'https://www.vagas.com.br' + (link[2] || ''),
            title: inline(link[1]),
            company: inline(/class="emprVaga"[^>]*>([\s\S]*?)<\/span>/.exec(card)?.[1]),
            location: inline(/class="vaga-local"[^>]*>([\s\S]*?)<\/(?:span|div)>/.exec(card)?.[1]),
          };
        })
        .filter((c) => c.title && c.url.includes('/vagas/v'));
    },
    async details(card) {
      const { title, company, ...rest } = fromPosting(await fetchText(card.url));
      return { ...rest, ...(!card.company && company && { company }) };
    },
  },
  {
    id: 'remotar',
    label: 'Remotar',
    setting: 'srcBoards',
    // vagas remotas para o Brasil; a resposta já traz a descrição
    async list(term, ctx) {
      if (!inBrazil(ctx)) return [];
      const data = JSON.parse(await fetchText(`https://api.remotar.com.br/jobs?search=${encodeURIComponent(term)}&active=true`)).data || [];
      return data.map((j) => ({
        url: `https://remotar.com.br/job/${j.id}`,
        title: j.title,
        company: j.company?.name || j.companyDisplayName || '',
        location: place(j.city?.name || j.city, j.state?.name || j.state) || 'Remoto',
        description: [j.subtitle, htmlToText(j.description), (j.jobTags || []).map((t) => t.tag?.name).filter(Boolean).join(' · ')].filter(Boolean).join('\n\n'),
        postedAt: Date.parse(j.createdAt) || undefined,
        remote: true,
      }));
    },
  },
  {
    id: 'himalayas',
    label: 'Himalayas',
    setting: 'srcBoards',
    // vagas remotas internacionais: só as abertas para o país do usuário (ou para qualquer país)
    async list(term, ctx) {
      const data = JSON.parse(await fetchText(`https://himalayas.app/jobs/api/search?q=${encodeURIComponent(term)}&limit=20`)).jobs || [];
      return data
        .filter((j) => {
          const where = j.locationRestrictions || [];
          return !ctx.country || !where.length || where.some((w) => w === ctx.country || /worldwide|latin america|south america|latam/i.test(w));
        })
        .map((j) => ({
          url: j.applicationLink || j.guid,
          title: j.title,
          company: j.companyName,
          location: (j.locationRestrictions || []).join(', ') || 'Remoto, qualquer país',
          description: htmlToText(j.description),
          postedAt: j.pubDate ? j.pubDate * 1000 : undefined,
          remote: true,
        }));
    },
  },
];

// ---------- termos de busca ----------

// Um termo por linha ou separados por vírgula: cada um vira uma busca própria em cada fonte.
export function searchTerms(text) {
  const seen = new Set();
  return (text || '')
    .split(/[\n,;]+/)
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter((t) => t && !seen.has(norm(t)) && seen.add(norm(t)));
}

// ---------- relevância ----------

// conectivos e palavras genéricas demais para exigir ("pessoa desenvolvedora", "analista de sistemas", "engenheiro de software")
const STOP = new Set('de da do das dos e em para com a o as os and of the in for to no na pessoa sistema sistemas system systems software ti it'.split(' '));
const LEVEL = new Set('senior pleno junior jr sr pl trainee estagio estagiario estagiaria'.split(' '));
// Palavras de cargo: dizem o tipo de vaga, não a tecnologia. Grupos = mesma função em português e inglês.
const ROLES = [
  'desenvolvedor desenvolvedora developer dev programador programadora programmer',
  'analista analyst',
  'consultor consultora consultant',
  'engenheiro engenheira engineer',
  'arquiteto arquiteta architect',
  'especialista specialist',
  'administrador administradora administrator',
  'gerente manager',
  'coordenador coordenadora coordinator',
  'lider lead',
  'tecnico tecnica technician',
].map((g) => g.split(' '));
const roleGroup = (w) => ROLES.find((g) => g.includes(w));

const compact = (s) => norm(s).replace(/[^a-z0-9+#]/g, '');
// Palavras do texto, mais cada par de palavras vizinhas junto ("pl sql" e "pl/sql" contam como "plsql").
function wordIndex(text) {
  const words = norm(text).split(/[^a-z0-9+#]+/).filter(Boolean);
  const set = new Set(words);
  for (let i = 0; i + 1 < words.length; i++) set.add(words[i] + words[i + 1]);
  return set;
}

// O que o termo exige da vaga: skills = tecnologias (têm de aparecer no título ou na descrição);
// roles = palavras de cargo (só são exigidas, no título, quando o termo não tem nenhuma tecnologia).
export function termNeeds(term) {
  const skills = [];
  const roles = [];
  for (const raw of norm(term).split(/\s+/)) {
    const w = compact(raw);
    if (!w || STOP.has(w) || LEVEL.has(w)) continue;
    (roleGroup(w) ? roles : skills).push(w);
  }
  return { skills, roles };
}

// A vaga tem a ver com o termo? Os sites devolvem muita coisa só "parecida". Regras:
// - todas as tecnologias do termo têm de aparecer no título ou na descrição;
// - se o termo também diz o cargo ("Consultor Oracle"), o título precisa trazer o cargo ou as tecnologias:
//   analista contábil que só cita Oracle na descrição não é vaga de consultor Oracle;
// - termo só com cargo ("Desenvolvedor"): o cargo tem de estar no título.
export function relevant(term, job) {
  const { skills, roles } = termNeeds(term);
  const title = wordIndex(job.title);
  const roleInTitle = roles.some((r) => roleGroup(r).some((w) => title.has(w)));
  if (!skills.length) return roleInTitle;
  const text = wordIndex(`${job.title} ${job.description || ''}`);
  if (!skills.every((s) => text.has(s))) return false;
  return !roles.length || roleInTitle || skills.every((s) => title.has(s));
}

// As tecnologias do termo estão no título? (vaga "de" Oracle APEX, e não uma que só cita de passagem)
export function inTitle(term, job) {
  const { skills } = termNeeds(term);
  const title = wordIndex(job.title);
  return skills.length > 0 && skills.every((s) => title.has(s));
}

// Anúncio antigo demais para valer a pena (as fontes sem filtro de data devolvem vagas de anos atrás).
export const tooOld = (job, days = 45) => !!job.postedAt && Date.now() - job.postedAt > days * DAY;
