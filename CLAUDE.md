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
   a cada chamada (`apiHandler`). Não voltar ao comportamento do template, que
   emitia token para qualquer conta.
4. **Limites do plano Free**: orçamento de 40 chamadas por requisição e
   `MAX_PERIOD_DAYS` por análise. Ferramenta nova que pagina precisa respeitar
   `client.callsRemaining`.
5. **Credencial nunca em argumento de linha de comando, log ou mensagem de
   erro.** Segredos só por `wrangler secret put` (que pergunta o valor).
6. **Documentação da Cloudbeds é a fonte da verdade, e a resposta real é o
   juiz.** Divergência entre a documentação e a resposta real: pare e reporte,
   não adapte em silêncio. A lista de pontos em aberto está no fim do README.

## Comandos

- `npm run check` — tipos + testes (obrigatório verde antes de deploy)
- `npm run dev` — Worker local em `http://localhost:8788/mcp`
- `npm run deploy` — check + deploy
- `npm run cf-typegen` — regenerar `worker-configuration.d.ts` após mudar `wrangler.jsonc`

## Estrutura

- `src/index.ts` — OAuthProvider, allowlist por chamada, criação do servidor MCP
- `src/auth/` — login via GitHub (adaptado do template oficial da Cloudflare)
- `src/cloudbeds/client.ts` — HTTP, orçamento de chamadas, espaçamento, erros
- `src/cloudbeds/endpoints.ts` — endpoints de leitura e tipos
- `src/analytics/` — datas e métricas (funções puras)
- `src/tools/` — registro das ferramentas MCP e análises
- `src/privacy.ts` — minimização de dados pessoais
- `test/` — testes com Cloudbeds simulada
