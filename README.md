# Painel Paulicomp — Expedição & Logística

Dashboard executivo estático (HTML + Tailwind + Chart.js), com uma função
serverless para sincronizar notas fiscais direto do Tiny ERP (Olist).

## Deploy na Vercel

1. Suba este repositório para o GitHub/GitLab.
2. Na Vercel, clique em **Add New → Project** e importe o repositório.
3. Framework preset: **Other**. Não é necessário configurar build command
   nem output directory — a Vercel detecta `index.html` na raiz e a pasta
   `api/` automaticamente.
4. Deploy. Pronto — o painel e a rota `/api/tiny-sync` sobem juntos.

## Integração com o Tiny ERP (Olist)

- Abra o painel → botão **Integração API (Tiny/Olist)**.
- Cole o token da API v2 de cada filial (gerado em Tiny → Preferências →
  API v2). Os tokens ficam salvos só no navegador (localStorage) e são
  enviados apenas para a própria função `/api/tiny-sync` deste projeto.
- Clique em **Sincronizar Agora**, ou ative a sincronização automática a
  cada 30 minutos.

## Controle de acesso à importação de planilhas

O primeiro acesso ao botão **Importar Planilha** pede a criação de um
usuário administrador (usuário + senha, com hash SHA-256 salvo no
navegador). Depois disso, qualquer importação de `.xls`/`.xlsx` exige
login. Usuários adicionais podem ser cadastrados em **Banco de Dados →
Gerenciar Usuários**.

> Como o painel não tem backend de autenticação, essa proteção evita uso
> descuidado por quem tem acesso ao link do dashboard — não substitui um
> controle de acesso real caso o painel vá lidar com dados sensíveis.

## Arquivos

- `index.html` — aplicação completa (single-file).
- `api/tiny-sync.js` — função serverless que consulta a API do Tiny e
  normaliza os dados para o formato do painel (evita bloqueio de CORS).
