// knowledge_save 의 덮어쓰기 안전장치 — 버전 대조(CAS)와 형식 정리 저장(style_fix)의 의미 보존·사람 편집 보호.
//
// 형식 정리를 에이전트 세션에 맡기면 서버가 안전을 보증해야 한다: 읽은 지식을 «형식만» 고친다며 수치·링크를 빠뜨리거나
//  사람이 방금 고친 글을 덮을 수 있다. 자동 정리 배치가 쓰는 판정(writing-rewrite-gate)을 같은 기준으로 저장 경로에 건다.
// 순수 함수다(DB 없음) — 핸들러가 읽은 기존 행과 최종 제목·본문을 넘긴다.
import { HttpError } from "../../http-error.js";
import { checkInvariants, isRecentlyEdited, type RewriteDoc } from "../../v6/writing-rewrite-gate.js";

export interface SaveGuardBefore {
  title: string | null | undefined;
  body_md: string | null | undefined;
  version: number | string;
  /** 마지막 저장의 출처 — upsertKnowledge 가 매 저장마다 MCP 면 'ai', 그 밖은 'human' 으로 덮는다. */
  confidence?: string | null;
  updated_at?: string | Date | null;
  updated_by?: string | null;
}

/** expected_version 이 있으면 지금 판과 같아야 한다. 없는 지식(신규)은 판이 없으므로 어긋난 것으로 본다. */
export function assertExpectedVersion(before: Pick<SaveGuardBefore, "version"> | null | undefined, expected: number | null | undefined): void {
  if (expected == null) return;
  const current = before ? Number(before.version) : null;
  if (current === expected) return;
  const msg = current == null
    ? `expected_version=${expected} 를 보냈지만 이 지식은 없습니다 — 이름을 확인하세요.`
    : `이 지식은 그 사이 바뀌었습니다(보낸 판 ${expected}, 지금 판 ${current}). knowledge_get 으로 지금 본문을 다시 읽고 고쳐 저장하세요 — 그대로 저장하면 그 변경을 덮어씁니다.`;
  throw new HttpError(409, msg, { body: { conflict: "version", expected_version: expected, current_version: current } });
}

/**
 * style_fix — 에이전트가 «형식만 고치는 저장»이라고 밝힌 경우에만 건다. 정상적인 내용 수정은 숫자·링크·표를 바꾸는 게
 *  본업이라 불변식을 모든 수정에 걸면 편집이 막힌다. 형식 정리는 뜻을 바꾸면 안 되는 저장이라 불변식이 정확히 맞는 계약이다.
 * 사람의 웹 편집은 대상이 아니다(사람이 직접 고친 수치는 의도다). 신규 저장은 대조할 원문이 없다.
 */
export function assertStyleFixSafe(o: {
  styleFix: boolean | undefined;
  human: boolean;
  actor: string | null | undefined;
  before: SaveGuardBefore | null | undefined;
  after: RewriteDoc;
  now: number | Date;
}): void {
  if (!o.styleFix || o.human || !o.before) return;
  // 남이 방금 고친 글은 그 사람이 아직 손보는 중일 수 있다 — 자동 정리 배치와 같은 보호 창이다.
  //  마지막 저장이 같은 계정의 에이전트(MCP) 저장이면 막지 않는다: 자기가 방금 저장한 지식의 형식 안내를 받고 바로 고치는 게
  //  기본 흐름이다. updated_by 만으로는 같은 계정의 사람 웹 편집과 에이전트 저장을 못 가르므로 confidence(upsertKnowledge 가
  //  저장 출처로 매번 덮는 값, mcp → 'ai')를 함께 본다 — 계정만 보면 그 사람이 웹에서 고치던 글을 자기 에이전트가 덮는다.
  const ownLast = !!o.actor && o.before.updated_by === o.actor && o.before.confidence === "ai";
  if (!ownLast && isRecentlyEdited(o.before.updated_at, o.now)) {
    throw new HttpError(409,
      "다른 사람이 최근 24시간 안에 고친 지식이라 형식 정리 저장(style_fix)을 받지 않습니다 — 그 사람이 아직 손보는 중일 수 있습니다. 형식 위반은 그대로 두고, 24시간 뒤에 다시 고치세요.",
      { body: { style_fix: { rejected: "recently_edited", updated_at: o.before.updated_at ?? null, updated_by: o.before.updated_by ?? null } } });
  }
  // knowledge.title 은 nullable 이다 — 원문에 제목이 없으면 고친 글에도 요구하지 않는다(제목 없는 지식의 형식 정리가 막히지 않게).
  const violations = checkInvariants({ title: o.before.title, body_md: o.before.body_md }, o.after,
    { requireTitle: !!String(o.before.title ?? "").trim() });
  if (!violations.length) return;
  const lines = violations.map((v) => `- ${v.kind}: ${v.detail}`);
  throw new HttpError(422,
    [
      `형식 정리 저장(style_fix)인데 원문의 사실이 바뀌어 저장하지 않았습니다(${violations.length}건). 코드·수치·링크·표 값·분량은 원문 그대로 두고 형식만 고쳐 다시 저장하세요. 내용을 바꾸려는 저장이었다면 style_fix 를 빼고 보내세요.`,
      ...lines,
    ].join("\n"),
    { body: { style_fix: { rejected: "invariants", violations } } });
}
