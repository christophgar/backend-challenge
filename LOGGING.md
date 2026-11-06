# Logs e credenciais de execução

O ledger e as transações permanecem como trilha financeira persistente; logs operacionais não copiam seus valores, saldos ou payloads. Logs não substituem o ledger e podem ser perdidos numa falha do processo após commit.

O logger possui allowlist de eventos e campos: timestamp, event, correlationId, messageId, transactionId, walletId, providerId, status, errorType, loop e httpStatus. Campos não previstos são descartados. Status, classe de erro e loop aceitam apenas valores conhecidos. Nunca registra stack, mensagem de erro, headers, tokens, senha ou body. Objetos recebidos como identificadores não são serializados.

Todos os identificadores são pseudonimizados com HMAC-SHA256, inclusive UUIDs. Isso impede que um identificador externo contendo email, senha ou texto arbitrário apareça em claro. Strings maiores que 512 caracteres são descartadas. Pseudonimização não é anonimização: acesso e retenção dos logs ainda devem ser controlados.

`LOG_HMAC_KEY` permite uma chave compartilhada de pelo menos 32 caracteres para correlacionar pseudônimos entre réplicas e reinícios. Use um segredo aleatório de alta entropia, configurado no ambiente ou no `.env` ignorado pelo Git; nunca registre essa chave. O Compose a repassa ao runtime. Sem configuração, cada processo gera uma chave aleatória efêmera: há correlação dentro daquele processo, mas não entre réplicas/reinícios. Rotacionar a chave altera os pseudônimos. Os IDs originais continuam disponíveis no banco, com os controles próprios de acesso.

A API gera X-Correlation-Id próprio para cada requisição e devolve esse ID no header. O header fornecido pelo cliente não é usado como identidade confiável. AsyncLocalStorage propaga o contexto entre chamadas assíncronas e isola requisições concorrentes. No SQS, o contexto acompanha a mensagem, wallet/provider e transactionId quando conhecidos; falhas anteriores à identificação desses campos mantêm null. Publicação e referências também enriquecem o contexto antes do trabalho. Logs de erro registram somente a classe permitida, nunca a mensagem original.

## Banco nativo

- API, worker e carga: `DATABASE_URL`; padrão local é `wagering_app`, com permissões restritas.
- Migrations: `MIGRATION_DATABASE_URL`; padrão administrativo local separado. Não usa DATABASE_URL como fallback.
- Testes de integração: `TEST_DATABASE_URL` administrativo para criar schemas e injetar falhas; a aplicação exercitada usa a conexão runtime separada.
- `bun run migrate` provisiona o usuário restrito quando usa a URL local padrão; com MIGRATION_DATABASE_URL explícita, só provisiona se PROVISION_LOCAL_ROLE=1. O Compose ativa essa opção apenas no serviço de migrations. PROVISION_LOCAL_ROLE=0 desliga o provisionamento.

Os padrões são credenciais públicas de desenvolvimento local. Produção continua bloqueada até integrar IdP e requer provisionamento de usuários/segredos fora destes padrões. Não forneça uma URL administrativa em DATABASE_URL; uma configuração explícita pode substituir o padrão restrito.
