# AGENTS.md

Veja o `CLAUDE.md` para o contexto completo do projeto (comandos, arquitetura,
invariantes e regras de idioma). Vale para qualquer assistente de código.

<!-- INSFORGE:START -->
## Backend InsForge

Este projeto usa o [InsForge](https://insforge.dev), um backend (BaaS) de
código aberto sobre Postgres que oferece banco de dados, autenticação,
armazenamento de arquivos, edge functions, realtime, gateway de modelos de IA
e pagamentos numa única plataforma.

- **Projeto:** cada dono roda o seu próprio projeto InsForge. A URL base da
  API tem o formato `https://seu-projeto.insforge.app`; leia o valor real em
  `.insforge/project.json` ou `.env.local` em vez de fixá-lo aqui.
- **Skills:** estas skills do InsForge estão instaladas nos assistentes
  compatíveis. Use-as antes de implementar qualquer recurso do InsForge, em
  vez de adivinhar a API:
  - `insforge`: código de app com o cliente `@insforge/sdk` (CRUD no banco,
    autenticação, armazenamento, edge functions, realtime, IA, e-mail e
    pagamentos com Stripe).
  - `insforge-cli`: backend e infraestrutura pela CLI `insforge` (projetos,
    SQL, migrations, políticas RLS, buckets, funções, segredos, pagamentos,
    agendamentos, deploys).
  - `insforge-debug`: diagnóstico de falhas (erros de SDK/HTTP, negações de
    RLS, problemas de autenticação e OAuth) e auditorias de segurança ou
    desempenho.
  - `insforge-integrations`: integração com provedores de autenticação
    externos (Clerk, Auth0, WorkOS, Better Auth etc.) para RLS com JWT, ou com
    o facilitador de pagamentos OKX x402.
  - `find-skills`: descobrir outras skills quando necessário.
- **Credenciais:** o código de app lê as chaves do `.env.local`; a CLI lê o
  `.insforge/project.json`. Nunca fixe chaves no código nem as coloque em
  commits.

Padrões importantes:

- Inserções no banco recebem um array: `insert([{ ... }])`.
- Referencie usuários com `auth.users(id)`; use `auth.uid()` nas políticas
  RLS.
- Em uploads para o armazenamento, guarde tanto a `url` quanto a `key`
  devolvidas.
<!-- INSFORGE:END -->
