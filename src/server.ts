import { createServer } from 'node:http';
import { ReviewError, ScriptReviewService } from './script-review.ts';

interface ApiError {
  code: string;
  message: string;
}

interface ApiResponse<T = unknown> {
  data?: T;
  error?: ApiError;
}

const MAX_BODY_BYTES = 1_000_000;

export function createApp({ service = new ScriptReviewService() }: { service?: ScriptReviewService } = {}) {
  return createServer(async (request, response) => {
    const send = (status: number, body: ApiResponse): void => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const match = url.pathname.match(/^\/campaigns\/([^/]+)\/script-review(?:\/(request-changes|approve))?$/);
      if (!match) return send(404, { error: { code: 'not_found', message: 'Rota não encontrada.' } });
      let campaignId: string;
      try { campaignId = decodeURIComponent(match[1]); } catch {
        return send(400, { error: { code: 'invalid_campaign_id', message: 'Identificador de campanha inválido.' } });
      }
      const action = match[2];
      if (request.method === 'GET' && !action) {
        const review = service.get(campaignId);
        return review
          ? send(200, { data: review })
          : send(404, { error: { code: 'not_found', message: 'Revisão não encontrada.' } });
      }
      if (request.method !== 'POST') return send(405, { error: { code: 'method_not_allowed', message: 'Método não permitido.' } });

      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) {
          response.setHeader('connection', 'close');
          return send(413, { error: { code: 'body_too_large', message: 'Corpo da requisição grande demais.' } });
        }
        chunks.push(chunk as Buffer);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try { body = JSON.parse(raw || '{}') as unknown; } catch {
        return send(400, { error: { code: 'invalid_json', message: 'Corpo JSON inválido.' } });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return send(400, { error: { code: 'invalid_body', message: 'O corpo deve ser um objeto JSON.' } });
      }

      if (!action) return send(201, { data: service.submit(campaignId, body as { text?: unknown }) });
      if (action === 'request-changes') {
        return send(201, { data: service.requestChanges(campaignId, body as { reason?: unknown; deadlineDate?: unknown }) });
      }
      return send(200, { data: service.approve(campaignId) });
    } catch (error) {
      return error instanceof ReviewError
        ? send(error.status, { error: { code: error.code, message: error.message } })
        : send(500, { error: { code: 'internal_error', message: 'Erro interno.' } });
    }
  });
}
