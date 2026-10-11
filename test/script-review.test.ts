import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.ts';
import { deadlineEndExclusive, ScriptReviewService } from '../src/script-review.ts';

async function withApi(t: TestContext, service: ScriptReviewService): Promise<string> {
  const server = createApp({ service });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test('prazo inclui o último milissegundo do dia em São Paulo e expira no seguinte', () => {
  const endExclusive = deadlineEndExclusive('2026-10-11');
  const lastInstant = endExclusive - 1;
  const firstInstantNextDay = endExclusive;
  const service = new ScriptReviewService({ clock: () => lastInstant });
  service.submit('c-1', { text: 'Roteiro v1' });
  assert.doesNotThrow(() => service.requestChanges('c-1', { reason: 'Ajustar abertura', deadlineDate: '2026-10-11' }));

  const expiredService = new ScriptReviewService({ clock: () => firstInstantNextDay });
  expiredService.submit('c-2', { text: 'Roteiro v1' });
  assert.throws(() => expiredService.requestChanges('c-2', { reason: 'Ajustar abertura', deadlineDate: '2026-10-11' }), { code: 'deadline_passed' });
});

test('fluxo completo preserva versões e aprovação encerra a revisão', async (t) => {
  let now = Date.parse('2026-10-10T12:00:00.000Z');
  const base = await withApi(t, new ScriptReviewService({ clock: () => now++ }));
  const post = async (path: string, body: object) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  let response = await post('/campaigns/campanha-42/script-review', { text: 'Roteiro inicial' });
  assert.equal(response.status, 201);
  response = await post('/campaigns/campanha-42/script-review/request-changes', { reason: 'Inclua o benefício no começo', deadlineDate: '2026-10-12' });
  assert.equal(response.status, 201);
  response = await post('/campaigns/campanha-42/script-review', { text: 'Roteiro revisado' });
  assert.equal(response.status, 201);
  response = await post('/campaigns/campanha-42/script-review/approve', {});
  assert.equal(response.status, 200);
  const approved = (await response.json() as { data: { status: string; versions: Array<{ status: string }> } }).data;
  assert.equal(approved.status, 'approved');
  assert.equal(approved.versions.length, 2);
  assert.equal(approved.versions[0].status, 'superseded');
  assert.equal(approved.versions[1].status, 'approved');

  response = await post('/campaigns/campanha-42/script-review', { text: 'Terceira versão' });
  assert.equal(response.status, 409);
  response = await post('/campaigns/campanha-42/script-review/request-changes', { reason: 'Outra alteração', deadlineDate: '2026-10-12' });
  assert.equal(response.status, 409);
});

test('pedido de alteração exige motivo e prazo', () => {
  const service = new ScriptReviewService();
  service.submit('campanha', { text: 'Roteiro' });
  assert.throws(() => service.requestChanges('campanha', { reason: '   ', deadlineDate: '2026-10-12' }), { code: 'invalid_reason' });
  assert.throws(() => service.requestChanges('campanha', { reason: 'Alterar', deadlineDate: '' }), { code: 'invalid_deadline' });
});

test('bloqueia transições fora do fluxo permitido', () => {
  const service = new ScriptReviewService();
  service.submit('estados', { text: 'Versão 1' });
  assert.throws(() => service.submit('estados', { text: 'Versão duplicada' }), { code: 'resubmission_not_allowed' });

  service.requestChanges('estados', { reason: 'Ajustar o início', deadlineDate: '2099-12-31' });
  assert.throws(() => service.requestChanges('estados', { reason: 'Outro ajuste', deadlineDate: '2099-12-31' }), { code: 'invalid_state' });

  service.submit('estados', { text: 'Versão 2' });
  service.approve('estados');
  assert.throws(() => service.approve('estados'), { code: 'review_closed' });
  assert.throws(() => service.requestChanges('estados', { reason: 'Reabrir', deadlineDate: '2099-12-31' }), { code: 'review_closed' });
  assert.throws(() => service.submit('estados', { text: 'Versão 3' }), { code: 'review_closed' });
});

test('mesma chave e mesmo corpo repetem a primeira resposta sem criar outra versão', async (t) => {
  const base = await withApi(t, new ScriptReviewService());
  const send = () => fetch(`${base}/campaigns/campanha-idempotente/script-review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'submit-v1' },
    body: JSON.stringify({ text: 'Roteiro único' }),
  });
  const first = await send();
  const firstBody = await first.json() as { data: { status: string; versions: Array<{ text: string }> } };
  assert.equal(firstBody.data.status, 'in_review');
  assert.equal(firstBody.data.versions.length, 1);
  assert.equal(firstBody.data.versions[0].text, 'Roteiro único');

  const requested = await fetch(`${base}/campaigns/campanha-idempotente/script-review/request-changes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'Ajustar o final', deadlineDate: '2099-12-31' }),
  });
  assert.equal(requested.status, 201);
  const resubmitted = await fetch(`${base}/campaigns/campanha-idempotente/script-review`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Roteiro revisado' }),
  });
  assert.equal(resubmitted.status, 201);

  const retry = await send();
  assert.equal(retry.status, first.status);
  assert.deepEqual(await retry.json(), firstBody);

  const read = await fetch(`${base}/campaigns/campanha-idempotente/script-review`);
  const review = (await read.json() as { data: { status: string; versions: Array<{ text: string; status: string }> } }).data;
  assert.equal(review.status, 'in_review');
  assert.equal(review.versions.length, 2);
  assert.equal(review.versions[0].text, 'Roteiro único');
  assert.equal(review.versions[0].status, 'superseded');
  assert.equal(review.versions[1].text, 'Roteiro revisado');
});

test('a mesma chave com outro corpo retorna conflito', async (t) => {
  const base = await withApi(t, new ScriptReviewService());
  const send = (text: string) => fetch(`${base}/campaigns/campanha-conflito/script-review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'same-key' },
    body: JSON.stringify({ text }),
  });
  assert.equal((await send('Roteiro A')).status, 201);
  const conflict = await send('Roteiro B');
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { error: { code: string } }).error.code, 'idempotency_key_reused');
});
