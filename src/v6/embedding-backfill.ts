// 임베딩 백필(벡터검색 #172) — "뒤늦게 켜는" 케이스의 핵심: 이미 저장된 지식은 provider 를 켜는 것만으론
//  임베딩이 안 채워진다(쓰기훅 embedKnowledgeBestEffort 는 저장/수정 때만 돈다). 기존 미임베딩분을 배치로 메운다.
//
//  ⚠ 단일 소스: CLI(scripts/backfill-embeddings.mjs)·REST(POST /api/ui/org/embeddings/backfill)·설치(deploy)가
//   모두 이 코어를 쓴다. 로직 중복 금지.
//
//  재진입/재실행 안전: 기본 모드는 embedding_vector IS NULL 잔여만 집어 갱신 → 중단/재실행해도 채운 행은 안 건드린다.
//  config: org_runtime_config.embedding_config(DB) 우선, 비면 env(EMBEDDINGS_*) 시드 — 쓰기경로·CLI 와 동일 해소.
import { itemsPool } from "../items/store.js";
import {
  type EmbeddingConfig,
  resolveEmbeddingConfig,
  resolveEmbeddingProvider,
  ensureEmbeddingSchema,
  embeddingInputText,
  toVectorLiteral,
} from "./embedding-provider.js";

const BATCH = 32;

export type BackfillMode = "pending" | "model-changed" | "all";
//  pending      = embedding_vector IS NULL 인 active 지식만(신규/미임베딩 보강 — 처음 켤 때).
//  model-changed = 위 + embedding_model 이 현재 모델과 다른 행(모델 스왑 후).
//  all          = active 지식 전부 재임베딩(차원/모델 전면 교체 후).

export interface BackfillProgress { total: number; done: number }

// ok=false 면 reason 으로 사유 구분: off(provider 미설정)·schema(pgvector 부재)·unavailable(엔드포인트)·error:*(배치 실패).
export interface BackfillResult {
  ok: boolean;
  embedded: number;
  reason?: "off" | "schema" | "unavailable" | string;
  model?: string;
  dimensions?: number;
}

// config 해소 — DB(org_runtime_config.embedding_config) 우선, 비면 env(EMBEDDINGS_*) 시드. 테이블 없으면 env 만.
async function resolveConfigFromDb(): Promise<EmbeddingConfig> {
  let dbRaw: unknown = null;
  try {
    const r = await itemsPool.query(`SELECT embedding_config FROM org_runtime_config WHERE id=1`);
    dbRaw = (r.rows[0] as { embedding_config?: unknown } | undefined)?.embedding_config ?? null;
  } catch {
    /* org_runtime_config 없으면 env 만으로 */
  }
  return resolveEmbeddingConfig(dbRaw);
}

// active 지식 총계 + 미임베딩(embedding_vector IS NULL) 수. 컬럼 부재(구 DB)면 pending=total 로 안전 폴백.
export async function countEmbeddingBacklog(): Promise<{ total: number; pending: number }> {
  const totalR = await itemsPool.query(`SELECT count(*)::int AS n FROM knowledge WHERE lifecycle='active'`);
  const total = (totalR.rows[0] as { n: number } | undefined)?.n ?? 0;
  try {
    const pendR = await itemsPool.query(
      `SELECT count(*)::int AS n FROM knowledge WHERE lifecycle='active' AND embedding_vector IS NULL`,
    );
    return { total, pending: (pendR.rows[0] as { n: number } | undefined)?.n ?? 0 };
  } catch {
    return { total, pending: total }; // 컬럼 없음 → 전량 미임베딩 취급
  }
}

async function countTarget(mode: BackfillMode, model: string): Promise<number> {
  if (mode === "all") return (await countEmbeddingBacklog()).total;
  if (mode === "pending") return (await countEmbeddingBacklog()).pending;
  try {
    const r = await itemsPool.query(
      `SELECT count(*)::int AS n FROM knowledge
         WHERE lifecycle='active' AND (embedding_vector IS NULL OR embedding_model IS DISTINCT FROM $1)`,
      [model],
    );
    return (r.rows[0] as { n: number } | undefined)?.n ?? 0;
  } catch {
    return 0;
  }
}

// 백필 코어. provider on(config)·pgvector 스키마·엔드포인트 가용이 전제 — 아니면 ok:false + reason 으로 조기 반환(무변경).
//  onProgress 로 진행률, shouldStop 으로 협조적 중단(UI 취소·셧다운). 배치 실패는 ok:false(error:*) — 채운 데까지 보존.
export async function runEmbeddingBackfill(opts: {
  mode?: BackfillMode;
  onProgress?: (p: BackfillProgress) => void;
  shouldStop?: () => boolean;
} = {}): Promise<BackfillResult> {
  const mode: BackfillMode = opts.mode ?? "pending";
  const cfg = await resolveConfigFromDb();
  const provider = resolveEmbeddingProvider(cfg);
  if (!provider) return { ok: false, embedded: 0, reason: "off" };

  // 스키마 보장(pgvector 확장 + 컬럼/인덱스). 부재면 graceful false.
  const schemaOk = await ensureEmbeddingSchema(itemsPool, cfg.dimensions);
  if (!schemaOk) return { ok: false, embedded: 0, reason: "schema", model: provider.model, dimensions: provider.dimensions };

  // 엔드포인트 헬스 — reachable + 차원 일치(잘못된 base_url/model 조기 차단).
  if (!(await provider.isAvailable())) {
    return { ok: false, embedded: 0, reason: "unavailable", model: provider.model, dimensions: provider.dimensions };
  }

  const total = await countTarget(mode, provider.model);
  opts.onProgress?.({ total, done: 0 });

  // 대상 필터 — 기본 IS NULL, model-changed 면 모델 불일치도, all 이면 전부.
  const params: unknown[] = [];
  let where: string;
  if (mode === "all") {
    where = `lifecycle='active'`;
  } else if (mode === "model-changed") {
    params.push(provider.model);
    where = `lifecycle='active' AND (embedding_vector IS NULL OR embedding_model IS DISTINCT FROM $1)`;
  } else {
    where = `lifecycle='active' AND embedding_vector IS NULL`;
  }

  let done = 0;
  try {
    for (;;) {
      if (opts.shouldStop?.()) break;
      // 재진입 안전: all 은 이미 처리한 행을 다시 잡으므로 OFFSET 으로 진행(같은 배치 무한루프 방지).
      //  pending/model-changed 는 UPDATE 로 조건에서 빠지므로 OFFSET 0 으로 항상 '남은 것'의 앞을 집는다.
      const offset = mode === "all" ? done : 0;
      const { rows } = await itemsPool.query(
        `SELECT name, title, summary, body_md FROM knowledge
           WHERE ${where}
           ORDER BY updated_at DESC NULLS LAST
           LIMIT ${BATCH} OFFSET ${offset}`,
        params,
      );
      if (rows.length === 0) break;

      const texts = rows.map((r) => embeddingInputText(r as { title?: string | null; summary?: string | null; body_md?: string | null }));
      const vecs = await provider.embed(texts);
      for (let i = 0; i < rows.length; i++) {
        const vec = vecs[i];
        if (!vec || !vec.length) continue;
        await itemsPool.query(
          `UPDATE knowledge SET embedding_vector=$2::vector, embedding_model=$3, embedding_updated_at=now() WHERE name=$1`,
          [(rows[i] as { name: string }).name, toVectorLiteral(vec), provider.model],
        );
        done++;
      }
      opts.onProgress?.({ total: Math.max(total, done), done });
    }
    return { ok: true, embedded: done, model: provider.model, dimensions: provider.dimensions };
  } catch (e) {
    return { ok: false, embedded: done, reason: `error: ${(e as Error)?.message ?? e}`, model: provider.model, dimensions: provider.dimensions };
  }
}

// ── 인프로세스 백필 잡(웹 UI 트리거) — 게이트웨이 프로세스 내 단일 실행. 진행률은 폴링(GET /api/ui/org/embeddings). ──
//  잡 유실(재시작)돼도 백필은 재진입 안전이라 다시 트리거하면 남은 것만 이어서. 동시 실행은 already-running 으로 거부.
export interface BackfillJob {
  running: boolean;
  mode: BackfillMode;
  total: number;
  done: number;
  embedded: number;
  model: string | null;
  reason: string | null;   // 실패 사유(off/schema/unavailable/error:*) — 성공이면 null
  startedAt: string;
  finishedAt: string | null;
}

let currentJob: BackfillJob | null = null;

export function getBackfillJob(): BackfillJob | null {
  return currentJob;
}

// 잡 시작(fire-and-forget). 이미 돌면 started:false. 진행은 getBackfillJob() 폴링.
export function startBackfillJob(mode: BackfillMode = "pending"): { started: boolean; job: BackfillJob | null } {
  if (currentJob?.running) return { started: false, job: currentJob };
  const job: BackfillJob = {
    running: true, mode, total: 0, done: 0, embedded: 0, model: null, reason: null,
    startedAt: new Date().toISOString(), finishedAt: null,
  };
  currentJob = job;
  void runEmbeddingBackfill({
    mode,
    onProgress: (p) => { job.total = p.total; job.done = p.done; },
  })
    .then((res) => {
      job.embedded = res.embedded;
      job.model = res.model ?? null;
      job.reason = res.ok ? null : (res.reason ?? "error");
    })
    .catch((e) => { job.reason = `error: ${(e as Error)?.message ?? e}`; })
    .finally(() => { job.running = false; job.finishedAt = new Date().toISOString(); });
  return { started: true, job };
}
