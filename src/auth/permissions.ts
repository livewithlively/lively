// 새 권한 체계 (#5799) — 기능 영역 10개 × 수준(보기 · 고치기) + 역할 4개.
//  방향 합의: 윤상민 2026-11-25 (지식 permission-model-redesign-direction-5799).
//
//  ⚠ **아직 강제에 쓰이지 않는다.** 지금 요청을 막고 여는 것은 종전 scope(./scopes.ts) 그대로다. 이 파일은 1단계 —
//   새 이름 · 옛 이름 번역 · 역할 묶음을 **순수 값**으로 먼저 고정하고, 옛 판정과 새 판정이 어디서 갈리는지를
//   시험(capabilities/permission-map.test.ts)이 전 기능 × 옛 scope 조합으로 잰다. 강제 전환은 다음 단계다.
//
//  종전 체계에서 섞여 있던 세 가지를 뗀다:
//   · 무슨 기능인가  = 권한(Permission) 10개 — 아래 PERMISSIONS
//   · 보기냐 고치기냐 = 수준(Level) — 기능이 컨텍스트를 바꾸는가(capMutates)에서 파생한다
//   · 어떤 대상인가  = DB 소스 · 레포 · 외부 앱별 지정 — **권한 이름에 붙이지 않는다**(`db:<소스>` 식 문자열 폐기).
//                      공개범위처럼 대상 쪽에 사람 · 팀을 적는다(다음 단계). 역할과 대상 지정이 둘 다 있어야 통과한다.
//
//  합치는 규칙은 하나다 — **합집합**. 본인 역할 · 개별 추가 · 소속 팀에서 온 것을 더하고, 거부 규칙은 두지 않는다
//   («이 권한이 어디서 왔나» 를 한 줄로 답할 수 있어야 한다).
import type { Scope } from "./scopes.js";

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
  pipeline: { label: "맥락 관리", definition: "맥락 저장소를 구축하고 관리한다", levels: "read-write" },
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

// ── 옛 이름 → 새 권한 (번역층) ─────────────────────────────────────────────────────────────
//  저장된 옛 값은 건드리지 않고 **읽을 때** 번역한다. 지금 코드는 모르는 이름을 조용히 버리므로
//   (org/store/tokens.ts computeEffectiveScopes 의 isScope 필터) 옛 칸에 새 이름을 써 넣었다가 되돌리면 그 사람의
//   권한이 전부 사라진다. 새 값은 새 칸에 둔다(다음 단계).
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
