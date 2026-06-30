// learn.ts — split from app.js (ESM, behavior-preserving). DO NOT add logic; moved verbatim.
import { TOKEN_KEY, api, el, errorNote, renderMarkdown, state } from './core.js';
import { copyButton, deployCommands, installCmd, loadAdmin } from './admin.js';
// 안내(#/learn) — 지식유형/수집 ground-truth(GET /api/ui/learn = kind_registry + data_source) 렌더.
//  비개발자 대상: V4 본질 종류 4종(R·K·H·W) 중심 + 통합 예정 legacy 종류는 graceful 표시 + 데이터소스별 수집방식. 읽기 전용.
//  V4: 종류(kind)·주제(area=space+domain)·출처(provenance)는 별개 축 — 종류는 본질, 주제는 도메인, 출처는 채널 사실.
//  non-stale: 서버가 DB 를 그대로 반환하므로 정의를 DB 에서 고치면 이 화면도 즉시 반영(런북과 동일 데이터).
//  §0.5 절제: 무채색 카드 + 작은 상태 점만, 채운 배지 금지. 자유텍스트는 안전 마크다운 렌더 재사용.
// ════════════════════════════════════════════
async function renderLearn(view) {
    // 가이드 — 비개발자용 '개념·용어'만. 핵심: '여기 담기는 지식 하나가 실제로 뭔지'를 예시로 와닿게.
    //  설치는 별도 [설치] 탭, 어려운 레지스트리(주입모드·수집방식)는 제거. 정적 — API 불필요.
    const head = el('div', { class: 'page-head' }, el('h1', {}, '사용 ', el('span', { class: 'accent', text: '설명서' })), el('p', { class: 'sub', text: '이 도구가 무엇이고, 안에 담기는 ‘지식’ 하나가 실제로 어떤 건지 쉽게 설명합니다. 한 번만 읽어두면 됩니다. (설치는 옆 [설치]에서.)' }));
    // ── A. 이 서비스가 뭔가요(목적) — 비개발자용 한눈 설명 ──
    const whatCard = el('div', { class: 'card guide-what' }, el('div', { class: 'card-head' }, el('h2', { text: '이 서비스가 뭔가요' })), el('p', { class: 'guide-lead', text: '팀이 쓰는 AI(예: Claude Code)가 매번 같은 배경을 다시 설명하지 않아도 되도록, 회사의 공통 맥락·규칙·기억을 한곳에 모아두는 저장소입니다. 여기 정리해두면, 설치한 모든 구성원의 AI가 세션을 시작할 때 이 내용을 자동으로 읽고 일합니다.' }));
    const whatRows = el('div', { class: 'learn-rows guide-what-rows' });
    whatRows.append(learnRow('무엇을 담나', '회사 규칙·페르소나, 팀이 쌓은 지식과 절차, 진행 중인 과업, 자주 쓰는 용어 등 — AI가 알고 있어야 할 회사 맥락 전부.'), learnRow('어떻게 전달되나', '구성원이 한 번 설치하면, AI 세션이 열릴 때마다 최신 내용이 자동으로 들어갑니다. 사람이 매번 복사·설명할 필요가 없습니다.'), learnRow('누가 바꾸나', '관리자는 [관리] 탭에서 규칙·분류를, [WIKI] 탭에서 지식을 편집·저장하면, 구성원이 다음에 설치/업데이트할 때 자동으로 받습니다. 구성원은 한 번만 설치하면 끝입니다.'), learnRow('처음이라면', '바로 시작하려면 [설치 단계](#/install)를 그대로 따라 하세요 — 5분이면 끝납니다. 그다음은 자동입니다.'));
    whatCard.append(whatRows);
    // B. '지식 하나'가 실제로 뭔지 — 예시 카드로 구체화(추상 개념을 눈으로). 그다음 종류 4가지. (정적 — API 불필요)
    const unitCard = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: '여기 담기는 ‘지식’ 하나가 뭔가요' })), el('p', { class: 'guide-lead', text: '회사 지식이 한 덩어리씩 쌓입니다. 덩어리 하나는 제목과 내용으로 된 짧은 글이에요 — 메모 한 장, 문서 한 페이지 같은 겁니다. 성격에 따라 네 가지로 나뉘는데, 각각 이런 모습이에요 (이름 옆 알파벳은 시스템이 쓰는 약자):' }));
    // 네 종류(R/K/H/W) 각각 — 비개발자가 한눈에 이해할 쉬운 예시를 하나씩. [글자, 한글이름, 설명, 예시제목, 예시내용]
    const GLOSS = [
        ['R', '규칙', 'AI가 항상 지켜야 할 회사 규칙',
            '추측으로 답하지 않기', '확실한 근거가 없으면 “잘 모르겠다”고 말한다. 그럴듯하게 지어내지 않는다.'],
        ['K', '지식', '자료·결정·조사처럼 쌓인 지식',
            '경쟁사 가격 비교 (2월 조사)', 'A사 월 9,900원, B사 월 14,000원, 우리 월 12,000원 — 우리가 중간 가격대.'],
        ['H', '절차', '“이런 일은 이렇게” 하는 방법',
            '새 팀원이 오면 하는 일', '① 슬랙·노션에 초대한다 → ② 필요한 권한을 준다 → ③ 환영 점심을 잡는다.'],
        ['W', '할 일', '지금 진행 중인 과업',
            '홈페이지 가격 페이지 새로 만들기', '이번 주까지 · 담당 원준. 새 요금제 3가지를 보기 좋게 정리하기.'],
    ];
    const glossList = el('div', { class: 'kind-ex-list' });
    for (const [g, ko, desc, exTitle, exBody] of GLOSS) {
        glossList.append(el('div', { class: 'kind-ex' }, el('div', { class: 'kind-ex-head' }, el('span', { class: 'gloss-glyph', 'aria-hidden': 'true', text: g }), el('div', { class: 'gloss-main' }, el('div', {}, el('span', { class: 'gloss-ko', text: ko }), el('span', { class: 'gloss-code', text: ' (' + g + ')' })), el('div', { class: 'gloss-desc', text: desc }))), el('div', { class: 'gloss-example' }, el('span', { class: 'gloss-example-tag', text: '예시' }), el('div', { class: 'gloss-example-title', text: exTitle }), el('div', { class: 'gloss-example-body', text: exBody }))));
    }
    unitCard.append(glossList, el('p', { class: 'admin-hint', style: 'margin-top:16px' }, '실제 지식들은 ', el('a', { href: '#/knowledge', text: '[WIKI] 탭' }), ' 에서 볼 수 있어요.'));
    // ── C. 프로젝트에 '필요지식'을 연결하면 뭐가 좋나(#317) — 비개발자 눈높이. 섹션 '왜' 배너의 [자세히]가 여기로. ──
    const whyReqCard = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: '프로젝트에 ‘필요지식’을 연결하면 뭐가 좋나요' })), el('p', { class: 'guide-lead', text: '프로젝트마다 “이 일을 하려면 먼저 알아야 할 것들”을 골라 연결해 둘 수 있어요. 그러면 그 프로젝트를 맡는 AI가, 그 내용을 일일이 찾아낼 필요 없이 처음부터 손에 쥔 채로 일을 시작합니다.' }));
    const whyRows = el('div', { class: 'learn-rows' });
    whyRows.append(learnRow('무엇을 연결하나', '이 프로젝트와 관련된 결정·규칙·자료·절차 — AI가 일을 시작하기 전에 알고 있어야 헷갈리지 않을 것들. 예: “요금제 정책 결정”, “디자인 가이드”, “이 기능의 지난 논의”.'), learnRow('연결하면 뭐가 달라지나', '연결을 안 해두면 AI는 매번 같은 배경을 다시 묻거나, 모른 채로 추측해 엉뚱한 방향으로 가기 쉽습니다. 연결해 두면 팀의 결정과 규칙을 “이미 아는 채로” 정확하게 시작해요.'), learnRow('어떻게 연결하나', '프로젝트 화면의 ‘지식 흐름’에서 [✨ 지식 찾기]를 누르면 관련 지식을 추천해 줘요. 마음에 드는 걸 [연결]만 누르면 끝. 없으면 [✎ 직접 작성]으로 새로 쓸 수도 있어요.'), learnRow('필요 지식 vs 산출 지식', '‘필요’는 이 프로젝트가 시작 전에 참고할 지식, ‘산출’은 이 프로젝트가 일하며 새로 만들어 낸 지식이에요. 산출은 처음엔 비어 있는 게 정상 — 일이 진행되며 쌓입니다.'));
    whyReqCard.append(whyRows);
    view.replaceChildren(head, el('div', { class: 'guide-cards' }, whatCard, unitCard, whyReqCard));
    document.getElementById('view').focus?.();
}
// 설치 탭(#/install) — 모든 구성원의 첫 행동. 비개발자도 그대로 따라 하도록 구성한다.
//  핵심: 쓰는 곳이 두 갈래라 시작법이 다르다 — (web) 라이블리 [터미널] 탭=서버에서 claude/codex 가 돌고
//  회사맥락이 이미 설치돼 있어 '설치 0' / (local) 내 컴퓨터 터미널=내 머신에 한 번 설치. mode 토글로 분기.
//  게이트웨이 주소는 org 프로필에서(loadAdmin — 비-admin 도 안전: tokens redact).
async function renderInstall(view) {
    const head = el('div', { class: 'page-head' }, el('h1', {}, 'Lively ', el('span', { class: 'accent', text: '시작하기' })), el('p', { class: 'sub', text: '라이블리에서 AI(Claude Code·Codex)를 쓰는 방법은 두 가지입니다. 아래에서 본인 상황을 고르면, 그에 맞춰 차근차근 안내합니다.' }));
    const slot = el('div', { class: 'install-guide' });
    slot.append(skeleton('설치 안내를 준비하는 중'));
    view.replaceChildren(head, slot);
    document.getElementById('view').focus?.();
    onboardingBanner().then((b) => { if (b)
        head.before(b); }); // 온보딩 진행 배너(미완 시) — 제목 '위'로 → #/onboarding
    loadAdmin().then((data) => drawInstallGuide(slot, data))
        .catch((e) => slot.replaceChildren(errorNote(e, '설치 안내를 불러오지 못했습니다')));
}
// 설치 가이드 — 먼저 '어디서 쓰나'(web/local) 를 고르게 하고, 고른 모드의 가이드만 렌더. slot 안만 교체.
function drawInstallGuide(slot, data) {
    const gw = (data.profile.gateway_url || window.location.origin).replace(/\/mcp$/, '').replace(/\/$/, '');
    const mode = state.start.mode === 'local' ? 'local' : 'web';
    // ── 0. 먼저 이게 뭔가요(짧게) ──
    const intro = el('div', { class: 'card install-intro' }, el('div', { class: 'card-head' }, el('h2', { text: '먼저, 이게 뭔가요' })), el('p', { class: 'guide-lead', text: '이걸 쓰면 AI(Claude Code·Codex)가 우리 회사의 규칙·맥락·기억을 “이미 아는 채로” 일을 시작합니다. 매번 배경을 다시 설명할 필요가 없어져요.' }), el('p', { class: 'admin-hint', style: 'margin-bottom:0' }, '개념·용어가 더 궁금하면 ', el('a', { href: '#/learn', text: '[사용설명서]' }), ' 를 먼저 봐도 좋아요.'));
    // ── 1. 어디서 쓰나 — 두 갈래 선택(카드 클릭 시 아래 가이드가 바뀜) ──
    const chooser = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: '어디서 AI를 쓰실 건가요?' })), el('p', { class: 'admin-hint', text: '본인이 주로 쓰는 곳을 고르세요. 둘은 시작법이 다릅니다(둘 다 써도 됩니다).' }), el('div', { class: 'mode-choice' }, modeCard('web', '라이블리 웹의 [터미널] 탭', '설치 필요 없음 · 웹에서 바로', '브라우저만 있으면 끝. 빠르게 써보거나 비개발자에게 추천.', mode, slot, data), modeCard('local', '내 컴퓨터의 터미널', '한 번 설치 필요 · 약 5분', '내 노트북(맥/윈도우) 터미널에서 직접 claude·codex 를 켜서 쓰는 분.', mode, slot, data)));
    const guide = mode === 'web' ? webGuideNodes() : localGuideNodes(gw, slot, data);
    slot.replaceChildren(intro, chooser, ...guide);
}
// 모드 선택 카드(웹 터미널 탭 vs 내 컴퓨터). 선택 시 재렌더.
function modeCard(key, title, tag, hint, active, slot, data) {
    const on = key === active;
    const pick = () => { if (state.start.mode !== key) {
        state.start.mode = key;
        drawInstallGuide(slot, data);
    } };
    return el('div', {
        class: 'mode-card' + (on ? ' active' : ''), role: 'button', tabindex: '0',
        'aria-pressed': on ? 'true' : 'false',
        onclick: pick,
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick();
        } },
    }, el('div', { class: 'mode-card-top' }, el('span', { class: 'mode-card-radio', 'aria-hidden': 'true' }), el('span', { class: 'mode-card-tag', text: tag })), el('div', { class: 'mode-card-title', text: title }), el('div', { class: 'mode-card-hint', text: hint }));
}
// (web) 라이블리 [터미널] 탭에서 쓰는 사람 — 내 컴퓨터엔 설치 0. 서버에서 claude/codex 가 회사맥락 가진 채 돈다.
function webGuideNodes() {
    const callout = el('div', { class: 'card install-callout' }, el('div', { class: 'callout-strong', text: '내 컴퓨터엔 아무것도 안 깔아도 됩니다.' }), el('p', { class: 'callout-sub', text: 'AI는 라이블리 서버에서 돌고, 회사 맥락·규칙도 거기에 이미 설치돼 있어요. 웹 브라우저만 있으면 바로 시작할 수 있습니다.' }));
    const steps = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: '쓰는 순서' })), el('div', { class: 'step-list' }, installStep(1, '위쪽 메뉴에서 [터미널] 탭 열기', el('p', { class: 'step-p' }, '맨 위 메뉴에서 ', el('a', { href: '#/terminal', text: '[터미널]' }), ' 을 누르세요.')), installStep(2, '[+ 새 세션] 누르기', el('p', { class: 'step-p', text: '오른쪽 위 파란 [+ 새 세션] 버튼을 누르면 만들기 창이 떠요.' })), installStep(3, '작업 폴더와 AI를 고르고 [만들기]', el('p', { class: 'step-p' }, '작업 폴더(', el('b', { text: '공유 워크스페이스' }), ' 또는 ', el('b', { text: '개인 폴더' }), '), 사용할 AI(', el('b', { text: 'Claude Code' }), ' 또는 ', el('b', { text: 'Codex' }), '), 세션 이름을 정하고 [만들기]를 누르세요.'), el('p', { class: 'step-note', text: '잘 모르겠으면 — 작업 폴더는 [개인 폴더], AI는 [Claude Code]로 두면 무난해요.' })), installStep(4, '열린 창에서 바로 대화하기', el('p', { class: 'step-p', text: '까만 창(터미널)이 열리면 거기에 하고 싶은 말을 그냥 입력하면 됩니다. 회사 맥락·규칙은 이미 들어가 있어요.' }), el('p', { class: 'step-note', text: '세션은 창을 닫아도 서버에 남아 있어, 다음에 [터미널] 탭에서 다시 이어서 쓸 수 있어요.' }))));
    return [callout, steps];
}
// (local) 내 컴퓨터 터미널에서 쓰는 사람 — 내 머신에 한 번 설치. OS 토글로 단계가 바뀐다.
function localGuideNodes(gw, slot, data) {
    const os = state.start.os === 'windows' ? 'windows' : 'mac';
    const isWin = os === 'windows';
    const callout = el('div', { class: 'card install-callout' }, el('div', { class: 'callout-strong', text: '내 컴퓨터에 한 번 설치합니다 (약 5분).' }), el('p', { class: 'callout-sub', text: '설치하면 내 노트북에서 claude(또는 codex)를 켤 때마다 회사 맥락이 자동으로 들어와요. 처음 딱 한 번만 하면 끝입니다.' }));
    // ── 준비물 — 대부분 이미 있음. 막히기 쉬운 node 는 확인법까지 명시(없으면 hooks 미설치=조용한 반쪽설치). ──
    const needs = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: '준비물 (잠깐 확인)' })), el('p', { class: 'admin-hint', text: '아래만 있으면 됩니다. 대부분 이미 갖춰져 있어요.' }), checklist([
        ['내 컴퓨터 (Mac 또는 Windows)', '회사에서 쓰는 본인 노트북이면 됩니다.'],
        ['터미널 앱', '맥·윈도우에 기본으로 들어 있어요. 여는 법은 아래 1단계에서 알려드립니다.'],
        ['Node.js (거의 항상 이미 있음)', '터미널을 연 뒤(아래 1단계) node -v 를 입력해 v20 같은 숫자가 보이면 통과예요. 안 보이면 nodejs.org 에서 ‘LTS’ 설치 파일을 받아 더블클릭하세요.'],
        ['회사 계정', '설치 마지막에 회사 계정으로 로그인하는 브라우저 창이 한 번 뜹니다.'],
    ]));
    // ── 2. 단계 — OS 토글을 카드 헤더에 두고, 단계 본문이 OS 에 맞게 바뀐다 ──
    const osTabs = el('div', { class: 'os-tabs' }, ...[['mac', 'macOS'], ['windows', 'Windows']].map(([o, label]) => el('button', {
        class: 'btn btn-sm ' + (o === os ? 'btn-primary' : 'btn-ghost'), text: label,
        onclick: () => { if (state.start.os !== o) {
            state.start.os = o;
            drawInstallGuide(slot, data);
        } }
    })));
    const term = isWin
        ? installStep(1, '터미널(PowerShell) 열기', el('p', { class: 'step-p' }, '화면 왼쪽 아래 ', kbd('시작'), ' 버튼을 누르고 ', kbd('powershell'), ' 라고 입력 → 목록에서 ', el('b', { text: 'Windows PowerShell' }), ' 을 클릭하세요.'), el('p', { class: 'step-note', text: '파란색 글자 입력 창이 하나 뜹니다. 이게 명령을 붙여넣을 곳이에요.' }))
        : installStep(1, '터미널 열기', el('p', { class: 'step-p' }, '키보드에서 ', kbd('⌘'), ' + ', kbd('스페이스바'), ' 를 동시에 눌러 검색창을 띄우고, ', kbd('터미널'), ' 이라고 입력한 뒤 ', kbd('Enter'), ' 를 누르세요.'), el('p', { class: 'step-note', text: '글자만 있는 작은 창이 하나 뜹니다. 이게 ‘터미널’이고, 여기에 명령을 붙여넣게 됩니다.' }));
    const mint = installStep(2, '내 설치 명령 만들기', el('p', { class: 'step-p' }, '아래 ', el('b', { text: '[설치 명령 만들기]' }), ' 를 누르면 본인 전용 설치 명령이 자동으로 만들어집니다 — 토큰을 직접 다룰 필요가 없어요.'), el('p', { class: 'step-note', text: '명령에는 본인 접속 키가 들어 있으니 남과 공유하지 마세요. 만든 다음 [명령 복사]를 누르면 됩니다.' }), installSelfCmdBox(gw, os));
    const run = installStep(3, '명령 붙여넣고 실행하기', el('p', { class: 'step-p' }, '1단계에서 연 터미널 창을 클릭한 다음, 방금 복사한 명령을 붙여넣고(', isWin ? kbd('Ctrl') : kbd('⌘'), ' + ', kbd('V'), ') ', kbd('Enter'), ' 를 누르세요.'), el('p', { class: 'step-note', text: '명령이 길어 보여도 한 줄이에요 — 통째로 붙여넣으면 됩니다. 그러면 알아서 진행됩니다. 도중에 이런 게 나올 수 있어요:' }), el('ul', { class: 'step-ul' }, el('li', {}, 'Claude Code 가 없으면 ', el('b', { text: '“설치할까요? [y/N]”' }), ' 라고 물어봐요 → ', kbd('y'), ' 를 누르고 ', kbd('Enter'), '.'), el('li', {}, '회사 계정 ', el('b', { text: '로그인 브라우저 창' }), ' 이 뜨면 회사 계정으로 로그인하세요.'), el('li', {}, el('b', { text: '“=== 끝! ===”' }), ' 비슷한 메시지가 보이면 설치가 끝난 거예요.')));
    const verify = installStep(4, '잘 됐는지 확인하기', el('p', { class: 'step-p' }, '같은 터미널에 아래를 입력하고 ', kbd('Enter'), ' 를 누르세요.'), cmdLine('claude mcp list'), el('p', { class: 'step-note' }, '목록에 ', el('b', { text: 'lively' }), ' 가 보이면 성공이에요. ', '이제 어느 폴더에서든 ', el('code', { class: 'md-code', text: 'claude' }), ' 를 켜면 회사 맥락이 따라옵니다.'));
    const steps = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: '설치 단계' }), el('div', { class: 'os-pick' }, el('span', { class: 'os-pick-label', text: '내 컴퓨터' }), osTabs)), isWin ? el('p', { class: 'admin-warn', text: '⚠ Windows 설치는 아직 검증이 충분치 않습니다. 막히면 관리자에게 알려주세요.' }) : null, el('div', { class: 'step-list' }, term, mint, run, verify));
    // ── 3. 끝났어요 — 이제 뭘 하나 ──
    const next = el('div', { class: 'card install-next' }, el('div', { class: 'card-head' }, el('h2', { text: '끝났어요 — 이제 뭘 하나요' })), el('p', { class: 'guide-lead', text: '설치가 끝나면 평소처럼 Claude Code 를 켜서 일하면 됩니다. 어느 폴더에서 켜든 회사 공통 맥락·규칙이 자동으로 함께 들어가요. 매번 회사 사정을 설명하지 않아도 됩니다.' }), el('p', { class: 'admin-hint', style: 'margin-bottom:0' }, '회사에 어떤 맥락이 쌓여 있는지 둘러보려면 ', el('a', { href: '#/knowledge', text: '[WIKI]' }), ' 탭으로 가보세요. (자동 주입은 ', el('b', { text: '다음 세션부터' }), ' 적용됩니다.)'));
    // ── 4. 유지보수(접힘) — 처음엔 필요 없음. 나중에 업데이트/제거할 때만. ──
    const staticBlock = (c) => el('div', { class: 'deploy-block' }, el('div', { class: 'deploy-head' }, el('h3', { text: c.title }), c.cmd !== '(준비 중)' ? copyButton(() => c.cmd, '복사') : null), el('p', { class: 'admin-hint', text: c.note }), el('pre', { class: 'admin-preview', text: c.cmd }));
    const maint = el('details', { class: 'install-maint' }, el('summary', { text: '＋ 나중에 필요할 때: 업데이트 · 제거 (지금은 안 봐도 됩니다)' }), el('p', { class: 'admin-hint', text: '처음 설치에는 필요 없습니다. 나중에 라이블리를 최신으로 갱신하거나, 내 컴퓨터에서 지울 때만 쓰는 명령이에요. 업데이트·제거는 설치된 토큰을 자동으로 읽어, 토큰을 다시 넣을 필요가 없습니다.' }), ...deployCommands(gw, os).filter((c) => c.kind !== 'install').map(staticBlock));
    return [callout, needs, steps, next, maint];
}
// 번호 매긴 설치 단계 한 칸.
function installStep(n, title, ...body) {
    return el('div', { class: 'step' }, el('div', { class: 'step-num', 'aria-hidden': 'true', text: String(n) }), el('div', { class: 'step-body' }, el('div', { class: 'step-title', text: title }), ...body));
}
// 사용자가 '관리자에게 받아 첫 로그인 때 입력한 토큰'을 직접 넣으면 그 토큰으로 설치 명령을 만든다(서버 발급 안 함).
//  입력값은 게이트 로그인 토큰(localStorage TOKEN_KEY)과 정확히 일치할 때만 통과 — 아무 문자열이나 명령으로
//  나가지 않게(아무거나 넣어도 산출되던 문제 차단). 일치하는 토큰은 state.start.token 에 캐시(OS 토글 시 재입력 불필요).
function installCmdBox(gw, os) {
    const result = el('div', { class: 'install-cmd-slot' });
    const err = el('p', { class: 'install-token-err' });
    err.hidden = true;
    const draw = () => {
        if (!state.start.token) {
            result.replaceChildren();
            return;
        }
        const cmd = installCmd(gw, os, state.start.token);
        result.replaceChildren(el('p', { class: 'install-ok', text: '✓ 토큰이 확인됐어요. 설치 명령이 만들어졌습니다 — [명령 복사]를 누른 뒤 3단계로 가세요.' }), el('div', { class: 'deploy-head' }, el('span', {}), copyButton(() => cmd, '명령 복사')), el('pre', { class: 'admin-preview', text: cmd }));
    };
    const showErr = (msg) => { err.textContent = msg; err.hidden = false; result.replaceChildren(); };
    const tokenIn = el('input', {
        type: 'password', class: 'term-input', autocomplete: 'off', spellcheck: 'false',
        'aria-label': '관리자에게 받은 접속 토큰',
        placeholder: '관리자에게 받은 토큰 (첫 로그인 때 입력한 것)', value: state.start.token || '',
    });
    const go = el('button', { class: 'btn btn-primary btn-sm', text: '설치 명령 만들기' });
    const make = () => {
        const t = tokenIn.value.trim();
        if (!t) {
            showErr('토큰을 입력하세요.');
            tokenIn.focus();
            return;
        }
        // 게이트(첫 로그인) 때 입력한 토큰과 정확히 일치하는지 확인 — 일치할 때만 명령 생성.
        const login = (localStorage.getItem(TOKEN_KEY) || '').trim();
        if (login && t !== login) {
            showErr('이 화면에 처음 들어올 때 입력한 토큰과 다릅니다. 그때 입력한 토큰을 그대로 넣어 주세요. (잊었다면 관리자에게 다시 받으세요.)');
            return;
        }
        err.hidden = true;
        state.start.token = t;
        draw();
    };
    go.addEventListener('click', make);
    tokenIn.addEventListener('input', () => { if (!err.hidden)
        err.hidden = true; });
    tokenIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') {
        e.preventDefault();
        make();
    } });
    draw();
    return el('div', {}, el('div', { class: 'install-minter' }, tokenIn, go), err, result);
}
// 설치 명령 셀프 베이크(P3) — 로그인된 본인이 [설치 명령 만들기] 한 번으로 본인 토큰을 자동 발급해 명령에 굽는다.
//  토큰을 손으로 만지지 않는다(self-mint = admin/runtime 제외 저권한). 기본 설치 플로우.
function installSelfCmdBox(gw, os) {
    const result = el('div', { class: 'install-cmd-slot' });
    const go = el('button', { class: 'btn btn-primary btn-sm', text: '설치 명령 만들기' });
    go.addEventListener('click', async () => {
        go.disabled = true;
        try {
            const r = await api('/api/ui/org/token/self', { method: 'POST', body: '{}' });
            const cmd = installCmd(gw, os, r.token);
            result.replaceChildren(el('p', { class: 'install-ok', text: '✓ 설치 명령이 만들어졌어요 — [명령 복사]를 누른 뒤 3단계로 가세요. (본인 접속 키가 들어 있으니 공유 금지.)' }), el('div', { class: 'deploy-head' }, el('span', {}), copyButton(() => cmd, '명령 복사')), el('pre', { class: 'admin-preview', text: cmd }));
        }
        catch (e) {
            result.replaceChildren(el('p', { class: 'install-token-err', text: '발급 실패 — ' + e.message }));
        }
        go.disabled = false;
    });
    return el('div', {}, el('div', { class: 'install-minter' }, go), result);
}
// 복사 가능한 한 줄 명령(확인용 등 — 토큰 없는 짧은 명령).
function cmdLine(cmd) {
    return el('div', { class: 'cmd-line' }, el('code', { class: 'cmd-line-text', text: cmd }), copyButton(() => cmd, '복사'));
}
// 키캡(키보드 키·메뉴 항목 강조) — 비개발자용 시각 힌트.
function kbd(label) { return el('span', { class: 'kbd', text: label }); }
// 준비물 체크리스트.
function checklist(items) {
    const wrap = el('div', { class: 'install-checks' });
    for (const [k, v] of items) {
        wrap.append(el('div', { class: 'install-check' }, el('span', { class: 'check-mark', 'aria-hidden': 'true', text: '✓' }), el('div', { class: 'check-main' }, el('div', { class: 'check-k', text: k }), el('div', { class: 'check-v', text: v }))));
    }
    return wrap;
}
// 안내 카드 안의 라벨 + 값 한 줄 — 값은 안전 마크다운 렌더(자유텍스트의 인라인 서식 허용, HTML 주입 불가).
function learnRow(label, value) {
    return el('div', { class: 'learn-row' }, el('div', { class: 'learn-row-k', text: label }), el('div', { class: 'learn-row-v' }, renderMarkdown(value)));
}
function skeleton(caption) {
    return el('div', {}, el('p', { class: 'loading-caption', text: caption + '…' }), el('div', { class: 'skel-stack' }, el('div', { class: 'skel' }), el('div', { class: 'skel' }), el('div', { class: 'skel' })));
}
function skeletonRows(n) {
    const box = el('div', {});
    for (let i = 0; i < n; i++)
        box.append(el('div', { class: 'row' }, el('div', { class: 'skel', style: 'min-height:18px;border:none;background:var(--bg-tint)' })));
    return box;
}
// 모달 오버레이(저장/편집 폼) — admin 의 overlay() 와 같은 ESC/배경클릭 닫기. 셸 재사용.
function overlayBox(title, ...content) {
    const box = el('div', { class: 'ov-box' }, el('div', { class: 'ov-head' }, el('h3', { text: title }), el('button', { class: 'btn-text', text: '닫기', onclick: () => back.remove() })), ...content);
    const back = el('div', { class: 'ov-back' }, box);
    back.addEventListener('click', (e) => { if (e.target === back)
        back.remove(); });
    document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') {
        back.remove();
        document.removeEventListener('keydown', esc);
    } });
    document.body.append(back);
    return back;
}
// ── 온보딩 진행상황(#/onboarding) — SoT = GET /api/ui/org/onboarding (하네스 주입과 동일 소스, 드리프트 0). ──
function obProgress(pct) {
    return el('div', { style: 'height:8px;background:#ececec;border-radius:4px;overflow:hidden;margin:10px 0' }, el('div', { style: `height:100%;width:${pct}%;background:#3a9d6e;transition:width .3s` }));
}
// 시작하기(랜딩) 상단 배너 — 미완일 때만(완료면 null → 안 보임). 클릭 시 #/onboarding.
async function onboardingBanner() {
    try {
        const s = await api('/api/ui/org/onboarding');
        if (!s || s.complete)
            return null;
        return el('a', { class: 'card', href: '#/onboarding', style: 'display:block;text-decoration:none;color:inherit' }, el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:12px' }, el('strong', { text: `온보딩 진행 ${s.done}/${s.total} (${s.pct}%)` }), el('span', { class: 'accent', text: '진행상황 보기 →' })), obProgress(s.pct), el('p', { class: 'admin-hint', style: 'margin:0', text: '남은 단계를 채우면 AI 세션이 그만큼 더 풍부한 회사 맥락으로 시작합니다(재설치 불필요).' }));
    }
    catch {
        return null;
    }
}
// 전용 페이지 — 단계별 완료 여부 + 진행률. AI(세션 시작)도 같은 SoT 를 받는다는 점을 명시.
async function renderOnboarding(view) {
    const head = el('div', { class: 'page-head' }, el('h1', {}, '온보딩 ', el('span', { class: 'accent', text: '진행상황' })), el('p', { class: 'sub', text: '이 인스턴스 셋업이 어디까지 됐는지 한눈에 봅니다. AI도 세션 시작 시 같은 진행상황(SoT)을 받아, 덜 된 단계를 사용자에게 안내합니다.' }));
    const slot = el('div', {});
    slot.append(skeleton('진행상황을 불러오는 중'));
    view.replaceChildren(head, slot);
    document.getElementById('view').focus?.();
    try {
        const s = await api('/api/ui/org/onboarding');
        const summary = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: `진행률 ${s.done}/${s.total} (${s.pct}%)` })), obProgress(s.pct), el('p', { class: 'admin-hint', style: 'margin:0', text: s.complete
                ? '✓ 기본 셋업 완료 — 세션에 실제 조직 맥락이 주입됩니다.'
                : '미완 단계를 채우면 다음 세션부터 AI가 그 맥락을 갖고 시작합니다(재설치 불필요 — 라이브 반영).' }));
        const steps = el('div', {});
        s.items.forEach((it, i) => {
            steps.append(el('div', { class: 'card', style: 'display:flex;gap:12px;align-items:flex-start;margin-bottom:10px;opacity:' + (it.done ? '0.65' : '1') }, el('div', { style: `flex:0 0 28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;background:${it.done ? '#3a9d6e' : '#bbb'}`, text: it.done ? '✓' : String(i + 1) }), el('div', { style: 'flex:1;min-width:0' }, el('div', { style: 'font-weight:600' }, it.label, it.count !== undefined ? el('span', { class: 'admin-hint', text: ` · 현재 ${it.count}` }) : null), el('div', { class: 'admin-hint', style: 'margin:2px 0 0', text: it.how }), it.href ? el('a', { class: 'accent', href: it.href, text: it.done ? '보기 →' : '바로가기 →', style: 'display:inline-block;margin-top:6px;text-decoration:none' }) : null)));
        });
        slot.replaceChildren(summary, steps);
    }
    catch (e) {
        slot.replaceChildren(errorNote(e, '온보딩 진행상황을 불러오지 못했습니다'));
    }
}
export { checklist, overlayBox, renderInstall, renderLearn, renderOnboarding, skeleton, skeletonRows, };
