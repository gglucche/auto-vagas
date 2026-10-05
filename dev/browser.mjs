// Separate browser for the dev/ scripts: the installed Chrome, Brave or Edge, headless and with its own
// profile, with the extension installed the way the "Carregar sem compactação" (Load unpacked) button would.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const DASHBOARD = /^chrome-extension:\/\/[a-p]{32}\/ui\/dashboard\.html/;

// --browser=path picks the browser; without it, the first one installed from this list is used
export const findBrowser = (args) =>
  args.find((a) => a.startsWith('--browser='))?.slice(10) ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/brave-browser',
    '/usr/bin/chromium',
  ].find((p) => fs.existsSync(p));

export function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    setTimeout(() => reject(new Error('conexão de depuração: sem resposta em 10 s')), 10000);
    let n = 0;
    const pending = new Map();
    const events = [];
    // the page may close in the middle of a call (the extension reloads itself): no wait lasts forever
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const id = ++n;
        pending.set(id, { res, rej });
        setTimeout(() => pending.delete(id) && rej(new Error(`${method}: sem resposta em 20 s`)), 20000);
        ws.send(JSON.stringify({ id, method, params }));
      });
    ws.onclose = () => {
      for (const p of pending.values()) p.rej(new Error('a página foi fechada'));
      pending.clear();
    };
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    ws.onopen = () => resolve({ events, send, evaluate, close: () => ws.close() });
    ws.onerror = (e) => reject(new Error('conexão de depuração: ' + (e.message || 'falhou')));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (!m.id) return events.push(m);
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    };
  });
}

// Opens the browser with the given profile. The profile lives in the system temp folder: long paths (over
// 260 characters) keep the browser from starting.
const children = [];
export async function launch(browser, profile, extraArgs = []) {
  const portFile = path.join(profile, 'DevToolsActivePort'); // the browser writes the debugging port it picked here
  fs.rmSync(portFile, { force: true });
  const child = spawn(
    browser,
    [
      '--headless=new', '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profile}`,
      // only the "pipe" connection installs extensions: Chrome no longer accepts --load-extension
      '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
      '--no-first-run', '--no-default-browser-check', '--window-size=1400,1100', ...extraArgs, 'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
  );
  children.push(child);
  for (let i = 0; i < 80 && !fs.existsSync(portFile); i++) await sleep(250);
  if (!fs.existsSync(portFile)) throw new Error('o navegador não abriu: ' + browser);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const api = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, { ...init, signal: AbortSignal.timeout(10000) }).then((r) => r.json());

  // commands over the pipe: JSON messages separated by \0
  let buffer = '';
  let lastId = 0;
  const waiting = new Map();
  child.stdio[4].on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (let i; (i = buffer.indexOf('\0')) >= 0; buffer = buffer.slice(i + 1)) {
      const msg = JSON.parse(buffer.slice(0, i));
      const w = waiting.get(msg.id);
      if (!w) continue;
      waiting.delete(msg.id);
      msg.error ? w.rej(new Error(msg.error.message)) : w.res(msg.result);
    }
  });
  const pipe = (method, params) => {
    const id = ++lastId;
    const answer = new Promise((res, rej) => waiting.set(id, { res, rej }));
    child.stdio[3].write(JSON.stringify({ id, method, params }) + '\0');
    return Promise.race([answer, sleep(20000).then(() => Promise.reject(new Error(`${method}: sem resposta em 20 s`)))]);
  };

  // Installs the extension with developer mode on: without it, the browser disables the extension when it reloads.
  const installUnpacked = async (dir) => {
    const tab = await api('/json/new?chrome://extensions', { method: 'PUT' });
    const settings = await connect(tab.webSocketDebuggerUrl);
    await sleep(1500);
    await settings.evaluate(`new Promise((r) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, r))`);
    settings.close();
    return pipe('Extensions.loadUnpacked', { path: dir });
  };
  // dashboard opened by the extension itself (on install or on update); not = old target to ignore
  const dashboard = async ({ not, wait = 10000 } = {}) => {
    for (const end = Date.now() + wait; Date.now() < end; await sleep(250)) {
      const target = (await api('/json/list').catch(() => [])).find((t) => t.type === 'page' && DASHBOARD.test(t.url) && t.id !== not);
      if (target) return { target, ...(await connect(target.webSocketDebuggerUrl)) };
    }
    return null;
  };
  // closes gracefully, so the browser saves what it has in cache
  const quit = async () => {
    const exited = new Promise((r) => child.once('exit', r));
    const all = await connect((await api('/json/version')).webSocketDebuggerUrl);
    all.send('Browser.close').catch(() => {});
    await Promise.race([exited, sleep(10000)]);
  };
  return { port, api, dashboard, quit, installUnpacked };
}

export function killAll() {
  for (const child of children) {
    try {
      if (process.platform === 'win32') execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
      else child.kill('SIGKILL');
    } catch {}
  }
}
