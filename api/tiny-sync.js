// Vercel Serverless Function — proxy para a API v2 do Tiny ERP (Olist).
// Roda no servidor para evitar bloqueio de CORS no navegador e para nunca
// expor o token em requisições feitas por terceiros (o token só é repassado
// pelo próprio painel, num POST direto para esta função).

const TINY_BASE_URL = "https://api.tiny.com.br/api2/notas.fiscais.pesquisa.php";
const MAX_PAGES = 40; // proteção contra loops longos / consumo excessivo de cota da API

function toIsoDate(brDate) {
  // "dd/mm/yyyy" -> "yyyy-mm-dd"
  if (!brDate || typeof brDate !== "string" || !brDate.includes("/")) return null;
  const [d, m, y] = brDate.split("/");
  if (!d || !m || !y) return null;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function mapNota(nf, filial) {
  const cliente = nf.cliente || {};
  const entrega = nf.endereco_entrega || {};
  const transportador = nf.transportador || {};

  const situacaoTexto = (nf.descricao_situacao || "").toLowerCase();
  if (situacaoTexto.includes("cancelad")) return null;

  const dataIso = toIsoDate(nf.data_emissao);
  if (!dataIso) return null;

  const docLimpo = String(entrega.cpf_cnpj || cliente.cpf_cnpj || "").replace(/[^0-9]/g, "");
  const tipoPessoa = entrega.tipo_pessoa || cliente.tipo_pessoa;
  const tipo = tipoPessoa === "F" || (tipoPessoa !== "J" && docLimpo.length > 0 && docLimpo.length <= 11)
    ? "B2C (CPF)"
    : "B2B (CNPJ)";

  return {
    filial,
    data: dataIso,
    data_fmt: nf.data_emissao,
    nf: String(nf.numero || nf.id || "-"),
    cliente: entrega.nome_destinatario || cliente.nome || nf.nome || "-",
    tipo,
    canal: (transportador.nome && transportador.nome.trim()) || "Mercado Envios",
    uf: String(entrega.uf || cliente.uf || "SP").toUpperCase().trim(),
    cidade: entrega.cidade || cliente.cidade || "-",
  };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Método não permitido. Use POST." });
    return;
  }

  const { filial, token, dataInicial, dataFinal } = req.body || {};

  if (!filial || !token) {
    res.status(400).json({ ok: false, error: "Parâmetros obrigatórios ausentes: filial e token." });
    return;
  }

  try {
    const rows = [];
    let pagina = 1;
    let totalPaginas = 1;
    let statusApi = null;

    do {
      const params = new URLSearchParams({
        token,
        formato: "json",
        pagina: String(pagina),
      });
      if (dataInicial) params.set("dataInicial", dataInicial);
      if (dataFinal) params.set("dataFinal", dataFinal);

      const resp = await fetch(`${TINY_BASE_URL}?${params.toString()}`);
      const json = await resp.json();
      const retorno = json.retorno || {};
      statusApi = retorno.status;

      if (retorno.status === "Erro" || retorno.status === "erro") {
        const msg = (retorno.erros || []).map(e => e.erro).join("; ") || "Erro desconhecido na API do Tiny.";
        res.status(502).json({ ok: false, error: msg, filial });
        return;
      }

      totalPaginas = Number(retorno.numero_paginas || 1);
      (retorno.notas_fiscais || []).forEach(item => {
        const mapped = mapNota(item.nota_fiscal || {}, filial);
        if (mapped) rows.push(mapped);
      });

      pagina++;
    } while (pagina <= totalPaginas && pagina <= MAX_PAGES);

    res.status(200).json({
      ok: true,
      filial,
      status: statusApi,
      totalPaginas,
      paginasLidas: Math.min(totalPaginas, MAX_PAGES),
      truncado: totalPaginas > MAX_PAGES,
      rows,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: `Falha ao consultar a API do Tiny: ${err.message}`, filial });
  }
};
