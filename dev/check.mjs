// Runs every test suite, in order, and stops at the first one that fails. Every bug fixed so far has a check in
// one of them (the check's name says what the bug was), so this is what keeps them from coming back: the CI
// runs it on every push (.github/workflows/ci.yml) and only publishes a version when it passes, and the
// pre-push hook (git config core.hooksPath dev/hooks) runs the quick ones before a push leaves the machine.
//
//   node dev/check.mjs [--rapido] [--browser=path-to-browser] [--live]
//   --rapido: skips the real-browser suite (a few minutes); the CI never skips it.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dev = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const quick = args.includes('--rapido');
const SUITES = [
  ['test.mjs', 'API chrome.* simulada: busca, preparação, envio, candidatura no site'],
  ['test-quality.mjs', 'aderência contra notas de recrutadores e conferência do que a IA escreve e responde'],
  ['test-pdf.mjs', 'leitura do PDF do currículo'],
  ...(quick ? [] : [['test-browser.mjs', 'a extensão instalada em um Chrome, Brave ou Edge de verdade']]),
];

const results = [];
const started = Date.now();
for (const [file, what] of SUITES) {
  console.log(`\n━━━ ${file} — ${what}\n`);
  const t0 = Date.now();
  const extra = file === 'test-browser.mjs' ? args.filter((a) => a !== '--rapido') : [];
  const { status } = spawnSync(process.execPath, [path.join(dev, file), ...extra], { stdio: 'inherit' });
  results.push([file, status === 0, Math.round((Date.now() - t0) / 1000)]);
  if (status !== 0) break;
}

console.log('\n━━━ Resumo\n');
for (const [file, ok, s] of results) console.log(`${ok ? 'OK    ' : 'FALHOU'} ${file} (${s} s)`);
const failed = results.some(([, ok]) => !ok);
const skipped = SUITES.length - results.length;
if (skipped) console.log(`       ${skipped} suíte(s) não rodaram por causa da falha acima.`);
if (quick) console.log('       (--rapido: a suíte no navegador de verdade ficou de fora; o CI roda tudo)');
console.log(`\n${failed ? 'Há falhas' : 'Tudo passou'} em ${Math.round((Date.now() - started) / 1000)} s.`);
process.exit(failed ? 1 : 0);
