// Relatórios semanais por e-mail (Separação, Expedição e Controle de Caixas e Insumos).
//
// Roda no GitHub Actions (.github/workflows/relatorio-semanal.yml), toda sexta às 18h
// de Brasília. Passos:
//   1. Atualiza os dados com o Tiny, um sistema por vez (os três usam o mesmo token do Tiny,
//      então nunca em paralelo): Expedição (notas), baixa automática das caixas (SP) e Separação.
//   2. Abre os painéis publicados num navegador sem tela, escolhe "últimos 7 dias" e clica nos
//      mesmos botões "Relatório PDF" que o usuário usa: sai exatamente o mesmo PDF.
//        - Expedição e Separação: um PDF por filial (SP, SUL e Comp Trade), 6 no total
//        - Controle de Caixas e Insumos: um PDF da SP e outro da Comp Trade
//      São 8 PDFs no total.
//   3. Manda um único e-mail com os PDFs anexados pela conta Gmail da empresa (senha de aplicativo).
//
// Se uma atualização do Tiny falhar, os relatórios saem mesmo assim, e o e-mail avisa quais dados
// podem estar desatualizados. Se um PDF não puder ser gerado, o e-mail sai com os outros e avisa.
//
// Variáveis de ambiente (ver LEIA-ME.md):
//   GMAIL_USER, GMAIL_APP_PASSWORD          conta que envia
//   RELATORIO_DESTINOS                      destinatários (Para), separados por vírgula
//   RELATORIO_COPIA                         destinatários em cópia (Cc), separados por vírgula (opcional)
//   RELATORIO_TESTE_DESTINO                 para onde vai o e-mail de teste
//   MODO_TESTE=true                         manda só para o destinatário de teste, com [TESTE] no assunto
//   URL_EXPEDICAO, URL_SEPARACAO            (opcional) endereços dos painéis

import { chromium } from 'playwright';
import nodemailer from 'nodemailer';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const URL_EXPEDICAO = (process.env.URL_EXPEDICAO || 'https://painel-paulicomp.vercel.app').replace(/\/$/, '');
const URL_SEPARACAO = (process.env.URL_SEPARACAO || 'https://painel-separacao.vercel.app').replace(/\/$/, '');
const MODO_TESTE = process.env.MODO_TESTE === 'true';
const PASTA = path.resolve('pdfs');
const DIAS_SYNC = 14; // janela de notas/pedidos reconsultada no Tiny (a rotina diária cobre o resto)

const avisos = []; // problemas que vão no corpo do e-mail
const anexos = []; // { filename, path }

// ---------- datas (horário de Brasília) ----------
const hojeIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const somaDias = (iso, n) => {
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
};
const br = (iso) => iso.split('-').reverse().join('/');
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. atualização com o Tiny ----------
async function chamar(base, caminho) {
  const resp = await fetch(base + caminho, { signal: AbortSignal.timeout(120000) });
  let json = null;
  try { json = await resp.json(); } catch { /* resposta sem JSON */ }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}${json && json.error ? ': ' + json.error : ''}`);
  return json || {};
}

async function sincronizar() {
  const hoje = hojeIso();
  const periodo = `dataInicial=${encodeURIComponent(br(somaDias(hoje, -DIAS_SYNC)))}&dataFinal=${encodeURIComponent(br(hoje))}`;

  // Expedição: notas fiscais das três filiais.
  try {
    const j = await chamar(URL_EXPEDICAO, `/api/tiny-sync?${periodo}`);
    const erros = (j.results || []).filter((r) => r.error);
    if (j.warning) avisos.push(`Expedição: ${j.warning}`);
    if (erros.length) avisos.push(`Expedição: falha ao atualizar ${erros.map((e) => `${e.filial} (${e.error})`).join('; ')}.`);
    console.log('Expedição sincronizada:', JSON.stringify(j.results || j));
  } catch (e) {
    avisos.push(`Expedição: não foi possível atualizar com o Tiny (${e.message}). Os dados podem estar desatualizados.`);
  }
  await pausa(5000);

  // Caixas (SP): baixa automática do consumo de hoje e dos dois dias anteriores.
  for (const n of [0, 1, 2]) {
    const dia = somaDias(hoje, -n);
    try {
      const j = await chamar(URL_EXPEDICAO, `/api/caixa-auto-executar?filial=SP&data=${dia}`);
      console.log(`Baixa automática de caixas ${dia}:`, j.notas_novas_processadas, 'notas novas');
    } catch (e) {
      avisos.push(`Caixas (SP): falha na baixa automática de ${br(dia)} (${e.message}). O consumo pode estar incompleto.`);
    }
    await pausa(3000);
  }

  // Separação: cada chamada lê só os pedidos MAIS RECENTES da janela (uns 47 por filial em 45 s) e
  // sempre os mesmos, então repetir a mesma busca não avança e esgota a cota do Tiny ("API Bloqueada").
  // Por isso é uma chamada por dia (hoje e ontem; o resto já veio das rotinas das 4h e das 8h),
  // com pausa entre elas e uma nova tentativa depois de uma pausa maior se o Tiny bloquear.
  for (const n of [0, 1]) {
    const dia = somaDias(hoje, -n);
    const janela = `dataInicial=${encodeURIComponent(br(dia))}&dataFinal=${encodeURIComponent(br(dia))}`;
    let j = null;
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      try {
        j = await chamar(URL_SEPARACAO, `/api/tiny-sync?${janela}`);
      } catch (e) {
        avisos.push(`Separação ${br(dia)}: não foi possível atualizar com o Tiny (${e.message}). Os dados podem estar desatualizados.`);
        j = null;
        break;
      }
      const bloqueou = (j.results || []).some((r) => /API Bloqueada/i.test(r.error || ''));
      if (!bloqueou || tentativa === 2) break;
      console.log('Tiny bloqueou a Separação; aguardando 2 minutos para tentar de novo.');
      await pausa(120000);
    }
    if (j) {
      console.log(`Separação ${br(dia)}:`, JSON.stringify(j.results || j));
      if (j.warning) avisos.push(`Separação: ${j.warning}`);
      for (const r of j.results || []) {
        if (r.error) avisos.push(`Separação ${br(dia)}: falha ao atualizar ${r.filial} (${r.error}).`);
        else if (r.pedidosProcessados < r.pedidosEncontrados) {
          avisos.push(`Separação ${br(dia)}: ${r.filial} leu ${r.pedidosProcessados} de ${r.pedidosEncontrados} pedidos (limite por execução).`);
        }
      }
    }
    if (n === 0) await pausa(75000);
  }
}

// ---------- 2. relatórios ----------
async function baixarPdf(page, clicar, nomeArquivo) {
  const download = page.waitForEvent('download', { timeout: 180000 });
  await clicar();
  const d = await download;
  const destino = path.join(PASTA, nomeArquivo);
  await d.saveAs(destino);
  anexos.push({ filename: nomeArquivo, path: destino });
  console.log('PDF gerado:', nomeArquivo);
}

// Escolhe "últimos 7 dias" no seletor de período dos painéis de Expedição e Separação.
async function periodoUltimos7(page) {
  await page.click('#b-periodo');
  await page.click('#pp-chips [data-pp="d7"]');
  await page.click('#pp-aplicar');
  await page.waitForTimeout(4000);
}

// Expedição e Separação saem separadas por filial: um PDF de cada (SP, SUL e Comp Trade).
const FILIAIS = [
  { valor: 'PAULICOMP SP', rotulo: 'SP', arquivo: 'SP' },
  { valor: 'PAULICOMP SUL', rotulo: 'SUL', arquivo: 'SUL' },
  { valor: 'COMP TRADE', rotulo: 'Comp Trade', arquivo: 'Comp-Trade' },
];

async function relatorioDashboard(browser, url, rotulo, prefixo) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 180000 });
    await page.waitForSelector('#b-periodo', { timeout: 120000 });
    await page.waitForTimeout(6000); // a base é grande: dá tempo de desenhar os gráficos
    await periodoUltimos7(page);
  } catch (e) {
    avisos.push(`${rotulo}: não foi possível abrir o painel (${e.message.split('\n')[0]}).`);
    await page.close();
    return;
  }
  for (const f of FILIAIS) {
    try {
      await page.selectOption('#filterFilial', f.valor);
      await page.waitForTimeout(4000);
      // Garante que o período continua em "últimos 7 dias" depois de trocar a filial.
      const periodo = (await page.textContent('#periodo-rot')) || '';
      if (!/7 dias/.test(periodo)) await periodoUltimos7(page);
      await baixarPdf(page, () => page.click('#btnPdfReport'), `${prefixo}_${f.arquivo}_ultimos-7-dias.pdf`);
      await page.waitForTimeout(2000);
    } catch (e) {
      avisos.push(`${rotulo} (${f.rotulo}): não foi possível gerar o relatório (${e.message.split('\n')[0]}).`);
    }
  }
  await page.close();
}

async function relatoriosCaixas(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(URL_EXPEDICAO, { waitUntil: 'networkidle', timeout: 180000 });
    await page.click('#cxNavCaixas');
    await page.waitForTimeout(8000);
    for (const [filial, rotulo] of [['SP', 'SP'], ['TRADE', 'Comp Trade']]) {
      try {
        await page.click(`.cx-filial-sel a[data-filial="${filial}"] >> visible=true`);
        await page.waitForTimeout(8000);
        await page.selectOption('#cxPeriodoSelect', '7');
        await page.waitForTimeout(5000);
        await baixarPdf(page, () => page.click('#cxBtnRelatorio'), `Caixas_e_Insumos_${filial}_ultimos-7-dias.pdf`);
        await page.waitForTimeout(2000);
      } catch (e) {
        avisos.push(`Caixas e Insumos (${rotulo}): não foi possível gerar o relatório (${e.message.split('\n')[0]}).`);
      }
    }
  } catch (e) {
    avisos.push(`Caixas e Insumos: não foi possível abrir o painel (${e.message.split('\n')[0]}).`);
  } finally {
    await page.close();
  }
}

// ---------- 3. e-mail ----------
// Aceita endereços separados por vírgula ou ponto e vírgula.
const lerLista = (texto) => String(texto || '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);

// O repositório é público e o log também: mostra só o começo do endereço (ru***@dominio),
// o bastante para conferir quem recebe sem expor o e-mail de ninguém.
const mascarar = (email) => {
  const [usuario, dominio] = String(email).split('@');
  return dominio ? `${usuario.slice(0, 2)}***@${dominio}` : `${String(email).slice(0, 2)}***`;
};
const mostrar = (lista) => (lista && lista.length ? lista.map(mascarar).join(', ') : '(ninguém)');

async function enviarEmail(inicio, fim) {
  const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
  const destinos = MODO_TESTE ? process.env.RELATORIO_TESTE_DESTINO : process.env.RELATORIO_DESTINOS;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) throw new Error('Faltam os segredos GMAIL_USER e GMAIL_APP_PASSWORD no GitHub.');
  if (!destinos) throw new Error(MODO_TESTE ? 'Falta a variável RELATORIO_TESTE_DESTINO.' : 'Falta a variável RELATORIO_DESTINOS.');

  const semana = `${br(inicio)} a ${br(fim)}`;
  const assunto = `${MODO_TESTE ? '[TESTE] ' : ''}Relatórios semanais Paulicomp: ${semana}`;
  const lista = anexos.map((a) => `<li>${a.filename}</li>`).join('');
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;max-width:600px;">
      <h2 style="margin:0 0 8px;">Relatórios semanais</h2>
      <p>Seguem em anexo os relatórios dos <b>últimos 7 dias</b> (${semana}): Separação e Expedição (um relatório para cada filial: SP, SUL e Comp Trade) e Controle de Caixas e Insumos (SP e Comp Trade).</p>
      ${anexos.length ? `<ul>${lista}</ul>` : '<p><b>Nenhum relatório pôde ser gerado.</b></p>'}
      ${avisos.length ? `<div style="border:1px solid #fecaca;background:#fef2f2;border-radius:8px;padding:10px 14px;"><b style="color:#b91c1c;">Atenção</b><ul>${avisos.map((a) => `<li>${a}</li>`).join('')}</ul></div>` : ''}
      <p style="color:#64748b;font-size:12px;">E-mail automático, enviado toda sexta às 18h. Dados atualizados com o Tiny antes de gerar os relatórios.${MODO_TESTE ? ' Este é um envio de teste.' : ''}</p>
    </div>`;
  const texto = `Relatórios semanais (${semana}). Anexos: ${anexos.map((a) => a.filename).join(', ') || 'nenhum'}.${avisos.length ? ' Atenção: ' + avisos.join(' ') : ''}`;

  const transporte = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  const para = lerLista(destinos);
  const copia = MODO_TESTE ? [] : lerLista(process.env.RELATORIO_COPIA);
  console.log(`Envio ${MODO_TESTE ? 'de TESTE' : 'REAL'}: de ${mascarar(GMAIL_USER)} | Para (${para.length}): ${mostrar(para)} | Cópia (${copia.length}): ${mostrar(copia)}`);
  if (MODO_TESTE) {
    const configurada = lerLista(process.env.RELATORIO_COPIA);
    console.log(`Em teste a cópia não é enviada. Cópia configurada para o envio real (${configurada.length}): ${mostrar(configurada)}`);
    console.log(`Destinatários configurados para o envio real (${lerLista(process.env.RELATORIO_DESTINOS).length}): ${mostrar(lerLista(process.env.RELATORIO_DESTINOS))}`);
  }
  const info = await transporte.sendMail({
    from: `"Relatórios Paulicomp" <${GMAIL_USER}>`,
    to: para,
    // Em teste não vai cópia: só o destinatário de teste recebe.
    cc: copia.length ? copia : undefined,
    subject: assunto,
    text: texto,
    html,
    attachments: anexos,
  });
  console.log('E-mail enviado:', info.messageId);
  console.log(`Aceitos pelo Gmail: ${mostrar(info.accepted)} | Recusados: ${mostrar(info.rejected)}`);
  if (info.rejected && info.rejected.length) console.warn(`ATENÇÃO: o Gmail recusou ${info.rejected.length} endereço(s). Confira os destinatários.`);
}

// ---------- principal ----------
// Confere os segredos e variáveis do GitHub antes de gastar minutos com o Tiny e os PDFs.
function conferirConfiguracao() {
  const faltam = [];
  if (!process.env.GMAIL_USER) faltam.push('segredo GMAIL_USER');
  if (!process.env.GMAIL_APP_PASSWORD) faltam.push('segredo GMAIL_APP_PASSWORD');
  if (MODO_TESTE && !process.env.RELATORIO_TESTE_DESTINO) faltam.push('variável RELATORIO_TESTE_DESTINO');
  if (!MODO_TESTE && !process.env.RELATORIO_DESTINOS) faltam.push('variável RELATORIO_DESTINOS');
  if (faltam.length) {
    throw new Error(`Faltam no GitHub (Settings > Secrets and variables > Actions): ${faltam.join(', ')}. Confira o nome (maiúsculas e sublinhado) e se estão em "Repository secrets" ou "Repository variables".`);
  }
}

async function main() {
  conferirConfiguracao();
  const hoje = hojeIso();
  const inicio = somaDias(hoje, -6);
  console.log(`Semana: ${inicio} a ${hoje}${MODO_TESTE ? ' (TESTE)' : ''}`);
  await mkdir(PASTA, { recursive: true });

  await sincronizar();

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ acceptDownloads: true, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', viewport: { width: 1440, height: 900 } });
    // newPage() do contexto: reaproveita o mesmo contexto (com downloads liberados)
    const navegador = { newPage: (opcoes) => ctx.newPage(opcoes) };
    await relatorioDashboard(navegador, URL_EXPEDICAO, 'Expedição', 'Expedicao');
    await relatorioDashboard(navegador, URL_SEPARACAO, 'Separação', 'Separacao');
    await relatoriosCaixas(navegador);
  } finally {
    await browser.close();
  }

  await enviarEmail(inicio, hoje);
  if (!anexos.length) process.exitCode = 1; // nenhum PDF: o GitHub marca a execução como falha
}

main().catch((e) => {
  console.error('Falha geral:', e);
  process.exit(1);
});
