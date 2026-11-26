// 옛 방식 구성원을 역할로 옮기는 계획 (#5799) — 순수.
//
//  옛 방식 구성원은 scope 이름으로 판정받는다. 역할로 옮기면 새 권한(영역 × 보기/고치기)으로 판정받는다. 이 파일은 «누가 어느 역할로 가고
//   무엇을 얻고 잃는가» 를 계산만 한다 — 저장은 capabilities/delivery/members.ts 의 org_member_role_apply 가 한다.
//
//  규칙:
//   · 권한이 하나도 없는 구성원(번역이 빈 것)은 옮기지 않는다 — 가장 낮은 역할인 게스트도 맥락 보기를 주므로, 옮기면 넓어진다.
//   · admin + runtime → 소유자 · admin → 관리자.
//   · 그 밖은 구성원 역할 — 단, 구성원 역할이 지금보다 **실제로 넓히면**(아래 HARMLESS_GAINS 밖의 것을 얻으면) 구성원으로 옮기지 않고
//     게스트 위에 지금 권한을 그대로 얹는다(«직접 고른 권한»). 이관이 조용히 권한을 넓히지 않게.
//   · 역할이 지금보다 낮추는 것(잃는 것)은 기본으로 그대로 낮춘다 — 미리보기가 잃는 것을 보여 주고, keep 을 주면 개별 권한으로 남긴다.
//   · DB 는 역할만으로 열리지 않는다(소스마다 지정). 옛 `db` 는 전 소스였으므로 «모든 소스»(지금 있는 것 + 앞으로 등록될 것)로 지정하고,
//     `db:<소스>` 는 등록된 그 소스에 지정한다. 지금 DB 를 보던 사람이 보던 범위 그대로 본다(결정 2026-11-26).
import {
  PERMISSIONS, ROLE_GRANTS, legacyScopesToGrants, mergeGrants,
  type Grants, type Level, type Permission, type Role,
} from "./permissions.js";

/** «모든 소스» 지정 — org/store/db-source-grants.ts ALL_DB_SOURCES 와 같은 값(이 파일은 순수라 저장 계층을 import 하지 않는다 — 시험이 둘을 맞춘다). */
export const ALL_SOURCES = "*";

/** 옮기며 얻어도 실제로 넓어지지 않는 것 — 하네스 설정 보기(구성원 역할의 바탕 · 읽기뿐)와 DB 조회 자격(소스 지정 없이는 아무것도 못 본다). */
const HARMLESS_GAINS: ReadonlyArray<readonly [Permission, Level]> = [["harness", "read"], ["db", "read"]];

export interface LevelChange { perm: Permission; from: Level | null; to: Level | null }

export interface MigrationPlan {
  id: string;
  /** 옮길 역할. null 이면 옮기지 않는다(skip 에 까닭). */
  role: Role | null;
  /** 역할 위에 얹을 개별 권한. */
  grants: Grants;
  /** 게스트 위에 지금 권한을 그대로 얹은 것인가(화면의 «직접 고른 권한»). */
  custom: boolean;
  gains: LevelChange[];
  losses: LevelChange[];
  /** 조회 대상으로 지정할 DB 소스(지금 조회하던 것이 끊기지 않게). */
  dbSources: string[];
  skip: "already-role" | "no-permissions" | null;
}

const rank = (lv: Level | null | undefined): number => (lv === "write" ? 2 : lv === "read" ? 1 : 0);

/** a 에서 b 로 갈 때 권한마다 달라지는 것 — 올라간 것(gains) · 내려간 것(losses). */
export function diffGrants(from: Grants, to: Grants): { gains: LevelChange[]; losses: LevelChange[] } {
  const gains: LevelChange[] = [];
  const losses: LevelChange[] = [];
  for (const perm of PERMISSIONS) {
    const a = from[perm] ?? null;
    const b = to[perm] ?? null;
    if (rank(b) > rank(a)) gains.push({ perm, from: a, to: b });
    else if (rank(b) < rank(a)) losses.push({ perm, from: a, to: b });
  }
  return { gains, losses };
}

/** 역할이 주는 것보다 높은 수준만 남긴다(개별 권한은 얹는 것이다). */
function above(role: Role, want: Grants): Grants {
  const out: Partial<Record<Permission, Level>> = {};
  for (const perm of PERMISSIONS) {
    const lv = want[perm];
    if (lv && rank(lv) > rank(ROLE_GRANTS[role][perm])) out[perm] = lv;
  }
  return out;
}

const harmless = (c: LevelChange): boolean => HARMLESS_GAINS.some(([p, lv]) => p === c.perm && rank(c.to) <= rank(lv));

/**
 * 한 구성원의 이관 계획.
 *  @param sources 지금 등록된 DB 소스 이름(내장 self 제외)
 *  @param keep 역할이 낮추는 것을 개별 권한으로 남긴다
 */
export function planMemberMigration(
  m: { id: string; role?: Role | null; scopes?: readonly string[] | null },
  opts: { sources?: readonly string[]; keep?: boolean } = {},
): MigrationPlan {
  const none = { grants: {}, custom: false, gains: [], losses: [], dbSources: [] };
  if (m.role) return { id: m.id, role: null, ...none, skip: "already-role" };
  const scopes = (m.scopes ?? []).filter((s): s is string => typeof s === "string");
  const now = legacyScopesToGrants(scopes);
  if (!Object.keys(now).length) return { id: m.id, role: null, ...none, skip: "no-permissions" };

  let role: Role = scopes.includes("admin") ? (scopes.includes("runtime") ? "owner" : "admin") : "member";
  let custom = false;
  if (role === "member" && !diffGrants(now, ROLE_GRANTS.member).gains.every(harmless)) { role = "guest"; custom = true; }

  //  직접 고른 권한은 지금 권한을 그대로 얹는다(잃는 것이 없다). 역할로 가는 구성원은 keep 일 때만 잃는 것을 얹는다.
  const grants = custom || opts.keep ? above(role, now) : {};
  const after = mergeGrants(ROLE_GRANTS[role], grants);
  const { gains, losses } = diffGrants(now, after);

  //  옛 `db` 는 전 소스였다(나중에 등록되는 소스까지) — 그대로 잇도록 «모든 소스» 로 지정한다. `db:<소스>` 는 등록된 그 소스만.
  const registered = new Set(opts.sources ?? []);
  const named = [...new Set(scopes.filter((s) => s.startsWith("db:") && s.length > 3).map((s) => s.slice(3)))].filter((s) => registered.has(s));
  const dbSources = !after.db ? [] : scopes.includes("db") ? [ALL_SOURCES] : named;
  return { id: m.id, role, grants, custom, gains, losses, dbSources, skip: null };
}

/** 여러 구성원의 계획 — 옮길 사람만(이미 역할인 사람은 뺀다). 권한이 없는 구성원은 까닭과 함께 남긴다. */
export function planMigration(
  members: ReadonlyArray<{ id: string; role?: Role | null; scopes?: readonly string[] | null }>,
  opts: { sources?: readonly string[]; keep?: boolean } = {},
): MigrationPlan[] {
  return members.map((m) => planMemberMigration(m, opts)).filter((p) => p.skip !== "already-role");
}

/**
 * 적용할 계획 고르기 — ids(목록) 또는 all(전원) 중 **하나만**. 둘 다 없거나 둘 다 주면 던진다(실수로 전원을 옮기지 않게).
 *  ids 에 옛 방식 구성원이 아닌 것(없는 id · 이미 역할)이 하나라도 있으면 던진다 — 일부만 옮기고 끝나지 않게.
 */
export function selectPlans(plans: readonly MigrationPlan[], ids: readonly string[], all: boolean): MigrationPlan[] {
  const want = [...new Set(ids.map((x) => String(x ?? "").trim()).filter(Boolean))];
  if (all === (want.length > 0)) throw new Error("ids(옮길 구성원 목록) 또는 all:true 중 하나만 주세요");
  if (all) return [...plans];
  const byId = new Map(plans.map((p) => [p.id, p]));
  const unknown = want.filter((id) => !byId.has(id));
  if (unknown.length) throw new Error(`옛 방식 구성원이 아닙니다(없거나 이미 역할): ${unknown.join(", ")}`);
  return want.map((id) => byId.get(id) as MigrationPlan);
}
