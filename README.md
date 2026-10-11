# Revisão de roteiro

API HTTP em TypeScript para a marca revisar o roteiro de uma campanha. O criador envia uma versão, a marca pede alteração (com motivo e prazo) ou aprova, e o criador reenvia. Toda versão fica no histórico.

## Como rodar

Precisa de Node.js 22.18 ou mais novo, que executa TypeScript direto. A API não tem dependências; `npm install` só serve para o typecheck.

```bash
npm start       # http://localhost:3000
npm test
npm run typecheck
```

Os dados ficam em memória e somem quando o processo reinicia.

## Endpoints

| Método e rota | O que faz |
| --- | --- |
| `POST /campaigns/:id/script-review` | Envia a primeira versão ou reenvia após um pedido de alteração |
| `POST /campaigns/:id/script-review/request-changes` | Marca pede alteração na versão atual |
| `POST /campaigns/:id/script-review/approve` | Marca aprova a versão atual |
| `GET /campaigns/:id/script-review` | Estado atual e histórico |

Sucesso responde `{ "data": ... }` com a revisão inteira. Erro responde `{ "error": { "code", "message" } }`.

### Enviar roteiro

```http
POST /campaigns/campanha-42/script-review
Content-Type: application/json

{"text":"Abertura, demonstração e chamada para ação"}
```

`201 Created`

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

### Pedir alteração

`deadlineDate` é um dia (`YYYY-MM-DD`) no fuso da marca, `America/Sao_Paulo`.

```http
POST /campaigns/campanha-42/script-review/request-changes
Content-Type: application/json

{"reason":"Apresente o benefício antes da demonstração","deadlineDate":"2026-10-12"}
```

`201 Created`. A revisão e a versão 1 passam a `changes_requested`, e a versão ganha o pedido:

```json
"changeRequests": [
  {
    "reason": "Apresente o benefício antes da demonstração",
    "deadlineDate": "2026-10-12",
    "deadlineAt": "2026-10-13T03:00:00.000Z",
    "requestedAt": "2026-10-11T12:05:00.000Z",
    "status": "open"
  }
]
```

### Erros

Pedido sem prazo, por exemplo, responde `400`:

```json
{ "error": { "code": "invalid_deadline", "message": "Informe o prazo da alteração." } }
```

| Status | `code` | Quando |
| --- | --- | --- |
| 400 | `invalid_text`, `invalid_reason`, `invalid_deadline` | Campo vazio, ausente ou data inválida |
| 400 | `deadline_passed` | O dia do prazo já terminou em São Paulo |
| 404 | `not_found` | Campanha sem revisão |
| 409 | `review_closed` | Revisão já aprovada |
| 409 | `change_request_expired` | Reenvio depois do prazo |
| 409 | `resubmission_not_allowed`, `invalid_state` | Ação fora de ordem |

## Estados

- `in_review` → `changes_requested`: a marca pede alteração.
- `changes_requested` → `in_review`: o criador reenvia dentro do prazo. A versão anterior vira `superseded` e o pedido vira `fulfilled`.
- `changes_requested` → `in_review`: o prazo vence sem reenvio. O pedido vira `expired` e a mesma versão volta para a marca, que aprova ou pede de novo com outro prazo.
- `in_review` → `approved`: final. Depois disso não entra versão nem pedido.

## Decisões

- O prazo vale até o início do dia seguinte em São Paulo. 23:59:59.999 de lá ainda está no prazo, mesmo com o UTC já no outro dia.
- Li "prazo que já passou não vale" nos dois sentidos: a marca não registra pedido com dia já encerrado, e o criador não reenvia depois do prazo.
- Pedido vencido devolve a decisão à marca. A alternativa era deixar a revisão presa em `changes_requested`. Com mais tempo eu confirmaria isso com produto.
- A expiração é calculada quando alguém lê ou altera a revisão. Não há job rodando.

## O que ficou de fora

- Banco de dados. Hoje não há conflito entre requisições simultâneas só porque o processo é único; com mais tempo, cada transição seria uma transação.
- Autenticação e papéis. A API não sabe quem é marca e quem é criador, nem registra quem fez cada ação.
- Fuso por marca: está fixo em `America/Sao_Paulo`.
- Aviso para as partes quando um pedido expira.

## Uso de IA

O Codex (OpenAI) gerou o código, os testes e a primeira versão deste README. O Claude (Anthropic) revisou contra o enunciado e fez estas mudanças:

- removeu um mecanismo de idempotência que o enunciado não pedia;
- fez o prazo valer também para o reenvio do criador;
- corrigiu os erros de campanha inexistente e identificador malformado;
- reescreveu os testes de prazo com instantes UTC fixos;
- reescreveu este README.

Eu revisei o código que a IA gerou.
