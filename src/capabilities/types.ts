// Capability 레지스트리 타입 (Stage① — DESIGN 단일 능력 계층).
// 하나의 op = 도메인 로직(handler) + 노출 선언(expose). 사람(web REST)/하네스(MCP)/CLI 가
// 같은 handler 를 공유해 co-exposed 표면에서 페이로드가 항상 동일함을 구조적으로 보장한다.
// 입력 검증은 어댑터 경계에서: MCP = zod(input shape), REST = mount.parse(기존 qstr/qint/qiso/qtype
// 검증을 그대로 수행 — 에러 메시지/상태코드 byte-compat 유지). handler 는 파싱된 입력을 신뢰한다.
import type express from "express";
import type { ZodRawShape } from "zod";
import type { LivelyUser } from "../context.js";
import type { Scope } from "./scopes.js";

// 어댑터가 주입하는 호출 맥락 — audit.source('mcp'|'web') 구분 + 감사 보강(B23). handler 가 쓰기 fn 에 전달.
export interface CapabilityCtx {
  source?: string;
  actor?: string;           // 안정 식별자(userId 우선) — 감사 actor(사람 축, author_person)
  agent?: string;           // 작업자(AI) — 게이트웨이가 접속 신원(User-Agent)으로 식별한 하네스(프로젝트 #182). MCP 경로만 채움
  tokenHashPrefix?: string; // DB 토큰 해시 prefix(회수 대상 즉시 특정 — 비밀 아님)
  ip?: string;              // 요청 IP
}

// REST 마운트 1개 — paths 배열로 기존 alias(propose/confirm 이중 경로 등)를 표현.
// parse 가 req(query/params/body)를 handler 입력으로 변환하며, 검증 실패 시 HttpError throw.
export interface RestMount {
  method: "GET" | "POST";
  paths: string[];
  parse(req: express.Request): Record<string, unknown>;
}

export interface Capability {
  name: string;
  title: string;
  description: string;
  // 요청 principal 에게 요구하는 스코프. null = bearer 인증만(예: me).
  // admin = 전달/관리 표면(org-content 편집·발행·구성원/토큰), runtime = 멤버 머신에서 실행되는 것(훅·툴) 정의.
  // 허용 scope 의 단일 진실원천은 ./scopes.ts — web.ts mw() 가 여기서 fail-closed 게이트를 파생한다.
  scope: Scope | null;
  // MCP inputSchema(zod raw shape) — REST 는 이걸 안 쓰고 mount.parse 가 검증.
  input: ZodRawShape;
  expose: {
    mcp: boolean;
    rest: RestMount[] | false;
  };
  // MCP tool 의 _meta — tools/list 에 그대로 실린다(SDK registerTool config._meta → ListTools).
  //  예: { "anthropic/alwaysLoad": true } = 하네스(Claude Code)가 이 툴을 deferred 시키지 않고 상시 로드.
  meta?: Record<string, unknown>;
  // canonical JSON 반환. 도메인 에러는 plain Error throw —
  // REST 는 wrap() 의 한국어 부분문자열 매핑('없음'→404 등), MCP 는 SDK isError 로 변환된다.
  // 입력은 어댑터 경계에서 검증되므로 레지스트리 차원에선 넓게 받는다(각 op 파일에서 좁혀 캐스팅).
  // eslint 없음 — any 는 어댑터 경계 1곳으로 한정한다.
  // deno-lint-ignore no-explicit-any
  handler(input: any, user: LivelyUser, ctx?: CapabilityCtx): Promise<unknown>;
}
