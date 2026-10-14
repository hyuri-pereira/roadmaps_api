# Gerenciador de Roadmap + Asana — API

Backend em NestJS sobre Firebird 5.0, integrado ao Asana, com avisos por
e-mail e WhatsApp (WAHA).

---

## O que o sistema faz

1. O gestor conecta a própria conta do Asana — com o próprio **PAT** ou por
   **OAuth**, à escolha dele.
2. Sincroniza o catálogo do Asana (workspaces, equipes, projetos, seções) e
   define, para a equipe, os destinos: projeto **SPRINT** com a coluna
   **"A fazer"** e projeto **Backlog** com a coluna **"Refino"**.
3. Cria um **roadmap** vinculado a um projeto do Asana, com período entre
   **1 semana e 3 meses** e um objetivo em texto.
4. Escreve **cards** com prazo, prioridade, links/arquivos de referência e um
   checkbox de sprint:
   - marcado → nasce em **SPRINT / "A fazer"**;
   - desmarcado → nasce em **Backlog / "Refino"**.
5. Acompanha em que coluna do quadro SPRINT cada card está e se foi concluído.
   O **percentual do roadmap** é calculado pelo banco e muda sozinho quando
   cards são incluídos, excluídos ou concluídos.
6. Mudanças feitas **dentro do Asana** (título, descrição, coluna, conclusão)
   voltam para o sistema por webhook e por reconciliação periódica.
7. Botão **Concluir roadmap** conclui todos os cards; excluir um roadmap
   exclui todos os seus cards.
8. Avisos opcionais por e-mail e/ou WhatsApp em quatro eventos:
   `ROADMAP_CONCLUIDO`, `CARD_PARADO`, `CARD_PENDENCIA_EXTERNA`,
   `CARD_CONCLUIDO`.

**Padrão do título do card:**
`PROJETO - PRIORIDADE - DD/MM/AAAA - ROADMAP`

O `PROJETO` é o projeto de **contexto** do roadmap (não o SPRINT). Sem prazo,
a seção da data simplesmente não aparece:

```
PortalGTS - ALTA - 30/09/2026 - Modernizacao de serventias
PortalGTS - ALTA - Modernizacao de serventias
```

Os links entram no corpo da tarefa, sempre no fim, sob a linha
`Links de referencia:`.

---

## Decisões técnicas que valem explicação

### Prisma não é usado

O Prisma **não tem connector para Firebird** — nem oficial, nem comunitário.
Os connectors existentes são PostgreSQL, MySQL/MariaDB, SQLite, SQL Server,
MongoDB e CockroachDB. Não há como usá-lo aqui.

No lugar dele há uma camada de acesso a dados própria, tipada, com
repositórios por módulo e transações explícitas (`FirebirdService.transacao`).
Isso não é só um substituto: o schema depende de `UPDATE` e
`EXECUTE PROCEDURE SP_SOLICITAR_SYNC_ITEM` acontecerem **na mesma transação**,
algo que um ORM genérico atrapalharia mais do que ajudaria.

### Driver do Firebird: `pure` por padrão

Há duas implementações plugáveis por trás da mesma interface
(`src/database/drivers/`):

| Driver | Pacote | Situação |
|---|---|---|
| `pure` | `node-firebird` | **Em uso.** Protocolo TCP puro, sem DLL. |
| `native` | `node-firebird-driver-native` | Pronto, mas exige pré-requisitos. |

Trocar é uma variável: `FIREBIRD_DRIVER=native`.

O `native` foi pedido originalmente, mas nesta máquina ele não roda sem duas
providências: o Firebird instalado é **32 bits**
(`C:\Program Files (x86)\Firebird\Firebird_5_0`) e o Node é **x64** — um
processo x64 não carrega uma DLL de 32 bits —, e o `node-firebird-native-api`
precisa ser compilado com node-gyp + Visual Studio Build Tools. Para usá-lo:
instale o Firebird 5 x64 (basta o `fbclient.dll`), aponte
`FIREBIRD_NATIVE_CLIENT_PATH` para a pasta dele e rode
`npm rebuild node-firebird-native-api`.

### Duas coisas do ambiente que precisaram de ajuste

**1. Porta.** Há duas instalações de Firebird nesta máquina. O **Firebird 2.5**
ocupa a porta padrão **3050**; o **Firebird 5.0** está na **3055**
(`RemoteServicePort` do `firebird.conf`). O `.env` já vem com `3055`. Apontar
para a 3050 falha com `Token unknown - WITH`, porque o 2.5 não conhece a
sintaxe do schema.

**2. WireCrypt.** O `node-firebird` não implementa wire encryption, e o
Firebird 5 vem com `WireCrypt = Required`. É preciso rodar **uma vez**, num
PowerShell **como administrador**:

```powershell
$conf = 'C:\Program Files (x86)\Firebird\Firebird_5_0\firebird.conf'
Copy-Item $conf "$conf.bak-roadmap" -Force
(Get-Content $conf) -replace '^\s*#?\s*WireCrypt\s*=.*$', 'WireCrypt = Enabled' |
  Set-Content $conf -Encoding ASCII
Restart-Service FirebirdServerFB50
```

Sem isso a conexão falha com *"Incompatible wire encryption levels requested
on client and server"*. Como API e banco ficam no mesmo host, o tráfego não
sai da máquina. Para reverter, restaure o `.bak-roadmap` e reinicie o serviço.

### Datas

O DDL original usava `TIMESTAMP WITH TIME ZONE`. O `node-firebird` não
decodifica esse tipo (o suporte dele para no Firebird 4 sem fuso), então as
colunas passaram a ser `TIMESTAMP`. O driver converte `Date` do JavaScript
usando o fuso local nos dois sentidos, então instantes fazem round-trip
corretamente enquanto **API e Firebird estiverem no mesmo fuso** — o caso
aqui, já que rodam no mesmo host. Se algum dia forem separados, o boot avisa:
o `FirebirdService` compara o relógio do banco com o da API e registra um
`warn` se a diferença passar de 5 minutos.

---

## Instalação

```bash
cd api
npm install
cp .env.example .env    # e preencha (veja abaixo)
```

### Preencher o `.env`

Obrigatórios para subir:

| Variável | O que é |
|---|---|
| `FIREBIRD_PASSWORD` | senha do SYSDBA |
| `ENCRYPTION_KEY` | 32 bytes em base64 — cifra tokens, API keys e senha SMTP |
| `JWT_SECRET` | segredo dos tokens de acesso |

Gere as duas chaves:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Opcionais, cada um liga um recurso: Google (`GOOGLE_CLIENT_ID`/`SECRET`),
OAuth do Asana (`ASANA_OAUTH_CLIENT_ID`/`SECRET`), webhooks
(`ASANA_WEBHOOK_URL`), e-mail (`MAIL_*`) e WhatsApp (`WAHA_*`). O que faltar é
listado no log do boot.

Para OAuth web do Asana, `ASANA_OAUTH_REDIRECT_URI` precisa ser uma URL HTTPS
pública e idêntica à cadastrada em Developer Console → OAuth → Redirect URL.
Na VPS isso vale também para o webhook: enquanto o domínio estiver em HTTP,
use PAT em vez de OAuth e conte com a reconciliação periódica.

### Docker (VPS)

O `docker-compose.yml` da pasta acima sobe Firebird, API, app, WAHA e nginx.
O container da API roda `scripts/preparar-banco.ts` antes de iniciar: cria o
banco se não existir, aplica `db/schema.sql` e as migrações de
`db/migracoes` ainda não registradas em `SCHEMA_MIGRACOES`. Veja
`../DEPLOY.md`.

### Criar o banco (fora do Docker)

```bash
npm run db:check     # valida o schema.sql sem tocar no banco
npm run db:create    # cria o .FDB (UTF8, dialect 3)
npm run db:schema    # aplica db/schema.sql
npm run db:ping      # diagnóstico da conexão
```

`npm run db:create -- --force` apaga e recria (destrutivo).

Se preferir usar o `isql` diretamente:

```bash
cd "C:\Program Files (x86)\Firebird\Firebird_5_0"
.\isql.exe -u SYSDBA -p SUA_SENHA "localhost/3055:C:\Web\TotalProjetos\api\db\ROADMAP.FDB" -i "C:\Web\TotalProjetos\api\db\schema.sql"
```

### Rodar

```bash
npm run start:dev
```

- API: `http://localhost:3000/api`
- **Swagger: `http://localhost:3000/api/docs`**
- Health: `http://localhost:3000/api/health`

O primeiro boot cria o administrador de `BOOTSTRAP_ADMIN_EMAIL`. Se a tabela
de usuários estiver vazia e nada for informado, o primeiro login pelo Google
vira `ADMIN` automaticamente.

---

## Ordem de configuração (primeira vez)

| # | Rota | O que faz |
|---|---|---|
| 1 | `POST /api/auth/login` ou `GET /api/auth/google` | entrar |
| 2 | `POST /api/asana-conexoes/pat` ou `GET /api/asana-conexoes/oauth/iniciar` | conectar o Asana |
| 3 | `POST /api/asana-catalogo/sincronizar` | trazer projetos e seções |
| 4 | `POST /api/equipes/{id}/entrar` | entrar na equipe |
| 5 | `GET /api/asana-catalogo/equipes/{id}/sugestao-destinos` | localizar SPRINT/Backlog por nome |
| 6 | `PUT /api/equipes/{id}/destinos` | gravar os destinos |
| 7 | `PUT /api/equipes/{id}/etapas` | mapear as 8 colunas do SPRINT |
| 8 | `POST /api/asana-webhooks/projetos/{idProjeto}` | registrar o webhook (precisa de HTTPS público) |
| 9 | `POST /api/roadmaps` | criar o primeiro roadmap |

O passo **7** é o que faz os avisos de "Parado" e "Pendência externa"
funcionarem: sem o mapa, o sistema não sabe o que cada coluna significa.

---

## Estrutura

```
api/
├── db/schema.sql                 DDL completo (30 tabelas, 5 views, 18 triggers,
│                                 5 procedures, 8 exceptions)
├── scripts/                      criar banco, aplicar e validar schema, ping
└── src/
    ├── common/                   config, crypto (AES-256-GCM), guards, filtros, DTOs
    ├── database/
    │   ├── firebird.service.ts   transações com retry em conflito de concorrência
    │   └── drivers/              pure.driver.ts | native.driver.ts
    ├── integrations/             asana/ waha/ mail/
    └── modules/
        ├── auth/                 Google OAuth + PKCE, JWT, refresh rotativo
        ├── usuarios/             perfis, contato de aviso
        ├── asana-conexoes/       PAT e OAuth por gestor, refresh de token
        ├── asana-catalogo/       espelho de workspaces/equipes/projetos/seções
        ├── equipes/              membros, destinos, mapa das 8 colunas
        ├── roadmaps/             CRUD, conclusão, exclusão
        ├── cards/                CRUD, referências, upload, corpo da tarefa
        ├── integracao/           fila + worker que fala com o Asana
        ├── asana-webhooks/       recepção, assinatura HMAC, espelhamento
        ├── waha/                 sessão de WhatsApp por gestor, QR
        ├── notificacoes/         preferências, fila e envio
        ├── dashboard/            visões gerais e quadro
        ├── auditoria/            histórico
        └── health/               monitoramento
```

Cada módulo corresponde a uma seção do DDL e a uma **tag numerada** no Swagger.

---

## Como a sincronização funciona

**Nenhuma trigger faz HTTP.** O banco apenas enfileira; quem conversa com o
Asana são os workers.

```
gestor edita card
      │
      ├─ UPDATE ROADMAP_ITENS ─────────┐  mesma transação
      └─ EXECUTE SP_SOLICITAR_SYNC_ITEM ┘
                    │
                    ▼
            INTEGRACAO_FILA (PENDENTE)
                    │
      worker reivindica com lease + token  ← transação curta, commit
                    │
            chamada HTTP ao Asana          ← fora da transação
                    │
      grava o resultado só se ainda tiver a lease
```

Garantias implementadas:

- **Ordem por card.** No máximo um job por card por rodada, processados por
  id crescente. Como `CRIAR_TAREFA` é enfileirado primeiro, ele sempre roda
  antes de qualquer `ATUALIZAR` ou `EXCLUIR` do mesmo card.
- **Lease.** `LOCK_TOKEN` único por tentativa. Se a lease expirou e outro
  worker assumiu, o resultado do worker antigo é descartado em vez de
  sobrescrever.
- **Revisão.** O worker captura a revisão antes do HTTP e só marca como
  sincronizado se ela não mudou. Se mudou, o job seguinte reenvia o estado
  novo — nada de sobrescrever edição mais recente.
- **POST ambíguo.** Em timeout ou 5xx na criação, o worker **procura** a
  tarefa no Asana antes de tentar de novo, e só adota se encontrar
  exatamente uma correspondência. Nunca repete o POST às cegas.
- **Exclusão.** Cancela a criação que ainda não saiu; se estiver em voo,
  espera o GID. `404` no DELETE conta como sucesso (ausência confirmada). O
  card só é apagado fisicamente depois disso, e o roadmap só quando não
  sobrar nenhum card.
- **Webhook.** Assinatura HMAC-SHA256 conferida sobre o corpo **bruto**;
  eventos deduplicados por `CHAVE_DEDUPLICACAO`. O evento é tratado como
  aviso: o estado atual é sempre lido do Asana, nunca deduzido do payload.
- **Reconciliação periódica.** Relê os cards mais desatualizados, porque
  mudança de membership nem sempre altera `modified_at`.
- **Logs sem segredo.** Token, QR, senha e API key são mascarados antes de
  qualquer gravação em `INTEGRACAO_LOGS`.

---

## Notificações

Destinatário: o **gestor dono do roadmap**. Não há envio geral para a equipe.

Cada gestor escolhe, por evento, entre nenhum canal, e-mail, WhatsApp ou os
dois. Um canal só funciona depois de **verificado**:

- **E-mail** — `POST /api/notificacoes/email/verificar` manda uma mensagem de
  teste; a entrega bem-sucedida é a prova de que o endereço existe.
- **WhatsApp** — `POST /api/waha/conectar`, `GET /api/waha/qrcode`, ler o QR.
  Depois o sistema confere a identidade da sessão: o número conectado precisa
  ser **igual ao cadastrado**. Se for outro, a verificação não é concedida.

A trigger `AI_NOTIF_EVENTO` só enfileira avisos para contatos verificados, e
o worker **revalida tudo antes de cada envio** (consentimento, destino, dono e
estado da sessão). Trocar o e-mail ou o número derruba a verificação
correspondente. Desligar um canal cancela na hora o que estava pendente nele.
A sessão de um gestor nunca é usada como alternativa para outro.

Ler o QR apenas conecta a conta — nenhuma mensagem é enviada nesse momento. O
QR é buscado no WAHA sob demanda e **nunca** gravado em banco, arquivo ou log.

> Entrega exatamente uma vez não é prometida em nenhum dos canais: SMTP e WAHA
> podem entregar antes de um timeout, e a retentativa pode gerar duplicata.

---

## Segurança

- Senhas com **Argon2id**; refresh tokens guardados só como SHA-256 e
  rotacionados a cada uso.
- Tokens do Asana, API key do WAHA, senha SMTP e segredo de webhook em
  envelopes **AES-256-GCM** (`[iv | tag | ciphertext]`), com AAD por
  finalidade. A chave fica fora do banco, no `.env`; `ENCRYPTION_KEYS_LEGACY`
  permite rotacionar sem perder o que já está gravado.
- OAuth com **state e PKCE** persistidos no banco (uso único, 10 minutos), o
  que também faz o callback funcionar com várias instâncias da API.
- Redirect pós-login restrito à origem de `FRONTEND_URL` — sem open redirect.
- Autorização checada no backend **em toda requisição**: participação na
  equipe para ler, e ser dono do roadmap (ou ADMIN) para alterar. O campo
  `PERFIL` no banco não implementa segurança por linha sozinho.
- Credencial do Asana é pessoal: nem ADMIN opera com o token de outro gestor.
- Arquivos ficam fora do Firebird; a URL publicada no Asana é durável e
  **autenticada**, com o acesso verificado a cada download.

Em produção, crie um usuário Firebird com privilégios mínimos e use
`FIREBIRD_RUNTIME_USER`/`FIREBIRD_RUNTIME_PASSWORD`. O SYSDBA fica só para
instalação e manutenção.

---

## Operação

| Rota | Para quê |
|---|---|
| `GET /api/health` | pública, para monitoramento |
| `GET /api/integracao/resumo` | fila do Asana (ADMIN) |
| `GET /api/integracao/fila/{id}/logs` | histórico HTTP de um job |
| `POST /api/integracao/fila/{id}/reenfileirar` | reenviar job em erro |
| `GET /api/notificacoes/resumo` | fila de avisos (ADMIN) |
| `GET /api/dashboard/atencao` | cards parados, com pendência ou erro |

Fila pendente crescendo costuma significar Asana fora do ar ou credencial
expirada — `GET /api/integracao/fila?situacao=ERRO` mostra o motivo.

Rodando em várias instâncias, deixe `WORKERS_ENABLED=true` em apenas uma. As
leases tornam a concorrência segura, mas não há por que gastar chamadas.

---

## Limites conhecidos

- **Não há testes automatizados.** O schema foi validado no Firebird 5.0.2
  (30 tabelas, 5 views, 18 triggers, 8 exceptions criados sem erro) e todo o
  TypeScript compila, mas nenhuma chamada real ao Asana, ao WAHA ou ao SMTP
  foi executada — isso depende de credenciais suas.
- **Endpoints do WAHA variam por versão.** Os caminhos usados seguem a API
  documentada; se a sua instância responder 404, ajuste
  `src/integrations/waha/waha.client.ts` — é o único arquivo que fala com o
  WAHA. Capacidade multissessão depende da edição instalada; o modelo aceita
  vários servidores caso a sua só suporte uma sessão por instância.
- **Webhook exige HTTPS público.** Sem `ASANA_WEBHOOK_URL`, o sistema ainda
  funciona, mas depende só da reconciliação periódica (padrão: 15 minutos).
- **"Concluído" e "Arquivado" são colunas, não conclusão.** O percentual e o
  aviso `CARD_CONCLUIDO` usam o campo `completed` do Asana. Se a equipe quiser
  que arrastar para "Concluído" marque `completed`, isso precisa ser uma regra
  explícita no worker. "Arquivado" nunca conclui automaticamente.
