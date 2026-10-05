const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

export const redirectUri = () => chrome.identity.getRedirectURL();

// Problema de login ou de configuração: não é culpa de nenhuma vaga, então a fila espera em vez de marcar erro.
const setupError = (message) => Object.assign(new Error(message), { setup: true });
const disconnected = () => setupError('Gmail desconectado — clique em "Conectar Gmail" no painel.');

function checkClientId(clientId) {
  clientId = (clientId || '').trim();
  if (!clientId) throw setupError('Configure o ID do cliente OAuth do Google nas Configurações.');
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId))
    throw setupError('O ID do cliente deve terminar em “.apps.googleusercontent.com”. Confira se você colou o ID do cliente, e não a chave secreta.');
  return clientId;
}

function authUrl(clientId, { silent, hint } = {}) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('scope', SCOPE);
  if (hint) url.searchParams.set('login_hint', hint);
  if (silent) url.searchParams.set('prompt', 'none');
  return url.toString();
}

// Com mais de uma conta logada no navegador, o Google precisa saber qual usar. Só dá para indicar
// quando o e-mail do usuário é claramente uma conta Google.
const accountHint = (email) => (/^[^@\s]+@(gmail|googlemail)\.com$/i.test((email || '').trim()) ? email.trim() : '');

// O Google só mostra erro de configuração dentro da janela de login, em uma página que não devolve nada
// para a extensão. A mesma página responde sem login, então dá para perguntar antes de abrir a janela.
// Devolve a explicação do problema, ou null se o Google aceita a configuração (ou não respondeu).
export async function configProblem(clientId) {
  let page;
  try {
    const res = await fetch(authUrl(clientId), { credentials: 'omit', signal: AbortSignal.timeout(8000) });
    res.body?.cancel().catch(() => {});
    page = new URL(res.url);
  } catch {
    return null;
  }
  if (!page.pathname.includes('/oauth/error')) return null;

  // authError é um pacote binário em base64 que começa pelo código do erro
  let code = '';
  try {
    const raw = decodeURIComponent(/[?&]authError=([^&]+)/.exec(page.search)?.[1] || '');
    code = atob(raw.replace(/-/g, '+').replace(/_/g, '/').slice(0, 64)).match(/[a-z]+(?:_[a-z]+)+/)?.[0] || '';
  } catch {}

  if (code === 'redirect_uri_mismatch')
    return (
      `O Google ainda não conhece o endereço desta extensão. No Google Cloud, abra Clientes → o seu cliente OAuth e, em ` +
      `“URIs de redirecionamento autorizados”, clique em “Adicionar URI”, cole ${redirectUri()} e salve. Pode levar alguns minutos para valer.`
    );
  if (code === 'invalid_client' || code === 'deleted_client')
    return 'O Google não encontrou este ID do cliente. Copie de novo o “ID do cliente” em Google Cloud → Clientes: ele pode ter sido colado incompleto, ou o cliente foi excluído.';
  return `O Google recusou a configuração do login (${code || 'erro não identificado'}). Confira o cliente OAuth em Google Cloud → Clientes.`;
}

// Login sem janela: espera até 8 s pela resposta, que pode vir por script depois de a página carregar
// (o padrão do navegador é desistir assim que a página carrega).
export const SILENT_FLOW = { interactive: false, abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 8000 };

// Passa pelo login do Google, com janela ou em silêncio. Devolve { token } ou { error }, em que error é
// o código devolvido pelo Google ("access_denied", "interaction_required"…), 'login_open' se já existe
// uma janela de login aberta, ou '' se o Google nem respondeu (detail traz o motivo dado pelo navegador).
async function authorize(clientId, { silent = false, hint = '' } = {}) {
  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({ url: authUrl(clientId, { silent, hint }), ...(silent ? SILENT_FLOW : { interactive: true }) });
  } catch (e) {
    // O navegador mantém uma janela de login por vez; a silenciosa não é afetada.
    return /only one web auth flow/i.test(e?.message || '') ? { error: 'login_open' } : { error: '', detail: e?.message || '' };
  }
  const back = new URL(redirect);
  const params = new URLSearchParams(back.hash.slice(1));
  const token = params.get('access_token');
  if (!token) return { error: params.get('error') || back.searchParams.get('error') || 'sem token' };
  const exp = Date.now() + Number(params.get('expires_in') || 3600) * 1000;
  await chrome.storage.local.set({ gmailToken: { token, exp } });
  return { token };
}

// Renova o token sem abrir janela: funciona enquanto o navegador estiver logado no Google e o acesso
// continuar concedido. Sem isso, esquece o token para o painel mostrar que é preciso conectar de novo.
async function renew(clientId, email) {
  const hint = accountHint(email);
  for (const h of hint ? [hint, ''] : ['']) {
    const r = await authorize(clientId, { silent: true, hint: h });
    if (r.token) return r.token;
    if (!r.error) break; // o Google nem respondeu: tentar sem indicar a conta não muda nada
  }
  await chrome.storage.local.remove('gmailToken');
  return null;
}

const LOGIN_OPEN =
  'Já existe uma janela de login do Google aberta, de uma tentativa anterior (ela pode estar atrás desta). Conclua o login nela ou feche-a, e clique em ' +
  'Conectar Gmail de novo. Se não encontrar a janela, recarregue a extensão na página de extensões do navegador.';

// Login com a janela do Google. Passa por ele mesmo com token válido: é assim que se troca de conta.
export async function connectGmail(clientId, email) {
  clientId = checkClientId(clientId);
  const problem = await configProblem(clientId);
  if (problem) throw setupError(problem);
  const r = await authorize(clientId, { hint: accountHint(email) });
  if (r.token) return r.token;
  if (r.error === 'login_open') throw setupError(LOGIN_OPEN);
  if (r.error === 'access_denied') throw setupError('Você cancelou o acesso na tela do Google. Clique em Conectar Gmail de novo e permita o envio de e-mails.');
  if (r.error) throw setupError(`O Google não liberou o acesso (${r.error}).`);
  if (/could not be loaded/i.test(r.detail)) throw setupError('A página de login do Google não carregou. Confira a conexão com a internet e tente de novo.');
  // Erro mostrado pelo Google na própria janela: aqui só chega que ela foi fechada.
  if (/did not approve/i.test(r.detail))
    throw setupError(
      'Login do Gmail não concluído. Se o Google mostrou “Erro 403: access_denied”, o app está em modo de teste e falta ' +
        'adicionar o seu e-mail em Google Cloud → Público-alvo → Usuários de teste (ou clicar em “Publicar app”).'
    );
  throw setupError(`Login do Gmail não concluído${r.detail ? `: ${r.detail}` : '.'}`);
}

// Token OAuth do Gmail (fluxo implícito, vale 1 hora). Só abre a janela de login se interactive=true.
// email é o endereço do usuário, para o Google escolher a conta certa.
export async function getToken(clientId, interactive, email) {
  clientId = checkClientId(clientId);
  const { gmailToken } = await chrome.storage.local.get('gmailToken');
  if (gmailToken && gmailToken.exp > Date.now() + 60_000) return gmailToken.token;
  // Sem janela, ou já conectado antes: renova em silêncio.
  if (!interactive || gmailToken) {
    const token = await renew(clientId, email);
    if (token) return token;
    if (!interactive) throw disconnected();
  }
  return connectGmail(clientId, email);
}

function utf8B64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const fold = (b64) => b64.replace(/.{76}/g, '$&\r\n');
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${utf8B64(s)}?=`);

export async function sendEmail(token, { to, subject, body, attachment, threadId }) {
  const boundary = 'autovagas_' + Math.random().toString(36).slice(2);
  const mime = [
    `To: ${to}`,
    `Subject: ${encWord(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    fold(utf8B64(body)),
    ...(attachment
      ? [
          `--${boundary}`,
          `Content-Type: application/pdf; name="${encWord(attachment.name)}"`,
          `Content-Disposition: attachment; filename="${encWord(attachment.name)}"`,
          'Content-Transfer-Encoding: base64',
          '',
          fold(attachment.b64),
        ]
      : []),
    `--${boundary}--`,
    '',
  ].join('\r\n');

  const raw = btoa(mime).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
  });
  if (res.status === 401) {
    await chrome.storage.local.remove('gmailToken');
    throw disconnected();
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const message = data?.error?.message || res.statusText;
    if (res.status === 403 && /has not been used|is disabled/i.test(message))
      throw setupError('A Gmail API não está ativada no seu projeto do Google Cloud. Ative-a (passo 3 das Configurações, item 1) e tente de novo em um minuto.');
    throw new Error(`Gmail (${res.status}): ${message}`);
  }
  return res.json(); // { id, threadId }
}
