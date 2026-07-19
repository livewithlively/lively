// start.ts — 구성원 온보딩 (#846 / 태스크 850, UI 전면개편 #870 → 순차 완료 여정 #req)
//  "온보딩은 여기서 시작해서 여기서 끝난다" — 유일한 **진입·완주 표면**.
//
//  ⚠ 화면은 SoT 가 아니다. 상태의 SoT 는 서버 `computeMemberOnboarding`(src/org/onboarding.ts) 한 함수이고
//   이 화면과 AI 온보딩 스킬이 **같은 REST(/api/ui/me/onboarding)** 를 읽는다 → 둘이 어긋나지 않는다.
//   (화면이 상태를 계산하기 시작하면 AI 가 "3/4 하셨네요" 할 때 화면은 2/4 를 보여주는 일이 생긴다.)
//
//  ⚠ 이 페이지는 **값을 편집하지 않는다.** 케이스별로 관리탭·프로젝트로 보내는 **딥링크 런처**다
//   (편집 UI 를 두면 관리탭과 두 개의 진실이 생긴다).
//
//  UI(#req): 처음 로그인한 사람이 **위→아래 한 단계씩 순서대로** 완주하는 여정. 스텝을 순서(connect→migrate
//   →credentials→repos)로 세우고, 지나온 건 체크(✓)로 접고, 첫 미완만 '지금 이 단계'로 크게 편다. 다음 스텝은 흐리게
//   '다음 차례'. 디자인은 #/learn 문서 사이트와 같은 언어(docsShell·docs-title·카드·토큰) — 인라인 색·하드코딩 금지.
import { api, el, toast } from './core.js';
import { docsEyebrow, docsShell, openInstallModal } from './learn.js'; // 사용 가이드 셸 + 설치 팝업 — '직접 해보기 › 시작하기'가 이 페이지의 입구다
import { isSectionDone, startGuideTour } from './guide-tour.js'; // '프로젝트 체험' — #/learn/tour 와 같은 'projects' 둘러보기 코스 시작·완료표시
// 시작 모드(웹/로컬) — 이 사람이 어디서 AI를 쓸지. 기기별 localStorage(기본 web=추천).
//  웹이면 로컬 전용 스텝('예전 환경 가져오기'=migrate)은 여정에서 뺀다(웹 세션은 내 컴퓨터 파일을 못 읽어 이관 불가).
const OB_MODE_KEY = 'ob_start_mode';
function obMode() { try {
    return localStorage.getItem(OB_MODE_KEY) === 'local' ? 'local' : 'web';
}
catch {
    return 'web';
} }
function setObMode(m, view) { try {
    localStorage.setItem(OB_MODE_KEY, m);
}
catch { /* 저장 실패 무시 */ } renderStart(view); }
// 여정 맨 위 '어디서 AI를 쓰실 건가요' 선택 — 고르면 아래 여정이 그 모드로 바뀐다(웹=3스텝·로컬=4스텝). connect 스텝의
//  '지금 하기'도 이 선택을 따라 바로 동작하므로(웹=홈 따라하기·로컬=설치 팝업), 예전의 스텝별 웹/로컬 팝업은 없앴다.
function modeChoice(view) {
    const mode = obMode();
    const card = (m, title, sub, tag, tagCls) => {
        const c = el('button', { class: 'ob-choice-card' + (mode === m ? ' sel' : ''), type: 'button', 'aria-pressed': String(mode === m) }, el('div', { class: 'ob-choice-top' }, el('span', { class: 'ob-choice-title', text: title }), el('span', { class: 'ob-choice-badge ' + tagCls, text: tag })), el('p', { class: 'ob-choice-desc', text: sub }));
        c.onclick = () => setObMode(m, view);
        return c;
    };
    return el('div', { class: 'card docs-card ob-choice' }, el('div', { class: 'ob-choice-head' }, el('b', { text: '어디서 AI를 쓰실 건가요?' })), el('p', { class: 'ob-choice-lead', text: '어느 쪽을 골라도 같은 AI에 같은 회사 맥락이 들어갑니다. 고민되면 설치 없이 바로 쓰는 왼쪽으로 시작하세요.' }), el('div', { class: 'ob-choice-grid' }, card('web', '라이블리 웹에서 바로', '설치 없이 웹 브라우저에서', '추천', 'rec'), card('local', '내 컴퓨터에서', '내 로컬 AI에 설치', '개발자', 'dev')));
}
async function mark(step, state, view) {
    await api('/api/ui/me/onboarding', { method: 'POST', body: JSON.stringify({ step, state, by: 'self' }) });
    toast('완료로 표시했습니다');
    await renderStart(view); // 서버가 돌려준 최신 상태로 다시 그린다(화면이 상태를 들고 있지 않다)
}
// ⋯ escape hatch — AI 보고·자동 판정이 주(主). "이미 했으니 완료로 표시"만 남긴다(수동 확인용).
//  완료된 스텝은 되돌리지 않는다: 되돌리면 진행도가 후퇴(2/4→1/4)해 "뒤 단계가 안 한 게 됨"처럼 보여 혼란.
//  '다시 보기'는 줄을 눌러 펼치는(비파괴) 것으로 충분하다 → done 스텝엔 ⋯ 를 아예 두지 않는다.
function stepMore(it, view) {
    if (it.state === 'done')
        return null;
    return el('details', { class: 'ob-more' }, el('summary', { 'aria-label': '이 항목 상태 바꾸기', text: '⋯' }), el('div', { class: 'card ob-more-pop' }, el('button', { class: 'btn btn-ghost btn-sm', text: '완료로 표시', onclick: () => mark(it.key, 'done', view) })));
}
// connect 는 선택한 모드(웹/로컬)대로 바로 동작 — 웹=홈 따라하기, 로컬=설치 팝업. 나머지 스텝은 딥링크(it.href).
function primaryActBtn(it, _view, label) {
    if (it.key === 'connect') {
        return el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: label,
            onclick: () => { if (obMode() === 'local')
                openInstallModal();
            else
                location.hash = '#/dashboard?tour=1&from=onboarding'; } });
    }
    const href = stepHref(it);
    return href ? el('a', { class: 'btn btn-primary btn-sm', href, text: label }) : null;
}
// connect 스텝 설명은 고른 모드에 맞춘다 — 웹=바로 열기 / 로컬=설치. 라벨('AI 설치하기')은 서버 SoT 그대로 두고 설명만 화면에서 바꾼다(#req).
function stepHow(it) {
    if (it.key === 'connect') {
        return obMode() === 'web'
            ? '라이블리 웹에서 [내 AI 세션]을 바로 엽니다.'
            : '내 컴퓨터의 AI(Claude Code·Codex)에 라이블리를 설치해서 사용합니다.';
    }
    return it.how;
}
// 외부 서비스 연결(credentials)의 '지금 하기'는 '내 서비스 로그인'(#/system/me-logins)으로 — 멤버 개인 자격을 연결하는 정확한 화면.
//  href 는 웹UI 내비 용도(AI 판단엔 안 씀)라 서버 SoT 대신 화면에서 바꾼다(#req).
function stepHref(it) {
    if (it.key === 'credentials')
        return '#/system/me-logins';
    return it.href;
}
// 조직 축(관리자가 채우는 5단계) 배너 — 구성원 온보딩을 다 해도 **회사 맥락이 비어 있으면** AI 는
//  baseline 안내만 한다. ②③만 하고 ①을 잊는 실수를 화면에서도 막는다.
async function orgBanner() {
    try {
        const s = await api('/api/ui/org/onboarding');
        if (!s || s.complete)
            return null; // 조직이 다 됐으면 조용히 사라진다
        return el('a', { href: '#/onboarding', class: 'ob-banner amber' }, el('div', { class: 'ob-banner-row' }, el('span', { class: 'ob-banner-title' }, el('b', { text: `회사 설정 ${s.done}/${s.total}` }), ' — 아직 채우는 중입니다'), el('span', { class: 'ob-banner-go', text: '보기 →' })), el('p', { class: 'ob-banner-sub', text: '이게 다 채워져야 AI 가 우리 회사 맥락(도메인·지식·규칙)을 알고 대답합니다. 관리자가 하는 일이라 기다리셔도 되고, 관리자면 눌러서 이어가세요.' }));
    }
    catch {
        return null;
    }
}
// #853 완료·다음 차례 스텝도 클릭하면 설명·[해보기]를 펼친다(기본 접힘). is-active(지금 단계)는 이미 펼친 카드라 제외.
//  headEls = 접힌 줄에 보이는 것(이름·태그·⋯). 펼치면 그 아래 설명·노트·행동 버튼(actionText)이 나온다.
function collapsibleBody(it, view, headEls, actsEl) {
    const hasActs = !!(actsEl && actsEl.childElementCount);
    const canExpand = !!(stepHow(it) || it.note || hasActs);
    const caret = canExpand ? el('span', { class: 'ob-quest-caret', 'aria-hidden': 'true', text: '▾' }) : null;
    const head = el('div', { class: 'ob-quest-collapse-head' + (canExpand ? ' expandable' : '') }, ...headEls, caret);
    if (!canExpand)
        return el('div', { class: 'ob-quest-body' }, head);
    const detail = el('div', { class: 'ob-quest-detail', hidden: true }, stepHow(it) ? el('p', { class: 'ob-quest-desc', text: stepHow(it) }) : null, it.note ? el('p', { class: 'ob-quest-note', text: it.note }) : null, hasActs ? actsEl : null);
    const wrap = el('div', { class: 'ob-quest-body' }, head, detail);
    head.addEventListener('click', (e) => {
        if (e.target.closest('.ob-more, a, button'))
            return; // ⋯ 메뉴·링크·버튼 클릭은 펼침 토글 아님
        const open = detail.hidden;
        detail.hidden = !open;
        wrap.classList.toggle('open', open);
        head.setAttribute('aria-expanded', String(open));
    });
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('aria-expanded', 'false');
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        head.click();
    } });
    return wrap;
}
// 여정의 한 스텝(레일 노드 + 본문). 상태별로 다른 얼굴:
//  done/skipped = 완료(✓/—)로 접힌 줄(클릭 펼침) · active = 지금 단계 풀카드(설명+액션) · upcoming = 흐린 '다음 차례'(클릭 펼침).
//  접힌 줄(upcoming/done/skipped)은 펼치면 active 카드와 같은 활성 느낌으로 보인다(CSS .ob-quest-body.open).
function questRow(it, idx, isActive, isLast, view) {
    const stateCls = it.state === 'done' ? 'is-done' : isActive ? 'is-active' : 'is-upcoming';
    const glyph = it.state === 'done' ? '✓' : String(idx + 1);
    const rail = el('div', { class: 'ob-quest-rail', 'aria-hidden': 'true' }, el('div', { class: 'ob-quest-node' }, el('span', { text: glyph })), isLast ? null : el('div', { class: 'ob-quest-line' }));
    let body;
    if (stateCls === 'is-active') {
        const acts = el('div', { class: 'ob-quest-act' }, primaryActBtn(it, view, '지금 하기 →'));
        body = el('div', { class: 'ob-quest-body' }, el('div', { class: 'ob-quest-title' }, el('span', { class: 'ob-quest-name', text: it.label }), it.required ? el('span', { class: 'ob-quest-badge req', text: '필수' }) : null, stepMore(it, view)), el('p', { class: 'ob-quest-desc', text: stepHow(it) }), it.note ? el('p', { class: 'ob-quest-note', text: it.note }) : null, (acts.childElementCount ? acts : null));
    }
    else if (stateCls === 'is-upcoming') {
        // 다음 차례 — 아직 안 한 단계. 기본은 접혀 있지만, 클릭해 펼치면 지금 단계와 **같은 카드 느낌·같은 가이드(it.how)+액션**을
        //  받는다. 꼭 순서대로 하지 않아도 뒤 단계를 먼저 열어 바로 진행할 수 있게 액션은 '지금 하기 →'(미리보기 아님).
        const acts = el('div', { class: 'ob-quest-act' }, primaryActBtn(it, view, '지금 하기 →'));
        body = collapsibleBody(it, view, [
            el('span', { class: 'ob-quest-name', text: it.label }),
            it.required ? el('span', { class: 'ob-quest-badge req', text: '필수' }) : null,
            el('span', { class: 'ob-quest-next', text: '다음 차례' }),
        ], acts);
    }
    else { // done — 완료. 클릭하면 설명·'다시 보기'를 펼친다(비파괴, #853).
        //  ('미룸/나중에 하기'는 폐지 — skipped 상태는 위 is-active/is-upcoming 으로 흘러 '지금 하기'로 이어서 하면 된다. #req)
        const by = it.by === 'ai' ? 'AI가 완료' : it.by === 'auto' ? '확인됨' : '완료';
        const dhref = stepHref(it);
        const acts = dhref ? el('div', { class: 'ob-quest-act' }, el('a', { class: 'btn btn-ghost btn-sm', href: dhref, text: '다시 보기 →' })) : null;
        body = collapsibleBody(it, view, [
            el('span', { class: 'ob-quest-name', text: it.label }),
            el('span', { class: 'ob-quest-tag', text: by }),
            it.by !== 'auto' ? stepMore(it, view) : null,
        ], acts);
    }
    return el('div', { class: 'ob-quest ' + stateCls }, rail, body);
}
// 여정 카드 — 헤더(N/총 완료, 진행바) + 스텝 레일. 모두 마치면 완료 배너를 위에 얹는다.
function journeyCard(items, activeIdx, view, complete) {
    const total = items.length;
    const cleared = items.filter((it) => it.state === 'done').length;
    const pct = total ? Math.round((cleared / total) * 100) : 0;
    const allClear = activeIdx === -1;
    const header = el('div', { class: 'ob-journey-head' }, el('span', { class: 'ob-journey-count' }, el('b', { text: String(cleared) }), ' / ' + total + ' 완료'), el('span', { class: 'ob-journey-note' + (complete ? ' ok' : ''),
        text: complete ? '✓ 필수 완료 — 이제 써도 돼요' : '필수 1개만 마치면 시작할 수 있어요' }));
    const bar = el('div', { class: 'ob-journey-bar' }, el('div', { class: 'ob-journey-bar-fill', style: `width:${pct}%` }));
    const celebrate = allClear
        ? el('div', { class: 'ob-done-all' }, el('div', { class: 'ob-done-all-stamp', 'aria-hidden': 'true', text: '✓' }), el('div', { class: 'ob-done-all-title', text: '준비 완료 — 이제 시작하세요' }), el('p', { class: 'ob-done-all-sub' }, el('a', { href: '#/dashboard', text: '내 AI 세션' }), ' 에서 한국어로 시키면 됩니다. 회사 맥락을 알고 답합니다.'))
        : null;
    const steps = el('div', { class: 'ob-journey-steps' }, ...items.map((it, i) => questRow(it, i, i === activeIdx, i === total - 1, view)));
    return el('div', { class: 'card docs-card ob-journey' }, header, bar, celebrate, steps);
}
export async function renderStart(view) {
    // #/learn 과 같은 머리 — 아이브로(직접 해보기) + docs-title 히어로 + 리드 한 줄.
    const head = [
        docsEyebrow('start'),
        el('h1', { class: 'docs-title', text: 'AI 세션 체험' }),
        el('p', { class: 'docs-lead' }, '먼저 어디서 쓸지 고른 뒤, 아래 단계를 ', el('b', { text: '위에서부터 차례대로' }), ' 마치면 됩니다.'),
    ];
    const slot = el('div', { class: 'guide-cards' });
    docsShell(view, 'start', ...head, slot); // 사이드바 유지 — 여기가 '직접 해보기'의 첫 항목
    let d;
    try {
        d = await api('/api/ui/me/onboarding');
    }
    catch (e) {
        slot.replaceChildren(el('p', { class: 'admin-hint', text: '현황을 불러오지 못했습니다 — ' + e.message }));
        return;
    }
    const s = d.status;
    // 웹 모드는 로컬 전용 스텝('예전 환경 가져오기'=migrate)을 뺀다 — 웹 세션은 내 컴퓨터 파일을 못 읽어 이관이 불가하니까.
    const items = (obMode() === 'web' ? s.items.filter((it) => it.key !== 'migrate') : s.items);
    const activeIdx = items.findIndex((it) => it.state !== 'done'); // 첫 미완(미룬 것 포함) = '지금 이 단계'
    // 선택박스(웹/로컬)를 맨 위에, 그 아래 모드에 맞춘 여정. null 은 배열에서 걸러 낸다.
    const cards = [
        modeChoice(view),
        journeyCard(items, activeIdx, view, s.complete),
        await orgBanner(),
    ].filter(Boolean);
    slot.replaceChildren(...cards);
}
// #/start/migrate — "예전 환경 가져오기" 스텝의 안내. **여기서 이관을 하지 않는다**(로컬 파일은 웹이 못 만진다).
//  AI 에게 시키는 법만 알려주고, 실제 작업·완료 보고는 lively-onboarding 스킬이 한다.
export async function renderStartMigrate(view) {
    const head = [
        docsEyebrow('start'),
        el('h1', { class: 'docs-title', text: '예전에 쓰던 AI 환경 가져오기' }),
        el('p', { class: 'docs-lead', text: '가져오기는 내 컴퓨터의 AI 가 진행합니다 — 웹은 내 컴퓨터의 파일을 읽을 수 없어서, 이 화면에서는 방법만 안내해요.' }),
    ];
    docsShell(view, 'start', ...head, el('div', { class: 'guide-cards' }, 
    // 전제 콜아웃 — 이 도우미는 라이블리가 내 컴퓨터에 설치돼 있어야 뜬다('온보딩 도와줘'는 라이블리 스킬).
    el('div', { class: 'ob-banner amber' }, el('div', { class: 'ob-banner-row' }, el('span', { class: 'ob-banner-title' }, el('b', { text: '먼저, 내 컴퓨터에 라이블리가 설치돼 있어야 해요.' })), el('a', { class: 'ob-banner-go', href: '#/start/setup', text: '설치하기 →' })), el('p', { class: 'ob-banner-sub' }, '‘온보딩 도와줘’ 는 라이블리를 설치할 때 내 컴퓨터의 AI(Claude Code·Codex)에 함께 추가되는 기능이에요. 그래서 ', el('a', { href: '#/start/setup', text: '내 컴퓨터에 설치' }), '를 먼저 마쳐야 이 명령이 동작합니다. 아직이라면 설치부터 하세요.')), el('div', { class: 'card docs-card' }, el('div', { class: 'card-head' }, el('h2', { text: '설치했다면 — 내 컴퓨터에서 AI 를 켜고, 이렇게 말해보세요' })), el('div', { class: 'md-prompt' }, el('p', { class: 'md-p', text: '온보딩 도와줘' })), el('p', { class: 'admin-hint', style: 'margin:12px 0 0', text: 'AI 가 예전 작업 메모·직접 만든 스킬·연결해 둔 서비스·쓰던 코드 저장소를 읽어서 목록으로 보여주고, 무엇을 회사 위키로 올리고 무엇을 그대로 둘지 하나씩 같이 정합니다. 원본은 수정하거나 삭제하지 않습니다 — 위키로 올릴 때도 복사만 합니다. 다 끝나면 이 화면에도 자동으로 완료 표시가 됩니다.' })), el('div', { class: 'card docs-card' }, el('div', { class: 'card-head' }, el('h2', { text: '“예전 작업 메모가 사라졌어요”' })), el('p', { class: 'guide-lead', style: 'margin:0', text: '사라지지 않았습니다. AI 의 작업 메모는 폴더마다 따로 저장돼서, 다른 폴더에서 켜면 안 보일 뿐입니다. ‘온보딩 도와줘’ 를 실행하면 다른 폴더에 저장된 작업 메모까지 찾아서 보여줍니다.' })), el('div', { class: 'card docs-card' }, el('div', { class: 'card-head' }, el('h2', { text: '웹에서 AI 세션을 쓰고 계신가요?' })), el('p', { class: 'guide-lead', style: 'margin:0 0 12px' }, el('a', { href: '#/dashboard', text: '내 AI 세션' }), '에서 연 세션은 회사 서버에서 실행됩니다 — 그래서 내 노트북에 있던 예전 환경을 읽을 수 없습니다. 가져오시려면 내 컴퓨터에 라이블리를 설치한 뒤, 거기서 ‘온보딩 도와줘’ 라고 입력하세요. 가져올 게 없다면 이 항목은 건너뛰셔도 됩니다.'), el('a', { class: 'btn btn-primary btn-sm', href: '#/start/setup', text: '내 컴퓨터에 설치하기 →' }))));
}
// #/start/project — '프로젝트 체험': 프로젝트 화면을 예시 프로젝트에서 한 바퀴 둘러보는 랜딩.
//  진행 자체는 guide-tour.ts 의 'projects' 코스(projects-board → projects-detail)가 안내한다 —
//  #/learn/tour 의 프로젝트 둘러보기와 **완전히 같은 투어**다(요청: 두 곳을 동일하게). 별도 투어를 두지 않는다.
export async function renderStartProject(view) {
    // UI 는 'AI 세션 체험'(renderStart)과 같은 여정 레일(ob-journey/ob-quest) 로 통일한다.
    //  스텝은 정적으로 보여주고(번호 노드 → 둘러보면 ✓), 실행은 startGuideTour(['projects']) 하나만 띄운다.
    const did = isSectionDone('projects');
    const head = [
        docsEyebrow('start-project'),
        el('h1', { class: 'docs-title', text: '프로젝트 체험' }),
        el('p', { class: 'docs-lead', text: '프로젝트 화면이 어떤 부분들로 이뤄져 있고 각각 무엇에 쓰는지, 예시 프로젝트에서 한 바퀴 둘러봅니다.' }),
    ];
    const STEPS = [
        ['프로젝트 목록', '폴더·리스트로 묶어 보는 보드입니다(쓰던 클릭업과 비슷). 여기서 예시 프로젝트를 하나 엽니다.'],
        ['선행·후속 프로젝트', '이 일의 앞뒤에 오는 프로젝트를 이어 두는 곳입니다. 일의 순서가 드러나고, AI 도 그 앞뒤를 아는 채로 시작합니다.'],
        ['개요와 연결된 지식', '프로젝트의 배경을 적는 본문과, 이 일에 필요한 회사 지식(WIKI)을 미리 붙여 두는 곳입니다. 연결한 지식은 AI 세션에 자동으로 전달됩니다.'],
        ['태스크와 공유 폴더', '프로젝트를 할 일로 나누는 태스크와, 팀이 함께 쓰는 파일을 두는 공유 폴더를 봅니다.'],
        ['AI 세션 열기', '이 프로젝트의 맥락(본문·연결된 지식)을 이미 아는 AI 작업 세션을 여는 과정을 봅니다.'],
    ];
    const total = STEPS.length;
    const questRowStatic = (i, title, desc) => {
        const stateCls = did ? 'is-done' : 'is-step'; // 둘러보면 5단계 모두 ✓(민트), 아니면 번호 노드
        const rail = el('div', { class: 'ob-quest-rail', 'aria-hidden': 'true' }, el('div', { class: 'ob-quest-node' }, el('span', { text: did ? '✓' : String(i + 1) })), i === total - 1 ? null : el('div', { class: 'ob-quest-line' }));
        const body = el('div', { class: 'ob-quest-body' }, el('div', { class: 'ob-quest-title' }, el('span', { class: 'ob-quest-name', text: title })), el('p', { class: 'ob-quest-desc', text: desc }));
        return el('div', { class: 'ob-quest ' + stateCls }, rail, body);
    };
    const header = el('div', { class: 'ob-journey-head' }, el('span', { class: 'ob-journey-count' }, el('b', { text: String(total) }), ' 단계 · 약 2분'), el('span', { class: 'ob-journey-note' + (did ? ' ok' : ''), text: did ? '✓ 둘러봤어요' : '예시 프로젝트로 한 바퀴' }));
    const lead = el('p', { class: 'ob-journey-lead', text: '실제 화면 위에서 지금 볼 곳을 표시하며 [다음]으로 한 단계씩 넘어갑니다. 예시 프로젝트라 실제로 만들거나 바꾸는 것은 없습니다 — 안심하고 둘러보세요. 언제든 ✕ 나 ESC 로 멈출 수 있습니다.' });
    const steps = el('div', { class: 'ob-journey-steps' }, ...STEPS.map(([t, d], i) => questRowStatic(i, t, d)));
    const cta = el('div', { class: 'step-cta step-cta-center' }, el('button', { class: 'btn btn-primary btn-lg', text: did ? '▶ 다시 둘러보기' : '▶ 둘러보기 시작', onclick: () => startGuideTour(['projects']) }), el('span', { class: 'step-cta-hint', text: '약 2분 · 언제든 ESC 로 중단' }));
    docsShell(view, 'start-project', ...head, el('div', { class: 'guide-cards' }, el('div', { class: 'card docs-card ob-journey' }, header, lead, steps, cta)));
}
