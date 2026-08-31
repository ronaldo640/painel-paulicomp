import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  // Configuração de CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const sql = neon(process.env.DATABASE_URL);

  // 1. GET: Retorna os registros do banco Neon
  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT 
          filial, 
          TO_CHAR(data, 'YYYY-MM-DD') AS data, 
          data_fmt, 
          nf, 
          cliente, 
          tipo, 
          canal, 
          uf, 
          cidade, 
          regiao, 
          dia_semana 
        FROM dispatches 
        ORDER BY data DESC, id DESC
      `;
      return res.status(200).json(rows);
    } catch (error) {
      console.error("Erro GET Neon:", error);
      return res.status(500).json({ error: error.message });
    }
  }

  // 2. POST: Insere registros em lote ignorando duplicatas (ON CONFLICT DO NOTHING)
  if (req.method === 'POST') {
    try {
      const records = req.body;
      if (!Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ error: 'Nenhum registro fornecido.' });
      }

      let insertedCount = 0;
      // Inserção em lotes seguros
      const batchSize = 100;
      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        
        for (const item of batch) {
          const result = await sql`
            INSERT INTO dispatches (
              filial, data, data_fmt, nf, cliente, tipo, canal, uf, cidade, regiao, dia_semana
            ) VALUES (
              ${item.filial}, 
              ${item.data}, 
              ${item.data_fmt}, 
              ${item.nf}, 
              ${item.cliente}, 
              ${item.tipo}, 
              ${item.canal}, 
              ${item.uf}, 
              ${item.cidade}, 
              ${item.regiao}, 
              ${item.dia_semana}
            )
            ON CONFLICT (filial, nf, data) DO NOTHING
            RETURNING id;
          `;
          if (result.length > 0) insertedCount++;
        }
      }

      return res.status(200).json({ inserted: insertedCount, totalSent: records.length });
    } catch (error) {
      console.error("Erro POST Neon:", error);
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: 'Método não permitido' });
}
