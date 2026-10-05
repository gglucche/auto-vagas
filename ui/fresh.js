import { BUILD } from '../lib/build.js';

// Garante que o código de fundo é o mesmo desta tela (ver lib/build.js). Devolve:
//   { ok: true, updatedFrom }  fundo em dia; updatedFrom vem preenchido logo depois de uma atualização automática
//   { ok: false }              a recarga automática já foi tentada há pouco e não resolveu
// Se o fundo é de outra versão, recarrega a extensão — a tela fecha e o painel reabre sozinho.
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
