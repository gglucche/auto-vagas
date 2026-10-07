// Checks and cleans what the AI writes before it reaches the email or the PDF. Free models in particular add
// markdown, a preamble ("Aqui está o currículo:"), placeholders ([Nome da empresa]), characters the PDF can't
// print, or facts that are not in the resume (a year, a percentage, a technology the job asks for). The format
// is fixed here, in code; what can't be fixed comes back as a problem, for one correction round with the AI.
import { findSkills, GENERIC, termRe } from './match.js';

const flat = (s) => (s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const words = (s) => flat(s).split(/[^a-z0-9+#]+/).filter(Boolean);

// ---------- language ----------

const STOPWORDS = {
  pt: 'de que para com nao uma os as das dos voce sua seu experiencia vaga empresa trabalho atuar conhecimento sobre tambem ao na no em e',
  en: 'the and with you your we our for experience will team work is are to of in on as be have',
  es: 'y el los las con para una del experiencia usted nuestro trabajo empresa conocimiento sobre tambien al en es',
};
const STOP = Object.fromEntries(Object.entries(STOPWORDS).map(([lang, list]) => [lang, new Set(list.split(' '))]));

// 'pt' | 'en' | 'es': the language most of the text's common words belong to (Portuguese when unsure).
export function detectLang(text) {
  const count = { pt: 0, en: 0, es: 0 };
  for (const w of words(text).slice(0, 600)) for (const lang of Object.keys(count)) if (STOP[lang].has(w)) count[lang]++;
  const [best, n] = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  return n >= 3 && n > count.pt * 1.2 ? best : 'pt';
}
export const LANG_NAME = { pt: 'português do Brasil', en: 'inglês', es: 'espanhol' };

// ---------- characters and markdown ----------

const PDF_SAFE = /[\x20-\x7e\xa0-\xff€…‘’“”•–—\n]/;
const SWAP = [
  [/[→⇒➜➔►▶]/g, '-'], [/[−‐‑‒]/g, '-'], [/„/g, '"'], [/‚/g, "'"], [/[‹›]/g, "'"], [/™/g, ''], [/­/g, ''],
  [/[​-‍⁠﻿]/g, ''], [/[ -  ]/g, ' '],
];
// Only characters the PDF font (Helvetica, WinAnsi) can print; emoji, arrows and check marks go away.
export function pdfSafe(text) {
  let t = (text || '').normalize('NFKC');
  for (const [re, to] of SWAP) t = t.replace(re, to);
  return [...t.normalize('NFC')].filter((ch) => PDF_SAFE.test(ch)).join('');
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
    .replace(/^["'“”«]+|["'“”»]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 110) s = s.slice(0, 110).replace(/\s+\S*$/, '');
  return s;
}

// The email as plain text, ending with the signature (added when the model left it out).
export function cleanBody(body, { name = '', signature = '' } = {}) {
  const lines = fences(body || '')
    .filter((l, i, all) => !(i === all.findIndex((x) => x.trim()) && /^\s*(assunto|subject|asunto)\s*:/i.test(l)))
    .map((l) => unmark(l).replace(/^\s*#{1,6}\s*/, '').replace(/^\s*[•*·▪●]\s+/, '- ').replace(/\s+$/, ''));
  let text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (signature && name && !flat(text).includes(flat(name))) text += `\n\n${signature}`;
  return text;
}

// ---------- resume ----------

const SECTION = /^(resumo( profissional)?|perfil( profissional)?|sobre( mim)?|objetivo|experiencias?( profissionais?)?|experiencia profissional|historico profissional|formacao( academica)?|educacao|habilidades( tecnicas)?|competencias( tecnicas)?|conhecimentos( tecnicos)?|tecnologias|idiomas|certificacoes|certificados|cursos( complementares)?|projetos|(professional )?summary|profile|(work |professional )?experience|education|(technical )?skills|languages|certifications|courses|projects|resumen|experiencia laboral|formacion|cursos)$/;

// The tailored resume in the format the PDF understands: name on line 1, contacts, "# " sections, "- " items.
export function cleanResume(text, { name = '', contacts = '', email = '' } = {}) {
  let lines = fences(pdfSafe(text || '')).map((l) => l.replace(/\s+$/, ''));
  // a preamble before the name ("Aqui está o currículo adaptado:") goes away; a missing name comes back
  const first = lines.findIndex((l) => l.trim());
  const at = name ? lines.slice(0, 8).findIndex((l) => flat(unmark(l).replace(/^#+\s*/, '')).trim() === flat(name).trim()) : -1;
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
    line = unmark(line);
    const bare = flat(line.replace(/^#+\s*/, '').replace(/:$/, '')).trim();
    const heading = /^#/.test(line) || (SECTION.test(bare) && line.length <= 40);
    if (heading) {
      if (seen.has(bare)) continue; // the same section twice
      seen.add(bare);
      const title = line.replace(/^#+\s*/, '').replace(/:$/, '').trim();
      out.push(`# ${title[0].toUpperCase()}${title.slice(1)}`);
      continue;
    }
    line = line.replace(/^([•*·▪●◦‣∙–—]|\d{1,2}[.)])\s+/, '- ').replace(/^-\s+/, '- ');
    out.push(line);
  }
  // the contacts right after the name, when the model dropped them
  if (contacts && email && !flat(out.slice(1, 6).join(' ')).includes(flat(email))) out.splice(1, 0, contacts);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- facts that are not in the resume ----------

const YEAR = /\b(19[5-9]\d|20[0-4]\d)\b/g;
const PERCENT = /\b\d{1,3}(?:[.,]\d+)?\s?%/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL = /\b(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com|github\.com|gitlab\.com)\/[\w\-./%]+/gi;
const digits = (s) => s.replace(/\D/g, '');

// What the text states that the base resume (or the person's settings, in "extra") doesn't: years, percentages,
// emails, profile links and technologies. Returns them as written in the text.
export function invented(text, base, extra = '') {
  const known = `${base}\n${extra}`;
  const knownFlat = flat(known);
  const knownDigits = digits(known);
  const out = new Set();
  for (const y of text.match(YEAR) || []) if (!known.includes(y)) out.add(y);
  for (const p of text.match(PERCENT) || []) if (!knownFlat.replace(/\s/g, '').includes(flat(p).replace(/\s/g, ''))) out.add(p.trim());
  for (const e of text.match(EMAIL) || []) if (!knownFlat.includes(flat(e))) out.add(e);
  for (const u of text.match(URL) || []) if (!knownFlat.includes(flat(u).replace(/^https?:\/\/(www\.)?/, ''))) out.add(u);
  for (const phone of text.match(/\+?\(?\d[\d\s().-]{8,}\d/g) || []) if (digits(phone).length >= 10 && !knownDigits.includes(digits(phone).slice(-8))) out.add(phone.trim());
  for (const skill of findSkills(text)) {
    const term = flat(skill);
    if (!GENERIC.has(term) && !termRe(term).test(knownFlat)) out.add(skill);
  }
  return [...out];
}

// Takes out of the resume the lines that state something invented (a technology in a comma list loses just itself).
export function removeInvented(resume, items) {
  let removed = 0;
  const lines = resume.split('\n').flatMap((line, i) => {
    if (i === 0) return [line];
    const hits = items.filter((it) => flat(line).includes(flat(it)));
    if (!hits.length) return [line];
    const isList = /[,;]/.test(line) && hits.every((it) => findSkills(it).length);
    if (isList) {
      let kept = line;
      for (const it of hits) kept = kept.replace(new RegExp(`(^|[,;:]\\s*)${it.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?=[,;]|$)`, 'i'), '$1');
      kept = kept.replace(/([,;])\s*[,;]/g, '$1').replace(/[,;]\s*$/, '').replace(/:\s*[,;]\s*/, ': ');
      if (kept !== line) {
        removed++;
        return /[a-z0-9]/i.test(kept.replace(/^[-#\s]+/, '').replace(/^[^:]*:\s*$/, '')) ? [kept] : [];
      }
    }
    removed++;
    return [];
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
  const re = /\[[^\]\n]{2,60}\]|\{[^}\n]{1,40}\}|<[^>\n]{2,40}>|\bX{3,}\b|\b(nome da empresa|nome do recrutador|seu nome|nome do cargo|company name|your name|hiring manager)\b/gi;
  return [...new Set((text || '').match(re) || [])];
}

// Does the resume contain this quote? (word for word, or nearly: accents, case and punctuation don't matter)
// Stricter matching: requires either exact sequence or very high match rate for free models' safety.
export function grounded(quote, base) {
  const q = words(quote).filter((w) => w.length >= 3);
  if (!q.length) return false;
  const b = ` ${words(base).join(' ')} `;
  // Exact match is the most reliable
  if (b.includes(` ${words(quote).join(' ')} `)) return true;
  // For partial matches, require 90% coverage to be conservative with free models
  const have = new Set(words(base));
  const matched = q.filter((w) => have.has(w)).length;
  return matched / q.length >= 0.9;
}

// ---------- the whole application ----------

// Cleans subject, email and resume and lists what is still wrong, in words the AI can act on.
// ctx: { base, lang, name, signature, contacts, email, extra, resume: whether a tailored resume was asked for }
export function reviewApplication(out, ctx) {
  const subject = cleanSubject(out.subject);
  const body = cleanBody(out.body, ctx);
  const resume = ctx.resume ? cleanResume(out.resume, ctx) : '';
  const problems = [];
  const bodyWords = words(body).length;
  if (!subject) problems.push({ field: 'subject', text: 'o assunto veio vazio' });
  const holes = [...placeholders(subject), ...placeholders(body)];
  if (holes.length) problems.push({ field: 'body', text: `o e-mail tem campos para preencher (${holes.join(', ')}): escreva o texto final` });
  if (bodyWords < 40) problems.push({ field: 'body', text: 'o e-mail está curto demais' });
  if (bodyWords > 260) problems.push({ field: 'body', text: 'o e-mail está longo demais (máximo de 180 palavras)' });
  if (bodyWords >= 30 && detectLang(body) !== ctx.lang) problems.push({ field: 'body', text: `o e-mail precisa estar em ${LANG_NAME[ctx.lang]}` });
  // without the resume's text (the AI read the PDF) there is nothing to compare the facts against
  const fakeBody = ctx.base ? invented(`${subject}\n${body.replace(ctx.signature || '\u0000', '')}`, ctx.base, ctx.extra) : [];
  // More strict: free models are prone to inventing; report even 1-2 invented items
  if (fakeBody.length >= 1) problems.push({ field: 'body', text: `o e-mail cita o que não está no currículo base (${fakeBody.slice(0, 3).join(', ')}): tire isso`, items: fakeBody });
  if (ctx.resume) {
    const sections = resume.split('\n').filter((l) => l.startsWith('# ')).length;
    if (sections < 2) problems.push({ field: 'resume', text: 'o currículo precisa ter as seções começando com "# " (ex.: "# Experiência")' });
    if (ctx.base.length >= 800 && resume.length < ctx.base.length * 0.35) problems.push({ field: 'resume', text: 'o currículo ficou curto demais: mantenha todas as experiências, com cargo, empresa e datas' });
    if (resume.length > 7000) problems.push({ field: 'resume', text: 'o currículo passou de 7.000 caracteres: resuma os itens das experiências mais antigas' });
    if (placeholders(resume).length) problems.push({ field: 'resume', text: `o currículo tem campos para preencher (${placeholders(resume).join(', ')})` });
    if (words(resume).length >= 80 && detectLang(resume) !== ctx.lang) problems.push({ field: 'resume', text: `o currículo precisa estar em ${LANG_NAME[ctx.lang]}` });
    const fake = ctx.base ? invented(resume, ctx.base, ctx.extra) : [];
    // More strict: free models often invent; any invented facts should trigger a fix
    if (fake.length >= 1) problems.push({ field: 'resume', text: `o currículo cita o que não está no currículo base (${fake.slice(0, 3).join(', ')}): tire isso`, items: fake });
  }
  return { subject, body, resume, problems };
}
