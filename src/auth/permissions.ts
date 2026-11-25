// 새 권한 체계 (#5799) — 기능 영역 10개 × 수준(보기 · 고치기) + 역할 4개.
//  방향 합의: 윤상민 2026-11-25 (지식 permission-model-redesign-direction-5799).
//
//  강제 지점은 아래 permits 로 잰다(2단계). **새 권한(grants)이 실린 주체만** 새 규칙을 받고, 옛 scope 만 가진 주체는 종전 그대로
//   «그 scope 를 갖고 있는가» 로 판정받는다 — 구성원을 역할로 옮기기 전에는 누구에게도 아무것도 바뀌지 않는다.
//   grants 는 **역할을 받은 구성원**(org_member.role)의 주체에만 실린다 — 웹 세션 · 토큰 · 앱 주체가 구성원 행에서 읽어 싣는다
//   (아래 «구성원 행 ↔ 권한»). 역할은 org_member_upsert 로 준다. 역할이 없는 구성원에게는 아무것도 바뀌지 않는다.
//
//  종전 체계에서 섞여 있던 세 가지를 뗀다:
//   · 무슨 기능인가  = 권한(Permission) 10개 — 아래 PERMISSIONS
//   · 보기냐 고치기냐 = 수준(Level) — 기능이 컨텍스트를 바꾸는가(capMutates)에서 파생한다
//   · 어떤 대상인가  = DB 소스 · 레포 · 외부 앱별 지정 — **권한 이름에 붙이지 않는다**(`db:<소스>` 식 문자열 폐기).
//                      공개범위처럼 대상 쪽에 사람 · 팀을 적는다(다음 단계). 역할과 대상 지정이 둘 다 있어야 통과한다.
//
//  합치는 규칙은 하나다 — **합집합**. 본인 역할 · 개별 추가 · 소속 팀에서 온 것을 더하고, 거부 규칙은 두지 않는다
//   («이 권한이 어디서 왔나» 를 한 줄로 답할 수 있어야 한다).
import { SCOPES, type Scope } from "./scopes.js";

export const PERMISSIONS = [
  "content", "pipeline", "external", "code", "session", "run", "db", "admin", "secrets", "harness",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(s: unknown): s is Permission {
  return typeof s === "string" && (PERMISSIONS as readonly string[]).includes(s);
}

/** 수준 — read(보기) < write(고치기). 고치기는 보기를 포함한다. */
export type Level = "read" | "write";
const RANK: Record<Level, number> = { read: 1, write: 2 };

/** 기능 하나가 요구하는 것. null = 로그인만(종전 scope null). */
export interface Need { perm: Permission; level: Level }

/** 한 주체가 가진 것 — 권한마다 최고 수준. 없는 키 = 그 권한 없음. */
export type Grants = Readonly<Partial<Record<Permission, Level>>>;

/**
 * 화면에 보일 이름과 정의 — 이름이 곧 기준이어야 한다(도구 이름을 보면 어느 권한인지 짐작된다).
 *  levels: 화면이 수준을 어떻게 고르게 할지.
 *   · read-write = 보기 / 고치기
 *   · read-only  = 보기만(DB 는 조회 전용이라 고치기가 없다)
 *   · on-off     = 있다 / 없다(세션 · 원격 실행 — 줄 때는 write 로 준다)
 */
export const PERMISSION_INFO: Readonly<Record<Permission, { label: string; definition: string; levels: "read-write" | "read-only" | "on-off" }>> = {
  content: { label: "맥락", definition: "팀이 쌓는 내용을 읽고 쓴다", levels: "read-write" },
  //  이름은 그 일을 하는 앱의 지금 이름과 같다(「수집 · 증류」 — 옛 이름 「맥락 관리」 는 화면 글에 쓰지 않는다 #4233 · scripts/ctx-rename.test).
  pipeline: { label: "수집 · 증류", definition: "맥락 저장소를 구축하고 관리한다", levels: "read-write" },
  external: { label: "외부 앱", definition: "AI 가 외부 앱 도구를 부른다", levels: "read-write" },
  code: { label: "코드", definition: "등록된 레포의 코드를 본다", levels: "read-write" },
  session: { label: "세션", definition: "라이블리에서 AI 와 일한다", levels: "on-off" },
  run: { label: "원격 실행", definition: "다른 서버 · 노드의 자원으로 무거운 일을 돌린다", levels: "on-off" },
  db: { label: "DB", definition: "등록된 DB 를 조회한다", levels: "read-only" },
  admin: { label: "관리", definition: "사람과 조직 정책을 정한다", levels: "read-write" },
  secrets: { label: "자격", definition: "로그인 정보와 토큰을 다룬다", levels: "read-write" },
  harness: { label: "하네스 설정", definition: "구성원의 AI 도구에 깔리는 것을 정한다", levels: "read-write" },
};

/** 이 주체가 그 기능을 쓸 수 있나. need 가 null 이면 로그인만으로 통과. */
export function allows(grants: Grants, need: Need | null): boolean {
  if (!need) return true;
  const have = grants[need.perm];
  return have !== undefined && RANK[have] >= RANK[need.level];
}

/** 합집합 — 권한마다 높은 수준이 이긴다. 거부 규칙은 없다. */
export function mergeGrants(...parts: readonly Grants[]): Grants {
  const out: Partial<Record<Permission, Level>> = {};
  for (const g of parts) {
    for (const p of PERMISSIONS) {
      const lv = g[p];
      if (lv !== undefined && (out[p] === undefined || RANK[lv] > RANK[out[p]])) out[p] = lv;
    }
  }
  return out;
}

/**
 * 교집합 — 권한마다 **낮은** 수준이 남고, 한쪽에 없으면 없다.
 *  토큰 · 앱 동의는 «발급된 상한» 이고 구성원은 «지금의 상한» 이다 — 둘 다 허락한 만큼만 통한다
 *  (종전 «토큰 scope ∩ 구성원 scope» 의 새 꼴. 구성원을 내리면 그 사람의 토큰 · 앱이 즉시 따라 내려간다).
 */
export function intersectGrants(a: Grants, b: Grants): Grants {
  const out: Partial<Record<Permission, Level>> = {};
  for (const p of PERMISSIONS) {
    const x = a[p], y = b[p];
    if (x !== undefined && y !== undefined) out[p] = RANK[x] <= RANK[y] ? x : y;
  }
  return out;
}

/**
 * 위험 권한 — 사람과 조직 정책 · 로그인 정보 · 구성원 컴퓨터에 깔리는 것. 종전 DANGEROUS_SCOPES(admin · runtime)가 가리키던 것이다.
 *  회수할 수 없는 정적 토큰(AUTH_TOKENS_JSON)으로는 이 권한의 기능을 쓰지 못한다(보기 포함 — 종전과 같다).
 */
export const DANGEROUS_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>(["admin", "secrets", "harness"]);

/** 권한을 가진 주체의 최소 꼴 — LivelyUser 가 이 꼴이다(이 파일은 context.ts 를 import 하지 않는 잎으로 둔다). */
export interface GrantHolder { scopes?: readonly string[] | null; grants?: Grants | null }

/**
 * 이 주체가 가진 권한. 새 값(grants)이 실려 있으면 그것, 없으면 옛 scope 를 번역한다.
 *  ⚠ 둘을 **합치지 않는다** — grants 가 실린 주체의 scopes 는 옛 코드 · 되돌리기용 사본일 뿐이다. 합치면 보기만 받은 사람이
 *   사본에 남은 옛 이름으로 고치기를 얻는다.
 */
export function grantsOf(u: GrantHolder | null | undefined): Grants {
  if (!u) return {};
  return u.grants ?? legacyScopesToGrants(u.scopes);
}

/**
 * **옛 scope 검사 한 번의 새 꼴** — 강제 지점이 쓰는 판정.
 *  · 새 권한(grants)이 실린 주체 → need 를 덮는가(영역 × 보기 · 고치기).
 *  · 그렇지 않은 주체(옛 scope 만) → **종전 그대로** 그 scope 를 갖고 있는가.
 *  옛 주체를 번역해서 재지 않는 까닭: 영역이 합쳐진 자리(context 와 memory 가 둘 다 «맥락»)에서 번역은 옛 주체의 권한을 넓힌다.
 *   앱 동의는 «이 앱에 memory 만 허락했다» 를 scope 이름으로 약속한 것이라, 배포만으로 그 앱이 분류체계 · NAS 파일까지 읽게 되면
 *   그 약속이 거짓이 된다. 그래서 **구성원을 역할로 옮기기 전에는 누구에게도 아무것도 바뀌지 않는다** — 달라지는 것은 옮기는 순간에,
 *   옮기는 사람이 보는 앞에서 달라진다.
 *  need 가 null(로그인만)이면 누구든 통과한다.
 */
export function permits(u: GrantHolder | null | undefined, legacyScope: string | null, need: Need | null): boolean {
  if (!need || legacyScope === null) return true;
  if (!u) return false;
  if (u.grants) return allows(u.grants, need);
  return Array.isArray(u.scopes) && u.scopes.includes(legacyScope);
}

/** 이 주체가 그 권한을 그 수준으로 갖고 있나. 수준을 안 주면 고치기를 묻는다(모르면 닫는 쪽). */
export function can(u: GrantHolder | null | undefined, perm: Permission, level: Level = "write"): boolean {
  return allows(grantsOf(u), { perm, level });
}

// ── 옛 이름 → 새 권한 (번역층) ─────────────────────────────────────────────────────────────
//  쓰이는 자리는 둘이다 — ① 구성원을 역할로 옮길 때 «지금 scope 로 되던 일» 을 새 권한으로 옮겨 적는다 ② 역할로 옮긴 구성원의
//   토큰 · 앱 동의는 여전히 옛 이름으로 적혀 있다(발급된 상한) — 그것을 번역해 구성원의 새 권한과 교집합한다.
//   ⚠ **옛 scope 만 가진 주체의 판정에는 쓰지 않는다**(permits 머리말 — 번역은 영역이 합쳐진 자리에서 넓힌다).
//  저장된 옛 값은 건드리지 않는다. 지금 코드는 모르는 이름을 조용히 버리므로(org/store/tokens.ts computeEffectiveScopes 의
//   isScope 필터) 옛 칸에 새 이름을 써 넣었다가 되돌리면 그 사람의 권한이 전부 사라진다. 새 값은 새 칸에 둔다.
//
//  기준: **옛 scope 하나가 열던 기능은 번역 뒤에도 전부 열린다.** 예외는 일부러 좁히는 것뿐이고 그 목록은
//   capabilities/permission-map.ts 의 NARROWED 가 이유와 함께 적는다(시험이 «그 목록이 전부» 임을 잰다).
//  영역이 합쳐진 자리에서는 넓어진다 — context 만 가진 사람이 지식을, memory 만 가진 사람이 분류체계를 고치게 된다
//   (둘 다 «맥락» 이다). 넓어지는 쌍도 시험이 표로 고정한다. 위험 권한 쪽으로는 한 칸도 넓어지지 않는다.
//
//  memory 가 session 을 주는 까닭 — 브라우저 도구가 종전 memory 였다. 웹 터미널 세션은 종전에 scope 검사가 없어
//   (로그인만) 이 표가 다루지 않는다. 세션 권한을 누구에게 줄지는 강제를 붙이는 단계에서 정한다.
export const LEGACY_SCOPE_GRANTS: Readonly<Record<Scope, Grants>> = {
  items: { external: "write" },
  context: { content: "write", code: "write", run: "write" },
  memory: { content: "write", pipeline: "write", session: "write" },
  code: { code: "read", run: "write" },
  db: { db: "read" },
  admin: { admin: "write", secrets: "write" },
  runtime: { harness: "write" },
};

/**
 * 옛 scope 배열을 새 권한으로. 모르는 이름은 버린다(종전과 같은 fail-closed).
 *  `db:<소스>` 는 «DB 를 조회할 자격» 까지만 번역한다 — 어느 소스인지는 대상 지정이 맡는다(다음 단계).
 */
export function legacyScopesToGrants(scopes: readonly string[] | null | undefined): Grants {
  const parts: Grants[] = [];
  for (const s of scopes ?? []) {
    if (typeof s !== "string") continue;
    if (s.startsWith("db:") && s.length > 3) { parts.push(LEGACY_SCOPE_GRANTS.db); continue; }
    if (Object.hasOwn(LEGACY_SCOPE_GRANTS, s)) parts.push(LEGACY_SCOPE_GRANTS[s as Scope]);
  }
  return mergeGrants(...parts);
}

// ── 역할 ────────────────────────────────────────────────────────────────────────────────
//  사람에게 권한 10개를 하나씩 체크하지 않고 역할 하나를 준다. 처음엔 제품이 정한 4개 — 고객이 직접 만드는 역할은
//   같은 조정을 여러 명에게 반복하는 고객이 나올 때 연다. 그 전에는 «역할 + 개별 권한 조정» 으로 받는다.
//  역할은 «무엇을 할 수 있나» 만 정한다. 어느 DB 소스 · 레포 · 외부 앱에 닿는지는 대상 지정이 정하므로,
//   대상이 세분돼도 역할을 새로 만들 필요가 없다(대상 묶음은 팀이 맡는다).
export const ROLES = ["guest", "member", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(s: unknown): s is Role {
  return typeof s === "string" && (ROLES as readonly string[]).includes(s);
}

export const ROLE_INFO: Readonly<Record<Role, { label: string; definition: string }>> = {
  guest: { label: "게스트", definition: "공개된 맥락을 본다" },
  member: { label: "구성원", definition: "라이블리에서 일한다" },
  admin: { label: "관리자", definition: "사람과 조직 정책을 정한다" },
  owner: { label: "소유자", definition: "전부 한다" },
};

const MEMBER_GRANTS: Grants = {
  session: "write",
  content: "write",
  pipeline: "write",   // 워크스페이스 운영은 구성원 누구나(2026-09-12 결정)
  external: "write",
  code: "read",        // 정책 확인용 코드 조회는 개발자가 아니어도 한다
  run: "write",
  db: "read",          // 조회할 자격만 — 어느 소스인지는 소스별 지정(기본 불가)
  harness: "read",
};

/**
 * 역할이 주는 권한.
 *  · 게스트 — 맥락 보기만. 세션도 코드도 없다.
 *  · 관리자 — 자격은 보기만, 하네스 설정도 보기만. 고치기는 개별로 얹는다(종전 «admin ⊉ runtime» 을 잇는다).
 *  · 소유자 — 전부. DB 는 보기가 최고 수준이다.
 */
export const ROLE_GRANTS: Readonly<Record<Role, Grants>> = {
  guest: { content: "read" },
  member: MEMBER_GRANTS,
  admin: { ...MEMBER_GRANTS, code: "write", admin: "write", secrets: "read" },
  owner: {
    session: "write", content: "write", pipeline: "write", external: "write", code: "write",
    run: "write", db: "read", admin: "write", secrets: "write", harness: "write",
  },
};

// ── 구성원 행 ↔ 권한 (역할 저장) ──────────────────────────────────────────────────────────
//  구성원 행의 새 칸 둘: role(역할 하나) · grants(역할 위에 개별로 얹은 권한). role 이 비어 있으면 **옛 구성원**이다 —
//   그 사람과 그 사람의 토큰 · 앱은 종전 그대로 scopes 로 판정받는다(permits).

/** 저장된 값(JSONB)을 권한으로 — 모르는 권한 · 모르는 수준 · 객체가 아닌 값은 버린다(fail-closed). */
export function sanitizeGrants(x: unknown): Grants {
  const out: Partial<Record<Permission, Level>> = {};
  if (!x || typeof x !== "object" || Array.isArray(x)) return out;
  for (const p of PERMISSIONS) {
    if (!Object.hasOwn(x, p)) continue;
    const lv = (x as Record<string, unknown>)[p];
    if (lv === "read" || lv === "write") out[p] = lv;
  }
  return out;
}

/** 구성원 행의 새 권한 = 역할 ∪ 개별 추가. 역할이 없으면(옛 구성원) undefined — 개별 추가만 있고 역할이 없는 행도 옛 구성원이다. */
export function memberGrants(row: { role?: unknown; grants?: unknown } | null | undefined): Grants | undefined {
  if (!row || !isRole(row.role)) return undefined;
  return mergeGrants(ROLE_GRANTS[row.role], sanitizeGrants(row.grants));
}

/**
 * 새 권한을 옛 scope 이름으로 비춘 **사본**. 역할을 줄 때 구성원 행의 scopes 칸에 함께 적는다.
 *  쓰임은 둘이다 — ① 아직 scopes 를 읽는 긴 꼬리(화면의 hasScope · 앱 화면의 관리자 판정 · 토큰 발급 상한)가 그 사람을 알아보게
 *  ② 되돌렸을 때 옛 코드가 읽을 값. **판정에는 쓰지 않는다** — 새 권한이 실린 주체는 permits 가 grants 만 본다.
 *  수준이 옛 이름에 없으므로 «그 scope 의 본줄기 일을 할 수 있는가» 로 비춘다: 보기만 가진 영역은 비치지 않는다(코드 · DB 는 원래 보기다).
 *   게스트 → 없음 · 구성원 → 기본 구성원 scope 다섯 · 관리자 → + admin · 소유자 → + admin · runtime.
 */
export function grantsToLegacyScopes(g: Grants): Scope[] {
  const has = (perm: Permission, level: Level): boolean => allows(g, { perm, level });
  const on: Record<Scope, boolean> = {
    items: has("external", "write"),
    context: has("content", "write"),
    memory: has("content", "write"),
    code: has("code", "read"),
    db: has("db", "read"),
    admin: has("admin", "write"),
    runtime: has("harness", "write"),
  };
  return SCOPES.filter((s) => on[s]);
}

/**
 * 역할로 옮긴 구성원의 **한 주체**(웹 세션 · 토큰 · 앱)가 갖는 권한 = 구성원의 지금 권한 ∩ 그 주체에 발급된 상한.
 *  상한은 아직 옛 이름으로 적혀 있다(토큰 scope · 앱 동의 scope) — 번역해서 교집합한다.
 *   · follow "all"  — 구성원을 그대로 따른다(웹 세션 · 우리가 굽는 세션/박스 토큰. 종전 follow_member_scopes).
 *   · follow "safe" — 위험 권한(관리 · 자격 · 하네스 설정 고치기)은 토큰에 실린 만큼만, 나머지는 구성원을 따른다(로그인 토큰 #5712).
 *                     하네스 설정 **보기**는 따른다 — 구성원 역할의 바탕이고(무엇이 깔려 있는지는 누구나 본다) 바꾸는 권한이 아니다.
 *   · follow "none" — 옛 이름으로 적힌 상한 안에서만(관리자가 골라 구운 토큰 · OAuth 발급분 · 앱 동의).
 *  구성원을 내리면 그 사람의 모든 주체가 즉시 따라 내려간다(구성원이 상한이라는 종전 규칙 그대로).
 */
export function principalGrants(
  member: Grants,
  ceiling: { follow: "all" } | { follow: "safe" | "none"; scopes: readonly string[] | null | undefined },
): Grants {
  if (ceiling.follow === "all") return member;
  const issued = legacyScopesToGrants(ceiling.scopes);
  const capped = intersectGrants(member, issued);
  if (ceiling.follow === "none") return capped;
  const out: Partial<Record<Permission, Level>> = {};
  for (const p of PERMISSIONS) {
    const lv = DANGEROUS_PERMISSIONS.has(p) ? capped[p] : member[p];
    if (lv !== undefined) out[p] = lv;
  }
  if (out.harness === undefined && member.harness !== undefined) out.harness = "read";
  return out;
}

/** 구성원 행으로 만드는 주체에 **펼쳐 넣을 칸** — 역할을 받은 구성원이면 `{ grants }`, 옛 구성원이면 빈 객체(scopes 가 판정한다). */
export function grantsField(row: { role?: unknown; grants?: unknown } | null | undefined): { grants?: Grants } {
  const g = memberGrants(row);
  return g ? { grants: g } : {};
}

/**
 * 앱이 그 사람 이름으로 도는 주체에 펼쳐 넣을 칸 — 구성원의 새 권한 ∩ 옛 이름으로 적힌 상한들(앱 동의 scope · 부른 연결의 scope · 작업 상한).
 *  ⚠ 앱 주체를 만들 때 사람의 주체를 `...user` 로 펼치면 그 사람의 권한이 통째로 실린다 — 반드시 이 값으로 덮는다(앱 동의가 상한이다).
 */
export function cappedGrantsField(member: Grants | null | undefined, ...ceilings: (readonly string[] | null | undefined)[]): { grants?: Grants } {
  if (!member) return {};
  return { grants: ceilings.reduce<Grants>((g, c) => intersectGrants(g, legacyScopesToGrants(c)), member) };
}
