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
  session?: string;         // 작업이 이뤄진 터미널 세션(tmux box) — 접속 헤더 x-lively-session 으로 식별(#852). 형식만 검증됨(권한은 소비처가)
  tokenHashPrefix?: string; // DB 토큰 해시 prefix(회수 대상 즉시 특정 — 비밀 아님)
  ip?: string;              // 요청 IP
  readOnly?: boolean;       // 읽기전용 세션(#1007) — 이 요청이 read-only 모드인가(x-lively-readonly 헤더 파생). 강제는 어댑터가 하고, 여기선 관측용(me 가 반환).
  incognito?: boolean;      // 인코그니토 세션(#1007+) — 이 요청이 incognito 모드인가(x-lively-incognito 헤더 파생). incognito = lively 툴 0개+전체 차단(읽기·쓰기 모두). 관측용.
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
  // 읽기전용 모드(#1007) 판정용 — 이 op 가 컨텍스트 스토어를 **변형(write)**하는가.
  //  보통은 생략한다: capMutates(index.ts)가 REST 마운트 method(POST=쓰기·GET=읽기)에서 자동 파생한다(코드베이스 관례).
  //  ⚠ 명시가 필요한 예외만 지정: (a) POST 인데 읽기(예: recall_route=라우팅 계산) → false,
  //   (b) REST 마운트가 없는 MCP 전용 읽기(파생 신호 부재 → fail-closed=쓰기로 오판) → false.
  //   신호가 전무하면 capMutates 는 **쓰기로 간주(fail-closed)** 한다 — 새 쓰기 툴이 실수로 읽기전용에서 새지 않게.
  mutates?: boolean;
  // MCP inputSchema(zod raw shape) — REST 는 이걸 안 쓰고 mount.parse 가 검증.
  input: ZodRawShape;
  expose: {
    mcp: boolean;
    rest: RestMount[] | false;
  };
  // MCP tool 의 _meta — 코드 기본값. registerMcpCapabilities 가 운영자 override(org_tool.always_load)와 하네스를 반영해
  //  최종 _meta 를 계산(resolveToolMeta)한 뒤 tools/list 에 싣는다(SDK registerTool config._meta → ListTools).
  //  예: { "anthropic/alwaysLoad": true } = Claude Code 가 이 툴을 deferred 안 시키고 상시 로드(v2.1.121+). 관리탭에서 per-tool 토글(#187).
  //  ⚠ anthropic/ 네임스페이스라 Claude 전용 — Codex 는 서버측 _meta deferral 미지원(전부 upfront 주입)이라 무효과.
  meta?: Record<string, unknown>;
  // canonical JSON 반환. 도메인 에러는 plain Error throw —
  // REST 는 wrap() 의 한국어 부분문자열 매핑('없음'→404 등), MCP 는 SDK isError 로 변환된다.
  // 입력은 어댑터 경계에서 검증되므로 레지스트리 차원에선 넓게 받는다(각 op 파일에서 좁혀 캐스팅).
  // eslint 없음 — any 는 어댑터 경계 1곳으로 한정한다.
  // deno-lint-ignore no-explicit-any
  handler(input: any, user: LivelyUser, ctx?: CapabilityCtx): Promise<unknown>;
}
