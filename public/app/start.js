// start.ts — 구성원 온보딩 '시작하기'(#/start). #1000 전면 재설계.
//  옛 설계: 맨 위에서 '웹 vs 로컬'(modeChoice)을 택1하게 하고, 고른 모드의 여정(connect→…)만 보여줬다.
//   → 한 사람을 한 모드로 **가둔다**(웹으로 쓰면서 로컬 설치·외부 연결이 필요한 경우를 못 담는다).
//  새 설계(#1000): 이분법을 버리고 **모두 같은 출발점** + **필요한 설정만 골라서** 하는 3블록:
//   ① 지금 바로 시작(필수) — 설치 없이 웹에서 AI 세션 열기.
//   ② 내 상황에 맞는 설정(선택) — 로컬 설치·예전 환경 가져오기·외부 서비스 연결. 각 카드가 '이런 분께 / 안 해도
//      되는 경우'를 밝혀, 비개발자는 겁먹지 않되 자기에게 필요한 건 놓치지 않는다.
//   ③ 더 해보기 — 예시·프로젝트 체험·둘러보기.
//
//  ⚠ 화면은 SoT 가 아니다. 상태의 SoT 는 서버 computeMemberOnboarding(src/org/delivery/onboarding.ts) 한 함수이고
//   이 화면과 AI 온보딩 스킬이 **같은 REST(/api/ui/me/onboarding)** 를 읽는다 → 둘이 어긋나지 않는다.
//  ⚠ 이 페이지는 **값을 편집하지 않는다.** 케이스별로 관리탭·프로젝트로 보내는 딥링크 / 설치는 모달 런처다.
import { api, el, renderMarkdown } from './core.js';
import { DOC_PAGES } from './docs-content.js'; // 블록 ③ 인라인 — '이런 걸 시켜보세요'(examples) 원고 재사용
import { docsEyebrow, docsShell, openInstallModal } from './learn.js'; // 사용 가이드 셸 + 설치 팝업(모달)
import { isSectionDone, startGuideTour } from './guide-tour.js'; // '프로젝트 체험' — #/start/tour 와 같은 'projects' 코스
// 조직 축(관리자가 채우는 5단계) 배너 — 구성원 온보딩을 다 해도 **회사 맥락이 비어 있으면** AI 는
//  baseline 안내만 한다. 관리자가 아직 채우는 중이면 알린다.
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
// ── 블록 ① 지금 바로 시작 — connect(필수·자동판정). 설치 없이 웹에서 세션 한 번 열면 끝. ──
//  connect 는 '이 사람 신원으로 MCP 툴이 실제 호출된 적 있나'로 서버가 자동 판정한다(웹/로컬 어느 쪽이든).
function blockStartNow(connect) {
    const done = !!(connect && connect.state === 'done');
    const badge = done
        ? el('span', { class: 'ob-block-badge is-done', text: '✓ 시작함' })
        : el('span', { class: 'ob-block-badge req', text: '필수' });
    const lead = done
        ? '이미 AI 세션을 여셨어요. 아래에서 언제든 이어서 쓰거나 새 세션을 열 수 있습니다.'
        : '설치 없이 라이블리 웹에서 AI를 바로 켜서 써보세요. 회사 맥락·규칙이 이미 들어가 있어, 까만 창에 한국어로 시키면 됩니다.';
    return el('div', { class: 'card docs-card ob-block' }, el('div', { class: 'card-head ob-block-head' }, el('h2', { text: '① 지금 바로 시작하기' }), badge), el('p', { class: 'guide-lead', text: lead }), el('div', { class: 'step-cta', style: 'margin-bottom:0' }, el('a', { class: 'btn btn-primary', href: '#/dashboard?tour=1&from=onboarding', target: '_blank', rel: 'noopener', text: '내 AI 세션 열기 ↗' })));
}
// 설정 카드 한 장 — 제목 + (상태칩) + '이런 분께' / '안 해도 되는 경우' + 액션. 상황을 스스로 판단하게 한다.
//  state: 'done'|'skipped'|'todo'|null(서버가 추적하지 않는 항목=로컬 설치).
function setupCard(o) {
    const chip = o.state === 'done' ? el('span', { class: 'ob-block-badge is-done', text: '✓ 완료' })
        : o.state === 'skipped' ? el('span', { class: 'ob-block-badge', text: '건너뜀' })
            : null;
    const act = o.href
        ? el('a', { class: 'btn btn-ghost btn-sm', href: o.href, text: o.actLabel })
        : el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: o.actLabel, onclick: o.onClick });
    return el('div', { class: 'setup-card' + (o.state === 'done' ? ' is-done' : '') }, el('div', { class: 'setup-card-top' }, el('span', { class: 'setup-card-title', text: o.title }), chip), el('p', { class: 'setup-card-who' }, el('b', { text: '이런 분께 ' }), o.who), el('p', { class: 'setup-card-skip' }, el('b', { text: '안 해도 되는 경우 ' }), o.skip), el('div', { class: 'setup-card-act' }, act));
}
// ── 블록 ② 내 상황에 맞는 설정(선택) — 로컬 설치·이관·외부 연결. 각자 해당하는 것만. ──
//  로컬 설치는 서버 추적 스텝이 아니다(connect 자동판정이 웹/로컬 공통) → 상태칩 없이 안내 카드.
//  이관(migrate)·외부 연결(credentials)은 서버 status 를 그대로 반영한다.
function blockSetup(byKey) {
    const cards = [
        setupCard({
            title: '내 컴퓨터에서도 쓰기 (설치)',
            who: '평소 내 노트북 터미널에서 Claude Code·Codex 를 켜서 일하시는 분',
            skip: '라이블리 웹에서만 쓰실 거면 안 하셔도 됩니다',
            state: null,
            actLabel: '설치 안내 열기',
            onClick: () => openInstallModal(),
        }),
        setupCard({
            title: '예전에 쓰던 AI 환경 가져오기',
            who: el('span', {}, '예전부터 Claude·Codex 를 쓰며 쌓인 작업 메모·설정이 있는 분 ', el('span', { class: 'setup-card-pre', text: '(내 컴퓨터에 설치한 뒤)' })),
            skip: '라이블리가 처음이라 가져올 게 없으면 넘어가세요',
            state: byKey.migrate ? byKey.migrate.state : 'todo',
            actLabel: '방법 보기 →',
            href: '#/start/migrate',
        }),
        setupCard({
            title: '외부 서비스 연결',
            who: 'AI 가 회사 노션·깃랩 등을 대신 읽고 쓰게 하려면 한 번 연결해요',
            skip: '그런 도구를 AI로 다룰 일이 없으면 넘어가세요',
            state: byKey.credentials ? byKey.credentials.state : 'todo',
            actLabel: '연결하기 →',
            href: '#/system/me-logins',
        }),
    ];
    return el('div', { class: 'card docs-card ob-block' }, el('div', { class: 'card-head ob-block-head' }, el('h2', { text: '② 내 상황에 맞는 설정' }), el('span', { class: 'ob-block-badge', text: '선택' })), el('p', { class: 'guide-lead', text: '아래는 해당하는 분만 하시면 됩니다. 웹에서만 쓰실 거면 ①로 충분해요 — 그래도 어떤 설정인지 한 번 읽어두면, 나중에 필요할 때 놓치지 않아요.' }), el('div', { class: 'setup-cards' }, ...cards));
}
// ── 블록 ③ 이런 걸 시켜보세요 — examples 원고를 이 블록에 인라인(#req). 옛 링크카드 3개(examples·project·tour) 폐지.
//  '이런 걸 시켜보세요'(#/start/examples) 탭은 nav 에서 숨겼고(learn.ts DOCS_NAV), 본문이 여기로 이사했다. 원고 단일소스(docs-content.ts) 유지.
function blockMore() {
    const page = DOC_PAGES.find((p) => p.slug === 'examples');
    let md = page ? page.md : '';
    md = md.replace(/^#\s+[^\n]*\r?\n+/, ''); // 맨 위 '# 이런 걸 시켜보세요' 제목 제거 → 블록 head 가 대신
    md = md.replace(/\r?\n+##\s*다음\s*단계[\s\S]*$/, ''); // '다음 단계' 링크 묶음 제거(#/start 안이라 불필요)
    md = md.replace(/^>\s?/gm, ''); // 인트로 인용부호 제거 → 리드 문단
    md = md.replace(/^##\s/gm, '### '); // 하위 제목(##)을 블록 head 아래 소제목(###)으로 강등
    return el('div', { class: 'card docs-card ob-block' }, el('div', { class: 'card-head ob-block-head' }, el('h2', { text: '③ 이런 걸 시켜보세요' })), el('div', { class: 'md-rendered docs-md' }, renderMarkdown(md)));
}
export async function renderStart(view) {
    // #/learn 과 같은 머리 — 아이브로(직접 해보기) + docs-title 히어로 + 리드 한 줄.
    const head = [
        docsEyebrow('start'),
        el('h1', { class: 'docs-title', text: 'AI 세션 시작하기' }),
        el('p', { class: 'docs-lead', text: '라이블리로 AI를 쓰기 시작하는 곳입니다. 대부분 설치 없이 바로 시작할 수 있고, 필요한 설정만 골라서 하면 됩니다.' }),
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
    const items = (d.status && d.status.items) || [];
    const byKey = {};
    for (const it of items)
        byKey[it.key] = it;
    const cards = [
        blockStartNow(byKey.connect),
        blockSetup(byKey),
        blockMore(),
        await orgBanner(),
    ].filter(Boolean);
    slot.replaceChildren(...cards);
}
// #/start/migrate — "예전 환경 가져오기" 안내. **여기서 이관을 하지 않는다**(로컬 파일은 웹이 못 만진다).
//  AI 에게 시키는 법만 알려주고, 실제 작업·완료 보고는 lively-onboarding 스킬이 한다. 설치는 모달로 연다(#1000).
export async function renderStartMigrate(view) {
    const openInstall = (e) => { e.preventDefault(); openInstallModal(); };
    const head = [
        docsEyebrow('start'),
        el('h1', { class: 'docs-title', text: '예전에 쓰던 AI 환경 가져오기' }),
        el('p', { class: 'docs-lead', text: '가져오기는 내 컴퓨터의 AI 가 진행합니다 — 웹은 내 컴퓨터의 파일을 읽을 수 없어서, 이 화면에서는 방법만 안내해요.' }),
    ];
    docsShell(view, 'start', ...head, el('div', { class: 'guide-cards' }, 
    // 전제 콜아웃 — 이 도우미는 라이블리가 내 컴퓨터에 설치돼 있어야 뜬다('온보딩 도와줘'는 라이블리 스킬).
    el('div', { class: 'ob-banner amber' }, el('div', { class: 'ob-banner-row' }, el('span', { class: 'ob-banner-title' }, el('b', { text: '먼저, 내 컴퓨터에 라이블리가 설치돼 있어야 해요.' })), el('a', { class: 'ob-banner-go', href: '#/start', onclick: openInstall, text: '설치하기 →' })), el('p', { class: 'ob-banner-sub' }, '‘온보딩 도와줘’ 는 라이블리를 설치할 때 내 컴퓨터의 AI(Claude Code·Codex)에 함께 추가되는 기능이에요. 그래서 ', el('a', { href: '#/start', onclick: openInstall, text: '내 컴퓨터에 설치' }), '를 먼저 마쳐야 이 명령이 동작합니다. 아직이라면 설치부터 하세요.')), el('div', { class: 'card docs-card' }, el('div', { class: 'card-head' }, el('h2', { text: '설치했다면 — 내 컴퓨터에서 AI 를 켜고, 이렇게 말해보세요' })), el('div', { class: 'md-prompt' }, el('p', { class: 'md-p', text: '온보딩 도와줘' })), el('p', { class: 'admin-hint', style: 'margin:12px 0 0', text: 'AI 가 예전 작업 메모·직접 만든 스킬·훅·연결해 둔 서비스를 읽어서 목록으로 보여주고, 무엇을 회사와 공유하고(작업 메모는 위키로, 스킬·훅·MCP 는 각자 알맞은 곳으로) 무엇을 그대로 둘지 하나씩 같이 정합니다. 원본은 수정하거나 삭제하지 않습니다 — 옮길 때도 복사만 합니다. AI 가 끝나면 이 화면에 완료로 표시해 드립니다.' })), el('div', { class: 'card docs-card' }, el('div', { class: 'card-head' }, el('h2', { text: '“예전 작업 메모가 사라졌어요”' })), el('p', { class: 'guide-lead', style: 'margin:0', text: '사라지지 않았습니다. AI 의 작업 메모는 폴더마다 따로 저장돼서, 다른 폴더에서 켜면 안 보일 뿐입니다. ‘온보딩 도와줘’ 를 실행하면 다른 폴더에 저장된 작업 메모까지 찾아서 보여줍니다.' })), el('div', { class: 'card docs-card' }, el('div', { class: 'card-head' }, el('h2', { text: '웹에서 AI 세션을 쓰고 계신가요?' })), el('p', { class: 'guide-lead', style: 'margin:0 0 12px' }, el('a', { href: '#/dashboard', text: '내 AI 세션' }), '에서 연 세션은 회사 서버에서 실행됩니다 — 그래서 내 노트북에 있던 예전 환경을 읽을 수 없습니다. 가져오시려면 내 컴퓨터에 라이블리를 설치한 뒤, 거기서 ‘온보딩 도와줘’ 라고 입력하세요. 가져올 게 없다면 이 항목은 건너뛰셔도 됩니다.'), el('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openInstallModal(), text: '내 컴퓨터에 설치하기 →' }))));
}
// #/start/project — '프로젝트 체험': 프로젝트 화면을 예시 프로젝트에서 한 바퀴 둘러보는 랜딩.
//  진행 자체는 guide-tour.ts 의 'projects' 코스(projects-board → projects-detail)가 안내한다 —
//  #/start/tour 의 프로젝트 둘러보기와 **완전히 같은 투어**다(요청: 두 곳을 동일하게). 별도 투어를 두지 않는다.
export async function renderStartProject(view) {
    // UI 는 'AI 세션 체험'(renderStart)과 같은 여정 레일(ob-journey/ob-quest) 로 통일한다.
    //  스텝은 정적으로 보여주고(번호 노드 → 둘러보면 ✓), 실행은 startGuideTour(['projects']) 하나만 띄운다.
    const did = isSectionDone('projects');
    const head = [
        docsEyebrow('start-project'),
        el('h1', { class: 'docs-title', text: '프로젝트 생성하기' }),
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
