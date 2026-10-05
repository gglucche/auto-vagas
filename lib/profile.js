// Builds the profile from the resume lines (output of extractPdfText), without AI:
// name, email, location, skills, search suggestions and the full text.
import { findSkills } from './match.js';

const flat = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

const SECTION =
  /^(contact|contato|contatos|dados pessoais|top skills|skills|technical skills|hard skills|principais competencias|competencias|habilidades|habilidades tecnicas|conhecimentos|tecnologias|languages|idiomas|certifications|certificacoes|licenses & certifications|licencas e certificados|summary|resumo|resumo profissional|sobre|sobre mim|about|about me|perfil|perfil profissional|objetivo|objective|experience|experiencia|experiencias|experiencia profissional|professional experience|work experience|education|educacao|formacao|formacao academica|projects|projetos|honors-awards|honors & awards|premios|publications|publicacoes|courses|cursos|volunteer experience|trabalho voluntario|references|referencias|interests|interesses|additional information|informacoes adicionais)$/;
const isSection = (t) => SECTION.test(flat(t).replace(/[:.]$/, ''));
const SKILLS = /^(top skills|skills|technical skills|hard skills|principais competencias|competencias|habilidades|habilidades tecnicas|conhecimentos|tecnologias)$/;
const EXPERIENCE = /^(experience|experiencia|experiencias|experiencia profissional|professional experience|work experience)$/;

const ROLE =
  /\b(developer|desenvolvedor|desenvolvedora|engineer|engenheir[oa]|analyst|analista|consultant|consultor|consultora|programmer|programador|programadora|architect|arquitet[oa]|designer|manager|gerente|coordinator|coordenador|coordenadora|specialist|especialista|administrator|administrador|administradora|dba|scientist|cientista|tester|devops|sre|product owner|scrum master|tech lead|technician|tecnic[oa]|assistant|assistente|auxiliar|estagiari[oa]|intern|trainee|supervisor|supervisora|director|diretor|diretora|vendedor|vendedora|representante|advogad[oa]|contador|contadora|enfermeir[oa]|professor|professora|teacher|recruiter|recrutador|recrutadora|atendente|operador|operadora|motorista|comprador|compradora|buyer|planner|planejador|planejadora)\b/;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/i;
const BR_STATE =
  /\b(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\b|sao paulo|rio de janeiro|minas gerais|parana|santa catarina|rio grande|bahia|pernambuco|ceara|distrito federal|goias|espirito santo|amazonas|mato grosso|paraiba|maranhao|alagoas|sergipe|piaui|rondonia|tocantins|roraima|amapa|acre/;
const COUNTRY = /\b(brasil|brazil|portugal|estados unidos|united states|usa|canada|argentina|chile|espanha|spain|germany|alemanha|ireland|irlanda|uk|united kingdom|reino unido)\b/;

const PARTICLES = new Set(['da', 'das', 'de', 'do', 'dos', 'del', 'della', 'di', 'du', 'e', 'van', 'von', 'la', 'le', 'y']);
const NAME = /^\p{Lu}[\p{L}'’.-]*(?:\s+(?:(?:d[aeo]s?|del|della|di|du|e|van|von|la|le|y)\s+)?\p{Lu}[\p{L}'’.-]*){1,5}$/u;
const NOT_NAME = /\b(curriculum|vitae|curriculo|resume|skills|rua|avenida|av|street|road|linkedin|page|pagina|certificate|certified|bacharel|university|universidade|instituto|ltda|inc)\b/;

function findName(lines, email) {
  const local = flat((email || '').split('@')[0]).replace(/[^a-z]/g, '');
  let best = null;
  lines.slice(0, 80).forEach((l, index) => {
    const t = l.text;
    const f = flat(t);
    if (!NAME.test(t) || isSection(t) || ROLE.test(f) || NOT_NAME.test(f) || findSkills(t).length) return;
    // the name is usually the largest text on the first page; the email often contains part of it
    const inEmail = f.split(/\s+/).some((w) => w.length >= 4 && local.includes(w.slice(0, 5)));
    const score = l.size + (inEmail ? 6 : 0) - index * 0.01;
    if (!best || score > best.score) best = { score, text: t, index };
  });
  if (!best) return { name: '', index: -1 };
  let name = best.text;
  if (name === name.toUpperCase())
    name = name.toLowerCase().split(/\s+/).map((w) => (PARTICLES.has(w) ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
  return { name, index: best.index };
}

function findLocation(lines, nameIndex) {
  let best = null;
  lines.slice(0, 80).forEach((l, index) => {
    if (isSection(l.text) || index === nameIndex) return;
    // the city often shares the line with the email and phone: "City, State · email · phone"
    for (const t of l.text.split(/\s*[·•|]\s*/)) {
      if (t.length > 60 || /[\d@:]/.test(t)) continue;
      const parts = t.split(/\s*[,/–-]\s*/).filter(Boolean);
      if (parts.length < 2 || parts.length > 4 || !parts.every((p) => /^\p{Lu}/u.test(p) && p.split(/\s+/).length <= 4)) continue;
      const f = flat(t);
      const score = (COUNTRY.test(f) ? 2 : 0) + (BR_STATE.test(t) || BR_STATE.test(f) ? 2 : 0) + (index > nameIndex && index - nameIndex <= 4 ? 2 : 0) - index * 0.01;
      if (score >= 2 && (!best || score > best.score)) best = { score, text: t };
    }
  });
  return best ? best.text : '';
}

// Items of the skills section, up to the next section.
function skillSection(lines) {
  const start = lines.findIndex((l) => SKILLS.test(flat(l.text).replace(/[:.]$/, '')));
  if (start < 0) return [];
  const items = [];
  let pending = '';
  for (const l of lines.slice(start + 1, start + 16)) {
    if (isSection(l.text) || l.text.length > 60) break;
    const t = pending ? `${pending} ${l.text}` : l.text;
    // an item broken across two lines ends with a preposition ("Programação de linguagem de")
    if (/\s(de|da|do|das|dos|e|em|para|com|of|and|for|in|&)$/i.test(t)) {
      pending = t;
      continue;
    }
    pending = '';
    items.push(...t.split(/\s*[,;•·|]\s*|\s{2,}/).map((x) => x.replace(/^[-–*]\s*/, '').trim()).filter((x) => x.length > 1 && x.length <= 40));
  }
  return items;
}

const ROLE_PT = {
  developer: 'Desenvolvedor', engineer: 'Engenheiro', analyst: 'Analista', consultant: 'Consultor', programmer: 'Programador',
  architect: 'Arquiteto', manager: 'Gerente', specialist: 'Especialista', administrator: 'Administrador', scientist: 'Cientista',
  designer: 'Designer', coordinator: 'Coordenador', director: 'Diretor', supervisor: 'Supervisor', technician: 'Técnico',
  assistant: 'Assistente', intern: 'Estagiário', recruiter: 'Recrutador', teacher: 'Professor', buyer: 'Comprador', planner: 'Planejador',
};
const LEVEL_PT = { senior: 'Sênior', sr: 'Sênior', junior: 'Júnior', jr: 'Júnior', mid: 'Pleno', 'mid-level': 'Pleno', principal: 'Principal' };

// "Senior Apex Developer" -> "Desenvolvedor Apex Sênior". Returns null if the title doesn't follow the English pattern.
function toPortuguese(title) {
  const words = title.split(/\s+/);
  const role = ROLE_PT[words.at(-1).toLowerCase().replace(/[^a-z]/g, '')];
  if (!role || words.length < 2) return null;
  const level = [];
  const rest = [];
  for (const w of words.slice(0, -1)) {
    const k = w.toLowerCase().replace(/\./g, '');
    if (LEVEL_PT[k]) level.push(LEVEL_PT[k]);
    else rest.push(k === '&' || k === 'and' ? 'e' : w);
  }
  return [role, ...rest, ...level].join(' ');
}

// "Oracle Consultant & Senior APEX Developer" is two roles; "Oracle APEX & PL/SQL Developer" is just one.
const splitRoles = (title) => {
  const parts = title.split(/\s+(?:&|and|e|\/|\+)\s+/);
  return parts.length > 1 && parts.every((p) => ROLE.test(flat(p))) ? parts : [title];
};

const looksLikeTitle = (t) => {
  const words = t.split(/\s+/);
  return t.length <= 60 && words.length <= 7 && !/[.,:;]$/.test(t) && !/\d/.test(t) && ROLE.test(flat(t)) &&
    words.filter((w) => /^\p{Lu}/u.test(w)).length >= words.length / 2;
};

function findTitles(lines, nameIndex) {
  const titles = [];
  // 1) headline right below the name ("Fulano | Desenvolvedor X | ...")
  for (const l of nameIndex >= 0 ? lines.slice(nameIndex + 1, nameIndex + 3) : []) {
    if (isSection(l.text)) break;
    const part = l.text.split(/\s*[|•·]\s*|\s+[–—-]\s+/).map((p) => p.trim()).find((p) => p && ROLE.test(flat(p)) && p.split(/\s+/).length <= 7);
    if (part) {
      titles.push(part);
      break;
    }
  }
  // 2) job titles from the experience section, from most recent to oldest
  const start = lines.findIndex((l) => EXPERIENCE.test(flat(l.text).replace(/[:.]$/, '')));
  const section = start < 0 ? lines : lines.slice(start + 1);
  const end = section.findIndex((l) => isSection(l.text) && !EXPERIENCE.test(flat(l.text)));
  const body = end < 0 ? section : section.slice(0, end);
  for (const l of body) if (looksLikeTitle(l.text)) titles.push(l.text);
  // 3) resume with no line of its own for the job title: look for the title inside the sentences
  if (!titles.length)
    for (const l of body)
      for (const re of [TITLE_PT, TITLE_EN]) for (const m of l.text.matchAll(re)) titles.push(m[0].replace(/[\s.,:;-]+$/, ''));
  return titles;
}

// "Analista de Dados Pleno na Empresa X" -> "Analista de Dados Pleno"; "worked as Senior Data Engineer at" -> "Senior Data Engineer"
const TITLE_PT =
  /(?<![\p{L}])(?:Desenvolvedora?|Analista|Engenheir[oa]|Consultora?|Programadora?|Arquitet[oa]|Gerente|Coordenadora?|Especialista|Administradora?|Cientista|Técnic[oa]|Assistente|Auxiliar|Estagiári[oa]|Supervisora?|Diretora?|Vendedora?|Recrutadora?|Professora?|Contadora?|Compradora?|Planejadora?|Operadora?|Atendente|Motorista|Advogad[oa]|Enfermeir[oa]|Representante)(?:(?:\s+(?:de|da|do|em|e))?\s+\p{Lu}[\p{L}/+#.-]*){1,3}/gu;
const TITLE_EN =
  /(?:\p{Lu}[\p{L}/+#.&-]*\s+){1,3}(?:Developer|Engineer|Analyst|Consultant|Programmer|Architect|Manager|Specialist|Administrator|Scientist|Designer|Coordinator|Director|Supervisor|Technician|Assistant|Recruiter|Teacher|Buyer|Planner)(?![\p{L}])/gu;

export function profileFromResume(lines) {
  const text = lines.map((l) => l.text).join('\n');
  const email = (text.match(EMAIL) || [''])[0].toLowerCase();
  const { name, index } = findName(lines, email);
  const location = findLocation(lines, index);

  const seen = new Set();
  const unique = (list) => list.filter((x) => x && !seen.has(flat(x)) && seen.add(flat(x)));
  const skills = unique([...skillSection(lines), ...findSkills(text)]).slice(0, 30);

  // in Brazil, job openings are usually posted in Portuguese
  const inBrazil = /\b(brasil|brazil)\b/.test(flat(location)) || BR_STATE.test(location) || /\.br$/.test(email) || /\+55/.test(text);
  seen.clear();
  const keywords = unique(findTitles(lines, index).flatMap(splitRoles).map((t) => (inBrazil && toPortuguese(t)) || t)).slice(0, 4);

  return { name, email, location, skills: skills.join(', '), keywords: keywords.join('\n'), resumeText: text };
}
