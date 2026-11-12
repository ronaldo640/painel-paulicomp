// Leitor mínimo de .xlsx, sem dependências: abre o zip, lê as abas e devolve
// os valores das células. Serve para a planilha de devoluções (RMA), que fica
// no Drive como .xlsx. Não lê fórmulas nem formatação, só o valor gravado.
//
// A descompactação vem de fora (inflateRaw), para o mesmo código rodar na
// Vercel (zlib do Node) e no navegador (DecompressionStream), onde é testado.
//
//   const abas = await lerXlsx(bytes, inflateRaw);
//   // [{ nome: 'JANEIRO', linhas: [['Data', 'SKU', ...], [...], ...] }, ...]

const decoder = new TextDecoder('utf-8');

function u16(b, p) { return b[p] | (b[p + 1] << 8); }
function u32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }

// Índice do zip: nome do arquivo -> onde estão os bytes e como foram gravados.
function indiceZip(b) {
  let fim = -1;
  for (let p = b.length - 22; p >= Math.max(0, b.length - 65557); p--) {
    if (u32(b, p) === 0x06054b50) { fim = p; break; }
  }
  if (fim < 0) throw new Error('O arquivo não parece ser um .xlsx (zip sem diretório central).');
  const total = u16(b, fim + 10);
  let p = u32(b, fim + 16);
  const arquivos = {};
  for (let i = 0; i < total; i++) {
    if (u32(b, p) !== 0x02014b50) throw new Error('Diretório do .xlsx corrompido.');
    const metodo = u16(b, p + 10);
    const tamCompactado = u32(b, p + 20);
    const lenNome = u16(b, p + 28), lenExtra = u16(b, p + 30), lenComent = u16(b, p + 32);
    const local = u32(b, p + 42);
    const nome = decoder.decode(b.subarray(p + 46, p + 46 + lenNome));
    arquivos[nome] = { metodo, tamCompactado, local };
    p += 46 + lenNome + lenExtra + lenComent;
  }
  return arquivos;
}

async function lerArquivo(b, arquivos, nome, inflateRaw) {
  const a = arquivos[nome];
  if (!a) return null;
  const inicio = a.local + 30 + u16(b, a.local + 26) + u16(b, a.local + 28);
  const dados = b.subarray(inicio, inicio + a.tamCompactado);
  if (a.metodo === 0) return decoder.decode(dados);
  if (a.metodo === 8) return decoder.decode(await inflateRaw(dados));
  throw new Error(`Compactação não suportada no .xlsx (método ${a.metodo}).`);
}

function desescapar(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'amp') return '&';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    return String.fromCodePoint(k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  });
}

function atributo(attrs, nome) {
  const m = new RegExp(`(?:^|\\s)${nome}="([^"]*)"`).exec(attrs);
  return m ? desescapar(m[1]) : null;
}

// Junta os trechos <t> de um <si> ou <is> (texto com formatação vem em vários <r>).
function textoRico(xml) {
  const semFonetica = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of semFonetica.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) out += desescapar(m[1] || '');
  return out;
}

function colunaParaIndice(ref) {
  const letras = /^[A-Z]+/.exec(ref || '');
  if (!letras) return -1;
  let n = 0;
  for (const ch of letras[0]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function lerAba(xml, compartilhadas) {
  const linhas = [];
  const dados = /<sheetData\b[^>]*?(?:\/>|>([\s\S]*?)<\/sheetData>)/.exec(xml);
  if (!dados || !dados[1]) return linhas;
  let proxLinha = 1;
  for (const r of dados[1].matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const numLinha = Number(atributo(r[1], 'r')) || proxLinha;
    proxLinha = numLinha + 1;
    const celulas = [];
    let proxCol = 0;
    for (const c of (r[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = atributo(c[1], 'r');
      const col = ref ? colunaParaIndice(ref) : proxCol;
      proxCol = col + 1;
      const tipo = atributo(c[1], 't');
      const corpo = c[2] || '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(corpo);
      let valor = null;
      if (tipo === 's') valor = v ? (compartilhadas[Number(v[1])] ?? '') : '';
      else if (tipo === 'inlineStr') valor = textoRico(corpo);
      else if (tipo === 'b') valor = v ? v[1] === '1' : null;
      else if (tipo === 'str' || tipo === 'e') valor = v ? desescapar(v[1]) : '';
      else if (v) { const n = Number(v[1]); valor = Number.isFinite(n) ? n : desescapar(v[1]); }
      celulas[col] = valor;
    }
    linhas[numLinha - 1] = celulas;
  }
  // Preenche buracos (linhas vazias que o Excel não grava) para o índice bater com o número da linha.
  for (let i = 0; i < linhas.length; i++) if (!linhas[i]) linhas[i] = [];
  return linhas;
}

export async function lerXlsx(bytes, inflateRaw) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const arquivos = indiceZip(b);

  const workbook = await lerArquivo(b, arquivos, 'xl/workbook.xml', inflateRaw);
  if (!workbook) throw new Error('O .xlsx não tem xl/workbook.xml.');
  const rels = (await lerArquivo(b, arquivos, 'xl/_rels/workbook.xml.rels', inflateRaw)) || '';
  const alvos = {};
  for (const m of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    alvos[atributo(m[1], 'Id')] = atributo(m[1], 'Target');
  }

  const sharedXml = (await lerArquivo(b, arquivos, 'xl/sharedStrings.xml', inflateRaw)) || '';
  const compartilhadas = [];
  for (const m of sharedXml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) compartilhadas.push(textoRico(m[1] || ''));

  const abas = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const nome = atributo(m[1], 'name');
    const rid = atributo(m[1], 'r:id');
    let alvo = alvos[rid];
    if (!alvo) continue;
    alvo = alvo.startsWith('/') ? alvo.slice(1) : `xl/${alvo}`;
    const xml = await lerArquivo(b, arquivos, alvo, inflateRaw);
    if (xml == null) continue;
    abas.push({ nome, linhas: lerAba(xml, compartilhadas) });
  }
  return abas;
}
