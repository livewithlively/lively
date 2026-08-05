// #1291 v4 — 커넥터별 **자료 공개범위 정책**. 수집된 자료가 태어날 때 공개범위를 정한다.
//
//  왜 커넥터 축인가: 자료의 생산자는 사람이 아니라 커넥터다(슬랙·지메일·디스코드…). 개별 자료를 사람이
//  하나씩 잠그는 건 현실적이지 않다(어니스트 실측 564건, 슬랙만 10,900건). 생산 지점에 정책을 걸면
//  "이 채널에서 들어오는 건 이 팀만" 을 한 번 정하고 이후 자동으로 적용된다.
//
//  왜 채널 오버라이드가 있나: 슬랙에서 실제 단위는 커넥터가 아니라 **채널**이다. 이미 채널별 수집 정책
//  (#1226/#1262 — 비공개 채널 기본 거부)이 있는 것과 같은 이유다. 그래서 커넥터 기본값 위에 채널 규칙을 얹는다.
//
//  ── 규약 ──
//  · 매칭은 **좁은 것이 이긴다**: 채널 지정 규칙 > 커넥터 전체 규칙. 동률이면 priority, 그다음 최신.
//  · 규칙이 없으면 `open`(현행 동작) — 정책을 안 세운 조직에선 아무것도 달라지지 않는다.
//  · **스탬핑은 INSERT 에만.** 재싱크(UPDATE)로 덮으면 사람이 손으로 조정한 공개범위가 매 동기화마다 되돌아간다.
//  · 정책 조회 실패는 **유예 후 fail-closed** — 유출은 못 되돌리고 과차단은 되돌릴 수 있다(backfill 로 정정 가능).
//    단 캐시된 값이 있으면 그걸 쓴다(순간 장애로 수천 건이 잠기는 걸 막는다 — hiddenProjects 와 같은 유예 패턴).
import { itemsPool } from "../db/client.js";
import { logger } from "../log.js";
import { axisOn } from "./visibility-axes.js";
import { auditKnowledge } from "./knowledge-common.js";
import type { WriteCtx } from "./content-audit.js";
import type pg from "pg";

export interface SourceVisRule {
  id: number;
  match_system: string;
  match_channel: string | null;
  visibility: "open" | "members";
  priority: number;
  members: Array<{ subject_kind: "member" | "team"; member_id: string }>;
}

export interface ResolvedSourceVis {
  visibility: "open" | "members";
  members: Array<{ subject_kind: "member" | "team"; member_id: string }>;
  ruleId: number | null;
}

const OPEN: ResolvedSourceVis = { visibility: "open", members: [], ruleId: null };
const TTL_MS = 30_000;
const GRACE_MS = 5 * 60_000;
let cache: { v: SourceVisRule[]; at: number; ok: number } | null = null;

/** 규칙 전체(캐시). 실패 시 유예 안이면 옛 값, 아니면 throw — 호출부가 fail-closed 로 판단한다. */
export async function sourceVisRules(): Promise<SourceVisRule[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.v;
  try {
    const { rows } = await itemsPool.query(`
      SELECT p.id, p.match_system, p.match_channel, p.visibility, p.priority,
             COALESCE(json_agg(json_build_object('subject_kind', m.subject_kind, 'member_id', m.member_id))
                      FILTER (WHERE m.member_id IS NOT NULL), '[]') AS members
        FROM org_source_vis_policy p
        LEFT JOIN org_source_vis_policy_member m ON m.policy_id = p.id
       WHERE p.enabled
       GROUP BY p.id`);
    const v = rows.map((r: any) => ({
      id: Number(r.id), match_system: String(r.match_system),
      match_channel: r.match_channel == null ? null : String(r.match_channel),
      visibility: r.visibility === "members" ? "members" as const : "open" as const,
      priority: Number(r.priority ?? 0),
      members: (r.members ?? []) as SourceVisRule["members"],
    }));
    cache = { v, at: now, ok: now };
    return v;
  } catch (e) {
    if (cache && now - cache.ok < GRACE_MS) { cache.at = now; return cache.v; }
    logger.warn({ err: (e as Error)?.message }, "[source-vis] 정책 조회 실패 — 수집물을 닫는 쪽으로 처리한다");
    throw e;
  }
}

export function invalidateSourceVisRules(): void { cache = null; }

/**
 * 이 자료가 태어날 때 가질 공개범위.
 * @param channels 자료의 채널 좌표 후보(container_ref·container_name) — 둘 중 하나라도 규칙과 맞으면 채널 매칭.
 */
export function pickRule(rules: SourceVisRule[], system: string, channels: Array<string | null | undefined>): ResolvedSourceVis {
  const chan = channels.filter((c): c is string => !!c && !!String(c).trim()).map(String);
  const mine = rules.filter((r) => r.match_system === system);
  if (!mine.length) return OPEN;
  // 좁은 것이 이긴다 — 채널을 지정한 규칙이 커넥터 전체 규칙을 덮는다.
  const byChannel = mine.filter((r) => r.match_channel && chan.includes(r.match_channel));
  const pool = byChannel.length ? byChannel : mine.filter((r) => !r.match_channel);
  if (!pool.length) return OPEN;
  const best = pool.sort((a, b) => (b.priority - a.priority) || (b.id - a.id))[0];
  return { visibility: best.visibility, members: best.members, ruleId: best.id };
}

/**
 * 수집 경로에서 부른다(INSERT 직후, 같은 트랜잭션). 정책이 `members` 면 자료를 잠그고 대상을 심는다.
 *  ⚠ 축이 꺼져 있으면 아무것도 하지 않는다 — 조직이 이 기능을 안 쓰는데 조용히 잠금을 심어두면
 *   나중에 축을 켜는 순간 예상 못 한 잠금이 쏟아진다. 나중에 켜고 backfill 하면 소급 적용된다.
 */
export async function stampSourceVisibility(
  client: Pick<pg.PoolClient, "query">, sourceId: number, system: string,
  channels: Array<string | null | undefined>,
): Promise<void> {
  if (!(await axisOn("source"))) return;
  let picked: ResolvedSourceVis;
  try {
    picked = pickRule(await sourceVisRules(), system, channels);
  } catch {
    // 정책을 못 읽었다 — 열어 두면 정책 위반이 유출로 굳는다. 닫아 두면 backfill 로 되돌릴 수 있다.
    picked = { visibility: "members", members: [], ruleId: null };
    logger.warn({ sourceId, system }, "[source-vis] 정책 판정 불가 — 이 자료를 잠근 채로 둔다(정책 복구 후 backfill)");
  }
  if (picked.visibility !== "members") return;   // open = 기본값이라 쓸 것이 없다
  await applyVisibility(client, sourceId, picked.members);
}

/** 자료 1건에 공개범위를 적용(잠그고 대상 교체). 스탬핑·백필이 같은 함수를 쓴다 — 규칙을 두 번 적지 않는다. */
export async function applyVisibility(
  client: Pick<pg.PoolClient, "query">, sourceId: number,
  members: Array<{ subject_kind: "member" | "team"; member_id: string }>,
): Promise<void> {
  await client.query(`UPDATE source SET visibility='members' WHERE id=$1`, [sourceId]);
  await client.query(`DELETE FROM source_member WHERE source_id=$1`, [sourceId]);
  if (!members.length) return;
  await client.query(
    `INSERT INTO source_member(source_id, subject_kind, member_id)
     SELECT $1, k, m FROM unnest($2::text[], $3::text[]) AS t(k, m)
     ON CONFLICT DO NOTHING`,
    [sourceId, members.map((m) => m.subject_kind), members.map((m) => m.member_id)]);
}

/**
 * 증류 지식이 원본 자료의 공개범위를 물려받는다(#1291 v4) — `derived_from` 링크가 생기는 순간 한 번.
 *
 *  왜 여기인가: 증류기는 `knowledge_save` 로 지식을 쓰고 `source_link_knowledge` 로 원본을 잇는다.
 *  그 링크가 "이 지식은 저 자료에서 나왔다"가 성립하는 **유일한 지점**이라, 상속도 여기 한 곳에 건다.
 *
 *  왜 교집합인가: 이 프로젝트의 상속 규칙은 일관되게 **단조 축소**다. 제한된 자료가 하나라도 섞였는데
 *  지식이 전체공개로 나가면 그게 유출이다 — 증류는 원문을 요약할 뿐 기밀성을 없애지 않는다.
 *
 *  ⚠ 교집합이 비면(서로 다른 팀의 자료를 섞어 증류) 지식은 **아무에게도 안 보이게** 된다. 그게 안전한
 *   기본값이지만 사람이 알아야 고칠 수 있으므로 호출부가 결과를 받아 알린다(조용히 잠그지 않는다).
 */
export interface InheritResult { applied: boolean; visibility: "open" | "members"; audience: number; empty: boolean }

export async function inheritSourceVisibility(name: string, sourceId: number, ctx?: WriteCtx): Promise<InheritResult> {
  const none: InheritResult = { applied: false, visibility: "open", audience: 0, empty: false };
  // 두 축이 다 켜져 있어야 의미가 있다 — 자료 잠금이 강제되지 않거나(자료 축 off) 지식 잠금이 강제되지
  //  않으면(지식 축 off) 상속은 아무 보호도 못 하면서 예상 못 한 잠금만 만든다.
  if (!(await axisOn("source")) || !(await axisOn("knowledge"))) return none;

  const src = await itemsPool.query(
    `SELECT visibility FROM source WHERE id=$1`, [sourceId]);
  if (src.rows[0]?.visibility !== "members") return none;   // 원본이 전원 공개면 물려줄 제한이 없다

  const srcAud = await itemsPool.query(
    `SELECT subject_kind, member_id FROM source_member WHERE source_id=$1`, [sourceId]);
  const srcSet = new Set(srcAud.rows.map((r: any) => `${r.subject_kind}:${r.member_id}`));

  const kRow = await itemsPool.query(`SELECT visibility FROM knowledge WHERE name=$1`, [name]);
  if (!kRow.rows.length) return none;
  const kLocked = kRow.rows[0].visibility === "members";

  let nextSet: Set<string>;
  let prevAudience = 0;                                // 잠금 전 대상 수 — 감사 before 와 no-op 판정에 쓴다
  if (!kLocked) {
    nextSet = srcSet;                                  // 열려 있던 지식 → 원본 대상으로 좁힌다
  } else {
    const kAud = await itemsPool.query(
      `SELECT subject_kind, member_id FROM knowledge_member WHERE name=$1`, [name]);
    const kSet = new Set(kAud.rows.map((r: any) => `${r.subject_kind}:${r.member_id}`));
    prevAudience = kSet.size;
    nextSet = new Set([...kSet].filter((x) => srcSet.has(x)));   // 이미 잠긴 지식 → 교집합(더 좁아지기만)
  }

  const rows = [...nextSet].map((x) => { const i = x.indexOf(":"); return { k: x.slice(0, i), m: x.slice(i + 1) }; });
  await itemsPool.query(`UPDATE knowledge SET visibility='members' WHERE name=$1`, [name]);
  await itemsPool.query(`DELETE FROM knowledge_member WHERE name=$1`, [name]);
  if (rows.length) {
    await itemsPool.query(
      `INSERT INTO knowledge_member(name, subject_kind, member_id)
       SELECT $1, k, m FROM unnest($2::text[], $3::text[]) AS t(k, m) ON CONFLICT DO NOTHING`,
      [name, rows.map((r) => r.k), rows.map((r) => r.m)]);
  }
  if (!rows.length) {
    logger.warn({ knowledge: name, sourceId },
      "[source-vis] 증류 지식의 상속 대상이 비었다 — 서로 다른 대상의 자료를 섞었을 수 있다(현재 아무도 못 본다)");
  }
  // #1561 감사 — **접근통제 이력**. 이 경로는 사람이 아무것도 누르지 않았는데 문서가 잠기는 자리라,
  //  안 남기면 '누가·언제·왜 이 문서를 잠갔나'에 답할 수 없다(그건 감사가 반드시 덮어야 하는 종류의 변경이다).
  //  ⚠ 실변경일 때만 — 이미 같은 대상으로 잠긴 문서를 재증류할 때마다 감사행이 쌓이면 타임라인이 덮인다
  //   (미러의 감사 노이즈 게이트와 같은 결). nextSet ⊆ kSet 이라 크기 비교만으로 동일 집합 판정이 성립한다.
  if (!kLocked || nextSet.size !== prevAudience) {
    await auditKnowledge(name, "set_visibility",
      { name, visibility: kLocked ? "members" : "open", audience: prevAudience },
      { name, visibility: "members", audience: rows.length, via_source: sourceId }, ctx);
  }
  return { applied: true, visibility: "members", audience: rows.length, empty: !rows.length };
}
