// Preenche formulários de candidatura na página: a "Candidatura simplificada" do LinkedIn, etapa por etapa,
// e — a pedido do usuário, pelo botão da extensão — os campos de qualquer formulário aberto.
// É injetado pelo background. As respostas vêm dele (lib/answers.js); aqui só se lê e se mexe na página.
// Os elementos são achados pelo texto e pelo papel (botão, diálogo, rótulo), não por classes, que mudam.
(() => {
  if (window.__autoVagasApply) return;
  window.__autoVagasApply = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pause = (a = 350, b = 900) => sleep(a + Math.random() * (b - a));
  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const ask = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

  const RE = {
    easy: /candidatura simplificada|easy apply|solicitud sencilla/,
    resume: /continuar candidatura|continue applying/,
    next: /^(avancar|proxim[oa]|continuar|next|continue)\b|avancar para|continue to next/,
    review: /^(revisar|review)\b|revise sua candidatura|review your application/,
    submit: /enviar candidatura|submit application|^enviar$|^submit$/,
    done: /^(concluido|done|pronto|ok)\b/,
    close: /^(fechar|dismiss|close)\b/,
    discard: /^(descartar|discard)\b/,
    sent: /candidatura (foi )?enviada|application (was )?(sent|submitted)|sua candidatura foi|your application was sent/,
    applied: /candidatou-se|candidatura enviada|voce se candidatou|\bapplied\b/,
    closed: /nao aceita mais candidaturas|no longer accepting applications|vaga encerrada/,
    // dados que não se guardam nem se aprendem
    secret: /senha|password|cpf|\brg\b|passaporte|passport|cartao|card|cvv|social security|\bssn\b/,
  };

  const clickables = (root) => [...root.querySelectorAll('button, [role="button"], a.jobs-apply-button, input[type="submit"]')].filter((el) => visible(el) && !el.disabled);
  const find = (root, re) => clickables(root).find((el) => re.test(norm(el.getAttribute('aria-label'))) || re.test(norm(el.innerText || el.value)));
  async function waitFor(fn, ms = 10000, step = 300) {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) {
      const v = fn();
      if (v) return v;
    }
    return null;
  }

  // ---------- campos ----------

  // Texto de um rótulo. O LinkedIn repete o texto em um trecho só para leitores de tela: fica o visível.
  const pick = (node) => (node ? (node.querySelector?.('[aria-hidden="true"]')?.textContent || node.textContent || '').replace(/\s+/g, ' ').trim() : '');
  function labelOf(el) {
    const own = el.id && el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (pick(own)) return pick(own);
    const by = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => pick(document.getElementById(id))).filter(Boolean).join(' ');
    return by || pick(el.closest('label')) || el.getAttribute('aria-label') || el.placeholder || el.name || '';
  }
  const isRequired = (el, label) => el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label) || !!el.closest('[aria-required="true"], [required]');
  const EMPTY_OPTION = /^(selecion|select|escolh|choose|--|—|$)/;

  // Os campos de um formulário, no formato que o background entende.
  function collect(root) {
    const fields = [];
    const groups = new Set();
    for (const el of root.querySelectorAll('input, select, textarea')) {
      if (el.disabled || el.readOnly || ['hidden', 'submit', 'button', 'search', 'password'].includes(el.type)) continue;
      if (el.type === 'radio') {
        const box = el.closest('fieldset, [role="radiogroup"]') || el.parentElement?.parentElement || root;
        const group = el.name || box;
        if (groups.has(group)) continue;
        groups.add(group);
        const radios = [...(el.name ? root.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`) : box.querySelectorAll('input[type="radio"]'))];
        if (!radios.some((r) => visible(r) || visible(r.closest('label') || root.querySelector(`label[for="${CSS.escape(r.id)}"]`)))) continue;
        const label = pick(box.querySelector('legend')) || box.getAttribute('aria-label') || labelOf(el);
        fields.push({ kind: 'radio', label, options: radios.map(labelOf), els: radios, required: isRequired(el, label) || box.getAttribute('aria-required') === 'true', empty: !radios.some((r) => r.checked) });
        continue;
      }
      const label = labelOf(el);
      if (el.type === 'checkbox') {
        if (!visible(el) && !visible(el.closest('label') || root.querySelector(`label[for="${CSS.escape(el.id)}"]`))) continue;
        fields.push({ kind: 'checkbox', label, els: [el], required: isRequired(el, label), empty: !el.checked });
      } else if (el.type === 'file') {
        fields.push({ kind: 'file', label: label || el.closest('div')?.innerText?.slice(0, 80) || '', els: [el], required: false, empty: !el.files?.length });
      } else if (!visible(el)) {
        continue;
      } else if (el.tagName === 'SELECT') {
        const options = [...el.options].map((o) => o.textContent.replace(/\s+/g, ' ').trim());
        fields.push({ kind: 'select', label, options, els: [el], required: isRequired(el, label), empty: EMPTY_OPTION.test(norm(el.selectedOptions[0]?.textContent)) });
      } else {
        const kind = el.tagName === 'TEXTAREA' ? 'textarea' : el.type === 'number' || el.inputMode === 'numeric' || el.inputMode === 'decimal' ? 'number' : 'text';
        fields.push({ kind, label, els: [el], required: isRequired(el, label), empty: !el.value.trim(), combo: el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete') });
      }
    }
    return fields.filter((f) => f.label);
  }

  // Escreve em campos controlados por React e afins: valor pelo "setter" nativo e os eventos que eles escutam.
  function setValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    for (const type of ['input', 'change', 'blur']) el.dispatchEvent(new Event(type, { bubbles: true }));
  }
  const press = (el) => (visible(el) ? el : el.closest('label') || document.querySelector(`label[for="${CSS.escape(el.id)}"]`) || el).click();

  async function fill(field, answer) {
    const [el] = field.els;
    if (field.kind === 'radio') {
      const i = field.options.indexOf(answer);
      if (i >= 0 && !field.els[i].checked) press(field.els[i]);
    } else if (field.kind === 'checkbox') {
      if (el.checked !== !!answer) press(el);
    } else if (field.kind === 'select') {
      const option = [...el.options].find((o) => o.textContent.replace(/\s+/g, ' ').trim() === answer);
      if (option) setValue(el, option.value);
    } else {
      el.focus();
      setValue(el, String(answer));
      if (field.combo) {
        // campo com sugestões (cidade, por exemplo): fica com a primeira
        const option = await waitFor(() => [...document.querySelectorAll('[role="listbox"] [role="option"], [role="option"]')].find(visible), 2500);
        option?.click();
      }
    }
    await pause(120, 320);
  }

  // Pede as respostas ao background e preenche o que ele souber. Devolve os campos que ficaram sem resposta.
  async function answerFields(fields, opts) {
    const open = fields.filter((f) => f.kind !== 'file' && (f.empty || (f.kind === 'checkbox' && /seguir|follow/.test(norm(f.label)))));
    if (!open.length) return [];
    const res = await ask({ type: 'apply:answers', jobId: opts.jobId, questions: open.map(({ label, kind, options, required }) => ({ label, kind, options, required })) });
    const unknown = [];
    for (const [i, field] of open.entries()) {
      const answer = res?.answers?.[i];
      if (answer == null) unknown.push(field);
      else await fill(field, answer);
    }
    return unknown.filter((f) => f.kind !== 'checkbox');
  }

  const describe = (f) => ({ label: f.label, kind: f.kind, options: f.options });

  // O usuário respondeu à mão o que faltava: guarda para a próxima candidatura (nunca senhas nem documentos).
  function learnFrom(fields) {
    for (const field of fields) {
      if (RE.secret.test(norm(field.label))) continue;
      const send = () => {
        const [el] = field.els;
        const value = field.kind === 'radio' ? field.options[field.els.findIndex((r) => r.checked)] : field.kind === 'select' ? el.selectedOptions[0]?.textContent.replace(/\s+/g, ' ').trim() : el.value.trim();
        if (value && !EMPTY_OPTION.test(norm(value))) ask({ type: 'apply:learn', pairs: [{ label: field.label, value }] });
      };
      for (const el of field.els) el.addEventListener('change', send);
    }
  }

  // ---------- candidatura simplificada do LinkedIn ----------

  const dialogs = () => [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  const applyDialog = () => dialogs().reverse().find((d) => find(d, RE.submit) || find(d, RE.review) || find(d, RE.next) || d.querySelector('form'));
  const wasSent = () => dialogs().some((d) => RE.sent.test(norm(d.innerText)));
  const signature = (d) => [d.querySelector('progress')?.value ?? d.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') ?? '', collect(d).map((f) => f.label).join('|'), norm(find(d, RE.submit)?.innerText || find(d, RE.review)?.innerText || find(d, RE.next)?.innerText)].join('#');
  const invalid = (d, fields) => fields.filter((f) => f.els.some((el) => el.getAttribute('aria-invalid') === 'true' || el.closest('[data-test-form-element], fieldset, div')?.querySelector('[role="alert"], [class*="error"]')));

  async function uploadResume(dlg, resume, state) {
    if (state.uploaded || !resume?.b64) return;
    const inputs = [...dlg.querySelectorAll('input[type="file"]')];
    const input = inputs.find((i) => /curr[ií]culo|resume|\bcv\b/i.test(`${i.id} ${i.name} ${labelOf(i)} ${i.closest('div')?.innerText || ''}`)) || (inputs.length === 1 ? inputs[0] : null);
    if (!input) return;
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(resume.b64), (c) => c.charCodeAt(0))], resume.name, { type: 'application/pdf' }));
    input.files = data.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    state.uploaded = true;
    await sleep(2500); // o envio do arquivo é feito em segundo plano pela página
  }

  async function closeDialog() {
    const dlg = applyDialog();
    const x = dlg && find(dlg, RE.close);
    if (!x) return;
    x.click();
    (await waitFor(() => dialogs().map((d) => find(d, RE.discard)).find(Boolean), 3000))?.click();
  }

  // Fica de olho depois de parar (falta resposta, ou o usuário quer conferir): quando ele mesmo enviar, avisa o background.
  function watchForSend(opts) {
    waitFor(wasSent, 15 * 60_000, 1000).then((ok) => ok && ask({ type: 'apply:done', jobId: opts.jobId, status: 'enviada' }));
  }

  // Sem botão de candidatura simplificada, o que a página diz da vaga: encerrada, já candidatada ou candidatura no site da empresa.
  function otherState() {
    const top = norm((document.querySelector('main') || document.body).innerText).slice(0, 4000);
    if (RE.closed.test(top)) return 'fechada';
    if (RE.applied.test(top)) return 'ja';
    return find(document, /^(candidatar-se|candidate-se|apply)\b/) ? 'externa' : null;
  }

  async function easyApply(opts) {
    let button = await waitFor(() => find(document, RE.easy) || otherState(), 15000);
    if (typeof button === 'string') {
      await sleep(1500); // o topo da vaga pode ainda estar montando
      button = find(document, RE.easy) || button;
    }
    if (!button || typeof button === 'string') return { status: button || 'externa' };
    await pause();
    button.click();
    const state = { uploaded: false };
    let stuck = 0;
    for (let step = 0; step < 20; step++) {
      const dlg = await waitFor(() => (wasSent() ? document.body : applyDialog()), step ? 6000 : 12000);
      if (wasSent()) break;
      if (!dlg) return { status: 'erro', error: 'a janela da candidatura não abriu' };
      const more = find(dlg, RE.resume); // aviso de segurança antes do formulário
      if (more && !dlg.querySelector('form')) {
        more.click();
        continue;
      }
      await pause();
      await uploadResume(dlg, opts.resume, state);
      const unknown = await answerFields(collect(dlg), opts);
      const before = signature(dlg);
      const action = find(dlg, RE.submit) || find(dlg, RE.review) || find(dlg, RE.next);
      if (!action) return { status: 'erro', error: 'não achei o botão para avançar na candidatura' };
      const sending = action === find(dlg, RE.submit);
      const stop = async (status, questions) => {
        if (opts.batch && status === 'pendente') await closeDialog(); // em lote, deixa o LinkedIn limpo e segue para a próxima
        else {
          learnFrom(questions.length ? questions : collect(dlg).filter((f) => f.empty));
          watchForSend(opts);
        }
        return { status, questions: questions.map(describe) };
      };
      // falta resposta obrigatória: para aqui, sem inventar
      const required = unknown.filter((f) => f.required);
      if (required.length) return stop('pendente', required);
      if (sending && !opts.submit) return stop('revisar', []);
      await pause();
      action.click();
      await waitFor(() => wasSent() || !applyDialog() || signature(applyDialog()) !== before, 8000);
      if (wasSent()) break;
      const now = applyDialog();
      if (now && signature(now) === before) {
        // não avançou: a página recusou algum campo
        const fields = collect(now);
        const bad = invalid(now, fields);
        if (++stuck > 1 || bad.length || unknown.length) return stop('pendente', bad.length ? bad : unknown.length ? unknown : fields.filter((f) => f.empty));
      } else stuck = 0;
    }
    if (!wasSent()) return { status: 'erro', error: 'a candidatura não chegou ao fim' };
    await pause();
    const end = dialogs().find((d) => RE.sent.test(norm(d.innerText)));
    (end && (find(end, RE.done) || find(end, RE.close)))?.click();
    return { status: 'enviada' };
  }

  // ---------- qualquer formulário ----------

  async function fillPage(opts) {
    const blank = () => collect(document.body).filter((f) => f.empty && f.kind !== 'file' && f.kind !== 'checkbox').length;
    const before = blank();
    const unknown = await answerFields(collect(document.body), opts);
    const state = { uploaded: false };
    await uploadResume(document.body, opts.resume, state);
    learnFrom(unknown);
    return { status: 'preenchida', filled: before - blank() + (state.uploaded ? 1 : 0), questions: unknown.map(describe) };
  }

  // Retrato do formulário quando a candidatura não chega ao fim — só rótulos e textos de botões, sem o que
  // foi digitado. Fica guardado na vaga, para dar para ver o que a página tinha de diferente do esperado.
  function snapshot() {
    const root = applyDialog() || document.body;
    return {
      dialog: root !== document.body,
      buttons: clickables(root).slice(0, 25).map((el) => norm(el.getAttribute('aria-label') || el.innerText || el.value).slice(0, 60)),
      fields: collect(root).slice(0, 30).map(({ label, kind, required, empty }) => ({ label: label.slice(0, 90), kind, required, empty })),
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, send) => {
    if (msg?.type !== 'apply:run') return;
    const run = msg.mode === 'easy' ? easyApply(msg).then((res) => (res.status === 'enviada' ? res : { ...res, debug: snapshot() })) : fillPage(msg);
    run.then(send, (e) => send({ status: 'erro', error: String(e?.message || e), debug: snapshot() }));
    return true;
  });
})();
