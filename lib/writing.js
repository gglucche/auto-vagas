// Checks and cleans what the AI writes before it reaches the email or the PDF. Free models in particular add
// markdown, a preamble ("Aqui está o currículo:"), placeholders ([Nome da empresa]), characters the PDF can't
// print, or facts that are not in the resume (a year, a percentage, a technology the job asks for). The format
// is fixed here, in code; what can't be fixed comes back as a problem, for one correction round with the AI.
import { findSkills, GENERIC, termRe, unalias } from './match.js';

const flat = (s) => (s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const words = (s) => flat(s).split(/[^a-z0-9+#]+/).filter(Boolean);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "Java" as a whole word: not inside "JavaScript"
const hasWord = (text, word) => new RegExp(`(^|[^a-z0-9+#])${escape(flat(word))}($|[^a-z0-9+#])`).test(flat(text));

// ---------- language ----------

// Only words that belong to one language ("para", "experiencia" and "no" are both Portuguese and Spanish).
const STOPWORDS = {
  pt: 'do da dos das os as ao aos na nas em e com nao voce voces uma sua seu suas seus trabalho conhecimento tambem vaga atuar pelo pela muito mais tem sao equipe desenvolvimento',
  en: 'the and with you your we our for experience will team work is are to of in on as be have',
  es: 'y el los las la lo un una del al con usted nuestro nuestra trabajo conocimiento conocimientos tambien puesto empleo muy tiene somos son equipo desarrollo desarrollador',
};
const STOP = Object.fromEntries(Object.entries(STOPWORDS).map(([lang, list]) => [lang, new Set(list.split(' '))]));

// 'pt' | 'en' | 'es': the language most of the text's common words belong to (Portuguese when unsure).
export function detectLang(text) {
  const count = { pt: 0, en: 0, es: 0 };
  for (const w of words(text).slice(0, 600)) for (const lang of Object.keys(count)) if (STOP[lang].has(w)) count[lang]++;
  const [[best, n], [, second]] = Object.entries(count).sort((a, b) => b[1] - a[1]);
  return n >= 3 && n > second * 1.2 ? best : 'pt';
}
export const LANG_NAME = { pt: 'português do Brasil', en: 'inglês', es: 'espanhol' };

// ---------- characters and markdown ----------

const PDF_SAFE = /[\x20-\x7e\xa0-\xff€…‘’“”•–—\n]/;
const SWAP = [
  [/[●▪◦‣∙■□►▶]/g, '•'], [/[→⇒➜➔]/g, '-'], [/[−‐‑‒]/g, '-'], [/„/g, '"'], [/‚/g, "'"], [/[‹›]/g, "'"], [/™/g, ''], [/­/g, ''],
  [/[​-‍⁠﻿]/g, ''], [/[ -  ]/g, ' '],
];
// Only characters the PDF font (Helvetica, WinAnsi) can print; emoji and check marks go away, and a character
// outside it is simplified when it can be ("ﬁ" becomes "fi"), while "º", "ª" and "½", which it prints, stay.
export function pdfSafe(text) {
  let t = (text || '').normalize('NFC');
  for (const [re, to] of SWAP) t = t.replace(re, to);
  return [...t].map((ch) => (PDF_SAFE.test(ch) ? ch : [...ch.normalize('NFKC')].filter((c) => PDF_SAFE.test(c)).join(''))).join('');
}

const unmark = (line) =>
  line
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|[.,;:!?]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)');

const fences = (text) => text.replace(/\r/g, '').replace(/\\n/g, '\n').split('\n').filter((l) => !/^\s*```/.test(l));

// ---------- subject and email ----------

export function cleanSubject(subject) {
  let s = unmark(fences(subject || '').find((l) => l.trim()) || '')
    .replace(/^\s*(assunto|subject|asunto)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  // quotes around the whole subject, never just one of them
  const wrapped = s.match(/^["'“«](.*)["'”»]$/);
  if (wrapped) s = wrapped[1].trim();
  if (s.length > 110) s = s.slice(0, 110).replace(/\s+\S*$/, '');
  return s;
}

// The email as plain text, ending with the signature: added when the closing lines don't have the name or the
// email, and in place of a closing line with just the first name ("Atenciosamente,\nFulano").
export function cleanBody(body, { name = '', email = '', signature = '' } = {}) {
  const lines = fences(body || '')
    .filter((l, i, all) => !(i === all.findIndex((x) => x.trim()) && /^\s*(assunto|subject|asunto)\s*:/i.test(l)))
    .map((l) => unmark(l).replace(/^\s*#{1,6}\s*/, '').replace(/^\s*[•*·▪●]\s+/, '- ').replace(/\s+$/, ''));
  let text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!signature || !name) return text;
  const tail = text.split('\n').filter((l) => l.trim()).slice(-4);
  if (tail.some((l) => flat(l).includes(flat(name)) || (email && flat(l).includes(flat(email))))) return text;
  const firstName = flat(name).split(/\s+/)[0];
  const last = tail.at(-1) || '';
  if (firstName && last.length <= 40 && words(last).includes(firstName)) text = text.slice(0, text.lastIndexOf(last)).trimEnd();
  return `${text}\n\n${signature}`;
}

// ---------- resume ----------

const SECTION = /^(resumo( profissional)?|perfil( profissional)?|sobre( mim)?|objetivo|experiencias?( profissionais?)?|experiencia profissional|historico profissional|formacao( academica)?|educacao|habilidades( tecnicas)?|competencias( tecnicas)?|conhecimentos( tecnicos)?|tecnologias|idiomas|certificacoes|certificados|cursos( complementares)?|projetos|(professional )?summary|profile|(work |professional )?experience|education|(technical )?skills|languages|certifications|courses|projects|resumen|experiencia laboral|formacion|cursos)$/;

// Is this line the person's name? (as written in the settings, or with most of its words: "Fulano Tal")
function isName(line, name) {
  const l = words(unmark(line).replace(/^#+\s*/, ''));
  const n = words(name);
  if (!l.length || !n.length || l.length > n.length + 1) return false;
  return n.filter((w) => l.includes(w)).length >= Math.min(n.length, Math.max(2, n.length - 1));
}

// The tailored resume in the format the PDF understands: name on line 1, contacts, "# " sections, "- " items.
export function cleanResume(text, { name = '', contacts = '', email = '', phone = '' } = {}) {
  let lines = fences(pdfSafe(text || '')).map((l) => l.replace(/\s+$/, ''));
  // a preamble before the name ("Aqui está o currículo adaptado:") goes away; a missing name comes back
  const first = lines.findIndex((l) => l.trim());
  const at = name ? lines.slice(0, 8).findIndex((l) => isName(l, name) || flat(l).startsWith(flat(name))) : -1;
  if (at >= 0) lines = lines.slice(at);
  else if (first >= 0) {
    lines = lines.slice(first);
    if (name && /:\s*$/.test(lines[0])) lines = lines.slice(1);
    if (name) lines.unshift(name);
  }
  if (lines.length) lines[0] = unmark(lines[0]).replace(/^#+\s*/, '').trim();

  const out = [];
  const seen = new Set();
  for (const [i, raw] of lines.entries()) {
    if (i === 0) {
      out.push(raw);
      continue;
    }
    let line = raw.trim();
    if (/^(-{3,}|\*{3,}|_{3,}|={3,})$/.test(line) || /^\|?\s*:?-{3,}/.test(line)) continue; // rules, table separators
    if (/^\|.*\|$/.test(line)) line = line.slice(1, -1).split('|').map((c) => c.trim()).filter(Boolean).join(' — ');
    // a heading: "# ", or a known section name written as a heading (bold or in capitals), not a "Projetos:" label
    const bold = /^\*\*[^*]+\*\*:?$/.test(line);
    line = unmark(line);
    const title = line.replace(/^#+\s*/, '').replace(/:$/, '').trim();
    const bare = flat(title);
    const caps = title === title.toUpperCase() && /\p{Lu}/u.test(title);
    if (/^#/.test(line) || ((bold || caps) && SECTION.test(bare) && title.length <= 40)) {
      if (!title || seen.has(bare)) continue; // empty, or the same section twice
      seen.add(bare);
      out.push(`# ${title[0].toUpperCase()}${title.slice(1)}`);
      continue;
    }
    line = line.replace(/^([•*·▪●◦‣∙–—]|\d{1,2}[.)])\s+/, '- ').replace(/^-\s+/, '- ');
    out.push(line);
  }
  // the contacts right after the name, when the model dropped them (and only then)
  const top = out.slice(1, 6).join(' ');
  const hasContacts = (email && flat(top).includes(flat(email))) || (phone && digits(top).includes(digits(phone).slice(-8))) || /@|linkedin/i.test(top);
  if (contacts && !hasContacts) out.splice(1, 0, contacts);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- facts that are not in the resume ----------

const YEAR = /\b(19[5-9]\d|20[0-4]\d)\b/g;
const PERCENT = /\b\d{1,3}(?:[.,]\d+)?\s?%/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL = /\b(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com|github\.com|gitlab\.com)\/[\w\-./%]+/gi;
const digits = (s) => (s || '').replace(/\D/g, '');
const site = (u) => flat(u).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/.,;]+$/, '');
// Technologies in a job posting, everyday words in a resume ("redes de varejo").
const EVERYDAY = new Set(['redes']);

// What the text states that the base resume (or "extra": the person's settings and, for the email, the job's own
// title and figures) doesn't: years, percentages, emails, profile links and technologies, as written in the text.
// Names of the same technology ("ReactJS" and "React", "Postgres" and "PostgreSQL") and the same number in another
// format ("30,5%" and "30.5%", "03/19" and "2019") count as the same.
export function invented(text, base, extra = '') {
  const known = `${base}\n${extra}`;
  const knownFlat = flat(unalias(known));
  const knownDigits = digits(known);
  const knownSites = (known.match(URL) || []).map(site);
  const out = new Set();
  for (const y of text.match(YEAR) || []) if (!known.includes(y) && !new RegExp(`\\b\\d{1,2}/${y.slice(2)}\\b`).test(known)) out.add(y);
  for (const p of text.match(PERCENT) || []) if (!knownDigits.includes(digits(p))) out.add(p.trim());
  for (const e of text.match(EMAIL) || []) if (!knownFlat.includes(flat(e))) out.add(e);
  for (const u of text.match(URL) || []) if (!knownSites.some((k) => k === site(u)) && !knownFlat.includes(site(u))) out.add(u);
  for (const phone of text.match(/\+?\(?\d[\d\s().-]{8,}\d/g) || []) if (digits(phone).length >= 10 && !knownDigits.includes(digits(phone).slice(-8))) out.add(phone.trim());
  for (const skill of findSkills(unalias(text))) {
    const term = flat(skill);
    if (!GENERIC.has(term) && !EVERYDAY.has(term) && !termRe(term).test(knownFlat)) out.add(skill);
  }
  return [...out];
}

// Takes out of the resume what is invented: from a list of skills, just that item; any other line that states it,
// the whole line. Matches whole words ("Java" doesn't take "JavaScript" along).
export function removeInvented(resume, items) {
  let removed = 0;
  const lines = resume.split('\n').flatMap((line, i) => {
    if (i === 0) return [line];
    const hits = items.filter((it) => hasWord(unalias(line), unalias(it)) || hasWord(line, it));
    if (!hits.length) return [line];
    removed++;
    // "- Cloud: AWS, Kubernetes e Docker." -> "- Cloud: AWS e Docker."
    const [, lead = '', list = line] = line.match(/^(\s*(?:[-•]\s*)?(?:[^:,;]{1,40}:\s*)?)(.*)$/) || [];
    const items_ = list.replace(/[.;]\s*$/, '').split(/\s*(?:,|;|\s+e\s+|\s+and\s+|\s+y\s+)\s*/);
    // a list of skills (short items), not a sentence that happens to have commas
    const isList = items_.length >= 2 && items_.every((x) => words(x).length <= 3) && hits.every((it) => findSkills(it).length);
    if (!isList) return [];
    const kept = items_.filter((x) => !hits.some((it) => hasWord(unalias(x), unalias(it)) || hasWord(x, it)));
    return kept.length ? [`${lead}${kept.join(', ')}`] : [];
  });
  return { text: lines.join('\n'), removed };
}

// Does a new transcription of the resume keep what the old one says? Dates, emails and technologies, most of the
// length, and next to nothing added. ("Refinar com IA" must not trade the resume for a summary of it.)
export function keepsFacts(fresh, old) {
  if (fresh.length < old.length * 0.6) return false;
  const facts = [...new Set([...(old.match(YEAR) || []), ...(old.match(EMAIL) || []), ...findSkills(old)].map(flat))];
  const now = flat(fresh);
  return facts.filter((f) => now.includes(f)).length >= facts.length * 0.9 && invented(fresh, old).length <= 2;
}

// Placeholders the model left to be filled in: [Nome da empresa], {empresa}, <nome>, XXXX.
export function placeholders(text) {
  const re = /\[[^\]\n]{2,60}\]|\{[^}\n]{1,40}\}|<[^>\n]{2,40}>|\bX{3,}\b|\b(nome da empresa|nome do recrutador|seu nome|nome do cargo|company name|your name)\b/gi;
  return [...new Set((text || '').match(re) || [])];
}

// Does the resume contain this quote? Word for word, or nearly (accents, case and punctuation don't matter): 90% of
// its words, numbers included, close together in the resume, not picked here and there. Short terms (C#, Go, BI)
// count too.
export function grounded(quote, base) {
  // models often join two real excerpts ("Escrevo consultas em PostgreSQL; CTEs, window functions"): each must be there
  const pieces = String(quote || '').split(/\s*(?:;|…|\.\.\.|\s\|\s)\s*/).filter((p) => words(p).length);
  if (pieces.length > 1) return pieces.every((p) => grounded(p, base));
  const all = words(quote);
  const q = all.filter((w) => w.length >= 3 || /\d|[+#]/.test(w));
  const need = q.length ? q : all;
  if (!need.length) return false;
  const b = words(base);
  if (` ${b.join(' ')} `.includes(` ${all.join(' ')} `)) return true;
  // a number counts with what it measures: "10 anos" needs "10 anos" in the resume, not "10 projetos" and "3 anos"
  const num = (w) => /^\d/.test(w) && w.replace(/\D/g, '');
  const pairs = all.flatMap((w, i) => (num(w) && all[i + 1] ? [[num(w), all[i + 1]]] : []));
  if (pairs.some(([n, next]) => !b.some((w, i) => num(w) === n && b[i + 1] === next))) return false;
  const span = Math.max(12, need.length * 3);
  const hits = (from) => need.filter((w) => b.slice(from, from + span).includes(w)).length;
  for (let i = 0; i < b.length; i += Math.max(1, Math.floor(span / 2))) if (hits(i) / need.length >= 0.9) return true;
  return false;
}

// ---------- the whole application ----------

// How bad a list of problems is: placeholders, wrong language and missing structure first, then invented facts,
// then length. Picks the better of two answers.
// (an invented fact in the resume can be taken out of it; in the email it can't)
const WEIGHT = (p) => (p.items && p.field === 'resume' ? 2 : /curto|longo|passou de/.test(p.text) ? 1 : 3);
export const severity = (problems) => problems.reduce((s, p) => s + WEIGHT(p), 0);

// Cleans subject, email and resume and lists what is still wrong, in words the AI can act on.
// ctx: { base, lang, name, signature, contacts, email, phone, extra, job, resume: whether a tailored resume was asked for }
export function reviewApplication(out, ctx) {
  const subject = cleanSubject(out.subject);
  const body = cleanBody(out.body, ctx);
  const resume = ctx.resume ? cleanResume(out.resume, ctx) : '';
  const problems = [];
  const bodyWords = words(body).length;
  // the job's own words are not invented: its title, a code it asks for in the subject, "100% remoto"
  const jobText = ctx.job ? `${ctx.job.title || ''}\n${ctx.job.company || ''}\n${ctx.job.location || ''}\n${ctx.job.description || ''}` : '';
  const jobFacts = ctx.job ? [ctx.job.title, ctx.job.company, ctx.job.location, ...(jobText.match(YEAR) || []), ...(jobText.match(PERCENT) || [])].join('\n') : '';
  if (!subject) problems.push({ field: 'subject', text: 'o assunto veio vazio' });
  const holes = [...placeholders(subject), ...placeholders(body)].filter((h) => !flat(jobText).includes(flat(h)));
  if (holes.length) problems.push({ field: 'body', text: `o e-mail tem campos para preencher (${holes.join(', ')}): escreva o texto final` });
  if (bodyWords < 40) problems.push({ field: 'body', text: 'o e-mail está curto demais' });
  if (bodyWords > 260) problems.push({ field: 'body', text: 'o e-mail está longo demais (máximo de 180 palavras)' });
  if (bodyWords >= 30 && detectLang(body) !== ctx.lang) problems.push({ field: 'body', text: `o e-mail precisa estar em ${LANG_NAME[ctx.lang]}` });
  // without the resume's text (the AI read the PDF) there is nothing to compare the facts against
  const fakeBody = ctx.base ? invented(`${subject}\n${body.replace(ctx.signature || '\u0000', '')}`, ctx.base, `${ctx.extra || ''}\n${jobFacts}`) : [];
  if (fakeBody.length) problems.push({ field: 'body', text: `o e-mail cita o que não está no currículo base (${fakeBody.slice(0, 5).join(', ')}): tire isso`, items: fakeBody });
  if (ctx.resume) {
    const sections = resume.split('\n').filter((l) => l.startsWith('# ')).length;
    if (sections < 2) problems.push({ field: 'resume', text: 'o currículo precisa ter as seções começando com "# " (ex.: "# Experiência")' });
    if (ctx.base.length >= 800 && resume.length < ctx.base.length * 0.35) problems.push({ field: 'resume', text: 'o currículo ficou curto demais: mantenha todas as experiências, com cargo, empresa e datas' });
    if (resume.length > 7000) problems.push({ field: 'resume', text: 'o currículo passou de 7.000 caracteres: resuma os itens das experiências mais antigas' });
    if (placeholders(resume).length) problems.push({ field: 'resume', text: `o currículo tem campos para preencher (${placeholders(resume).join(', ')})` });
    if (words(resume).length >= 80 && detectLang(resume) !== ctx.lang) problems.push({ field: 'resume', text: `o currículo precisa estar em ${LANG_NAME[ctx.lang]}` });
    const fake = ctx.base ? invented(resume, ctx.base, ctx.extra) : [];
    if (fake.length) problems.push({ field: 'resume', text: `o currículo cita o que não está no currículo base (${fake.slice(0, 5).join(', ')}): tire isso`, items: fake });
  }
  return { subject, body, resume, problems };
}
