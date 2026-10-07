import { getSettings, setSettings, getJobs, getJob, putJobs, patchJob, removeJobs, log, hashId, fillTemplate, JOB_PREFIX } from './lib/store.js';
import { tailor, analyzeResume, providerOf, aiKey, discoverModels } from './lib/ai.js';
import { getToken, connectGmail, sendEmail } from './lib/gmail.js';
import { textToPdf, pdfToB64 } from './lib/pdf.js';
import { extractTags, localFit, normKey } from './lib/match.js';
import { BUILD } from './lib/build.js';
import { resolvePlace, WORLD } from './lib/linkedin.js';
import { SOURCES, searchTerms, relevant, inTitle, tooOld } from './lib/sources.js';
import { answerFor, questionKey } from './lib/answers.js';

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
  if (reason === 'update') retryFailed(true);
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
  // mentions the term only in passing and has little to do with the resume
  const fit = localFit(text, s.resumeText, s.skills);
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
      const base = { geoId: place.geoId, country: countryOf(place), remoteOnly: s.remoteOnly, max };
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
      await log(`Busca em ${Math.round((Date.now() - started) / 1000)} s — ${terms.length} termo(s), ${place.name}: ${parts.join(' · ')}.`);
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
    const m = localFit(`${f.title}\n${f.description}`, s.resumeText, s.skills);
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

// Resume or skills changed: recomputes the local fit of open jobs (the score given by the AI is kept).
let fitBasis = null;
async function recalcFit() {
  const s = await getSettings();
  const basis = hashId(`${s.resumeText}|${s.skills}`);
  if (basis === fitBasis) return;
  fitBasis = basis;
  for (const j of await getJobs()) {
    if (j.aiDone || ['enviado', 'descartado', 'ignorado'].includes(j.status)) continue;
    const m = localFit(`${j.title}\n${j.description}`, s.resumeText, s.skills) || { fit: null, matched: null, missing: null };
    if ((j.fit ?? null) !== m.fit || (j.matched || []).join() !== (m.matched || []).join()) await patchJob(j.id, m);
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

async function prepare(id, { forceAi = false } = {}) {
  const s = await getSettings();
  const job = await getJob(id);
  if (!job) return;
  let patch;
  if (s.mode === 'ai' || forceAi) {
    try {
      const r = await withAi(async (ai) => tailor(ai, job, await getResumePdf()));
      patch = r.is_job_posting
        ? {
            subject: r.subject, body: r.body, resumeText: r.resume, fit: r.fit, note: r.reason,
            strengths: r.strengths, gaps: r.gaps, aiDone: true, error: '',
            status: job.email ? (job.status === 'enviado' ? 'enviado' : 'pronto') : 'sem_email',
          }
        : { status: 'ignorado', note: r.reason || 'A IA avaliou que não é um anúncio de vaga.', error: '' };
    } catch (e) {
      // A manual "Adaptar com IA" (Tailor with AI) leaves the job where it is; it only shows the error.
      patch = forceAi && job.status !== 'novo' ? { error: e.message } : { status: 'erro', error: e.message, errorBasis: aiBasis(s) };
    }
  } else {
    patch = { subject: fillTemplate(s.subjectTemplate, job, s), body: fillTemplate(s.bodyTemplate, job, s), status: job.email ? 'pronto' : 'sem_email', error: '' };
  }
  await patchJob(id, patch);
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
        const fresh = (await getJobs()).filter((j) => j.status === 'novo' && !tried.has(j.id)).slice(0, batch);
        if (!fresh.length) break;
        fresh.forEach((j) => tried.add(j.id));
        await Promise.all(fresh.map((j) => prepare(j.id)));
        refreshBadge();
      }

      // 2) autopilot: ready jobs with enough fit go into the queue
      const s = await getSettings();
      if (s.autoSend)
        for (const j of await getJobs())
          if (j.status === 'pronto' && (j.fit == null || j.fit >= Number(s.minFit))) await patchJob(j.id, { status: 'fila', queuedAt: Date.now() });

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

// ---------- Website applications: LinkedIn's "Candidatura simplificada" (Easy Apply) and forms ----------
// The form is filled in on the page itself (content/apply.js), in a window the user can see, with their own
// account. Answers come only from what they provided (lib/answers.js): an unanswered question stops the
// application and goes to the dashboard, to be answered once.

const applying = { running: false, stop: false, batch: false, winId: null, tabId: null, keepOpen: false, waiters: new Map() };

// Website applications made today: their own limit, separate from the email one.
async function appliedToday() {
  const { applyLog } = await chrome.storage.local.get('applyLog');
  return applyLog?.date === today() ? applyLog.count : 0;
}

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
    // dedicated window in the foreground: the page only builds the form when it is visible
    const win = await chrome.windows.create({ url, focused: true, width: 1180, height: 920 });
    applying.winId = win.id;
    applying.tabId = win.tabs[0].id;
  }
  await waitComplete(applying.tabId);
  return applying.tabId;
}

// Runs in the page's own world. The newer Easy Apply window only creates the file input when "Carregar currículo"
// (Upload resume) is clicked, and opens the file picker on it right away. While content/apply.js is attaching the
// resume (an attribute on <html>), that picker is held back and the input is marked for it to fill in instead.
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
  html.setAttribute('data-auto-vagas-picker', '');
}

async function runInPage(tabId, msg) {
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: holdFilePicker }).catch(() => {});
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/apply.js'] });
  return Promise.race([chrome.tabs.sendMessage(tabId, msg), sleep(5 * 60_000).then(() => ({ status: 'erro', error: 'tempo esgotado' }))]);
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

async function markApplied(id, note = '') {
  const job = await getJob(id);
  if (!job || job.status === 'enviado') return;
  await patchJob(id, { status: 'enviado', stage: 'aguardando', sentAt: Date.now(), via: 'linkedin', applyState: '', error: '', ...(note && { note }) });
  if (!note) {
    await chrome.storage.local.set({ applyLog: { date: today(), count: (await appliedToday()) + 1 } });
    await log(`Candidatura enviada pelo LinkedIn — ${job.title}`);
  }
}

// One application. Returns false when the queue must stop (the user was going to review it and did not submit).
async function applyOne(id, s) {
  const job = await getJob(id);
  if (!job || job.status === 'enviado') return true;
  await patchJob(id, { applyState: 'rodando', error: '' });
  applying.keepOpen = false;
  let res;
  try {
    const tabId = await openApplyTab(job.url);
    const { url = '' } = await chrome.tabs.get(tabId);
    if (/linkedin\.com\/(login|authwall|checkpoint|uas\/)/.test(url)) throw Object.assign(new Error('faça login no LinkedIn neste navegador e clique em Candidatar de novo'), { setup: true });
    res = await runInPage(tabId, { type: 'apply:run', mode: 'easy', jobId: id, submit: !s.applyReview, batch: applying.batch, resume: await buildAttachment(job, s).catch(() => null) });
  } catch (e) {
    if (e.setup) throw e;
    res = { status: 'erro', error: e.message };
  }
  // snapshot of the form (without answers) when it did not reach the end: helps tune the form filling
  if (res?.debug) await patchJob(id, { applyDebug: { status: res.status, at: Date.now(), ...res.debug } });
  switch (res?.status) {
    case 'enviada':
      await markApplied(id);
      break;
    case 'ja':
      await markApplied(id, 'Você já tinha se candidatado a esta vaga no LinkedIn.');
      break;
    case 'revisar': {
      // filled to the end: the user reviews it and clicks Enviar (Submit) in the LinkedIn window
      await patchJob(id, { applyState: 'revisar' });
      applying.keepOpen = true;
      const sent = await Promise.race([new Promise((r) => applying.waiters.set(id, r)), sleep(10 * 60_000).then(() => false)]);
      applying.waiters.delete(id);
      if (!sent) return false;
      applying.keepOpen = false;
      await markApplied(id);
      break;
    }
    case 'pendente':
      await rememberPending(res.questions, job);
      await patchJob(id, { applyState: 'pendente', error: `Falta responder: ${(res.questions || []).map((q) => `“${q.label}”`).join(', ') || 'um campo do formulário'}. Responda em Configurações → Candidatura no site e clique em Candidatar de novo.` });
      applying.keepOpen = !applying.batch; // outside a batch, the form stays open for the user to finish
      break;
    case 'externa':
      await patchJob(id, { easyApply: false, applyState: '', error: 'Esta vaga não tem candidatura simplificada: a candidatura é feita no site da empresa.' });
      break;
    case 'fechada':
      await patchJob(id, { status: 'descartado', applyState: '', note: 'A vaga não aceita mais candidaturas.' });
      break;
    default:
      await patchJob(id, { applyState: '', error: `Candidatura no LinkedIn: ${res?.error || 'não foi possível concluir'}.` });
  }
  return true;
}

async function runApply() {
  if (applying.running) return;
  applying.running = true;
  applying.stop = false;
  try {
    for (;;) {
      const { applyQueue = [] } = await chrome.storage.local.get('applyQueue');
      if (!applyQueue.length || applying.stop) break;
      const s = await getSettings();
      const limit = Number(s.applyDailyLimit) || 20;
      if ((await appliedToday()) >= limit) {
        // the queue resumes every minute: log it only once
        const msg = `Candidaturas pelo site: limite de ${limit} por dia atingido; as demais ficam na fila para amanhã.`;
        const { log: [last] = [] } = await chrome.storage.local.get('log');
        if (last?.msg !== msg) await log(msg);
        break;
      }
      const [id] = applyQueue;
      let go;
      try {
        go = await applyOne(id, s);
      } catch (e) {
        // without a login there is no point in retrying: empty the queue and warn
        await chrome.storage.local.set({ applyQueue: [] });
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
    if (applying.winId != null && !applying.keepOpen) {
      chrome.windows.remove(applying.winId).catch(() => {});
      applying.winId = null;
    }
  }
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
    const { applyQueue = [] } = await chrome.storage.local.get('applyQueue');
    const ids = m.ids.filter((id) => !applyQueue.includes(id));
    applying.batch = applyQueue.length + ids.length > 1;
    await chrome.storage.local.set({ applyQueue: [...applyQueue, ...ids] });
    for (const id of ids) await patchJob(id, { applyState: 'fila', error: '' });
    runApply();
    return { queued: ids.length };
  },
  'apply:stop': async () => {
    applying.stop = true;
    const { applyQueue = [] } = await chrome.storage.local.get('applyQueue');
    await chrome.storage.local.set({ applyQueue: [] });
    for (const id of applyQueue) if ((await getJob(id))?.applyState === 'fila') await patchJob(id, { applyState: '' });
  },
  // the page asks what to put in each field
  'apply:answers': async (m) => {
    const settings = await getSettings();
    const job = m.jobId ? await getJob(m.jobId) : null;
    return { answers: m.questions.map((q) => answerFor(q, { settings, job })) };
  },
  // the user answered by hand on the page: it applies to future applications
  'apply:learn': async (m) => {
    const { applyAnswers = {} } = await getSettings();
    const { applyPending = [] } = await chrome.storage.local.get('applyPending');
    const keys = [];
    for (const { label, value } of m.pairs) {
      const key = questionKey(label);
      if (!key || !value) continue;
      applyAnswers[key] = value;
      keys.push(key);
    }
    await setSettings({ applyAnswers });
    await chrome.storage.local.set({ applyPending: applyPending.filter((p) => !keys.includes(p.key)) });
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
    const s = await getSettings();
    let res;
    try {
      res = await runInPage(tab.id, { type: 'apply:run', mode: 'fill', resume: await buildAttachment(null, s).catch(() => null) });
    } catch {
      throw new Error('Não consegui mexer nesta página (páginas internas do navegador não são permitidas).');
    }
    await rememberPending(res?.questions, { title: tab.title });
    return { filled: res?.filled || 0, unknown: (res?.questions || []).map((q) => q.label) };
  },
  'resume:analyze': async () => {
    const s = await getSettings();
    const r = await withAi(async (ai) => analyzeResume(ai, await getResumePdf()));
    await setSettings({
      resumeText: r.resume_text,
      skills: r.skills.join(', '),
      name: s.name || r.name,
      email: s.email || r.email,
      location: s.location || r.location,
      keywords: s.keywords || r.job_titles.join('\n'),
    });
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
    await chrome.storage.local.remove(keys);
    refreshBadge();
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  const h = handlers[msg?.type];
  if (!h) return;
  Promise.resolve()
    .then(() => h(msg))
    .then(
      (r) => respond({ ok: true, ...(r || {}) }),
      (e) => respond({ ok: false, error: e.message })
    );
  return true;
});
