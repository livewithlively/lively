// dash/status.ts — 대시보드 상태계(#1313 R41 · dashboard-home.ts 에서 verbatim 분리).
//  ① 프로젝트 상태: 리스트 커스텀 상태 정규화 → 해석 → 아이콘(pjv* 동형 복제 — projects.ts 의 원본과 **통합하지 않는다**(#619)).
//  ② 태스크 native 상태 3단계. ③ AI 세션 상태(판정·정렬·죽음 여부는 공용 web/session-status.ts 에 위임 — #1059 P1).
//  ④ 상태 '메뉴'(dashProjStatusControl/dashTaskStatusControl) — R41 때는 팝오버 프리미티브(dashPopover/dashSubMenu)가
//   dashboard-home.ts 안에 있어 순환 때문에 못 왔다. R42 가 그 프리미티브를 dash/chrome.ts 로 내리면서 제자리로 돌아왔다.
import { api, el, sv, toast } from '../core.js';
import { SESS_STATES, sessStateKey, sessRank as sessRankShared, sessIsDead } from '../session-status.js';
import { dashPopover, dashSubMenu } from './chrome.js';
// ── 프로젝트 상태 아이콘(프로젝트 탭과 동일) — projects.ts 를 건드리지 않고 소형 동형 함수로 인라인(#619 재사용 원칙). ──
// 리스트 커스텀 상태 정의 정규화 + Active 버킷 진행도(frac) — pjvListStatusDefs/pjvAssignFracs 동형.
function dashListStatusDefs(list) {
    const s = list && list.settings;
    let defs;
    if (s && s.statusMode === 'custom' && Array.isArray(s.statuses) && s.statuses.length) {
        defs = s.statuses.filter((x) => x && x.key).map((x) => ({
            key: String(x.key), label: String(x.label || x.key), color: x.color || '#94a3b8',
            category: (x.category === 'done' || x.category === 'closed') ? x.category : 'active',
        }));
    }
    else {
        defs = [
            { key: 'todo', label: '할 일', color: '#94a3b8', category: 'active' },
            { key: 'active', label: '진행 중', color: '#f59e0b', category: 'active' },
            { key: 'done', label: '완료', color: '#22c55e', category: 'done' },
        ];
    }
    const act = defs.filter((d) => d.category === 'active');
    act.forEach((d, i) => { d.frac = act.length > 0 ? i / act.length : 0; });
    return defs;
}
// 프로젝트 → 상태 def 해석 — status_raw 우선, 미스매치는 네이티브 status 로 흡수(pjvResolveProjStatus 동형).
function dashResolveStatus(p, defs) {
    const rawKey = p.status_raw || p.status;
    let d = defs.find((x) => x.key === rawKey);
    if (!d) {
        if (p.status === 'done')
            d = defs.find((x) => x.category === 'done') || defs.find((x) => x.category === 'closed');
        else
            d = defs.find((x) => x.category === 'active');
    }
    return d || defs[0];
}
// 상태 아이콘(SVG) — pjvStatusIcon 동형: Active=진행도 파이(frac=0→점선 빈 링='할일') · Done=색 링+체크 · Closed=꽉 찬 원+흰 체크.
function dashStatusIconSvg(category, color, frac) {
    const c = color || 'var(--muted-3)';
    const R = 9, cx = 12, cy = 12;
    const svg = sv('svg', { class: 'pjv-status-ic', viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' });
    if (category === 'done' || category === 'closed') {
        const filled = category === 'closed';
        svg.append(sv('circle', { cx, cy, r: R, 'stroke-width': 2, style: 'fill:' + (filled ? c : 'none') + ';stroke:' + c }));
        svg.append(sv('path', { d: 'M7.7 12.3l2.7 2.7 5.9-6.2', 'stroke-width': 2.1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', style: 'fill:none;stroke:' + (filled ? '#fff' : c) }));
        return svg;
    }
    const f = Math.max(0, Math.min(0.995, frac || 0));
    if (f < 0.001) {
        svg.append(sv('circle', { cx, cy, r: R, 'stroke-width': 2, 'stroke-dasharray': '2.2 2.4', style: 'fill:none;stroke:' + c }));
    }
    else {
        svg.append(sv('circle', { cx, cy, r: R, 'stroke-width': 2, opacity: 0.3, style: 'fill:none;stroke:' + c }));
        const th = f * 2 * Math.PI;
        const ex = (cx + R * Math.sin(th)).toFixed(2), ey = (cy - R * Math.cos(th)).toFixed(2);
        const large = f > 0.5 ? 1 : 0;
        svg.append(sv('path', { d: 'M' + cx + ' ' + cy + 'L' + cx + ' ' + (cy - R) + 'A' + R + ' ' + R + ' 0 ' + large + ' 1 ' + ex + ' ' + ey + 'Z', style: 'fill:' + c }));
    }
    return svg;
}
// 프로젝트 → 상태 아이콘. 리스트 커스텀 상태(있으면) 반영, 없으면 표준 3단계(pjvStatusIconStd 동형).
function dashProjStatusIcon(p, listById) {
    const l = p.list_id != null ? listById.get(p.list_id) : null;
    const s = l && l.settings;
    if (s && s.statusMode === 'custom' && Array.isArray(s.statuses) && s.statuses.length) {
        const def = dashResolveStatus(p, dashListStatusDefs(l));
        return dashStatusIconSvg(def.category, def.color, def.frac);
    }
    // 기본 3단계 색 — 프로젝트 탭 PJV_DEFAULT_STATUS_DEFS(상태 편집 창)와 동일 가족(#667): 회색 할일·주황 진행·초록 완료.
    if (p.status === 'done')
        return dashStatusIconSvg('done', '#22c55e');
    if (p.status === 'todo')
        return dashStatusIconSvg('active', '#94a3b8', 0);
    return dashStatusIconSvg('active', '#f59e0b', 0.5);
}
// ⚠ 색은 dashProjStatusIcon 의 네이티브 폴백(#94a3b8 할일·#f59e0b 진행·#22c55e 완료)과 반드시 일치시킨다 —
//  행 아이콘과 팝아웃 메뉴가 같은 상태를 다른 색으로 보이던 버그(#req: '주황 아이콘 → 파랑 팝아웃') 원인이었다.
const DASH_NATIVE_STATUS = [
    { key: 'todo', label: '할 일', icon: () => dashStatusIconSvg('active', '#94a3b8', 0) },
    { key: 'in_progress', label: '진행 중', icon: () => dashStatusIconSvg('active', '#f59e0b', 0.5) },
    { key: 'done', label: '완료', icon: () => dashStatusIconSvg('done', '#22c55e') },
];
async function dashSetProjStatus(p, patch, redraw) {
    try {
        await api('/api/ui/v6/projects/' + p.id + '/status', { method: 'POST', body: JSON.stringify(patch) });
        p.status = patch.status;
        if ('status_raw' in patch)
            p.status_raw = patch.status_raw;
        toast(patch.status === 'done' ? '완료로 옮겼습니다' : '상태를 변경했습니다');
        redraw();
    }
    catch (e) {
        toast('실패 — ' + (e && e.message || e), true);
    }
}
// ── ③ AI 세션 상태 — 판정·라벨·정렬·죽음 여부는 전부 공용 web/session-status.ts 위임(대시보드 전용 래퍼). ──
// #req 세션 상태(4단계) → { key, label }. 서버가 CPU·pane 내용으로 판정한 s.agentState 를 그대로 매핑.
//  busy=작업중(주황) / waiting=확인 필요(빨강, 사용자 선택·승인 대기) / idle=대기중(초록) / offline=오프라인(회색).
// #1059 P1 — 상태 판정·라벨은 공용 정의(web/session-status.ts)에 위임한다. 종전엔 여기서 따로 만들어
//  띄어쓰기('작업중' vs '작업 중')·색 위계·정렬이 AI 세션 탭과 갈라졌고, '작업 완료'는 여기만 있었다.
function dashSessState(s) {
    const key = sessStateKey(s);
    const def = SESS_STATES[key] || SESS_STATES.exited;
    // ⚠ CSS 는 `cls`(하이픈) 기준이다 — key(언더스코어)로 클래스를 만들면 `is-exited_user` 처럼 셀렉터와
    //  어긋나 색이 아예 안 먹는다(#1251 리뷰에서 발견: `.is-exited-user` 규칙이 그동안 죽어 있었다).
    //  key 와 cls 가 같은 상태(shell·done·busy…)는 종전과 동일하고, 다른 것만 이제 제대로 칠해진다.
    return { key, label: def.label, cls: def.cls };
}
// '지금 볼 것 먼저' 정렬의 상태 우선순위(작을수록 위) — 사람이 행동해야 하는 순서.
function dashSessRank(s) { return sessRankShared(s); }
// 'AI 가 더 안 도는' 세션인가 — 예전 key==='offline' 판정을 대체한다(exited·offline·restorable 모두 죽은 것 — #1059 E 포함).
function dashSessDead(s) { return sessIsDead(s); }
// ── ② 태스크 상태 — native 3단계 고정(리스트 커스텀 어휘는 프로젝트에만 있다). ──
// 태스크 native 상태 3단계(할 일·진행 중·완료) — 색은 프로젝트 상태 아이콘과 통일.
const DASH_TASK_STATUS = [
    { key: 'todo', label: '할 일', mk: () => dashStatusIconSvg('active', '#94a3b8', 0) },
    { key: 'in_progress', label: '진행 중', mk: () => dashStatusIconSvg('active', '#f59e0b', 0.5) },
    { key: 'done', label: '완료', mk: () => dashStatusIconSvg('done', '#22c55e') },
];
function dashTaskStatusIcon(t) {
    if (t.status === 'done' || t.status_category === 'done' || t.status_category === 'closed')
        return dashStatusIconSvg('done', '#22c55e');
    if (t.status === 'todo')
        return dashStatusIconSvg('active', '#94a3b8', 0);
    return dashStatusIconSvg('active', '#f59e0b', 0.5);
}
// ── ④ 상태 메뉴(#1313 R42 이관) — 아이콘을 눌러 상태를 바꾸는 컨트롤. 표시(위 아이콘)와 변경(여기)이 한 파일에 모였다. ──
// ── 상태 변경(#req) — 대시보드 프로젝트 행에서 상태 동그라미 클릭 → 상태 메뉴. 프로젝트 탭 pjvProjStatusDot 동형(projects.ts 무수정, 인라인). ──
//  커스텀 상태 리스트면 그 상태들을(Active/Done/Closed 그룹), 아니면 표준 3단계(할 일·진행 중·완료). 선택 시 /status POST + 로컬 반영 + 재렌더.
function dashProjStatusControl(p, listById, redraw) {
    const l = p.list_id != null ? listById.get(p.list_id) : null;
    const s = l && l.settings;
    const custom = !!(s && s.statusMode === 'custom' && Array.isArray(s.statuses) && s.statuses.length);
    const btn = el('button', { class: 'dash-projstatus-btn', type: 'button', title: '상태 변경', 'aria-label': '상태 변경' }, dashProjStatusIcon(p, listById));
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation(); // 행 앵커(프로젝트 상세)로 전파 막기 — 메뉴만 연다.
        const menu = el('div', { class: 'pjv-menu dash-statusmenu' }); // dash-statusmenu = 카드 배경(기존 dashPopover 는 .dash-pop=위치만 부여)
        const close = dashPopover(btn, menu);
        if (custom) {
            const defs = dashListStatusDefs(l);
            const cur = dashResolveStatus(p, defs);
            for (const catKey of ['active', 'done', 'closed']) {
                for (const d of defs.filter((x) => x.category === catKey)) {
                    const isCur = d.key === (cur && cur.key);
                    const item = el('button', { class: 'pjv-menu-item' + (isCur ? ' sel' : ''), type: 'button' }, dashStatusIconSvg(d.category, d.color, d.frac), el('span', { text: d.label }));
                    item.onclick = () => { close(); if (!isCur)
                        dashSetProjStatus(p, { status: (d.category === 'done' || d.category === 'closed') ? 'done' : 'in_progress', status_raw: d.key }, redraw); };
                    menu.append(item);
                }
            }
        }
        else {
            const curKey = p.status || 'todo';
            for (const st of DASH_NATIVE_STATUS) {
                const isCur = curKey === st.key;
                const item = el('button', { class: 'pjv-menu-item' + (isCur ? ' sel' : ''), type: 'button' }, st.icon(), el('span', { text: st.label }));
                item.onclick = () => { close(); if (!isCur)
                    dashSetProjStatus(p, { status: st.key }, redraw); };
                menu.append(item);
            }
        }
    });
    return btn;
}
// 태스크 상태 아이콘 = 클릭 시 상태 변경 메뉴(#req). 태스크는 native(todo|in_progress|done) — POST /tasks/:id {status}(프로젝트 탭과 동일).
function dashTaskStatusControl(t, onChanged) {
    const btn = el('button', { class: 'dash-taskstatus-btn', type: 'button', title: '상태 변경', 'aria-label': '상태 변경' }, dashTaskStatusIcon(t));
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const cur = (t.status === 'done' || t.status_category === 'done' || t.status_category === 'closed') ? 'done' : (t.status || 'todo');
        const menu = el('div', { class: 'dash-statusmenu' });
        const close = dashSubMenu(btn, menu); // 부모 팝오버(.dash-pop)를 안 닫는 중첩 메뉴
        for (const st of DASH_TASK_STATUS) {
            const isCur = cur === st.key;
            const item = el('button', { class: 'pjv-menu-item' + (isCur ? ' sel' : ''), type: 'button' }, st.mk(), el('span', { text: st.label }));
            item.onclick = async () => { close(); if (isCur)
                return; try {
                await api('/api/ui/v6/tasks/' + t.id, { method: 'POST', body: JSON.stringify({ status: st.key }) });
                toast('상태를 변경했어요');
                onChanged && onChanged();
            }
            catch (e2) {
                toast('실패 — ' + (e2 && e2.message || e2), true);
            } };
            menu.append(item);
        }
    });
    return btn;
}
export { dashListStatusDefs, dashResolveStatus, dashStatusIconSvg, dashProjStatusIcon, DASH_NATIVE_STATUS, dashSetProjStatus, dashSessState, dashSessRank, dashSessDead, DASH_TASK_STATUS, dashTaskStatusIcon, dashProjStatusControl, dashTaskStatusControl, };
