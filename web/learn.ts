// learn.ts — 클래식 안내 표면의 소유 모듈 + 옛 UI 프리미티브 재수출 배럴.
//  ★ 「사용 가이드」 본체는 여기 없다(#4179, 2026-09-27). 가이드는 새 셸이 직접 그리는 앱이 됐다: 화면 web/guide/app.ts ·
//   본문 web/guide/render.ts · 도식 web/guide/figures.ts · 원고 web/docs-content.ts.
//  이 파일에 남은 화면: 클래식 「시작하기」가 쓰는 문서 셸(docsShell — start.ts) · 둘러보기 랜딩(#/start/tour) ·
//   설치 모달(renderInstall · openInstallModal) · 온보딩 진행(#/onboarding).
//  소비자: main.ts(라우팅) · 설치/온보딩 안내를 여는 start.ts·admin 계열.
//  ⚠ 재수출(하위호환): skeleton·skeletonRows·overlayBox 는 **이 파일 소유가 아니다** — ui-primitives.ts 가 소유하고
//   여기서 그대로 재수출할 뿐이다(#1313 R27). 18개 파일이 옛 경로 './learn.js' 로 가져가고 있어 남겨 뒀다.
//   새 소비자는 ui-primitives.ts 에서 직접 받아라 — 이 배럴 몫은 줄어드는 방향으로만 간다.
import { api, el, errorNote, navOn, pageHead, state } from './core.js';
// 관리탭 조각 4개를 **실체 모듈에서 직접** 받는다(#1313 R40). 종전엔 넷 다 './admin.js' 배럴 경유였고,
//  admin.ts 가 review/visibility-axes 를 import 하는 한 그 배럴이 learn 으로 되돌아오는 순환 4건을 만들었다
//  (check-imports 의 ALLOWED_CYCLES 에 'R37/R40 이 나가면 사라진다'로 예약돼 있던 바로 그것).
//  같은 심볼·같은 값이고 경로만 실체로 바꾼다 — 배럴은 옛 소비자를 위해 그대로 남아 있다.
import { deployCommands, installCmd } from './admin-install.js';
import { loadAdmin } from './admin-rerender.js';
// 앱 전역 UI 프리미티브(#1313 R27) — 예전엔 이 파일이 skeleton·overlayBox 를 소유해 18개 파일이 여기서
//  가져갔다(admin 과는 상호 import = 순환). 지금은 ui-primitives 소유이고 아래 export 로 그대로 재수출한다.
import { copyButton, overlayBox, skeleton, skeletonRows } from './ui-primitives.js';
import { isGuideTourDone, isSectionDone, startGuideTour } from './guide-tour.js'; // Lively 둘러보기(#761) — 크로스탭 스포트라이트 투어
import { guideIcon } from './guide/icon.js';   // 그림은 표(lib/icon-paths.ts) 한 벌을 읽는다

// ── 클래식 문서 셸의 머리. 「사용 가이드」로 돌아가는 길 하나만 둔다(문서 목록은 가이드 앱이 그린다). ──
function legacyHeader(): HTMLElement {
  return el('div', { class: 'pjv-board-header lg-board-header' },
    el('div', { class: 'pjv-crumbbar' },
      el('nav', { class: 'pjv-crumbs', 'aria-label': '현재 위치' },
        el('a', { class: 'pjv-crumb is-leaf lg-crumb-leaf', href: '#/learn' }, guideIcon('learn', 'pjv-crumb-ic lg-crumb-ic'), el('span', { class: 'pjv-crumb-label', text: '사용 가이드' })),
        el('span', { class: 'lg-crumb-sub', text: '시작하기' }))));
}

// 문서 셸 — 머리 + 본문. 클래식 「시작하기」(start.ts) · 둘러보기 · 설치 화면이 이 셸 안에서 렌더된다.
//  export: 시그니처(view, active, ...content)는 그대로다. active 는 옛 문서 목록의 강조 키였고 지금은 쓰지 않는다.
export function docsShell(view, _active, ...content) {
  const article = el('article', { class: 'docs-body lg-article' }, ...content);
  view.replaceChildren(el('div', { class: 'pjv-board-wrap lg-wrap' },
    el('div', { class: 'card pjv-listboard lg-board' }, legacyHeader(), el('div', { class: 'lg-body' }, article))));
  document.getElementById('view')!.focus?.();
  try { view.scrollTop = 0; window.scrollTo({ top: 0 }); } catch { /* noop */ }
}

// 페이지 아이브로 — 제목 위에 얹는 한 줄(start.ts 가 같은 함수를 쓴다).
export function docsEyebrow(_key) {
  return el('div', { class: 'docs-eyebrow', text: '시작하기' });
}

// ── Lively 둘러보기(#/learn/tour, #761) — 실제 화면 위 스포트라이트 투어의 랜딩. ──
//  시작만 여기서: 진행은 guide-tour.ts(장면 오케스트레이터)가 상단 탭 클릭 → 라우팅 → 재개로 이어 간다.
//  §0.5 채색 예산: 채운 파란 버튼은 [▶ 둘러보기 시작] 1개뿐 — 코스별 버튼은 ghost.
async function renderLearnTour(view) {
  const head = el('div', { class: 'page-head' },
    el('h1', {}, 'Lively ', el('span', { class: 'accent', text: '둘러보기' })));

  const intro = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '눌러보며 익혀요' })),
    el('p', { class: 'guide-lead', text: '실제 화면 위에서 지금 눌러야 할 곳을 표시하며 한 단계씩 안내합니다. 처음부터 쭉 볼 수도 있고, 아래에서 원하는 섹션만 골라 볼 수도 있습니다. 진행 중 언제든 화면 위 ✕ 버튼이나 ESC 키로 멈출 수 있습니다.' }),
    isGuideTourDone() ? el('p', { class: 'admin-hint', text: '✓ 세 섹션을 모두 봤어요 — 언제든 다시 볼 수 있어요.' }) : null,
    el('div', { class: 'step-cta' },
      el('button', { class: 'btn btn-primary', text: '▶ 처음부터 쭉 보기 (약 3분)', onclick: () => startGuideTour() })),
    el('p', { class: 'admin-hint', style: 'margin:6px 0 0', text: '프로젝트 → 도메인 맵 → WIKI 순서로 진행돼요.' }));

  // 섹션 한 줄(#780) — 골라 들어가는 게 주 동선이라 진입 버튼을 각 줄에 두고, 본 섹션은 ✓ 로 표시한다.
  //  pathStep 과 같은 시각 언어(번호·제목·설명). §0.5 채색 예산: 채운 파란 버튼은 위 '처음부터 쭉 보기' 하나뿐.
  const courseRow = (num, key, title, desc) => el('div', { class: 'guide-path-step' },
    el('div', { class: 'guide-path-num', 'aria-hidden': 'true', text: num }),
    el('div', { class: 'guide-path-body' },
      el('div', { class: 'guide-path-title' }, el('span', { text: title }),
        isSectionDone(key) ? el('span', { class: 'admin-hint', style: 'margin-left:8px;font-weight:400', text: '✓ 봤어요' }) : null),
      el('p', { class: 'guide-path-desc', text: desc }),
      el('button', { class: 'btn btn-sm btn-ghost guide-path-btn', text: '▶ ' + title.split(' — ')[0] + '만 보기', onclick: () => startGuideTour([key]) })));
  // ui_nav 게이팅(#1454 S2) — 꺼진 탭의 섹션 코스는 진입 버튼을 내지 않는다(첫 스텝이 숨은 탭을 짚는
  //  막다른 투어가 된다). nav 매핑: projects→projects2 · domainmap→context(#/categories 는 그리로 리다이렉트) ·
  //  wiki→knowledge. 남은 코스만 번호를 다시 매긴다.
  const courseDefs = [
    { key: 'projects', nav: 'projects2', title: '프로젝트 — 일의 흐름', desc: '회사의 일이 어디서 어떻게 진행되는지: 보드와 리스트, 프로젝트 상세, 그리고 AI에게 전달하는 \'필요지식\'.' },
    { key: 'domainmap', nav: 'context', title: '도메인 맵 — 코드의 구조', desc: '제품 코드가 어떤 도메인 단위로 나뉘어 있는지, 하려던 것(should)과 실제(is)의 대조.' },
    { key: 'wiki', nav: 'knowledge', title: 'WIKI — AI가 읽는 지식', desc: '회사 지식이 어떻게 분류·검색되는지, 지식 한 덩어리와 핀(인덱스)의 의미.' },
  ].filter((c) => navOn(c.nav));
  const courses = courseDefs.length ? el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '섹션만 골라 보기' })),
    el('p', { class: 'guide-lead', text: '급하면 필요한 것만 봐도 돼요. 각 섹션은 따로 시작하고 따로 끝나요.' }),
    el('div', { class: 'guide-path' },
      courseDefs.map((c, i) => courseRow(String(i + 1), c.key, c.title, c.desc)))) : null;

  const extra = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '더 해보기' })),
    el('p', { class: 'admin-hint', text: 'AI 세션을 직접 만들어 첫 대화까지 해보는 실습 가이드는 별도로 있어요.' }),
    el('div', { class: 'step-cta', style: 'margin-bottom:0' },
      el('a', { class: 'btn btn-sm btn-ghost', href: '#/dashboard?tour=1', text: '홈에서 따라하며 만들기 →' }),
      // #762 '#/learn/install' 페이지 숨김 → 같은 설치 화면을 품은 '시작하기'(#/start)로 링크(복원 시 '#/learn/install'·'내 AI 세션 생성'으로 되돌리기).
      el('a', { class: 'btn btn-sm btn-ghost', href: '#/start', text: '내 컴퓨터에 설치하기 — 시작하기 →' })));

  docsShell(view, 'tour', docsEyebrow('tour'), head, el('div', { class: 'guide-cards' }, intro, courses, extra));
}

// 설치 탭(#/install) — 모든 구성원의 첫 행동. 비개발자도 그대로 따라 하도록 구성한다.
//  핵심: 쓰는 곳이 두 갈래라 시작법이 다르다 — (web) 라이블리 [터미널] 탭=서버에서 claude/codex 가 돌고
//  회사맥락이 이미 설치돼 있어 '설치 0' / (local) 내 컴퓨터 터미널=내 머신에 한 번 설치. mode 토글로 분기.
//  게이트웨이 주소는 org 프로필에서(loadAdmin — 비-admin 도 안전: tokens redact).
async function renderInstall(view) {
  // 부제 없음(#780) — 문서 셸의 다른 페이지들과 제목 줄을 맞춘다. 화면 이름은 '내 AI 세션 생성'(사이드바와 동일).
  const head = pageHead('내 AI 세션 생성', null, [], '생성');
  const slot = el('div', { class: 'install-guide' });
  slot.append(skeleton('설치 안내를 준비하는 중'));
  // 설치 후 명령·Claude/Codex 차이·문제 해결은 별도 문서(#/learn/docs/cli)로 분리 — 설치 페이지는 '설치까지'만.
  docsShell(view, 'install', docsEyebrow('install'), head, slot);
  onboardingBanner().then((b) => { if (b) head.before(b); }); // 온보딩 진행 배너(미완 시) — 제목 '위'로 → #/onboarding
  loadAdmin().then((data) => drawInstallGuide(slot, data))
    .catch((e) => slot.replaceChildren(errorNote(e, '설치 안내를 불러오지 못했습니다')));
}

// 설치 화면을 '팝업(모달)'으로 — #/start ② '내 컴퓨터에서도 쓰기'와 '예전 환경 가져오기'에서 호출. 페이지 이동 없이 그 자리에서.
//  #1000: 설치는 모달이 유일 표면이다(옛 전체페이지 #/start/setup 은 폐지 → #/start 리다이렉트). 그래서 '전체보기 ↗' 링크를 없앴다.
//  사이드바 없이 설치 가이드(drawInstallGuide)만 담는다. 프로젝트 상세 팝업(.pjv-pm)과 같은 셸을 재사용한다.
function openInstallModal() {
  const back = el('div', { class: 'pjv-pm-back' });
  const box = el('div', { class: 'pjv-pm' });
  const bodyEl = el('div', { class: 'pjv-pm-body' });
  const closeBtn = el('button', { class: 'pjv-pm-x', type: 'button', title: '닫기 (Esc)', 'aria-label': '닫기', text: '✕' });
  box.append(el('div', { class: 'pjv-pm-head' }, el('b', { class: 'pjv-pm-title', text: '내 컴퓨터에 설치' }), closeBtn), bodyEl);
  back.append(box);

  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('hashchange', close);
    document.body.classList.remove('pjv-pm-open');
    back.remove();
  };
  function onKey(e) { if (e.key === 'Escape' && !document.querySelector('.pjv-pop, .tour-root, .ov-back')) close(); }
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  closeBtn.onclick = (e) => { e.stopPropagation(); close(); };
  document.addEventListener('keydown', onKey, true);
  // 모달엔 사이드바가 없어 라우팅(뒤로가기·딥링크)이 유일한 이탈 경로다 — 해시가 바뀌면 닫아 다음 화면 위에 남지 않게(#1000).
  window.addEventListener('hashchange', close);
  document.body.append(back);
  document.body.classList.add('pjv-pm-open');

  const slot = el('div', { class: 'install-guide' }, skeleton('설치 안내를 준비하는 중'));
  bodyEl.append(slot);
  // 이미 '로컬에서 만들기'로 들어왔으니 상단 '어디서 쓰나' 선택 카드는 숨기고 로컬 설치 가이드만 바로 보여준다(중복 제거).
  loadAdmin().then((data) => drawInstallGuide(slot, data, { noChooser: true }))
    .catch((e) => slot.replaceChildren(errorNote(e, '설치 안내를 불러오지 못했습니다')));
  return close;
}

// 설치 가이드 — 먼저 '어디서 쓰나'(web/local) 를 고르게 하고, 고른 모드의 가이드만 렌더. slot 안만 교체.
//  opts.noChooser — 이미 '로컬'을 고르고 들어온 팝업(openInstallModal)에선 상단 '어디서 쓰나' 선택 카드를 숨기고
//   로컬 가이드만 바로 보여준다(중복 제거). OS 토글 재렌더에도 opts 를 그대로 넘겨 유지한다.
function drawInstallGuide(slot, data, opts?: any) {
  const noChooser = !!(opts && opts.noChooser);
  const gw = (data.profile.gateway_url || window.location.origin).replace(/\/mcp$/, '').replace(/\/$/, '');
  const mode = noChooser ? 'local' : (state.start.mode === 'local' ? 'local' : 'web');

  // ── 어디서 쓰나 — 두 갈래 선택(카드 클릭 시 아래 가이드가 바뀜). 설명은 한 줄만(#780 → 장황함 제거). ──
  const chooser = noChooser ? null : el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '어디서 AI를 쓰실 건가요?' })),
    el('p', { class: 'admin-hint', style: 'margin-bottom:12px' }, '어느 쪽을 골라도 같은 AI에 같은 회사 맥락이 들어갑니다. 고민되면 ',
      el('b', { text: '설치 없이 바로 쓰는 왼쪽' }), ' 으로 시작하세요.'),
    el('div', { class: 'mode-choice' },
      modeCard('web', '라이블리 웹에서 바로', '설치 없이 · 브라우저만', '비개발자 친화', mode, slot, data),
      modeCard('local', '내 컴퓨터에서', '한 번 설치 · 약 5분', '개발자 친화', mode, slot, data)));

  const guide = mode === 'web' ? webGuideNodes() : localGuideNodes(gw, slot, data, opts);
  slot.replaceChildren(...(chooser ? [chooser] : []), ...guide);
}

// 모드 선택 카드(라이블리 웹 vs 내 컴퓨터). 선택 시 재렌더.
//  audience = 카드별 대상 핀(비개발자 친화 / 개발자 친화). '상황' 한 줄(who)은 위 안내와 겹쳐 제거(#780).
function modeCard(key, title, tag, audience, active, slot, data) {
  const on = key === active;
  const pick = () => { if (state.start.mode !== key) { state.start.mode = key; drawInstallGuide(slot, data); } };
  return el('div', {
    class: 'mode-card' + (on ? ' active' : ''), role: 'button', tabindex: '0',
    'aria-pressed': on ? 'true' : 'false',
    onclick: pick,
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } },
  },
    el('span', { class: 'mode-card-radio', 'aria-hidden': 'true' }),
    el('div', { class: 'mode-card-head' },
      el('div', { class: 'mode-card-title', text: title }),
      el('span', { class: 'mode-card-tag', text: tag })),
    el('div', { class: 'mode-card-who' },
      el('span', { class: 'mode-card-who-label', text: audience })));
}

// (web) 라이블리 웹에서 쓰는 사람 — 내 컴퓨터엔 설치 0. AI 는 서버에서 회사맥락을 가진 채 돈다.
//  세션 만들기는 [홈]에서 한다(#780) — 예전엔 터미널 탭으로 보냈으나, 홈의 「내 AI 세션」 카드가 첫 화면이자 상시 진입점.
function webGuideNodes() {
  const callout = el('div', { class: 'card install-callout' },
    el('div', { class: 'callout-strong', text: '내 컴퓨터엔 아무것도 설치하지 않습니다.' }),
    el('p', { class: 'callout-sub', text: 'AI는 라이블리 서버에서 실행되고, 회사 맥락·규칙도 거기에 이미 준비돼 있어요. 브라우저만 있으면 바로 시작할 수 있습니다.' }));

  // 따라하기 투어 — 홈(#/dashboard?tour=1)으로 이동하면서 스포트라이트를 켠다(main.ts → startDashboardSessionTour).
  //  눌러야 할 곳만 밝게 남기고 나머지를 덮은 뒤, 실제 버튼을 직접 누르며 한 단계씩 진행한다.
  //  §0.5 예산: 채운 blue primary 는 이 화면 1개뿐(따라하며 만들기).
  const tourBtn = el('a', {
    class: 'btn btn-primary', href: '#/dashboard?tour=1',
    text: '홈에서 따라하며 만들기 →',
  });
  const newWinBtn = el('a', {
    class: 'btn btn-ghost', href: '#/dashboard?tour=1', target: '_blank', rel: 'noopener',
    text: '새 창으로 열기 ↗',
  });

  const steps = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '홈에서 내 AI 세션 만들기' })),
    el('p', { class: 'admin-hint', text: '아래 버튼을 누르면 홈(대시보드)으로 넘어가면서, 눌러야 할 곳만 밝게 강조해 한 단계씩 짚어주는 “따라하기”가 시작돼요. 화면 속 버튼을 직접 누르며 진행하면 됩니다.' }),
    el('div', { class: 'step-cta' }, tourBtn, newWinBtn),
    // 미리보기 — 따라하기가 짚어줄 순서. JS 안내가 안 떠도 흐름을 알 수 있게 남겨 둔다(폴백).
    el('div', { class: 'step-list' },
      installStep(1, '홈에서 [+ 새 세션] 누르기',
        el('p', { class: 'step-p' }, '홈 가운데 ', el('b', { text: '「내 AI 세션」' }), ' 카드에서 ',
          el('b', { text: '[+ 새 세션]' }), ' 을 누르면 만들기 창이 홈 화면 위에 바로 열려요.')),
      installStep(2, '작업 폴더와 AI를 고르고 이름 정하기',
        el('p', { class: 'step-p' }, '작업 폴더(', el('b', { text: '공유 워크스페이스' }), ' 또는 ', el('b', { text: '개인 폴더' }),
          '), 사용할 AI(', el('b', { text: 'Claude Code' }), ' 또는 ', el('b', { text: 'Codex' }), '), 세션 이름을 정하세요.'),
        el('p', { class: 'step-note', text: '잘 모르겠으면 — 작업 폴더는 [개인 폴더], AI는 [Claude Code]를 그대로 두면 됩니다.' })),
      installStep(3, '[생성하기] → 바로 요청 입력하기',
        el('p', { class: 'step-p', text: '[생성하기]를 누르면 새 탭에 세션 창이 열려요. 거기에 요청할 내용을 입력하면 됩니다 — 회사 맥락·규칙은 이미 들어가 있어요.' }),
        el('p', { class: 'step-note', text: '세션은 창을 닫아도 서버에 남아 있어요. 다음에 홈의 「내 AI 세션」에서 [열기]로 이어서 쓰면 됩니다.' }))));

  return [callout, steps];
}

// (local) 내 컴퓨터 터미널에서 쓰는 사람 — 내 머신에 한 번 설치. OS 토글로 단계가 바뀐다.
function localGuideNodes(gw, slot, data, opts?: any) {
  const os = state.start.os === 'windows' ? 'windows' : 'mac';
  const isWin = os === 'windows';

  const callout = el('div', { class: 'card install-callout' },
    el('div', { class: 'callout-strong', text: '내 컴퓨터에 한 번 설치합니다 (약 5분).' }),
    el('p', { class: 'callout-sub', text: '설치하면 내 노트북에서 claude(또는 codex)를 켤 때마다 회사 맥락이 자동으로 들어와요. 처음 딱 한 번만 하면 끝입니다.' }));

  // ── 준비물 — 대부분 이미 있음. 막히기 쉬운 node 는 확인법까지 명시(없으면 hooks 미설치=조용한 반쪽설치). ──
  const needs = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '준비물 (잠깐 확인)' })),
    el('p', { class: 'admin-hint', text: '아래만 있으면 됩니다. 대부분 이미 갖춰져 있어요.' }),
    checklist([
      ['내 컴퓨터 (Mac 또는 Windows)', '회사에서 쓰는 본인 노트북이면 됩니다.'],
      ['명령 입력 창', isWin ? 'Windows 에 기본으로 들어 있는 PowerShell 을 씁니다. 여는 법은 아래 1단계에서 알려드립니다.'
        : 'macOS 에 기본으로 들어 있는 ‘터미널’ 앱을 씁니다. 여는 법은 아래 1단계에서 알려드립니다.'],
      ['Node.js — 없어도 됩니다', '이미 있으면 그대로 쓰고, 없으면 설치기가 관리자 권한 없이 알아서 준비해요. 따로 받아 둘 필요가 없습니다.'],
      ['회사 계정', '설치 마지막에 회사 계정으로 로그인하는 브라우저 창이 한 번 뜹니다.'],
    ]));

  // ── 2. 단계 — OS 토글을 카드 헤더에 두고, 단계 본문이 OS 에 맞게 바뀐다 ──
  const osTabs = el('div', { class: 'os-tabs' },
    ...[['mac', 'macOS'], ['windows', 'Windows']].map(([o, label]) => el('button', {
      class: 'btn btn-sm ' + (o === os ? 'btn-primary' : 'btn-ghost'), text: label,
      onclick: () => { if (state.start.os !== o) { state.start.os = o; drawInstallGuide(slot, data, opts); } } })));

  // 1단계 — 명령 입력 창 열기. (여기서 말하는 '터미널'은 macOS 에 들어 있는 앱 이름이다. 제품의 AI 세션과는 다른 것.)
  const term = isWin
    ? installStep(1, '명령 입력 창(PowerShell) 열기',
        el('p', { class: 'step-p' }, '화면 왼쪽 아래 ', kbd('시작'), ' 버튼을 누르고 ',
          kbd('powershell'), ' 라고 입력 → 목록에서 ', el('b', { text: 'Windows PowerShell' }), ' 을 클릭하세요.'),
        el('p', { class: 'step-note', text: '파란색 글자 입력 창이 하나 뜹니다. 이게 명령을 붙여넣을 곳이에요.' }))
    : installStep(1, '명령 입력 창(터미널 앱) 열기',
        el('p', { class: 'step-p' }, '키보드에서 ', kbd('⌘'), ' + ', kbd('스페이스바'),
          ' 를 동시에 눌러 검색창을 띄우고, ', kbd('터미널'), ' 이라고 입력한 뒤 ', kbd('Enter'), ' 를 누르세요.'),
        el('p', { class: 'step-note', text: '글자만 있는 작은 창이 하나 뜹니다. macOS 에 기본으로 들어 있는 앱이고, 여기에 명령을 붙여넣게 됩니다.' }));

  // 2단계 — 설치 명령 붙여넣기 → **브라우저 승인**. #880 부터 토큰을 복붙하지 않는다(명령줄·프롬프트 어디에도).
  //  설치 중 브라우저 승인 창이 열리고, 승인하면 터미널이 로그인을 이어받는다.
  const run = installStep(2, '설치 명령 붙여넣고 승인하기',
    el('p', { class: 'step-p' }, '1단계에서 연 창을 클릭한 다음, 아래 명령을 복사해 붙여넣고(',
      isWin ? kbd('Ctrl') : kbd('⌘'), ' + ', kbd('V'), ') ', kbd('Enter'), ' 를 누르세요.'),
    cmdLine(installCmd(gw, os)),
    el('p', { class: 'step-note', text: '토큰을 다룰 필요가 없어요 — 그냥 붙여넣으면 됩니다. 도중에 이런 게 나와요:' }),
    el('ul', { class: 'step-ul' },
      el('li', {}, el('b', { text: '라이블리 승인 창' }), ' 이 자동으로 열려요(회사 계정). ',
        '터미널에 표시된 ', el('b', { text: '코드가 같은지 확인' }), ' 하고 ', el('b', { text: '[승인]' }), ' 을 누르세요. ',
        el('span', { class: 'step-note-inline', text: '(안 열리면 터미널에 뜬 주소를 직접 여세요.)' })),
      el('li', {}, 'Claude Code 가 없으면 ', el('b', { text: '“지금 설치할까요?”' }), ' → ', kbd('Y'), ' ', kbd('Enter'), '.'),
      el('li', {}, '터미널로 돌아오면 ', el('b', { text: '“…로 로그인됩니다. 계속?”' }), ' 이 떠요 → 본인 계정이 맞으면 ', kbd('Y'), '.'),
      el('li', {}, el('b', { text: '“=== 끝! ===”' }), ' 이 보이면 설치가 끝난 거예요.')),
    el('p', { class: 'step-note' }, '※ ', el('b', { text: 'Claude Code(Anthropic 계정) 로그인' }),
      ' 창은 나중에 ', el('b', { text: '처음 claude 를 켤 때' }), ' 따로 떠요 — 위 라이블리 승인과는 다른 계정·다른 시점입니다.'));

  const verify = installStep(3, '잘 됐는지 확인하기',
    el('p', { class: 'step-p' }, '같은 창에 아래를 입력하고 ', kbd('Enter'), ' 를 누르세요.'),
    cmdLine('lively status'),
    el('p', { class: 'step-note' }, '게이트웨이 ', el('b', { text: '도달 OK' }), ' · 내 이름 · ',
      el('b', { text: 'MCP 등록 ✓' }), ' 가 보이면 성공이에요. ',
      '이제 어느 폴더에서든 ', el('code', { class: 'md-code', text: 'claude' }), ' 를 켜면 회사 맥락이 따라옵니다. ',
      '(자동 주입은 ', el('b', { text: '다음 세션부터' }), ' 적용됩니다.)'),
    el('p', { class: 'step-note' }, '뭔가 이상하면 ', el('code', { class: 'md-code', text: 'lively doctor' }),
      ' — 무엇이 잘못됐고 어떻게 고치는지 알려 줍니다.'));

  // 고급 · CI — 자동화(스크립트·프로비저닝)는 브라우저 승인 대신 토큰을 직접 쓴다(`lively login --token`).
  //  일반 사용자는 볼 일 없으니 접어 둔다(#880: mint 는 더 이상 기본 흐름이 아니다).
  const advanced = el('details', { class: 'install-maint' },
    el('summary', { text: '＋ 고급: CI·자동화용 토큰 발급 (일반 설치엔 필요 없어요)' }),
    el('p', { class: 'admin-hint', text: '스크립트·서버처럼 브라우저를 못 여는 곳에서는 토큰을 직접 씁니다: lively login --token <토큰>. 아래에서 본인 토큰을 발급하세요(비밀번호처럼 취급 — 공유 금지).' }),
    tokenMintBox());

  const steps = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', { text: '설치 단계' }),
      el('div', { class: 'os-pick' }, el('span', { class: 'os-pick-label', text: '내 컴퓨터' }), osTabs)),
    isWin ? el('p', { class: 'admin-warn', text: '⚠ Windows 설치는 아직 검증이 충분치 않습니다. 막히면 관리자에게 알려주세요.' }) : null,
    el('div', { class: 'step-list' }, term, run, verify),
    advanced);

  // ── 3. 끝났어요 — 이제 뭘 하나 ──
  const next = el('div', { class: 'card install-next' },
    el('div', { class: 'card-head' }, el('h2', { text: '끝났어요 — 이제 뭘 하나요' })),
    el('p', { class: 'guide-lead', text: '설치가 끝나면 평소처럼 Claude Code 를 켜서 일하면 됩니다. 어느 폴더에서 켜든 회사 공통 맥락·규칙이 자동으로 함께 들어가요. 매번 회사 사정을 설명하지 않아도 됩니다.' }),
    el('p', { class: 'admin-hint' }, '내 컴퓨터에서 켜든 웹에서 켜든 같은 회사 맥락을 씁니다 — 웹에서 열고 싶으면 ',
      el('a', { href: '#/dashboard', text: '[홈]' }), ' 의 「내 AI 세션」에서 [+ 새 세션]을 누르세요. 회사에 어떤 맥락이 쌓여 있는지는 ',
      el('a', { href: '#/knowledge', text: '[WIKI]' }), ' 에서 볼 수 있어요.'),
    el('p', { class: 'admin-hint' }, '예전에 쓰던 AI 환경(작업 메모·직접 만든 스킬 등)이 있다면 ',
      el('a', { href: '#/start/migrate', text: '[예전 환경 가져오기]' }), ' — 켜서 ',
      el('code', { class: 'md-code', text: '온보딩 도와줘' }), ' 라고 말하면(또는 ',
      el('code', { class: 'md-code', text: 'lively onboarding' }), ') AI 가 읽어서 정리를 도와줍니다. 원본은 건드리지 않아요.'),
    // 노드 연결은 설치·로그인과 **다른 단계**다. 여기서 말하지 않으면, 설치를 마친 사람이 [내 컴퓨터] 에
    //  자기 기계가 없는 것을 보고 연결이 실패했다고 읽는다 — 실제로는 아무도 시키지 않은 명령이 남은 것이다.
    el('p', { class: 'admin-hint' }, '이 컴퓨터를 웹에서 열고 싶으면(세션 열기·작업 위탁) 한 줄이 더 필요해요 — ',
      el('code', { class: 'md-code', text: 'lively node --daemon' }), ' 을 실행하면 ',
      el('a', { href: '#/system/me-nodes', text: '[내 컴퓨터]' }), ' 목록에 나타납니다. 자세한 건 ',
      el('a', { href: '#/learn/docs/nodes', text: '[내 컴퓨터 연결]' }), ' 에 있어요.'),
    el('p', { class: 'admin-hint', style: 'margin-bottom:0' }, '설치 후 쓸 수 있는 ',
      el('code', { class: 'md-code', text: 'lively' }), ' 명령 · Claude/Codex 차이 · 문제 해결은 ',
      el('a', { href: '#/learn/docs/cli', text: '[AI 세션 명령어]' }), ' 에서 보세요.'));

  // ── 4. 유지보수(접힘) — 업데이트는 이제 자동이라 평소엔 볼 일이 없다(#858). 제거·강제갱신용. ──
  const staticBlock = (c) => el('div', { class: 'deploy-block' },
    el('div', { class: 'deploy-head' }, el('h3', { text: c.title }),
      c.cmd !== '(준비 중)' ? copyButton(() => c.cmd, '복사') : null),
    el('p', { class: 'admin-hint', text: c.note }),
    el('pre', { class: 'admin-preview', text: c.cmd }));
  const auto = el('p', { class: 'admin-hint' },
    el('b', { text: '업데이트는 자동입니다. ' }),
    'Claude Code(또는 Codex)를 켤 때마다 라이블리가 최신인지 확인하고, 다르면 백그라운드로 받아 설치합니다 — ',
    el('b', { text: '다음에 켤 때부터' }), ' 적용돼요(작업 중인 세션은 방해하지 않습니다). 아래 명령은 ',
    el('b', { text: '자동 업데이트를 껐거나, 지금 당장 맞춰야 할 때' }), '만 쓰면 됩니다.');
  // 설치 후 쓸 수 있는 명령들 — 유지보수 패널을 열었다는 건 "뭔가 손봐야 한다"는 뜻이니 doctor 를 가장 먼저 보여준다.
  const cheats = el('div', { class: 'deploy-block' },
    el('h3', { text: '알아 두면 좋은 명령' }),
    el('p', { class: 'admin-hint', text: '설치가 끝나면 터미널에서 `lively` 를 쓸 수 있어요.' }),
    el('div', { class: 'step-list' },
      cmdLine('lively doctor'), el('p', { class: 'step-note', text: '뭐가 잘못됐는지 + 어떻게 고치는지 알려 줍니다. 문제가 생기면 이것부터.' }),
      cmdLine('lively status'), el('p', { class: 'step-note', text: '지금 설치 상태 · 버전 · MCP 등록 여부.' }),
      cmdLine('lively run 123'), el('p', { class: 'step-note', text: '프로젝트를 내 PC 에서 열기(프로젝트 번호). 프로젝트 화면의 [💻 내 PC에서 열기] 가 만들어 주는 명령과 같습니다.' })));
  const maint = el('details', { class: 'install-maint' },
    el('summary', { text: '＋ 나중에 필요할 때: 명령어 · 업데이트 · 제거 (지금은 안 봐도 됩니다)' }),
    cheats,
    auto,
    ...deployCommands(gw, os).filter((c) => c.kind !== 'install').map(staticBlock));

  return [callout, needs, steps, next, maint];
}

// 번호 매긴 설치 단계 한 칸.
function installStep(n, title, ...body) {
  return el('div', { class: 'step' },
    el('div', { class: 'step-num', 'aria-hidden': 'true', text: String(n) }),
    el('div', { class: 'step-body' },
      el('div', { class: 'step-title', text: title }),
      ...body));
}

// 접속 토큰 셀프 발급 (#864) — 로그인된 본인이 [내 토큰 발급] 한 번으로 본인 토큰을 받는다.
//  종전(installSelfCmdBox)은 이 토큰을 **설치 명령줄에 구워** 건넸다 → 복붙하면 ~/.zsh_history 에 평문으로 영구히 남았다.
//  이제는 토큰만 건네고, 설치 명령(3단계)은 토큰 없는 정적 한 줄이다. 토큰은 CLI 의 가림 프롬프트에 붙여넣는다.
//  (그래서 이 함수는 OS 를 몰라도 된다 — 토큰은 mac/win 이 같다.)
function tokenMintBox() {
  const result = el('div', { class: 'install-cmd-slot' });
  // #632: admin/runtime 보유자만 — 관리 권한을 이 토큰에 실을지 opt-in(기본 off). 멤버 scope 가 상한(증폭 불가).
  //  (state.me.scopes = 현재 세션 유효 scope — admin.ts hasScope 와 동일 판정.)
  const canCp = !!(state.me && Array.isArray(state.me.scopes) && (state.me.scopes.includes('admin') || state.me.scopes.includes('runtime')));
  const cpChk = el('input', { type: 'checkbox', style: 'margin-right:6px;vertical-align:middle' });
  const cpLabel = canCp ? el('label', { class: 'caption', style: 'display:block;margin:6px 0;cursor:pointer' },
    cpChk, el('span', { text: '관리 권한(admin/runtime) 포함 — 이 토큰으로 설치한 로컬 세션이 관리탭 기능(구성원·토큰·훅·DB소스)을 MCP로 직접 다룹니다. 변경은 감사에 AI로 남습니다.' })) : null;
  const go = el('button', { class: 'btn btn-primary btn-sm', text: '내 토큰 발급' });
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const r = await api('/api/ui/org/token/self', { method: 'POST', body: JSON.stringify({ includeControlPlane: canCp && cpChk.checked }) });
      result.replaceChildren(
        el('p', { class: 'install-ok', text: '✓ 토큰이 발급됐어요 — [토큰 복사]를 누른 뒤 3단계로 가세요.' }),
        el('div', { class: 'deploy-head' }, el('span', { class: 'mini-meta', text: '내 접속 토큰' }), copyButton(() => r.token, '토큰 복사')),
        el('pre', { class: 'admin-preview', text: r.token }),
        el('p', { class: 'admin-hint', text: '⚠ 지금 이 화면에서만 보여요 — 닫으면 다시 볼 수 없습니다(잃어버리면 다시 발급하면 됩니다).' }));
    } catch (e) {
      result.replaceChildren(el('p', { class: 'install-token-err', text: '발급 실패 — ' + e.message }));
    }
    go.disabled = false;
  });
  return el('div', {}, cpLabel, el('div', { class: 'install-minter' }, go), result);
}

// 복사 가능한 한 줄 명령(확인용 등 — 토큰 없는 짧은 명령).
function cmdLine(cmd) {
  return el('div', { class: 'cmd-line' },
    el('code', { class: 'cmd-line-text', text: cmd }),
    copyButton(() => cmd, '복사'));
}

// 키캡(키보드 키·메뉴 항목 강조) — 비개발자용 시각 힌트.
function kbd(label) { return el('span', { class: 'kbd', text: label }); }

// 준비물 체크리스트.
function checklist(items) {
  const wrap = el('div', { class: 'install-checks' });
  for (const [k, v] of items) {
    wrap.append(el('div', { class: 'install-check' },
      el('span', { class: 'check-mark', 'aria-hidden': 'true', text: '✓' }),
      el('div', { class: 'check-main' },
        el('div', { class: 'check-k', text: k }),
        el('div', { class: 'check-v', text: v }))));
  }
  return wrap;
}

// ── 온보딩 진행상황(#/onboarding) — SoT = GET /api/ui/org/onboarding (하네스 주입과 동일 소스, 드리프트 0). ──
function obProgress(pct) {
  return el('div', { style: 'height:8px;background:var(--line-row);border-radius:4px;overflow:hidden;margin:10px 0' },
    el('div', { style: `height:100%;width:${pct}%;background:var(--ok-2);transition:width .3s` }));
}
// 시작하기(랜딩) 상단 배너 — 미완일 때만(완료면 null → 안 보임). 클릭 시 #/onboarding.
async function onboardingBanner() {
  try {
    const s = await api('/api/ui/org/onboarding');
    if (!s || s.complete) return null;
    return el('a', { class: 'card', href: '#/onboarding', style: 'display:block;text-decoration:none;color:inherit' },
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:12px' },
        el('strong', { text: `온보딩 진행 ${s.done}/${s.total} (${s.pct}%)` }),
        el('span', { class: 'accent', text: '진행상황 보기 →' })),
      obProgress(s.pct),
      el('p', { class: 'admin-hint', style: 'margin:0', text: '남은 단계를 채우면 AI 세션이 그만큼 더 풍부한 회사 맥락으로 시작합니다(재설치 불필요).' }));
  } catch { return null; }
}
// 전용 페이지 — 단계별 완료 여부 + 진행률. AI(세션 시작)도 같은 SoT 를 받는다는 점을 명시.
async function renderOnboarding(view) {
  const head = el('div', { class: 'page-head' },
    el('h1', {}, '온보딩 ', el('span', { class: 'accent', text: '진행상황' })),
    el('p', { class: 'sub', text: '이 인스턴스 셋업이 어디까지 됐는지 한눈에 봅니다. 진행률은 필수 항목만으로 셉니다 — 「선택」은 해당하는 조직만 하면 됩니다.' }));
  const slot = el('div', {});
  slot.append(skeleton('진행상황을 불러오는 중'));
  view.replaceChildren(head, slot);
  document.getElementById('view')!.focus?.();
  try {
    const s = await api('/api/ui/org/onboarding');
    const summary = el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', { text: `진행률 ${s.done}/${s.total} (${s.pct}%)` })),
      obProgress(s.pct),
      el('p', { class: 'admin-hint', style: 'margin:0', text: s.complete
        ? '✓ 필수 셋업 완료.'
        : '남은 필수 항목을 채우면 AI가 그만큼 더 풍부한 회사 맥락으로 시작합니다(재설치 불필요 — 라이브 반영).' }));
    const steps = el('div', {});
    s.items.forEach((it, i) => {
      // 선택 항목은 **미완이어도 경고처럼 보이면 안 된다** — 진행률에서 빠지는데 화면만 빨갛게 남으면
      //  "뭔가 덜 됐다"는 잘못된 압박이 된다. 번호 대신 '—', 배지로 '선택'을 명시한다.
      steps.append(el('div', { class: 'card', style: 'display:flex;gap:12px;align-items:flex-start;margin-bottom:10px;opacity:' + (it.done || it.optional ? '0.65' : '1') },
        el('div', { style: `flex:0 0 28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--on-fill);background:${it.done ? 'var(--ok-2)' : it.optional ? 'var(--muted-3)' : 'var(--muted-2)'}`, text: it.done ? '✓' : it.optional ? '–' : String(i + 1) }),
        el('div', { style: 'flex:1;min-width:0' },
          el('div', { style: 'font-weight:600' }, it.label,
            it.optional ? el('span', { class: 'admin-only-badge', style: 'margin-left:6px', text: '선택' }) : null,
            it.count !== undefined ? el('span', { class: 'admin-hint', text: ` · 현재 ${it.count}` }) : null),
          el('div', { class: 'admin-hint', style: 'margin:2px 0 0', text: it.how }),
          it.href ? el('a', { class: 'accent', href: it.href, text: it.done ? '보기 →' : '바로가기 →', style: 'display:inline-block;margin-top:6px;text-decoration:none' }) : null)));
    });
    slot.replaceChildren(summary, steps);
  } catch (e) {
    slot.replaceChildren(errorNote(e, '온보딩 진행상황을 불러오지 못했습니다'));
  }
}

export {
  checklist,
  openInstallModal,
  overlayBox,
  renderInstall,
  renderLearnTour,
  renderOnboarding,
  skeleton,
  skeletonRows,
};
