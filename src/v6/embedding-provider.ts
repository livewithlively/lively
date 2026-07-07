// 임베딩 provider seam — 벡터검색(#172)의 추론 경계. **config 가 백엔드를 고른다(코드 변경 0).**
//  설계: 지식 [[vector-search-172-design-pluggable-seam-oss]]. OSS·셀프호스팅·모델 스왑이 1급 목표다.
//  · 유니버설 계약 = OpenAI-compatible `POST {base_url}/v1/embeddings` (최대 스왑성: OpenAI·로컬 TEI/Ollama/
//    vLLM/llama.cpp·고객 자체 엔드포인트가 전부 같은 형식). 고객은 base_url+model+auth_env 만 바꾸면 모델 교체.
//  · 시크릿 금지: auth 는 auth_env_ref(환경변수 '이름'만, 값 아님) — src/db/sources.ts·org_mcp_server 와 동일 idiom.
//  · 기본 OFF(provider='off') — 켜기 전엔 현행 grep/ILIKE 그대로(무중단·하위호환). 벡터는 opt-in.
//  config SoT: org_runtime_config.embedding_config(DB, 무재시작) — 비어있으면 env 부트스트랩(EMBEDDINGS_*)이 시드.
//   (이 모듈은 store 를 import 하지 않는다 — getRuntimeConfig 가 resolveEmbeddingConfig 로 정규화해 들고 온다. 무순환.)
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
export const EMBEDDING_OFF: EmbeddingConfig = {
  provider: "off", base_url: null, model: null, dimensions: DEFAULT_EMBEDDING_DIMENSIONS, auth_env_ref: null,
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

// DB row(JSONB) / env → 정규화된 EmbeddingConfig(순수). 알 수 없는 provider·잡값은 안전하게 off.
export function normalizeEmbeddingConfig(raw: unknown): EmbeddingConfig {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const provider = String(o.provider ?? "off").toLowerCase();
  if (provider !== "http") return { ...EMBEDDING_OFF };
  const dimRaw = Number(o.dimensions);
  // pgvector vector 타입 상한 16000(인덱스는 별도 — ensureEmbeddingSchema 가 HNSW 2000 한계 처리).
  const dimensions = Number.isFinite(dimRaw) && dimRaw >= 1 && dimRaw <= 16000 ? Math.floor(dimRaw) : DEFAULT_EMBEDDING_DIMENSIONS;
  return { provider: "http", base_url: str(o.base_url), model: str(o.model), dimensions, auth_env_ref: str(o.auth_env_ref) };
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
  });
}

// getRuntimeConfig 가 쓰는 병합 정책: DB(운영자 웹 설정)가 켜져 있으면 DB 우선, off/미설정이면 env 시드.
export function resolveEmbeddingConfig(dbRaw: unknown): EmbeddingConfig {
  const db = normalizeEmbeddingConfig(dbRaw);
  return db.provider !== "off" ? db : embeddingConfigFromEnv();
}

// ── OpenAI-compatible HTTP provider — 원격/로컬 사이드카 공통(fetch, 새 의존성 0; Node22 global fetch). ──
class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly kind = "http" as const;
  readonly model: string;
  readonly dimensions: number;
  private readonly url: string;
  private readonly authEnvRef: string | null;

  constructor(cfg: EmbeddingConfig) {
    this.model = cfg.model ?? "bge-m3";
    this.dimensions = cfg.dimensions;
    const base = (cfg.base_url ?? "https://api.openai.com").replace(/\/+$/, "");
    // base 가 이미 /v1/embeddings 로 끝나면 그대로(고객이 풀 URL 지정), 아니면 표준 경로 부착.
    this.url = /\/v1\/embeddings$/.test(base) ? base : `${base}/v1/embeddings`;
    this.authEnvRef = cfg.auth_env_ref;
  }

  // 시크릿은 런타임에 env 이름에서 해소(DB/설정엔 키 값 미저장). 키 없으면 헤더 생략(무인증 사이드카 허용).
  private authHeader(): Record<string, string> {
    if (!this.authEnvRef) return {};
    const key = process.env[this.authEnvRef];
    return key ? { authorization: `Bearer ${key}` } : {};
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeader() },
      body: JSON.stringify({ model: this.model, input: texts }),
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
const EMBEDDABLE_TABLES = new Set(["knowledge", "project"]);

// 가드 마이그레이션 — pgvector 확장 + <table> 임베딩 컬럼/인덱스(embedding_vector/model/updated_at + <table>_embedding_hnsw).
//  기본 table='knowledge'. 프로젝트 등 다른 임베딩 타깃도 같은 컬럼셋을 재사용(#631).
//  fail-open: 확장 없거나 실패해도 false 반환 + 경고만(부팅·렉시컬 검색 무손상). 멱등(ADD COLUMN/INDEX IF NOT EXISTS).
//  ⚠ 기존 컬럼의 차원은 IF NOT EXISTS 가 못 바꾼다 — 차원 변경(모델 스왑)은 enable/backfill 경로(P2)가 drop+recreate 처리.
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
