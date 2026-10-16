// On the company's site, in a tab opened from the dashboard for a job ("Candidatar no site"): a small card offers to
// fill in the application form with what the extension knows (content/apply.js does the filling), step by step, and
// notices when the page says the application was received.
// Injected by the background on each page of that tab only. The card lives in a closed shadow root, apart from the
// page's styles and scripts; nothing is filled in or sent without the user's click, except marking the job as
// applied in the dashboard when the page thanks for an application this card filled in.
(async () => {
  if (window.__autoVagasHelper) return;
  window.__autoVagasHelper = true;

  const ask = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ');
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

  const info = await ask({ type: 'site:job' });
  if (!info?.ok || !info.job || info.job.sent) return;
  const state = { filled: info.filled, shownFor: '', dismissed: '', done: false };

  // what a page says after an application goes in
  const SENT =
    /candidatura (foi )?(enviada|recebida|realizada|concluida|finalizada|registrada)|recebemos (a )?sua candidatura|obrigad[oa] (por|pela) (se candidatar|sua candidatura|candidatar-se)|thank you for (applying|your application)|application (has been |was )?(submitted|received)|we('ve| have) received your application|gracias por (postularte|tu postulacion|aplicar)/;
  // fields an application form has (a search box or a newsletter signup alone doesn't count)
  const HINT = /nome|name|e-?mail|telefone|celular|phone|mobile|linkedin|curr[ií]culo|resume|\bcv\b|cidade|city|endere[cç]o|address|sal[aá]ri|pretens|cover|carta|portf/i;
  const describe = (el) => [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('autocomplete'), el.labels?.[0]?.textContent].join(' ');
  function formFields() {
    const fields = [...document.querySelectorAll('input, select, textarea')].filter(
      (el) => !el.disabled && !['hidden', 'submit', 'button', 'image', 'reset', 'search', 'password'].includes(el.type) && (el.type === 'file' || visible(el))
    );
    const hinted = fields.filter((el) => HINT.test(describe(el))).length;
    return (fields.some((el) => el.type === 'file') && fields.length >= 2) || hinted >= 2 ? fields : [];
  }
  const signature = (fields) => fields.map((el) => el.name || el.id || el.type).join('|');

  // ---------- the card ----------
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    :host { all: initial; }
    .card { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; width: 320px; box-sizing: border-box; padding: 14px 14px 12px;
      font: 13.5px/1.45 "Segoe UI", system-ui, sans-serif; color: #171a21; background: #fff; border: 1px solid #e4e7ec; border-radius: 12px;
      box-shadow: 0 12px 32px rgba(16, 24, 40, .18); }
    .head { display: flex; align-items: center; gap: 6px; font-weight: 700; margin-bottom: 4px; }
    .x { margin-left: auto; border: 0; background: none; color: inherit; font: 18px/1 sans-serif; cursor: pointer; opacity: .55; padding: 2px 4px; }
    .job { color: #667085; font-size: 12.5px; margin-bottom: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    p { margin: 0 0 10px; }
    .muted { color: #667085; font-size: 12.5px; }
    ul { margin: -4px 0 10px; padding-left: 18px; color: #667085; font-size: 12.5px; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; }
    button.b { font: inherit; font-weight: 600; padding: 7px 12px; border-radius: 8px; border: 1px solid #d0d5dd; background: none; color: inherit; cursor: pointer; }
    button.b:disabled { opacity: .6; cursor: default; }
    button.p { background: #4f46e5; border-color: #4f46e5; color: #fff; }
    @media (prefers-color-scheme: dark) {
      .card { color: #e7eaf0; background: #161a21; border-color: #272d38; }
      .job, .muted, ul { color: #8f99a8; }
      button.b { border-color: #3a4250; }
      button.p { background: #6d67ff; border-color: #6d67ff; }
    }
  </style><div class="card" role="dialog" aria-label="Auto Vagas"><div class="head">⚡ Auto Vagas<button class="x" aria-label="Fechar">×</button></div>
    <div class="job"></div><div class="body"></div></div>`;
  root.querySelector('.job').textContent = [info.job.title, info.job.company].filter(Boolean).join(' · ');
  const body = root.querySelector('.body');
  root.querySelector('.x').onclick = () => hide(true);

  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const button = (text, primary, onclick) => {
    const b = el('button', text, primary ? 'b p' : 'b');
    b.onclick = onclick;
    return b;
  };
  function show(...children) {
    body.replaceChildren(...children);
    if (!host.isConnected) document.documentElement.append(host);
  }
  function hide(dismiss) {
    if (dismiss) state.dismissed = state.shownFor;
    host.remove();
  }

  function offer(fields) {
    state.shownFor = signature(fields);
    const again = state.filled;
    const text = info.stopped && !state.offered
      ? 'A candidatura parou aqui. Termine e envie; quando a página agradecer, eu registro no painel.'
      : again
        ? 'Nova etapa do formulário. Quer que eu preencha esta também?'
        : 'Posso preencher este formulário com seus dados e o seu currículo. Você confere e envia.';
    state.offered = true;
    show(el('p', text), row(button(again ? 'Preencher esta etapa' : 'Preencher', true, fill), button('Já enviei', false, markSent), button('Agora não', false, () => hide(true))));
  }
  function row(...buttons) {
    const r = el('div', null, 'row');
    r.append(...buttons);
    return r;
  }

  async function fill() {
    show(el('p', 'Preenchendo… Com a IA, as perguntas podem levar alguns segundos.'));
    const res = await ask({ type: 'site:fill' });
    if (!res?.ok) return show(el('p', `Não consegui preencher: ${res?.error || 'a página não respondeu'}.`), row(button('Tentar de novo', true, fill), button('Fechar', false, () => hide(true))));
    state.filled = true;
    state.shownFor = signature(formFields());
    const parts = [el('p', res.filled ? `Preenchi ${res.filled} campo(s). Confira tudo antes de enviar.` : 'Não achei nada que eu soubesse preencher aqui.')];
    if (res.unknown?.length) {
      parts.push(el('p', 'Sem resposta (preencha na página; eu guardo para a próxima vez):', 'muted'));
      const list = el('ul');
      list.append(...res.unknown.slice(0, 6).map((label) => el('li', label)));
      parts.push(list);
      if (!res.ai) parts.push(el('p', 'Com a IA configurada no painel, perguntas assim são respondidas a partir do seu currículo.', 'muted'));
    }
    parts.push(row(button('Já enviei', false, markSent), button('Fechar', false, () => hide(true))));
    show(...parts);
  }

  async function markSent() {
    state.done = true;
    const res = await ask({ type: 'site:sent' });
    show(el('p', res?.marked ? 'Candidatura registrada no painel ✓' : 'Não consegui registrar; marque “Já me candidatei” no painel.'));
    setTimeout(() => hide(false), 6000);
  }

  // ---------- watching the page ----------
  const started = Date.now();
  const timer = setInterval(() => {
    if (state.done || Date.now() - started > 45 * 60_000) return clearInterval(timer);
    const fields = formFields();
    // the thanks counts once the form is gone (a form page may say "after your application is sent…")
    if (!fields.length && SENT.test(norm(document.body?.innerText).slice(0, 20000))) {
      // after a form this card filled in, the thanks is enough; otherwise the user confirms
      if (state.filled) return markSent();
      state.done = true;
      return show(el('p', 'Parece que a candidatura foi enviada.'), row(button('Marcar como enviada', true, markSent), button('Não foi', false, () => hide(false))));
    }
    const sig = signature(fields);
    if (!fields.length || sig === state.shownFor || sig === state.dismissed) return;
    offer(fields);
  }, 1500);
})();
