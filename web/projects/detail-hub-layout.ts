// projects/detail-hub-layout.ts — 프로젝트 상세 «도구 위젯 허브»의 **배치 모델**(#3916, 2026-09-14 원준 결정).
//  화면(detail-hub.ts)과 분리한 순수 로직: 도구·크기 어휘, 기본 한 벌, 프리셋, 저장·복원, 정규화.
//
//  원칙(캔버스 뷰 폐기 #1719 에서 배운 둘을 규칙으로):
//   ① **들어오면 이미 채워져 있다** — 기본 한 벌(HUB_DEFAULT)이 있고, 새 도구가 생기면 숨김이 아니라 기본 크기로 붙는다.
//   ② **배치는 내 계정 전역 한 벌** — 프로젝트마다 다르게는 사람이 「이 프로젝트에서만」을 켠 프로젝트에서만.
//  크기가 곧 뷰: S 1×1 «한눈» · M 2×1 «목록» · L 2×2 «조작» · XL 3×1 «띠». 격자는 3열 × 260px(37-projects-hub.css).
//  저장은 브라우저 localStorage(키 아래) — 서버 동기화는 후속(#1227 member_side_pref 와 같은 자리).

export type HubTool = 'tasks' | 'sessions' | 'body' | 'folder' | 'knowledge' | 'timeline';
export type HubSize = 's' | 'm' | 'l' | 'xl';
export interface HubItem { tool: HubTool; size: HubSize }
export interface HubLayout { v: 1; items: HubItem[]; hidden: HubTool[] }
export type HubScope = 'global' | 'project';

export const HUB_TOOLS: HubTool[] = ['tasks', 'sessions', 'body', 'folder', 'knowledge', 'timeline'];
export const HUB_SIZES: HubSize[] = ['s', 'm', 'l', 'xl'];
export const HUB_SIZE_LABEL: Record<HubSize, string> = { s: '한눈', m: '목록', l: '조작', xl: '띠' };
export const HUB_TOOL_LABEL: Record<HubTool, string> = {
  tasks: '태스크', sessions: '터미널 세션', body: '본문', folder: '공유 폴더', knowledge: '연결된 지식', timeline: '작업 타임라인',
};

const item = (tool: HubTool, size: HubSize): HubItem => ({ tool, size });

/** 기본 한 벌 — 태스크 L · 세션 S · 본문 S · 폴더 M · 지식 S · 타임라인 XL (12칸, 빈틈 0). */
export const HUB_DEFAULT: HubLayout = {
  v: 1,
  items: [item('tasks', 'l'), item('sessions', 's'), item('body', 's'), item('folder', 'm'), item('knowledge', 's'), item('timeline', 'xl')],
  hidden: [],
};

/** 프리셋 — 편집의 «시작점». 고르면 순서·크기 한 벌이 통째로 바뀐다(숨김은 풀린다). */
export const HUB_PRESETS: { id: string; label: string; items: HubItem[] }[] = [
  { id: 'default', label: '기본', items: HUB_DEFAULT.items },
  { id: 'tasks', label: '태스크 중심', items: [item('tasks', 'xl'), item('sessions', 's'), item('body', 's'), item('knowledge', 's'), item('folder', 'm'), item('timeline', 's')] },
  { id: 'sessions', label: '세션 중심', items: [item('sessions', 'l'), item('tasks', 's'), item('knowledge', 's'), item('body', 'm'), item('timeline', 's'), item('folder', 'xl')] },
  { id: 'reading', label: '읽기 중심', items: [item('body', 'l'), item('knowledge', 's'), item('sessions', 's'), item('tasks', 'm'), item('folder', 's'), item('timeline', 'xl')] },
];

const KEY_GLOBAL = 'lively_hub_layout';
const keyProject = (pid: number | string): string => 'lively_hub_layout_' + pid;
const keyScope = (pid: number | string): string => 'lively_hub_scope_' + pid;

function isTool(x: unknown): x is HubTool { return typeof x === 'string' && (HUB_TOOLS as string[]).includes(x); }
function isSize(x: unknown): x is HubSize { return typeof x === 'string' && (HUB_SIZES as string[]).includes(x); }

/** 저장본을 믿지 않는다 — 모르는 도구·크기는 버리고, 빠진 도구는 **기본 크기로 끝에 붙인다**(숨기지 않는다: 원칙 ①). */
export function normalizeHubLayout(raw: unknown): HubLayout {
  const out: HubLayout = { v: 1, items: [], hidden: [] };
  const seen = new Set<HubTool>();
  const r = (raw && typeof raw === 'object') ? raw as { items?: unknown; hidden?: unknown } : {};
  if (Array.isArray(r.items)) {
    for (const it of r.items) {
      const t = it && (it as { tool?: unknown }).tool, s = it && (it as { size?: unknown }).size;
      if (!isTool(t) || seen.has(t)) continue;
      seen.add(t);
      out.items.push(item(t, isSize(s) ? s : (HUB_DEFAULT.items.find((d) => d.tool === t) as HubItem).size));
    }
  }
  if (Array.isArray(r.hidden)) for (const h of r.hidden) if (isTool(h) && !seen.has(h)) { seen.add(h); out.hidden.push(h); }
  for (const d of HUB_DEFAULT.items) if (!seen.has(d.tool)) out.items.push(item(d.tool, d.size));
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
  return { layout: raw ? normalizeHubLayout(raw) : { v: 1, items: HUB_DEFAULT.items.map((x) => ({ ...x })), hidden: [] }, scope };
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

/** 프리셋 적용 — 순서·크기를 통째로, 숨김은 푼다. */
export function applyHubPreset(presetId: string): HubLayout {
  const p = HUB_PRESETS.find((x) => x.id === presetId) || HUB_PRESETS[0];
  return normalizeHubLayout({ items: p.items, hidden: [] });
}

/** 지금 배치가 어느 프리셋과 같은가(순서·크기 모두) — 편집 띠의 프리셋 단추 표시용. 없으면 null. */
export function matchHubPreset(layout: HubLayout): string | null {
  if (layout.hidden.length) return null;
  const sig = layout.items.map((x) => x.tool + ':' + x.size).join(',');
  const hit = HUB_PRESETS.find((p) => p.items.map((x) => x.tool + ':' + x.size).join(',') === sig);
  return hit ? hit.id : null;
}

/** 좁은 폭(≤900)에선 한 열 — L·XL 은 M 의 뷰로, 나머진 그대로(격자 span 은 CSS 가 이미 1열로 눕힌다). */
export function effectiveHubSize(size: HubSize, narrow: boolean): HubSize {
  if (!narrow) return size;
  return size === 'l' || size === 'xl' ? 'm' : size;
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
export function resizeHubItem(layout: HubLayout, tool: HubTool, size: HubSize): HubLayout {
  if (!isSize(size)) return layout;   // 모르는 크기는 그대로(저장본·해시에서 온 값을 믿지 않는다)
  return { ...layout, items: layout.items.map((x) => (x.tool === tool ? { ...x, size } : x)) };
}
export function hideHubItem(layout: HubLayout, tool: HubTool): HubLayout {
  if (layout.hidden.includes(tool)) return layout;
  return { ...layout, items: layout.items.filter((x) => x.tool !== tool), hidden: [...layout.hidden, tool] };
}
export function showHubItem(layout: HubLayout, tool: HubTool): HubLayout {
  if (!layout.hidden.includes(tool)) return layout;
  const size = (HUB_DEFAULT.items.find((d) => d.tool === tool) as HubItem).size;
  return { ...layout, items: [...layout.items, item(tool, size)], hidden: layout.hidden.filter((h) => h !== tool) };
}
