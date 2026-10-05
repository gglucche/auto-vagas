import { getJobs } from '../lib/store.js';
import { freshBackground, STALE_HELP } from './fresh.js';

const $ = (s) => document.querySelector(s);
const call = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

if (!(await freshBackground()).ok) $('#msg').textContent = STALE_HELP;

const jobs = await getJobs();
const { sentLog, scan } = await chrome.storage.local.get(['sentLog', 'scan']);
$('#kReview').textContent = jobs.filter((j) => j.status === 'pronto').length;
$('#kToday').textContent = sentLog?.date === new Date().toLocaleDateString('sv') ? sentLog.count : 0;
$('#kTotal').textContent = jobs.filter((j) => j.status === 'enviado').length;
if (scan?.running) {
  $('#scan').disabled = true;
  $('#scan').textContent = 'Buscando…';
}

$('#open').onclick = async () => {
  await call('openDashboard');
  window.close();
};

$('#scan').onclick = async () => {
  await call('scanNow');
  $('#scan').disabled = true;
  $('#scan').textContent = 'Buscando…';
  $('#msg').textContent = 'Busca iniciada: os sites são consultados direto, sem abrir aba. Leva menos de um minuto.';
};

// Runs on the open page (any job site) and returns the job posting.
function grabPage() {
  const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
  const picked = String(getSelection());
  const root = document.querySelector('main, article, [role="main"]') || document.body;
  const text = (picked.length > 80 ? picked : root.innerText).replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000);
  const meta = (p) => document.querySelector(`meta[property="${p}"]`)?.content || '';
  return {
    source: 'captura',
    title: (document.querySelector('h1')?.innerText || meta('og:title') || document.title).trim().slice(0, 140),
    company: meta('og:site_name') || location.hostname.replace(/^www\./, ''),
    location: '',
    url: location.href,
    description: text,
    emails: [...new Set((text.match(EMAIL) || []).map((e) => e.toLowerCase()))],
  };
}

// Application form on any site: fills in whatever it knows, without clicking anything.
$('#fill').onclick = async () => {
  $('#msg').textContent = 'Preenchendo…';
  const res = await call('apply:fill');
  if (!res?.ok) return ($('#msg').textContent = res?.error || 'Falhou.');
  $('#msg').textContent =
    `Preenchi ${res.filled} campo(s).` + (res.unknown.length ? ` Sem resposta: ${res.unknown.slice(0, 4).join('; ')}. Preencha na página: a extensão guarda para a próxima vez.` : ' Confira e envie.');
};

$('#capture').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const [{ result: job }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: grabPage });
    const res = await call('capture', { job });
    $('#msg').textContent = !res?.ok ? res?.error || 'Falhou.' : res.added ? 'Vaga salva ✓ — veja no painel.' : 'Esta vaga já estava salva.';
  } catch {
    $('#msg').textContent = 'Não consegui ler esta página (páginas internas do Chrome não são permitidas).';
  }
};
