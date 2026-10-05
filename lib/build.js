// Versão deste código, igual à do manifest.json (dev/test.mjs confere).
//
// O navegador guarda o código de fundo (service worker) em cache e só o troca quando a extensão é
// recarregada na página de extensões; fechar e abrir o navegador não troca. As telas, por outro lado, vêm
// sempre do disco. Por isso o painel compara a versão dele com a que o service worker responde e
// recarrega a extensão quando são diferentes (ui/fresh.js). Mudou código de fundo? Suba a versão aqui e no manifest.
export const BUILD = '0.7.0';
