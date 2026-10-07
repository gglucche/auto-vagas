// Integration test of the background (service worker) outside Chrome, with the chrome.* API mocked.
// Covers: job intake, deduplication, preparation (template and AI), sending through the Gmail API,
// follow-up, autopilot and scanning. No real network is used.
//
//   node dev/test.mjs [path-to-a-resume.pdf]
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- mocked chrome.* ----------
const data = {};
const ev = () => {
  const fns = [];
  return { addListener: (f) => fns.push(f), fns };
};
const onMessage = ev(), onInstalled = ev(), onAlarm = ev();
const calls = { notifications: [], badge: [], tabsCreated: [], windows: 0 };
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
globalThis.chrome = {
  storage: {
    local: {
      async get(q) {
        const keys = q == null ? Object.keys(data) : typeof q === 'string' ? [q] : Array.isArray(q) ? q : Object.keys(q);
        return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, clone(data[k])]));
      },
      async getKeys() { return Object.keys(data); },
      async set(o) { for (const [k, v] of Object.entries(o)) data[k] = clone(v); },
      async remove(k) { for (const key of [].concat(k)) delete data[key]; },
    },
    onChanged: ev(),
  },
  runtime: { getURL: (p) => 'chrome-extension://teste/' + p, onInstalled, onStartup: ev(), onMessage, openOptionsPage: async () => {} },
  alarms: { create() {}, clear: async () => true, onAlarm },
  action: { setBadgeText: (o) => calls.badge.push(o.text), setBadgeBackgroundColor() {} },
  notifications: { create: (o) => calls.notifications.push(o.message), onClicked: ev() },
  tabs: {
    query: async () => [],
    create: async (o) => calls.tabsCreated.push(o.url),
    update: async () => {},
    get: async () => ({ status: 'complete' }),
    sendMessage: async () => ({ ok: true, count: 0 }),
  },
  windows: { create: async () => ({ id: ++calls.windows, tabs: [{ id: 1 }] }), remove: async () => {}, update: async () => {}, getLastFocused: async () => ({ id: 99 }) },
  i18n: { getUILanguage: () => 'pt-BR' },
  identity: {
    getRedirectURL: () => 'https://teste.chromiumapp.org/',
    launchWebAuthFlow: async (o) => {
      // like the browser: only one login window at a time; silent login is not affected
      if (o.interactive && auth.windowOpen) throw new Error('Only one web auth flow is allowed at a time.');
      auth.flows.push(o);
      const back = auth.answer(o);
      if (back == null) throw new Error(o.interactive ? 'The user did not approve access.' : 'User interaction required.');
      return 'https://teste.chromiumapp.org/' + back;
    },
  },
};
// Mocked Google login: answer returns the tail of the redirect URL, or null if the window closed / nothing came back;
// config is what Google thinks of the OAuth client ('ok' or the error code shown on its page).
const granted = '#access_token=TOKEN_TESTE&expires_in=3600';
const auth = { flows: [], answer: () => granted, config: 'ok', asked: [], windowOpen: false };
const authErrorPage = (code) =>
  'https://accounts.google.com/signin/oauth/error?authError=' +
  encodeURIComponent(Buffer.from(`\n${String.fromCharCode(code.length)}${code}\x12\x10texto para humanos`, 'latin1').toString('base64')) +
  '&client_id=x';

// ---------- mocked network ----------
const net = { gmail: [], ai: [], li: [], boards: [], gmailOff: false, aiOff: false, liLimited: false, aiDirty: false, onEval: null };
// The AI's answers, one per task. The evaluation lists requirements with evidence; one of them ("Kubernetes")
// claims a quote that is not in the resume, which must count only in part.
const req = (requisito, tipo, evidencia, atende) => ({ requisito, tipo, evidencia, atende });
const aiEval = {
  is_job_posting: true,
  requisitos: [
    req('Oracle APEX', 'obrigatorio', 'Desenvolvedor Oracle APEX com experiência em PL/SQL', 'sim'),
    req('PL/SQL', 'obrigatorio', 'experiência em PL/SQL', 'sim'),
    req('JavaScript', 'obrigatorio', 'JavaScript, jQuery', 'sim'),
    req('Kubernetes', 'obrigatorio', 'Kubernetes em produção', 'sim'),
    req('Delphi', 'desejavel', '', 'nao'),
  ],
  area: 'mesma', nivel: 'compativel', resumo: 'Boa aderência.',
};
const aiEvalLow = { ...aiEval, requisitos: [req('Spark', 'obrigatorio', '', 'nao'), req('Hadoop', 'obrigatorio', '', 'nao'), req('Oracle APEX', 'desejavel', 'Oracle APEX', 'sim')], area: 'outra', resumo: 'Outra área.' };
const aiAnswer = {
  subject: 'Assunto escrito pela IA',
  body: 'Olá,\n\nTenho interesse na vaga de desenvolvedor Oracle APEX e acredito que posso contribuir com o time. Trabalho com Oracle APEX e PL/SQL há alguns anos, além de JavaScript e jQuery nas telas, e faço integrações com APIs REST no dia a dia. Também participo de times que usam Scrum e gosto de entender o negócio antes de propor uma solução. Fico à disposição para conversar sobre a vaga e sobre como posso ajudar.\n\nAtenciosamente,',
  resume: 'Fulano de Tal\neu@meu-email.example\n# Resumo\nDesenvolvedor Oracle APEX com experiência em PL/SQL, JavaScript, jQuery, REST e integrações.\n# Experiência\n- Oracle APEX e PL/SQL\n- JavaScript e jQuery nas telas',
};
// what a weak model writes first: markdown, a placeholder and a technology the resume doesn't have
const aiAnswerDirty = {
  subject: '**Candidatura – [Nome da vaga]**',
  body: aiAnswer.body.replace('Olá,', 'Olá [Nome do Recrutador],'),
  resume: 'Aqui está o currículo adaptado:\n```\n**Fulano de Tal**\n## Resumo\nDesenvolvedor Oracle APEX com experiência em PL/SQL e Kubernetes.\n## Experiência\n• Oracle APEX e PL/SQL 🚀\n```',
};
const aiTask = (body) => {
  const system = body.messages[0].content;
  return /recrutador experiente/.test(system) ? 'eval' : /escreve a candidatura/.test(system) ? 'write' : /extrai dados/.test(system) ? 'profile' : 'probe';
};
// The AI provider's catalog as the free key sees it: not everything listed can be used.
const catalog = [
  { id: 'llama-3.3-70b-versatile', context_window: 131072 }, // Enterprise plan only: 404 for this key
  { id: 'openai/gpt-oss-120b', context_window: 131072 },
  { id: 'openai/gpt-oss-20b', context_window: 131072 }, // per-minute quota exceeded: 429
  { id: 'qwen/qwen3.8-27b', context_window: 131072 },
  { id: 'modelo-tagarela-40b', context_window: 8192 }, // answers, but not in JSON
  { id: 'whisper-large-v3' },
  { id: 'meta-llama/llama-prompt-guard-2-86m' },
  { id: 'openai/gpt-oss-safeguard-20b' },
];
const reply = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url.startsWith('https://gmail.googleapis.com/')) {
    if (net.gmailOff)
      return reply(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Gmail API has not been used in project 123 before or it is disabled. Enable it by visiting the console then retry.' } });
    net.gmail.push({ url, init });
    return reply(200, { id: 'm' + net.gmail.length, threadId: 'thread1' });
  }
  // LinkedIn public search: place -> region code, list in pages of 10, and each job's details
  if (url.startsWith('https://www.linkedin.com/jobs-guest/')) {
    const u = new URL(url);
    const page = (status, text) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => text });
    net.li.push({ path: u.pathname, params: u.searchParams, init });
    if (net.liLimited) return page(429, '');
    if (u.pathname.endsWith('/typeaheadHits'))
      return page(200, JSON.stringify(/brasil/i.test(u.searchParams.get('query')) ? [{ id: '106057199', displayName: 'Brasil' }, { id: '104413988', displayName: 'Brasília, Distrito Federal, Brasil' }] : []));
    if (u.pathname.endsWith('/search')) {
      const start = Number(u.searchParams.get('start'));
      const ids = start === 0 ? [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010] : start === 10 ? [1011, 1012, 1013] : [];
      return page(200, ids.map((id) => `<li><div class="base-card" data-entity-urn="urn:li:jobPosting:${id}"><h3 class="base-search-card__title"> Vaga LinkedIn ${id} </h3><h4 class="base-search-card__subtitle"><a href="#">Empresa LI ${id}</a></h4><span class="job-search-card__location">São Paulo, SP</span></div></li>`).join('\n'));
    }
    const id = u.pathname.split('/').pop();
    return page(200, `<h2 class="top-card-layout__title topcard__title">Desenvolvedor Oracle APEX ${id}</h2><a class="topcard__org-name-link" href="#"> Empresa LI ${id} </a><span class="topcard__flavor topcard__flavor--bullet">Campinas, SP</span>
      <div class="show-more-less-html__markup relative"><p>Vaga remota para Oracle APEX e PL/SQL &amp; JavaScript.</p><ul><li>Requisito: Git</li><li>Diferencial: Delphi</li></ul>${id === '1002' ? '<p>Envie seu currículo para vagas@empresa-li.example</p>' : ''}</div><button class="show-more-less-html__button">ver mais</button>
      <span class="description__job-criteria-text">Pleno-sênior</span><span class="description__job-criteria-text">Tempo integral</span>`);
  }
  // job sites queried directly (lib/sources.js): small responses, in each site's real format
  if (/^https:\/\/(portal\.gupy\.io|www\.infojobs\.com\.br|www\.vagas\.com\.br|api\.remotar\.com\.br|himalayas\.app)\//.test(url)) {
    const u = new URL(url);
    const page = (text) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => text });
    const term = decodeURIComponent(u.pathname.split('term=')[1] || u.searchParams.get('palabra') || u.searchParams.get('search') || u.searchParams.get('q') || u.pathname);
    const apex = /apex/i.test(term);
    const recent = new Date(Date.now() - 3 * 86400e3).toISOString();
    const posting = (o) => `<html><script type="application/ld+json">${JSON.stringify({ '@context': 'http://schema.org', '@type': 'JobPosting', datePosted: recent, ...o })}</script></html>`;
    net.boards.push({ host: u.hostname, path: u.pathname, init });
    if (u.hostname === 'portal.gupy.io') {
      const list = [
        { id: 1, name: 'Desenvolvedor Oracle APEX', careerPageName: 'Certsys', description: 'Atuação remota com Oracle APEX e PL/SQL. Git.', publishedDate: recent, workplaceType: 'remote', city: '', state: '', jobUrl: 'https://certsys.gupy.io/job/1' },
        { id: 2, name: 'Desenvolvedor Oracle APEX', careerPageName: 'Fábrica', description: 'Oracle APEX e PL/SQL.', publishedDate: recent, workplaceType: 'on-site', city: 'Manaus', state: 'Amazonas', jobUrl: 'https://fabrica.gupy.io/job/2' },
        { id: 3, name: 'Consultor Oracle APEX', careerPageName: 'Velha', description: 'Oracle APEX, remoto.', publishedDate: new Date(Date.now() - 200 * 86400e3).toISOString(), workplaceType: 'remote', jobUrl: 'https://velha.gupy.io/job/3' },
        { id: 4, name: 'Assistente Administrativo', careerPageName: 'Loja', description: 'Rotinas de escritório, remoto.', publishedDate: recent, workplaceType: 'remote', jobUrl: 'https://loja.gupy.io/job/4' },
      ];
      return page(`<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialJobList: { data: apex ? list : [] } } } })}</script></html>`);
    }
    if (u.hostname === 'www.infojobs.com.br') {
      if (u.pathname.includes('empregos'))
        return page(apex ? `<div class="card js_rowCard" data-href="/vaga-de-analista-oracle-apex__10.aspx"><div hidden class="js_date" data-value="${recent.slice(0, 10).replace(/-/g, '/')} 08:00:00"></div><a href="/vaga-de-analista-oracle-apex__10.aspx"><h2 class="h3 js_vacancyTitle"> Analista Oracle APEX </h2></a></div>` : '<p>Nenhuma vaga</p>');
      return page(posting({ title: 'analista oracle apex', description: 'Home office.<br>Oracle APEX e PL/SQL.<br>Envie o currículo para selecao@infoempresa.example', hiringOrganization: { name: 'Info Empresa' }, jobLocation: { address: { addressLocality: 'Campinas', addressRegion: 'SP' } } }));
    }
    if (u.hostname === 'www.vagas.com.br') {
      if (u.pathname.startsWith('/vagas-de-'))
        return page(apex ? `<ul><li class="vaga odd "><h2 class="cargo"><a class="link-detalhes-vaga" data-id-vaga="77" title="Desenvolvedor Oracle APEX" id="v77" href="/vagas/v77/desenvolvedor-oracle-apex"> Desenvolvedor Oracle APEX </a></h2><span class="emprVaga"> Certsys </span><span class="vaga-local">100% Home Office</span></li></ul>` : '<p>Não encontramos vagas</p>');
      return page(posting({ title: 'Desenvolvedor Oracle APEX', description: 'Trabalho remoto com Oracle APEX e PL/SQL.', hiringOrganization: { name: 'Certsys' } }));
    }
    if (u.hostname === 'api.remotar.com.br')
      return page(JSON.stringify({ data: apex ? [
        { id: 5, title: 'Pessoa Desenvolvedora Oracle APEX Sênior', subtitle: 'APEX, PL/SQL e REST', description: '<p>Aplicações em Oracle APEX.</p>', company: { name: 'Remota Tech' }, createdAt: recent, type: 'remote', jobTags: [{ tag: { name: '100% Remoto' } }] },
        { id: 6, title: 'Analista de BI Pl', description: '<p>Power BI e SQL.</p>', company: { name: 'Riachuelo' }, createdAt: recent, type: 'remote' },
      ] : [] }));
    return page(JSON.stringify({ jobs: apex ? [
      { title: 'Oracle APEX Developer', companyName: 'CACI', locationRestrictions: ['United States'], description: '<p>Oracle APEX and PL/SQL, fully remote.</p>', pubDate: Math.round(Date.now() / 1000) - 86400, applicationLink: 'https://himalayas.app/companies/caci/jobs/1' },
      { title: 'Senior Oracle APEX Engineer', companyName: 'Remote Co', locationRestrictions: ['Brazil', 'Argentina'], description: '<p>Oracle APEX, remote.</p>', pubDate: Math.round(Date.now() / 1000) - 86400, applicationLink: 'https://himalayas.app/companies/remote-co/jobs/2' },
    ] : [] }));
  }
  if (url.startsWith('https://accounts.google.com/o/oauth2/v2/auth')) {
    auth.asked.push({ url, init });
    return { ok: true, status: 200, url: auth.config === 'ok' ? 'https://accounts.google.com/v3/signin/identifier?continue=x' : authErrorPage(auth.config) };
  }
  if (url.endsWith('/models')) return reply(200, { data: catalog });
  if (url.includes('/chat/completions')) {
    const body = JSON.parse(init.body);
    const model = body.model;
    const task = aiTask(body);
    net.ai.push({ url, init, model, task });
    if (net.aiOff) return reply(500, { error: { message: 'Internal error' } });
    if (/whisper|guard/.test(model)) throw new Error('modelo que não é de conversa foi testado: ' + model);
    if (model === 'llama-3.3-70b-versatile')
      return reply(404, { error: { message: 'The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.', code: 'model_not_found' } });
    if (model === 'openai/gpt-oss-20b') return reply(429, { error: { message: 'Rate limit reached' } });
    if (model === 'modelo-tagarela-40b') return reply(200, { choices: [{ message: { content: 'Claro! Segue a resposta em texto corrido.' } }] });
    const ad = body.messages[1].content;
    if (task === 'eval') {
      await net.onEval?.(ad);
      return reply(200, { choices: [{ message: { content: '```json\n' + JSON.stringify(/Spark/.test(ad) ? aiEvalLow : aiEval) + '\n```' } }] });
    }
    if (task === 'write') {
      const fixing = body.messages.length > 2; // the correction round
      return reply(200, { choices: [{ message: { content: JSON.stringify(net.aiDirty && !fixing ? aiAnswerDirty : aiAnswer) } }] });
    }
    return reply(200, { choices: [{ message: { content: JSON.stringify({ ok: true, palavra: 'casa' }) } }] });
  }
  throw new Error('rede não esperada no teste: ' + url);
};

// ---------- test helpers ----------
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(ok ? 'OK    ' : 'FALHOU', name, ok ? '' : detail);
};
const send = (msg) =>
  new Promise((resolve) => {
    const keep = onMessage.fns[0](msg, {}, resolve);
    if (!keep) resolve(undefined);
  });
const jobs = () => Object.entries(data).filter(([k]) => k.startsWith('job:')).map(([, v]) => v);
const until = async (cond, ms = 20000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return false;
    await sleep(50);
  }
  return true;
};
const decodeMime = (call) => {
  const raw = JSON.parse(call.init.body).raw;
  const mime = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
  const boundary = mime.match(/boundary="([^"]+)"/)[1];
  const parts = mime.split('--' + boundary).slice(1, -1).map((p) => {
    const i = p.indexOf('\r\n\r\n');
    return { head: p.slice(0, i), data: Buffer.from(p.slice(i + 4).replace(/\r\n/g, ''), 'base64') };
  });
  const word = (s) => s.replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
  return { mime, parts, to: mime.match(/^To: (.+)$/m)[1].trim(), subject: word(mime.match(/^Subject: (.+)$/m)[1].trim()), threadId: JSON.parse(call.init.body).threadId };
};

const { textToPdf } = await mod('lib/pdf.js');
const cvPath = process.argv[2];
const cvBytes = cvPath ? fs.readFileSync(cvPath) : Buffer.from(textToPdf('Fulano de Tal\nfulano@exemplo.com\n# Experiência\n- Oracle APEX, PL/SQL, JavaScript'), 'latin1');
const resumeText = 'Desenvolvedor Oracle APEX com experiência em PL/SQL, JavaScript, jQuery, REST e integrações. Scrum.';

const googleJob = (n, extra = {}) => ({
  source: 'google_jobs', title: `Desenvolvedor Oracle APEX ${n}`, company: `Empresa ${n}`, location: 'Campinas, SP',
  url: `https://www.google.com/goto?url=vaga${n}`, emails: [],
  description: 'Vaga remota PJ para Oracle APEX, PL/SQL, HTML, CSS e JavaScript. Diferencial: Delphi.', ...extra,
});
const postJob = (n, email) => ({
  source: 'linkedin_post', title: `Estamos contratando dev APEX ${n}`, company: 'Recrutadora', location: '',
  url: `https://www.linkedin.com/feed/update/urn:li:activity:${n}/`, emails: [email, 'eu@meu-email.example'],
  description: `Vaga Oracle APEX e PL/SQL, JavaScript. Envie seu currículo para ${email}`,
});

// ---------- scenario ----------
await mod('background.js');
await onInstalled.fns[0]({ reason: 'install' });
await sleep(50);
check('instalação abre o painel', calls.tabsCreated.some((u) => u.endsWith('ui/dashboard.html')));

const { DEFAULTS } = await mod('lib/store.js');
data.settings = { ...DEFAULTS, name: 'Fulano de Tal', email: 'eu@meu-email.example', keywords: 'desenvolvedor oracle apex', gmailClientId: 'id.apps.googleusercontent.com', resumeText, skills: 'oracle apex, pl/sql' };
data.resumePdf = { name: 'CV.pdf', b64: cvBytes.toString('base64') };

// 1) job intake
let r = await send({ type: 'jobsFound', jobs: [googleJob(1), googleJob(2), postJob(1, 'rh@empresa-teste.example')] });
check('3 vagas novas entram', r?.ok && r.added === 3, JSON.stringify(r));
await until(() => jobs().length === 3 && !jobs().some((j) => j.status === 'novo'));
const g1 = jobs().find((j) => j.title.endsWith('APEX 1'));
const p1 = jobs().find((j) => j.source === 'linkedin_post');
check('vaga do Google sem e-mail vai para "sem e-mail"', g1?.status === 'sem_email');
check('etiquetas e aderência calculadas', g1?.tags.includes('Remoto') && g1.tags.includes('PJ') && typeof g1.fit === 'number', JSON.stringify([g1?.tags, g1?.fit]));
check('requisito ausente aparece como "falta"', g1?.missing?.includes('delphi'), JSON.stringify(g1?.missing));
check('post com e-mail fica pronto, sem usar o meu próprio e-mail', p1?.status === 'pronto' && p1.email === 'rh@empresa-teste.example', JSON.stringify([p1?.status, p1?.email]));
check('assunto e corpo vêm do modelo', p1?.subject === 'Candidatura – Estamos contratando dev APEX 1' && p1.body.includes('Fulano de Tal'), JSON.stringify(p1?.subject));
check('contador no ícone mostra 1 pronta', calls.badge.at(-1) === '1', String(calls.badge.at(-1)));

// 2) duplicates
r = await send({ type: 'jobsFound', jobs: [googleJob(1), googleJob(2, { url: 'https://outro-site.example/vaga' })] });
check('vagas repetidas (mesmo link ou mesmo título+empresa) são ignoradas', r?.added === 0, JSON.stringify(r));

// 3) sending through the Gmail API with the default resume
r = await send({ type: 'job:send', id: p1.id });
check('envio responde ok', r?.ok, JSON.stringify(r));
const m1 = net.gmail[0] && decodeMime(net.gmail[0]);
check('chamada usa o token obtido no login', net.gmail[0]?.init.headers.authorization === 'Bearer TOKEN_TESTE');
check('destinatário certo', m1?.to === 'rh@empresa-teste.example', m1?.to);
check('anexo idêntico ao currículo salvo', m1 && sha(m1.parts[1].data) === sha(cvBytes));
const sent = jobs().find((j) => j.id === p1.id);
check('vaga vira "enviado", etapa "aguardando", guarda a conversa', sent.status === 'enviado' && sent.stage === 'aguardando' && sent.threadId === 'thread1', JSON.stringify([sent.status, sent.stage, sent.threadId]));
check('contagem diária registra 1 envio', data.sentLog?.count === 1);
r = await send({ type: 'job:send', id: p1.id });
check('não envia duas vezes a mesma candidatura', r?.ok === false && net.gmail.length === 1, JSON.stringify(r));

// 4) follow-up in the same thread, with no attachment
r = await send({ type: 'job:followup', id: p1.id, body: 'Reforço meu interesse.' });
const m2 = net.gmail[1] && decodeMime(net.gmail[1]);
check('follow-up vai na mesma conversa e sem anexo', r?.ok && m2?.threadId === 'thread1' && m2.parts.length === 1 && m2.subject === 'Re: ' + sent.subject, JSON.stringify([r, m2?.subject]));

// 5) e-mail address already used
r = await send({ type: 'jobsFound', jobs: [postJob(2, 'rh@empresa-teste.example')] });
await until(() => jobs().length === 4);
check('novo anúncio para e-mail que já recebeu candidatura é descartado', jobs().find((j) => j.title.endsWith('APEX 2') && j.source === 'linkedin_post')?.status === 'descartado');

// 6) job without an e-mail that gets an address
await send({ type: 'job:patch', id: g1.id, patch: { email: 'vagas@outra-empresa.example' } });
await until(() => jobs().find((j) => j.id === g1.id)?.status === 'pronto');
check('vaga sem e-mail entra em revisão quando recebe um endereço', jobs().find((j) => j.id === g1.id)?.status === 'pronto');

// 7) AI (OpenAI-compatible provider) and tailored resume as a PDF
data.settings = { ...data.settings, provider: 'groq', groqKey: 'chave' };
r = await send({ type: 'job:regen', id: g1.id });
const ai = jobs().find((j) => j.id === g1.id);
check('IA preenche assunto, corpo, currículo adaptado e assina o e-mail', r?.ok && ai.subject === aiAnswer.subject && ai.resumeText === aiAnswer.resume && ai.body.startsWith('Olá,') && ai.body.trim().endsWith('eu@meu-email.example'), JSON.stringify([r, ai.subject, ai.body.slice(-60)]));
check('aderência calculada requisito por requisito: o que a IA diz ter, sem trecho do currículo que prove, conta menos',
  ai.fit === 76 && ai.strengths.join() === 'Oracle APEX,PL/SQL,JavaScript' && ai.gaps.join() === 'Kubernetes (em parte),Delphi' && ai.requirements.find((x) => x.requisito === 'Kubernetes')?.atende === 'parcial',
  JSON.stringify([ai.fit, ai.strengths, ai.gaps]));
const asked = net.ai.find((c) => c.task === 'eval' && JSON.parse(c.init.body).messages[1].content.includes(resumeText));
check('pedido à IA leva o texto do currículo e o anúncio', !!asked && JSON.parse(asked.init.body).messages[1].content.includes('Delphi'));
const askedBody = JSON.parse(asked.init.body);
check('Groq: resposta no formato estrito (json_schema), temperatura baixa e limite de tokens',
  askedBody.response_format?.type === 'json_schema' && askedBody.response_format.json_schema.strict === true && askedBody.temperature === 0.2 && askedBody.max_completion_tokens > 0 && askedBody.include_reasoning === false,
  JSON.stringify({ ...askedBody, messages: undefined }));
const tested = data.aiModels?.groq;
check('sem modelo escolhido: testa os modelos de conversa e usa o melhor que responde',
  asked?.model === 'openai/gpt-oss-120b' && tested?.working.map((w) => w.id).join() === 'openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b',
  JSON.stringify([asked?.model, tested?.working]));
check('modelo sem acesso e modelo que não devolve JSON ficam de fora, com o motivo',
  tested?.failed.map((x) => x.id).join() === 'llama-3.3-70b-versatile,modelo-tagarela-40b' && /does not exist/.test(tested.failed[0].reason), JSON.stringify(tested?.failed));
r = await send({ type: 'job:send', id: g1.id });
const m3 = decodeMime(net.gmail.at(-1));
check('candidatura com IA anexa o PDF do currículo adaptado', r?.ok && m3.parts[1].data.subarray(0, 5).toString() === '%PDF-' && sha(m3.parts[1].data) !== sha(cvBytes));

// 7b) hand-picked model the key cannot use (Groq's 404 error): switches on its own and carries on
data.settings = { ...data.settings, groqModel: 'llama-3.3-70b-versatile' };
const g2 = jobs().find((j) => j.title.endsWith('APEX 2') && j.source === 'google_jobs');
const callsBefore = net.ai.length;
r = await send({ type: 'job:regen', id: g2.id });
check('modelo indisponível em tempo de execução: troca pelo melhor e conclui',
  r?.ok && jobs().find((j) => j.id === g2.id).subject === aiAnswer.subject && net.ai[callsBefore].model === 'llama-3.3-70b-versatile' && net.ai.at(-1).model === 'openai/gpt-oss-120b',
  JSON.stringify([r, net.ai.slice(callsBefore).map((c) => c.model)]));
check('a escolha volta para o automático e o registro explica a troca',
  data.settings.groqModel === '' && /llama-3\.3-70b-versatile não está disponível.*gpt-oss-120b/.test(data.log?.[0]?.msg || ''), JSON.stringify([data.settings.groqModel, data.log?.[0]?.msg]));

// 7c) a weak model's first answer (markdown, placeholder, invented technology): one correction round fixes it
net.aiDirty = true;
const writesBefore = net.ai.filter((c) => c.task === 'write').length;
r = await send({ type: 'job:regen', id: g2.id });
const fixed = jobs().find((j) => j.id === g2.id);
const writes = net.ai.filter((c) => c.task === 'write').slice(writesBefore);
check('resposta com markdown, campo a preencher e tecnologia inventada: a IA recebe os problemas e corrige',
  r?.ok && writes.length === 2 && /\[Nome do Recrutador\]/.test(JSON.parse(writes[1].init.body).messages.at(-1).content) && /Kubernetes/.test(JSON.parse(writes[1].init.body).messages.at(-1).content) && fixed.subject === aiAnswer.subject && !/[[*]/.test(fixed.body),
  JSON.stringify([writes.length, fixed.subject]));
net.aiDirty = false;

// 7d) AI on for every job
data.settings = { ...data.settings, mode: 'ai', aiScoreSite: true };
const aiBefore = net.ai.length;
net.onEval = async (ad) => {
  // the user discards this one while the AI is still working on it
  const j = ad.includes('dev APEX 8') && jobs().find((x) => x.title.endsWith('dev APEX 8'));
  if (j) await send({ type: 'job:patch', id: j.id, patch: { status: 'descartado' } });
};
await send({ type: 'jobsFound', jobs: [{ ...postJob(6, 'rh@sexta.example'), description: 'Vaga de Oracle APEX com Spark e Hadoop. Envie para rh@sexta.example' }, googleJob(7), postJob(8, 'rh@oitava.example')] });
await until(() => jobs().find((j) => j.title.endsWith('dev APEX 6'))?.status === 'pronto' && jobs().find((j) => j.title.endsWith('Oracle APEX 7'))?.aiDone, 15000);
await sleep(200);
net.onEval = null;
const lowAi = jobs().find((j) => j.title.endsWith('dev APEX 6'));
const siteJob = jobs().find((j) => j.title.endsWith('Oracle APEX 7'));
const gone = jobs().find((j) => j.title.endsWith('dev APEX 8'));
const tasks = net.ai.slice(aiBefore).map((c) => c.task);
check('IA ligada, vaga de baixa aderência: a IA avalia mas não escreve; fica o modelo de e-mail e o PDF original',
  lowAi?.fit === 14 && lowAi.subject === 'Candidatura – Estamos contratando dev APEX 6' && !lowAi.resumeText && /Aderência 14/.test(lowAi.aiWarnings?.[0] || ''),
  JSON.stringify([lowAi?.fit, lowAi?.subject, lowAi?.aiWarnings]));
check('vaga para candidatar no site também recebe a avaliação da IA, sem gastar com textos', siteJob?.fit === 76 && siteJob.status === 'sem_email' && !siteJob.subject && tasks.filter((t) => t === 'eval').length >= 2,
  JSON.stringify([siteJob?.fit, siteJob?.status, tasks]));
check('vaga descartada enquanto a IA trabalhava continua descartada', gone?.status === 'descartado' && !gone.subject, JSON.stringify([gone?.status, gone?.subject]));
data.settings = { ...data.settings, mode: 'template' };

// 8) autopilot with a minimum fit
data.settings = { ...data.settings, provider: 'anthropic', autoSend: true, minFit: 50 };
const before = net.gmail.length;
await send({ type: 'jobsFound', jobs: [postJob(3, 'talentos@terceira.example'), { ...postJob(4, 'rh@quarta.example'), description: 'Vaga de Spark, Hadoop, Kafka e Airflow. Envie para rh@quarta.example' }, { ...postJob(10, 'rh@decima.example'), title: 'Oportunidade em aberto', description: 'Envie seu currículo para rh@decima.example' }] });
await until(() => net.gmail.length > before && !jobs().some((j) => ['novo', 'fila'].includes(j.status)), 30000);
const auto = jobs().find((j) => j.title.endsWith('APEX 3'));
const low = jobs().find((j) => j.title.endsWith('APEX 4'));
const unknown = jobs().find((j) => j.title === 'Oportunidade em aberto');
check('piloto automático envia a vaga aderente', auto?.status === 'enviado' && decodeMime(net.gmail.at(-1)).to === 'talentos@terceira.example', JSON.stringify([auto?.status, auto?.fit]));
check('piloto automático segura a vaga de baixa aderência', low?.status === 'pronto' && low.fit < 50, JSON.stringify([low?.status, low?.fit]));
check('piloto automático não envia vaga sem aderência conhecida (anúncio sem nenhum requisito)', unknown?.status === 'pronto' && unknown.fit == null, JSON.stringify([unknown?.status, unknown?.fit]));

// 9) daily limit
data.settings = { ...data.settings, dailyLimit: data.sentLog.count };
const n = net.gmail.length;
await send({ type: 'jobsFound', jobs: [postJob(5, 'rh@quinta.example')] });
await until(() => jobs().find((j) => j.title.endsWith('APEX 5'))?.status === 'fila');
await sleep(300);
check('limite diário atingido: fica na fila sem enviar', net.gmail.length === n && jobs().find((j) => j.title.endsWith('APEX 5'))?.status === 'fila');

// 10) scan: the search tab answers with jobs, as the content script would
data.settings = { ...data.settings, autoSend: false, srcLinkedinJobs: false, srcBoards: false, srcLinkedinPosts: false, srcGoogle: true };
chrome.tabs.sendMessage = async () => {
  await send({ type: 'jobsFound', jobs: [googleJob(9), postJob(9, 'rh@nona.example')] });
  return { ok: true, count: 2 };
};
await send({ type: 'scanNow' });
await until(() => data.scan?.running === true, 3000);
const ran = await until(() => data.scan && data.scan.running === false && data.scan.last, 20000);
const scanned = jobs().find((j) => j.title.endsWith('APEX 9'));
check('varredura abre a janela, lê a vaga e encerra', ran && calls.windows === 1 && scanned?.keyword === 'desenvolvedor oracle apex', JSON.stringify([ran, calls.windows, scanned?.keyword]));
check('avisa sobre vagas novas', calls.notifications.some((m) => m.startsWith('2 vaga')), JSON.stringify(calls.notifications));
await until(() => jobs().find((j) => j.title.endsWith('APEX 9') && j.source === 'linkedin_post')?.status === 'pronto');
check('post achado na varredura usa a palavra-chave da busca no assunto', jobs().find((j) => j.title.endsWith('APEX 9') && j.source === 'linkedin_post')?.subject === 'Candidatura – desenvolvedor oracle apex');

// 11) resume/skills change: the fit of open jobs is recomputed
const open = jobs().find((j) => j.title.endsWith('APEX 9') && j.source === 'google_jobs');
data.settings = { ...data.settings, skills: 'oracle apex, pl/sql, delphi, html, css' };
await send({ type: 'settings:changed' });
await until(() => jobs().find((j) => j.id === open.id).fit !== open.fit, 5000);
const redone = jobs().find((j) => j.id === open.id);
check('mudar as habilidades refaz a aderência das vagas em aberto', redone.fit > open.fit && !redone.missing.includes('delphi'), JSON.stringify([open.fit, redone.fit, redone.missing]));

// 12) connecting Gmail: a configuration error is explained before the Google window opens
const flowUrl = (f) => new URL(f.url).searchParams;
auth.flows.length = 0;
auth.config = 'redirect_uri_mismatch';
r = await send({ type: 'gmail:connect' });
check('endereço não cadastrado no cliente OAuth: explica onde cadastrar, sem abrir a janela',
  r?.ok === false && r.error.includes('https://teste.chromiumapp.org/') && r.error.includes('URIs de redirecionamento autorizados') && auth.flows.length === 0, JSON.stringify([r, auth.flows.length]));
check('a consulta ao Google vai sem cookies e com o mesmo endereço do login',
  auth.asked.at(-1)?.init.credentials === 'omit' && flowUrl(auth.asked.at(-1)).get('redirect_uri') === 'https://teste.chromiumapp.org/' && flowUrl(auth.asked.at(-1)).get('client_id') === 'id.apps.googleusercontent.com');
auth.config = 'invalid_client';
r = await send({ type: 'gmail:connect' });
check('ID do cliente que o Google não conhece: avisa, sem abrir a janela', r?.ok === false && /não encontrou este ID do cliente/.test(r.error) && auth.flows.length === 0, JSON.stringify(r));
auth.config = 'ok';
auth.answer = () => null;
r = await send({ type: 'gmail:connect' });
check('janela fechada na tela de erro do Google: aponta os usuários de teste', r?.ok === false && /Usuários de teste/.test(r.error) && auth.flows.length === 1 && auth.flows[0].interactive === true, JSON.stringify(r));
auth.answer = () => '#error=access_denied';
r = await send({ type: 'gmail:connect' });
check('acesso negado pelo usuário: diz que foi cancelado', r?.ok === false && /cancelou/.test(r.error), JSON.stringify(r));

// 13) expired token and Google demands a new login: the queue waits, without flagging the jobs as errors
const queued = () => jobs().find((j) => j.title.endsWith('APEX 5'));
const pauses = () => (data.log || []).filter((l) => l.msg.startsWith('Envio pausado')).length;
data.settings = { ...data.settings, dailyLimit: 100, email: 'fulano@gmail.com' };
data.gmailToken = { token: 'VENCIDO', exp: Date.now() - 1000 };
auth.flows.length = 0;
auth.answer = (o) => (o.interactive ? null : '#error=interaction_required');
const [pausesBefore, alertsBefore, sentBefore] = [pauses(), calls.notifications.length, net.gmail.length];
onAlarm.fns[0]({ name: 'queue' });
await until(() => pauses() > pausesBefore, 5000);
check('renovação recusada: vaga continua na fila e o envio é pausado',
  queued()?.status === 'fila' && net.gmail.length === sentBefore && /^Envio pausado: Gmail desconectado/.test(data.log[0].msg), JSON.stringify([queued()?.status, data.log?.[0]?.msg]));
check('renovação é silenciosa, tenta a conta do e-mail do usuário e depois sem conta',
  auth.flows.length === 2 && auth.flows.every((f) => f.interactive === false && f.abortOnLoadForNonInteractive === false && flowUrl(f).get('prompt') === 'none') &&
    flowUrl(auth.flows[0]).get('login_hint') === 'fulano@gmail.com' && !flowUrl(auth.flows[1]).has('login_hint'), JSON.stringify(auth.flows));
check('painel passa a mostrar o Gmail como desconectado', !('gmailToken' in data));
onAlarm.fns[0]({ name: 'queue' });
await sleep(400);
check('pausa é registrada e avisada uma vez só', pauses() === pausesBefore + 1 && calls.notifications.length === alertsBefore + 1 && calls.notifications.at(-1).startsWith('Gmail desconectado'), JSON.stringify([pauses(), calls.notifications.slice(alertsBefore)]));

// 14) reconnecting resumes the queue; an hour later the token renews itself
auth.flows.length = 0;
auth.answer = () => granted;
r = await send({ type: 'gmail:connect' });
await until(() => queued()?.status === 'enviado', 15000);
check('conectar de novo envia o que estava parado', r?.ok && queued()?.status === 'enviado' && auth.flows[0].interactive === true && !flowUrl(auth.flows[0]).has('prompt') && flowUrl(auth.flows[0]).get('login_hint') === 'fulano@gmail.com',
  JSON.stringify([r, queued()?.status, auth.flows]));
const low4 = jobs().find((j) => j.title.endsWith('APEX 4'));
data.gmailToken = { ...data.gmailToken, exp: Date.now() - 1000 };
auth.flows.length = 0;
await send({ type: 'job:queue', ids: [low4.id] });
await until(() => jobs().find((j) => j.id === low4.id).status === 'enviado', 30000);
check('token vencido se renova sem janela e o envio segue',
  jobs().find((j) => j.id === low4.id).status === 'enviado' && auth.flows.length === 1 && auth.flows[0].interactive === false && data.gmailToken.exp > Date.now(), JSON.stringify([jobs().find((j) => j.id === low4.id).status, auth.flows]));

// 15) Gmail API disabled in the Google Cloud project: also a pause, not a job error
const nine = jobs().find((j) => j.title.endsWith('APEX 9') && j.source === 'linkedin_post');
net.gmailOff = true;
await send({ type: 'job:queue', ids: [nine.id] });
await until(() => /Gmail API/.test(data.log[0].msg), 30000);
check('Gmail API desativada: vaga fica na fila com a explicação no registro',
  jobs().find((j) => j.id === nine.id).status === 'fila' && /^Envio pausado: A Gmail API não está ativada/.test(data.log[0].msg), JSON.stringify([jobs().find((j) => j.id === nine.id).status, data.log[0].msg]));
net.gmailOff = false;

// 16) login window left open (the browser keeps only one): Conectar explains, and the queue does not get stuck
auth.windowOpen = true;
auth.flows.length = 0;
r = await send({ type: 'gmail:connect' });
check('janela de login já aberta: explica o que fazer em vez de repassar o erro do navegador', r?.ok === false && /janela de login do Google aberta/.test(r.error) && !/web auth flow/.test(r.error), JSON.stringify(r));
data.gmailToken = { ...data.gmailToken, exp: Date.now() - 1000 };
onAlarm.fns[0]({ name: 'queue' });
await until(() => jobs().find((j) => j.id === nine.id).status === 'enviado', 15000);
check('com a janela aberta, a fila ainda renova o token em silêncio e envia',
  jobs().find((j) => j.id === nine.id).status === 'enviado' && auth.flows.length === 1 && auth.flows[0].interactive === false, JSON.stringify([jobs().find((j) => j.id === nine.id).status, auth.flows.map((f) => f.interactive)]));
auth.windowOpen = false;

// 17) a job whose AI preparation failed is retried when the AI settings change or the extension is updated
const byTitle = (n) => jobs().find((j) => j.title.endsWith('APEX ' + n) && j.source === 'linkedin_post');
data.settings = { ...data.settings, mode: 'ai', provider: 'groq', groqKey: 'chave', groqModel: '', autoSend: false };
net.aiOff = true;
await send({ type: 'jobsFound', jobs: [postJob(20, 'rh@vinte.example')] });
await until(() => byTitle(20)?.status === 'erro', 30000);
check('falha da IA na preparação: vaga fica com erro e sem assunto', byTitle(20)?.status === 'erro' && !byTitle(20).subject && /\(500\)/.test(byTitle(20).error), JSON.stringify([byTitle(20)?.status, byTitle(20)?.error]));
let aiCalls = net.ai.length;
await send({ type: 'settings:changed' });
await sleep(400);
check('configuração da IA igual: não insiste na vaga que falhou', byTitle(20).status === 'erro' && net.ai.length === aiCalls, JSON.stringify([byTitle(20).status, net.ai.length - aiCalls]));
net.aiOff = false;
data.settings = { ...data.settings, groqModel: 'qwen/qwen3.8-27b' };
await send({ type: 'settings:changed' });
await until(() => byTitle(20).status === 'pronto', 30000);
check('configuração da IA mudou: a vaga é preparada de novo sozinha', byTitle(20).status === 'pronto' && byTitle(20).subject === aiAnswer.subject && !byTitle(20).error && net.ai.at(-1).model === 'qwen/qwen3.8-27b', JSON.stringify([byTitle(20).status, byTitle(20).error]));
net.aiOff = true;
await send({ type: 'jobsFound', jobs: [postJob(21, 'rh@vinteeum.example')] });
await until(() => byTitle(21)?.status === 'erro', 30000);
net.aiOff = false;
const tabsBefore = calls.tabsCreated.length;
await onInstalled.fns[0]({ reason: 'update' });
await until(() => byTitle(21).status === 'pronto', 30000);
check('extensão atualizada: vagas que falharam na IA são preparadas de novo', byTitle(21).status === 'pronto' && calls.tabsCreated.length === tabsBefore, JSON.stringify([byTitle(21).status, byTitle(21).error]));

// 18) background code version: the dashboard uses it to tell if the browser still runs an old service worker
const { BUILD } = await mod('lib/build.js');
r = await send({ type: 'version' });
check('service worker informa a versão, igual à do manifest', r?.build === BUILD && BUILD === JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version, JSON.stringify([r, BUILD]));
data.autoReload = { to: BUILD, from: '0.4.1', at: Date.now() };
await onInstalled.fns[0]({ reason: 'update' });
check('atualização pedida pelo painel: reabre o painel que a recarga fechou', calls.tabsCreated.length === tabsBefore + 1 && calls.tabsCreated.at(-1).endsWith('ui/dashboard.html'), JSON.stringify(calls.tabsCreated.slice(tabsBefore)));

// 19) search by direct query: each term on each source, sources in parallel, no window
const { searchTerms, relevant } = await mod('lib/sources.js');
check('termos separados por vírgula, ponto e vírgula ou linha viram buscas próprias, sem repetir',
  searchTerms('Oracle APEX, PL/SQL;  oracle apex\nConsultor Oracle ,').join('|') === 'Oracle APEX|PL/SQL|Consultor Oracle', searchTerms('Oracle APEX, PL/SQL;  oracle apex\nConsultor Oracle ,').join('|'));
check('relevância: a tecnologia do termo tem de estar no anúncio, como palavra inteira',
  relevant('PL/SQL', { title: 'Desenvolvedor', description: 'Experiência em PL SQL e Oracle' }) && relevant('Oracle APEX', { title: 'Dev PLSQL', description: 'usamos Oracle APEX' }) &&
    !relevant('Oracle APEX', { title: 'Zap Expert', description: 'zap expert com oracle' }) && !relevant('Oracle APEX', { title: 'Assistente (Python)', description: 'Python e Angular' }));
check('relevância: termo com cargo exige o cargo ou a tecnologia no título',
  relevant('Consultor Oracle', { title: 'Oracle Fusion Consultant', description: '' }) && relevant('Consultor Oracle', { title: 'Oracle Fusion Cloud SR', description: '' }) &&
    !relevant('Consultor Oracle', { title: 'Analista de Contabilidade Sênior', description: 'Conhecimento em Oracle ERP' }) && relevant('Desenvolvedor', { title: 'Senior Developer', description: '' }));

const scanOnce = async () => {
  await send({ type: 'scanNow' });
  await until(() => data.scan?.running === true, 3000);
  await until(() => data.scan && data.scan.running === false, 90000);
};
const liSearches = () => net.li.filter((c) => c.path.endsWith('/search'));
const liDetails = () => net.li.filter((c) => c.path.includes('/jobPosting/'));
const boardCalls = (host) => net.boards.filter((c) => c.host === host);
const bySource = (id) => jobs().filter((j) => j.source === id);
data.settings = { ...data.settings, mode: 'template', autoSend: false, keywords: 'Oracle APEX, PL/SQL', location: 'Brasil', remoteOnly: true, srcLinkedinJobs: true, srcBoards: true, srcLinkedinPosts: false, srcGoogle: false, maxPerSearch: 12 };
const windowsBefore = calls.windows;
await scanOnce();
await until(() => !jobs().some((j) => j.status === 'novo'), 10000);
check('LinkedIn pela busca pública: lê as páginas até o máximo por termo, sem abrir janela', bySource('linkedin_jobs').length === 12 && calls.windows === windowsBefore, JSON.stringify([bySource('linkedin_jobs').length, calls.windows - windowsBefore]));
const firstSearch = liSearches()[0];
check('o lugar vira o código de região do LinkedIn, a primeira busca olha 30 dias e leva o filtro de remoto',
  firstSearch?.params.get('geoId') === '106057199' && firstSearch.params.get('f_TPR') === 'r2592000' && firstSearch.params.get('f_WT') === '2' && firstSearch.params.get('keywords') === 'Oracle APEX', String(firstSearch?.params));
check('cada termo é buscado em cada site (2 termos, 6 fontes)',
  ['portal.gupy.io', 'api.remotar.com.br', 'himalayas.app'].every((h) => boardCalls(h).length === 2) && boardCalls('www.infojobs.com.br').filter((c) => c.path.includes('empregos')).length === 2 &&
    boardCalls('www.vagas.com.br').filter((c) => c.path.includes('vagas-de-')).map((c) => c.path).join() === '/vagas-de-oracle-apex,/vagas-de-pl-sql' && liSearches().some((c) => c.params.get('keywords') === 'PL/SQL'),
  JSON.stringify(net.boards.map((c) => c.host + c.path)));
check('nenhuma consulta leva os cookies das contas do usuário', [...net.li, ...net.boards].every((c) => c.init.credentials === 'omit'));
check('entram as vagas de cada site que citam o termo: Gupy ou Vagas.com (a mesma vaga), InfoJobs, Remotar e Himalayas',
  bySource('gupy').length + bySource('vagas').length === 1 && bySource('infojobs').length === 1 && bySource('remotar').length === 1 && bySource('himalayas').length === 1,
  JSON.stringify(jobs().filter((j) => !['linkedin_jobs', 'linkedin_post', 'google_jobs'].includes(j.source)).map((j) => `${j.source}: ${j.title} — ${j.company}`)));
check('ficam de fora: presencial (busca só remota), anúncio antigo, vaga sem a tecnologia e vaga restrita a outro país',
  !jobs().some((j) => ['Fábrica', 'Velha', 'Loja', 'Riachuelo', 'CACI'].includes(j.company)), JSON.stringify(jobs().map((j) => j.company)));
const mailed = bySource('infojobs')[0];
check('anúncio com e-mail na descrição fica pronto para revisão; os demais vão para “candidatar no site”',
  mailed?.status === 'pronto' && mailed.email === 'selecao@infoempresa.example' && mailed.company === 'Info Empresa' && mailed.location === 'Campinas, SP' && bySource('remotar')[0].status === 'sem_email' &&
    bySource('linkedin_jobs').filter((j) => j.status === 'pronto').length === 1, JSON.stringify([mailed?.status, mailed?.email, mailed?.company, mailed?.location]));
const liJob = bySource('linkedin_jobs').find((j) => j.url.endsWith('/1002/'));
check('descrição vem completa, em texto, com os itens da lista e os critérios da vaga',
  liJob?.description.includes('Oracle APEX e PL/SQL & JavaScript') && liJob.description.includes('- Requisito: Git') && liJob.description.includes('Pleno-sênior · Tempo integral') && liJob.keyword === 'Oracle APEX', JSON.stringify(liJob?.description));
check('o registro resume a busca: tempo, termos, região e quantas cada site leu e trouxe de novo',
  /^Busca em \d+ s — 2 termo\(s\), Brasil: LinkedIn 24 lida\(s\), 12 nova\(s\) · Gupy 4 lida\(s\), [01] nova\(s\) · InfoJobs 1 lida\(s\), 1 nova\(s\) · Vagas\.com 1 lida\(s\), [01] nova\(s\) · Remotar 2 lida\(s\), 1 nova\(s\) · Himalayas 1 lida\(s\), 1 nova\(s\)\.$/.test(data.log.find((l) => l.msg.startsWith('Busca em'))?.msg || ''),
  data.log.find((l) => l.msg.startsWith('Busca em'))?.msg);

const [searchesBefore, detailsBefore, boardDetails] = [liSearches().length, liDetails().length, net.boards.filter((c) => /vaga-de-|\/vagas\/v/.test(c.path)).length];
await scanOnce();
check('busca seguinte: LinkedIn olha só 1 dia para trás e nenhuma vaga já lida (guardada ou recusada) é consultada de novo',
  liSearches()[searchesBefore].params.get('f_TPR') === 'r86400' && liDetails().length === detailsBefore && net.boards.filter((c) => /vaga-de-|\/vagas\/v/.test(c.path)).length === boardDetails &&
    net.li.filter((c) => c.path.endsWith('/typeaheadHits')).length === 1 && /LinkedIn 24 lida\(s\), 0 nova\(s\) · Gupy 4 lida\(s\), 0 nova\(s\)/.test(data.log[0].msg),
  JSON.stringify([liSearches()[searchesBefore].params.get('f_TPR'), liDetails().length - detailsBefore, data.log[0].msg]));
data.settings = { ...data.settings, location: 'Qualquer lugar' };
await scanOnce();
check('“Qualquer lugar” não é tratado como nome de cidade: vale o país do idioma do navegador', liSearches().at(-1).params.get('geoId') === '106057199' && /termo\(s\), Brasil:/.test(data.log[0].msg), data.log[0].msg);
data.settings = { ...data.settings, location: 'Mundo' };
await scanOnce();
check('“Mundo” busca em qualquer país: entra também a vaga remota restrita a outro país', liSearches().at(-1).params.get('geoId') === '92000000' && /Mundialmente:/.test(data.log[0].msg) && jobs().some((j) => j.company === 'CACI'), data.log[0].msg);
net.liLimited = true;
const searchesLimited = liSearches().length;
await scanOnce();
check('LinkedIn limitou as consultas: o resumo avisa, o segundo termo não insiste e os outros sites seguem normalmente',
  liSearches().length === searchesLimited + 1 && /LinkedIn 0 lida\(s\), 0 nova\(s\) \(limitou as consultas por agora\) · Gupy 4 lida\(s\)/.test(data.log[0].msg), JSON.stringify([liSearches().length - searchesLimited, data.log[0].msg]));
net.liLimited = false;

// 20) users of the previous version: sources that open a window are turned off once, with a notice
delete data.migrated;
data.settings = { ...data.settings, srcLinkedinPosts: true, srcGoogle: true };
await onInstalled.fns[0]({ reason: 'update' });
check('atualização para a busca direta desliga “Posts do LinkedIn” e “Vagas do Google” e avisa no registro',
  data.settings.srcLinkedinPosts === false && data.settings.srcGoogle === false && data.migrated?.directSearch === true && /sem abrir janela/.test(data.log[0].msg), JSON.stringify([data.settings.srcLinkedinPosts, data.settings.srcGoogle, data.log[0].msg]));
data.settings = { ...data.settings, srcGoogle: true };
await onInstalled.fns[0]({ reason: 'update' });
check('se o usuário religar uma delas, a escolha é respeitada nas atualizações seguintes', data.settings.srcGoogle === true);

// 21) applying on the website: answers come only from what the user provided
const { answerFor, questionKey } = await mod('lib/answers.js');
const prof = {
  ...DEFAULTS, name: 'Fulano de Tal', email: 'eu@gmail.example', phone: '+55 (19) 99999-8888', city: 'Campinas, São Paulo', skills: 'oracle apex, pl/sql',
  skillYears: 'oracle apex: 8\npl/sql: 10', yearsExperience: '12', salary: 'R$ 12.000', englishLevel: 'Avançado',
  applyAnswers: { [questionKey('Você aceita trabalhar como PJ? *')]: 'Sim' },
};
const ans = (label, kind = 'text', options, required = true) => answerFor({ label, kind, options, required }, { settings: prof, job: { body: 'Olá, tenho interesse.' } });
check('respostas: dados de contato, com telefone sem o código do país e a opção certa nas listas',
  ans('Celular') === '19999998888' && ans('Endereço de e-mail', 'select', ['Selecionar opção', 'eu@gmail.example']) === 'eu@gmail.example' &&
    ans('Código do país', 'select', ['Selecionar opção', 'Brasil (+55)', 'Estados Unidos (+1)']) === 'Brasil (+55)' && ans('First name') === 'Fulano' && ans('Sobrenome') === 'de Tal' && ans('Cidade') === 'Campinas, São Paulo',
  JSON.stringify([ans('Celular'), ans('First name'), ans('Sobrenome'), ans('Cidade')]));
check('respostas: anos de experiência por tecnologia; o total só quando a pergunta é geral; tecnologia não informada fica sem resposta',
  ans('Há quantos anos você já usa Oracle APEX no trabalho?', 'number') === '8' && ans('How many years of work experience do you have with PL/SQL?', 'number') === '10' &&
    ans('Quantos anos de experiência profissional você tem?', 'number') === '12' && ans('Há quantos anos você já usa Salesforce no trabalho?', 'number') === null,
  JSON.stringify([ans('Há quantos anos você já usa Oracle APEX no trabalho?', 'number'), ans('Quantos anos de experiência profissional você tem?', 'number'), ans('Há quantos anos você já usa Salesforce no trabalho?', 'number')]));
check('respostas: “sim” para habilidade do usuário (mesmo com opções em inglês) e nível de inglês na escala do formulário',
  ans('Você tem experiência com PL/SQL?', 'radio', ['Yes', 'No']) === 'Yes' && ans('Você tem experiência com SAP?', 'radio', ['Sim', 'Não']) === null &&
    ans('Qual é o seu nível de proficiência em inglês?', 'select', ['Selecionar opção', 'Nenhum', 'Básico', 'Conversação', 'Profissional', 'Nativo ou bilíngue']) === 'Profissional');
check('respostas: o que o usuário já respondeu vale para a mesma pergunta, com ou sem asterisco', ans('Você aceita trabalhar como PJ?', 'radio', ['Yes', 'No']) === 'Yes');
check('respostas: nada é inventado — pergunta desconhecida, documento e dado sensível sem opção de recusar ficam em branco',
  ans('Você possui certificação Oracle Cloud?', 'radio', ['Sim', 'Não']) === null && ans('CPF') === null && ans('Gênero', 'select', ['Masculino', 'Feminino']) === null &&
    ans('Gênero', 'select', ['Masculino', 'Feminino', 'Prefiro não responder']) === 'Prefiro não responder');
check('respostas: aceita termo obrigatório, não segue a empresa, usa a pretensão e o texto do e-mail como carta',
  ans('Li e concordo com os termos', 'checkbox') === true && ans('Seguir a Empresa X para ficar por dentro das novidades', 'checkbox', undefined, false) === false && ans('Quero receber novidades', 'checkbox', undefined, false) === null &&
    ans('Pretensão salarial', 'number') === '12000' && ans('Carta de apresentação', 'textarea') === 'Olá, tenho interesse.');

// 22) website application queue (the LinkedIn page is simulated: it returns what the form would)
const site = { runs: [], url: 'https://www.linkedin.com/jobs/view/1/', answer: () => ({ status: 'enviada' }) };
chrome.scripting = { executeScript: async () => [] };
chrome.tabs.get = async () => ({ status: 'complete', url: site.url });
chrome.tabs.sendMessage = async (_tab, msg) => (msg.type === 'apply:run' ? (site.runs.push(msg), site.answer(msg)) : { ok: true, count: 0 });
const job = (id) => jobs().find((j) => j.id === id);
const easy = bySource('linkedin_jobs').filter((j) => j.status === 'sem_email');
data.settings = { ...data.settings, phone: '19 99999-8888', applyDailyLimit: 2, applyReview: false };
const winsApply = calls.windows;
r = await send({ type: 'apply:start', ids: [easy[0].id] });
await until(() => job(easy[0].id).status === 'enviado', 15000);
check('candidatar: abre a vaga em uma janela, manda preencher e enviar com o currículo, e marca a candidatura como feita',
  r?.ok && job(easy[0].id).status === 'enviado' && job(easy[0].id).via === 'linkedin' && !job(easy[0].id).applyState && calls.windows === winsApply + 1 &&
    site.runs[0].mode === 'easy' && site.runs[0].submit === true && site.runs[0].resume?.b64?.length > 100 && data.applyLog?.count === 1,
  JSON.stringify([job(easy[0].id).status, job(easy[0].id).via, calls.windows - winsApply, site.runs[0]?.mode, data.applyLog]));
r = await send({ type: 'apply:answers', jobId: easy[1].id, questions: [{ label: 'Celular', kind: 'text', required: true }, { label: 'Você possui certificação Oracle Cloud?', kind: 'radio', options: ['Sim', 'Não'], required: true }] });
check('a página pergunta e o background responde só o que sabe', r?.answers?.[0] === '19999998888' && r.answers[1] === null, JSON.stringify(r));

site.answer = () => ({ status: 'pendente', questions: [{ label: 'Você possui certificação Oracle Cloud?', kind: 'radio', options: ['Sim', 'Não'] }] });
await send({ type: 'apply:start', ids: [easy[1].id] });
await until(() => job(easy[1].id).applyState === 'pendente', 15000);
check('pergunta sem resposta: a candidatura para, a vaga explica o que falta e a pergunta vai para o painel',
  job(easy[1].id).status === 'sem_email' && /Falta responder: “Você possui certificação Oracle Cloud\?”/.test(job(easy[1].id).error) && data.applyPending?.[0]?.options?.join() === 'Sim,Não' && data.applyLog.count === 1,
  JSON.stringify([job(easy[1].id).applyState, job(easy[1].id).error, data.applyPending]));
await send({ type: 'apply:learn', pairs: [{ label: 'Você possui certificação Oracle Cloud? *', value: 'Não' }] });
check('resposta dada pelo usuário é guardada e a pergunta sai da lista de pendentes',
  data.settings.applyAnswers[questionKey('Você possui certificação Oracle Cloud?')] === 'Não' && data.applyPending.length === 0, JSON.stringify([data.settings.applyAnswers, data.applyPending]));

site.answer = () => ({ status: 'enviada' });
await send({ type: 'apply:start', ids: [easy[1].id, easy[2].id] });
await until(() => job(easy[1].id).status === 'enviado' && (data.log || []).some((l) => /limite de 2 por dia/.test(l.msg)), 40000);
check('em lote: respeita o limite diário e deixa o resto na fila',
  job(easy[1].id).status === 'enviado' && job(easy[2].id).status === 'sem_email' && job(easy[2].id).applyState === 'fila' && data.applyQueue?.join() === easy[2].id && site.runs.at(-1).batch === true,
  JSON.stringify([job(easy[1].id).status, job(easy[2].id).applyState, data.applyQueue]));
onAlarm.fns[0]({ name: 'queue' });
await sleep(400);
check('limite atingido é registrado uma vez só, mesmo com a fila sendo retomada a cada minuto', data.log.filter((l) => /limite de 2 por dia/.test(l.msg)).length === 1);

data.settings = { ...data.settings, applyDailyLimit: 20 };
site.url = 'https://www.linkedin.com/login?session_redirect=x';
onAlarm.fns[0]({ name: 'queue' });
await until(() => (data.applyQueue || []).length === 0, 15000);
check('sem login no LinkedIn: a fila é esvaziada, a vaga diz o que fazer e nada fica tentando de novo',
  /faça login no LinkedIn/.test(job(easy[2].id).error) && !job(easy[2].id).applyState && /pausadas/.test(data.log[0].msg), JSON.stringify([job(easy[2].id).error, data.log[0].msg]));
site.url = 'https://www.linkedin.com/jobs/view/1/';
site.answer = () => ({ status: 'externa' });
await send({ type: 'apply:start', ids: [easy[2].id] });
await until(() => job(easy[2].id).easyApply === false, 15000);
check('vaga sem candidatura simplificada: fica marcada para candidatura no site da empresa', job(easy[2].id).easyApply === false && job(easy[2].id).status === 'sem_email' && /site da empresa/.test(job(easy[2].id).error));

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} de ${results.length} verificações passaram.`);
process.exit(failed ? 1 : 0);
