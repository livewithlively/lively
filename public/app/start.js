// start.ts — 구성원 온보딩 (#846 / 태스크 850, UI 전면개편 #870)
//  "온보딩은 여기서 시작해서 여기서 끝난다" — 유일한 **진입·완주 표면**.
//
//  ⚠ 화면은 SoT 가 아니다. 상태의 SoT 는 서버 `computeMemberOnboarding`(src/org/onboarding.ts) 한 함수이고
//   이 화면과 AI 온보딩 스킬이 **같은 REST(/api/ui/me/onboarding)** 를 읽는다 → 둘이 어긋나지 않는다.
//   (화면이 상태를 계산하기 시작하면 AI 가 "3/4 하셨네요" 할 때 화면은 2/4 를 보여주는 일이 생긴다.)
//
//  ⚠ 이 페이지는 **값을 편집하지 않는다.** 케이스별로 관리탭·프로젝트로 보내는 **딥링크 런처**다
//   (편집 UI 를 두면 관리탭과 두 개의 진실이 생긴다).
//
//  UI(#870): #/learn 문서 사이트와 같은 디자인 언어 — docsShell 사이드바 + docs-title 히어로 + 카드 클래스
//   (.ob-*, .docs-*). 인라인 스타일·하드코딩 색 금지(그게 #/learn 과 이질감의 원인이었다). null 은 렌더 배열에서 걸러낸다.
import { api, el, toast } from './core.js';
import { docsEyebrow, docsShell } from './learn.js'; // 사용 가이드 사이드바 셸 — '직접 해보기 › 시작하기'가 이 페이지의 입구다
const ICON = { done: '✓', skipped: '—', todo: '○' };
async function mark(step, state, view) {
    await api('/api/ui/me/onboarding', { method: 'POST', body: JSON.stringify({ step, state, by: 'self' }) });
    toast(state === 'reset' ? '다시 열었습니다' : state === 'skipped' ? '해당 없음으로 표시했습니다' : '완료로 표시했습니다');
    await renderStart(view); // 서버가 돌려준 최신 상태로 다시 그린다(화면이 상태를 들고 있지 않다)
}
// 진행률 요약 — #/learn 카드 언어(.ob-progress-*, .ob-bar). 하드코딩 색·인라인 스타일 제거.
function progressCard(s) {
    return el('div', { class: 'card docs-card' }, el('div', { class: 'ob-progress-head' }, el('span', { class: 'ob-progress-count', text: `${s.done}/${s.total} 완료` }), el('span', { class: 'ob-progress-note', text: s.complete ? '필수 항목을 다 하셨어요' : '필수 항목만 마치면 시작할 수 있어요' })), el('div', { class: 'ob-bar' }, el('div', { class: 'ob-bar-fill', style: `width:${s.pct}%` })));
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
// ⋯ escape hatch — AI 보고·자동 판정이 주(主). "의도적으로 마킹하고 싶을 때"만.
function stepMore(it, view) {
    return el('details', { class: 'ob-more' }, el('summary', { 'aria-label': '이 항목 상태 바꾸기', text: '⋯' }), el('div', { class: 'card ob-more-pop' }, it.state !== 'done' ? el('button', { class: 'btn btn-ghost btn-sm', text: '완료로 표시', onclick: () => mark(it.key, 'done', view) }) : null, it.state !== 'skipped' && !it.required ? el('button', { class: 'btn btn-ghost btn-sm', text: '해당 없음', onclick: () => mark(it.key, 'skipped', view) }) : null, it.state !== 'todo' ? el('button', { class: 'btn btn-ghost btn-sm', text: '다시 열기', onclick: () => mark(it.key, 'reset', view) }) : null));
}
// 미완 = 크고 뚜렷한 '할 일' 카드 — 설명 + [해보기]. 필수는 .req 로 한 단계 더 강조.
//  (완료/미완이 같은 크기 카드라 '점 색만' 다르던 게 안 읽힌 원인 → 미완만 풀카드로, 완료는 얇은 줄로 분리.)
function todoCard(it, view) {
    const cls = 'card ob-step todo' + (it.required ? ' req' : '');
    return el('div', { class: cls }, el('div', { class: 'ob-step-top' }, el('div', { class: 'ob-step-head' }, el('span', { class: 'ob-step-dot' }), // 속 빈/채운 파란 링 — CSS
    el('span', { class: 'ob-step-label', text: it.label }), it.required ? el('span', { class: 'ob-step-badge req', text: '필수' }) : null), stepMore(it, view)), el('p', { class: 'ob-step-desc', text: it.how }), it.note ? el('p', { class: 'ob-step-note', text: it.note }) : null, it.href
        ? el('div', { class: 'ob-step-act' }, el('a', { class: 'btn btn-primary btn-sm', href: it.href, text: '해보기 →' }))
        : null);
}
// 완료(또는 해당없음) = 접힌 얇은 줄 — 체크 + 라벨 + 상태 pill + ⋯. 설명·버튼 없음(끝난 일이라 조용히).
function doneRow(it, view) {
    const skipped = it.state === 'skipped';
    const by = it.by === 'ai' ? 'AI가 완료' : it.by === 'auto' ? '확인됨' : '완료';
    return el('div', { class: 'ob-done-row' + (skipped ? ' skipped' : '') }, el('span', { class: 'ob-done-check', text: skipped ? '—' : '✓' }), el('span', { class: 'ob-done-label', text: it.label }), el('span', { class: 'ob-done-tag', text: skipped ? '해당 없음' : by }), stepMore(it, view));
}
export async function renderStart(view) {
    // #/learn 과 같은 머리 — 아이브로(직접 해보기) + docs-title 히어로 + 리드 한 줄.
    const head = [
        docsEyebrow('start'),
        el('h1', { class: 'docs-title', text: '시작하기' }),
        el('p', { class: 'docs-lead' }, '라이블리를 쓸 준비가 얼마나 됐는지 한눈에 봅니다. AI 도 같은 현황을 읽으니, ', el('a', { href: '#/dashboard', text: '내 AI 세션' }), ' 에서 AI 에게 ', el('b', { text: '“온보딩 도와줘”' }), ' 라고 하면 이어서 도와줍니다.'),
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
    // 상태로 가른다 — 미완(할 일)은 위·풀카드, 완료(끝난 것)는 아래·얇은 줄. "무엇이 남았나"가 한눈에.
    const todo = s.items.filter((it) => it.state !== 'done' && it.state !== 'skipped');
    const done = s.items.filter((it) => it.state === 'done' || it.state === 'skipped');
    const doneBanner = s.complete
        ? el('div', { class: 'ob-banner green' }, el('div', { class: 'ob-banner-title', text: '준비 끝 — 이제 그냥 쓰시면 됩니다.' }), el('p', { class: 'ob-banner-sub' }, '아래 선택 항목은 필요할 때 하시면 됩니다. ', el('a', { href: '#/dashboard', text: '내 AI 세션' }), ' 에서 AI 에게 한국어로 물어보세요 — 회사 맥락을 알고 답합니다.'))
        : null;
    const todoSection = todo.length
        ? el('div', { class: 'ob-sec' }, el('div', { class: 'ob-sec-head' }, el('span', { class: 'ob-sec-title', text: '지금 할 일' }), el('span', { class: 'ob-sec-count', text: String(todo.length) })), ...todo.map((it) => todoCard(it, view)))
        : null;
    const doneSection = done.length
        ? el('div', { class: 'ob-sec' }, el('div', { class: 'ob-sec-head' }, el('span', { class: 'ob-sec-title done', text: '완료' }), el('span', { class: 'ob-sec-count', text: String(done.length) })), el('div', { class: 'ob-done-list' }, ...done.map((it) => doneRow(it, view))))
        : null;
    // null 은 배열에서 걸러 낸다(예전엔 그대로 렌더돼 화면에 'null' 이 찍혔다).
    const cards = [
        progressCard(s),
        await orgBanner(),
        doneBanner,
        todoSection,
        doneSection,
    ].filter(Boolean);
    slot.replaceChildren(...cards);
}
// #/start/harness — 로컬 하네스 ↔ 라이블리 하네스 한눈에 (#891 온보딩 C, 슬라이스 1: 읽기).
//  세션훅이 push 한 로컬 관측(me/harness)과 라이블리 배포(me_assets)를 나란히 + 중복 대조.
//  ⚠ 값을 편집하지 않는다(슬라이스 1은 조회만). 토글은 슬라이스 2.
function harnessRow(name, kindLabel, tag, sub) {
    return el('div', { class: 'ob-done-row' }, el('span', { class: 'ob-done-check', text: '•' }), el('span', { class: 'ob-done-label' }, el('b', { text: name }), sub ? el('span', { class: 'ob-step-desc', text: ' ' + sub }) : null), el('span', { class: 'ob-done-tag', text: kindLabel }), tag ? el('span', { class: 'ob-step-badge ' + tag.cls, text: tag.text }) : null);
}
export async function renderStartHarness(view) {
    const head = [
        docsEyebrow('start'),
        el('h1', { class: 'docs-title', text: '내 하네스 설정' }),
        el('p', { class: 'docs-lead', text: '라이블리가 배포하는 스킬·훅과, 내 컴퓨터에 깔린 로컬 하네스 자산을 한눈에 봅니다. 겹치는 건 조직이 함께 관리·개선하는 라이블리 쪽을 쓰시길 권합니다.' }),
    ];
    const slot = el('div', { class: 'guide-cards' });
    docsShell(view, 'harness', ...head, slot);
    let d;
    try {
        d = await api('/api/ui/me/harness');
    }
    catch (e) {
        slot.replaceChildren(el('p', { class: 'admin-hint', text: '불러오지 못했습니다 — ' + e.message }));
        return;
    }
    // 라이블리 배포 — 스킬 + 훅. effective=false 면 내가 끈 것.
    const livelyRows = [
        ...d.lively.skills.map((a) => harnessRow(a.label || a.id, a.kind === 'subagent' ? '서브에이전트' : a.kind === 'command' ? '커맨드' : '스킬', a.effective ? null : { text: '꺼짐', cls: 'off' }, a.description ? String(a.description).slice(0, 60) : '')),
        ...d.lively.hooks.map((h) => harnessRow(h.label || h.id, '훅', h.effective ? null : { text: '꺼짐', cls: 'off' })),
    ];
    const livelyCard = el('div', { class: 'ob-sec' }, el('div', { class: 'ob-sec-head' }, el('span', { class: 'ob-sec-title', text: '라이블리가 준 것' }), el('span', { class: 'ob-sec-count', text: String(livelyRows.length) })), el('p', { class: 'ob-step-desc', text: '조직이 관리하는 스킬·훅입니다. 모두에게 배포되고 함께 개선됩니다. (끄고 켜기는 곧 여기서 됩니다.)' }), el('div', { class: 'ob-done-list' }, ...(livelyRows.length ? livelyRows : [el('p', { class: 'admin-hint', text: '아직 없습니다.' })])));
    // 로컬 관측 — 세션훅이 아직 push 안 했으면 observed=false.
    const local = d.local;
    let localBody;
    if (!local.observed) {
        localBody = el('p', { class: 'admin-hint', text: '아직 내 컴퓨터의 하네스를 못 봤습니다. 내 컴퓨터에서 claude(또는 codex)를 한 번 켜면, 다음 세션에 자동으로 여기 나타납니다. (웹 [터미널] 세션은 회사 서버라 로컬이 안 보입니다.)' });
    }
    else {
        const rows = (local.assets || []).map((a) => {
            const kindLabel = a.kind === 'subagent' ? '서브에이전트' : a.kind === 'command' ? '커맨드' : a.kind === 'hook' ? '훅' : '스킬';
            const tag = a.overlap === 'managed' ? { text: '라이블리가 설치', cls: 'muted' }
                : a.overlap === 'shadow' ? { text: '라이블리 것을 가림', cls: 'warn' }
                    : { text: '내가 만든 것', cls: 'own' };
            return harnessRow(a.id, kindLabel, tag);
        });
        localBody = el('div', { class: 'ob-done-list' }, ...(rows.length ? rows : [el('p', { class: 'admin-hint', text: '내가 직접 만든 로컬 자산은 없습니다(라이블리가 준 것만 있어요).' })]));
    }
    const freshness = local.observed && local.at
        ? el('p', { class: 'admin-hint', text: `${local.host ? local.host + ' · ' : ''}마지막 확인 ${new Date(local.at).toLocaleString('ko-KR')}` })
        : null;
    const localCard = el('div', { class: 'ob-sec' }, el('div', { class: 'ob-sec-head' }, el('span', { class: 'ob-sec-title', text: '내 컴퓨터에 있는 것' }), local.observed ? el('span', { class: 'ob-sec-count', text: String((local.assets || []).length) }) : null), localBody, freshness);
    // shadow(가림)가 있으면 라이블리 채택 권고 배너.
    const shadowCount = local.observed ? (local.assets || []).filter((a) => a.overlap === 'shadow').length : 0;
    const shadowBanner = shadowCount
        ? el('div', { class: 'ob-banner amber' }, el('div', { class: 'ob-banner-title', text: `내 로컬 자산 ${shadowCount}개가 라이블리 것과 이름이 같아 라이블리 배포를 가리고 있어요.` }), el('p', { class: 'ob-banner-sub', text: '같은 이름이면 조직이 함께 관리·개선하는 라이블리 쪽을 쓰시길 권합니다. 내 것이 더 낫다면 AI 에게 "이 스킬 라이블리에 올리게 정리해줘" 라고 해서 관리자에게 전달하세요. (자동으로 바꾸지 않습니다 — 원하시면 그대로 두셔도 됩니다.)' }))
        : null;
    slot.replaceChildren(...[shadowBanner, livelyCard, localCard].filter(Boolean));
}
// #/start/migrate — "예전 환경 가져오기" 스텝의 안내. **여기서 이관을 하지 않는다**(로컬 파일은 웹이 못 만진다).
//  AI 에게 시키는 법만 알려주고, 실제 작업·완료 보고는 lively-onboarding 스킬이 한다.
export async function renderStartMigrate(view) {
    const head = [
        docsEyebrow('start'),
        el('h1', { class: 'docs-title', text: '예전에 쓰던 AI 환경 가져오기' }),
        el('p', { class: 'docs-lead', text: '이 일은 AI 가 합니다 — 웹에서는 할 수 없어요(내 컴퓨터의 파일을 웹이 읽을 수 없으니까요).' }),
    ];
    docsShell(view, 'start', ...head, el('div', { class: 'guide-cards' }, 
    // 전제 콜아웃 — 이 도우미는 라이블리가 내 컴퓨터에 설치돼 있어야 뜬다('온보딩 도와줘'는 라이블리 스킬).
    el('div', { class: 'ob-banner amber' }, el('div', { class: 'ob-banner-row' }, el('span', { class: 'ob-banner-title' }, el('b', { text: '먼저, 내 컴퓨터에 라이블리가 설치돼 있어야 해요.' })), el('a', { class: 'ob-banner-go', href: '#/start/setup', text: '설치하기 →' })), el('p', { class: 'ob-banner-sub' }, '‘온보딩 도와줘’ 는 라이블리가 내 컴퓨터의 AI(Claude Code·Codex)에 심어 두는 도우미예요. 그래서 ', el('a', { href: '#/start/setup', text: '내 컴퓨터에 설치' }), ' 를 먼저 마쳐야 아래 말이 통합니다. 아직이라면 설치부터 하세요.')), el('div', { class: 'card docs-card' }, el('div', { class: 'card-head' }, el('h2', { text: '설치했다면 — 내 컴퓨터에서 AI 를 켜고, 이렇게 말해보세요' })), el('div', { class: 'md-prompt' }, el('p', { class: 'md-p', text: '온보딩 도와줘' })), el('p', { class: 'admin-hint', style: 'margin:12px 0 0', text: 'AI 가 예전 작업 메모·직접 만든 스킬·연결해 둔 서비스·쓰던 코드 저장소를 읽기만 해서 보여주고, 무엇을 회사 위키로 올리고 무엇을 그대로 둘지 하나씩 같이 정합니다. 원본은 건드리지 않습니다(복사만 하고 지우지 않습니다). 다 끝나면 이 화면에도 자동으로 완료 표시가 됩니다.' })), el('div', { class: 'card docs-card' }, el('div', { class: 'card-head' }, el('h2', { text: '“예전 기억이 사라졌어요”' })), el('p', { class: 'guide-lead', style: 'margin:0', text: '사라지지 않았습니다. AI 의 작업 메모는 폴더마다 따로 저장돼서, 다른 폴더에서 켜면 안 보일 뿐입니다. 위 도우미가 다른 폴더에 있던 것까지 찾아서 보여줍니다.' })), el('div', { class: 'card docs-card' }, el('div', { class: 'card-head' }, el('h2', { text: '웹에서 AI 세션을 쓰고 계신가요?' })), el('p', { class: 'guide-lead', style: 'margin:0 0 12px' }, el('a', { href: '#/dashboard', text: '내 AI 세션' }), ' 으로 연 세션은 회사 서버에서 돌아갑니다 — 그래서 내 노트북에 있던 예전 환경을 볼 수 없습니다. 가져오시려면 내 컴퓨터에 설치한 뒤 거기서 도우미를 부르세요. 가져올 게 없다면 이 항목은 건너뛰셔도 됩니다.'), el('a', { class: 'btn btn-primary btn-sm', href: '#/start/setup', text: '내 컴퓨터에 설치하기 →' }))));
}
