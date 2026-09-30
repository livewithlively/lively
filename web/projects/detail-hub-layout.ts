// projects/detail-hub-layout.ts — 프로젝트 상세 «도구 위젯 허브»의 **배치 모델**(#3916, 2026-09-14 원준 결정).
//  화면(detail-hub.ts)과 분리한 순수 로직: 도구·크기 어휘, 기본 한 벌, 프리셋, 저장·복원, 정규화.
//
//  원칙(캔버스 뷰 폐기 #1719 에서 배운 둘을 규칙으로):
//   ① **들어오면 이미 채워져 있다** — 기본 한 벌(HUB_DEFAULT)이 있고, 새 도구가 생기면 숨김이 아니라 기본 크기로 붙는다.
//   ② **배치는 내 계정 전역 한 벌** — 프로젝트마다 다르게는 사람이 「이 프로젝트에서만」을 켠 프로젝트에서만.
//  #4164(2026-09-23 원준): 크기는 S·M·L·XL 네 칸이 아니라 **가로 w × 세로 h 를 자유롭게**(w 1~3 · h 1~HUB_MAX_H) —
//   "태스크는 애초에 세로형 목록인데 XL 이 세로로 못 늘어나는 게 말이 되냐 · n×n 을 자연스럽게 다 고르게".
//   뷰는 크기에서 나온다(hubView): 1×1 «한눈» · 1×N·2×1 «목록» · 3×1 «띠» · 2×2 이상 «전체»(기존 섹션). 격자는 3열 × 260px.
//  옛 저장본(v1, size 's'|'m'|'l'|'xl')은 정규화가 그 칸 수 그대로 옮긴다 — s 1×1 · m 2×1 · l 2×2 · xl 3×1.
//  저장은 브라우저 localStorage(키 아래) — 서버 동기화는 후속(#1227 member_side_pref 와 같은 자리).

export type HubTool = 'tasks' | 'sessions' | 'body' | 'folder' | 'knowledge' | 'timeline';
export interface HubItem { tool: HubTool; w: number; h: number }
export interface HubLayout { v: 2; items: HubItem[]; hidden: HubTool[] }
export type HubScope = 'global' | 'project';
export type HubView = 'glance' | 'list' | 'band' | 'full';

export const HUB_TOOLS: HubTool[] = ['tasks', 'sessions', 'body', 'folder', 'knowledge', 'timeline'];
export const HUB_COLS = 3;
export const HUB_MAX_H = 6;
export const HUB_VIEW_LABEL: Record<HubView, string> = { glance: '한눈', list: '목록', band: '띠', full: '전체' };
export const HUB_TOOL_LABEL: Record<HubTool, string> = {
  tasks: '태스크', sessions: '터미널 세션', body: '본문', folder: '공유 폴더', knowledge: '연결된 지식', timeline: '작업 타임라인',
};

const item = (tool: HubTool, w: number, h: number): HubItem => ({ tool, w, h });

/** 도구마다 «처음 붙을 때» 크기 — 숨겼다 되살리거나, 저장본에 없던 새 도구가 붙을 때 쓴다. */
export const HUB_TOOL_DEFAULT: Record<HubTool, { w: number; h: number }> = {
  tasks: { w: 1, h: 3 }, sessions: { w: 1, h: 1 }, body: { w: 2, h: 2 }, folder: { w: 1, h: 1 }, knowledge: { w: 1, h: 1 }, timeline: { w: 3, h: 1 },
};

/** 기본 한 벌(#4164 회의 2026-09-21) — 본문이 먼저 보이고(2×2), 태스크는 사이드바 폭으로 길게(1×3).
 *  세션 목록은 «내용» 이 아니라서 기본에선 뺀다(태스크 = 세션이라 태스크에서 들어간다) — 「＋ 위젯」으로 되살린다.
 *  본문 2×2 · 태스크 1×3 · 지식 1×1 · 폴더 1×1 · 타임라인 3×1 = 12칸, 빈틈 0. */
export const HUB_DEFAULT: HubLayout = {
  v: 2,
  items: [item('body', 2, 2), item('tasks', 1, 3), item('knowledge', 1, 1), item('folder', 1, 1), item('timeline', 3, 1)],
  hidden: ['sessions'],
};

/** 프리셋 — 편집의 «시작점». 고르면 순서·크기·숨김 한 벌이 통째로 바뀐다. 전부 12칸을 빈틈 없이 채운다. */
export const HUB_PRESETS: { id: string; label: string; items: HubItem[]; hidden: HubTool[] }[] = [
  { id: 'default', label: '기본', items: HUB_DEFAULT.items, hidden: HUB_DEFAULT.hidden },
  { id: 'tasks', label: '태스크 중심', hidden: [],
    items: [item('tasks', 2, 3), item('body', 1, 1), item('knowledge', 1, 1), item('sessions', 1, 1), item('folder', 1, 1), item('timeline', 2, 1)] },
  { id: 'sessions', label: '세션 중심', hidden: [],
    items: [item('sessions', 3, 2), item('tasks', 1, 2), item('body', 1, 1), item('knowledge', 1, 1), item('folder', 1, 1), item('timeline', 1, 1)] },
  { id: 'reading', label: '읽기 중심', hidden: [],
    items: [item('body', 2, 3), item('tasks', 1, 2), item('knowledge', 1, 1), item('folder', 1, 1), item('timeline', 1, 1), item('sessions', 1, 1)] },
];

const LEGACY: Record<string, { w: number; h: number }> = { s: { w: 1, h: 1 }, m: { w: 2, h: 1 }, l: { w: 2, h: 2 }, xl: { w: 3, h: 1 } };

const KEY_GLOBAL = 'lively_hub_layout';
const keyProject = (pid: number | string): string => 'lively_hub_layout_' + pid;
const keyScope = (pid: number | string): string => 'lively_hub_scope_' + pid;

function isTool(x: unknown): x is HubTool { return typeof x === 'string' && (HUB_TOOLS as string[]).includes(x); }
const isSpan = (x: unknown, max: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= max;

/** 저장본 한 칸의 크기 — w·h 가 온전하면 그것, 옛 size 면 그 칸 수, 아니면 null(→ 그 도구의 기본 크기). */
function spanOf(raw: unknown): { w: number; h: number } | null {
  const r = (raw && typeof raw === 'object') ? raw as { w?: unknown; h?: unknown; size?: unknown } : {};
  if (isSpan(r.w, HUB_COLS) && isSpan(r.h, HUB_MAX_H)) return { w: r.w, h: r.h };
  if (typeof r.size === 'string' && LEGACY[r.size]) return { ...LEGACY[r.size] };
  return null;
}

/** 저장본을 믿지 않는다 — 모르는 도구·크기는 버리고, 빠진 도구는 **기본 크기로 끝에 붙인다**(원칙 ①).
 *  단 기본 한 벌이 숨긴 도구(세션)는 저장본에도 없으면 숨김으로 둔다 — 새로 온 사람의 화면이 기본과 같아야 한다. */
export function normalizeHubLayout(raw: unknown): HubLayout {
  const out: HubLayout = { v: 2, items: [], hidden: [] };
  const seen = new Set<HubTool>();
  const r = (raw && typeof raw === 'object') ? raw as { items?: unknown; hidden?: unknown } : {};
  const known = Array.isArray(r.items) || Array.isArray(r.hidden);
  if (Array.isArray(r.items)) {
    for (const it of r.items) {
      const t = it && (it as { tool?: unknown }).tool;
      if (!isTool(t) || seen.has(t)) continue;
      seen.add(t);
      const sp = spanOf(it) || HUB_TOOL_DEFAULT[t];
      out.items.push(item(t, sp.w, sp.h));
    }
  }
  if (Array.isArray(r.hidden)) for (const h of r.hidden) if (isTool(h) && !seen.has(h)) { seen.add(h); out.hidden.push(h); }
  if (!known) return { v: 2, items: HUB_DEFAULT.items.map((x) => ({ ...x })), hidden: [...HUB_DEFAULT.hidden] };
  for (const t of HUB_TOOLS) {
    if (seen.has(t)) continue;
    if (HUB_DEFAULT.hidden.includes(t)) out.hidden.push(t);
    else out.items.push(item(t, HUB_TOOL_DEFAULT[t].w, HUB_TOOL_DEFAULT[t].h));
  }
  return out;
}

function readKey(key: string): unknown {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch (_) { return null; }
}
function writeKey(key: string, val: unknown): void {
  try { if (val == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(val)); } catch (_) { /* 저장 못 해도 화면은 선다 */ }
}

/** 이 프로젝트에서 쓸 배치 — 「이 프로젝트에서만」이 켜져 있으면 그 프로젝트 것, 아니면 전역 한 벌, 그것도 없으면 기본. */
export function loadHubLayout(pid: number | string): { layout: HubLayout; scope: HubScope } {
  const scope: HubScope = readKey(keyScope(pid)) === 'project' ? 'project' : 'global';
  const raw = scope === 'project' ? (readKey(keyProject(pid)) ?? readKey(KEY_GLOBAL)) : readKey(KEY_GLOBAL);
  return { layout: normalizeHubLayout(raw), scope };
}

export function saveHubLayout(pid: number | string, layout: HubLayout, scope: HubScope): void {
  const clean = normalizeHubLayout(layout);
  if (scope === 'project') { writeKey(keyScope(pid), 'project'); writeKey(keyProject(pid), clean); }
  else { writeKey(keyScope(pid), null); writeKey(keyProject(pid), null); writeKey(KEY_GLOBAL, clean); }
}

/** 「이 프로젝트에서만」 토글 — 켜면 지금 배치를 이 프로젝트 것으로 복사해 시작, 끄면 전역으로 돌아간다(프로젝트 것은 지운다). */
export function setHubScope(pid: number | string, scope: HubScope, current: HubLayout): { layout: HubLayout; scope: HubScope } {
  if (scope === 'project') { saveHubLayout(pid, current, 'project'); return { layout: normalizeHubLayout(current), scope }; }
  writeKey(keyScope(pid), null); writeKey(keyProject(pid), null);
  return loadHubLayout(pid);
}

export function resetHubLayout(pid: number | string, scope: HubScope): HubLayout {
  const fresh = normalizeHubLayout(HUB_DEFAULT);
  saveHubLayout(pid, fresh, scope);
  return fresh;
}

/** 프리셋 적용 — 순서·크기·숨김을 통째로. */
export function applyHubPreset(presetId: string): HubLayout {
  const p = HUB_PRESETS.find((x) => x.id === presetId) || HUB_PRESETS[0];
  return normalizeHubLayout({ items: p.items, hidden: p.hidden });
}

const sigOf = (items: HubItem[], hidden: HubTool[]): string =>
  items.map((x) => x.tool + ':' + x.w + 'x' + x.h).join(',') + '|' + [...hidden].sort().join(',');

/** 지금 배치가 어느 프리셋과 같은가(순서·크기·숨김 모두) — 편집 띠의 프리셋 단추 표시용. 없으면 null. */
export function matchHubPreset(layout: HubLayout): string | null {
  const sig = sigOf(layout.items, layout.hidden);
  const hit = HUB_PRESETS.find((p) => sigOf(p.items, p.hidden) === sig);
  return hit ? hit.id : null;
}

/** 크기 → 뷰. 좁은 폭(≤900, 한 열)에선 가로가 1칸뿐이라 «전체»·«띠» 는 목록으로 내린다(세로 h 는 목록 길이로 남는다). */
export function hubView(w: number, h: number, narrow = false): HubView {
  if (w <= 1 && h <= 1) return 'glance';
  if (narrow) return 'list';
  if (w >= 2 && h >= 2) return 'full';
  if (w >= HUB_COLS && h === 1) return 'band';
  return 'list';
}

/** 목록 뷰가 담을 줄 수 — 행 하나 ≈39px(.pjh-row 실측), 머리·바닥·여백 ≈146px. 1행(260px)은 종전처럼 다섯(넘치면 잘린다).
 *  넘치는 목록은 마지막 한 줄을 «… N개 더» 안내에 내준다(detail-hub.ts). */
export function hubListCap(h: number): number {
  return h <= 1 ? 5 : Math.max(5, Math.floor((h * 276 - 146) / 39));
}

/* 순서 바꾸기·크기 바꾸기·숨기기·되살리기 — 전부 새 배열을 돌려준다(원본 불변). */
export function moveHubItem(layout: HubLayout, tool: HubTool, before: HubTool | null): HubLayout {
  const me = layout.items.find((x) => x.tool === tool);
  if (!me || before === tool) return layout;   // 없는 도구 · 자기 자신 앞 = 변화 없음
  const items = layout.items.filter((x) => x.tool !== tool);
  const at = before ? items.findIndex((x) => x.tool === before) : -1;
  if (at < 0) items.push(me); else items.splice(at, 0, me);
  return { ...layout, items };
}
export function resizeHubItem(layout: HubLayout, tool: HubTool, w: number, h: number): HubLayout {
  if (!isSpan(w, HUB_COLS) || !isSpan(h, HUB_MAX_H)) return layout;   // 범위 밖은 그대로(저장본·해시에서 온 값을 믿지 않는다)
  return { ...layout, items: layout.items.map((x) => (x.tool === tool ? { ...x, w, h } : x)) };
}
export function hideHubItem(layout: HubLayout, tool: HubTool): HubLayout {
  if (!isTool(tool) || layout.hidden.includes(tool)) return layout;   // 모르는 도구를 숨김 목록에 들이지 않는다
  return { ...layout, items: layout.items.filter((x) => x.tool !== tool), hidden: [...layout.hidden, tool] };
}
export function showHubItem(layout: HubLayout, tool: HubTool): HubLayout {
  if (!layout.hidden.includes(tool)) return layout;
  const d = HUB_TOOL_DEFAULT[tool];
  return { ...layout, items: [...layout.items, item(tool, d.w, d.h)], hidden: layout.hidden.filter((h) => h !== tool) };
}
