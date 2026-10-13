# Segurança da JK CRED

## Proteções implementadas no código

- CSP permite scripts, estilos e fontes locais; as conexões ficam restritas à própria origem e ao projeto Supabase configurado. Sem `unsafe-inline` ou `unsafe-eval`. Cabeçalhos locais e do Netlify têm a mesma política, validada em teste.
- Proteção contra inclusão em iframe, MIME sniffing e vazamento do referrer. HSTS configurado para o hosting HTTPS do Netlify; não é enviado na prévia HTTP local.
- SDK Supabase distribuído localmente, na versão 2.45.4 já usada pelo projeto. Pacote oficial npm verificado contra `dist.integrity`, licença incluída e hash do JS registrado. Nenhum script de CDN ou fonte externa é carregado em tempo de execução. A cópia não representa uma atualização de versão nem uma auditoria de todas as dependências internas do SDK.
- O navegador recusa endpoints HTTP externos, URLs com credenciais e chaves secretas/service_role antes de criar o cliente.
- Login/recuperação: origens explicitamente permitidas, JSON obrigatório, limite de 4 KiB lido no fluxo real (também sem Content-Length) e limites para telefone e senha.
- Uma RPC atômica serializa a contagem e o registro de tentativas por telefone e IP, usando locks transacionais em ordem estável. Somente service_role pode chamá-la; clientes não acessam o log de tentativas. Cinco tentativas de login por telefone em 15 minutos e 30 por IP; recuperação permite três por telefone e dez por IP em 60 minutos.
- Identificadores do limitador são HMAC-SHA256 com chave de servidor. Login bem-sucedido não apaga a contagem do IP. Registros com mais de 24 horas são removidos em lotes de até 100 por tentativa aceita, inclusive quando a senha estiver incorreta.
- O script legado de teste de autenticação saiu da pasta publicada e agora exige configuração explícita de conta de homologação, sem credenciais fixas.
- As verificações anteriores de RLS, papel administrativo no banco, escrita por RPC, idempotência, escape do HTML e mensagens sem dados sensíveis continuam em uso.

## Aplicação no ambiente remoto

As mudanças foram desenvolvidas localmente. A migração e a Edge Function não foram publicadas no Supabase; os headers remotos só entram em vigor no próximo deploy do Netlify.

1. Aplicar as migrações anteriores do projeto, inclusive `20261013103750_atomic_loan_operations.sql`.
2. Aplicar `20261013180000_auth_rate_limit.sql` ANTES da nova função de acesso. A nova função falha com 503 se a RPC estiver ausente, sem recorrer ao limitador anterior.
3. Configurar `SITE_URL` na Edge Function com a URL HTTPS da aplicação. O código utiliza a origem dessa URL para CORS e a URL completa para o retorno da recuperação.
4. Se houver outras origens necessárias, configurar `ALLOWED_ORIGINS`, separadas por vírgula. Para a prévia local, incluir explicitamente `http://127.0.0.1:4173`. Não há fallback para `*`. Origens HTTP são aceitas apenas para loopback.
5. Opcionalmente configurar `AUTH_RATE_LIMIT_SECRET` com um segredo aleatório longo e exclusivo. Se ausente, o código usa a chave service_role somente no servidor como chave HMAC. A rotação da chave reinicia os buckets, pois os identificadores mudam.
6. Publicar `acesso-cliente`, mantendo a configuração de gateway apropriada à autenticação antes do login. A chave de serviço permanece nos secrets do servidor.
7. Publicar `public/` no Netlify e verificar login, recuperação, origens, políticas de dados e headers em ambiente de homologação. Se o projeto Supabase mudar, ajustar também `connect-src` em `netlify.toml` e `scripts/security-headers.js`.

## Limites e configurações ainda pendentes

CORS controla navegadores e não substitui autenticação. A proteção por telefone não depende do IP. O bucket de IP depende de `x-forwarded-for` fornecido pelo gateway confiável; confirmar seu comportamento na infraestrutura de produção. Clientes atrás de um mesmo NAT compartilham o limite do IP; sem header, compartilham o bucket desconhecido.

O limitador customizado cobre o acesso de clientes e recuperação. Login administrativo e cadastro usam o Supabase Auth diretamente e dependem dos limites e regras do provedor. MFA administrativo, CAPTCHA, senha forte/verificação de senha vazada e validade de sessão precisam ser configurados no Supabase e, quando necessário, ter fluxo de UI implementado. Essas proteções não foram ativadas no projeto remoto, cujo conector não concedeu acesso.

A sessão atual continua em sessionStorage e não equivale a uma sessão de servidor com cookie HttpOnly. CSP reduz a superfície de XSS, mas não substitui revisão de qualquer código novo que renderize dados. Os testes locais de banco validam privilégios e limites; não são um teste de carga concorrente da infraestrutura real.

## Evidência de verificação

`npm test` exercita rejeição de origens, tamanho/media type, falha fechada do limitador, hashes com chave, privilégios SQL, limites por identidade/IP, expiração da janela, autorização e persistência. O contrato CSP e a rejeição de chaves privilegiadas também têm testes específicos. `npm run lint` verifica sintaxe. A prévia local foi conferida em navegador com a política CSP ativa. Nenhuma senha ou conta real foi usada nas verificações.
