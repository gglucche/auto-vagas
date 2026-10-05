import { BUILD } from '../lib/build.js';

// Ensures the background code is the same version as this page (see lib/build.js). Returns:
//   { ok: true, updatedFrom }  background up to date; updatedFrom is set right after an automatic update
//   { ok: false }              the automatic reload was already tried recently and didn't fix it
// If the background's version differs, reloads the extension — the page closes and the dashboard reopens by itself.
export async function freshBackground() {
  const res = await chrome.runtime.sendMessage({ type: 'version' }).catch(() => null);
  const { autoReload } = await chrome.storage.local.get('autoReload');
  if (res?.build === BUILD) {
    if (autoReload) await chrome.storage.local.remove('autoReload');
    return { ok: true, updatedFrom: autoReload ? autoReload.from || 'anterior' : null };
  }
  if (autoReload?.to === BUILD && Date.now() - autoReload.at < 10 * 60e3) return { ok: false };
  await chrome.storage.local.set({ autoReload: { to: BUILD, from: res?.build || '', at: Date.now() } });
  chrome.runtime.reload();
  return new Promise(() => {});
}

export const STALE_HELP = 'O código de fundo da extensão está desatualizado. Abra a página de extensões do navegador (brave://extensions ou chrome://extensions) e clique em ↻ no cartão da Auto Vagas.';
