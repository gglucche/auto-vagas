// Regenerates the README images: installs the extension in a separate Chrome, Brave or Edge (headless, no internet,
// temporary profile deleted at the end), writes made-up sample data — the resume of a senior React
// developer — and screenshots the dashboard and the popup into docs/.
//
//   node dev/screenshots.mjs [--light] [--browser=path-to-browser]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, findBrowser, connect, launch, killAll } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs');
const args = process.argv.slice(2);
const scheme = args.includes('--light') ? 'light' : 'dark';
const browser = findBrowser(args);
if (!browser) {
  console.log('Nenhum navegador encontrado. Informe um com --browser=caminho.');
  process.exit(1);
}

// Sample data: made-up people, companies and addresses.
function sampleData() {
  const now = Date.now();
  const min = 60e3;
  const h = 60 * min;
  const ad = (empresa, extra) =>
    `A ${empresa} procura uma pessoa para criar e evoluir aplicações web em React e TypeScript, do componente ao deploy.\n\n` +
    `Requisitos\n- React e TypeScript\n- Next.js\n- Testes automatizados (Jest e Testing Library)\n- Git\n${extra}\n\nBenefícios\n- Trabalho 100% remoto\n- Plano de saúde e vale-refeição`;
  const job = (id, o) => ({
    id, dupKey: id, emails: o.email ? [o.email] : [], email: '', keyword: 'React', location: 'Remoto · Brasil', tags: ['Remoto'],
    status: 'pronto', source: 'gupy', url: `https://exemplo.com.br/vaga/${id}`, matched: ['react', 'typescript', 'next.js', 'jest'], missing: [],
    description: ad(o.company, '- Desejável: React Native'), ...o,
  });
  const body = `Olá, time da Alfa Sistemas!

Vi a vaga de Desenvolvedor React Sênior e me candidato com entusiasmo. Trabalho há 7 anos com React e 6 com TypeScript, criando aplicações web de ponta a ponta: componentes, estado, Next.js e testes com Jest e Testing Library.

No último projeto, liderei a migração de um painel para Next.js e reduzi o tempo de carregamento pela metade.

Segue meu currículo em anexo. Fico à disposição para conversar.

Atenciosamente,
Fulano de Tal
(11) 99999-8888`;
  const jobs = [
    job('r1', {
      title: 'Desenvolvedor React Sênior', company: 'Alfa Sistemas', email: 'talentos@alfa.exemplo.com.br', fit: 93, foundAt: now - 14 * min,
      tags: ['Remoto', 'Sênior', 'CLT'], subject: 'Candidatura — Desenvolvedor React Sênior', body,
      resumeText: 'FULANO DE TAL\nDesenvolvedor React Sênior\n\nRESUMO\n7 anos de React e 6 de TypeScript…',
      note: 'Boa aderência: a vaga pede React, TypeScript e Next.js, que são o centro do seu currículo.',
      strengths: ['7 anos de React, acima dos 5 pedidos', 'TypeScript e Next.js em produção', 'Testes com Jest e Testing Library'],
      gaps: ['O currículo não cita React Native, que é desejável'],
    }),
    job('r2', { title: 'Engenheiro Front-end Sênior (React)', company: 'Banco Beta', email: 'rh@beta.exemplo.com.br', fit: 86, source: 'linkedin_post', foundAt: now - 2 * h, tags: ['Remoto', 'Sênior'] }),
    job('r3', { title: 'Desenvolvedor Full Stack React e Node.js', company: 'Gama Consultoria', email: 'vagas@gama.exemplo.com.br', fit: 72, source: 'infojobs', foundAt: now - 5 * h, missing: ['aws'] }),
    job('r4', { title: 'Desenvolvedor Front-end Pleno', company: 'Grupo Delta', email: 'carreiras@delta.exemplo.com.br', fit: 61, source: 'vagas', foundAt: now - 9 * h, missing: ['angular'] }),
    job('r5', { title: 'Tech Lead Front-end', company: 'Ômega Dados', email: 'jobs@omega.exemplo.com', fit: 54, source: 'himalayas', foundAt: now - 20 * h, missing: ['vue', 'micro-frontends'] }),

    job('n1', {
      title: 'Senior React Developer', company: 'Sigma Labs', status: 'sem_email', source: 'linkedin_jobs', easyApply: true, fit: 90, foundAt: now - 35 * min,
      url: 'https://www.linkedin.com/jobs/view/4000000001/', tags: ['Remoto', 'Sênior'],
      description: ad('Sigma Labs', '- Inglês avançado para reuniões com o time global'),
    }),
    job('n2', { title: 'Desenvolvedor React Sênior', company: 'Kappa Saúde', status: 'sem_email', source: 'linkedin_jobs', easyApply: true, fit: 85, foundAt: now - 3 * h, url: 'https://www.linkedin.com/jobs/view/4000000002/' }),
    job('n3', {
      title: 'Front-end Engineer (React e Next.js)', company: 'Lambda Pagamentos', status: 'sem_email', source: 'linkedin_jobs', easyApply: true, fit: 78, foundAt: now - 6 * h,
      url: 'https://www.linkedin.com/jobs/view/4000000003/', applyState: 'pendente',
      error: 'Falta responder: “Há quantos anos você usa React Native?”. Responda em Configurações → Candidatura no site e clique em Candidatar de novo.',
    }),
    job('n4', { title: 'Desenvolvedor Front-end React', company: 'Zeta Cooperativa', status: 'sem_email', source: 'gupy', fit: 74, foundAt: now - 8 * h }),
    job('n5', { title: 'React Developer', company: 'Teta Tech', status: 'sem_email', source: 'linkedin_jobs', easyApply: false, fit: 69, foundAt: now - 11 * h, url: 'https://www.linkedin.com/jobs/view/4000000005/' }),
    job('n6', { title: 'Desenvolvedor React Native', company: 'Iota Varejo', status: 'sem_email', source: 'remotar', fit: 58, foundAt: now - 26 * h, missing: ['react native'] }),

    job('s1', { title: 'Desenvolvedor React Sênior', company: 'Épsilon Energia', email: 'rh@epsilon.exemplo.com.br', status: 'enviado', stage: 'entrevista', sentAt: now - 2 * h, fit: 91 }),
    job('s2', { title: 'Front-end Developer', company: 'Eta Logística', email: 'vagas@eta.exemplo.com.br', status: 'enviado', stage: 'aguardando', sentAt: now - 4 * 24 * h, fit: 77 }),
    job('s3', { title: 'Engenheiro de Software Front-end', company: 'Rô Seguros', email: 'talentos@ro.exemplo.com.br', status: 'enviado', stage: 'respondeu', sentAt: now - 6 * 24 * h, fit: 73 }),
    job('d1', { title: 'Curso de React com desconto', company: 'Escola Exemplo', email: 'contato@escola.exemplo.com', status: 'ignorado', note: 'Propaganda de curso, não é vaga.', source: 'linkedin_post', fit: null }),
  ];
  return {
    settings: {
      name: 'Fulano de Tal', email: 'fulano@exemplo.com.br',
      skills: 'react, typescript, javascript, next.js, node.js, redux, graphql, jest, testing library, css, git, inglês',
      mode: 'ai', provider: 'groq', groqKey: 'chave-de-exemplo-chave-de-exemplo', groqModel: 'openai/gpt-oss-120b',
      keywords: 'React, TypeScript, Next.js', location: 'Brasil', remoteOnly: true, scanEveryHours: 6,
      resumeText: 'FULANO DE TAL\nDesenvolvedor React Sênior · São Paulo, SP\n\nRESUMO\n9 anos de front-end, 7 com React…',
      gmailClientId: '000000000000-exemplo.apps.googleusercontent.com',
      phone: '11 99999-8888', city: 'São Paulo, SP', linkedinUrl: 'https://www.linkedin.com/in/fulano-exemplo', yearsExperience: '9',
      salary: '15000', skillYears: 'react: 7\ntypescript: 6\nnext.js: 4', englishLevel: 'Avançado', availability: 'Imediata',
      applyAnswers: { 'voce aceita trabalhar como pj': 'Sim' },
    },
    resumePdf: { name: 'curriculo-fulano.pdf', b64: '' },
    gmailToken: { token: 'exemplo', exp: now + h },
    scan: { last: now - 14 * min },
    sentLog: { date: new Date().toLocaleDateString('sv'), count: 1 },
    applyPending: [{ key: 'ha quantos anos voce usa react native', label: 'Há quantos anos você usa React Native?', kind: 'text', options: [], job: 'Front-end Engineer (React e Next.js)' }],
    ...Object.fromEntries(jobs.map((j) => ['job:' + j.id, j])),
  };
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'av-shots-'));
try {
  // no internet: nothing with the sample data leaves this machine
  const b = await launch(browser, profile, ['--hide-scrollbars', '--host-resolver-rules=MAP * ~NOTFOUND']);
  await b.installUnpacked(root);
  const page = await b.dashboard({ wait: 15000 });
  if (!page) throw new Error('o painel não abriu: a extensão foi instalada?');
  const base = page.target.url.replace(/\/ui\/dashboard\.html.*/, '');

  const view = async (p, width, height) => {
    await p.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  };
  const shot = async (p, name, clip) => {
    const r = await p.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    fs.writeFileSync(path.join(out, name), Buffer.from(r.data, 'base64'));
    console.log('docs/' + name);
  };
  const click = (sel) => page.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);

  fs.mkdirSync(out, { recursive: true });
  await page.send('Page.enable');
  await view(page, 1360, 820);
  await page.evaluate(`(async () => {
    const data = ${JSON.stringify(sampleData())};
    // model check already cached: the dashboard doesn't call the AI with the sample key
    const { hashId } = await import(chrome.runtime.getURL('lib/store.js'));
    const working = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'].map((id) => ({ id }));
    data.aiModels = { groq: { key: hashId(data.settings.groqKey), checkedAt: Date.now(), working, failed: [], others: [] } };
    await chrome.storage.local.set(data);
  })()`);
  await page.send('Page.reload');
  await sleep(1800);

  await shot(page, 'painel.png');

  await click('#nav [data-view="noemail"]');
  await sleep(600);
  await click('[data-tab="ad"]');
  await sleep(500);
  await shot(page, 'candidatar.png');

  await view(page, 1360, 1060);
  await click('#nav [data-view="settings"]');
  await sleep(700);
  await shot(page, 'configuracoes.png');

  // the popup, opened as a page and cropped to its own size
  const tab = await b.api(`/json/new?${encodeURIComponent(base + '/ui/popup.html')}`, { method: 'PUT' });
  const popup = await connect(tab.webSocketDebuggerUrl);
  await popup.send('Page.enable');
  await view(popup, 340, 420);
  await popup.send('Page.reload');
  await sleep(1200);
  const box = await popup.evaluate(`(() => { const r = document.body.getBoundingClientRect(); return { x: 0, y: 0, width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`);
  await shot(popup, 'popup.png', box);

  const toasts = await page.evaluate(`document.querySelector('#toasts').innerText`);
  if (toasts) console.log('Aviso no painel:', toasts);
  popup.close();
  page.close();
} catch (e) {
  console.log('FALHOU:', e.stack || e.message);
  process.exitCode = 1;
} finally {
  killAll();
  await sleep(1500);
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
  } catch {}
}
