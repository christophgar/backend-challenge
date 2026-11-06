# Evidências de execução

`unit.log` e `integration.log` são cópias dos registros da execução de 06/11/2026, posterior à proteção dos logs: 73 testes unitários / 179 assertions e 28 testes de integração / 225 assertions, sem falhas. Não representam uma nova execução na preparação do commit.

Os logs de integração incluem eventos operacionais JSON com identificadores pseudonimizados por HMAC. Esses eventos não substituem o ledger financeiro. Um replay pode emitir novamente `transaction_committed` com a mesma identidade sem criar outro lançamento: o evento de log isolado não conta operações financeiras únicas.

Os três JSONs de carga em `reports/` preservam as medições históricas. Caminhos locais de usuário nos metadados do Docker foram substituídos por `<workspace>` para publicação; percentis, amostras, ambiente de execução e resultados não foram alterados. O commit-base e o estado dirty desses experimentos descrevem o instante da medição, anterior ao commit de entrega. Consulte `LOAD_TEST.md` para metodologia e limitações.

Os testes usam dados sintéticos locais. Credenciais padrão documentadas no código são exclusivamente de desenvolvimento; nenhum `.env` deve acompanhar a entrega.
