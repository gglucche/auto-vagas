import { getSettings, setSettings, getJobs, getJob, putJobs, patchJob, removeJobs, log, hashId, fillTemplate, JOB_PREFIX } from './lib/store.js';
import { evaluate, writeApplication, analyzeResume, answerQuestions, providerOf, aiKey, discoverModels } from './lib/ai.js';
import { getToken, connectGmail, sendEmail } from './lib/gmail.js';
import { textToPdf, pdfToB64 } from './lib/pdf.js';
import { extractTags, localFit, normKey } from './lib/match.js';
import { BUILD } from './lib/build.js';
import { resolvePlace, WORLD } from './lib/linkedin.js';
import { SOURCES, searchTerms, relevant, inTitle, tooOld, foreign } from './lib/sources.js';
import { answerFor, questionKey, SECRET } from './lib/answers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = (s) => (s || '').split('\n').map((l) => l.trim()).filter(Boolean);
const DASHBOARD = chrome.runtime.getURL('ui/dashboard.html');

async function openDashboard() {
  const [tab] = await chrome.tabs.query({ url: DASHBOARD + '*' });
  if (!tab) return chrome.tabs.create({ url: DASHBOARD });
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // migration from the old format (all jobs under a single key)
  const { jobs } = await chrome.storage.local.get('jobs');
  if (jobs) {
    await putJobs(Object.values(jobs));
    await chrome.storage.local.remove('jobs');
  }
  // 0.6.0: search switched to direct queries. Sources that open a window stay off until the user turns them back on.
  const { migrated = {}, settings: saved } = await chrome.storage.local.get(['migrated', 'settings']);
  if (!migrated.directSearch) {
    if (saved && (saved.srcLinkedinPosts || saved.srcGoogle)) {
      await setSettings({ srcLinkedinPosts: false, srcGoogle: false });
      await log('A busca agora consulta os sites direto, sem abrir janela. “Posts do LinkedIn” e “Vagas do Google”, que precisam de uma janela, foram desligados; dá para religar em Configurações.');
    }
    await chrome.storage.local.set({ migrated: { ...migrated, directSearch: true } });
  }
  setupAlarms();
  refreshBadge();
  // autoReload: the dashboard asked for the extension update (ui/fresh.js) and was closed by it
  const { autoReload } = await chrome.storage.local.get('autoReload');
  if (reason === 'install' || Date.now() - (autoReload?.at || 0) < 60_000) openDashboard();
  if (reason === 'update') {
    // 0.8.0: a new way to compute the fit. The AI's old scores (one number, no requirements) of open jobs give way
    // to it: the local fit is recomputed, and the jobs for the website get evaluated again by the AI.
    const { migrated: done = {} } = await chrome.storage.local.get('migrated');
    if (!done.fit08) {
      for (const j of await getJobs())
        if (j.aiDone && !j.requirements && !['enviado', 'descartado', 'ignorado'].includes(j.status)) await patchJob(j.id, { aiDone: false });
      await chrome.storage.local.set({ migrated: { ...done, fit08: true } });
    }
    recalcFit();
    retryFailed(true);
  }
});
chrome.runtime.onStartup.addListener(setupAlarms);
chrome.notifications.onClicked.addListener(openDashboard);

async function setupAlarms() {
  const s = await getSettings();
  await chrome.alarms.clear('scan');
  const mins = Number(s.scanEveryHours) * 60;
  if (mins > 0) chrome.alarms.create('scan', { periodInMinutes: mins, delayInMinutes: mins });
  // Safety net: resumes the queue if the service worker is shut down midway.
  chrome.alarms.create('queue', { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'scan') runScan();
  if (a.name === 'queue') {
    processQueue();
    runApply(); // resumes website applications left in the queue
  }
});

async function refreshBadge() {
  const n = (await getJobs()).filter((j) => j.status === 'pronto').length;
  chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
  chrome.action.setBadgeText({ text: n ? String(n) : '' });
}

// ---------- Scan ----------

// Search runs as direct HTTP queries to the sources in lib/sources.js: each term becomes a search of its own
// in each source, sources run in parallel, and nothing opens a tab or uses the user's account. The two sources
// that only exist inside a page (LinkedIn posts and Google Jobs) are optional and open a window.
const PAGE_LABEL = { linkedin_post: 'Posts do LinkedIn', google_jobs: 'Vagas do Google' };

// "Qualquer lugar" (anywhere), "remoto" (remote) and the like are not places: on Google they become noise, and
// LinkedIn reads them as a city name. With no place set, the search covers the country of the browser's language.
const ANYWHERE = /^(qualquer( lugar)?|anywhere|remoto|remote|home ?office)$/i;
const WORLDWIDE = /^(mundo( todo)?|mundialmente|worldwide|global|internacional)$/i;
const homeCountry = () => ({ 'pt-br': 'Brasil', 'pt-pt': 'Portugal' })[(chrome.i18n?.getUILanguage?.() || '').toLowerCase()];
// Seniority words and connectives only narrow the posts search, which requires every word.
const coreTerms = (kw) => kw.replace(/\b(s[êe]nior|pleno|j[úu]nior|jr|sr)\b\.?/gi, ' ').replace(/\s+(e|and|&)\s+/gi, ' ').replace(/\s+/g, ' ').trim();

function pageSearches(s, terms) {
  const out = [];
  const loc = ANYWHERE.test(s.location.trim()) || WORLDWIDE.test(s.location.trim()) ? '' : s.location.trim();
  for (const kw of terms) {
    if (s.srcLinkedinPosts)
      out.push({
        source: 'linkedin_post',
        keyword: kw,
        url: `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(
          `${coreTerms(kw)} (vaga OR oportunidade OR contratando) (email OR "e-mail" OR currículo OR cv)` +
            (s.remoteOnly ? ' (remoto OR remota OR remote OR "home office")' : '')
        )}&datePosted=%22past-week%22&sortBy=%22date_posted%22`,
      });
    if (s.srcGoogle)
      out.push({
        source: 'google_jobs',
        keyword: kw,
        url: `https://www.google.com/search?q=${encodeURIComponent(`${kw} vagas ${s.remoteOnly ? 'remoto' : loc}`.trim())}&udm=8`,
      });
  }
  return out;
}

async function waitComplete(tabId) {
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
  }
}

async function askContent(tabId, msg) {
  let lastErr;
  for (let i = 0; i < 8; i++) {
    try {
      return await Promise.race([
        chrome.tabs.sendMessage(tabId, msg),
        sleep(5 * 60_000).then(() => ({ ok: false, error: 'tempo esgotado' })),
      ]);
    } catch (e) {
      lastErr = e; // content script not loaded yet
      await sleep(1000);
    }
  }
  return { ok: false, error: `página não respondeu (captcha ou bloqueio?) — ${lastErr?.message || ''}` };
}

const scan = { running: false, stop: false, i: 0, total: 0, label: '', keyword: '', found: 0, winId: null, stoleFocus: false };
const publishScan = (extra = {}) =>
  chrome.storage.local.set({ scan: { running: scan.running, i: scan.i, total: scan.total, label: scan.label, found: scan.found, ...extra } });

// If the service worker restarted in the middle of a search, the saved state would be stuck at "running".
chrome.storage.local.get('scan').then(({ scan: saved }) => {
  if (saved?.running && !scan.running) chrome.storage.local.set({ scan: { ...saved, running: false } });
});

// LinkedIn region for the location in the settings. It is cached: it rarely changes and costs a lookup.
async function linkedinPlace(text) {
  text = text.trim();
  if (!text || ANYWHERE.test(text)) text = homeCountry() || '';
  if (!text || WORLDWIDE.test(text)) return WORLD;
  const { liPlace } = await chrome.storage.local.get('liPlace');
  if (liPlace?.text === text) return liPlace;
  const place = { text, ...((await resolvePlace(text)) || { ...WORLD, name: `${WORLD.name} (o LinkedIn não reconheceu “${text}”)` }) };
  await chrome.storage.local.set({ liPlace: place });
  return place;
}

// The search country as the international sources write it; '' = any country.
const COUNTRY = { brasil: 'Brazil', portugal: 'Portugal', 'estados unidos': 'United States', espanha: 'Spain', argentina: 'Argentina', mexico: 'Mexico', canada: 'Canada', alemanha: 'Germany', 'reino unido': 'United Kingdom' };
function countryOf(place) {
  if (place.geoId === WORLD.geoId) return '';
  const last = place.name.split(',').pop().trim();
  return COUNTRY[last.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()] || last;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const DAY_MS = 86400e3;

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

// Why a job that was read stays out of the dashboard ('' = it gets in). Sites return a lot that is only "similar".
function rejection(term, card, ctx, s) {
  if (!card.title) return 'sem título';
  if (tooOld(card)) return 'antiga';
  const text = `${card.title}\n${card.description || ''}`;
  if (ctx.remoteOnly && !(card.remote ?? extractTags(`${text}\n${card.location || ''}`).includes('Remoto'))) return 'não é remota';
  if (!relevant(term, card)) return 'fora do termo';
  if (s.foreignOnly && !foreign(card)) return 'não é de fora';
  // mentions the term only in passing and has little to do with the resume
  const fit = localFit(card, s);
  if (fit && fit.fit < 35 && !inTitle(term, card)) return 'pouca aderência';
  return '';
}

// One search: one term in one source. Reads the list, fills in the description only for jobs not seen yet,
// filters and stores. state is shared by the whole scan (what is already on the dashboard, what was already rejected).
async function scanSource(src, term, ctx, state, s) {
  const stat = state.stats[src.id];
  const cards = (await src.list(term, ctx)).slice(0, ctx.max);
  stat.read += cards.length;
  const basis = hashId(`${term}|${ctx.remoteOnly}`);
  const seenKey = (card) => `${hashId(card.url)}:${basis}`;
  const fresh = cards.filter((c) => c.url && !state.known.has(hashId(c.url)) && !state.seen[seenKey(c)]);
  if (src.details)
    await pool(fresh, src.parallel || 2, async (card) => {
      if (scan.stop || state.off[src.id]) return void (card.skipped = true);
      if (src.pause) await sleep(src.pause * (1 + Math.random()));
      try {
        for (const [k, v] of Object.entries(await src.details(card))) if (v) card[k] = v;
      } catch (e) {
        card.skipped = true; // left for the next search
        if (e.limited) state.off[src.id] = stat.error = e.message;
      }
    });
  const jobs = [];
  for (const card of fresh) {
    if (card.skipped) continue;
    state.seen[seenKey(card)] = Date.now(); // read: rejected, stored or a repeat from another site; not worth querying again
    if (rejection(term, card, ctx, s)) continue;
    const description = (card.description || '').slice(0, 8000);
    const emails = [...new Set((description.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))];
    const job = { source: src.id, title: card.title, company: card.company || '', location: card.location || '', url: card.url, description, emails };
    if (card.easyApply) job.easyApply = card.easyApply === 'sim';
    jobs.push(job);
    state.known.add(hashId(card.url));
  }
  stat.kept += jobs.length;
  if (jobs.length) stat.added += (await addJobs(jobs, term)).added;
}

async function runScan() {
  if (scan.running) return;
  const s = await getSettings();
  const terms = searchTerms(s.keywords);
  const sources = SOURCES.filter((src) => s[src.setting]);
  const pages = pageSearches(s, terms);
  if (!terms.length || !(sources.length || pages.length)) return log('Busca: defina palavras-chave e ao menos uma fonte nas Configurações.');
  Object.assign(scan, { running: true, stop: false, i: 0, total: sources.length * terms.length + pages.length, label: '', found: 0, winId: null, stoleFocus: false });
  await publishScan();
  const started = Date.now();
  const max = Number(s.maxPerSearch) || 15;
  const before = await chrome.windows.getLastFocused().catch(() => null);
  const hiddenNote = (res) => (res.hidden ? ' — a janela de busca ficou escondida e a página pode não ter carregado' : '');
  try {
    if (sources.length) {
      const place = await linkedinPlace(s.location);
      const { liScanAt = {}, seenJobs = {} } = await chrome.storage.local.get(['liScanAt', 'seenJobs']);
      const state = {
        known: new Set((await getJobs()).map((j) => j.id)),
        seen: Object.fromEntries(Object.entries(seenJobs).filter(([, t]) => Date.now() - t < 45 * DAY_MS)),
        stats: Object.fromEntries(sources.map((src) => [src.id, { read: 0, kept: 0, added: 0, error: '' }])),
        off: {},
      };
      const base = { geoId: place.geoId, country: countryOf(place), remoteOnly: s.remoteOnly, foreignOnly: !!s.foreignOnly, max };
      // sources in parallel; within each source, one term at a time (so as not to rush any site)
      await Promise.all(
        sources.map(async (src) => {
          for (const term of terms) {
            if (!scan.stop && !state.off[src.id]) {
              scan.label = `${src.label} · ${term}`;
              scan.keyword = term;
              publishScan();
              // LinkedIn: the first search for each term looks back 30 days; later ones, the time since the previous one
              const key = `${term}|${place.geoId}|${s.remoteOnly}`;
              const seconds = liScanAt[key] ? Math.min(30 * 86400, Math.max(86400, (Date.now() - liScanAt[key]) / 1000 + 3600)) : 30 * 86400;
              try {
                await scanSource(src, term, { ...base, seconds }, state, s);
                if (src.id === 'linkedin_jobs' && !state.off[src.id]) liScanAt[key] = Date.now();
              } catch (e) {
                state.stats[src.id].error = e.message;
                if (e.limited) state.off[src.id] = e.message;
              }
            }
            scan.i++;
            publishScan();
          }
        })
      );
      await chrome.storage.local.set({ liScanAt, seenJobs: state.seen });
      const parts = sources.map((src) => {
        const st = state.stats[src.id];
        return `${src.label} ${st.read} lida(s), ${st.added} nova(s)${st.error ? ` (${st.error})` : ''}`;
      });
      await log(`Busca em ${Math.round((Date.now() - started) / 1000)} s — ${terms.length} termo(s), ${place.name}${s.foreignOnly ? ', só de fora' : ''}: ${parts.join(' · ')}.`);
    }

    let tabId;
    for (const search of pages) {
      if (scan.stop) break;
      Object.assign(scan, { keyword: search.keyword, label: `${PAGE_LABEL[search.source]} · ${search.keyword}` });
      await publishScan();
      if (!scan.winId) {
        // Dedicated window: background tabs don't load the lists.
        const win = await chrome.windows.create({ url: 'about:blank', focused: false, width: 1250, height: 900 });
        scan.winId = win.id;
        tabId = win.tabs[0].id;
      }
      await chrome.tabs.update(tabId, { url: search.url });
      await waitComplete(tabId);
      const res = await askContent(tabId, { type: 'scan', source: search.source, max });
      if (res?.error === 'login') await log(`${scan.label}: faça login no LinkedIn neste navegador e busque de novo.`);
      else if (!res?.ok) await log(`${scan.label}: ${res?.error || 'falhou'}`);
      else if (search.source === 'linkedin_post') await log(`${scan.label}: ${res.count} com e-mail em ${res.posts ?? '?'} post(s) lido(s)${hiddenNote(res)}.`);
      else await log(`${scan.label}: ${res.count} anúncio(s) lido(s)${hiddenNote(res)}.`);
      scan.i++;
      await sleep(2000 + Math.random() * 3000);
    }
  } catch (e) {
    if (!scan.stop) await log(`Busca interrompida: ${e.message}`);
  } finally {
    scan.running = false;
    scan.i = scan.total;
    await publishScan({ last: Date.now() });
    if (scan.winId) chrome.windows.remove(scan.winId).catch(() => {});
    // give focus back to the window the user was in, if the search had to come to the front
    if (scan.stoleFocus && before?.id) chrome.windows.update(before.id, { focused: true }).catch(() => {});
  }
  if (s.notify && scan.found)
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/128.png'),
      title: 'Auto Vagas',
      message: `${scan.found} vaga(s) nova(s) encontrada(s). Clique para revisar.`,
    });
  processQueue();
}

// Sources run in parallel: additions to the dashboard go through one at a time, so the same job coming from
// two sites is not stored twice.
let adding = Promise.resolve();
function addJobs(found, keyword) {
  const run = adding.then(() => storeJobs(found, keyword));
  adding = run.catch(() => {});
  return run;
}

async function storeJobs(found, keyword) {
  const s = await getSettings();
  const blocked = lines(s.blockedDomains).map((d) => d.toLowerCase());
  const exclude = lines(s.excludeTerms).map((t) => t.toLowerCase());
  const own = s.email.trim().toLowerCase();
  const okEmail = (e) =>
    e !== own && !/\.(png|jpe?g|gif|webp|svg)$/.test(e) && !/^(no-?reply|noreply)/.test(e) && !blocked.some((d) => e.endsWith('@' + d) || e.endsWith('.' + d));

  const existing = await getJobs();
  const ids = new Set(existing.map((j) => j.id));
  const dups = new Set(existing.map((j) => j.dupKey));
  const sentTo = new Set(existing.filter((j) => j.status === 'enviado' && j.email).map((j) => j.email));
  const fresh = [];
  for (const f of found) {
    const emails = (f.emails || []).filter(okEmail);
    const id = hashId(f.source === 'linkedin_post' ? `${emails[0] || ''}|${f.title}` : f.url);
    // the same job often shows up in more than one source
    const dupKey = f.source === 'linkedin_post' ? id : normKey(f.title, f.company);
    if (ids.has(id) || dups.has(dupKey)) continue;
    const head = `${f.title} ${f.company}`.toLowerCase();
    if (exclude.some((t) => head.includes(t))) continue;

    const job = { ...f, id, dupKey, emails, email: emails[0] || '', keyword, foundAt: Date.now(), status: 'novo' };
    job.tags = extractTags(`${f.title}\n${f.location}\n${f.description}`);
    if (foreign(f)) job.tags.unshift('Internacional');
    const m = localFit(f, s);
    if (m) Object.assign(job, m);
    if (!job.email) job.status = 'sem_email';
    else if (sentTo.has(job.email)) Object.assign(job, { status: 'descartado', note: 'Já existe candidatura enviada para este e-mail.' });
    ids.add(id);
    dups.add(dupKey);
    fresh.push(job);
  }
  await putJobs(fresh);
  if (scan.running) {
    scan.found += fresh.length;
    publishScan();
  }
  if (fresh.length) processQueue();
  return { added: fresh.length };
}

// Resume, skills, search terms or years of experience changed: recomputes the local fit of open jobs (the score
// given by the AI is kept).
let fitBasis = null;
async function recalcFit() {
  const s = await getSettings();
  const basis = hashId(`${s.resumeText}|${s.skills}|${s.keywords}|${s.yearsExperience}|${s.englishLevel}`);
  if (basis === fitBasis) return;
  fitBasis = basis;
  for (const j of await getJobs()) {
    if (j.aiDone || ['enviado', 'descartado', 'ignorado'].includes(j.status)) continue;
    const m = localFit(j, s) || { fit: null, matched: null, missing: null, fitWhy: '' };
    if ((j.fit ?? null) === m.fit && (j.matched || []).join() === (m.matched || []).join() && (j.fitWhy || '') === m.fitWhy) continue;
    // the AI may have scored it in the meantime: its score stays
    const now = await getJob(j.id);
    if (now && !now.aiDone) await patchJob(j.id, m);
  }
}

// ---------- AI models: which ones respond with the user's key ----------

const MODELS_TTL = 24 * 3600e3;
async function workingModels(s, force = false) {
  const { aiModels = {} } = await chrome.storage.local.get('aiModels');
  const key = hashId(aiKey(s));
  let entry = aiModels[s.provider];
  if (force || !entry || entry.key !== key || Date.now() - entry.checkedAt > MODELS_TTL) {
    entry = { ...(await discoverModels(s)), key };
    await chrome.storage.local.set({ aiModels: { ...aiModels, [s.provider]: entry } });
  }
  return entry;
}

// Settings ready for calling the AI: with no model chosen, uses the best one that responded to the test.
async function aiSettings(force = false) {
  const s = await getSettings();
  const p = providerOf(s);
  if (!p.base || (s[p.modelField] && !force)) return s;
  const entry = await workingModels(s, force);
  if (!entry.working.length) {
    const why = entry.failed[0] ? ` (${entry.failed[0].id}: ${entry.failed[0].reason})` : '';
    throw new Error(`${p.label}: nenhum modelo respondeu com esta chave${why}.`);
  }
  return { ...s, [p.modelField]: entry.working[0].id };
}

// Calls the AI; if the model is gone or the key lost access, switches to the best available one and retries.
async function withAi(fn) {
  const s = await aiSettings();
  try {
    return await fn(s);
  } catch (e) {
    const p = providerOf(s);
    if (!e.modelIssue || !p.base) throw e;
    const bad = s[p.modelField];
    const fresh = await aiSettings(true);
    if (fresh[p.modelField] === bad) throw e;
    if ((await getSettings())[p.modelField]) await setSettings({ [p.modelField]: '' }); // back to automatic selection
    await log(`${p.label}: o modelo ${bad} não está disponível para esta chave; passei a usar ${fresh[p.modelField]}.`);
    return fn(fresh);
  }
}

// ---------- Preparation (template or AI) ----------

const getResumePdf = async () => (await chrome.storage.local.get('resumePdf')).resumePdf;

// What the AI's evaluation gives a job: the fit, the requirements one by one, strengths and gaps.
// With no requirement listed, the local fit stays.
const evalPatch = (sc) => ({
  ...(sc.fit != null && { fit: sc.fit, aiDone: true, fitWhy: sc.why || '' }),
  note: sc.reason || '',
  requirements: sc.requirements,
  strengths: sc.strengths,
  gaps: sc.gaps,
});

// Below this fit the AI doesn't write the application (it would not be sent by the autopilot anyway):
// the job keeps the template and the AI writes when the user asks for it.
const writeMin = (s) => Math.min(40, Number(s.minFit) || 0);

async function prepare(id, { forceAi = false } = {}) {
  const s = await getSettings();
  const job = await getJob(id);
  if (!job) return;
  const template = { subject: fillTemplate(s.subjectTemplate, job, s), body: fillTemplate(s.bodyTemplate, job, s) };
  const sent = job.status === 'enviado';
  let patch;
  if (s.mode === 'ai' || forceAi) {
    let scored = null;
    try {
      patch = await withAi(async (ai) => {
        const pdf = await getResumePdf();
        const sc = await evaluate(ai, job, pdf);
        if (!sc.isPosting)
          // only a job still being prepared is put aside; on a manual request the job stays where it is
          return job.status === 'novo' ? { status: 'ignorado', note: sc.reason || 'A IA avaliou que não é um anúncio de vaga.', error: '' } : { error: 'A IA avaliou que este texto não é um anúncio de vaga.' };
        scored = { ...evalPatch(sc), error: '' };
        if (sent) return scored; // the email and the resume that went out stay as they were
        const fit = sc.fit ?? job.fit;
        if (!forceAi && fit != null && fit < writeMin(s))
          return { ...scored, ...template, resumeText: '', aiWarnings: [`Aderência ${fit}: a IA não escreveu e-mail nem currículo para esta vaga. Use “Adaptar com IA” se quiser se candidatar mesmo assim.`] };
        const w = await writeApplication(ai, job, pdf, sc);
        return { ...scored, subject: w.subject || template.subject, body: w.body || template.body, resumeText: w.resume, aiWarnings: w.warnings };
      });
    } catch (e) {
      // A manual "Adaptar com IA" (Tailor with AI) leaves the job where it is; it only shows the error. Out of quota,
      // the job waits a little and goes again. What the evaluation found stays, even when only the writing failed.
      const failed = forceAi && job.status !== 'novo' ? { error: e.message }
        : e.status === 429 ? { status: 'novo', error: e.message, retryAt: Date.now() + 15 * 60e3 }
        : { status: 'erro', error: e.message, errorBasis: aiBasis(s) };
      patch = { ...(scored || {}), ...failed };
    }
  } else {
    patch = { ...template, error: '' };
  }
  // the user may have discarded (or sent) the job while the AI was working: that decision stands
  const now = await getJob(id);
  if (!now) return;
  if (now.status !== job.status && ['descartado', 'ignorado', 'enviado'].includes(now.status)) return;
  // a status the user changed meanwhile ("Enviar todas" put it in the queue, an email came in) stands; otherwise the
  // status follows the job as it is now, and a discarded or sent job stays as it is ("Adaptar com IA" never puts
  // it back in the queue)
  if (now.status !== job.status) delete patch.status;
  else if (!('status' in patch) && !patch.error && !['enviado', 'descartado'].includes(now.status)) patch.status = now.email ? 'pronto' : 'sem_email';
  await patchJob(id, patch);
}

// With the AI on, the jobs to apply for on the website (no email: most of them) get its evaluation too, a few per
// round and the best local fit first, so the list is ranked by the AI and not only by keywords. A daily cap keeps
// a free quota for the jobs with an email; running out of quota ends the round; a job that failed is tried again
// some hours later, or as soon as the AI settings change.
const SCORE_PER_DAY = (s) => (providerOf(s).serial ? 30 : 100);
async function scoreSiteJobs(s) {
  const basis = aiBasis(s);
  const { aiScoreLog } = await chrome.storage.local.get('aiScoreLog');
  let count = aiScoreLog?.date === today() ? aiScoreLog.count : 0;
  const recent = (j) => j.aiTried === basis && Date.now() - (j.aiTriedAt || 0) < 6 * 3600e3;
  const pending = (await getJobs())
    .filter((j) => j.status === 'sem_email' && !j.aiDone && !recent(j) && (j.fit == null || j.fit >= 35))
    .sort((a, b) => (b.fit ?? 50) - (a.fit ?? 50))
    .slice(0, 5);
  for (const j of pending) {
    if (count >= SCORE_PER_DAY(s)) return;
    let patch = {};
    try {
      const sc = await withAi(async (ai) => evaluate(ai, j, await getResumePdf(), { patient: false }));
      patch = sc.isPosting ? evalPatch(sc) : { status: 'ignorado', note: sc.reason || 'A IA avaliou que não é um anúncio de vaga.' };
      await chrome.storage.local.set({ aiScoreLog: { date: today(), count: ++count } });
    } catch (e) {
      if (e.status === 429) return;
    }
    const now = await getJob(j.id);
    if (now?.status === 'sem_email' && !now.aiDone) await patchJob(j.id, { ...patch, aiTried: basis, aiTriedAt: Date.now() });
  }
}

// A job whose AI preparation failed (left with no subject) goes back to the queue when there is reason for it
// to work now: the extension was updated (all) or the AI configuration changed since the failure.
const aiBasis = (s) => hashId([s.mode, s.provider, aiKey(s), s[providerOf(s).modelField]].join('|'));
async function retryFailed(all = false) {
  const basis = aiBasis(await getSettings());
  let retried = 0;
  for (const j of await getJobs()) {
    if (j.status !== 'erro' || j.subject || (!all && j.errorBasis === basis)) continue;
    await patchJob(j.id, { status: 'novo', error: '' });
    retried++;
  }
  if (retried) processQueue();
}

// ---------- Sending ----------

const today = () => new Date().toLocaleDateString('sv');
async function sentToday() {
  const { sentLog } = await chrome.storage.local.get('sentLog');
  return sentLog?.date === today() ? sentLog.count : 0;
}

async function buildAttachment(job, s) {
  const fileName = `Curriculo - ${s.name || 'candidato'}.pdf`;
  if (job?.resumeText) return { name: fileName, b64: pdfToB64(textToPdf(job.resumeText)) };
  const resumePdf = await getResumePdf();
  if (!resumePdf) throw Object.assign(new Error('Suba o currículo padrão (PDF) nas Configurações.'), { setup: true });
  return { name: resumePdf.name || fileName, b64: resumePdf.b64 };
}

async function send(id, { interactive }) {
  const s = await getSettings();
  const job = await getJob(id);
  if (!job || !job.email) throw new Error('Vaga sem e-mail.');
  if (job.status === 'enviado') throw new Error('Já enviada.');
  const attachment = await buildAttachment(job, s);
  const token = await getToken(s.gmailClientId, interactive, s.email);
  const sent = await sendEmail(token, { to: job.email, subject: job.subject, body: job.body, attachment });
  await patchJob(id, { status: 'enviado', stage: 'aguardando', sentAt: Date.now(), threadId: sent.threadId, error: '' });
  await chrome.storage.local.set({ sentLog: { date: today(), count: (await sentToday()) + 1 } });
  await log(`Enviado para ${job.email} — ${job.title}`);
}

async function followUp(id, body) {
  const s = await getSettings();
  const job = await getJob(id);
  if (!job?.email) throw new Error('Vaga sem e-mail.');
  const token = await getToken(s.gmailClientId, true, s.email);
  await sendEmail(token, { to: job.email, subject: `Re: ${job.subject}`, body, threadId: job.threadId });
  await patchJob(id, { followUpAt: Date.now(), followUpBody: body });
  await log(`Follow-up enviado para ${job.email} — ${job.title}`);
}

// The queue retries every minute: the pause is logged and notified only once.
async function pauseSending(reason) {
  const msg = `Envio pausado: ${reason}`;
  const { log: [last] = [] } = await chrome.storage.local.get('log');
  if (last?.msg === msg) return;
  await log(msg);
  chrome.notifications.create({ type: 'basic', iconUrl: chrome.runtime.getURL('icons/128.png'), title: 'Auto Vagas — envio pausado', message: reason });
}

let busy = false;
let again = false; // someone asked for the queue while it was running
async function processQueue() {
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  try {
    const tried = new Set();
    for (;;) {
      // 1) prepare new jobs (including those that arrived during a send): 3 at a time,
      //    or one at a time when the AI is on a free quota, so as not to exceed the per-minute limit
      const cfg = await getSettings();
      const batch = cfg.mode === 'ai' && providerOf(cfg).serial ? 1 : 3;
      for (;;) {
        const fresh = (await getJobs()).filter((j) => j.status === 'novo' && !tried.has(j.id) && !(j.retryAt > Date.now())).slice(0, batch);
        if (!fresh.length) break;
        fresh.forEach((j) => tried.add(j.id));
        await Promise.all(fresh.map((j) => prepare(j.id)));
        refreshBadge();
      }

      // 1b) with the AI on, a few jobs to apply for on the website get its evaluation
      //     (only with nothing waiting to be sent, so no email waits for them)
      if (cfg.mode === 'ai' && cfg.aiScoreSite && !(await getJobs()).some((j) => j.status === 'fila')) await scoreSiteJobs(cfg);

      // 2) autopilot: ready jobs with enough fit go into the queue (one whose fit is unknown waits for the user,
      //    unless the minimum fit is zero)
      const s = await getSettings();
      if (s.autoSend)
        for (const j of await getJobs())
          if (j.status === 'pronto' && (j.fit != null ? j.fit >= Number(s.minFit) : Number(s.minFit) <= 0)) await patchJob(j.id, { status: 'fila', queuedAt: Date.now() });
      // 2b) autopilot on the websites: jobs with enough fit go into the application queue
      if (s.applyAuto) await queueAutoApply(s);

      // 3) send one from the queue, respecting the daily limit, and go back to step 1
      if ((await sentToday()) >= Number(s.dailyLimit)) break;
      const next = (await getJobs()).filter((j) => j.status === 'fila').sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0))[0];
      if (!next) break;
      try {
        await send(next.id, { interactive: false });
      } catch (e) {
        // A login/configuration problem is not the job's fault: keep it in the queue and warn.
        if (e.setup) {
          await pauseSending(e.message);
          break;
        }
        await patchJob(next.id, { status: 'erro', error: e.message });
      }
      await sleep(8000);
    }
  } finally {
    busy = false;
    refreshBadge();
  }
  if (again) {
    again = false;
    processQueue();
  }
}

// ---------- Website applications: LinkedIn's "Candidatura simplificada" (Easy Apply) and any site's form ----------
// The application is made on the page itself (content/apply.js), in a window the user can see, with their own
// account: LinkedIn's Easy Apply window or, on any other site, the job page's apply button and the form that
// follows, step by step, across page loads (one round per page, driven from here), new tabs and frames. Answers
// come from what the user provided (lib/answers.js) and, with an AI key, from the AI reading their resume
// (answerQuestions). What neither can answer stops the application and goes to the dashboard, to be answered
// once; so does a site that asks for a login, which only the user does. A page that says "apply by email" turns
// the job into an email one.

const applying = { running: false, stop: false, batch: false, winId: null, tabId: null, wins: new Set(), keepOpen: false, waiters: new Map(), loginHosts: new Set(), tally: null };
// How long a login wall waits for the user: in a batch the window moves on to the next site after it (the tests shorten it).
export const tuning = { loginWait: { batch: 3 * 60_000, single: 10 * 60_000 } };
const isLinkedIn = (url) => /^https:\/\/([\w-]+\.)?linkedin\.com\//.test(url || '');
const linkedinJob = (j) => j.source === 'linkedin_jobs' || isLinkedIn(j.url);
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
async function waitFor(fn, ms, step = 500) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) if (await fn()) return true;
  return false;
}

// Website applications made today: their own limit, separate from the email one.
async function appliedToday() {
  const { applyLog } = await chrome.storage.local.get('applyLog');
  return applyLog?.date === today() ? applyLog.count : 0;
}

// The page's window: a dedicated one in the foreground (the pages only build their forms when visible). The tab
// may change during an application: a site that opens its form in a new tab (LinkedIn's "Candidatar-se", for
// one) is followed there (tabs.onCreated, below).
async function openApplyTab(url) {
  if (applying.winId != null) {
    try {
      await chrome.tabs.update(applying.tabId, { url });
      await chrome.windows.update(applying.winId, { focused: true });
    } catch {
      applying.winId = null; // the user closed the window
    }
  }
  if (applying.winId == null) {
    const win = await chrome.windows.create({ url, focused: true, width: 1180, height: 920 });
    applying.winId = win.id;
    applying.tabId = win.tabs[0].id;
    applying.wins.add(win.id);
  }
  await waitComplete(applying.tabId);
  return applying.tabId;
}
chrome.tabs.onCreated.addListener((tab) => {
  if (applying.running && tab.openerTabId != null && tab.openerTabId === applying.tabId) {
    applying.tabId = tab.id;
    if (tab.windowId != null) applying.wins.add(tab.windowId);
  }
  // a tab opened from one that shows the helper card shows it too
  if (tab.openerTabId != null) siteTabs((map) => (map[tab.openerTabId] ? (map[tab.id] = { ...map[tab.openerTabId] }) : false));
});
function closeApplyWindows() {
  for (const id of applying.wins) chrome.windows.remove(id).catch(() => {});
  applying.wins.clear();
  applying.winId = null;
}

// Only the user logs in to LinkedIn: the queue stops and explains.
async function linkedinLoginCheck(tabId) {
  const { url = '' } = await chrome.tabs.get(tabId);
  if (/linkedin\.com\/(login|authwall|checkpoint|uas\/)/.test(url)) throw Object.assign(new Error('faça login no LinkedIn neste navegador e clique em Candidatar de novo'), { setup: true });
}

// Runs in the page's own world, before content/apply.js. Two things the page does that only a real click can:
// - The newer Easy Apply window only creates the file input when "Carregar currículo" (Upload resume) is clicked,
//   and opens the file picker on it right away. While content/apply.js is attaching the resume (an attribute on
//   <html>), that picker is held back and the input is marked for it to fill in instead.
// - A job page that opens its application in a new tab (window.open) would have it blocked as a popup, since no
//   one really clicked. While content/apply.js is applying, the page's own tab goes there instead.
function holdFilePicker() {
  const html = document.documentElement;
  if (html.hasAttribute('data-auto-vagas-picker')) return;
  const hold = (open) =>
    function (...args) {
      if (this.type !== 'file' || !html.hasAttribute('data-auto-vagas-upload')) return open.apply(this, args);
      this.setAttribute('data-auto-vagas-upload', '');
      if (!this.isConnected) {
        this.hidden = true;
        document.body.append(this);
      }
    };
  HTMLInputElement.prototype.click = hold(HTMLInputElement.prototype.click);
  if (HTMLInputElement.prototype.showPicker) HTMLInputElement.prototype.showPicker = hold(HTMLInputElement.prototype.showPicker);
  const open = window.open;
  window.open = function (url, ...rest) {
    if (!html.hasAttribute('data-auto-vagas-apply') || !url || /^about:/.test(String(url))) return open.call(this, url, ...rest);
    location.assign(String(url));
    return null;
  };
  html.setAttribute('data-auto-vagas-picker', '');
}

// What a frame of the page has: fields, a resume field, a password field, an apply button. Runs in each frame.
function frameProbe() {
  const shown = (el) => el.getClientRects().length > 0;
  const fields = [...document.querySelectorAll('input, select, textarea')].filter((el) => !el.disabled && !['hidden', 'submit', 'button', 'image', 'reset', 'search'].includes(el.type) && (el.type === 'file' || shown(el)));
  const texts = [...document.querySelectorAll('button, [role="button"], a[href], input[type="submit"]')].filter(shown).map((el) => (el.getAttribute('aria-label') || el.innerText || el.value || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').trim());
  return {
    fields: fields.length,
    file: fields.some((el) => el.type === 'file'),
    password: fields.some((el) => el.type === 'password'),
    apply: texts.some((t) => /^(candidat|quero me candidatar|me candidatar|apply|inscrev|postul|aplicar|enviar candidatura|submit application)/.test(t)),
  };
}
// The frame where the application is: the top frame, unless only a frame has the form (some sites embed their
// application system in one).
async function pickFrame(tabId) {
  const frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: frameProbe }).catch(() => []);
  const score = (f) => f.result.fields + (f.result.file ? 4 : 0) + (f.result.apply ? 3 : 0) + (f.result.password ? 2 : 0);
  const best = frames.filter((f) => f.result && f.frameId != null).sort((a, b) => score(b) - score(a) || a.frameId - b.frameId)[0];
  return best && score(best) > 0 ? best.frameId : 0;
}

async function runInPage(tabId, msg, frameId = 0) {
  const target = frameId ? { tabId, frameIds: [frameId] } : { tabId };
  await chrome.scripting.executeScript({ target, world: 'MAIN', func: holdFilePicker }).catch(() => {});
  await chrome.scripting.executeScript({ target, files: ['content/apply.js'] });
  return Promise.race([chrome.tabs.sendMessage(tabId, msg, frameId ? { frameId } : {}), sleep(5 * 60_000).then(() => ({ status: 'erro', error: 'tempo esgotado' }))]);
}

// Questions that stopped an application for lack of an answer: the dashboard shows them so the user answers once.
async function rememberPending(questions, job) {
  const { applyPending = [] } = await chrome.storage.local.get('applyPending');
  for (const q of questions || []) {
    const key = questionKey(q.label);
    if (!key || applyPending.some((p) => p.key === key)) continue;
    applyPending.unshift({ key, label: q.label, kind: q.kind, options: q.options || [], job: job?.title || '' });
  }
  await chrome.storage.local.set({ applyPending: applyPending.slice(0, 60) });
}

// via: 'linkedin' (Easy Apply) or 'site' (the company's site or a job board); counted: made by the extension
// (the daily limit), as opposed to reported by the user.
async function markApplied(id, { note = '', via = 'linkedin', counted = true } = {}) {
  const job = await getJob(id);
  if (!job || job.status === 'enviado') return;
  await patchJob(id, { status: 'enviado', stage: 'aguardando', sentAt: Date.now(), via, applyState: '', applyQuestions: [], error: '', ...(note && { note }) });
  if (note) return;
  if (counted) await chrome.storage.local.set({ applyLog: { date: today(), count: (await appliedToday()) + 1 } });
  if (applying.tally) applying.tally.sent++;
  await log(`Candidatura enviada ${via === 'linkedin' ? 'pelo LinkedIn' : 'no site da vaga'} — ${job.title}`);
}

// Logs a message unless it is already the latest one (the queues resume every minute).
async function logOnce(msg) {
  const { log: [last] = [] } = await chrome.storage.local.get('log');
  if (last?.msg !== msg) await log(msg);
}

// With an AI key, the AI answers the form questions the user's own answers don't cover (unless turned off).
const aiAnswersOn = (s) => s.aiAnswers !== false && !!aiKey(s);
// Acting on sites other than LinkedIn needs the optional permission for them, granted in the dashboard.
const sitesAllowed = async () => (chrome.permissions ? chrome.permissions.contains({ origins: ['https://*/*'] }).catch(() => false) : false);

// Puts jobs in the website application queue and starts it. batch: close a form that stopped and go on to the next.
async function queueApply(ids, { batch = false } = {}) {
  const { applyQueue = [] } = await chrome.storage.local.get('applyQueue');
  const fresh = ids.filter((id) => !applyQueue.includes(id));
  applying.batch = batch || applyQueue.length + fresh.length > 1;
  await chrome.storage.local.set({ applyQueue: [...applyQueue, ...fresh] });
  for (const id of fresh) await patchJob(id, { applyState: 'fila', error: '' });
  runApply();
  return fresh.length;
}

// Any job to apply for on a website: LinkedIn (Easy Apply or the company's site) or any other site.
const canApplyJob = (j) => j.status === 'sem_email' && /^https?:\/\//.test(j.url || '');

// Autopilot: jobs with the minimum fit (the AI's, when it evaluates the website jobs) go into the queue, the best
// first, up to the daily limit. Each job is tried once. Sites other than LinkedIn need the permission to act on
// them. After a login wall, a stop by the user or a closed window, the autopilot waits a few hours instead of
// opening the window again every minute.
async function queueAutoApply(s) {
  const { applyQueue = [], applyHold = 0 } = await chrome.storage.local.get(['applyQueue', 'applyHold']);
  if (Date.now() - applyHold < 3 * 3600e3) return;
  const room = (Number(s.applyDailyLimit) || 20) - (await appliedToday()) - applyQueue.length;
  if (room <= 0) return;
  const aiScores = s.mode === 'ai' && s.aiScoreSite && !!aiKey(s);
  const sites = await sitesAllowed();
  const ready = (await getJobs()).filter((j) => canApplyJob(j) && !j.applyState && !j.applyTriedAt && !applyQueue.includes(j.id) && j.fit != null && j.fit >= Number(s.minFit) && (!aiScores || j.aiDone));
  if (!sites && ready.some((j) => !linkedinJob(j))) await logOnce('Piloto automático: para candidatar também fora do LinkedIn, permita o acesso aos sites em Configurações → Candidatura no site.');
  const picks = ready.filter((j) => sites || linkedinJob(j)).sort((a, b) => b.fit - a.fit).slice(0, room);
  if (!picks.length) return;
  await log(`Piloto automático: ${picks.length} candidatura(s) na fila.`);
  await queueApply(picks.map((j) => j.id), { batch: true });
}

// Jobs that stopped for questions the user has now answered go back into the queue.
async function requeueAnswered() {
  const settings = await getSettings();
  const ready = (await getJobs()).filter(
    (j) => j.applyState === 'pendente' && j.status === 'sem_email' && j.applyQuestions?.length && j.applyQuestions.every((q) => answerFor({ ...q, required: true }, { settings, job: j }) != null)
  );
  return ready.length ? queueApply(ready.map((j) => j.id)) : 0;
}

// A login wall fell (an application went through on that site): the jobs that stopped at it go again.
async function requeueLogin(host) {
  const ids = (await getJobs()).filter((j) => j.applyState === 'login' && (!host || j.loginHost === host)).map((j) => j.id);
  applying.loginHosts.delete(host);
  return ids.length ? queueApply(ids) : 0;
}

// Answers the user gave (on the page or in the dashboard) apply to future applications; never passwords or documents.
async function learnAnswers(pairs) {
  const { applyAnswers = {} } = await getSettings();
  const { applyPending = [] } = await chrome.storage.local.get('applyPending');
  const keys = [];
  for (const { label, value } of pairs || []) {
    const key = questionKey(label);
    if (!key || !value || SECRET.test(key)) continue;
    applyAnswers[key] = value;
    keys.push(key);
  }
  await setSettings({ applyAnswers });
  await chrome.storage.local.set({ applyPending: applyPending.filter((p) => !keys.includes(p.key)) });
}

// Does the page say the application was received, with the form gone? Runs in the page. (The same notice as
// content/apply.js looks for; this one survives the page loads a submit often causes.)
function sentProbe() {
  const text = (document.body?.innerText || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').slice(0, 30000);
  const sent = /candidatura (foi )?(enviada|recebida|realizada|concluida|finalizada|registrada|efetuada)|recebemos (a )?sua candidatura|obrigad[oa] (por|pela) (se candidatar|sua candidatura|candidatar-se|se inscrever)|sua candidatura foi|inscricao (realizada|enviada|concluida)|application (has been |was )?(submitted|received|sent|complete)|thank you for (applying|your application)|thanks for applying|we('ve| have) received your application|successfully applied|you('ve| have) applied|gracias por (postularte|tu postulacion|aplicar)|postulacion (enviada|recibida)/.test(text);
  const fields = [...document.querySelectorAll('input, select, textarea')].filter((el) => !el.disabled && !['hidden', 'submit', 'button', 'checkbox', 'radio', 'search'].includes(el.type) && el.getClientRects().length > 0).length;
  return sent && fields < 4;
}
// Is the page a login (or signup) page? Runs in the page.
function loginProbe() {
  const shown = (el) => el.getClientRects().length > 0;
  if ([...document.querySelectorAll('input[type="password"]')].some(shown)) return true;
  const texts = [...document.querySelectorAll('button, [role="button"], a[href]')].filter(shown).map((el) => (el.innerText || el.getAttribute('aria-label') || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, ''));
  return texts.some((t) => /entrar com|continue with|sign in with|log ?in with|iniciar sessao com/.test(t)) && !texts.some((t) => /^(candidat|apply|inscrev|postul)/.test(t));
}

// Watches the window for the page that says the application was received (the user finishing it by hand, or a
// send that loaded another page). mark: records the job as applied. Ends when the window goes away.
async function watchSent(id, ms, { mark = true, via = 'site' } = {}) {
  const found = await waitFor(async () => {
    if ((await getJob(id))?.status === 'enviado') return true;
    const tab = await chrome.tabs.get(applying.tabId).catch(() => null);
    if (!tab) return 'gone';
    if (tab.status !== 'complete' || !/^https?:/.test(tab.url || '')) return false;
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: sentProbe }).catch(() => []);
    return !!result;
  }, ms, 2000);
  if (found !== true) return false;
  if (mark) await markApplied(id, { via });
  return true;
}
// Waits for the user to submit the form in the window: the page's own notice (content/apply.js) or a thanks page.
async function waitUserSend(id, ms) {
  const byPage = new Promise((r) => applying.waiters.set(id, r));
  const sent = await Promise.race([byPage, watchSent(id, ms, { mark: false })]);
  applying.waiters.delete(id);
  return !!sent;
}
// Waits for the user to log in: the page moves away from the login page (or stops being one). Lets them know.
async function waitLogin(id, job, loginUrl, host, ms) {
  await patchJob(id, { applyState: 'login', loginHost: host, error: `A candidatura parou no login de ${host}. Entre na sua conta na janela que abriu (ou crie uma): o resto continua sozinho.` });
  if (applying.batch) notifyUser(`Candidatura parada: faça login em ${host} na janela do Auto Vagas.`);
  const ok = await waitFor(async () => {
    if (applying.stop) return false;
    const tab = await chrome.tabs.get(applying.tabId).catch(() => null);
    if (!tab || tab.status !== 'complete' || !/^https?:/.test(tab.url || '')) return false;
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: loginProbe }).catch(() => [{ result: true }]);
    return result === false;
  }, ms, 2000);
  if (ok) await patchJob(id, { applyState: 'rodando', error: '' });
  return ok;
}
function notifyUser(message) {
  chrome.notifications.create({ type: 'basic', iconUrl: chrome.runtime.getURL('icons/128.png'), title: 'Auto Vagas', message });
}

// The application on any site, from the job page on: content/apply.js does one round per page (finds the apply
// button or the form, fills it in, moves on) and this follows the page: a new page load, a new tab, a login page
// (waits for the user) and the frame that has the form.
const NAV_ERR = /message port closed|message channel is closed|back\/forward cache|receiving end does not exist|context invalidated|frame was removed|no frame with id|no tab with id/i;
async function walkSite(id, job, base) {
  let clicked = 0;
  let acted = false; // the page moved on because of a click of ours (so a thanks page is this application's)
  for (let round = 0; round < 16; round++) {
    if (applying.stop) return { status: 'erro', error: 'interrompida', via: 'site' };
    const tabId = applying.tabId;
    if (!(await chrome.tabs.get(tabId).catch(() => null))) return { status: 'erro', error: 'a janela da candidatura foi fechada', via: 'site' };
    await waitComplete(tabId);
    await sleep(round ? 1500 : 500);
    const url = (await chrome.tabs.get(tabId).catch(() => ({}))).url || '';
    if (!/^https?:/.test(url)) return { status: 'erro', error: `não consigo agir nesta página (${url.slice(0, 40) || 'em branco'})`, via: 'site' };
    await linkedinLoginCheck(tabId);
    const host = hostOf(url);
    let res;
    try {
      res = await runInPage(tabId, { ...base, mode: 'site', clicked, acted, round }, await pickFrame(tabId));
    } catch (e) {
      if (NAV_ERR.test(e.message)) {
        acted = true; // the page moved on: next round on the new page
        continue;
      }
      const denied = /cannot access|permission|not allowed|cannot be scripted/i.test(e.message);
      return { status: 'erro', error: denied ? 'sem permissão para agir neste site: clique em “Candidatar” no painel, que pede a permissão' : e.message, permission: denied, via: 'site' };
    }
    res = { ...res, via: 'site', host };
    if (res.status === 'clicado') {
      // the apply button was clicked and nothing showed up yet: a new tab, a slow page or a dead button
      if (++clicked > 1) return { ...res, status: 'erro', error: 'cliquei no botão de candidatura e nada aconteceu', keepOpen: true };
      const moved = await waitFor(async () => applying.tabId !== tabId || (await chrome.tabs.get(tabId).catch(() => ({}))).url !== url, 5000);
      if (moved) acted = true;
      else await sleep(1500);
      continue;
    }
    if (res.status === 'login') {
      if (applying.loginHosts.has(host)) return res; // this run already waited for a login there
      if (await waitLogin(id, job, url, host, applying.batch ? tuning.loginWait.batch : tuning.loginWait.single)) {
        acted = false; // what the page shows now came from the login, not from us
        continue;
      }
      applying.loginHosts.add(host);
      return res;
    }
    return res;
  }
  return { status: 'erro', error: 'a candidatura não chegou ao fim', via: 'site' };
}

// The window stays open for the user to finish: the helper card (content/helper.js) goes in, and a thanks page
// marks the job as applied.
async function userFinishes(id) {
  const tabId = applying.tabId;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  if (!isLinkedIn(tab.url)) {
    await siteTabs((map) => (map[tabId] = { id, filled: true, stopped: true }));
    chrome.scripting.executeScript({ target: { tabId }, files: ['content/helper.js'] }).catch(() => {});
  }
  watchSent(id, 10 * 60_000);
}

// One application. Returns false when the queue must stop (the user was going to review it and did not submit).
async function applyOne(id, s) {
  const job = await getJob(id);
  if (!job || job.status === 'enviado') return true;
  // a site that asked for a login earlier in this run: no point in opening it again now
  if (applying.loginHosts.has(hostOf(job.url)) || (job.loginHost && applying.loginHosts.has(job.loginHost))) {
    const host = job.loginHost || hostOf(job.url);
    await patchJob(id, { applyState: 'login', loginHost: host, error: `A candidatura parou no login de ${host}. Entre na sua conta lá e clique em Candidatar de novo.` });
    applying.tally.login++;
    return true;
  }
  await patchJob(id, { applyState: 'rodando', applyTriedAt: Date.now(), error: '' });
  applying.keepOpen = false;
  let res;
  try {
    const tabId = await openApplyTab(job.url);
    await siteTabs((map) => (tabId in map ? delete map[tabId] : false)); // the helper card stays out while the extension acts
    await linkedinLoginCheck(tabId);
    const base = { type: 'apply:run', jobId: id, submit: !s.applyReview, batch: applying.batch, resume: await buildAttachment(job, s).catch(() => null) };
    if (linkedinJob(job) && job.easyApply !== false) {
      res = await runInPage(tabId, { ...base, mode: 'easy' });
      // no Easy Apply: the job's "Candidatar-se" leads to the company's site, and the application goes on there
      if (res?.status === 'externa') {
        await patchJob(id, { easyApply: false });
        res = await walkSite(id, job, base);
      }
    } else res = await walkSite(id, job, base);
  } catch (e) {
    if (e.setup) throw e;
    res = { status: 'erro', error: e.message };
  }
  // snapshot of the form (without answers) when it did not reach the end: helps tune the form filling
  if (res?.debug) await patchJob(id, { applyDebug: { status: res.status, at: Date.now(), ...res.debug } });
  const via = res?.via || 'linkedin';
  const tally = applying.tally;
  switch (res?.status) {
    case 'enviada':
      await markApplied(id, { via });
      if (via === 'site') await requeueLogin(res.host);
      break;
    case 'ja':
      await markApplied(id, { note: 'Você já tinha se candidatado a esta vaga.' });
      break;
    case 'revisar': {
      // filled to the end: the user reviews it and clicks Enviar (Submit) in the window
      await patchJob(id, { applyState: 'revisar' });
      applying.keepOpen = true;
      const sent = await waitUserSend(id, 10 * 60_000);
      if (!sent) return false;
      applying.keepOpen = false;
      await markApplied(id, { via });
      break;
    }
    case 'pendente': {
      const questions = (res.questions || []).filter((q) => q.kind !== 'file').map(({ label, kind, options }) => ({ label, kind, options: options || [] }));
      await rememberPending(questions, job);
      await patchJob(id, {
        applyState: 'pendente',
        applyQuestions: questions,
        error: questions.length
          ? `A candidatura parou: falta responder ${questions.map((q) => `“${q.label}”`).join(', ')}. Responda abaixo e ela recomeça sozinha.`
          : 'A candidatura parou em um campo que a extensão não soube preencher. Termine na janela que ficou aberta.',
      });
      tally.pending++;
      applying.keepOpen = !applying.batch; // outside a batch, the form stays open for the user to finish
      if (applying.keepOpen) userFinishes(id);
      break;
    }
    case 'login':
      tally.login++;
      applying.keepOpen = !applying.batch; // the login page stays for the user
      break;
    case 'email': {
      // the site asks for an application by email: the job joins the email flow
      await patchJob(id, { email: res.email, emails: [...new Set([res.email, ...(job.emails || [])])], status: 'novo', applyState: '', error: '' });
      await log(`${job.title}: a candidatura é por e-mail (${res.email}); a vaga foi para “Para revisar”.`);
      processQueue();
      break;
    }
    case 'incerto': {
      // the form went away but no page said it was received: give it a while, then leave it to the user
      applying.keepOpen = !applying.batch;
      if (await watchSent(id, applying.batch ? 20_000 : 90_000, { via })) break;
      await patchJob(id, { applyState: '', error: 'Não consegui confirmar se a candidatura foi enviada. Confira na janela; se foi, clique em “Já me candidatei”.' });
      tally.failed++;
      if (applying.keepOpen) userFinishes(id);
      break;
    }
    case 'fechada':
      await patchJob(id, { status: 'descartado', applyState: '', note: 'A vaga não aceita mais candidaturas.' });
      break;
    default: {
      await patchJob(id, { applyState: '', error: `Candidatura no site: ${res?.error || 'não foi possível concluir'}.` });
      tally.failed++;
      applying.keepOpen = !applying.batch && !!res?.keepOpen;
      if (applying.keepOpen) userFinishes(id);
    }
  }
  return true;
}

async function runApply() {
  if (applying.running) return;
  applying.running = true;
  applying.stop = false;
  applying.loginHosts = new Set();
  applying.tally = { sent: 0, pending: 0, login: 0, failed: 0 };
  let s;
  try {
    for (;;) {
      const { applyQueue = [] } = await chrome.storage.local.get('applyQueue');
      if (!applyQueue.length || applying.stop) break;
      s = await getSettings();
      const limit = Number(s.applyDailyLimit) || 20;
      if ((await appliedToday()) >= limit) {
        // the queue resumes every minute: log it only once
        await logOnce(`Candidaturas pelo site: limite de ${limit} por dia atingido; as demais ficam na fila para amanhã.`);
        break;
      }
      const [id] = applyQueue;
      let go;
      try {
        go = await applyOne(id, s);
      } catch (e) {
        // without a login there is no point in retrying: empty the queue and warn (the autopilot waits a few hours)
        await chrome.storage.local.set({ applyQueue: [], applyHold: Date.now() });
        for (const queued of applyQueue) await patchJob(queued, { applyState: '', ...(queued === id && { error: `Candidatura no LinkedIn: ${e.message}.` }) });
        await log(`Candidaturas pelo site pausadas: ${e.message}.`);
        break;
      }
      const { applyQueue: now = [] } = await chrome.storage.local.get('applyQueue');
      await chrome.storage.local.set({ applyQueue: now.filter((x) => x !== id) });
      if (!go) break;
      if (now.length > 1 && !applying.stop) await sleep(6000 + Math.random() * 8000); // no rush between applications
    }
  } finally {
    applying.running = false;
    refreshBadge();
    if (!applying.keepOpen) closeApplyWindows();
    const t = applying.tally;
    // a batch the user may not be watching: what it did, and what waits for them
    if (applying.batch && s?.notify !== false && (t.pending || t.login || t.sent > 1))
      notifyUser(
        [t.sent && `${t.sent} candidatura(s) enviada(s)`, t.pending && `${t.pending} esperando resposta sua`, t.login && `${t.login} esperando o seu login`, t.failed && `${t.failed} não concluída(s)`].filter(Boolean).join(' · ') + '. Clique para ver.'
      );
  }
}

// ---------- The helper card (content/helper.js) ----------
// When an application stops with the window open (a question for the user, a form to finish, a send not
// confirmed), the tab gets the card: it offers to fill in the form again and, on a thanks page, marks the job as
// applied. The tabs that one opens get it too. tab -> { id: the job, filled, stopped }. Per browser session: tab
// ids don't survive a restart.
let siteChain = Promise.resolve();
function siteTabs(change) {
  const p = siteChain.then(async () => {
    const { siteTabs: map = {} } = await chrome.storage.session.get('siteTabs');
    if (change && change(map) !== false) await chrome.storage.session.set({ siteTabs: map });
    return map;
  });
  siteChain = p.catch(() => {});
  return p;
}
chrome.tabs.onRemoved.addListener((tabId) => {
  siteTabs((map) => (tabId in map ? delete map[tabId] : false));
  if (applying.running && tabId === applying.tabId && applying.batch) chrome.storage.local.set({ applyHold: Date.now() }); // the user closed it: the autopilot waits
});
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  const entry = (await siteTabs())[tabId];
  // LinkedIn has its own way (Easy Apply): there the helper would only get in the way
  if (!entry || isLinkedIn(tab.url)) return;
  chrome.scripting.executeScript({ target: { tabId }, files: ['content/helper.js'] }).catch(() => {});
});

// Fills in the forms of a tab, frames included (some application systems are embedded in the company's page):
// content/apply.js goes into each frame that has fields.
async function fillTab(tabId, msg) {
  const probe = await chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, func: () => document.querySelectorAll('input:not([type=hidden]), select, textarea').length })
    .catch(() => []);
  const frames = probe.filter((r) => r.result > 0).map((r) => r.frameId);
  if (!frames.length) frames.push(0);
  let filled = 0;
  const questions = [];
  for (const frameId of frames) {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['content/apply.js'] });
    const res = await Promise.race([chrome.tabs.sendMessage(tabId, { type: 'apply:run', mode: 'fill', ...msg }, { frameId }), sleep(3 * 60_000).then(() => null)]);
    filled += res?.filled || 0;
    questions.push(...(res?.questions || []));
  }
  return { filled, questions };
}

// The job of a tab and what the form filling needs for it (with no job, only the person's data).
async function siteFill(tab) {
  const s = await getSettings();
  const entry = (await siteTabs())[tab.id];
  const job = entry ? await getJob(entry.id) : null;
  const res = await fillTab(tab.id, { jobId: job?.id, resume: await buildAttachment(job, s).catch(() => null) });
  if (entry) await siteTabs((map) => (map[tab.id] ? (map[tab.id].filled = true) : false));
  await rememberPending(res.questions, job || { title: tab.title });
  return { filled: res.filled, unknown: res.questions.map((q) => q.label), ai: aiAnswersOn(s) };
}

// ---------- Messages (content script, popup and dashboard) ----------

const handlers = {
  jobsFound: (m) => addJobs(m.jobs, scan.keyword),
  capture: (m) => addJobs([m.job], 'captura'),
  openDashboard,
  scanNow: () => {
    runScan();
  },
  scanStop: () => {
    scan.stop = true;
  },
  // The search page is hidden behind another window and does not load the lists: bring the window to the front.
  scanHidden: async () => {
    if (!scan.winId) return;
    scan.stoleFocus = true;
    await chrome.windows.update(scan.winId, { focused: true });
  },
  version: () => ({ build: BUILD }),
  'settings:changed': async () => {
    await setupAlarms();
    recalcFit();
    retryFailed();
  },
  'ai:models': async (m) => ({ entry: await workingModels(await getSettings(), !!m.force) }),
  'gmail:connect': async () => {
    const s = await getSettings();
    await connectGmail(s.gmailClientId, s.email);
    processQueue(); // whatever was held up for lack of a login starts going out again
  },
  'gmail:test': async () => {
    const s = await getSettings();
    if (!s.email) throw new Error('Preencha seu e-mail no passo 1 para receber o teste.');
    const token = await getToken(s.gmailClientId, true, s.email);
    const attachment = await buildAttachment(null, s).catch(() => undefined);
    await sendEmail(token, { to: s.email, subject: 'Teste do Auto Vagas', body: 'Se você recebeu este e-mail, o envio está funcionando.', attachment });
  },
  // ---- website application ----
  'apply:start': async (m) => {
    await chrome.storage.local.remove('applyHold'); // the user is here: the autopilot may try again too
    return { queued: await queueApply(m.ids) };
  },
  'apply:stop': async () => {
    applying.stop = true;
    const { applyQueue = [] } = await chrome.storage.local.get('applyQueue');
    await chrome.storage.local.set({ applyQueue: [], applyHold: Date.now() }); // the autopilot doesn't refill it right away
    for (const id of applyQueue) if ((await getJob(id))?.applyState === 'fila') await patchJob(id, { applyState: '' });
  },
  // the user logged in on a site: the jobs that stopped at its login go again (all of them, with no host)
  'apply:retryLogin': async (m) => {
    await chrome.storage.local.remove('applyHold');
    return { queued: await requeueLogin(m.host || '') };
  },
  // the page asks what to put in each field: the user's own answers first, then the AI for the rest
  'apply:answers': async (m) => {
    const settings = await getSettings();
    const job = m.jobId ? await getJob(m.jobId) : null;
    const answers = m.questions.map((q) => answerFor(q, { settings, job }));
    // a long list of options (countries, states) is personal data the resume doesn't have
    const open = m.questions
      .map((q, i) => ({ ...q, i }))
      .filter((q) => answers[q.i] == null && !['checkbox', 'file'].includes(q.kind) && !SECRET.test(questionKey(q.label)) && (q.options?.length || 0) <= 40);
    if (open.length && aiAnswersOn(settings)) {
      try {
        const got = await withAi(async (ai) => answerQuestions(ai, job, open, await getResumePdf()));
        const used = [];
        open.forEach((q, k) => {
          if (!got[k]) return;
          answers[q.i] = got[k].value;
          used.push({ q: q.label, a: got[k].value, why: got[k].why, ...(got[k].absent && { absent: true }) });
        });
        // shown with the job, so the user can check (and correct) what the AI answered
        if (job && used.length) {
          const now = await getJob(job.id);
          await patchJob(job.id, { applyAi: [...(now?.applyAi || []).filter((x) => !used.some((u) => u.q === x.q)), ...used].slice(-30) });
        }
      } catch (e) {
        await logOnce(`A IA não respondeu as perguntas do formulário: ${e.message}`);
      }
    }
    return { answers };
  },
  // the user answered by hand on the page: it applies to future applications
  'apply:learn': (m) => learnAnswers(m.pairs),
  // answers typed in the dashboard: saved, and the jobs that stopped waiting for them go back into the queue
  'apply:answer': async (m) => {
    await learnAnswers(m.pairs);
    return { queued: await requeueAnswered() };
  },
  // on the page, the user finished an application that had stopped
  'apply:done': async (m) => {
    const waiting = applying.waiters.get(m.jobId);
    if (waiting) waiting(true);
    else await markApplied(m.jobId);
  },
  // the popup's "Preencher esta página" (Fill this page) button: any form, without clicking anything
  'apply:fill': async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('Abra a página do formulário e clique de novo.');
    try {
      return await siteFill(tab);
    } catch {
      throw new Error('Não consegui mexer nesta página (páginas internas do navegador não são permitidas).');
    }
  },
  // ---- the helper card on a page where an application stopped ----
  'site:job': async (_m, sender) => {
    const entry = (await siteTabs())[sender.tab?.id];
    const job = entry && (await getJob(entry.id));
    return { job: job ? { title: job.title, company: job.company, sent: job.status === 'enviado' } : null, filled: !!entry?.filled, stopped: !!entry?.stopped };
  },
  'site:fill': (_m, sender) => siteFill(sender.tab),
  // the page says the application was received, or the user says it was sent
  'site:sent': async (_m, sender) => {
    const entry = (await siteTabs())[sender.tab?.id];
    if (entry) await markApplied(entry.id, { via: 'site', counted: false });
    return { marked: !!entry };
  },
  'resume:analyze': async () => {
    const r = await withAi(async (ai) => analyzeResume(ai, await getResumePdf()));
    const s = await getSettings(); // as it is now: the user may have typed something while the AI read
    // nothing is replaced by an empty answer; the resume text only by a transcription that keeps its facts
    await setSettings({
      ...(r.resume_text && { resumeText: r.resume_text }),
      ...(r.skills.length && { skills: r.skills.join(', ') }),
      name: s.name || r.name,
      email: s.email || r.email,
      location: s.location || r.location,
      keywords: s.keywords || r.job_titles.join('\n'),
    });
    recalcFit(); // a new resume text or skills change the local fit
    return { keptOwnText: r.keptOwnText, skills: r.skills.length };
  },
  'job:patch': async (m) => {
    const before = await getJob(m.id);
    await patchJob(m.id, m.patch);
    // a job with no email that got an address enters the review flow
    if (before?.status === 'sem_email' && m.patch.email) {
      await patchJob(m.id, { status: before.subject ? 'pronto' : 'novo' });
      processQueue();
    }
    refreshBadge();
  },
  'job:send': (m) => send(m.id, { interactive: true }).finally(refreshBadge),
  'job:queue': async (m) => {
    for (const id of m.ids) await patchJob(id, { status: 'fila', queuedAt: Date.now() });
    processQueue();
  },
  'job:regen': (m) => prepare(m.id, { forceAi: true }),
  'job:followup': (m) => followUp(m.id, m.body),
  'jobs:remove': async (m) => {
    await removeJobs(m.ids);
    refreshBadge();
  },
  'jobs:wipe': async () => {
    const keys = (await chrome.storage.local.getKeys()).filter((k) => k.startsWith(JOB_PREFIX));
    await chrome.storage.local.remove([...keys, 'seenJobs', 'liScanAt', 'applyQueue']); // the next search reads everything again
    refreshBadge();
  },
  // Starts over: the open jobs go away, the ads already read are forgotten and a search runs. Sent and archived
  // jobs stay (and keep an ad from coming back as new).
  'scan:reset': async () => {
    if (scan.running) throw new Error('Espere a busca atual terminar (ou pare-a) e tente de novo.');
    const open = (await getJobs()).filter((j) => ['novo', 'pronto', 'fila', 'erro', 'sem_email'].includes(j.status));
    const ids = new Set(open.map((j) => j.id));
    await removeJobs([...ids]);
    const { applyQueue = [] } = await chrome.storage.local.get('applyQueue');
    await chrome.storage.local.set({ applyQueue: applyQueue.filter((id) => !ids.has(id)) });
    await chrome.storage.local.remove(['seenJobs', 'liScanAt']);
    refreshBadge();
    await log(`Busca do zero: ${open.length} vaga(s) em aberto apagada(s); os anúncios já lidos entram de novo.`);
    runScan();
    return { removed: open.length };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const h = handlers[msg?.type];
  if (!h) return;
  Promise.resolve()
    .then(() => h(msg, sender))
    .then(
      (r) => respond({ ok: true, ...(r || {}) }),
      (e) => respond({ ok: false, error: e.message })
    );
  return true;
});
