// lib/connect-board.ts — [외부 앱 연결]의 앱 × 구성원 현황판 판정(#4213 T13). DOM 을 모르는 순수 모듈이다(시험: scripts/connect-board.test.mjs).
//
//  무엇을 보여 주나(설계 connect-collect-tobe-claude-connector-4213 §7): 앱 줄마다
//   · 구성원 칸 — «Claude로 연결됨» / 다시 로그인 필요 / 연결 실패 / «○○님 연결 필요» / 확인 전 / (안 씀)
//   · 연결 경로 — Claude 커넥터(구성원 계정) · 라이블리 수집기 · «리브가 연결함»(리브가 직접 연결한 단위)
//   · 수집 단위 — 모으는 중 · 후보 · 뺌, 그리고 단위마다 공개범위·담당·마지막으로 읽은 때·설명(보기만 — 고치는 것은 공개범위와 모을지뿐)
//  판정의 원천은 서버다 — 구성원 Claude 커넥터 기록(member_ai_connectors, T6) · 수집 단위 표(collect_units, T10) · 수집기 목록.
//   여기서는 그 값을 칸으로 옮길 뿐 새 판정을 만들지 않는다. 고칠 수 있나의 판정은 서버 규칙(unit-plan canEditUnit ·
//   visibilityChangeError)을 그대로 따라 **버튼을 보일지만** 정한다 — 실제 허락은 서버가 한다(403·409 를 화면이 받는다).
import { CLAUDE_COLLECT_APP_KEYS, CLAUDE_CONNECTOR_STATUS_LABEL, NOT_WORK_APPS, appKeyOfConnector, appLabel } from './claude-connectors.js';

export type Policy = 'allowed' | 'blocked' | 'unknown';
export type Visibility = 'me' | 'viewers' | 'all';
export type UnitStateName = 'candidate' | 'active' | 'excluded';

export interface BoardMemberIn { id: string; name: string }
export interface ConnectorMemberIn {
  member_id: string;
  scan: { ok: boolean; error: string | null; scanned_at?: string | null } | null;
  connectors: Array<{ app: string; status: string }>;
}
/** collect_units 의 한 줄 — full(다 보임)과 coarse(겉만) 둘 다 받는다. */
export interface UnitIn {
  id: number; app: string; kind: string; name: string | null; route: string; state: UnitStateName; visibility: Visibility;
  access: 'full' | 'coarse';
  owner_member?: string | null; connector?: string | null; read_at?: string | null; last_item_at?: string | null;
  description?: string | null; meta?: Record<string, unknown> | null;
  candidates?: Array<{ member_id: string; verified: boolean; active?: boolean; health?: string }>;
  assignee?: { kind: 'collector' | 'member'; member_id?: string } | null;
  assignee_kind?: 'collector' | 'member' | null;
  candidate_count?: number;
}
export interface CollectorIn { preset_key: string; enabled: boolean; label?: string | null }
/** 구성원 명부(GET /api/ui/org/members)의 한 줄 — 비관리자에게도 오는 칸만. */
export interface RosterIn { id: string; display_name?: string | null; is_person?: boolean; state?: string | null }

/**
 * 열(구성원) — 명부에서 «자기 계정으로 들어오는 사람»(is_person)이면서 활성인 사람. 보는 사람은 늘 넣는다.
 *  ⚠ kind='human' 으로 고르지 않는다 — 매니지드 실측(2026-10-17): 사람 행 90개 중 들어오는 사람은 3명이었다(나머지는 연결 앱이
 *   미러한 사람 행 · 리브 페르소나). 그 90개를 열로 세우면 표가 쓸 수 없게 된다.
 *  명부를 못 읽었으면(null) 커넥터 기록이 있는 구성원으로 세운다 — 그 사람들은 실제로 들어와 Claude 를 쓴 사람이다.
 *  이름은 nameOf(아바타 명부) → 명부의 이름 → id 순.
 */
export function boardPeople(roster: RosterIn[] | null, recordIds: readonly string[], me: string, nameOf: (id: string) => string | null): BoardMemberIn[] {
  const out = new Map<string, string>();
  const name = (id: string, fallback?: string | null): string => nameOf(id) || (fallback ? String(fallback) : '') || id;
  if (roster) {
    for (const m of roster) if (m && m.is_person === true && m.state === 'active') out.set(String(m.id), name(String(m.id), m.display_name));
  } else {
    for (const id of recordIds) if (id) out.set(String(id), name(String(id)));
  }
  if (me && !out.has(me)) out.set(me, name(me));
  return [...out].map(([id, nm]) => ({ id, name: nm }));
}

export interface BoardInput {
  me: string;
  isAdmin: boolean;
  members: BoardMemberIn[];
  policy: Policy;
  connectorMembers: ConnectorMemberIn[];
  units: UnitIn[];
  collectors: CollectorIn[];
}

export type CellState = 'connected' | 'needs-auth' | 'failed' | 'pending' | 'unknown' | 'need' | 'unchecked' | 'scan-failed' | 'off' | 'blocked';
export interface BoardCell { member: string; state: CellState; label: string; scanError?: string | null }
export interface BoardApp {
  key: string;
  label: string;
  /** 수집 실행(Claude 커넥터)이 이 앱에서 목록·수집을 아나. */
  collectable: boolean;
  /** Claude 로 이 앱을 연결한 구성원 수(connected). */
  claudeMembers: number;
  /** 켜진 라이블리 수집기가 이 앱을 맡나. */
  collector: boolean;
  /** 리브가 직접 연결한 단위(route liv_direct)가 있나 — «리브가 연결함». */
  livDirect: boolean;
  /** 팀이 Claude 커넥터로 이 앱을 쓰나 — 연결한 구성원이 있거나 구성원 경로 단위를 모으는 중. 아니면 «연결 필요» 를 말하지 않는다. */
  teamUses: boolean;
  units: { active: number; candidate: number; excluded: number; list: UnitIn[] };
  cells: BoardCell[];
}
export interface Board { members: BoardMemberIn[]; apps: BoardApp[]; policy: Policy }

/** 단위의 앱 키 공간에서 수집기 프리셋 키 — 단위로 안 풀리는 프리셋은 현황판 줄로 세우지 않는다(T10 이관에서도 건너뛴다). */
const NOT_APP_PRESETS: ReadonlySet<string> = new Set(['domain-wiki', 'local', 'local-files']);

/** 사람이 읽는 상태 이름 — 칸의 글자. «○○님 연결 필요» 는 이름이 들어가 칸마다 만든다. */
export const CELL_LABEL: Readonly<Record<Exclude<CellState, 'need'>, string>> = {
  connected: 'Claude로 연결됨',
  'needs-auth': CLAUDE_CONNECTOR_STATUS_LABEL['needs-auth'],
  failed: CLAUDE_CONNECTOR_STATUS_LABEL.failed,
  pending: CLAUDE_CONNECTOR_STATUS_LABEL.pending,
  unknown: CLAUDE_CONNECTOR_STATUS_LABEL.unknown,
  unchecked: '확인 전',
  'scan-failed': '확인 못 함',
  off: '안 씀',
  blocked: '쓰지 않음',
};
export const needLabel = (name: string): string => `${name}님 연결 필요`;

/** 커넥터는 있는데 지금 못 쓰는 칸(다시 로그인 · 실패 · 연결 중 · 모름). */
const BROKEN_CELLS: ReadonlySet<CellState> = new Set<CellState>(['needs-auth', 'failed', 'pending', 'unknown']);
/**
 * 연결 경로 말 — 이 앱이 어떤 길로 이어져 있나(Claude 커넥터 n명 · 라이블리 수집기 · 리브가 연결함).
 *  길이 하나도 없는데 Claude 로 이어 둔 사람이 있으면(지금 못 쓰는 상태) «아직 연결한 사람이 없어요» 로 숨기지 않고 그 사실을 말한다
 *  (화면 실측 2026-10-17 — 칸은 «다시 로그인 필요» 인데 줄은 «아직 연결한 사람이 없어요» 라 서로 어긋났다).
 */
export function routeText(a: Pick<BoardApp, 'claudeMembers' | 'collector' | 'livDirect' | 'cells'>): string {
  const parts: string[] = [];
  if (a.claudeMembers) parts.push(`Claude 커넥터 ${a.claudeMembers}명`);
  if (a.collector) parts.push('라이블리 수집기');
  if (a.livDirect) parts.push('리브가 연결함');
  if (parts.length) return parts.join(' · ');
  return a.cells.some((c) => BROKEN_CELLS.has(c.state)) ? 'Claude 로 이어 두었지만 지금은 쓸 수 없어요' : '아직 연결한 사람이 없어요';
}

export const VIS_LABEL: Readonly<Record<Visibility, string>> = { me: '나만', viewers: '볼 수 있는 사람만', all: '모두' };
export const STATE_LABEL: Readonly<Record<UnitStateName, string>> = { active: '모으는 중', candidate: '후보', excluded: '뺌' };
export const KIND_LABEL: Readonly<Record<string, string>> = {
  channel: '공개 채널', private_channel: '비공개 채널', group_dm: '그룹 대화', dm: '1:1 대화', page: '페이지', database: '데이터베이스',
  mailbox: '메일함', label: '메일 라벨', repo: '저장소', project: '프로젝트', team: '팀', folder: '폴더', file: '파일', other: '그 밖',
};
/** 이름이 숨은 겉줄(남의 비공개 대화) — 이름 대신 종류만 말한다. */
export const hiddenUnitName = (kind: string): string => `이름이 가려진 ${KIND_LABEL[kind] ?? '곳'}`;
/** 서버가 겉줄에서 이름을 빼는 종류(unit-store PRIVATE_KINDS 와 같은 목록). */
const PRIVATE_UNIT_KINDS: ReadonlySet<string> = new Set(['private_channel', 'group_dm', 'dm', 'mailbox']);
/**
 * 단위 이름 — 이름이 없을 때 «가려졌다» 고 말하는 것은 서버가 정말 가린 경우(겉줄 · 비공개 종류)뿐이다.
 *  그 밖에 이름이 비었으면 «이름 없는 …» 이다(매니지드 실측 2026-10-17: 이름 없이 만든 공개 채널 단위가 «이름이 가려진 공개 채널» 로 보였다).
 */
export function unitDisplayName(u: Pick<UnitIn, 'name' | 'kind' | 'access'>): string {
  if (u.name) return u.name;
  return u.access === 'coarse' && PRIVATE_UNIT_KINDS.has(u.kind) ? hiddenUnitName(u.kind) : `이름 없는 ${KIND_LABEL[u.kind] ?? '곳'}`;
}
/**
 * 마지막으로 읽은 때 — 다 보는 줄(full)만 말한다. 겉줄(coarse)에는 서버가 읽은 위치를 주지 않는다(UnitCoarseView) —
 *  거기서 «아직 안 읽음» 이라고 하면 이미 읽은 수집기 단위를 안 읽었다고 지어낸다(격리 리뷰 2026-10-17).
 */
export function unitReadText(u: Pick<UnitIn, 'access' | 'read_at' | 'state'>, rel: (iso: string) => string): string {
  if (u.access !== 'full') return '';
  if (u.read_at) return `${rel(u.read_at)} 읽음`;
  return u.state === 'active' ? '아직 안 읽음' : '';
}
/** 모으는 곳 요약 — 있는 상태만 센다(«모으는 중 0» 같은 말을 하지 않는다). 하나도 없으면 길이 있는지에 따라 말한다(있는 척하지 않는다). */
export function unitSummaryText(a: Pick<BoardApp, 'units' | 'collectable' | 'collector'>): string {
  const u = a.units;
  const parts = ([['active', u.active], ['candidate', u.candidate], ['excluded', u.excluded]] as Array<[UnitStateName, number]>)
    .filter(([, n]) => n > 0).map(([k, n]) => `${STATE_LABEL[k]} ${n}`);
  if (parts.length) return parts.join(' · ');
  return a.collectable || a.collector ? '아직 찾은 곳이 없어요' : '이 앱은 아직 모으는 길을 준비 중이에요';
}

const UNIT_ORDER: Record<UnitStateName, number> = { active: 0, candidate: 1, excluded: 2 };

export function buildBoard(i: BoardInput): Board {
  //  구성원 열 — 나를 맨 앞에. 커넥터 기록은 있는데 명부(활성 사람)에 없는 id 는 세우지 않는다(내보낸 사람·운영 계정).
  const members = [...i.members].sort((a, b) => (a.id === i.me ? -1 : b.id === i.me ? 1 : a.name.localeCompare(b.name)));
  const byMember = new Map(i.connectorMembers.map((m) => [m.member_id, m]));
  type Acc = { key: string; name: string | null; claude: Set<string>; collector: boolean; livDirect: boolean; units: UnitIn[] };
  const acc = new Map<string, Acc>();
  const row = (key: string, name?: string | null): Acc => {
    let r = acc.get(key);
    if (!r) { r = { key, name: name ?? null, claude: new Set(), collector: false, livDirect: false, units: [] }; acc.set(key, r); }
    if (!r.name && name) r.name = name;
    return r;
  };
  const people = new Set(members.map((m) => m.id));
  for (const m of i.connectorMembers) {
    if (!people.has(m.member_id)) continue;
    for (const c of m.connectors) {
      const key = appKeyOfConnector(c.app);
      if (!key || NOT_WORK_APPS.has(key) || c.status === 'removed') continue;
      const r = row(key, c.app);
      if (c.status === 'connected') r.claude.add(m.member_id);
    }
  }
  for (const u of i.units) {
    const r = row(u.app, u.connector ?? null);
    r.units.push(u);
    if (u.route === 'liv_direct') r.livDirect = true;
    if (u.route === 'lively_collector') r.collector = true;
  }
  for (const c of i.collectors) {
    const key = String(c.preset_key || '').toLowerCase();
    if (!c.enabled || !key || NOT_APP_PRESETS.has(key)) continue;
    row(key, null).collector = true;
  }

  const apps: BoardApp[] = [...acc.values()].map((r) => {
    const memberUnitsActive = r.units.some((u) => u.route === 'member_ai' && u.state === 'active');
    const teamUses = r.claude.size > 0 || memberUnitsActive;
    const cells = members.map((m): BoardCell => {
      if (i.policy === 'blocked') return { member: m.id, state: 'blocked', label: CELL_LABEL.blocked };
      const rec = byMember.get(m.id) ?? null;
      const c = rec?.connectors.find((x) => appKeyOfConnector(x.app) === r.key && x.status !== 'removed') ?? null;
      if (c) {
        const st = (['connected', 'needs-auth', 'failed', 'pending'] as const).find((s) => s === c.status) ?? 'unknown';
        return { member: m.id, state: st, label: CELL_LABEL[st] };
      }
      if (!rec || !rec.scan) return { member: m.id, state: 'unchecked', label: CELL_LABEL.unchecked };
      if (!rec.scan.ok) return { member: m.id, state: 'scan-failed', label: CELL_LABEL['scan-failed'], scanError: rec.scan.error };
      return teamUses ? { member: m.id, state: 'need', label: needLabel(m.name) } : { member: m.id, state: 'off', label: CELL_LABEL.off };
    });
    const list = [...r.units].sort((a, b) => UNIT_ORDER[a.state] - UNIT_ORDER[b.state]
      || String(a.name ?? '').localeCompare(String(b.name ?? '')) || a.id - b.id);
    return {
      key: r.key, label: appLabel(r.key, r.name), collectable: CLAUDE_COLLECT_APP_KEYS.includes(r.key),
      claudeMembers: r.claude.size, collector: r.collector, livDirect: r.livDirect, teamUses,
      units: {
        active: list.filter((u) => u.state === 'active').length,
        candidate: list.filter((u) => u.state === 'candidate').length,
        excluded: list.filter((u) => u.state === 'excluded').length,
        list,
      },
      cells,
    };
  });
  //  줄 순서 — 팀이 쓰는 것(Claude 로 연결한 사람 많은 순) → 모으는 단위가 많은 순 → 이름.
  apps.sort((a, b) => Number(b.teamUses) - Number(a.teamUses) || b.claudeMembers - a.claudeMembers
    || b.units.active - a.units.active || Number(b.collector) - Number(a.collector) || a.label.localeCompare(b.label));
  return { members, apps, policy: i.policy };
}

// ── 고치기 — 서버 규칙(unit-plan canEditUnit · visibilityChangeError)을 그대로 따른다. 실제 허락은 서버가 한다. ──
const isCollectorRoute = (r: string): boolean => r === 'lively_collector' || r === 'liv_direct';
const verifiedIn = (u: UnitIn, m: string | null | undefined): boolean =>
  !!m && !!u.candidates?.some((c) => c.member_id === m && c.verified && c.active !== false);

/** 이 사람이 이 단위를 고칠 수 있나(다 보이는 줄만) — 구성원 경로는 확인된 볼 수 있는 구성원 · 수집기 경로는 관리자 또는 확인된 구성원. */
export function canEditUnit(u: UnitIn, me: string, isAdmin: boolean): boolean {
  if (u.access !== 'full') return false;
  const verified = !!u.candidates?.some((c) => c.member_id === me && c.verified);
  return isCollectorRoute(u.route) ? (isAdmin || verified) : verified;
}

/** 공개범위 선택지 — 고를 수 없는 값은 빼서 내준다(지금 값은 늘 들어간다 — 선택 칸이 빈칸이 되지 않게). */
export function visibilityChoices(u: UnitIn, me: string, isAdmin: boolean): Visibility[] {
  if (!canEditUnit(u, me, isAdmin)) return [u.visibility];
  const all: Visibility[] = ['me', 'viewers', 'all'];
  const out = all.filter((next) => {
    if (next === u.visibility) return true;
    if (u.visibility === 'me' && u.owner_member && u.owner_member !== me) {
      if (!verifiedIn(u, me)) return false;
      if (verifiedIn(u, u.owner_member) && next !== 'viewers') return false;
    }
    if (next === 'me' && !verifiedIn(u, me)) return false;
    return true;
  });
  return out;
}

/** 넓히는 쪽인가(나만 → 볼 수 있는 사람만 → 모두) — 이미 모은 자료가 있으면 서버가 확인(confirm)을 요구한다. */
export function widens(from: Visibility, to: Visibility): boolean {
  const rank: Record<Visibility, number> = { me: 0, viewers: 1, all: 2 };
  return rank[to] > rank[from];
}

/** 이 단위를 지금 누가 모으나 — 사람 말. 이름표는 부르는 쪽이 준다(구성원 id → 이름). */
export function assigneeText(u: UnitIn, nameOf: (id: string) => string): string {
  const a = u.assignee ?? null;
  if (a?.kind === 'collector' || u.assignee_kind === 'collector') return '라이블리 수집기';
  if (a?.kind === 'member' && a.member_id) return `${nameOf(a.member_id)}님 Claude`;
  if (u.assignee_kind === 'member') return '구성원 Claude';
  return u.state === 'active' ? '모을 사람 없음' : '—';
}
