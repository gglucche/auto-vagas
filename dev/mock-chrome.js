// Simula a API chrome.* para abrir o painel fora da extensão (node dev/server.mjs).
(() => {
  const now = Date.now();
  const h = 3600e3;
  const job = (id, o) => ({
    id, dupKey: id, emails: [o.email].filter(Boolean), email: '', keyword: 'desenvolvedor oracle apex', location: 'São Paulo, SP',
    foundAt: now - 2 * h, status: 'pronto', source: 'linkedin_jobs', url: 'https://www.linkedin.com/jobs/view/1/', tags: ['Remoto', 'PJ', 'Sênior'],
    subject: `Candidatura – ${o.title}`,
    body: 'Olá,\n\nTenho interesse na vaga e envio meu currículo em anexo para avaliação.\n\nAtenciosamente,\nFulano de Tal',
    description: 'Buscamos pessoa desenvolvedora com experiência em Oracle APEX, PL/SQL, JavaScript e integrações REST.\n\nRequisitos:\n- Oracle APEX 20+\n- PL/SQL avançado\n- Git\n- Inglês técnico\n\nEnvie seu currículo para o e-mail informado.',
    ...o,
  });
  // empresas, pessoas e endereços inventados
  const jobs = [
    job('a1', { title: 'Desenvolvedor Oracle APEX Sênior', company: 'Alfa Sistemas', email: 'talentos@alfa.exemplo.com.br', fit: 88, aiDone: true,
      note: 'Perfil muito aderente: experiência direta com APEX e PL/SQL em projetos de grande porte.',
      strengths: ['8 anos de Oracle APEX', 'PL/SQL avançado', 'Integrações REST'], gaps: ['Inglês fluente não comprovado'],
      resumeText: 'Fulano de Tal\nfulano@exemplo.com.br · São Paulo\n# Resumo\nDesenvolvedor Oracle APEX com 8 anos de experiência.\n# Experiência\n- Empresa X (2019–2024): migração de 40 aplicações APEX.' }),
    job('a2', { title: 'Analista PL/SQL Pleno', company: 'Banco Beta', email: 'rh@beta.exemplo.com.br', fit: 71, matched: ['pl/sql', 'oracle', 'git', 'sql'], missing: ['java', 'kafka'], tags: ['Híbrido', 'CLT', 'Pleno', 'R$ 9.000'], foundAt: now - 5 * h }),
    job('a3', { title: 'Estamos contratando! Dev APEX para projeto de 6 meses', company: 'Marina Souza', source: 'linkedin_post', email: 'marina@consultoria.exemplo.com', fit: 54, matched: ['apex', 'oracle'], missing: ['sap', 'ingles'], foundAt: now - 26 * h }),
    job('a4', { title: 'Engenheiro de Dados', company: 'Gama Dados', email: 'vagas@gama.exemplo.com.br', fit: 32, status: 'erro', error: 'Gmail (400): endereço inválido.', matched: ['sql'], missing: ['spark', 'airflow', 'python'], source: 'google_jobs' }),
    job('a5', { title: 'Desenvolvedor Full Stack', company: 'Delta Tech', email: 'jobs@delta.exemplo.com', status: 'novo', fit: null }),
    job('b1', { title: 'Desenvolvedor(a) Android Sênior | Kotlin', company: 'Ômega Mobile', status: 'sem_email', source: 'google_jobs', fit: 20, url: 'https://www.google.com/search?q=vaga' }),
    job('c1', { title: 'Consultor Oracle APEX', company: 'Épsilon Energia', email: 'rh@epsilon.exemplo.com.br', status: 'enviado', stage: 'entrevista', sentAt: now - 30 * h, fit: 90, notes: 'Entrevista quinta 15h com a Paula.' }),
    job('c2', { title: 'Desenvolvedor PL/SQL', company: 'Banco Z', email: 'rh@bancoz.exemplo.com', status: 'enviado', stage: 'aguardando', sentAt: now - 9 * 24 * h, fit: 76 }),
    job('c3', { title: 'Analista de Sistemas', company: 'Zeta Software', email: 'vagas@zeta.exemplo.com', status: 'enviado', stage: 'rejeitado', sentAt: now - 3 * 24 * h, fit: 60 }),
    job('d1', { title: 'Curso de APEX com desconto', company: 'Escola Y', email: 'contato@escola.exemplo.com', status: 'ignorado', note: 'Propaganda de curso, não é vaga.', source: 'linkedin_post' }),
  ];
  jobs.forEach((j) => (j.email ||= j.emails[0] || ''));

  const empty = new URLSearchParams(location.search).has('empty');
  const data = empty ? {} : {
    settings: { name: 'Fulano de Tal', email: 'fulano@exemplo.com.br', keywords: 'desenvolvedor oracle apex\nanalista pl/sql', location: 'São Paulo, Brasil', gmailClientId: 'x.apps.googleusercontent.com', skills: 'oracle apex, pl/sql, javascript' },
    resumePdf: { name: 'curriculo-fulano.pdf', b64: '' },
    gmailToken: { token: 't', exp: now + h },
    scan: { running: false, last: now - 40 * 60e3, i: 0, total: 0, found: 0 },
    sentLog: { date: new Date().toLocaleDateString('sv'), count: 2 },
    log: [{ t: now - h, msg: 'Vagas do LinkedIn · desenvolvedor oracle apex: 12 anúncio(s) lido(s).' }],
    ...Object.fromEntries(jobs.map((j) => ['job:' + j.id, j])),
  };

  const listeners = [];
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const emit = (changes) => setTimeout(() => listeners.forEach((l) => l(changes, 'local')));
  const local = {
    async get(q) {
      const keys = q == null ? Object.keys(data) : typeof q === 'string' ? [q] : Array.isArray(q) ? q : Object.keys(q);
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, clone(data[k])]));
    },
    async getKeys() { return Object.keys(data); },
    async set(obj) {
      const ch = {};
      for (const [k, v] of Object.entries(obj)) { ch[k] = { oldValue: data[k], newValue: clone(v) }; data[k] = clone(v); }
      emit(ch);
    },
    async remove(keys) {
      const ch = {};
      for (const k of [].concat(keys)) { ch[k] = { oldValue: data[k] }; delete data[k]; }
      emit(ch);
    },
  };

  async function sendMessage(m) {
    console.log('[mock] message', m);
    if (m.type === 'version') return { ok: true, build: (await import('/lib/build.js')).BUILD };
    const key = 'job:' + m.id;
    if (m.type === 'job:patch') await local.set({ [key]: { ...data[key], ...m.patch } });
    if (m.type === 'job:send') { await new Promise((r) => setTimeout(r, 400)); await local.set({ [key]: { ...data[key], status: 'enviado', stage: 'aguardando', sentAt: Date.now() } }); }
    if (m.type === 'job:queue') for (const id of m.ids) await local.set({ ['job:' + id]: { ...data['job:' + id], status: 'fila' } });
    if (m.type === 'jobs:remove') await local.remove(m.ids.map((id) => 'job:' + id));
    if (m.type === 'ai:models')
      return { ok: true, entry: { checkedAt: Date.now(), others: [],
        working: [{ id: 'openai/gpt-oss-120b', ok: true, ms: 820 }, { id: 'qwen/qwen3.8-27b', ok: true, ms: 610 }, { id: 'openai/gpt-oss-20b', ok: true, ms: 400 }],
        failed: [{ id: 'llama-3.3-70b-versatile', ok: false, reason: '(404): The model does not exist or you do not have access to it.' }] } };
    // ?mismatch mostra o aviso de endereço não cadastrado no cliente OAuth
    if (m.type === 'gmail:connect' && new URLSearchParams(location.search).has('mismatch'))
      return { ok: false, error: 'O Google ainda não conhece o endereço desta extensão. No Google Cloud, abra Clientes → o seu cliente OAuth e, em “URIs de redirecionamento autorizados”, clique em “Adicionar URI”, cole https://abcdefghijklmnop.chromiumapp.org/ e salve. Pode levar alguns minutos para valer.' };
    if (m.type === 'scanNow') {
      await local.set({ scan: { running: true, i: 1, total: 6, label: 'Vagas do LinkedIn · analista pl/sql', found: 3 } });
      setTimeout(() => local.set({ scan: { running: false, last: Date.now(), i: 6, total: 6, found: 3 } }), 4000);
    }
    return { ok: true };
  }

  window.chrome = {
    storage: { local, onChanged: { addListener: (l) => listeners.push(l) } },
    runtime: { sendMessage, getURL: (p) => '/' + p, id: 'mock' },
    identity: { getRedirectURL: () => 'https://abcdefghijklmnop.chromiumapp.org/' },
    tabs: { query: async () => [], create: async () => {} },
  };
})();
