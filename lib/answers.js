// Answers for the fields of a job application form: LinkedIn's "Candidatura simplificada" (Easy Apply) and others.
// Everything comes from what the user provided: contact details, default answers and their earlier answers to the
// same question. Anything unknown is left unanswered — the application stops and the question goes to the panel.
//
//   answerFor({ label, kind, options, required }, { settings, job }) -> value or null
//   kind: text | number | textarea | select | radio | checkbox | file

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim();
// The same question shows up with an asterisk, a colon or "(obrigatório)" (required): all map to one key.
export const questionKey = (label) => norm(label).replace(/\(?\b(obrigatorio|required|opcional|optional)\b\)?/g, '').replace(/[*:?¿!.]+/g, ' ').replace(/\s+/g, ' ').trim();

const YES = /^(sim|yes|si|true|verdadeiro)\b/;
const NO = /^(nao|no|false|falso)\b/;
const PLACEHOLDER = /^(selecion|select|escolh|choose|--|—|$)/;

// The form option that matches an answer ("Sim" works for "Yes", "Avançado" for "Advanced"…).
export function pickOption(options, value) {
  const want = norm(String(value));
  const real = (options || []).filter((o) => !PLACEHOLDER.test(norm(o)));
  const same = (test) => real.find((o) => test(norm(o)));
  return (
    same((o) => o === want) ||
    (YES.test(want) && same((o) => YES.test(o))) ||
    (NO.test(want) && same((o) => NO.test(o))) ||
    same((o) => o.startsWith(want) || want.startsWith(o)) ||
    same((o) => o.includes(want)) ||
    null
  );
}

const LEVELS = [
  ['basico', /basic|basico|elementar|elementary|iniciante|beginner|a1|a2/],
  ['intermediario', /intermedi|limited working|b1|b2/],
  ['avancado', /avancad|advanced|professional working|profissional|c1/],
  ['fluente', /fluente|fluent|full professional|nativo|native|bilingue|bilingual|c2/],
];
const levelOption = (options, level) => {
  const re = LEVELS.find(([name]) => name === norm(level))?.[1];
  return (re && (options || []).find((o) => re.test(norm(o)))) || null;
};

const digits = (s) => String(s || '').replace(/\D/g, '');
// "oracle apex: 8" per line (or comma-separated) -> [['oracle apex', '8'], …], from the longest name to the shortest
const skillYears = (text) =>
  String(text || '')
    .split(/[\n,;]+/)
    .map((l) => l.split(/[:=]/).map((p) => p.trim()))
    .filter(([skill, years]) => skill && digits(years))
    .map(([skill, years]) => [norm(skill), digits(years)])
    .sort((a, b) => b[0].length - a[0].length);
const mentions = (label, term) => new RegExp(`(^|[^a-z0-9+#])${term.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}($|[^a-z0-9+#])`).test(label);

export function answerFor(question, { settings: s, job }) {
  const label = questionKey(question.label);
  const { kind, options } = question;
  const choice = kind === 'select' || kind === 'radio';
  const as = (value) => (value == null || value === '' ? null : choice ? pickOption(options, value) : String(value));

  // 1) the user has answered this question before
  const saved = s.applyAnswers?.[label];
  if (saved != null && saved !== '') return kind === 'checkbox' ? YES.test(norm(saved)) : as(saved);

  // 2) checkboxes: accept required terms, don't follow the company
  if (kind === 'checkbox') {
    if (/seguir|follow/.test(label)) return false;
    if (question.required && /concordo|aceito|li e|ciente|declaro|autorizo|i agree|i accept|acknowledge|terms|termos|privacidade|privacy/.test(label)) return true;
    return null;
  }
  if (kind === 'file') return null;

  // 3) contact details
  if (/e-?mail/.test(label)) return as(s.email);
  if (/codigo do pais|country code|phone country|pais do telefone/.test(label)) return choice ? (options || []).find((o) => o.includes(`(+${s.phoneCountry || '55'})`)) || null : `+${s.phoneCountry || '55'}`;
  if (/celular|telefone|phone|mobile|whatsapp|contato telefonico/.test(label)) {
    const phone = digits(s.phone);
    const country = s.phoneCountry || '55';
    return phone ? (phone.length > 11 && phone.startsWith(country) ? phone.slice(country.length) : phone) : null;
  }
  const names = (s.name || '').trim().split(/\s+/);
  if (/primeiro nome|first name|given name/.test(label)) return as(names[0]);
  if (/sobrenome|last name|ultimo nome|family name|surname/.test(label)) return as(names.slice(1).join(' '));
  if (/nome completo|full name|^nome$|^name$|seu nome/.test(label)) return as(s.name);
  if (/linkedin/.test(label)) return as(s.linkedinUrl);
  if (/github|portfolio|website|site pessoal|pagina pessoal/.test(label)) return as(s.portfolioUrl);
  if (/cidade|city|localizacao|location|onde voce (mora|reside)|municipio/.test(label)) return as(s.city);

  // 4) default answers
  if (/pretensao|salari|remuneracao|salary|compensation|expectativa de ganho|valor hora|hourly rate/.test(label)) return kind === 'number' ? digits(s.salary) || null : as(s.salary);
  if (/anos? de experiencia|years? of .*experience|how many years|quantos anos|tempo de experiencia|years? experience/.test(label)) {
    const known = skillYears(s.skillYears).find(([skill]) => mentions(label, skill));
    if (known) return as(known[1]);
    // general question ("anos de experiência profissional"): only if it doesn't mention any specific technology
    const general = /profissional|na area|no mercado|total|work experience|professional experience|^quantos anos de experiencia voce (tem|possui)$/.test(label);
    return general ? as(digits(s.yearsExperience)) : null;
  }
  if (/ingles|english/.test(label)) {
    if (choice) return levelOption(options, s.englishLevel) || null;
    return /nivel|level|proficien/.test(label) ? as(s.englishLevel) : null;
  }
  if (/disponibilidade|aviso previo|notice period|quando (voce )?pode comecar|start date|data de inicio/.test(label)) return as(s.availability);
  if (/carta de apresentacao|cover letter|mensagem (ao|para o) recrutador|message to (the )?hiring/.test(label)) return as(job?.body);
  // sensitive personal data: only "prefiro não responder" (prefer not to answer), when that option exists
  if (/genero|gender|raca|etnia|ethnic|race|deficiencia|disabilit|pcd|veteran|orientacao sexual|sexual orientation/.test(label))
    return choice ? (options || []).find((o) => /prefiro nao|nao desejo|nao quero|decline|prefer not|rather not/.test(norm(o))) || null : null;

  // 5) "Você tem experiência com X?" (do you have experience with X?): yes when X is among the user's skills
  if (choice && /experiencia (com|em)|experience (with|in)|conhecimento (em|de)|voce (tem|possui)|do you have|trabalhou com|worked with/.test(label)) {
    const mine = [...skillYears(s.skillYears).map(([skill]) => skill), ...String(s.skills || '').split(/[,\n;]/).map(norm).filter((x) => x.length > 1)];
    if (mine.some((skill) => mentions(label, skill))) return pickOption(options, 'sim');
  }
  return null;
}
