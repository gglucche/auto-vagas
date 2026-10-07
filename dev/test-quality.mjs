// Quality of the fit and of the AI's texts, without network:
// - local fit against postings scored by recruiters (dev/fit-cases.json, invented data);
// - the checks and the cleanup of what the AI writes (lib/writing.js);
// - reading the AI's answer and computing the fit from its evaluation (lib/ai.js);
// - the request to OpenAI-compatible providers going around parameters the API turns down.
//
//   node dev/test-quality.mjs [-v]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const verbose = process.argv.includes('-v');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(ok ? 'OK    ' : 'FALHOU', name, ok ? '' : detail);
};

const { localFit } = await mod('lib/match.js');
const { cleanResume, cleanBody, cleanSubject, invented, removeInvented, placeholders, detectLang, grounded, keepsFacts, reviewApplication, pdfSafe } = await mod('lib/writing.js');
const { parseJsonLoose, conform, scoreEvaluation, evaluate, writeApplication } = await mod('lib/ai.js');

// ---------- 1) local fit against recruiters ----------
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'dev/fit-cases.json'), 'utf8'));
const rows = fixture.cases.map((c) => ({ ...c, fit: localFit(c, fixture.profiles[c.profile])?.fit ?? null }));
if (verbose) for (const r of rows) console.log(`       ${r.id.padEnd(9)} ${r.category.padEnd(17)} avaliadores ${String(r.gold).padStart(3)}  local ${String(r.fit).padStart(4)}`);
const scored = rows.filter((r) => r.fit != null);
const mae = scored.reduce((s, r) => s + Math.abs(r.fit - r.gold), 0) / scored.length;
const rank = (xs) => {
  const order = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = [];
  order.forEach(([, i], k) => (r[i] = k));
  return r;
};
const [rg, rf] = [rank(scored.map((r) => r.gold)), rank(scored.map((r) => r.fit))];
const mid = (scored.length - 1) / 2;
const spearman = rg.reduce((s, x, i) => s + (x - mid) * (rf[i] - mid), 0) / rg.reduce((s, x) => s + (x - mid) ** 2, 0);
check(`aderência local acompanha a dos recrutadores (erro médio ${mae.toFixed(1)}, correlação de ordem ${spearman.toFixed(2)})`, mae <= 9 && spearman >= 0.88 && scored.length === rows.length);
const poor = rows.filter((r) => r.gold < 35);
check('vaga que os recrutadores descartariam não passa de 40 (núcleo ausente, outra função, estágio, outra área)', poor.every((r) => r.fit <= 40), JSON.stringify(poor.filter((r) => r.fit > 40).map((r) => [r.id, r.gold, r.fit])));
const good = rows.filter((r) => r.gold >= 70);
check('vaga boa de verdade fica com 65 ou mais, inclusive anúncio curto e em inglês', good.every((r) => r.fit >= 65), JSON.stringify(good.filter((r) => r.fit < 65).map((r) => [r.id, r.gold, r.fit])));
check('o filtro da busca (aderência abaixo de 35) não esconde vaga razoável', rows.filter((r) => r.gold >= 45).every((r) => r.fit >= 35), JSON.stringify(rows.filter((r) => r.gold >= 45 && r.fit < 35).map((r) => r.id)));

const apex = fixture.profiles.apex;
const intern = localFit({ title: 'Estágio em Desenvolvimento Oracle APEX', description: 'Requisitos: Oracle APEX, PL/SQL e SQL.' }, apex);
check('o motivo do teto vai junto com a nota', intern.fit <= 15 && intern.fitWhy === 'é vaga de estágio ou trainee', JSON.stringify(intern));
const benefits = localFit({ title: 'Desenvolvedor Oracle APEX', description: 'Requisitos\n- Oracle APEX\n- PL/SQL\nBenefícios\n- Curso de inglês, Python e AWS pagos pela empresa' }, apex);
check('o que aparece só nos benefícios não conta como requisito', !benefits.missing.includes('python') && !benefits.missing.includes('aws'), JSON.stringify(benefits.missing));
const plsql = localFit({ title: 'Analista de Sistemas', description: 'Requisitos: PL/SQL, Oracle APEX, Java e JavaScript' }, { resumeText: 'Desenvolvedor PL/SQL e Oracle APEX', skills: 'pl/sql, oracle apex', keywords: 'Desenvolvedor PL/SQL' });
check('"sql" dentro de "pl/sql" não conta duas vezes', !plsql.matched.includes('sql') && plsql.matched.includes('pl/sql'), JSON.stringify(plsql.matched));

// ---------- 2) what the AI writes ----------
const base = 'Fulano de Tal\nfulano@exemplo.com · (19) 99999-8888\n# Experiência\nDesenvolvedor Oracle APEX — Empresa Alfa (2019 – atual)\n- Oracle APEX, PL/SQL e JavaScript; batch 40% mais rápido\n# Formação\n- Sistemas de Informação — Universidade X (2015)';
const who = { name: 'Fulano de Tal', email: 'fulano@exemplo.com', contacts: 'fulano@exemplo.com · (19) 99999-8888', signature: 'Fulano de Tal\nfulano@exemplo.com · (19) 99999-8888' };
const messy = 'Aqui está o currículo adaptado:\n```markdown\n**Fulano de Tal**\n## EXPERIÊNCIA PROFISSIONAL\n**Desenvolvedor Oracle APEX** | Empresa Alfa | 2019 – atual\n• Oracle APEX → PL/SQL ✓ 🚀\n1. JavaScript nas telas\n## Experiência profissional\n| Ferramenta | Anos |\n|---|---|\n---\n```';
const clean = cleanResume(messy, who);
check('currículo: sai o preâmbulo, a cerca de código, o markdown, o emoji e a tabela; o nome vem primeiro e os contatos depois',
  clean.split('\n')[0] === 'Fulano de Tal' && clean.split('\n')[1] === who.contacts && !/[`*🚀✓→]|^\||-{3}/m.test(clean) && /^Ferramenta — Anos$/m.test(clean) && /^# EXPERIÊNCIA PROFISSIONAL$/m.test(clean) && /^- Oracle APEX - PL\/SQL$/m.test(clean) && /^- JavaScript nas telas$/m.test(clean) && clean.split('\n').filter((l) => l.startsWith('# ')).length === 1,
  JSON.stringify(clean));
check('currículo: só caracteres que o PDF imprime (acentos ficam)', pdfSafe('ação — “ok” ★ → ﬁm Łukasz') === 'ação — “ok”  - fim ukasz', JSON.stringify(pdfSafe('ação — “ok” ★ → ﬁm Łukasz')));
check('e-mail: sai a linha "Assunto:", o markdown, e entra a assinatura que faltava',
  cleanBody('Assunto: Vaga\n\nOlá,\n\n**Tenho** interesse.', who) === `Olá,\n\nTenho interesse.\n\n${who.signature}`, JSON.stringify(cleanBody('Assunto: Vaga\n\nOlá,\n\n**Tenho** interesse.', who)));
check('assunto: uma linha, sem aspas, asteriscos nem "Assunto:"', cleanSubject('Assunto: **"Candidatura – Dev APEX"**\nmais') === 'Candidatura – Dev APEX');
const fake = invented('Desenvolvedor Oracle APEX desde 2019, Kubernetes e Docker em 2021, 60% de ganho, contato ciclano@exemplo.com, liderança de times.', base);
check('fatos fora do currículo: ano, porcentagem, e-mail e tecnologia (não palavras genéricas como liderança)',
  ['2021', '60%', 'ciclano@exemplo.com', 'Kubernetes', 'Docker'].every((x) => fake.includes(x)) && !fake.includes('2019') && !fake.some((x) => /lideran/i.test(x)), JSON.stringify(fake));
const removed = removeInvented('Fulano de Tal\n# Habilidades\n- Banco: Oracle, PL/SQL, Kubernetes\n- Kubernetes e Docker em produção desde 2021\n- Oracle APEX', ['Kubernetes', '2021', 'Docker']);
check('tirar o inventado: a tecnologia sai da lista, a linha inventada sai inteira', removed.text === 'Fulano de Tal\n# Habilidades\n- Banco: Oracle, PL/SQL\n- Oracle APEX' && removed.removed === 2, JSON.stringify(removed));
check('campos para preencher são achados', placeholders('Olá [Nome do Recrutador], na {empresa} — XXXX').length === 3);
check('idioma do anúncio', detectLang('We are looking for a developer with experience in Oracle APEX to join our team') === 'en' && detectLang('Buscamos un desarrollador con experiencia en Oracle APEX para el equipo de la empresa') === 'es' && detectLang('Procuramos pessoa desenvolvedora com experiência em Oracle APEX para o time') === 'pt');
check('evidência: o trecho tem de estar no currículo (acento e maiúscula não importam)', grounded('ORACLE APEX, PL/SQL e Javascript', base) && !grounded('Kubernetes em produção', base));
check('"Refinar com IA": transcrição que perde datas e tecnologias não substitui o texto do currículo',
  keepsFacts(base.replace('Fulano', 'Fulano'), base) && !keepsFacts('Fulano de Tal\nDesenvolvedor com experiência em várias tecnologias e boa comunicação, focado em resultados.', base));
const review = reviewApplication({ subject: 'Candidatura', body: 'Olá [Nome], tenho interesse.', resume: 'Fulano de Tal\n- Kubernetes' }, { ...who, base, lang: 'pt', extra: '', resume: true });
check('revisão lista o que pedir para a IA corrigir', review.problems.some((p) => /campos para preencher/.test(p.text)) && review.problems.some((p) => /seções/.test(p.text)) && review.problems.some((p) => p.items?.includes('Kubernetes')), JSON.stringify(review.problems.map((p) => p.text)));

// ---------- 3) reading the AI's answer ----------
const loose = parseJsonLoose('<think>pensando…</think>Claro! ```json\n{"body": "linha 1\nlinha 2", "lista": [1, 2,],}\n```');
check('JSON com bloco de raciocínio, cerca, texto em volta, quebra de linha crua e vírgula sobrando', loose.body === 'linha 1\nlinha 2' && loose.lista.length === 2, JSON.stringify(loose));
const EV = { type: 'object', properties: { is_job_posting: { type: 'boolean' }, nota: { type: 'integer' }, requisitos: { type: 'array', items: { type: 'object', properties: { requisito: { type: 'string' }, atende: { type: 'string', enum: ['sim', 'parcial', 'nao'] } } } } } };
const fixedUp = conform(EV, { resposta: { isJobPosting: 'True', Nota: '85%', Requisitos: [{ requisito: 'APEX', atende: 'Sim' }, { requisito: 'Delphi', atende: 'talvez' }] } });
check('resposta embrulhada, chaves com outra grafia, "True", "85%" e valor fora da lista viram o formato certo',
  fixedUp.is_job_posting === true && fixedUp.nota === 85 && fixedUp.requisitos[0].atende === 'sim' && fixedUp.requisitos[1].atende === 'nao', JSON.stringify(fixedUp));

const ev = (requisitos, extra = {}) => ({ is_job_posting: true, requisitos, area: 'mesma', nivel: 'compativel', resumo: 'ok', ...extra });
const r = (requisito, tipo, evidencia, atende) => ({ requisito, tipo, evidencia, atende });
const strong = scoreEvaluation(ev([r('Oracle APEX', 'obrigatorio', 'Oracle APEX, PL/SQL e JavaScript', 'sim'), r('PL/SQL', 'obrigatorio', 'PL/SQL', 'sim'), r('Delphi', 'desejavel', '', 'nao')]), base);
check('nota da IA: obrigatórios atendidos valem mais que o desejável que falta', strong.fit === 86 && strong.gaps.join() === 'Delphi', JSON.stringify(strong));
const liar = scoreEvaluation(ev([r('Oracle APEX', 'obrigatorio', 'Oracle APEX', 'sim'), r('Kubernetes', 'obrigatorio', 'Kubernetes em produção', 'sim')]), base);
check('nota da IA: "atende" sem trecho real do currículo vale só metade', liar.fit === 75 && liar.requirements[1].atende === 'parcial' && liar.requirements[1].evidencia === '', JSON.stringify(liar));
const other = scoreEvaluation(ev([r('Oracle APEX', 'obrigatorio', 'Oracle APEX', 'sim')], { area: 'outra' }), base);
check('nota da IA: outra função limita a nota, e o motivo vem junto', other.fit === 25 && other.why === 'é outro tipo de função', JSON.stringify(other));
const missing = scoreEvaluation(ev([r('Java', 'obrigatorio', '', 'nao'), r('Spring', 'obrigatorio', '', 'nao'), r('Oracle APEX', 'obrigatorio', 'Oracle APEX', 'sim')]), base);
check('nota da IA: faltando a maioria dos obrigatórios, fica baixa', missing.fit <= 35, JSON.stringify(missing));
check('fonte que só tem vagas: "não é vaga" da IA é ignorado', scoreEvaluation({ ...ev([]), is_job_posting: false }, base, { source: 'gupy' }).isPosting && !scoreEvaluation({ ...ev([]), is_job_posting: false }, base, { source: 'linkedin_post' }).isPosting);

// ---------- 4) the request: parameters the API turns down ----------
const calls = [];
let replies = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push(body);
  const [status, payload] = replies.shift() || [200, {}];
  return { ok: status < 400, status, headers: { get: () => null }, json: async () => payload };
};
const answer = (obj, finish = 'stop') => [200, { choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) }, finish_reason: finish }] }];
const evalAnswer = ev([r('Oracle APEX', 'obrigatorio', 'Oracle APEX', 'sim')]);
const settings = { provider: 'openai', openaiKey: 'k', openaiModel: 'gpt-teste', resumeText: base, name: who.name, email: who.email, phone: '(19) 99999-8888' };
const job = { source: 'gupy', title: 'Desenvolvedor Oracle APEX', description: 'Requisitos: Oracle APEX', company: 'X' };

replies = [
  [400, { error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.", param: 'temperature', code: 'unsupported_value' } }],
  [400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", param: 'max_tokens' } }],
  answer(evalAnswer),
];
let got = await evaluate({ ...settings, openaiModel: 'modelo-a' }, job, null).catch((e) => e);
check('parâmetro recusado (temperatura, nome do limite de tokens): pede de novo sem ele e não troca de modelo',
  got.fit === 100 && calls.length === 3 && !('temperature' in calls[2]) && calls[1].max_completion_tokens > 0, JSON.stringify([got.message || got.fit, calls.map((c) => Object.keys(c))]));

calls.length = 0;
replies = [[400, { error: { message: 'This model does not support response format `json_schema`.' } }], answer(evalAnswer)];
got = await evaluate({ ...settings, openaiModel: 'modelo-b' }, job, null).catch((e) => e);
check('formato estrito recusado: cai para json_object', got.fit === 100 && calls[0].response_format.type === 'json_schema' && calls[1].response_format.type === 'json_object', JSON.stringify(calls.map((c) => c.response_format)));

calls.length = 0;
replies = [answer('{"is_job_posting": true, "requisitos": [{"requisito": "Oracle', 'length'), answer(evalAnswer)];
got = await evaluate({ ...settings, openaiModel: 'modelo-c' }, job, null).catch((e) => e);
check('resposta cortada por falta de tokens: pede de novo com mais espaço', got.fit === 100 && calls[1].max_completion_tokens > calls[0].max_completion_tokens, JSON.stringify(calls.map((c) => c.max_completion_tokens)));

calls.length = 0;
replies = [answer('Claro, a vaga combina bastante com o candidato.'), answer(evalAnswer)];
got = await evaluate({ ...settings, openaiModel: 'modelo-d' }, job, null).catch((e) => e);
check('resposta fora de JSON: o modelo vê o erro e responde de novo', got.fit === 100 && calls.length === 2 && /não é um JSON válido/.test(calls[1].messages.at(-1).content), JSON.stringify(calls.length));

calls.length = 0;
replies = [[413, { error: { message: 'Request too large for model on tokens per minute (TPM): Limit 8000, Requested 9500' } }], answer(evalAnswer)];
got = await evaluate({ ...settings, provider: 'groq', groqKey: 'k', groqModel: 'openai/gpt-oss-120b' }, job, null).catch((e) => e);
check('cota gratuita por minuto (413): pede de novo com um limite de tokens que cabe', got.fit === 100 && calls[1].max_completion_tokens <= calls[0].max_completion_tokens - 1500, JSON.stringify(calls.map((c) => c.max_completion_tokens)));

calls.length = 0;
const goodText = {
  subject: 'Candidatura – Desenvolvedor Oracle APEX',
  body: 'Olá,\n\nTenho interesse na vaga de desenvolvedor Oracle APEX. Trabalho com Oracle APEX, PL/SQL e JavaScript na Empresa Alfa desde 2019 e deixei um batch 40% mais rápido. Gosto de entender o negócio antes de propor uma solução e de trabalhar perto de quem usa o sistema. Fico à disposição para conversar sobre a vaga e sobre como posso ajudar o time.\n\nAtenciosamente,',
  resume: base,
};
replies = [answer({ ...goodText, resume: `${base}\n- Kubernetes e Docker em produção` }), answer({ ...goodText, resume: `${base}\n- Kubernetes e Docker em produção` })];
got = await writeApplication({ ...settings, openaiModel: 'modelo-e' }, job, null, strong);
check('currículo que insiste em inventar depois da correção: a linha inventada sai e o usuário fica sabendo',
  calls.length === 2 && !/Kubernetes/.test(got.resume) && got.resume.startsWith('Fulano de Tal') && /Kubernetes/.test(got.warnings.join()) && got.body.endsWith(who.signature), JSON.stringify([calls.length, got.warnings]));

calls.length = 0;
replies = [answer({ ...goodText, body: 'Hello,\n\n' + 'I am interested in this role and I have worked with the tools you need for years and I would be glad to talk. '.repeat(3) }), answer({ ...goodText, body: 'Hello,\n\n' + 'I am interested in this role and I have worked with the tools you need for years and I would be glad to talk. '.repeat(3) })];
got = await writeApplication({ ...settings, openaiModel: 'modelo-f' }, job, null, strong);
check('e-mail no idioma errado mesmo depois da correção: fica vazio (vai o modelo de e-mail do usuário), com aviso', got.body === '' && /modelo de e-mail/.test(got.warnings.join()), JSON.stringify(got.warnings));

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} de ${results.length} verificações passaram.`);
process.exit(failed ? 1 : 0);
