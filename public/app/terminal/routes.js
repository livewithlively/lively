// terminal/routes.ts — #/terminal **진입점**: renderTerminal(데이터 로드 → 3축 필터·소유 섹션·카드 조립 → 일괄 바)과 온보딩 투어.
//  소비자: web/main.ts(라우팅) · 대시보드(따라하기 투어) — 전부 배럴 terminal.ts 를 거친다.
//  import 방향: terminal/ 4모듈을 **위에서 아래로만** 본다(아래 모듈은 이 파일을 import 하지 않는다 — 폼의 목록 재렌더는 아래 훅 등록으로 해소).
import { api, el, errorNote, initDragRangeSelect, pageHead, state, toast } from '../core.js';
import { openMySessionsModal } from '../sessions.js'; // #905 C1 — 터미널 탭 '내 세션 기록' 버튼→모달
import { skeleton } from '../learn.js';
import { confirmDialog } from '../admin.js';
import { startTour } from '../tour.js';
import { TSESS_PERIOD_OPTS, TSESS_SCOPE_OPTS, TSESS_SECTIONS, TSESS_STATE_OPTS, TSESS_STATUS, buildSessAxisFilter, saveTsessCollapsed, saveTsessFilter, sessDead, sessState, tsessCollapsed, tsessConfirmEnd, tsessFilter, tsessPeriodMatch, tsessScopeOf, ymdShort, } from './status-filter.js';
import { openGridPicker, openSessionSelectPicker, termUrl } from './select-bar.js';
import { loginBannerEl, openNodeManager, openTermCreateForm, setTerminalRerender } from './session-form.js';
import { buildSessProjFilter, openGlobalPromptSearch, tsessCard } from './session-list.js';
// 폼·다이얼로그(session-form)가 끝난 뒤 목록을 다시 그리게 등록 — 이 방향(위→아래)이라야 순환이 안 생긴다.
setTerminalRerender(renderTerminal);
async function renderTerminal(view) {
    view.replaceChildren(skeleton('세션을 불러오는 중'));
    let data, cfg, projects, projLists, projFolders;
    try {
        [data, cfg, projects, projLists, projFolders] = await Promise.all([
            // includeProjects=1 — 프로젝트 공동 세션(#452 로 로그인한 전원 공개)까지 서버가 함께 준다.
            //  남이 만든 것도 포함: 이 탭은 '박스에서 지금 도는 AI 작업' 전체를 보는 미션컨트롤.
            //  (기본값은 여전히 숨김이라 대시보드 '내 AI 세션' 위젯은 영향 없음.)
            api('/api/ui/terminal/sessions?includeProjects=1'),
            api('/api/ui/terminal/config'),
            // 프로젝트명 매핑 + '어떤 프로젝트 할당' 칩. 남의 프로젝트 세션도 이름을 보여야 하므로 mine=1 이 아닌
            //  전체 목록(공개범위는 서버가 시행). 실패해도 세션 목록은 그대로 보인다(칩은 '프로젝트 #id' 폴백).
            api('/api/ui/v6/projects').then((d) => (d && d.projects) || []).catch(() => []),
            // 리스트(영역) — 프로젝트 필터를 리스트 단위로 묶어 보여주기 위해(#1098). 실패해도 평면 목록으로 동작.
            api('/api/ui/v6/project-lists').then((d) => (d && d.lists) || []).catch(() => []),
            api('/api/ui/v6/project-folders').then((d) => (d && d.folders) || []).catch(() => []),
        ]);
    }
    catch (e) {
        view.replaceChildren(errorNote(e, '세션을 불러오지 못했습니다'));
        return;
    }
    const sessions = (data && data.sessions) || [];
    const projName = new Map((projects || []).map((p) => [p.id, p.name]));
    // '내 프로젝트'(칩 강조용) = 서버 mine=1 과 같은 술어(생성자이거나 팀원)를 전체 목록에서 그대로 판정.
    const meIdNow = (state.me && state.me.userId) || '';
    const myProjIds = new Set((projects || [])
        .filter((p) => p.created_by === meIdNow || (p.members || []).some((m) => m.member_id === meIdNow))
        .map((p) => p.id));
    for (const s of sessions)
        s._st = sessState(s); // 카드·정렬·카운트가 공유(백엔드 agentState)
    const reRender = () => renderTerminal(view);
    // 관리(선택삭제) 가능 = 내 소유 세션. 서버도 소유자 아니면 403 재검증.
    const ownedSessions = sessions.filter((s) => s.owned);
    const sel = { mode: false, ids: new Set() };
    // #1140 체크박스를 누른 채 위아래로 끌면 지나온 카드가 한 번에 선택된다(대시보드 '내 AI 세션'과 같은 헬퍼 한 벌).
    initDragRangeSelect('.tsess-card', '.tsess-check');
    // 3축 필터 — 상태(다중) · 소속(단일) · 기간(단일). 전부 드롭다운. 소유 축은 필터가 아니라 섹션이다(#1229).
    const filt = tsessFilter();
    const fState = new Set(filt.state);
    const fScope = new Set(filt.scope);
    const fPeriod = { ...filt.period };
    const collapsed = tsessCollapsed();
    const persist = () => saveTsessFilter({ state: [...fState], scope: [...fScope], period: { ...fPeriod } });
    const matchState = (s) => fState.size === 0 || fState.has(s._st);
    // 두 칸이 전체를 덮으므로 '빈 선택'과 '둘 다 선택'은 결과가 같다(둘 다 전체) — 굳이 정규화하지 않는다.
    const matchScope = (s) => fScope.size === 0 || fScope.has(tsessScopeOf(s));
    const matchPeriod = (s) => tsessPeriodMatch(fPeriod, s);
    let projF = 0; // 0=전체 · >0=projectId (소속 축은 fScope 가 전담 — #1229)
    let shownNow = []; // 지금 필터에 걸려 화면에 있는 세션 — 벌크바의 '보이는 것 전체 선택' 범위
    const headActions = el('div', { class: 'term-head-actions' });
    const bulkBar = el('div', { class: 'dash-bulkbar dash-bulkbar--sess', hidden: true });
    const controls = el('div', { class: 'tsess-controls' });
    const listWrap = el('div', {});
    // 하단 플로팅 바 — 대시보드 '내 AI 세션'과 같은 컴포넌트(.dash-bulkbar, 스타일 한 벌 공유).
    //  표시 조건도 동일: 선택이 하나라도 있거나 '선택' 모드일 때. 다 풀면 자동으로 사라진다.
    function repaintBulk() {
        const n = sel.ids.size;
        bulkBar.hidden = !sel.mode && n === 0;
        if (bulkBar.hidden) {
            bulkBar.replaceChildren();
            return;
        }
        // 선택 대상은 소유 세션만(체크박스가 소유 카드에만 붙는다). '전체 선택'은 지금 필터로 보이는 것 기준 —
        //  목록에 남의 세션까지 들어오면서 '전부'는 종료할 수도 없는 것까지 담게 됐다.
        //  (상태칩 '종료됨' → 전체 선택 → 선택 종료 가 정리 동선.)
        // #1150 '조건으로 선택' — 상태·시간·범위 조건으로 한 번에 고른다(구 빠른칩 전체/온라인/오프라인을 대체·흡수).
        //  ⚠ 후보는 **지금 보이는 내 세션**으로 한정한다(구 빠른칩과 같은 범위). 안 보이는 것까지 고르면
        //   '5개 선택'인데 화면엔 2장뿐 — 무엇을 종료·복원하는지 확인할 길이 없다. 넓게 고르려면 상단 필터를 먼저 푼다.
        const scope = (shownNow.length ? shownNow : sessions).filter((s) => s.owned);
        const pickBtn = el('button', { class: 'dash-bulkbar-btn', type: 'button', 'aria-haspopup': 'true',
            title: '보이는 세션을 상태·시간·범위 조건으로 한 번에 고르기 (확인 필요 · 중단됨 · 방치 7일+ …)', text: '조건으로 선택 ▾' });
        pickBtn.onclick = () => openSessionSelectPicker(pickBtn, {
            candidates: scope, shown: scope, selected: sel.ids,
            apply: (next) => { sel.ids = next; draw(); },
        });
        const pickBtns = scope.length ? [pickBtn] : [];
        // #1146 '열기' — 누르면 방식(각각 새 탭 / 한 탭 그리드)을 고르는 팝업. 1개만 골랐으면 그냥 그 탭을 연다.
        const openBtn = el('button', { class: 'dash-bulkbar-btn primary dash-bulkbar-push', type: 'button',
            title: '고른 세션 열기 — 각각 새 탭으로 또는 한 탭에 나란히', text: '열기' + (n ? ' (' + n + ')' : ''), onclick: () => bulkOpen() });
        openBtn.disabled = n === 0;
        const endBtn = el('button', { class: 'dash-bulkbar-btn danger', type: 'button',
            title: '고른 세션을 끝냅니다 — 대화록은 세션 기록에 남습니다', text: '종료' + (n ? ' (' + n + ')' : ''), onclick: () => bulkEnd(endBtn) });
        endBtn.disabled = n === 0;
        // #1141 복원 — 고른 것 중 '복원 가능'(tmux 는 죽고 desired-state 만 남은) 세션만 대상. 카드 [복원]과 같은 경로.
        const nRestore = pickedRestorable().length;
        const restoreBtn = el('button', { class: 'dash-bulkbar-btn', type: 'button',
            title: nRestore ? '고른 세션 중 ' + nRestore + '개를 저장된 폴더·설정으로 다시 열고 대화를 이어받습니다' : '중단됨·종료됨 세션을 골라야 이어서 열 수 있어요',
            text: '이어서 열기' + (nRestore ? ' (' + nRestore + ')' : ''), onclick: () => bulkRestore(restoreBtn) });
        restoreBtn.disabled = nRestore === 0;
        bulkBar.replaceChildren(el('span', { class: 'dash-bulkbar-n', text: n ? (n + '개 선택') : '세션을 골라 열거나 복원·종료하세요' }), ...pickBtns, openBtn, restoreBtn, endBtn, el('button', { class: 'dash-bulkbar-btn', type: 'button', title: sel.mode ? '선택 모드 종료' : '선택 해제', text: '완료',
            onclick: () => { sel.mode = false; sel.ids.clear(); draw(); } }));
    }
    sel.onToggle = repaintBulk; // 카드 체크박스 토글 시 bulkBar 카운트만 갱신(전체 재렌더 없이)
    const ctx = { cfg, view, projName, myProjIds, reRender, sel };
    // reopen='state'|'scope' 면 다시 그린 뒤 그 축의 드롭다운을 다시 펼친다 — **다중 선택은 고를 때마다 닫히면 안 된다**
    //  (#1098 에서 배운 것: 재렌더가 앵커를 갈아치우면 팝오버가 '바깥 클릭'으로 판정돼 닫힌다).
    //  기간은 프리셋을 고르면 닫히는 게 맞지만, 날짜·기준을 만질 땐(직접 고르기) 닫히면 못 쓴다 → 'period' 로 다시 편다.
    function draw(reopen = '') {
        // 헤더 우측 — [+ 새 세션] + (내 세션 0개면) 따라하기. data-tour 앵커 유지(#517 온보딩).
        const newBtn = el('button', { class: 'btn btn-primary', 'data-tour': 'new-session', text: '+ 새 세션', onclick: () => openTermCreateForm(cfg, view) });
        const nodeBtn = el('button', { class: 'btn btn-ghost', title: '내 PC·서버를 노드로 연결/관리(#869)', text: '🖥 노드', onclick: () => openNodeManager(view) });
        // 내 세션 기록(#905 C1) — 중앙에 기록된 내 세션 대화록(끝난 세션 포함). 프로젝트 탭과 동일 화면, 단 '내 세션'만.
        const logBtn = el('button', { class: 'btn btn-ghost', title: '중앙에 기록된 내 AI 세션 대화록(끝난 세션 포함)', text: '📜 세션 기록', onclick: () => openMySessionsModal() });
        const tourBtn = ownedSessions.length === 0
            ? el('button', { class: 'btn btn-ghost', text: '🧭 따라하기', title: '세션 만드는 법을 화면에서 한 단계씩 짚어드려요', onclick: () => startTerminalTour() })
            : null;
        headActions.replaceChildren(...[tourBtn, logBtn, nodeBtn, newBtn].filter(Boolean));
        // ── 상태 축 — **출처·기간과 같은 드롭다운(다중 선택)**. 종전엔 칩을 늘어놓았는데 상태가 8개로 늘면서
        //  ('확인 필요·작업 완료·작업 중·대기 중·오프라인·셸·중단됨·종료됨' + 전체) 한 줄을 다 먹었다(상민님 지적).
        //  카운트는 **다른 축(소속·기간)을 적용한 뒤** 기준 — 항목 숫자와 실제로 보이는 카드 수가 항상 일치한다.
        //  0건 항목도 숨기지 않는다(사라지면 '왜 없지'로 헷갈린다 — #1098 대시보드와 같은 규칙).
        const statePool = sessions.filter((s) => matchScope(s) && matchPeriod(s));
        // 우측 — 상태·소속·기간 축(드롭다운) + 질문검색 + 프로젝트 필터 + 선택. (한 줄 레이아웃)
        const right = el('div', { class: 'tsess-controls-right' });
        const stateDD = buildSessAxisFilter({
            title: '상태', multi: true, sel: fState, allCount: statePool.length,
            items: TSESS_STATE_OPTS.map((o) => ({ key: o.key, label: o.label, hint: o.hint, count: statePool.filter((s) => s._st === o.key).length })),
            onChange: (next) => { fState.clear(); for (const k of next)
                fState.add(k); persist(); draw('state'); },
        });
        right.append(stateDD.wrap);
        // 소속(다중, 상호배타 2칸) — 프로젝트 소속 · 프로젝트 비소속. 안 고름 = 전체(#1238).
        const scopePool = sessions.filter((s) => matchState(s) && matchPeriod(s));
        const scopeDD = buildSessAxisFilter({
            title: '소속', multi: true, sel: fScope, allCount: scopePool.length,
            items: TSESS_SCOPE_OPTS.map((o) => ({ key: o.key, label: o.label, hint: o.hint, count: scopePool.filter(o.match).length })),
            onChange: (next) => { fScope.clear(); for (const k of next)
                fScope.add(k); persist(); draw('scope'); },
        });
        right.append(scopeDD.wrap);
        const periodPool = sessions.filter((s) => matchState(s) && matchScope(s));
        // '직접 고르기' — 하루 단위 시작·끝(브라우저 기본 달력) + 기준(마지막 작업 / 만든 날).
        //  ⚠ 값 하나 고칠 때마다 드롭다운이 닫히면 못 쓴다 → draw('period') 로 다시 펼친다.
        const buildPeriodFooter = () => {
            const box = el('div', { class: 'tsess-period-custom' });
            box.append(el('div', { class: 'tsess-period-h', text: '직접 고르기' }));
            const mk = (which) => {
                const i = el('input', { type: 'date', class: 'pjv-date-input tsess-period-date', value: fPeriod[which] || '', title: which === 'from' ? '시작 날짜' : '끝 날짜' });
                i.onchange = () => {
                    fPeriod[which] = i.value || '';
                    fPeriod.preset = (fPeriod.from || fPeriod.to) ? 'range' : 'all';
                    persist();
                    draw('period');
                };
                i.onmousedown = (e) => e.stopPropagation(); // 달력 클릭이 바깥클릭으로 안 잡히게
                return i;
            };
            box.append(el('div', { class: 'tsess-period-row' }, mk('from'), el('span', { class: 'tsess-period-tilde', text: '~' }), mk('to')));
            if (fPeriod.from || fPeriod.to) {
                const clr = el('button', { class: 'tsess-period-clear', type: 'button', text: '날짜 지우기' });
                clr.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); fPeriod.from = ''; fPeriod.to = ''; fPeriod.preset = 'all'; persist(); draw('period'); };
                box.append(clr);
            }
            return box;
        };
        // 기준(마지막 작업 / 만든 날) — **드롭다운 맨 위**. 아래 프리셋과 '직접 고르기' 둘 다에 걸리는 설정이라
        //  목록 밑에 두면 '날짜에만 적용되나?'로 읽히고, 고르는 순서(기준 먼저 → 기간)와도 어긋난다.
        const buildPeriodBasis = () => {
            const seg = el('div', { class: 'tsess-period-basis' }, el('span', { class: 'tsess-period-basis-lbl', text: '기준' }));
            for (const [k, label, hint] of [['last', '마지막 작업', '클로드가 마지막으로 작업한 시각(없으면 만든 시각)'], ['created', '만든 날', '세션을 만든 시각']]) {
                const b = el('button', { class: 'tsess-period-basisbtn' + (fPeriod.basis === k ? ' on' : ''), type: 'button', text: label, title: hint });
                b.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); if (fPeriod.basis === k)
                    return; fPeriod.basis = k; persist(); draw('period'); };
                seg.append(b);
            }
            return seg;
        };
        const rangeLabel = (fPeriod.from ? ymdShort(fPeriod.from) : '처음') + '~' + (fPeriod.to ? ymdShort(fPeriod.to) : '지금');
        const periodDD = buildSessAxisFilter({
            title: '기간', allLabel: '전체 기간', multi: false, sel: fPeriod.preset, allCount: periodPool.length,
            btnLabel: fPeriod.preset === 'range' ? rangeLabel : undefined,
            header: buildPeriodBasis(),
            footer: buildPeriodFooter(),
            // 카운트도 기준(basis)을 타야 칩 숫자와 보이는 카드 수가 어긋나지 않는다.
            items: TSESS_PERIOD_OPTS.filter((o) => o.key !== 'all').map((o) => ({
                key: o.key, label: o.label, hint: o.hint,
                count: periodPool.filter((s) => tsessPeriodMatch({ ...fPeriod, preset: o.key }, s)).length,
            })),
            // 프리셋을 고르면 직접 지정 범위는 비운다(둘이 동시에 걸려 있으면 무엇이 적용됐는지 읽을 수 없다).
            onChange: (k) => { fPeriod.preset = k; fPeriod.from = ''; fPeriod.to = ''; persist(); draw(); },
        });
        right.append(periodDD.wrap);
        right.append(el('button', { class: 'btn btn-ghost btn-sm tsess-gbtn', text: '질문 검색', title: '여러 세션에서 내가 클로드에게 보낸 질문을 통합 검색하고 어느 세션인지 찾기', onclick: () => openGlobalPromptSearch(ctx) }));
        // 고를 수 있는 프로젝트는 **소속 축을 적용한 뒤** 남는 것들 — '프로젝트 비소속'이면 목록이 비어 드롭다운이
        //  통째로 사라진다(고를 게 없는 컨트롤을 남겨 두면 골랐다가 빈 화면을 보게 된다). 걸려 있던 프로젝트가
        //  그렇게 사라지면 자동 해제한다 — 안 그러면 아무것도 안 보이는데 그 원인이 화면에 없다.
        const projIds = [...new Set(sessions.filter(matchScope).map((s) => Number(s.projectId) || 0).filter(Boolean))];
        if (projF && !projIds.includes(projF))
            projF = 0;
        if (projIds.length)
            right.append(buildSessProjFilter({ projects: projects || [], projIds, projName, lists: projLists || [], folders: projFolders || [], current: projF, onPick: (v) => { projF = v; draw(); } }));
        const selToggle = sel.mode
            ? el('button', { class: 'btn btn-ghost btn-sm', text: '취소', onclick: () => { sel.mode = false; sel.ids.clear(); draw(); } })
            : (sessions.length ? el('button', { class: 'btn btn-ghost btn-sm', text: '선택', title: '여러 세션을 골라 한 탭 그리드로 열거나 한 번에 종료', onclick: () => { sel.mode = true; draw(); } }) : null);
        if (selToggle)
            right.append(selToggle);
        controls.replaceChildren(el('div', { class: 'tsess-controls-top' }, right));
        // ⚠ 재오픈은 **여기서**(DOM 에 붙은 뒤) 한다. 붙기 전에 open() 하면 getBoundingClientRect 가 전부 0 이라
        //  화면경계 보정이 '왼쪽으로 넘쳤다'고 오판해 앵커 왼쪽정렬로 뒤집어버린다 → 기준 버튼 한 번 눌렀는데
        //  드롭다운이 반대쪽으로 튀어 보인다(상민님 신고).
        if (reopen === 'state')
            stateDD.open();
        else if (reopen === 'scope')
            scopeDD.open();
        else if (reopen === 'period')
            periodDD.open();
        // 필터 적용(상태 · 소속 · 기간 · 프로젝트) + 정렬(확인필요→작업중→대기→끝남, 그 안에서 최근 작업순).
        const shown = sessions
            .filter((s) => matchState(s) && matchScope(s) && matchPeriod(s))
            .filter((s) => projF === 0 || (Number(s.projectId) || 0) === projF)
            .sort((a, b) => TSESS_STATUS[a._st].rank - TSESS_STATUS[b._st].rank
            || (Number(b.lastActive || b.created) || 0) - (Number(a.lastActive || a.created) || 0));
        shownNow = shown; // 벌크바 '보이는 것 전체 선택' 범위(필터 결과와 항상 일치)
        if (!sessions.length) {
            sel.ids.clear();
            listWrap.replaceChildren(el('div', { class: 'empty', text: '아직 세션이 없습니다. "+ 새 세션"으로 만드세요.' }));
            repaintBulk();
            return;
        }
        if (!shown.length) {
            sel.ids.clear();
            listWrap.replaceChildren(el('div', { class: 'empty', text: '이 필터에 해당하는 세션이 없습니다.' }));
            repaintBulk();
            return;
        }
        // ── 소유 섹션(#1229). 비어 있는 섹션은 헤더째 안 그린다 — 0건 헤더가 남으면 '왜 여기만 비었지'로 읽힌다.
        //  접기는 이 기기에 영속. 접어도 **거른 건 아니라서** 헤더의 개수는 그대로 보인다(있다는 사실은 안 감춘다).
        const sects = el('div', { class: 'tsess-sects' });
        sel.listEls = []; // 카드 체크박스가 has-sel 을 갱신할 대상(섹션마다 하나씩)
        const rendered = []; // 실제로 그려진 카드 = 벌크바의 선택 후보(접힌 섹션은 빠진다 — #1150)
        for (const sect of TSESS_SECTIONS) {
            const items = shown.filter(sect.match);
            if (!items.length)
                continue;
            const off = collapsed.has(sect.key);
            const head = el('button', { class: 'tsess-sect-head', type: 'button', title: sect.hint,
                'aria-expanded': off ? 'false' : 'true',
                onclick: () => { if (off)
                    collapsed.delete(sect.key);
                else
                    collapsed.add(sect.key); saveTsessCollapsed(collapsed); draw(); } }, el('span', { class: 'tsess-sect-chev' + (off ? ' off' : ''), text: '▾' }), el('span', { class: 'tsess-sect-name', text: sect.label }), el('span', { class: 'tsess-sect-n', text: String(items.length) }));
            const list = el('div', { class: 'tsess-list' + (sel.mode ? ' selectmode' : '') + (sel.ids.size ? ' has-sel' : '') });
            if (!off) {
                for (const s of items) {
                    list.append(tsessCard(s, ctx));
                    rendered.push(s);
                }
                sel.listEls.push(list);
            }
            sects.append(el('div', { class: 'tsess-sect' }, head, ...(off ? [] : [list])));
        }
        // 섹션을 접었으면 그 세션은 **화면에 없다** → 벌크바 '조건으로 선택' 후보에서도 빠져야 한다(#1150 불변식:
        //  '3개 선택'인데 보이는 카드가 1장이면 무엇을 종료하는지 확인할 길이 없다). 넓게 고르려면 섹션을 편다.
        shownNow = rendered;
        // 같은 이유로 **화면에서 사라진 카드는 선택도 풀린다** — 안 그러면 접거나 걸러 놓고 '종료 (1)'을 누르는데
        //  그 1개가 어느 세션인지 볼 수가 없다. 종료는 되돌리기 번거로운 동작이라 보이는 것과 어긋나면 안 된다.
        if (sel.ids.size) {
            const vis = new Set(rendered.map((s) => s.id));
            for (const id of [...sel.ids])
                if (!vis.has(id))
                    sel.ids.delete(id);
        }
        listWrap.replaceChildren(sects);
        repaintBulk();
    }
    // 선택 열기 — 고른 세션들을 한 탭 그리드로. 1개면 단독 탭, 여러 개면 배치(그리드) 선택 팝업 후 terminal-grid.html.
    function bulkOpen() {
        const items = [...sel.ids]
            .map((id) => sessions.find((s) => s.id === id))
            .filter(Boolean)
            .map((s) => ({ id: s.id, label: s.label || '', node: (s.node && s.node.id) || '' }));
        if (!items.length)
            return;
        if (items.length === 1) {
            window.open(termUrl(items[0].id, items[0].label, items[0].node), '_blank');
            return;
        }
        openGridPicker(items);
    }
    // #1141 일괄 복원 — 고른 세션 중 복원 가능한 것들을 한 번에 되살린다(카드 [복원]과 같은 POST …/restore).
    //  탭은 열지 않는다 — n개를 한꺼번에 열면 팝업이 차단되거나 화면이 폭주한다. 복원되면 라이브 카드로 바뀌므로
    //  열고 싶으면 '그리드로 열기'로 고르면 된다.
    function pickedRestorable() {
        return [...sel.ids].map((id) => sessions.find((s) => s.id === id)).filter((s) => s && s.restorable && s.owned);
    }
    async function bulkRestore(btn) {
        const items = pickedRestorable();
        if (!items.length)
            return;
        const ok = await confirmDialog({
            title: items.length + '개 세션을 이어서 열까요?', confirmText: '이어서 열기', cancelText: '취소',
            message: '저장된 폴더·설정 그대로 다시 열리고, 대화도 이어받습니다.',
            note: '터미널 탭은 열지 않아요 — 복원 뒤 목록에서 열거나 ‘그리드로 열기’로 한 번에 볼 수 있습니다.',
        });
        if (!ok)
            return;
        btn.disabled = true;
        let done = 0, fail = 0;
        for (const s of items) { // 순차 — 세션 생성은 tmux 를 띄우는 일이라 한꺼번에 몰지 않는다.
            try {
                await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/restore', { method: 'POST', body: '{}' });
                done++;
            }
            catch {
                fail++;
            }
        }
        toast(fail ? (done + '개 복원 · ' + fail + '개 실패') : (done + '개 세션을 복원했습니다 — 대화를 이어받았어요'), fail > 0);
        sel.mode = false;
        sel.ids.clear();
        reRender();
    }
    // 일괄 종료 — 고른 세션을 끝낸다(대화록은 중앙 세션 기록에 남아 '이어 질문하기'로 되살릴 수 있다).
    async function bulkEnd(btn) {
        const picked = [...sel.ids].map((id) => sessions.find((s) => s.id === id)).filter(Boolean);
        // 종료는 소유자만(서버가 403). 목록에 남의 세션(초대·프로젝트 공동)이 섞이므로 미리 걸러 안내한다
        //  — 안 그러면 '전체 선택 → 종료'가 대량 403 실패 토스트로 끝난다.
        const items = picked.filter((s) => s.owned);
        const skipped = picked.length - items.length;
        if (!items.length) {
            toast(picked.length ? '내가 만든 세션만 종료할 수 있습니다' : '', true);
            return;
        }
        const live = items.filter((s) => !sessDead(s)).length; // 아직 도는 세션은 따로 경고(진행 중 작업이 끊긴다)
        const lines = [];
        if (live)
            lines.push('⚠ 이 중 ' + live + '개는 아직 도는 세션입니다.');
        if (skipped)
            lines.push('남의 세션 ' + skipped + '개는 제외됩니다(소유자만 종료 가능).');
        if (!await tsessConfirmEnd(items.length + '개 세션을 종료할까요?', lines, items))
            return;
        btn.disabled = true;
        // 병렬 종료 — 일부 실패해도 나머지는 진행(성공/실패 건수 보고). 노드 세션은 ?node= 로 위임(#869).
        const results = await Promise.allSettled(items.map((s) => api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + (s.node ? '?node=' + encodeURIComponent(s.node.id) : ''), { method: 'DELETE' })));
        const ok = results.filter((r) => r.status === 'fulfilled').length;
        const fail = results.length - ok;
        toast(fail ? (ok + '개 종료 · ' + fail + '개 실패') : (ok + '개 세션을 종료했습니다 — 대화록은 📜 세션 기록에 남아 있어요'), fail > 0);
        sel.mode = false;
        sel.ids.clear();
        reRender();
    }
    const head = pageHead('AI 세션', 'AI 세션이 지금 무슨 작업을 하는지 · 어떤 프로젝트 할당인지 · 어떤 게 끝났는지 한눈에.', [headActions], '세션');
    view.replaceChildren(...[loginBannerEl(cfg, view), head, controls, listWrap, bulkBar].filter(Boolean)); // 바는 맨 아래 — sticky bottom 플로팅(대시보드와 동일)
    draw();
}
function startTerminalTour(firstStep, opts) {
    startTour([
        firstStep || {
            target: '[data-tour="new-session"]',
            title: '① 새 세션 만들기',
            body: [el('p', { class: 'tour-p' }, '오른쪽 위 파란 ', el('b', { text: '[+ 새 세션]' }), ' 버튼을 눌러 주세요. 세션 만들기 창이 열립니다.')],
            // scrollIntoView: 버튼이 뷰포트 밖이면 스포트라이트 구멍이 화면 밖이 돼 딤이 통째로 덮여 클릭이 막힌다(#1000).
            placement: 'bottom', advanceOn: 'click', scrollIntoView: true,
        },
        {
            target: '[data-tour="label"]',
            title: '② 세션 이름 정하기',
            body: [el('p', { class: 'tour-p' }, '나중에 알아보기 쉽게 이름을 적어요. 예: ', el('b', { text: '랜딩 카피 수정' }), '.')],
            placement: 'right', scrollIntoView: true,
        },
        {
            // 실행 위치(#869 노드) — 어느 '컴퓨터'에서 돌지. folder(어느 '폴더'에서 일할지)와는 다른 것이라 스텝을 나눈다(#req).
            target: '[data-tour="node"]',
            title: '③ 실행 위치',
            body: [el('p', { class: 'tour-p' }, 'AI가 실제로 ', el('b', { text: '어느 컴퓨터에서 실행될지' }), '예요.'),
                el('p', { class: 'tour-p' }, '보통은 회사의 ', el('b', { text: '[중앙 컴퓨터]' }), '(기본)에서 돌아가니 ', el('b', { text: '그대로 두면 됩니다' }), '. 내 PC를 따로 등록해 뒀다면 여기서 골라 그 컴퓨터에서 돌릴 수도 있어요.')],
            placement: 'right', scrollIntoView: true,
        },
        {
            // 작업 위치(공유/개인) + 그 안의 폴더 = 어느 '폴더'에서 일할지. AI가 들여다보고 다룰 파일들이 있는 곳.
            target: '[data-tour="folder"]',
            title: '④ 어디서 실행할까요',
            body: [el('p', { class: 'tour-p' }, 'AI가 ', el('b', { text: '어느 폴더에서 일할지' }), ' 골라요 — 그 폴더 안의 파일을 AI가 보고 다뤄요.'),
                el('p', { class: 'tour-p' }, '먼저 ', el('b', { text: '작업 위치' }), '를 골라요: ', el('b', { text: '공유 워크스페이스' }), '(팀이 함께 쓰는 곳) 또는 ', el('b', { text: '개인 폴더' }), '(나만 쓰는 곳). 그 아래 ', el('b', { text: '폴더' }), '에서 더 좁은 하위 폴더까지 정할 수 있어요.'),
                el('p', { class: 'tour-p', text: '잘 모르겠으면 기본값 그대로 두어도 괜찮아요.' })],
            placement: 'right', scrollIntoView: true,
        },
        {
            target: '[data-tour="options"]',
            title: '⑤ 실행 옵션',
            body: [el('p', { class: 'tour-p' }, el('b', { text: '자동 승인' }), ' — 확인 없이 바로 실행해 빨라요. 공유 폴더에선 꺼 두는 걸 권해요.')],
            placement: 'right', scrollIntoView: true,
        },
        {
            target: '[data-tour="preset"]',
            title: '⑥ 실행 설정 (선택)',
            body: [el('p', { class: 'tour-p' }, '함께 일할 ', el('b', { text: 'AI · 모델 · effort' }), '예요. 기본값으로 접혀 있고 ', el('b', { text: '이전 설정을 기억' }), '해요 — 바꾸려면 눌러 펼치세요.'),
                el('p', { class: 'tour-p', text: '잘 모르겠으면 그대로 — Claude Code · 기본 모델로 시작해요.' })],
            placement: 'right', scrollIntoView: true,
        },
        {
            // 검색하면 그 아래로 '사람 목록'(.proj-mp-menu, position:absolute)이 초대칸 밖으로 열린다 → 구멍이 초대칸만 뚫으면
            //  목록이 딤(pointer-events:auto) 밑에 깔려 클릭이 씹힌다(#req). 목록이 열려 있으면 구멍에 함께 포함해 누를 수 있게.
            target: () => { const f = document.querySelector('[data-tour="invite"]'); if (!f)
                return null; const m = f.querySelector('.proj-mp-menu:not([hidden])'); return m ? [f, m] : f; },
            title: '⑦ 함께 볼 사람 초대하기 (선택)',
            body: [el('p', { class: 'tour-p' }, '검색해서 추가하면 그 사람도 이 세션을 봐요. ', el('b', { text: '비워두면 나만 보는 비공개 세션' }), '이에요.'),
                el('p', { class: 'tour-p', text: '지금 안 정해도 돼요 — 나중에 세션 [수정]에서 바꿀 수 있어요.' })],
            placement: 'right', scrollIntoView: true,
        },
        {
            target: '[data-tour="create"]',
            title: '⑧ 만들기',
            body: [el('p', { class: 'tour-p' }, '마지막! ', el('b', { text: '[생성하기]' }), ' 를 누르면 새 탭에 까만 터미널 창이 열리고, 거기서 완료 안내가 이어집니다.')],
            placement: 'top', scrollIntoView: true, advanceOn: 'click',
        },
        // '🎉 완료' 단계는 여기(원래 탭)에 안 띄운다 — 생성하면 새 탭으로 실제 터미널이 열리므로, 완료 안내는 그 새 탭에서
        //  보여준다(openTermCreateForm 이 &welcome=1 로 넘기고 terminal.js 의 maybeShowWelcome 이 띄운다). 흐름이 실제 터미널에서 끝난다.
    ], opts);
}
export { renderTerminal, startTerminalTour };
