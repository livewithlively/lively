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

/**
 * 커넥터가 «이 자료는 이 사람 것»이라고 말한 자료(RawItem.audience)를 그 사람만 보게 잠근다.
 *  (처음 쓴 곳은 Zotero 개인 라이브러리였는데 #2202 에서 걷었다 — 지금 이 표시를 내는 커넥터는 없다.)
 *  INSERT 직후 stampSourceVisibility **다음에** 부른다 — 조직 정책의 결과를 **주인으로 바꿔 쓴다**(개인 라이브러리는 정책의
 *  대상이 아니라 그 사람의 것이다. 정책이 «관리자만» 이어도 주인이 못 보면 안 된다).
 *  ⚠ stampSourceVisibility 와 달리 **축이 꺼져 있어도 심는다.** 그쪽이 축 꺼짐을 지키는 이유는 «켜는 순간 예상 못 한 잠금이
 *   쏟아지는 것»인데, 개인 라이브러리는 켜는 순간 주인에게 잠기는 것이 **예상한 결과**다. 꺼져 있는 동안엔 술어(sourceVisWhere)가
 *   보지 않으니 아무것도 달라지지 않고, 켜면 그때까지 모인 것도 함께 잠긴다(소급 백필이 필요 없다 — 정책 백필은 이 주인을 모른다).
 */
export async function stampSourceAudience(
  client: Pick<pg.PoolClient, "query">, sourceId: number, memberIds: string[],
): Promise<void> {
  const ids = [...new Set(memberIds.map((m) => String(m ?? "").trim()).filter(Boolean))];
  if (!ids.length) return;
  await applyVisibility(client, sourceId, ids.map((member_id) => ({ subject_kind: "member" as const, member_id })));
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

// 증류 지식이 원본 자료의 공개범위를 물려받는 일(#1291 v4)은 #4824 부터 derived-visibility.ts 가 한다 —
//  연결·판정·맞추기를 한 트랜잭션에서, 그리고 자료가 나중에 좁혀질 때도(applySourceAudience · 정책 소급) 같은 함수로.
//  종전의 «연결 뒤 한 번 · 실패는 삼킴» 상속(inheritSourceVisibility)은 그 자리로 옮겨 걷었다.
