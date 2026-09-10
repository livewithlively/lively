// v2/run-prefs.ts — 새 세션 실행 설정의 **기억**(localStorage)과 실행 노드 규칙. run-picker.ts · session-defaults.ts 가 나눠 쓰는 잎 모듈.
//
//  ── 기억 = 클래식 '새 AI 세션' 폼과 같은 키 ──
//  lively_term_create_prefs(사용자별 → 옛 전역 키 폴백). 그 모듈(terminal/session-form.ts)을 import 하지 않는 이유:
//  v2 → terminal 방향의 런타임 의존을 만들지 않으려고(check-imports 순환 게이트). 키 규약만 공유한다.
//
//  ── 새 세션 기본값(#3778 안 C, 원준 2026-09-09) ──
//  홈·프로젝트 컴포저의 [⚙]는 **기본값 편집**이다 — 실행 컴퓨터·라이블리 모드·실행 승인·기록 범위. 세션마다 다르게
//  열 길은 두지 않는다(그건 클래식 폼의 몫). 종전엔 이 넷 중 자동 승인만 클래식 폼의 마지막 값이 **말없이** 따라왔고
//  (quick-session.ts), 모드는 늘 일반이었다. 이제 넷 다 여기 한 곳에서 읽고 [⚙]가 그 값을 보여 준다.
//  ⚠ 실행 컴퓨터의 기본은 여전히 **규칙**(#2172 — 켜진 내 컴퓨터 > 켜진 공유 컴퓨터 > 중앙)이다. 사람이 기본값 창에서
//   «항상 중앙» 이나 특정 노드를 고른 경우만 그 값을 쓰고, 고른 노드가 꺼져 있으면 규칙으로 돌아간다.
import { state } from '../core.js';

// 실행 노드(#869·#1744) — 서버 /terminal/config 의 cfg.nodes 그대로. harnesses = 그 PC 가 띄울 수 있는 하네스 키(미보고면 기준선).
export interface RunNode {
  id: string; name?: string; kind?: string; shared?: boolean; online?: boolean; harnesses?: string[];
  // #2172 — 기본 노드 규칙이 쓰는 두 값. mine=내 소유인가(shared 와 직교: 내 노드를 관리자가 공유로 지정할 수 있다),
  //  connectedAt=지금 연결이 붙은 시각(ms, 오프라인이면 null). 구 게이트웨이는 둘 다 안 준다 → 아래에서 폴백한다.
  mine?: boolean; connectedAt?: number | null;
  // #3833 — 그 노드에서 **지금 돌고 있는 세션 수**. 내 컴퓨터끼리 동률일 때 «내가 실제로 쓰는 곳» 을 고르는 축.
  sessions?: number;
}

/** 내 소유인가 — 구 게이트웨이(mine 미보고)면 '공유가 아니면 내 것'으로 본다(서버가 내 소유 ∪ 공유만 주므로 정확한 폴백). */
const nodeIsMine = (n: RunNode): boolean => (typeof n.mine === 'boolean' ? n.mine : !n.shared);

/** 이 칸이 후보로 삼는 하네스인가 — **셸은 AI 가 아니다**(이 칸은 '무엇에게 시킬까'를 묻는다). */
export const isAiHarness = (key: string): boolean => key !== 'shell';

/**
 * 이 노드로 **AI 세션을 열 수 있나**(#2172 후속) — 그 PC 가 보고한 하네스에 AI 가 하나라도 있나.
 *  미보고(구 번들)는 '제한 없음'으로 본다 — nodeAllow() 와 **같은 규칙**이라야 목록과 기본값이 갈리지 않는다.
 *  ⚠ 이게 없으면 defaultNodeId 가 **AI 가 하나도 없는 PC 를 기본으로 뽑는다**(실측 윤상민 2026-08-28: 윈도우 PC 가 shell 만
 *   보고하는데 그게 기본이 되어 세 칸이 잠긴 채 기억해 둔 하네스로만 열렸다).
 */
export const nodeCanRunAi = (n: RunNode): boolean =>
  !Array.isArray(n.harnesses) || !n.harnesses.length || n.harnesses.some(isAiHarness);

/**
 * 새 세션의 **기본 실행 노드**(#2172) — 켜져 있는 내 컴퓨터 > 켜져 있는 공유 컴퓨터 > 중앙('').
 *  후보에서 빠지는 것 둘 — ⓐ 꺼진 노드(서버 409) ⓑ AI 를 하나도 못 띄우는 노드(nodeCanRunAi). 사람이 직접 고르는 건 그대로 된다.
 *
 *  ── 동률 깨기(#3833, 2026-09-09) ──
 *  내 컴퓨터가 둘 이상 켜져 있으면 **지금 세션이 많이 돌고 있는 쪽**이 이긴다. 종전 기준은 connectedAt(가장 최근에
 *  붙은 것) 하나였는데, 그것은 «내가 어디서 일하나» 를 재는 값이 아니었다 — 게이트웨이가 재시작하면 전 노드가
 *  **동시에** 재접속하므로(실측 2026-09-09: 두 노드의 connectedAt 이 134ms 차) 사실상 핸드셰이크 경주 결과가
 *  기본 컴퓨터를 정했다. 그래서 세션 23개가 도는 맥북을 두고 세션 0개인 PC 가 기본으로 뽑혔다(윤상민 신고).
 *  connectedAt 은 마지막 동률 깨기로 남는다(둘 다 세션 0인 경우).
 *  ⚠ 세션 수 축은 **내 컴퓨터끼리만** 쓴다 — 공유 컴퓨터는 남의 세션도 세므로 그 수가 «내가 쓰는 곳» 을 뜻하지 않는다.
 */
export function defaultNodeId(nodes: RunNode[]): string {
  const live = nodes.filter((n) => n.online && nodeCanRunAi(n));
  if (!live.length) return '';
  const rank = (n: RunNode): number => (nodeIsMine(n) ? 1 : 0);
  const best = live.slice().sort((a, b) =>
    rank(b) - rank(a)
    || (rank(a) === 1 ? (b.sessions || 0) - (a.sessions || 0) : 0)
    || (b.connectedAt || 0) - (a.connectedAt || 0))[0];
  return best ? best.id : '';
}

/** 기본값 창의 «실행 컴퓨터» 값 — '' = 규칙대로 · 'central' = 항상 중앙 · 그 밖 = 노드 id. */
export const NODE_CENTRAL = 'central';
/** 왜 고른 컴퓨터가 아닌 데서 열리는가 — 화면이 그 사실을 **말할 수 있게** 사유를 함께 낸다(#3833). */
export interface NodeFallback { id: string; name: string; why: 'offline' | 'gone' | 'no-ai' }
export interface NodeChoice { id: string; fellBack: NodeFallback | null }
/**
 * 기본값 설정을 실제 노드 id 로 — 고른 노드가 꺼졌거나 사라졌으면 규칙(#2172)으로 돌아간다. '' = 중앙.
 *  폴백은 **조용히 하지 않는다**: 사람이 «이 컴퓨터에서» 라고 골라 둔 것을 화면이 말없이 바꾸면, 딴 PC 에서 열린
 *  세션을 보고서야 알게 된다(윤상민 2026-09-09 — 그마저도 «왜?» 가 화면 어디에도 없었다).
 */
export function resolveNodeChoice(nodes: RunNode[], pref: string): NodeChoice {
  if (pref === NODE_CENTRAL) return { id: '', fellBack: null };
  if (pref) {
    const n = nodes.find((x) => x.id === pref);
    if (n && n.online && nodeCanRunAi(n)) return { id: n.id, fellBack: null };
    const why: NodeFallback['why'] = !n ? 'gone' : !n.online ? 'offline' : 'no-ai';
    return { id: defaultNodeId(nodes), fellBack: { id: pref, name: (n && n.name) || pref, why } };
  }
  return { id: defaultNodeId(nodes), fellBack: null };
}
/** 위의 id 만 — 사유가 필요 없는 자리(칸 그리기·하네스 거르기)가 쓴다. */
export function resolveNodeDefault(nodes: RunNode[], pref: string): string {
  return resolveNodeChoice(nodes, pref).id;
}

const PREFS_KEY = 'lively_term_create_prefs';
const prefsKey = (): string => PREFS_KEY + '::' + ((state.me && (state.me.userId || state.me.email)) || 'anon');
export interface RunPrefs {
  harness?: string; flags?: Record<string, string>; autoApprove?: boolean; node?: string;
  // #3778 새 세션 기본값 — 컴포저 [⚙]가 편집한다. 클래식 폼은 이 셋을 안 읽는다(자기 스냅샷을 쓴다).
  nodeDefault?: string; mode?: string; writeVis?: string;
  [k: string]: unknown;
}
export function runPrefs(): RunPrefs {
  try {
    const raw = localStorage.getItem(prefsKey()) || localStorage.getItem(PREFS_KEY) || '{}';
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? p : {};
  } catch { return {}; }
}
/** 고른 값을 **덧쓴다**(통째 교체 아님) — 폼이 기억해 둔 나머지(스냅샷 등)를 지우지 않는다. */
export function saveRunPrefs(patch: RunPrefs): void {
  try { localStorage.setItem(prefsKey(), JSON.stringify({ ...runPrefs(), ...patch })); } catch { /* localStorage 불가 — 기억만 못 할 뿐 */ }
}

export type LivelyMode = 'normal' | 'readonly' | 'incognito';
export const MODE_OPTS: { key: LivelyMode; lbl: string; sub: string }[] = [
  { key: 'normal', lbl: '일반', sub: '라이블리를 읽고 씀' },
  { key: 'readonly', lbl: '읽기전용', sub: '읽되 기록하지 않음 · 기밀 작업' },
  { key: 'incognito', lbl: '인코그니토', sub: '라이블리를 전혀 안 씀 · 클린룸' },
];
// 기록 범위 선택지(#3778 재검증, 2026-09-10) — **실제 강제 지점 한 곳**(capabilities/activity.ts)에 맞춘 문구다.
//  거기서 하는 일은 «이 세션이 작업 기록을 어느 프로젝트에 붙일 수 있나» 하나뿐이다. 값이 open 이 아니면,
//  회사 전체가 볼 수 있는 프로젝트에 기록하려 할 때 400 으로 막는다(좁히는 것이 아니라 막는다).
//  ⚠ 그래서 audience 와 private 는 **지금 동작이 같다**(둘 다 «open 이 아님»으로만 쓰인다). 종전 문구는
//   «그 팀만 봄 / 나만 봄» 이라 보는 사람이 달라지는 것처럼 읽혔는데, 그런 구분은 이 축에 없다.
//   값을 지우면 그 설정을 가진 사람의 세션이 조용히 바뀌므로 선택지는 넷 다 남기고 **문구로 사실을 말한다**.
//  ⚠ 지식 저장(knowledge_save)은 이 값을 보지 않는다 — 이 축이 닿는 곳은 작업 기록뿐이다.
export const WRITE_VIS_OPTS: { v: string; t: string; d: string }[] = [
  { v: '', t: '자동', d: '세션이 열린 폴더를 따름' },
  { v: 'open', t: '제한 없음', d: '어느 프로젝트에나 기록' },
  { v: 'audience', t: '공개 프로젝트 제외', d: '전체 공개 프로젝트에는 기록 안 함' },
  { v: 'private', t: '공개 프로젝트 제외 (같음)', d: '위와 동작이 같음' },
];
export interface SessionDefaults { nodeDefault: string; mode: LivelyMode; autoApprove: boolean; writeVis: string }
/** 새 세션 기본값 — 기억이 없거나 모르는 값이면 안전한 쪽(규칙대로 · 일반 · 확인 후 실행 · 자동). */
export function sessionDefaults(): SessionDefaults {
  const p = runPrefs();
  const mode = MODE_OPTS.some((m) => m.key === p.mode) ? (p.mode as LivelyMode) : 'normal';
  const writeVis = WRITE_VIS_OPTS.some((o) => o.v === p.writeVis) ? String(p.writeVis) : '';
  return { nodeDefault: typeof p.nodeDefault === 'string' ? p.nodeDefault : '', mode, autoApprove: p.autoApprove === true, writeVis };
}
export function saveSessionDefaults(d: SessionDefaults): void {
  saveRunPrefs({ nodeDefault: d.nodeDefault, mode: d.mode, autoApprove: d.autoApprove, writeVis: d.mode === 'normal' ? d.writeVis : '' });
}
