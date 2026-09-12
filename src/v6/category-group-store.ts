// 카테고리 묶음(category_group) 데이터 접근(#1631) — **화면에서만 보이는 상위 층**.
//  지식은 여전히 카테고리 하나에만 속한다. 묶음은 그 카테고리들을 화면에서 갈라 보여 주는 이름표일 뿐이고,
//  분류기 후보에도, 증류기 목적지(target_category)에도, 검색·소환에도 **들어가지 않는다**(category-groups.ts 머리말).
//  그래서 이 파일에는 «분류» 가 없다 — 만들고, 이름 붙이고, 카테고리를 옮기고, 지우는 것뿐이다.
//
//  ── 이 파일이 지키는 불변식 하나: **고아를 만들지 않는다** ──────────────────────────────
//  category.group_key 는 FK 가 없는 소프트 참조다(묶음이 없어져도 카테고리는 안 죽어야 하므로).
//  FK 가 없으니 «가리키는 묶음이 없는 group_key» 는 DB 가 아니라 **쓰기 경로가** 막아야 한다:
//   · 없는 묶음 key 로 카테고리를 만들거나 옮기려 하면 400 (planGroupAssign)
//   · 카테고리가 든 묶음을 지우려 하면 옮길 곳을 먼저 묻는다 (planGroupRemoval)
//   · 그 «묻고 · 옮기고 · 지우고» 는 **한 트랜잭션**이고 대상 묶음 행을 FOR UPDATE 로 잡는다
//     (removeCategoryGroup — 반쪽 반영 없음 · 동시 삭제 직렬화. 배정 쪽에 남는 창은 거기 머리말에 적어 뒀다).
//  두 판정은 **순수 함수**로 빼 뒀다 — DB 없이 표로 검사할 수 있어야 이 불변식이 회귀에서 산다
//  (category-group-store.test.ts 가 엣지 표 그대로 건다).
//
//  감사는 org_content_audit — category-store.ts 와 같은 append-only 패턴(entity='category_group',
//   카테고리의 소속이 바뀌는 쓰기는 entity='category' 로 남긴다 — 바뀐 것이 카테고리 행이기 때문).
import crypto from "node:crypto";
import { itemsPool, q, one, withTx } from "../db/client.js";
import { HttpError } from "../http-error.js";
import { auditOrgContent, type WriteCtx } from "./content-audit.js";
import { groupSetFor, type GroupDef } from "./category-groups.js";

const GROUP_COLS = `id, key, name, hint, sort, state, origin`;

export interface CategoryGroupRow {
  id: number; key: string; name: string; hint: string | null;
  sort: number; state: string; origin?: string | null;
  /** 이 묶음에 든 카테고리 수 — 목록만 채운다(화면이 «한눈에» 쓰는 값). */
  category_count?: number;
}

// append-only 감사(org_content_audit) — 공유 헬퍼 위임(category-store.ts 와 같은 idiom).
const auditGroup = (key: string, op: string, before: unknown, after: unknown, ctx?: WriteCtx): Promise<void> =>
  auditOrgContent("category_group", key, op, before, after, ctx);

// ── 순수 판정 ────────────────────────────────────────────────────────────────
//  DB 를 안 보는 부분만 여기 모은다. 실 DB 가 필요한 계층은 *.itest.mjs 가 따로 잡는다.

/**
 * 이름에서 묶음 key 를 뽑는다(순수) — 사람이 이름을 바꿔도 카테고리가 계속 가리킬 값.
 *  한글처럼 ascii 로 떨어지지 않는 이름은 해시로 내린다(welcome 의 drawerKey 와 같은 판단 —
 *  key 는 기계가 쓰는 값이고 사람이 읽는 것은 name 이다).
 */
export function groupKeyFrom(name: string): string {
  const ascii = String(name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (ascii) return ascii;
  const seed = String(name ?? "").trim();
  if (!seed) return "";
  return `g-${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 10)}`;
}

/** 카테고리의 소속을 어떻게 바꿀 것인가(순수). change=false 는 «안 건드림»(부분 수정)이다. */
export interface GroupAssignPlan {
  /** group_key 를 실제로 쓸 것인가. false = 입력에 group 이 없었다(부분 수정에서 보존). */
  change: boolean;
  /** 쓸 값. null = 해제(빈 문자열·null 을 준 경우). */
  groupKey: string | null;
  /** 거절 사유(있으면 400). */
  error: string | null;
}

/**
 * 카테고리를 어느 묶음에 넣을지 판정(순수) — **없는 묶음이면 거절**한다.
 *  거절 메시지에 지금 있는 묶음 key 를 전부 적는 것이 핵심이다: 이걸 읽는 것은 대개 리브(에이전트)라
 *  «없다» 만 들으면 다시 찍어 보는 수밖에 없다. 목록을 주면 그 자리에서 고쳐 다시 부른다.
 */
export function planGroupAssign(
  input: { group?: string | null; groupKeys: string[] },
): GroupAssignPlan {
  if (input.group === undefined) return { change: false, groupKey: null, error: null };
  const want = input.group === null ? "" : String(input.group).trim();
  if (!want) return { change: true, groupKey: null, error: null };   // 빈 문자열·null = 해제
  if (input.groupKeys.includes(want)) return { change: true, groupKey: want, error: null };
  return {
    change: true, groupKey: null,
    error: `'${want}' 라는 묶음이 없습니다 — 지금 있는 묶음: ${listKeys(input.groupKeys)}.`
      + " 묶음은 category_group_upsert 로 먼저 만드세요(묶음은 화면에서만 보이는 층이라 분류에는 쓰이지 않습니다).",
  };
}

/** 묶음을 지워도 되는가(순수) — 카테고리가 남아 있으면 **옮길 곳을 먼저 묻는다**. */
export interface GroupRemovalPlan {
  /** 지워도 되는가. */
  ok: boolean;
  /** 지우기 전에 옮길 묶음. null = 옮길 것이 없다(빈 묶음). */
  reassignTo: string | null;
  error: string | null;
}

/**
 * @param inUse       그 묶음에 남아 있는 카테고리 수
 * @param reassignTo  옮길 묶음 key(없으면 null)
 * @param groupKeys   **지울 묶음을 뺀** 지금 있는 묶음 key 들(자기 자신으로는 못 옮긴다)
 */
export function planGroupRemoval(
  input: { inUse: number; reassignTo: string | null; groupKeys: string[] },
): GroupRemovalPlan {
  const n = Math.max(0, Number(input.inUse) || 0);
  const to = input.reassignTo == null ? "" : String(input.reassignTo).trim();
  if (n === 0) return { ok: true, reassignTo: null, error: null };   // 빈 묶음 — 옮길 것이 없다
  const head = `이 묶음에 카테고리 ${n}개가 있습니다. 옮길 묶음을 정해 주세요`;
  if (!to) {
    return { ok: false, reassignTo: null, error: `${head}(reassign_to) — 지금 있는 묶음: ${listKeys(input.groupKeys)}.` };
  }
  if (!input.groupKeys.includes(to)) {
    return { ok: false, reassignTo: null, error: `${head} — '${to}' 라는 묶음이 없습니다(지금 있는 묶음: ${listKeys(input.groupKeys)}).` };
  }
  return { ok: true, reassignTo: to, error: null };
}

/** 시드할 것이 있는가(순수) — **멱등**: 묶음이 하나라도 있으면 아무것도 안 한다. */
export function planGroupSeed(
  input: { existing: string[]; stage?: string | null; job?: string | null },
): { groups: GroupDef[]; skipped: boolean } {
  if (input.existing.length) return { groups: [], skipped: true };
  return { groups: groupSetFor(input.stage, input.job), skipped: false };
}

const listKeys = (keys: string[]): string => (keys.length ? keys.join(", ") : "(하나도 없음)");

// ── DB ──────────────────────────────────────────────────────────────────────

/** active 묶음 전체(sort→key). 각 행에 든 카테고리 수(category_count)를 함께 센다. */
export async function listCategoryGroups(): Promise<CategoryGroupRow[]> {
  return q(itemsPool,
    `SELECT ${GROUP_COLS.split(",").map((c) => "g." + c.trim()).join(", ")},
            (SELECT COUNT(*)::int FROM category c WHERE c.group_key=g.key AND c.state<>'merged') AS category_count
       FROM category_group g
      WHERE g.state='active'
      ORDER BY g.sort, g.key`);
}

export async function getCategoryGroup(key: string): Promise<CategoryGroupRow | undefined> {
  return one(itemsPool,
    `SELECT ${GROUP_COLS} FROM category_group WHERE key=$1 AND state<>'archived'`, [key]);
}

/** 지금 있는 묶음 key 들 — 판정(순수 함수)에 먹일 입력. */
export async function activeGroupKeys(): Promise<string[]> {
  const rows = await q(itemsPool,
    `SELECT key FROM category_group WHERE state='active' ORDER BY sort, key`);
  return rows.map((r: { key: string }) => r.key);
}

/**
 * 없는 묶음 key 면 400 — 카테고리 쓰기 경로(createCategory/updateCategory)가 부르는 단일 판정.
 *  ⚠ **판정은 스토어 한 곳에서만** 한다(이 레포 관례): REST 경로엔 zod 검증이 없어서 capability 에서
 *   거르면 MCP 와 웹의 동작이 갈린다(dev 실측 2026-09-03 의 조용한 no-op 이 그 자리였다).
 */
export async function resolveGroupKey(group?: string | null): Promise<GroupAssignPlan> {
  if (group === undefined) return { change: false, groupKey: null, error: null };   // DB 왕복도 아끼자
  const plan = planGroupAssign({ group, groupKeys: await activeGroupKeys() });
  if (plan.error) throw new HttpError(400, plan.error);
  return plan;
}

/**
 * key 로 insert/update(부분 수정 — 안 준 필드는 기존 값 보존).
 *  ★ `created` 를 함께 돌려준다 — 이름만 보내면 key 는 슬러그로 **파생**되므로, 다른 이름이 같은 슬러그로 떨어지면
 *   «만들기» 가 조용히 «고치기» 가 된다(화면은 만들었다는데 개수가 안 는다). 저장 동작은 그대로 upsert 로 두고
 *   (이름·순서 바꾸기가 같은 창구를 쓴다) **무슨 일이 일어났는지를 호출부가 알 수 있게** 한다.
 */
export async function upsertCategoryGroup(
  input: { key: string; name?: string; hint?: string | null; sort?: number; origin?: string },
  ctx?: WriteCtx,
): Promise<{ group: CategoryGroupRow; created: boolean }> {
  const key = String(input.key ?? "").trim();
  if (!key) throw new HttpError(400, "묶음 key 가 필요합니다");
  const before = await getCategoryGroup(key);
  // COALESCE($n, col): undefined→null→기존값 보존(category-store.updateCategory 와 같은 부분 수정 idiom).
  const row: CategoryGroupRow = before
    ? await one(itemsPool,
      `UPDATE category_group SET name=COALESCE($2,name), hint=COALESCE($3,hint), sort=COALESCE($4,sort), updated_at=now()
         WHERE id=$1 RETURNING ${GROUP_COLS}`,
      [before.id, input.name ?? null, input.hint ?? null, input.sort ?? null])
    : await one(itemsPool,
      `INSERT INTO category_group(key, name, hint, sort, state, origin, created_at, updated_at)
         VALUES($1,$2,$3,COALESCE($4,0),'active',$5,now(),now()) RETURNING ${GROUP_COLS}`,
      [key, input.name ?? key, input.hint ?? null, input.sort ?? null,
       input.origin ?? (ctx?.source === "mcp" ? "agent" : "human")]);
  await auditGroup(key, before ? "update" : "insert", before ?? null, row, ctx);
  return { group: row, created: !before };
}

/** 이 카테고리를 어느 묶음에 둘지 바꾼다. groupKey=null 이면 해제(어느 묶음에도 안 든다). */
export async function setCategoryGroup(
  categoryKey: string, groupKey: string | null, ctx?: WriteCtx,
): Promise<{ key: string; group_key: string | null }> {
  const cat: { id: number; key: string; group_key: string | null } | undefined = await one(itemsPool,
    `SELECT id, key, group_key FROM category WHERE key=$1 AND state<>'merged'`, [categoryKey]);
  if (!cat) throw new HttpError(404, `카테고리 '${categoryKey}' 없음`);
  const plan = await resolveGroupKey(groupKey);
  const row = await one(itemsPool,
    `UPDATE category SET group_key=$2, updated_at=now() WHERE id=$1 RETURNING key, group_key`,
    [cat.id, plan.groupKey]);
  //  바뀐 것은 카테고리 행이다 — 감사도 그 엔티티로 남긴다(묶음 표는 한 줄도 안 바뀌었다).
  await auditOrgContent("category", cat.key, "set_group",
    { group_key: cat.group_key }, { group_key: plan.groupKey }, ctx);
  return row;
}

/**
 * 묶음을 지운다 — **반쪽 반영을 안 만든다**.
 *  카테고리가 남아 있으면 reassignTo 로 전부 옮긴 뒤에 지운다. 옮길 곳이 없으면 아무것도 하지 않고 400.
 *
 *  ── 왜 한 트랜잭션인가 ──────────────────────────────────────────────────────
 *  «비었나 확인 → 재배정 → 삭제» 가 따로 도는 세 문장이면, 그 사이에 끼어든 쓰기가 고아(가리키는 묶음이
 *   없는 group_key)를 남긴다. 그래서 셋을 withTx 로 묶고(중도 실패 = 전체 롤백 — 옮기다 만 상태가 없다),
 *   대상 묶음 행을 `FOR UPDATE` 로 잡아 **동시 삭제끼리** 직렬화한다(둘이 동시에 «비었다» 를 보고 둘 다
 *   지우거나, 한쪽이 옮겨 넣는 사이 다른 쪽이 지우는 일이 없다).
 *  ⚠ 남는 창(정직히): 배정 쪽(category_update.group)은 트랜잭션이 아니라 «있는 묶음인가» 를 따로 읽고
 *   카테고리를 고친다. 잠금 없는 SELECT 는 이 FOR UPDATE 에 안 걸리므로, 그 읽기와 쓰기 **사이에** 삭제가
 *   끼면 여전히 고아가 한 건 날 수 있다. 그걸 0 으로 만들려면 배정 쪽도 같은 트랜잭션에서 묶음 행을
 *   FOR SHARE 로 잡아야 하는데, 그건 카테고리 쓰기 경로 전체(정의·상태·임베딩 재계산)를 트랜잭션으로
 *   넓히는 일이라 여기서 하지 않았다. 그 한 건은 **읽는 쪽이 안전하게 다룬다**: 화면은 모르는 group_key 를
 *   «묶음 없음» 으로 그리고, 그 카테고리를 다시 저장할 때 planGroupAssign 이 400 으로 잡아 준다.
 */
export async function removeCategoryGroup(
  key: string, opts: { reassignTo?: string | null }, ctx?: WriteCtx,
): Promise<{ deleted: boolean; key: string; moved: number; reassign_to: string | null }> {
  const done = await withTx(async (client) => {
    //  ① 대상 행을 먼저 잠근다 — 뒤따르는 count·UPDATE·DELETE 가 같은 잠금 아래 돈다.
    const before: CategoryGroupRow | undefined = await one(client,
      `SELECT ${GROUP_COLS} FROM category_group WHERE key=$1 AND state<>'archived' FOR UPDATE`, [key]);
    if (!before) throw new HttpError(404, `묶음 '${key}' 없음`);
    const inUse: { n: number } | undefined = await one(client,
      `SELECT count(*)::int AS n FROM category WHERE group_key=$1 AND state<>'merged'`, [key]);
    //  자기 자신으로는 못 옮긴다 — 후보에서 지울 묶음을 뺀다(그래야 «없는 묶음» 으로 거절된다).
    const others: string[] = (await q(client,
      `SELECT key FROM category_group WHERE state='active' AND key<>$1 ORDER BY sort, key`, [key]))
      .map((r: { key: string }) => r.key);
    const plan = planGroupRemoval({ inUse: inUse?.n ?? 0, reassignTo: opts.reassignTo ?? null, groupKeys: others });
    //  throw 는 withTx 가 ROLLBACK 으로 받는다 — 거절이면 한 행도 안 바뀐 채로 끝난다.
    if (!plan.ok) throw new HttpError(400, plan.error ?? "묶음을 지울 수 없습니다");

    let moved = 0;
    if (plan.reassignTo) {
      const r = await client.query(
        `UPDATE category SET group_key=$2, updated_at=now() WHERE group_key=$1 AND state<>'merged'`, [key, plan.reassignTo]);
      moved = r.rowCount ?? 0;
    }
    await client.query(`DELETE FROM category_group WHERE id=$1`, [before.id]);
    return { before, moved, reassignTo: plan.reassignTo };
  });

  //  ② 감사는 **커밋 뒤에** 남긴다 — auditOrgContent 는 공유 풀(itemsPool)을 쓰므로 위 트랜잭션 밖에서 돈다.
  //   안에서 부르면 롤백된 일까지 감사에 남는다(append-only 라 되돌릴 수도 없다).
  if (done.moved && done.reassignTo) {
    await auditGroup(key, "reassign",
      { group_key: key, categories: done.moved }, { group_key: done.reassignTo, categories: done.moved }, ctx);
  }
  await auditGroup(key, "delete", done.before, null, ctx);
  return { deleted: true, key, moved: done.moved, reassign_to: done.reassignTo };
}

/**
 * 처음 설정용 시드 — **멱등**. active 묶음이 하나라도 있으면 아무것도 안 한다.
 *  없으면 groupSetFor(stage, job) 의 집합을 sort 0..n 으로 넣는다(origin='welcome').
 *  ⚠ 룰 테이블은 어느 경로로 와도 다섯 원칙을 다 덮는다 — 「기타」 묶음이 없는 이유다(category-groups.ts).
 */
export async function seedCategoryGroups(
  input: { stage?: string | null; job?: string | null; actor?: string | null },
): Promise<{ created: string[]; skipped: boolean }> {
  const plan = planGroupSeed({ existing: await activeGroupKeys(), stage: input.stage, job: input.job });
  if (plan.skipped) return { created: [], skipped: true };
  const ctx: WriteCtx = { actor: input.actor ?? null, source: "welcome" };
  const created: string[] = [];
  for (let i = 0; i < plan.groups.length; i++) {
    const g = plan.groups[i];
    await upsertCategoryGroup({ key: g.key, name: g.name, hint: g.hint, sort: i, origin: "welcome" }, ctx);
    created.push(g.key);
  }
  return { created, skipped: false };
}
