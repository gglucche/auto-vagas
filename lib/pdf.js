// Minimal PDF generator (text, Helvetica, A4) for the resume tailored by the AI.
// Input format: 1st line = name; "# " = section heading; "- " = item.

// Helvetica widths for ASCII 32..126 (in units of 1/1000 em).
const W =
  '278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584'
    .split(' ')
    .map(Number);

const WINANSI = { 0x20ac: 0x80, 0x2026: 0x85, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97 };

function toBytes(str) {
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c >= 0x20 && c <= 0x7e) out.push(c);
    else if (c >= 0xa0 && c <= 0xff) out.push(c);
    else if (WINANSI[c]) out.push(WINANSI[c]);
    else if (c === 0x09) out.push(0x20);
    // any other characters (emoji etc.) are dropped
  }
  return out;
}

// Width of the characters outside ASCII (WinAnsi): the em dash and the ellipsis are much wider
// than average, and without this, lines with several em dashes run past the margin.
function wideWidth(b) {
  if (b === 0x97 || b === 0x85) return 1000; // — …
  if (b === 0x95) return 350; // •
  if (b === 0x91 || b === 0x92) return 222; // ‘ ’
  if (b === 0x93 || b === 0x94) return 333; // “ ”
  if (b === 0xa0 || b === 0xb7) return 278; // non-breaking space, ·
  if ((b >= 0xc0 && b <= 0xc5) || (b >= 0xc8 && b <= 0xcb)) return 667; // À-Å È-Ë
  if (b === 0xc7 || b === 0xd1 || (b >= 0xd9 && b <= 0xdc)) return 722; // Ç Ñ Ù-Ü
  if (b >= 0xd2 && b <= 0xd6) return 778; // Ò-Ö
  if ((b >= 0xcc && b <= 0xcf) || (b >= 0xec && b <= 0xef)) return 278; // Ì-Ï ì-ï
  if (b === 0xe7) return 500; // ç
  return 556; // à-å è-ë ñ ò-ö ù-ü – and the rest
}

function width(bytes, size, bold) {
  let w = 0;
  for (const b of bytes) w += b >= 32 && b <= 126 ? W[b - 32] : wideWidth(b);
  return (w / 1000) * size * (bold ? 1.07 : 1);
}

const hex = (bytes) => '<' + bytes.map((b) => b.toString(16).padStart(2, '0')).join('') + '>';

function wrap(text, size, bold, maxW) {
  const lines = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const test = cur ? cur + ' ' + word : word;
    if (cur && width(toBytes(test), size, bold) > maxW) {
      lines.push(cur);
      cur = word;
    } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}

export function textToPdf(text) {
  const PW = 595, PH = 842, M = 50, CW = PW - 2 * M;
  const pages = [[]];
  let y = PH - M;
  const need = (h) => {
    if (y - h < M) {
      pages.push([]);
      y = PH - M;
    }
  };
  const put = (str, x, size, bold) => {
    pages[pages.length - 1].push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${y.toFixed(1)} Td ${hex(toBytes(str))} Tj ET`);
  };

  let first = true;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) {
      y -= 6;
      continue;
    }
    if (first) {
      first = false;
      need(22);
      y -= 16;
      put(line.replace(/^#\s*/, ''), M, 16, true);
      y -= 8;
    } else if (line.startsWith('#')) {
      need(40);
      y -= 20;
      put(line.replace(/^#+\s*/, '').toUpperCase(), M, 11, true);
      y -= 4;
      pages[pages.length - 1].push(`0.6 G 0.5 w ${M} ${y.toFixed(1)} m ${PW - M} ${y.toFixed(1)} l S`);
      y -= 4;
    } else {
      const bullet = /^[-•*]\s+/.test(line);
      const body = bullet ? line.replace(/^[-•*]\s+/, '') : line;
      const indent = bullet ? 12 : 0;
      wrap(body, 10, false, CW - indent).forEach((l, i) => {
        need(14);
        y -= 14;
        if (bullet && i === 0) put('•', M, 10, false);
        put(l, M + indent, 10, false);
      });
    }
  }

  // Build the file (ASCII only, so offset in characters = offset in bytes).
  const objs = [];
  const fontIds = [3, 4];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  const kids = [];
  pages.forEach((ops) => {
    const stream = ops.join('\n');
    const contentId = objs.length;
    objs[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    const pageId = objs.length;
    objs[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Contents ${contentId} 0 R ` +
      `/Resources << /Font << /F1 ${fontIds[0]} 0 R /F2 ${fontIds[1]} 0 R >> >> >>`;
    kids.push(`${pageId} 0 R`);
  });
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out; // ASCII string
}

export const pdfToB64 = (pdfString) => btoa(pdfString);
