// 세션 요청의 **종류 등록부**(#5713) — 세션의 AI 가 사람에게 화면으로 받는 것(값 입력 · 고르기 · 파일 올리기 …)의 종류.
//
// ── 왜 등록부인가 ────────────────────────────────────────────────────────────
//  종전엔 종류 셋(자격 · 객관식 · 올리기)이 리브 도구 셋(me_liv_ask_*)에 하나씩 박혀 있었고, 저장(프로필 한 칸) · 조회(리브 홈) ·
//  답 받기(종류마다 다른 REST)가 종류별로 따로였다. 종류를 하나 더하려면 그 네 자리를 다 고쳐야 했다.
//  이제 종류는 **이 모양 하나**를 채워 등록한다 — 저장 · 주소(#/ask/<id>) · 목록 · 상태 조회 · 알림 · 세션에 한 마디 넣기는
//  공통(capabilities/session-ask.ts)이 한다.
//
// ── 종류 하나를 더하려면 ─────────────────────────────────────────────────────
//  ① 서버: src/asks/kinds/<종류>.ts 에 AskKind 를 채우고 kinds/index.ts 목록에 넣는다(도구 하나가 저절로 생긴다).
//  ② 화면: web/asks/kind-<종류>.ts 에 그리는 함수를 등록한다(web/asks/registry.ts). 화면이 모르는 종류는 «새로고침» 안내 카드가 뜬다.
//  두 자리뿐이다. 표(org_session_ask.kind)에는 CHECK 가 없다 — 종류는 여기가 정본이다.
//
// ── 계약 ─────────────────────────────────────────────────────────────────────
//  · open   — AI 의 입력을 검증해 **payload**(사람에게 보일 말 + 넣을 자리)를 만든다. 저장은 공통이 한다.
//             ⚠ 거절(HttpError)은 저장 전에 난다 — open 이 던지면 아무것도 남지 않는다.
//  · submit — 화면이 보낸 답을 처리하고 **result**(AI 가 읽을 요약)와 **say**(그 세션에 넣을 한 마디)를 돌려준다.
//             ⚠ 넣을 자리는 **저장된 payload 에서만** 읽는다 — 화면 입력에서 대상(칸 · 수집기)을 읽으면 브라우저가 다른 칸으로 돌릴 수 있다.
//             ⚠ 시크릿 값은 result · say · 로그 어디에도 넣지 않는다.
//  · stillOpen(선택) — 다른 길로 이미 끝난 요청(관리 화면에서 직접 넣었다 등)을 목록에서 걷는다.
import type { ZodRawShape } from "zod";
import type { LivelyUser } from "../context.js";
import type { AskRow } from "./store.js";

/** 요청을 걸거나 답하는 주체 — 언제나 토큰의 사람 본인. session = 요청을 건 세션(모르면 null). */
export interface AskWho { userId: string; user: LivelyUser; session: string | null }

export interface AskSubmitOut {
  /** AI 가 읽을 요약(무엇을 골랐나 · 저장됐나). 시크릿 값 금지. */
  result: Record<string, unknown>;
  /** 요청을 건 세션에 사람 대신 넣을 한 마디(없으면 넣지 않는다). 시크릿 값 금지. */
  say?: string;
}

export interface AskKind {
  /** 종류 이름(소문자 슬러그) — 표의 kind · 화면 등록부의 열쇠. */
  kind: string;
  /** 사람이 읽는 종류 이름(화면이 모르는 종류일 때의 폴백 카드 · 로그). */
  label: string;
  /** 이 종류를 거는 MCP 도구. input 은 평평한 zod shape(Capability.input 규약). */
  tool: { name: string; title: string; description: string; input: ZodRawShape };
  /**
   * 옛 이름(호환) — 같은 핸들러를 옛 도구 이름 · 옛 REST 경로로도 연다. 기본 스킬 · 훅은 «없을 때만» 심기므로(default-content.ts),
   *  이미 심긴 조직의 문서가 옛 이름을 부른다. 새 종류에는 필요 없다.
   */
  aliases?: Array<{ name: string; title: string; restPath: string }>;
  /** 입력 검증 → payload(값 없음) + slot(같은 것을 다시 물었나 가르는 열쇠 — 같으면 앞 요청을 내리고 갈아 끼운다). */
  open(input: Record<string, unknown>, who: AskWho): Promise<{ payload: Record<string, unknown>; slot?: string }>;
  /** 목록 · 주소 화면의 한 줄 제목(payload 에서). */
  title(payload: Record<string, unknown>): string;
  /** 아직 띄울 일인가 — false 면 공통이 그 요청을 닫는다(done · result.elsewhere). 판정 못 하면 true(띄워 둔다). */
  stillOpen?(ask: AskRow, who: AskWho): Promise<boolean>;
  /** 화면이 보낸 답 처리. 던지면 요청은 열린 채 남는다(사람이 다시 넣을 수 있다). */
  submit(ask: AskRow, input: Record<string, unknown>, who: AskWho): Promise<AskSubmitOut>;
}

const kinds = new Map<string, AskKind>();

/** 종류를 등록한다 — 이름 · 도구 이름이 겹치면 던진다(조용히 덮으면 한 종류가 사라진다). */
export function registerAskKind(k: AskKind): void {
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(k.kind)) throw new Error(`세션 요청 종류 이름 형식 오류: ${k.kind}`);
  if (kinds.has(k.kind)) throw new Error(`세션 요청 종류가 이미 등록돼 있습니다: ${k.kind}`);
  const names = new Set([...kinds.values()].flatMap((x) => [x.tool.name, ...(x.aliases ?? []).map((a) => a.name)]));
  for (const n of [k.tool.name, ...(k.aliases ?? []).map((a) => a.name)]) {
    if (names.has(n)) throw new Error(`세션 요청 도구 이름이 겹칩니다: ${n}`);
  }
  kinds.set(k.kind, k);
}

export function askKind(kind: string): AskKind | undefined { return kinds.get(kind); }
export function askKinds(): AskKind[] { return [...kinds.values()]; }

/** 사람에게 보일 짧은 글(AI 가 준 label · why · hint) — 앞뒤 공백을 걷고 자른다. 비면 undefined. */
export const clip = (v: unknown, max: number): string | undefined => {
  const t = String(v ?? "").trim().slice(0, max);
  return t || undefined;
};
