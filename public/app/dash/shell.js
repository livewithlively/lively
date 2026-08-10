// dash/shell.ts — 대시보드 셸(#1313 R43 · dashboard-home.ts 에서 verbatim 분리). '대시보드' 상위 탭(#/dashboard)의 뼈대다.
//  옛 '시작하기' 자리를 개편한 나만의 코크핏(#617).
//  1단계: 3열 고정 프리셋 — 좌(내 프로젝트 + 팀 공유 폴더) · 중(최신 알림 + 내 AI 세션) · 우(팀 작업 로그).
//   풀스크린·페이지 스크롤 없음(body[data-route="dashboard"] 훅) — 넘치는 목록은 위젯 '안에서만' 스크롤.
//   위젯별 독립 로드·독립 실패: 한 위젯의 API 오류가 대시보드 전체를 죽이지 않는다.
//  2단계(현재): 위젯 레지스트리(DASH_WIDGETS) + '대시보드 편집' 모달 — 어떤 위젯을 보일지(내용)와 어느 열 몇 번째에
//   둘지(배치)를 사람이 정한다. 위 프리셋이 곧 기본 배치(DASH_LAYOUT_DEFAULT)이고, 열 폭·행 높이 드래그는 그대로 얹힌다.
//  §0.5 채색 예산: 채운 파란 버튼은 화면당 1개([+ 새 세션])뿐. 나머지는 무채 카드 + 작은 상태점·아웃라인 배지.
//
//  ── 이 파일의 경계(#1313 R43) ──
//   여기 있는 것: 위젯 레지스트리 · 배치 정규화 · 인사 스트립 · 존 카드 셸(dashZone) · 열 폭 드래그 · '대시보드 편집' 모달.
//   여기 없는 것: 위젯 7종의 내용물(dash/widget-*.ts) · 위젯 공용 크롬(dash/chrome.ts) · 저장층(dash/prefs.ts·resize.ts) · 아이콘(dash/icons.ts).
//   방향은 한 갈래다 — shell → widget-* → chrome/status/icons/prefs/resize. 위젯이 셸을 되부르지 않는다(순환 금지).
//   ⚠ dashLayout()·dashInitColResize 가 저장층이 아니라 여기 있는 이유: 둘 다 레지스트리(DASH_W 의 col·wide·row·off)를
//    읽는다. 저장층으로 내리면 prefs/resize → shell 역방향이 생겨 순환이 된다. 저장 키·writer 만 그쪽에 있고 여기서 부른다.
import { api, el } from '../core.js';
import { skeleton } from '../learn.js';
//  프로젝트 생성은 '내 프로젝트' 섹션 인라인 추가와 같은 팝업을 그대로 쓴다(#853 — 같은 개념은 같은 창).
import { openProjectV2Form } from '../projects.js';
import { openTermCreateForm, startTerminalTour } from '../terminal.js'; // 세션 생성 팝업·따라하기 투어를 대시보드에서 그대로 재사용(#req).
import { DASH_LAYOUT_KEY, DASH_LAYOUT_VER, dashResetLayout, dashSaveLayout } from './prefs.js';
import { dashGearIcon, dashGripIcon } from './icons.js';
import { DASH_COLS_KEY, DASH_COLS_KEY_V2, DASH_COL_PX, dashColsSaved, dashColsSig, dashInitRowResize, dashRowKey, dashSaveCols } from './resize.js';
import { dashUpdateChipClip, myDisplayName } from './chrome.js';
import { fillProjects } from './widget-projects.js';
import { dashTourStep1, fillSessions } from './widget-sessions.js';
import { fillFolders } from './widget-folders.js';
import { fillNotifications } from './widget-notifications.js';
import { dashModal, fillActivity, fillMyTasks, fillReviewQueue } from './widget-tasks-review-log.js';
import { fillLivelyLog, fillLivelyLogTimeline } from './widget-lively-log.js';
// ── 위젯 레지스트리 + 배치(#1232) — '대시보드 편집' 모달이 이 표 하나만 보고 화면을 조립한다. ──
//  위젯을 새로 만들면 여기에 한 줄 + fill 매핑(renderMyDashboard 의 위젯별 호출)만 추가하면 편집 모달에 자동으로 나온다.
//  col  = 열 폭 기본 가중치(그 열 위젯들의 최댓값이 열 fr) — 기본 배치에서 5:4:3 = 예전 프리셋 그대로.
//  row  = 한 열 안 높이 기본 가중치 · auto = 내용맞춤 성향(열의 '마지막' 칸일 때만 auto, 팀 공유 폴더는 한 줄짜리라 잘리면 안 됨).
//  wide = 이 위젯이 있는 열은 기본 폭을 px 로 고정(내 프로젝트 = 리스트 개요 카드가 3열로 정렬되는 최소 폭).
//  off  = **기본 숨김** — 화면에 자리를 주기 전에 사람이 편집에서 직접 꺼내야 하는 위젯. 모두에게 값이 차지는 않는
//         위젯(역할 한정이거나, 그 필드를 아직 안 쓰는 조직에선 빈 칸)을 기본 배치에 밀어 넣지 않기 위한 장치.
//  home = off 위젯을 편집에서 [표시]로 꺼냈을 때 놓일 열(기본 배치에 자리가 없으니 필요 — 없으면 왼쪽 열).
const DASH_WIDGETS = [
    { key: 'proj', title: '내 프로젝트', desc: '내가 참여한 프로젝트를 리스트별로', col: 5, row: 5, wide: true },
    { key: 'fold', title: '팀 공유 폴더', desc: '팀이 함께 쓰는 중앙 저장 공간', col: 5, row: 1.5, auto: true },
    { key: 'notif', title: '최신 알림', desc: '나에 관한 멘션·댓글·초대·마감', col: 4, row: 5 },
    { key: 'sess', title: '내 AI 세션', desc: '내 세션 · 초대받은 세션 · 프로젝트 세션', col: 4, row: 7 },
    { key: 'log', title: '팀 작업 로그', desc: '회사 전체의 사람·AI 작업 기록', col: 3, row: 5 },
    //   라이블리 로그(#1570 시안 D): 감사 기록을 시간순 그대로. #1596 에서 기본 배치 3열 상단으로 —
    //   브리핑(집계)보다 "무엇을 언제 했는지"를 먼저 본다(사용자 결정 2026-08-10, #1570 의 시안 A 기본을 뒤집음).
    { key: 'lvlogd', title: '라이블리 로그', desc: '라이블리가 한 일 시간순 — 감사 기록을 쉬운 말로', col: 3, row: 5 },
    // ↓ 기본 숨김 — 조직이 그 기능을 실제로 쓸 때만 값이 찬다(안 쓰면 빈 칸). 편집에서 [표시]로 꺼내 쓴다.
    //   검토 대기: 검토 게이트를 켠 조직에서만 / 내 할 일: 태스크에 담당자·마감을 쓰는 팀에서만.
    //   내 라이블리 사용 내역(#1570 시안 A): 같은 기록의 기간 브리핑 — 로그와 한 열에 둘 다 세우지 않는다(#1596).
    //   home=2: 기본 배치엔 없지만 편집에서 [표시]로 꺼내면 원래 살던 3열로 — 3열 폭(col:3)에 맞춰 만든 위젯이라
    //    왼쪽 열(내 프로젝트가 쓰는 넓은 열) 바닥에 떨어지면 자리가 어색하다.
    { key: 'lvlog', title: '내 라이블리 사용 내역', desc: '주간 브리핑 — 근거로 쓴 지식·활동 구성', col: 3, row: 5, off: true, home: 2 },
    { key: 'review', title: '검토 대기 지식', desc: '승인해야 검색·세션주입에 반영돼요', col: 3, row: 4, off: true },
    { key: 'task', title: '내 할 일', desc: '내가 담당인 태스크 — 마감 임박순', col: 5, row: 4, off: true },
];
const DASH_W = Object.fromEntries(DASH_WIDGETS.map((w) => [w.key, w]));
// 기본 배치 = 1단계 프리셋 **그대로**(좌: 내 프로젝트+팀 공유 폴더 / 중: 최신 알림+내 AI 세션 / 우: 팀 작업 로그).
//  '기본 배치로 되돌리기'가 돌아오는 자리이자, 새 위젯이 처음 놓이는 자리(off 위젯은 여기 없고 숨김으로 간다).
//  #1596(2026-08-10 사용자 결정): 3열 = 위 '라이블리 로그', 아래 '팀 작업 로그'
//  (#1570 에서 그 자리에 있던 '내 라이블리 사용 내역'은 기본 숨김으로 — 편집에서 꺼내 쓴다).
const DASH_LAYOUT_DEFAULT = [['proj', 'fold'], ['notif', 'sess'], ['lvlogd', 'log']];
const DASH_COL_LABELS = ['왼쪽 열', '가운데 열', '오른쪽 열'];
// ⚠ 배치 정규화(아래 두 함수)는 위 레지스트리(DASH_WIDGETS/DASH_W/DASH_LAYOUT_DEFAULT)를 읽어야 해서 여기 산다.
//  저장 키·버전·writer(DASH_LAYOUT_KEY·DASH_LAYOUT_VER·dashSaveLayout·dashResetLayout)는 dash/prefs.ts 에 있다.
function dashDefaultLayout() {
    return { cols: DASH_LAYOUT_DEFAULT.map((c) => c.slice()), hidden: DASH_WIDGETS.filter((w) => w.off).map((w) => w.key) };
}
// 저장값 → 항상 '3열 + 숨김' 정규형. 모르는 키는 버리고, 중복은 첫 자리만, 어디에도 없는 **새 위젯은 기본 자리**로
//  되살린다(숨김은 사람이 명시적으로 고른 것만 — 그래야 새 위젯이 조용히 안 보이는 일이 없다).
//  단 off(기본 숨김) 위젯은 그 반대 — 처음엔 숨김으로 간다.
function dashLayout() {
    let raw = null;
    try {
        raw = JSON.parse(localStorage.getItem(DASH_LAYOUT_KEY) || 'null');
    }
    catch { /* 파손된 값은 기본으로 */ }
    if (!raw || !Array.isArray(raw.cols))
        return dashDefaultLayout();
    const seen = new Set();
    const take = (arr) => {
        const out = [];
        for (const k of Array.isArray(arr) ? arr : []) {
            if (typeof k !== 'string' || !DASH_W[k] || seen.has(k))
                continue;
            seen.add(k);
            out.push(k);
        }
        return out;
    };
    const cols = [0, 1, 2].map((i) => take(raw.cols[i]));
    // 저장값이 4열 이상이면(미래 포맷 축소) 넘치는 열은 마지막 열 뒤로 흡수 — 위젯이 사라지지 않게.
    for (let i = 3; i < raw.cols.length; i++)
        cols[2].push(...take(raw.cols[i]));
    const hidden = take(raw.hidden);
    // 구버전 저장값 마이그레이션 — **단계마다 그 단계가 겨냥한 버전 구간에서만** 돈다(sv = 저장된 포맷 버전).
    //  ⚠ 예전엔 전부 `raw.v !== 현재버전` 한 덩어리였다. 그러면 버전을 올릴 때마다 옛 구제가 다시 발동해,
    //   그 사이 사람이 직접 내린 결정(예: 검토 대기를 꺼내 뒀다 / 최신 알림을 일부러 숨겼다)을 도로 뒤집는다.
    //   각 단계는 자기 구간(sv < N)에서 한 번만 돌아야 "그 뒤로 다시 일어나지 않는다"는 약속이 실제로 지켜진다.
    //  ⚠ DASH_LAYOUT_VER 를 올릴 때는 여기에 그 버전의 단계(sv < 새버전)를 함께 추가한다 — 버전만 올리면
    //   저장값은 낡은 채로 통과하고, 단계만 추가하면 이미 저장한 사람에겐 영영 닿지 않는다.
    const sv = Number(raw.v) || 0;
    if (sv < DASH_LAYOUT_VER) {
        // v3: 이전 정규화(또는 이전 기본 배치)가 지금 기준으로 '기본 숨김'인 위젯을 열에 밀어 넣어 둔 상태를 되돌린다
        //  (다른 위젯의 자리는 사람이 정한 대로 그대로 둔다).
        if (sv < 3) {
            for (let i = 0; i < cols.length; i++) {
                for (const k of cols[i])
                    if (DASH_W[k].off && !hidden.includes(k))
                        hidden.push(k);
                cols[i] = cols[i].filter((k) => !DASH_W[k].off);
            }
        }
        // v4(#1570): '최신 알림' hidden 구제 — 알림 개편(#1571)의 과도기 상태(최신 알림→통합 인박스 대체, 곧 원복)를
        //  연 브라우저에 notif 가 hidden 으로 저장돼 "숨긴 적 없는데 사라졌다"가 됐다. 한 번 되꺼낸다 — seen 에서도
        //  빼서 아래 unseen 삽입이 기본 자리(가운데 열 상단)로 되살리게. 일부러 숨긴 사람은 이 한 번만 다시 보이고,
        //  다시 숨기면 v4 로 저장돼 반복되지 않는다(v3 의 '검토 대기 되돌리기'와 같은 철학, 방향만 반대).
        if (sv < 4) {
            const ni = hidden.indexOf('notif');
            if (ni >= 0) {
                hidden.splice(ni, 1);
                seen.delete('notif');
            }
        }
        // v5(#1596): 3열 상단 기본을 '내 라이블리 사용 내역'(브리핑) → '라이블리 로그'(시간순)로 **교체**한다.
        //  둘은 같은 기록의 두 표현이라 한 열에 나란히 세우지 않는다 — 그래서 자리를 넘기며 브리핑은 숨김으로 접는다.
        //  이 자리에 있던 브리핑은 사람이 고른 게 아니라 기본으로 들어가 있던 것이므로 한 번 접어도 선택을 뒤집지 않는다.
        //  이후 편집에서 다시 꺼내면 v5 로 저장돼 반복되지 않는다.
        if (sv < 5) {
            for (let i = 0; i < cols.length; i++)
                cols[i] = cols[i].filter((k) => k !== 'lvlog');
            if (!hidden.includes('lvlog'))
                hidden.push('lvlog');
            const di = hidden.indexOf('lvlogd');
            if (di >= 0) {
                hidden.splice(di, 1);
                seen.delete('lvlogd');
            } // 기본 자리(3열 상단)로 되살리도록 seen 에서도 뺀다
        }
    }
    for (const w of DASH_WIDGETS) {
        if (seen.has(w.key))
            continue;
        if (w.off) {
            hidden.push(w.key);
            continue;
        }
        const ci = DASH_LAYOUT_DEFAULT.findIndex((c) => c.includes(w.key));
        const target = cols[ci < 0 ? 0 : ci];
        // 자리만이 아니라 **순서까지** 기본 배치를 따른다(#1570) — 예전엔 열 끝에 push 라, 기본 배치에서 위인
        //  새 위젯(lvlog: 3열 '상단')이 기존 저장 배치 사용자에겐 맨 아래로 들어갔다. 기본 배치에서 이 위젯보다
        //  뒤인 위젯이 그 열에 있으면 그 앞에 끼운다 — "새 위젯은 기본 자리로 되살린다"의 순서 완성판.
        const def = ci < 0 ? [] : DASH_LAYOUT_DEFAULT[ci];
        const after = def.slice(def.indexOf(w.key) + 1);
        const at = target.findIndex((k) => after.includes(k));
        if (at < 0)
            target.push(w.key);
        else
            target.splice(at, 0, w.key);
    }
    return { cols, hidden };
}
async function renderMyDashboard(view) {
    // ── 셸 즉시 그리기(각 존은 스켈레톤) → 위젯별 병렬 로드 ──
    const sepEl = el('span', { text: ' · ' }); // 날짜와 요약 사이 구분점(요약 없으면 숨김)
    const summaryEl = el('span', { text: '불러오는 중…' }); // 인사줄 요약(프로젝트·세션 수) — 로드 후 갱신
    const obSlot = el('span'); // 온보딩 칩 자리(완료면 빈 채로)
    // 배치(#1232) — 사람이 고른 위젯만 만든다(숨긴 위젯은 존 자체를 안 만들어 API 호출도 안 함).
    const layout = dashLayout();
    const zones = {};
    for (const keys of layout.cols)
        for (const k of keys)
            zones[k] = dashZone(k, DASH_W[k].title);
    // mine=1(내 프로젝트)·리스트는 '최신 알림'·'내 프로젝트'·'내 AI 세션'이 공유 — 한 번만 호출(각자 독립적으로 await·실패처리).
    //  셋을 다 숨겼으면 아예 부르지 않는다(#1232 — 안 보이는 위젯 때문에 API 를 때리지 않는다).
    const projectsP = (zones.notif || zones.proj || zones.sess)
        ? api('/api/ui/v6/projects?mine=1').then((d) => (d && d.projects) || [])
        : Promise.resolve([]);
    const listsP = zones.proj ? api('/api/ui/v6/project-lists').then((d) => (d && d.lists) || []).catch(() => []) : Promise.resolve([]);
    const strip = el('div', { class: 'dash-strip' }, el('div', {}, el('div', { class: 'dash-hi', text: greeting() + ', ' + myDisplayName() + '님' }), el('div', { class: 'dash-date' }, todayLabel(), sepEl, summaryEl)), el('div', { class: 'dash-acts' }, obSlot, 
    // #req 탭 이동 대신 대시보드 위에 생성 팝업을 그대로 띄운다(세션=openTermCreateForm). 생성 후 대시보드 재렌더로 즉시 반영.
    //  프로젝트 생성은 '내 프로젝트' 섹션 인라인 추가와 **같은 팝업**(openProjectV2Form — 리스트 선택·설명·태스크·레포·팀원·AI세션 실행)으로 통일.
    //  stay:true = 생성 후 상세로 튀지 않고 여기서 재렌더만.
    el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '+ 새 프로젝트', onclick: () => openProjectV2Form(() => renderMyDashboard(view), { stay: true }) }), el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '+ 새 AI 세션', onclick: async (e) => {
            const b = e.currentTarget;
            b.disabled = true;
            try {
                const cfg = await api('/api/ui/terminal/config');
                openTermCreateForm(cfg, null, () => renderMyDashboard(view));
            }
            catch {
                location.hash = '#/terminal';
            }
            finally {
                b.disabled = false;
            }
        } }), 
    // #1232 대시보드 편집 — 위젯 카드의 ⚙(dash-wh-btn-gear)와 **같은 버튼**(같은 아이콘·테두리·톤)이라 '설정'임이 한눈에 통한다.
    //  스트립은 btn-sm 줄이라 크기만 그 줄에 맞춘다(.dash-acts .dash-wh-btn). 배치는 생성 버튼들 오른쪽 = 이 줄의 끝.
    dashLayoutBtn(view)));
    // 열 — 사람이 배치(어떤 위젯을 어느 열 몇 번째에)와 폭·높이를 정한다(#1232 + #req, 기기별 저장).
    //  빈 열은 아예 렌더하지 않고(남은 열이 그 폭을 나눠 갖는다), 열 사이 핸들은 '렌더된 열 수 - 1'개.
    const colKeys = layout.cols.filter((keys) => keys.length);
    const colEls = colKeys.map((keys) => el('div', { class: 'dash-col' }, ...keys.map((k) => zones[k].box)));
    const zonesEl = el('div', { class: 'dash-zones' }, ...colEls);
    if (colEls.length) {
        dashInitColResize(zonesEl, colKeys);
        // #req R13 — 한 열 안 박스들 사이 세로 높이 핸들(예: 내 프로젝트↔팀 공유 폴더). 위젯이 하나뿐인 열엔 핸들이 없다.
        colEls.forEach((c, i) => dashInitRowResize(c, dashRowKey(colKeys[i]), colKeys[i].map((k) => DASH_W[k].row), { autoLast: !!DASH_W[colKeys[i][colKeys[i].length - 1]].auto }));
    }
    else {
        zonesEl.classList.add('dash-zones--empty');
        zonesEl.append(el('div', { class: 'dash-allhidden' }, el('div', { class: 'dash-allhidden-t', text: '표시할 위젯이 없어요.' }), el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '대시보드 편집 열기', onclick: () => openDashLayoutModal(() => renderMyDashboard(view)) })));
    }
    view.replaceChildren(el('div', { class: 'dash' }, strip, zonesEl));
    // 열린 모달 안에 포커스가 있으면 뺏지 않는다 — '대시보드 편집'은 창을 열어둔 채 배치를 바꾸고(그때마다 여기로 재렌더),
    //  사람은 방금 옮긴 카드에서 방향키를 이어 누른다. 그 포커스를 #view 로 끌어오면 키보드 조작이 매번 끊긴다.
    if (!document.activeElement?.closest?.('.dash-modal-ov'))
        document.getElementById('view').focus?.();
    // ── 위젯별 독립 로드(실패는 그 존 안에만 errorNote) ──
    const counts = { projects: null, sessions: null }; // 인사줄 요약용(null=미집계 — 로드 실패 포함)
    const drawSummary = () => {
        const parts = [];
        if (counts.projects != null)
            parts.push('진행 중 프로젝트 ' + counts.projects);
        if (counts.sessions != null)
            parts.push('실행 중 세션 ' + counts.sessions);
        summaryEl.textContent = parts.join(' · ');
        sepEl.hidden = !parts.length; // 요약이 비면(양쪽 다 실패) 구분점도 숨김 — '날짜 · ' 꼬리 방지
    };
    if (zones.notif)
        fillNotifications(zones.notif, projectsP);
    if (zones.proj)
        fillProjects(zones.proj, (n) => { counts.projects = n; drawSummary(); }, projectsP, listsP);
    if (zones.task)
        fillMyTasks(zones.task);
    if (zones.sess)
        fillSessions(zones.sess, (n) => { counts.sessions = n; drawSummary(); }, projectsP);
    if (zones.fold)
        fillFolders(zones.fold);
    if (zones.log)
        fillActivity(zones.log);
    if (zones.review)
        fillReviewQueue(zones.review);
    if (zones.lvlog)
        fillLivelyLog(zones.lvlog);
    if (zones.lvlogd)
        fillLivelyLogTimeline(zones.lvlogd);
    fillOnboarding(obSlot);
    if (!zones.proj && !zones.sess)
        drawSummary(); // 두 위젯을 다 숨기면 요약할 게 없다 — '불러오는 중…'을 남기지 않는다
}
// 인사 스트립의 [⚙ 대시보드 편집] — 위젯 헤더 ⚙(dashCtl)와 같은 프리미티브(dash-wh-btn + dashGearIcon).
function dashLayoutBtn(view) {
    const b = el('button', { class: 'dash-wh-btn dash-wh-btn-gear', type: 'button', title: '대시보드 편집 — 위젯 표시·배치', 'aria-label': '대시보드 편집' }, dashGearIcon());
    b.onclick = () => openDashLayoutModal(() => renderMyDashboard(view));
    return b;
}
// ── 인사 스트립 조각들 ──
//  myDisplayName 은 dash/chrome.ts 에 있다(#1313 R43) — 최신 알림의 멘션 판정도 같은 이름을 봐야 하는데,
//  여기 두면 shell → widget-notifications → shell 순환이 된다.
function greeting() {
    const h = new Date().getHours();
    if (h < 5)
        return '늦은 밤이에요';
    if (h < 11)
        return '좋은 아침이에요';
    if (h < 17)
        return '좋은 오후예요';
    if (h < 22)
        return '좋은 저녁이에요';
    return '늦은 밤이에요';
}
function todayLabel() {
    return new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' });
}
// 온보딩 진행 칩 — 미완일 때만 표시(완료·실패면 조용히 생략).
//  ⚠ 우선순위: **내 온보딩(#/start)이 먼저**다 — 내가 아직 라이블리를 못 쓰는 상태면, 관리자가 채우는
//   조직 셋업보다 그게 급하다. 내 것이 끝났을 때만 조직 셋업(#/onboarding) 칩을 보여준다.
//   두 개를 동시에 띄우지 않는다(대시보드 인사줄은 좁고, 지금 할 일은 하나여야 한다).
async function fillOnboarding(slot) {
    try {
        const me = await api('/api/ui/me/onboarding').catch(() => null);
        if (me && me.status && !me.status.complete) {
            const s = me.status;
            slot.replaceChildren(el('a', { class: 'dash-ob', href: '#/start', title: '시작하기 — 준비 상황 보기' }, el('span', { text: `시작하기 ${s.done}/${s.total}` }), el('span', { class: 'dash-ob-bar' }, el('span', { class: 'dash-ob-fill', style: 'width:' + (s.pct || 0) + '%' }))));
            return;
        }
        const s = await api('/api/ui/org/onboarding');
        if (!s || s.complete)
            return;
        slot.replaceChildren(el('a', { class: 'dash-ob', href: '#/onboarding', title: '온보딩 진행상황 보기' }, el('span', { text: `온보딩 ${s.done}/${s.total}` }), el('span', { class: 'dash-ob-bar' }, el('span', { class: 'dash-ob-fill', style: 'width:' + (s.pct || 0) + '%' }))));
    }
    catch { /* 칩 없이 진행 */ }
}
// ── 존(위젯 카드) 공통 셸 — 헤더(제목·카운트·칩 슬롯·우상단 컨트롤) + 내부 스크롤 목록 ──
//  우상단 컨트롤(ctlEl)은 dashCtl 로 [⚙ 설정]+[액션] 을 채운다 — 5개 존 동일 배치·동일 스타일(#req 통일성).
function dashZone(key, title) {
    const countEl = el('span', { class: 'dash-wh-n' });
    const chipsEl = el('span', { class: 'dash-wh-chips' });
    const ctlEl = el('span', { class: 'dash-wh-ctl' });
    const body = el('div', { class: 'dash-wl' });
    body.append(skeleton('불러오는 중'));
    const box = el('section', { class: 'dash-zone dash-zone--' + key, 'aria-label': title }, el('div', { class: 'dash-wh' }, el('h4', { text: title }), countEl, chipsEl, ctlEl), body);
    // 칩이 실제로 넘칠 때만 우측 페이드(is-clipped) — 열 폭 리사이즈로 너비 바뀔 때도 재판정(#req '안 넘치면 안 흐리게').
    try {
        new ResizeObserver(() => dashUpdateChipClip(chipsEl)).observe(chipsEl);
    }
    catch { /* 미지원 무시 */ }
    return { box, body, countEl, chipsEl, ctlEl };
}
// ── 열 폭 사용자화(#req) — .dash-zones 열 사이 드래그 핸들. 저장·이관(sig·v2 이어받기)은 dash/resize.ts 에 있다. ──
//  ⚠ 여기 있는 이유: 열 기본 가중치를 위젯 레지스트리(DASH_W 의 col·wide)에서 읽는다 — resize.ts 로 내리면
//   resize → shell 역방향이 생겨 순환이 된다(레지스트리는 셸 소유). 짝인 행 높이 핸들은 dashInitRowResize 다.
function dashInitColResize(zonesEl, colKeys) {
    const n = colKeys.length;
    const sig = dashColsSig(colKeys);
    const saved = dashColsSaved(sig, n);
    // saved 없으면 이 가중치는 px 기본을 안 덮음(frMode=false) — 첫 드래그 때 captureFr 가 실제 px→fr 로 대체.
    const cols = saved || colKeys.map((keys) => Math.max(...keys.map((k) => DASH_W[k].col)));
    // wide 위젯이 있는 열은 px 기본. 열이 하나뿐이면 px 고정이 무의미하니(옆에 나눌 열이 없다) 그냥 fr.
    const pxCol = n > 1 ? colKeys.findIndex((keys) => keys.some((k) => DASH_W[k].wide)) : -1;
    let frMode = !!saved; // false = px 기본(wide 열 = 3열-최소 폭) 유지 상태.
    const HANDLE = 16, MIN_FR = 1.2; // 핸들 트랙 폭(px) · 열 최소 폭(fr, 붕괴 방지).
    // #758 px 하드 최소(minmax 의 px 하한)는 두지 않는다 — 드래그 중 그 열이 하한 밑으로 안 줄어 부족분을 먼 열에서 뺏어오던 버그
    //   (px 하한 vs fr 클램프 불일치). 여기 px 는 '기본 초기값'일 뿐, 드래그하면 captureFr 로 전 열을 fr 로 바꿔 apply() 는 minmax(0,fr)만
    //   쓴다 — px 하한이 드래그와 싸우지 않는다. (행 높이 리사이즈의 cssDefault/captureFr 패턴과 동형.)
    const track = (i) => (!frMode && i === pxCol ? DASH_COL_PX + 'px' : `minmax(0,${cols[i]}fr)`);
    const apply = () => { zonesEl.style.gridTemplateColumns = cols.map((_, i) => track(i)).join(` ${HANDLE}px `); };
    const kids = Array.from(zonesEl.children); // 스냅샷 [col0 … colN-1]
    // 현재(px 기본) 열 폭을 fr 비율로 캡처 → 드래그 시작점(레이아웃 안 튀게). 이후엔 순수 fr.
    const captureFr = () => {
        const w = kids.map((k) => Math.max(1, k.offsetWidth || 100));
        const s = (4 * n) / w.reduce((a, b) => a + b, 0);
        w.forEach((x, i) => { cols[i] = x * s; });
        frMode = true;
    };
    const mkHandle = (idx) => {
        const h = el('div', { class: 'dash-col-handle', role: 'separator', 'aria-orientation': 'vertical', title: '열 폭 조절 (더블클릭=기본, ←/→ 미세조절)', tabindex: '0' }, el('span', { class: 'dash-col-grip' }));
        let startX = 0, w0 = 0, w1 = 0, dragging = false;
        const onMove = (e) => {
            if (!dragging)
                return;
            const rect = zonesEl.getBoundingClientRect();
            const content = Math.max(1, rect.width - (n - 1) * HANDLE);
            const totalFr = cols.reduce((a, b) => a + b, 0);
            const dFr = ((e.clientX - startX) / content) * totalFr;
            let a = w0 + dFr, b = w1 - dFr;
            if (a < MIN_FR) {
                b -= (MIN_FR - a);
                a = MIN_FR;
            }
            if (b < MIN_FR) {
                a -= (MIN_FR - b);
                b = MIN_FR;
            }
            cols[idx] = a;
            cols[idx + 1] = b;
            apply();
        };
        const onUp = () => { if (!dragging)
            return; dragging = false; document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); document.body.classList.remove('dash-col-resizing'); dashSaveCols(sig, cols); };
        h.addEventListener('pointerdown', (e) => { e.preventDefault(); if (!frMode)
            captureFr(); dragging = true; startX = e.clientX; w0 = cols[idx]; w1 = cols[idx + 1]; document.body.classList.add('dash-col-resizing'); document.addEventListener('pointermove', onMove); document.addEventListener('pointerup', onUp); apply(); });
        // 기본(wide 열 = 3열-최소 px)으로 복귀. v2 도 함께 지운다 — 안 그러면 기본 배치에선 예전 fr 이 되살아난다.
        h.addEventListener('dblclick', () => {
            try {
                localStorage.removeItem(DASH_COLS_KEY);
                localStorage.removeItem(DASH_COLS_KEY_V2);
            }
            catch { /* */ }
            frMode = false;
            colKeys.forEach((keys, i) => { cols[i] = Math.max(...keys.map((k) => DASH_W[k].col)); });
            apply();
        });
        h.addEventListener('keydown', (e) => {
            const step = e.key === 'ArrowLeft' ? -0.3 : e.key === 'ArrowRight' ? 0.3 : 0;
            if (!step)
                return;
            e.preventDefault();
            if (!frMode)
                captureFr();
            const a = cols[idx] + step, b = cols[idx + 1] - step;
            if (a >= MIN_FR && b >= MIN_FR) {
                cols[idx] = a;
                cols[idx + 1] = b;
                apply();
                dashSaveCols(sig, cols);
            }
        });
        return h;
    };
    for (let i = 0; i < n - 1; i++)
        zonesEl.insertBefore(mkHandle(i), kids[i + 1]); // col0 | H0 | col1 | H1 | …
    apply(); // 배치가 사람마다 달라 CSS 기본 열 트랙이 맞을 수 없다 — px/fr 어느 쪽이든 여기서 항상 인라인으로 확정
}
// ── 대시보드 편집(#1232) — 어떤 위젯을 보일지(내용)와 어느 열 몇 번째에 둘지(배치)를 한 창에서. ──
//  창 자체가 대시보드의 축소판이다: 3열 + 아래 '숨긴 위젯' 트레이. 카드를 끌어 옮기거나(드래그),
//  카드를 고르고 방향키/버튼으로 옮긴다(hover 로만 되는 조작을 두지 않는다 — DS 체크리스트).
//  저장은 조작 즉시(기기별 localStorage), 뒤 화면 재조립만 400ms 로 묶는다 — 카드를 연달아 옮길 때
//  옮길 때마다 위젯 API 를 다시 부르지 않게. 창은 열린 채 남아 결과를 바로 보며 이어서 만질 수 있다.
function openDashLayoutModal(onApply) {
    let lay = dashLayout();
    const body = el('div', { class: 'dash-lay' });
    let dragKey = null;
    let timer = null;
    const scheduleApply = () => { if (timer)
        clearTimeout(timer); timer = setTimeout(() => { timer = null; onApply(); }, 400); };
    const pluck = (k) => { lay.cols = lay.cols.map((c) => c.filter((x) => x !== k)); lay.hidden = lay.hidden.filter((x) => x !== k); };
    const place = (k, ci, i) => { pluck(k); const c = lay.cols[ci]; c.splice(Math.max(0, Math.min(i, c.length)), 0, k); };
    const hide = (k) => { pluck(k); lay.hidden.push(k); };
    // 되돌릴 땐 그 위젯의 기본 자리로. 기본 배치에 없는 위젯(off=기본 숨김)은 갈 자리가 정해져 있지 않으니
    //  home(레지스트리에 적힌 제자리, 없으면 왼쪽 열) 끝에 — 거기서 사람이 원하는 자리로 옮기면 된다
    //  (그 순간 현재 버전으로 저장돼 다시 숨겨지지 않는다).
    const show = (k) => {
        const ci = DASH_LAYOUT_DEFAULT.findIndex((c) => c.includes(k));
        pluck(k);
        lay.cols[ci >= 0 ? ci : (DASH_W[k].home || 0)].push(k);
    };
    const commit = (focusKey) => { dashSaveLayout(lay); draw(focusKey); scheduleApply(); };
    // 카드 — 배치된 것(ci≥0)과 숨긴 것(ci=-1)이 같은 모양. 배치 카드만 이동 컨트롤을 갖는다.
    const card = (k, ci, i) => {
        const w = DASH_W[k];
        const c = el('div', { class: 'dash-lay-card' + (ci < 0 ? ' off' : ''), draggable: 'true', tabindex: '0', 'data-wkey': k,
            'aria-label': w.title + ' — ' + (ci < 0 ? '숨김' : DASH_COL_LABELS[ci] + ' ' + (i + 1) + '번째'),
            'aria-keyshortcuts': ci < 0 ? 'Enter' : 'ArrowLeft ArrowRight ArrowUp ArrowDown Delete',
            title: ci < 0 ? '표시하려면 Enter 또는 [표시]' : '방향키로 옮겨요 — ←→ 열 이동 · ↑↓ 순서 · Delete 숨김' });
        c.append(el('div', { class: 'dash-lay-top' }, dashGripIcon(), el('span', { class: 'dash-lay-txt' }, el('span', { class: 'dash-lay-name', text: w.title }), el('span', { class: 'dash-lay-desc', text: w.desc }))));
        const ctl = el('div', { class: 'dash-lay-ctl' });
        if (ci < 0) {
            const on = el('button', { class: 'dash-lay-restore', type: 'button', text: '표시', title: w.title + ' 다시 표시' });
            on.onclick = () => { show(k); commit(k); };
            ctl.append(on);
        }
        else {
            const keys = lay.cols[ci];
            const mv = (label, aria, disabled, run) => {
                const b = el('button', { class: 'dash-lay-mv', type: 'button', text: label, title: aria, 'aria-label': w.title + ' ' + aria });
                if (disabled)
                    b.setAttribute('disabled', 'disabled');
                else
                    b.onclick = run;
                return b;
            };
            ctl.append(mv('←', '왼쪽 열로', ci === 0, () => { place(k, ci - 1, lay.cols[ci - 1].length); commit(k); }), mv('↑', '위로', i === 0, () => { place(k, ci, i - 1); commit(k); }), mv('↓', '아래로', i === keys.length - 1, () => { place(k, ci, i + 1); commit(k); }), mv('→', '오른쪽 열로', ci === lay.cols.length - 1, () => { place(k, ci + 1, lay.cols[ci + 1].length); commit(k); }));
            const off = el('button', { class: 'dash-lay-x', type: 'button', text: '✕', title: w.title + ' 숨기기', 'aria-label': w.title + ' 숨기기' });
            off.onclick = () => { hide(k); commit(k); };
            ctl.append(el('span', { class: 'dash-lay-ctl-sp' }), off);
        }
        c.append(ctl);
        // 키보드 = 버튼과 같은 조작(포커스된 카드에서 바로).
        c.addEventListener('keydown', (e) => {
            if (ci < 0) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    show(k);
                    commit(k);
                }
                return;
            }
            const keys = lay.cols[ci];
            if (e.key === 'ArrowLeft' && ci > 0) {
                e.preventDefault();
                place(k, ci - 1, lay.cols[ci - 1].length);
                commit(k);
            }
            else if (e.key === 'ArrowRight' && ci < lay.cols.length - 1) {
                e.preventDefault();
                place(k, ci + 1, lay.cols[ci + 1].length);
                commit(k);
            }
            else if (e.key === 'ArrowUp' && i > 0) {
                e.preventDefault();
                place(k, ci, i - 1);
                commit(k);
            }
            else if (e.key === 'ArrowDown' && i < keys.length - 1) {
                e.preventDefault();
                place(k, ci, i + 1);
                commit(k);
            }
            else if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                hide(k);
                commit(k);
            }
        });
        // 드래그 — 카드 위/아래 절반으로 '앞/뒤' 삽입(요약 카드 재정렬 #671 과 같은 결). 열 컨테이너로는 전파하지 않는다.
        c.addEventListener('dragstart', (e) => { dragKey = k; try {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', k);
        }
        catch { /* */ } c.classList.add('drag-src'); });
        c.addEventListener('dragend', () => { dragKey = null; c.classList.remove('drag-src'); body.querySelectorAll('.drop-before, .drop-after, .drop-in').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-in')); });
        c.addEventListener('dragover', (e) => {
            if (!dragKey || dragKey === k)
                return;
            e.preventDefault();
            e.stopPropagation();
            c.parentElement?.classList.remove('drop-in'); // 카드 위에선 '이 카드 앞/뒤'가 답 — 열 전체 강조는 끈다
            const r = c.getBoundingClientRect();
            const after = (e.clientY - r.top) > r.height / 2;
            c.classList.toggle('drop-after', after);
            c.classList.toggle('drop-before', !after);
        });
        c.addEventListener('dragleave', () => c.classList.remove('drop-before', 'drop-after'));
        c.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const after = c.classList.contains('drop-after');
            c.classList.remove('drop-before', 'drop-after');
            const src = dragKey;
            dragKey = null;
            if (!src || src === k)
                return;
            if (ci < 0) {
                hide(src);
                commit(src);
                return;
            }
            // 같은 열 안에서 위로 끌어올릴 땐 자기 자신을 뺀 뒤의 인덱스로 보정해야 한 칸씩 밀리지 않는다.
            const from = lay.cols[ci].indexOf(src);
            let at = i + (after ? 1 : 0);
            if (from >= 0 && from < at)
                at--;
            place(src, ci, at);
            commit(src);
        });
        return c;
    };
    // 드롭 영역(열·트레이) 공통 — 카드가 아닌 빈 곳에 떨어뜨리면 맨 끝으로.
    const dropZone = (box, onDrop) => {
        box.addEventListener('dragover', (e) => { if (!dragKey)
            return; e.preventDefault(); box.classList.add('drop-in'); });
        box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget))
            box.classList.remove('drop-in'); });
        box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('drop-in'); const src = dragKey; dragKey = null; if (src)
            onDrop(src); });
        return box;
    };
    const draw = (focusKey) => {
        const cols = el('div', { class: 'dash-lay-cols' });
        lay.cols.forEach((keys, ci) => {
            const box = dropZone(el('div', { class: 'dash-lay-col', role: 'group', 'aria-label': DASH_COL_LABELS[ci] }), (src) => { place(src, ci, lay.cols[ci].length); commit(src); });
            box.append(el('div', { class: 'dash-lay-ch', text: DASH_COL_LABELS[ci] }));
            if (!keys.length)
                box.append(el('div', { class: 'dash-lay-drop', text: '비어 있어요' }));
            keys.forEach((k, i) => box.append(card(k, ci, i)));
            cols.append(box);
        });
        const tray = dropZone(el('div', { class: 'dash-lay-tray', role: 'group', 'aria-label': '숨긴 위젯' }), (src) => { hide(src); commit(src); });
        if (!lay.hidden.length)
            tray.append(el('div', { class: 'dash-lay-drop', text: '카드를 여기로 끌면 화면에서 숨겨져요' }));
        lay.hidden.forEach((k) => tray.append(card(k, -1, 0)));
        const reset = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '기본 배치로 되돌리기' });
        reset.onclick = () => { dashResetLayout(); lay = dashDefaultLayout(); draw(); scheduleApply(); };
        body.replaceChildren(el('p', { class: 'dash-lay-hint', text: '화면에 보일 위젯과 자리를 정합니다. 카드를 끌어 옮기거나, 카드를 고른 뒤 버튼·방향키(←→ 열 이동 · ↑↓ 순서)를 쓰세요. 열 폭과 높이는 대시보드에서 위젯 사이 경계를 끌어 조절합니다.' }), cols, el('div', { class: 'dash-lay-th', text: '숨긴 위젯' }), tray, el('div', { class: 'dash-lay-foot' }, el('span', { class: 'dash-lay-note', text: '바뀐 배치는 이 기기에 저장돼요.' }), reset));
        if (focusKey)
            body.querySelector('[data-wkey="' + focusKey + '"]')?.focus?.(); // 옮긴 카드를 계속 조작할 수 있게 포커스 유지
    };
    draw();
    dashModal('대시보드 편집', body, true);
}
// 홈에서 '내 AI 세션 만들기' 따라하기 시작(#780) — 사용 가이드의 [내 AI 세션 생성]이 #/dashboard?tour=1 로 보낸다.
//  세션 위젯은 비동기로 채워지므로 앵커([data-tour="new-session"] — 목록 하단 ＋새 세션 / 빈 상태 버튼)가 뜰 때까지 기다린다.
//  ①단계만 대시보드용이고 ②~⑦(생성 폼)은 터미널과 동일 폼이라 그대로 이어진다.
async function startDashboardSessionTour(returnTo) {
    for (let i = 0; i < 40 && !document.querySelector('[data-tour="new-session"]'); i++) {
        await new Promise((r) => setTimeout(r, 100));
    }
    if (!document.querySelector('[data-tour="new-session"]'))
        return; // 못 찾으면 조용히 포기(딤만 남기지 않는다)
    // 온보딩(#/start)에서 '웹에서 만들기'로 들어온 경우(returnTo)엔, 끝나면 항상 온보딩 화면으로 되돌린다.
    //  - 완주(⑦ [생성하기] 클릭=세션 생성)면 connect 를 done 으로 보고 → 다음 단계(2/4)로 넘어간 상태로 복귀.
    //  - 중도 취소(투어 닫기/이탈)면 아무것도 마킹하지 않고 그대로 복귀 → 완료 안 된 상태(1/4) 유지.
    const opts = returnTo ? {
        onEnd: async (reason) => {
            if (reason === 'complete') {
                try {
                    await api('/api/ui/me/onboarding', { method: 'POST', body: JSON.stringify({ step: 'connect', state: 'done', by: 'self' }) });
                }
                catch (_) { /* 마킹 실패해도 이동은 진행 — 서버 자동판정(첫 MCP 호출)이 곧 done 으로 만든다 */ }
            }
            location.hash = returnTo; // 완주든 취소든 원래 있던 곳으로. 취소면 위에서 마킹을 건너뛰어 미완료 유지.
        },
    } : undefined;
    startTerminalTour(dashTourStep1(), opts);
}
export { DASH_COL_LABELS, DASH_LAYOUT_DEFAULT, DASH_W, DASH_WIDGETS, dashDefaultLayout, dashInitColResize, dashLayout, dashLayoutBtn, dashZone, fillOnboarding, greeting, openDashLayoutModal, renderMyDashboard, startDashboardSessionTour, todayLabel, };
