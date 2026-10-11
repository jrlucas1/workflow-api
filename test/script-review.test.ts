import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.ts';
import { ScriptReviewService } from '../src/script-review.ts';

async function withApi(t: TestContext, service: ScriptReviewService): Promise<string> {
  const server = createApp({ service });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const postJson = (base: string, path: string, body: unknown) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

// São Paulo está em UTC-3: o dia 11/10 termina em 12/10 às 03:00 UTC.
const LAST_INSTANT_OF_OCT_11 = Date.parse('2026-10-12T02:59:59.999Z');
const FIRST_INSTANT_OF_OCT_12 = Date.parse('2026-10-12T03:00:00.000Z');

test('prazo ainda vale no último instante do dia em São Paulo, com o UTC já no dia seguinte', () => {
  const service = new ScriptReviewService({ clock: () => LAST_INSTANT_OF_OCT_11 });
  service.submit('c-1', { text: 'Roteiro v1' });
  const review = service.requestChanges('c-1', { reason: 'Ajustar abertura', deadlineDate: '2026-10-11' });
  assert.equal(review.status, 'changes_requested');
  assert.deepEqual(review.versions[0].changeRequests, [{
    reason: 'Ajustar abertura',
    deadlineDate: '2026-10-11',
    deadlineAt: '2026-10-12T03:00:00.000Z',
    requestedAt: '2026-10-12T02:59:59.999Z',
    status: 'open',
  }]);
});

test('criador reenvia até o último instante do prazo; no instante seguinte o pedido expira', () => {
  let now = Date.parse('2026-10-10T12:00:00.000Z');
  const service = new ScriptReviewService({ clock: () => now });
  for (const id of ['no-prazo', 'atrasado']) {
    service.submit(id, { text: 'Roteiro v1' });
    service.requestChanges(id, { reason: 'Ajustar abertura', deadlineDate: '2026-10-11' });
  }

  now = LAST_INSTANT_OF_OCT_11;
  const onTime = service.submit('no-prazo', { text: 'Roteiro v2' });
  assert.equal(onTime.versions.length, 2);
  assert.equal(onTime.versions[0].changeRequests[0].status, 'fulfilled');

  now = FIRST_INSTANT_OF_OCT_12;
  assert.throws(() => service.submit('atrasado', { text: 'Roteiro v2' }), { code: 'change_request_expired' });
  const late = service.get('atrasado')!;
  assert.equal(late.status, 'in_review');
  assert.equal(late.versions.length, 1);
  assert.equal(late.versions[0].status, 'in_review');
  assert.equal(late.versions[0].changeRequests[0].status, 'expired');

  // A marca pode pedir de novo com outro prazo; o pedido expirado continua no histórico.
  service.requestChanges('atrasado', { reason: 'Ajustar abertura', deadlineDate: '2026-10-13' });
  const reopened = service.submit('atrasado', { text: 'Roteiro v2' });
  assert.deepEqual(reopened.versions[0].changeRequests.map((request) => request.status), ['expired', 'fulfilled']);
  assert.equal(reopened.versions[1].text, 'Roteiro v2');
});

test('leitura mostra o pedido expirado sem gravar nada', () => {
  let now = Date.parse('2026-10-10T12:00:00.000Z');
  const service = new ScriptReviewService({ clock: () => now });
  service.submit('leitura', { text: 'Roteiro v1' });
  service.requestChanges('leitura', { reason: 'Ajustar abertura', deadlineDate: '2026-10-11' });

  now = FIRST_INSTANT_OF_OCT_12;
  const expired = service.get('leitura')!;
  assert.equal(expired.status, 'in_review');
  assert.equal(expired.versions[0].changeRequests[0].status, 'expired');

  // Voltar o relógio só é possível no teste: se a leitura tivesse gravado, o pedido continuaria expirado.
  now = LAST_INSTANT_OF_OCT_11;
  const open = service.get('leitura')!;
  assert.equal(open.status, 'changes_requested');
  assert.equal(open.versions[0].changeRequests[0].status, 'open');
});

test('prazo não vale mais no primeiro instante do dia seguinte em São Paulo', () => {
  const service = new ScriptReviewService({ clock: () => FIRST_INSTANT_OF_OCT_12 });
  service.submit('c-2', { text: 'Roteiro v1' });
  assert.throws(() => service.requestChanges('c-2', { reason: 'Ajustar abertura', deadlineDate: '2026-10-11' }), { code: 'deadline_passed' });
  assert.equal(service.get('c-2')?.status, 'in_review');
  assert.doesNotThrow(() => service.requestChanges('c-2', { reason: 'Ajustar abertura', deadlineDate: '2026-10-12' }));
});

test('fluxo completo preserva versões e aprovação encerra a revisão', async (t) => {
  let now = Date.parse('2026-10-10T12:00:00.000Z');
  const base = await withApi(t, new ScriptReviewService({ clock: () => now++ }));
  const path = '/campaigns/campanha-42/script-review';

  let response = await postJson(base, path, { text: 'Roteiro inicial' });
  assert.equal(response.status, 201);
  response = await postJson(base, `${path}/request-changes`, { reason: 'Inclua o benefício no começo', deadlineDate: '2026-10-12' });
  assert.equal(response.status, 201);
  response = await postJson(base, path, { text: 'Roteiro revisado' });
  assert.equal(response.status, 201);
  response = await postJson(base, `${path}/approve`, {});
  assert.equal(response.status, 200);

  type Review = { status: string; approvedAt: string | null; versions: Array<{ number: number; text: string; status: string; changeRequests: Array<{ reason: string; deadlineDate: string; status: string }> }> };
  const approved = (await response.json() as { data: Review }).data;
  assert.equal(approved.status, 'approved');
  assert.notEqual(approved.approvedAt, null);
  assert.equal(approved.versions.length, 2);
  assert.equal(approved.versions[0].text, 'Roteiro inicial');
  assert.equal(approved.versions[0].status, 'superseded');
  assert.equal(approved.versions[0].changeRequests.length, 1);
  assert.equal(approved.versions[0].changeRequests[0].reason, 'Inclua o benefício no começo');
  assert.equal(approved.versions[0].changeRequests[0].deadlineDate, '2026-10-12');
  assert.equal(approved.versions[0].changeRequests[0].status, 'fulfilled');
  assert.equal(approved.versions[1].text, 'Roteiro revisado');
  assert.equal(approved.versions[1].status, 'approved');

  response = await postJson(base, path, { text: 'Terceira versão' });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: { code: string } }).error.code, 'review_closed');
  response = await postJson(base, `${path}/request-changes`, { reason: 'Outra alteração', deadlineDate: '2026-10-12' });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: { code: string } }).error.code, 'review_closed');
  response = await postJson(base, `${path}/approve`, {});
  assert.equal(response.status, 409);

  const read = await fetch(`${base}${path}`);
  assert.deepEqual((await read.json() as { data: Review }).data, approved);
});

test('pedido de alteração sem motivo ou sem prazo não passa', async (t) => {
  const base = await withApi(t, new ScriptReviewService({ clock: () => Date.parse('2026-10-10T12:00:00.000Z') }));
  const path = '/campaigns/campanha/script-review';
  await postJson(base, path, { text: 'Roteiro' });

  const cases: Array<[body: object, code: string]> = [
    [{ deadlineDate: '2026-10-12' }, 'invalid_reason'],
    [{ reason: '   ', deadlineDate: '2026-10-12' }, 'invalid_reason'],
    [{ reason: 42, deadlineDate: '2026-10-12' }, 'invalid_reason'],
    [{ reason: 'Alterar' }, 'invalid_deadline'],
    [{ reason: 'Alterar', deadlineDate: '' }, 'invalid_deadline'],
    [{ reason: 'Alterar', deadlineDate: null }, 'invalid_deadline'],
    [{ reason: 'Alterar', deadlineDate: '2026-02-30' }, 'invalid_deadline'],
    [{ reason: 'Alterar', deadlineDate: '2026-10-12T23:59:59-03:00' }, 'invalid_deadline'],
    [{ reason: 'Alterar', deadlineDate: '2026-10-09' }, 'deadline_passed'],
  ];
  for (const [body, code] of cases) {
    const response = await postJson(base, `${path}/request-changes`, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json() as { error: { code: string } }).error.code, code, JSON.stringify(body));
  }

  const read = await fetch(`${base}${path}`);
  const review = (await read.json() as { data: { status: string; versions: Array<{ changeRequests: unknown[] }> } }).data;
  assert.equal(review.status, 'in_review');
  assert.deepEqual(review.versions[0].changeRequests, []);
});

test('bloqueia transições fora do fluxo permitido', () => {
  const service = new ScriptReviewService({ clock: () => Date.parse('2026-10-10T12:00:00.000Z') });
  assert.throws(() => service.submit('estados', { text: '   ' }), { code: 'invalid_text' });
  service.submit('estados', { text: 'Versão 1' });
  assert.throws(() => service.submit('estados', { text: 'Versão duplicada' }), { code: 'resubmission_not_allowed' });

  service.requestChanges('estados', { reason: 'Ajustar o início', deadlineDate: '2026-10-12' });
  assert.throws(() => service.requestChanges('estados', { reason: 'Outro ajuste', deadlineDate: '2026-10-12' }), { code: 'invalid_state' });
  assert.throws(() => service.approve('estados'), { code: 'invalid_state' });

  service.submit('estados', { text: 'Versão 2' });
  service.approve('estados');
  assert.throws(() => service.approve('estados'), { code: 'review_closed' });
  assert.throws(() => service.requestChanges('estados', { reason: 'Reabrir', deadlineDate: '2026-10-12' }), { code: 'review_closed' });
  assert.throws(() => service.submit('estados', { text: 'Versão 3' }), { code: 'review_closed' });
});

test('campanha sem revisão retorna 404 e identificador malformado retorna 400', async (t) => {
  const base = await withApi(t, new ScriptReviewService());
  const path = '/campaigns/inexistente/script-review';
  assert.equal((await fetch(`${base}${path}`)).status, 404);
  assert.equal((await postJson(base, `${path}/approve`, {})).status, 404);
  assert.equal((await postJson(base, `${path}/request-changes`, { reason: 'Alterar', deadlineDate: '2099-12-31' })).status, 404);
  assert.equal((await fetch(`${base}/campaigns/%E0%A4%A/script-review`)).status, 400);
});
