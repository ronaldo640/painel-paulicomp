// Limpeza do veículo — funções usadas pelas duas telas (gestão e motorista):
// chave do link secreto, chamadas à API, datas, redução e envio de fotos.
(function () {
  var papelTela = document.documentElement.getAttribute('data-papel') || 'gestao';
  var CHAVE_LS = 'limpeza_chave_' + papelTela;

  function chave() {
    var k = new URLSearchParams(location.search).get('k') || '';
    try {
      if (k) { localStorage.setItem(CHAVE_LS, k); return k; }
      return localStorage.getItem(CHAVE_LS) || '';
    } catch (e) { return k; }
  }

  async function api(caminho, opcoes) {
    opcoes = opcoes || {};
    var cab = Object.assign({ 'x-limpeza-key': chave() }, opcoes.headers || {});
    var r = await fetch(caminho, { method: opcoes.method || 'GET', headers: cab, body: opcoes.body });
    var j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (!r.ok) {
      var erro = new Error((j && j.error) || 'Erro ' + r.status);
      erro.status = r.status;
      throw erro;
    }
    return j;
  }

  function enviarJson(caminho, metodo, corpo) {
    return api(caminho, { method: metodo, headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
  }

  // ---------- datas ----------
  var pad = function (n) { return String(n).padStart(2, '0'); };
  function hojeTexto() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function paraData(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2], 12); }
  function diasAte(s) {
    var h = paraData(hojeTexto());
    return Math.round((paraData(s) - h) / 864e5);
  }
  function fmtLongo(s) {
    return paraData(s).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function fmtCurto(s) { var p = s.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  function brl(n) { return Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  function tipoNome(t) { return t === 'completa' ? 'Completa' : 'Simples'; }
  function situacao(s) {
    var n = diasAte(s);
    if (n < 0) return { cls: 'bad', texto: 'Atrasada há ' + (-n) + (n === -1 ? ' dia' : ' dias') };
    if (n === 0) return { cls: 'warn', texto: 'É hoje' };
    if (n <= 3) return { cls: 'warn', texto: 'Em ' + n + (n === 1 ? ' dia' : ' dias') };
    return { cls: 'ok', texto: 'Em ' + n + ' dias' };
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- fotos ----------
  // Reduz a foto do celular (lado maior 1600 px, JPEG 82%) antes de enviar:
  // o corpo da requisição na Vercel é limitado a 4,5 MB.
  async function reduzir(arquivo) {
    try {
      var bmp = await createImageBitmap(arquivo, { imageOrientation: 'from-image' });
      var escala = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      var c = document.createElement('canvas');
      c.width = Math.round(bmp.width * escala);
      c.height = Math.round(bmp.height * escala);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      var blob = await new Promise(function (ok) { c.toBlob(ok, 'image/jpeg', 0.82); });
      return blob || arquivo;
    } catch (e) {
      return arquivo;
    }
  }

  async function enviarFoto(arquivo) {
    var blob = await reduzir(arquivo);
    var r = await api('/api/limpeza-foto', { method: 'POST', headers: { 'content-type': blob.type || 'image/jpeg' }, body: blob });
    return r.url;
  }

  // ---------- ampliar foto ----------
  function ligarAmpliacao() {
    var lb = document.getElementById('lb');
    var img = document.getElementById('lb-img');
    function fechar() { lb.hidden = true; img.removeAttribute('src'); }
    lb.addEventListener('click', fechar);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !lb.hidden) fechar(); });
    return function abrir(url) { img.src = url; lb.hidden = false; document.getElementById('lb-x').focus(); };
  }

  window.Limpeza = {
    chave: chave, api: api, enviarJson: enviarJson,
    hojeTexto: hojeTexto, diasAte: diasAte, fmtLongo: fmtLongo, fmtCurto: fmtCurto, brl: brl,
    tipoNome: tipoNome, situacao: situacao, esc: esc,
    enviarFoto: enviarFoto, ligarAmpliacao: ligarAmpliacao,
  };
})();
