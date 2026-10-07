// Local analysis (no AI, instant): job tags and skill-based fit.

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const TAGS = [
  ['Remoto', /\bremot[oa]\b|home ?office|\banywhere\b|trabalho de casa|100% remote|\bremote\b/],
  ['Híbrido', /\bhibrid[oa]\b|\bhybrid\b/],
  ['Presencial', /\bpresencial\b|\bon-?site\b/],
  ['CLT', /\bclt\b/],
  ['PJ', /\bpj\b|pessoa juridica/],
  ['Estágio', /\bestagi(o|ario|aria)\b|\bintern(ship)?\b/],
  ['Freelance', /\bfreela(ncer)?\b|\bfreelance\b/],
  ['Júnior', /\bjunior\b|\bjr\b/],
  ['Pleno', /\bpleno\b|\bmid-?level\b/],
  ['Sênior', /\bsenior\b|\bsr\b/],
  ['Especialista', /\bespecialista\b|\bstaff\b|\btech lead\b|\blead\b/],
];

export function extractTags(text) {
  const t = norm(text);
  const tags = TAGS.filter(([, re]) => re.test(t)).map(([name]) => name);
  const salary = (text || '').match(/R\$\s?\d[\d.,]*(?:\s?(?:a|-|–|até)\s?(?:R\$\s?)?\d[\d.,]*)?/);
  if (salary) tags.push(salary[0].replace(/\s+/g, ' '));
  return tags;
}

const LEXICON = `javascript typescript python java c# c++ .net php ruby golang rust kotlin swift sql pl/sql apex oracle
postgresql postgres mysql sql server mongodb redis supabase firebase react react native angular vue next.js node.js node
express nestjs django flask fastapi spring spring boot laravel rails html css sass tailwind bootstrap jquery rest api
graphql microsservicos microservices docker kubernetes aws azure gcp oci linux git github gitlab ci/cd jenkins terraform
ansible kafka rabbitmq elasticsearch spark hadoop airflow etl power bi tableau excel sap totvs protheus salesforce scrum
kanban agil agile jira figma ux ui photoshop machine learning llm pandas numpy tensorflow pytorch selenium cypress jest
junit testes automatizados qa devops lgpd ingles espanhol android ios flutter wordpress shopify seo google ads
marketing digital crm erp vendas atendimento gestao de projetos pmp contabilidade financeiro recrutamento logistica
compras cobol mainframe delphi vba power automate sharepoint dynamics servicenow itil redes cisco vmware suporte
helpdesk n8n data warehouse dbt snowflake databricks bigquery looker oracle ebs blue yonder integracao lideranca
oracle apex oracle retail ords ssis dax power query qlik sas outsystems mulesoft abap sap hana scala elixir redux svelte
storybook webpack playwright appium jmeter robot framework postman nosql dynamodb cassandra prometheus grafana datadog
google analytics weblogic t-sql
bash shell script powershell zabbix nginx windows server active directory microsoft 365 intune hyper-v helm argocd istio`
  .split('\n')
  .flatMap((line) => {
    // multi-word terms, listed explicitly
    const multi = ['sql server', 'react native', 'spring boot', 'power bi', 'machine learning', 'testes automatizados',
      'google ads', 'marketing digital', 'gestao de projetos', 'power automate', 'data warehouse', 'oracle ebs', 'blue yonder',
      'oracle apex', 'oracle retail', 'power query', 'sap hana', 'robot framework', 'google analytics', 'shell script',
      'windows server', 'active directory', 'microsoft 365'];
    let rest = ' ' + line + ' ';
    const found = multi.filter((m) => rest.includes(' ' + m + ' '));
    for (const m of found) rest = rest.replace(' ' + m + ' ', ' ');
    return [...found, ...rest.split(' ').filter(Boolean)];
  });

const cache = new Map();
export function termRe(term) {
  if (!cache.has(term)) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cache.set(term, new RegExp(`(^|[^a-z0-9+#])${esc}($|[^a-z0-9+#])`));
  }
  return cache.get(term);
}

const LEXICON_SET = new Set(LEXICON);
const userTerms = (skills) => (skills || '').split(/[,\n;]/).map((s) => norm(s).trim()).filter((s) => s.length > 1);

// ---------- local fit ----------
// What a recruiter looks at first, without AI: the technology in the title, the required items (the "diferenciais",
// nice-to-haves, count little; benefits and the company blurb don't count), the kind of role and the level.
// Tools that almost every posting lists (Git, Scrum, English…) weigh little: they don't make anyone fit a job.
// Calibrated against postings scored by recruiters (dev/fit-cases.json, checked by dev/test.mjs).

// The company's sector ("cliente do setor financeiro", "operação logística") is not a requirement either.
export const GENERIC = new Set(('git github gitlab scrum kanban agil agile jira linux excel ingles espanhol rest api html css ci/cd ' +
  'lideranca integracao crm erp figma ux ui seo lgpd qa suporte helpdesk atendimento vendas postman ' +
  'financeiro contabilidade logistica compras recrutamento').split(' '));

// Technologies that do the same job: missing the one in the title hurts less when you know its sibling.
const SIBLINGS = [
  'react|angular|vue|svelte', 'java|kotlin|c#|.net', 'postgresql|postgres|mysql|sql server|oracle|t-sql',
  'aws|azure|gcp|oci', 'power bi|tableau|looker|qlik', 'cypress|selenium|playwright|robot framework|appium',
  'android|ios|flutter|react native', 'node.js|nestjs|express', 'django|flask|fastapi', 'databricks|snowflake|bigquery|spark',
].map((g) => g.split('|'));

// Words for the kind of role, not a technology: in a title they say what the job is ("Analista DevOps").
const ROLE_TERMS = new Set('devops sre qa dba suporte helpdesk atendimento vendas ux ui'.split(' '));

// Other names for the same technology, so the posting and the resume use one ("Google Cloud" is GCP).
const ALIASES = [
  [/\bgoogle cloud( platform)?\b/gi, 'GCP'], [/\bamazon web services\b/gi, 'AWS'], [/\bmicrosoft azure\b/gi, 'Azure'],
  [/\bk8s\b/gi, 'Kubernetes'], [/\bnode\.?js\b/gi, 'Node.js'], [/\bpostgres\b/gi, 'PostgreSQL'],
  // the language Go, in a list or after "em/com/in/with" ("Java, Go e Python", "programação em Go"); not "Go Live",
  // nor the state at the end of a place ("Goiânia, Go")
  [/(?<=(?:\b(?:em|com|de|e|ou|in|with|and|or)\s+|[,;(/]\s*))Go\b(?![-'’]|\s+[Ll][Ii][Vv][Ee]\b)(?!\s*(?:$|[)|\n]))/gm, 'Golang'],
  [/\breact\.?js\b/gi, 'React'], [/\bvue\.?js\b/gi, 'Vue'], [/\bnext\.?js\b/gi, 'Next.js'], [/\bms ?sql( server)?\b/gi, 'SQL Server'],
  [/\bmicro-?servi[cç]os\b|\bmicro-?services\b/gi, 'microsserviços'],
];
export const unalias = (text) => ALIASES.reduce((t, [re, to]) => t.replace(re, to), text || '');

// Technologies the lexicon doesn't know, recognized in the requirements by their shape: an acronym (AKS, KVM),
// a mixed-case name (SELinux, PowerShell) or a name with a number (AZ-104, S3). Not these, which are not technologies.
const TECH_SHAPE = /^(?:[A-Z]{3,6}\d{0,3}|[A-Z]?[a-z]+[A-Z][A-Za-z]*|[A-Z]{2,}[a-z]+[A-Za-z]*|[A-Za-z]{1,4}-?\d{1,4}[A-Za-z]?|[A-Z]{2,}(?:\.[A-Z]+)+)$/;
const NOT_TECH = new Set(('clt pj sla slas ti rh plr vr va vt eua usa uk latam b2b b2c pme cnpj cpf mba kpi kpis okr okrs ceo cto cfo coo cio ' +
  'pcd lgbt lgbtqia esg ong sp rj mg pr sc rs ba pe ce df go es pa am rn pb al se pi ma ro ac ap rr ms mt abc nr ot ia ai ' +
  'n1 n2 n3 l1 l2 l3 tcc pdv cv hr it pt en pdf ok mvp poc rpa home office ads cnh mei ltda ead enem a1 a2 b1 b2 c1 c2 ' +
  'sr jr pl ii iii iv vaga vagas area time para com sobre pleno junior senior remoto remota urgente cargo setor nivel ' +
  'linkedin apis restful backend frontend fullstack devsecops mlops dataops finops').split(' '));

// Where a term shows up in the posting, and how much that counts.
const WEIGHT = { title: 3, must: 1.5, body: 1, nice: 0.4, skip: 0 };
const HEADING = [
  ['nice', /^(diferenciais|diferencial|desejavel|desejaveis|nice[ -]to[ -]have|pontos extras|sera um diferencial|good to have|preferred|plus)\b/],
  ['must', /^(requisitos|requisito|requirements|qualificacoes|qualifications|pre-?requisitos|o que (buscamos|esperamos|procuramos)|o que voce precisa|voce (precisa|deve) ter|must[ -]have|what you('ll| will)? need|what we('re| are) looking for|about you|you have|conhecimentos|competencias|perfil|hard skills|stack|tecnologias)\b/],
  ['body', /^(responsabilidades|atividades|principais atividades|atribuicoes|o que voce (vai|ira) fazer|responsibilities|what you('ll| will) do|descricao|sobre a (vaga|oportunidade|posicao|funcao)|a vaga|about the (role|job)|the role|your role|(o |os )?desafios?|dia a dia|sua missao|missao)\b/],
  ['skip', /^(beneficios|benefits|o que oferecemos|oferecemos|what we offer|perks|sobre (a empresa|nos|o time|a [a-z]+)|about (us|the company)|quem somos|nossa cultura|por que|why join|remuneracao|salario|etapas|processo seletivo|informacoes adicionais|local de trabalho)\b/],
];
const INLINE_NICE = /diferencia(l|is)|desejave(l|is)|nice to have|is a plus|\ba plus\b|\bbonus\b|preferencia|preferred|sera bem-?vindo/;

// The posting in pieces (line or sentence), each with its section: [normalized text, section, original text].
function sections(description) {
  let current = 'body';
  const parts = [];
  for (const raw of unalias(description).split(/\n|;\s|\.\s+(?=\p{L})/u)) {
    const bulleted = /^\s*[-–*·•>]/.test(raw);
    const original = raw.replace(/^[\s\-–*·•>]+/, '').trim();
    const line = norm(original);
    if (!line) continue;
    // a heading ("Requisitos", "Diferenciais: Docker, Kafka") changes the section, and what it says belongs to it;
    // a list item that happens to start like one ("- Conhecimentos em Kubernetes") doesn't
    const head = (!bulleted || /:\s*$/.test(line)) && HEADING.map(([where, re]) => [where, line.match(re)]).find(([, m]) => m);
    const [lead, rest] = line.split(/:\s*(.*)/s);
    if (head && (rest != null ? lead.split(' ').length <= 6 : line.length - head[1][0].length <= 15))
      current = head[0] !== 'skip' && INLINE_NICE.test(line) ? 'nice' : head[0]; // "Requisitos desejáveis"
    parts.push([line, current !== 'skip' && INLINE_NICE.test(line) ? 'nice' : current, original]);
  }
  return parts;
}

// Unknown technologies in a requirement (see TECH_SHAPE), as normalized terms; known terms are left to the lexicon.
function unknownTech(original, known) {
  // words split at letters with accents too ("SÊNIOR" is one word, not "S" and "NIOR"); a line mostly in capitals
  // is a heading or shouting, not a list of technologies
  const tokens = original.match(/\p{L}[\p{L}\p{N}]*(?:[.-][\p{L}\p{N}]+)*/gu) || [];
  if (tokens.filter((w) => /^\p{Lu}{4,}$/u.test(w)).length * 2 > tokens.length) return [];
  return [...new Set(tokens
    .filter((w) => TECH_SHAPE.test(w))
    .map((w) => norm(w))
    .filter((w) => !NOT_TECH.has(w) && !ROLE_TERMS.has(w) && !LEXICON_SET.has(w) && !known.some((t) => t.includes(w))))];
}

// English: 1 basic, 2 intermediate, 3 advanced or fluent.
const ENGLISH = [[3, /avancad|advanced|fluen|proficien|nativ|bilingu/], [2, /intermedi/], [1, /basic|basico|elementar/]];
const englishLevel = (text) => ENGLISH.find(([, re]) => re.test(text))?.[0] ?? null;
// The level said about English in a text: only next to the word, and not what belongs to another language
// ("Espanhol avançado e inglês básico" is basic English). Highest, when said more than once; null when not said.
const OTHER_LANGUAGE = /\b(espanhol|portugues|frances|alemao|italiano|mandarim|japones|spanish|portuguese|french|german|italian)\b/;
function englishIn(text) {
  const levels = [];
  for (const m of text.matchAll(/\b(ingles|english)\b/g)) {
    const before = text.slice(Math.max(0, m.index - 30), m.index).split(OTHER_LANGUAGE).at(-1).split(/[,;.\n]/).at(-1);
    const after = text.slice(m.index, m.index + 45).split(OTHER_LANGUAGE)[0].split(/[;.\n]/)[0];
    const level = englishLevel(after) || englishLevel(before);
    if (level) levels.push(level);
  }
  return levels.length ? Math.max(...levels) : null;
}
// What the person says about their English: the setting, or the resume ("Inglês: intermediário-avançado").
const personEnglish = (profile, resume) => (profile.englishLevel ? englishLevel(norm(profile.englishLevel)) : englishIn(resume));

// Terms mentioned in a text, without counting "sql" inside "pl/sql" or "spring" inside "spring boot".
function termsIn(text, terms) {
  const found = [];
  for (const term of terms) {
    const re = new RegExp(termRe(term).source, 'g');
    for (let m; (m = re.exec(text)); ) {
      const at = m.index + m[1].length;
      re.lastIndex = at + term.length;
      found.push({ term, at, end: at + term.length });
    }
  }
  return found.filter((f) => !found.some((o) => o.at <= f.at && f.end <= o.end && o.end - o.at > f.end - f.at)).map((f) => f.term);
}

// Kinds of role. A strong one is a different job even when the technology matches (a SQL Server DBA is not a data analyst).
const FAMILIES = [
  ['qa', true, /\b(qa|quality assurance|qualidade de software|analista de (testes?|qualidade)|testador|tester|test analyst|sdet)\b/],
  ['suporte', true, /\b(suporte|support|help ?desk|service ?desk)\b/],
  ['dba', true, /\b(dba|administrador(a)? de bancos? de dados|database administrator)\b/],
  ['gestao', true, /\b(gerente|gestor(a)?|head|diretor(a)?|director|coordenador(a)?|manager|supervisor(a)?|cto|cio)\b/],
  ['comercial', true, /\b(comercial|vendas|vendedor(a)?|sales|sdr|bdr|executiv[oa] de (contas|vendas|negocios)|account (executive|manager)|key account|pre-?vendas|presales)\b/],
  ['financeiro', true, /\b(financeir[oa]|contas a (pagar|receber)|contabil|contador(a)?|fiscal|tesouraria|cobranca|faturamento|controladoria|accounting|accountant)\b/],
  ['rh', true, /\b(rh|recursos humanos|recrutador(a)?|recrutamento|talent acquisition|recruiter|departamento pessoal)\b/],
  ['design', true, /\b(designer|design)\b/],
  ['produto', true, /\b(product owner|product manager|gerente de produto|analista de produto)\b/],
  ['atendimento', true, /\b(atendimento|atendente|customer success|sac|call center)\b/],
  ['dados', false, /\b(dados|data|bi|business intelligence|analytics|cientista|scientist)\b/],
  ['infra', false, /\b(infraestrutura|infra|redes|network|sysadmin|devops|sre|cloud engineer|seguranca da informacao|ciberseguranca|security)\b/],
  ['negocios', false, /\b(analista de (requisitos|negocios|processos)|business analyst|analista funcional)\b/],
  ['consultoria', false, /\b(consultor(a)?|consultant)\b/],
  ['dev', false, /\b(desenvolvedor(a)?|developer|programador(a)?|engenheir[oa] de software|software engineer|dev|full ?stack|front-?end|back-?end|frontend|backend|mobile|analista (de )?sistemas|analista (desenvolvedor|programador)(a)?)\b/],
];
const familiesOf = (text) => FAMILIES.filter(([, , re]) => re.test(text));
const SECTOR = new Set(['comercial', 'financeiro', 'rh', 'atendimento', 'design', 'produto']);
const EDUCATION = /\b(bacharel\w*|graduacao|tecnologo|licenciatura|mba|pos-?graduacao|mestrado|doutorado|curso|certified|certificacao|certificado|universidade|faculdade|escola|university|college|degree)\b/;

// Level: 0 internship, 1 junior, 2 mid-level, 3 senior and above.
const LEVELS = [
  [0, /\b(estagi(o|ario|aria)|intern|internship|trainee|aprendiz)\b/],
  [1, /\b(junior|jr)\b/],
  [2, /\b(pleno|mid-?level|middle)\b/],
  [3, /\b(senior|sr|especialista|staff|principal|expert|lead|lider)\b/],
];
const levelsIn = (text) => LEVELS.filter(([, re]) => re.test(text)).map(([level]) => level);
// For the person, only words that state a level: "principal", "lead" and "líder" turn up in any summary
// ("minha principal stack", "atuo junto ao líder técnico").
const PERSON_LEVELS = [...LEVELS.slice(0, 3), [3, /\b(senior|sr|especialista|staff)\b/]];
const personLevelsIn = (text) => PERSON_LEVELS.filter(([, re]) => re.test(text)).map(([level]) => level);

// The person's kind of role and level: from what they search for, the resume's headline and the job headers
// ("Desenvolvedor Oracle Sênior | Empresa | 2021 - atual", or the title on the line above the dates), not from
// every word of the resume: "experiência no setor financeiro" doesn't make a data analyst a finance analyst.
function personOf(resume, profile) {
  const lines = resume.split('\n').map((l) => l.trim()).filter(Boolean);
  const dated = (l) => l.length <= 160 && /\b(19|20)\d{2}\b|\b(atual|presente|present|current)\b/.test(l) && !EDUCATION.test(l);
  // "Cargo | Empresa | 2021 - atual": the role is the first part (the company's name says nothing about the role)
  const role = (l) => l.split(/\s+[|—–]\s+|\s+-\s+(?=\D)/)[0];
  const headers = lines.flatMap((l, i) => (!dated(l) ? [] : familiesOf(role(l)).length ? [role(l)] : lines.slice(Math.max(0, i - 1), i).filter((x) => x.length <= 100 && !x.startsWith('-'))));
  const roles = [norm(profile.keywords), ...lines.slice(0, 3), ...headers].join('\n');
  // level: what the person searches for, then the years they gave, then the headline and the latest job title
  const years = Number(profile.yearsExperience) || 0;
  const bySearch = personLevelsIn(norm(profile.keywords));
  const byResume = personLevelsIn([...lines.slice(0, 3), headers[0] || ''].join('\n'));
  const byText = personLevelsIn(resume.slice(0, 600));
  const level = bySearch.length ? Math.max(...bySearch)
    : years ? (years >= 6 ? 3 : years >= 3 ? 2 : years >= 1 ? 1 : 0)
    : byResume.length ? Math.max(...byResume) : byText.length ? Math.max(...byText) : null;
  return { families: new Set(familiesOf(roles).map(([name]) => name)), level };
}

// The words that say what a title is ("Desenvolvedor(a) Front-end Pleno" -> desenvolvedor, front, end).
const TITLE_STOP = new Set('de da do das dos e em para com a o as os and of the in for to no na pessoa vaga remoto remota remote hibrido hybrid presencial home office'.split(' '));
const titleWords = (s) =>
  norm(s).split(/[^a-z0-9+#.]+/).map((w) => w.replace(/(dor|tor)a$/, '$1').replace(/eira$/, 'eiro'))
    .filter((w) => w.length > 1 && !TITLE_STOP.has(w) && !levelsIn(w).length);
// Is this the kind of job the person searches for? (the title is one of their search terms, or contains one)
function titleSearched(title, keywords) {
  const t = new Set(titleWords(title));
  return (keywords || '').split('\n').map(titleWords).some((k) => k.length && (k.every((w) => t.has(w)) || (t.size >= 2 && [...t].every((w) => k.includes(w)))));
}

// { fit, matched, missing, fitWhy } or null when the posting says too little. job = { title, description };
// profile = the settings (resumeText, skills, keywords, yearsExperience).
export function localFit(job, profile) {
  const mine = userTerms(unalias(profile.skills));
  const resume = norm(unalias(profile.resumeText));
  const known = resume + '\n' + mine.join(' , ');
  if (known.trim().length < 20) return null;
  const terms = [...new Set([...LEXICON, ...mine])];
  const titleText = unalias(job.title);
  const title = norm(titleText);
  // the role words of the title (QA, DevOps, Suporte) are left to the kind of role, below
  const inTitle = termsIn(title, terms).filter((t) => !ROLE_TERMS.has(t));

  // each term: the heaviest place it shows up (a term only in the benefits or the company blurb is dropped);
  // a technology the lexicon doesn't know counts too, in the title and the requirements, a little less
  const weight = new Map();
  const add = (term, w) => weight.set(term, Math.max(weight.get(term) ?? 0, w));
  const place = (term, where) => WEIGHT[where] * (GENERIC.has(term) && where !== 'title' ? 0.25 : 1);
  for (const term of inTitle) add(term, place(term, 'title'));
  for (const term of unknownTech(titleText, inTitle)) add(term, WEIGHT.title * 0.7);
  const parts = sections(job.description);
  for (const [text, where, original] of parts) {
    const found = termsIn(text, terms);
    for (const term of found) add(term, place(term, where));
    if (where === 'must') for (const term of unknownTech(original, found)) add(term, WEIGHT.must * 0.7);
  }
  const list = [...weight].filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]);

  const got = (term) => termRe(term).test(known);
  // a title that is one of the person's search terms counts as a requirement met ("Analista de Dados")
  const searched = titleSearched(job.title, profile.keywords) ? 2 : 0;
  const total = list.reduce((s, [, w]) => s + w, 0) + searched;
  const core = [...new Set([...inTitle, ...unknownTech(titleText, inTitle)])];
  if (total < 1.5 && !core.length) return null;
  const matched = list.filter(([t]) => got(t)).map(([t]) => t);
  const missing = list.filter(([t]) => !got(t)).map(([t]) => t);
  // with little said in the posting, the score stays away from the extremes
  let fit = (100 * (list.filter(([t]) => got(t)).reduce((s, [, w]) => s + w, 0) + searched)) / (total + 1.5);

  // ceilings: the first thing a recruiter would turn the application down for
  const caps = [];
  const cap = (max, why) => caps.push([max, why]);
  const required = list.filter(([t, w]) => w >= WEIGHT.must * 0.7 && !GENERIC.has(t) && !core.includes(t));
  const requiredWeight = required.reduce((s, [, w]) => s + w, 0);
  const share = requiredWeight ? required.filter(([t]) => got(t)).reduce((s, [, w]) => s + w, 0) / requiredWeight : 1;
  if (requiredWeight >= 3) {
    const lacking = required.filter(([t]) => !got(t)).map(([t]) => t).slice(0, 4).join(', ');
    if (share < 0.34) cap(35, `faltam requisitos principais: ${lacking}`);
    else if (share < 0.6) cap(50, `faltam requisitos: ${lacking}`);
  }
  const coreMissing = core.filter((t) => !got(t));
  if (coreMissing.length) {
    const why = `${coreMissing.join(', ')}, do título da vaga, não aparece no seu currículo`;
    // a sibling technology (React for an Angular job), or everything else required, softens it
    const near = coreMissing.every((t) => SIBLINGS.some((g) => g.includes(t) && g.some((s) => s !== t && got(s))));
    cap(coreMissing.length < core.length ? 65 : near || (requiredWeight >= 3 && share >= 0.6) ? 45 : 30, why);
  }
  const needs = Math.max(0, ...parts.filter(([, where]) => where !== 'nice' && where !== 'skip').map(([text]) => englishIn(text) || 0));
  const speaks = personEnglish(profile, resume);
  if (needs && speaks && needs - speaks >= 2) cap(40, 'a vaga pede inglês fluente');
  else if (needs && speaks && needs > speaks) cap(60, 'a vaga pede um inglês mais avançado que o seu');

  const person = personOf(resume, profile);
  const roles = familiesOf(title);
  const foreign = roles.filter(([name]) => !person.families.has(name));
  // next to the person's own role, a sector is just where the job is ("Analista de Dados Comercial",
  // "Desenvolvedor Java - Squad Financeiro"); management, QA, support or a DBA job is still another job
  const own = roles.length > foreign.length;
  const blocking = foreign.filter(([name, strong]) => strong && !(own && SECTOR.has(name)));
  if (person.families.size && foreign.length) {
    if (blocking.length) cap(25, 'é outro tipo de função');
    else if (foreign.length === roles.length && (coreMissing.length || !core.length)) cap(45, 'é outro tipo de função');
  }
  const wanted = levelsIn(title);
  if (person.level != null && wanted.length) {
    const [low, high] = [Math.min(...wanted), Math.max(...wanted)];
    if (high === 0 && person.level >= 1) cap(15, 'é vaga de estágio ou trainee');
    else if (high < person.level - 1) cap(40, 'o nível da vaga está abaixo do seu');
    else if (low > person.level + 1) cap(45, 'o nível da vaga está acima do seu');
    else if (low > person.level) cap(75, 'o nível da vaga está um pouco acima do seu');
  }
  const [limit, why] = caps.sort((a, b) => a[0] - b[0])[0] || [100, ''];
  fit = Math.round(Math.min(fit, limit));
  return { fit, matched, missing, fitWhy: fit === limit ? why : '' };
}

export const normKey = (title, company) => norm(`${title}|${company}`).replace(/[^a-z0-9|]/g, '');

// Common English words that only count as a skill when capitalized (REST, Node, Excel…).
const AMBIGUOUS = new Set(['rest', 'node', 'express', 'spring', 'rails', 'flask', 'spark', 'jest', 'excel', 'swift', 'rust']);

// Lexicon skills mentioned in the text, most-mentioned first, spelled as they appear.
export function findSkills(text) {
  const original = (text || '').normalize('NFC');
  let flat = ''; // same character positions as the original, without accents and lowercased
  for (const ch of original) {
    const n = norm(ch);
    flat += n.length === ch.length ? n : ch;
  }
  const found = [];
  for (const term of LEXICON) {
    const re = new RegExp(termRe(term).source, 'g');
    const ranges = [];
    let display = '';
    let m;
    while ((m = re.exec(flat))) {
      const at = m.index + m[1].length;
      re.lastIndex = at + term.length; // the trailing separator may be the leading one of the next match
      const shown = original.slice(at, at + term.length);
      if (AMBIGUOUS.has(term) && shown === shown.toLowerCase()) continue;
      if (term === 'express' && /application\s+$/.test(flat.slice(0, at))) continue; // Oracle Application Express is APEX
      ranges.push([at, at + term.length]);
      if (!display || (display === display.toLowerCase() && shown !== shown.toLowerCase())) display = shown;
    }
    if (ranges.length) found.push({ term, display, ranges });
  }
  // "SQL" inside "PL/SQL" or "Node" inside "Node.js" is not a separate skill
  const all = found.flatMap((f) => f.ranges);
  return found
    .map((f) => ({ ...f, count: f.ranges.filter(([s, e]) => !all.some(([ls, le]) => ls <= s && e <= le && le - ls > e - s)).length }))
    .filter((f) => f.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((f) => f.display);
}
