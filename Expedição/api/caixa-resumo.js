// Vercel Serverless Function — resumo por modelo de caixa para uma filial:
// estoque atual, consumo médio (7 e 30 dias), ponto de reposição (consumo
// x lead time + margem de segurança), cobertura em dias e status de
// urgência de compra. É o que alimenta os KPIs, o ranking, o gráfico e a
// tabela da aba "Controle de Caixas".

import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);

  // Marca TODAS as pendências abertas de um SKU como resolvidas — o alerta
  // agrupa por SKU (não por nota), então dispensar precisa limpar todas as
  // ocorrências de uma vez, não só a que estava sendo exibida.
  if (req.method === 'POST') {
    try {
      const { sku, filial: filialBody } = req.body || {};
      if (!sku) return res.status(400).json({ error: 'Campo "sku" é obrigatório.' });
      const filialResolver = filialBody ? String(filialBody).toUpperCase() : 'SP';
      await sql`UPDATE caixa_auto_pendencias SET resolvida = true WHERE sku = ${sku} AND filial = ${filialResolver} AND resolvida = false`;
      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error('Erro POST caixa-resumo (resolver pendência):', error);
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido.' });

  const filial = req.query.filial ? String(req.query.filial).toUpperCase() : 'SP';

  try {
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
        WHERE filial = ${filial} AND tipo = 'saida' AND conta_estoque = true AND data >= current_date - interval '30 days'
        GROUP BY modelo_id
      ),
      consumo7 AS (
        SELECT modelo_id, SUM(quantidade)::numeric / 7 AS consumo_7d
        FROM caixa_movimentacoes
        WHERE filial = ${filial} AND tipo = 'saida' AND conta_estoque = true AND data >= current_date - interval '7 days'
        GROUP BY modelo_id
      ),
      consumo_prev7 AS (
        SELECT modelo_id, SUM(quantidade)::numeric / 7 AS consumo_prev7d
        FROM caixa_movimentacoes
        WHERE filial = ${filial} AND tipo = 'saida' AND conta_estoque = true
          AND data >= current_date - interval '14 days' AND data < current_date - interval '7 days'
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
      WHERE filial = ${filial} AND tipo = 'saida' AND conta_estoque = true
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
    const limitePendencias = Math.min(Number(req.query.limitePendencias) || 50, 5000);
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

    const modelos = rows.map(r => {
      const estoqueSeguranca = r.consumo_30d * (r.lead_time_dias || 0) * Number(r.estoque_seguranca_pct);
      const pontoReposicao = r.lead_time_dias
        ? r.consumo_30d * r.lead_time_dias + estoqueSeguranca
        : null;
      const coberturaDias = r.consumo_30d > 0 ? r.estoque_atual / r.consumo_30d : null;

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
        estoque_seguranca_un: Math.round(estoqueSeguranca),
        ponto_reposicao: pontoReposicao !== null ? Math.round(pontoReposicao) : null,
        cobertura_dias: coberturaDias !== null ? Math.round(coberturaDias) : null,
        tendencia_pct: tendenciaPct !== null ? Math.round(tendenciaPct) : null,
        status, // 'crit' | 'warn' | 'ok' | 'sem_config' (falta cadastrar lead time)
      };
    });

    const urgencia = { crit: 0, warn: 1, sem_config: 2, ok: 3 };
    modelos.sort((a, b) => {
      const u = urgencia[a.status] - urgencia[b.status];
      if (u !== 0) return u;
      if (a.cobertura_dias === null) return 1;
      if (b.cobertura_dias === null) return -1;
      return a.cobertura_dias - b.cobertura_dias;
    });

    return res.status(200).json({ filial, ultima_saida, modelos, pendencias_regra: pendenciasRegra });
  } catch (error) {
    console.error('Erro GET caixa-resumo:', error);
    return res.status(500).json({ error: error.message });
  }
}
