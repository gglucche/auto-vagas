export const DEFAULTS = {
  name: '',
  email: '',
  keywords: '',
  location: '',
  remoteOnly: false,
  excludeTerms: '',
  srcLinkedinJobs: true,
  srcBoards: true, // Gupy, InfoJobs, Vagas.com, Remotar e Himalayas
  // estas duas só existem dentro de uma página: abrem uma janela de busca, por isso vêm desligadas
  srcLinkedinPosts: false,
  srcGoogle: false,
  maxPerSearch: 15,
  scanEveryHours: 0,
  notify: true,
  mode: 'template', // 'template' | 'ai'
  provider: 'anthropic', // 'anthropic' | 'openai' | 'groq' | 'opencode'
  apiKey: '', // Anthropic
  model: 'claude-opus-5-5',
  openaiKey: '',
  openaiModel: '',
  groqKey: '',
  groqModel: '',
  opencodeKey: '',
  opencodeModel: '',
  resumeText: '',
  skills: '',
  subjectTemplate: 'Candidatura – {vaga}',
  bodyTemplate:
    'Olá,\n\nTenho interesse na vaga de {vaga} e envio meu currículo em anexo para avaliação.\n\nFico à disposição para conversar.\n\nAtenciosamente,\n{nome}',
  followUpDays: 7,
  followUpTemplate:
    'Olá,\n\nEscrevo para reforçar meu interesse na vaga de {vaga}. Sigo à disposição para conversar e posso enviar qualquer informação adicional.\n\nAtenciosamente,\n{nome}',
  autoSend: false,
  dailyLimit: 20,
  minFit: 60,
  gmailClientId: '',
  // candidatura no site (LinkedIn "Candidatura simplificada" e formulários): respostas que o usuário dá uma vez
  phone: '',
  phoneCountry: '55',
  city: '',
  linkedinUrl: '',
  portfolioUrl: '',
  yearsExperience: '',
  skillYears: '', // "oracle apex: 8", um por linha
  salary: '',
  availability: 'Imediata',
  englishLevel: '',
  applyAnswers: {}, // pergunta (normalizada) -> resposta
  applyReview: false, // parar antes de enviar, para o usuário conferir
  applyDailyLimit: 20,
  blockedDomains: 'linkedin.com\nexample.com\nsentry.io',
};

export const JOB_PREFIX = 'job:';

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...settings };
}

export async function setSettings(patch) {
  const s = await getSettings();
  await chrome.storage.local.set({ settings: { ...s, ...patch } });
}

// Cada vaga fica em sua própria chave: alterar uma vaga grava só ela,
// e o painel recebe a mudança isolada via storage.onChanged.
export async function getJobs() {
  const keys = (await chrome.storage.local.getKeys()).filter((k) => k.startsWith(JOB_PREFIX));
  return keys.length ? Object.values(await chrome.storage.local.get(keys)) : [];
}

export async function getJob(id) {
  const key = JOB_PREFIX + id;
  return (await chrome.storage.local.get(key))[key] || null;
}

export function putJobs(list) {
  if (!list.length) return Promise.resolve();
  return chrome.storage.local.set(Object.fromEntries(list.map((j) => [JOB_PREFIX + j.id, j])));
}

// Serializa as alterações para não perder atualizações concorrentes da mesma vaga.
let chain = Promise.resolve();
export function patchJob(id, patch) {
  const p = chain.then(async () => {
    const job = await getJob(id);
    if (!job) return null;
    Object.assign(job, patch);
    await chrome.storage.local.set({ [JOB_PREFIX + id]: job });
    return job;
  });
  chain = p.catch(() => {});
  return p;
}

export const removeJobs = (ids) => chrome.storage.local.remove(ids.map((id) => JOB_PREFIX + id));

export async function log(msg) {
  const { log = [] } = await chrome.storage.local.get('log');
  log.unshift({ t: Date.now(), msg });
  await chrome.storage.local.set({ log: log.slice(0, 200) });
}

export function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 'j' + (h >>> 0).toString(36);
}

export function fillTemplate(tpl, job, s) {
  // Em posts o "título" é só a 1ª linha do texto; a palavra-chave da busca descreve melhor a vaga.
  const vaga = job.source === 'linkedin_post' ? job.keyword || job.title : job.title;
  return tpl.replaceAll('{vaga}', vaga).replaceAll('{empresa}', job.company || '').replaceAll('{nome}', s.name);
}
