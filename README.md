# Revisão de roteiro

API HTTP em TypeScript para revisar roteiros por versões. O fluxo permite enviar um roteiro, pedir alteração com motivo e prazo, reenviar uma versão e aprovar. A aprovação é terminal. As versões anteriores permanecem no histórico.

## Requisitos e execução

- Node.js 22.18 ou superior (usa a remoção nativa de tipos do Node; não há etapa de build em runtime)
- `npm start` inicia a API em `http://localhost:3000`
- `npm test` executa os testes com o runner nativo do Node
- `npm install` e `npm run typecheck` instalam/rodam o verificador estático TypeScript

Não há dependências de runtime. Os dados das revisões ficam em memória e se perdem quando o processo reinicia.

## Endpoints

`POST /campaigns/:campaignId/script-review` cria a primeira versão ou reenvia após um pedido de alteração.

```http
POST /campaigns/campanha-42/script-review
Content-Type: application/json

{"text":"Abertura, demonstração e chamada para ação"}
```

Resposta `201 Created`:

```json
{
  "data": {
    "campaignId": "campanha-42",
    "status": "in_review",
    "versions": [
      {
        "number": 1,
        "text": "Abertura, demonstração e chamada para ação",
        "status": "in_review",
        "submittedAt": "2026-10-11T12:00:00.000Z",
        "changeRequests": []
      }
    ],
    "approvedAt": null
  }
}
```

`POST /campaigns/:campaignId/script-review/request-changes` pede alteração na versão atual. `deadlineDate` é uma data civil da marca (`YYYY-MM-DD`) em `America/Sao_Paulo`.

```http
POST /campaigns/campanha-42/script-review/request-changes
Content-Type: application/json

{"reason":"Apresente o benefício antes da demonstração","deadlineDate":"2026-10-12"}
```

Resposta `201 Created`:

```json
{
  "data": {
    "campaignId": "campanha-42",
    "status": "changes_requested",
    "versions": [
      {
        "number": 1,
        "text": "Abertura, demonstração e chamada para ação",
        "status": "changes_requested",
        "submittedAt": "2026-10-11T12:00:00.000Z",
        "changeRequests": [
          {
            "reason": "Apresente o benefício antes da demonstração",
            "deadlineDate": "2026-10-12",
            "deadlineAt": "2026-10-13T03:00:00.000Z",
            "requestedAt": "2026-10-11T12:05:00.000Z",
            "status": "open"
          }
        ]
      }
    ],
    "approvedAt": null
  }
}
```

`POST /campaigns/:campaignId/script-review/approve` aprova a versão atual. `GET /campaigns/:campaignId/script-review` devolve o estado e o histórico.

Respostas de sucesso usam `{ "data": ... }`; erros usam `{ "error": { "code": ..., "message": ... } }`. Um roteiro aprovado retorna `409 review_closed` para novas alterações e reenvios. Campanha sem revisão retorna `404 not_found`; pedido de alteração sem motivo, sem prazo, com data inválida ou com prazo já vencido retorna `400` (`invalid_reason`, `invalid_deadline`, `deadline_passed`).

Transições válidas: `in_review → changes_requested`; `changes_requested → in_review` no reenvio dentro do prazo (a versão anterior vira `superseded` e o pedido vira `fulfilled`); `in_review → approved`. `approved` é terminal.

Quando o prazo vence sem reenvio, o pedido passa a `expired` e a mesma versão volta a `in_review`: o criador recebe `409 change_request_expired` se tentar reenviar, e a marca pode aprovar ou fazer um novo pedido com outro prazo. Cada versão guarda todos os seus pedidos em `changeRequests`.

## Decisões e limites

- O prazo é armazenado como data civil e como instante exclusivo no início do dia seguinte em `America/Sao_Paulo`. Assim, o último instante do dia ainda é válido e a virada de dia é calculada no fuso da marca, mesmo se o UTC já mudou de data.
- A revisão guarda as versões no próprio recurso da campanha. Ao reenviar, a versão anterior passa a `superseded`, mantendo seu conteúdo e seus pedidos de alteração no histórico.
- "Prazo que já passou não vale" vale nos dois sentidos: a marca não registra um pedido cujo dia de prazo já terminou em São Paulo, e o criador só reenvia até o último instante desse dia. Depois disso o pedido expira e a decisão volta para a marca, para a revisão não ficar presa.
- A expiração é aplicada na leitura ou na próxima operação, comparando o relógio com o prazo; não há job em segundo plano.
- Não há usuários nem permissões: a API não distingue marca de criador, e qualquer versão em `in_review` pode ser aprovada ou receber pedido de alteração.
- O fuso é fixo em `America/Sao_Paulo`, não configurável por marca.

## O que eu faria diferente com mais tempo

- Confirmar com produto o que acontece quando o prazo vence sem reenvio (escolhi devolver a decisão à marca) e avisar as partes quando o pedido expira.
- Persistência em banco com transação por transição; hoje duas requisições simultâneas só não conflitam porque o processo é único e as transições são síncronas.
- Autenticação e papéis (marca pede alteração e aprova, criador envia), com autor registrado em cada versão e pedido.
- Um endpoint para ler uma versão específica, em vez de sempre devolver o histórico inteiro.

## Uso de IA

O código, os testes e a primeira versão deste README foram gerados com o Codex (OpenAI). Depois, o Claude (Anthropic) fez uma revisão contra o enunciado, removeu um mecanismo de idempotência que o enunciado não pedia, corrigiu os códigos de erro para campanha inexistente e identificador malformado, fez o prazo valer também para o reenvio do criador (pedido vencido expira), e reescreveu o teste de prazo para usar instantes UTC literais em vez de derivá-los da função testada.

O que eu revisei pessoalmente: **TODO — preencher antes de entregar.**
