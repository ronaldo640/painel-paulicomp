// Service worker do app da Fiorino (limpeza + checklist do motorista).
// Só guarda as telas e os arquivos estáticos para abrir rápido e mostrar a tela
// mesmo sem sinal. NUNCA guarda a API (/api/*): registros e fotos sempre vão
// para a internet. A chave de acesso (?k=) nunca entra no cache: as telas são
// guardadas pelo caminho, sem o endereço completo.

var VERSAO = 'limpeza-v1';
var ESTATICOS = ['/limpeza.css', '/limpeza-comum.js', '/logo-empresa.png', '/icons/icon-192.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSAO)
      .then(function (c) { return Promise.all(ESTATICOS.map(function (u) { return c.add(u).catch(function () {}); })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (nomes) { return Promise.all(nomes.filter(function (n) { return n !== VERSAO; }).map(function (n) { return caches.delete(n); })); })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // fontes do Google etc.: segue direto
  if (url.pathname.indexOf('/api/') === 0) return;       // API: sempre rede

  // Telas: rede primeiro (deploy novo aparece na hora); sem sinal, usa a última guardada.
  if (req.mode === 'navigate') {
    var chave = new Request(url.pathname);
    e.respondWith(
      fetch(req).then(function (r) {
        if (r && r.ok) { var copia = r.clone(); caches.open(VERSAO).then(function (c) { c.put(chave, copia); }); }
        return r;
      }).catch(function () {
        return caches.match(chave).then(function (c) { return c || Response.error(); });
      })
    );
    return;
  }

  // Estáticos (css, js, imagens): usa o guardado e atualiza em segundo plano.
  e.respondWith(
    caches.open(VERSAO).then(function (c) {
      return c.match(req).then(function (guardado) {
        var rede = fetch(req).then(function (r) { if (r && r.ok) c.put(req, r.clone()); return r; }).catch(function () { return guardado; });
        return guardado || rede;
      });
    })
  );
});
