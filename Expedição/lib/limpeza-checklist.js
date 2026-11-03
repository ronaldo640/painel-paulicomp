// Checklist de início do dia da Fiorino: itens, data de hoje e validação do envio.
// Usado por api/limpeza.js (gravar) e lib/limpeza-alerta.js (e-mail de problema).
// A tela do motorista recebe a lista de itens pela API, então o texto mora só aqui.

export const ITENS = [
  { id: 'oleo',     nome: 'Óleo do motor',        dica: 'Nível na vareta, motor frio e carro em piso plano' },
  { id: 'radiador', nome: 'Água do radiador',     dica: 'Reservatório entre MIN e MAX, com o motor frio' },
  { id: 'limpador', nome: 'Água do limpador',     dica: 'Reservatório com líquido' },
  { id: 'palhetas', nome: 'Palhetas do limpador', dica: 'Limpam o vidro sem deixar riscos' },
  { id: 'pneus',    nome: 'Pneus',                dica: 'Sem estar murcho, com bolha ou corte' },
  { id: 'luzes',    nome: 'Luzes',                dica: 'Farol, lanterna, seta, freio e ré' },
  { id: 'painel',   nome: 'Luzes do painel',      dica: 'Nenhuma luz de alerta acesa depois de ligar' },
  { id: 'freio',    nome: 'Freio',                dica: 'Pedal firme, sem afundar' },
  { id: 'combust',  nome: 'Combustível',          dica: 'Suficiente para a rota de hoje' },
  { id: 'lataria',  nome: 'Lataria e vidros',     dica: 'Sem amassado, risco ou trinca nova' },
];

export const MAX_FOTOS_ITEM = 3;
export const MAX_KM = 2000000;

export const nomeDoItem = (id) => (ITENS.find((i) => i.id === id) || { nome: id }).nome;

// Data de hoje no horário de Brasília, como AAAA-MM-DD.
export function hojeBrasilia() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

// Confere o corpo do envio e devolve { erro } ou { motorista, km, itens }, com os
// itens na ordem da lista. `fotosOk(lista)` diz se os endereços são do nosso Blob.
export function validarChecklist(b, fotosOk) {
  const motorista = String((b && b.motorista) || '').trim().slice(0, 60);
  const km = Number(b && b.km);
  if (!motorista) return { erro: 'Informe seu nome.' };
  if (!Number.isInteger(km) || km <= 0 || km > MAX_KM) return { erro: 'Km do painel inválido.' };
  const enviados = (b && b.itens) || {};
  const itens = [];
  for (const it of ITENS) {
    const r = enviados[it.id];
    if (!r || (r.status !== 'ok' && r.status !== 'problema')) return { erro: `Responda o item "${it.nome}".` };
    if (r.status === 'ok') { itens.push({ id: it.id, status: 'ok', fotos: [] }); continue; }
    const fotos = r.fotos;
    if (!Array.isArray(fotos) || !fotos.length) return { erro: `Tire uma foto do problema em "${it.nome}".` };
    if (fotos.length > MAX_FOTOS_ITEM || !fotosOk(fotos)) return { erro: `Fotos inválidas em "${it.nome}".` };
    itens.push({ id: it.id, status: 'problema', fotos });
  }
  return { motorista, km, itens };
}
