# Verificação automatizada

Ambiente: Bun 1.3.11, PostgreSQL 17 e LocalStack 4.10.0 em containers reais.

Execução final em 06/11/2026 após proteção dos logs: 73 testes unitários (179 assertions) e 28 de integração (225 assertions) passaram, sem falhas. Integração: 77,21 segundos. TypeScript, `git diff --check` e `bun audit` também passaram, sem vulnerabilidades reportadas.

```sh
docker compose stop worker
docker compose build
docker compose run --rm migrate
bun run typecheck
bun run test
bun run test:integration
docker compose start worker
```

Os workers normais ficam parados durante a suíte para não disputarem suas mensagens. As APIs existentes podem permanecer ativas. Os testes abrem três processos adicionais nas portas 3101–3103. Não execute duas cópias da suíte de integração simultaneamente: elas compartilham as filas locais. Os dados de teste usam identidades novas e não apagam wallets anteriores.

A revisão posterior acrescentou sete cenários, totalizando 25 de integração: FAILED auditável, agendamento concorrente, falha SQL pós-publicação, crash do publisher, SIGTERM real em container Linux, permissões do usuário runtime e invisibilidade de outbox não confirmada. A imagem do worker deve estar atualizada e a rede Compose deve ser `backend-challenge_default`. O teste de migrations também verifica up/down do índice adicional.

A proteção dos logs acrescentou testes unitários de allowlist, pseudonimização, injeção de linhas, limites de tamanho, isolamento de contexto e falhas de inicialização sem credenciais. Três cenários adicionais de integração verificam o usuário nativo restrito e os logs de falha HTTP/SQS. A conexão administrativa da suíte é TEST_DATABASE_URL; o código financeiro usa separadamente DATABASE_URL com wagering_app por padrão.

## Cobertura por requisito

| Requisito | Verificação |
|---|---|
| Money: escala e precisão | Strings com duas casas, carries, centavos, valores além do inteiro seguro, comparações, zero, negação e imutabilidade |
| Arredondamento | Não há arredondamento implícito: `1.005`, `1.004`, `1.999` e outras escalas inválidas são rejeitadas |
| Entradas inválidas | NaN, Infinity, exponencial, negativos de entrada, strings vazias, espaços, tipos não string e formato inválido |
| Wallet | Abertura negativa, saldo insuficiente, zero, moeda divergente, saldo/version preservados após erro e ledger balanceado |
| BET/WIN/LOSS/REFUND/ROLLBACK | Contratos e políticas financeiras puras em unidade; efeitos persistidos e concorrência em integração |
| Idempotência divergente | Hash canônico e decisão NEW/REPLAY/REPROCESS/conflito em unidade; unicidade persistente e rollback da inbox em integração |
| Migrations | Up → down → up em schema isolado, revertido ao fim da transação de teste |
| Constraints | Rejeição de saldo negativo, divergência saldo/ledger e UPDATE/DELETE no ledger |
| Atomicidade | Trigger de teste força falha na outbox; saldo, transação, ledger e inbox são verificados após rollback |
| Inbox e redelivery | Mesma mensagem enviada novamente com nova deduplication ID SQS e apenas um efeito financeiro |
| Retry | Falha SQL real, rollback, backoff e redelivery; fila de eventos inexistente, retry de outbox e posterior recuperação |
| DLQ | Mensagem inválida transferida e efetivamente recebida da DLQ |
| 50 duplicatas paralelas | Promise.all no serviço e 50 HTTPs distribuídos entre três processos Bun reais |
| Disputa de saldo | Duas apostas de 80.00 contra 100.00: um sucesso, uma rejeição, saldo 20.00 e um débito |
| Wallets independentes | 20 wallets em paralelo e processamento de uma wallet enquanto outra permanece bloqueada |
| Publishers concorrentes | Chamadas simultâneas e dois processos independentes publicando a mesma outbox |
| Referência fora de ordem | REFUND antes da BET; reprocessamento após chegada da referência e rejeição após limite de espera |
| Crash/reinício | Consumidor encerra após commit antes do ack; aguarda 60s de visibilidade e novo processo consome a mesma mensagem |

Após **cada teste de integração**, uma consulta SQL independente compara todas as wallets com a soma de seus lançamentos. Qualquer divergência falha o teste. Cenários financeiros também verificam saldo esperado e/ou reconciliação diretamente.

Os testes de falha usam triggers temporários direcionados exclusivamente à wallet da fixture, removidos em `finally`. Não substituem PostgreSQL ou SQS por mocks. O hook de crash requer simultaneamente `NODE_ENV=test` e `TEST_CRASH_AFTER_COMMIT=1`.

`test/policy.test.ts` testa diretamente `src/domain/policy.ts`, sem PostgreSQL, SQS ou mocks de infraestrutura. Essas mesmas funções são chamadas por `processWager` após a leitura dos fatos sob lock. Cobertura: direção financeira dos cinco tipos, rollback de BET/WIN/REFUND, saldo insuficiente, player/moeda, referência ausente ou não processada, escopo por provider/player/wallet/rodada/moeda, tipo permitido, reversão integral e única, expiração por TTL/tentativas, teto de saldo e decisões de idempotência. Locks, unicidade SQL e persistência do replay continuam cobertos em integração.
