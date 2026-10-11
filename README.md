# Revisão de roteiro

API HTTP em TypeScript para revisar roteiros por versões. O fluxo permite enviar um roteiro, pedir alteração com motivo e prazo, reenviar uma versão e aprovar. A aprovação é terminal. As versões anteriores permanecem no histórico.

## Requisitos e execução

- Node.js 22.18 ou superior (usa a remoção nativa de tipos do Node; não há etapa de build em runtime)
- `npm start` inicia a API em `http://localhost:3000`
- `npm test` executa os testes com o runner nativo do Node
- `npm install` e `npm run typecheck` instalam/rodam o verificador estático TypeScript

Não há dependências de runtime. O cache de idempotência e os dados das revisões ficam em memória e se perdem quando o processo reinicia.

## Endpoints

`POST /campaigns/:campaignId/script-review` cria a primeira versão ou reenvia após um pedido de alteração.

```http
POST /campaigns/campanha-42/script-review
Content-Type: application/json
Idempotency-Key: submit-campanha-42-v1

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
        "changeRequest": null
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
Idempotency-Key: request-changes-campanha-42-v1

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
        "changeRequest": {
          "reason": "Apresente o benefício antes da demonstração",
          "deadlineDate": "2026-10-12",
          "deadlineAt": "2026-10-13T03:00:00.000Z"
        }
      }
    ],
    "approvedAt": null
  }
}
```

`POST /campaigns/:campaignId/script-review/approve` aprova a versão atual. `GET /campaigns/:campaignId/script-review` devolve o estado e o histórico.

Respostas de sucesso usam `{ "data": ... }`; erros usam `{ "error": { "code": ..., "message": ... } }`. Um roteiro aprovado retorna `409 review_closed` para novas alterações e reenvios.

Transições válidas: `in_review → changes_requested`; `changes_requested → in_review` no reenvio (a versão anterior vira `superseded`); `in_review → approved`. `approved` é terminal.

## Idempotência

`Idempotency-Key` é opcional para manter compatibilidade com clientes existentes. Em uma operação `POST`, a mesma chave e o mesmo corpo JSON canônico repetem o status e a resposta originais sem executar a transição outra vez. Reutilizar a chave com outro corpo retorna `409 idempotency_key_reused`. A chave é isolada por método e rota.

O cache é local ao processo; em produção, ele deve ser persistido junto à operação de negócio e protegido por uma restrição única e uma transação para cobrir reinícios e múltiplas instâncias. Este exemplo mantém ambos em memória.

## Decisões e limites

- O prazo é armazenado como data civil e como instante exclusivo no início do dia seguinte em `America/Sao_Paulo`. Assim, o último instante do dia ainda é válido e a virada de dia é calculada no fuso da marca, mesmo se o UTC já mudou de data.
- A revisão guarda as versões no próprio recurso da campanha. Ao reenviar, a versão anterior passa a `superseded`, mantendo seu conteúdo e pedido de alteração no histórico.
- Por simplicidade, qualquer versão em `in_review` pode ser aprovada ou receber pedido de alteração; o sistema não modela usuários ou permissões.
- Com mais tempo, eu adicionaria armazenamento transacional, autorização por papel, trilha de auditoria independente e testes de concorrência.

## Uso de IA

Esta implementação e os testes foram produzidos com apoio de IA. A decisão sobre estados, a conversão de data civil para o fuso IANA, a resposta de replay idempotente e os limites do exemplo foram revisados contra o enunciado; antes de publicar, o responsável pela entrega deve revisar o código e executar `npm test` e `npm run typecheck`.
