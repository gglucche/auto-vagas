import { DEFAULTS, JOB_PREFIX, getSettings, setSettings, getJobs, fillTemplate, log } from '../lib/store.js';
import { textToPdf } from '../lib/pdf.js';
import { redirectUri } from '../lib/gmail.js';
import { PROVIDERS, providerOf, aiKey, listModels } from '../lib/ai.js';
import { extractPdfText } from '../lib/pdftext.js';
import { profileFromResume } from '../lib/profile.js';
import { BUILD } from '../lib/build.js';
import { freshBackground, STALE_HELP } from './fresh.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const call = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  review: svg('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>'),
  noemail: svg('<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>'),
  sent: svg('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>'),
  archive: svg('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>'),
  stats: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.3l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2.2-1.3L14 3h-4l-.4 2.4a7 7 0 0 0-2.2 1.3l-2.3-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.6l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2.2 1.3L10 21h4l.4-2.4a7 7 0 0 0 2.2-1.3l2.3.9 2-3.4-2-1.5c.1-.4.1-.9.1-1.3z"/>'),
  scan: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
};

const VIEWS = {
  review: { label: 'Para revisar', statuses: ['pronto', 'novo', 'erro', 'fila'] },
  noemail: { label: 'Candidatar no site', statuses: ['sem_email'] },
  sent: { label: 'Candidaturas', statuses: ['enviado'] },
  archive: { label: 'Arquivadas', statuses: ['descartado', 'ignorado'] },
};
const PAGES = { stats: 'Estatísticas', settings: 'Configurações' };
const SOURCE = { linkedin_jobs: 'LinkedIn', linkedin_post: 'Post no LinkedIn', google_jobs: 'Google', gupy: 'Gupy', infojobs: 'InfoJobs', vagas: 'Vagas.com', remotar: 'Remotar', himalayas: 'Himalayas', captura: 'Capturada' };
const STAGES = { aguardando: 'Aguardando', respondeu: 'Responderam', entrevista: 'Entrevista', oferta: 'Oferta', rejeitado: 'Recusada' };
// Vaga do LinkedIn com candidatura simplificada (ou ainda não conferida): dá para a extensão preencher e enviar.
const canApply = (j) => j.source === 'linkedin_jobs' && j.status === 'sem_email' && j.easyApply !== false;
const APPLY_PILL = { fila: ['Na fila', 'acc'], rodando: ['Candidatando…', 'acc'], revisar: ['Conferir e enviar', 'warn'], pendente: ['Falta resposta', 'bad'] };

const STATUS_PILL = {
  novo: ['Preparando…', 'acc'], fila: ['Na fila', 'acc'], erro: ['Erro', 'bad'], ignorado: ['Ignorada pela IA', ''], descartado: ['Descartada', ''],
};

const S = {
  jobs: new Map(), settings: DEFAULTS, view: 'review', sel: null, checked: new Set(), q: '', sort: 'fit',
  tab: 'email', scan: {}, meta: {}, sending: new Map(), busy: new Set(),
};

// ---------- utilidades ----------
function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  if (m < 1440) return `há ${Math.round(m / 60)} h`;
  return `há ${Math.round(m / 1440)} d`;
}
const fitClass = (f) => (f == null ? '' : f >= 70 ? 'hi' : f >= 45 ? 'mid' : 'low');
const followUpDue = (j) =>
  j.status === 'enviado' && (j.stage || 'aguardando') === 'aguardando' && !j.followUpAt && Date.now() - j.sentAt > S.settings.followUpDays * 864e5;

function toast(msg, { action, onAction, ms = 3500, bad = false } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  if (action)
    el.querySelector('button').onclick = () => {
      onAction();
      el.remove();
    };
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

function download(name, href) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.click();
}

// ---------- renderização (agrupada: várias mudanças na mesma tarefa viram um redesenho) ----------
let dirty = new Set();
function render(...parts) {
  if (!dirty.size) queueMicrotask(flush);
  (parts.length ? parts : ['nav', 'list', 'detail']).forEach((p) => dirty.add(p));
}
function flush() {
  const d = dirty;
  dirty = new Set();
  if (d.has('nav')) renderNav();
  if (d.has('list')) renderList();
  if (d.has('detail')) renderDetail();
  if (d.has('stats') && S.view === 'stats') renderStats();
}

function visible() {
  const v = VIEWS[S.view];
  if (!v) return [];
  const q = S.q.trim().toLowerCase();
  const list = [...S.jobs.values()].filter(
    (j) => v.statuses.includes(j.status) && !S.sending.has(j.id) && (!q || `${j.title} ${j.company} ${j.email}`.toLowerCase().includes(q))
  );
  const byDate = (a, b) => (b.sentAt || b.foundAt) - (a.sentAt || a.foundAt);
  return list.sort(S.sort === 'fit' && S.view !== 'sent' ? (a, b) => (b.fit ?? -1) - (a.fit ?? -1) || byDate(a, b) : byDate);
}

function renderNav() {
  const counts = {};
  for (const j of S.jobs.values()) if (!S.sending.has(j.id)) counts[j.status] = (counts[j.status] || 0) + 1;
  const due = [...S.jobs.values()].filter(followUpDue).length;
  const btn = (id, label, n, cls = '') =>
    `<button data-view="${id}" class="${S.view === id ? 'active' : ''}" title="${label}"><span>${ICON[id]}<em>${label}</em></span>${n ? `<span class="count ${cls}">${n}</span>` : ''}</button>`;
  $('#nav').innerHTML =
    Object.entries(VIEWS)
      .map(([id, v]) => {
        const n = v.statuses.reduce((a, s) => a + (counts[s] || 0), 0);
        return id === 'sent' && due ? btn(id, v.label, `${due}<em> follow-up</em>`, 'due') : btn(id, v.label, n);
      })
      .join('') +
    '<div class="sep"></div>' +
    Object.entries(PAGES).map(([id, label]) => btn(id, label, 0)).join('');

  const s = S.settings;
  const steps = [
    ['Currículo', !!(S.meta.resumePdf || s.resumeText)],
    ['Busca definida', !!s.keywords.trim()],
    ['Gmail conectado', !!S.meta.gmailOk],
  ];
  $('#setup').innerHTML = steps.every(([, ok]) => ok)
    ? ''
    : `<div class="checklist"><b>Primeiros passos</b>${steps.map(([l, ok]) => `<div class="${ok ? 'done' : ''}" data-view="settings">${ok ? '✓' : '○'} ${l}</div>`).join('')}</div>`;

  const sc = S.scan;
  $('#scanBox').innerHTML = sc.running
    ? `<button data-act="scanStop" title="Parar">${ICON.scan}<span class="lbl">Parar busca</span></button>
       <div class="progress"><i style="width:${Math.round((100 * (sc.i + 0.5)) / Math.max(sc.total, 1))}%"></i></div>
       <span class="muted">${esc(sc.label || 'Iniciando…')} · ${sc.found} nova(s)</span>`
    : `<button class="primary" data-act="scan" title="Buscar vagas agora">${ICON.scan}<span class="lbl">Buscar vagas agora</span></button>
       <span class="muted">${sc.last ? `Última busca ${ago(sc.last)}` : 'Nenhuma busca ainda'}</span>`;

  const isPage = !!PAGES[S.view];
  $('#app').classList.toggle('is-page', isPage);
  $('#app').classList.toggle('has-sel', !!S.sel);
  for (const p of Object.keys(PAGES)) $('#' + p).classList.toggle('active', S.view === p);
}

function renderList() {
  if (!VIEWS[S.view]) return;
  const list = visible();
  if (!list.some((j) => j.id === S.sel)) S.sel = matchMedia('(max-width: 760px)').matches ? null : list[0]?.id || null;
  for (const id of S.checked) if (!list.some((j) => j.id === id)) S.checked.delete(id);

  // candidatura simplificada em lote: as selecionadas ou, sem seleção, todas as da lista
  const easy = S.view === 'noemail' ? (S.checked.size ? list.filter((j) => S.checked.has(j.id)) : list).filter(canApply).length : 0;
  const applyAll = easy ? `<button class="primary" data-act="bulkApply">⚡ Candidatar ${S.checked.size ? `nas ${easy} selecionadas` : `nas ${easy} do LinkedIn`}</button>` : '';
  $('#bulk').classList.toggle('on', S.checked.size > 0 || !!applyAll);
  $('#bulk').innerHTML = S.checked.size
    ? `<span>${S.checked.size} selecionada(s)</span>${applyAll}
       ${S.view === 'review' ? '<button class="primary" data-act="bulkSend">Enviar todas</button>' : ''}
       ${S.view === 'archive' ? '<button data-act="bulkRestore">Restaurar</button>' : '<button data-act="bulkDiscard">Descartar</button>'}
       <button class="ghost" data-act="bulkAll">Selecionar tudo</button><button class="ghost" data-act="bulkNone">Limpar</button>`
    : applyAll && `${applyAll}<span class="muted">preenche e envia cada uma</span>`;

  $('#list').innerHTML = list.length
    ? list
        .map((j) => {
          const pill = S.view === 'sent'
            ? followUpDue(j) ? ['Follow-up', 'warn'] : [STAGES[j.stage || 'aguardando'], j.stage === 'rejeitado' ? '' : j.stage && j.stage !== 'aguardando' ? 'ok' : '']
            : APPLY_PILL[j.applyState] || (canApply(j) && j.easyApply ? ['Simplificada', 'ok'] : STATUS_PILL[j.status]);
          return `<div class="item ${j.id === S.sel ? 'sel' : ''}" data-id="${j.id}">
            <input type="checkbox" ${S.checked.has(j.id) ? 'checked' : ''} aria-label="Selecionar">
            <div class="fit ${fitClass(j.fit)}">${j.fit ?? '–'}</div>
            <div class="item-main"><b>${esc(j.title)}</b>
              <span>${esc([j.company, SOURCE[j.source], ago(j.sentAt || j.foundAt)].filter(Boolean).join(' · '))}</span></div>
            ${pill ? `<span class="pill ${pill[1]}">${pill[0]}</span>` : ''}
          </div>`;
        })
        .join('')
    : emptyState();
  $('#app').classList.toggle('has-sel', !!S.sel);
}

function emptyState() {
  if (S.q) return `<div class="empty"><b>Nada encontrado</b>Nenhuma vaga combina com “${esc(S.q)}”.</div>`;
  if (S.view === 'review') {
    if (!S.settings.keywords.trim())
      return `<div class="empty"><b>Bem-vindo 👋</b>Em três passos você começa a se candidatar: currículo, busca e envio.<br><button class="primary" data-view="settings">Configurar agora</button></div>`;
    return `<div class="empty"><b>Tudo revisado</b>Nenhuma vaga esperando por você.<br><button class="primary" data-act="scan">Buscar vagas agora</button></div>`;
  }
  return `<div class="empty"><b>Vazio por aqui</b>${
    { noemail: 'Vagas sem e-mail de contato aparecem aqui, com o link para se candidatar.', sent: 'Suas candidaturas enviadas aparecem aqui para acompanhamento.', archive: 'Vagas descartadas ficam aqui.' }[S.view]
  }</div>`;
}

let shown = '';
function renderDetail() {
  if (!VIEWS[S.view]) return;
  const j = S.jobs.get(S.sel);
  const key = j ? `${j.id}|${j.status}` : '';
  // não redesenha por cima de um campo que o usuário está editando
  if (key === shown && $('#detail').contains(document.activeElement) && document.activeElement.matches('[data-f]')) return;
  shown = key;
  if (!j) return ($('#detail').innerHTML = `<div class="empty">Selecione uma vaga na lista.</div>`);

  const busy = S.busy.has(j.id);
  const sent = j.status === 'enviado';
  const hasAi = j.strengths?.length || j.gaps?.length;
  const attach = j.resumeText
    ? `📎 Currículo adaptado para esta vaga <button class="ghost" data-act="pdf">Visualizar PDF</button>`
    : S.meta.resumePdf
      ? `📎 ${esc(S.meta.resumePdf)} (currículo padrão)`
      : `⚠ Nenhum currículo — <a href="#" data-view="settings">suba o PDF nas Configurações</a>`;

  const tabs = [['email', 'E-mail'], ['resume', 'Currículo'], ['ad', 'Anúncio']];
  const pane = {
    email: `
      <div class="field"><label>Para</label><input data-f="email" value="${esc(j.email)}" placeholder="e-mail do recrutador" ${sent ? 'readonly' : ''}></div>
      <div class="field"><label>Assunto</label><input data-f="subject" value="${esc(j.subject)}" ${sent ? 'readonly' : ''}></div>
      <textarea data-f="body" rows="11" ${sent ? 'readonly' : ''} placeholder="Texto do e-mail">${esc(j.body)}</textarea>
      <div class="attach">${attach}</div>
      ${sent ? followUpHtml(j) : ''}`,
    resume: j.resumeText
      ? `<p class="muted">Este texto vira o PDF anexado. Edite à vontade.</p><textarea data-f="resumeText" rows="22">${esc(j.resumeText)}</textarea>`
      : `<div class="empty"><b>Currículo padrão</b>Esta candidatura vai com o seu PDF original.<br><button data-act="regen" ${busy ? 'disabled' : ''}>✦ Adaptar para esta vaga com IA</button></div>`,
    ad: `<pre>${esc(j.description)}</pre>`,
  }[S.tab];

  $('#detail').innerHTML = `
    <div class="d-head">
      <button class="back ghost" data-act="back">←</button>
      ${j.fit != null ? `<div class="ring ${fitClass(j.fit)}" style="--v:${j.fit}" title="Aderência ao seu currículo">${j.fit}</div>` : ''}
      <div class="grow">
        <h2>${esc(j.title)}</h2>
        <p class="muted">${esc([j.company, j.location, SOURCE[j.source], `encontrada ${ago(j.foundAt)}`].filter(Boolean).join(' · '))}</p>
        ${j.tags?.length ? `<div class="tags">${j.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
      </div>
      <a class="btn" href="${esc(j.url)}" target="_blank" rel="noopener">Abrir vaga ↗</a>
    </div>
    ${j.error ? `<div class="banner">${esc(j.error)}</div>` : ''}
    ${j.status === 'novo' ? `<div class="banner info">Preparando a candidatura…</div>` : ''}
    ${j.applyState === 'revisar' ? `<div class="banner info">Formulário preenchido. Confira na janela do LinkedIn e clique em “Enviar candidatura”.</div>` : ''}
    ${j.status === 'ignorado' || j.status === 'descartado' ? (j.note ? `<div class="banner info">${esc(j.note)}</div>` : '') : ''}
    ${
      hasAi
        ? `<div class="match">${j.note ? `<p style="margin-bottom:10px">${esc(j.note)}</p>` : ''}<div class="cols">
            <div><h4>Pontos fortes</h4><ul>${j.strengths.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
            <div><h4>Lacunas</h4><ul>${j.gaps.map((x) => `<li>${esc(x)}</li>`).join('') || '<li>Nenhuma relevante</li>'}</ul></div></div></div>`
        : j.matched
          ? `<div class="match"><h4>Requisitos encontrados no anúncio</h4><div class="tags" style="margin:0">
              ${j.matched.map((t) => `<span class="tag has">✓ ${esc(t)}</span>`).join('')}${j.missing.map((t) => `<span class="tag miss">${esc(t)}</span>`).join('')}</div></div>`
          : ''
    }
    ${sent ? `<div style="margin-top:14px" class="row"><div class="stages">${Object.entries(STAGES).map(([k, l]) => `<button data-stage="${k}" class="${(j.stage || 'aguardando') === k ? 'active' : ''}">${l}</button>`).join('')}</div>
        <span class="muted">Enviada ${ago(j.sentAt)}${j.followUpAt ? ` · follow-up ${ago(j.followUpAt)}` : ''}</span></div>` : ''}
    <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${S.tab === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div class="pane">${pane}</div>
    <div class="d-foot">${footHtml(j, busy)}</div>`;
}

function followUpHtml(j) {
  if (j.followUpAt) return `<p class="muted">Follow-up enviado ${ago(j.followUpAt)}.</p>`;
  return `<details ${followUpDue(j) ? 'open' : ''}><summary>Follow-up${followUpDue(j) ? ' — já faz alguns dias sem resposta' : ''}</summary>
    <textarea id="fuBody" rows="6">${esc(fillTemplate(S.settings.followUpTemplate, j, S.settings))}</textarea>
    <div class="row" style="margin-top:8px"><button data-act="followup">Enviar follow-up</button></div></details>`;
}

function footHtml(j, busy) {
  const ai = `<button data-act="regen" ${busy ? 'disabled' : ''}>${busy ? 'Adaptando…' : '✦ Adaptar com IA'}</button>`;
  const hint = `<span class="hint"><span><kbd>J</kbd> <kbd>K</kbd> navegar</span><span><kbd>Ctrl</kbd>+<kbd>↵</kbd> enviar</span><span><kbd>X</kbd> descartar</span></span>`;
  switch (j.status) {
    case 'pronto':
    case 'erro':
      return `<button class="primary" data-act="send">Enviar candidatura</button>${ai}<button data-act="markSent">Já me candidatei</button><button class="danger ghost" data-act="discard">Descartar</button>${hint}`;
    case 'novo':
    case 'fila':
      return `<span class="muted">${j.status === 'fila' ? 'Na fila de envio — sai em instantes.' : 'Aguarde…'}</span><button class="danger ghost" data-act="discard">Descartar</button>`;
    case 'sem_email': {
      const running = ['fila', 'rodando'].includes(j.applyState);
      const apply = canApply(j) ? `<button class="primary" data-act="apply" ${running ? 'disabled' : ''}>${running ? 'Candidatando…' : '⚡ Candidatar pelo LinkedIn'}</button>` : '';
      const site = apply
        ? `<a class="btn" href="${esc(j.url)}" target="_blank" rel="noopener">Abrir vaga ↗</a>`
        : `<a class="btn" style="background:var(--accent);color:#fff;border-color:var(--accent)" href="${esc(j.url)}" target="_blank" rel="noopener">Candidatar no site ↗</a>`;
      return `${apply}${site}${ai}<button data-act="markSent">Já me candidatei</button><button class="danger ghost" data-act="discard">Descartar</button>
        <span class="hint">Achou um e-mail? Preencha “Para” e a vaga vai para revisão.</span>`;
    }
    case 'enviado':
      return `<label style="flex:1">Anotações<textarea data-f="notes" rows="2" placeholder="Contato, data da entrevista, pretensão…">${esc(j.notes)}</textarea></label>`;
    default:
      return `<button data-act="restore">Restaurar</button><button class="danger ghost" data-act="remove">Apagar de vez</button>`;
  }
}

function renderStats() {
  const jobs = [...S.jobs.values()];
  const sent = jobs.filter((j) => j.status === 'enviado');
  const stage = (s) => sent.filter((j) => (j.stage || 'aguardando') === s).length;
  const replied = sent.length - stage('aguardando');
  const days = [...Array(14)].map((_, i) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (13 - i));
    return { d, n: sent.filter((j) => j.sentAt >= d.getTime() && j.sentAt < d.getTime() + 864e5).length };
  });
  const max = Math.max(1, ...days.map((x) => x.n));
  const hbar = (label, n, total) => `<div class="hbar"><span>${label}</span><i style="width:${total ? (100 * n) / total : 0}%"></i><span>${n}</span></div>`;
  $('#stats').innerHTML = `
    <div class="page-head"><h2>Estatísticas</h2></div>
    <div class="kpis">
      <div class="kpi"><b>${jobs.length}</b><span class="muted">vagas encontradas</span></div>
      <div class="kpi"><b>${sent.length}</b><span class="muted">candidaturas enviadas</span></div>
      <div class="kpi"><b>${sent.length ? Math.round((100 * replied) / sent.length) : 0}%</b><span class="muted">taxa de resposta</span></div>
      <div class="kpi"><b>${stage('entrevista') + stage('oferta')}</b><span class="muted">entrevistas e ofertas</span></div>
    </div>
    <div class="card"><h3>Candidaturas nos últimos 14 dias</h3>
      <div class="bars">${days.map((x) => `<div title="${x.d.toLocaleDateString('pt-BR')}: ${x.n}">${x.n || ''}<i style="height:${(100 * x.n) / max}%"></i>${x.d.getDate()}</div>`).join('')}</div></div>
    <div class="card"><h3>Funil</h3>${Object.entries(STAGES).map(([k, l]) => hbar(l, stage(k), sent.length)).join('')}</div>
    <div class="card"><h3>De onde vêm as vagas</h3>${Object.entries(SOURCE).map(([k, l]) => hbar(l, jobs.filter((j) => j.source === k).length, jobs.length)).join('')}</div>`;
}

// ---------- ações ----------
function go(view) {
  flushEdit();
  S.view = view;
  S.checked.clear();
  S.tab = 'email';
  shown = '';
  if (view === 'stats') render('nav', 'stats');
  else render();
}

function select(id) {
  flushEdit();
  S.sel = id;
  shown = '';
  render('list', 'detail');
}

function move(delta) {
  const list = visible();
  const i = list.findIndex((j) => j.id === S.sel);
  const next = list[Math.max(0, Math.min(list.length - 1, i + delta))];
  if (next && next.id !== S.sel) {
    select(next.id);
    setTimeout(() => $('.item.sel')?.scrollIntoView({ block: 'nearest' }));
  }
}

// edição com salvamento automático
let edit = null; // { id, patch, timer }
function flushEdit() {
  if (!edit) return;
  clearTimeout(edit.timer);
  call('job:patch', { id: edit.id, patch: edit.patch });
  edit = null;
}
function onEdit(el) {
  const id = S.sel;
  if (edit && edit.id !== id) flushEdit();
  edit ??= { id, patch: {} };
  edit.patch[el.dataset.f] = el.dataset.f === 'email' ? el.value.trim() : el.value;
  Object.assign(S.jobs.get(id), edit.patch);
  clearTimeout(edit.timer);
  edit.timer = setTimeout(flushEdit, 500);
}

function patch(id, p) {
  Object.assign(S.jobs.get(id) || {}, p); // resposta imediata; o storage confirma em seguida
  render();
  return call('job:patch', { id, patch: p });
}

// Ao tirar vagas da lista, a seleção pula para a vizinha (e não volta ao topo).
function advance(ids) {
  if (!ids.includes(S.sel)) return;
  const list = visible();
  const i = list.findIndex((j) => j.id === S.sel);
  const rest = [...list.slice(i + 1), ...list.slice(0, i).reverse()];
  S.sel = rest.find((j) => !ids.includes(j.id))?.id || null;
  shown = '';
}

function discard(ids) {
  advance(ids);
  const prev = ids.map((id) => [id, S.jobs.get(id).status]);
  prev.forEach(([id, st]) => patch(id, { status: 'descartado', prevStatus: st }));
  S.checked.clear();
  toast(ids.length > 1 ? `${ids.length} vagas descartadas` : 'Vaga descartada', {
    action: 'Desfazer', ms: 6000, onAction: () => prev.forEach(([id, st]) => patch(id, { status: st })),
  });
}

const restore = (ids) => ids.forEach((id) => {
  const j = S.jobs.get(id);
  patch(id, { status: j.prevStatus && j.prevStatus !== 'fila' ? j.prevStatus : j.email ? 'pronto' : 'sem_email' });
});

function resumeHref(j) {
  return URL.createObjectURL(new Blob([textToPdf(j.resumeText)], { type: 'application/pdf' }));
}

async function sendJob(id) {
  flushEdit();
  const j = S.jobs.get(id);
  if (!j?.email) return toast('Informe o e-mail do recrutador em “Para”.', { bad: true });
  if (!j.subject || !j.body) return toast('Assunto e texto do e-mail não podem ficar vazios.', { bad: true });

  if (!S.settings.gmailClientId) {
    // Sem OAuth configurado: abre o Gmail preenchido e entrega o anexo para o usuário arrastar.
    const u = new URL('https://mail.google.com/mail/?view=cm&fs=1');
    u.searchParams.set('to', j.email);
    u.searchParams.set('su', j.subject);
    u.searchParams.set('body', j.body);
    window.open(u.toString(), '_blank');
    if (j.resumeText) download(`Curriculo - ${S.settings.name || 'candidato'}.pdf`, resumeHref(j));
    return toast('Gmail aberto. Anexe o currículo, envie e depois clique em “Já me candidatei”.', { ms: 9000 });
  }

  // 5 segundos para desfazer antes de enviar de verdade
  advance([id]);
  S.sending.set(id, setTimeout(async () => {
    const res = await call('job:send', { id });
    S.sending.delete(id);
    if (res?.ok) toast(`Enviada para ${j.email} ✓`);
    else {
      await call('job:patch', { id, patch: { status: 'erro', error: res?.error || 'Falha no envio.' } });
      toast(res?.error || 'Falha no envio.', { bad: true, ms: 7000 });
    }
    render();
  }, 5000));
  toast(`Enviando para ${j.email}…`, {
    action: 'Desfazer', ms: 5000,
    onAction: () => {
      clearTimeout(S.sending.get(id));
      S.sending.delete(id);
      S.sel = id;
      render();
    },
  });
  shown = '';
  render();
}

async function regen(id) {
  flushEdit();
  if (!aiKey(S.settings)) {
    toast(`Informe a chave de API de ${providerOf(S.settings).label} nas Configurações para usar a IA.`, { bad: true });
    return go('settings');
  }
  S.busy.add(id);
  shown = '';
  render('detail');
  const res = await call('job:regen', { id });
  S.busy.delete(id);
  shown = '';
  if (!res?.ok) toast(res?.error || 'A IA falhou.', { bad: true, ms: 7000 });
  render('detail');
}

const actions = {
  scan: () => {
    if (!S.settings.keywords.trim()) {
      toast('Defina primeiro os cargos que você procura.');
      return go('settings');
    }
    call('scanNow');
  },
  scanStop: () => call('scanStop'),
  back: () => select(null),
  send: () => sendJob(S.sel),
  regen: () => regen(S.sel),
  discard: () => discard([S.sel]),
  restore: () => {
    const id = S.sel;
    advance([id]);
    restore([id]);
  },
  remove: () => call('jobs:remove', { ids: [S.sel] }),
  markSent: () => {
    const id = S.sel;
    advance([id]);
    patch(id, { status: 'enviado', stage: 'aguardando', sentAt: Date.now(), error: '' });
  },
  pdf: () => window.open(resumeHref(S.jobs.get(S.sel)), '_blank'),
  followup: async () => {
    if (!S.settings.gmailClientId) return toast('Conecte o Gmail nas Configurações para enviar o follow-up.', { bad: true });
    const res = await call('job:followup', { id: S.sel, body: $('#fuBody').value });
    toast(res?.ok ? 'Follow-up enviado ✓' : res?.error || 'Falhou.', { bad: !res?.ok });
  },
  bulkSend: () => {
    const ids = [...S.checked].filter((id) => ['pronto', 'erro'].includes(S.jobs.get(id)?.status) && S.jobs.get(id).email);
    if (!S.settings.gmailClientId) return toast('O envio em lote precisa do Gmail conectado (Configurações).', { bad: true });
    S.checked.clear();
    ids.forEach((id) => Object.assign(S.jobs.get(id), { status: 'fila' }));
    call('job:queue', { ids });
    toast(`${ids.length} candidatura(s) na fila de envio.`);
    render();
  },
  apply: async () => {
    await call('apply:start', { ids: [S.sel] });
    toast('Abrindo a vaga no LinkedIn para preencher a candidatura…', { ms: 6000 });
  },
  bulkApply: async () => {
    const ids = (S.checked.size ? visible().filter((j) => S.checked.has(j.id)) : visible()).filter(canApply).map((j) => j.id);
    S.checked.clear();
    await call('apply:start', { ids });
    toast(`${ids.length} candidatura(s) na fila: a janela do LinkedIn abre e preenche uma por vez.`, { ms: 12000, action: 'Parar', onAction: () => call('apply:stop') });
    render('list');
  },
  bulkDiscard: () => discard([...S.checked]),
  bulkRestore: () => {
    restore([...S.checked]);
    S.checked.clear();
  },
  bulkAll: () => {
    visible().forEach((j) => S.checked.add(j.id));
    render('list');
  },
  bulkNone: () => {
    S.checked.clear();
    render('list');
  },
};

document.addEventListener('click', (e) => {
  const t = e.target;
  const viewEl = t.closest('[data-view]');
  if (viewEl) {
    e.preventDefault();
    return go(viewEl.dataset.view);
  }
  const act = t.closest('[data-act]');
  if (act) return actions[act.dataset.act]?.();
  if (t.dataset.tab) {
    flushEdit();
    S.tab = t.dataset.tab;
    shown = '';
    return render('detail');
  }
  if (t.dataset.stage) return patch(S.sel, { stage: t.dataset.stage });
  const item = t.closest('.item');
  if (item) {
    if (t.matches('input[type=checkbox]')) {
      t.checked ? S.checked.add(item.dataset.id) : S.checked.delete(item.dataset.id);
      return render('list');
    }
    select(item.dataset.id);
  }
});

$('#detail').addEventListener('input', (e) => e.target.dataset.f && onEdit(e.target));
$('#search').addEventListener('input', (e) => {
  S.q = e.target.value;
  render('list', 'detail');
});
$('#sort').addEventListener('change', (e) => {
  S.sort = e.target.value;
  render('list');
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && VIEWS[S.view] && ['pronto', 'erro'].includes(S.jobs.get(S.sel)?.status)) {
    e.preventDefault();
    return sendJob(S.sel);
  }
  if (e.target.matches('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey || !VIEWS[S.view]) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 'j' || e.key === 'ArrowDown') move(1);
  else if (k === 'k' || e.key === 'ArrowUp') move(-1);
  else if (k === 'x' && S.sel && S.view !== 'archive' && S.view !== 'sent') discard([S.sel]);
  else if (k === '/') $('#search').focus();
  else return;
  e.preventDefault();
});

// ---------- configurações (salvamento automático) ----------
// Os campos de chave e modelo apontam para a configuração do provedor escolhido.
$('#aiProvider').innerHTML = Object.entries(PROVIDERS).map(([id, p]) => `<option value="${id}">${p.label}</option>`).join('');
function bindProvider() {
  const p = providerOf(S.settings);
  $('#aiKey').dataset.key = p.keyField;
  $('#aiKey').placeholder = p.keyHint;
  $('#aiModel').dataset.key = p.modelField;
  $('#aiModel').placeholder = p.base ? 'automático' : `padrão: ${p.defaultModel}`;
  $('#aiKey').value = S.settings[p.keyField] || '';
  $('#aiModel').value = S.settings[p.modelField] || '';
  $('#aiKeyLink').href = p.keyUrl;
  $('#aiHint').textContent = p.hint;
  checkModels(false);
}

// Mostra quais modelos responderam ao teste feito com a chave do usuário e qual está em uso.
let checkRun = 0;
async function checkModels(force) {
  const run = ++checkRun;
  const p = providerOf(S.settings);
  const status = $('#aiModelStatus');
  $('#aiCheckRow').hidden = !p.base;
  if (!p.base || !aiKey(S.settings)) {
    status.textContent = p.base ? 'Cole a chave para eu testar quais modelos ela pode usar.' : '';
    const models = await listModels(S.settings).catch(() => []);
    if (run === checkRun) $('#aiModels').innerHTML = models.map((m) => `<option value="${esc(m)}">`).join('');
    return;
  }
  status.textContent = 'Testando quais modelos respondem com a sua chave…';
  $('#aiCheck').disabled = true;
  const res = await call('ai:models', { force });
  if (run !== checkRun) return; // o usuário já trocou de provedor ou de chave
  $('#aiCheck').disabled = false;
  if (!res?.ok) return (status.textContent = res?.error || 'Não consegui testar os modelos.');
  const { working, failed, others = [] } = res.entry;
  $('#aiModels').innerHTML =
    working.map((m) => `<option value="${esc(m.id)}" label="${m.limited ? 'sem cota agora' : 'respondeu ao teste'}">`).join('') +
    others.map((id) => `<option value="${esc(id)}" label="não testado">`).join('');
  let chosen = S.settings[p.modelField];
  if (chosen && failed.some((f) => f.id === chosen)) {
    // o modelo escolhido não responde com esta chave: volta para a escolha automática
    toast(`O modelo ${chosen} não está disponível para esta chave. Voltei para a escolha automática.`, { ms: 8000 });
    await setSettings({ [p.modelField]: '' });
    S.settings = await getSettings();
    $('#aiModel').value = chosen = '';
  }
  if (!working.length) return (status.textContent = `Nenhum modelo respondeu com esta chave. ${failed[0] ? `${failed[0].id}: ${failed[0].reason}` : ''}`);
  $('#aiModel').placeholder = `automático: ${working[0].id}`;
  status.textContent =
    `✓ ${working.length} modelo(s) respondem com esta chave. Em uso: ${chosen || `${working[0].id} (automático)`}.` +
    (failed.length ? ` Sem acesso: ${failed.map((f) => f.id).join(', ')}.` : '');
}
$('#aiCheck').addEventListener('click', async () => {
  await saveSettings();
  S.settings = await getSettings();
  checkModels(true);
});
$('#aiModel').addEventListener('change', () => setTimeout(() => checkModels(false), 600));
$('#aiProvider').addEventListener('change', async () => {
  await saveSettings(); // grava a chave/modelo do provedor anterior antes de trocar os campos
  S.settings = await getSettings();
  bindProvider();
});
$('#aiKey').addEventListener('change', async () => {
  await saveSettings();
  S.settings = await getSettings();
  checkModels(true);
});

function fillSettings() {
  bindProvider();
  document.querySelectorAll('[data-key]').forEach((el) => {
    if (el.type === 'checkbox') el.checked = !!S.settings[el.dataset.key];
    else el.value = S.settings[el.dataset.key] ?? '';
  });
  document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === S.settings.mode));
  $('#redirectUri').textContent = redirectUri();
}

let saveTimer;
function saveSettingsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 400);
}
async function saveSettings() {
  clearTimeout(saveTimer);
  const s = {};
  document.querySelectorAll('[data-key]').forEach((el) => {
    s[el.dataset.key] = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.dataset.key === 'scanEveryHours' ? Number(el.value) : el.value.trim();
  });
  await setSettings(s);
  await call('settings:changed');
  $('#saveStatus').textContent = 'Salvo ✓';
  setTimeout(() => ($('#saveStatus').textContent = ''), 1500);
}
$('#settings').addEventListener('input', (e) => e.target.dataset.key && saveSettingsSoon());
$('#settings').addEventListener('submit', (e) => e.preventDefault());

$('#modeSeg').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  await setSettings({ mode: b.dataset.mode });
  document.querySelectorAll('#modeSeg button').forEach((x) => x.classList.toggle('active', x === b));
  if (b.dataset.mode === 'ai' && !$('#aiKey').value) {
    toast('Escolha o provedor e cole a chave de API para ativar a IA.');
    $('#aiKey').focus();
  }
});

const bytesToB64 = (bytes) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

async function saveResume(file) {
  if (!file || file.type !== 'application/pdf') return toast('Escolha um arquivo PDF.', { bad: true });
  if (file.size > 15 * 1024 * 1024) return toast('PDF grande demais (o limite é 15 MB).', { bad: true });
  const bytes = new Uint8Array(await file.arrayBuffer());
  await chrome.storage.local.set({ resumePdf: { name: file.name, b64: bytesToB64(bytes) } });
  await fillFromResume(bytes);
}

const PROFILE_FIELDS = { name: 'nome', email: 'e-mail', location: 'localização', skills: 'habilidades', keywords: 'buscas', resumeText: 'texto do currículo', phone: 'celular', city: 'cidade', linkedinUrl: 'LinkedIn' };
const listPt = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} e ${items.at(-1)}` : items[0] || '');

// Lê o PDF e preenche sozinho o que estiver vazio. Campo que já tinha valor só muda se o usuário pedir.
async function fillFromResume(bytes) {
  let profile;
  try {
    profile = profileFromResume((await extractPdfText(bytes)).lines);
  } catch (e) {
    return toast(`Currículo salvo, mas não consegui ler o PDF: ${e.message}. Preencha os campos à mão ou use “Refinar com IA”.`, { bad: true, ms: 10000 });
  }
  if (profile.resumeText.length < 200)
    return toast('Currículo salvo, mas o PDF parece ser uma imagem, sem texto para ler. Preencha os campos à mão ou use “Refinar com IA”.', { bad: true, ms: 10000 });

  // dados de contato para os formulários de candidatura no site
  profile.phone = profile.resumeText.match(/(?:\+?55[\s.-]*)?\(?\d{2}\)?[\s.-]*9?\d{4}[\s.-]?\d{4}/)?.[0].trim() || '';
  profile.linkedinUrl = (profile.resumeText.match(/linkedin\.com\/in\/[\w%-]+/i) || [])[0]?.replace(/^/, 'https://www.') || '';
  profile.city = profile.location;

  await saveSettings(); // o que já está digitado na tela conta como preenchido
  const current = await getSettings();
  const fill = {};
  const replace = {};
  for (const key of Object.keys(PROFILE_FIELDS)) {
    const had = String(current[key] ?? '').trim();
    if (!profile[key]) continue;
    if (!had) fill[key] = profile[key];
    else if (had !== profile[key]) replace[key] = profile[key];
  }
  const apply = async (values) => {
    await setSettings(values);
    S.settings = await getSettings();
    fillSettings();
    await call('settings:changed');
    render('nav');
  };
  const names = (values) => listPt(Object.keys(values).map((k) => PROFILE_FIELDS[k]));
  await apply(fill);
  const differ = Object.keys(replace).length;
  const message = Object.keys(fill).length
    ? `Currículo lido: preenchi ${names(fill)}. Confira e ajuste o que quiser.`
    : differ
      ? 'Currículo lido. Os campos já estavam preenchidos.'
      : 'Currículo lido: os campos já estão de acordo com ele.';
  if (!differ) return toast(message, { ms: 8000 });
  toast(message, {
    ms: 20000,
    action: `Trocar também ${names(replace)}`,
    onAction: async () => {
      await apply(replace);
      toast('Campos atualizados com o currículo novo.');
    },
  });
}
$('#resumeFile').addEventListener('change', (e) => saveResume(e.target.files[0]));
const drop = $('#drop');
['dragover', 'dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.toggle('over', ev === 'dragover');
    if (ev === 'drop') saveResume(e.dataTransfer.files[0]);
  })
);

async function withButton(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

$('#refillBtn').addEventListener('click', (e) =>
  withButton(e.target, 'Lendo o PDF…', async () => {
    const { resumePdf } = await chrome.storage.local.get('resumePdf');
    if (!resumePdf?.b64) return toast('Carregue primeiro o PDF do currículo.', { bad: true });
    await fillFromResume(Uint8Array.from(atob(resumePdf.b64), (c) => c.charCodeAt(0)));
  })
);
$('#analyzeBtn').addEventListener('click', (e) =>
  withButton(e.target, 'Lendo seu currículo…', async () => {
    await saveSettings();
    const res = await call('resume:analyze');
    if (!res?.ok) return toast(res?.error || 'A IA falhou.', { bad: true, ms: 7000 });
    S.settings = await getSettings();
    fillSettings();
    toast('Pronto: preenchi nome, habilidades e sugestões de busca. Confira abaixo.', { ms: 6000 });
  })
);
// O conserto de um erro de conexão é feito no Google Cloud, em outra aba: o aviso fica na tela até a próxima tentativa.
function gmailProblem(msg) {
  const el = $('#gmailProblem');
  el.hidden = !msg;
  if (!msg) return;
  const uri = redirectUri();
  const [label, href] = /Gmail API/.test(msg)
    ? ['Ativar a Gmail API ↗', 'https://console.cloud.google.com/apis/library/gmail.googleapis.com']
    : /Público-alvo/.test(msg)
      ? ['Abrir Público-alvo no Google Cloud ↗', 'https://console.cloud.google.com/auth/audience']
      : /Google Cloud/.test(msg)
        ? ['Abrir Clientes no Google Cloud ↗', 'https://console.cloud.google.com/auth/clients']
        : [];
  el.innerHTML =
    `<span>${esc(msg)}</span><span class="row">` +
    (msg.includes(uri) ? '<button type="button">Copiar endereço</button>' : '') +
    (href ? `<a href="${href}" target="_blank" rel="noopener">${label}</a>` : '') +
    '</span>';
  el.querySelector('button')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(uri);
    toast('Copiado ✓');
  });
  el.scrollIntoView({ block: 'nearest' });
}
$('#gmailBtn').addEventListener('click', (e) =>
  withButton(e.target, 'Conferindo com o Google…', async () => {
    await saveSettings();
    const res = await call('gmail:connect');
    gmailProblem(res?.ok ? '' : res?.error || 'Não foi possível conectar.');
    if (res?.ok) toast('Gmail conectado ✓');
  })
);
$('#gmailTest').addEventListener('click', (e) =>
  withButton(e.target, 'Enviando…', async () => {
    await saveSettings();
    const res = await call('gmail:test');
    gmailProblem(res?.ok ? '' : res?.error || 'Não foi possível enviar o teste.');
    if (res?.ok) toast(`Teste enviado para ${S.settings.email} ✓`, { ms: 6000 });
  })
);
$('#copyUri').addEventListener('click', async () => {
  await navigator.clipboard.writeText(redirectUri());
  toast('Copiado ✓');
});

$('#exportCsv').addEventListener('click', () => {
  const cols = ['title', 'company', 'location', 'source', 'email', 'status', 'stage', 'fit', 'url', 'foundAt', 'sentAt', 'notes'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [...S.jobs.values()].map((j) => cols.map((c) => cell(/At$/.test(c) && j[c] ? new Date(j[c]).toISOString() : j[c])).join(';'));
  download('auto-vagas.csv', URL.createObjectURL(new Blob(['﻿' + [cols.join(';'), ...rows].join('\r\n')], { type: 'text/csv' })));
});
$('#clearArchive').addEventListener('click', async () => {
  const ids = [...S.jobs.values()].filter((j) => VIEWS.archive.statuses.includes(j.status)).map((j) => j.id);
  await call('jobs:remove', { ids });
  toast(`${ids.length} vaga(s) apagada(s).`);
});
$('#wipe').addEventListener('click', async () => {
  if (!confirm('Apagar TODAS as vagas e candidaturas? Isso não pode ser desfeito.')) return;
  await call('jobs:wipe');
  toast('Tudo apagado.');
});

// ---------- sincronização com o storage ----------
// Perguntas que pararam uma candidatura no site e as respostas que o usuário já salvou.
async function renderApply() {
  const { applyPending = [] } = await chrome.storage.local.get('applyPending');
  const field = (p, i) =>
    p.options?.length
      ? `<select data-pending="${i}"><option value="">Escolha…</option>${p.options.filter((o) => !/^(selecion|select|escolh|choose)/i.test(o.trim())).map((o) => `<option>${esc(o)}</option>`).join('')}</select>`
      : `<input data-pending="${i}" placeholder="Sua resposta">`;
  $('#applyPending').innerHTML = applyPending.length
    ? `<div class="alert ask"><b>${applyPending.length} pergunta(s) esperando a sua resposta</b>
        ${applyPending.map((p, i) => `<label>${esc(p.label)} <span class="muted">${p.job ? '— ' + esc(p.job) : ''}</span>${field(p, i)}</label>`).join('')}
        <span class="row"><button type="button" class="primary" id="applySave">Salvar respostas</button><span class="muted">Depois é só clicar em Candidatar de novo nas vagas que pararam.</span></span></div>`
    : '';
  const saved = Object.entries(S.settings.applyAnswers || {});
  $('#applyAnswersTitle').textContent = `Respostas salvas (${saved.length})`;
  $('#applyAnswers').innerHTML = saved.length
    ? `<div class="answers">${saved.map(([q, a]) => `<span><b>${esc(q)}</b>: ${esc(a)}</span><button type="button" data-forget="${esc(q)}">Esquecer</button>`).join('')}</div>`
    : '<p class="muted">Nenhuma ainda. Elas aparecem aqui quando você responde a uma pergunta de candidatura.</p>';
}
$('#applyPending').addEventListener('click', async (e) => {
  if (e.target.id !== 'applySave') return;
  const { applyPending = [] } = await chrome.storage.local.get('applyPending');
  const applyAnswers = { ...S.settings.applyAnswers };
  const left = applyPending.filter((p, i) => {
    const value = $(`[data-pending="${i}"]`)?.value.trim();
    if (value) applyAnswers[p.key] = value;
    return !value;
  });
  await setSettings({ applyAnswers });
  await chrome.storage.local.set({ applyPending: left });
  toast('Respostas salvas ✓');
});
$('#applyAnswers').addEventListener('click', async (e) => {
  const q = e.target.dataset.forget;
  if (!q) return;
  const { [q]: _gone, ...applyAnswers } = S.settings.applyAnswers || {};
  await setSettings({ applyAnswers });
});

async function loadMeta() {
  const { resumePdf, gmailToken, log = [] } = await chrome.storage.local.get(['resumePdf', 'gmailToken', 'log']);
  // o token vale 1 hora, mas se renova sozinho: só deixa de existir quando o Google exige um novo login
  S.meta = { resumePdf: resumePdf?.name, gmailOk: !!gmailToken };
  $('#resumeName').textContent = resumePdf ? `✓ ${resumePdf.name} — clique ou arraste para trocar` : 'Arraste o PDF do currículo aqui ou clique para escolher';
  $('#gmailStatus').textContent = S.meta.gmailOk ? '✓ Conectado' : '';
  $('#logList').innerHTML = log.map((l) => `<li><span class="muted">${new Date(l.t).toLocaleString('pt-BR')}</span> — ${esc(l.msg)}</li>`).join('') || '<li class="muted">Nada ainda.</li>';
}

chrome.storage.onChanged.addListener(async (ch) => {
  let jobs = false;
  for (const [k, c] of Object.entries(ch)) {
    if (!k.startsWith(JOB_PREFIX)) continue;
    jobs = true;
    const id = k.slice(JOB_PREFIX.length);
    if (!c.newValue) S.jobs.delete(id);
    else S.jobs.set(id, edit?.id === id ? { ...c.newValue, ...edit.patch } : c.newValue);
  }
  if (ch.settings) S.settings = { ...DEFAULTS, ...ch.settings.newValue };
  if (ch.scan) S.scan = ch.scan.newValue || {};
  if (ch.resumePdf || ch.gmailToken || ch.log) await loadMeta();
  if (ch.applyPending || ch.settings) renderApply();
  if (jobs) render('nav', 'list', 'detail', 'stats');
  else render('nav');
});

// Tela nova com código de fundo antigo dá erros que já foram corrigidos: confere antes de montar o painel.
const background = await freshBackground();
if (!background.ok) toast(STALE_HELP, { bad: true, ms: 3600e3 });
else if (background.updatedFrom) {
  toast(`Extensão atualizada da versão ${background.updatedFrom} para a ${BUILD} ✓`, { ms: 7000 });
  await log(`Extensão atualizada da versão ${background.updatedFrom} para a ${BUILD}.`);
}

S.settings = await getSettings();
S.scan = (await chrome.storage.local.get('scan')).scan || {};
for (const j of await getJobs()) S.jobs.set(j.id, j);
await loadMeta();
fillSettings();
renderApply();
if (location.hash === '#settings' || !S.settings.keywords.trim()) S.view = 'settings';
render();
setInterval(() => render('nav'), 60_000); // mantém "há X min" atualizado
