// domainmap(canonical 도메인/프로젝트/부채 맵) HTTP API 클라이언트.
// domainmap 은 자기 컨테이너·Postgres·web UI 로 따로 돌고, 게이트웨이는 그 /api/* 를 프록시한다.
// (읽기 = dmGet passthrough, 쓰기 = dmPost/dmPatch — 화이트리스트된 capability 만 사용)
// domainmap 자체엔 auth 가 없으므로 반드시 게이트웨이 뒤 사내망 전용으로 둘 것(신뢰 경계 = 게이트웨이).
import { HttpError } from "../capabilities/rest-util.js"; // 단방향(rest-util 은 client 미참조) — 순환 없음
import { logger } from "../log.js";

const BASE = (process.env.DOMAINMAP_URL ?? "http://localhost:7700").replace(/\/$/, "");
const DEFAULT_REPO = process.env.DOMAINMAP_DEFAULT_REPO ?? "";

// domainmap 5xx 전용 에러 — 업스트림 본문(raw pg 에러 등 내부 정보)은 message 에 싣지 않고
// 분기용 필드로만 보존한다(클라이언트행 노출 차단, 본문 전문은 logger.error 로만).
export class DmUpstreamError extends Error {
  constructor(message: string, public readonly upstreamStatus: number, public readonly upstreamBody: string) {
    super(message);
  }
}

// 업스트림 본문이 JSON {error} 면 그 메시지만 추출(아니면 원문 슬라이스) — 에러 문구 래핑 노이즈 축소.
function extractError(text: string, max: number): string {
  try {
    const j = JSON.parse(text) as { error?: unknown };
    if (j && typeof j === "object" && j.error !== undefined) return String(j.error).slice(0, max);
  } catch { /* plain text 그대로 */ }
  return text.slice(0, max);
}

export function resolveRepo(repo?: string): string {
  const r = repo ?? DEFAULT_REPO;
  if (!r) throw new Error("repo 미지정 — 인자로 주거나 DOMAINMAP_DEFAULT_REPO 를 설정하세요");
  return r;
}

export async function dmGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // JSON {error} 면 메시지만 추출 — UI 딥링크 에러 문구의 raw JSON 노출 방지(메시지의 'domainmap' 토큰은 wrap() 502 매핑에 load-bearing).
    throw new Error(`domainmap ${res.status} ${path}: ${extractError(body, 200)}`);
  }
  return res.json();
}

// ── 쓰기(큐레이션) — actorId 필수 인자로 x-actor 헤더 강제(누락 = 컴파일 에러). ──
// 에러 분기(load-bearing): domainmap 4xx 는 {error} 를 HttpError(원status, 메시지)로 보존해
// UI 까지 닿게 하고(restore 의 400 dependent-rows, debt 의 400 bad-status 등),
// 네트워크 실패는 plain Error, 5xx 는 DmUpstreamError(본문 비노출) — 둘 다 'domainmap' 토큰으로 wrap() 502 매핑.
// opts.actorType: 커넥터 싱크('agent') 용 x-actor-type 헤더 — 라우트는 소문자 'agent' 만 인정,
// 미지정 시 헤더 자체를 생략(기존 호출자 거동 무변경 — 'human' 기본).
export interface DmWriteOpts { actorType?: "agent" }
async function dmWrite(
  method: "POST" | "PATCH", path: string, body: unknown, actorId: string, opts?: DmWriteOpts,
): Promise<unknown> {
  if (!actorId || !actorId.trim()) throw new Error("인증 사용자 식별 실패 — userId 필수");
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        accept: "application/json", "content-type": "application/json", "x-actor": actorId,
        ...(opts?.actorType ? { "x-actor-type": opts.actorType } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    throw new Error(`domainmap 연결 실패 ${path}: ${(err as Error).message}`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    if (res.status >= 400 && res.status < 500) {
      throw new HttpError(res.status, extractError(text, 300));
    }
    // 5xx — 본문(예: raw pg 'duplicate key …'로 테이블/제약명 노출 가능)은 서버 로그에만 남기고,
    // 클라이언트행 메시지는 일반화한다. 상위 분기(dm_mapping_move 의 duplicate-key 409 번역)는
    // DmUpstreamError.upstreamBody 로 계속 가능. 'domainmap' 토큰은 wrap() 502 매핑에 load-bearing.
    logger.error({ path, status: res.status, body: text.slice(0, 500) }, "domainmap 5xx");
    throw new DmUpstreamError(`domainmap 오류(${res.status}) ${path}`, res.status, text.slice(0, 500));
  }
  try { return JSON.parse(text); } catch { return null; }
}

export const dmPost = (path: string, body: unknown, actorId: string, opts?: DmWriteOpts): Promise<unknown> =>
  dmWrite("POST", path, body, actorId, opts);
export const dmPatch = (path: string, body: unknown, actorId: string, opts?: DmWriteOpts): Promise<unknown> =>
  dmWrite("PATCH", path, body, actorId, opts);
