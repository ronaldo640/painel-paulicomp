// Limpeza do veículo — funções usadas pelas duas telas (gestão e motorista):
// chave do link secreto, chamadas à API, datas, redução e envio de fotos.
(function () {
  var papelTela = document.documentElement.getAttribute('data-papel') || 'gestao';
  var CHAVE_LS = 'limpeza_chave_' + papelTela;

  // Chave digitada no campo desta tela; vale mais que a do endereço (?k=), que
  // pode ser antiga, e cobre o navegador que não deixa guardar nada.
  var digitada = '';

  function chave() {
    if (digitada) return digitada;
    var k = new URLSearchParams(location.search).get('k') || '';
    try {
      if (k) { localStorage.setItem(CHAVE_LS, k); return k; }
      return localStorage.getItem(CHAVE_LS) || '';
    } catch (e) { return k; }
  }

  function salvarChave(k) {
    digitada = k;
    try { localStorage.setItem(CHAVE_LS, k); } catch (e) {}
    try {
      var u = new URL(location.href);
      if (u.searchParams.has('k')) { u.searchParams.delete('k'); history.replaceState(null, '', u.pathname + u.search + u.hash); }
    } catch (e) {}
  }

  // Campo para digitar a chave uma vez só (fica guardada neste aparelho). Aparece
  // quando não há chave ou ela foi recusada; o texto fica visível de propósito.
  // aoSalvar() recarrega a tela; motivo é a explicação mostrada abaixo do campo.
  function pedirChave(aoSalvar, motivo) {
    var caixa = document.getElementById('acesso');
    if (!caixa) {
      caixa = document.createElement('form');
      caixa.id = 'acesso';
      caixa.className = 'card';
      caixa.setAttribute('autocomplete', 'off');
      caixa.innerHTML =
        '<h2>Acesso</h2>' +
        '<div class="field"><label for="acesso-k">Chave de acesso</label>' +
        '<input type="text" id="acesso-k" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Cole a chave aqui" required></div>' +
        '<button class="btn grande" type="submit">Entrar</button>' +
        '<p class="msg" id="acesso-msg" role="status"></p>' +
        '<span class="muted" style="font-size:.85rem">A chave fica guardada neste aparelho: você só digita uma vez.</span>';
      var ref = document.getElementById('erro');
      ref.parentNode.insertBefore(caixa, ref.nextSibling);
      caixa.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var k = document.getElementById('acesso-k').value.trim();
        if (!k) return;
        salvarChave(k);
        aoSalvar();
      });
    }
    caixa.hidden = false;
    document.getElementById('acesso-msg').textContent = motivo || '';
    document.getElementById('acesso-k').focus();
  }

  function fecharChave() {
    var caixa = document.getElementById('acesso');
    if (caixa) caixa.hidden = true;
  }

  async function api(caminho, opcoes) {
    opcoes = opcoes || {};
    var cab = Object.assign({ 'x-limpeza-key': chave() }, opcoes.headers || {});
    var r = await fetch(caminho, { method: opcoes.method || 'GET', headers: cab, body: opcoes.body });
    var j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (!r.ok) {
      var erro = new Error((j && j.error) || 'Erro ' + r.status);
      erro.status = r.status;      throw erro;
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
  // Reduz a foto do celular (lado maior 1280 px, JPEG 75%) antes de enviar: o
  // corpo da requisição na Vercel é limitado a 4,5 MB, e foto menor sobe e
  // abre mais rápido (e gasta menos da cota grátis do Blob).
  var LADO_MAX = 1280;
  var QUALIDADE = 0.75;
  async function reduzir(arquivo) {
    try {
      var bmp = await createImageBitmap(arquivo, { imageOrientation: 'from-image' });
      var escala = Math.min(1, LADO_MAX / Math.max(bmp.width, bmp.height));
      var c = document.createElement('canvas');
      c.width = Math.round(bmp.width * escala);
      c.height = Math.round(bmp.height * escala);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      var blob = await new Promise(function (ok) { c.toBlob(ok, 'image/jpeg', QUALIDADE); });
      return blob || arquivo;
    } catch (e) {
      return arquivo;
    }
  }

  async function enviarFoto(arquivo) {
    var blob = await reduzir(arquivo);
    var r = await api('/api/limpeza?acao=foto', { method: 'POST', headers: { 'content-type': blob.type || 'image/jpeg' }, body: blob });
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
    chave: chave, pedirChave: pedirChave, fecharChave: fecharChave, api: api, enviarJson: enviarJson,
    hojeTexto: hojeTexto, diasAte: diasAte, fmtLongo: fmtLongo, fmtCurto: fmtCurto, brl: brl,
    tipoNome: tipoNome, situacao: situacao, esc: esc,
    enviarFoto: enviarFoto, ligarAmpliacao: ligarAmpliacao,
  };
})();
