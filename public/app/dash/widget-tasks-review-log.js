// dash/widget-tasks-review-log.ts — 소형 위젯 3종(#1313 R43 · dashboard-home.ts 에서 verbatim 분리).
//  ⑥ 내 할 일 · ⑦ 검토 대기 지식 · ④ 팀 작업 로그. 셋 다 "목록 한 벌 + ⚙ 기본 필터"라는 같은 뼈대라 한 파일에 모았다.
//  ⚠ 여기 함께 사는 것들(다른 파일에서 못 떼는 이유):
//   · dashModal — 이 파일의 작업로그/작업상세 팝업이 쓰고, 공유폴더 위젯(widget-folders)·셸의 '대시보드 편집'도 쓴다.
//     세 소비자의 공통 조상이라 여기 두고 그쪽이 import 한다(셸에 두면 shell ↔ widget-* 순환).
//   · DASH_ACT_TONE — 작업 로그의 유형점과 최신 알림의 활동 타일이 **같은 매핑**을 봐야 한다(widget-notifications 가 import).
//   · dashDueDays/dashDueLabel — 마감일 계산 1벌(#1313 R43). 예전엔 여기 dashDueDays 와 알림 쪽 dueInDays 가
//     같은 값을 서로 다른 파싱으로 구했다(주석이 자인). 로컬 자정 파싱이 더 방어적인 이쪽을 남기고 그쪽을 지웠다 —
//     라벨 문구는 자리마다 달라(‘3일 남음’ vs ‘3일 뒤’) 계산만 합쳤다.
import { api, el, errorNote, relTime } from '../core.js';
// 작업 상세 = 회사 타임라인·프로젝트 타임라인과 **같은** 범용 템플릿(#852) — 한 곳에서 고치면 모든 뷰가 같이 나아진다.
import { activityDetailView, activityHasDetail } from '../activity-view.js';
// 작업 로그 전체 보기 팝업 = 회사 활동 피드 재사용.
import { companyTimelineSection, pjvOpenProjectModal } from '../projects.js';
import { pjvOpenTaskModal } from '../taskmodal.js'; // #1232 '내 할 일' 행 클릭 = 태스크 모달(#810) — 대시보드를 떠나지 않는다
import { dashLogType, dashRvwFilterDefault, dashSaveLogType, dashSaveRvwFilter, dashSaveTaskFilter, dashTaskFilterDefault } from './prefs.js';
import { dashTaskStatusControl } from './status.js';
import { dashChips, dashChoicePopover, dashCtl, dashEmpty, dashPopover } from './chrome.js';
// 작업 유형 → 점 톤/라벨 — 작업 현황(activity-view.ts ACT_TYPE_TONE)과 동일 매핑(성격축 8종).
const DASH_ACT_TONE = { feature: 'mint', fix: 'coral', decision: 'blue', docs: 'teal', research: 'violet', review: 'amber', chore: 'mut', other: 'mut' };
const DASH_ACT_LABEL = { feature: '기능', fix: '수정', decision: '결정', docs: '문서', research: '리서치', review: '검토', chore: '운영', other: '기타' };
// ── 경량 모달(중앙 오버레이) — 배경/✕/Esc 로 닫힘. 공유 폴더 전체 보기 등. ──
// opts.persistent: 바깥 클릭으로 안 닫힘(✕·Esc 만) — 파일탐색기처럼 오래 머무는 창의 오조작 방지.
// opts.resizable: 모달 우하단 드래그로 크기 조절(공유 폴더/미리보기 창을 키워 크게 보기).
function dashModal(title, content, wide, opts) {
    document.querySelectorAll('.dash-modal-ov').forEach((n) => n.remove());
    const closeBtn = el('button', { class: 'dash-modal-x', type: 'button', 'aria-label': '닫기', text: '✕' });
    const cls = 'dash-modal' + (wide ? ' dash-modal--wide' : '') + (opts && opts.resizable ? ' dash-modal--resizable' : '');
    const box = el('div', { class: cls, role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, el('div', { class: 'dash-modal-head' }, el('strong', { text: title }), closeBtn), el('div', { class: 'dash-modal-body' }, content));
    const ov = el('div', { class: 'dash-modal-ov' }, box);
    // opts.history: 열 때 히스토리 항목 push → 브라우저 뒤로가기가 대시보드를 이동시키지 않고 이 팝업만 닫는다(라우터는 hashchange 기반이라 같은 해시 push 는 라우팅 안 함). knowledge-doc peek 와 동형.
    const useHistory = !!(opts && opts.history);
    let byPop = false;
    const close = () => {
        ov.remove();
        document.removeEventListener('keydown', onKey, true);
        if (useHistory) {
            window.removeEventListener('popstate', onPop);
            if (!byPop) {
                try {
                    history.back();
                }
                catch { /* */ }
            }
        }
    };
    const onKey = (e) => { if (e.key === 'Escape')
        close(); };
    const onPop = () => { byPop = true; close(); };
    if (!(opts && opts.persistent))
        ov.addEventListener('mousedown', (e) => { if (e.target === ov)
            close(); });
    closeBtn.onclick = close;
    document.addEventListener('keydown', onKey, true);
    if (useHistory) {
        try {
            history.pushState({ dashModal: true }, '');
        }
        catch { /* */ }
        window.addEventListener('popstate', onPop);
    }
    document.body.append(ov);
    return close;
}
// ── ⑥ 내 할 일 — 내가 담당인 미완료 태스크를 프로젝트 가로질러(#1232 후속). ──
//  프로젝트 보드의 '내 할당만'은 **이미 보고 있는 프로젝트**를 거르는 축이라, "내 일 전부"를 볼 자리가 없었다.
//  GET /v6/my-tasks(마감 임박순) → 기한 버킷으로 묶는다. 상태 동그라미(dashTaskStatusControl)·태스크 모달(#810)은
//  프로젝트 탭과 **같은 프리미티브**를 그대로 쓴다 — 대시보드에서 상태를 바꾸면 프로젝트 탭에서 바꾼 것과 동일하다.
// 'YYYY-MM-DD' → 오늘 기준 남은 일수(음수=지남). due_date 는 TEXT 라 UTC 파싱 시 KST 에서 하루 밀린다(스키마 주석) —
//  로컬 자정끼리 비교하려고 숫자로 쪼개 new Date(y,m,d) 로 만든다. Date 파서에 문자열을 넘기지 말 것.
//  ⚠ 대시보드의 **유일한** 마감 일수 계산이다(#1313 R43) — 알림 위젯(다가오는 마감)도 이걸 부른다. 두 벌로 갈리면
//   같은 날짜가 화면마다 다른 D-값이 되는데, 그 어긋남은 눈으로 안 보인다.
function dashDueDays(due) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(due || ''));
    if (!m)
        return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return Math.round((d.getTime() - t.getTime()) / 86400000);
}
function dashDueLabel(n) {
    if (n == null)
        return '';
    if (n < 0)
        return -n + '일 지남';
    if (n === 0)
        return '오늘';
    if (n === 1)
        return '내일';
    return n + '일 남음';
}
// 기한 버킷 — 위에서 아래로 급한 순. '기한 없음'은 맨 아래(있는 일은 잊지 않게, 없는 일은 묻히지 않게).
const DASH_TASK_BUCKETS = [
    { key: 'over', label: '기한 지남', hit: (n) => n != null && n < 0 },
    { key: 'today', label: '오늘', hit: (n) => n === 0 },
    { key: 'week', label: '이번 주', hit: (n) => n != null && n > 0 && n <= 7 },
    { key: 'later', label: '나중', hit: (n) => n != null && n > 7 },
    { key: 'none', label: '기한 없음', hit: (n) => n == null },
];
async function fillMyTasks(zone) {
    let tasks;
    try {
        tasks = await api('/api/ui/v6/my-tasks').then((d) => (d && d.tasks) || []);
    }
    catch (e) {
        zone.body.replaceChildren(errorNote(e, '내 할 일을 불러오지 못했습니다'));
        return;
    }
    let mode = dashTaskFilterDefault();
    // 상태를 바꾸면(완료 처리 등) 목록에서 빠져야 하므로 서버에서 다시 받는다. 실패 시 기존 목록 유지.
    const reload = async () => {
        try {
            tasks = await api('/api/ui/v6/my-tasks').then((d) => (d && d.tasks) || []);
        }
        catch { /* 기존 유지 */ }
        draw();
    };
    const taskRow = (t) => {
        const n = dashDueDays(t.due_date);
        const cell = el('div', { class: 'pjv-trow-title-cell' }, dashTaskStatusControl(t, reload), el('span', { class: 'pjv-trow-title clickable', title: t.name || '', text: t.name || '(제목 없음)' }));
        if (t.due_date)
            cell.append(el('span', { class: 'dash-task-due' + (n != null && n < 0 ? ' over' : n === 0 ? ' now' : ''), title: '마감 ' + t.due_date, text: dashDueLabel(n) }));
        // 소속 프로젝트 — 태스크만 보면 '무슨 일의 일부인지'를 잃는다. 눌러서 그 프로젝트로.
        if (t.project_name && t.project_id) {
            const pb = el('span', { class: 'dash-badge dash-rowchip dash-task-proj', role: 'button', tabindex: '0', title: t.project_name + ' 열기', text: t.project_name });
            const openP = (e) => { e.preventDefault(); e.stopPropagation(); pjvOpenProjectModal(Number(t.project_id), reload); };
            pb.addEventListener('click', openP);
            pb.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ')
                openP(e); });
            cell.append(pb);
        }
        // 행 클릭 = 태스크 모달(#810). href 를 남겨 ⌘/Ctrl/중클릭·새 탭은 딥링크로 열리게.
        const row = el('a', { class: 'dash-projrow2', href: '#/projects2/t/' + t.id }, cell);
        row.addEventListener('click', (e) => {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
                return;
            e.preventDefault();
            pjvOpenTaskModal(Number(t.id), reload);
        });
        return row;
    };
    const draw = () => {
        zone.countEl.textContent = String(tasks.length);
        dashChips(zone.chipsEl, [['all', '전체'], ['soon', '마감 임박']], mode, (k) => { mode = k; draw(); });
        // '마감 임박' = 기한이 있고 7일 이내(지난 것 포함). 기한 없는 일은 이 칩에서 빠진다.
        const shown = mode === 'soon' ? tasks.filter((t) => { const n = dashDueDays(t.due_date); return n != null && n <= 7; }) : tasks;
        if (!shown.length) {
            zone.body.replaceChildren(dashEmpty(mode === 'soon' ? '이번 주 안에 마감인 일이 없어요.' : '나에게 할당된 일이 없어요.'));
            return;
        }
        const box = el('div', { class: 'dash-tasklist' });
        for (const b of DASH_TASK_BUCKETS) {
            const arr = shown.filter((t) => b.hit(dashDueDays(t.due_date)));
            if (!arr.length)
                continue;
            box.append(el('div', { class: 'dash-task-gh' + (b.key === 'over' ? ' over' : '') }, el('span', { text: b.label }), el('span', { class: 'dash-task-gn', text: String(arr.length) })));
            for (const t of arr)
                box.append(taskRow(t));
        }
        zone.body.replaceChildren(box);
    };
    dashCtl(zone, {
        gear: { title: '내 할 일 설정', open: (a) => dashChoicePopover(a, '기본 필터', [['all', '전체'], ['soon', '마감 임박']], dashTaskFilterDefault(), (k) => { dashSaveTaskFilter(k); mode = k; draw(); }) },
        action: { href: '#/projects2', title: '프로젝트 탭으로' },
    });
    draw();
}
// ── ⑦ 검토 대기 지식 — 승인해야 검색·세션주입에 들어간다(#1232 후속, #802/#783 큐의 상시 표면). ──
//  pending 은 검색·세션주입에서 격리돼 있어, 쌓이면 "AI 가 기록했는데 아무도 못 쓰는" 맥락이 된다.
//  지금까지 이 큐는 관리 화면에 들어가야만 보였고 대시보드엔 알림 한 줄로만 스쳐 지나갔다.
//  신규(lifecycle=pending 지식) + 수정(pending 리비전)을 한 목록으로 합쳐 최신순 — 검토 큐(#/knowledge/review)의 집합과 동일.
async function fillReviewQueue(zone) {
    let sum, pend, revs;
    try {
        [sum, pend, revs] = await Promise.all([
            api('/api/ui/review-queue/summary').catch(() => null), // 실패해도 목록은 살린다(내 도메인 칩만 빠짐)
            api('/api/ui/knowledge?lifecycle=pending&light=1&limit=50&orderBy=updated_at').then((d) => (d && d.entries) || []),
            api('/api/ui/knowledge-revisions?status=pending&limit=50').then((d) => (d && d.entries) || []),
        ]);
    }
    catch (e) {
        zone.body.replaceChildren(errorNote(e, '검토 대기 목록을 불러오지 못했습니다'));
        return;
    }
    // 내 도메인 = 내 팀이 오너인 카테고리(summary 가 계산해 준다). 없으면 그 칩 자체를 띄우지 않는다.
    const mineKeys = new Set(((sum && sum.mine_category_keys) || []).map(String));
    const items = [
        ...pend.map((k) => ({ kind: 'new', name: k.name, title: k.title || k.name, cat: k.category_key || null, catName: k.category_name || null, when: k.updated_at, who: k.updated_by || null })),
        ...revs.map((r) => ({ kind: 'edit', name: r.name, title: r.k_title || r.name, cat: r.category_key || null, catName: r.category_name || null, when: r.updated_at, who: r.agent || r.proposed_by || null })),
    ].sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')));
    let mode = mineKeys.size ? dashRvwFilterDefault() : 'all';
    const draw = () => {
        const shown = mode === 'mine' ? items.filter((it) => it.cat && mineKeys.has(String(it.cat))) : items;
        zone.countEl.textContent = String(items.length);
        dashChips(zone.chipsEl, mineKeys.size ? [['all', '전체'], ['mine', '내 도메인']] : [], mode, (k) => { mode = k; draw(); });
        if (!shown.length) {
            zone.body.replaceChildren(dashEmpty(mode === 'mine' ? '내 도메인에 검토 대기가 없어요.' : '검토 대기 중인 지식이 없어요.'));
            return;
        }
        // 행 클릭 = 검토 큐(#/knowledge/review) — 승인/반려가 일어나는 곳. 지식 본문만 보고 싶으면 제목 옆 '열기'.
        zone.body.replaceChildren(...shown.map((it) => el('a', { class: 'dash-row dash-rvw', href: '#/knowledge/review', title: it.title }, el('span', { class: 'dash-rvw-kind' + (it.kind === 'new' ? ' new' : ' edit'), text: it.kind === 'new' ? '신규' : '수정' }), el('span', { class: 'dash-rvw-nm', text: it.title }), it.catName ? el('span', { class: 'dash-rvw-cat', text: it.catName }) : null, el('span', { class: 'dash-rvw-when', text: it.when ? relTime(it.when) : '' }))));
    };
    dashCtl(zone, {
        gear: { title: '검토 대기 설정', open: (a) => dashChoicePopover(a, '기본 필터', [['all', '전체'], ['mine', '내 도메인']], dashRvwFilterDefault(), (k) => { dashSaveRvwFilter(k); mode = mineKeys.size ? k : 'all'; draw(); }) },
        action: { href: '#/knowledge/review', title: '검토 큐 열기' },
    });
    draw();
}
// ── ④ 팀 작업 로그 — 회사 전체 활동 피드(유형점 + 요약 + 사람·AI·상대시간). 유형 드롭다운 필터. ──
//  #852 로 클릭 두 갈래를 갈랐다 — 이전엔 **행을 눌러도 ⤢(전체 보기)와 똑같은 전체 목록**이 떠서,
//  "이 작업이 궁금해서 눌렀는데 왜 전체가 뜨지?"가 됐다. 이제:
//   · 행 클릭  → 그 작업 **한 건**의 상세 팝업(openActivityModal)
//   · ⤢ 클릭  → 전체 작업 로그 팝업(넓은 창 + 한 번에 쭉 — 6개씩 끊어 보여주던 것 폐지)
function openWorklogPopup() { dashModal('작업 로그', companyTimelineSection(), true); }
// 작업 한 건 상세 — 목록 인라인 펼침과 같은 범용 템플릿(activityDetailView)을 팝업에 담는다.
function openActivityModal(a, nameOf) {
    const view = activityDetailView(a, nameOf, { head: true });
    // 상세가 얇은 작업(제목·시각뿐)이면 팝업이 텅 빈 것처럼 보인다 — 비었다는 사실을 말해 준다.
    if (!activityHasDetail(a)) {
        view.append(el('div', { class: 'act-doc-empty', text: '이 작업에는 기록된 상세 내용이 없습니다. AI가 본문·연결 지식을 남기면 여기에 보입니다.' }));
    }
    dashModal('작업 상세', view, true);
}
async function fillActivity(zone) {
    let rows, people;
    try {
        [rows, people] = await Promise.all([
            api('/api/ui/activity/list?limit=60').then((d) => (Array.isArray(d) ? d : (d && d.rows) || [])),
            api('/api/ui/dash/people').then((d) => (d && d.people) || []).catch(() => []),
        ]);
    }
    catch (e) {
        zone.body.replaceChildren(errorNote(e, '작업 로그를 불러오지 못했습니다'));
        return;
    }
    // 활동 로그는 닉네임 우선 표시(#762) — 닉네임 비었으면 이름(display_name) 폴백.
    const nameOf = (pid) => {
        if (!pid)
            return '';
        const m = people.find((x) => x.author_person === pid);
        return (m && (m.nickname || m.display_name)) || pid;
    };
    // #req R14 — 팀원(인물) 필터 제거 → '팀이 한 작업의 성격(유형)'으로 필터. 유형 = feature·fix·decision·docs·research·review·chore·other.
    const TYPE_ORDER = ['feature', 'fix', 'decision', 'docs', 'research', 'review', 'chore', 'other'];
    const typesPresent = TYPE_ORDER.filter((t) => rows.some((a) => (a.type || 'other') === t));
    const typeOpts = [['', '전체'], ...typesPresent.map((t) => [t, DASH_ACT_LABEL[t] || t])];
    let typeF = dashLogType(); // 저장된 기본 유형 필터(없거나 무효면 전체)
    if (typeF && !typesPresent.includes(typeF))
        typeF = '';
    // #req 유형이 많아 칩으로 다 늘어놓으면 헤더가 넘침 → 헤더엔 '현재 선택 ▾' 드롭다운 하나만(1행 유지).
    const openTypeMenu = (anchor) => {
        const panel = el('div', { class: 'dash-pop-panel' });
        panel.append(el('div', { class: 'dash-pop-head' }, el('strong', { text: '유형 필터' })));
        let closeM = () => { };
        for (const [k, label] of typeOpts) {
            const b = el('button', { class: 'dash-pop-opt' + (k === typeF ? ' sel' : ''), type: 'button' }, el('span', { class: 'dash-pop-name', text: label }), k === typeF ? el('span', { class: 'dash-pop-check', text: '✓' }) : null);
            b.onclick = () => { closeM(); typeF = k; draw(); };
            panel.append(b);
        }
        closeM = dashPopover(anchor, panel);
    };
    // 헤더 우상단 통일 컨트롤 — ⚙(기본 유형 필터 저장) + ⤢(전체 작업 로그 모달).
    dashCtl(zone, { gear: { title: '작업 로그 표시 설정', open: (a) => dashChoicePopover(a, '기본 유형 필터', typeOpts, typeF, (k) => { dashSaveLogType(k); typeF = k; draw(); }) }, action: { onClick: openWorklogPopup, title: '전체 작업 로그 보기' } });
    const draw = () => {
        const shown = typeF ? rows.filter((a) => (a.type || 'other') === typeF) : rows;
        zone.countEl.textContent = String(shown.length);
        const curLabel = (typeOpts.find(([k]) => k === typeF) || ['', '전체'])[1];
        const dd = el('button', { class: 'dash-chip dash-chip-dd' + (typeF ? ' on' : ''), type: 'button', 'aria-haspopup': 'true', title: '작업 유형 필터' }, el('span', { text: curLabel }), el('span', { class: 'dash-chip-caret', 'aria-hidden': 'true', text: '▾' }));
        dd.onclick = () => openTypeMenu(dd);
        zone.chipsEl.replaceChildren(dd);
        if (!shown.length) {
            zone.body.replaceChildren(dashEmpty(typeF ? '이 유형의 작업이 없어요.' : '아직 기록된 작업이 없어요.'));
            return;
        }
        zone.body.replaceChildren(...shown.map((a) => {
            const when = a.committed_at || a.created_at;
            const sub = [nameOf(a.author_person), a.author_agent, when ? relTime(when) : '']
                .filter(Boolean).join(' · ');
            // 행 클릭 = **이 작업 한 건**의 상세 팝업(#852). 전체 목록은 헤더 ⤢ 로만.
            return el('div', { class: 'dash-row dash-row--log', role: 'button', tabindex: '0',
                title: '자세히 보기', onclick: () => openActivityModal(a, nameOf) }, el('span', { class: 'dash-dot tn-' + (DASH_ACT_TONE[a.type] || 'mut'), title: DASH_ACT_LABEL[a.type] || a.type || '' }), el('span', { class: 'dash-nm' }, el('span', { class: 'dash-nm-line', title: a.summary || a.title || '', text: a.summary || a.title || '(제목 없음)' }), el('span', { class: 'dash-sub', text: sub })));
        }));
    };
    draw();
}
export { DASH_ACT_LABEL, DASH_ACT_TONE, DASH_TASK_BUCKETS, dashDueDays, dashDueLabel, dashModal, fillActivity, fillMyTasks, fillReviewQueue, openActivityModal, openWorklogPopup, };
