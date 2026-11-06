# Teste de carga local — 06/11/2026

## Reprodução

```sh
docker compose up -d --scale api=3 --scale worker=2
bun run test:load
```

O script exige APIs e workers ativos. Usa PostgreSQL e SQS/LocalStack reais, sem mocks, e grava relatórios JSON independentes em `reports/`. Não limpa dados existentes. Cada execução cria 24 wallets e usa provider/transaction IDs exclusivos. Não executar simultaneamente com a suíte de integração ou outro gerador de carga.

Configuração por variáveis de ambiente:

| Variável | Padrão |
|---|---|
| LOAD_URLS | http://localhost:3000,http://localhost:3001,http://localhost:3002 |
| LOAD_REQUESTS | 300 requisições por cenário financeiro |
| LOAD_CONCURRENCY | 24 requisições em voo |
| LOAD_WALLETS | 20 wallets no cenário distribuído |
| LOAD_DRAIN_SECONDS | 90 segundos para drenagem da outbox |
| DATABASE_URL | Mesmo PostgreSQL das APIs; padrão local na porta 55432 |

Exemplo PowerShell: `$env:LOAD_REQUESTS='1000'; bun run test:load`. Remova a variável depois com `Remove-Item Env:LOAD_REQUESTS` para voltar ao padrão. Aumentar o volume exige ajustar o limite de drenagem. Código de saída não zero indica erro HTTP/transporte, inconsistência financeira ou outbox ainda pendente ao esgotar o prazo.

## Ambiente

- Gerador: Bun 1.3.11 no Windows 11 (10.0.26200).
- CPU: AMD Ryzen 7 5700X3D, 8 núcleos / 16 processadores lógicos; RAM do host: 31,91 GiB.
- Docker Engine 29.1.3; VM Docker: 16 CPUs e 16.718.688.256 bytes de memória (~15,57 GiB).
- PostgreSQL 17.11; LocalStack 4.10.0; três APIs NestJS/Bun e dois workers, sem limites de CPU por container.
- Gerador, banco, APIs, workers e emulador compartilham a mesma máquina; sem isolamento de ruído de outros processos. Sem autenticação ou TLS.
- O JSON inclui versões, configuração, containers, commit-base e indicação de arquivos locais não commitados. O banco já continha dados dos testes anteriores.

## Metodologia

Modelo fechado: cada cliente envia a próxima requisição após receber a anterior. Distribuição round-robin pelas três APIs. Warmup de 30 apostas com concorrência 5, excluído das estatísticas dos cenários. Depois: 300 apostas em uma wallet com concorrência 24; 300 apostas em 20 wallets com concorrência 24; 50 cópias da mesma aposta com concorrência 50. Cada aposta vale `0.01 BRL`, saldo inicial `100000.00 BRL`. Total por execução: 650 requisições medidas e 30 de warmup.

Latência client-side inclui envio, resposta e leitura do JSON. Timeout por requisição: 20s; erros de transporte e status inesperados entram no denominador da taxa de erro. Percentis pelo método nearest-rank, incluindo tentativas com falha. Throughput é requisições concluídas / duração da fase, não operações financeiras únicas: o cenário de duplicatas representa apenas um débito.

Conflitos: diferença da soma de `wager_lock_conflicts_total` das três APIs antes/depois da fase; mede timeout/deadlock/serialization failure, **não tempo aguardando locks**. Retries SQL são medidos separadamente. Zero conflitos nessa métrica não significa ausência de contenção.

Outbox: consulta SQL a cada ~1s, restrita às wallets desta execução, registra pendências e idade do evento não publicado mais antigo. Picos são amostrados, não máximos contínuos. Inclui abertura das wallets e warmup. Após HTTP terminar, aguarda drenagem e mede esse intervalo separadamente. A publicação por SQS permanece assíncrona e não entra na latência HTTP.

Verificação final: soma do ledger igual ao saldo, nenhum lançamento duplicado, valores esperados em centavos e exatamente um débito para as 50 duplicatas. O script também compara quantidade de débitos por wallet com o cenário planejado; ausência de efeito esperado falha a verificação.

## Resultados HTTP

| Execução | Cenário | RPS | p50 ms | p95 ms | p99 ms | Erros | Conflitos / retries SQL |
|---|---|---:|---:|---:|---:|---:|---:|
| 1 | Wallet disputada | 137,45 | 27,41 | 638,81 | 707,54 | 0% | 0 / 0 |
| 1 | 20 wallets | 1.090,07 | 19,24 | 39,21 | 56,55 | 0% | 0 / 0 |
| 1 | 50 duplicatas | 281,14 | 90,55 | 167,63 | 177,15 | 0% | 0 / 0 |
| 2 | Wallet disputada | 170,03 | 18,00 | 558,39 | 658,79 | 0% | 0 / 0 |
| 2 | 20 wallets | 1.223,29 | 17,51 | 28,34 | 43,58 | 0% | 0 / 0 |
| 2 | 50 duplicatas | 325,70 | 71,49 | 144,87 | 152,76 | 0% | 0 / 0 |

Cada execução teve 49 replays no cenário de duplicatas. Não foram calculados intervalos de confiança: duas execuções são insuficientes para estabelecer uma distribuição robusta de capacidade.

## Análise e limites

A wallet disputada apresenta uma cauda de latência significativamente maior, compatível com a serialização por lock da wallet. As wallets independentes permitem paralelismo maior. A ausência de timeout/deadlock não elimina esse custo de espera.

Na primeira execução, a outbox atingiu 1.228 pendências e 63,89s de idade máxima amostrada, terminou sem pendências e levou 65,89s para drenar após o fim das requisições. Esse resultado mostra que o throughput HTTP observado não é o throughput de publicação de eventos.

Na segunda execução, foram 1.238 pendências no pico, 63,70s de idade máxima amostrada e 65,52s de drenagem. Ambas terminaram com outbox vazia, reconciliação correta e um único débito para as duplicatas. Relatórios completos: [execução 1](reports/load-2026-11-06T04-33-01.755Z.json) e [execução 2](reports/load-2026-11-06T04-34-33.543Z.json).

Pelo código atual, cada worker aguarda seu ciclo que inclui long polling de consumo SQS e publica até 20 eventos por iteração. Essa é uma hipótese concreta para a drenagem mais lenta; confirmar causalidade exigiria outro experimento separando os loops. Este teste não alterou o worker para melhorar o número medido.

Os cenários distribuídos duraram menos de um segundo e o cenário de wallet disputada cerca de dois segundos: são **rajadas curtas**, úteis para comparação inicial e verificação de integridade, não prova de throughput sustentado, capacidade máxima, resistência de longa duração ou desempenho em AWS real. A ordem fixa dos cenários, cache aquecido e recursos compartilhados influenciam os resultados. O modelo fechado não corrige coordinated omission e pode subestimar latências sob uma taxa de chegada aberta. Um próximo experimento deve usar duração fixa de vários minutos, chegada aberta, coleta de CPU/IO e repetições adicionais.

## Após revisão e otimização dos workers

Executado o mesmo cenário (300 + 300 + 50 requisições), com loops independentes, índice adicional do ledger, usuário runtime restrito e dependências atualizadas. [JSON completo](reports/load-2026-11-06T04-56-29.345Z.json).

| Cenário | RPS | p50 ms | p95 ms | p99 ms | Erros | Conflitos / retries |
|---|---:|---:|---:|---:|---:|---:|
| Wallet disputada | 140,52 | 23,63 | 713,35 | 859,00 | 0% | 0 / 0 |
| 20 wallets | 1.026,15 | 19,98 | 37,50 | 56,65 | 0% | 0 / 0 |
| Duplicatas | 333,55 | 71,01 | 140,56 | 149,28 | 0% | 0 / 0 |

Outbox: pico amostrado de 482 pendências e 0,49s de idade do evento mais antigo; drenagem confirmada na checagem de 5,27s após HTTP (checagens de drenagem espaçadas em 5s, portanto não é o tempo exato até a última publicação). Zero pendências ao final, nenhuma divergência saldo/ledger, um débito e 49 replays nas duplicatas.

A melhora observada é na publicação assíncrona: antes cerca de 64s de lag amostrado e 66s até confirmação de drenagem. Não houve melhora consistente do HTTP; p99 da wallet disputada aumentou nesta execução. Como várias mudanças foram aplicadas e o ambiente não é isolado, não é possível atribuir toda a diferença a uma única alteração ou prometer o mesmo ganho em produção.
