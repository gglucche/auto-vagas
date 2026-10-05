const TAILOR_SYSTEM = `Você prepara candidaturas a vagas de emprego em nome do candidato.

Você recebe o currículo base do candidato e o texto de um anúncio (vaga do LinkedIn, post de recrutador, vaga do Google ou página capturada).

Regras:
- NUNCA invente experiências, empresas, cargos, datas, formações, certificações ou habilidades. Use somente o que está no currículo base. Adaptar significa selecionar, reordenar, resumir e reescrever para destacar o que é relevante para a vaga.
- Escreva no idioma do anúncio.
- "is_job_posting" é false quando o texto não é alguém contratando (ex.: pessoa procurando emprego, propaganda de curso, notícia). Nesse caso deixe os demais campos vazios e explique em "reason".
- "fit" é de 0 a 100: quanto o currículo base atende aos requisitos da vaga. Seja honesto.
- "reason": uma frase resumindo a avaliação.
- "strengths": até 4 pontos curtos do currículo que batem com a vaga. "gaps": até 4 requisitos da vaga que o currículo não comprova.
- "subject": assunto curto do e-mail. Se o anúncio pedir um assunto específico, use exatamente o que foi pedido.
- "body": e-mail curto (até ~130 palavras), direto, sem clichês e sem placeholders, citando 2 ou 3 pontos do currículo que batem com a vaga. Termine com o nome e os contatos do candidato. Texto puro, sem markdown.
- "resume": currículo adaptado em texto puro neste formato: primeira linha é o nome; segunda linha os contatos; seções começam com "# " (ex.: "# Experiência"); itens começam com "- ". Sem outro markdown, sem emojis. Máximo de duas páginas.`;

const str = { type: 'string' };
const strList = { type: 'array', items: str };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

const TAILOR_SCHEMA = obj({
  is_job_posting: { type: 'boolean' },
  fit: { type: 'integer' },
  reason: str,
  strengths: strList,
  gaps: strList,
  subject: str,
  body: str,
  resume: str,
});

const PROFILE_SCHEMA = obj({ name: str, email: str, location: str, resume_text: str, job_titles: strList, skills: strList });

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)', keyField: 'apiKey', modelField: 'model', defaultModel: 'claude-opus-5-5',
    keyUrl: 'https://console.anthropic.com/settings/keys', keyHint: 'sk-ant-...',
    hint: 'Melhor qualidade. Lê o PDF do currículo direto.',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
  },
  openai: {
    label: 'OpenAI', base: 'https://api.openai.com/v1', keyField: 'openaiKey', modelField: 'openaiModel', defaultModel: 'gpt-5.4-mini',
    keyUrl: 'https://platform.openai.com/api-keys', keyHint: 'sk-...',
    hint: 'Conta paga, sem cota gratuita. O app testa poucos modelos e prefere os econômicos.',
    pick: (id) => /^(gpt|o\d)/.test(id) && !/audio|realtime|image|tts|transcribe|search|embedding|codex|-pro/.test(id),
    // prefere os modelos econômicos da geração mais nova
    score: (id) => (parseFloat(id.match(/\d+(?:\.\d+)?/)?.[0]) || 0) * 10 + (/mini|luna/.test(id) ? 5 : /nano/.test(id) ? 3 : 0),
    probeMax: 4,
  },
  groq: {
    label: 'Groq (tem cota gratuita)', base: 'https://api.groq.com/openai/v1', keyField: 'groqKey', modelField: 'groqModel', defaultModel: 'openai/gpt-oss-120b',
    keyUrl: 'https://console.groq.com/keys', keyHint: 'gsk_...',
    hint: 'Rápido e com cota gratuita. O app testa quais modelos a sua chave pode usar e escolhe o melhor.',
    pick: (id) => !/whisper|tts|orpheus|guard|embed|compound/.test(id),
    serial: true, // cota gratuita: uma chamada de cada vez
  },
  opencode: {
    label: 'OpenCode Zen (modelos gratuitos)', base: 'https://opencode.ai/zen/v1', keyField: 'opencodeKey', modelField: 'opencodeModel', defaultModel: 'big-pickle',
    keyUrl: 'https://opencode.ai/auth', keyHint: 'chave do OpenCode Zen',
    hint: 'big-pickle e os modelos terminados em “-free” não cobram, mas exigem a chave da sua conta Zen. O app testa quais respondem e escolhe o melhor.',
    // só os modelos servidos em /chat/completions; os gratuitos primeiro
    pick: (id) => (/free$|^big-pickle$/.test(id) || /^(deepseek|glm|kimi|minimax|qwen3\.8-max)/.test(id)) && !/^(jev|muse)/.test(id),
    free: (id) => /free$|^big-pickle$/.test(id), // só estes entram no teste, para não gastar créditos
    sort: (a, b) => /free$|^big-pickle$/.test(b) - /free$|^big-pickle$/.test(a) || a.localeCompare(b),
    serial: true,
  },
};

export const providerOf = (settings) => PROVIDERS[settings.provider] || PROVIDERS.anthropic;
export const aiKey = (settings) => settings[providerOf(settings).keyField] || '';
const aiModel = (settings) => settings[providerOf(settings).modelField] || providerOf(settings).defaultModel;

function apiError(res, data, name) {
  const detail = data?.error?.message || data?.message || res.statusText || '';
  const code = `${data?.error?.code || ''} ${data?.error?.type || ''}`;
  // modelo aposentado, inexistente ou fora do plano da chave: dá para trocar por outro e seguir
  const modelIssue =
    res.status === 404 ||
    /model_not_found|model_decommissioned|model_terms_required/.test(code) ||
    (/model/i.test(detail) && /(not exist|not found|decommission|deprecat|not have access|no access|not available|not supported|unsupported|terms)/i.test(detail));
  const err = modelIssue
    ? new Error(`${name} (${res.status}): ${detail}`)
    : res.status === 401 || res.status === 403
      ? new Error(`${name}: chave recusada — ${detail}`)
      : res.status === 429
        ? new Error(`${name}: limite de uso atingido; tente de novo em instantes.`)
        : new Error(`${name} (${res.status}): ${detail}`);
  err.status = res.status;
  err.modelIssue = modelIssue;
  return err;
}

async function fetchModels(settings) {
  const p = providerOf(settings);
  const res = await fetch(p.base + '/models', { headers: aiKey(settings) ? { authorization: `Bearer ${aiKey(settings)}` } : {} });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res, data, p.label);
  return (data.data || []).filter((m) => m.id && m.active !== false && p.pick(m.id));
}

// Lista os modelos do provedor (para o campo "Modelo" do painel).
export async function listModels(settings) {
  const p = providerOf(settings);
  if (!p.base) return p.models;
  try {
    return (await fetchModels(settings)).map((m) => m.id).sort(p.sort || ((a, b) => a.localeCompare(b)));
  } catch {
    return [p.defaultModel];
  }
}

// ---------- OpenAI, Groq e OpenCode Zen (API compatível com a da OpenAI) ----------

const TYPE_PT = { string: 'texto', integer: 'número inteiro', boolean: 'true ou false', array: 'lista de textos' };
const describe = (schema) => Object.entries(schema.properties).map(([k, v]) => `- "${k}": ${TYPE_PT[v.type]}`).join('\n');

// Esses provedores não garantem o formato: completa campos ausentes e corrige tipos.
function conform(schema, raw) {
  const out = {};
  for (const [k, v] of Object.entries(schema.properties)) {
    const x = raw?.[k];
    if (v.type === 'array') out[k] = Array.isArray(x) ? x.map(String) : x ? [String(x)] : [];
    else if (v.type === 'integer') out[k] = Math.round(Number(x)) || 0;
    else if (v.type === 'boolean') out[k] = x === true || x === 'true';
    else out[k] = x == null ? '' : String(x);
  }
  return out;
}

async function callCompat(settings, { system, content, schema }, { timeoutMs = 120000, waitRateLimit = true } = {}) {
  const p = providerOf(settings);
  if (!aiKey(settings)) throw new Error(`Informe a chave de API de ${p.label} nas Configurações.`);
  const body = {
    model: aiModel(settings),
    messages: [
      { role: 'system', content: `${system}\n\nResponda SOMENTE com um objeto JSON válido, sem texto antes ou depois, com exatamente estes campos:\n${describe(schema)}` },
      { role: 'user', content },
    ],
    response_format: { type: 'json_object' },
  };
  const post = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(p.base + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${aiKey(settings)}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? `${p.label}: o modelo ${body.model} demorou demais para responder.` : `${p.label}: sem conexão (${e.message}).`);
    } finally {
      clearTimeout(timer);
    }
  };
  let res = await post();
  if (res.status === 400) {
    // alguns modelos não aceitam response_format; o pedido de JSON já está no prompt
    delete body.response_format;
    res = await post();
  }
  // cota gratuita estourada: espera o tempo que o provedor pedir e tenta de novo
  for (let attempt = 0; res.status === 429 && waitRateLimit && attempt < 3; attempt++) {
    const wait = Math.min(Number(res.headers?.get?.('retry-after')) || 6 * (attempt + 1), 25);
    await new Promise((r) => setTimeout(r, wait * 1000));
    res = await post();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res, data, p.label);
  const text = (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  try {
    return conform(schema, JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
  } catch {
    throw new Error(`${p.label}: o modelo ${body.model} não devolveu um JSON válido. Tente outro modelo.`);
  }
}

// ---------- Quais modelos a chave do usuário realmente pode usar ----------

// Palpite de capacidade pelo nome: "120b" vale mais que "20b"; "instant", "flash" e afins valem menos.
function modelScore(p, m) {
  if (p.score) return p.score(m.id);
  const id = m.id.toLowerCase();
  const size = id.match(/(\d+(?:\.\d+)?)b(?![a-z0-9])/);
  let score = size ? Math.min(+size[1], 400) : /ultra|large|max/.test(id) ? 90 : /mini|small|instant|nano|lite|flash|lightning|fast/.test(id) ? 12 : 40;
  if (/instant|lightning|flash|nano/.test(id)) score *= 0.8;
  return score + Math.log2((m.context_window || 32000) / 8000);
}

const PROBE_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' }, palavra: { type: 'string' } } };

// Pergunta mínima para saber se a chave pode usar o modelo e se ele devolve JSON.
export async function probeModel(settings, id) {
  const p = providerOf(settings);
  const started = Date.now();
  try {
    await callCompat(
      { ...settings, [p.modelField]: id },
      { system: 'Teste de conexão.', content: 'Devolva ok igual a true e palavra igual a "casa".', schema: PROBE_SCHEMA },
      { timeoutMs: 30000, waitRateLimit: false }
    );
    return { id, ok: true, ms: Date.now() - started };
  } catch (e) {
    // limite de uso estourado quer dizer que o modelo existe e a chave tem acesso
    if (e.status === 429) return { id, ok: true, limited: true, ms: Date.now() - started };
    return { id, ok: false, reason: e.message.replace(`${p.label}: `, '').replace(`${p.label} `, '') };
  }
}

// Testa, com a chave do usuário, quais modelos respondem. "working" vem do melhor para o pior.
export async function discoverModels(settings) {
  const p = providerOf(settings);
  if (!p.base) return { checkedAt: Date.now(), working: p.models.map((id) => ({ id, ok: true })), failed: [], others: [] };
  if (!aiKey(settings)) throw new Error(`Informe a chave de API de ${p.label} nas Configurações.`);
  const all = await fetchModels(settings);
  const candidates = (p.free ? all.filter((m) => p.free(m.id)) : all)
    .map((m) => ({ id: m.id, score: modelScore(p, m) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, p.probeMax || 16);
  const results = new Array(candidates.length);
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const i = next++;
      results[i] = await probeModel(settings, candidates[i].id);
    }
  };
  await Promise.all(Array.from({ length: p.serial ? 2 : 4 }, worker));
  return {
    checkedAt: Date.now(),
    working: results.filter((r) => r.ok).sort((a, b) => !!a.limited - !!b.limited), // sem cota no momento vai para o fim
    failed: results.filter((r) => !r.ok),
    others: all.map((m) => m.id).filter((id) => !candidates.some((c) => c.id === id)), // não testados
  };
}

function resumeTextOrThrow(settings) {
  if (settings.resumeText.trim()) return settings.resumeText;
  throw new Error(`${providerOf(settings).label} não lê PDF: carregue o currículo de novo para o texto ser extraído, ou cole o texto em “Texto do currículo usado pela IA”.`);
}

// ---------- Anthropic ----------

async function callClaude(settings, { system, content, schema }) {
  if (!settings.apiKey) throw new Error('Informe a API key da Anthropic nas Configurações.');
  const model = aiModel(settings);
  const modern = /^claude-(opus-5|sonnet-5-5|fable-5)/.test(model);
  const headers = {
    'content-type': 'application/json',
    'x-api-key': settings.apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const payload = {
    model,
    max_tokens: 16000,
    system,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  };
  if (modern) {
    payload.output_config.effort = 'medium';
    // Se o classificador de segurança recusar, a API refaz em outro modelo.
    payload.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res, data, 'Anthropic');
  if (data.stop_reason === 'refusal') throw new Error('A IA recusou este conteúdo.');
  if (data.stop_reason === 'max_tokens') throw new Error('Resposta da IA foi cortada (max_tokens).');
  const text = (data.content || []).find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('Resposta da IA veio vazia.');
  return JSON.parse(text);
}

const pdfBlock = (b64) => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } });

// O currículo vem primeiro e marcado para cache: é idêntico em todas as vagas.
function resumeBlock(settings, resumePdf) {
  if (settings.resumeText.trim())
    return { type: 'text', text: `<curriculo_base>\n${settings.resumeText}\n</curriculo_base>`, cache_control: { type: 'ephemeral' } };
  if (resumePdf?.b64) return { ...pdfBlock(resumePdf.b64), cache_control: { type: 'ephemeral' } };
  throw new Error('Suba seu currículo (PDF) nas Configurações para usar a IA.');
}

// ---------- Tarefas ----------

export async function tailor(settings, job, resumePdf) {
  const ad = `<anuncio origem="${job.source}">\nTítulo: ${job.title || ''}\nEmpresa/autor: ${job.company || ''}\nLocal: ${job.location || ''}\n\n${job.description || ''}\n</anuncio>`;
  if (providerOf(settings).base)
    return callCompat(settings, {
      system: TAILOR_SYSTEM,
      schema: TAILOR_SCHEMA,
      content: `<curriculo_base>\n${resumeTextOrThrow(settings)}\n</curriculo_base>\n\n${ad}`,
    });
  return callClaude(settings, { system: TAILOR_SYSTEM, schema: TAILOR_SCHEMA, content: [resumeBlock(settings, resumePdf), { type: 'text', text: ad }] });
}

// Lê o currículo e devolve os dados para preencher as configurações.
export async function analyzeResume(settings, resumePdf) {
  const system =
    'Você extrai dados de um currículo. Não invente nada: campos ausentes ficam vazios. ' +
    '"resume_text" é o conteúdo completo do currículo em texto puro (primeira linha o nome, seções com "# ", itens com "- "). ' +
    '"job_titles" são de 3 a 5 títulos de vaga, curtos, que essa pessoa deveria buscar em sites de emprego, no idioma do currículo. ' +
    '"skills" são as habilidades e ferramentas citadas (até 30), cada uma com 1 a 3 palavras.';
  const ask = 'Extraia os dados deste currículo.';
  if (!providerOf(settings).base) {
    if (!resumePdf?.b64) throw new Error('Suba o currículo em PDF primeiro.');
    return callClaude(settings, { system, schema: PROFILE_SCHEMA, content: [pdfBlock(resumePdf.b64), { type: 'text', text: ask }] });
  }
  // A OpenAI aceita o PDF como arquivo; Groq e OpenCode Zen, só texto.
  const content =
    settings.provider === 'openai' && resumePdf?.b64 && !settings.resumeText.trim()
      ? [{ type: 'file', file: { filename: resumePdf.name || 'curriculo.pdf', file_data: `data:application/pdf;base64,${resumePdf.b64}` } }, { type: 'text', text: ask }]
      : `${ask}\n\n${resumeTextOrThrow(settings)}`;
  return callCompat(settings, { system, schema: PROFILE_SCHEMA, content });
}
