export const BRAND_TIME_ZONE = 'America/Sao_Paulo';

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function partsAt(epochMs: number, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map(({ type, value }) => [type, Number(value)])) as unknown as ZonedParts;
}

// Resolve a wall-clock time in an IANA zone without assuming a fixed UTC offset.
function zonedMidnightEpoch(date: string, timeZone: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const targetUtcLike = Date.UTC(year, month - 1, day, 0, 0, 0);
  let candidate = targetUtcLike;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = partsAt(candidate, timeZone);
    const actualUtcLike = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const adjustment = targetUtcLike - actualUtcLike;
    candidate += adjustment;
    if (adjustment === 0) break;
  }
  return candidate;
}

function nextCalendarDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

export function deadlineEndExclusive(deadlineDate: string, timeZone = BRAND_TIME_ZONE): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadlineDate)) throw new TypeError('Prazo deve estar no formato YYYY-MM-DD.');
  const [year, month, day] = deadlineDate.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  if (check !== deadlineDate) throw new TypeError('Data de prazo inválida.');
  return zonedMidnightEpoch(nextCalendarDate(deadlineDate), timeZone);
}

export type ReviewStatus = 'in_review' | 'changes_requested' | 'approved';
export type VersionStatus = 'in_review' | 'changes_requested' | 'superseded' | 'approved';

export interface ChangeRequest {
  reason: string;
  deadlineDate: string;
  deadlineAt: string;
}

export interface ScriptVersion {
  number: number;
  text: string;
  status: VersionStatus;
  submittedAt: string;
  changeRequest: ChangeRequest | null;
}

export interface ScriptReview {
  campaignId: string;
  status: ReviewStatus;
  versions: ScriptVersion[];
  approvedAt: string | null;
}

export class ReviewError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class ScriptReviewService {
  #reviews = new Map<string, ScriptReview>();
  private readonly clock: () => number;

  constructor({ clock = () => Date.now() }: { clock?: () => number } = {}) {
    this.clock = clock;
  }

  get(campaignId: string): ScriptReview | null {
    return this.#reviews.get(campaignId) ?? null;
  }

  submit(campaignId: string, { text }: { text?: unknown }): ScriptReview {
    if (typeof text !== 'string' || !text.trim()) throw new ReviewError(400, 'invalid_text', 'O roteiro não pode ficar vazio.');
    const review: ScriptReview = this.#reviews.get(campaignId) ?? { campaignId, status: 'in_review', versions: [], approvedAt: null };
    if (review.status === 'approved') throw new ReviewError(409, 'review_closed', 'A revisão já foi aprovada e está encerrada.');
    if (review.versions.length && review.versions.at(-1)?.status !== 'changes_requested') {
      throw new ReviewError(409, 'resubmission_not_allowed', 'Só é possível reenviar após um pedido de alteração.');
    }

    const previousVersion = review.versions.at(-1);
    if (previousVersion) previousVersion.status = 'superseded';
    const version: ScriptVersion = {
      number: review.versions.length + 1,
      text: text.trim(),
      status: 'in_review',
      submittedAt: new Date(this.clock()).toISOString(),
      changeRequest: null,
    };
    review.versions.push(version);
    review.status = 'in_review';
    this.#reviews.set(campaignId, review);
    return review;
  }

  requestChanges(campaignId: string, { reason, deadlineDate }: { reason?: unknown; deadlineDate?: unknown }): ScriptReview {
    const review = this.#reviews.get(campaignId);
    if (!review || review.status === 'approved') throw new ReviewError(409, 'review_closed', 'Não há revisão aberta para alterar.');
    if (typeof reason !== 'string' || !reason.trim()) throw new ReviewError(400, 'invalid_reason', 'Informe o motivo da alteração.');
    if (typeof deadlineDate !== 'string' || !deadlineDate.trim()) throw new ReviewError(400, 'invalid_deadline', 'Informe o prazo da alteração.');
    let deadlineAt: number;
    try {
      deadlineAt = deadlineEndExclusive(deadlineDate);
    } catch {
      throw new ReviewError(400, 'invalid_deadline', 'Informe uma data válida no formato YYYY-MM-DD.');
    }
    if (this.clock() >= deadlineAt) throw new ReviewError(400, 'deadline_passed', 'O prazo informado já passou no fuso da marca.');
    const version = review.versions.at(-1);
    if (!version || version.status !== 'in_review') throw new ReviewError(409, 'invalid_state', 'A versão atual não está aguardando revisão.');
    version.status = 'changes_requested';
    version.changeRequest = { reason: reason.trim(), deadlineDate, deadlineAt: new Date(deadlineAt).toISOString() };
    review.status = 'changes_requested';
    return review;
  }

  approve(campaignId: string): ScriptReview {
    const review = this.#reviews.get(campaignId);
    if (!review || review.status === 'approved') throw new ReviewError(409, 'review_closed', 'Não há revisão aberta para aprovar.');
    const version = review.versions.at(-1);
    if (!version || version.status !== 'in_review') throw new ReviewError(409, 'invalid_state', 'A versão atual não está aguardando aprovação.');
    version.status = 'approved';
    review.status = 'approved';
    review.approvedAt = new Date(this.clock()).toISOString();
    return review;
  }
}
