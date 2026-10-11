# Revisão de roteiro

API em TypeScript para a marca revisar o roteiro de uma campanha. O criador envia uma versão, a marca aprova ou pede alteração com motivo e prazo, e o criador reenvia. Nenhuma versão é apagada.

## Rodar

Node.js 22.18 ou mais novo. Os dados ficam em memória.

```bash
npm start   # http://localhost:3000
npm test
```

## API

- `POST /campaigns/:id/script-review` envia ou reenvia o roteiro: `{"text": "..."}`
- `POST /campaigns/:id/script-review/request-changes` pede alteração: `{"reason": "...", "deadlineDate": "YYYY-MM-DD"}`
- `POST /campaigns/:id/script-review/approve` aprova
- `GET /campaigns/:id/script-review` devolve o estado e o histórico

Toda resposta de sucesso traz a revisão inteira. Depois de um envio e um pedido de alteração:

```http
POST /campaigns/campanha-42/script-review/request-changes
Content-Type: application/json

{"reason":"Apresente o benefício antes da demonstração","deadlineDate":"2026-10-12"}
```

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

O mesmo pedido sem `deadlineDate` responde `400`:

```json
{ "error": { "code": "invalid_deadline", "message": "Informe o prazo da alteração." } }
```

## Regras

- O prazo é um dia em `America/Sao_Paulo` e vale até 23:59:59.999 de lá, mesmo com o UTC já no dia seguinte.
- Pedido sem motivo, sem prazo ou com prazo já vencido responde `400`.
- O criador só reenvia dentro do prazo. Depois disso o pedido vira `expired`, a versão volta a `in_review` e a marca aprova ou pede de novo.
- No reenvio, a versão anterior vira `superseded` e continua no histórico com seus pedidos.
- `approved` é final: nova versão ou novo pedido responde `409`.

## O que ficou de fora e o que eu mudaria

- Não tem banco nem autenticação. A API não sabe quem é marca e quem é criador.
- O fuso é fixo, não é configurável por marca.
- Devolver a decisão à marca quando o prazo vence foi escolha minha. Eu confirmaria com produto.
- A expiração só é calculada quando alguém lê ou altera a revisão, e ninguém é avisado.

## Uso de IA

O Codex (OpenAI) gerou o código, os testes e a primeira versão deste README. O Claude (Anthropic) revisou contra o enunciado, removeu um mecanismo de idempotência que não foi pedido, fez o prazo valer também para o reenvio, corrigiu códigos de erro e reescreveu os testes de prazo e este README.

Eu revisei o código que a IA gerou.
