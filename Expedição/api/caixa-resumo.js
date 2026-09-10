// Vercel Serverless Function — resumo por modelo de caixa para uma filial:
// estoque atual, consumo médio (7 e 30 dias), ponto de reposição (consumo
// x lead time + margem de segurança), cobertura em dias e status de
// urgência de compra. É o que alimenta os KPIs, o ranking, o gráfico e a
// tabela da aba "Controle de Caixas".

import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido.' });

  const sql = neon(process.env.DATABASE_URL);
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
        WHERE filial = ${filial}
        GROUP BY modelo_id
      ),
      consumo30 AS (
        SELECT modelo_id, SUM(quantidade)::numeric / 30 AS consumo_30d
        FROM caixa_movimentacoes
        WHERE filial = ${filial} AND tipo = 'saida' AND data >= current_date - interval '30 days'
        GROUP BY modelo_id
      ),
      consumo7 AS (
        SELECT modelo_id, SUM(quantidade)::numeric / 7 AS consumo_7d
        FROM caixa_movimentacoes
        WHERE filial = ${filial} AND tipo = 'saida' AND data >= current_date - interval '7 days'
        GROUP BY modelo_id
      ),
      consumo_prev7 AS (
        SELECT modelo_id, SUM(quantidade)::numeric / 7 AS consumo_prev7d
        FROM caixa_movimentacoes
        WHERE filial = ${filial} AND tipo = 'saida'
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
      WHERE filial = ${filial} AND tipo = 'saida'
    `;

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

    return res.status(200).json({ filial, ultima_saida, modelos });
  } catch (error) {
    console.error('Erro GET caixa-resumo:', error);
    return res.status(500).json({ error: error.message });
  }
}
