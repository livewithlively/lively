// lively-db.mjs 의 타입(#4483). 앱 프로젝트에 lively-db.mjs 옆에 두면 TypeScript 가 읽는다.
import type { PgRemoteDatabase } from "drizzle-orm/pg-proxy";
import type { Logger } from "drizzle-orm";

export declare const LIVELY_DB_SDK_VERSION: string;

/** 게이트웨이가 거절한 호출 — status(HTTP) · body(게이트웨이 JSON) · index(묶음에서 몇 번째 쿼리인지, 0부터). */
export declare class LivelyDbError extends Error {
  status: number;
  body: unknown;
  index?: number;
}

export interface LivelyDbOptions<TSchema extends Record<string, unknown>> {
  /** 기본 = 환경변수 LIVELY_API_URL. */
  url?: string;
  /** 기본 = 환경변수 LIVELY_APP_TOKEN(앱 서버 토큰). */
  token?: string;
  /** 앱이 붙은 세션 토큰으로 부를 때만(그 앱 id). 기본 = LIVELY_APP_ID. */
  appId?: string;
  schema?: TSchema;
  logger?: boolean | Logger;
  casing?: "snake_case" | "camelCase";
  /** 시험 주입 — 기본 = 전역 fetch. */
  fetch?: typeof fetch;
  /** 미들웨어 대신 신원을 직접 준다(요청마다 다른 값이면 withIdentity 를 쓴다). */
  identity?: () => string | undefined;
}

export interface LivelyDb<TSchema extends Record<string, unknown>> {
  db: PgRemoteDatabase<TSchema>;
  /** Drizzle 쿼리 여러 개를 한 트랜잭션으로 — 전부 되거나 전부 취소. 결과는 각 쿼리를 따로 await 한 것과 같은 모양. */
  batch<T extends readonly unknown[]>(queries: [...T]): Promise<{ [K in keyof T]: Awaited<T[K]> }>;
}

export declare function createLivelyDb<TSchema extends Record<string, unknown> = Record<string, never>>(opts?: LivelyDbOptions<TSchema>): LivelyDb<TSchema>;

/** Express·Connect 미들웨어 — 그 요청 안의 DB 호출이 들어온 사람 신원(X-Lively-Identity)을 싣는다. */
export declare function livelyIdentity(): (req: { headers: Record<string, string | string[] | undefined> }, res: unknown, next: () => void) => void;
/** 이 요청의 사람(앱 서버 함수 앞 검사 층이 붙인 머리글을 풀어서) — 없으면 null. 라이블리 앱 서버 함수 안에서만 믿을 수 있다. */
export declare function livelyMember(req: { headers: Record<string, string | string[] | undefined> | { get(name: string): string | null } }): { id: string; name: string; variant: "pub" | "draft"; job: number | null } | null;

/** 백그라운드 작업 하나(#4486) — 끝 상태 done(라우트가 2xx) · failed · canceled. result 는 라우트 응답의 앞 64KB. */
export interface LivelyJob {
  id: number; app_id: string; status: "queued" | "dispatched" | "running" | "done" | "failed" | "canceled"; label: string | null; requester: string;
  created_at: string | null; started_at: string | null; ended_at: string | null; duration_ms: number | null; error: string | null; cancel_requested: boolean;
  route?: string; variant?: "pub" | "draft"; body_bytes?: number; timeout_s?: number; attempts?: number; parent_id?: number | null; depth?: number;
  dispatched_at?: string | null; status_code?: number | null;
  result?: { status_code: number | null; content_type: string | null; json?: unknown; text?: string; base64?: string; truncated: boolean; bytes: number | null } | null;
}
export interface LivelyJobs {
  start(route: string, body?: unknown, opts?: { label?: string; timeout_s?: number; wait?: number }): Promise<LivelyJob>;
  get(id: number, opts?: { wait?: number }): Promise<LivelyJob>;
  list(opts?: { status?: LivelyJob["status"]; limit?: number }): Promise<LivelyJob[]>;
  cancel(id: number): Promise<LivelyJob>;
  wait(id: number, opts?: { timeout_ms?: number }): Promise<LivelyJob>;
}
/** 백그라운드 작업 — 이 앱 서버의 라우트를 라이블리가 뒤에서(15분까지) 부르게 한다. 신원은 들어온 요청의 것(livelyIdentity)을 싣는다. */
export declare function livelyJobs(opts?: { url?: string; token?: string; fetch?: typeof fetch; identity?: () => string | undefined }): LivelyJobs;

/** fn 안의 DB 호출이 그 신원을 싣는다(Next 라우트 · Lambda 핸들러). fn 의 결과를 안에서 기다려 Promise 로 돌려준다. */
export declare function withIdentity<T>(identity: string | null | undefined, fn: () => T): Promise<Awaited<T>>;

/** 잡은 오류에서 게이트웨이 오류를 꺼낸다(Drizzle 의 DrizzleQueryError 가 감싼 cause 까지). 아니면 null. */
export declare function livelyErrorOf(err: unknown): LivelyDbError | null;

/** 매니페스트(lively-app.json 객체) → Drizzle 스키마 소스. `node lively-db.mjs gen lively-app.json > db/schema.mjs` 와 같다. */
export declare function generateDrizzleSchema(manifest: object): string;

export declare function encodeParam(v: unknown): unknown;
export declare function decodeRows(r: { fields?: Array<{ name: string; type: number }>; rows?: Array<Array<string | null>> }): unknown[][];
export declare function decodeObjects(r: { fields?: Array<{ name: string; type: number }>; rows?: Array<Array<string | null>>; changed?: number | null; row_count?: number }, kind?: string): Array<Record<string, unknown>> & { rowCount: number; command?: string };
export declare function parsePgArray(text: string, el?: (s: string) => unknown): unknown[];
export declare const TYPE_PARSERS: Record<number, (v: string) => unknown>;
