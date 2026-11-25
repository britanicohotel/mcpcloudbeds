# CLAUDE.md — cloudbeds-mcp

Conector MCP remoto (Cloudflare Workers, plano Free) que dá ao Claude leitura da
Cloudbeds do Hotel Britânico (propriedade 7830). Instruções de implantação no
`README.md`.

## Regras invioláveis

1. **Só leitura.** O cliente (`src/cloudbeds/client.ts`) só faz GET na API
   clássica; o único POST é a consulta da Insights API. Qualquer ferramenta de
   escrita exige decisão explícita do Nino, allowlist própria de endpoints,
   chave separada com escopo `write:*` e confirmação na ferramenta.
2. **Dados pessoais por lista de permitidos.** Toda reserva passa por
   `sanitizeReservation`. Campo novo só sai se for acrescentado à lista, com
   motivo. Documento, nascimento, endereço, CPF/taxID, cartões e campos
   personalizados nunca saem.
3. **A allowlist do GitHub barra antes de emitir token** (`/callback`) e de novo
   a cada chamada (`withAllowlist` em `src/auth/gate.ts`). A segunda barreira
   lê as props do token em `ctx.props`: `getMcpAuthContext()` devolve undefined
   nesse ponto, e foi isso que barrou todo mundo até 24/11/2026. Não voltar ao
   comportamento do template, que emitia token para qualquer conta.
4. **Limites do plano Free**: orçamento de 40 chamadas por requisição e
   `MAX_PERIOD_DAYS` por análise. Ferramenta nova que pagina precisa respeitar
   `client.callsRemaining`.
5. **Credencial nunca em argumento de linha de comando, log ou mensagem de
   erro.** Segredos só por `wrangler secret put` (que pergunta o valor), por
   pipe ou pelo painel da Cloudflare, sempre como tipo **Secret**.
   `secrets.required` no `wrangler.jsonc` lista só GITHUB_CLIENT_ID,
   GITHUB_CLIENT_SECRET e COOKIE_ENCRYPTION_KEY. A lista controla ao mesmo
   tempo a trava do deploy, os tipos gerados e a leitura do `.dev.vars`.
   CLOUDBEDS_API_KEY e CLOUDBEDS_WEBHOOK_SECRET podem faltar e ficam fora dela,
   tipados como opcionais em `src/env.d.ts`.
6. **Documentação da Cloudbeds é a fonte da verdade, e a resposta real é o
   juiz.** Divergência entre a documentação e a resposta real: pare e reporte,
   não adapte em silêncio. A lista de pontos em aberto está no fim do README.

## Comandos

- `npm run check` — tipos + testes (obrigatório verde antes de deploy)
- `npm run dev` — Worker local em `http://localhost:8788/mcp`
- `npm run deploy` — check + deploy
- `npm run cf-typegen` — regenerar `worker-configuration.d.ts` após mudar `wrangler.jsonc`

## Estrutura

- `ESTADO.md` — onde parou, fases, decisões e suposições a verificar com a chave
- `src/index.ts` — OAuthProvider e criação do servidor MCP
- `src/env.d.ts` — segredos opcionais, tipados à mão (fora de `secrets.required`)
- `src/auth/` — login via GitHub (adaptado do template oficial da Cloudflare) e
  `gate.ts`, a allowlist por chamada
- `src/cloudbeds/client.ts` — HTTP, orçamento de chamadas, espaçamento, erros
- `src/cloudbeds/endpoints.ts` — endpoints de leitura e tipos
- `src/analytics/` — datas e métricas (funções puras)
- `src/tools/` — registro das ferramentas MCP e análises
- `src/privacy.ts` — minimização de dados pessoais
- `test/` — testes com Cloudbeds simulada
