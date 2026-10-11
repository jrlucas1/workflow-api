import { createServer } from 'node:http';
import { ReviewError, ScriptReviewService, type ScriptReview } from './script-review.ts';

interface ApiError {
  code: string;
  message: string;
}

interface ApiResponse<T = unknown> {
  data?: T;
  error?: ApiError;
}

interface HttpResult {
  status: number;
  body: ApiResponse;
}

interface CachedResponse {
  fingerprint: string;
  result: HttpResult;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createApp({ service = new ScriptReviewService() }: { service?: ScriptReviewService } = {}) {
  const idempotencyCache = new Map<string, CachedResponse>();

  return createServer(async (request, response) => {
    const send = (status: number, body: ApiResponse): void => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    let cacheEntry: { key: string; fingerprint: string } | undefined;
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const match = url.pathname.match(/^\/campaigns\/([^/]+)\/script-review(?:\/(request-changes|approve))?$/);
      if (!match) return send(404, { error: { code: 'not_found', message: 'Rota não encontrada.' } });
      const campaignId = decodeURIComponent(match[1]);
      const action = match[2];
      if (request.method === 'GET' && !action) {
        const review = service.get(campaignId);
        return review
          ? send(200, { data: snapshot(review) })
          : send(404, { error: { code: 'not_found', message: 'Revisão não encontrada.' } });
      }
      if (request.method !== 'POST') return send(405, { error: { code: 'method_not_allowed', message: 'Método não permitido.' } });

      const rawKey = request.headers['idempotency-key'];
      const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
      if (idempotencyKey !== undefined && (!idempotencyKey.trim() || idempotencyKey.length > 200)) {
        return send(400, { error: { code: 'invalid_idempotency_key', message: 'A chave deve ter entre 1 e 200 caracteres.' } });
      }

      let raw = '';
      for await (const chunk of request) raw += chunk;
      let body: unknown;
      try { body = JSON.parse(raw || '{}') as unknown; } catch {
        return send(400, { error: { code: 'invalid_json', message: 'Corpo JSON inválido.' } });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return send(400, { error: { code: 'invalid_body', message: 'O corpo deve ser um objeto JSON.' } });
      }

      const fingerprint = canonicalJson(body);
      if (idempotencyKey) {
        const cacheKey = `${request.method}:${url.pathname}:${idempotencyKey}`;
        const cached = idempotencyCache.get(cacheKey);
        if (cached) {
          if (cached.fingerprint !== fingerprint) {
            return send(409, { error: { code: 'idempotency_key_reused', message: 'A chave já foi usada com outro conteúdo.' } });
          }
          return send(cached.result.status, snapshot(cached.result.body));
        }
        cacheEntry = { key: cacheKey, fingerprint };
      }

      let result: HttpResult;
      if (!action) {
        result = { status: 201, body: { data: service.submit(campaignId, body as { text?: unknown }) } };
      } else if (action === 'request-changes') {
        result = { status: 201, body: { data: service.requestChanges(campaignId, body as { reason?: unknown; deadlineDate?: unknown }) } };
      } else {
        result = { status: 200, body: { data: service.approve(campaignId) as ScriptReview } };
      }
      if (cacheEntry) idempotencyCache.set(cacheEntry.key, { fingerprint: cacheEntry.fingerprint, result: snapshot(result) });
      return send(result.status, result.body);
    } catch (error) {
      const result: HttpResult = error instanceof ReviewError
        ? { status: error.status, body: { error: { code: error.code, message: error.message } } }
        : { status: 500, body: { error: { code: 'internal_error', message: 'Erro interno.' } } };
      if (cacheEntry) idempotencyCache.set(cacheEntry.key, { fingerprint: cacheEntry.fingerprint, result });
      return send(result.status, result.body);
    }
  });
}
