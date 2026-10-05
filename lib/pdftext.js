// Dependency-free PDF text reader. Covers what resumes use in practice: standalone objects
// or objects in /ObjStm, FlateDecode streams, simple and Type0 fonts with /ToUnicode, text operators and
// Form XObjects. A scanned PDF (image only) yields little or no text; a password-protected PDF throws.
//
//   const { lines, text } = await extractPdfText(bytes)   // lines: [{ page, size, text }]

const latin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
};

// ---------- object syntax ----------

const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const DELIM = '()<>[]{}/%';

function skipWs(s, i) {
  for (;;) {
    const c = s.charCodeAt(i);
    if (c === 37) while (i < s.length && s.charCodeAt(i) !== 10 && s.charCodeAt(i) !== 13) i++; // comment
    else if (isWs(c)) i++;
    else return i;
  }
}

function parseName(s, i) {
  let j = i + 1;
  while (j < s.length && !isWs(s.charCodeAt(j)) && !DELIM.includes(s[j])) j++;
  return [s.slice(i + 1, j).replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), j];
}

function parseLiteral(s, i) {
  let depth = 1;
  let out = '';
  let j = i + 1;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\') {
      const n = s[j + 1];
      if (n >= '0' && n <= '7') {
        let o = n;
        while (o.length < 3 && s[j + 1 + o.length] >= '0' && s[j + 1 + o.length] <= '7') o += s[j + 1 + o.length];
        out += String.fromCharCode(parseInt(o, 8) & 255);
        j += 1 + o.length;
        continue;
      }
      if (n === '\r' && s[j + 2] === '\n') j++; // escaped line break: line continuation
      else if (n !== '\r' && n !== '\n') out += { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[n] ?? n;
      j += 2;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return [{ str: out }, j + 1];
    out += ch;
    j++;
  }
  throw new Error('string sem fim');
}

function parseHex(s, i) {
  const end = s.indexOf('>', i);
  if (end < 0) throw new Error('hex sem fim');
  let hex = s.slice(i + 1, end).replace(/[^0-9A-Fa-f]/g, '');
  if (hex.length % 2) hex += '0';
  let out = '';
  for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.substr(k, 2), 16));
  return [{ str: out }, end + 1];
}

const NUM = /[+-]?(?:\d+\.?\d*|\.\d+)/y;
const REF = /\s+\d+\s+R(?![A-Za-z])/y;

// Returns [value, nextPosition]. Names become '/Name'; strings, { str }; references, { ref }.
function parseValue(s, i, refs) {
  i = skipWs(s, i);
  const c = s[i];
  if (c === '<' && s[i + 1] === '<') {
    const dict = {};
    i += 2;
    for (;;) {
      i = skipWs(s, i);
      if (s[i] === '>' && s[i + 1] === '>') return [dict, i + 2];
      if (s[i] !== '/') throw new Error('dicionário inválido');
      const [key, j] = parseName(s, i);
      const [value, next] = parseValue(s, j, refs);
      dict[key] = value;
      i = next;
    }
  }
  if (c === '[') {
    const arr = [];
    i++;
    for (;;) {
      i = skipWs(s, i);
      if (s[i] === ']') return [arr, i + 1];
      if (i >= s.length) throw new Error('lista sem fim');
      const [value, next] = parseValue(s, i, refs);
      arr.push(value);
      i = next;
    }
  }
  if (c === '/') {
    const [name, j] = parseName(s, i);
    return ['/' + name, j];
  }
  if (c === '(') return parseLiteral(s, i);
  if (c === '<') return parseHex(s, i);
  NUM.lastIndex = i;
  const m = NUM.exec(s);
  if (m) {
    if (refs && /^\d+$/.test(m[0])) {
      REF.lastIndex = NUM.lastIndex;
      if (REF.test(s)) return [{ ref: +m[0] }, REF.lastIndex];
    }
    return [+m[0], NUM.lastIndex];
  }
  for (const [word, value] of [['true', true], ['false', false], ['null', null]]) if (s.startsWith(word, i)) return [value, i + word.length];
  throw new Error('valor inválido');
}

// ---------- text encodings ----------

const CP1252 = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];
const MAC_ROMAN =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

const baseEncoding = (name) =>
  Array.from({ length: 256 }, (_, c) => {
    if (c < 128) return String.fromCharCode(c);
    if (name === '/MacRomanEncoding') return MAC_ROMAN[c - 128];
    return String.fromCharCode(c < 160 ? CP1252[c - 128] : c);
  });

const GLYPHS = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'", parenleft: '(',
  parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', minus: '-', period: '.', slash: '/', zero: '0', one: '1', two: '2',
  three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', colon: ':', semicolon: ';', less: '<', equal: '=',
  greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_',
  grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~', bullet: '•', endash: '–', emdash: '—', quoteleft: '‘',
  quoteright: '’', quotedblleft: '“', quotedblright: '”', quotesinglbase: '‚', quotedblbase: '„', ellipsis: '…', fi: 'fi', fl: 'fl',
  ff: 'ff', ffi: 'ffi', ffl: 'ffl', periodcentered: '·', degree: '°', ordfeminine: 'ª', ordmasculine: 'º', section: '§', copyright: '©',
  registered: '®', trademark: '™', guillemotleft: '«', guillemotright: '»', exclamdown: '¡', questiondown: '¿', Euro: '€', sterling: '£',
  cent: '¢', nbspace: ' ', germandbls: 'ß', ccedilla: 'ç', Ccedilla: 'Ç', aring: 'å', Aring: 'Å', oslash: 'ø', Oslash: 'Ø', ae: 'æ',
  AE: 'Æ', dotlessi: 'ı', multiply: '×', divide: '÷', plusminus: '±', mu: 'µ', paragraph: '¶', dagger: '†', daggerdbl: '‡',
};
const ACCENTS = { grave: '̀', acute: '́', circumflex: '̂', tilde: '̃', dieresis: '̈', caron: '̌' };

function glyphChar(name) {
  if (name.length === 1) return name;
  if (name in GLYPHS) return GLYPHS[name];
  let m = name.match(/^([A-Za-z])(grave|acute|circumflex|tilde|dieresis|caron)$/);
  if (m) return (m[1] + ACCENTS[m[2]]).normalize('NFC');
  m = name.match(/^uni([0-9A-Fa-f]{4})/) || name.match(/^u([0-9A-Fa-f]{4,6})$/);
  return m ? String.fromCodePoint(parseInt(m[1], 16)) : null;
}

const utf16 = (hex) => {
  if (hex.length <= 2) return String.fromCharCode(parseInt(hex || '0', 16));
  let out = '';
  for (let k = 0; k + 3 < hex.length; k += 4) out += String.fromCharCode(parseInt(hex.substr(k, 4), 16));
  return out;
};

// /ToUnicode CMap: font code -> text.
function parseCMap(text) {
  const map = new Map();
  const space = text.match(/begincodespacerange\s*<([0-9A-Fa-f]+)>/);
  const bytes = space ? space[1].length / 2 : 0;
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f\s]*)>/g)) map.set(parseInt(m[1], 16), utf16(m[2].replace(/\s/g, '')));
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]*)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = Math.min(parseInt(m[2], 16), lo + 65535);
      if (m[4] !== undefined) [...m[4].matchAll(/<([0-9A-Fa-f]*)>/g)].forEach((d, k) => map.set(lo + k, utf16(d[1])));
      else {
        const base = utf16(m[3]);
        const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(last + c - lo));
      }
    }
  return { map, bytes };
}

// ---------- matrices ([a b c d e f], PDF convention) ----------

const IDENTITY = [1, 0, 0, 1, 0, 0];
const mul = (A, B) => [
  A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3],
  A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3],
  A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5],
];

async function inflate(data) {
  let error;
  // some generators leave 1 or 2 end-of-line bytes after the compressed data
  for (const trim of [0, 1, 2]) {
    try {
      const stream = new Blob([data.subarray(0, data.length - trim)]).stream().pipeThrough(new DecompressionStream('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      error = e;
    }
  }
  throw error;
}

// ---------- document ----------

export async function extractPdfText(bytes) {
  const s = latin1(bytes);
  const header = s.indexOf('%PDF-');
  if (header < 0 || header > 1024) throw new Error('o arquivo não é um PDF');
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(s)) throw new Error('o PDF está protegido por senha');

  // 1) standalone objects
  const objs = new Map();
  const head = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = head.exec(s))) {
    try {
      const [value, after] = parseValue(s, head.lastIndex, true);
      const obj = { value };
      let i = skipWs(s, after);
      if (s.startsWith('stream', i)) {
        let start = i + 6;
        if (s[start] === '\r') start++;
        if (s[start] === '\n') start++;
        const len = value && typeof value.Length === 'number' ? value.Length : -1;
        let end = len >= 0 && /^\s*endstream/.test(s.substr(start + len, 16)) ? start + len : -1;
        if (end < 0) {
          end = s.indexOf('endstream', start);
          if (end < 0) continue;
          if (s[end - 1] === '\n') end--;
          if (s[end - 1] === '\r') end--;
        }
        obj.stream = [start, end];
        i = end;
      }
      objs.set(+m[1], obj);
      head.lastIndex = i;
    } catch {
      // unreadable object: move on to the next one
    }
  }

  const resolve = (v) => (v && v.ref !== undefined ? objs.get(v.ref)?.value : v);
  const objOf = (v) => (v && v.ref !== undefined ? objs.get(v.ref) : null);

  async function streamBytes(obj) {
    if (!obj?.stream) return null;
    if (obj.data) return obj.data;
    let data = bytes.subarray(obj.stream[0], obj.stream[1]);
    const filter = resolve(obj.value.Filter);
    for (const f of filter == null ? [] : Array.isArray(filter) ? filter : [filter]) {
      const name = resolve(f);
      if (name === '/FlateDecode' || name === '/Fl') data = await inflate(data);
      else throw new Error('compressão não suportada: ' + name);
    }
    return (obj.data = data);
  }

  // 2) objects stored inside /ObjStm (PDF 1.5+)
  for (const obj of [...objs.values()]) {
    if (obj.value?.Type !== '/ObjStm' || !obj.stream) continue;
    try {
      const text = latin1(await streamBytes(obj));
      const first = resolve(obj.value.First);
      const index = text.slice(0, first).trim().split(/\s+/).map(Number);
      for (let k = 0; k + 1 < index.length; k += 2) {
        try {
          if (!objs.has(index[k])) objs.set(index[k], { value: parseValue(text, first + index[k + 1], true)[0] });
        } catch {}
      }
    } catch {}
  }

  // 3) pages, in page-tree order
  const pages = [];
  const seen = new Set();
  const visit = (ref, inherited) => {
    const node = resolve(ref);
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const resources = node.Resources !== undefined ? node.Resources : inherited;
    const kids = resolve(node.Kids);
    if (Array.isArray(kids)) kids.forEach((k) => visit(k, resources));
    else pages.push({ dict: node, resources });
  };
  const catalog = [...objs.values()].map((o) => o.value).find((v) => v && v.Type === '/Catalog');
  if (catalog?.Pages) visit(catalog.Pages);
  if (!pages.length)
    [...objs.entries()].sort((a, b) => a[0] - b[0]).forEach(([, o]) => o.value?.Type === '/Page' && pages.push({ dict: o.value, resources: o.value.Resources }));

  // 4) fonts
  const fontCache = new Map();
  async function loadFont(ref) {
    const key = ref?.ref ?? ref;
    if (fontCache.has(key)) return fontCache.get(key);
    const d = resolve(ref) || {};
    const font = { two: d.Subtype === '/Type0', map: null, enc: null, w: new Map(), dw: 1000 };
    try {
      const cmap = objOf(d.ToUnicode);
      if (cmap?.stream) {
        const parsed = parseCMap(latin1(await streamBytes(cmap)));
        font.map = parsed.map;
        if (font.two && parsed.bytes === 1) font.two = false;
      }
    } catch {}
    if (font.two) {
      const desc = resolve((resolve(d.DescendantFonts) || [])[0]) || {};
      if (typeof resolve(desc.DW) === 'number') font.dw = resolve(desc.DW);
      const W = resolve(desc.W);
      for (let i = 0; Array.isArray(W) && i < W.length; ) {
        const first = W[i];
        const next = resolve(W[i + 1]);
        if (Array.isArray(next)) {
          next.forEach((w, k) => font.w.set(first + k, w));
          i += 2;
        } else {
          for (let c = first; c <= next && c - first < 70000; c++) font.w.set(c, W[i + 2]);
          i += 3;
        }
      }
    } else {
      const enc = resolve(d.Encoding);
      font.enc = baseEncoding(typeof enc === 'string' ? enc : resolve(enc?.BaseEncoding));
      let code = 0;
      for (const item of resolve(enc?.Differences) || []) {
        if (typeof item === 'number') code = item;
        else if (typeof item === 'string') {
          const ch = glyphChar(item.slice(1));
          if (ch != null) font.enc[code] = ch;
          code++;
        }
      }
      const widths = resolve(d.Widths);
      const first = resolve(d.FirstChar) || 0;
      if (Array.isArray(widths)) widths.forEach((w, k) => font.w.set(first + k, resolve(w)));
      font.dw = Array.isArray(widths) ? resolve(resolve(d.FontDescriptor)?.MissingWidth) || 500 : 520; // standard font with no width table: use an average
    }
    fontCache.set(key, font);
    return font;
  }

  async function loadFonts(resources) {
    const fonts = {};
    for (const [name, ref] of Object.entries(resolve(resolve(resources)?.Font) || {})) fonts[name] = await loadFont(ref);
    return fonts;
  }

  // 5) content interpretation: produces text runs with position and size
  const runs = [];
  async function run(text, fonts, xobjects, ctm, page, depth) {
    const stack = [];
    const args = [];
    let tm = IDENTITY;
    let tlm = IDENTITY;
    let leading = 0;
    let font = null;
    let size = 0;

    const show = (v) => {
      if (!font || !v || v.str === undefined) return;
      const str = v.str;
      const step = font.two ? 2 : 1;
      let out = '';
      let width = 0;
      for (let k = 0; k + step <= str.length; k += step) {
        const code = step === 2 ? (str.charCodeAt(k) << 8) | str.charCodeAt(k + 1) : str.charCodeAt(k);
        out += font.map?.get(code) ?? (font.enc ? font.enc[code] : '');
        width += font.w.get(code) ?? font.dw;
      }
      const advance = (width / 1000) * size;
      const mx = mul(tm, ctm);
      const scale = Math.sqrt(Math.abs(mx[0] * mx[3] - mx[1] * mx[2])) || 1;
      runs.push({ page, x: mx[4], y: mx[5], w: advance * Math.hypot(mx[0], mx[1]), size: Math.abs(size) * scale, text: out });
      tm = mul([1, 0, 0, 1, advance, 0], tm);
    };
    const newLine = (tx, ty) => {
      tlm = mul([1, 0, 0, 1, tx, ty], tlm);
      tm = tlm;
    };

    let i = 0;
    while (i < text.length) {
      i = skipWs(text, i);
      if (i >= text.length) break;
      if (!/[A-Za-z'"]/.test(text[i])) {
        try {
          const [value, next] = parseValue(text, i, false);
          args.push(value);
          i = next;
        } catch {
          i++;
        }
        continue;
      }
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9*]/.test(text[j])) j++;
      const op = text.slice(i, j);
      i = j;
      const n = args.length;
      if (op === 'q') stack.push(ctm);
      else if (op === 'Q') ctm = stack.pop() || ctm;
      else if (op === 'cm' && n >= 6) ctm = mul(args.slice(-6), ctm);
      else if (op === 'BT') tm = tlm = IDENTITY;
      else if (op === 'Tf' && n >= 2) {
        font = fonts[String(args[n - 2]).slice(1)] || null;
        size = args[n - 1];
      } else if (op === 'TL') leading = args[n - 1];
      else if (op === 'Td' && n >= 2) newLine(args[n - 2], args[n - 1]);
      else if (op === 'TD' && n >= 2) {
        leading = -args[n - 1];
        newLine(args[n - 2], args[n - 1]);
      } else if (op === 'Tm' && n >= 6) tm = tlm = args.slice(-6);
      else if (op === 'T*') newLine(0, -leading);
      else if (op === 'Tj') show(args[n - 1]);
      else if (op === "'" || op === '"') {
        newLine(0, -leading);
        show(args[n - 1]);
      } else if (op === 'TJ') {
        for (const el of Array.isArray(args[n - 1]) ? args[n - 1] : []) {
          if (typeof el === 'number') tm = mul([1, 0, 0, 1, (-el / 1000) * size, 0], tm);
          else show(el);
        }
      } else if (op === 'Do' && depth < 6) {
        const form = objOf(xobjects?.[String(args[n - 1]).slice(1)]);
        if (form?.value?.Subtype === '/Form' && form.stream) {
          try {
            const res = resolve(form.value.Resources);
            const matrix = resolve(form.value.Matrix);
            await run(
              latin1(await streamBytes(form)),
              res ? { ...fonts, ...(await loadFonts(res)) } : fonts,
              res ? resolve(res.XObject) || {} : xobjects,
              Array.isArray(matrix) && matrix.length === 6 ? mul(matrix, ctm) : ctm,
              page,
              depth + 1
            );
          } catch {}
        }
      } else if (op === 'ID') {
        // inline image: skip the binary data up to EI
        let end = text.indexOf('EI', i);
        while (end >= 0 && !(isWs(text.charCodeAt(end - 1)) && (end + 2 >= text.length || isWs(text.charCodeAt(end + 2))))) end = text.indexOf('EI', end + 2);
        i = end < 0 ? text.length : end + 2;
      }
      args.length = 0;
    }
  }

  for (const [index, page] of pages.entries()) {
    try {
      const contents = resolve(page.dict.Contents);
      const parts = [];
      for (const ref of Array.isArray(contents) ? contents : [page.dict.Contents]) {
        const data = await streamBytes(objOf(ref));
        if (data) parts.push(latin1(data));
      }
      const resources = resolve(page.resources) || {};
      await run(parts.join('\n'), await loadFonts(resources), resolve(resources.XObject) || {}, IDENTITY, index + 1, 0);
    } catch {
      // unreadable page: the others still count
    }
  }

  // 6) join the runs into lines, in the order the PDF draws them
  const lines = [];
  let cur = null;
  for (const r of runs) {
    if (!r.text) continue;
    const same = cur && cur.page === r.page && Math.abs(r.y - cur.y) < 0.45 * Math.max(r.size, cur.size) && r.x >= cur.x0 - 1;
    if (same) {
      if (r.x - cur.end > 0.18 * r.size && !/\s$/.test(cur.text) && !/^\s/.test(r.text)) cur.text += ' ';
      cur.text += r.text;
      cur.end = Math.max(cur.end, r.x + r.w);
      cur.size = Math.max(cur.size, r.size);
    } else {
      if (cur) lines.push(cur);
      cur = { page: r.page, y: r.y, x0: r.x, end: r.x + r.w, size: r.size, text: r.text };
    }
  }
  if (cur) lines.push(cur);

  const clean = lines
    .map((l) => ({ page: l.page, size: Math.round(l.size * 10) / 10, text: l.text.replace(/\s+/g, ' ').trim() }))
    .filter((l) => l.text && !/^(page|p[aá]gina)\s+\d+\s+(of|de)\s+\d+$/i.test(l.text));
  return { lines: clean, text: clean.map((l) => l.text).join('\n') };
}
