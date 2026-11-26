// 새 권한 체계의 화면용 값 (#5799) — 권한 10개 · 역할 4개의 이름 · 설명 · 묶음.
//  서버 값(src/auth/permissions.ts)이 기준이다. 웹 번들은 서버 코드를 import 할 수 없어 같은 값을 따로 적고,
//  시험(src/auth/web-permissions.test.ts)이 둘이 갈라지지 않게 잠근다 — 아래 세 값은 **JSON 그대로** 적는다(시험이 글로 읽는다).
//  설명 글은 화면에만 있다: 권한마다 «무엇인가» 한 줄 + «켜면 할 수 있는 일» 을 행동으로.

export type Level = 'read' | 'write';
export type Grants = Record<string, Level>;

/* permissions:begin */
export const PERMISSION_KEYS = ["content", "pipeline", "external", "code", "session", "run", "db", "admin", "secrets", "harness"];
/* permissions:end */

/* role-keys:begin */
export const ROLE_KEYS = ["guest", "member", "admin", "owner"];
/* role-keys:end */

/* role-grants:begin */
export const ROLE_GRANTS: Record<string, Grants> = {
  "guest": { "content": "read" },
  "member": { "session": "write", "content": "write", "pipeline": "write", "external": "write", "code": "read", "run": "write", "db": "read", "harness": "read" },
  "admin": { "session": "write", "content": "write", "pipeline": "write", "external": "write", "code": "write", "run": "write", "db": "read", "harness": "read", "admin": "write", "secrets": "read" },
  "owner": { "session": "write", "content": "write", "pipeline": "write", "external": "write", "code": "write", "run": "write", "db": "read", "admin": "write", "secrets": "write", "harness": "write" }
};
/* role-grants:end */

/** 수준을 고르는 방식 — read-write(보기/고치기) · read-only(DB 는 조회 전용) · on-off(세션 · 원격 실행은 있다/없다). */
export const PERMISSION_INFO: Record<string, { label: string; definition: string; levels: 'read-write' | 'read-only' | 'on-off'; read?: string; write: string }> = {
  content: { label: '맥락', definition: '팀이 쌓는 내용을 읽고 쓴다', levels: 'read-write', read: '지식 · 프로젝트 · 자료를 찾아 읽습니다', write: '지식을 쓰고 프로젝트 · 태스크를 만들고 고칩니다' },
  pipeline: { label: '수집 · 증류', definition: '맥락 저장소를 구축하고 관리한다', levels: 'read-write', read: '수집 · 증류 설정과 실행 기록을 봅니다', write: '수집기 · 증류기 · 예약 실행 · 경보를 만들고 고칩니다' },
  external: { label: '외부 앱', definition: 'AI 가 외부 앱 도구를 부른다', levels: 'read-write', read: 'AI 가 슬랙 · 깃허브 · 구글 등에서 찾아 읽습니다', write: 'AI 가 내 이름으로 메시지를 보내고 이슈를 만듭니다' },
  code: { label: '코드', definition: '등록된 레포의 코드를 본다', levels: 'read-write', read: '레포의 파일을 읽고 검색합니다', write: '레포를 등록하고 이름을 바꾸고 지웁니다' },
  session: { label: '세션', definition: '라이블리에서 AI 와 일한다', levels: 'on-off', write: 'AI 세션을 열고 브라우저 도구를 씁니다' },
  run: { label: '원격 실행', definition: '다른 서버 · 노드의 자원으로 무거운 일을 돌린다', levels: 'on-off', write: '작업을 위탁하고 프리뷰 환경을 띄웁니다' },
  db: { label: 'DB', definition: '등록된 DB 를 조회한다', levels: 'read-only', write: '', read: '조회 대상으로 지정된 DB 소스를 조회합니다(소스마다 따로 지정해야 열립니다)' },
  admin: { label: '관리', definition: '사람과 조직 정책을 정한다', levels: 'read-write', read: '감사 기록 · 조직 설정을 봅니다', write: '구성원 · 팀 · 공개범위 정책 · DB 소스를 바꿉니다' },
  secrets: { label: '자격', definition: '로그인 정보와 토큰을 다룬다', levels: 'read-write', read: '등록된 로그인 정보 · 토큰의 목록을 봅니다', write: '서비스 로그인을 넣고 토큰을 발급 · 회수합니다' },
  harness: { label: '하네스 설정', definition: '구성원의 AI 도구에 깔리는 것을 정한다', levels: 'read-write', read: '어떤 훅 · 도구 · 스킬이 깔려 있는지 봅니다', write: '모든 구성원의 AI 도구에 깔리는 훅 · 도구 · 스킬을 바꿉니다' },
};

export const ROLE_INFO: Record<string, { label: string; definition: string }> = {
  guest: { label: '게스트', definition: '공개된 맥락을 보기만 합니다. AI 세션은 열 수 없습니다.' },
  member: { label: '구성원', definition: '라이블리에서 일합니다. 맥락을 쓰고, AI 세션을 열고, 외부 앱 도구를 씁니다.' },
  admin: { label: '관리자', definition: '구성원이 하는 일에 더해 사람과 조직 정책을 정합니다.' },
  owner: { label: '소유자', definition: '전부 합니다. 로그인 정보와 모든 구성원의 AI 도구 설정까지 바꿉니다.' },
};

const RANK: Record<string, number> = { read: 1, write: 2 };
const rank = (lv?: string): number => (lv ? RANK[lv] || 0 : 0);

/** 역할 + 개별 추가 = 실제 권한(권한마다 높은 수준). 모르는 역할이면 개별 추가만. */
export function grantsFor(role: string | null | undefined, extras?: Grants | null): Grants {
  const out: Grants = { ...((role && ROLE_GRANTS[role]) || {}) };
  for (const p of PERMISSION_KEYS) {
    const lv = extras && extras[p];
    if ((lv === 'read' || lv === 'write') && rank(lv) > rank(out[p])) out[p] = lv;
  }
  return out;
}

/** 수준을 사람 말로 — 없음 · 보기 · 고치기(있다/없다 권한은 «있음», DB 는 «조회»). */
export function levelText(perm: string, level?: string): string {
  if (!level) return '없음';
  const kind = PERMISSION_INFO[perm]?.levels;
  if (kind === 'on-off') return '있음';
  if (kind === 'read-only') return '조회';
  return level === 'write' ? '고치기' : '보기';
}

/** 권한 하나가 그 수준에서 «할 수 있는 일» 한 줄. */
export function abilityText(perm: string, level?: string): string {
  const info = PERMISSION_INFO[perm];
  if (!info || !level) return '';
  return level === 'write' && info.write ? info.write : (info.read || info.write);
}

/** 이 역할 위에 개별로 얹을 수 있는 수준들(역할이 이미 주는 것보다 높은 것만). */
export function extraChoices(role: string, perm: string): Level[] {
  const kind = PERMISSION_INFO[perm]?.levels;
  const have = rank(ROLE_GRANTS[role]?.[perm]);
  const all: Level[] = kind === 'read-only' ? ['read'] : kind === 'on-off' ? ['write'] : ['read', 'write'];
  return all.filter((lv) => rank(lv) > have);
}

/** 옛 scope 로 받은 권한과 가장 가까운 역할(화면의 «역할로 옮기기» 제안) — admin 이 있으면 관리자(runtime 까지면 소유자), 아니면 구성원. 권한이 하나도 없으면 게스트. */
export function suggestRole(scopes: string[] | null | undefined): string {
  const s = new Set(scopes || []);
  if (s.has('admin')) return s.has('runtime') ? 'owner' : 'admin';
  return s.size ? 'member' : 'guest';
}

/** 새 구성원 등록 폼이 미리 골라 두는 역할 — 서버의 새 구성원 기본 역할(src/auth/permissions.ts DEFAULT_MEMBER_ROLE)과 같은 값. */
export const MEMBER_DEFAULT_ROLE = 'member';

//  ── 폼의 «권한 주는 방식» 고르기 ──
//   역할 넷 + «직접 고르기». «직접 고르기» 는 따로 저장되는 종류가 아니다 — 게스트 역할(맥락 보기) 위에 개별 권한을 얹은 것이다.
//   그래서 게스트인데 개별 권한이 있는 구성원은 «직접 고르기» 로 읽는다. 옛 방식(역할 없음)은 이미 옛 방식인 구성원을 고칠 때만 남는다.
export const CUSTOM_CHOICE = 'custom';
export const LEGACY_CHOICE = '';

/** 이 구성원이 지금 어느 방식인가 — 역할 이름 · 'custom'(직접 고르기) · ''(옛 방식). */
export function accessChoiceOf(m: { role?: string | null; grants?: Grants | null } | null | undefined): string {
  const role = m?.role;
  if (!role || !ROLE_GRANTS[role]) return LEGACY_CHOICE;
  return role === 'guest' && Object.keys(m?.grants || {}).length ? CUSTOM_CHOICE : role;
}

/** 고른 방식이 실제로 저장되는 역할 — «직접 고르기» 는 게스트. 옛 방식이면 null. */
export function roleOfChoice(choice: string): string | null {
  if (choice === CUSTOM_CHOICE) return 'guest';
  return ROLE_GRANTS[choice] ? choice : null;
}

/** 폼에 보여 줄 방식들 — 새 구성원과 역할 구성원에게는 옛 방식을 내놓지 않는다(옛 방식으로 새로 들어가는 길을 닫는다). */
export function accessChoices(m: { role?: string | null } | null | undefined, isNew: boolean): string[] {
  const all = [...ROLE_KEYS, CUSTOM_CHOICE];
  return !isNew && !m?.role ? [LEGACY_CHOICE, ...all] : all;
}

/** 방식을 바꿨을 때 남길 개별 권한 — 그 역할이 이미 주는 것(얹을 것이 아닌 것)은 버린다. 옛 방식이면 전부 버린다. */
export function extrasForChoice(choice: string, extras: Grants | null | undefined): Grants {
  const role = roleOfChoice(choice);
  const out: Grants = {};
  if (!role) return out;
  for (const [pk, lv] of Object.entries(extras || {})) if (extraChoices(role, pk).includes(lv)) out[pk] = lv;
  return out;
}

/** 저장할 값 — 역할 방식이면 {role, grants}. 옛 방식이면 null(부르는 쪽이 scopes 를 보낸다). */
export function accessPayload(choice: string, extras: Grants | null | undefined): { role: string; grants: Grants } | null {
  const role = roleOfChoice(choice);
  return role ? { role, grants: extrasForChoice(choice, extras) } : null;
}

//  ── 옛 방식 구성원을 역할로 옮기기(이관 계획을 사람 말로) ──
export interface LevelChange { perm: string; from: string | null; to: string | null }
export interface MigrationRow {
  id: string; display_name?: string | null; kind?: string | null; scopes?: string[];
  role: string | null; custom?: boolean; grants?: Grants; gains?: LevelChange[]; losses?: LevelChange[];
  db_sources?: string[]; app_consents?: number; skip?: string | null;
}

/** 이 구성원이 갈 곳 — 역할 이름 · «직접 고른 권한» · 옮기지 않음. */
export function planTargetText(r: MigrationRow): string {
  if (!r.role) return r.skip === 'no-permissions' ? '옮기지 않음 (권한 없음)' : '옮기지 않음';
  if (r.custom) return '직접 고른 권한';
  const extra = Object.keys(r.grants || {}).length;
  return (ROLE_INFO[r.role]?.label || r.role) + (extra ? ' + 개별 권한 ' + extra + '개' : '');
}

/** 얻는 것 한 조각 — «하네스 설정 보기». */
export function gainText(c: LevelChange): string {
  return (PERMISSION_INFO[c.perm]?.label || c.perm) + ' ' + levelText(c.perm, c.to || undefined);
}

/** 잃는 것 한 조각 — «코드 고치기 → 보기»(다 잃으면 «→ 없음»). */
export function lossText(c: LevelChange): string {
  return (PERMISSION_INFO[c.perm]?.label || c.perm) + ' ' + levelText(c.perm, c.from || undefined) + ' → ' + levelText(c.perm, c.to || undefined);
}

/** 역할별 수를 한 줄로 — 0 인 것은 뺀다. */
export function migrationSummary(counts: Record<string, number> | null | undefined): string {
  const c = counts || {};
  const parts: Array<[string, number]> = [
    [ROLE_INFO.owner.label, c.owner || 0], [ROLE_INFO.admin.label, c.admin || 0], [ROLE_INFO.member.label, c.member || 0],
    ['직접 고른 권한', c.custom || 0], ['옮기지 않음', c.skipped || 0],
  ];
  return parts.filter(([, n]) => n > 0).map(([k, n]) => k + ' ' + n + '명').join(' · ');
}

/** 역할로 옮길 옛 방식 구성원 수 — 명부 위 안내에 쓴다. 권한이 하나도 없는 구성원(시스템 계정 등)은 세지 않는다(옮기지 않는다). */
export function legacyCount(members: Array<{ role?: string | null; scopes?: string[] | null }> | null | undefined): number {
  return (members || []).filter((m) => !m.role && (m.scopes || []).length > 0).length;
}

//  ── 팀이 주는 권한 · «이 권한이 어디서 왔나» ──
//   서버 auth/permissions.ts 의 teamGrants · memberGrants · grantSources 와 같은 규칙이다(시험이 서버와 맞춘다).
export interface TeamAccess { team_id: number; name?: string | null; role?: string | null; grants?: Grants | null }

const raise = (into: Grants, add: Grants | null | undefined): void => {
  for (const [pk, lv] of Object.entries(add || {})) if ((lv === 'read' || lv === 'write') && rank(lv) > rank(into[pk])) into[pk] = lv;
};

/** 팀 하나가 주는 권한 = 팀의 역할이 주는 것 ∪ 팀의 개별 권한. */
export function teamGrantsOf(t: { role?: string | null; grants?: Grants | null } | null | undefined): Grants {
  const out: Grants = {};
  if (!t) return out;
  if (t.role && ROLE_GRANTS[t.role]) raise(out, ROLE_GRANTS[t.role]);
  raise(out, t.grants);
  return out;
}

/** 구성원의 지금 권한 = 본인 역할 ∪ 본인 개별 권한 ∪ 소속 팀들이 주는 것. 역할이 없으면(옛 방식) 빈 것 — 팀은 역할을 받은 구성원에게만 더한다. */
export function effectiveGrants(m: { role?: string | null; grants?: Grants | null; team_access?: TeamAccess[] | null } | null | undefined): Grants {
  const out: Grants = {};
  if (!m?.role || !ROLE_GRANTS[m.role]) return out;
  raise(out, ROLE_GRANTS[m.role]);
  raise(out, m.grants);
  for (const t of m.team_access || []) raise(out, teamGrantsOf(t));
  return out;
}

/** 권한 하나가 어디서 왔나 — 지금 수준을 주는 출처들을 사람 말로(«역할» · «개별 권한» · «팀 이름»). 권한이 없으면 빈 배열. */
export function sourceTexts(m: { role?: string | null; grants?: Grants | null; team_access?: TeamAccess[] | null } | null | undefined, perm: string): string[] {
  const lv = effectiveGrants(m)[perm];
  if (!lv || !m?.role) return [];
  const out: string[] = [];
  if (ROLE_GRANTS[m.role]?.[perm] === lv) out.push((ROLE_INFO[m.role]?.label || m.role) + ' 역할');
  if ((m.grants || {})[perm] === lv) out.push('개별 권한');
  for (const t of m.team_access || []) if (teamGrantsOf(t)[perm] === lv) out.push('팀 ' + (t.name || '#' + t.team_id));
  return out;
}

/** 팀이 주는 권한을 한 줄로 — «구성원 역할 · 코드 고치기 · DB 조회». 주는 것이 없으면 빈 줄. */
export function teamAccessText(t: { role?: string | null; grants?: Grants | null } | null | undefined): string {
  if (!t) return '';
  const parts: string[] = [];
  if (t.role && ROLE_INFO[t.role]) parts.push(ROLE_INFO[t.role].label + ' 역할');
  for (const pk of PERMISSION_KEYS) { const lv = (t.grants || {})[pk]; if (lv === 'read' || lv === 'write') parts.push(PERMISSION_INFO[pk].label + ' ' + levelText(pk, lv)); }
  return parts.join(' · ');
}

/** 팀에 개별 권한으로 줄 수 있는 수준들 — 권한 종류대로(보기 · 고치기 / 조회 / 있음). */
export function teamLevelChoices(perm: string): Level[] {
  const kind = PERMISSION_INFO[perm]?.levels;
  return kind === 'read-only' ? ['read'] : kind === 'on-off' ? ['write'] : ['read', 'write'];
}
