// terminal/status-filter.ts — AI 세션의 **상태 어휘**(라벨·판정·상대시각·짧은 경로)와 **3축 필터**(상태·소속·기간)의 정의·영속·축 드롭다운.
//  소비자: terminal/{select-bar,session-list,routes}.ts. import 방향: core·session-status·admin(프리미티브)만 본다 — terminal/ 안에서는
//  아무것도 import 하지 않는 최하층이다(위층이 이 파일을 본다).
import { el } from '../core.js';
import { SESS_STATES, SESS_STATE_KEYS, sessStateKey, sessIsDead as sessDeadShared } from '../session-status.js'; // #1059 P1 — 상태 어휘는 대시보드와 한 벌
// #1582 — 종료 확인창의 정의는 web/session-actions.ts 로 옮겼다(대시보드·프로젝트 상세가 같은 것을 쓰게).
//  여기 남은 tsessConfirmEnd 는 이 탭 호출부의 이름을 지키는 얇은 위임일 뿐이다.
import { confirmSessionEnd } from '../session-actions.js';
// ── 세션 라이브 상태(#745, #1015 E 로 5단계) — 게이트웨이 백엔드의 agentState 를 그대로 쓴다. ──
//  busy=작업 중(스피너 관측) · waiting=확인 필요(승인·선택 대기) · idle=대기 중(에이전트 살아있음)
//  exited=종료됨(하네스가 끝나 셸만 남음 — 이 세션에선 AI 가 더 안 돈다) · offline=연결 끊김(원격 노드 미연결).
//  ⚠ '대기 중'은 브라우저 접속 여부와 무관하다 — 세션은 게이트웨이/노드에서 상시 돌고, 아무도 안 보고 있다고
//   꺼진 게 아니다. 예전엔 미접속을 전부 '오프라인'으로 칠해 살아 있는 세션이 꺼진 것처럼 보였다(#1015 E).
//  title = Claude Code 가 pane 에 써두는 '지금 하는 일' 요약(백엔드 제공) → 카드에 그대로 노출(= '지금 무슨 작업').
//  waiting 을 맨 앞으로: 내 승인/선택을 기다리는 = 가장 먼저 처리할 것. 아무도 안 보는 세션(offline)·끝난 세션(exited)은 뒤로.
const TSESS_STATUS = SESS_STATES; // #1059 P1 — 공용 정의(web/session-status.ts). 두 화면이 갈라지지 않게 여기서 만들지 않는다.
// 종료 확인 다이얼로그 — 카드/일괄 공통. 브라우저 confirm 대신 라이블리 확인 모달(#1062).
//  '삭제'가 아니라 '끝내기'이고 대화록은 남는다는 걸 여기서 못 박는다.
//  #1582 — 문구를 여기서 만들지 않고 공용 정의에 위임한다. 종전엔 "대화록은 지워지지 않아요"를 **무조건** 말했는데,
//   조직이 세션 공유를 안 켰거나 그 하네스가 캡처 대상이 아니면 거짓이 된다(라이블리는 다른 조직에도 배포된다).
//   sessions 를 넘겨 그 세션에서 참인 문장만 나가게 한다.
function tsessConfirmEnd(title, extraLines = [], sessions) {
    return confirmSessionEnd({ title, lines: extraLines, sessions });
}
// 세션이 '이제 AI 가 안 도는' 상태인가 — 일괄 종료 대상·'끝남' 뷰 판정. exited(셸만 남음)·restorable(#1059 E, tmux 죽음).
//  ⚠ offline 은 제외한다 — 그건 '아무도 안 보는 중'이지 끝난 게 아니다(프로세스는 대개 살아 있다).
function sessDead(s) { return sessDeadShared(s); }
// #1059 E — restorable(desired-state 만 남고 tmux 는 죽음)을 먼저 판정, 그 외는 백엔드 agentState(없으면 exited).
function sessState(s) { return sessStateKey(s); }
// 상대 시각 — '방금 · 3분 전 · 2시간 전 · 5일 전'.
function relAgo(sec) {
    const n = Number(sec) || 0;
    if (!n)
        return '';
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - n);
    if (diff < 45)
        return '방금';
    if (diff < 3600)
        return Math.floor(diff / 60) + '분 전';
    if (diff < 86400)
        return Math.floor(diff / 3600) + '시간 전';
    return Math.floor(diff / 86400) + '일 전';
}
// 작업 폴더는 끝 2단계만(…/745/context-ontology) — 카드 한 줄에 담기게.
function shortDir(d) {
    const segs = String(d || '').split('/').filter(Boolean);
    return segs.length <= 2 ? (d || '') : '…/' + segs.slice(-2).join('/');
}
// ── 필터 재설계(#1062) — '상태 다중토글 + 소유 3버킷'을 목적별 뷰 한 줄로 교체 ──
//  왜: 실측(48세션)에서 상태는 대기중 42 / 작업중 3 / 확인필요 2 / 종료됨 1 로 88%가 한 칸이라 필터가 아니라
//  장식이었고, 소유도 39:9 쏠림이라 칩 두 개를 쓸 값이 없었다. 반대로 사람이 실제로 나누고 싶어 하는 축
//  —'지금 나를 기다리는 것 / 오늘 만진 것 / 몇 주째 방치된 것'— 은 아예 없었다(마지막 작업 경과 분포는
//  오늘 11 · 1~7일 19 · 8~30일 18 로 잘 갈린다). 그래서 축을 '상태'가 아니라 **목적**으로 바꾼다.
//  프로젝트(40개에 1~3개씩 분산)는 검색형 드롭다운이 맞으므로 그대로 직교 유지.
const DAY = 86400;
function sessAgeDays(s) { const t = Number(s.lastActive || s.created) || 0; return t ? (Date.now() / 1000 - t) / DAY : 999; }
// '오늘'은 24시간이 아니라 **달력상 오늘**(자정 이후) — 라벨이 '오늘'인데 어젯밤 11시 작업이 빠지거나
//  하루 종일 경계가 밀리면 읽는 사람의 '오늘'과 어긋난다.
function sessSinceMidnight(s) {
    const t = Number(s.lastActive || s.created) || 0;
    if (!t)
        return false;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return t * 1000 >= d.getTime();
}
// ── #1098 재재설계 — 목적별 뷰(단일선택) 한 줄을 **3축**으로 나눈다: 상태(다중) · 출처(다중) · 기간(단일).
//  #1062 때는 상태 축이 88% 한 칸이라 죽은 축이라 판단해 접었지만, 그건 '거를 값이 없다'는 뜻이었지
//  '고를 수 없어도 된다'는 뜻이 아니었다(상민님 지적). 대시보드(#1098)에서 만든 출처·상태 2축을 여기에도 주되,
//  이 탭은 헤더 폭 여유가 있으므로 **상태는 칩으로 펼치고**(한 번 클릭) 출처·기간은 드롭다운으로 접는다.
//  시간축(오늘·최근 7일·방치)은 상태·출처로 표현 못 하는 직교축이라 살려서 '기간'으로 옮겼다.
// ── #1229 '출처' 축 해체 — 소유는 **섹션**으로, 소속만 **필터**로.
//  #1098 의 '출처'는 사실 두 축의 곱이었다: (프로젝트 소속 여부) × (내 것 여부) = 4버킷
//  (내 프로젝트 · 남의 프로젝트 · 개인 · 초대). 한 드롭다운에 곱을 우겨넣으니 (a) '내 것만'처럼 흔한 의도가
//  두 칸을 골라야 되는 일이 되고, (b) 소유로 **걸러 버리면** 남의 '확인 필요' 세션을 아예 못 본다 —
//  그건 이 탭의 목적(#1062 §2 '박스에서 도는 AI 작업 미션컨트롤')과 정반대다.
//  → 소유 축은 거르지 않고 **나눈다**(아래 TSESS_SECTIONS 2섹션, 접기 가능).
// ── #1238 「전체」 행 폐지 — 다중 축은 **체크박스만** 둔다(아무것도 안 고름 = 전체).
//  구조상 '전체'는 항목이 아니라 **선택이 비어 있는 상태**인데, 그걸 형제 행으로 세우면 (a) 항목처럼 보이지만
//  다른 것과 함께 못 골리고 (b) 축마다 '전체 상태'/'전체'/'전체 기간'으로 이름이 갈렸다. 체크박스로 두면
//  빈 선택이 곧 전체라 행이 필요 없다. 되돌리기는 헤더 「초기화」 한 번(대시보드 #1098 팝오버와 같은 컨트롤).
//  ⚠ 이때 소속 축은 단일선택 → **다중선택 2칸**이 된다. #1229 가 폐기한 「~만」 체크박스 안과 다른 점:
//   저건 파생 조건의 단방향 토글이라 끄는 게 '제외'가 아니었지만, 여기 두 칸은 **한 축을 빈틈없이 나눈
//   상호배타 버킷**이라 「비소속」 체크가 곧 「소속 제외」다(안 고름=전체 · 하나만=그것만 · 둘 다=전체).
//  기간 축은 그대로 단일선택 + 「전체 기간」 행 유지 — 버킷이 겹쳐(오늘 ⊂ 최근 7일) 다중선택 합집합이
//  '오늘 + 최근 7일' 같은 무의미한 조합을 만든다(상민님 결정 2026-07-29).
// #1059 P1 — 카드 라벨과 **같은 이름·같은 순서**의 필터 항목(공용 정의에서 생성). 종전엔 카드가 '종료됨'인데
//  필터엔 그 칸이 없어 '복원 가능'에 잡히는 어긋남이 있었다.
const TSESS_STATE_OPTS = SESS_STATE_KEYS.map((k) => ({ key: k, label: SESS_STATES[k].label, cls: SESS_STATES[k].cls, hint: SESS_STATES[k].hint }));
// 소속 — '이 세션이 프로젝트에 묶여 있나'(다중 선택, 상호배타 2칸이 전체를 빈틈없이 덮는다).
//  ⚠ 프로젝트 드롭다운(buildSessProjFilter)의 구 '개인 세션만'·'프로젝트 세션만'이 바로 이 축이었다 —
//   같은 축이 두 컨트롤에 있어 중복이었고, 그쪽에서 뺐다. 저기는 '어느 프로젝트냐'만 고른다.
const TSESS_SCOPE_OPTS = [
    { key: 'proj', label: '프로젝트 소속', hint: '프로젝트 폴더에서 도는 세션 — 로그인한 전원에게 공개(#452)', match: (s) => !!(Number(s.projectId) || 0) },
    { key: 'nonproj', label: '프로젝트 비소속', hint: '프로젝트에 안 묶인 개인 세션 — 소유자와 초대받은 사람만 봅니다', match: (s) => !(Number(s.projectId) || 0) },
];
// 한 세션의 소속 버킷. 두 칸이 전체를 덮으므로 '못 찾음'은 없다(프로젝트 id 유무가 전부).
const tsessScopeOf = (s) => (Number(s.projectId) || 0) ? 'proj' : 'nonproj';
// 섹션 — 소유 축(#1229). 거르지 않고 **나눈다**: 두 섹션이 늘 같이 보이되 각각 접을 수 있다.
//  ⚠ '남이 만든'은 두 종류가 섞인다 — 내가 초대받은 개인 세션(배지 `초대받음`)과, 초대와 무관하게 전원 공개인
//   프로젝트 세션(배지 `공동`, #452·#1062 §2). 그래서 섹션 이름을 '초대된 세션'이라 하면 다수가 오탈이다.
//   구분은 카드 배지가 이미 한다(tsessCard) — 섹션은 '내가 만든 것이냐'만 가른다(종료·복원 권한선과 일치).
const TSESS_SECTIONS = [
    { key: 'mine', label: '내가 만든 세션', hint: '내가 만든 세션 — 종료·이어서 열기 같은 관리는 여기서만 됩니다(서버도 소유자만 허용)', match: (s) => !!s.owned },
    { key: 'others', label: '남이 만든 세션', hint: '내가 초대받은 개인 세션 + 전원 공개인 프로젝트 세션(#452). 열어서 볼 수는 있지만 종료는 못 합니다', match: (s) => !s.owned },
];
// 접어 둔 섹션(브라우저 영속). 값 = 접힌 섹션 key 배열.
const TSESS_SECT_KEY = 'lively_term_sections_v1';
function tsessCollapsed() {
    try {
        const raw = JSON.parse(localStorage.getItem(TSESS_SECT_KEY) || '[]');
        return new Set((Array.isArray(raw) ? raw : []).filter((k) => TSESS_SECTIONS.some((s) => s.key === k)));
    }
    catch {
        return new Set();
    }
}
function saveTsessCollapsed(c) {
    try {
        if (c.size)
            localStorage.setItem(TSESS_SECT_KEY, JSON.stringify([...c]));
        else
            localStorage.removeItem(TSESS_SECT_KEY);
    }
    catch { /* noop */ }
}
function sessBasisTime(s, basis) {
    return Number(basis === 'created' ? s.created : (s.lastActive || s.created)) || 0;
}
const TSESS_PERIOD_OPTS = [
    { key: 'all', label: '전체 기간', hint: '기간 제한 없음', match: () => true },
    { key: 'today', label: '오늘', hint: '오늘(자정 이후)', match: (s, t) => t > 0 && t * 1000 >= startOfDayMs() },
    { key: 'week', label: '최근 7일', hint: '이번 주', match: (s, t) => t > 0 && (Date.now() / 1000 - t) < 7 * DAY },
    { key: 'stale', label: '방치 7일+', hint: '일주일 넘게 아무 작업이 없는 세션 — 정리(종료) 후보', match: (s, t) => t > 0 && (Date.now() / 1000 - t) >= 7 * DAY && !sessDead(s) },
];
// 하루 경계는 **달력상 오늘**(자정) 기준 — '오늘'인데 24시간 창이면 어젯밤 작업이 섞여 체감과 어긋난다.
function startOfDayMs(d) { const x = d ? new Date(d) : new Date(); x.setHours(0, 0, 0, 0); return x.getTime(); }
// 'YYYY-MM-DD'(date input 값) → 그 날 00:00 / 다음날 00:00 의 epoch초. 형식이 아니면 0.
function ymdStartSec(v) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ''); if (!m)
    return 0; return new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0).getTime() / 1000; }
function ymdEndSec(v) { const st = ymdStartSec(v); return st ? st + DAY : 0; }
function ymdShort(v) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ''); return m ? Number(m[2]) + '/' + Number(m[3]) : ''; }
const TSESS_PERIOD_ALL = { preset: 'all', from: '', to: '', basis: 'last' };
function tsessPeriodIsAll(p) { return p.preset === 'all' && p.basis === 'last'; }
// 구 저장값(period 가 문자열)도 그대로 읽어 객체로 올린다.
function tsessPeriodOf(v) {
    if (typeof v === 'string')
        return { ...TSESS_PERIOD_ALL, preset: TSESS_PERIOD_OPTS.some((o) => o.key === v) ? v : 'all' };
    const o = v || {};
    const ymd = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? String(x) : '');
    const preset = o.preset === 'range' || TSESS_PERIOD_OPTS.some((x) => x.key === o.preset) ? o.preset : 'all';
    return { preset, from: ymd(o.from), to: ymd(o.to), basis: o.basis === 'created' ? 'created' : 'last' };
}
// 한 세션이 그 기간 선택에 걸리나 — 프리셋·직접지정 둘 다 같은 기준 시각을 쓴다.
function tsessPeriodMatch(p, s) {
    const t = sessBasisTime(s, p.basis);
    if (p.preset === 'range') {
        if (!p.from && !p.to)
            return true;
        if (!t)
            return false;
        const from = p.from ? ymdStartSec(p.from) : 0;
        const to = p.to ? ymdEndSec(p.to) : 0; // 끝날은 그 날 24:00 까지 포함(하루 단위 선택이므로)
        return (!from || t >= from) && (!to || t < to);
    }
    return (TSESS_PERIOD_OPTS.find((o) => o.key === p.preset) || TSESS_PERIOD_OPTS[0]).match(s, t);
}
// 저장은 3축을 한 덩어리로(v5 — 소속이 문자열→배열이 되며 v4 에서 올라왔다).
//  구 키(v4 = 소속 단일 · v3 = 출처 다중 · v2 = 목적별 뷰 + '내 것만')는 첫 로드에서 1회 이관하고 지운다.
const TSESS_FILTER_KEY = 'lively_term_filter_v5';
const TSESS_FILTER_V4_KEY = 'lively_term_filter_v4';
const TSESS_FILTER_V3_KEY = 'lively_term_filter_v3';
const TSESS_VIEW_KEY = 'lively_term_view_v2';
const TSESS_MINE_KEY = 'lively_term_mine_only_v2';
function tsessFilter() {
    const states = (v) => (Array.isArray(v) ? v : []).filter((k) => TSESS_STATE_OPTS.some((o) => o.key === k));
    const scopes = (v) => (Array.isArray(v) ? v : []).filter((k) => TSESS_SCOPE_OPTS.some((o) => o.key === k));
    const period = (v) => tsessPeriodOf(v);
    try {
        const raw = localStorage.getItem(TSESS_FILTER_KEY);
        if (raw) {
            const f = JSON.parse(raw) || {};
            return { state: states(f.state), scope: scopes(f.scope), period: period(f.period) };
        }
        const f = { state: [], scope: [], period: { ...TSESS_PERIOD_ALL } };
        const v4raw = localStorage.getItem(TSESS_FILTER_V4_KEY);
        const v3raw = localStorage.getItem(TSESS_FILTER_V3_KEY);
        if (v4raw) {
            // v4 → v5. 소속만 문자열→배열. 구 'all' 은 **빈 배열**이 된다(전체 = 아무것도 안 고른 상태).
            const v4 = JSON.parse(v4raw) || {};
            f.state = states(v4.state);
            f.period = period(v4.period);
            f.scope = scopes([v4.scope]);
        }
        else if (v3raw) {
            // v3 → v5. 출처 4버킷 중 **소속 성분만** 살린다(소유 성분은 필터가 아니라 섹션이 됐다 — #1229).
            const v3 = JSON.parse(v3raw) || {};
            f.state = states(v3.state);
            f.period = period(v3.period);
            const src = Array.isArray(v3.src) ? v3.src : [];
            const nProj = src.filter((k) => k === 'myproj' || k === 'otherproj').length;
            const nNon = src.filter((k) => k === 'private' || k === 'invited').length;
            // 고른 버킷이 한쪽에만 몰려 있을 때만 그 소속으로 옮긴다. 섞였으면 전체(빈 배열) — **넓히는 쪽으로**
            //  이관한다(좁게 옮겨 세션이 사라지면 '내 세션이 없어졌다'로 읽히고, 원인이 이관이라는 걸 알 길이 없다).
            if (nProj && !nNon)
                f.scope = ['proj'];
            else if (nNon && !nProj)
                f.scope = ['nonproj'];
        }
        else {
            // v2 → v5. '내 것만'(TSESS_MINE_KEY)은 옮길 곳이 없다 — 소유는 섹션이 됐고, 섹션은 거르지 않는다(키만 지운다).
            const view = localStorage.getItem(TSESS_VIEW_KEY) || 'all';
            if (view === 'waiting' || view === 'busy')
                f.state = [view];
            else if (view === 'ended')
                f.state = ['exited', 'restorable']; // 구 '끝남' = sessDead
            else if (view === 'today' || view === 'week' || view === 'stale')
                f.period = { ...TSESS_PERIOD_ALL, preset: view };
        }
        localStorage.removeItem(TSESS_FILTER_V4_KEY);
        localStorage.removeItem(TSESS_FILTER_V3_KEY);
        localStorage.removeItem(TSESS_VIEW_KEY);
        localStorage.removeItem(TSESS_MINE_KEY);
        if (f.state.length || f.scope.length || !tsessPeriodIsAll(f.period))
            saveTsessFilter(f);
        return f;
    }
    catch {
        return { state: [], scope: [], period: { ...TSESS_PERIOD_ALL } };
    }
}
function saveTsessFilter(f) {
    try {
        if (!f.state.length && !f.scope.length && tsessPeriodIsAll(f.period))
            localStorage.removeItem(TSESS_FILTER_KEY);
        else
            localStorage.setItem(TSESS_FILTER_KEY, JSON.stringify(f));
    }
    catch { /* noop */ }
}
// #1098 축 드롭다운 — 접어 두는 필터 축(상태·소속=다중 · 기간=단일). 프로젝트 필터(아래)와 같은 껍데기·같은 CSS 를 쓴다.
//  ⚠ 다중 축은 항목을 골라도 **닫지 않는다**(연속으로 여러 개 체크해야 하므로). 대신 목록만 그 자리에서 다시 그린다.
// #1238 다중 축은 **체크박스 항목만** 둔다 — '전체'는 항목이 아니라 선택이 빈 상태이므로 행을 세우지 않는다.
//  되돌리기는 헤더 「초기화」(선택이 있을 때만 노출). 단일 축(기간)은 종전 그대로 '전체 기간' 행을 쓴다 —
//  거기선 빈 선택이라는 상태가 없고(항상 한 칸이 골라져 있다) '전체'가 진짜 항목 중 하나다.
//  체크박스·초기화 마크업은 대시보드 필터 팝오버(.dash-pop-box/.dash-pop-clear)와 **CSS 한 벌을 공유**한다
//  (#1062 관례 — 두 화면이 다시 갈라지지 않게 새 클래스를 만들지 않는다).
function buildSessAxisFilter(opts) {
    const isMulti = opts.multi;
    const selSet = isMulti ? opts.sel : new Set([opts.sel]);
    const active = !!opts.btnLabel || (isMulti ? selSet.size > 0 : opts.sel !== 'all');
    const picked = opts.items.filter((i) => selSet.has(i.key));
    const btnText = opts.btnLabel ? opts.btnLabel
        : !active ? opts.title
            : picked.length === 1 ? picked[0].label
                : picked.length ? opts.title + ' ' + picked.length : opts.title;
    const wrap = el('div', { class: 'tsess-projfilter' });
    const btn = el('button', { type: 'button', class: 'tsess-projfilter-btn' + (active ? ' active' : ''), title: opts.title + '(으)로 필터' }, el('span', { text: btnText }), el('span', { class: 'tsess-projfilter-chev', text: '▾' }));
    const dd = el('div', { class: 'tsess-projfilter-dd', hidden: true });
    const listBox = el('div', { class: 'tsess-projfilter-list' });
    let docHandler = null;
    const close = () => { dd.hidden = true; if (docHandler) {
        document.removeEventListener('mousedown', docHandler);
        docHandler = null;
    } };
    //  단일 축 '전체' 행 카운트는 항목 합이 아니라 **풀 크기**를 받는다 — 기간처럼 버킷이 겹치는 축(오늘 ⊂ 최근 7일)에서
    //  합을 쓰면 세션 수보다 큰 숫자가 나온다.
    const total = opts.allCount;
    const renderList = () => {
        const row = (key, label, count, on, hint) => el('button', {
            class: 'tsess-projfilter-opt' + (on ? ' active' : '') + (count === 0 && !on ? ' zero' : ''), type: 'button', title: hint || label,
            // 다중=체크박스(aria-checked), 단일=한 칸만 서는 선택(aria-pressed) — 스크린리더가 둘을 다르게 읽어야 한다.
            ...(isMulti ? { role: 'menuitemcheckbox', 'aria-checked': String(on) } : { 'aria-pressed': String(on) }),
            onmousedown: (e) => {
                e.preventDefault();
                if (!isMulti) {
                    close();
                    opts.onChange(key);
                    return;
                }
                if (selSet.has(key))
                    selSet.delete(key);
                else
                    selSet.add(key);
                opts.onChange(new Set(selSet)); // 목록·카운트는 호출부가 다시 그린다(닫지 않는다)
            },
        }, ...(isMulti ? [el('span', { class: 'dash-pop-box', text: on ? '✓' : '' })] : []), el('span', { class: 'tsess-opt-name', text: label }), el('span', { class: 'tsess-opt-n', text: String(count) }));
        // 헤더 — 다중 축에서 선택이 있을 때만. 체크를 하나씩 끄지 않고 한 번에 전체로 되돌린다(상태는 8칸이라 필요).
        const head = isMulti && selSet.size
            ? [el('div', { class: 'tsess-projfilter-head' }, el('span', { class: 'tsess-projfilter-headn', text: '전체 ' + total + '개 중 ' + selSet.size + '칸 선택' }), el('button', {
                    class: 'dash-pop-clear', type: 'button', title: opts.title + ' 조건을 지우고 전체 보기',
                    onmousedown: (e) => { e.preventDefault(); selSet.clear(); opts.onChange(new Set()); },
                }, '초기화'))]
            : [];
        listBox.replaceChildren(...head, 
        // 단일 축만 '전체' 행을 둔다. 다중 축은 아무것도 안 고른 상태가 곧 전체다(#1238).
        ...(isMulti ? [] : [row('all', opts.allLabel || '전체', total, opts.sel === 'all')]), ...opts.items.map((i) => row(i.key, i.label, i.count, selSet.has(i.key), i.hint)));
    };
    // 열 때 화면 경계로 위치를 보정한다. CSS 기본은 `right: 0`(앵커 우측 정렬 → 왼쪽으로 230px 뻗음)인데, 이 축
    //  필터가 필터바 **왼쪽**에 놓이면서 팝오버가 창 밖으로 나가 안 보였다(상민님 실측 — 창을 아주 크게 해야 보임).
    //  한쪽으로 고정하면 반대쪽 끝에서 같은 문제가 난다(왼쪽 정렬은 오른쪽 끝에서 삐진다) → **재서 넘치면 뒤집고,
    //  그래도 넘치면 화면 안으로 밀어넣는다.** 뒤집기만으로 끝내지 않는 이유: 창이 팝오버보다 좁을 수 있다.
    const placeIntoView = () => {
        const M = 8; // 화면 가장자리 여백
        // 아직 문서에 안 붙었으면 재봐야 전부 0 이다 — 다음 프레임(붙은 뒤)에 다시 잰다.
        if (!dd.isConnected) {
            requestAnimationFrame(() => { if (dd.isConnected && !dd.hidden)
                placeIntoView(); });
            return;
        }
        dd.style.left = '';
        dd.style.right = ''; // CSS 기본(right:0)으로 되돌린 뒤 측정
        let r = dd.getBoundingClientRect();
        if (r.left < M) { // 왼쪽으로 넘침 → 앵커 왼쪽 정렬로 뒤집기
            dd.style.right = 'auto';
            dd.style.left = '0px';
            r = dd.getBoundingClientRect();
        }
        const over = r.right - (window.innerWidth - M);
        if (over > 0) { // 그래도 오른쪽으로 넘침 → 그만큼 왼쪽으로 당긴다
            const cur = parseFloat(dd.style.left || '0') || 0;
            dd.style.right = 'auto';
            dd.style.left = `${cur - over}px`;
            if (dd.getBoundingClientRect().left < M)
                dd.style.left = `${cur - over + (M - dd.getBoundingClientRect().left)}px`;
        }
    };
    const open = () => {
        dd.hidden = false;
        renderList();
        placeIntoView();
        docHandler = (e) => { if (!wrap.contains(e.target))
            close(); };
        // ⚠ 바깥클릭 감지는 **다음 tick 에** 붙인다. 항목 선택(onmousedown) → 재렌더 → 새 드롭다운 open() 이
        //  같은 mousedown 이 아직 document 까지 올라오는 중에 일어나므로, 여기서 바로 붙이면 그 이벤트가 이 핸들러에
        //  잡혀 방금 연 드롭다운이 곧바로 닫힌다(다중 선택이 한 번에 하나만 되던 원인).
        setTimeout(() => { if (!dd.hidden && docHandler)
            document.addEventListener('mousedown', docHandler); }, 0);
    };
    btn.addEventListener('click', () => (dd.hidden ? open() : close()));
    if (opts.header)
        dd.append(opts.header);
    dd.append(listBox);
    if (opts.footer)
        dd.append(opts.footer);
    wrap.append(btn, dd);
    return { wrap, open, isOpen: () => !dd.hidden };
}
// ── 위층(select-bar·session-list·routes)이 쓰는 것만 재수출 — 나머지는 이 파일 안에서 닫힌다. ──
export { TSESS_STATUS, tsessConfirmEnd, sessDead, sessState, relAgo, shortDir, sessAgeDays, sessSinceMidnight, TSESS_STATE_OPTS, TSESS_SCOPE_OPTS, tsessScopeOf, TSESS_SECTIONS, tsessCollapsed, saveTsessCollapsed, TSESS_PERIOD_OPTS, tsessPeriodMatch, ymdShort, tsessFilter, saveTsessFilter, buildSessAxisFilter, };
