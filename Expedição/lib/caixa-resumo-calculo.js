// Cálculo do resumo por modelo de caixa (estoque, consumo, ponto de reposição,
// cobertura, status, pendências de regra). Fica em lib/ pra ser usado tanto
// por api/caixa-resumo.js (a tela) quanto pelo aviso por e-mail
// (lib/caixa-alerta.js), sem uma chamar a outra por HTTP.

export async function calcularResumo(sql, filial, limitePendencias) {
  const rows = await sql`
    WITH base AS (
      SELECT id, nome, medida_mm, lead_time_dias, estoque_seguranca_pct
      FROM caixa_modelos
      WHERE ativo = true
    ),
    estoque AS (
      SELECT modelo_id,
        SUM(CASE WHEN tipo = 'entrada' THEN quantidade ELSE -quantidade END) AS estoque_atual
      FROM caixa_movimentacoes
      WHERE filial = ${filial} AND conta_estoque = true
      GROUP BY modelo_id
    ),
    consumo30 AS (
      SELECT modelo_id, SUM(quantidade)::numeric / 30 AS consumo_30d
      FROM caixa_movimentacoes
      WHERE filial = ${filial} AND tipo = 'saida' AND conta_estoque = true AND conta_consumo = true AND data > current_date - interval '30 days'
      GROUP BY modelo_id
    ),
    consumo7 AS (
      SELECT modelo_id, SUM(quantidade)::numeric / 7 AS consumo_7d
      FROM caixa_movimentacoes
      WHERE filial = ${filial} AND tipo = 'saida' AND conta_estoque = true AND conta_consumo = true AND data > current_date - interval '7 days'
      GROUP BY modelo_id
    ),
    consumo_prev7 AS (
      SELECT modelo_id, SUM(quantidade)::numeric / 7 AS consumo_prev7d
      FROM caixa_movimentacoes
      WHERE filial = ${filial} AND tipo = 'saida' AND conta_estoque = true AND conta_consumo = true
        AND data > current_date - interval '14 days' AND data <= current_date - interval '7 days'
      GROUP BY modelo_id
    )
    SELECT
      b.id, b.nome, b.medida_mm, b.lead_time_dias, b.estoque_seguranca_pct,
      COALESCE(e.estoque_atual, 0)::int AS estoque_atual,
      COALESCE(c30.consumo_30d, 0)::float AS consumo_30d,
      COALESCE(c7.consumo_7d, 0)::float AS consumo_7d,
      COALESCE(cp7.consumo_prev7d, 0)::float AS consumo_prev7d
    FROM base b
    LEFT JOIN estoque e ON e.modelo_id = b.id
    LEFT JOIN consumo30 c30 ON c30.modelo_id = b.id
    LEFT JOIN consumo7 c7 ON c7.modelo_id = b.id
    LEFT JOIN consumo_prev7 cp7 ON cp7.modelo_id = b.id
    ORDER BY b.nome
  `;

  const [{ ultima_saida }] = await sql`
    SELECT TO_CHAR(MAX(data), 'YYYY-MM-DD') AS ultima_saida
    FROM caixa_movimentacoes
    WHERE filial = ${filial} AND tipo = 'saida' AND conta_estoque = true AND conta_consumo = true
  `;

  // Itens de notas processadas pela baixa automática que caíram sem
  // regra de embalagem (nem mapeamento padrão, nem faixa de qtd que
  // cubra o caso) — cada um vira um alerta convidando a criar a regra.
  // Agrupado por SKU (não por nota): o mesmo SKU sem mapeamento pode
  // vender várias vezes antes de alguém criar a regra, e listar uma
  // linha por venda só polui o alerta e sugere (errado) que precisaria
  // mapear várias vezes a mesma coisa. Try/catch isolado: se a tabela
  // ainda não existir (migração 007 não rodada), o resumo inteiro não
  // pode quebrar por causa disso.
  const limitePendencias = Math.min(Number(limitePendencias) || 50, 5000);
  let pendenciasRegra = [];
  try {
    // Limpeza defensiva: um SKU pode ter ganhado mapeamento por um
    // caminho que não passou pelo auto-resolve de api/caixa-regras.js
    // (ex: regra criada antes dessa lógica existir, ou um ajuste manual
    // direto no banco) — nesse caso a pendência "sem mapeamento" ficaria
    // presa pra sempre. Roda toda vez que o resumo é pedido: barato
    // (poucas linhas, índice em sku) e garante que o alerta nunca mostra
    // um SKU que já está mapeado.
    await sql`
      UPDATE caixa_auto_pendencias
      SET resolvida = true
      WHERE filial = ${filial} AND resolvida = false AND motivo = 'sem_mapeamento'
        AND sku IN (SELECT sku FROM produto_caixa)
    `;
    // Mesma ideia pra "fora da faixa": uma regra nova pode ter vindo a
    // cobrir uma quantidade que antes não tinha faixa nenhuma pra ela —
    // aqui não basta existir mapeamento, tem que existir uma regra ATIVA
    // pro SKU cuja faixa realmente inclua a quantidade daquela venda.
    await sql`
      UPDATE caixa_auto_pendencias p
      SET resolvida = true
      WHERE p.filial = ${filial} AND p.resolvida = false AND p.motivo = 'fora_da_faixa'
        AND EXISTS (
          SELECT 1
          FROM caixa_regra_produtos rp
          JOIN caixa_regras r ON r.id = rp.regra_id
          WHERE rp.sku = p.sku AND r.ativa = true
            AND (r.qtd_min IS NULL OR p.quantidade >= r.qtd_min)
            AND (r.qtd_max IS NULL OR p.quantidade <= r.qtd_max)
        )
    `;
    pendenciasRegra = await sql`
      WITH abertas AS (
        SELECT * FROM caixa_auto_pendencias
        WHERE filial = ${filial} AND resolvida = false
      ),
      recente AS (
        SELECT DISTINCT ON (sku) sku, nota_numero, descricao, data
        FROM abertas
        ORDER BY sku, data DESC, id DESC
      ),
      agregado AS (
        SELECT sku, COUNT(*) AS ocorrencias, SUM(quantidade) AS quantidade_total,
               STRING_AGG(DISTINCT motivo, ' / ') AS motivos
        FROM abertas
        GROUP BY sku
      )
      SELECT r.sku, r.descricao, r.nota_numero AS ultima_nf, TO_CHAR(r.data, 'YYYY-MM-DD') AS data,
             a.ocorrencias::int AS ocorrencias, a.quantidade_total::int AS quantidade_total, a.motivos
      FROM recente r
      JOIN agregado a ON a.sku = r.sku
      ORDER BY r.data DESC
      LIMIT ${limitePendencias}
    `;
  } catch (err) {
    console.error('Tabela caixa_auto_pendencias indisponível (migração 007 pendente?):', err.message);
  }

  // Modelos sem estoque controlado (embalagem original do produto ou
  // reaproveitada, ex: "Padrão 1"): o consumo aparece, mas estoque,
  // reposição e status de compra não se aplicam. Try/catch isolado: se a
  // coluna ainda não existir (migração 008 não rodada), todos os modelos
  // continuam controlados como antes.
  let semControle = new Set();
  try {
    const flagRows = await sql`SELECT id FROM caixa_modelos WHERE controla_estoque = false`;
    semControle = new Set(flagRows.map(f => f.id));
  } catch (err) {
    console.error('Coluna controla_estoque indisponível (migração 008 pendente?):', err.message);
  }

  // Planejamento de compras (migração 009): cobertura desejada e ponto de
  // reposição manual por modelo, e quantidade já pedida e ainda não
  // recebida. Também tolerante: sem a migração, tudo segue como antes.
  const planejamento = new Map();
  try {
    const pl = await sql`SELECT id, cobertura_desejada_dias, ponto_reposicao_manual FROM caixa_modelos`;
    pl.forEach(p => planejamento.set(p.id, p));
  } catch (err) {
    console.error('Colunas de planejamento indisponíveis (migração 009 pendente?):', err.message);
  }
  const emPedido = new Map();
  try {
    const ped = await sql`
      SELECT modelo_id, SUM(quantidade)::int AS qtd
      FROM caixa_compras
      WHERE filial = ${filial} AND status IN ('solicitado','em_transito')
      GROUP BY modelo_id`;
    ped.forEach(p => emPedido.set(p.modelo_id, p.qtd));
  } catch (err) {
    console.error('Tabela caixa_compras indisponível (migração 009 pendente?):', err.message);
  }

  // Envios ao Fulfillment lançados manualmente (migração 011): baixam o
  // estoque, mas ficam fora do "consumo real" (conta_consumo = false). Pro
  // planejamento de compra entram como consumo, numa janela maior (60
  // dias), porque o envio é em lote a cada 20-30 dias e uma janela de 30
  // dias oscilaria demais conforme caiu ou não um lote nela.
  const JANELA_ENVIO_FULFILLMENT = 60;
  const consumoFulfillment = new Map();
  try {
    const fl = await sql`
      SELECT modelo_id, SUM(quantidade)::numeric / ${JANELA_ENVIO_FULFILLMENT} AS por_dia
      FROM caixa_movimentacoes
      WHERE filial = ${filial} AND tipo = 'saida' AND envio_fulfillment = true
        AND data > current_date - ${JANELA_ENVIO_FULFILLMENT} * interval '1 day'
      GROUP BY modelo_id`;
    fl.forEach(f => consumoFulfillment.set(f.modelo_id, Number(f.por_dia)));
  } catch (err) {
    console.error('Coluna envio_fulfillment indisponível (migração 011 pendente?):', err.message);
  }

  const modelos = rows.map(r => {
    if (semControle.has(r.id)) {
      const tendencia = r.consumo_prev7d > 0 ? ((r.consumo_7d - r.consumo_prev7d) / r.consumo_prev7d) * 100 : null;
      return {
        id: r.id, nome: r.nome, medida_mm: r.medida_mm,
        lead_time_dias: null, estoque_seguranca_pct: Number(r.estoque_seguranca_pct),
        controla_estoque: false,
        estoque_atual: null,
        consumo_30d: Math.round(r.consumo_30d * 10) / 10,
        consumo_7d: Math.round(r.consumo_7d * 10) / 10,
        estoque_seguranca_un: 0, ponto_reposicao: null, cobertura_dias: null,
        tendencia_pct: tendencia !== null ? Math.round(tendencia) : null,
        status: 'nao_controlada',
      };
    }
    // Consumo usado no planejamento = consumo real (30d) + envios ao Fulfillment (60d).
    const consumoFulf = consumoFulfillment.get(r.id) || 0;
    const consumoPlan = r.consumo_30d + consumoFulf;
    const estoqueSeguranca = consumoPlan * (r.lead_time_dias || 0) * Number(r.estoque_seguranca_pct);
    const plan = planejamento.get(r.id) || {};
    // A coluna ponto_reposicao_manual (migração 009) guarda, na prática, a
    // QUANTIDADE PADRÃO DE CADA PEDIDO do modelo (o "lote"): é assim que
    // o usuário enxerga reposição. O gatilho de quando comprar continua
    // sendo sempre o cálculo: consumo x lead time + segurança.
    const qtdPedido = plan.ponto_reposicao_manual ?? null;
    const coberturaDesejada = plan.cobertura_desejada_dias ?? null;
    const qtdEmPedido = emPedido.get(r.id) || 0;
    const pontoReposicao = r.lead_time_dias ? consumoPlan * r.lead_time_dias + estoqueSeguranca : null;
    // Sugestão de compra: com quantidade por pedido definida, sugere um
    // lote quando o estoque (contando o que já está pedido) chegou no
    // ponto de reposição. Sem lote, cai na cobertura desejada.
    let sugestaoCompra = null;
    if (qtdPedido !== null) {
      sugestaoCompra = pontoReposicao !== null && r.estoque_atual + qtdEmPedido <= pontoReposicao ? qtdPedido : 0;
    } else if (coberturaDesejada !== null && consumoPlan > 0) {
      sugestaoCompra = Math.max(0, Math.ceil(consumoPlan * coberturaDesejada + estoqueSeguranca - r.estoque_atual - qtdEmPedido));
    }
    const coberturaDias = consumoPlan > 0 ? r.estoque_atual / consumoPlan : null;

    let status = 'sem_config';
    if (pontoReposicao !== null) {
      if (r.estoque_atual <= pontoReposicao) status = 'crit';
      else if (r.estoque_atual <= pontoReposicao * 1.3) status = 'warn';
      else status = 'ok';
    }

    const tendenciaPct = r.consumo_prev7d > 0
      ? ((r.consumo_7d - r.consumo_prev7d) / r.consumo_prev7d) * 100
      : null;

    return {
      id: r.id,
      nome: r.nome,
      medida_mm: r.medida_mm,
      lead_time_dias: r.lead_time_dias,
      estoque_seguranca_pct: Number(r.estoque_seguranca_pct),
      estoque_atual: r.estoque_atual,
      consumo_30d: Math.round(r.consumo_30d * 10) / 10,
      consumo_7d: Math.round(r.consumo_7d * 10) / 10,
      consumo_envio_fulfillment: Math.round(consumoFulf * 10) / 10,
      consumo_planejamento: Math.round(consumoPlan * 10) / 10,
      estoque_seguranca_un: Math.round(estoqueSeguranca),
      ponto_reposicao: pontoReposicao !== null ? Math.round(pontoReposicao) : null,
      cobertura_dias: coberturaDias !== null ? Math.round(coberturaDias) : null,
      tendencia_pct: tendenciaPct !== null ? Math.round(tendenciaPct) : null,
      cobertura_desejada_dias: coberturaDesejada,
      qtd_pedido: qtdPedido,
      em_pedido: qtdEmPedido,
      sugestao_compra: sugestaoCompra,
      status, // 'crit' | 'warn' | 'ok' | 'sem_config' (falta cadastrar lead time)
    };
  });

  const urgencia = { crit: 0, warn: 1, sem_config: 2, ok: 3, nao_controlada: 4 };
  modelos.sort((a, b) => {
    const u = urgencia[a.status] - urgencia[b.status];
    if (u !== 0) return u;
    if (a.cobertura_dias === null) return 1;
    if (b.cobertura_dias === null) return -1;
    return a.cobertura_dias - b.cobertura_dias;
  });


  return { filial, ultima_saida, modelos, pendencias_regra: pendenciasRegra };
}
