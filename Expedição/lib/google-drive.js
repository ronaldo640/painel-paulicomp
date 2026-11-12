// Acesso de leitura ao Google Drive por conta de serviço (sem dependências).
//
// A conta de serviço é um "usuário técnico" do Google: a planilha é
// compartilhada com o e-mail dela como LEITOR, e esta função baixa o arquivo.
// Escopo drive.readonly: mesmo que alguém dê permissão de edição por engano,
// este código não consegue alterar nada.
//
// Variável de ambiente na Vercel:
//   GOOGLE_SERVICE_ACCOUNT_JSON  conteúdo inteiro do arquivo .json da chave
//                                (pode ser colado como está, ou em base64)

import crypto from 'node:crypto';

const ESCOPO = 'https://www.googleapis.com/auth/drive.readonly';
let tokenEmCache = null; // { token, expira } — reaproveitado enquanto a função estiver quente

function lerCredenciais() {
  const bruto = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!bruto) return null;
  let texto = bruto.trim();
  if (!texto.startsWith('{')) texto = Buffer.from(texto, 'base64').toString('utf8');
  const cred = JSON.parse(texto);
  if (!cred.client_email || !cred.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON sem client_email/private_key.');
  // Ao colar na Vercel, as quebras de linha da chave às vezes viram "\n" literal.
  cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  return cred;
}

export function contaDeServicoConfigurada() {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

export function emailContaDeServico() {
  try { return lerCredenciais()?.client_email || null; } catch { return null; }
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function obterToken() {
  if (tokenEmCache && tokenEmCache.expira > Date.now() + 60000) return tokenEmCache.token;
  const cred = lerCredenciais();
  if (!cred) throw new Error('Conta de serviço do Google não configurada (GOOGLE_SERVICE_ACCOUNT_JSON).');
  const agora = Math.floor(Date.now() / 1000);
  const cabecalho = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const corpo = base64url(JSON.stringify({
    iss: cred.client_email, scope: ESCOPO, aud: 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3600,
  }));
  const assinatura = crypto.createSign('RSA-SHA256').update(`${cabecalho}.${corpo}`).sign(cred.private_key);
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${cabecalho}.${corpo}.${base64url(assinatura)}`,
    }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.access_token) {
    throw new Error(`Google recusou a conta de serviço: ${json.error_description || json.error || resp.status}`);
  }
  tokenEmCache = { token: json.access_token, expira: Date.now() + (Number(json.expires_in) || 3600) * 1000 };
  return tokenEmCache.token;
}

async function erroDrive(resp, idArquivo) {
  const json = await resp.json().catch(() => ({}));
  if (resp.status === 404) {
    return new Error(`A conta de serviço não enxerga a planilha (${idArquivo}). Compartilhe o arquivo com ${emailContaDeServico() || 'o e-mail da conta de serviço'} como Leitor.`);
  }
  return new Error(`Erro do Google Drive (${resp.status}): ${json.error?.message || 'sem detalhe'}`);
}

// Baixa o arquivo como .xlsx. Se um dia a planilha for convertida para o
// formato do Google Planilhas, exporta como .xlsx e o resto continua igual.
export async function baixarComoXlsx(idArquivo) {
  const token = await obterToken();
  const auth = { Authorization: `Bearer ${token}` };
  const base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(idArquivo)}`;

  const metaResp = await fetch(`${base}?fields=name,mimeType,modifiedTime&supportsAllDrives=true`, { headers: auth });
  if (!metaResp.ok) throw await erroDrive(metaResp, idArquivo);
  const meta = await metaResp.json();

  const url = meta.mimeType === 'application/vnd.google-apps.spreadsheet'
    ? `${base}/export?mimeType=${encodeURIComponent('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}`
    : `${base}?alt=media&supportsAllDrives=true`;
  const arqResp = await fetch(url, { headers: auth });
  if (!arqResp.ok) throw await erroDrive(arqResp, idArquivo);
  const bytes = new Uint8Array(await arqResp.arrayBuffer());
  return { bytes, nome: meta.name, modificadoEm: meta.modifiedTime };
}
