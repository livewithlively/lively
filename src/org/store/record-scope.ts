// 기록 범위(#5016 → 조직 기본값) — 규칙만 모은 순수 모듈. DB 는 members.ts(구성원 컴퓨터별 값)·runtime-config.ts(조직 값)가 읽고 쓴다.
//
// 두 층이다 — 스킬 배포(조직이 깔고 구성원이 하나씩 끈다)와 같은 모양:
//   조직(관리자) — 방식 하나 + 목록 두 개. org_runtime_config.record_scope_policy{scope, exclude_roots} + 종전 work_roots 칸.
//     · work_folders(기본) = 기본 꺼짐 · 허용 목록(work_roots)에 든 폴더만 켠다.
//     · anywhere         = 기본 켜짐 · 제외 목록(exclude_roots)에 든 폴더만 끈다.
//   구성원 컴퓨터(오버라이드) — **목록만** 바꾼다. 방식은 못 바꾼다(관리자 결정, 2026-11-11).
//     · 자기 줄을 더하고 뺀다(work_roots · exclude_roots).
//     · 조직 줄을 이 컴퓨터에서만 끄고 다시 켠다(off_work_roots · off_exclude_roots).
//   유효 값 = 조직 줄(이 컴퓨터가 끈 것 빼고) ∪ 이 컴퓨터 줄. 방식에 따라 둘 중 한 목록만 판정에 쓴다 — 다른 목록은 지우지 않고 둔다
//    (관리자가 방식을 바꿔도 허용 목록이 제외 목록으로 뜻이 뒤집히지 않게 목록을 둘로 나눴다).
//
// 판정은 구성원 컴퓨터의 kit/hooks/record-scope.mjs 가 한다 — 서버는 유효 값을 계산해 내려줄 뿐이다(localScopeView).
// 경로는 그 컴퓨터만 펼 수 있다(`~`·대소문자) — 서버는 끝 구분자만 떼고 견준다(rootKeyOf).

export type RecordScope = "work_folders" | "anywhere";
export const DEFAULT_RECORD_SCOPE: RecordScope = "work_folders";
export const isRecordScope = (v: unknown): v is RecordScope => v === "work_folders" || v === "anywhere";

// 한 목록의 상한 — kit/hooks/record-scope.mjs 의 MAX_ROOTS · MAX_ROOT_LEN 과 같은 값이어야 한다(사본이 같은 규칙으로 자른다).
export const MAX_WORK_ROOTS = 200;
export const MAX_WORK_ROOT_LEN = 1000;

/** 조직 기록 범위 — 관리자가 정한다. */
export interface OrgRecordScope { scope: RecordScope; work_roots: string[]; exclude_roots: string[]; updated_at: string }
export const defaultOrgRecordScope = (): OrgRecordScope => ({ scope: DEFAULT_RECORD_SCOPE, work_roots: [], exclude_roots: [], updated_at: "" });

/** 구성원 컴퓨터 하나의 오버라이드(org_member.local_scope_pref[machine_id]).
 *  scope 는 옛 판(구성원이 방식을 고르던 때)이 쓰던 값이다 — 판정에 쓰지 않지만 지우지 않는다: 게이트웨이를 옛 판으로 되돌리면
 *  옛 판은 scope 가 없는 값을 통째로 버린다(이 컴퓨터가 더한 줄까지 사라진다). */
export interface LocalScopePreference {
  scope: RecordScope;
  work_roots: string[];
  exclude_roots: string[];
  off_work_roots: string[];
  off_exclude_roots: string[];
  updated_at: string;
}
export type LocalScopePreferences = Record<string, LocalScopePreference>;
export const defaultScopePref = (): LocalScopePreference =>
  ({ scope: DEFAULT_RECORD_SCOPE, work_roots: [], exclude_roots: [], off_work_roots: [], off_exclude_roots: [], updated_at: "" });

/** 한 번의 변경. 목록마다 «통째 교체(이 컴퓨터 줄만) → 더하기 → 빼기» 순서.
 *  더하기·빼기는 조직 줄에도 먹는다 — 조직 줄을 빼면 이 컴퓨터에서 끄고, 끈 조직 줄을 더하면 다시 켠다.
 *  scope 는 **받고 버린다** — 옛 키트의 못 올린 변경(pending)에 남아 있을 수 있고, 거절하면 같이 실린 폴더 변경까지 영영 못 올라간다. */
export interface LocalScopeChange {
  scope?: RecordScope;
  work_roots?: string[]; add?: string[]; remove?: string[];
  exclude_roots?: string[]; exclude_add?: string[]; exclude_remove?: string[];
}

// 끝 구분자만 떼고 비교한다 — 경로 해석(~ 펴기·대소문자)은 그 컴퓨터만 안다(서버는 사람마다 다른 홈을 모른다).
export const rootKeyOf = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, "") || p : p);
export function cleanRootList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const v of list) {
    const s = String(v ?? "").trim();
    if (!s || s.length > MAX_WORK_ROOT_LEN) continue;
    if (!out.some((x) => rootKeyOf(x) === rootKeyOf(s))) out.push(s);
  }
  return out.slice(0, MAX_WORK_ROOTS);
}

// 등록할 수 있는 꼴 — 절대경로(POSIX `/` · 윈도우 `C:\` · UNC `\\`) 또는 `~` 로 시작(그 컴퓨터 홈 기준, 펴는 건 그 컴퓨터가 한다).
//  상대경로는 판정하는 쪽(훅·MCP 프록시)의 cwd 에 묶여 뜻이 흔들린다 — kit/hooks/record-scope.mjs isRootForm 과 같은 규칙.
export const isWorkRootForm = (s: string) => s === "~" || s.startsWith("~/") || s.startsWith("~\\") || s.startsWith("/")
  || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\");

/** 등록할 목록의 꼴 검사 — 상대경로가 하나라도 있으면 던진다. */
export function assertRootForms(list: string[], what = "작업 폴더") {
  for (const s of cleanRootList(list)) {
    if (!isWorkRootForm(s)) throw new Error(`절대경로나 ~ 로 시작하는 경로만 ${what}로 등록할 수 있습니다: ${s}`);
  }
}

export function parseScopePref(raw: unknown): LocalScopePreference | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  // 옛 판이 쓴 값엔 scope 가 늘 있고, 이 판이 쓴 값에도 남긴다(위 머리말). 없거나 잡값이면 기본값으로 둔다 — 목록은 버리지 않는다.
  return {
    scope: isRecordScope(row.scope) ? row.scope : DEFAULT_RECORD_SCOPE,
    work_roots: cleanRootList(row.work_roots),
    exclude_roots: cleanRootList(row.exclude_roots),
    off_work_roots: cleanRootList(row.off_work_roots),
    off_exclude_roots: cleanRootList(row.off_exclude_roots),
    updated_at: typeof row.updated_at === "string" ? row.updated_at : "",
  };
}

/** 조직 칸 두 개(record_scope_policy JSONB · work_roots JSONB)를 한 값으로. 잡값·부재는 기본값(작업 폴더에서만 · 빈 목록). */
export function parseOrgRecordScope(policy: unknown, workRoots: unknown, updatedAt: unknown): OrgRecordScope {
  const p = policy && typeof policy === "object" && !Array.isArray(policy) ? policy as Record<string, unknown> : {};
  return {
    scope: isRecordScope(p.scope) ? p.scope : DEFAULT_RECORD_SCOPE,
    work_roots: cleanRootList(workRoots),
    exclude_roots: cleanRootList(p.exclude_roots),
    updated_at: isoOf(updatedAt),
  };
}
const isoOf = (v: unknown): string => {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : "";
  if (typeof v === "string" && Number.isFinite(Date.parse(v))) return new Date(v).toISOString();
  return "";
};

/** 한 목록에 변경을 얹는다 — 이 컴퓨터 줄(own)과 끈 조직 줄(off)을 함께 돌려준다. */
function applyList(own: string[], off: string[], org: string[], op: { replace?: string[]; add?: string[]; remove?: string[] }, what: string) {
  assertRootForms([...(op.replace ?? []), ...(op.add ?? [])], what);
  const orgKey = (p: string) => org.find((x) => rootKeyOf(x) === rootKeyOf(p));
  let mine = op.replace !== undefined ? cleanRootList(op.replace) : [...own];
  let offs = [...off];
  for (const a of cleanRootList(op.add ?? [])) {
    if (orgKey(a)) { offs = offs.filter((x) => rootKeyOf(x) !== rootKeyOf(a)); continue; }   // 끈 조직 줄을 다시 켠다(켜져 있으면 그대로)
    if (!mine.some((x) => rootKeyOf(x) === rootKeyOf(a))) mine.push(a);
  }
  for (const r of cleanRootList(op.remove ?? [])) {
    mine = mine.filter((x) => rootKeyOf(x) !== rootKeyOf(r));
    const o = orgKey(r);
    if (o && !offs.some((x) => rootKeyOf(x) === rootKeyOf(o))) offs.push(o);   // 조직 줄은 지울 수 없다 — 이 컴퓨터에서 끈다
  }
  if (mine.length > MAX_WORK_ROOTS) throw new Error(`${what}는 한 컴퓨터에 ${MAX_WORK_ROOTS}개까지입니다`);
  //  지금 조직 목록에 없는 «끈 줄» 은 걷는다 — 관리자가 뺀 줄을 나중에 다시 넣었을 때 옛 끄기가 몰래 살아나지 않게.
  offs = offs.filter((x) => orgKey(x));
  return { own: mine, off: offs };
}

/** 순수 — 지금 값에 변경 하나를 얹는다(테스트가 직접 부른다). 등록(교체·더하기)엔 경로 꼴을 검사한다 — 빼기는 옛 쓰레기 줄도 걷게 검사하지 않는다.
 *  org 는 조직 목록 — 조직 줄을 빼면 «이 컴퓨터에서 끔» 으로 남기려고 받는다(없으면 조직 줄이 없는 것으로 본다). */
export function applyLocalScopeChange(cur: LocalScopePreference, change: LocalScopeChange, org: OrgRecordScope = defaultOrgRecordScope(),
  now = new Date()): LocalScopePreference {
  const w = applyList(cur.work_roots, cur.off_work_roots, org.work_roots,
    { replace: change.work_roots, add: change.add, remove: change.remove }, "작업 폴더");
  const x = applyList(cur.exclude_roots, cur.off_exclude_roots, org.exclude_roots,
    { replace: change.exclude_roots, add: change.exclude_add, remove: change.exclude_remove }, "제외 폴더");
  return { scope: cur.scope, work_roots: w.own, exclude_roots: x.own, off_work_roots: w.off, off_exclude_roots: x.off, updated_at: now.toISOString() };
}

/** 화면·키트가 받는 한 줄 — 어디서 왔고(조직·이 컴퓨터) 지금 켜져 있나. */
export interface LocalScopeEntry { path: string; origin: "org" | "own"; on: boolean }
/** 구성원 컴퓨터 하나의 유효 값 — GET·POST /api/ui/me/local-scope 의 preference 이자 웹 화면의 값.
 *  ⚠ scope·work_roots·updated_at 는 옛 키트가 읽는 이름 그대로다(옛 키트는 제외 목록을 모른다 — 다음 자가 업데이트까지 «어디서나» 면 어디서나 켠다). */
export interface LocalScopeView {
  scope: RecordScope;
  work_roots: string[];
  exclude_roots: string[];
  /** 이 컴퓨터가 끈 조직 작업 폴더 — 키트가 설치 때 깔린 ~/.lively/work-roots 파일(조직 목록의 사본)의 같은 줄도 빼도록. */
  off_roots: string[];
  org: { work_roots: string[]; exclude_roots: string[] };
  entries: { work_roots: LocalScopeEntry[]; exclude_roots: LocalScopeEntry[] };
  updated_at: string;
}

function mergeList(org: string[], off: string[], own: string[]): LocalScopeEntry[] {
  const out: LocalScopeEntry[] = org.map((p) => ({ path: p, origin: "org" as const, on: !off.some((x) => rootKeyOf(x) === rootKeyOf(p)) }));
  for (const p of own) if (!out.some((e) => rootKeyOf(e.path) === rootKeyOf(p))) out.push({ path: p, origin: "own", on: true });
  return out;
}
const later = (a: string, b: string) => (Date.parse(a || "") || 0) >= (Date.parse(b || "") || 0) ? a : b;

/** 순수 — 조직 값 위에 이 컴퓨터 오버라이드를 얹은 유효 값. */
export function localScopeView(org: OrgRecordScope, pref: LocalScopePreference | null): LocalScopeView {
  const p = pref ?? defaultScopePref();
  const w = mergeList(org.work_roots, p.off_work_roots, p.work_roots);
  const x = mergeList(org.exclude_roots, p.off_exclude_roots, p.exclude_roots);
  const on = (list: LocalScopeEntry[]) => list.filter((e) => e.on).map((e) => e.path);
  return {
    scope: org.scope,
    work_roots: on(w),
    exclude_roots: on(x),
    off_roots: w.filter((e) => !e.on).map((e) => e.path),
    org: { work_roots: [...org.work_roots], exclude_roots: [...org.exclude_roots] },
    entries: { work_roots: w, exclude_roots: x },
    updated_at: later(org.updated_at, p.updated_at),
  };
}
