// Job sources read through direct HTTP requests: no tab opened, no login and no API key. Each source
// takes a search term and returns the jobs in the same format; the background filters, dedupes and stores them.
//
//   list(term, ctx)  -> [{ url, title, company, location, description?, postedAt?, remote? }]
//   details(card)    -> fields the list doesn't include (one request per job), when the source needs it
//
// ctx: { geoId, seconds, remoteOnly, country, max }. country is "Brazil", "Portugal"… or '' for the whole world.
import { fetchText, inline, htmlToText, jobPosting } from './http.js';
import { searchJobs, jobDetails, PAGE } from './linkedin.js';

const DAY = 86400e3;
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const place = (...parts) => parts.filter(Boolean).join(', ');
const inBrazil = (ctx) => !ctx.country || ctx.country === 'Brazil';

// Job data from the JobPosting embedded in the detail page.
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
    // one request at a time, with a pause: in bursts LinkedIn answers "429" and cuts off requests for a while
    parallel: 1,
    pause: 350,
    // the site's public search, in pages of 10; LinkedIn itself applies region, date range and "remote"
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
    // the portal already delivers the list inside the page, with the full description
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
      const { title, ...rest } = fromPosting(await fetchText(card.url)); // the list carries the posting's title; the page's is abbreviated
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
    // remote jobs for Brazil; the response already includes the description
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
    // international remote jobs: only those open to the user's country (or to any country)
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

// ---------- search terms ----------

// One term per line or comma-separated: each one becomes a separate search in every source.
export function searchTerms(text) {
  const seen = new Set();
  return (text || '')
    .split(/[\n,;]+/)
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter((t) => t && !seen.has(norm(t)) && seen.add(norm(t)));
}

// ---------- relevance ----------

// connectives and words too generic to require ("pessoa desenvolvedora", "analista de sistemas", "engenheiro de software")
const STOP = new Set('de da do das dos e em para com a o as os and of the in for to no na pessoa sistema sistemas system systems software ti it'.split(' '));
const LEVEL = new Set('senior pleno junior jr sr pl trainee estagio estagiario estagiaria'.split(' '));
// Role words: they say what kind of job it is, not the technology. Groups = same role in Portuguese and English.
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
// The text's words, plus each pair of neighboring words joined ("pl sql" and "pl/sql" count as "plsql").
function wordIndex(text) {
  const words = norm(text).split(/[^a-z0-9+#]+/).filter(Boolean);
  const set = new Set(words);
  for (let i = 0; i + 1 < words.length; i++) set.add(words[i] + words[i + 1]);
  return set;
}

// What the term requires of the job: skills = technologies (must appear in the title or the description);
// roles = role words (only required, in the title, when the term has no technology at all).
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

// Does the job match the term? Sites return a lot of things that are only "similar". Rules:
// - every technology in the term must appear in the title or the description;
// - if the term also names the role ("Consultor Oracle"), the title must contain the role or the technologies:
//   an accounting analyst job that only mentions Oracle in its description is not an Oracle consultant job;
// - role-only term ("Desenvolvedor"): the role must be in the title.
export function relevant(term, job) {
  const { skills, roles } = termNeeds(term);
  const title = wordIndex(job.title);
  const roleInTitle = roles.some((r) => roleGroup(r).some((w) => title.has(w)));
  if (!skills.length) return roleInTitle;
  const text = wordIndex(`${job.title} ${job.description || ''}`);
  if (!skills.every((s) => text.has(s))) return false;
  return !roles.length || roleInTitle || skills.every((s) => title.has(s));
}

// Are the term's technologies in the title? (an actual Oracle APEX job, not one that just mentions it in passing)
export function inTitle(term, job) {
  const { skills } = termNeeds(term);
  const title = wordIndex(job.title);
  return skills.length > 0 && skills.every((s) => title.has(s));
}

// Posting too old to be worth it (sources with no date filter return jobs from years ago).
export const tooOld = (job, days = 45) => !!job.postedAt && Date.now() - job.postedAt > days * DAY;
