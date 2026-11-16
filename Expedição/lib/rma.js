// RMA (devoluções e garantias) — transforma as abas das planilhas "Retorno de
// materiais SP" e "Retorno de Materiais PR" (Sul e Trade juntos) em registros e
// classifica o motivo de cada devolução em grupos.
//
// A planilha é preenchida por várias pessoas e só é LIDA aqui: nada é gravado
// de volta. Cada mês é uma aba, e as colunas mudam de um mês para outro
// (entraram "Pedido Tiny", "Defeito", "Fotos"...), por isso as colunas são
// achadas pelo nome do cabeçalho, nunca pela posição.
//
// Código puro (sem Node), usado pela API e testado no navegador.

// ---------------------------------------------------------------------------
// Grupos de motivo
// ---------------------------------------------------------------------------
// O campo "Motivo abertura de devolução" é texto livre (em geral copiado do
// Mercado Livre), com mais de 100 redações diferentes. As regras abaixo são
// testadas EM ORDEM e a primeira que casa define o grupo. A ordem importa:
// "cancelado" vem antes de "arrependimento", "quebrado" antes de "não funciona"
// (produto que chegou quebrado é avaria, mesmo que também não funcione).

export const CATEGORIAS = [
  { id: 'produto', nome: 'Problema no produto', cor: '#f87171' },
  { id: 'anuncio', nome: 'Anúncio / compatibilidade', cor: '#fbbf24' },
  { id: 'cliente', nome: 'Decisão do cliente', cor: '#60a5fa' },
  { id: 'logistica', nome: 'Logística', cor: '#a78bfa' },
  { id: 'sem_detalhe', nome: 'Sem detalhe', cor: '#94a3b8' },
  { id: 'fora', nome: 'Fora do indicador', cor: '#475569' },
];

export const GRUPOS = [
  {
    id: 'retorno_full', nome: 'Retorno do Fulfillment', categoria: 'fora',
    descricao: 'Produto voltando do estoque Full. Não é devolução de cliente.',
    // "Retirada estoque full S/venda" aparece na planilha do Sul/Trade (PR).
    regra: /ret\w*no (do )?full|retirada (do |estoque )?full/,
  },
  {
    id: 'cancelamento', nome: 'Cancelamento da venda', categoria: 'cliente',
    descricao: 'Venda cancelada antes ou durante o envio.',
    regra: /cancel|canecel|n[ãa]o pode esperar/,
  },
  {
    id: 'entrega', nome: 'Falha na entrega', categoria: 'logistica',
    descricao: 'Não foi entregue, entrega recusada, endereço errado ou etiqueta errada.',
    regra: /n[ãa]o foi poss[ií]vel entreg|n[ãa]o entregue|n[ãa]o foi entregue|entrega foi recusada|n[ãa]o encontraram ningu[ée]m|endere[çc]o do comprador estava incorreto|etiqueta errada|irregularidades na opera|realizar a entrega|n[ãa]o recebi o pacote|entrega do pacote foi interrompida/,
  },
  {
    id: 'avaria', nome: 'Avaria / dano físico', categoria: 'produto',
    descricao: 'Chegou quebrado, arranhado, rasgado, amassado ou estourado.',
    regra: /quebrad|danificad|arranh|rasgad|avariad|amassad|estourad|desgaste|marca vis[ií]vel|danos f[ií]sicos vis[ií]veis que|tipos de dano|pontos de quebra/,
  },
  {
    id: 'incompatibilidade', nome: 'Incompatibilidade', categoria: 'anuncio',
    descricao: 'Não serve, não encaixa ou não é compatível com o equipamento do cliente.',
    regra: /incompat|n[ãa]o serve|n[ãa]o servi|n[ãa]o encaixa|maior do que|furos de montagem|comprou errado|n[ãa]o era compat|n[ãa]o foi compat|[ée] menor/,
  },
  {
    id: 'divergente', nome: 'Produto divergente do anúncio', categoria: 'anuncio',
    descricao: 'Diferente do anúncio ou do escolhido: modelo, cor, tamanho, marca, peças faltando.',
    regra: /n[ãa]o [ée] igual|diferente|n[ãa]o est[áa] de acordo|n[ãa]o [ée] da cor|n[ãa]o [ée] do modelo|outro tipo|conector incorreto|marca origin|faltam partes|n[ãa]o tinha armazenamento|produto errado|modelo errado|itens faltando|n[ãa]o corresponde|ter recebido uma .* errad|recebeu (branco|preto)|erro no envio|diferen[çc]as/,
  },
  {
    id: 'defeito', nome: 'Defeito / não funciona', categoria: 'produto',
    descricao: 'Não liga, não funciona, teclas falhando, parou de funcionar.',
    regra: /n[ãa]o funcion|n[ãa]o liga|parou|pararam|teclas|defei|falha|n[ãa]o ligou|sendo reconhecid|n[ãa]o gera v[ií]deo|travamento|n[ãa]o carrega|apresentando problema|problema de alerta|n[ãa]o est[áa] reconhecendo|n[ãa]o est[áa] carregando|n[ãa]o est[áa] funcionando|som estava|erros de v[ií]deo|n[ãa]o durou|picos de luz|n[ãa]o obteve resultado|desligando/,
  },
  {
    id: 'arrependimento', nome: 'Arrependimento', categoria: 'cliente',
    descricao: 'Chegou em boas condições, mas o cliente não quer mais.',
    regra: /arrepend|n[ãa]o quer mais|n[ãa]o o quer mais|desistiu|reembolso|retorno de todas|mudei de ideia|solicitou uma devolu|n[ãa]o a quero mais|inadequado/,
  },
  {
    id: 'nao_especificado', nome: 'Problema não especificado', categoria: 'sem_detalhe',
    descricao: 'O cliente relatou "um problema" ou "um inconveniente", sem dizer qual.',
    regra: /relatou (um )?problema|inconveniente/,
  },
  {
    id: 'nao_informado', nome: 'Não informado', categoria: 'sem_detalhe',
    descricao: 'Campo de motivo vazio na planilha.',
    regra: null,
  },
  {
    id: 'outros', nome: 'Outros', categoria: 'sem_detalhe',
    descricao: 'Texto que nenhuma regra reconheceu. Vale revisar e criar regra.',
    regra: null,
  },
];

// Trechos que NEGAM dano e enganariam a regra de avaria
// ("a embalagem não estava danificada", "não há danos físicos visíveis").
const NEGACOES = /embalagem n[ãa]o estava danificada|n[ãa]o h[áa] danos f[ií]sicos vis[ií]veis/g;

export function classificarMotivo(texto) {
  const t = String(texto ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(NEGACOES, '');
  if (!t) return 'nao_informado';
  for (const g of GRUPOS) if (g.regra && g.regra.test(t)) return g.id;
  return 'outros';
}

// ---------------------------------------------------------------------------
// Leitura das abas
// ---------------------------------------------------------------------------

function normalizar(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Cabeçalho da planilha (normalizado) -> campo do registro.
// "Cliente" e "Nº de série" ficam de fora de propósito: o painel abre por link
// e não precisa expor nome de cliente.
const COLUNAS = {
  'identificacao rma': 'rma',
  'pedido': 'pedido',
  'pedido tiny': 'pedidoTiny',
  'sku': 'sku',
  'produto': 'produto',
  'motivo abertura de devolucao': 'motivoTexto',
  'motivo': 'motivoPlanilha',
  'observacoes/defeitos': 'observacoes',
  'resultado da requisicao': 'resultadoRequisicao',
  'quantidade devolvida': 'quantidade',
  'nota fiscal de saida': 'nfSaida',
  'emissao': 'emissaoSaida',
  'empresa': 'canal',
  'nota fiscal de entrada': 'nfEntrada',
  'data de entrada': 'dataEntrada',
  'laudo a.t.': 'laudo',
  'defeito': 'responsavel',
  'destino': 'destino',
  // Planilha PR (Sul e Trade): o destino vem em duas colunas. "Responsável" lá é
  // o nome de quem atendeu, não a responsabilidade, e fica de fora.
  'setor de destino': 'setorDestino',
  'destino final': 'destinoFinal',
};

const MESES = ['JANEIRO', 'FEVEREIRO', 'MARCO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];

// Data do Excel (número de dias desde 30/12/1899) ou texto dd/mm/aaaa -> aaaa-mm-dd.
export function paraDataIso(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(String(v).trim());
  if (m) {
    const ano = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${ano}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

function texto(v) {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return String(v).replace(/\s+/g, ' ').trim();
}

function numeroNota(v) {
  const s = texto(v).replace(/^'+/, '');
  const digitos = s.replace(/\D/g, '');
  return digitos ? String(Number(digitos)) : '';
}

// Padroniza variações de digitação ("Autorizada ", "Não autoizada", "Não autorizado").
function padronizarResultado(v) {
  const n = normalizar(v);
  if (!n) return '';
  if (/^nao auto|^negad/.test(n)) return 'Não autorizada';
  if (/^autoriz/.test(n)) return 'Autorizada';
  return texto(v);
}

function padronizarCanal(v) {
  const s = texto(v).toUpperCase();
  if (!s || s === '-') return 'Não informado';
  // Planilha PR: "ML SUL" / "ML TRADE" = Mercado Livre da filial (a filial sai à parte).
  if (/^ML (SUL|TRADE)$/.test(s)) return 'ML';
  return s;
}

// Planilha PR (Sul e Trade juntos): não há coluna de filial. "ML TRADE" e
// "Remessa" (NF de saída da série 13xxx–16xxx) são da Comp Trade; o resto (ML SUL,
// SHOPEE, LOJA, NF 6xxxx) é da Paulicomp Sul (confirmado pelo usuário em 16/11/2026).
// Empresa vazia: decide pela NF de saída (>= 50000 = Sul).
export function filialDaLinhaPr(empresa, nfSaida) {
  const s = texto(empresa).toUpperCase();
  if (/TRADE|REMESSA/.test(s)) return 'TRADE';
  if (s && s !== '-') return 'SUL';
  const nf = Number(nfSaida) || 0;
  if (nf >= 50000) return 'SUL';
  if (nf > 0) return 'TRADE';
  return 'SUL';
}

function padronizarResponsavel(v) {
  const n = normalizar(v);
  if (!n) return 'Não informado';
  if (n.startsWith('cliente')) return 'Cliente';
  if (n.startsWith('frete') || n.includes('transport')) return 'Frete';
  if (n.startsWith('fabrica') || n.includes('empresa')) return 'Fábrica/empresa';
  return texto(v);
}

function padronizarDestino(v) {
  const n = normalizar(v);
  if (!n) return 'Não informado';
  if (n.startsWith('voltou')) return 'Voltou ao estoque';
  if (n.startsWith('sucata')) return 'Sucata';
  return texto(v);
}

// Planilha PR: "Destino Final" (Sucata) manda; senão "Setor de Destino"
// (ESTOQUE = voltou ao estoque; A.T. = assistência técnica).
function destinoPr(setor, final) {
  const nf = normalizar(final);
  if (nf.startsWith('sucata')) return 'Sucata';
  if (nf) return texto(final);
  const ns = normalizar(setor);
  if (!ns) return 'Não informado';
  if (ns.startsWith('estoque')) return 'Voltou ao estoque';
  if (/^a\.?\s?t\.?$/.test(ns)) return 'Assistência técnica';
  return texto(setor);
}

export function lerRegistrosRma(abas) {
  const registros = [];
  const avisos = [];
  for (const aba of abas) {
    const idxMes = MESES.indexOf(normalizar(aba.nome).toUpperCase());
    // Cabeçalho = primeira linha (entre as 5 primeiras) que tenha uma coluna "SKU".
    const iCab = aba.linhas.slice(0, 5).findIndex(l => (l || []).some(c => normalizar(c) === 'sku'));
    if (iCab < 0) {
      if (aba.linhas.some(l => l && l.length)) avisos.push(`Aba "${aba.nome}" ignorada: não achei a coluna SKU.`);
      continue;
    }
    const cab = aba.linhas[iCab];
    const mapa = {};
    cab.forEach((c, i) => {
      const campo = COLUNAS[normalizar(c)];
      if (campo && mapa[campo] == null) mapa[campo] = i; // primeira coluna com o nome vale
    });
    for (let i = iCab + 1; i < aba.linhas.length; i++) {
      const l = aba.linhas[i] || [];
      const pega = campo => (mapa[campo] == null ? null : l[mapa[campo]]);
      const sku = texto(pega('sku'));
      if (!sku) continue;
      const qtd = Number(texto(pega('quantidade')).replace(',', '.'));
      // A coluna A não tem cabeçalho fixo, mas guarda a data de recebimento do RMA.
      const dataReceb = paraDataIso(l[0]);
      const dataEntrada = paraDataIso(pega('dataEntrada'));
      const motivoTexto = texto(pega('motivoTexto'));
      registros.push({
        aba: aba.nome,
        mes: idxMes >= 0 ? idxMes + 1 : null,
        linha: i + 1,
        data: dataEntrada || dataReceb,
        rma: texto(pega('rma')),
        pedido: texto(pega('pedido')).replace(/^'+/, ''),
        pedidoTiny: texto(pega('pedidoTiny')),
        sku,
        produto: texto(pega('produto')),
        motivoTexto,
        grupo: classificarMotivo(motivoTexto),
        motivoPlanilha: texto(pega('motivoPlanilha')).toUpperCase() || 'NÃO INFORMADO',
        observacoes: texto(pega('observacoes')),
        laudo: texto(pega('laudo')),
        resultadoRequisicao: padronizarResultado(pega('resultadoRequisicao')),
        // Quantidade vazia conta como 1 peça (cada linha é ao menos uma devolução).
        quantidade: Number.isFinite(qtd) && qtd > 0 ? qtd : 1,
        quantidadeInformada: Number.isFinite(qtd) && qtd > 0,
        nfSaida: numeroNota(pega('nfSaida')),
        emissaoSaida: paraDataIso(pega('emissaoSaida')),
        canal: padronizarCanal(pega('canal')),
        nfEntrada: numeroNota(pega('nfEntrada')),
        responsavel: padronizarResponsavel(pega('responsavel')),
        destino: mapa.destino == null && (mapa.setorDestino != null || mapa.destinoFinal != null)
          ? destinoPr(pega('setorDestino'), pega('destinoFinal'))
          : padronizarDestino(pega('destino')),
        // Só a planilha PR mistura filiais; a API filtra por este campo.
        filialPr: filialDaLinhaPr(pega('canal'), numeroNota(pega('nfSaida'))),
      });
    }
  }
  return { registros, avisos };
}
