// 서술 형식 위반을 사람 없이 푸는 저장 경로 배선 — 기준 날짜 조회(감사 기록).
//
// 판정은 순수 함수(v6/writing-resolve.ts)에 있고, 여기는 DB 조회만 맡는다.
import { itemsPool } from "../../db/client.js";
import { orgTimezone } from "../../org/timezone.js";
import { ANCHOR_LOOKUP_MAX, timeAnchors, timeReferenceLines, type TimeAnchor } from "../../v6/writing-resolve.js";

/**
 * 줄마다 본문에 처음 들어간 판의 저장 시각 — 판마다 본문 전문이 남는 감사 기록(insert·update)에서 한 번의 조회로 찾는다.
 *  줄은 글자·숫자만 남긴 꼴(lineKey)로 줄 머리부터 끝까지 맞아야 잡는다. 긴 줄의 일부만 같은 다른 줄로 이른 날이 나오지 않게
 *  하고, 굵게·기호·띄어쓰기만 고친 형식 정리 저장을 «그 줄이 처음 생긴 판» 으로 잡지 않게 한다 — 잡으면 형식만 고친 날이
 *  기준 날짜가 되고, 다음 형식 정리가 그 날짜를 사실 변경 없이 적게 된다. 감사 행마다 본문을 한 번만 푼다.
 */
export async function firstSeenInAudit(name: string, lines: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  const byKey = new Map<string, string[]>();
  for (const l of lines) {
    const k = lineKey(l);
    if (k) byKey.set(k, [...(byKey.get(k) ?? []), l]);
  }
  if (!byKey.size) return out;
  const r = await itemsPool.query<{ k: string; at: Date }>(
    `SELECT l.k, min(a.at) AS at
       FROM (SELECT at, E'\n' || regexp_replace(coalesce(after->>'body_md', ''), $4, '', 'g') || E'\n' AS body FROM org_content_audit
              WHERE entity='knowledge' AND entity_key=$1 AND op = ANY($2::text[])) a
       JOIN unnest($3::text[]) AS l(k) ON strpos(a.body, E'\n' || l.k || E'\n') > 0
      GROUP BY l.k`, [name, ["insert", "update"], [...byKey.keys()], LINE_KEY_DROP]);
  for (const row of r.rows) for (const l of byKey.get(row.k) ?? []) out.set(l, row.at);
  return out;
}

/** 줄 맞춤 키에서 지우는 글자 — 글자·숫자와 줄바꿈만 남긴다(SQL 과 JS 가 같은 식을 쓴다). */
const LINE_KEY_DROP = "[^0-9A-Za-z가-힣\n]";
const LINE_KEY_DROP_RE = new RegExp(LINE_KEY_DROP, "g");
export const lineKey = (line: string): string => line.replace(LINE_KEY_DROP_RE, "");

/** 한 저장 안에서 같은 지식의 줄별 조회 결과를 다시 쓴다(판정이 두 번 돌 때). */
export type AnchorCache = Map<string, Date | null>;

/** 지식 본문의 시점 표현 줄마다 기준 날짜. beforeBody 를 주면 저장(그 본문에 없던 줄은 오늘), 안 주면 읽기. */
export async function knowledgeAnchors(o: {
  name: string | null | undefined; body: string; beforeBody?: string | null;
  updatedAt?: Date | string | null; cache?: AnchorCache;
}): Promise<TimeAnchor[]> {
  const tz = await orgTimezone().catch(() => "UTC");
  const cache = o.cache ?? new Map<string, Date | null>();
  const before = o.beforeBody === undefined ? null : new Set(String(o.beforeBody ?? "").split("\n").map((l) => l.trim()));
  const legacy = timeReferenceLines(o.body).map((x) => x.line).filter((l) => (!before || before.has(l)) && !cache.has(l));
  if (o.name && legacy.length) {
    const found = await firstSeenInAudit(o.name, legacy.slice(0, ANCHOR_LOOKUP_MAX)).catch(() => new Map<string, Date>());
    for (const l of legacy.slice(0, ANCHOR_LOOKUP_MAX)) cache.set(l, found.get(l) ?? null);
  }
  return timeAnchors({
    body: o.body, beforeBody: o.beforeBody, now: new Date(), updatedAt: o.updatedAt, tz,
    firstSeen: o.name ? async (line) => cache.get(line) ?? null : undefined,
  });
}
