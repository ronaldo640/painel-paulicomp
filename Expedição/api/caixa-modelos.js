// Vercel Serverless Function — cadastro de modelos de caixa (catálogo
// compartilhado entre filiais: nome, medida, lead time, % de estoque de
// segurança). GET lista tudo, PUT atualiza lead time / % de um modelo,
// POST cria um modelo novo (ex: quando surgir uma 16ª embalagem).

import { neon } from '@neondatabase/serverless';

const FILIAIS = ['SP', 'TRADE']; // a Paulicomp Sul não entra: o estoque dela é o da Trade

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);

  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT id, nome, medida_mm, lead_time_dias, estoque_seguranca_pct, ativo
        FROM caixa_modelos
        ORDER BY nome
      `;
      // controla_estoque em query separada: tolerante à migração 008 pendente
      let semControle = new Set();
      try {
        const flags = await sql`SELECT id FROM caixa_modelos WHERE controla_estoque = false`;
        semControle = new Set(flags.map(f => f.id));
      } catch (err) {
        console.error('Coluna controla_estoque indisponível (migração 008 pendente?):', err.message);
      }
      // cobertura desejada / ponto de reposição manual (migração 009), idem
      const extras = new Map();
      try {
        const ex = await sql`SELECT id, cobertura_desejada_dias, ponto_reposicao_manual FROM caixa_modelos`;
        ex.forEach(e => extras.set(e.id, e));
      } catch (err) {
        console.error('Colunas de planejamento indisponíveis (migração 009 pendente?):', err.message);
      }
      // filiais em que cada modelo é controlado (migração 017); sem ela, todos são só da SP
      const filiaisPorId = new Map();
      try {
        const fl = await sql`SELECT id, filiais FROM caixa_modelos`;
        fl.forEach(f => filiaisPorId.set(f.id, f.filiais));
      } catch (err) {
        console.error('Coluna filiais indisponível (migração 017 pendente?):', err.message);
      }
      // parâmetros próprios da filial (migração 019): se existe linha, ela vale por inteiro
      const filialVista = req.query.filial ? String(req.query.filial).toUpperCase() : 'SP';
      const paramsFilial = new Map();
      if (filialVista !== 'SP') {
        try {
          const o = await sql`SELECT modelo_id, lead_time_dias, estoque_seguranca_pct, cobertura_desejada_dias, ponto_reposicao_manual FROM caixa_modelo_filial WHERE filial = ${filialVista}`;
          o.forEach(p => paramsFilial.set(p.modelo_id, p));
        } catch (err) {
          console.error('Tabela caixa_modelo_filial indisponível (migração 019 pendente?):', err.message);
        }
      }
      return res.status(200).json(rows.map(r => ({
        ...r,
        ...(paramsFilial.has(r.id) ? { lead_time_dias: paramsFilial.get(r.id).lead_time_dias, estoque_seguranca_pct: paramsFilial.get(r.id).estoque_seguranca_pct ?? r.estoque_seguranca_pct } : {}),
        filiais: filiaisPorId.get(r.id) || ['SP'],
        controla_estoque: !semControle.has(r.id),
        cobertura_desejada_dias: (paramsFilial.get(r.id) || extras.get(r.id))?.cobertura_desejada_dias ?? null,
        ponto_reposicao_manual: (paramsFilial.get(r.id) || extras.get(r.id))?.ponto_reposicao_manual ?? null,
      })));
    } catch (error) {
      console.error('Erro GET caixa_modelos:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const { nome, medida_mm, lead_time_dias, estoque_seguranca_pct } = req.body || {};
      if (!nome || !String(nome).trim()) {
        return res.status(400).json({ error: 'Campo "nome" é obrigatório.' });
      }
      const rows = await sql`
        INSERT INTO caixa_modelos (nome, medida_mm, lead_time_dias, estoque_seguranca_pct)
        VALUES (
          ${String(nome).trim()},
          ${medida_mm || null},
          ${lead_time_dias ?? null},
          ${estoque_seguranca_pct ?? 0.20}
        )
        RETURNING id, nome, medida_mm, lead_time_dias, estoque_seguranca_pct, ativo
      `;
      // modelo criado numa filial passa a ser controlado nela (migração 017)
      const filialCriacao = String(req.body.filial || 'SP').toUpperCase();
      if (FILIAIS.includes(filialCriacao) && filialCriacao !== 'SP') {
        await sql`UPDATE caixa_modelos SET filiais = ARRAY[${filialCriacao}]::text[] WHERE id = ${rows[0].id}`
          .catch(err => { if (!/filiais/.test(err.message || '')) throw err; });
      }
      return res.status(201).json(rows[0]);
    } catch (error) {
      console.error('Erro POST caixa_modelos:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method === 'PUT') {
    try {
      const { id, lead_time_dias, estoque_seguranca_pct, medida_mm, ativo, controla_estoque } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Campo "id" é obrigatório.' });

      // Estes dois aceitam null (limpar o campo), então o COALESCE usado
      // abaixo não serve: só são gravados se a chave veio no corpo.
      const body = req.body || {};

      // Fora da SP, prazo, margem, cobertura e quantidade por pedido são da filial
      // (migração 019): grava na tabela da filial e não mexe no catálogo.
      const filialPut = body.filial ? String(body.filial).toUpperCase() : 'SP';
      const foraDaSp = filialPut !== 'SP';
      if (foraDaSp && ['lead_time_dias', 'estoque_seguranca_pct', 'cobertura_desejada_dias', 'ponto_reposicao_manual'].some(k => k in body)) {
        const num = v => (v === null || v === '' || v === undefined ? null : Number(v));
        try {
          const [cat] = await sql`SELECT lead_time_dias, estoque_seguranca_pct::float AS estoque_seguranca_pct, cobertura_desejada_dias, ponto_reposicao_manual FROM caixa_modelos WHERE id = ${id}`;
          if (!cat) return res.status(404).json({ error: 'Modelo não encontrado.' });
          const [atual] = await sql`SELECT lead_time_dias, estoque_seguranca_pct::float AS estoque_seguranca_pct, cobertura_desejada_dias, ponto_reposicao_manual FROM caixa_modelo_filial WHERE modelo_id = ${id} AND filial = ${filialPut}`;
          const base = atual || cat;
          const lead = 'lead_time_dias' in body ? num(body.lead_time_dias) : base.lead_time_dias;
          const seg = 'estoque_seguranca_pct' in body && num(body.estoque_seguranca_pct) !== null ? num(body.estoque_seguranca_pct) : base.estoque_seguranca_pct;
          const cob = 'cobertura_desejada_dias' in body ? num(body.cobertura_desejada_dias) : base.cobertura_desejada_dias;
          const man = 'ponto_reposicao_manual' in body ? num(body.ponto_reposicao_manual) : base.ponto_reposicao_manual;
          for (const v of [cob, man]) {
            if (v !== null && (!Number.isInteger(v) || v < 0)) {
              return res.status(400).json({ error: 'Cobertura desejada e quantidade por pedido devem ser inteiros maiores ou iguais a zero.' });
            }
          }
          await sql`
            INSERT INTO caixa_modelo_filial (modelo_id, filial, lead_time_dias, estoque_seguranca_pct, cobertura_desejada_dias, ponto_reposicao_manual)
            VALUES (${id}, ${filialPut}, ${lead}, ${seg}, ${cob}, ${man})
            ON CONFLICT (modelo_id, filial) DO UPDATE SET lead_time_dias = EXCLUDED.lead_time_dias, estoque_seguranca_pct = EXCLUDED.estoque_seguranca_pct,
              cobertura_desejada_dias = EXCLUDED.cobertura_desejada_dias, ponto_reposicao_manual = EXCLUDED.ponto_reposicao_manual`;
        } catch (err) {
          if (/caixa_modelo_filial/.test(err.message || '')) {
            return res.status(400).json({ error: 'Migração 019 pendente: rode sql/019_parametros_por_filial.sql no Neon.' });
          }
          throw err;
        }
      }

      if (!foraDaSp && ('cobertura_desejada_dias' in body || 'ponto_reposicao_manual' in body)) {
        const num = v => (v === null || v === '' || v === undefined ? null : Number(v));
        const cob = num(body.cobertura_desejada_dias);
        const man = num(body.ponto_reposicao_manual);
        for (const v of [cob, man]) {
          if (v !== null && (!Number.isInteger(v) || v < 0)) {
            return res.status(400).json({ error: 'Cobertura desejada e ponto de reposição manual devem ser inteiros maiores ou iguais a zero.' });
          }
        }
        try {
          if ('cobertura_desejada_dias' in body) await sql`UPDATE caixa_modelos SET cobertura_desejada_dias = ${cob} WHERE id = ${id}`;
          if ('ponto_reposicao_manual' in body) await sql`UPDATE caixa_modelos SET ponto_reposicao_manual = ${man} WHERE id = ${id}`;
        } catch (err) {
          if (/cobertura_desejada|ponto_reposicao_manual/.test(err.message)) {
            return res.status(400).json({ error: 'Migração 009 pendente: rode sql/009_caixa_compras.sql no Neon antes de alterar cobertura/ponto de reposição.' });
          }
          throw err;
        }
      }

      if ('filiais' in body) {
        const filiais = (Array.isArray(body.filiais) ? body.filiais : []).map(f => String(f).toUpperCase()).filter(f => FILIAIS.includes(f));
        try {
          await sql`UPDATE caixa_modelos SET filiais = ${filiais}::text[] WHERE id = ${id}`;
        } catch (err) {
          if (/filiais/.test(err.message)) {
            return res.status(400).json({ error: 'Migração 017 pendente: rode sql/017_filiais_trade.sql no Neon.' });
          }
          throw err;
        }
      }

      if (typeof controla_estoque === 'boolean') {
        try {
          await sql`UPDATE caixa_modelos SET controla_estoque = ${controla_estoque} WHERE id = ${id}`;
        } catch (err) {
          if (/controla_estoque/.test(err.message)) {
            return res.status(400).json({ error: 'Migração 008 pendente: rode sql/008_caixa_modelos_controla_estoque.sql no Neon antes de alterar "Controla estoque".' });
          }
          throw err;
        }
      }

      const rows = await sql`
        UPDATE caixa_modelos SET
          lead_time_dias = COALESCE(${foraDaSp ? null : (lead_time_dias ?? null)}, lead_time_dias),
          estoque_seguranca_pct = COALESCE(${foraDaSp ? null : (estoque_seguranca_pct ?? null)}, estoque_seguranca_pct),
          medida_mm = COALESCE(${medida_mm ?? null}, medida_mm),
          ativo = COALESCE(${ativo ?? null}, ativo)
        WHERE id = ${id}
        RETURNING id, nome, medida_mm, lead_time_dias, estoque_seguranca_pct, ativo
      `;
      if (rows.length === 0) return res.status(404).json({ error: 'Modelo não encontrado.' });
      return res.status(200).json(rows[0]);
    } catch (error) {
      console.error('Erro PUT caixa_modelos:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: 'Método não permitido.' });
}
