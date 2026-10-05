// Análise local (sem IA, instantânea): etiquetas da vaga e aderência por habilidades.

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

const LEXICON = `javascript typescript python java c# c++ .net php ruby golang rust kotlin swift sql pl/sql oracle apex
postgresql postgres mysql sql server mongodb redis supabase firebase react react native angular vue next.js node.js node
express nestjs django flask fastapi spring spring boot laravel rails html css sass tailwind bootstrap jquery rest api
graphql microsservicos microservices docker kubernetes aws azure gcp oci linux git github gitlab ci/cd jenkins terraform
ansible kafka rabbitmq elasticsearch spark hadoop airflow etl power bi tableau excel sap totvs protheus salesforce scrum
kanban agil agile jira figma ux ui photoshop machine learning llm pandas numpy tensorflow pytorch selenium cypress jest
junit testes automatizados qa devops lgpd ingles espanhol android ios flutter wordpress shopify seo google ads
marketing digital crm erp vendas atendimento gestao de projetos pmp contabilidade financeiro recrutamento logistica
compras cobol mainframe delphi vba power automate sharepoint dynamics servicenow itil redes cisco vmware suporte
helpdesk n8n data warehouse dbt snowflake databricks bigquery looker oracle ebs blue yonder integracao lideranca`
  .split('\n')
  .flatMap((line) => {
    // termos de mais de uma palavra, declarados explicitamente
    const multi = ['sql server', 'react native', 'spring boot', 'power bi', 'machine learning', 'testes automatizados',
      'google ads', 'marketing digital', 'gestao de projetos', 'power automate', 'data warehouse', 'oracle ebs', 'blue yonder'];
    let rest = ' ' + line + ' ';
    const found = multi.filter((m) => rest.includes(' ' + m + ' '));
    for (const m of found) rest = rest.replace(' ' + m + ' ', ' ');
    return [...found, ...rest.split(' ').filter(Boolean)];
  });

const cache = new Map();
function termRe(term) {
  if (!cache.has(term)) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cache.set(term, new RegExp(`(^|[^a-z0-9+#])${esc}($|[^a-z0-9+#])`));
  }
  return cache.get(term);
}

const userTerms = (skills) => (skills || '').split(/[,\n;]/).map((s) => norm(s).trim()).filter((s) => s.length > 1);

// { fit, matched, missing } ou null quando não há sinal suficiente no anúncio.
export function localFit(jobText, resumeText, skills) {
  const mine = userTerms(skills);
  const resume = norm(resumeText) + ' ' + mine.join(' , ');
  if (resume.trim().length < 20) return null;
  const job = norm(jobText);
  const terms = [...new Set([...LEXICON, ...mine])].filter((t) => termRe(t).test(job));
  if (terms.length < 3) return null;
  const matched = terms.filter((t) => termRe(t).test(resume));
  const missing = terms.filter((t) => !matched.includes(t));
  return { fit: Math.round((100 * matched.length) / terms.length), matched, missing };
}

export const normKey = (title, company) => norm(`${title}|${company}`).replace(/[^a-z0-9|]/g, '');

// Palavras comuns do inglês que só contam como habilidade quando escritas com maiúscula (REST, Node, Excel…).
const AMBIGUOUS = new Set(['rest', 'node', 'express', 'spring', 'rails', 'flask', 'spark', 'jest', 'excel', 'swift', 'rust']);

// Habilidades do léxico citadas no texto, da mais citada à menos, na grafia em que aparecem.
export function findSkills(text) {
  const original = (text || '').normalize('NFC');
  let flat = ''; // mesma posição de caracteres do original, sem acentos e em minúsculas
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
      re.lastIndex = at + term.length; // o separador final pode ser o inicial da próxima ocorrência
      const shown = original.slice(at, at + term.length);
      if (AMBIGUOUS.has(term) && shown === shown.toLowerCase()) continue;
      if (term === 'express' && /application\s+$/.test(flat.slice(0, at))) continue; // Oracle Application Express é o APEX
      ranges.push([at, at + term.length]);
      if (!display || (display === display.toLowerCase() && shown !== shown.toLowerCase())) display = shown;
    }
    if (ranges.length) found.push({ term, display, ranges });
  }
  // "SQL" dentro de "PL/SQL" ou "Node" dentro de "Node.js" não é uma habilidade à parte
  const all = found.flatMap((f) => f.ranges);
  return found
    .map((f) => ({ ...f, count: f.ranges.filter(([s, e]) => !all.some(([ls, le]) => ls <= s && e <= le && le - ls > e - s)).length }))
    .filter((f) => f.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((f) => f.display);
}
