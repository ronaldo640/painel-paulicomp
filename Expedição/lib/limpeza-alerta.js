// Avisos por e-mail da limpeza do veículo: lembrete na véspera e limpeza atrasada
// (via Resend, igual ao aviso de caixas: mesmos destinos e mesmo remetente, ver
// lib/caixa-alerta.js).
//
// Roda no fim da rotina diária que já existe (api/caixa-auto-executar.js, cron
// das 5h BRT; o Hobby só permite 2 crons). Também atende
// ?alerta=limpeza-simular (mostra o que seria enviado, sem enviar nada; aceita
// &hoje=AAAA-MM-DD para simular outro dia).
//
// Lembrete: um dia antes da data prevista da próxima limpeza (como as datas caem
// na sexta, sai na quinta). O assunto começa sempre com "Lembrete: amanhã é dia
// de lavar", para o filtro do e-mail reenviar aos motoristas.
//
// Quando avisa: a próxima limpeza da agenda já passou da data. Sai no 1º dia de
// atraso e se repete a cada 7 dias (atraso 1, 8, 15...) até alguém registrar a
// limpeza. Não guarda estado: a regra sai só da data, então não precisa de
// migração. Se a rotina falhar num dia, o aviso daquele dia se perde.
//
// Liga com LIMPEZA_ALERTA_ATIVO=true; se ela não existir, vale a mesma chave do
// aviso de caixas (ALERTA_EMAIL_ATIVO).

import { enviarEmail, destinos } from './caixa-alerta.js';
import { montarAgenda } from './limpeza-agenda.js';

const REPETE_A_CADA_DIAS = 7;
const URL_TELA = 'https://painel-paulicomp.vercel.app/limpeza';
const URL_LOGO = 'https://painel-paulicomp.vercel.app/logo-empresa.png'; // a mesma do painel
const UNIDADE = 'Unidade Bariri';

export function alertaLimpezaAtivo() {
  return (process.env.LIMPEZA_ALERTA_ATIVO ?? process.env.ALERTA_EMAIL_ATIVO) === 'true';
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Data de hoje no horário de Brasília, como AAAA-MM-DD.
function hojeBrasilia() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

function diasEntre(deTexto, ateTexto) {
  const t = (s) => { const [a, m, d] = s.split('-').map(Number); return Date.UTC(a, m - 1, d); };
  return Math.round((t(ateTexto) - t(deTexto)) / 86400000);
}

const fmt = (s) => s.split('-').reverse().join('/');

// A logo tem letras brancas (feita pro fundo escuro do painel), por isso vai
// numa faixa escura; a unidade fica logo abaixo dela.
function cartao(titulo, corpo) {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;max-width:560px;">
      <div style="background:#0f172a;border-radius:10px 10px 0 0;padding:16px 20px;">
        <img src="${URL_LOGO}" alt="Paulicomp" height="36" style="display:block;height:36px;width:auto;border:0;">
        <div style="color:#cbd5e1;font-size:13px;letter-spacing:.04em;margin-top:6px;">${UNIDADE}</div>
      </div>
      <div style="border:1px solid #e2e8f0;border-top:0;border-radius:0 0 10px 10px;padding:20px;">
        <h2 style="margin:0 0 8px;">${esc(titulo)}</h2>
        ${corpo}
      </div>
    </div>`;
}

// Roda todo dia: um e-mail na véspera da limpeza prevista (lembrete) e os de
// atraso. `hoje` só vale na simulação (para testar com outra data).
// `teste` manda o lembrete agora, com "[TESTE]" no assunto, mesmo fora da véspera
// e mesmo com o aviso desligado (só para conferir o e-mail e o filtro).
export async function avisarLimpezaAtrasada(sql, { simular = false, teste = false, hoje: hojeSimulado } = {}) {
  const [cfg] = await sql`
    SELECT frequencia, TO_CHAR(inicio, 'YYYY-MM-DD') AS inicio, placa FROM limpeza_config WHERE id = 1`;
  if (!cfg) return { atrasada: false, motivo: 'Sem configuração da limpeza (rode a migração 020).' };
  const [ult] = await sql`
    SELECT TO_CHAR(data, 'YYYY-MM-DD') AS data, tipo FROM limpezas ORDER BY data DESC, id DESC LIMIT 1`;
  const prox = montarAgenda(cfg, ult || null, 1)[0];
  const hoje = simular && /^\d{4}-\d{2}-\d{2}$/.test(hojeSimulado || '') ? hojeSimulado : hojeBrasilia();
  const atraso = diasEntre(prox.data, hoje);

  const resultado = { ativo: alertaLimpezaAtivo(), hoje, prevista: prox.data, tipo: prox.tipo, atraso_dias: Math.max(0, atraso) };

  if (atraso === -1 || teste) {
    const veiculo = cfg.placa ? `Fiorino ${cfg.placa}` : 'Fiorino';
    const servico = prox.tipo === 'completa' ? 'completa' : 'simples';
    // O assunto começa sempre igual: é por ele que o filtro do e-mail reenvia aos motoristas.
    const assunto = `${teste ? '[TESTE] ' : ''}Lembrete: amanhã é dia de lavar a ${veiculo} (${fmt(prox.data)})`;
    const html = cartao(`Amanhã é dia de lavar a ${veiculo}`, `
        <p>A limpeza <b>${servico}</b> está prevista para <b>amanhã, ${fmt(prox.data)}</b>.</p>
        <p>Motorista: leve a Fiorino ao lava-rápido e, depois de lavar, registre a limpeza na sua tela, com <b>3 fotos</b> (exterior, cabine e compartimento de carga).</p>
        <p><a href="${URL_TELA}" style="color:#2563eb;">Abrir a tela da limpeza</a></p>`);
    const texto = `${UNIDADE}. Amanhã (${fmt(prox.data)}) é dia de lavar a ${veiculo}: limpeza ${servico}. Depois de lavar, registre na tela do motorista com 3 fotos. ${URL_TELA}`;
    const plano = { assunto, destinos: destinos(), texto };
    if (simular) return { ...resultado, lembrete: true, simulacao: true, enviado: false, ...plano };
    if (!resultado.ativo && !teste) return { ...resultado, lembrete: true, enviado: false };
    const envio = await enviarEmail(assunto, html, texto);
    return { ...resultado, lembrete: true, enviado: true, id_resend: envio.id, assunto };
  }

  if (atraso < 1) return { ...resultado, atrasada: false, enviado: false };
  const dia = (atraso - 1) % REPETE_A_CADA_DIAS === 0;
  if (!dia) return { ...resultado, atrasada: true, enviado: false, motivo: `Já avisado; repete a cada ${REPETE_A_CADA_DIAS} dias (próximo lembrete no atraso de ${atraso + REPETE_A_CADA_DIAS - ((atraso - 1) % REPETE_A_CADA_DIAS)} dias).` };

  const veiculo = cfg.placa ? `Fiorino ${cfg.placa}` : 'Fiorino';
  const servico = prox.tipo === 'completa' ? 'completa' : 'simples';
  const dias = `${atraso} ${atraso === 1 ? 'dia' : 'dias'}`;
  const assunto = `Limpeza da ${veiculo} atrasada há ${dias}`;
  const ultima = ult ? `A última limpeza registrada foi em ${fmt(ult.data)}.` : 'Ainda não há nenhuma limpeza registrada.';
  const html = cartao(`Limpeza da ${veiculo} atrasada`, `
        <p>A limpeza ${servico} estava prevista para <b>${fmt(prox.data)}</b> e ainda não foi registrada: <b>${dias} de atraso</b>.</p>
        <p>${esc(ultima)}</p>
        <p>Quando o motorista registrar a limpeza (com as 3 fotos), o aviso para.</p>
        <p><a href="${URL_TELA}" style="color:#2563eb;">Abrir a tela da limpeza</a></p>`);
  const texto = `${UNIDADE}. A limpeza ${servico} da ${veiculo} estava prevista para ${fmt(prox.data)} e ainda não foi registrada (${dias} de atraso). ${ultima} ${URL_TELA}`;
  const plano = { assunto, destinos: destinos(), texto };

  if (simular) return { ...resultado, atrasada: true, simulacao: true, enviado: false, ...plano };
  if (!resultado.ativo) return { ...resultado, atrasada: true, enviado: false };
  const envio = await enviarEmail(assunto, html, texto);
  return { ...resultado, atrasada: true, enviado: true, id_resend: envio.id, assunto };
}
