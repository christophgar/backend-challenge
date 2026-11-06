# Revisão de correção, segurança e desempenho — 06/11/2026

Revisão baseada no enunciado original (GitHub HEAD c7143e6d041585d6913f56eb7415105e074f83dc), nas restrições da seção 5 e nas falhas eliminatórias. Esta revisão é de código e testes locais; não é certificação de segurança nem garantia de inexistência de outros defeitos.

## Correções

- Outbox: separado erro de envio de erro SQL após envio. O segundo aborta a transação do publisher e preserva retry, sem tentar reagendar objeto já marcado publicado.
- FAILED: erros SQL 22003/23514 após rollback geram resultado terminal auditável, inbox e evento, sem saldo/ledger. Falha de conexão ou commit ambíguo não é classificada como permanente; persistência indisponível continua sujeita a retry/DLQ.
- Referências: rechecagem de next_attempt_at dentro do lock da wallet impede que workers concorrentes consumam tentativas futuras.
- SIGTERM: loops param de iniciar trabalho, verificam parada entre itens de lote, concluem a mensagem em andamento e devolvem visibilidade se receberem nova mensagem após a parada.
- Métricas: a gravação de FAILED usa a mesma observação externa de latência, sem duplicar a observação na chamada de recuperação.

## Segurança

- API, PostgreSQL e LocalStack publicados apenas em 127.0.0.1; API nativa também usa localhost por padrão.
- Runtime PostgreSQL usa wagering_app, sem superuser/DDL e sem UPDATE/DELETE/TRUNCATE do ledger. Migrations usam usuário separado. Testes verificam inclusive proibição de desabilitar triggers.
- SQL parametrizado nos caminhos de produção; valores monetários exclusivamente bigint/string/numeric. Logs de aplicação não incluem payload financeiro completo. Valores de exemplo no Compose são credenciais locais, não segredos de produção.
- Auth permanece omitida conforme permitido pelo desafio; NODE_ENV=production é bloqueado até haver integração de IdP. Não foi implementada autenticação artesanal. Isso não torna a aplicação pronta para exposição pública.
- Auditoria inicial encontrou dependências transitivas vulneráveis. Overrides fixam glob 14.0.4, minimatch 11.0.5 e multer 2.5.0; lockfile atualizado, build e testes exercitam a compatibilidade. `bun audit` após atualização: nenhuma vulnerabilidade reportada na base consultada.
- Fontes consultadas: [minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249), [glob](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4), [multer](https://github.com/advisories/GHSA-q7qp-rjg7-q26m). Os overrides devem ser revistos quando as dependências diretas adotarem essas versões.

## Otimizações aplicadas

1. Loops independentes de consumo, publicação e referências: o long polling do consumidor não atrasa mais cada lote da outbox. Lotes disponíveis são drenados imediatamente; loop ocioso pausa 100ms.
2. Índice ledger(transaction_id), em migration adicional reversível, para o constraint trigger que verifica lançamentos da transação. Preservados os triggers deferred de igualdade saldo/ledger.
3. Eliminada consulta adicional da chave de idempotência durante a extração anterior das políticas; os fatos já vêm na consulta existente.

Mantidos: lock por wallet, constraints únicas, ledger imutável, transação única de saldo/ledger/inbox/outbox, publicação só de dados confirmados e dinheiro exato. Não foi usada deduplicação FIFO como garantia financeira, nem cache em memória ou lock global.

## Limites deliberados

O trigger ainda soma o histórico da wallet no commit. Removê-lo sem uma garantia equivalente enfraqueceria a restrição de consistência; qualquer substituição precisa de benchmark e prova por testes de concorrência. Publicação continua at-least-once e consumidores devem deduplicar eventId. O teste de carga é uma rajada curta, não capacidade sustentada. LocalStack não representa latência/custos/disponibilidade AWS real. Persistência do LocalStack entre recriações e ferramenta administrativa de replay de DLQ não fazem parte desta implementação local.

As mudanças permanecem no checkout local. Publicação em um repositório de entrega requer definir o destino; o origin atual é o repositório público do enunciado.

## Restrições verificadas

| Restrição do enunciado | Garantia preservada |
|---|---|
| Sem number/float/double monetário | Money usa bigint; JSON e driver usam strings; SQL usa numeric |
| Idempotência persistente | Chaves únicas, payloadHash, resultado e inbox no PostgreSQL |
| Não depender apenas de FIFO | Constraints e locks SQL permanecem a autoridade |
| Publicar após commit | Publisher separado lê apenas outbox confirmada; teste explícito de invisibilidade pré-commit |
| Ledger imutável | Triggers e privilégios runtime bloqueiam UPDATE/DELETE/TRUNCATE |
| Sem lock global | Serialização por walletId e SKIP LOCKED somente na outbox |
| Sem atualização de saldo desprotegida | SELECT FOR UPDATE e escrita dentro da mesma transação |
| Múltiplas instâncias | Testes de três APIs, publishers separados e referências concorrentes |
| Garantias no schema | CHECKs, FKs, índices únicos e constraint triggers deferred preservados |

O usuário restrito é aplicado ao runtime do Compose e, após o endurecimento descrito em LOGGING.md, também é o padrão nativo. Migrations usam MIGRATION_DATABASE_URL; testes de integração usam TEST_DATABASE_URL para seu controle administrativo e uma conexão runtime restrita separada. Nenhuma credencial de produção foi provisionada.

## Resultado final

67 testes unitários e 25 de integração aprovados (140 + 200 assertions), TypeScript aprovado e auditoria de dependências sem vulnerabilidades reportadas. Testes incluem SQL/LocalStack reais, três processos HTTP, dois publishers, dois pontos de crash, SIGTERM em Linux e privilégios runtime. O teste de expiração foi ajustado para respeitar lotes limitados na presença de fixtures antigas, sem limpar dados.

Novo teste de carga: 650 requisições medidas, 0% de erros, um débito para 50 duplicatas e saldo/ledger consistentes. Outbox: pico amostrado de lag caiu de ~64s para 0,49s; confirmação de drenagem de ~66s para 5,27s (resolução da checagem: 5s). Não houve ganho consistente de latência HTTP. Detalhes e limitações em LOAD_TEST.md.

Revisão posterior dos logs: allowlist de eventos/campos, HMAC para todos os identificadores, contexto assíncrono por operação, tratamento seguro de falhas de inicialização e conexão nativa restrita por padrão. Configuração e limites em LOGGING.md. Validação atual: 73 testes unitários e 28 de integração. A rechecagem de agendamento agora usa clock_timestamp() no PostgreSQL, eliminando comparação entre relógios do banco e do host.
