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
 *  같은 등급이면 **가장 최근에 붙은 것**. connectedAt 을 안 주는 구 게이트웨이에서는 서버가 준 목록 순서를 따른다.
 *  후보에서 빠지는 것 둘 — ⓐ 꺼진 노드(서버 409) ⓑ AI 를 하나도 못 띄우는 노드(nodeCanRunAi). 사람이 직접 고르는 건 그대로 된다.
 */
export function defaultNodeId(nodes: RunNode[]): string {
  const live = nodes.filter((n) => n.online && nodeCanRunAi(n));
  if (!live.length) return '';
  const best = live.slice().sort((a, b) =>
    (nodeIsMine(b) ? 1 : 0) - (nodeIsMine(a) ? 1 : 0) || (b.connectedAt || 0) - (a.connectedAt || 0))[0];
  return best ? best.id : '';
}

/** 기본값 창의 «실행 컴퓨터» 값 — '' = 규칙대로 · 'central' = 항상 중앙 · 그 밖 = 노드 id. */
export const NODE_CENTRAL = 'central';
/** 기본값 설정을 실제 노드 id 로 — 고른 노드가 꺼졌거나 사라졌으면 규칙(#2172)으로 돌아간다. '' = 중앙. */
export function resolveNodeDefault(nodes: RunNode[], pref: string): string {
  if (pref === NODE_CENTRAL) return '';
  if (pref) {
    const n = nodes.find((x) => x.id === pref);
    if (n && n.online && nodeCanRunAi(n)) return n.id;
  }
  return defaultNodeId(nodes);
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
export const WRITE_VIS_OPTS: { v: string; t: string; d: string }[] = [
  { v: '', t: '자동', d: '실행 폴더를 따름' },
  { v: 'open', t: '전체 공개', d: '누구나 봄' },
  { v: 'audience', t: '프로젝트', d: '그 팀만 봄' },
  { v: 'private', t: '나만', d: '나만 봄' },
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
