// Test in a real browser: installs the extension in a separate Chrome, Brave or Edge (headless, with a
// temporary profile deleted at the end) and checks what the mocked tests cannot reach: that it opens without
// errors, the OAuth redirect URL, the chrome.identity login, Easy Apply on a replica of the LinkedIn window,
// and the replacement of the cached background code.
//
//   node dev/test-browser.mjs [oauth-client-id] [--live] [--browser=path-to-browser]
//
// With the client ID, it also clicks "Conectar Gmail" and shows what the extension answers after querying
// Google. The query is anonymous; only the user can do the actual login, in their own browser.
// With --live, it runs a small real search on the job sites.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, DASHBOARD, findBrowser, connect, launch, killAll } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const clientId = args.find((a) => !a.startsWith('--'));
const browser = findBrowser(args);
if (!browser) {
  console.log('Nenhum navegador encontrado. Informe um com --browser=caminho.');
  process.exit(1);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(ok ? 'OK    ' : 'FALHOU', name, ok ? '' : detail);
};
const step = (msg) => process.env.AV_DEBUG && console.log('   ·', msg);

// Local replica of LinkedIn's "Candidatura simplificada" (Easy Apply), with labels, roles and texts as on the real
// page, in Portuguese: a multi-step form inside a dialog, validation at each step and a confirmation screen.
// kind: 'simples' | 'pergunta' (has a question the profile does not answer) | 'externa' | 'ja' (already applied)
const easyApplyPage = (kind) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Vaga de teste</title>
<style>.visually-hidden{position:absolute;clip:rect(0 0 0 0);width:1px;height:1px;overflow:hidden}[role=dialog]{border:1px solid #888;padding:16px;margin:16px;max-width:560px}</style></head>
<body><main><h1>Desenvolvedor Oracle APEX</h1><p>Empresa X · Remoto</p>
${
  kind === 'externa'
    ? '<button class="jobs-apply-button" aria-label="Candidatar-se à vaga no site da empresa"><span>Candidatar-se</span></button>'
    : kind === 'ja'
      ? '<p>Candidatou-se há 2 dias</p>'
      : '<button class="jobs-apply-button artdeco-button--primary" aria-label="Candidatura simplificada à vaga de Desenvolvedor Oracle APEX na Empresa X"><span>Candidatura simplificada</span></button>'
}
</main><div id="root"></div>
<script>
const root = document.getElementById('root');
const label = (id, text) => '<label for="' + id + '"><span aria-hidden="true">' + text + '</span><span class="visually-hidden">' + text + '</span></label>';
const steps = [
  '<h3>Informações de contato</h3>' +
    '<div data-test-form-element>' + label('email', 'Endereço de e-mail') + '<select id="email" required aria-required="true"><option value="Selecionar opção">Selecionar opção</option><option value="eu@gmail.example">eu@gmail.example</option></select></div>' +
    '<div data-test-form-element>' + label('cc', 'Código do país') + '<select id="cc" required><option value="Selecionar opção">Selecionar opção</option><option value="br">Brasil (+55)</option><option value="us">Estados Unidos (+1)</option></select></div>' +
    '<div data-test-form-element>' + label('phone', 'Celular') + '<input id="phone" type="text" required></div>',
  '<h3>Currículo</h3><p>Verifique se incluiu um currículo atualizado</p>' +
    '<label for="jobs-document-upload-file-input-upload-resume" role="button">Carregar currículo</label><input type="file" id="jobs-document-upload-file-input-upload-resume" name="file" style="display:none">',
  '<h3>Perguntas adicionais</h3>' +
    '<div data-test-form-element>' + label('anos', 'Há quantos anos você já usa Oracle APEX no trabalho?') + '<input id="anos" type="text" inputmode="numeric" required></div>' +
    '<fieldset data-test-form-builder-radio-button-form-component="true" aria-required="true"><legend><span><span aria-hidden="true">Você tem experiência com PL/SQL?</span><span class="visually-hidden">Você tem experiência com PL/SQL?</span></span></legend>' +
    '<div><input type="radio" class="visually-hidden" id="plsql-y" name="plsql" value="Yes"><label for="plsql-y">Yes</label></div><div><input type="radio" class="visually-hidden" id="plsql-n" name="plsql" value="No"><label for="plsql-n">No</label></div></fieldset>' +
    '<div data-test-form-element>' + label('ingles', 'Qual é o seu nível de proficiência em inglês?') + '<select id="ingles" required><option>Selecionar opção</option><option>Nenhum</option><option>Básico</option><option>Conversação</option><option>Profissional</option><option>Nativo ou bilíngue</option></select></div>' +
    ${JSON.stringify(
      kind === 'pergunta'
        ? '<fieldset aria-required="true"><legend><span aria-hidden="true">Você possui certificação Oracle Cloud?</span></legend><div><input type="radio" id="cert-s" name="cert" value="Sim"><label for="cert-s">Sim</label></div><div><input type="radio" id="cert-n" name="cert" value="Não"><label for="cert-n">Não</label></div></fieldset>'
        : ''
    )},
  '<h3>Revise sua candidatura</h3><p>Confira os dados antes de enviar.</p>' +
    '<div><input type="checkbox" id="follow-company-checkbox" checked><label for="follow-company-checkbox">Seguir a Empresa X para ficar por dentro das novidades da página.</label></div>',
];
const buttons = [['Avançar', 'Avançar para próxima etapa'], ['Avançar', 'Avançar para próxima etapa'], ['Revisar', 'Revise sua candidatura'], ['Enviar candidatura', 'Enviar candidatura']];
let step = 0;
const values = {};
function render() {
  root.innerHTML = '<div role="dialog" aria-labelledby="titulo" class="artdeco-modal jobs-easy-apply-modal"><h2 id="titulo">Candidatar-se a Empresa X</h2><button type="button" aria-label="Fechar" id="fechar">×</button>' +
    '<progress max="100" value="' + step * 25 + '"></progress><form>' + steps[step] + '</form><footer>' +
    (step ? '<button type="button" aria-label="Voltar à etapa anterior"><span>Voltar</span></button>' : '') +
    '<button type="button" id="ir" aria-label="' + buttons[step][1] + '" class="artdeco-button--primary"><span>' + buttons[step][0] + '</span></button></footer></div>';
  document.getElementById('ir').onclick = advance;
  document.getElementById('fechar').onclick = () => {
    root.insertAdjacentHTML('beforeend', '<div role="dialog"><p>Salvar esta candidatura?</p><button type="button" id="descartar"><span>Descartar</span></button><button type="button"><span>Salvar</span></button></div>');
    document.getElementById('descartar').onclick = () => { root.innerHTML = ''; fetch('/discarded' + location.pathname, { method: 'POST' }); };
  };
}
function advance() {
  const form = root.querySelector('form');
  form.querySelectorAll('[role=alert]').forEach((e) => e.remove());
  let ok = true;
  const refuse = (el, text) => { ok = false; el.insertAdjacentHTML(el.tagName === 'FIELDSET' ? 'beforeend' : 'afterend', '<div role="alert" class="artdeco-inline-feedback--error">' + text + '</div>'); };
  for (const el of form.querySelectorAll('input, select')) {
    if (el.type === 'file') values.file = el.files[0] ? { name: el.files[0].name, size: el.files[0].size, type: el.files[0].type } : null;
    else if (el.type === 'checkbox') values[el.id] = el.checked;
    else if (el.type === 'radio') { if (el.checked) values[el.name] = el.value; }
    else if (el.required && (!el.value || /^Selecionar/.test(el.value))) { el.setAttribute('aria-invalid', 'true'); refuse(el, 'Insira uma resposta válida'); }
    else { el.removeAttribute('aria-invalid'); values[el.id] = el.tagName === 'SELECT' ? el.selectedOptions[0].textContent : el.value; }
  }
  for (const group of form.querySelectorAll('fieldset[aria-required]')) if (!group.querySelector('input:checked')) refuse(group, 'Faça uma seleção');
  if (!ok) return;
  if (step === steps.length - 1) {
    fetch('/submitted', { method: 'POST', body: JSON.stringify({ job: location.pathname, ...values }) });
    root.innerHTML = '<div role="dialog"><h2>Candidatura enviada</h2><p>Sua candidatura foi enviada para Empresa X.</p><button type="button" id="fim"><span>Concluído</span></button></div>';
    document.getElementById('fim').onclick = () => (root.innerHTML = '');
    return;
  }
  step++;
  setTimeout(render, 250); // the real page moves to the next step after a network call
}
document.querySelector('.jobs-apply-button')?.addEventListener('click', () => ${JSON.stringify(kind !== 'externa')} && setTimeout(render, 300));
</script></body></html>`;
// The window LinkedIn shows since 2026, as measured on the real page: a native <dialog> with no role and no <form>,
// progress as an svg role="progressbar", buttons known only by their text, "Avaliar" (Review) before submitting,
// the resume picked from a list (the file input only exists after "Carregar currículo" (Upload resume) is clicked,
// and the page opens the file picker on it right away), errors written in the text each field points to with
// aria-describedby, a "Salvar esta candidatura?" (Save this application?) window on close, and an open messaging
// window with its own file attachment and Enviar (Send) button, which must be left alone.
// confirm: 'janela' (a confirmation window after sending) | 'pagina' (the window just closes; only the job page says so)
const newApplyPage = (kind, confirm) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Vaga de teste</title>
<style>dialog{max-width:560px}</style></head>
<body><div id="root"><h1>Desenvolvedor Oracle APEX</h1><p>Empresa X · Remoto</p><p id="estado"></p>
<button type="button" id="easy" aria-label="Usar a candidatura simplificada para esta vaga"><span>Candidatura simplificada</span></button></div>
<aside><div role="dialog" aria-label="Conversa com Fulana"><form id="chat"><input type="file" id="chat-file"><div contenteditable="true">Oi, tudo bem?</div><button type="submit"><span>Enviar</span></button></form></div></aside>
<script>
const root = document.getElementById('root');
const touchChat = () => fetch('/chat', { method: 'POST' });
document.getElementById('chat').onsubmit = (e) => { e.preventDefault(); touchChat(); };
document.getElementById('chat-file').onchange = touchChat;
const resumes = ['Profile.pdf', 'CV antigo.pdf'];
let chosen = 0;
const helper = (id) => '<div id="' + id + '-info"><p aria-live="polite"><span aria-hidden="true">0/20</span><span>0 de 20 caracteres</span></p></div>';
const text = (id, q) => '<p>' + q + '*</p><input id="' + id + '" type="text" aria-label="' + q + '" aria-describedby="' + id + '-info" required>' + helper(id);
const select = (id, q, options) => '<label for="' + id + '"><div>' + q + '*</div></label><select id="' + id + '" aria-describedby="' + id + '-info" required><option disabled selected value="">Selecionar opção</option>' + options.map((o) => '<option>' + o + '</option>').join('') + '</select><div id="' + id + '-info"></div>';
const radios = (name, q, options) => '<fieldset role="radiogroup" aria-describedby="' + name + '-info"><legend><span>' + q + '*</span></legend>' + options.map((o, i) => '<div><input type="radio" id="' + name + i + '" name="' + name + '" value="' + o + '"><label for="' + name + i + '">' + o + '</label></div>').join('') + '</fieldset><div id="' + name + '-info"></div>';
const steps = [
  () => '<p>Informações de contato</p>' + select('email', 'E-mail', ['eu@gmail.example']) + select('cc', 'Código do país', ['Brasil (+55)', 'Estados Unidos (+1)']) +
    '<label for="phone"><div>Número de celular*</div></label><input id="phone" type="tel" aria-describedby="phone-info" required><div id="phone-info"></div>',
  () => '<p>Currículo*</p><p>Selecione ou carregue um currículo no formato DOC, DOCX ou PDF com menos de 2 MB</p><fieldset role="radiogroup" aria-describedby="error-message-cv">' +
    resumes.map((r, i) => '<div role="button"><p>PDF</p><span>' + r + '</span><p>26/06/2026</p></div><div aria-label="' + r + '"><input type="radio" id="cv' + i + '" name="cv" value="' + r + '" aria-label="' + r + '" style="opacity:0;width:0;height:0"' + (i === chosen ? ' checked' : '') + '><label for="cv' + i + '"></label></div>').join('') +
    '</fieldset><div id="error-message-cv"></div><button type="button" id="carregar"><span>Carregar currículo</span></button>',
  () => '<p>Perguntas adicionais</p>' + text('anos', 'Há quantos anos você já usa Oracle APEX no trabalho?') + radios('plsql', 'Você tem experiência com PL/SQL?', ['Yes', 'No']) +
    select('ingles', 'Qual é o seu nível de proficiência em inglês?', ['Nenhum', 'Básico', 'Conversação', 'Profissional', 'Nativo ou bilíngue']) +
    (${JSON.stringify(kind === 'pergunta')} ? radios('cert', 'Você possui certificação Oracle Cloud?', ['Sim', 'Não']) : ''),
  () => '<p>Revise sua candidatura</p><p>Confira os dados antes de enviar.</p><div><input type="checkbox" id="follow-company-checkbox" checked><label for="follow-company-checkbox">Seguir a Empresa X para ficar por dentro das novidades da página.</label></div>',
];
const buttons = ['Avançar', 'Avançar', 'Avaliar', 'Enviar candidatura'];
let step = 0;
const values = {};
const modal = (html) => {
  const d = document.createElement('dialog');
  d.setAttribute('data-testid', 'dialog');
  d.innerHTML = html;
  root.append(d);
  d.showModal();
  return d;
};
let dlg = null;
function render() {
  dlg = dlg || modal('');
  dlg.innerHTML = '<button type="button" aria-label="Fechar" id="fechar">×</button><header id="dialog-header"><h2>Candidate-se à empresa Empresa X</h2></header><div data-testid="dialog-content">' +
    '<div id="pct">' + (step + 1) * 25 + ' por cento concluído</div><svg role="progressbar" aria-labelledby="pct" aria-valuenow="' + (step + 1) * 25 + '" width="100" height="4"></svg><p>' + (step + 1) + ' de 4 páginas</p>' +
    '<div data-testid="lazy-column">' + steps[step]() + '</div><hr role="presentation">' +
    (step ? '<button type="button"><span>Voltar</span></button>' : '') + '<button type="button" id="ir"><span>' + buttons[step] + '</span></button></div>';
  document.getElementById('ir').onclick = advance;
  dlg.querySelectorAll('input[name=cv]').forEach((r, i) => (r.onchange = () => (chosen = i)));
  const upload = document.getElementById('carregar');
  if (upload) upload.onclick = () => {
    // like the real page: a new input at the end of <body>, and the file picker opened on it
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'application/pdf';
    input.onchange = () => {
      const f = input.files[0];
      if (!f) return;
      values.file = { name: f.name, size: f.size, type: f.type };
      setTimeout(() => { resumes.unshift(f.name); chosen = 0; if (step === 1) render(); }, 600); // the upload
    };
    document.body.append(input);
    input.click();
  };
  document.getElementById('fechar').onclick = () => {
    const ask = modal('<button type="button" aria-label="Fechar">×</button><h2>Salvar esta candidatura?</h2><p>Salve para voltar a esta candidatura mais tarde.</p><button type="button" id="descartar"><span>Descartar</span></button><button type="button"><span>Salvar</span></button>');
    document.getElementById('descartar').onclick = () => { ask.remove(); dlg.remove(); dlg = null; fetch('/discarded' + location.pathname, { method: 'POST' }); };
  };
}
function advance() {
  dlg.querySelectorAll('[data-erro]').forEach((e) => e.remove());
  let ok = true;
  const refuse = (el, msg) => { ok = false; document.getElementById(el.getAttribute('aria-describedby')).insertAdjacentHTML('afterbegin', '<p data-erro>' + msg + '</p>'); };
  for (const el of dlg.querySelectorAll('input, select')) {
    if (el.type === 'checkbox') values[el.id] = el.checked;
    else if (el.type === 'radio') { if (el.checked) values[el.name] = el.value; }
    else if (el.required && !el.value) refuse(el, el.tagName === 'SELECT' ? 'Este campo é obrigatório' : 'Valor inválido');
    else values[el.id] = el.tagName === 'SELECT' ? el.selectedOptions[0].textContent : el.value;
  }
  for (const group of dlg.querySelectorAll('fieldset[role=radiogroup]')) if (!group.querySelector('input:checked')) refuse(group, 'Faça uma seleção');
  if (!ok) return;
  if (step < steps.length - 1) {
    step++;
    return setTimeout(render, 250); // the real page moves to the next step after a network call
  }
  fetch('/submitted', { method: 'POST', body: JSON.stringify({ job: location.pathname, ...values }) });
  dlg.remove();
  dlg = null;
  if (${JSON.stringify(confirm === 'pagina')}) {
    document.getElementById('easy').remove();
    document.getElementById('estado').textContent = 'Candidatura enviada agora';
    return;
  }
  const end = modal('<button type="button" aria-label="Fechar">×</button><h2>Candidatura enviada</h2><p>Sua candidatura foi enviada para Empresa X.</p><button type="button" id="fim"><span>Concluído</span></button>');
  document.getElementById('fim').onclick = () => end.remove();
}
document.getElementById('easy').addEventListener('click', () => setTimeout(render, 300));
</script></body></html>`;
// job number -> [kind, window, confirmation]: 'nova' is the window LinkedIn shows today, 'antiga' the older one
const KINDS = { 1: ['simples', 'nova'], 2: ['pergunta', 'nova'], 3: ['externa', 'antiga'], 4: ['ja', 'antiga'], 5: ['simples', 'nova'], 6: ['simples', 'antiga'], 7: ['simples', 'nova', 'pagina'] };
const submitted = []; // what the replica received for each submitted application
let chatTouched = 0; // times the messaging window got a file or a send

// Local server: a fake login provider (to exercise chrome.identity without needing an account) and the test job.
let back = '';
const provider = http.createServer((req, res) => {
  const view = /^\/jobs\/view\/(\d+)/.exec(req.url);
  if (view) {
    const [kind, ui, confirm] = KINDS[view[1]];
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(ui === 'nova' ? newApplyPage(kind, confirm) : easyApplyPage(kind));
  }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url === '/submitted') submitted.push(JSON.parse(body));
      if (req.url === '/chat') chatTouched++;
      res.writeHead(204).end();
    });
    return;
  }
  const html = (body) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>login de teste</title>${body}`);
  if (req.url.startsWith('/direto')) return res.writeHead(302, { location: back + '#access_token=FALSO_DIRETO&expires_in=3600' }).end();
  if (req.url.startsWith('/recusa')) return res.writeHead(302, { location: back + '#error=interaction_required' }).end();
  if (req.url.startsWith('/script')) return html(`<script>setTimeout(() => location.replace(${JSON.stringify(back + '#access_token=FALSO_SCRIPT&expires_in=3600')}), 1200)</script>`);
  return html('página que não devolve nada');
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'av-'));
try {
  // ---------- 1) the extension from this folder, as the user loads it ----------
  const b = await launch(browser, path.join(work, 'perfil'));
  await b.installUnpacked(root);
  console.log('Navegador:', (await b.api('/json/version')).Browser, '—', path.basename(browser), '\n');

  const page = await b.dashboard();
  check('extensão instala como "Carregar sem compactação" e abre o painel', !!page, 'o painel não abriu');
  if (!page) throw new Error('sem painel não há o que testar');
  const id = new URL(page.target.url).host;
  check('service worker ativo', (await b.api('/json/list')).some((t) => t.type === 'service_worker' && t.url.includes(id)));

  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.reload'); // reloads with logging on, to catch script errors at load time
  await sleep(2500);
  const errors = page.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
  check('painel abre sem erros de script', errors.length === 0, errors.join(' | '));
  check('sem nada configurado, abre direto nas Configurações', await page.evaluate(`document.querySelector('#settings').classList.contains('active')`));

  back = await page.evaluate('chrome.identity.getRedirectURL()');
  const shown = await page.evaluate(`document.querySelector('#redirectUri').textContent`);
  check('endereço de retorno mostrado no passo 3 é o que o navegador usa', shown === back && back === `https://${id}.chromiumapp.org/`, JSON.stringify([shown, back]));

  // silent login (token renewal), with the options the extension uses
  const base = `http://127.0.0.1:${provider.address().port}/`;
  const flow = (route, options = 'SILENT_FLOW') =>
    page.evaluate(`(async () => {
      const { SILENT_FLOW } = await import(chrome.runtime.getURL('lib/gmail.js'));
      const t = Date.now();
      return chrome.identity.launchWebAuthFlow({ url: '${base}${route}', ...${options} })
        .then((url) => ({ url, ms: Date.now() - t }), (e) => ({ error: e.message, ms: Date.now() - t }));
    })()`);
  let r = await flow('direto');
  check('login silencioso: resposta por redirecionamento devolve o token', r.url?.includes('access_token=FALSO_DIRETO'), JSON.stringify(r));
  r = await flow('script');
  check('login silencioso: resposta por script, depois de a página carregar, também', r.url?.includes('access_token=FALSO_SCRIPT'), JSON.stringify(r));
  r = await flow('script', '{ interactive: false }');
  check('(com as opções padrão do navegador, a resposta por script se perderia)', !!r.error, JSON.stringify(r));
  r = await flow('recusa');
  check('login silencioso: recusa do provedor chega como resposta, sem travar', r.url?.includes('error=interaction_required') && r.ms < 3000, JSON.stringify(r));
  r = await flow('nada');
  check('login silencioso: página que não responde é abandonada em 8 s', !!r.error && r.ms > 7000 && r.ms < 12000, JSON.stringify(r));

  // login window left open (a page that never answers): the browser keeps only one
  await page.evaluate(`void chrome.identity.launchWebAuthFlow({ url: '${base}nada', interactive: true }).catch(() => {})`);
  await sleep(2000);
  r = await flow('direto', '{ interactive: true }');
  check('com uma janela de login aberta, o navegador recusa outra (a extensão explica o motivo)', /one web auth flow/i.test(r.error || ''), JSON.stringify(r));
  r = await flow('direto');
  check('a renovação silenciosa não é afetada pela janela aberta', r.url?.includes('access_token=FALSO_DIRETO'), JSON.stringify(r));
  await page.send('Page.reload');
  await sleep(2000);
  r = await flow('direto', '{ interactive: true }');
  check('recarregar o painel (F5) não fecha a janela esquecida', /one web auth flow/i.test(r.error || ''), JSON.stringify(r));
  const left = (await b.api('/json/list')).find((t) => t.url.startsWith(base));
  if (left) await fetch(`http://127.0.0.1:${b.port}/json/close/${left.id}`);
  await sleep(1000);
  r = await flow('direto', '{ interactive: true }');
  check('fechada a janela, o login com janela volta a funcionar', r.url?.includes('access_token=FALSO_DIRETO'), JSON.stringify(r));

  if (args.includes('--live')) {
    // Real search, run by the service worker on the real sites (few queries: 2 terms, 5 jobs per term on each site).
    const t0 = Date.now();
    await page.evaluate(
      `chrome.storage.local.set({ settings: { keywords: 'Oracle APEX, Consultor Oracle', location: 'Brasil', remoteOnly: true, srcLinkedinJobs: true, srcBoards: true, srcLinkedinPosts: false, srcGoogle: false, maxPerSearch: 5 } }).then(() => chrome.runtime.sendMessage({ type: 'scanNow' }))`
    );
    let done = false;
    for (let i = 0; i < 180 && !done; i++) {
      await sleep(500);
      const sc = await page.evaluate(`chrome.storage.local.get('scan').then((x) => x.scan)`);
      done = !!sc && sc.running === false && !!sc.last;
    }
    const found = await page.evaluate(`chrome.storage.local.get(null).then((all) => ({
      jobs: Object.entries(all).filter(([k]) => k.startsWith('job:')).map(([, v]) => ({ source: v.source, title: v.title, company: v.company, location: v.location, chars: v.description.length, keyword: v.keyword, fit: v.fit })),
      log: (all.log || []).map((l) => l.msg),
    }))`);
    const sites = [...new Set(found.jobs.map((j) => j.source))];
    const opened = (await b.api('/json/list')).filter((t) => /linkedin\.com|gupy\.io|infojobs|vagas\.com|remotar|himalayas/.test(t.url)).length;
    check('busca real pelo service worker: vagas de vários sites, lidas sem abrir nenhuma página', done && found.jobs.length > 0 && sites.length >= 3 && found.jobs.every((j) => j.title && j.chars > 100) && opened === 0, JSON.stringify({ done, total: found.jobs.length, sites, opened }));
    console.log(`       ${found.jobs.length} vagas de ${sites.length} sites em ${((Date.now() - t0) / 1000).toFixed(0)} s (contando a espera do teste)`);
    console.log('       ' + (found.log.find((m) => m.startsWith('Busca em')) || '(sem resumo no registro)'));
    for (const j of found.jobs.slice(0, 8)) console.log(`       · [${j.source}] ${j.title.slice(0, 54)} — ${j.company.slice(0, 22)} — ${j.location.slice(0, 22)} — termo: ${j.keyword}`);
  }

  let connectReport = '';
  if (clientId) {
    // pastes the client ID and clicks Conectar, as the user would
    await page.evaluate(`(() => {
      const input = document.querySelector('[data-key="gmailClientId"]');
      input.value = ${JSON.stringify(clientId)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#gmailBtn').click();
    })()`);
    let problem = null;
    let login = false;
    for (let i = 0; i < 60 && !problem && !login; i++) {
      await sleep(250);
      problem = await page.evaluate(`(() => { const el = document.querySelector('#gmailProblem'); return el.hidden ? null : el.querySelector('span').textContent; })()`);
      login = (await b.api('/json/list')).some((t) => t.url.startsWith('https://accounts.google.com/'));
    }
    connectReport =
      `\nConectar Gmail com ${clientId}\n` +
      (problem ? '  A extensão avisou: ' + problem : login ? '  O Google aceitou a configuração: a janela de login abriu.' : '  Nenhuma resposta em 15 s.');
  }
  page.close();
  killAll();

  // ---------- 2) old background code kept by the browser ----------
  // A copy of the extension, so the files can be changed "on disk" the way it happens with every fix.
  const copy = path.join(work, 'ext');
  fs.cpSync(root, copy, { recursive: true, filter: (src) => !['dev', '.git', '.claude', 'node_modules'].includes(path.relative(root, src).split(path.sep)[0]) });
  const setBuild = (version) => {
    const file = path.join(copy, 'lib', 'build.js');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/BUILD = '[^']+'/, `BUILD = '${version}'`));
    const manifest = JSON.parse(fs.readFileSync(path.join(copy, 'manifest.json'), 'utf8'));
    fs.writeFileSync(path.join(copy, 'manifest.json'), JSON.stringify({ ...manifest, version }, null, 2));
  };
  const manifestFile = path.join(copy, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, host_permissions: [...manifest.host_permissions, 'http://127.0.0.1/*'] }, null, 2));
  const running = (p) => p.evaluate(`chrome.runtime.sendMessage({ type: 'version' }).then((r) => r?.build || '(sem resposta)')`);
  const toastOf = async (p) => {
    for (let i = 0; i < 24; i++) {
      const text = await Promise.race([p.evaluate(`document.querySelector('#toasts')?.innerText || ''`), sleep(3000).then(() => Promise.reject(new Error('painel não respondeu em 3 s')))]).catch((e) => (step('aviso: ' + e.message), ''));
      if (text.includes('Extensão atualizada')) return text.trim();
      await sleep(250);
    }
    return '';
  };

  let c = await launch(browser, path.join(work, 'perfil2'));
  await c.installUnpacked(copy);
  let dash = await c.dashboard();
  if (!dash) throw new Error('a cópia da extensão não abriu o painel');
  await sleep(1500);
  const first = await running(dash);

  // ---------- Easy Apply, from the click in the dashboard to submission, on a replica of the LinkedIn window ----------
  await dash.evaluate(`(async () => {
    const { textToPdf, pdfToB64 } = await import(chrome.runtime.getURL('lib/pdf.js'));
    const job = (n) => ({ id: 'e' + n, dupKey: 'e' + n, source: 'linkedin_jobs', title: 'Vaga de teste ' + n, company: 'Empresa X', location: 'Remoto', url: '${base}jobs/view/' + n, description: 'Oracle APEX', emails: [], email: '', status: 'sem_email', easyApply: true, foundAt: Date.now(), tags: [] });
    await chrome.storage.local.set({
      settings: { name: 'Fulano de Tal', email: 'eu@gmail.example', keywords: 'Oracle APEX', phone: '+55 (19) 99999-8888', city: 'Campinas', skills: 'oracle apex, pl/sql', skillYears: 'oracle apex: 8\\npl/sql: 10', englishLevel: 'Avançado', applyReview: false },
      resumePdf: { name: 'CV de teste.pdf', b64: pdfToB64(textToPdf('Fulano de Tal\\nfulano@exemplo.com\\n# Experiência\\n- Oracle APEX e PL/SQL')) },
      'job:e1': job(1), 'job:e2': job(2), 'job:e3': job(3), 'job:e4': job(4), 'job:e5': job(5), 'job:e6': job(6), 'job:e7': job(7),
    });
  })()`);
  const jobState = (id) => dash.evaluate(`chrome.storage.local.get('job:${id}').then((x) => x['job:${id}'])`);
  const waitJob = async (id, test, ms = 90000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if (test(await jobState(id))) break;
    return jobState(id);
  };
  const applyTo = (ids) => dash.evaluate(`chrome.runtime.sendMessage({ type: 'apply:start', ids: ${JSON.stringify(ids)} })`);
  const sentFor = (n) => submitted.find((x) => x.job === '/jobs/view/' + n);

  await applyTo(['e1']);
  let job = await waitJob('e1', (x) => x.status === 'enviado');
  check('candidatura simplificada: clica, percorre as etapas, anexa o currículo e envia', job.status === 'enviado' && job.via === 'linkedin' && !!sentFor(1), JSON.stringify([job.status, job.applyState, job.error]));
  check('cada campo recebe a resposta certa (lista, texto, número, sim/não com opções em inglês, nível de inglês) e a empresa não é seguida',
    sentFor(1)?.email === 'eu@gmail.example' && sentFor(1).cc === 'Brasil (+55)' && sentFor(1).phone === '19999998888' && sentFor(1).anos === '8' && sentFor(1).plsql === 'Yes' && sentFor(1).ingles === 'Profissional' && sentFor(1)['follow-company-checkbox'] === false,
    JSON.stringify(sentFor(1)));
  check('o arquivo anexado é o currículo salvo na extensão, carregado pelo botão sem abrir o seletor de arquivos, e fica escolhido na lista',
    sentFor(1)?.file?.name === 'CV de teste.pdf' && sentFor(1).file.size > 300 && sentFor(1).file.type === 'application/pdf' && sentFor(1).cv === 'CV de teste.pdf', JSON.stringify([sentFor(1)?.file, sentFor(1)?.cv]));
  check('a janela de mensagens aberta ao lado não recebe nada', chatTouched === 0, `mexeu ${chatTouched} vez(es)`);

  await applyTo(['e6']);
  job = await waitJob('e6', (x) => x.status === 'enviado' || !!x.error);
  check('janela antiga (role="dialog", com <form>) continua funcionando, com o currículo anexado', job.status === 'enviado' && sentFor(6)?.file?.name === 'CV de teste.pdf' && sentFor(6).phone === '19999998888', JSON.stringify([job.status, job.error, sentFor(6)]));

  await applyTo(['e7']);
  job = await waitJob('e7', (x) => x.status === 'enviado' || !!x.error);
  check('sem janela de confirmação depois de Enviar: o envio é reconhecido pelo aviso na página da vaga', job.status === 'enviado' && !!sentFor(7), JSON.stringify([job.status, job.error]));

  await applyTo(['e2']);
  job = await waitJob('e2', (x) => x.applyState === 'pendente' || x.status === 'enviado');
  const pending = await dash.evaluate(`chrome.storage.local.get('applyPending').then((x) => x.applyPending)`);
  check('pergunta que o perfil não responde: para sem enviar e a pergunta vai para o painel, com as opções',
    job.applyState === 'pendente' && !sentFor(2) && pending?.[0]?.label === 'Você possui certificação Oracle Cloud?' && pending[0].options.join() === 'Sim,Não', JSON.stringify([job.applyState, job.error, pending]));
  await dash.evaluate(`chrome.runtime.sendMessage({ type: 'apply:learn', pairs: [{ label: 'Você possui certificação Oracle Cloud?', value: 'Não' }] })`);
  await applyTo(['e2']);
  job = await waitJob('e2', (x) => x.status === 'enviado');
  check('respondida uma vez, a mesma vaga segue até o envio com essa resposta', job.status === 'enviado' && sentFor(2)?.cert === 'Não', JSON.stringify([job.status, job.error, sentFor(2)]));

  await applyTo(['e3', 'e4']);
  const outside = await waitJob('e3', (x) => x.easyApply === false);
  const already = await waitJob('e4', (x) => x.status === 'enviado', 60000);
  check('em lote: vaga com candidatura no site da empresa fica marcada assim, e vaga já candidatada vira candidatura feita',
    outside.easyApply === false && outside.status === 'sem_email' && already.status === 'enviado' && /já tinha se candidatado/.test(already.note || ''), JSON.stringify([outside.easyApply, outside.error, already.status, already.note]));

  // review mode: fills everything in and waits for the user to click Enviar (Submit)
  await dash.evaluate(`chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, applyReview: true } }))`);
  await applyTo(['e5']);
  job = await waitJob('e5', (x) => x.applyState === 'revisar' || x.status === 'enviado');
  check('modo conferir: preenche até a última etapa e para antes de enviar', job.applyState === 'revisar' && !sentFor(5), JSON.stringify([job.applyState, job.status, job.error]));
  const applyTab = (await c.api('/json/list')).find((t) => t.url.includes('/jobs/view/5'));
  if (applyTab) {
    const tab = await connect(applyTab.webSocketDebuggerUrl);
    await tab.evaluate(`document.getElementById('ir').click()`);
    tab.close();
  }
  job = await waitJob('e5', (x) => x.status === 'enviado', 30000);
  check('quando o usuário clica em Enviar na página, a extensão registra a candidatura', job.status === 'enviado' && !!sentFor(5), JSON.stringify([job.status, job.applyState]));

  setBuild('9.9.8'); // a fix lands in the files; the browser keeps running the background code it stored
  await dash.send('Page.reload').catch(() => {}); // the user presses F5 on the dashboard
  let fresh = await c.dashboard({ not: dash.target.id, wait: 20000 });
  let note = fresh ? await toastOf(fresh) : '';
  check('arquivos mudaram e o painel foi recarregado (F5): a extensão se atualiza e reabre o painel sozinha', note.includes(`da versão ${first} para a 9.9.8`), JSON.stringify([first, note]));
  check('depois disso o código de fundo é o novo', fresh && (await running(fresh)) === '9.9.8');

  await c.quit(); // the user closes the browser…
  setBuild('9.9.9'); // …the files change again…
  c = await launch(browser, path.join(work, 'perfil2')); // …and they open the browser again
  await c.api('/json/new?' + encodeURI(fresh.target.url.split('#')[0]), { method: 'PUT' }); // and the dashboard
  // Looks for a dashboard answering with the new background code (tabs restored from the last session don't answer).
  let seen = null;
  for (const end = Date.now() + 30000; Date.now() < end && !seen; await sleep(500)) {
    for (const t of (await c.api('/json/list').catch(() => [])).filter((x) => x.type === 'page' && DASHBOARD.test(x.url))) {
      const p = await connect(t.webSocketDebuggerUrl).catch(() => null);
      if (!p) continue;
      const state = await Promise.race([
        p.evaluate(`(async () => ({ build: await chrome.runtime.sendMessage({ type: 'version' }).then((r) => r?.build), log: ((await chrome.storage.local.get('log')).log || [])[0]?.msg || '' }))()`),
        sleep(3000).then(() => null),
      ]).catch(() => null);
      p.close();
      step(t.id.slice(0, 4) + ' ' + JSON.stringify(state));
      if (state?.build === '9.9.9') seen = state;
    }
  }
  const healed = /da versão 9\.9\.8 para a 9\.9\.9/.test(seen?.log || '');
  console.log('       (fechar e abrir o navegador trocou o código de fundo por conta própria? ' + (healed ? 'não: seguia na 9.9.8 até o painel abrir' : 'sim') + ')');
  check('navegador reaberto com arquivos novos: com o painel aberto, o código de fundo fica na versão nova', !!seen, JSON.stringify(seen));
  if (connectReport) console.log(connectReport);
} catch (e) {
  check('teste concluído', false, e.stack || e.message);
} finally {
  provider.close();
  killAll();
  await sleep(1500);
  try {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
  } catch (e) {
    console.log('Pasta temporária não removida:', work, e.message);
  }
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} de ${results.length} verificações passaram.`);
process.exit(failed ? 1 : 0);
