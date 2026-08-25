// 임베딩 provider seam — 벡터검색(#172)의 추론 경계. **config 가 백엔드를 고른다(코드 변경 0).**
//  설계: 지식 [[vector-search-172-design-pluggable-seam-oss]]. OSS·셀프호스팅·모델 스왑이 1급 목표다.
//  · 유니버설 계약 = OpenAI-compatible `POST {base_url}/v1/embeddings` (최대 스왑성: OpenAI·로컬 TEI/Ollama/
//    vLLM/llama.cpp·고객 자체 엔드포인트가 전부 같은 형식). 고객은 base_url+model+auth_env 만 바꾸면 모델 교체.
//  · 시크릿 금지: auth 는 auth_env_ref(환경변수 '이름'만, 값 아님) — src/db/sources.ts·org_mcp_server 와 동일 idiom.
//  · 기본 OFF(provider='off') — 켜기 전엔 현행 grep/ILIKE 그대로(무중단·하위호환). 벡터는 opt-in.
//  config SoT: org_runtime_config.embedding_config(DB, 무재시작) — 비어있으면 env 부트스트랩(EMBEDDINGS_*)이 시드.
//   (이 모듈은 store 를 import 하지 않는다 — getRuntimeConfig 가 resolveEmbeddingConfig 로 정규화해 들고 온다. 무순환.)
import { createHmac } from "node:crypto";
import { currentTenant } from "../org/tenant-context.js";
import type pg from "pg";

// 'off' = 벡터 비활성(렉시컬만). 'http' = OpenAI-compatible /v1/embeddings 엔드포인트(원격/로컬 사이드카 공통).
//  후속: 'onnx'(in-process, 사이드카 없는 단일박스 편의) — seam 만 있으면 추가는 resolve 분기 1줄.
export type EmbeddingProviderKind = "off" | "http";

export interface EmbeddingConfig {
  provider: EmbeddingProviderKind;
  base_url: string | null;     // http: `{base_url}/v1/embeddings` 로 호출. null=공식 OpenAI(api.openai.com)
  model: string | null;        // 예: 'bge-m3'(기본 권장), 'text-embedding-3-small', 고객 모델명
  dimensions: number;          // 벡터 차원(knowledge.embedding_vector vector(N)). 기본 1024(bge-m3). ⚠ 변경=전체 재임베딩
  auth_env_ref: string | null; // Authorization: Bearer <process.env[auth_env_ref]>. 환경변수 '이름'만 저장(시크릿 금지). null=무인증(로컬 사이드카)
  // 성능 튜닝(#602) — 느린/CPU 백엔드 대응. 백엔드마다 처리속도가 크게 달라 config 로 조정(코드 변경 0).
  batch_size: number;          // 한 fetch 요청당 임베딩 텍스트 수 = 백필 커밋 단위. CPU 백엔드는 낮춰 요청당 시간을 300초 안으로.
  request_timeout_ms: number;  // 임베딩 요청당 AbortSignal.timeout(ms). undici 무설정 기본(≈300초)을 명시화·설정화. 초과 시 배치를 반으로 줄여 재시도.
  // 백필 pre-flight 메모리 게이트(#1059) — 자동 백필 스윕이 임베딩 백엔드(예: Ollama bge-m3 = 로드 시 ~3.3GB)를 깨우기 전
  //  가용 메모리가 이 값(MB) 미만이면 이번 스윕을 건너뛰고 다음 주기에 재시도(pending 은 DB 유지, 재진입 안전). 0=게이트 비활성(무회귀).
  //  배경: claude 세션 baseline + 임베딩 3.3GB 스파이크 겹침이 스왑0 물리 초과로 박스를 뻗게 함(고객사 A 2026-07-21). 권장=임베딩 백엔드 상주분+헤드룸.
  backfill_min_available_mb: number;
}

// 임베딩 백엔드 1개. resolveEmbeddingProvider(config) 가 config 를 보고 구현을 고른다.
export interface EmbeddingProvider {
  readonly kind: EmbeddingProviderKind;
  readonly model: string;
  readonly dimensions: number;
  // 입력 순서 = 출력 순서(index 보장). 빈 입력 → []. 실패는 throw(호출부가 렉시컬 폴백 판단).
  embed(texts: string[]): Promise<number[][]>;
  // 헬스(엔드포인트 reachable + 키/차원 일치). 검색경로의 가용성 게이트.
  isAvailable(): Promise<boolean>;
}

export const DEFAULT_EMBEDDING_DIMENSIONS = 1024; // bge-m3 / KURE-v1 둘 다 1024 → 모델 스왑해도 스키마 불변
// 기본 배치=8 — 측정치(bge-m3 CPU): 단건 7~29초, 4건 56초 → 8건 ≈ 최악 232초로 300초 안. 요청당 시간이 타임아웃 안에 들도록 보수값.
//  ⚠ #602: 32건 배치는 CPU 에서 undici 기본 타임아웃(≈300초)을 넘겨 'fetch failed' → 백필이 0건 커밋 후 죽고 무한 재시도. GPU 는 config 로 올려 처리량 확보.
export const DEFAULT_EMBEDDING_BATCH_SIZE = 8;
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 300000; // 요청당 300초. batch_size 를 이 안에 끝나게 잡는 게 정석 — 타임아웃은 이상치용 안전망(초과 시 배치 축소 재시도).
export const DEFAULT_EMBEDDING_BACKFILL_MIN_MB = 0; // 0=백필 메모리 게이트 비활성(무회귀). 관리자가 박스 크기 보고 설정(#1059).
export const EMBEDDING_OFF: EmbeddingConfig = {
  provider: "off", base_url: null, model: null, dimensions: DEFAULT_EMBEDDING_DIMENSIONS, auth_env_ref: null,
  batch_size: DEFAULT_EMBEDDING_BATCH_SIZE, request_timeout_ms: DEFAULT_EMBEDDING_TIMEOUT_MS,
  backfill_min_available_mb: DEFAULT_EMBEDDING_BACKFILL_MIN_MB,
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
// 숫자 정규화 — 유효 정수면 [min,max]로 클램프, 아니면 fallback. (batch_size·request_timeout_ms 방어; DB JSONB/env 잡값 안전화)
const clampInt = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
export const EMBEDDING_BATCH_MIN = 1, EMBEDDING_BATCH_MAX = 512;             // 배치 상한(과대 요청 방지)
export const EMBEDDING_TIMEOUT_MIN_MS = 1000, EMBEDDING_TIMEOUT_MAX_MS = 3600000; // 1초~1시간
export const EMBEDDING_BACKFILL_MIN_MB_MIN = 0, EMBEDDING_BACKFILL_MIN_MB_MAX = 1048576; // 0(비활성)~1TB(상한 방어)

// DB row(JSONB) / env → 정규화된 EmbeddingConfig(순수). 알 수 없는 provider·잡값은 안전하게 off.
export function normalizeEmbeddingConfig(raw: unknown): EmbeddingConfig {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const provider = String(o.provider ?? "off").toLowerCase();
  if (provider !== "http") return { ...EMBEDDING_OFF };
  const dimRaw = Number(o.dimensions);
  // pgvector vector 타입 상한 16000(인덱스는 별도 — ensureEmbeddingSchema 가 HNSW 2000 한계 처리).
  const dimensions = Number.isFinite(dimRaw) && dimRaw >= 1 && dimRaw <= 16000 ? Math.floor(dimRaw) : DEFAULT_EMBEDDING_DIMENSIONS;
  return {
    provider: "http", base_url: str(o.base_url), model: str(o.model), dimensions, auth_env_ref: str(o.auth_env_ref),
    batch_size: clampInt(o.batch_size, DEFAULT_EMBEDDING_BATCH_SIZE, EMBEDDING_BATCH_MIN, EMBEDDING_BATCH_MAX),
    request_timeout_ms: clampInt(o.request_timeout_ms, DEFAULT_EMBEDDING_TIMEOUT_MS, EMBEDDING_TIMEOUT_MIN_MS, EMBEDDING_TIMEOUT_MAX_MS),
    backfill_min_available_mb: clampInt(o.backfill_min_available_mb, DEFAULT_EMBEDDING_BACKFILL_MIN_MB, EMBEDDING_BACKFILL_MIN_MB_MIN, EMBEDDING_BACKFILL_MIN_MB_MAX),
  };
}

// 고객 .env / docker-compose 부트스트랩 — DB 가 비어있을 때의 시드 기본값. EMBEDDINGS_PROVIDER=http 일 때만 유효.
export function embeddingConfigFromEnv(): EmbeddingConfig {
  const provider = (process.env.EMBEDDINGS_PROVIDER ?? "").trim().toLowerCase();
  if (provider !== "http") return { ...EMBEDDING_OFF };
  return normalizeEmbeddingConfig({
    provider: "http",
    base_url: process.env.EMBEDDINGS_BASE_URL ?? null,
    model: process.env.EMBEDDINGS_MODEL ?? null,
    dimensions: process.env.EMBEDDINGS_DIMENSIONS ?? null,
    auth_env_ref: process.env.EMBEDDINGS_AUTH_ENV ?? null,
    batch_size: process.env.EMBEDDINGS_BATCH_SIZE ?? null,           // 비면 normalize 가 기본값(8)로
    request_timeout_ms: process.env.EMBEDDINGS_TIMEOUT_MS ?? null,   // 비면 normalize 가 기본값(300000)로
    backfill_min_available_mb: process.env.EMBEDDINGS_BACKFILL_MIN_MB ?? null, // 비면 normalize 가 기본값(0=비활성)로
  });
}

// ── #688 관리탭 '명시적 끄기' — DB 에 {"provider":"off","explicit":true} 로 저장된 off 는 env 시드로 부활하지 않는다. ──
//  배경(고객사 A 박스 실사례): 관리탭 토글 off 는 DB 만 off 로 써서 .env(EMBEDDINGS_*)가 있으면 env 폴백으로 되살아나
//  "껐는데 켜져 있는" 혼동을 만들었다. 레거시/미설정 off({"provider":"off"} 마커 없음)는 기존대로 env 폴백(부트스트랩 비파괴).
//  우선순위: 관리탭(DB) > .env — 명시적으로 껐으면 enable-embeddings.sh(env 만 세팅)로도 안 켜진다(관리탭에서 켜기 저장).
export type EmbeddingConfigPatch = EmbeddingConfig | { provider: "off"; explicit: true };
export function isExplicitEmbeddingOff(raw: unknown): boolean {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  return !!o && String(o.provider ?? "").toLowerCase() === "off" && o.explicit === true;
}

// getRuntimeConfig 가 쓰는 병합 정책: DB(운영자 웹 설정)가 켜져 있으면 DB 우선, off/미설정이면 env 시드.
//  단 '명시적 끄기'(explicit:true)는 env 를 무시하고 완전 off(#688).
export function resolveEmbeddingConfig(dbRaw: unknown): EmbeddingConfig {
  const db = normalizeEmbeddingConfig(dbRaw);
  if (db.provider !== "off") return db;
  if (isExplicitEmbeddingOff(dbRaw)) return { ...EMBEDDING_OFF };
  return embeddingConfigFromEnv();
}

// 유효 설정의 출처(관리 UI 안내, #688) — db=관리탭 저장(on) · db-off=관리탭에서 명시적으로 끔 · env=.env 시드 · off=미설정.
export function embeddingConfigSource(dbRaw: unknown): "db" | "db-off" | "env" | "off" {
  if (normalizeEmbeddingConfig(dbRaw).provider !== "off") return "db";
  if (isExplicitEmbeddingOff(dbRaw)) return "db-off";
  return embeddingConfigFromEnv().provider !== "off" ? "env" : "off";
}

// 타임아웃(AbortSignal.timeout)·취소·네트워크 실패('fetch failed')는 배치를 줄이면 통할 수 있어 축소 재시도 대상.
//  HTTP 4xx/5xx(우리가 만든 Error)는 배치를 줄여도 동일하게 실패 → 즉시 throw(불필요한 재시도로 시간 낭비 방지).
function isRetriableEmbedError(e: unknown): boolean {
  const name = (e as { name?: string } | null | undefined)?.name;
  return name === "TimeoutError" || name === "AbortError" || e instanceof TypeError; // TypeError = undici 'fetch failed'(네트워크/바디 타임아웃)
}

// 4xx 중 유일한 예외(#669 포이즌 문서) — 모델 컨텍스트(토큰) 초과. 우리 입력 캡은 8000'자'라 한국어/코드 장문은
//  8192'토큰'을 넘을 수 있다(Ollama: "the input length exceeds the context length" · OpenAI: "maximum context length…"
//  · TEI: "must have less than N tokens"). 이 오류는 배치 분할(포이즌 격리)·프리픽스 축약으로 해소 가능 → 재시도 대상.
//  안 잡으면 pending 백필이 같은 문서를 매번 다시 집어 영구 정체(고객사 A 박스 86건 실사례).
function isContextLengthError(e: unknown): boolean {
  const msg = String((e as Error | null | undefined)?.message ?? "");
  if (!/embedding endpoint 4\d\d/.test(msg)) return false;
  return /context length|context_length|maximum context|input length|too many tokens|less than \d+ tokens/i.test(msg);
}

// ── OpenAI-compatible HTTP provider — 원격/로컬 사이드카 공통(fetch, 새 의존성 0; Node22 global fetch). ──
/**
 * env 에서 읽은 키를 **이 워크스페이스 것으로** 좁힌다(순수).
 *
 * ★ 프로세스 하나가 여러 워크스페이스를 서비스하면 env 는 값을 하나만 담을 수 있다. 그 하나를
 *  그대로 쓰면 **모든 워크스페이스가 같은 키로 상류에 붙는다** — 상류(임베딩 프록시)는 키로
 *  사용량을 계량하고 rate limit 을 거는데, 그러면 누구의 사용량인지 구분이 사라지고
 *  한 워크스페이스가 전체 한도를 태워버릴 수 있다.
 *
 * 저장하지 않고 **유도**한다: 상류가 같은 방식으로 유도해 검증하면 새 저장소가 필요 없다.
 *  컨텍스트가 없으면(단일 테넌트) 값 그대로 — 종전 동작이다.
 */
export function tenantScopedKey(raw: string | undefined, tenantId = currentTenant()?.id ?? null): string {
  if (!raw || !tenantId) return raw ?? "";
  return createHmac("sha256", raw).update(`embed:${tenantId}`).digest("hex");
}

class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly kind = "http" as const;
  readonly model: string;
  readonly dimensions: number;
  readonly batchSize: number;      // 한 요청당 텍스트 수(백필 커밋 단위와 일치)
  private readonly timeoutMs: number;
  private readonly url: string;
  private readonly authEnvRef: string | null;

  constructor(cfg: EmbeddingConfig) {
    this.model = cfg.model ?? "bge-m3";
    this.dimensions = cfg.dimensions;
    this.batchSize = clampInt(cfg.batch_size, DEFAULT_EMBEDDING_BATCH_SIZE, EMBEDDING_BATCH_MIN, EMBEDDING_BATCH_MAX);
    this.timeoutMs = clampInt(cfg.request_timeout_ms, DEFAULT_EMBEDDING_TIMEOUT_MS, EMBEDDING_TIMEOUT_MIN_MS, EMBEDDING_TIMEOUT_MAX_MS);
    const base = (cfg.base_url ?? "https://api.openai.com").replace(/\/+$/, "");
    // base 가 이미 /v1/embeddings 로 끝나면 그대로(고객이 풀 URL 지정), 아니면 표준 경로 부착.
    this.url = /\/v1\/embeddings$/.test(base) ? base : `${base}/v1/embeddings`;
    this.authEnvRef = cfg.auth_env_ref;
  }

  // 시크릿은 런타임에 env 이름에서 해소(DB/설정엔 키 값 미저장). 키 없으면 헤더 생략(무인증 사이드카 허용).
  private authHeader(): Record<string, string> {
    if (!this.authEnvRef) return {};
    const key = tenantScopedKey(process.env[this.authEnvRef]);
    return key ? { authorization: `Bearer ${key}` } : {};
  }

  // 입력을 batchSize 청크로 쪼개 순차 요청(느린/CPU 백엔드 과부하·타임아웃 방지) 후 순서 보존 concat.
  //  ⚠ #602: 예전엔 texts 전부를 한 fetch·타임아웃 무설정으로 보내 CPU 백엔드가 undici 기본(≈300초)을 넘겨 실패했다.
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const vecs = await this.embedChunk(texts.slice(i, i + this.batchSize));
      for (const v of vecs) out.push(v);
    }
    return out;
  }

  // 한 청크를 1회 요청. 타임아웃/네트워크 실패면 청크를 반으로 줄여 재귀 재시도(단건까지) — 느린 백엔드가 조금씩이라도 진행되게.
  //  단건까지 줄여도 타임아웃이면 throw(엔드포인트가 사실상 불가용 — 호출부가 unavailable/error 로 처리).
  //  컨텍스트 초과(4xx, isContextLengthError)도 분할 대상 — 포이즌 문서를 단건으로 격리한 뒤 프리픽스 축약(#669).
  private async embedChunk(texts: string[]): Promise<number[][]> {
    try {
      return await this.embedRequest(texts);
    } catch (e) {
      if (texts.length > 1 && (isRetriableEmbedError(e) || isContextLengthError(e))) {
        const mid = Math.ceil(texts.length / 2);
        const head = await this.embedChunk(texts.slice(0, mid));
        const tail = await this.embedChunk(texts.slice(mid));
        return [...head, ...tail];
      }
      if (texts.length === 1 && isContextLengthError(e)) {
        return [await this.embedTruncated(texts[0])];
      }
      throw e;
    }
  }

  // 단건이 모델 컨텍스트(토큰) 한도를 넘으면 프리픽스를 반씩 줄여 성공까지 재시도(#669 포이즌 문서).
  //  벡터 없음(백필이 그 문서에서 영구 정체)보다 프리픽스 벡터가 낫다 — 의미검색은 앞부분(제목·요약·서두) 기준으로 동작.
  //  컨텍스트 오류 외의 실패는 그대로 throw(재시도 폭주 방지). 500자 미만까지 줄여도 안 되면 포기(엔드포인트 이상).
  private async embedTruncated(text: string): Promise<number[]> {
    let t = text;
    while (t.length > 500) {
      t = t.slice(0, Math.floor(t.length / 2));
      try {
        const [v] = await this.embedRequest([t]);
        if (v && v.length) return v;
      } catch (e) {
        if (!isContextLengthError(e)) throw e;
      }
    }
    throw new Error(`embedding: 컨텍스트 한도 축약 재시도 실패(${text.length}자 → 500자 미만까지 축소)`);
  }

  // 실제 1회 HTTP 호출 — 요청마다 새 AbortSignal.timeout(초과 시 TimeoutError → 상위에서 축소 재시도).
  private async embedRequest(texts: string[]): Promise<number[][]> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeader() },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`embedding endpoint ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data?: Array<{ embedding: number[]; index: number }> };
    const data = json.data ?? [];
    // 일부 서버가 응답 순서를 비보장 → index 로 재배열(입력 순서 = 출력 순서 보장).
    const out = new Array<number[]>(texts.length);
    for (const d of data) if (typeof d.index === "number" && Array.isArray(d.embedding)) out[d.index] = d.embedding;
    return out;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const v = await this.embed(["healthcheck"]);
      return v.length === 1 && Array.isArray(v[0]) && v[0].length > 0;
    } catch {
      return false;
    }
  }
}

// config → provider(또는 null=off). 새 백엔드 추가는 여기 분기 한 줄(seam 의 요점).
export function resolveEmbeddingProvider(cfg: EmbeddingConfig): EmbeddingProvider | null {
  if (cfg.provider === "http") return new HttpEmbeddingProvider(cfg);
  return null; // off
}

// number[] → pgvector 리터럴 '[a,b,c]'(파라미터로 $n::vector 캐스팅). NaN/Inf 는 0 으로 방어(저장 거부 회피).
export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;
}

const EMBED_MAX_CHARS = 8000; // bge-m3 ~8192토큰 — 한글 멀티바이트 고려 보수적 캡(임베딩 입력 절단)
// 임베딩 입력 텍스트 — 제목+요약+본문(grep 과 같은 검색 표면 title+body 에 summary 보강). 모델 토큰한계 캡.
export function embeddingInputText(k: { title?: string | null; summary?: string | null; body_md?: string | null }): string {
  const parts = [k.title, k.summary, k.body_md].map((s) => (s ?? "").trim()).filter(Boolean);
  return parts.join("\n\n").slice(0, EMBED_MAX_CHARS);
}

const HNSW_MAX_DIMS = 2000; // pgvector HNSW 인덱스 차원 한계(초과 시 컬럼만 — 작은 코퍼스는 seq-scan 으로 충분)

// 임베딩 컬럼을 얹을 수 있는 테이블 — 내부 상수만 넘긴다(knowledge·project). SQL 인터폴레이션 안전 가드.
// category(#1153) — 분류의 **정의(should)** 를 벡터로 둔다. 소속 지식 벡터와의 거리가 곧 '정의-내용 불일치'다.
//  (지식·프로젝트처럼 '검색 대상'이라서가 아니라, 그 분류 안 지식을 재는 **고정점**이라서 임베딩한다.)
const EMBEDDABLE_TABLES = new Set(["knowledge", "project", "category"]);

// 가드 마이그레이션 — pgvector 확장 + <table> 임베딩 컬럼/인덱스(embedding_vector/model/updated_at + <table>_embedding_hnsw).
//  기본 table='knowledge'. 프로젝트 등 다른 임베딩 타깃도 같은 컬럼셋을 재사용(#631).
//  fail-open: 확장 없거나 실패해도 false 반환 + 경고만(부팅·렉시컬 검색 무손상). 멱등(ADD COLUMN/INDEX IF NOT EXISTS).
//  ⚠ 기존 컬럼의 차원은 IF NOT EXISTS 가 못 바꾼다 — 차원 변경(모델 스왑)은 enable/backfill 경로(P2)가 drop+recreate 처리.
/**
 * 이 테이블에 임베딩 스키마가 **이미** 갖춰져 있나 — 컬럼 3개 + (차원이 HNSW 범위면) 인덱스.
 * 읽기(카탈로그 조회)만 하므로 **소유권이 필요 없다.** 차원까지 본다: 모델이 바뀌어 차원이 달라졌으면
 * 갖춰진 것이 아니다(그 경로는 아래 drop+recreate 가 맡는다).
 */
async function hasEmbeddingSchema(pool: pg.Pool, table: string, dim: number): Promise<boolean> {
  try {
    const cols = await pool.query(
      `SELECT a.attname, COALESCE(information_schema._pg_char_max_length(a.atttypid, a.atttypmod), a.atttypmod) AS dim
         FROM pg_attribute a
        WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
          AND a.attname = ANY($2)`,
      [table, ["embedding_vector", "embedding_model", "embedding_updated_at"]],
    );
    if (cols.rowCount !== 3) return false;
    // vector(N) 의 atttypmod 는 N 이다(pgvector). 차원이 다르면 '갖춰짐' 이 아니다.
    const vec = cols.rows.find((r: { attname: string }) => r.attname === "embedding_vector") as { dim: number } | undefined;
    if (vec && Number(vec.dim) > 0 && Number(vec.dim) !== dim) return false;
    if (dim > HNSW_MAX_DIMS) return true;   // 인덱스를 애초에 안 만드는 구간
    const idx = await pool.query(`SELECT 1 FROM pg_indexes WHERE tablename = $1 AND indexname = $2`, [table, `${table}_embedding_hnsw`]);
    return (idx.rowCount ?? 0) > 0;
  } catch {
    return false;   // 못 읽으면 '없다' 로 보고 아래 생성 경로가 판단하게 둔다(종전 동작)
  }
}

export async function ensureEmbeddingSchema(pool: pg.Pool, dimensions: number, table = "knowledge"): Promise<boolean> {
  if (!EMBEDDABLE_TABLES.has(table)) {
    console.warn(`[embeddings] 알 수 없는 임베딩 테이블(${table}) — 스키마 준비 건너뜀`);
    return false;
  }
  const dim = Math.floor(dimensions);
  if (!(dim >= 1 && dim <= 16000)) {
    console.warn(`[embeddings] 잘못된 dimensions(${dimensions}) — 스키마 준비 건너뜀`);
    return false;
  }
  // ── 이미 갖춰져 있으면 손대지 않는다 (2026-08-20 실측) ─────────────────────────────
  //  `ALTER TABLE … ADD COLUMN IF NOT EXISTS` 는 **컬럼이 이미 있어도 소유권을 요구한다** — Postgres 가
  //  no-op 이 되기 전에 소유자 검사를 먼저 하기 때문이다. 그래서 게이트웨이 DB 롤이 테이블 소유자가 아닌
  //  배포에서는(우리 dev 가 그랬다) 이 함수가 **늘** false 를 내고, 그 뒤 백필이 통째로 막힌다:
  //  `runEmbeddingBackfill` 이 reason:"schema" 로 11ms 만에 죽어 **새로 쓴 지식이 영영 임베딩되지 않는다**
  //  (실측 dev: 미임베딩 64건 적체, 그 문서들은 벡터 채널에 없어 하이브리드 검색이 grep 단독보다 나빴다).
  //  벡터검색 자체는 멀쩡했다 — 컬럼도 인덱스도 이미 있었다. 없는 것을 만들 권한이 없었을 뿐이다.
  //  → **먼저 있는지 보고, 없을 때만 만든다.** 다 있으면 권한과 무관하게 true.
  if (await hasEmbeddingSchema(pool, table, dim)) return true;
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  } catch (e) {
    console.warn(`[embeddings] pgvector 확장 없음 — 벡터검색 비활성(렉시컬 폴백). ${(e as Error)?.message}`);
    return false;
  }
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS embedding_vector vector(${dim})`);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS embedding_model TEXT`);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMPTZ`);
    if (dim <= HNSW_MAX_DIMS) {
      await pool.query(
        `CREATE INDEX IF NOT EXISTS ${table}_embedding_hnsw ON ${table} USING hnsw (embedding_vector vector_cosine_ops)`,
      );
    } else {
      console.warn(`[embeddings] dimensions=${dim} > ${HNSW_MAX_DIMS}: HNSW 인덱스 생략(seq-scan). 작은 코퍼스 권장.`);
    }
    return true;
  } catch (e) {
    console.warn(`[embeddings] 벡터 컬럼/인덱스 생성 실패(${table}) — 렉시컬 폴백. ${(e as Error)?.message}`);
    return false;
  }
}
