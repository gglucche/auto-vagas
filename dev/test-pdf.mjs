// Tests the PDF reader (lib/pdftext.js) and the profile autofill (lib/profile.js).
// The PDFs are built right here, each one exercising a different way of storing text.
//
//   node dev/test-pdf.mjs [resume.pdf]     (with a real PDF, shows what would be filled in)
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const { extractPdfText } = await mod('lib/pdftext.js');
const { profileFromResume } = await mod('lib/profile.js');
const { textToPdf } = await mod('lib/pdf.js');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(ok ? 'OK    ' : 'FALHOU', name, ok ? '' : detail);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bin = (s) => Buffer.from(s, 'latin1');
const flate = (s) => zlib.deflateSync(bin(s));

// objects: [{ num, dict, stream? }] — no xref table, which the reader does not use
function build(objects, header = '%PDF-1.5\n') {
  const parts = [bin(header)];
  for (const o of objects) {
    parts.push(bin(`${o.num} 0 obj\n`));
    if (o.stream) parts.push(bin(`<< ${o.dict} /Length ${o.stream.length} >>\nstream\n`), o.stream, bin('\nendstream'));
    else parts.push(bin(o.dict));
    parts.push(bin('\nendobj\n'));
  }
  return new Uint8Array(Buffer.concat(parts));
}
const texts = async (pdf) => (await extractPdfText(pdf)).lines.map((l) => l.text);

// 1) Simple font with /Differences and /Widths; spaces only by position (LaTeX style); inherited resources; two streams
const widths = Array(224).fill(500).join(' ');
const simple = build([
  { num: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
  { num: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 5 0 R >> >> >>' },
  { num: 3, dict: '<< /Type /Page /Parent 2 0 R /Contents [4 0 R 9 0 R] >>' },
  {
    num: 4, dict: '',
    stream: bin(
      'BT /F1 20 Tf 72 760 Td [(Jo) -15 (\\343o) -280 (da) -280 (Silva)] TJ ET\n' +
        'BT /F1 10 Tf 72 730 Td (Desenvolvedor) Tj 68.5 0 Td (Web) Tj ET\n' +
        'BT /F1 10 Tf 1 0 0 1 72 700 Tm (Ora) Tj 15.05 0 Td (cle) Tj ET\n'
    ),
  },
  {
    num: 5,
    dict: `<< /Type /Font /Subtype /Type1 /BaseFont /Teste /FirstChar 32 /LastChar 255 /Widths [${widths}]
      /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [1 /ccedilla /atilde /fi 4 /uni00E9] >> >>`,
  },
  {
    num: 9, dict: '',
    stream: bin(
      'BT /F1 10 Tf 12 TL 72 680 Td (Linha um \\(com par\\352nteses\\)) Tj (Linha dois) \' T* (Gra\\001a, n\\002o, \\003m, caf\\004) Tj ET\n' +
        'BI /W 2 /H 2 /BPC 8 /CS /G ID \x00(\xff) EI\nBT /F1 10 Tf 72 620 Td (Depois da imagem) Tj ET\n'
    ),
  },
]);
check('fonte simples: acentos, kerning, espaços por posição, aspas simples, T*, imagem embutida',
  same(await texts(simple), ['João da Silva', 'Desenvolvedor Web', 'Oracle', 'Linha um (com parênteses)', 'Linha dois', 'Graça, não, fim, café', 'Depois da imagem']),
  JSON.stringify(await texts(simple)));

// 2) Type0 font with compressed /ToUnicode, objects inside /ObjStm, Form XObject, two pages, footer
const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
3 beginbfchar <0001> <0041> <0002> <00E7> <0003> <00660069> endbfchar
2 beginbfrange <0010> <0012> <0061> <0020> <0021> [<0058> <0059>] endbfrange
endcmap end end`;
const inside = [
  [1, '<< /Type /Catalog /Pages 2 0 R >>'],
  [2, '<< /Type /Pages /Kids [3 0 R 13 0 R] /Count 2 >>'],
  [3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F2 6 0 R /F1 8 0 R >> /XObject << /Fm1 10 0 R >> >> >>'],
  [6, '<< /Type /Font /Subtype /Type0 /BaseFont /Sub+Fonte /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 11 0 R >>'],
  [7, '<< /Type /Font /Subtype /CIDFontType2 /DW 1000 /W [1 [500 500 500] 16 33 600] >>'],
  [8, '<< /Type /Font /Subtype /TrueType /BaseFont /Arial /Encoding /WinAnsiEncoding >>'],
  [13, '<< /Type /Page /Parent 2 0 R /Contents 14 0 R /Resources << /Font << /F1 8 0 R >> >> >>'],
];
let body = '';
const index = inside.map(([num, text]) => {
  const at = body.length;
  body += text + '\n';
  return `${num} ${at}`;
}).join(' ') + '\n';
const packed = build([
  { num: 20, dict: `/Type /ObjStm /N ${inside.length} /First ${index.length} /Filter /FlateDecode`, stream: flate(index + body) },
  {
    num: 4, dict: '/Filter /FlateDecode',
    stream: flate('q 1 0 0 1 0 0 cm BT /F2 12 Tf 72 700 Td <000100020003> Tj [<0010> -400 <00110012>] TJ ET Q\n/Fm1 Do\nBT /F1 9 Tf 72 40 Td (P\\341gina 1 de 2) Tj ET'),
  },
  { num: 10, dict: '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [1 0 0 1 72 600] /Resources << /Font << /F2 6 0 R >> >>', stream: bin('BT /F2 12 Tf 0 0 Td <00200021> Tj ET') },
  { num: 11, dict: '/Filter [/FlateDecode]', stream: flate(cmap) },
  { num: 14, dict: '', stream: bin('BT /F1 11 Tf 72 700 Td (Segunda p\\341gina) Tj ET') },
]);
const packedOut = await extractPdfText(packed);
check('Type0 + ToUnicode (bfchar, bfrange, lista), ObjStm, Flate, Form XObject, rodapé removido',
  same(packedOut.lines.map((l) => `${l.page}:${l.text}`), ['1:Açfia bc', '1:XY', '2:Segunda página']), JSON.stringify(packedOut.lines));

// 3) PDF generated by the extension itself (standard font, hex strings, no /Widths)
const own = await extractPdfText(Uint8Array.from(bin(textToPdf('Fulano de Tal\nfulano@exemplo.com\n# Experiência\n- Desenvolveu integrações — Oracle APEX e PL/SQL'))));
check('PDF gerado pela extensão é lido de volta', same(own.lines.map((l) => l.text), ['Fulano de Tal', 'fulano@exemplo.com', 'EXPERIÊNCIA', '• Desenvolveu integrações — Oracle APEX e PL/SQL']), JSON.stringify(own.lines));
check('tamanho da fonte acompanha cada linha', own.lines[0].size === 16 && own.lines[1].size === 10, JSON.stringify(own.lines.map((l) => l.size)));

// 4) files that cannot be read
const fails = async (bytes) => extractPdfText(bytes).then(() => '', (e) => e.message);
check('arquivo que não é PDF dá erro claro', /não é um PDF/.test(await fails(Uint8Array.from(bin('PK\x03\x04 isto é um zip')))));
check('PDF com senha dá erro claro', /senha/.test(await fails(Uint8Array.from(bin('%PDF-1.4\ntrailer << /Root 1 0 R /Encrypt 9 0 R >>')))));

// 5) profile: resume in Portuguese, name in capitals, city on the contact line
const L = (text, size = 11) => ({ page: 1, size, text });
const pt = profileFromResume([
  L('MARIANA DE SOUZA ARAÚJO', 30), L('Desenvolvedora Full Stack Sênior — React, Node.js e AWS', 15),
  L('Belo Horizonte, MG · mariana.araujo@exemplo.com.br · (31) 98888-7777', 15),
  L('HABILIDADES', 15), L('React'), L('Node.js'), L('TypeScript'), L('PostgreSQL'), L('Docker'), L('Testes automatizados'),
  L('IDIOMAS', 15), L('Inglês avançado'), L('Espanhol básico'),
  L('RESUMO', 15), L('Mais de 9 anos criando aplicações web. Experiência com microsserviços, integração contínua (CI/CD) e'),
  L('gestão de equipes ágeis.'),
  L('EXPERIÊNCIA PROFISSIONAL', 15), L('Desenvolvedora Full Stack Sênior'), L('Empresa Ação & Cia · 2021 – atual'),
  L('Liderança técnica de um time de 6 pessoas.'), L('Migração para AWS com Terraform e Kubernetes.'),
  L('Analista de Sistemas Pleno'), L('Banco Exemplo · 2017 – 2021'), L('APIs REST em Java e Spring Boot.'),
  L('FORMAÇÃO ACADÊMICA', 15), L('Bacharelado em Ciência da Computação — UFMG (2012 – 2016)'),
]);
check('perfil PT: nome em maiúsculas vira nome próprio', pt.name === 'Mariana de Souza Araújo', pt.name);
check('perfil PT: e-mail e cidade na mesma linha', pt.email === 'mariana.araujo@exemplo.com.br' && pt.location === 'Belo Horizonte, MG', JSON.stringify([pt.email, pt.location]));
check('perfil PT: habilidades da seção vêm primeiro, depois as citadas no texto',
  pt.skills.startsWith('React, Node.js, TypeScript, PostgreSQL, Docker, Testes automatizados') && /AWS/.test(pt.skills) && /Kubernetes/.test(pt.skills) && /Spring Boot/.test(pt.skills), pt.skills);
check('perfil PT: buscas são os cargos, sem repetir', pt.keywords === 'Desenvolvedora Full Stack Sênior\nAnalista de Sistemas Pleno', JSON.stringify(pt.keywords));

// 6) profile: English resume of someone based in Brazil — job titles become searches in Portuguese
const en = profileFromResume([
  L('Contact', 13), L('john@doe.dev'), L('Top Skills', 13), L('Python'), L('Django'),
  L('John Doe', 26), L('Backend Engineer | Python | Open source'), L('Curitiba, Paraná, Brazil'),
  L('Experience', 16), L('Acme Inc.'), L('Senior Backend Engineer'), L('January 2022 - Present (2 years)'), L('Built REST APIs with Django and PostgreSQL.'),
  L('Data & Analytics Analyst'), L('2019 - 2021'), L('Education', 16), L('UFPR'),
]);
check('perfil EN: nome é o maior texto, mesmo depois da barra lateral', en.name === 'John Doe' && en.location === 'Curitiba, Paraná, Brazil', JSON.stringify([en.name, en.location]));
check('perfil EN no Brasil: cargos traduzidos para a busca', en.keywords === 'Engenheiro Backend\nEngenheiro Backend Sênior\nAnalista Data e Analytics', JSON.stringify(en.keywords));
check('perfil EN: "Python, Django" da seção e o resto do texto', en.skills.startsWith('Python, Django') && /PostgreSQL/.test(en.skills) && /REST/.test(en.skills), en.skills);

// 6b) a headline with two job titles becomes two searches, without mixing them together
const dois = profileFromResume([
  L('Pedro Henrique Costa', 26), L('Oracle Consultant & Senior APEX Developer | Low-code'), L('Sorocaba, São Paulo, Brazil'),
  L('Experience', 16), L('Senior Apex Developer'), L('Oracle Consultant'), L('Oracle Developer'), L('Education', 16),
]);
check('perfil: dois cargos na apresentação viram duas buscas', dois.keywords === 'Consultor Oracle\nDesenvolvedor APEX Sênior\nDesenvolvedor Oracle', JSON.stringify(dois.keywords));

// 7) profile: the job title only appears in the middle of a sentence
const frase = profileFromResume([
  L('Ana Beatriz Lima', 16), L('ana.lima@exemplo.com · Recife, PE'), L('EXPERIÊNCIA', 11),
  L('• Analista de Dados Pleno na Empresa X: Power BI, SQL Server e Python para relatórios gerenciais.'),
  L('• Antes disso, worked as Senior Data Engineer at Acme, building pipelines.'), L('FORMAÇÃO', 11), L('• Estatística, UFPE'),
]);
check('perfil: cargo no meio da frase vira busca', frase.keywords === 'Analista de Dados Pleno\nEngenheiro Data Sênior', JSON.stringify(frase.keywords));

if (process.argv[2]) {
  const real = await extractPdfText(new Uint8Array(fs.readFileSync(process.argv[2])));
  const p = profileFromResume(real.lines);
  console.log(`\nPDF real: ${real.lines.length} linhas, ${real.text.length} caracteres`);
  console.log({ ...p, resumeText: `(${p.resumeText.length} caracteres)` });
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} de ${results.length} verificações passaram.`);
process.exit(failed ? 1 : 0);
