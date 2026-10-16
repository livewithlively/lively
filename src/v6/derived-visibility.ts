// #4824 — 증류 지식의 공개범위를 원본 자료에 맞춘다(DB). 계산은 derived-audience.ts(순수)가 한다.
//
//  종전(#1291 v4)에는 `source_link_knowledge` 가 연결 행을 **먼저 커밋한 뒤** 한 번 상속하고, 실패는 삼켰다.
//   그래서 세 갈래로 샜다(태스크 #4824): ① 연결을 빠뜨리거나 상속이 실패하면 잠긴 자료로 만든 지식이 공개로 남고,
//   ② 잠긴 자료를 이미 공개된 지식에 합치면 그 문서가 조용히 좁혀져 보던 사람이 잃고(지식 공개범위는 사람이 되돌릴
//   도구가 없다), ③ 연결 뒤에 자료가 좁혀지면(단위 «모두»→«나만», 정책 소급) 지식은 그대로 넓었다.
//   그리고 리스트 grant(비공개 프로젝트 지식)는 OR 이라 상속이 걸려도 프로젝트 구성원 전원이 계속 봤다.
//
//  규칙: 지식 대상 ⊆ 잠긴 derived_from 자료 각각의 대상. «맞추기» 가 이벤트마다 그 이벤트의 트랜잭션 안에서 지킨다 —
//   연결이 생길 때(linkDerivedSources) · 자료가 좁혀질 때(reconcileDerivedVisibility) · 축을 켤 때(reconcileAllDerived).
//   좁히기만 한다(자료를 넓혀도 지식은 그대로 — 지식 넓히기는 사람 몫).
//
//  ⚠ 거절과 좁히기의 경계(격리 검토 2026-10-17):
//   · 내용을 쓰기 **전**(knowledge_save + derived_from)이면 «지금 보는 사람이 줄어드는 합치기» 를 거절한다 — 빈틈 ②.
//   · 단독 연결(source_link_knowledge)은 내용이 이미 들어간 **뒤**에 온다. 거기서 거절하면 잠긴 내용이 넓은 문서에 남아
//     유출이 된다 — 그래서 종전처럼 좁힌다(닫히는 쪽). 예외: 증류 배치가 이번 판에 쓰지도 않은 지식에 잇는 것은 합치기가
//     아니라 «남이 보던 문서를 좁히기» 뿐이라 거절한다(배치는 knowledge_save 의 derived_from 으로만 잇는다).
//
//  ⚠ 잠금 순서는 **자료 → 지식**이다. 연결은 자료를 FOR SHARE 로 먼저 잡고 지식을 FOR NO KEY UPDATE 로 잡는다. 좁히기는
//   자료를 UPDATE(배타) 한 뒤 지식을 잡는다. 지식을 쥔 채 자료를 잡는 길을 만들지 마라 — 교착이 된다.
//   지식은 FOR UPDATE 가 아니라 FOR NO KEY UPDATE — 지식을 가리키는 FK 삽입(knowledge_link·knowledge_category·
//   knowledge_source)이 거는 KEY SHARE 와 부딪치지 않게(위키링크 재작성과 서로 기다리지 않게). 키 칸은 안 바꾼다.
//   여러 건이면 이름 순(COLLATE "C" — JS 정렬과 같은 순서)으로 잡는다.
//   둘이 겹치면 나중 쪽이 앞의 커밋을 보고 다시 계산한다(READ COMMITTED · 문장마다 새 스냅샷).
//
//  ⚠ 이 파일의 쿼리는 전부 받은 `db`(트랜잭션 클라이언트)로 낸다 — 풀(itemsPool)로 내면 트랜잭션 밖에서 읽어
//   이 트랜잭션이 막 좁힌 대상을 못 보고(옛 대상으로 계산 = 유출), 잡은 행을 풀이 기다리면 스스로를 기다린다.
//   예외: 축 설정(derivedEnforced — 잠그기 **전에** 읽어 넘긴다). 증류 배치 판정은 org/distill/distill-batch.ts(잠그기 전에 부른다).
import type pg from "pg";
import { itemsPool, withTx } from "../db/client.js";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import { axisOn } from "./visibility-axes.js";
import { auditKnowledge } from "./knowledge-common.js";
import type { WriteCtx } from "./content-audit.js";
import {
  expandMembers, planDerivedAudience, splitSubject, subjectKey,
  type DerivedPlan, type KnowledgeAudience, type LockedSourceAudience,
} from "./derived-audience.js";

type Q = Pick<pg.PoolClient, "query">;

/** 한 번에 맞추는 지식 수 — 지식 행을 쥐는 범위라 너무 크게 잡지 않는다. */
export const RECONCILE_BATCH = 200;
/** 이 파일이 여는 트랜잭션의 잠금 대기 상한 — 넘으면 503(잠시 뒤). 풀(20)을 쥔 채 끝없이 기다리지 않게(#4638 결). */
export const DERIVED_LOCK_TIMEOUT_MS = 10_000;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 맞추기가 도는가 — 자료 축과 지식 축이 **둘 다** 켜져 있을 때만(종전 상속과 같은 규칙).
 *  자료 축이 꺼져 있으면 자료가 전원에게 보이므로 그 자료로 만든 지식을 잠글 까닭이 없다. 지식 축이 꺼져 있으면 잠가도
 *  강제되지 않는다. 꺼진 축을 켜서 둘 다 켜지는 순간 reconcileAllDerived 가 전부 맞춘다(vis_axis_set).
 */
export async function derivedEnforced(): Promise<boolean> {
  return (await axisOn("source")) && (await axisOn("knowledge"));
}

/**
 * 이 파일의 쓰기 트랜잭션 — 잠금 대기 상한(SET LOCAL lock_timeout) + 교착(40P01) 한 번 다시 + 대기 초과(55P03)는 503.
 *  자료를 잡는 곳은 모두 한 문장 · 전역 id 순이다(여기 lockSources · 단위 applySourceAudience). 그래도 잠금 순서가 다른 옛 경로
 *   (자료를 행마다 따로 고치는 곳)와는 교착이 남을 수 있다 — 한 번 다시 하면 대개 풀린다.
 */
export async function withDerivedTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTx(async (client) => {
        await client.query(`SET LOCAL lock_timeout = '${DERIVED_LOCK_TIMEOUT_MS}ms'`);
        return fn(client);
      });
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "40P01" && attempt === 0) continue;
      if (code === "55P03" || code === "40P01") {
        throw new HttpError(503, "같은 지식·자료를 다른 작업이 고치는 중이라 이번 저장을 마치지 못했습니다 — 아무것도 바뀌지 않았습니다. 잠시 뒤 다시 시도하세요.", { cause: e });
      }
      throw e;
    }
  }
}

export interface SourceState { id: number; locked: boolean; subjects: string[] }

/** 자료를 FOR SHARE 로 잡고(id 순) 잠김·대상을 읽는다. 없는 id 는 missing. */
export async function lockSources(db: Q, ids: readonly number[]): Promise<{ found: Map<number, SourceState>; missing: number[] }> {
  const uniq = [...new Set(ids.map(Number))].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  const found = new Map<number, SourceState>();
  if (!uniq.length) return { found, missing: [] };
  const r = await db.query(`SELECT id, visibility FROM source WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE`, [uniq]);
  for (const row of r.rows as Array<{ id: number; visibility: string }>) {
    found.set(Number(row.id), { id: Number(row.id), locked: row.visibility === "members", subjects: [] });
  }
  const lockedIds = [...found.values()].filter((s) => s.locked).map((s) => s.id);
  if (lockedIds.length) {
    const m = await db.query(`SELECT source_id, subject_kind, member_id FROM source_member WHERE source_id = ANY($1::int[])`, [lockedIds]);
    for (const row of m.rows as Array<{ source_id: number; subject_kind: string; member_id: string }>) {
      found.get(Number(row.source_id))?.subjects.push(subjectKey(String(row.subject_kind), String(row.member_id)));
    }
  }
  return { found, missing: uniq.filter((id) => !found.has(id)) };
}

/** 지식들의 공개범위·대상·리스트. lock=true 면 이름 순으로 FOR NO KEY UPDATE. 없는 이름은 빠진다. */
async function loadKnowledge(db: Q, names: readonly string[], lock: boolean): Promise<Map<string, KnowledgeAudience>> {
  const sorted = [...new Set(names)].sort(byCodeUnit);
  const out = new Map<string, { open: boolean; subjects: string[]; lists: number[] }>();
  if (!sorted.length) return out;
  const r = await db.query(
    `SELECT name, visibility FROM knowledge WHERE name = ANY($1::text[]) ORDER BY name COLLATE "C"${lock ? " FOR NO KEY UPDATE" : ""}`, [sorted]);
  for (const row of r.rows as Array<{ name: string; visibility: string }>) {
    out.set(String(row.name), { open: row.visibility !== "members", subjects: [], lists: [] });
  }
  if (!out.size) return out;
  const present = [...out.keys()];
  const m = await db.query(`SELECT name, subject_kind, member_id FROM knowledge_member WHERE name = ANY($1::text[])`, [present]);
  for (const row of m.rows as Array<{ name: string; subject_kind: string; member_id: string }>) {
    out.get(String(row.name))?.subjects.push(subjectKey(String(row.subject_kind), String(row.member_id)));
  }
  const g = await db.query(`SELECT name, list_id FROM knowledge_list_grant WHERE name = ANY($1::text[])`, [present]);
  for (const row of g.rows as Array<{ name: string; list_id: number }>) out.get(String(row.name))?.lists.push(Number(row.list_id));
  return out;
}

/** 지식별로 이미 이어진 **잠긴** derived_from 자료와 그 대상. */
async function loadLockedDerived(db: Q, names: readonly string[]): Promise<Map<string, LockedSourceAudience[]>> {
  const out = new Map<string, LockedSourceAudience[]>();
  if (!names.length) return out;
  const r = await db.query(
    `SELECT ks.name, s.id FROM knowledge_source ks JOIN source s ON s.id = ks.source_id
      WHERE ks.name = ANY($1::text[]) AND ks.relation = 'derived_from' AND s.visibility = 'members'`, [[...names]]);
  const ids = [...new Set((r.rows as Array<{ id: number }>).map((x) => Number(x.id)))];
  const aud = new Map<number, string[]>();
  if (ids.length) {
    const m = await db.query(`SELECT source_id, subject_kind, member_id FROM source_member WHERE source_id = ANY($1::int[])`, [ids]);
    for (const row of m.rows as Array<{ source_id: number; subject_kind: string; member_id: string }>) {
      const k = Number(row.source_id);
      aud.set(k, [...(aud.get(k) ?? []), subjectKey(String(row.subject_kind), String(row.member_id))]);
    }
  }
  for (const row of r.rows as Array<{ name: string; id: number }>) {
    const list = out.get(String(row.name)) ?? [];
    list.push({ id: Number(row.id), subjects: aud.get(Number(row.id)) ?? [] });
    out.set(String(row.name), list);
  }
  return out;
}

/** 열쇠들에 나오는 팀의 지금 팀원 — «좁아지나» 를 사람 단위로 재는 데만 쓴다(저장하는 대상은 팀 그대로다). */
async function loadTeams(db: Q, keys: Iterable<string>): Promise<Map<string, Set<string>>> {
  const teamIds = [...new Set([...keys].filter((k) => k.startsWith("team:")).map((k) => k.slice("team:".length)))];
  const out = new Map<string, Set<string>>();
  if (!teamIds.length) return out;
  const r = await db.query(`SELECT team_id::text AS team_id, member_id FROM team_member WHERE team_id::text = ANY($1::text[])`, [teamIds]);
  for (const row of r.rows as Array<{ team_id: string; member_id: string }>) {
    out.set(String(row.team_id), (out.get(String(row.team_id)) ?? new Set<string>()).add(String(row.member_id)));
  }
  return out;
}

/** 맞춘 결과를 쓴다(바뀐 경우만) + 감사. 감사도 같은 트랜잭션이라 잠금과 함께 커밋·롤백된다. */
async function applyPlan(
  db: Q, name: string, before: KnowledgeAudience, plan: DerivedPlan, ctx: WriteCtx | undefined,
  via: { sources: readonly number[]; reason: string },
): Promise<void> {
  if (!plan.changed) return;
  const { next } = plan;
  await db.query(`UPDATE knowledge SET visibility = $2 WHERE name = $1`, [name, next.open ? "open" : "members"]);
  await db.query(`DELETE FROM knowledge_member WHERE name = $1`, [name]);
  if (next.subjects.length) {
    const kinds: string[] = [], ids: string[] = [];
    for (const s of next.subjects) { const p = splitSubject(s); kinds.push(p.kind); ids.push(p.id); }
    await db.query(
      `INSERT INTO knowledge_member(name, subject_kind, member_id)
       SELECT $1, k, m FROM unnest($2::text[], $3::text[]) AS t(k, m) ON CONFLICT DO NOTHING`, [name, kinds, ids]);
  }
  if (plan.dropsLists) await db.query(`DELETE FROM knowledge_list_grant WHERE name = $1`, [name]);
  if (plan.empty) {
    logger.warn({ knowledge: name, sources: via.sources, reason: via.reason },
      "[derived-vis] 증류 지식의 볼 수 있는 사람이 비었다 — 서로 다른 대상의 잠긴 자료가 섞였다(지금 관리자만 본다)");
  }
  // #1561 감사 — 접근통제 이력. 사람이 아무것도 누르지 않았는데 문서가 잠기는 자리라 «누가·언제·왜» 가 남아야 한다.
  //  via_source(첫 자료)는 옛 상속 감사와 같은 칸, via_sources 는 이번에 맞춘 근거 전부. 부팅 해제(#4007)가 이 칸을 읽는다.
  await auditKnowledge(name, "set_visibility",
    { name, visibility: before.open ? "open" : "members", audience: before.subjects.length, lists: [...before.lists] },
    {
      name, visibility: next.open ? "open" : "members", audience: next.subjects.length,
      via_source: via.sources[0] ?? null, via_sources: [...via.sources], reason: via.reason,
      ...(plan.dropsLists ? { dropped_list_grants: [...before.lists] } : {}),
    }, ctx, db);
}

export interface DerivedChange { name: string; empty: boolean; dropsLists: boolean }

/**
 * 맞추기 — 대상 지식(이름 + 이 자료들에서 derived_from 으로 나온 것)을 잠긴 원본 자료에 맞춘다. 좁히기만 한다(사양 R1·R2·R9).
 *  부르는 쪽 트랜잭션 안에서 부른다(자료를 좁힌 그 트랜잭션). 거절하지 않는다 — 자료가 이미 좁혀졌으니 지식도 따라야 한다.
 *  enforced 를 넘기면 축을 다시 읽지 않는다(잠금을 쥔 채 풀을 기다리지 않게 — 부르는 쪽이 잠그기 전에 읽어 둔다).
 */
export async function reconcileDerivedVisibility(
  db: Q, target: { names?: readonly string[]; sourceIds?: readonly number[] }, ctx?: WriteCtx, reason = "source_narrowed",
  enforced?: boolean,
): Promise<DerivedChange[]> {
  if (!(enforced ?? await derivedEnforced())) return [];
  const names = new Set(target.names ?? []);
  const sids = [...new Set((target.sourceIds ?? []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (sids.length) {
    for (const n of await linkMirrorCopies(db, sids, ctx)) names.add(n);
    const r = await db.query(
      `SELECT DISTINCT name FROM knowledge_source WHERE source_id = ANY($1::int[]) AND relation = 'derived_from'`, [sids]);
    for (const row of r.rows as Array<{ name: string }>) names.add(String(row.name));
  }
  const all = [...names].sort(byCodeUnit);
  const out: DerivedChange[] = [];
  for (let i = 0; i < all.length; i += RECONCILE_BATCH) {
    const chunk = all.slice(i, i + RECONCILE_BATCH);
    const ks = await loadKnowledge(db, chunk, true);
    const lockedBy = await loadLockedDerived(db, [...ks.keys()]);
    const teams = await loadTeams(db, [
      ...[...ks.values()].flatMap((k) => k.subjects),
      ...[...lockedBy.values()].flat().flatMap((s) => s.subjects),
    ]);
    for (const [name, k] of ks) {
      const locked = lockedBy.get(name) ?? [];
      if (!locked.length) continue;
      const plan = planDerivedAudience(k, locked, teams);
      if (!plan.changed) continue;
      await applyPlan(db, name, k, plan, ctx, { sources: locked.map((s) => s.id), reason });
      out.push({ name, empty: plan.empty, dropsLists: plan.dropsLists });
    }
  }
  return out;
}

/**
 * 같은 외부 항목의 지식 사본을 잠긴 자료에 derived_from 으로 잇는다 — 수집기 «자료+지식(both)» 출력이 원문 그대로의 지식
 *  사본을 연결 없이 만들어(connector-mirror), 자료가 잠겨도 사본은 공개로 남았다(격리 검토). 같은 외부 좌표
 *  (external_system·instance·id)면 같은 항목의 같은 원문이다. 잠긴 자료만 잇는다(열린 자료는 물려줄 제한이 없고, 연결은
 *  그 자료를 «증류됨» 으로 만들어 증류 인박스에서 뺀다). 이은 지식 이름을 돌려준다.
 */
export async function linkMirrorCopies(db: Q, sourceIds: readonly number[], ctx?: WriteCtx): Promise<string[]> {
  if (!sourceIds.length) return [];
  const r = await db.query(
    `INSERT INTO knowledge_source(name, source_id, relation, created_at)
     SELECT k.name, s.id, 'derived_from', now()
       FROM source s
       JOIN knowledge k ON k.external_system = s.external_system AND k.external_instance = s.external_instance
                       AND k.external_id = s.external_id
      WHERE s.id = ANY($1::int[]) AND s.visibility = 'members' AND s.external_id IS NOT NULL
     ON CONFLICT (name, source_id, relation) DO NOTHING
     RETURNING name, source_id`, [[...sourceIds]]);
  const out: string[] = [];
  for (const row of r.rows as Array<{ name: string; source_id: number }>) {
    await auditKnowledge(String(row.name), "link_source", null,
      { source_id: Number(row.source_id), relation: "derived_from", via: "mirror_copy" }, ctx, db);
    out.push(String(row.name));
  }
  return out;
}

/**
 * 축을 켜서 자료·지식 축이 둘 다 켜졌을 때 — 잠긴 자료에서 나온 지식 전부를 맞춘다(사양 R10).
 *  축이 꺼져 있던 동안 이은 연결은 맞추기를 건너뛰었으므로, 켜는 순간 맞추지 않으면 «연결이 있는데도 공개» 가 남는다.
 *  RECONCILE_BATCH 건씩 트랜잭션 — 한 번에 수천 건을 쥐지 않는다. 멱등이라 몇 번을 돌려도 같다. 바꾼 지식 수를 돌려준다.
 */
export async function reconcileAllDerived(ctx?: WriteCtx): Promise<number> {
  if (!(await derivedEnforced())) return 0;
  const r = await itemsPool.query(
    `SELECT DISTINCT ks.name FROM knowledge_source ks JOIN source s ON s.id = ks.source_id
      WHERE ks.relation = 'derived_from' AND s.visibility = 'members'`);
  const names = (r.rows as Array<{ name: string }>).map((x) => String(x.name)).sort(byCodeUnit);
  let changed = 0;
  for (let i = 0; i < names.length; i += RECONCILE_BATCH) {
    const chunk = names.slice(i, i + RECONCILE_BATCH);
    changed += (await withDerivedTx((c) => reconcileDerivedVisibility(c, { names: chunk }, ctx, "axis_on", true))).length;
  }
  return changed;
}

/** 거절 — 잠긴 자료를 이미 더 넓게 보이는 지식에 합치려 했다(사양 R4·R6·R8). 내용·연결·공개범위 아무것도 안 바꾼다. */
function mergeRefusal(name: string, k: KnowledgeAudience, lockedNew: readonly number[], plan: DerivedPlan,
  teams: Map<string, Set<string>>, why: "narrows" | "batch_untouched"): HttpError {
  const ids = [...lockedNew];
  const idText = ids.map((x) => `#${x}`).join(",") || "(이미 이어진 자료)";
  if (k.lists.length) {
    return new HttpError(409,
      `지식 '${name}' 은(는) 비공개 프로젝트 세션에서 만든 지식(그 프로젝트를 볼 수 있는 사람만 봄)이라 잠긴 자료 ${idText} 의 파생으로 이을 수 없습니다 — `
      + `이으면 프로젝트 공개범위와 자료 공개범위를 함께 지킬 수 없습니다. 그 자료의 내용은 이 지식에 넣지 말고, 프로젝트 밖 세션에서 `
      + `knowledge_save(derived_from: [${ids.join(", ")}]) 로 새 지식을 따로 쓰세요.`,
      { body: { code: "derived_merge_refused", reason: "project_list", knowledge: name, locked_sources: ids } });
  }
  const before = k.open ? null : expandMembers(k.subjects, teams);
  const after = expandMembers(plan.next.subjects, teams);
  const lost = before === null ? null : [...before].filter((m) => !after.has(m)).length;
  const who = lost === null ? "조직 전체가 보던 이 지식을 대부분의 사람이" : `지금 이 지식을 보는 사람 중 ${lost}명이`;
  const head = why === "batch_untouched"
    ? `이 증류 배치는 지식 '${name}' 을(를) 고치지 않았는데 잠긴 자료 ${idText}(볼 수 있는 사람만 봄)를 파생으로 이으려 했습니다 — 이으면 ${who} 못 보게 됩니다. `
    : `잠긴 자료 ${idText}(볼 수 있는 사람만 봄)를 이미 더 넓게 보이는 지식 '${name}' 에 합칠 수 없습니다 — 합치면 ${who} 못 보게 됩니다. `;
  return new HttpError(409,
    head
    + `그 자료의 내용은 새 이름으로 따로 저장하세요: knowledge_save(name: '<새 이름>', derived_from: [${ids.join(", ")}]). `
    + `이 지식은 그대로 두세요(이미 그 내용을 넣었다면 그 부분을 지우세요 — knowledge_save mode='edit').`,
    { body: { code: "derived_merge_refused", reason: why, knowledge: name, locked_sources: ids, lost: lost ?? "all" } });
}

export interface LinkDerivedResult {
  /** 이번에 새로 생긴 연결의 자료 id */
  inserted: number[];
  /** 맞춘 뒤 공개범위 */
  visibility: "open" | "members";
  /** 맞춘 뒤 대상 수(사람·팀 열쇠 수) */
  audience: number;
  /** 잠겼는데 아무도 못 본다 */
  empty: boolean;
  /** 공개범위가 이번에 바뀌었나 */
  changed: boolean;
  /** 지금 보던 사람이 줄었나(단독 연결이 닫히는 쪽으로 좁혔을 때 — 알림용) */
  narrowed: boolean;
}

export interface LinkDerivedOpts {
  /**
   * save — knowledge_save 가 내용을 쓰기 **전**: 좁아지면 거절(빈틈 ②).
   * link — 단독 연결(내용은 이미 들어갔을 수 있다): 좁힌다(닫히는 쪽). 리스트 grant 지식은 거절(사양 R4).
   *   batchSince 가 있으면(증류 배치) 그 배치가 이 지식을 쓰지 않았을 때 거절한다 — 합치기가 아니라 남의 문서 좁히기라서.
   */
  mode: "save" | "link";
  /** 되돌리기(undo)가 옛 연결을 되살릴 때 — 거절하지 않고 좁힌다(원래 있던 연결이다). */
  allowNarrow?: boolean;
  /** 증류 배치의 시작 시각(link 모드 판정) */
  batchSince?: Date | null;
  /** 축 상태(잠그기 전에 읽어 넘긴다) */
  enforced: boolean;
}

/**
 * 기존 지식에 derived_from 연결을 잇는다 — 판정 · 연결 · 맞추기를 받은 트랜잭션 안에서 한 번에(사양 R6·R8).
 *  · 자료가 없거나 지식이 없으면 404(아무것도 안 씀).
 *  · 좁아지는 경우의 처리는 LinkDerivedOpts.mode 를 본다.
 *  · 축이 하나라도 꺼져 있으면 연결만 잇는다(맞추기 없음 — 켤 때 reconcileAllDerived 가 맞춘다).
 */
export async function linkDerivedSources(
  db: Q, name: string, sourceIds: readonly number[], ctx: WriteCtx | undefined, opts: LinkDerivedOpts,
): Promise<LinkDerivedResult> {
  const { found, missing } = await lockSources(db, sourceIds);
  if (missing.length) throw new HttpError(404, `자료 #${missing[0]} 없음`);
  const ids = [...found.keys()];
  const ks = await loadKnowledge(db, [name], true);
  const k = ks.get(name);
  if (!k) throw new HttpError(404, `지식 '${name}' 없음`);

  let plan: DerivedPlan | null = null;
  let lockedAll: LockedSourceAudience[] = [];
  if (opts.enforced) {
    const existing = (await loadLockedDerived(db, [name])).get(name) ?? [];
    const known = new Set(existing.map((s) => s.id));
    const adding = ids.map((id) => found.get(id)!).filter((s) => s.locked && !known.has(s.id))
      .map((s) => ({ id: s.id, subjects: s.subjects }));
    lockedAll = [...existing, ...adding];
    const teams = await loadTeams(db, [...k.subjects, ...lockedAll.flatMap((s) => s.subjects)]);
    plan = planDerivedAudience(k, lockedAll, teams);
    if (plan.narrows && !opts.allowNarrow) {
      const addIds = adding.map((s) => s.id);
      if (opts.mode === "save" || k.lists.length) throw mergeRefusal(name, k, addIds, plan, teams, "narrows");
      if (opts.batchSince && !(await writtenSince(db, name, ctx?.actor, opts.batchSince))) {
        throw mergeRefusal(name, k, addIds, plan, teams, "batch_untouched");
      }
    }
  }

  const ins = await db.query(
    `INSERT INTO knowledge_source(name, source_id, relation, created_at)
     SELECT $1, s, 'derived_from', now() FROM unnest($2::int[]) AS s
     ON CONFLICT (name, source_id, relation) DO NOTHING RETURNING source_id`, [name, ids]);
  const inserted = (ins.rows as Array<{ source_id: number }>).map((x) => Number(x.source_id)).sort((a, b) => a - b);
  for (const sid of inserted) await auditKnowledge(name, "link_source", null, { source_id: sid, relation: "derived_from" }, ctx, db);

  //  아무도 못 보게 되는 연결(대상이 안 겹치는 잠긴 자료)도 단독 연결에서는 거절하지 않는다 — 새 저장(planNewDerivedKnowledge)과
  //   다른 까닭: 내용이 이미 들어간 뒤라 거절하면 잠긴 내용이 더 넓은 문서에 남는다. 닫힌 쪽(관리자만)으로 두고 응답 empty 로 알린다.
  if (plan?.changed) await applyPlan(db, name, k, plan, ctx, { sources: lockedAll.map((s) => s.id), reason: "linked" });
  const final = plan?.changed ? plan.next : k;
  return {
    inserted,
    visibility: final.open ? "open" : "members",
    audience: final.subjects.length,
    empty: !final.open && !final.subjects.length && !final.lists.length,
    changed: !!plan?.changed,
    narrowed: !!plan?.narrows,
  };
}

/** 이 사람이 since 뒤에 이 지식의 내용을 썼나(insert·update 감사) — 증류 배치가 이번 판에 그 지식을 고쳤는가. */
async function writtenSince(db: Q, name: string, actor: string | null | undefined, since: Date): Promise<boolean> {
  if (!actor) return false;
  const r = await db.query(
    `SELECT 1 FROM org_content_audit a
      WHERE a.entity = 'knowledge' AND a.entity_key = $1 AND a.op IN ('insert', 'update')
        AND a.actor = $2 AND a.at >= $3 LIMIT 1`, [name, actor, since]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * 잠긴 자료를 cites(참조)로 이으려 할 때 — 그 지식이 자료보다 넓게 보이면 거절한다.
 *  cites 는 공개범위를 안 바꾸므로, 거절 받은 합치기가 relation 만 바꿔 빠져나가는 길이 된다(격리 검토). 단순 참고라면
 *  자료를 볼 수 있는 사람만 보는 지식에서만 잇는다.
 */
export async function assertCitesAllowed(db: Q, name: string, sourceId: number, enforced: boolean): Promise<void> {
  if (!enforced) return;
  const { found, missing } = await lockSources(db, [sourceId]);
  if (missing.length) throw new HttpError(404, `자료 #${sourceId} 없음`);
  const s = found.get(sourceId)!;
  if (!s.locked) return;
  const k = (await loadKnowledge(db, [name], false)).get(name);
  if (!k) throw new HttpError(404, `지식 '${name}' 없음`);
  const teams = await loadTeams(db, [...k.subjects, ...s.subjects]);
  const plan = planDerivedAudience(k, [{ id: s.id, subjects: s.subjects }], teams);
  if (plan.narrows) {
    throw new HttpError(409,
      `잠긴 자료 #${sourceId}(볼 수 있는 사람만 봄)를 더 넓게 보이는 지식 '${name}' 에서 참조(cites)할 수 없습니다 — 그 지식을 보는 사람 대부분이 자료를 못 봅니다. `
      + `그 자료의 내용을 썼다면 cites 가 아니라 derived_from 이고, 그 내용은 새 지식으로 따로 써야 합니다: knowledge_save(name: '<새 이름>', derived_from: [${sourceId}]).`,
      { body: { code: "derived_merge_refused", reason: "cites_wider", knowledge: name, locked_sources: [sourceId] } });
  }
}

/**
 * 새 지식의 공개범위 — knowledge_save(신규 + derived_from) 가 INSERT **전에** 정한다(사양 R6). 받은 트랜잭션에서 자료를 잡는다.
 *  base: 비공개 프로젝트 세션이면 그 리스트(stampListId) — 잠긴 자료가 섞이면 거절(사양 R4). 그 밖엔 열림.
 *  잠긴 자료끼리 겹치는 사람이 없으면 거절(아무도 못 보는 지식을 만들지 않는다 — 자료별로 나눠 쓰게 한다).
 */
export async function planNewDerivedKnowledge(
  db: Q, sourceIds: readonly number[], stampListId: number | null, enforced: boolean,
): Promise<{ plan: DerivedPlan; sourceIds: number[]; lockedIds: number[] }> {
  const { found, missing } = await lockSources(db, sourceIds);
  if (missing.length) throw new HttpError(404, `자료 #${missing[0]} 없음`);
  const ids = [...found.keys()];
  const base: KnowledgeAudience = stampListId != null ? { open: false, subjects: [], lists: [stampListId] } : { open: true, subjects: [], lists: [] };
  if (!enforced) return { plan: planDerivedAudience(base, []), sourceIds: ids, lockedIds: [] };
  const locked = [...found.values()].filter((s) => s.locked).map((s) => ({ id: s.id, subjects: s.subjects }));
  if (stampListId != null && locked.length) {
    throw new HttpError(409,
      `이 세션은 비공개 프로젝트에 붙어 있어 잠긴 자료 ${locked.map((s) => `#${s.id}`).join(",")} 로 지식을 만들 수 없습니다 — `
      + `프로젝트 공개범위와 자료 공개범위를 함께 지킬 수 없습니다. 그 자료로 만드는 지식은 프로젝트 밖 세션에서 쓰세요.`,
      { body: { code: "derived_merge_refused", reason: "project_list", locked_sources: locked.map((s) => s.id) } });
  }
  const plan = planDerivedAudience(base, locked, new Map());
  if (!plan.next.open && plan.empty) {
    throw new HttpError(409,
      `잠긴 자료 ${locked.map((s) => `#${s.id}`).join(",")} 은(는) 볼 수 있는 사람이 서로 겹치지 않아, 한 지식으로 합치면 아무도 못 봅니다 — `
      + `자료별로(볼 수 있는 사람이 같은 자료끼리) 나눠 저장하세요.`,
      { body: { code: "derived_empty_audience", locked_sources: locked.map((s) => s.id) } });
  }
  return { plan, sourceIds: ids, lockedIds: locked.map((s) => s.id) };
}

/** 새 지식에 정한 대상(planNewDerivedKnowledge 의 결과)과 연결을 쓴다 — INSERT 와 같은 트랜잭션에서. */
export async function writeNewDerivedKnowledge(
  db: Q, name: string, planned: { plan: DerivedPlan; sourceIds: number[]; lockedIds: number[] }, ctx: WriteCtx | undefined,
): Promise<void> {
  const { next } = planned.plan;
  if (next.subjects.length) {
    const kinds: string[] = [], ids: string[] = [];
    for (const s of next.subjects) { const p = splitSubject(s); kinds.push(p.kind); ids.push(p.id); }
    await db.query(
      `INSERT INTO knowledge_member(name, subject_kind, member_id)
       SELECT $1, k, m FROM unnest($2::text[], $3::text[]) AS t(k, m) ON CONFLICT DO NOTHING`, [name, kinds, ids]);
  }
  for (const listId of next.lists) {
    await db.query(`INSERT INTO knowledge_list_grant(name, list_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [name, listId]);
  }
  const ins = await db.query(
    `INSERT INTO knowledge_source(name, source_id, relation, created_at)
     SELECT $1, s, 'derived_from', now() FROM unnest($2::int[]) AS s
     ON CONFLICT (name, source_id, relation) DO NOTHING RETURNING source_id`, [name, planned.sourceIds]);
  for (const row of ins.rows as Array<{ source_id: number }>) {
    await auditKnowledge(name, "link_source", null, { source_id: Number(row.source_id), relation: "derived_from" }, ctx, db);
  }
  if (!next.open) {
    await auditKnowledge(name, "set_visibility",
      { name, visibility: "open", audience: 0 },
      {
        name, visibility: "members", audience: next.subjects.length,
        ...(planned.lockedIds.length ? { via_source: planned.lockedIds[0], via_sources: planned.lockedIds, reason: "created_derived" } : {}),
        ...(next.lists.length ? { via_project_list: next.lists[0] } : {}),
      }, ctx, db);
  }
}
