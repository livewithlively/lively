// 임베딩 백필(벡터검색 #172, 프로젝트 검색 #631) — "뒤늦게 켜는" 케이스의 핵심: 이미 저장된 행은 provider 를
//  켜는 것만으론 임베딩이 안 채워진다(쓰기훅 embed*BestEffort 는 저장/수정 때만 돈다). 기존 미임베딩분을 배치로 메운다.
//
//  ⚠ 단일 소스: CLI(scripts/backfill-embeddings.mjs)·REST(POST /api/ui/org/embeddings/backfill 등)·설치(deploy)가
//   모두 이 코어를 쓴다. 로직 중복 금지. 임베딩 타깃(knowledge·project…)은 EmbeddingTarget 로 파라미터화 — 배치/잡/모드
//   로직은 공유하고, 테이블/키/텍스트조립만 타깃별로 다르다(#631).
//
//  재진입/재실행 안전: 기본 모드는 embedding_vector IS NULL 잔여만 집어 갱신 → 중단/재실행해도 채운 행은 안 건드린다.
//  config: org_runtime_config.embedding_config(DB) 우선, 비면 env(EMBEDDINGS_*) 시드 — 모든 타깃 공유(같은 모델·차원).
import { itemsPool } from "../items/store.js";
import {
  type EmbeddingConfig,
  resolveEmbeddingConfig,
  resolveEmbeddingProvider,
  ensureEmbeddingSchema,
  embeddingInputText,
  toVectorLiteral,
} from "./embedding-provider.js";
import { memAvailableMb } from "../host-mem.js"; // #1059 백필 pre-flight 메모리 게이트

export type BackfillMode = "pending" | "model-changed" | "all";
//  pending      = embedding_vector IS NULL 인 active 행만(신규/미임베딩 보강 — 처음 켤 때).
//  model-changed = 위 + embedding_model 이 현재 모델과 다른 행(모델 스왑 후).
//  all          = active 행 전부 재임베딩(차원/모델 전면 교체 후).

// ── 임베딩 타깃 — 어느 테이블의 어떤 텍스트를 임베딩하나. 배치/잡/모드는 공유, 이 셋만 타깃별로 다르다. ──
export interface EmbeddingTarget {
  name: string;                                        // 잡 키 + 라벨(타깃별 잡 독립 실행)
  table: string;                                       // 대상 테이블(embedding_vector 컬럼 보유)
  idCol: string;                                       // PK 컬럼(UPDATE 키) — knowledge='name', project='id'
  activeFilter: string;                                // 백필 대상 행 필터(SQL boolean) — knowledge="lifecycle='active'", project="TRUE"
  selectCols: string;                                  // buildText 에 필요한 SELECT 컬럼들(idCol 포함)
  buildText: (row: Record<string, unknown>) => string; // 행 → 임베딩 입력 텍스트
}

// 지식: 제목+요약+본문(기존 동작 그대로). idCol='name', active 만.
export const KNOWLEDGE_TARGET: EmbeddingTarget = {
  name: "knowledge",
  table: "knowledge",
  idCol: "name",
  activeFilter: "lifecycle='active'",
  selectCols: "name, title, summary, body_md",
  buildText: (r) => embeddingInputText(r as { title?: string | null; summary?: string | null; body_md?: string | null }),
};

// 프로젝트(project·task·subtask 통합 테이블): name+description. idCol='id'(int), lifecycle 컬럼 없음 → 전 행 대상(TRUE).
//  name→title, description→body_md 로 매핑해 knowledge 와 같은 embeddingInputText(8000자 캡) 재사용.
export const PROJECT_TARGET: EmbeddingTarget = {
  name: "project",
  table: "project",
  idCol: "id",
  activeFilter: "folder IS DISTINCT FROM '__board_anchor__'", // 내부 보드 앵커(__board__)는 검색·임베딩 대상 아님
  selectCols: "id, name, description",
  buildText: (r) => embeddingInputText({ title: (r as { name?: string | null }).name, body_md: (r as { description?: string | null }).description }),
};

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
//  (타깃 무관 — 임베딩 설정은 조직 단일. 모든 타깃이 같은 모델·차원을 쓴다.)
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

// 대상 총계 + 미임베딩(embedding_vector IS NULL) 수. 컬럼 부재(구 DB)면 pending=total 로 안전 폴백.
export async function countEmbeddingBacklog(target: EmbeddingTarget = KNOWLEDGE_TARGET): Promise<{ total: number; pending: number }> {
  const totalR = await itemsPool.query(`SELECT count(*)::int AS n FROM ${target.table} WHERE ${target.activeFilter}`);
  const total = (totalR.rows[0] as { n: number } | undefined)?.n ?? 0;
  try {
    const pendR = await itemsPool.query(
      `SELECT count(*)::int AS n FROM ${target.table} WHERE ${target.activeFilter} AND embedding_vector IS NULL`,
    );
    return { total, pending: (pendR.rows[0] as { n: number } | undefined)?.n ?? 0 };
  } catch {
    return { total, pending: total }; // 컬럼 없음 → 전량 미임베딩 취급
  }
}

async function countByMode(mode: BackfillMode, model: string, target: EmbeddingTarget): Promise<number> {
  if (mode === "all") return (await countEmbeddingBacklog(target)).total;
  if (mode === "pending") return (await countEmbeddingBacklog(target)).pending;
  try {
    const r = await itemsPool.query(
      `SELECT count(*)::int AS n FROM ${target.table}
         WHERE ${target.activeFilter} AND (embedding_vector IS NULL OR embedding_model IS DISTINCT FROM $1)`,
      [model],
    );
    return (r.rows[0] as { n: number } | undefined)?.n ?? 0;
  } catch {
    return 0;
  }
}

// 백필 코어. provider on(config)·pgvector 스키마·엔드포인트 가용이 전제 — 아니면 ok:false + reason 으로 조기 반환(무변경).
//  onProgress 로 진행률, shouldStop 으로 협조적 중단(UI 취소·셧다운). 배치 실패는 ok:false(error:*) — 채운 데까지 보존.
//  target 기본=knowledge(기존 호출부 무변경). #631 은 PROJECT_TARGET 로 프로젝트 테이블을 백필.
export async function runEmbeddingBackfill(opts: {
  mode?: BackfillMode;
  onProgress?: (p: BackfillProgress) => void;
  shouldStop?: () => boolean;
} = {}, target: EmbeddingTarget = KNOWLEDGE_TARGET): Promise<BackfillResult> {
  const mode: BackfillMode = opts.mode ?? "pending";
  const cfg = await resolveConfigFromDb();
  const provider = resolveEmbeddingProvider(cfg);
  if (!provider) return { ok: false, embedded: 0, reason: "off" };

  // 스키마 보장(pgvector 확장 + 컬럼/인덱스). 부재면 graceful false.
  const schemaOk = await ensureEmbeddingSchema(itemsPool, cfg.dimensions, target.table);
  if (!schemaOk) return { ok: false, embedded: 0, reason: "schema", model: provider.model, dimensions: provider.dimensions };

  // 엔드포인트 헬스 — reachable + 차원 일치(잘못된 base_url/model 조기 차단).
  if (!(await provider.isAvailable())) {
    return { ok: false, embedded: 0, reason: "unavailable", model: provider.model, dimensions: provider.dimensions };
  }

  const total = await countByMode(mode, provider.model, target);
  opts.onProgress?.({ total, done: 0 });

  // 배치 = provider 요청 단위(cfg.batch_size). DB fetch 배치 == 임베딩 요청 == 커밋 단위로 맞춘다(#602):
  //  배치마다 UPDATE 커밋되므로 죽음/재배포에도 채운 만큼 살아남고(재진입 안전), 요청당 시간이 타임아웃 안에 든다.
  //  provider 는 같은 cfg 로 생성돼 요청도 batch 크기 → 보통 배치당 1요청(느리면 provider 가 내부에서 반으로 축소 재시도).
  const batch = cfg.batch_size;

  // 대상 필터 — 기본 IS NULL, model-changed 면 모델 불일치도, all 이면 전부.
  const params: unknown[] = [];
  let where: string;
  if (mode === "all") {
    where = target.activeFilter;
  } else if (mode === "model-changed") {
    params.push(provider.model);
    where = `${target.activeFilter} AND (embedding_vector IS NULL OR embedding_model IS DISTINCT FROM $1)`;
  } else {
    where = `${target.activeFilter} AND embedding_vector IS NULL`;
  }

  let done = 0;
  try {
    for (;;) {
      if (opts.shouldStop?.()) break;
      // 재진입 안전: all 은 이미 처리한 행을 다시 잡으므로 OFFSET 으로 진행(같은 배치 무한루프 방지).
      //  pending/model-changed 는 UPDATE 로 조건에서 빠지므로 OFFSET 0 으로 항상 '남은 것'의 앞을 집는다.
      const offset = mode === "all" ? done : 0;
      const { rows } = await itemsPool.query(
        `SELECT ${target.selectCols} FROM ${target.table}
           WHERE ${where}
           ORDER BY updated_at DESC NULLS LAST
           LIMIT ${batch} OFFSET ${offset}`,
        params,
      );
      if (rows.length === 0) break;

      const texts = rows.map((r) => target.buildText(r as Record<string, unknown>));
      const vecs = await provider.embed(texts);
      for (let i = 0; i < rows.length; i++) {
        const vec = vecs[i];
        if (!vec || !vec.length) continue;
        await itemsPool.query(
          `UPDATE ${target.table} SET embedding_vector=$2::vector, embedding_model=$3, embedding_updated_at=now() WHERE ${target.idCol}=$1`,
          [(rows[i] as Record<string, unknown>)[target.idCol], toVectorLiteral(vec), provider.model],
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

// ── 자동 백필 일시중지(#1060) — 성능 이슈로 사람이 자동 임베딩 백필을 멈추고 재개하는 마스터 스위치. ──
//  SoT = org_runtime_config.embedding_backfill_paused(DB, 영속 — 재시작에도 유지되어 부팅 스윕이 존중한다).
//  인메모리 캐시(pausedCache)는 '동기' shouldStop 을 위한 라이브 신호다: runEmbeddingBackfill 의 배치 루프가 매 배치
//  경계에서 shouldStop()(동기 시그니처)을 부르므로 DB(비동기)를 못 읽는다 → 캐시로 즉시 판정한다. 캐시 갱신 경로 둘:
//   (a) REST 토글이 setBackfillPausedCache 로 즉시 반영(→ 실행 중 잡이 다음 배치에서 협조적 중단),
//   (b) 스윕 진입의 refreshBackfillPausedFromDb 가 DB 로 재수화(부팅 스윕이 영속 상태를 픽업).
//  게이트웨이는 단일 프로세스(스윕·REST 핸들러 동거)라 캐시가 정합적이다(스케줄러 게이트: LIVELY_NO_SCHEDULER).
let pausedCache = false;
export function isBackfillPaused(): boolean { return pausedCache; }
export function setBackfillPausedCache(paused: boolean): void { pausedCache = paused; }
// DB 의 일시중지 플래그를 읽어 캐시에 반영하고 반환. 컬럼/테이블 부재(구 DB)면 캐시 불변(기본 false=평소대로 자동 백필 — 하위호환).
export async function refreshBackfillPausedFromDb(): Promise<boolean> {
  try {
    const r = await itemsPool.query(`SELECT embedding_backfill_paused FROM org_runtime_config WHERE id=1`);
    pausedCache = (r.rows[0] as { embedding_backfill_paused?: unknown } | undefined)?.embedding_backfill_paused === true;
  } catch {
    /* 컬럼/테이블 부재(임베딩 미도입/구 DB) → 캐시 유지(기본 false). 스윕은 계속 돈다. */
  }
  return pausedCache;
}

// ── 인프로세스 백필 잡(웹 UI 트리거) — 게이트웨이 프로세스 내 단일 실행. 진행률은 폴링(GET /api/ui/org/embeddings 등). ──
//  잡 유실(재시작)돼도 백필은 재진입 안전이라 다시 트리거하면 남은 것만 이어서. 동시 실행은 already-running 으로 거부.
//  타깃별로 독립 잡(knowledge·project 를 동시에 돌릴 수 있다) — jobs Map 이 타깃명으로 보관.
export interface BackfillJob {
  target: string;
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

const jobs = new Map<string, BackfillJob>();

export function getBackfillJob(target: EmbeddingTarget = KNOWLEDGE_TARGET): BackfillJob | null {
  return jobs.get(target.name) ?? null;
}

// 잡 시작(fire-and-forget). 같은 타깃이 이미 돌면 started:false. 진행은 getBackfillJob(target) 폴링.
export function startBackfillJob(
  mode: BackfillMode = "pending",
  target: EmbeddingTarget = KNOWLEDGE_TARGET,
): { started: boolean; job: BackfillJob | null } {
  const existing = jobs.get(target.name);
  if (existing?.running) return { started: false, job: existing };
  const job: BackfillJob = {
    target: target.name, running: true, mode, total: 0, done: 0, embedded: 0, model: null, reason: null,
    startedAt: new Date().toISOString(), finishedAt: null,
  };
  jobs.set(target.name, job);
  void runEmbeddingBackfill({
    mode,
    onProgress: (p) => { job.total = p.total; job.done = p.done; },
    // #1060 — 일시중지 토글 시 현재 배치를 끝내고 협조적 중단(재진입 안전: 채운 만큼 커밋됨, pending 은 재개 때 이어서).
    //  자동 스윕 잡·수동 백필 잡 모두 이 게이트를 통과하므로, 일시중지는 어느 경로로 시작된 잡이든 멈춘다.
    shouldStop: () => isBackfillPaused(),
  }, target)
    .then((res) => {
      job.embedded = res.embedded;
      job.model = res.model ?? null;
      job.reason = res.ok ? null : (res.reason ?? "error");
    })
    .catch((e) => { job.reason = `error: ${(e as Error)?.message ?? e}`; })
    .finally(() => { job.running = false; job.finishedAt = new Date().toISOString(); });
  return { started: true, job };
}

// ── 자동 pending 백필 스윕(#669) — 쓰기훅·미러가 남긴 미임베딩 잔량을 게이트웨이가 스스로 줍는 안전망. ──
//  잔량의 출처: ① 커넥터 미러(신규 insert + 제목/본문 변경 시 embedding_* 리셋 — connector-mirror.ts)
//  ② 쓰기훅 best-effort 실패(엔드포인트 순단) ③ 임베딩 도입 전 스톡(뒤늦게 켜기·버전업 직후).
//  호출: 부팅 후·10분 주기(index.ts) + connector_sync 완료 후(scheduler.ts·delivery.ts).
//  ⚠ 게이트웨이 프로세스 전용 — run-sync 서브프로세스에서 부르면 잡이 관리 UI(getBackfillJob)에 안 보이고,
//   대량 스톡 드레인이 sync 런을 수십 분 붙들어 커서 전진·run 하트비트를 위협한다(그래서 미러는 리셋만 하고 떠난다).
//  비용 가드: provider off=설정 1회 조회 후 즉시 반환 · pending 0=카운트 쿼리만 · 스윕/잡 중복=자체 거부.
//  타깃 순차 — CPU 임베딩 백엔드(bge-m3 등)에서 두 잡이 동시에 돌아 요청당 시간이 늘어나 타임아웃에 가까워지는 것 방지.
let sweepRunning = false;
export async function runAutoBackfillSweep(): Promise<void> {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    // #1060 — 일시중지면 스윕 자체가 no-op. DB 를 읽어 캐시 재수화(부팅 스윕이 영속 상태를 픽업) 후 게이트한다.
    //  이 한 곳이 4개 자동 트리거(부팅 30초·10분 주기·connector_sync 완료 후·쓰기 nudge)의 공통 급소 — 전부 여기로 수렴한다.
    if (await refreshBackfillPausedFromDb()) return;
    const cfg = await resolveConfigFromDb();   // #1059 메모리 게이트가 cfg.backfill_min_available_mb 를 읽으므로 변수로 보관
    const provider = resolveEmbeddingProvider(cfg);
    if (!provider) return;
    // G2(#1059) 백필 pre-flight 메모리 게이트 — 임베딩 백엔드 로드(예: Ollama bge-m3 ~3.3GB)가 세션 baseline 과
    //  겹쳐 물리 초과→OOM 스래싱 되던 것(어니스트 2026-07-21)을 사전 회피. 가용 메모리가 임계 미만이면 이번 스윕을
    //  건너뛴다 — pending 은 DB 에 남아(embedding_vector IS NULL) 다음 주기(10분)·nudge 스윕이 여유 생기면 흡수(재진입 안전).
    //  0=비활성(무회귀). 수동 백필(startBackfillJob = 관리탭 버튼)은 사용자 명시 의도라 게이트하지 않는다 — 자동 스윕만.
    const minMb = cfg.backfill_min_available_mb;
    if (minMb > 0) {
      const availMb = await memAvailableMb();
      if (availMb < minMb) {
        console.warn(`[embedding] 자동 백필 스윕 보류 — 가용메모리 ${availMb}MB < 임계 ${minMb}MB (pending 유지, 다음 주기 재시도)`);
        return;
      }
    }
    for (const target of [KNOWLEDGE_TARGET, PROJECT_TARGET]) {
      if (isBackfillPaused()) break; // 스윕 도중 일시중지되면 남은 타깃으로 넘어가지 않는다(실행 중 잡은 shouldStop 으로 이미 중단).
      let pending = 0;
      try { pending = (await countEmbeddingBacklog(target)).pending; } catch { continue; }
      if (pending === 0) continue;
      const { started, job } = startBackfillJob("pending", target);
      if (!started || !job) continue;
      while (job.running) await new Promise((r) => setTimeout(r, 2_000));
    }
  } finally {
    sweepRunning = false;
  }
}

// ── 쓰기 경로 → pending 마킹(#1053) — 저장/수정 때 임베딩 HTTP(느린 CPU 백엔드는 건당 수십 초)를 인라인 호출하지 ──
//  않는다. 대신 행의 벡터를 비워 'pending'(embedding_vector IS NULL) 풀로 되돌리고, 백그라운드 드레인
//  (runAutoBackfillSweep)이 배치로 채운다 — 저장은 즉시 반환. 커넥터 미러의 knowledge 리셋 idiom(connector-mirror.ts)과 동형.
//   · off/미설정: no-op(오늘의 embed*BestEffort 게이트와 동일 — 벡터 컬럼 부재 DB 의 헛 UPDATE 도 회피).
//   · 신규 행: embedding_vector 가 이미 NULL(=pending) → 리셋 UPDATE 는 0행(IS NOT NULL 가드) + nudge 만.
//   · 수정 행: 임베딩 입력 텍스트가 '실제로 바뀐' 경우에만 호출부가 부른다(무변경·facet-only 저장엔 헛임베딩·검색 공백 없음).
//  내구성: pending 은 DB 에 남아 프로세스 재시작·엔드포인트 순단에도 부팅/주기 스윕이 반드시 흡수(재진입 안전).
export async function markEmbeddingPending(
  target: EmbeddingTarget,
  id: string | number,
  nudge = true,
): Promise<void> {
  // provider off 면 즉시 반환 — 리셋할 벡터도, 채울 스윕도 없다(오늘 동기 경로의 activeEmbeddingProvider 게이트와 동치 비용: 설정 1회 조회).
  const cfg = await resolveConfigFromDb();
  if (cfg.provider === "off") return;
  try {
    await itemsPool.query(
      `UPDATE ${target.table} SET embedding_vector=NULL, embedding_model=NULL, embedding_updated_at=NULL
         WHERE ${target.idCol}=$1 AND embedding_vector IS NOT NULL`,
      [id],
    );
  } catch (e) {
    // 벡터 컬럼 부재(임베딩 미도입 DB) 등 — 삼킨다(스윕이 스키마를 보장·수렴). 저장 자체는 이미 커밋됨.
    console.warn(`[embeddings] pending 마킹 실패(best-effort, 스윕으로 보강) ${target.name}#${id}: ${(e as Error)?.message}`);
  }
  if (nudge) nudgeAutoBackfill();
}

// nudge — 방금 생긴 pending 을 10분 주기 스윕까지 안 기다리고 곧(디바운스) 드레인한다. arm-once(고정 지연):
//  버스트(대량 저장·연속 편집)는 지연창 안에서 한 번의 스윕으로 합쳐지고, 스윕은 단일비행(sweepRunning)이라 겹치면
//  자체 거부한다. 실행 중 스윕은 pending IS NULL 을 0행까지 재조회하므로 창 사이에 새로 생긴 pending 도 흡수한다.
//  ⚠ 게이트웨이 프로세스 전용 실효 — run-sync 서브프로세스에서 스윕을 돌리지 않으려 그 경로(flushProjectEmbeds)는
//   nudge=false 로 부른다(리셋만; 게이트웨이 post-sync 스윕이 드레인). unref 로 타이머가 프로세스를 붙잡지 않는다.
let nudgeArmed = false;
const NUDGE_DELAY_MS = 1000;
export function nudgeAutoBackfill(): void {
  if (nudgeArmed) return; // 이미 예약됨 — 합친다
  nudgeArmed = true;
  const t = setTimeout(() => { nudgeArmed = false; void runAutoBackfillSweep(); }, NUDGE_DELAY_MS);
  t.unref?.();
}
