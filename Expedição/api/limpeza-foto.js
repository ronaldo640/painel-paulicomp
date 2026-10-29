// Vercel Serverless Function — recebe UMA foto da limpeza do veículo e grava no
// Vercel Blob. Devolve o endereço, que depois vai junto no registro da limpeza
// (/api/limpeza). O navegador reduz a foto antes (lado maior 1600 px, JPEG),
// então ela chega bem abaixo do limite de 4,5 MB do corpo da requisição.
//
// Variável de ambiente: BLOB_READ_WRITE_TOKEN (criada pela Vercel ao conectar
// o Blob ao projeto).

import { put } from '@vercel/blob';
import { papel } from '../lib/limpeza-auth.js';

// Lemos o corpo cru da requisição (a imagem), sem o parser de JSON da Vercel.
export const config = { api: { bodyParser: false } };

const TIPOS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_BYTES = 4 * 1024 * 1024;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
  if (!papel(req)) return res.status(401).json({ error: 'Link inválido ou expirado.' });

  const tipo = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const extensao = TIPOS[tipo];
  if (!extensao) return res.status(415).json({ error: 'Envie a foto em JPG, PNG ou WebP.' });

  const tamanho = parseInt(req.headers['content-length'] || '0', 10);
  if (!tamanho) return res.status(400).json({ error: 'Foto vazia.' });
  if (tamanho > MAX_BYTES) return res.status(413).json({ error: 'Foto grande demais (máximo 4 MB).' });

  try {
    const blob = await put(`limpeza-veiculo/foto.${extensao}`, req, {
      access: 'public',
      contentType: tipo,
      addRandomSuffix: true,
    });
    return res.status(200).json({ url: blob.url });
  } catch (error) {
    console.error('Erro em /api/limpeza-foto:', error);
    return res.status(500).json({ error: 'Não foi possível guardar a foto. Confira se o Blob está conectado ao projeto.' });
  }
}
