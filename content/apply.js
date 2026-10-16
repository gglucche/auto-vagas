// Fills in application forms on the page: LinkedIn's "Candidatura simplificada" (Easy Apply), step by step,
// and — at the user's request, via the extension's button — the fields of any open form.
// Injected by the background. Answers come from it (lib/answers.js); this script only reads and manipulates the page.
// Elements are found by their text and role (button, dialog, label), not by class names, which change.
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
    review: /^(revisar|avaliar|review)\b|revise sua candidatura|review your application/,
    submit: /enviar candidatura|submit application|^enviar$|^submit$/,
    done: /^(concluido|done|pronto|ok)\b/,
    close: /^(fechar|dismiss|close)\b/,
    discard: /^(descartar|discard)\b/,
    sent: /candidatura (foi )?enviada|application (was )?(sent|submitted)|sua candidatura foi|your application was sent/,
    applied: /candidatou-se|candidatura enviada|voce se candidatou|\bapplied\b/,
    closed: /nao aceita mais candidaturas|no longer accepting applications|vaga encerrada/,
    upload: /^(carregar|anexar|upload|attach)\b.*\b(curriculo|resume|cv)\b/,
    // any site: the button that starts the application on the job page, the next-step and the final buttons, what
    // a page says after an application (now, or earlier), and the login buttons of a site without a password field
    applyBtn: /^(candidatar|candidate-se|quero me candidatar|me candidatar|inscrever-se|inscreva-se|apply|postular|postulate|postularme|aplicar|enviar (meu |o )?curriculo|submit (your )?(resume|cv)|solicitar (vaga|emprego))\b/,
    nextSite: /^(avancar|proxim[oa]|continuar|next|continue|seguinte|prosseguir|salvar e (continuar|avancar)|save (and|&) continue)\b|avancar para|continue to next|proxima etapa|next step/,
    submitSite: /enviar candidatura|submit application|^enviar$|^submit$|finalizar candidatura|concluir candidatura|^finalizar\b|^concluir\b|send application|submit my application|confirmar candidatura|enviar inscricao|enviar minha candidatura|enviar (meu |o )?curriculo|^candidatar(-se)?( a esta vaga| a vaga)?$|^apply( now)?$/,
    confirm: /^(confirmar|confirm|sim|yes|continuar|continue|ok|prosseguir)\b/,
    sentPage: /candidatura (foi )?(enviada|recebida|realizada|concluida|finalizada|registrada|efetuada)|recebemos (a )?sua candidatura|obrigad[oa] (por|pela) (se candidatar|sua candidatura|candidatar-se|se inscrever)|sua candidatura foi|inscricao (realizada|enviada|concluida)|application (has been |was )?(submitted|received|sent|complete)|thank you for (applying|your application)|thanks for applying|we('ve| have) received your application|successfully applied|you('ve| have) applied|gracias por (postularte|tu postulacion|aplicar)|postulacion (enviada|recibida)/,
    appliedPage: /voce ja se candidatou|ja se candidatou|candidatura ja (realizada|enviada|feita)|already applied|you('ve| have) already applied|ya te postulaste|candidatou-se/,
    closedPage: /nao aceita mais candidaturas|no longer accepting applications|vaga (encerrada|expirada|finalizada|preenchida|pausada)|inscricoes encerradas|job (is )?(closed|expired)|position (has been )?filled|no longer available|nao esta mais disponivel|this job is no longer/,
    sso: /entrar com|continue with|sign in with|log ?in with|iniciar sessao com/,
    // what a page writes under a field it rejected (the helper text under it also says "1 de 20 caracteres")
    error: /invalid|obrigatori|required|insira|faca uma selecao|selecione uma|enter a valid|please (enter|select|make)|\berro\b|\berror\b/,
    // data that is never stored or learned
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

  // ---------- fields ----------

  // A label's text. LinkedIn repeats the text in a part meant only for screen readers: keep the visible one.
  const pick = (node) => (node ? (node.querySelector?.('[aria-hidden="true"]')?.textContent || node.textContent || '').replace(/\s+/g, ' ').trim() : '');
  function labelOf(el) {
    const own = el.id && el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (pick(own)) return pick(own);
    const by = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => pick(document.getElementById(id))).filter(Boolean).join(' ');
    return by || pick(el.closest('label')) || el.getAttribute('aria-label') || el.placeholder || el.name || '';
  }
  const isRequired = (el, label) => el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label) || !!el.closest('[aria-required="true"], [required]');
  const EMPTY_OPTION = /^(selecion|select|escolh|choose|--|—|$)/;

  // A form's fields, in the format the background understands.
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
        fields.push({ kind, label, els: [el], required: isRequired(el, label), empty: !el.value.trim(), max: el.maxLength > 0 ? el.maxLength : undefined, combo: el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete') });
      }
    }
    // the asterisk only marks a required field ("E-mail*"): it stays out of the question
    return fields.map((f) => ({ ...f, label: f.label.replace(/\s*\*\s*$/, '') })).filter((f) => f.label);
  }

  // Writes to fields controlled by React and the like: value via the native setter, plus the events they listen for.
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
        // field with suggestions (a city, for example): take the first one
        const option = await waitFor(() => [...document.querySelectorAll('[role="listbox"] [role="option"], [role="option"]')].find(visible), 2500);
        option?.click();
      }
    }
    await pause(120, 320);
  }

  // Asks the background for the answers and fills in whatever it knows. Returns the fields left unanswered.
  async function answerFields(fields, opts) {
    const open = fields.filter((f) => f.kind !== 'file' && (f.empty || (f.kind === 'checkbox' && /seguir|follow/.test(norm(f.label)))));
    if (!open.length) return [];
    const res = await ask({ type: 'apply:answers', jobId: opts.jobId, questions: open.map(({ label, kind, options, required, max }) => ({ label, kind, options, required, max })) });
    const unknown = [];
    for (const [i, field] of open.entries()) {
      const answer = res?.answers?.[i];
      if (answer == null) unknown.push(field);
      else await fill(field, answer);
    }
    return unknown.filter((f) => f.kind !== 'checkbox');
  }

  const describe = (f) => ({ label: f.label, kind: f.kind, options: f.options });

  // The user filled in the gaps by hand: save the answers for the next application (never passwords or ID documents).
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

  // ---------- LinkedIn Easy Apply ----------

  // The older window is a div with role="dialog"; the newer one is a native <dialog>, with no role and no <form>.
  // Messaging windows (a text box, a file attachment and an Enviar (Send) button of their own) are left out.
  const dialogs = () => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')].filter((d) => visible(d) && !d.querySelector('[contenteditable="true"]'));
  const applyDialog = () => dialogs().reverse().find((d) => find(d, RE.submit) || find(d, RE.review) || find(d, RE.next));
  const wasSent = () => dialogs().some((d) => RE.sent.test(norm(d.innerText)));
  const signature = (d) => [d.querySelector('progress')?.value ?? d.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') ?? '', collect(d).map((f) => f.label).join('|'), norm(find(d, RE.submit)?.innerText || find(d, RE.review)?.innerText || find(d, RE.next)?.innerText)].join('#');
  // The error under a field: an alert next to it (older window) or the text the field points to with aria-describedby (newer one).
  const describedBy = (el) => [el, el.closest('fieldset, [role="radiogroup"]')].flatMap((x) => (x?.getAttribute('aria-describedby') || '').split(/\s+/)).filter(Boolean).map((id) => norm(document.getElementById(id)?.textContent));
  const invalid = (d, fields) => fields.filter((f) => f.els.some((el) => el.getAttribute('aria-invalid') === 'true' || describedBy(el).some((text) => RE.error.test(text)) || el.closest('[data-test-form-element], fieldset, div')?.querySelector('[role="alert"], [class*="error"]')));

  // The resume list in the newer window: how many there are and which one is selected.
  const resumeChoice = (root) => {
    const radios = [...root.querySelectorAll('input[type="radio"]')];
    return `${radios.length}:${radios.filter((r) => r.checked).map(labelOf).join('|')}`;
  };

  async function uploadResume(root, resume, state) {
    if (state.uploaded || !resume?.b64) return;
    const inputs = [...root.querySelectorAll('input[type="file"]')];
    // a lone file field takes the resume, unless it is plainly for something else (a photo) or refuses a PDF
    const takesResume = (i) => !/foto|photo|imagem|image|avatar|selfie/i.test(`${i.id} ${i.name} ${labelOf(i)}`) && (!i.accept || /pdf|application\/|\*/i.test(i.accept));
    let input = inputs.find((i) => /curr[ií]culo|resume|\bcv\b/i.test(`${i.id} ${i.name} ${labelOf(i)} ${i.closest('div')?.innerText || ''}`)) || (inputs.length === 1 && takesResume(inputs[0]) ? inputs[0] : null);
    const before = resumeChoice(root);
    const html = document.documentElement;
    const button = !input && html.hasAttribute('data-auto-vagas-picker') && find(root, RE.upload);
    if (button) {
      // Newer window: the file input only exists once "Carregar currículo" (Upload resume) is clicked, and the page
      // opens the file picker right away. In the page's own world that picker is held back (holdFilePicker, in the
      // background) while this attribute is set, and the input is marked for us to fill in.
      html.setAttribute('data-auto-vagas-upload', '');
      button.click();
      input = await waitFor(() => document.querySelector('input[type="file"][data-auto-vagas-upload]'), 3000, 100);
      html.removeAttribute('data-auto-vagas-upload');
      input?.removeAttribute('data-auto-vagas-upload');
    }
    if (!input) return;
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(resume.b64), (c) => c.charCodeAt(0))], resume.name, { type: 'application/pdf' }));
    input.files = data.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    state.uploaded = true;
    // the page uploads the file in the background; the newer window then adds it to the list, already selected
    if (button && (await waitFor(() => resumeChoice(root) !== before, 15000))) await pause();
    else await sleep(2500);
  }

  async function closeDialog() {
    const dlg = applyDialog();
    const x = dlg && find(dlg, RE.close);
    if (!x) return;
    x.click();
    (await waitFor(() => dialogs().map((d) => find(d, RE.discard)).find(Boolean), 3000))?.click();
  }

  // Keeps watching after stopping (missing answer, or the user wants to check): when the user submits, tells the background.
  function watchForSend(opts, site = false) {
    waitFor(() => (site ? !appRoot() && RE.sentPage.test(pageText()) : wasSent()), 15 * 60_000, 1000).then((ok) => ok && ask({ type: 'apply:done', jobId: opts.jobId, status: 'enviada' }));
  }

  // Without an Easy Apply button, what the page says about the job: closed, already applied, or apply on the company's site.
  function otherState() {
    const top = norm((document.querySelector('main') || document.body).innerText).slice(0, 4000);
    if (RE.closed.test(top)) return 'fechada';
    if (RE.applied.test(top)) return 'ja';
    return find(document, /^(candidatar-se|candidate-se|apply)\b/) ? 'externa' : null;
  }

  async function easyApply(opts) {
    let button = await waitFor(() => find(document, RE.easy) || otherState(), 15000);
    if (typeof button === 'string') {
      await sleep(1500); // the top of the job page may still be rendering
      button = find(document, RE.easy) || button;
    }
    if (!button || typeof button === 'string') return { status: button || 'externa' };
    await pause();
    button.click();
    const state = { uploaded: false };
    let stuck = 0;
    let sent = false;
    for (let step = 0; step < 20; step++) {
      const dlg = await waitFor(() => (wasSent() ? document.body : applyDialog()), step ? 6000 : 12000);
      if (wasSent()) break;
      if (!dlg) return { status: 'erro', error: 'a janela da candidatura não abriu' };
      const more = find(dlg, RE.resume); // safety notice before the form
      if (more && !collect(dlg).length) {
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
        if (opts.batch && status === 'pendente') await closeDialog(); // in a batch, leave LinkedIn clean and move on to the next
        else {
          learnFrom(questions.length ? questions : collect(dlg).filter((f) => f.empty));
          watchForSend(opts);
        }
        return { status, questions: questions.map(describe) };
      };
      // a required answer is missing: stop here, don't make one up
      const required = unknown.filter((f) => f.required);
      if (required.length) return stop('pendente', required);
      if (sending && !opts.submit) return stop('revisar', []);
      await pause();
      action.click();
      await waitFor(() => wasSent() || !applyDialog() || signature(applyDialog()) !== before, 8000);
      if (wasSent()) break;
      // the window closed after Enviar (Submit) without a confirmation window: the job page says it was sent
      if (sending && !applyDialog()) {
        sent = !!(await waitFor(() => wasSent() || otherState() === 'ja', 6000));
        break;
      }
      const now = applyDialog();
      if (now && signature(now) === before) {
        // didn't advance: the page rejected some field
        const fields = collect(now);
        const bad = invalid(now, fields);
        if (++stuck > 1 || bad.length || unknown.length) return stop('pendente', bad.length ? bad : unknown.length ? unknown : fields.filter((f) => f.empty));
      } else stuck = 0;
    }
    if (!sent && !wasSent()) return { status: 'erro', error: 'a candidatura não chegou ao fim' };
    await pause();
    const end = dialogs().find((d) => RE.sent.test(norm(d.innerText)));
    (end && (find(end, RE.done) || find(end, RE.close)))?.click();
    return { status: 'enviada' };
  }

  // ---------- any site: the application, step by step ----------
  // One round per page load: finds the application (the form on the page or the apply button that leads to it),
  // fills in what it can and moves on. The background follows the page across loads, tabs and frames and calls
  // again (opts.round, opts.clicked). Returns: enviada | ja | fechada | login | email (apply by email) | pendente |
  // revisar | clicado (the apply button was clicked and nothing showed up here) | incerto | erro.

  const pageText = () => norm(document.body?.innerText || '').slice(0, 30000);
  const hasPassword = (root) => [...root.querySelectorAll('input[type="password"]')].some(visible);
  // what an application form asks for (a search box or a newsletter field alone is not one)
  const HINT = /nome|name|e-?mail|telefone|celular|phone|mobile|whatsapp|linkedin|curriculo|resume|\bcv\b|cidade|city|endereco|address|salari|pretens|cover|carta|portf|github|website|experien|anos|years|genero|gender|raca|race|deficien|disab|veteran|pronome|pronoun|autoriz|visa|visto|sponsor|relocat|mudar|disponib|availab|inicio|start|notice|aviso|idioma|language|ingles|english|nivel|level|escolar|educ|degree|formacao|curso|certif|trabalh|work|empresa|company|cargo|title|motivo|why|conte|tell us|descreva|describe|pais|country|estado|state|cep|zip|nascimento|birth/;
  const looksLikeApplication = (fields) => {
    const hinted = fields.filter((f) => HINT.test(norm(f.label))).length;
    return fields.some((f) => f.kind === 'file') || hinted >= 2 || (fields.length >= 4 && hinted >= 1);
  };
  // The application form on the page: the open window, the <form> or, on pages that build the form without one,
  // the body itself. A form with a password field is a login or a signup: never filled in.
  function appRoot() {
    for (const d of dialogs().reverse()) if (!hasPassword(d) && looksLikeApplication(collect(d))) return d;
    let best = null;
    const forms = [...document.querySelectorAll('form')].filter((f) => visible(f) && !f.matches('[role="search"]') && !f.querySelector('input[type="search"]'));
    for (const el of [...forms, document.body]) {
      if (hasPassword(el)) continue;
      const fields = collect(el);
      if (!fields.length || !looksLikeApplication(fields)) continue;
      const score = fields.length + (fields.some((f) => f.kind === 'file') ? 4 : 0) - (el === document.body ? 2 : 0);
      if (!best || score > best.score) best = { el, score };
    }
    return best?.el || null;
  }
  // The button (or link) that starts the application: the first visible one that says so.
  const entryButtons = () => [...document.querySelectorAll('button, [role="button"], a[href], input[type="submit"]')].filter((el) => visible(el) && !el.disabled);
  const says = (el, re) => re.test(norm(el.getAttribute('aria-label'))) || re.test(norm(el.innerText || el.value));
  const ENTRY_ALT = /enviar candidatura|submit application|enviar (meu |o )?curriculo|confirmar candidatura/;
  const findApplyButton = () => entryButtons().find((el) => says(el, RE.applyBtn)) || entryButtons().find((el) => says(el, ENTRY_ALT));
  // a cookie or privacy notice is never answered (its "OK" would be a consent)
  const CONSENT = /cookie|privacidade|privacy|consent|lgpd/;
  const askingDialog = () => dialogs().filter((d) => !CONSENT.test(norm(d.innerText).slice(0, 600))).at(-1);
  // what this tab already did for this application: survives the page loads the site causes (same origin)
  const acted = (opts) => {
    try {
      return (opts.clicked || 0) > 0 || !!opts.acted || sessionStorage.getItem('__autoVagasActed') === opts.jobId;
    } catch {
      return (opts.clicked || 0) > 0 || !!opts.acted;
    }
  };
  const noteActed = (opts) => {
    try {
      sessionStorage.setItem('__autoVagasActed', opts.jobId);
    } catch {}
  };
  // A login page: a password field, or only "Entrar com Google"-style buttons and no way to apply.
  const isLoginPage = () => hasPassword(document.body) || (entryButtons().some((el) => says(el, RE.sso)) && !findApplyButton());
  const siteSignature = (root) => signature(root) + '#' + (root === document.body ? location.href : '');
  // The form's buttons may sit outside it (a footer); never those of another form, a chat or a dialog of its own.
  const findOutside = (root, re) => {
    const own = (el) => root.contains(el) || !el.closest('form, [role="dialog"], [role="alertdialog"], dialog, [contenteditable="true"], header, nav');
    return clickables(document).find((el) => own(el) && (re.test(norm(el.getAttribute('aria-label'))) || re.test(norm(el.innerText || el.value))));
  };

  // Clicks the apply button. A link to a new tab goes to this tab instead (a click by script can't open a tab);
  // a button that calls window.open is redirected the same way by holdFilePicker (in the background).
  function enter(entry) {
    const href = entry.tagName === 'A' && entry.getAttribute('href');
    if (href && entry.target === '_blank' && !/^(javascript:|#)/.test(href)) return location.assign(entry.href);
    entry.click();
  }

  async function siteApply(opts) {
    await sleep(500);
    document.documentElement.setAttribute('data-auto-vagas-apply', '');
    const state = { uploaded: false };
    let did = acted(opts); // something was clicked in this application (here or on an earlier page)
    let clicks = 0;
    let stuck = 0;
    const stop = (status, questions) => {
      if (!(opts.batch && status === 'pendente')) {
        learnFrom(questions);
        watchForSend(opts, true);
      }
      return { status, questions: questions.map(describe) };
    };
    for (let step = 0; step < 12; step++) {
      const root = appRoot();
      if (!root) {
        const text = pageText();
        if (RE.sentPage.test(text)) return { status: did ? 'enviada' : 'ja' };
        if (RE.closedPage.test(text)) return { status: 'fechada' };
        if (RE.appliedPage.test(text)) return { status: 'ja' };
        if (isLoginPage()) return { status: 'login' };
        // a confirmation window after the apply button ("Confirmar candidatura?")
        const dlg = askingDialog();
        const yes = dlg && !collect(dlg).length && (find(dlg, RE.submitSite) || find(dlg, RE.nextSite) || find(dlg, RE.confirm));
        if (yes) {
          did = true;
          noteActed(opts);
          yes.click();
          await waitFor(() => !yes.isConnected || appRoot() || RE.sentPage.test(pageText()), 8000, 400);
          continue;
        }
        const entry = findApplyButton();
        if (!entry) return { status: 'erro', error: 'não achei o botão de candidatura nem um formulário nesta página', keepOpen: true };
        const mailto = entry.closest('a[href^="mailto:"]');
        if (mailto) return { status: 'email', email: mailto.getAttribute('href').slice(7).split('?')[0].trim().toLowerCase() };
        if (clicks++) return { status: 'clicado' }; // once per round: the background decides what to do
        did = true;
        noteActed(opts);
        const had = dialogs().length;
        await pause();
        enter(entry);
        const got = await waitFor(() => appRoot() || dialogs().length > had || isLoginPage() || RE.sentPage.test(pageText()), 6000, 400);
        if (!got) return { status: 'clicado' };
        continue;
      }
      await pause();
      await uploadResume(root, opts.resume, state);
      const fields = collect(root);
      const unknown = await answerFields(fields, opts);
      const required = unknown.filter((f) => f.required);
      if (required.length) return stop('pendente', required);
      const before = siteSignature(root);
      const action = find(root, RE.submitSite) || find(root, RE.review) || find(root, RE.nextSite) || find(root, RE.applyBtn) || findOutside(root, RE.submitSite) || findOutside(root, RE.nextSite);
      if (!action) return { status: 'erro', error: 'não achei o botão para avançar no formulário', keepOpen: true };
      const label = norm(action.getAttribute('aria-label') || action.innerText || action.value);
      const sending = (RE.submitSite.test(label) || RE.applyBtn.test(label)) && !RE.nextSite.test(label) && !RE.review.test(label);
      if (sending && !opts.submit) return stop('revisar', []);
      did = true;
      noteActed(opts);
      await pause();
      action.click();
      const changed = await waitFor(() => !root.isConnected || RE.sentPage.test(pageText()) || siteSignature(appRoot() || root) !== before, 10000, 400);
      if (RE.sentPage.test(pageText()) && !appRoot()) return { status: 'enviada' };
      if (!changed) {
        // didn't advance: the page rejected some field
        const bad = invalid(root, collect(root)).filter((f) => f.kind !== 'file');
        if (bad.length || unknown.length) return stop('pendente', bad.length ? bad : unknown);
        if (++stuck > 1) return { status: 'erro', error: `o formulário não avançou depois de “${label}”`, keepOpen: true };
      } else stuck = 0;
      if (sending && !appRoot()) {
        // the form went away after sending: the page should say it was received
        const ok = await waitFor(() => RE.sentPage.test(pageText()), 8000, 500);
        return { status: ok ? 'enviada' : 'incerto' };
      }
    }
    return { status: 'erro', error: 'a candidatura não chegou ao fim', keepOpen: true };
  }

  // ---------- any form ----------

  async function fillPage(opts) {
    const blank = () => collect(document.body).filter((f) => f.empty && f.kind !== 'file' && f.kind !== 'checkbox').length;
    const before = blank();
    const unknown = await answerFields(collect(document.body), opts);
    const state = { uploaded: false };
    await uploadResume(document.body, opts.resume, state);
    learnFrom(unknown);
    return { status: 'preenchida', filled: before - blank() + (state.uploaded ? 1 : 0), questions: unknown.map(describe) };
  }

  // Snapshot of the form when the application doesn't finish — only labels and button texts, not what was
  // typed. Saved with the job, so we can see how the page differed from what was expected.
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
    const flow = msg.mode === 'easy' ? easyApply : msg.mode === 'site' ? siteApply : fillPage;
    const run = msg.mode === 'fill' ? fillPage(msg) : flow(msg).then((res) => (['enviada', 'clicado', 'ja'].includes(res.status) ? res : { ...res, debug: snapshot() }));
    run.then(send, (e) => send({ status: 'erro', error: String(e?.message || e), debug: snapshot() }));
    return true;
  });
})();
