// projects/rows.ts — #1313 R33: web/projects.ts 분해 ④.
//  프로젝트 보드의 **행·그룹 렌더러**와 그 프리퍼런스·비교자 —
//   · 프리퍼런스(localStorage): 그룹바이(pjvGetGroupBy) · '리스트로도 묶기' · 그룹 접힘
//   · 비교자: pjvContainerCmp(리스트/폴더) · pjvManualCmp(수동 순서) · pjvColSortCmp(컬럼 정렬)
//  ※ 컬럼 정렬의 **저장·헤더 바인딩**(pjvGetColSort/pjvSetColSort/pjvHeadSortable)은 #1313 R36 에서
//   projects/columns.ts 로 내렸다 — 유일한 소비자가 컬럼 헤더(columns·fields)라, 거기 두면 두 모듈이
//   배럴(../projects.js)을 되짚을 이유가 사라진다(실측 순환 117→64). 비교자는 행 렌더러의 것이라 여기 남는다.
//   · 그룹 렌더: pjvRenderStatusGroups(상태 3버킷/커스텀 상태) · pjvRenderFieldGroups(담당자·우선순위·마감·태그)
//   · 프로젝트 행 인라인 컨트롤: 상태 동그라미 · 팀원 셀 · ⋯메뉴 · 이름변경 · 삭제 · '내 세션' 셀 · projPatch
//   · 행 본체: pjvProjRow · pjvProjTaskRow · pjvProjGroup · 인라인 추가행(pjvProjAddRow)
//  ⚠ pjvOpenTaskModal 은 **배럴(../projects.js) 경유**로 받는다 — 기존 projects↔taskmodal 순환을 새 직접
//   엣지(rows→taskmodal)로 늘리지 않기 위해서다(순환 축소는 R56 소관).
import { api, appUrl, busy, el, personFace, toast } from '../core.js';
import {
  openProjectSessionForm, pjvAddTask, pjvOpenTaskModal,
  pjvRowMore, pjvSetProjStatusCustom,
} from '../projects.js';
import { pjvIcon, pjvSubtaskIcon } from './icons.js';
import { pjvPopover } from './popover.js';
// #1313 R32 — 컬럼 시스템·커스텀 필드·필터는 projects/{columns,fields,filters}.ts 소유. 배럴(../projects.js)을
//  거치지 않고 직결한다(배럴 경유는 역방향 엣지를 새로 만들 뿐이다).
import { pjvApplyColOrder, pjvNameResizeHandle, pjvProjGridTemplate, pjvStdColHead, pjvWireColReorder } from './columns.js';
import { pjvAddColumnButton, pjvColumnHead, pjvFieldControl } from './fields.js';
import { pjvMeMode, pjvTaskIsMine } from './filters.js';
// #1313 R34 — '리스트 이동' 팝오버는 projects/list-forms.ts 소유가 됐다(같은 이유로 직결).
import { pjvMoveProjectList } from './list-forms.js';
import { pjvGroupCheck, pjvGroupReorderTarget, pjvRowActions, pjvRowCheck, pjvRowGrip, pjvRowTagsEl, pjvTagPopover } from './selection.js';
import { pjvFolderDrag, pjvLocalSortOverride, pjvProjClosedView, pjvReloadKeepScroll } from './state.js';
import { PJV_STATUS_CATS, pjvCatMeta, pjvCustomStatusDot, pjvFmtDate, pjvListIsCustomStatus, pjvListStatusDefs, pjvNativeStatusColor, pjvNativeStatusOf, pjvProjStatusMeta, pjvRegisterProjList, pjvResolveProjStatus, pjvStatusIcon, pjvStatusIconBtn, pjvStatusIconStd, pjvStatusReg } from './status.js';
import { pjvAssigneeControl, pjvDueControl, pjvMemberDirectory, pjvPatchTask, pjvPriorityControl, pjvSaveProjMembers, pjvSaveTask, pjvStatusControl } from './task-controls.js';

// 상태 그룹 렌더(사이드바 본문) — 단일 리스트 선택이고 커스텀 상태면 각 상태를 그룹으로(스크린샷),
//  아니면(전체/폴더/미분류/기본 리스트) 표준 3버킷. #475.
// ── 그룹바이 파리티(#541) — ClickUp 뷰의 group by(field+dir)를 기본값으로, 리스트별 로컬 오버라이드 저장. ──
//  필드: status(상태)|assignee(담당자)|priority(우선순위)|due(마감일)|tag(태그). dir 1=오름/-1=내림(ClickUp grouping.dir 동형).
const PJV_GROUPBY_FIELDS = [
  { key: 'status', label: '상태' }, { key: 'assignee', label: '담당자' },
  { key: 'priority', label: '우선순위' }, { key: 'due', label: '마감일' }, { key: 'tag', label: '태그' },
];
const PJV_CU_GROUP_MAP = { status: 'status', assignee: 'assignee', assignees: 'assignee', priority: 'priority', dueDate: 'due', due_date: 'due', duedate: 'due', tag: 'tag', tags: 'tag' };
function pjvGroupByStoreKey(scope) { return 'pjv:groupBy:' + (scope == null || scope === '' ? 'all' : scope); }
// 그룹 기준의 저장 스코프(#1067) — 리스트면 그 리스트 id(기존 키 그대로 유지), 아니면 스코프 키(F<id>/__all__/__none__).
//  예전엔 리스트 스코프에서만 그룹을 바꿀 수 있어 폴더·스페이스에선 버튼이 죽어 있었다(ClickUp 은 폴더에서도 Group: Status).
function pjvGroupScope(selList, scopeKey) { return selList ? String(selList.id) : (scopeKey || 'all'); }
function pjvGetGroupBy(selList, cu, scopeKey?) {
  try {
    const v = JSON.parse(localStorage.getItem(pjvGroupByStoreKey(pjvGroupScope(selList, scopeKey))) || 'null');
    if (v && v.field) return { field: v.field, dir: v.dir === -1 ? -1 : 1 };
  } catch (_) { /* noop */ }
  const g = cu && cu.view_grouping;
  const f = g && PJV_CU_GROUP_MAP[String(g.field)];
  if (f) return { field: f, dir: g.dir === -1 ? -1 : 1, fromView: true };
  return { field: 'status', dir: 1 };
}
function pjvSetGroupBy(selList, v, scopeKey?) {
  try {
    const k = pjvGroupByStoreKey(pjvGroupScope(selList, scopeKey));
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch (_) { /* noop */ }
}
// '리스트로도 묶기'(#req, ClickUp 'Also group by List' 파리티) — 폴더·스페이스 스코프에서만 의미가 있다.
//  켬(기본) = 리스트마다 테두리 박스, 그 안에서 그룹 기준으로 다시 묶음. 끔 = 리스트 경계를 지우고
//  스코프 전체를 한 덩어리로 그룹 기준(상태 등)으로만 묶음. 폴더로 묶는 옵션은 두지 않는다(사용자 결정 — 불필요).
//  스코프별 저장(F<id>) — 폴더마다 보는 방식이 다를 수 있어서.
function pjvAlsoListKey(scopeKey) { return 'pjv:alsoList:' + (scopeKey || 'all'); }
function pjvGetAlsoList(scopeKey) { try { return localStorage.getItem(pjvAlsoListKey(scopeKey)) !== '0'; } catch (_) { return true; } }
function pjvSetAlsoList(scopeKey, on) {
  try { const k = pjvAlsoListKey(scopeKey); if (on) localStorage.removeItem(k); else localStorage.setItem(k, '0'); } catch (_) { /* noop */ }
}

// 상태(그룹) 접힘 상태 저장(#req) — 리스트+그룹 단위로 localStorage 에 저장해 새로고침에도 유지된다.
//  기본은 펼침(키 없음); 접으면 '0' 을 저장하고, 다시 펼치면 키를 지워 기본(펼침)으로 되돌린다(저장소 정리).
//  gid = 커스텀 상태 key | 기본 3버킷 statusKey('in_progress'|'todo'|'done') | (필드 그룹) 라벨.
//  이유: 태스크 수십 개인 조직에서 매 새로고침마다 다 펼쳐지면 원하는 그룹까지 매번 접어야 해 불편(#req).
function pjvGrpOpenKey(listId, gid) { return 'pjv:grpOpen:' + (listId == null ? 'all' : listId) + ':' + gid; }
function pjvGrpOpenGet(listId, gid) { try { return localStorage.getItem(pjvGrpOpenKey(listId, gid)) !== '0'; } catch (_) { return true; } }
function pjvGrpOpenSet(listId, gid, open) {
  try { const k = pjvGrpOpenKey(listId, gid); if (open) localStorage.removeItem(k); else localStorage.setItem(k, '0'); } catch (_) { /* noop */ }
}

// 리스트/폴더 표시 순서 비교자(#541 사이드바 파리티) — sort 오름차순(0 포함 — 구 0-based 재정렬 데이터의 0-top 보존,
//  서버 ORDER BY 와 동형), 동률(미재정렬 전부 0 등)은 ClickUp orderindex(settings.clickup — 미러 사이드바 순서), 이름.
function pjvContainerCmp(a, b) {
  const sa = Number(a.sort) || 0, sb = Number(b.sort) || 0;
  if (sa !== sb) return sa - sb;
  const oi = (x) => { const n = Number(x && x.settings && x.settings.clickup && x.settings.clickup.orderindex); return Number.isFinite(n) ? n : null; };
  const oa = oi(a), ob = oi(b);
  if (oa != null || ob != null) { if (oa == null) return 1; if (ob == null) return -1; if (oa !== ob) return oa - ob; }
  return String(a.name).localeCompare(String(b.name));
}

// 수동/기본 순서 비교자 — 로컬 드래그(sort 1..n; 0=미지정→맨 위(새 항목)) → ClickUp 수동 순서(ext_orderindex) → 최신순.
function pjvManualCmp(a, b) {
  const sa = pjvLocalSortOverride.get(Number(a.id)) ?? (Number(a.sort) || 0);
  const sb = pjvLocalSortOverride.get(Number(b.id)) ?? (Number(b.sort) || 0);
  if (sa !== sb) { if (!sa) return -1; if (!sb) return 1; return sa - sb; }
  const na = a.ext_orderindex == null ? null : Number(a.ext_orderindex);
  const nb = b.ext_orderindex == null ? null : Number(b.ext_orderindex);
  if (na != null || nb != null) {
    if (na == null) return -1; if (nb == null) return 1;
    if (na !== nb) return na - nb;
  }
  return (Date.parse(b.updated_at || 0) || 0) - (Date.parse(a.updated_at || 0) || 0);
}
// 컬럼 정렬 비교자 — 빈 값은 방향 무관 항상 뒤(ClickUp 동형). 동률은 수동/기본 순서.
const PJV_PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
function pjvColSortCmp(sortSpec) {
  if (!sortSpec || !sortSpec.key) return pjvManualCmp;
  const { key, dir } = sortSpec;
  const val = (p) => {
    if (key === 'name') return String(p.name || '');
    if (key === 'team') { const m = (p.members || [])[0]; return m ? String(m.display_name || m.member_id || '') : null; }
    if (key === 'due') return p.due_date || null;
    if (key === 'start') return p.start_date || null;
    if (key === 'created') return p.created_at || null;
    if (key === 'updated') return p.updated_at || null;
    if (key === 'priority') { const r = PJV_PRIORITY_RANK[p.priority]; return r === undefined ? null : r; }
    // 그 외(cu:<externalId> — ClickUp 이관, 또는 네이티브 커스텀필드 id) — 행 field_values 값.
    const v = (p.field_values || {})[key];
    return v == null || v === '' ? null : v;
  };
  return (a, b) => {
    const va = val(a), vb = val(b);
    if (va == null && vb == null) return pjvManualCmp(a, b);
    if (va == null) return 1;
    if (vb == null) return -1;
    let c;
    const na = Number(va), nb = Number(vb);
    if (Number.isFinite(na) && Number.isFinite(nb) && String(va).trim() !== '' && String(vb).trim() !== '') c = na - nb;
    else c = String(va).localeCompare(String(vb));
    return (dir === -1 ? -c : c) || pjvManualCmp(a, b);
  };
}
// 그룹 안 프로젝트 정렬 — 컬럼 정렬 지정 시 그것, 아니면 수동/기본 순서. (기존 rank/최신순을 대체 — ClickUp 파리티)
function pjvSortProjects(arr, colSort) { return arr.slice().sort(pjvColSortCmp(colSort)); }

function pjvRenderStatusGroups(main, shownProjects, selList, opts) {
  const { reload, canDelete, fields, anchorId, meId, taskCtx, listIdForAdd } = opts;
  // 추가행을 뺄 조건 — '내 할당만'(예전부터) 또는 opts.noAdd(#req 폴더에서 리스트 그룹을 끈 경우:
  //  어느 리스트로 만들지 정할 수 없으니 만들기를 열어 두면 폴더 밖 '미분류'로 새는 프로젝트가 생긴다).
  const mineOnly = opts.mineOnly || opts.noAdd;
  const gb = opts.groupBy || { field: 'status', dir: 1 };
  const sortArr = (arr) => pjvSortProjects(arr, opts.colSort);
  // 첫(맨 위) 그룹 헤더에 컬럼 라벨을 합친다(별도 컬럼헤더 행 없음, #470). 실제로 그려지는 첫 그룹에만 withCols.
  let firstShown = true;
  const takeCols = () => { const w = firstShown; firstShown = false; return w; };
  // 상태 외 그룹바이(#541 파리티) — 담당자/우선순위/마감일/태그.
  if (gb.field && gb.field !== 'status') {
    pjvRenderFieldGroups(main, shownProjects, selList, opts, gb, sortArr, takeCols);
    return;
  }
  if (selList && pjvListIsCustomStatus(selList)) {
    const defs = pjvListStatusDefs(selList);
    // 프로젝트를 상태 def 로 분배 — status_raw/status 매칭, 미스매치는 카테고리 첫 def 로 흡수.
    const byKey = new Map<string, any[]>();
    for (const d of defs) byKey.set(d.key, []);
    const firstOfCat = (cat) => defs.find((d) => d.category === cat);
    for (const p of shownProjects) {
      let d = defs.find((x) => x.key === (p.status_raw || p.status));
      // 미스매치는 네이티브 status 로 흡수 — done 은 Done(없으면 Closed), 그 외는 Active 첫 상태.
      if (!d) d = (p.status === 'done' ? (firstOfCat('done') || firstOfCat('closed')) : firstOfCat('active')) || defs[0];
      const arr = d ? byKey.get(d.key) : null; if (arr) arr.push(p);
    }
    // 카테고리 순서로, 각 카테고리 안에서는 정의 순서. dir=-1(내림)이면 전체 역순(ClickUp group by status descending 동형).
    //  완료(done)/종결(closed) 상태는 Closed 토글일 때만.
    const ordered: any[] = [];
    for (const cat of PJV_STATUS_CATS) {
      for (const d of defs.filter((x) => x.category === cat.key)) {
        if ((cat.key === 'done' || cat.key === 'closed') && !pjvProjClosedView.done) continue;
        const arr = byKey.get(d.key) || [];
        if (mineOnly && !arr.length) continue;
        ordered.push({ d, arr });
      }
    }
    if (gb.dir === -1) ordered.reverse();
    for (const { d, arr } of ordered) {
      main.append(pjvProjGroup(d.label, pjvNativeStatusOf(d.category), sortArr(arr), reload, null, canDelete, takeCols(), fields, anchorId, meId, taskCtx, undefined, mineOnly, listIdForAdd, d));
    }
    return;
  }
  // 표준 3버킷(기존 동작 그대로 — 회귀 없음). dir=-1 이면 역순.
  const inprog = shownProjects.filter((p) => p.status !== 'done' && p.status !== 'todo');
  const todo = shownProjects.filter((p) => p.status === 'todo');
  const done = shownProjects.filter((p) => p.status === 'done');
  const subs: Array<[string, string, any[]]> = [];
  if (!mineOnly || inprog.length) subs.push(['진행 중', 'in_progress', inprog]);
  if (!mineOnly || todo.length) subs.push(['할 일', 'todo', todo]);
  if (pjvProjClosedView.done && (!mineOnly || done.length)) subs.push(['완료', 'done', done]);
  if (gb.dir === -1) subs.reverse();
  for (const [label, key, arr] of subs) main.append(pjvProjGroup(label, key, sortArr(arr), reload, null, canDelete, takeCols(), fields, anchorId, meId, taskCtx, undefined, mineOnly, listIdForAdd));
}

// 상태 외 필드 그룹 렌더(#541 그룹바이) — 담당자(다중이면 각 그룹에 중복 표시, ClickUp 동형)/우선순위/마감일/태그.
//  값 없는 그룹('없음')은 방향 무관 항상 마지막. 추가행은 그룹 값 프리필이 애매해 생략(noAdd).
function pjvRenderFieldGroups(main, shownProjects, selList, opts, gb, sortArr, takeCols) {
  const { reload, canDelete, fields, anchorId, meId, taskCtx, mineOnly } = opts;
  // done 필터는 그룹 분배 **전에**(#541 리뷰) — 그룹별 사후 필터는 '전부 done'일 때 빈 안내조차 없는 완전 공백을 만든다.
  shownProjects = shownProjects.filter((p) => p.status !== 'done' || pjvProjClosedView.done);
  const groups = new Map<string, { label: string; sortVal: any; arr: any[] }>();
  const put = (key, label, sortVal, p) => {
    if (!groups.has(key)) groups.set(key, { label, sortVal, arr: [] });
    groups.get(key)!.arr.push(p);
  };
  const NONE = '\u0000none';   // 그룹키 센티넬(실제 키와 절대 충돌 안 함). 리터럴 NUL 이 아니라 이스케이프 — 소스에 NUL 이 있으면 grep 이 파일을 바이너리로 보고 건너뛴다.
  for (const p of shownProjects) {
    if (gb.field === 'assignee') {
      const ms = (p.members || []);
      if (!ms.length) put(NONE, '담당자 없음', null, p);
      else for (const m of ms) put('m:' + m.member_id, String(m.display_name || m.member_id), String(m.display_name || m.member_id), p);
    } else if (gb.field === 'priority') {
      const r = PJV_PRIORITY_RANK[p.priority];
      if (r === undefined) put(NONE, '우선순위 없음', null, p);
      else put('p:' + p.priority, ({ urgent: '긴급', high: '높음', normal: '보통', low: '낮음' })[p.priority] || p.priority, r, p);
    } else if (gb.field === 'due') {
      if (!p.due_date) put(NONE, '마감일 없음', null, p);
      else put('d:' + p.due_date, pjvFmtDate(p.due_date), p.due_date, p);
    } else if (gb.field === 'tag') {
      const tags = (p.tags || []);
      if (!tags.length) put(NONE, '태그 없음', null, p);
      else for (const t of tags) put('t:' + String(t.name).toLowerCase(), String(t.name), String(t.name).toLowerCase(), p);
    }
  }
  const entries = [...groups.entries()];
  entries.sort((a, b) => {
    if (a[0] === NONE) return 1; if (b[0] === NONE) return -1;
    const va = a[1].sortVal, vb = b[1].sortVal;
    const c = (typeof va === 'number' && typeof vb === 'number') ? va - vb : String(va).localeCompare(String(vb));
    return gb.dir === -1 ? -c : c;
  });
  if (!entries.length) { main.append(el('div', { class: 'pjv-proj-empty', text: mineOnly ? '내가 할당된 프로젝트가 없습니다.' : '아직 프로젝트가 없습니다.' })); return; }
  for (const [, g] of entries) {
    main.append(pjvProjGroup(g.label, null, sortArr(g.arr), reload, null, canDelete, takeCols(), fields, anchorId, meId, taskCtx, undefined, true, null));
  }
}

async function pjvSetProjStatus(id, status, reload) {
  try {
    await api('/api/ui/v6/projects/' + id + '/status', { method: 'POST', body: JSON.stringify({ status }) });
    toast(status === 'done' ? '완료된 프로젝트로 옮겼습니다'
      : status === 'todo' ? '할 일로 옮겼습니다'
      : '진행 중으로 옮겼습니다');
    pjvReloadKeepScroll(reload);  // 상태 아이콘 변경 후 위로 튀지 않게 스크롤 보존(#358)
  } catch (e) { toast('실패 — ' + e.message, true); }
}

// 상태 동그라미(클릭→상태 메뉴) — 태스크 pjvStatusControl 과 같은 결. 소속 리스트가 커스텀 상태면 그 상태들을 제시(#475).
function pjvProjStatusDot(p, reload) {
  const defs = (p.list_id != null && pjvStatusReg.get(Number(p.list_id))) || null;
  if (defs && defs.length) {
    const cur = pjvResolveProjStatus(p) || defs[0];
    const btn = el('button', { class: 'pjv-status-btn', type: 'button',
      title: '상태: ' + cur.label, 'aria-label': '상태 ' + cur.label },
      pjvStatusIcon(cur.category, cur.color, cur.frac));
    btn.onclick = (e) => {
      e.stopPropagation();
      const menu = el('div', { class: 'pjv-menu' });
      const close = pjvPopover(btn, menu);
      for (const cat of PJV_STATUS_CATS) {
        for (const d of defs.filter((x) => x.category === cat.key)) {
          const isCur = d.key === cur.key;
          const item = el('button', { class: 'pjv-menu-item' + (isCur ? ' sel' : ''), type: 'button' },
            pjvCustomStatusDot(d, 'sm'), el('span', { text: d.label }));
          item.onclick = () => { close(); if (!isCur) pjvSetProjStatusCustom(p.id, d, reload); };
          menu.append(item);
        }
      }
    };
    return btn;
  }
  const meta = pjvProjStatusMeta(p.status);
  const btn = pjvStatusIconBtn(pjvStatusIconStd(p.status), { title: '상태: ' + meta.label, 'aria-label': '상태 ' + meta.label });
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(btn, menu);
    for (const st of ['todo', 'in_progress', 'done']) {
      const m = pjvProjStatusMeta(st);
      const cur = pjvProjStatusMeta(p.status).key === st;
      const item = el('button', { class: 'pjv-menu-item' + (cur ? ' sel' : ''), type: 'button' },
        pjvStatusIconStd(st, 'sm'),
        el('span', { text: m.label }));
      item.onclick = () => { close(); if (!cur) pjvSetProjStatus(p.id, st, reload); };
      menu.append(item);
    }
  };
  return btn;
}

// 팀원 셀 — 멤버 페이스파일(클릭→전체 구성원 검색·다중토글 팝오버). 프로젝트의 '담당자'를 대체한다.
//  currentMembers=[{member_id,display_name}](보드 listProjects 가 채움). applyIds(ids)= 저장(프로젝트 행) 또는 드래프트 갱신(추가행).
//  태스크의 pjvAssigneeControl 과 같은 결(팝오버·아바타·체크) + 검색 인풋으로 전체 구성원에서 고른다.
function pjvProjTeamControl(currentMembers, applyIds) {
  let members = (currentMembers || []).map((m) => ({ id: m.member_id, name: m.display_name || m.member_id }));
  const btn = el('button', { class: 'pjv-cell-btn', type: 'button', title: '팀원' });
  function render() {
    btn.className = 'pjv-cell-btn' + (members.length ? '' : ' empty');
    if (members.length) {
      const faces = el('span', { class: 'pjv-asg-faces' });
      for (const m of members.slice(0, 3)) faces.append(personFace(m.id, 'pjv-ava', m.name));
      if (members.length > 3) faces.append(el('span', { class: 'pjv-ava pjv-ava-more', text: '+' + (members.length - 3) }));
      btn.replaceChildren(faces);
    } else {
      btn.replaceChildren(pjvIcon('assignee'));
    }
  }
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu pjv-asg-menu pjv-team-menu' });
    pjvPopover(btn, menu);
    const search = el('input', { type: 'text', class: 'pjv-team-search', placeholder: '이름으로 검색해 추가/해제…', spellcheck: 'false', autocomplete: 'off' });
    const listBox = el('div', { class: 'pjv-team-list' });
    menu.append(el('div', { class: 'pjv-team-searchwrap' }, search), listBox);
    let all: any = null;
    const setIds = (ids) => {
      members = ids.map((id) => { const m = all && all.find((x) => x.id === id); return { id, name: m ? (m.display_name || id) : id }; });
      render(); applyIds(ids); rebuild();
    };
    function rebuild() {
      if (!all) { busy(listBox, el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' })); return; }
      const selIds = new Set(members.map((m) => m.id));
      const q = search.value.trim().toLowerCase();
      const cand = all.filter((m) => !q || (m.display_name || m.id).toLowerCase().includes(q));
      if (!cand.length) { listBox.replaceChildren(el('div', { class: 'pjv-menu-empty', text: q ? '일치하는 사람이 없어요.' : '구성원이 없습니다.' })); return; }
      listBox.replaceChildren(...cand.map((m) => {
        const on = selIds.has(m.id);
        const item = el('button', { class: 'pjv-menu-item' + (on ? ' sel' : ''), type: 'button' },
          personFace(m.id, 'pjv-ava', m.display_name || m.id),
          el('span', { class: 'pjv-asg-mname', text: m.display_name || m.id }),
          el('span', { class: 'pjv-asg-check', text: on ? '✓' : '' }));
        item.onclick = (ev) => { ev.stopPropagation(); const cur = members.map((x) => x.id); setIds(on ? cur.filter((x) => x !== m.id) : [...cur, m.id]); };
        return item;
      }));
    }
    pjvMemberDirectory().then((dir) => { all = dir; rebuild(); }).catch(() => listBox.replaceChildren(el('div', { class: 'pjv-menu-empty', text: '구성원을 불러오지 못했어요.' })));
    search.addEventListener('input', rebuild);
    setTimeout(() => search.focus(), 0);
  };
  render();
  return btn;
}
async function projPatch(id, patch, reload) {
  try { await api('/api/ui/v6/projects/' + id, { method: 'POST', body: JSON.stringify(patch) }); pjvReloadKeepScroll(reload); }
  catch (e) { toast('수정 실패 — ' + e.message, true); }
}
// 행 끝 ⋯ 메뉴 — 이름 변경 · 상태 토글 · 삭제(작성자만, 서버 403 재검증).
function pjvProjMore(p, reload, canDelete) {
  const btn = el('button', { class: 'pjv-trow-more', type: 'button', title: '더보기', 'aria-label': '프로젝트 작업', text: '⋯' });
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(btn, menu);
    const mk = (label, fn, danger) => { const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label })); b.onclick = () => { close(); fn(); }; return b; };
    menu.append(mk('이름 변경', () => pjvProjRename(btn, p, reload), false));
    menu.append(mk(p.status === 'done' ? '진행 중으로' : '완료된 프로젝트로', () => pjvSetProjStatus(p.id, p.status === 'done' ? 'in_progress' : 'done', reload), false));
    menu.append(mk('리스트 이동', () => pjvMoveProjectList(btn, p, reload), false));
    if (canDelete(p)) menu.append(mk('삭제', () => pjvProjDelete(p, reload), true));
  };
  return btn;
}
function pjvProjRename(anchor, p, reload) {
  const input = el('input', { type: 'text', class: 'pjv-rename-input', value: p.name, maxlength: '200' });
  const close = pjvPopover(anchor, el('div', { class: 'pjv-menu pjv-rename-pop' }, input));
  input.onkeydown = async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault(); const v = input.value.trim(); close();
    if (v && v !== p.name) {
      try { await api('/api/ui/v6/projects/' + p.id, { method: 'POST', body: JSON.stringify({ name: v }) }); reload(); }
      catch (err) { toast('수정 실패 — ' + err.message, true); }
    }
  };
  setTimeout(() => { input.focus(); input.select(); }, 0);
}
function pjvProjDelete(p, reload) {
  if (!confirm('프로젝트 ‘' + p.name + '’을(를) 삭제할까요?\n\n프로젝트와 그 안의 작업(태스크·하위)이 함께 사라집니다(되돌릴 수 없음).')) return;
  (async () => {
    try { await api('/api/ui/v6/projects/' + p.id + '/delete', { method: 'POST' }); toast('프로젝트를 삭제했습니다'); reload(); }
    catch (e) { toast('삭제 실패 — ' + e.message, true); }
  })();
}
// 프로젝트 한 줄(태스크 행과 동형) — [캐럿자리][상태점/체크] 이름 | 담당자 | 마감일 | 우선순위 | 커스텀… | ⋯.
// '내 세션' 셀(프로젝트 목록 전용) — 터미널 아이콘 클릭 → 이 프로젝트의 '내 세션' 목록 팝업 → 고르면 새 탭으로 입장.
function pjvProjSessionCell(p, reload) {
  // 내 세션이 있으면 활성(컬러 터미널 아이콘 + 작은 라이브 점), 없으면 옅게(비활성). my_session_count 는 보드 API 가 부여.
  const nSess = Number(p.my_session_count || 0);
  const active = nSess > 0;
  const btn = el('button', { class: 'pjv-cell-btn' + (active ? ' pjv-sess-active' : ' empty'), type: 'button',
    title: active ? ('내 세션 ' + nSess + '개 — 클릭해 입장/추가') : '내 세션 없음 — 클릭해 만들기' },
    el('span', { class: 'pjv-sess-ico-wrap' }, pjvIcon('session'), active ? el('span', { class: 'pjv-sess-dot', 'aria-hidden': 'true' }) : null));
  // 그 자리에서 바로 '새 터미널 세션' 폼을 띄운다 — 프로젝트 안으로 들어가지 않음. 이름은 프로젝트명으로 프리필.
  const openCreate = () => openProjectSessionForm(p.id, reload, '/api/ui/v6/projects/', p.name, p.repos);
  btn.onclick = (e) => {
    e.stopPropagation();
    // 활성·비활성 공통으로 같은 드롭다운을 띄운다 — 비활성도 곧장 폼이 뜨지 않고 '＋ 새 세션 만들기'를 거치게(이미지 참고).
    const menu = el('div', { class: 'pjv-menu pjv-sess-menu' });
    const close = pjvPopover(btn, menu);
    // '＋ 새 세션 만들기' — 프로젝트로 안 들어가고 그 자리에서 새 세션 생성 폼. (활성·비활성 공통 항목)
    const addItem = el('button', { class: 'pjv-menu-item pjv-sess-add', type: 'button' },
      el('span', { class: 'pjv-sess-ico pjv-sess-add-ico', text: '＋' }),
      el('span', { text: '새 세션 만들기' }));
    addItem.onclick = (ev) => { ev.stopPropagation(); close(); openCreate(); };
    if (!active) {
      // 내 세션 없음 → 빈 목록 fetch 없이 곧장 안내 + 새 세션 만들기(활성 드롭다운과 같은 모양·위치).
      menu.append(el('div', { class: 'pjv-menu-empty', text: '내 세션이 없습니다' }), addItem);
      return;
    }
    // 내 세션 있음 → 내 세션들(입장) + '＋ 새 세션 만들기'.
    menu.append(el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
    api('/api/ui/v6/projects/' + p.id + '/sessions')
      .then((d) => {
        const mine = ((d && d.sessions) || []).filter((s) => s.owned); // owned = 서버가 판정한 '내 세션'
        menu.replaceChildren();
        for (const s of mine) {
          const item = el('button', { class: 'pjv-menu-item', type: 'button', title: s.id },
            el('span', { class: 'pjv-sess-ico' }, pjvIcon('session')),
            el('span', { class: 'pjv-sess-name', text: s.label || s.id }));
          item.onclick = (ev) => {
            ev.stopPropagation(); close();
            // 노드 세션(#905 C4)은 &node= 로 열어야 attach 가 그 노드로 릴레이된다.
            window.open(appUrl('/ui/terminal.html?session=') + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label || '') + (s.node ? '&node=' + encodeURIComponent(s.node.id) : ''), '_blank');
          };
          menu.append(item);
        }
        menu.append(addItem);
      })
      .catch((err) => { menu.replaceChildren(el('div', { class: 'pjv-menu-empty', text: '불러오기 실패 — ' + err.message })); });
  };
  return btn;
}

function pjvProjRow(p, reload, select, canDelete, fields, anchorId, taskCtx) {
  fields = fields || [];
  pjvRegisterProjList(p.id, p.list_id);   // #731 이 프로젝트의 태스크 행이 소속 리스트 커스텀 상태를 쓰게 등록.
  const isDone = p.status === 'done';
  const selectable = !!select && canDelete(p);
  const wrap = el('div', { class: 'pjv-trow-wrap pjv-proj-wrap', 'data-proj-id': p.id, 'data-proj-name': p.name || '' });

  // 폴더로 드래그(#454) — 선택(일괄) 모드가 아닐 때만. 체크박스·캐럿·버튼·제목링크 등 상호작용 요소에서 시작한
  //  드래그는 취소(칠하기-선택·클릭 유지). 폴더(사이드바 항목·인라인 그룹 헤더)가 드롭 타깃(pjvFolderDrag).
  if (!select) {
    wrap.draggable = true;
    wrap.addEventListener('dragstart', (ev: any) => {
      const t = ev.target as Element;
      // 상호작용 요소 + 펼친 하위(태스크) 영역에서 시작한 드래그는 취소 — 칠하기-선택·클릭·하위 재정렬을 살린다.
      if (t && t.closest && t.closest('.pjv-row-check, .pjv-trow-caret, .pjv-row-actions, .pjv-subcount-ico, .pjv-cell-btn, .pjv-trow-subs, button, input, a')) { ev.preventDefault(); return; }
      pjvFolderDrag.id = p.id; pjvFolderDrag.name = p.name; // #1020 이름은 휴지통 드롭 삭제 확인 문구에 쓴다
      try { ev.dataTransfer.setData('text/plain', String(p.id)); ev.dataTransfer.effectAllowed = 'move'; } catch (_) { /* */ }
      document.body.classList.add('pjv-folder-dragging');
      wrap.classList.add('pjv-proj-drag-src');
    });
    wrap.addEventListener('dragend', () => { pjvFolderDrag.id = null; document.body.classList.remove('pjv-folder-dragging'); wrap.classList.remove('pjv-proj-drag-src'); document.querySelectorAll('.pjv-folder-drop-over').forEach((n) => n.classList.remove('pjv-folder-drop-over')); });
  }

  let lead;
  if (select) {
    if (selectable) {
      const cb = el('button', { class: 'pjv-proj-check', type: 'button', 'aria-label': '선택', 'aria-checked': 'false' });
      const apply = (on) => { cb.classList.toggle('on', on); cb.textContent = on ? '✓' : ''; cb.setAttribute('aria-checked', on ? 'true' : 'false'); };
      apply(select.ids.has(p.id));
      cb.onclick = (e) => {
        e.stopPropagation();
        const on = !select.ids.has(p.id);
        if (on) select.ids.add(p.id); else select.ids.delete(p.id);
        apply(on); select.onToggle();
      };
      lead = cb;
    } else {
      lead = el('span', { class: 'pjv-proj-check disabled', title: '내 프로젝트 아님', 'aria-hidden': 'true' });
    }
  } else {
    lead = pjvProjStatusDot(p, reload);
  }

  const title = el('span', { class: 'pjv-trow-title clickable' + (isDone ? ' done' : ''), title: p.name, text: p.name });
  title.onclick = (e) => {
    e.stopPropagation();
    if (select && selectable) { lead.click(); } else { location.hash = '#/projects2/p/' + p.id; } // #req 프로젝트 탭 목록은 페이지 이동(상세 팝업은 대시보드에서만). 선택모드는 그대로.
  };
  // 펼침 캐럿 — 태스크가 있는 프로젝트만(클릭 시 그 프로젝트의 태스크를 안에 펼침). 선택모드/모드없음/0개면 빈 캐럿.
  const nTasks = Number(p.task_count || 0);
  const canExpand = !select && !!taskCtx && nTasks > 0;
  const caret = canExpand
    ? el('button', { class: 'pjv-trow-caret', type: 'button', 'aria-expanded': 'false', text: '▸', title: nTasks + '개 태스크' })
    : el('span', { class: 'pjv-trow-caret empty', 'aria-hidden': 'true' });
  // 프로젝트 태그 칩(클릭업식) — task_tag_link 를 project.id 로 사용. 칩 호버 시 × 로 제거(pjvRowTagsEl). 최대 2 + "+N".
  const ptagsEl = pjvRowTagsEl(p, reload);
  // 하위 태스크 아이콘(이름 옆 배지) — 클릭하면 캐럿과 동일하게 펼침/접힘(클릭업식). canExpand 일 때만 표시·클릭.
  const subcountEl = canExpand ? el('span', { class: 'pjv-trow-subcount pjv-subcount-ico clickable', role: 'button', tabindex: '0', title: nTasks + '개 태스크 — 클릭하여 펼치기' },
    pjvSubtaskIcon(), el('span', { text: String(nTasks) })) : null;
  const titleCell = el('div', { class: 'pjv-trow-title-cell' },
    select ? null : pjvRowCheck('project', p, { reload }),
    caret, lead, title,
    subcountEl,
    ptagsEl,
    select ? null : pjvRowActions([
      { title: '태스크 추가', icon: 'add', fn: () => pjvAddTask(p.id, null, reload) },
      { title: '태그 편집', icon: 'tag', fn: (b) => pjvTagPopover(b, p, reload) },
      { title: '이름 변경', icon: 'rename', fn: (b) => pjvProjRename(b, p, reload) },
      // #1236 행 호버에서 바로 새 세션 — 오른쪽 '내 세션' 컬럼까지 안 가고 제목 옆에서 세션 생성 모달을 연다.
      { title: '새 세션 만들기', icon: 'session', fn: () => openProjectSessionForm(p.id, reload, '/api/ui/v6/projects/', p.name, p.repos) },
    ]));
  // 제목 셀 전체(글자 + 여백)를 클릭 영역으로 — 태스크 목록처럼. 캐럿·체크박스·상태점·행 액션·제목(자체 핸들러)은 제외(각자 처리).
  titleCell.addEventListener('click', (e) => {
    if ((e.target as Element).closest('button, input, a, .pjv-trow-caret, .pjv-row-actions, .pjv-trow-title')) return;
    if (select && selectable) { lead.click(); } else { location.hash = '#/projects2/p/' + p.id; } // #req 프로젝트 탭 목록은 페이지 이동(상세 팝업은 대시보드에서만). 선택모드는 그대로.
  });

  const row = el('div', { class: 'pjv-trow pjv-proj-row' },
    titleCell,
    el('div', { class: 'pjv-tcell', 'data-col': 'team' }, pjvProjTeamControl(p.members || [], (ids) => pjvSaveProjMembers(p.id, ids))),
    el('div', { class: 'pjv-tcell', 'data-col': 'due' }, pjvDueControl(p, (patch) => projPatch(p.id, patch, reload))),
    el('div', { class: 'pjv-tcell pjv-datecell', 'data-col': 'start' }, el('span', { class: 'pjv-fval', text: p.start_date ? pjvFmtDate(p.start_date) : '' })),
    el('div', { class: 'pjv-tcell pjv-datecell', 'data-col': 'created' }, el('span', { class: 'pjv-fval', text: p.created_at ? pjvFmtDate(p.created_at) : '' })),
    el('div', { class: 'pjv-tcell pjv-datecell', 'data-col': 'updated' }, el('span', { class: 'pjv-fval', text: p.updated_at ? pjvFmtDate(p.updated_at) : '' })),
    el('div', { class: 'pjv-tcell', 'data-col': 'priority' }, pjvPriorityControl(p, (patch) => projPatch(p.id, patch, reload))),
    el('div', { class: 'pjv-tcell pjv-sess-cell', 'data-col': 'sess' }, pjvProjSessionCell(p, reload)),
    ...(fields).map((f) => el('div', { class: 'pjv-tcell pjv-fcell', 'data-col': 'f:' + f.id }, pjvFieldControl(p, f, reload))),
    el('div', { class: 'pjv-tcell pjv-tcell-add' }, pjvProjMore(p, reload, canDelete)));
  row.style.gridTemplateColumns = pjvProjGridTemplate(fields);
  pjvApplyColOrder(row, 'proj', fields); // 열 순서 적용(#611)
  wrap.append(row);

  // 하위(=이 프로젝트의 태스크) 펼침 영역 — 캐럿 클릭 시 lazy 로드, expanded 모드면 자동 펼침. 태스크 박스와 동일한 행/컨트롤.
  if (canExpand) {
    const subBox = el('div', { class: 'pjv-trow-subs pjv-proj-subs' });
    subBox.hidden = true;
    let loaded = false, open = false, loading = false;
    const localReload = () => { if (taskCtx.invalidate) taskCtx.invalidate(p.id); loaded = false; if (open) doLoad(); };
    const doLoad = async () => {
      if (loading) return; loading = true;
      busy(subBox, el('div', { class: 'pjv-proj-subnote', text: '태스크 불러오는 중…' }));
      try {
        const d = await taskCtx.fetchProjTasks(p.id);
        const all = (d && d.tasks) || [];
        // Me mode(#1067) — '태스크' 스위치가 켜져 있으면 내가 담당인 태스크만. 담당자 없는 태스크도 빠진다(내 것이 아니므로).
        const tasks = pjvMeMode.tasks ? all.filter((t) => pjvTaskIsMine(t, taskCtx.meId)) : all;
        subBox.replaceChildren();
        if (!tasks.length) subBox.append(el('div', { class: 'pjv-proj-subnote', text: pjvMeMode.tasks && all.length ? '내가 담당인 태스크가 없습니다.' : '태스크가 없습니다.' }));
        else for (const t of tasks) subBox.append(pjvProjTaskRow(p.id, t, d.members, localReload, 1, fields));
        loaded = true;
      } catch (e) { subBox.replaceChildren(el('div', { class: 'pjv-proj-subnote', text: '태스크를 불러오지 못했습니다 — ' + e.message })); }
      loading = false;
    };
    const setOpen = (o) => {
      open = o; caret.textContent = o ? '▾' : '▸'; caret.setAttribute('aria-expanded', o ? 'true' : 'false'); subBox.hidden = !o;
      if (o && !loaded) doLoad();
    };
    caret.onclick = (e) => { e.stopPropagation(); setOpen(!open); };
    if (subcountEl) {
      subcountEl.onclick = (e) => { e.stopPropagation(); setOpen(!open); };
      subcountEl.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setOpen(!open); } };
    }
    if (taskCtx.mode === 'expanded') setOpen(true);
    wrap.append(subBox);
  }
  return wrap;
}

// 보드에서 프로젝트를 펼쳤을 때 그 안의 태스크 한 행 — 프로젝트 행과 '같은 그리드(pjvProjGridTemplate)'로 그려 컬럼 정렬 일치
//  (세션·커스텀필드 칼럼 자리는 빈 칸). 상태·담당자·마감·우선순위·이름변경·삭제·하위추가 모두 동작. 하위태스크는 캐럿으로 재귀 펼침.
function pjvProjTaskRow(projectId, t, members, reload, depth, boardFields) {
  depth = depth || 0;
  boardFields = boardFields || [];
  const subs = t.subtasks || [];
  const isDone = t.status === 'done';
  const wrap = el('div', { class: 'pjv-trow-wrap', 'data-task-id': t.id, 'data-task-name': t.name || t.title || '', 'data-task-level': t.level || 'task' });

  let open = false;
  const caret = subs.length
    ? el('button', { class: 'pjv-trow-caret', type: 'button', 'aria-expanded': 'false', text: '▸' })
    : el('span', { class: 'pjv-trow-caret empty', 'aria-hidden': 'true' });

  const tagsEl = pjvRowTagsEl(t, reload);
  const subcountEl = subs.length ? el('span', { class: 'pjv-trow-subcount pjv-subcount-ico clickable', role: 'button', tabindex: '0', title: subs.length + '개 하위 — 클릭하여 펼치기' },
    pjvSubtaskIcon(), el('span', { text: String(subs.length) })) : null;
  const titleCell = el('div', { class: 'pjv-trow-title-cell' },
    pjvRowGrip('task', t, { reload }), // 좌측 드래그 핸들(#366) — 잡고 끌어 순서 변경
    pjvRowCheck('task', t, { reload, projectId, members }), // 프로젝트 행과 동일한 선택 체크박스(16px) — 정렬·다중선택 모두 동일하게
    caret, pjvStatusControl(t, reload, projectId),
    el('span', { class: 'pjv-trow-title' + (isDone ? ' done' : ''), text: t.name || t.title || '(제목 없음)' }),
    subcountEl,
    tagsEl);
  titleCell.style.paddingLeft = (depth * 22) + 'px';
  // 제목(셀) 클릭 = 태스크 상세 모달 (#811). 이 행은 보드 전용 렌더러라 pjvTaskRow 에 붙는 모달 배선(data-tm-wired)이
  //  없어서 **눌러도 아무 일도 안 일어났다** — 보드에서 태스크를 열 방법 자체가 없었다. 주소 동기화(#/projects2/t/<id>)는
  //  pjvOpenTaskModal 이 하므로 배선만 하면 따라온다(#810). 컨트롤(그립·체크·캐럿·상태·하위수·행액션)은 각자 동작하도록 통과.
  const titleEl: any = titleCell.querySelector('.pjv-trow-title');
  if (titleEl) { titleEl.classList.add('clickable'); titleEl.title = '상세 열기'; }
  titleCell.addEventListener('click', (e: any) => {
    if (e.target.closest('button, input, a, .pjv-trow-caret, .pjv-row-actions')) return;
    pjvOpenTaskModal(t.id, reload);
  });

  const subBox = el('div', { class: 'pjv-trow-subs' });
  subBox.hidden = true;
  if (subs.length && depth < 4) {
    for (const s of subs) subBox.append(pjvProjTaskRow(projectId, s, members, reload, depth + 1, boardFields));
    const toggle = () => { open = !open; caret.textContent = open ? '▾' : '▸'; caret.setAttribute('aria-expanded', open ? 'true' : 'false'); subBox.hidden = !open; };
    caret.onclick = toggle;
    if (subcountEl) {
      subcountEl.onclick = (e) => { e.stopPropagation(); toggle(); };
      subcountEl.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggle(); } };
    }
  }

  // 하위 추가 가능 여부는 '레벨'로 판단(시각 indent용 depth 와 분리) — 프로젝트 직속 태스크(level=task)는 depth 1 로 그려도 하위 추가 가능.
  const isTopTask = t.level !== 'subtask';
  const onAddSub = isTopTask ? (() => pjvAddTask(projectId, t.id, reload)) : null;
  const moreBtn = pjvRowMore(projectId, t, isTopTask ? 0 : 1, reload, onAddSub);

  const rowEl = el('div', { class: 'pjv-trow pjv-proj-taskrow' },
    titleCell,
    el('div', { class: 'pjv-tcell', 'data-col': 'team' }, pjvAssigneeControl(t, members, (pa) => pjvSaveTask(t.id, pa))), // 태스크는 담당자지만 보드 그리드의 '팀원' 열 자리(#611 순서 정렬 일치)
    el('div', { class: 'pjv-tcell', 'data-col': 'due' }, pjvDueControl(t, (pa) => pjvPatchTask(t.id, pa, reload))),
    el('div', { class: 'pjv-tcell pjv-datecell', 'data-col': 'start' }, el('span', { class: 'pjv-fval', text: t.start_date ? pjvFmtDate(t.start_date) : '' })),
    el('div', { class: 'pjv-tcell pjv-datecell', 'data-col': 'created' }, el('span', { class: 'pjv-fval', text: t.created_at ? pjvFmtDate(t.created_at) : '' })),
    el('div', { class: 'pjv-tcell pjv-datecell', 'data-col': 'updated' }, el('span', { class: 'pjv-fval', text: t.updated_at ? pjvFmtDate(t.updated_at) : '' })),
    el('div', { class: 'pjv-tcell', 'data-col': 'priority' }, pjvPriorityControl(t, (pa) => pjvPatchTask(t.id, pa, reload))),
    el('div', { class: 'pjv-tcell pjv-sess-cell', 'data-col': 'sess' }),
    ...(boardFields).map((f) => el('div', { class: 'pjv-tcell', 'data-col': 'f:' + f.id })),
    el('div', { class: 'pjv-tcell pjv-tcell-add' }, moreBtn));
  rowEl.style.gridTemplateColumns = pjvProjGridTemplate(boardFields);
  pjvApplyColOrder(rowEl, 'proj', boardFields); // 열 순서 적용(#611)
  wrap.append(rowEl);
  wrap.append(subBox);
  return wrap;
}

// 상태 그룹(진행 중/완료) — 헤더(점·라벨·개수·캐럿[, withCols 면 컬럼 라벨]) + 행들. 빈 그룹은 안내.
function pjvProjGroup(label, statusKey, list, reload, select, canDelete, withCols, fields, anchorId, meId, taskCtx?: any, sepTasks?: any, noAdd?: boolean, listId?: any, statusDef?: any) {
  fields = fields || [];
  sepTasks = sepTasks || [];
  // statusKey=null(#541 그룹바이 — 담당자/우선순위 등 비상태 그룹): 상태 점 없이 라벨만, 추가행 없음(noAdd 전제).
  const meta = statusDef ? { key: pjvNativeStatusOf(statusDef.category), label: statusDef.label, ...pjvCatMeta(statusDef.category) }
    : statusKey ? pjvProjStatusMeta(statusKey)
    : { key: 'in_progress', label, cls: '' };
  const cat = statusDef ? statusDef.category : (statusKey === 'done' ? 'done' : (statusKey === 'todo' ? 'todo' : 'active')); // 완료 여부 판정용
  const body = el('div', { class: 'pjv-tgroup-body' });
  pjvGroupReorderTarget(body, reload); // 그룹 내 수동 재정렬(#541) — 같은 그룹 본문 안 드롭 시 순서 저장
  const countEl = el('span', { class: 'pjv-tgroup-count', text: String(list.length + sepTasks.length) });
  if (list.length) { for (const p of list) body.append(pjvProjRow(p, reload, select, canDelete, fields, anchorId, taskCtx)); }
  else if (cat === 'done' && !sepTasks.length) body.append(el('div', { class: 'pjv-proj-empty', text: '완료한 프로젝트가 아직 없습니다.' }));
  // 분리(separate) 모드 — 각 프로젝트의 태스크를 상태 버킷에 평면 행으로(프로젝트 행과 같은 그리드). 프로젝트 행 아래, 추가행 위.
  for (const s of sepTasks) body.append(pjvProjTaskRow(s.projId, s.task, s.members, reload, 1, fields));
  // 클릭업식 인라인 추가행 — 각 그룹(완료 제외) 맨 아래. 빈 그룹에선 이 행이 '시작하기' CTA. 선택(일괄삭제) 모드에선 숨김.
  if (!select && cat !== 'done' && cat !== 'closed' && !noAdd) body.append(pjvProjAddRow(meta.key, reload, body, countEl, fields, select, canDelete, anchorId, meId, taskCtx, listId, statusDef));

  // 그룹 접힘 상태 — 리스트+그룹 단위로 localStorage 에 저장해 새로고침에도 유지(#req). 기본 펼침.
  const gid = statusDef ? statusDef.key : (statusKey || label);
  let gopen = pjvGrpOpenGet(listId, gid);
  body.hidden = !gopen;   // 저장된 상태가 접힘이면 로드 시점부터 접혀 보이게
  const gcaret = el('button', { class: 'pjv-tgroup-caret', type: 'button', text: gopen ? '▾' : '▸', 'aria-expanded': String(gopen) });
  gcaret.onclick = () => {
    gopen = !gopen; gcaret.textContent = gopen ? '▾' : '▸';
    gcaret.setAttribute('aria-expanded', gopen ? 'true' : 'false'); body.hidden = !gopen;
    pjvGrpOpenSet(listId, gid, gopen);   // 접힘/펼침 저장 → 다음 새로고침에 반영
  };
  const dot = statusDef ? pjvCustomStatusDot(statusDef, 'sm')
    : statusKey ? pjvStatusIconStd(meta.key, 'sm')
    : el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' }); // 비상태 그룹 — 점 없이 정렬만 유지
  // 상태 그룹 헤더 라벨 — 커스텀이든 기본(inherit)이든 같은 색 pill 로 통일(#670). 비상태 그룹(statusKey=null: 담당자·우선순위 등)만 밋밋 라벨.
  const labelEl = statusDef
    ? el('span', { class: 'pjv-tgroup-label pjv-status-pill', style: '--sc:' + statusDef.color, text: label })
    : statusKey
      ? el('span', { class: 'pjv-tgroup-label pjv-status-pill', style: '--sc:' + pjvNativeStatusColor(statusKey), text: label })
      : el('span', { class: 'pjv-tgroup-label', text: label });

  // 그룹 전체선택 체크박스(#664) — 헤더 좌측(행 체크박스와 같은 16px 자리). 레거시 선택(select) 모드에선 스페이서 유지.
  const headCheck = () => select
    ? el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' })
    : pjvGroupCheck('project', body);
  let head;
  if (withCols) {
    head = el('div', { class: 'pjv-tgroup-head pjv-tgroup-head-cols ' + meta.cls },
      el('div', { class: 'pjv-trow-title-cell' }, headCheck(), dot, labelEl, countEl, gcaret, pjvNameResizeHandle()),
      pjvStdColHead('proj', 'team', '팀원'),
      pjvStdColHead('proj', 'due', '마감일'),
      pjvStdColHead('proj', 'start', '시작일'),
      pjvStdColHead('proj', 'created', '생성일'),
      pjvStdColHead('proj', 'updated', '갱신일'),
      pjvStdColHead('proj', 'priority', '우선순위'),
      pjvStdColHead('proj', 'sess', '내 세션'),
      ...(fields || []).map((f) => pjvColumnHead(f, anchorId, reload)),
      el('div', { class: 'pjv-tcell pjv-tcell-add' }, anchorId ? pjvAddColumnButton(anchorId, reload, listId) : el('span', {}))); // #607/D 리스트별 필드 — 이 그룹의 리스트로 컬럼 추가
    head.style.gridTemplateColumns = pjvProjGridTemplate(fields);
    pjvApplyColOrder(head, 'proj', fields);                 // 열 순서 적용(#611)
    pjvWireColReorder(head, 'proj', fields || [], reload);  // 열 순서 드래그 재정렬(기본+커스텀, #611)
  } else {
    // 2번째+ 상태 그룹(non-cols) 헤더도 첫 그룹(withCols)·행과 동일하게 체크박스 자리(#664 전체선택)를 둬 상태점 가로 위치를 맞춘다
    //  (#613 후속 — 첫 그룹만 spacer 가 있어 그룹 간 상태 아이콘 들여쓰기가 어긋나 있었다).
    head = el('div', { class: 'pjv-tgroup-head ' + meta.cls }, headCheck(), dot, labelEl, countEl, gcaret);
  }
  return el('div', { class: 'pjv-tgroup' }, head, body);
}

// 프로젝트 인라인 추가행(클릭업식) — 태스크 add row 와 동형. 클릭→입력칸, Enter=생성(연속 추가 위해 입력 유지·낙관적 삽입), Esc/빈 blur=접기.
//  생성: POST /v6/projects {name} → 작성자=나(actor) 자동 → 내 보드 노출·삭제권한. '할 일' 그룹이면 생성 후 status=todo 패치(기본 생성은 active=진행 중).
//  담당자/마감/우선순위는 팀원이 아직 없어 행 생성 후 각 셀에서 지정(여기선 빈 칸으로 컬럼만 정렬). 모달 없이 그 자리에서.
function pjvProjAddRow(statusKey, reload, body, countEl, fields, select, canDelete, anchorId, meId, taskCtx, listId?, statusDef?) {
  fields = fields || [];
  const row = el('div', { class: 'pjv-addrow' });
  let indentParent: any = null; // Tab 들여쓰기(#663) — 바로 위 프로젝트의 '태스크'로 만들 때 그 부모 {id,name}. Shift+Tab 해제.
  // 접힌 트리거 '＋' 를 그룹 헤더 상태점 열에 맞춘다(#613 후속) — 옛 트리거는 체크박스 자리(check-spacer) 가 없어
  //  '＋ 프로젝트' 가 헤더 파이 아이콘·라벨보다 왼쪽으로 어긋났다. 헤더 title-cell 과 동일한 선두 spacer 로 정렬.
  const trigger = el('button', { class: 'pjv-addrow-trigger', type: 'button', 'data-tour': 'pd-new-project' },   // #853 '프로젝트 체험' 투어 앵커
    el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' }),
    el('span', { class: 'pjv-addrow-plus', text: '＋' }), el('span', { text: '프로젝트' }));
  const input = el('input', { type: 'text', class: 'pjv-addrow-input', placeholder: '프로젝트 이름 입력 후 Enter (Esc 취소)', maxlength: '200', spellcheck: 'false', autocomplete: 'off' });
  // 생성 전 드래프트 — 팀원·마감·우선순위를 그 자리(인라인 셀)에서 지정해 생성 직후 한 번에 반영(태스크 추가행 pjvAddRow 와 동형).
  const draft: any = { memberIds: [], due_date: null, priority: null };
  const cTeam = el('div', { class: 'pjv-tcell' });
  const cDue = el('div', { class: 'pjv-tcell' });
  const cPriority = el('div', { class: 'pjv-tcell' });
  const setDraft = (p) => { Object.assign(draft, p); paintDateCells(); setTimeout(() => { if (row.classList.contains('editing')) input.focus(); }, 0); };
  // 마감·우선순위 셀만 draft 값을 반영해 다시 그린다. 팀원 셀은 자체 선택 상태를 들고 있으므로 여기서 재생성하지 않는다
  //  (마감일·우선순위를 고를 때 setDraft 가 팀원 셀까지 빈 상태로 다시 그려 선택이 사라지던 버그 방지 — expand 에서 한 번만 생성).
  function paintDateCells() {
    cDue.replaceChildren(pjvDueControl(draft, setDraft));
    cPriority.replaceChildren(pjvPriorityControl(draft, setDraft));
  }
  // 제목 칸 — 실제 프로젝트 행과 동일 구조(체크박스 자리 spacer + 캐럿 자리 + 그룹 상태 동그라미 + 입력)로 그려 픽셀 정렬 일치.
  //  프로젝트 행엔 호버 체크박스(16px)가 자리를 차지하므로, 추가행에도 동일 폭 spacer 를 둬 말머리(상태점) 가로 위치를 맞춘다.
  const buildTitleCell = () => {
    const dotEl = indentParent ? pjvStatusIconStd('todo') // 들여쓰기(#663) — 태스크로 생성되므로 할 일 점선 링
      : statusDef ? pjvCustomStatusDot(statusDef)
      : pjvStatusIconStd(pjvProjStatusMeta(statusKey).key);
    const tc = el('div', { class: 'pjv-trow-title-cell' },
      el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' }),
      el('span', { class: 'pjv-trow-caret empty', 'aria-hidden': 'true' }),
      dotEl, input);
    if (indentParent) tc.style.paddingLeft = '22px'; // 하위(태스크) 위치 — 태스크 추가행(pjvAddRow)과 동일 톤
    return tc;
  };
  // Tab 들여쓰기 시각화(#663) — 제목 칸을 한 단 들이고 안내문을 부모 프로젝트 이름으로 바꾼다(pjvAddRow 동형).
  const applyIndent = () => {
    const old = row.querySelector('.pjv-trow-title-cell');
    if (old) old.replaceWith(buildTitleCell());
    input.placeholder = indentParent
      ? ('“' + (indentParent.name || '위 프로젝트') + '” 의 태스크 — 이름 입력 후 Enter (Shift+Tab 해제)')
      : '프로젝트 이름 입력 후 Enter (Esc 취소)';
    input.focus();
  };
  const collapse = () => { row.classList.remove('editing'); draft.memberIds = []; draft.due_date = draft.priority = null; indentParent = null; row.replaceChildren(trigger); };
  const expand = () => {
    row.classList.add('editing');
    row.style.gridTemplateColumns = pjvProjGridTemplate(fields);
    // 팀원 셀은 자체 선택 상태를 들고 있어 expand 시 한 번만 생성(이후 마감/우선순위 변경에 재생성하지 않아 선택 유지).
    cTeam.replaceChildren(pjvProjTeamControl([], (ids) => { draft.memberIds = ids; }));
    if (!cTeam.getAttribute('data-col')) cTeam.setAttribute('data-col', 'team');
    if (!cDue.getAttribute('data-col')) cDue.setAttribute('data-col', 'due');
    if (!cPriority.getAttribute('data-col')) cPriority.setAttribute('data-col', 'priority');
    paintDateCells();
    row.replaceChildren(
      buildTitleCell(),
      cTeam, cDue,
      el('div', { class: 'pjv-tcell', 'data-col': 'start' }), el('div', { class: 'pjv-tcell', 'data-col': 'created' }), el('div', { class: 'pjv-tcell', 'data-col': 'updated' }),
      cPriority, el('div', { class: 'pjv-tcell pjv-sess-cell', 'data-col': 'sess' }),
      ...(fields).map((f) => el('div', { class: 'pjv-tcell', 'data-col': 'f:' + f.id })),
      el('div', { class: 'pjv-tcell pjv-tcell-add' }));
    pjvApplyColOrder(row, 'proj', fields); // 열 순서 적용(#611)
    input.focus();
  };
  trigger.onclick = expand;
  // Tab 들여쓰기 커밋(#663) — 위 프로젝트의 '태스크'로 직접 생성(설정 팝업 없이, 태스크 추가행과 동일 경로).
  //  드래프트(팀원 첫 명→담당자·마감·우선순위)도 태스크 패치로 반영. 생성 후 그 프로젝트 태스크 캐시 무효화 + 리로드.
  let busyTask = false;
  const commitAsTask = async () => {
    if (busyTask || !indentParent) return;
    const name = input.value.trim();
    if (!name) { collapse(); return; }
    busyTask = true; input.disabled = true;
    try {
      const created = await api('/api/ui/v6/projects/' + indentParent.id + '/tasks', { method: 'POST', body: JSON.stringify({ name }) }).then((d) => d && d.task);
      const patch: any = {};
      if (draft.memberIds && draft.memberIds[0]) patch.assignee = draft.memberIds[0];
      if (draft.due_date) patch.due_date = draft.due_date;
      if (draft.priority) patch.priority = draft.priority;
      if (created && Object.keys(patch).length) await api('/api/ui/v6/tasks/' + created.id, { method: 'POST', body: JSON.stringify(patch) }).catch(() => {});
      if (taskCtx && taskCtx.invalidate) taskCtx.invalidate(indentParent.id);
      toast('“' + (indentParent.name || '위 프로젝트') + '” 에 태스크를 추가했습니다');
      pjvReloadKeepScroll(reload);
    } catch (err) { toast('태스크 추가 실패 — ' + err.message, true); input.disabled = false; busyTask = false; input.focus(); }   // focus 는 실패 후 blur 자동커밋 재진입을 막는다(아래 commit 의 catch 주석)
  };
  // Enter / 바깥클릭(blur) → **설정 팝업 없이 바로 생성**(#1067). 프리필(이름 + 그룹 상태 + 인라인 드래프트[팀원·마감·우선순위])
  //  대로 만들고, 태스크 추가행(pjvAddRow)과 똑같이 새 행을 그 자리에 끼운 뒤 입력을 열어 둬(keepOpen) 다음 프로젝트를
  //  바로 이어서 만들 수 있게 한다. 자세한 설정(설명·레포·태스크 등)이 필요하면 트리거 옆 '자세히'(pjvProjAddMenu)에서.
  //  Tab 들여쓰기 상태(#663)면 위 프로젝트의 태스크로 즉시 생성(종전과 동일).
  // Enter 를 눌러도 **기다리지 않는다**(#1581) — 예전엔 입력칸을 잠근 채 생성 + 상태 패치(+마감·우선순위 패치)
  //  왕복이 끝나야 다음 이름을 칠 수 있었다. 이제 이름·드래프트를 그 자리에서 챙겨 입력을 비우고 임시 행을 세운 뒤,
  //  생성은 뒤에서 돈다. 응답이 오면 임시 행을 진짜 행으로 바꾸고, 실패하면 걷어내며 친 이름을 되돌린다.
  const commit = (keepOpen) => {
    if (indentParent) { commitAsTask(); return; }
    const name = input.value.trim();
    if (!name) { if (!keepOpen) collapse(); return; }
    // 이 커밋이 쓸 드래프트를 **스냅샷**으로 떠 둔다 — 아래에서 곧바로 드래프트를 비우므로(다음 입력용) 참조를 남기면 안 된다.
    const memberIds = (draft.memberIds || []).slice();
    const dueDate = draft.due_date, priority = draft.priority;
    input.value = '';
    draft.memberIds = []; draft.due_date = draft.priority = null;
    if (keepOpen) { paintDateCells(); cTeam.replaceChildren(pjvProjTeamControl([], (ids) => { draft.memberIds = ids; })); input.focus(); } else collapse();
    const nativeStatus = statusDef ? pjvNativeStatusOf(statusDef.category) : (statusKey === 'todo' ? 'todo' : statusKey === 'done' ? 'done' : 'in_progress');
    // 낙관적 행 — 아직 id 가 없어 클릭·인라인 편집은 막아 둔다(pending). 자리·글자는 실제 행과 같아 흐름이 끊기지 않는다.
    const dotEl = statusDef ? pjvCustomStatusDot(statusDef) : pjvStatusIconStd(pjvProjStatusMeta(statusKey).key);
    const pending = el('div', { class: 'pjv-trow pjv-proj-row pjv-proj-row-pending' },
      el('div', { class: 'pjv-trow-title-cell' },
        el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' }),
        el('span', { class: 'pjv-trow-caret empty', 'aria-hidden': 'true' }),
        dotEl, el('span', { class: 'pjv-trow-title', text: name })));
    pending.style.gridTemplateColumns = pjvProjGridTemplate(fields);
    body.insertBefore(pending, row);
    if (countEl) countEl.textContent = String((parseInt(countEl.textContent, 10) || 0) + 1);
    const emptyEl = body.querySelector('.pjv-proj-empty'); if (emptyEl) emptyEl.remove();
    (async () => {
      try {
        // 생성 — 이름·팀원·리스트를 한 번에. (커스텀/비-진행중 상태·마감·우선순위는 생성 직후 패치.)
        const np = await api('/api/ui/v6/projects', { method: 'POST', body: JSON.stringify({
          name, members: memberIds.length ? memberIds : undefined,
          list_id: listId != null ? listId : undefined,
        }) }).then((d) => (d && d.project) || d);
        if (!np || !np.id) throw new Error('생성 응답에 프로젝트가 없어요');
        if (statusDef || nativeStatus !== 'in_progress') {
          await api('/api/ui/v6/projects/' + np.id + '/status', { method: 'POST', body: JSON.stringify({ status: nativeStatus, status_raw: statusDef ? statusDef.key : null }) }).catch(() => {});
        }
        const patch: any = {};
        if (dueDate) patch.due_date = dueDate;
        if (priority) patch.priority = priority;
        if (Object.keys(patch).length) await api('/api/ui/v6/projects/' + np.id, { method: 'POST', body: JSON.stringify(patch) }).catch(() => {});
        // 임시 행을 진짜 행으로 교체. 멤버 facepile 은 draft ids 로 임시 구성(다음 렌더에 정식화).
        const p = Object.assign({ priority: null, due_date: null, start_date: null, task_count: 0, field_values: {}, tags: [] }, np, patch, {
          status: nativeStatus, status_raw: statusDef ? statusDef.key : null, list_id: listId ?? np.list_id ?? null, members: memberIds.map((id) => ({ member_id: id })),
        });
        const real = pjvProjRow(p, reload, select, canDelete, fields, anchorId, taskCtx);
        if (pending.isConnected) pending.replaceWith(real); else body.insertBefore(real, row);
      } catch (err: any) {
        pending.remove();
        if (countEl) countEl.textContent = String(Math.max(0, (parseInt(countEl.textContent, 10) || 1) - 1));
        toast('프로젝트 생성 실패 — ' + (err.message || err), true);
        // 친 이름을 잃지 않게 되돌린다 — 입력칸이 비어 있을 때만(그 사이 다음 이름을 치고 있으면 건드리지 않는다).
        if (!input.value.trim()) { if (!row.classList.contains('editing')) expand(); input.value = name; input.focus(); }
      }
    })();
    // ⚠ #1614(실패 시 포커스 복원)는 여기서 **구조적으로** 해소된다 — 그 버그의 원인이던 `input.disabled = true`
    //  자체를 안 쓰기 때문이다(#1581 낙관적 생성). 잠금이 없으니 blur 가 안 뜨고, 그래서 바깥클릭 130ms
    //  자동커밋이 예약될 일도, 같은 이름이 두 번 커밋돼 실패 토스트가 겹칠 일도 없다. 실패 경로가 이름을
    //  되돌리며 focus() 하는 것도 그대로다(위 catch).
  };
  // 바깥클릭 — 드래프트 셀 팝오버가 열려 있거나 행 내부 포커스면 보류. 이름 있으면 생성(접기), 없으면 접기.
  //  ⚠ 팀원·마감·우선순위 팝오버는 `.pjv-pop` 이 아니라 `.pjv-menu`(마감=`.pjv-date-pop`) 를 쓴다 — `.pjv-pop` 만
  //   보면 그 셀을 여는 순간 blur 가 조기 생성해 **프로젝트가 두 개** 만들어졌다(#1067). 둘 다 가드한다.
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (busyTask || !row.classList.contains('editing')) return;
      if (document.querySelector('.pjv-pop, .pjv-menu')) return;
      if (row.contains(document.activeElement)) return;
      if (input.value.trim()) commit(false); else collapse();
    }, 130);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; collapse(); return; }
    if (e.key === 'Tab') {
      // Tab 들여쓰기(#663) — 바로 위 프로젝트 행을 부모로, 이 입력을 그 프로젝트의 '태스크'로(클릭업식 강등).
      //  Shift+Tab = 해제(다시 프로젝트로). 위에 프로젝트 행이 없으면(분리 태스크 행 등) 무시.
      e.preventDefault();
      if (e.shiftKey) { if (indentParent) { indentParent = null; applyIndent(); } return; }
      if (indentParent) return; // 3단계 위계상 태스크 아래로 더 못 내림(하위태스크는 태스크 행에서)
      const prev = row.previousElementSibling as HTMLElement | null;
      const pid = prev && prev.classList && prev.classList.contains('pjv-proj-wrap') ? prev.getAttribute('data-proj-id') : null;
      if (pid) { indentParent = { id: Number(pid), name: prev!.getAttribute('data-proj-name') || '' }; applyIndent(); }
      return;
    }
    // 한글(IME) 조합 중 Enter 는 글자 확정용 — 그때 커밋하면 마지막 글자가 중복된 이름이 만들어진다(#293 동형).
    //  Enter=연속 추가(keepOpen) — 만들고 입력을 열어 둬 다음 프로젝트를 바로 잇는다(태스크 추가행과 동형).
    if (e.key === 'Enter' && !e.isComposing && (e as any).keyCode !== 229) { e.preventDefault(); commit(true); }
  });
  collapse();
  return row;
}

export {
  PJV_CU_GROUP_MAP,
  PJV_GROUPBY_FIELDS,
  PJV_PRIORITY_RANK,
  pjvAlsoListKey,
  pjvColSortCmp,
  pjvContainerCmp,
  pjvGetAlsoList,
  pjvGetGroupBy,
  pjvGroupByStoreKey,
  pjvGroupScope,
  pjvGrpOpenGet,
  pjvGrpOpenKey,
  pjvGrpOpenSet,
  pjvManualCmp,
  pjvProjAddRow,
  pjvProjDelete,
  pjvProjGroup,
  pjvProjMore,
  pjvProjRename,
  pjvProjRow,
  pjvProjSessionCell,
  pjvProjStatusDot,
  pjvProjTaskRow,
  pjvProjTeamControl,
  pjvRenderFieldGroups,
  pjvRenderStatusGroups,
  pjvSetAlsoList,
  pjvSetGroupBy,
  pjvSetProjStatus,
  pjvSortProjects,
  projPatch,
};
