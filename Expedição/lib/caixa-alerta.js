// Aviso por e-mail do Controle de Caixas (via Resend).
//
// Roda no fim da rotina diária que já existe (api/caixa-auto-executar.js,
// cron das 5h BRT) — o plano Hobby da Vercel só permite 2 crons e ambos já
// estão em uso. Também atende ?alerta=simular (mostra o que seria enviado,
// sem enviar nem gravar nada) e ?alerta=teste (e-mail de teste).
//
// Pra não encher a caixa de entrada, o e-mail só sai quando um modelo MUDA
// de estado (entrou em "Atenção" ou "Comprar agora", ou piorou de Atenção
// pra Comprar agora). Se continuar no mesmo estado, repete 1x por semana.
// O estado já avisado fica na tabela caixa_alerta_estado (migração 012).
//
// Variáveis de ambiente (Vercel):
//   RESEND_API_KEY          chave da API do Resend (obrigatória)
//   ALERTA_EMAIL_ATIVO      "true" liga o aviso automático (padrão: desligado)
//   ALERTA_EMAIL_REMETENTE  ex: "Painel Paulicomp <alertas@paulicomp.com>"
//                           (precisa de domínio verificado no Resend; sem isso
//                           usa onboarding@resend.dev, que só entrega no
//                           e-mail dono da conta Resend)
//   ALERTA_EMAIL_DESTINOS   lista separada por vírgula (opcional)

import { calcularResumo } from './caixa-resumo-calculo.js';

// Sem domínio verificado no Resend, ele só entrega no e-mail da própria conta
// (ronaldo@paulicomp.com) e recusa o envio inteiro se houver outro endereço
// na lista. Pra incluir mais gente (ex: lsmatielo04@gmail.com), ou o domínio
// paulicomp.com é verificado no Resend, ou o destinatário encaminha pelo Gmail.
const DESTINOS_PADRAO = ['ronaldo@paulicomp.com'];
const REENVIO_DIAS = 7;            // lembrete se continuar no mesmo estado
const DADOS_ANTIGOS_DIAS = 3;      // última saída registrada há >= N dias
const ESTADO_DADOS_ANTIGOS = 0;    // linhas "especiais" de caixa_alerta_estado
const ESTADO_TESTE = -1;
const ESTADO_FALHA_BAIXA = -2;
const URL_PAINEL = 'https://painel-paulicomp.vercel.app/index.html.html#caixas';

export function alertaAtivo() {
  return process.env.ALERTA_EMAIL_ATIVO === 'true';
}

export function destinos() {
  const env = process.env.ALERTA_EMAIL_DESTINOS;
  return env ? env.split(',').map(s => s.trim()).filter(Boolean) : DESTINOS_PADRAO;
}

const REMETENTE_PADRAO = 'Painel Paulicomp <onboarding@resend.dev>';

// Remetente configurado na Vercel, já limpo (aspas e espaços sobrando) e
// conferido; se o valor não estiver em "email@x.com" ou "Nome <email@x.com>",
// cai no remetente de teste do Resend em vez de derrubar o envio.
export function remetente() {
  const v = (process.env.ALERTA_EMAIL_REMETENTE || '').trim().replace(/^["']+|["']+$/g, '').trim();
  const soEmail = /^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$/;
  const comNome = /^[^<>]+<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>$/;
  return soEmail.test(v) || comNome.test(v) ? v : REMETENTE_PADRAO;
}

export async function enviarEmail(assunto, html, texto, para) {
  const chave = process.env.RESEND_API_KEY;
  if (!chave || !chave.trim()) {
    // Diagnóstico sem expor segredo: qual deploy está respondendo e se a
    // outra variável criada junto aparece neste ambiente.
    const deploy = (process.env.VERCEL_GIT_COMMIT_SHA || 'desconhecido').slice(0, 7);
    throw new Error(`RESEND_API_KEY ${chave === undefined ? 'ausente' : 'vazia'} neste deploy (commit ${deploy}, ambiente ${process.env.VERCEL_ENV || '?'}; ALERTA_EMAIL_REMETENTE ${process.env.ALERTA_EMAIL_REMETENTE ? 'definida' : 'ausente'}).`);
  }
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: remetente(),
      to: para && para.length ? para : destinos(),
      subject: assunto,
      html,
      text: texto,
    }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`${json.message || `Resend respondeu ${resp.status}`} (remetente usado: ${remetente()}; destinos: ${destinos().join(', ')})`);
  return { ...json, remetente: remetente() }; // { id, remetente }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function diasDesde(data) {
  return (Date.now() - new Date(data).getTime()) / 86400000;
}

function diasEntreIso(isoAntigo) {
  // diferença em dias de calendário entre hoje (fuso de Brasília) e uma data AAAA-MM-DD
  const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  return Math.round((new Date(hoje) - new Date(isoAntigo)) / 86400000);
}

async function lerEstado(sql, filial) {
  const rows = await sql`SELECT modelo_id, status, notificado_em FROM caixa_alerta_estado WHERE filial = ${filial}`;
  return new Map(rows.map(r => [r.modelo_id, r]));
}

async function gravarEstado(sql, filial, modeloId, status, renovarData = true) {
  if (renovarData) {
    await sql`
      INSERT INTO caixa_alerta_estado (filial, modelo_id, status, notificado_em)
      VALUES (${filial}, ${modeloId}, ${status}, now())
      ON CONFLICT (filial, modelo_id) DO UPDATE SET status = EXCLUDED.status, notificado_em = now()`;
  } else {
    await sql`
      INSERT INTO caixa_alerta_estado (filial, modelo_id, status, notificado_em)
      VALUES (${filial}, ${modeloId}, ${status}, now())
      ON CONFLICT (filial, modelo_id) DO UPDATE SET status = EXCLUDED.status`;
  }
}

const ROTULO = { crit: 'Comprar agora', warn: 'Atenção' };
const COR = { crit: '#e11d48', warn: '#d97706' };
const MOTIVO = { novo: 'novo', agravou: 'piorou', lembrete: 'lembrete semanal' };

function montarEmail({ itens, dadosAntigos }) {
  const crit = itens.filter(i => i.m.status === 'crit').length;
  const warn = itens.filter(i => i.m.status === 'warn').length;
  const partes = [];
  if (crit) partes.push(`${crit} para comprar agora`);
  if (warn) partes.push(`${warn} em atenção`);
  const assunto = itens.length
    ? `Controle de Caixas: ${partes.join(' e ')}`
    : 'Controle de Caixas: dados de consumo desatualizados';

  const linhas = itens.map(({ m, motivo }) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #e2e8f0;"><b>${esc(m.nome)}</b><br><span style="color:#64748b;font-size:12px;">${esc(MOTIVO[motivo])}</span></td>
      <td style="padding:8px;border-bottom:1px solid #e2e8f0;color:${COR[m.status]};font-weight:bold;">${ROTULO[m.status]}</td>
      <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;">${m.estoque_atual} un</td>
      <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;">${(m.consumo_planejamento ?? m.consumo_30d).toFixed(1)}/dia</td>
      <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;">${m.cobertura_dias !== null ? m.cobertura_dias + ' dias' : '—'}</td>
      <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;">${m.ponto_reposicao !== null ? m.ponto_reposicao + ' un' : '—'}</td>
      <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;">${m.em_pedido > 0 ? m.em_pedido + ' un' : '—'}</td>
      <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;">${m.qtd_pedido != null ? m.qtd_pedido + ' un' : '—'}</td>
    </tr>`).join('');

  const tabela = itens.length ? `
    <table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:12px;">
      <thead><tr style="background:#f1f5f9;text-align:left;">
        <th style="padding:8px;">Modelo</th><th style="padding:8px;">Situação</th>
        <th style="padding:8px;text-align:right;">Estoque</th><th style="padding:8px;text-align:right;">Consumo</th>
        <th style="padding:8px;text-align:right;">Cobertura</th><th style="padding:8px;text-align:right;">Ponto de reposição</th>
        <th style="padding:8px;text-align:right;">Já pedido</th><th style="padding:8px;text-align:right;">Pedido padrão</th>
      </tr></thead>
      <tbody>${linhas}</tbody>
    </table>` : '';

  const aviso = dadosAntigos ? `
    <p style="background:#fffbeb;border:1px solid #fcd34d;padding:10px;border-radius:6px;font-size:13px;">
      <b>Dados de consumo desatualizados:</b> a última saída registrada foi em ${esc(dadosAntigos.ultimaSaida)}
      (${dadosAntigos.dias} dias). Confira se a baixa automática está rodando.
    </p>` : '';

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;max-width:760px;">
      <h2 style="margin:0 0 4px;">Controle de Caixas — Paulicomp SP</h2>
      ${aviso}${tabela}
      <p style="margin-top:16px;"><a href="${URL_PAINEL}" style="color:#2563eb;">Abrir o Controle de Caixas</a></p>
      <p style="color:#94a3b8;font-size:11px;">Aviso automático. Ele só é enviado quando um modelo muda de situação; se continuar igual, repete uma vez por semana.</p>
    </div>`;

  const texto = [
    assunto,
    dadosAntigos ? `Dados de consumo desatualizados: última saída em ${dadosAntigos.ultimaSaida} (${dadosAntigos.dias} dias).` : '',
    ...itens.map(({ m }) => `- ${m.nome}: ${ROTULO[m.status]} · estoque ${m.estoque_atual} un · cobertura ${m.cobertura_dias ?? '—'} dias · ponto ${m.ponto_reposicao ?? '—'} un`),
    URL_PAINEL,
  ].filter(Boolean).join('\n');

  return { assunto, html, texto };
}

// Decide o que avisar. simular = não envia nem grava nada, só devolve o plano.
export async function verificarEAvisar(sql, filial, { simular = false } = {}) {
  if (!simular && !alertaAtivo()) return { ativo: false };

  const resumo = await calcularResumo(sql, filial, 0);
  const estado = await lerEstado(sql, filial);

  const itens = [];       // entram no e-mail
  const semAviso = [];    // só atualizam o estado salvo
  for (const m of resumo.modelos) {
    const r = estado.get(m.id);
    if (m.status !== 'crit' && m.status !== 'warn') {
      if (r && r.status !== m.status) semAviso.push({ id: m.id, status: m.status });
      continue;
    }
    const ativoAntes = r && (r.status === 'crit' || r.status === 'warn');
    if (!ativoAntes) { itens.push({ m, motivo: 'novo' }); continue; }
    if (r.status === 'warn' && m.status === 'crit') { itens.push({ m, motivo: 'agravou' }); continue; }
    if (r.status === 'crit' && m.status === 'warn') { semAviso.push({ id: m.id, status: m.status }); continue; }
    if (diasDesde(r.notificado_em) >= REENVIO_DIAS) itens.push({ m, motivo: 'lembrete' });
  }

  let dadosAntigos = null;
  const rDados = estado.get(ESTADO_DADOS_ANTIGOS);
  if (resumo.ultima_saida) {
    const dias = diasEntreIso(resumo.ultima_saida);
    if (dias >= DADOS_ANTIGOS_DIAS && (!rDados || rDados.status !== 'antigo' || diasDesde(rDados.notificado_em) >= DADOS_ANTIGOS_DIAS)) {
      dadosAntigos = { ultimaSaida: resumo.ultima_saida, dias };
    }
  }

  const plano = {
    aviso_automatico_ligado: alertaAtivo(),
    destinos: destinos(),
    avisar: itens.map(i => ({ modelo: i.m.nome, situacao: ROTULO[i.m.status], motivo: i.motivo, estoque: i.m.estoque_atual })),
    dados_antigos: dadosAntigos,
    atualizacoes_silenciosas: semAviso.length,
  };
  if (simular) return { simulacao: true, ...plano };

  if (itens.length === 0 && !dadosAntigos) {
    for (const s of semAviso) await gravarEstado(sql, filial, s.id, s.status, false);
    if (rDados && rDados.status === 'antigo' && resumo.ultima_saida && diasEntreIso(resumo.ultima_saida) < DADOS_ANTIGOS_DIAS) {
      await gravarEstado(sql, filial, ESTADO_DADOS_ANTIGOS, 'ok', false);
    }
    return { enviado: false, ...plano };
  }

  const { assunto, html, texto } = montarEmail({ itens, dadosAntigos });
  const envio = await enviarEmail(assunto, html, texto);

  for (const i of itens) await gravarEstado(sql, filial, i.m.id, i.m.status, true);
  for (const s of semAviso) await gravarEstado(sql, filial, s.id, s.status, false);
  if (dadosAntigos) await gravarEstado(sql, filial, ESTADO_DADOS_ANTIGOS, 'antigo', true);
  return { enviado: true, id_resend: envio.id, assunto, ...plano };
}

// E-mail de teste da configuração (no máx. 1 a cada 5 minutos, pra ninguém
// usar o endereço público pra disparar e-mails em sequência).
// `para` (opcional) restringe o teste a um endereço da lista de destinos —
// serve pra validar o envio enquanto o domínio ainda não foi verificado no
// Resend (que, sem domínio, só entrega no e-mail da própria conta).
export async function enviarTeste(sql, filial, para) {
  let alvo = null;
  if (para) {
    alvo = destinos().filter(d => d.toLowerCase() === String(para).toLowerCase());
    if (alvo.length === 0) return { enviado: false, motivo: 'O endereço precisa estar na lista de destinos.' };
  }
  const estado = await lerEstado(sql, filial);
  const r = estado.get(ESTADO_TESTE);
  if (r && diasDesde(r.notificado_em) < 5 / 1440) {
    return { enviado: false, motivo: 'Já foi enviado um teste há menos de 5 minutos.' };
  }
  const resumo = await calcularResumo(sql, filial, 0);
  const crit = resumo.modelos.filter(m => m.status === 'crit').length;
  const warn = resumo.modelos.filter(m => m.status === 'warn').length;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;max-width:560px;">
      <h2 style="margin:0 0 8px;">Teste dos avisos — Controle de Caixas</h2>
      <p>Se você recebeu este e-mail, o envio está configurado corretamente.</p>
      <p>Situação agora: <b>${crit}</b> modelo(s) em "Comprar agora" e <b>${warn}</b> em "Atenção".</p>
      <p>Avisos automáticos: <b>${alertaAtivo() ? 'ligados' : 'desligados'}</b>.</p>
      <p><a href="${URL_PAINEL}" style="color:#2563eb;">Abrir o Controle de Caixas</a></p>
    </div>`;
  const texto = `Teste dos avisos do Controle de Caixas. ${crit} em Comprar agora, ${warn} em Atenção. Avisos automáticos: ${alertaAtivo() ? 'ligados' : 'desligados'}. ${URL_PAINEL}`;
  const envio = await enviarEmail('Teste — avisos do Controle de Caixas', html, texto, alvo);
  await gravarEstado(sql, filial, ESTADO_TESTE, 'teste', true);
  return { enviado: true, id_resend: envio.id, remetente: envio.remetente, destinos: alvo || destinos() };
}

// Avisa que a baixa automática da madrugada falhou (no máx. 1 por dia).
export async function avisarFalhaBaixa(sql, filial, mensagem) {
  if (!alertaAtivo()) return { ativo: false };
  const estado = await lerEstado(sql, filial);
  const r = estado.get(ESTADO_FALHA_BAIXA);
  if (r && diasDesde(r.notificado_em) < 20 / 24) return { enviado: false };
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;max-width:560px;">
      <h2 style="margin:0 0 8px;">A baixa automática de caixas falhou</h2>
      <p>A rotina diária das 5h não conseguiu processar as notas. Erro:</p>
      <pre style="background:#f1f5f9;padding:10px;border-radius:6px;white-space:pre-wrap;">${esc(mensagem)}</pre>
      <p>Costuma ser limite de acessos da API do Tiny e se resolve sozinho no dia seguinte. Se se repetir, vale conferir.</p>
      <p><a href="${URL_PAINEL}" style="color:#2563eb;">Abrir o Controle de Caixas</a></p>
    </div>`;
  const envio = await enviarEmail('Controle de Caixas: a baixa automática falhou', html, `A baixa automática de caixas falhou: ${mensagem}`);
  await gravarEstado(sql, filial, ESTADO_FALHA_BAIXA, 'falha', true);
  return { enviado: true, id_resend: envio.id };
}
