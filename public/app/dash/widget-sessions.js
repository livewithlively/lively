// dash/widget-sessions.ts — 대시보드 '내 AI 세션' 위젯(#1313 R42 · dashboard-home.ts 에서 verbatim 분리).
//  내 세션 + 초대받은 세션 + 내 프로젝트 세션을 한 목록으로 합쳐 카드로 보여주고, 열기·복원·종료·일괄선택을 준다.
//  fillSessions 가 470줄짜리 한 덩어리 클로저였다 — 지역 상태를 **SessCtx 한 객체**로 명명해 내부 함수들을
//  파일 상위로 승격했다(로직 무수정). 거르기 모델·팝오버 4종은 widget-sessions-popovers.ts 로 나가 있다.
//
// ⚠ 이 파일이 지켜야 하는 계약 — 셋 다 원문 주석에 근거가 있고, 어기면 조용히 깨진다.
//  ① **헤더 필터 칩(fdd)의 노드 identity.** 칩은 fillSessions 에서 **딱 한 번** 만들고, sessDraw() 는 라벨·on
//     클래스만 갱신한다(sessPaintFilterChip). 팝오버가 열려 있는 동안 앵커가 살아 있어야 하기 때문 —
//     draw() 마다 칩을 새로 만들어 갈아끼우면 dashPopover 의 바깥클릭 감지가 '앵커 밖 클릭'으로 오판해
//     항목을 두 번째로 고르는 순간 팝오버가 닫힌다(#1098). 그래서 재부착도 `firstChild !== fdd` 일 때만 한다
//     (같은 노드를 replaceChildren 으로 다시 넣으면 remove→append 로 포커스가 끊긴다).
//  ② **5초 폴링의 수명.** setInterval 은 fillSessions 가 소유하고, 매 tick 첫 줄에서 `document.body.contains(zone.box)`
//     로 위젯이 화면에 남아 있는지 보고 없으면 스스로 clearInterval 한다(라우팅으로 대시보드를 떠나면 자동 정지).
//     tick 은 또 `document.hidden`(백그라운드 탭)과 `body.lv-dragselect`(드래그 범위 선택 중, #1140)면 건너뛴다 —
//     재렌더가 카드를 갈아치우면 끌던 범위가 끊기기 때문. 상태 서명(sessStateSig)이 바뀔 때만 다시 그리고,
//     그릴 때 스크롤 위치를 보존한다. ⚠ 타이머는 이 모듈 밖으로 나갈 수 없다(소유 모듈과 동거).
//  ③ **드래그 범위 선택 등록**(initDragRangeSelect)은 core 가 문서 리스너 한 벌을 소유하고 여기선 조합만 등록한다.
import { api, appUrl, el, errorNote, initDragRangeSelect, toast } from '../core.js';
import { openGridPicker, openSessionSelectPicker, openTermCreateForm, startTerminalTour } from '../terminal.js';
import { dashSessDensity, dashSessFilter2, dashSessOnlineOnly, dashSessShowClosed, dashSessSort } from './prefs.js';
import { dashSessionIcon } from './icons.js';
import { dashSessRank, dashSessState } from './status.js';
import { dashCtl, dashEmpty } from './chrome.js';
import { openSessMenu, sessBaseSessions, sessFilterLabel, sessIsClosedProjSess, sessIsProjClosed, sessMatchSrc, sessMatchState, sessOpenFilterMenu, sessOpenPrefs } from './widget-sessions-popovers.js';
// #1582 — 세션 종료 확인창은 전 화면 공용 정의 하나만 쓴다(문구가 화면마다 갈라지지 않게).
import { confirmSessionEnd, endedToast } from '../session-actions.js';
import { confirmDialog } from '../ui-primitives.js';
const sessMemberName = (ctx, id) => {
    const m = ((ctx.cfg && ctx.cfg.members) || []).find((x) => x.id === id);
    return (m && m.name) || id || '';
};
// 프로젝트 → 소속 리스트(영역) 이름(#853) — 카드에 '프로젝트:' 와 나란히 '리스트:' 뱃지로.
const sessProjList = (ctx, pid) => ctx.listName.get(ctx.projListId.get(pid)) || '';
// #req — 상대시간('3시간 전') 대신 실제 시각을 표기. 오늘이면 시:분만, 다른 날이면 '월 일 시:분'.
const sessTime = (c) => {
    const n = Number(c);
    if (!n)
        return '';
    const d = new Date(n * 1000);
    const hm = d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? hm : d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' }) + ' ' + hm;
};
// '마지막 작업이 마지막 열람 이후'인가 = 아직 안 본 결과. lastAttached(tmux session_last_attached)는 탭을 붙일 때 갱신되므로
//  들어가서 보면 자동으로 해제된다(별도 '읽음' 저장 불필요). 하루 지난 건 알림이 아니라 이력이라 조용한 상태로 되돌린다.
// 카드 우측에 찍히는 시각과 같은 값 — 마지막 작업(@box_last_busy)이 있으면 그것, 없으면 만든 시각.
//  ⚠ lastActive 는 '이 기능 배포 뒤 실제로 busy 로 관측된' 세션에만 있다(#853) → 없는 세션이 흔하다.
//   그때 0 으로 두고 정렬하면 방금 만든 세션이 맨 아래로 가라앉는다.
function dashSessWhen(s) { return Number(s && (s.lastActive || s.created)) || 0; }
// #1139 — 모르는 프로젝트 id(남이 만든 프로젝트에서 내가 연 세션)가 있을 때만 전체 프로젝트 목록을 한 번 더 받아
//  이름·리스트·완료여부를 채운다. 안 채우면 카드가 '프로젝트: #1138' 로 뜨고, 완료 프로젝트 숨김도 안 걸린다.
async function sessFillProjNames(ctx) {
    if (ctx.projNamesFilled)
        return false;
    if (!ctx.sessions.some((s) => Number(s.projectId) > 0 && !ctx.projName.has(Number(s.projectId))))
        return false;
    ctx.projNamesFilled = true;
    const all = await api('/api/ui/v6/projects').then((d) => (d && d.projects) || []).catch(() => []);
    if (!all.length) {
        ctx.projNamesFilled = false;
        return false;
    }
    for (const p of all) {
        if (!ctx.projName.has(p.id)) {
            ctx.projName.set(p.id, p.name);
            ctx.projListId.set(p.id, p.list_id);
        }
        if (sessIsProjClosed(p))
            ctx.closedPids.add(p.id);
    }
    return true;
}
// ⚠ 계약①(파일 헤더) — 칩 **노드는 이미 있는 것을 그대로 쓴다**. 라벨·on 클래스만 갱신하고, 부착도
//  이미 첫 자식이면 건너뛴다. draw() 가 여기 말고 다른 데서 칩을 만들면 열려 있던 팝오버의 앵커가 끊긴다.
function sessPaintFilterChip(ctx) {
    ctx.fdd.classList.toggle('on', ctx.fSrc.size + ctx.fState.size > 0);
    ctx.fddLbl.textContent = sessFilterLabel(ctx);
    if (ctx.zone.chipsEl.firstChild !== ctx.fdd)
        ctx.zone.chipsEl.replaceChildren(ctx.fdd);
}
// #req 일괄 종료 — 소유한 세션 여러 개를 체크해 한 번에 끝낸다(DELETE=tmux 세션 제거). 소유자만 선택 가능(서버도 403 재검증).
//  #1582 — 이름·확인창을 AI 세션 탭과 통일했다('삭제' + 브라우저 confirm + "되돌릴 수 없어요" → '종료' + 라이블리
//  확인창 + 남는 것 안내). 문구를 왜 그렇게 쓰는지는 session-actions.ts 헤더 참고 — 이 동작은 파일을 안 지운다.
async function sessKillSelected(ctx) {
    const ids = [...ctx.selected];
    if (!ids.length)
        return;
    const items = ids.map((id) => ctx.sessions.find((s) => s.id === id)).filter(Boolean);
    // 이미 꺼진(restorable) 세션은 끊을 작업이 없다 — 섞여 있으면 '종료'라는 말이 그 카드엔 안 맞으므로 알려준다.
    const dead = items.filter((s) => s.restorable).length;
    const lines = dead ? [dead + '개는 이미 꺼진 세션이라 목록에서만 지워집니다.'] : [];
    if (!await confirmSessionEnd({ title: ids.length + '개 세션을 종료할까요?', lines, sessions: items }))
        return;
    let failed = 0;
    for (const id of ids) {
        try {
            await api('/api/ui/terminal/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
        }
        catch {
            failed++;
        }
    }
    const done = ids.length - failed;
    toast(failed ? (done + '개 종료 · ' + failed + '건 실패') : await endedToast(done, items), !!failed);
    ctx.selected.clear();
    await ctx.reloadSessions();
}
const sessRestorableSelected = (ctx) => [...ctx.selected].map((id) => ctx.sessions.find((s) => s.id === id)).filter((s) => s && s.restorable);
// #1141 일괄 복원 — 고른 세션 중 '복원 가능'(재부팅·회수로 tmux 는 죽고 desired-state 만 남은) 것들을 한 번에 되살린다.
//  카드의 [복원]과 같은 경로(POST …/restore). 여러 개를 되살리며 탭을 n개 여는 건 팝업 차단·화면 폭주라 열지 않는다
//  — 복원 후 목록이 라이브 카드로 바뀌므로, 열고 싶으면 '그리드로 열기'로 고르면 된다.
async function sessRestoreSelected(ctx) {
    const items = sessRestorableSelected(ctx);
    if (!items.length)
        return;
    if (!await confirmDialog({
        title: items.length + '개 세션을 이어서 열까요?', confirmText: '복원', cancelText: '취소',
        message: '저장된 폴더·설정 그대로 다시 열리고, 대화도 이어받습니다.',
    }))
        return;
    let ok = 0, failed = 0;
    for (const s of items) { // 순차 — 세션 생성은 tmux 를 띄우는 일이라 한꺼번에 몰지 않는다.
        try {
            await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/restore', { method: 'POST', body: '{}' });
            ok++;
        }
        catch {
            failed++;
        }
    }
    toast(failed ? (ok + '개 복원 · ' + failed + '건 실패') : (ok + '개 세션을 복원했어요 — 대화를 이어받았습니다'), !!failed);
    ctx.selected.clear();
    await ctx.reloadSessions();
}
// #870/#1146 열기 — 1개면 단독 탭, 여러 개면 방식 선택 팝업(각각 새 탭 / 한 탭 그리드. 터미널 탭과 동일 openGridPicker 재사용 — 두 벌 만들지 않는다).
function sessOpenSelectedGrid(ctx) {
    const items = [...ctx.selected]
        .map((id) => ctx.sessions.find((s) => s.id === id))
        .filter(Boolean)
        .map((s) => ({ id: s.id, label: s.label || '', node: (s.node && s.node.id) || '' }));
    if (!items.length)
        return;
    if (items.length === 1) {
        const s = items[0];
        dashOpenSessionTab(s.id, s.label, s.node || '');
        return;
    }
    openGridPicker(items);
}
function sessRenderBar(ctx) {
    const bar = ctx.bar;
    // #853 하단 일괄 바 = 선택이 하나라도 있거나(호버 체크로 바로 진입) ⚙ 선택모드일 때 표시. 다 풀면 자동으로 숨는다.
    const n = ctx.selected.size;
    bar.hidden = n === 0;
    if (bar.hidden)
        return; // 선택이 있으면 뜨고 다 풀면 사라진다(별도 '선택 모드' 없음)
    // #870/#1146 '열기' = 선택 모드의 주 동작. 누르면 방식(각각 새 탭 / 한 탭 그리드)을 고르는 팝업(1개면 바로 그 탭).
    //  dash-bulkbar-push 로 액션 묶음을 우측 정렬.
    const gridBtn = el('button', { class: 'dash-bulkbar-btn primary dash-bulkbar-push', type: 'button', title: '고른 세션 열기 — 각각 새 탭으로 또는 한 탭에 나란히', text: '열기' + (n ? ' (' + n + ')' : ''), onclick: () => sessOpenSelectedGrid(ctx) });
    gridBtn.disabled = n === 0;
    // #1582 '삭제' → '종료' — AI 세션 탭과 같은 이름. 세션은 지워 없애는 게 아니라 끝내는 것이고, 대화록·파일은 남는다.
    const delBtn = el('button', { class: 'dash-bulkbar-btn danger', type: 'button',
        title: '고른 세션을 끝냅니다 — 작업 폴더·파일은 그대로, 대화록은 세션 기록에 남습니다',
        text: '종료' + (n ? ' (' + n + ')' : ''), onclick: () => sessKillSelected(ctx) });
    delBtn.disabled = n === 0;
    // #1141 복원 — 고른 것 중 '복원 가능'한 세션 수만 센다(라이브 세션은 복원 대상이 아니다). 0개면 비활성.
    const nr = sessRestorableSelected(ctx).length;
    const restoreBtn = el('button', { class: 'dash-bulkbar-btn', type: 'button',
        title: nr ? '고른 세션 중 복원 가능한 ' + nr + '개를 저장된 폴더·설정으로 다시 열고 대화를 이어받습니다' : '복원 가능(종료됨·중단됨) 세션을 골라야 복원할 수 있어요',
        text: '복원' + (nr ? ' (' + nr + ')' : ''), onclick: () => sessRestoreSelected(ctx) });
    restoreBtn.disabled = nr === 0;
    // #1150 조건으로 선택 — AI 세션 탭과 같은 팝오버(상태·시간·범위).
    //  ⚠ 후보는 **지금 보이는 내 세션**만. 대시보드 draw() 는 안 보이게 된 선택을 자동 해제하므로
    //   숨은 세션을 골라 봤자 그 자리에서 지워지고, 무엇을 고른 건지도 화면으로 확인할 수 없다.
    const scope = ctx.shownNow.filter((s) => s.owned);
    const pickBtn = el('button', { class: 'dash-bulkbar-btn', type: 'button', 'aria-haspopup': 'true',
        title: '보이는 세션을 상태·시간·범위 조건으로 한 번에 고르기 (확인 필요 · 복원 가능 · 방치 7일+ …)', text: '조건으로 선택 ▾' });
    pickBtn.onclick = () => openSessionSelectPicker(pickBtn, {
        candidates: scope, shown: scope, selected: ctx.selected,
        apply: (next) => { ctx.selected.clear(); next.forEach((id) => ctx.selected.add(id)); ctx.draw(); },
    });
    bar.replaceChildren(el('span', { class: 'dash-bulkbar-n', text: n ? (n + '개 선택') : '세션을 골라 열거나 복원·종료하세요' }), ...(scope.length ? [pickBtn] : []), gridBtn, restoreBtn, delBtn, el('button', { class: 'dash-bulkbar-btn', type: 'button', title: '선택 해제', text: '완료', onclick: () => { ctx.selected.clear(); ctx.draw(); } }));
}
function sessDraw(ctx) {
    const zone = ctx.zone;
    // 정렬(#req ⚙에서 선택): active(기본)=마지막 작업 최신순(가장 최근에 작업한 세션이 위) / recent=생성 최신순 / name=제목(작업요약)순.
    const dispOf = (s) => ((s.title && s.title.trim()) || s.label || '').toLowerCase();
    const cmp = ctx.sortMode === 'recent' ? ((a, b) => (Number(b.created) || 0) - (Number(a.created) || 0))
        : ctx.sortMode === 'name' ? ((a, b) => dispOf(a).localeCompare(dispOf(b), 'ko'))
            // #1098 정렬 축 2개를 이름 그대로 분리한다.
            //  · active(기본) '최근 작업순' = **순수 최근순**. 상태를 섞지 않는다 — 이름이 그렇게 말하고 있으므로.
            //    키는 카드 우측에 실제로 찍히는 시각(`마지막 작업` 없으면 `만든 시각`)과 **같은 값**을 쓴다. 안 그러면
            //    '방금 만든 세션'이 목록 맨 아래로 가라앉아 화면과 순서가 어긋난다(AI세션 탭과 동일한 키).
            //  · priority '지금 볼 것 먼저' = 확인 필요 → 작업 완료(안 본 결과) → 작업 중 → …, 같은 급이면 최근순.
            : ctx.sortMode === 'priority' ? ((a, b) => dashSessRank(a) - dashSessRank(b) || dashSessWhen(b) - dashSessWhen(a))
                : ((a, b) => dashSessWhen(b) - dashSessWhen(a));
    // #req 완료·보관 프로젝트의 **종료된** 세션은 기본 숨김(showClosed 켜면 포함) — 축 필터 이전의 기준 집합(칩 카운트도 이걸 센다).
    const base = sessBaseSessions(ctx);
    const hiddenClosed = ctx.showClosed ? 0 : ctx.sessions.filter((s) => sessIsClosedProjSess(ctx, s)).length;
    const shown = base.filter((s) => sessMatchSrc(ctx, s) && sessMatchState(ctx, s)).sort(cmp);
    ctx.shownNow = shown; // #1150 '조건으로 선택' 팝오버의 '지금 보이는 것' 범위(필터 결과와 항상 일치)
    // 필터 전환 시 안 보이게 된 선택은 해제(내 프로젝트 모달과 동형).
    const ownedShown = new Set(shown.filter((s) => s.owned).map((s) => s.id));
    for (const id of [...ctx.selected])
        if (!ownedShown.has(id))
            ctx.selected.delete(id);
    zone.countEl.textContent = String(shown.length);
    // #1098 필터 칩 — 노드를 **재생성하지 않는다**(계약① — 파일 헤더). 라벨·상태만 갱신.
    sessPaintFilterChip(ctx);
    if (!shown.length) {
        zone.body.replaceChildren((ctx.fSrc.size || ctx.fState.size) ? dashEmpty('고른 조건에 맞는 세션이 없어요 — 필터에서 ‘초기화’를 눌러 보세요.')
            : ctx.onlineOnly ? dashEmpty('지금 도는 세션이 없어요 — ⚙ 설정에서 ‘온라인 세션만’을 끄면 오프라인 세션도 보여요.')
                : (!ctx.showClosed && hiddenClosed > 0) ? dashEmpty('완료·보관 프로젝트의 종료된 세션 ' + hiddenClosed + '개만 있어요 — ⚙ 설정에서 ‘완료·보관 프로젝트 세션 표시’를 켜면 보여요.')
                    : dashSessionEmpty(ctx.cfg, ctx.reloadSessions)); // #req 세션 0개 첫 사용자 — 설명 + 따라하기/새 세션(대시보드서 바로)
        return;
    }
    const list = el('div', { class: 'dash-sess-list' }); // 체크박스는 호버·선택됨일 때 나온다(별도 선택 모드 없음)
    for (const s of shown) {
        // #853 재배치 — 읽는 순서를 고정한다: [상태 · 제목] → [부제·뱃지] → 우측 고정열 [마지막 작업 시각] → [열기 ⋮].
        //  시각이 뱃지 줄 끝에 섞여 있으면(구버전) 프로젝트명 길이에 따라 위치가 춤춘다 → 세로로 스캔이 안 된다.
        const stt = dashSessState(s); // { key, label }
        const pid = Number(s.projectId) || 0;
        const mineProj = !!(pid && ctx.myProjIds.has(pid));
        const statusEl = stt.label ? el('span', { class: 'dash-scard-status is-' + stt.cls }, el('span', { class: 'dash-scard-dot' }), el('span', { text: stt.label })) : null;
        // 뱃지 줄 — 프로젝트(눌러서 이동) · 리스트(영역) · 초대.
        const chips = el('div', { class: 'dash-scard-chips' });
        if (pid) { // #853 팝업이 아니라 프로젝트 페이지로 아예 이동.
            const pname = ctx.projName.get(pid) || ('#' + pid);
            const go = el('button', { class: 'dash-scard-proj' + (mineProj ? ' mine' : ''), type: 'button',
                title: '프로젝트 ‘' + pname + '’ 열기', text: '프로젝트: ' + pname });
            go.onclick = (ev) => { ev.stopPropagation(); location.hash = '#/projects2/p/' + pid; };
            chips.append(go);
            const lname = sessProjList(ctx, pid); // #853 프로젝트와 같은 형식의 '리스트:' 뱃지(자세히 보기에서만).
            if (lname && ctx.density !== 'compact')
                chips.append(el('span', { class: 'dash-scard-list', title: '리스트(영역): ' + lname, text: '리스트: ' + lname }));
        }
        if (!s.owned)
            chips.append(el('span', { class: 'dash-scard-tag', title: '소유: ' + sessMemberName(ctx, s.owner), text: sessMemberName(ctx, s.owner) + ' · 초대받음' }));
        else if ((s.invites || []).length)
            chips.append(el('span', { class: 'dash-scard-tag', text: '초대 ' + s.invites.length }));
        // 우측 고정 시각열 — '마지막 작업'(클로드가 마지막으로 턴을 돌린/끝낸 때). 내가 열어본 시각과 무관(#853).
        const worked = Number(s.lastActive) || 0;
        const when = el('div', { class: 'dash-scard-when' + (worked ? '' : ' none'), title: worked ? '마지막 작업 — 클로드가 마지막으로 작업한 시각' : '아직 작업 기록이 없어요 (만든 시각)' }, ctx.density === 'compact' ? null : el('span', { class: 'dash-scard-when-lbl', text: worked ? '마지막 작업' : '만든 시각' }), el('span', { class: 'dash-scard-when-t', text: sessTime(worked || s.created) }));
        // #1059 — 사용자 정상 종료(/exit)로 생긴 복원카드는 '이어보기'로 구분(재부팅·회수 중단은 '복원').
        const dExitedByUser = !!(s.restorable && s.exitedByUser);
        // #1059 — AI 세션 탭과 같은 버튼 문구(상민님 결정): 상태가 '중단됨/종료됨'을 말하고 버튼은 행동만 말한다.
        const dRestoreVerb = dExitedByUser ? '다시 열기' : '이어서 열기';
        const openBtn = el('button', { class: 'dash-scard-open', type: 'button', text: s.restorable ? dRestoreVerb : '열기' });
        if (s.restorable) {
            // #1059 E — 복원: 재부팅·회수로 꺼진 세션을 저장된 desired-state 로 재생성(claude 는 대화 이어받기). 새 세션이 뜨면 그걸 연다.
            openBtn.title = dExitedByUser ? '내가 종료한 세션 — 저장된 대화를 이어서 엽니다 (같은 폴더·설정)' : '재부팅·자동회수로 중단된 세션을 다시 엽니다 (같은 폴더·설정 + 대화 이어받기)';
            openBtn.onclick = async () => {
                openBtn.disabled = true;
                openBtn.textContent = '여는 중…';
                try {
                    const r = await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/restore', { method: 'POST', body: '{}' });
                    // 라이브 경합(already) — 그새 다시 떠 있으면 새로 만들지 않고 그 세션을 그대로 연다(오success 방지).
                    if (r && r.already) {
                        dashOpenSessionTab(s.id, s.label || '');
                        toast('세션이 이미 살아있어 그대로 엽니다');
                        ctx.reloadSessions && ctx.reloadSessions();
                        return;
                    }
                    const ns = r && r.session;
                    if (ns && ns.id)
                        dashOpenSessionTab(ns.id, ns.label || s.label || '');
                    toast('열었어요 — 새 터미널에서 대화를 이어받아요(정확한 대화를 못 찾으면 목록에서 고르세요).');
                    ctx.reloadSessions && ctx.reloadSessions();
                }
                catch (e) {
                    toast(dRestoreVerb + ' 실패 — ' + (e && e.message || e), true);
                    openBtn.disabled = false;
                    openBtn.textContent = dRestoreVerb;
                }
            };
        }
        else {
            openBtn.onclick = () => dashOpenSessionTab(s.id, s.label || '', (s.node && s.node.id) || ''); // #869 원격 노드면 node 파라미터 · #1098 이미 열린 탭이면 그 탭으로
        }
        const moreBtn = el('button', { class: 'dash-scard-more', type: 'button', title: s.owned ? '세션 관리 (이름 수정·내 질문·종료)' : '세션 (내 질문)', 'aria-label': '세션 관리', text: '⋮' });
        moreBtn.onclick = () => openSessMenu(moreBtn, s, ctx.reloadSessions); // 이름 수정·종료는 소유자만 메뉴에 뜬다(서버도 403 재검증).
        const acts = el('div', { class: 'dash-scard-acts' }, openBtn, moreBtn);
        // 1행 볼드 제목 = 하고 있는 작업(s.title). 없으면 세션명.
        //   자세히: [상태 · 작업제목] / [터미널 제목: 세션명] / [뱃지] · 시각은 우측 고정열
        //   간략히: [작업제목] / [상태 · 프로젝트 · 시각] 2줄 (원래 배치 — #853 에서 실수로 한 줄로 바꿨던 것 복원)
        const nameStr = s.label || '(이름 없음)';
        const worksum = (s.title && s.title.trim() && s.title.trim() !== nameStr) ? s.title.trim() : '';
        const headline = worksum || nameStr;
        const nameEl = el('span', { class: 'dash-scard-name', title: headline, text: headline });
        const main = ctx.density === 'compact'
            ? el('div', { class: 'dash-scard-main' }, nameEl, el('div', { class: 'dash-scard-meta' }, statusEl, chips.childElementCount ? chips : null, when)) // 2줄째: 상태·프로젝트·시각
            : el('div', { class: 'dash-scard-main' }, el('div', { class: 'dash-scard-head' }, statusEl, nameEl), worksum ? el('div', { class: 'dash-scard-work', title: '터미널 제목: ' + nameStr, text: '터미널 제목: ' + nameStr }) : null, chips.childElementCount ? chips : null);
        // #870 자세히(A안) = 상태 레일 + 2영역: 좌 콘텐츠 / 우 컬럼(시각을 [열기·⋮] 위에 스택). 간략히는 그대로.
        const box = el('div', { class: 'dash-scard' + (ctx.density === 'compact' ? '' : ' dash-scard--full') + ' is-' + stt.key + (ctx.selected.has(s.id) ? ' sel' : '') });
        if (s.owned) { // 소유 세션만 일괄 선택 가능(비소유는 서버가 종료 403).
            // #853 체크박스는 평소 숨김 → 카드 왼쪽에 호버하면 나타난다(CSS: 호버 || .sel || 드래그 중).
            //  선택 모드 스위치는 없다 — 체크하면 하단 바가 뜨고, 다 풀면 체크박스도 바도 사라진다.
            const cb = el('input', { type: 'checkbox', class: 'dash-sess-check', 'aria-label': (s.label || '세션') + ' 선택' });
            cb.checked = ctx.selected.has(s.id);
            cb.onchange = () => {
                if (cb.checked)
                    ctx.selected.add(s.id);
                else
                    ctx.selected.delete(s.id);
                box.classList.toggle('sel', cb.checked);
                list.classList.toggle('has-sel', ctx.selected.size > 0);
                sessRenderBar(ctx); // 선택이 하나라도 있으면 하단 일괄 바 표시, 다 풀면 숨김.
            };
            const wrap = el('label', { class: 'dash-sess-checkwrap', title: '선택 — 누른 채 위아래로 끌면 여러 개가 한 번에 선택돼요 (Shift+클릭도 범위 선택)' }, cb);
            wrap.addEventListener('click', (ev) => ev.stopPropagation());
            box.append(wrap);
        }
        // 간략히는 시각(when)을 메타 줄(2줄째) 안에 넣었으므로 box 직속엔 넣지 않는다.
        //  자세히(A안): 시각+액션을 우측 세로 컬럼(dash-scard-side)으로 묶어 '시각 위 · 열기·⋮ 아래'로 스택.
        if (ctx.density === 'compact')
            box.append(main, acts);
        else
            box.append(main, el('div', { class: 'dash-scard-side' }, when, acts));
        list.append(box);
    }
    // #req 세션이 있어도 대시보드에서 바로 새 세션 — 목록 맨 밑 '+ 새 세션'(팝업은 터미널과 동일 openTermCreateForm 재사용).
    list.append(el('div', { class: 'dash-sess-addrow' }, el('button', { class: 'dash-sess-addbtn', type: 'button', 'data-tour': 'new-session', title: '새 세션 만들기',
        onclick: () => { if (ctx.cfg)
            openTermCreateForm(ctx.cfg, null, () => ctx.reloadSessions());
        else
            location.hash = '#/terminal'; } }, el('span', { class: 'dash-sess-addplus', text: '＋' }), el('span', { text: '새 세션' }))));
    list.classList.toggle('has-sel', ctx.selected.size > 0);
    zone.body.replaceChildren(list, ctx.bar);
    sessRenderBar(ctx);
}
// base 세션 + 프로젝트 세션 재병합(재렌더 없이 sessions 만 갱신).
async function sessRefetch(ctx) {
    const d = await api('/api/ui/terminal/sessions?includeProjects=owned');
    ctx.sessions = (d && d.sessions) || []; // #1139 내 프로젝트 세션·복원 가능 포함
    const withSess = (ctx.projects || []).filter((p) => Number(p.my_session_count) > 0);
    if (withSess.length) {
        const arrs = await Promise.all(withSess.map((p) => api('/api/ui/v6/projects/' + p.id + '/sessions').then((d2) => (d2 && d2.sessions) || []).catch(() => [])));
        const seen = new Set(ctx.sessions.map((x) => x.id));
        for (const arr of arrs)
            for (const x of arr)
                if (x.owned && !seen.has(x.id)) {
                    seen.add(x.id);
                    ctx.sessions.push(x);
                }
    }
    ctx.onCount(ctx.sessions.filter((x) => x.attached).length);
}
// #req 실시간 반영 — 상태(작업중/대기중)를 주기적으로 폴링. 상태가 실제로 바뀔 때만 재렌더(스크롤 튐·깜빡임 방지). 위젯이 사라지면 자동 중단.
const sessStateSig = (ctx) => ctx.sessions.map((s) => s.id + ':' + (s.agentState || '') + ':' + (s.attached ? 1 : 0) + ':' + (s.title || '')).join('|');
async function sessPollTick(ctx) {
    // #1140 드래그 범위 선택 중이면 건너뛴다 — 재렌더가 카드를 갈아치우면 끌던 범위가 끊긴다.
    if (ctx.polling || document.hidden || document.body.classList.contains('lv-dragselect'))
        return;
    ctx.polling = true; // 탭 백그라운드면 건너뜀
    try {
        await sessRefetch(ctx);
        const sig = sessStateSig(ctx);
        if (sig !== ctx.lastSig) {
            ctx.lastSig = sig;
            const sc = ctx.zone.body.scrollTop;
            ctx.draw();
            ctx.zone.body.scrollTop = sc;
        }
    }
    catch { /* 무시 */ }
    finally {
        ctx.polling = false;
    }
}
// ── ② 내 AI 세션 — 내 세션 · 초대받은 세션 · 프로젝트 세션. ──
async function fillSessions(zone, onCount, projectsP) {
    let sessions, cfg, projects, lists;
    try {
        [sessions, cfg, projects, lists] = await Promise.all([
            // #1139 includeProjects=owned — '내가 만든' 프로젝트 세션까지 서버가 함께 준다(남의 것은 여전히 제외).
            //  아래 프로젝트별 병합만으로는 **세션이 전부 복원 가능(tmux 죽음)인 프로젝트가 통째로 빠져** 복원 가능 세션이 안 보였다.
            api('/api/ui/terminal/sessions?includeProjects=owned').then((d) => (d && d.sessions) || []),
            api('/api/ui/terminal/config').catch(() => null), // 라벨 보강용 — 실패해도 폴백으로 진행
            (projectsP || Promise.resolve([])).catch(() => []), // 프로젝트 세션의 프로젝트명 매핑용
            api('/api/ui/v6/project-lists').then((d) => (d && d.lists) || []).catch(() => []), // 프로젝트 → 리스트(영역) 이름 매핑용
        ]);
    }
    catch (e) {
        onCount(null);
        zone.body.replaceChildren(errorNote(e, '세션을 불러오지 못했습니다'));
        return;
    }
    // 프로젝트 탭에서 만든 '내 세션'도 포함 — /terminal/sessions 는 프로젝트 세션을 숨기므로(터미널 탭 전용 정책),
    //  내 프로젝트(my_session_count>0)별로 /projects/:id/sessions 를 받아 owned('내 세션')만 합친다(id 중복 제거).
    try {
        const withSess = (projects || []).filter((p) => Number(p.my_session_count) > 0);
        if (withSess.length) {
            const lists = await Promise.all(withSess.map((p) => api('/api/ui/v6/projects/' + p.id + '/sessions').then((d) => (d && d.sessions) || []).catch(() => [])));
            const seen = new Set(sessions.map((s) => s.id));
            for (const arr of lists)
                for (const s of arr) {
                    if (s.owned && !seen.has(s.id)) {
                        seen.add(s.id);
                        sessions.push(s);
                    }
                }
        }
    }
    catch { /* 프로젝트 세션 병합 실패 → 기존 목록만 유지 */ }
    onCount(sessions.filter((s) => s.attached).length);
    // #1098 필터 = 출처·상태 두 축의 다중선택(집합). 빈 집합 = 그 축 '전체'(안 거름).
    const saved = dashSessFilter2();
    // ⚠ 계약①(파일 헤더) — 헤더 필터 칩은 **여기서 한 번만** 만든다. draw 는 라벨만 갱신(sessPaintFilterChip).
    const fddLbl = el('span', { text: '전체' });
    const fdd = el('button', { class: 'dash-chip dash-chip-dd', type: 'button', 'aria-haspopup': 'true', title: '세션 보기 필터' }, fddLbl, el('span', { class: 'dash-chip-caret', 'aria-hidden': 'true', text: '▾' }));
    const ctx = {
        zone, onCount, sessions, cfg, projects,
        // #1139 — 이름 맵과 '내 프로젝트' 판정을 분리한다. 이제 남이 만든 프로젝트에서 내가 연 세션도 목록에 오므로
        //  이름 맵은 그런 프로젝트까지 담아야 하고(아래 sessFillProjNames), '내 프로젝트'(칩·필터)는 mine=1 목록만이다.
        myProjIds: new Set((projects || []).map((p) => p.id)),
        projName: new Map((projects || []).map((p) => [p.id, p.name])),
        projListId: new Map((projects || []).map((p) => [p.id, p.list_id])),
        listName: new Map((lists || []).map((l) => [l.id, l.name])),
        closedPids: new Set((projects || []).filter(sessIsProjClosed).map((p) => p.id)),
        projNamesFilled: false,
        fSrc: new Set(saved.src),
        fState: new Set(saved.state),
        showClosed: dashSessShowClosed(),
        onlineOnly: dashSessOnlineOnly(), // #670 지금 도는 세션만 보기(오프라인·종료됨·복원 가능 숨김)
        sortMode: dashSessSort(), // active(최근 작업순) | priority(지금 볼 것 먼저) | recent(최근 생성순) | name(작업 제목순)
        density: dashSessDensity(), // #758 full(자세히·기본) | compact(간략히) — 카드 한 줄로 접기
        fdd, fddLbl,
        // #req 일괄 삭제·복원·열기의 선택 집합. #1150 shownNow = 지금 필터에 걸려 화면에 있는 세션.
        selected: new Set(),
        shownNow: [],
        bar: el('div', { class: 'dash-bulkbar dash-bulkbar--sess', hidden: true }),
        lastSig: '',
        polling: false,
    };
    ctx.draw = () => sessDraw(ctx);
    ctx.reloadSessions = async () => { try {
        await sessRefetch(ctx);
        await sessFillProjNames(ctx);
    }
    catch { /* 유지 */ } ctx.draw(); }; // 세션 변경(이름 수정·삭제·종료) 후 새로고침.
    fdd.onclick = () => sessOpenFilterMenu(ctx, fdd);
    // #1140 체크박스를 누른 채 위아래로 끌면 지나온 카드가 한 번에 선택된다(AI 세션 탭과 같은 동작·같은 헬퍼).
    //  문서 리스너는 core 가 한 벌만 소유한다 — 여기선 (행, 체크박스) 조합만 등록한다.
    initDragRangeSelect('.dash-scard', '.dash-sess-check');
    ctx.lastSig = sessStateSig(ctx);
    // ⚠ 계약②(파일 헤더) — 5초 폴링 타이머는 이 위젯이 소유한다. 존이 문서에서 사라지면 스스로 멈춘다.
    const pollId = setInterval(() => {
        if (!document.body.contains(zone.box)) {
            clearInterval(pollId);
            return;
        }
        sessPollTick(ctx);
    }, 5000);
    // #758 헤더 컨트롤 — [⚙ 설정(선택 모드 포함)] + [→ 터미널]. 필터는 칩 영역 드롭다운(작업 로그와 동일), 선택은 ⚙ 안.
    dashCtl(zone, {
        gear: { title: '세션 표시 설정', open: (a) => sessOpenPrefs(ctx, a) },
        action: { href: '#/terminal', title: '터미널로' },
    });
    ctx.draw();
    // #1139 — 모르는 프로젝트 이름은 뒤늦게 채워 다시 그린다(첫 렌더를 붙잡지 않는다).
    sessFillProjNames(ctx).then((changed) => { if (changed)
        ctx.draw(); }).catch(() => { });
}
// #1098 세션 터미널 열기 — **세션 id 를 창 이름으로** 준다. 그 세션이 이미 내 탭에 열려 있으면 새 탭을 만들지 않고
//  그 탭을 재사용·포커스한다(같은 세션을 여러 번 열어 탭이 무한히 늘어나던 문제). 이 대시보드가 연 탭이어야 이름이 잡히므로,
//  다른 경로로 연 탭이면 새로 열린다(그 뒤로는 이 이름으로 묶여 재사용된다).
function dashOpenSessionTab(id, label, nodeId) {
    // #1169 appUrl — 프리뷰(/preview/<id>/…) 아래에서 열면 루트 절대경로가 오리진 루트(라이브)로 새어 프리뷰가 풀린다.
    const url = appUrl('/ui/terminal.html?session=') + encodeURIComponent(id) + '&label=' + encodeURIComponent(label || '') + (nodeId ? '&node=' + encodeURIComponent(nodeId) : '');
    const w = window.open(url, 'lively-term-' + id);
    try {
        w && w.focus();
    }
    catch { /* 팝업 차단·크로스오리진 — 열기는 됐으니 무시 */ }
    return w;
}
// #req 따라하기 ① 단계 — 대시보드 맥락에 맞춘 문구·앵커. (②~⑦은 openTermCreateForm 폼이 동일해 그대로 재사용.)
//  이 카드의 [+ 새 세션]([data-tour="new-session"])을 가리키고, 클릭하면 폼이 대시보드 위로 떠 다음 단계로 이어짐.
function dashTourStep1() {
    return {
        target: '[data-tour="new-session"]',
        title: '① 새 세션 만들기',
        body: [el('p', { class: 'tour-p' }, '바로 옆 ', el('b', { text: '[+ 새 세션]' }), ' 을 눌러 주세요 — 세션 만들기 창이 이 대시보드 위에 바로 열려요.')],
        // scrollIntoView: 세션이 여러 개면 [+ 새 세션]이 목록 아래(뷰포트 밖)로 밀린다 — 그럼 스포트라이트 구멍이
        //  화면 밖이 돼(hole 높이 0) 딤이 통째로 덮고 버튼 클릭이 막힌다(#1000 버그). 진입 시 버튼을 화면 안으로 스크롤.
        placement: 'bottom', advanceOn: 'click', scrollIntoView: true,
    };
}
// #req 세션 0개 첫 사용자 빈 상태 — 'AI 세션이 뭔지' 쉬운 설명 + 바로 시작(따라하기/새 세션). 팝업·투어 모두 대시보드에서.
function dashSessionEmpty(cfg, reloadSessions) {
    const startNew = () => { if (cfg)
        openTermCreateForm(cfg, null, () => reloadSessions && reloadSessions());
    else
        location.hash = '#/terminal'; };
    return el('div', { class: 'dash-sess-empty' }, el('div', { class: 'dash-sess-empty-ic' }, dashSessionIcon()), el('div', { class: 'dash-sess-empty-title', text: 'AI 세션으로 바로 시작해 보세요' }), el('div', { class: 'dash-sess-empty-desc', text: '터미널에서 Claude·Codex 같은 AI와 함께 코드·문서를 만드는 작업 공간이에요. 폴더를 고르고 세션을 열면 AI가 바로 일을 시작해요.' }), el('div', { class: 'dash-sess-empty-acts' }, 
    // 따라하기 = 온보딩 투어(startTerminalTour). ① 단계를 대시보드용으로 넘겨(버튼 위치·문구), 이후 폼 단계(②~⑦)는 동일 폼이라 그대로 이어짐.
    el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '🧭 따라하며 시작하기', title: '세션 만드는 법을 화면에서 한 단계씩 짚어드려요', onclick: () => startTerminalTour(dashTourStep1()) }), el('button', { class: 'btn btn-ghost btn-sm', 'data-tour': 'new-session', type: 'button', text: '+ 새 세션', title: '바로 새 세션 만들기', onclick: startNew })));
}
export { fillSessions, sessPaintFilterChip, dashSessWhen, dashOpenSessionTab, dashTourStep1, dashSessionEmpty, };
