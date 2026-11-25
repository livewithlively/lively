// knowledge_save 의 덮어쓰기 안전장치 — 버전 대조(CAS)와 형식 정리 저장(style_fix)의 의미 보존·사람 편집 보호.
//
// 형식 정리를 에이전트 세션에 맡기면 서버가 안전을 보증해야 한다: 읽은 지식을 «형식만» 고친다며 수치·링크를 빠뜨리거나
//  사람이 방금 고친 글을 덮을 수 있다. 자동 정리 배치가 쓰는 판정(writing-rewrite-gate)을 같은 기준으로 저장 경로에 건다.
// 판정은 순수 함수다(DB 를 읽지 않는다) — 핸들러가 읽은 기존 행과 최종 제목·본문을 넘긴다. 조회는 lastContentWrite 하나뿐이다.
//  판 대조는 두 자리에서 한다: 핸들러가 읽은 판으로 미리(assertExpectedVersion — 낡은 판 위에 edit·append 를 계산하지 않게)와
//  쓰는 순간에(upsertKnowledge expectedVersion — 그 사이 낀 저장을 덮지 않게). 둘 다 versionConflictError 로 같은 409 를 낸다.
import { HttpError } from "../../http-error.js";
import { KnowledgeVersionConflictError } from "../../v6/knowledge-store.js";
import { itemsPool } from "../../db/client.js";
import { checkInvariants, isRecentlyEdited, type RewriteDoc } from "../../v6/writing-rewrite-gate.js";

export interface SaveGuardBefore {
  title: string | null | undefined;
  body_md: string | null | undefined;
  version: number | string;
  /** 마지막 본문·제목 저장의 출처 — upsertKnowledge·setKnowledgeTitle 이 저장마다 MCP 면 'ai', 그 밖은 'human' 으로 덮는다. */
  confidence?: string | null;
  updated_at?: string | Date | null;
  updated_by?: string | null;
  /** 지금 판을 만든 저장의 감사 기록(lastContentWrite). 없으면 confidence 로 가른다. */
  last_write?: LastWrite | null;
}

export interface LastWrite { actor: string | null; channel: string | null }

/** 지식의 판(version)을 올리는 저장의 감사 op — knowledge-store.ts 에서 `version=version+1` 하는 함수들이 남기는 op 다.
 *  판을 올리지 않는 토글(set_wiki·set_lifecycle·set_searchable)과 휴지통 복원도 after 에 지금 판을 싣는다. 그 행을 집으면
 *  같은 값으로 토글 하나만 부르고도 «지금 판을 만든 저장» 이 내 MCP 저장으로 바뀌어 남의 최근 편집 보호를 비껴간다. */
export const VERSION_BUMP_OPS = ["insert", "update", "set_title", "set_fields"] as const;

/**
 * 지금 판을 만든 저장의 계정·채널 — org_content_audit 에서 판을 올리는 op 이면서 after.version 이 그 판인 마지막 행.
 *  confidence 만으로는 «같은 계정의 에이전트 저장»을 다 못 가른다: fields 갱신(knowledge_set_fields)은 판을 올리면서
 *  confidence 를 그대로 둬 앞 저장의 출처가 남는다. 그래서 에이전트가 쓴 지식의 fields 를 사람이 웹에서 고친 직후에도
 *  보호 창이 안 걸린다. 판을 올리지 않는 토글 행을 «지금 판을 만든 저장» 으로 집지 않는 것도 이 조회의 몫이다.
 *  못 찾으면(조직 섹션처럼 다른 entity 로 감사되는 쓰기 등) null 이고 confidence 로 돌아간다. 조회 실패도 null 이다 —
 *  종전 판정으로 돌아갈 뿐 보호가 약해지지 않는다. 검증: save-guard-last-write.pg-test.mjs.
 */
export async function lastContentWrite(name: string, version: number | string): Promise<LastWrite | null> {
  try {
    const r = await itemsPool.query<LastWrite>(
      `SELECT actor, channel FROM org_content_audit
        WHERE entity='knowledge' AND entity_key=$1 AND op = ANY($2::text[]) AND after->>'version' = $3
        ORDER BY id DESC LIMIT 1`, [name, [...VERSION_BUMP_OPS], String(version)]);
    return r.rows[0] ?? null;
  } catch (e) {
    console.warn(`[save-guard] 마지막 저장 조회 실패 — confidence 로 판정한다: ${(e as Error)?.message ?? e}`);
    return null;
  }
}

/** 판 대조가 어긋났을 때의 409 — current 는 지금 판(지식이 없으면 null). */
export function versionConflictError(expected: number, current: number | null): HttpError {
  const msg = current == null
    ? `expected_version=${expected} 를 보냈지만 이 지식은 없습니다 — 이름을 확인하세요.`
    : `이 지식은 그 사이 바뀌었습니다(보낸 판 ${expected}, 지금 판 ${current}). knowledge_get 으로 지금 본문을 다시 읽고 고쳐 저장하세요 — 그대로 저장하면 그 변경을 덮어씁니다.`;
  return new HttpError(409, msg, { body: { conflict: "version", expected_version: expected, current_version: current } });
}

/** expected_version 이 있으면 지금 판과 같아야 한다. 없는 지식(신규)은 판이 없으므로 어긋난 것으로 본다. */
export function assertExpectedVersion(before: Pick<SaveGuardBefore, "version"> | null | undefined, expected: number | null | undefined): void {
  if (expected == null) return;
  const current = before ? Number(before.version) : null;
  if (current === expected) return;
  throw versionConflictError(expected, current);
}

/** 쓰는 순간의 판 대조(upsertKnowledge 의 KnowledgeVersionConflictError)를 미리 한 대조와 같은 409 로 바꾼다 — 다른 오류는 그대로. */
export function rethrowVersionConflict(e: unknown): never {
  if (e instanceof KnowledgeVersionConflictError) throw versionConflictError(e.expectedVersion, e.currentVersion);
  throw e;
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
  /** 이 저장에 새로 들어와도 되는 날짜 — 원문의 상대시간·상태 서술 줄의 기준 날짜(writing-resolve allowedAnchorDates). */
  allowedDates?: ReadonlySet<string>;
}): void {
  if (!o.styleFix || o.human || !o.before) return;
  // 남이 방금 고친 글은 그 사람이 아직 손보는 중일 수 있다 — 자동 정리 배치와 같은 보호 창이다.
  //  마지막 저장이 같은 계정의 에이전트(MCP) 저장이면 막지 않는다: 자기가 방금 저장한 지식의 형식 안내를 받고 바로 고치는 게
  //  기본 흐름이다. updated_by 만으로는 같은 계정의 사람 웹 편집과 에이전트 저장을 못 가르므로 confidence(본문·제목 저장이
  //  출처로 매번 덮는 값, mcp → 'ai')를 함께 본다 — 계정만 보면 그 사람이 웹에서 고치던 글을 자기 에이전트가 덮는다.
  //  지금 판을 만든 저장의 감사 기록이 있으면 그것을 먼저 본다(confidence 를 안 바꾸는 저장이 있다 — lastContentWrite).
  const lw = o.before.last_write;
  const ownLast = !!o.actor && (lw
    ? lw.actor === o.actor && lw.channel === "mcp"
    : o.before.updated_by === o.actor && o.before.confidence === "ai");
  if (!ownLast && isRecentlyEdited(o.before.updated_at, o.now)) {
    throw new HttpError(409,
      "다른 사람이 최근 24시간 안에 고친 지식이라 형식 정리 저장(style_fix)을 받지 않습니다 — 그 사람이 아직 손보는 중일 수 있습니다. 형식 위반은 그대로 두고, 24시간 뒤에 다시 고치세요.",
      { body: { style_fix: { rejected: "recently_edited", updated_at: o.before.updated_at ?? null, updated_by: o.before.updated_by ?? null } } });
  }
  // knowledge.title 은 nullable 이다 — 원문에 제목이 없으면 고친 글에도 요구하지 않는다(제목 없는 지식의 형식 정리가 막히지 않게).
  const violations = checkInvariants({ title: o.before.title, body_md: o.before.body_md }, o.after,
    { requireTitle: !!String(o.before.title ?? "").trim(), allowAddedDates: o.allowedDates });
  if (!violations.length) return;
  const lines = violations.map((v) => `- ${v.kind}: ${v.detail}`);
  throw new HttpError(422,
    [
      `형식 정리 저장(style_fix)인데 원문의 사실이 바뀌어 저장하지 않았습니다(${violations.length}건). 코드·수치·링크·표 값·분량은 원문 그대로 두고 형식만 고쳐 다시 저장하세요. 내용을 바꾸려는 저장이었다면 style_fix 를 빼고 보내세요.`,
      ...lines,
    ].join("\n"),
    { body: { style_fix: { rejected: "invariants", violations } } });
}
