// Manutenção básica da Fiorino: óleo, filtro de óleo, filtro de ar, filtro de
// combustível (10.000 km) e filtro de cabine (20.000 km). Estima a próxima troca de
// cada item a partir da última troca dele, do intervalo e da média de km por dia.
// Usado por api/limpeza.js (tela da gestão) e lib/limpeza-alerta.js (e-mail).
//
// Intervalo de cada item: km e meses, vale o que vier primeiro (os meses são uma
// rede de segurança para o carro que roda pouco). Os valores mudam na tela.
//
// Média de km por dia: dos km dos checklists de início do dia, nos últimos 90 dias
// de checklist (do primeiro ao último km, dividido pelos dias corridos entre eles,
// fim de semana incluído). Precisa de pelo menos 2 checklists com 7 dias entre eles;
// sem isso a previsão por km não sai e vale só a do prazo. A data estimada pelo km
// parte do km do último checklist, não de hoje.
//
// Situação de cada item: 'sem_troca' (nenhuma troca registrada), 'vencida' (passou
// do km ou da data), 'chegando' (faltam até avisoKm km ou avisoDias dias) e 'ok'.
//
// Datas sempre como texto AAAA-MM-DD, calculadas em UTC.

const DIA_MS = 86400000;
const JANELA_DIAS = 90;
const MIN_DIAS_MEDIA = 7;

export const ITENS = [
  { id: 'oleo',          nome: 'Óleo do motor',         km: 10000, meses: 12 },
  { id: 'filtro_oleo',   nome: 'Filtro de óleo',        km: 10000, meses: 12 },
  { id: 'filtro_ar',     nome: 'Filtro de ar',          km: 10000, meses: 12 },
  { id: 'filtro_comb',   nome: 'Filtro de combustível', km: 10000, meses: 12 },
  { id: 'filtro_cabine', nome: 'Filtro de cabine',      km: 20000, meses: 24 },
];
export const IDS_ITENS = ITENS.map((i) => i.id);
export const PADRAO = { avisoKm: 1000, avisoDias: 15 };

const paraTempo = (s) => { const [a, m, d] = s.split('-').map(Number); return Date.UTC(a, m - 1, d); };
const paraTexto = (t) => new Date(t).toISOString().slice(0, 10);
export const somaDias = (s, n) => paraTexto(paraTempo(s) + n * DIA_MS);
export const diasEntre = (de, ate) => Math.round((paraTempo(ate) - paraTempo(de)) / DIA_MS);

export function somaMeses(s, n) {
  const [a, m, d] = s.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + n, 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimoDia));
  return alvo.toISOString().slice(0, 10);
}

// Lê os dados do banco (usado pela API e pelo aviso por e-mail).
export async function carregarManutencao(sql) {
  const [cfg] = await sql`
    SELECT placa, manut_intervalos, manut_aviso_km, manut_aviso_dias, manut_aviso_estado,
           TO_CHAR(manut_aviso_em, 'YYYY-MM-DD') AS manut_aviso_em
    FROM limpeza_config WHERE id = 1`;
  const registros = await sql`
    SELECT id, TO_CHAR(data, 'YYYY-MM-DD') AS data, km, itens, custo::float8 AS custo, obs
    FROM limpeza_manutencoes ORDER BY data DESC, id DESC LIMIT 200`;
  const checklists = await sql`
    SELECT TO_CHAR(data, 'YYYY-MM-DD') AS data, km FROM limpeza_checklists ORDER BY data DESC LIMIT 150`;
  return { cfg, registros, checklists };
}

// Configuração com os padrões nos campos que faltam: { intervalos: { id: { km, meses } }, avisoKm, avisoDias }.
export function configDe(c) {
  const guardado = (c && c.manut_intervalos) || {};
  const intervalos = {};
  for (const it of ITENS) {
    const g = guardado[it.id] || {};
    intervalos[it.id] = { km: Number(g.km) || it.km, meses: Number(g.meses) || it.meses };
  }
  const aviso = (v, padrao) => (v == null || Number.isNaN(Number(v)) ? padrao : Number(v));
  return { intervalos, avisoKm: aviso(c && c.manut_aviso_km, PADRAO.avisoKm), avisoDias: aviso(c && c.manut_aviso_dias, PADRAO.avisoDias) };
}

// Média de km por dia (ou null) e o último km/data de checklist.
export function mediaDeKm(checklists) {
  const lista = checklists.slice().sort((a, b) => (a.data < b.data ? 1 : -1)); // mais recente primeiro
  const atual = lista[0] ? { data: lista[0].data, km: Number(lista[0].km) } : null;
  let media = null, janelaDias = 0;
  if (atual) {
    const corte = somaDias(atual.data, -JANELA_DIAS);
    const dentro = lista.filter((r) => r.data >= corte);
    const antigo = dentro[dentro.length - 1];
    janelaDias = diasEntre(antigo.data, atual.data);
    if (dentro.length >= 2 && janelaDias >= MIN_DIAS_MEDIA && atual.km > Number(antigo.km)) {
      media = (atual.km - Number(antigo.km)) / janelaDias;
    }
  }
  return { atual, media, janelaDias };
}

function estimarItem(item, intervalo, ultima, atual, media, cfg, hoje) {
  const base = { id: item.id, nome: item.nome, intervalo_km: intervalo.km, intervalo_meses: intervalo.meses };
  if (!ultima) return { ...base, situacao: 'sem_troca' };
  const alvoKm = ultima.km + intervalo.km;
  const restanteKm = atual ? alvoKm - atual.km : null;
  const dataTempo = somaMeses(ultima.data, intervalo.meses);
  const dataKm = atual && media
    ? (restanteKm <= 0 ? atual.data : somaDias(atual.data, Math.ceil(restanteKm / media)))
    : null;
  const usaKm = !!dataKm && dataKm < dataTempo;
  const proxima = usaKm ? dataKm : dataTempo;
  const diasTempo = diasEntre(hoje, dataTempo);
  const diasKm = dataKm ? diasEntre(hoje, dataKm) : null;
  const vencida = (restanteKm != null && restanteKm <= 0) || diasTempo < 0;
  const chegando = !vencida && (
    (restanteKm != null && restanteKm <= cfg.avisoKm) || diasTempo <= cfg.avisoDias ||
    (diasKm != null && diasKm <= cfg.avisoDias));
  return {
    ...base, situacao: vencida ? 'vencida' : chegando ? 'chegando' : 'ok',
    ultima, alvo_km: alvoKm, restante_km: restanteKm,
    data_por_km: dataKm, data_por_tempo: dataTempo,
    proxima_data: proxima, proxima_motivo: usaKm ? 'km' : 'tempo',
    dias_ate_proxima: diasEntre(hoje, proxima),
  };
}

// `registros` = visitas [{ data, km, itens: [ids] }] em qualquer ordem; `checklists` =
// [{ data, km }]; `cfg` = saída de configDe().
export function estimar({ cfg, registros, checklists, hoje }) {
  const { atual, media, janelaDias } = mediaDeKm(checklists);
  const maisNovoPrimeiro = registros.slice().sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : (b.id || 0) - (a.id || 0)));
  const itens = ITENS.map((it) => {
    const v = maisNovoPrimeiro.find((r) => Array.isArray(r.itens) && r.itens.includes(it.id));
    return estimarItem(it, cfg.intervalos[it.id], v ? { data: v.data, km: Number(v.km) } : null, atual, media, cfg, hoje);
  });
  const ordem = { vencida: 0, chegando: 1, ok: 2, sem_troca: 3 };
  const pior = itens.slice().sort((a, b) => ordem[a.situacao] - ordem[b.situacao])[0];
  return {
    hoje, km_atual: atual ? atual.km : null, km_atual_data: atual ? atual.data : null,
    media_km_dia: media == null ? null : Math.round(media * 10) / 10, janela_dias: janelaDias,
    situacao: pior.situacao, itens,
  };
}

// Resumo curto para a tela do motorista (sem valores): os itens com troca registrada,
// do mais urgente ao menos, juntando os que vencem no mesmo km e na mesma data.
// Devolve { situacao, km_atual, grupos: [{ nomes: [...], situacao, restante_km, proxima_data }] }.
export function resumoParaMotorista(est) {
  const ordem = { vencida: 0, chegando: 1, ok: 2 };
  const itens = est.itens.filter((i) => i.situacao !== 'sem_troca')
    .sort((a, b) => ordem[a.situacao] - ordem[b.situacao]
      || (a.restante_km == null ? 1e12 : a.restante_km) - (b.restante_km == null ? 1e12 : b.restante_km));
  const grupos = [];
  for (const i of itens) {
    const g = grupos.find((x) => x.situacao === i.situacao && x.restante_km === i.restante_km && x.proxima_data === i.proxima_data);
    if (g) g.nomes.push(i.nome);
    else grupos.push({ nomes: [i.nome], situacao: i.situacao, restante_km: i.restante_km, proxima_data: i.proxima_data });
  }
  return { situacao: itens[0] ? itens[0].situacao : 'sem_troca', km_atual: est.km_atual, grupos: grupos.slice(0, 3) };
}
