// projects/status.ts — #1313 R31: web/projects.ts 분해 ②.
//  상태 체계 일체 — 프로젝트 상태 메타 · 리스트별 커스텀 상태(#475)와 스페이스 기본 스킴(#729) 로드/정규화 ·
//  렌더 스코프 레지스트리(리스트→defs · 프로젝트→리스트) · 상태 해석 · 진행도 아이콘 SVG(사이트 전역 단일 출처) ·
//  태스크 표준 상수(PJV_TASK_STATUS·PJV_PRIORITY)와 날짜 헬퍼.
//  ⚠ pjvSpaceDefaultDefs·pjvStatusTemplatesCache·pjvStatusReg·pjvProjListReg 은 이 모듈이 **단독 소유**한다 —
//   밖에서는 읽기만 하고(ESM live binding), 갱신은 pjvLoadStatusTemplates·pjvSetStatusRegistry·pjvRegisterProjList 로만.
import { api, el, sv } from '../core.js';

function pjvProjStatusMeta(status) {
  // 태스크 리스트와 동일한 3단계 — 할 일(점선 링)·진행 중(◐)·완료(✓ 민트).
  //  레거시·기본값 'active' 는 '진행 중'으로 흡수(표시만 — 기존 active 프로젝트가 진행 중에 그대로 보이게).
  if (status === 'done') return { key: 'done', label: '완료', cls: 'done', glyph: '✓' };
  if (status === 'todo') return { key: 'todo', label: '할 일', cls: 'todo', glyph: '' };
  return { key: 'in_progress', label: '진행 중', cls: 'inprog', glyph: '◐' };
}

// ══════════════════════════════════════════════════════════════════════════
// 리스트별 커스텀 상태(#475 Task statuses) — 고정 3버킷(할 일/진행 중/완료) 안에 사용자 정의 단계.
//  저장: project_list.settings.statusMode('inherit'|'custom') + settings.statuses[{key,label,color,category}].
//  프로젝트엔 status(CHECK 유효 네이티브 투영: todo|in_progress|done) + status_raw(커스텀 상태 키, 개방 어휘)로 저장.
// ══════════════════════════════════════════════════════════════════════════
// 기본(inherit) 상태 — 클릭업 3버킷(Active/Done/Closed) 표현: 할 일(점선)·진행 중 은 Active,
//  완료 는 Done, Closed 는 기본 비어있음. 커스텀 전환 시 이 세트가 출발점.
const PJV_DEFAULT_STATUS_DEFS = [
  { key: 'todo', label: '할 일', color: '#94a3b8', category: 'active' },
  { key: 'active', label: '진행 중', color: '#f59e0b', category: 'active' },
  { key: 'done', label: '완료', color: '#22c55e', category: 'done' },
];
// 카테고리(버킷) — 클릭업 상태 유형과 동일: Active(진행 파이) → Done(체크) → Closed(채운 체크). #499
const PJV_STATUS_CATS = [
  { key: 'active', label: 'Active' },
  { key: 'done', label: 'Done' },
  { key: 'closed', label: 'Closed' },
];
// 커스텀 상태 category → 저장할 네이티브 status(CHECK 유효 todo|in_progress|done).
//  Done·Closed 는 둘 다 네이티브 done(완료됨), 그 외(Active)는 in_progress. (todo 버킷은 Active 로 흡수 — #499)
function pjvNativeStatusOf(category) { return (category === 'done' || category === 'closed') ? 'done' : 'in_progress'; }
function pjvListIsCustomStatus(list) {
  const s = list && list.settings;
  return !!(s && s.statusMode === 'custom' && Array.isArray(s.statuses) && s.statuses.length);
}
// ── #729 스페이스(워크스페이스) 기본 상태 스킴 + 재사용 템플릿 ──────────────────────────────
//  리스트를 새로 만들 때마다 상태 체계를 재생성하던 문제 해소: is_default 템플릿이 '스페이스 기본'으로,
//  inherit(기본 상태 사용) 리스트가 이 스킴을 물려받는다(하드코딩 3단계 대신). project_status_template 를 로드해 캐시.
let pjvSpaceDefaultDefs: any[] | null = null;      // 스페이스 기본 defs(없으면 null=표준 3단계 폴백)
let pjvStatusTemplatesCache: any[] = [];           // 템플릿 목록(에디터·새 리스트 폼 드롭다운)
// 원시 statuses[] → 정규화 defs(리스트 커스텀 상태 정규화와 동형).
function pjvNormStatusDefs(statuses) {
  if (!Array.isArray(statuses)) return [];
  return statuses.filter((x) => x && x.key).map((x) => ({
    key: String(x.key), label: String(x.label || x.key), color: x.color || '#94a3b8',
    category: (x.category === 'done' || x.category === 'closed') ? x.category : 'active',
  }));
}
// 상태 템플릿(스페이스 기본 포함) 로드 — 실패해도 조용히(기본=null → 표준 3단계). 레지스트리 세팅/렌더 전에 await.
async function pjvLoadStatusTemplates() {
  try {
    const d = await api('/api/ui/v6/status-templates');
    pjvStatusTemplatesCache = (d && d.templates) || [];
    const def = (d && d.default) || pjvStatusTemplatesCache.find((t) => t.is_default) || null;
    const defs = def ? pjvNormStatusDefs(def.statuses) : [];
    pjvSpaceDefaultDefs = defs.length ? defs : null;
  } catch (_) { /* 미설정/실패 → 표준 3단계 폴백 */ }
}
// 리스트의 상태 정의(커스텀이면 그것, 아니면 기본 3단계). 항상 {key,label,color,category,frac} 정규화.
//  frac = Active 버킷 안 진행도(0=첫 상태=점선 할일 → (n-1)/n=거의 가득). Done/Closed 는 체크라 무관. #499
function pjvListStatusDefs(list) {
  let defs;
  if (pjvListIsCustomStatus(list)) {
    defs = list.settings.statuses.filter((x) => x && x.key).map((x) => ({
      key: String(x.key), label: String(x.label || x.key), color: x.color || '#94a3b8',
      // 레거시 'todo' 카테고리는 Active 로 흡수, 'closed' 신규 허용, 그 외는 Active.
      category: (x.category === 'done' || x.category === 'closed') ? x.category : 'active',
    }));
  } else {
    // #729 inherit(기본 상태 사용) — 하드코딩 3단계 대신 스페이스 기본 스킴을 상속(있으면).
    const base = (pjvSpaceDefaultDefs && pjvSpaceDefaultDefs.length) ? pjvSpaceDefaultDefs : PJV_DEFAULT_STATUS_DEFS;
    defs = base.map((d) => ({ ...d }));
  }
  return pjvAssignFracs(defs);
}
// Active 버킷 정의들에 진행도 frac(순서 i / 개수 n) 부여 — 파이차트 채움용. 첫 상태=0(점선). #499
function pjvAssignFracs(defs) {
  const act = defs.filter((d) => d.category === 'active');
  const n = act.length;
  act.forEach((d, i) => { d.frac = n > 0 ? i / n : 0; });
  return defs;
}
// 보드 렌더 동안 리스트별 커스텀 상태 레지스트리 — 프로젝트 행의 상태 동그라미/메뉴가 소속 리스트 상태를 참조(어느 뷰든).
let pjvStatusReg = new Map<number, any[]>();
function pjvSetStatusRegistry(lists) {
  pjvStatusReg = new Map();
  const hasSpaceDefault = !!(pjvSpaceDefaultDefs && pjvSpaceDefaultDefs.length);
  for (const l of lists || []) {
    // 커스텀이면 그 스킴을, 아니면(inherit) 스페이스 기본이 있을 때만 등록 — 그래야 inherit 리스트의 프로젝트/태스크
    //  행도 스페이스 기본 상태(색·이름)로 보인다. 스페이스 기본이 없으면 등록 안 함(네이티브 3단계 폴백 경로 유지).
    if (pjvListIsCustomStatus(l) || hasSpaceDefault) pjvStatusReg.set(Number(l.id), pjvListStatusDefs(l));
  }
}
// #731 프로젝트 id → 소속 리스트 id 맵. 태스크/하위태스크는 list_id 가 없어(부모 체인으로 해소), 행 상태칩이
//  '루트 프로젝트의 리스트' 커스텀 상태를 쓰게 하는 다리. 프로젝트 행/상세가 렌더될 때 채워진다(그 뒤 태스크 행이 그림).
let pjvProjListReg = new Map<number, number | null>();
function pjvRegisterProjList(projectId, listId) {
  if (projectId != null) pjvProjListReg.set(Number(projectId), listId != null ? Number(listId) : null);
}
// 태스크(하위 포함)의 상태 정의 — 루트 프로젝트 id 로 소속 리스트를 찾아 커스텀 상태 defs 반환(없으면 null=네이티브 3단계).
function pjvTaskStatusDefs(projectId) {
  if (projectId == null) return null;
  const listId = pjvProjListReg.get(Number(projectId));
  if (listId == null) return null;
  const defs = pjvStatusReg.get(Number(listId));
  return (defs && defs.length) ? defs : null;
}
// 커스텀 상태 defs 에서 (status_raw 우선, 없으면 네이티브 status 흡수) 현재 상태 def 해소 — 프로젝트/태스크 공용.
function pjvResolveStatusDef(statusRaw, status, defs) {
  if (!defs || !defs.length) return null;
  const rawKey = statusRaw || status;
  let d = defs.find((x) => x.key === rawKey);
  if (!d) {
    if (status === 'done') d = defs.find((x) => x.category === 'done') || defs.find((x) => x.category === 'closed') || null;
    else d = defs.find((x) => x.category === 'active') || null;
  }
  return d;
}
// 프로젝트의 실제 상태 정의(커스텀 리스트면 커스텀 def, 아니면 null=기본 meta). status_raw 우선, 없으면 카테고리로 흡수.
function pjvResolveProjStatus(p) {
  if (p == null || p.list_id == null) return null;
  const defs = pjvStatusReg.get(Number(p.list_id));
  if (!defs || !defs.length) return null;
  const rawKey = p.status_raw || p.status;
  let d = defs.find((x) => x.key === rawKey);
  if (!d) {
    // 미스매치는 네이티브 status 로 흡수 — done 은 Done(없으면 Closed), 그 외는 Active 첫 상태.
    if (p.status === 'done') d = defs.find((x) => x.category === 'done') || defs.find((x) => x.category === 'closed') || null;
    else d = defs.find((x) => x.category === 'active') || null;
  }
  return d;
}
// 카테고리 → 기본 클래스(버킷별 CSS 훅). 아이콘 자체는 pjvStatusIcon 이 그린다(#499).
function pjvCatMeta(category) {
  if (category === 'closed') return { cls: 'closed', glyph: '✓' };
  if (category === 'done') return { cls: 'done', glyph: '✓' };
  return { cls: 'inprog', glyph: '' };
}
// 상태 아이콘(SVG) — 클릭업 스타일(#499). 사이트 전역 진행도 아이콘의 단일 출처:
//  · Active: 진행도 파이(frac=0 → 점선 빈 링='할일', 커질수록 시계방향으로 채워짐).
//  · Done:  색 링 + 체크.   · Closed: 색으로 꽉 채운 원 + 흰 체크.
//  색은 inline style 로 넣어 CSS 변수(var(--blue) 등)도 해석되게 한다(setAttribute fill 은 var 미해석).
function pjvStatusIcon(category, color, frac, size?) {
  const px = size === 'sm' ? 15 : 18;
  const c = color || 'var(--muted-3)';
  const R = 9, cx = 12, cy = 12;
  const svg = sv('svg', { class: 'pjv-status-ic' + (size ? ' ' + size : ''), viewBox: '0 0 24 24', width: px, height: px, 'aria-hidden': 'true' });
  if (category === 'done' || category === 'closed') {
    const filled = category === 'closed';
    svg.append(sv('circle', { cx, cy, r: R, 'stroke-width': 2, style: 'fill:' + (filled ? c : 'none') + ';stroke:' + c }));
    svg.append(sv('path', { d: 'M7.7 12.3l2.7 2.7 5.9-6.2', 'stroke-width': 2.1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', style: 'fill:none;stroke:' + (filled ? '#fff' : c) }));
    return svg;
  }
  // Active — 진행도 파이.
  const f = Math.max(0, Math.min(0.995, frac || 0));
  if (f < 0.001) {
    svg.append(sv('circle', { cx, cy, r: R, 'stroke-width': 2, 'stroke-dasharray': '2.2 2.4', style: 'fill:none;stroke:' + c }));
  } else {
    svg.append(sv('circle', { cx, cy, r: R, 'stroke-width': 2, opacity: 0.3, style: 'fill:none;stroke:' + c }));
    const th = f * 2 * Math.PI;
    const ex = (cx + R * Math.sin(th)).toFixed(2), ey = (cy - R * Math.cos(th)).toFixed(2);
    const large = f > 0.5 ? 1 : 0;
    svg.append(sv('path', { d: 'M' + cx + ' ' + cy + 'L' + cx + ' ' + (cy - R) + 'A' + R + ' ' + R + ' 0 ' + large + ' 1 ' + ex + ' ' + ey + 'Z', style: 'fill:' + c }));
  }
  return svg;
}
// 표준 3상태(todo|in_progress|done) → 통일 상태 아이콘. 사이트 전역(프로젝트·태스크·하위태스크) 공통 진행도 아이콘.
//  todo=점선 빈 링, in_progress=반쯤 채운 파이, done=색 링+체크.
//  색은 PJV_DEFAULT_STATUS_DEFS(상태 편집 창의 기본 3단계)와 단일 출처(#667) — 예전 파랑/민트 테마변수는
//  상태 편집 창(주황 진행·초록 완료)과 어긋나 '기본 상태'가 outdated 파란 아이콘으로 보였다.
function pjvStatusIconStd(status, size?) {
  const color = (k, fb) => { const d = PJV_DEFAULT_STATUS_DEFS.find((x) => x.key === k); return (d && d.color) || fb; };
  if (status === 'done') return pjvStatusIcon('done', color('done', '#22c55e'), undefined, size);
  if (status === 'todo') return pjvStatusIcon('active', color('todo', '#94a3b8'), 0, size);
  return pjvStatusIcon('active', color('active', '#f59e0b'), 0.5, size); // in_progress — 반 파이
}
// 네이티브 상태(todo|in_progress|done) → 기본 상태색(PJV_DEFAULT_STATUS_DEFS 단일 출처). 상태 그룹 헤더 pill 배경용(#670 통일감).
//  in_progress 는 기본 def 키 'active' 로 대응. 커스텀 리스트의 pill 과 같은 표현으로 inherit/기본 리스트도 통일.
function pjvNativeStatusColor(status) {
  const k = status === 'in_progress' ? 'active' : status;
  const d = PJV_DEFAULT_STATUS_DEFS.find((x) => x.key === k);
  return (d && d.color) || '#94a3b8';
}
// 클릭 가능한 상태 아이콘 버튼 래퍼 — SVG 아이콘 + 투명 버튼(경계·배경 없음).
function pjvStatusIconBtn(icon, attrs?) {
  return el('button', { class: 'pjv-status-btn', type: 'button', ...(attrs || {}) }, icon);
}
// 커스텀 상태 아이콘 — 파이/체크(pjvStatusIcon). size='sm' 작게.
function pjvCustomStatusDot(def, size?) {
  return pjvStatusIcon(def.category, def.color, def.frac, size);
}
// ══ 태스크 표준 상수(네이티브 3단계·우선순위)와 날짜 헬퍼 — 커스텀 상태가 없는 리스트의 폴백이자 표시 어휘. ══
const PJV_TASK_STATUS = {
  todo:        { label: '할 일',   bucket: 'todo',        glyph: '',  cls: 'todo' },
  in_progress: { label: '진행 중', bucket: 'in_progress', glyph: '◐', cls: 'inprog' },
  done:        { label: '완료',    bucket: 'done',        glyph: '✓', cls: 'done' },   // #731 프로젝트('완료')와 라벨 통일(구 'Closed')
};
const PJV_STATUS_ORDER = ['todo', 'in_progress', 'done'];
// 레거시 'active'(구 토글)·클릭업 미러 적재값을 'todo' 버킷으로 흡수. 그 외 미지정도 todo.
function pjvStatusMeta(s) {
  if (s === 'done') return PJV_TASK_STATUS.done;
  if (s === 'in_progress') return PJV_TASK_STATUS.in_progress;
  return PJV_TASK_STATUS.todo;
}
const PJV_PRIORITY = {
  urgent: { label: '긴급', cls: 'urgent' },
  high:   { label: '높음', cls: 'high' },
  normal: { label: '보통', cls: 'normal' },
  low:    { label: '낮음', cls: 'low' },
};
const PJV_PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low'];

function pjvFmtDate(d) {
  if (!d) return '';
  const p = String(d).split(/[T ]/)[0].split('-');
  return p.length === 3 ? (Number(p[1]) + '/' + Number(p[2])) : String(d);
}
function pjvTodayStr() {
  const n = new Date(); const z = (x) => String(x).padStart(2, '0');
  return n.getFullYear() + '-' + z(n.getMonth() + 1) + '-' + z(n.getDate());
}
function pjvIsOverdue(t) { return t.due_date && t.status !== 'done' && t.due_date < pjvTodayStr(); }

export {
  PJV_DEFAULT_STATUS_DEFS,
  PJV_PRIORITY,
  PJV_PRIORITY_ORDER,
  PJV_STATUS_CATS,
  PJV_STATUS_ORDER,
  PJV_TASK_STATUS,
  pjvAssignFracs,
  pjvCatMeta,
  pjvCustomStatusDot,
  pjvFmtDate,
  pjvIsOverdue,
  pjvListIsCustomStatus,
  pjvListStatusDefs,
  pjvLoadStatusTemplates,
  pjvNativeStatusColor,
  pjvNativeStatusOf,
  pjvNormStatusDefs,
  pjvProjListReg,
  pjvProjStatusMeta,
  pjvRegisterProjList,
  pjvResolveProjStatus,
  pjvResolveStatusDef,
  pjvSetStatusRegistry,
  pjvSpaceDefaultDefs,
  pjvStatusIcon,
  pjvStatusIconBtn,
  pjvStatusIconStd,
  pjvStatusMeta,
  pjvStatusReg,
  pjvStatusTemplatesCache,
  pjvTaskStatusDefs,
  pjvTodayStr,
};
