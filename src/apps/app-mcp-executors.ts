// 앱이 선언한 MCP 도구의 실행기 등록부(#5050 앱 v2-40) — 잎 모듈(가져오는 것은 타입뿐).
//
//  틀(apps/app-mcp-decl.ts 선언 · mcp/app-declared-tools.ts 등록 · 부르기)은 실행기와 무관하다: 이름 · 설명 · 입력 · level · 보는 사람의 판 ·
//  동의 · 호출자 신원 · 감사는 틀이 하고, 실행기는 «이미 확인된 사람이 이 앱의 이 도구를 이 인자로 불렀다» 만 받아 결과를 낸다.
//  선언의 `run.kind` 가 실행기 이름이다. 이 코어가 모르는 kind 는 설치 · 저장이 400 으로 막고(app-mcp-decl assertAppMcpToolsInstallable),
//  이미 저장된 매니페스트(새 코어에서 깔고 이 코어로 되돌린 앱)의 그 도구는 목록에 올리지 않는다.
//
//  첫 실제 실행기는 server(#5053 앱 v2-42 · apps/app-mcp-server-executor.ts — 앱 서버 라우트를 사람 대리 신원으로), 그다음 sql(#5104 앱 v2-46).
//  실행기를 더하는 쪽은 부팅 때 registerAppMcpExecutor 를 한 번 부른다(server 는 index.ts). 시험은 가짜 실행기를 등록했다가 돌려받은 함수로 걷는다.
import type { AppMcpToolDecl } from "./app-mcp-decl.js";

/** 실행기가 받는 «누가 불렀나» — 전부 게이트웨이가 토큰 · 구성원 · 동의에서 채운다(입력으로 바꿀 수 없다). */
export interface AppMcpCaller {
  /** 토큰의 구성원 id. */
  userId: string;
  /** 구성원 표시 이름(없으면 id). */
  name: string;
  /** 토큰의 scope — OAuth 연결이면 그 연결에 허락한 만큼(관리 scope 는 없다). */
  tokenScopes: string[];
  /** 그 사람의 이 앱 동의(org_app_grant). 틀이 «활성 동의가 있다» 를 확인한 뒤에만 실행기를 부른다. */
  grant: { scopes: string[]; tools: string[] };
  /** tokenScopes ∩ grant.scopes — 앱이 이 사람 이름으로 할 수 있는 상한(앱 화면 도구 다리 runAppTool 의 축소와 같은 교집합). */
  scopes: string[];
  oauthClientId?: string;
  /** 감사 상관용 토큰 지문 앞자리(비밀 아님). */
  tokenHashPrefix?: string;
}

/** 실행기가 받는 한 번의 부르기. */
export interface AppMcpToolCall {
  /** 이 도구를 선언한 앱 — 부른 사람이 보는 판의 것. */
  app: {
    id: string;
    title: string;
    /** 'installed' = 설치된 상태(초안을 고친 사람 · 초안이 없는 앱) · 'published' = 판 행의 공개 판. */
    view: "installed" | "published";
    /** 앱 주소의 판 이름 — 초안을 고친 사람이면 'draft', 나머지는 'pub'(apps/visibility.ts addressVariantFor). 앱 서버 별칭(cur · pub)을 고를 때 쓴다. */
    variant: "pub" | "draft";
    content_hash: string | null;
  };
  /** 그 판의 선언(입력 스키마 · run 칸 포함). */
  tool: AppMcpToolDecl;
  /** 그 판의 입력 스키마로 검사한 인자(선언 밖 칸은 빠진다). */
  args: Record<string, unknown>;
  caller: AppMcpCaller;
  /** 부른 쪽이 끊으면 걸린다(MCP 요청 취소 · 연결 끊김). */
  signal?: AbortSignal;
  /**
   * 진행 알림(MCP notifications/progress) — 부른 쪽이 진행을 받겠다고 했을 때(요청의 progressToken)만 있다. 오래 걸리는 실행기가 기다리는 동안 보낸다
   *  (Claude Code 는 이것을 활동으로 세어 5분 무소식 끊기를 미룬다 · #5053 server 실행기의 background). 보내다 실패해도 던지지 않는다.
   */
  progress?: (p: { progress: number; total?: number; message?: string }) => Promise<void>;
}

/**
 * 실행기의 결과 — data 는 JSON 으로 옮길 수 있는 값(글자면 그대로 · 그 밖은 JSON 한 줄). 틀이 크기 상한을 걸어 잘린 표시를 붙인다.
 *  truncatedFrom — 실행기가 원래 답을 이미 앞부분만 받아 넘겼으면 그 원래 크기(바이트 · 앱 서버 답의 앞 256KiB 만 모은 server 실행기). 틀이 그 크기로 잘림을 알린다.
 */
export interface AppMcpToolResult {
  data: unknown;
  truncatedFrom?: number;
  /** 도구 결과의 _meta 에 더할 표지(lively/* — 예: 아직 도는 작업 번호 lively/job_id). 틀의 잘림 표지가 이긴다. */
  meta?: Record<string, unknown>;
}

/**
 * 실행기. 오류는 던진다 — HttpError 면 그 글과 body.code 가 도구 오류(isError)로 그대로 가고, 그 밖의 예외는 글을 감추고 기록만 남긴다.
 *  validate — 설치 · 판 저장 때 그 도구의 run 칸(과 매니페스트)을 검사한다. 틀리면 HttpError(400). DB 를 보지 않는다(설치 계획과 같은 자리).
 *  ⚠ 틀은 시간 상한을 걸지 않는다(signal 만 넘긴다) — 실행기가 제 상한을 건다(앱 서버 30초 · SQL 문장 5초). level 은 작성자의 자기 신고라,
 *   L0(조회)을 지키는 것도 실행기 몫이다.
 */
export interface AppMcpExecutor {
  readonly kind: string;
  validate?(tool: AppMcpToolDecl, manifest: unknown): void | Promise<void>;
  call(c: AppMcpToolCall): Promise<AppMcpToolResult>;
}

/** 실행기 이름 꼴 — 선언의 run.kind 도 같은 꼴만 받는다(apps/app-mcp-decl.ts). */
export const EXECUTOR_KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/;

const executors = new Map<string, AppMcpExecutor>();

/** 실행기를 등록한다 — 같은 kind 가 이미 있으면 던진다(둘이 같은 선언을 다르게 실행하지 않게). 돌려준 함수를 부르면 걷는다. */
export function registerAppMcpExecutor(e: AppMcpExecutor): () => void {
  if (!EXECUTOR_KIND_RE.test(e.kind)) throw new Error(`실행기 이름 형식 오류: '${e.kind}'`);
  if (executors.has(e.kind)) throw new Error(`실행기 '${e.kind}' 는 이미 등록돼 있습니다`);
  executors.set(e.kind, e);
  return () => { if (executors.get(e.kind) === e) executors.delete(e.kind); };
}

export function appMcpExecutor(kind: string): AppMcpExecutor | undefined {
  return executors.get(kind);
}

export function appMcpExecutorKinds(): string[] {
  return [...executors.keys()].sort();
}
