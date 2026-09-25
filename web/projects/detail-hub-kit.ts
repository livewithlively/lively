// projects/detail-hub-kit.ts — 프로젝트 허브 위젯들이 같이 쓰는 **부품과 계약**(#3916·#4164·#4135).
//  detail-hub.ts(격자·편집 모드)와 위젯 채움 모듈(detail-hub-tasks·detail-hub-sessions …)이 여기서 같은 아이콘·단추·줄·세션 상태를 받는다.
//  ⚠ 리프만 문다(core · lib/session-open · v2/sess-tail · session-status · popover · detail-hub-layout 타입). 섹션 모듈은 detail.ts 가 공장(HubOpts)으로 넘긴다.
import { el, sv } from '../core.js';
import { openSessionWindow } from '../lib/session-open.js';
import { fetchTurns } from '../v2/sess-tail.js';
import { SESS_STATES, rowDotCls, sessRank, sessStateKey } from '../session-status.js';
import type { HubTool, HubView } from './detail-hub-layout.js';

export type HubSectionFactory = () => HTMLElement;
/** 태스크 목록 공장(#4135) — detail-tasks.pjvTasksSection 을 옵션과 함께 부른다(허브는 그 모듈을 직접 못 문다 — 배럴 순환). */
export interface HubTasksListOpts {
  chrome: false;
  groups: Array<{ key: string; label: string; status: 'todo' | 'in_progress' | 'done'; tasks: any[]; add?: boolean }>;
  cap?: number[];
  onMore?: () => void;
  rowOpts?: { assigneeNames?: boolean };
  fields?: any[];
}
export interface HubOpts {
  id: number;
  p: any;                       // GET /api/ui/v6/projects/:id 의 프로젝트(tasks · knowledge · description · updated_at …)
  members: any[];
  reload: () => void;           // 상세 전체 재렌더(기존 섹션들이 쓰는 그 reload)
  base: string;                 // '/api/ui/v6/projects/'
  sections: Record<HubTool, HubSectionFactory>;   // «열기»(전폭)와 아직 위젯화 안 된 도구가 앉히는 기존 섹션 카드
  inModal: boolean;             // .pjv-pm 안이면 열기는 제자리 전환
  focus: HubTool | null;        // 주소가 가리키는 «열기» 도구(페이지)
  actionsHost?: HTMLElement;    // [배치 편집] 단추를 앉힐 자리(뒤로 줄 오른쪽)
  openTask?: (taskId: number) => void;   // 태스크 줄 → 태스크 모달(#4165 — 세션으로 바로 넘어가지 않는다). 없으면 주소로
  goTask?: (t: any) => void;             // 태스크 줄 호버 [작업 공간] — 맡은 세션으로, 없으면 그 태스크로 새 세션(#4165)
  meId?: string;                          // 보는 사람(«내 것» 필터)
  tasksList?: (opts: HubTasksListOpts) => HTMLElement;   // 프로젝트 탭 태스크 목록을 옵션으로(5판 «줄을 그대로 쓴다»)
  newSession?: () => void;                // 「＋ 새 세션」 — 프로젝트 세션 만들기 모달
  sessionLog?: () => void;                // 「세션 기록」 — 끝난 세션까지의 대화록 모달
}

/** 허브가 한 번 받아 위젯에 나눠 주는 데이터(같은 화면에서 같은 것을 두 번 묻지 않는다). invalidate 로 한 키를 다시 받게 한다. */
export interface HubData {
  sessions: () => Promise<any[]>;
  files: () => Promise<any[]>;
  acts: () => Promise<any[]>;
  comments: () => Promise<any[]>;
  recs: () => Promise<any[]>;
  invalidate: (key: 'sessions' | 'files' | 'acts' | 'comments' | 'recs') => void;
}
export interface HubCtx {
  pid: number;
  P: any;
  o: HubOpts;
  D: HubData;
  meId: string;
  narrow: boolean;
  openTool: (tool: HubTool | null) => void;
  memberName: (mid: string) => string;
  refreshGrid: () => void;      // 위젯 하나가 상태를 바꾼 뒤 격자를 다시 그린다(설정 변경 · 붙이기 뒤)
}
export type Fit = { view: HubView; w: number; h: number; cap: number };
export type Fill = (ctx: HubCtx, f: Fit, body: HTMLElement, foot: HTMLElement, sub: HTMLElement, acts: HTMLElement) => void;

// ── 아이콘 — 24 그리드 · 획 1.7(projects/icons.ts 톤) ─────────────────────────
export const HUB_ICON: Record<string, string> = {
  tasks: '<path d="M4 6.5h9M4 12h9M4 17.5h6"/><path d="M15 12.5l2.4 2.4L22 10"/>',
  sessions: '<path d="M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12z"/>',
  body: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  knowledge: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5"/><path d="M8 7h7"/>',
  timeline: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  right: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  left: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  chevr: '<path d="M9.5 6.5 15 12l-5.5 5.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8"/>',
  comment: '<path d="M5 4h14v11l-5 5H5z"/><path d="M14 20v-5h5"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  chev: '<path d="M6.5 9.5 12 15l5.5-5.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  // 작업 공간(세션) — 터미널 창 + 프롬프트. 새로 여는 쪽은 우상단 ＋ 배지(selection.ts pjvActIcon('session') 과 같은 붓).
  term: '<rect x="2.5" y="4.5" width="19" height="15" rx="2.6"/><path d="M6.8 9.6l3 2.6-3 2.6"/><path d="M12.4 15h4.4"/>',
  termnew: '<rect x="1.5" y="4.5" width="16" height="14" rx="2.4"/><path d="M5.2 9.4l3 2.6-3 2.6"/><path d="M10.6 15.4h3.8"/><path d="M20.6 2.6v5"/><path d="M18.1 5.1h5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7L12.5 19.5"/>',
};
export const TOOL_TONE: Record<HubTool, string> = { tasks: 'amber', sessions: 'mint', body: '', folder: 'blue', knowledge: 'mint', timeline: '' };
export function hubIcon(name: string, size = 14): SVGElement {
  const n = sv('svg', { class: 'pjh-ic', viewBox: '0 0 24 24', 'aria-hidden': 'true', style: 'width:' + size + 'px;height:' + size + 'px' });
  n.innerHTML = HUB_ICON[name] || HUB_ICON.doc;
  return n;
}

// ── 작은 부품 ─────────────────────────────────────────────────────────────────
export const btn = (label: string, kind = 'btn-ghost', onclick?: (e: Event) => void, extra?: any): HTMLButtonElement =>
  el('button', { class: 'btn btn-sm ' + kind, type: 'button', text: label, onclick, ...(extra || {}) }) as HTMLButtonElement;
export const stripMd = (md: string): string => String(md || '')
  .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/^#{1,6}\s+/gm, '').replace(/^>\s?/gm, '').replace(/[*_`]+/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/\s+/g, ' ').trim();
export const lastHeading = (md: string): string | null => {
  const hs = String(md || '').split('\n').filter((l) => /^#{1,6}\s+\S/.test(l));
  return hs.length ? hs[hs.length - 1].replace(/^#{1,6}\s+/, '').trim() : null;
};
export function ring(pct: number, s = 52, sw = 6): SVGElement {
  const r = (s - sw) / 2, c = 2 * Math.PI * r;
  const n = sv('svg', { class: 'pjh-ring', viewBox: '0 0 ' + s + ' ' + s, style: 'width:' + s + 'px;height:' + s + 'px', 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: s / 2, cy: s / 2, r, fill: 'none', stroke: 'var(--line-net)', 'stroke-width': sw }));
  n.append(sv('circle', { cx: s / 2, cy: s / 2, r, fill: 'none', stroke: 'var(--mint-fill)', 'stroke-width': sw, 'stroke-linecap': 'round',
    'stroke-dasharray': (c * Math.max(0, Math.min(1, pct))).toFixed(1) + ' ' + c.toFixed(1), transform: 'rotate(-90 ' + s / 2 + ' ' + s / 2 + ')' }));
  return n;
}
export const big = (n: string | number, unit: string, lead?: HTMLElement | SVGElement): HTMLElement =>
  el('div', { class: 'pjh-big' }, lead || null, String(n), el('small', { text: unit }));
export const stat = (...kids: any[]): HTMLElement => el('div', { class: 'pjh-stat' }, ...kids);
export const row = (...kids: any[]): HTMLElement => el('div', { class: 'pjh-row' }, ...kids);
export const emptyNote = (text: string): HTMLElement => el('div', { class: 'pjh-stat', style: 'padding:6px 2px', text });
/** 목록이 넘칠 때 마지막 줄 — «… N개 더» 를 누르면 그 도구 전폭(열기)으로. */
export const moreNote = (text: string, onclick: () => void): HTMLElement =>
  el('button', { class: 'pjh-more', type: 'button', text: '… ' + text, onclick });
export const footText = (text: string): HTMLElement => el('span', { class: 'pjh-wf-txt', text });

// ── 세션 상태 — 단일 어휘(web/session-status.ts): 확인 필요 · 작업 완료 · 작업 중 · 대기 중 · 오프라인 · 셸 · 중단됨 · 메모리 부족 · 종료됨 ──
export interface SessView { key: string; label: string; dot: string; live: boolean; rank: number }
export function sessView(s: any, nowMs = Date.now()): SessView {
  const key = sessStateKey(s, nowMs);
  const meta = SESS_STATES[key] || SESS_STATES.shell;
  //  «사용 중» = 지금 탭에 열려 있거나 돌고 있거나 나를 기다리는 것(확인 필요·작업 완료·작업 중·대기 중). 오프라인·셸·끝난 것은 «최근».
  const live = key === 'waiting' || key === 'busy' || key === 'done' || key === 'idle';
  return { key, label: meta.label, dot: rowDotCls(key), live, rank: sessRank(s, nowMs) };
}
export const sessDot = (v: SessView): HTMLElement =>
  v.dot === 'busy' ? el('span', { class: 'pjh-pulse', title: v.label }) : el('span', { class: 'pjh-dot ' + (v.dot === 'quiet' ? 'off' : v.dot), title: v.label });
/** 세션 «입장» — 세션 터미널로 가는 단 하나의 문(lib/session-open, #1820): 죽은 세션 복원은 도착지가 책임진다. */
export const enterSession = (s: any): void => { openSessionWindow(String(s.id), { label: s.label, node: s.node && s.node.id ? String(s.node.id) : null }); };
/** 도는 세션의 마지막 AI 줄 — v2 셸의 꼬리 읽기(v2/sess-tail)를 빌린다. 좌표(uuid·노드)가 없으면 빈 채로 둔다(꾸미지 않는다). */
export async function lastLine(s: any, max = 180): Promise<string> {
  try {
    const onNode = !!(s.node && s.node.id);
    const adapted: any = { id: s.id, live: !!s.attached && !onNode, node: onNode ? s.node.id : undefined, raw: s };
    const turns = await fetchTurns(adapted, 6000);
    const ai = [...turns].reverse().find((t) => t.who === 'ai' && t.text.trim().length > 2);
    return ai ? ai.text.trim().replace(/\s+/g, ' ').slice(0, max) : '';
  } catch (_) { return ''; }
}
/** 마지막 몇 턴(사람·AI) — 3×2 세션 위젯의 «마지막 줄» 칸. */
export async function lastTurns(s: any, n = 4): Promise<Array<{ who: string; text: string }>> {
  try {
    const onNode = !!(s.node && s.node.id);
    const adapted: any = { id: s.id, live: !!s.attached && !onNode, node: onNode ? s.node.id : undefined, raw: s };
    const turns = await fetchTurns(adapted, 12000);
    return turns.filter((t) => t.text.trim().length > 0).slice(-n).map((t) => ({ who: t.who, text: t.text.trim().replace(/[ \t]+/g, ' ').slice(0, 400) }));
  } catch (_) { return []; }
}
