// 사용 가이드 «라이블리 동작원리» 영상(guide)의 «제품 화면» 두 장을 만든다.
//   guide-app.gen.html  — 셸: 레일 · 위키 곁칸(분류 나무) · 홈 · 세션(터미널 + 곁칸 콘솔) · 앱 찾기
//   guide-page.gen.html — 앱 프레임 안의 클래식 화면: 수집 · 증류(실시간 현황 · 수집기 설정 · 증류기 설정 · AI 주입기 설정) · WIKI 문서
//  그리지 않는다 — 제품의 스타일시트를 걸고 제품이 세우는 DOM(클래스 이름 그대로)을 밝은 테마 · 예시 데이터로 세운다.
//  예시 팀은 둘러보기 영상과 같다(지원님 · 영업팀 · 제안서 · 3단계 요금제).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { here, LINKS, SHEETS, FREEZE, SHELL_CSS, ic, railIc, lineIc, gi, logo, livIc, livMark, GEAR, ctxHeader, flowMap, runsCard, CTX_ROOM } from './gen-common.mjs';

const MONITOR = 'M3 5h18v11H3z M8 20h8 M12 16v4';
const sw = (on) => `<input type="checkbox" class="cxc-sw" role="switch"${on ? ' checked' : ''}>`;

// ════════════════════════════════════════════════════════════════════════════
//  수집기 설정(web/context-collectors.ts 가 세우는 DOM)
// ════════════════════════════════════════════════════════════════════════════
const colRow = (id, svc, brand, name, kind, every, last) => `<div class="cxc-row liv-row" data-f="${id}"><span class="svc-tile cxc-tile" data-svc="${svc}" style="--svc-brand:${brand}">${logo(svc)}</span><div class="cxc-main"><div class="cxc-t"><span class="cxc-name">${name}</span><span class="cxc-state is-on"><span class="cxc-state-dot" aria-hidden="true"></span><span>켜짐</span></span></div><div class="cxc-m"><span class="cxc-kind">${kind}</span>${livMark}<span class="cxc-sep" aria-hidden="true">·</span><span>${every}</span><span class="cxc-sep" aria-hidden="true">·</span><span class="cxc-last" data-f="${id}Last">${last}</span></div></div><div class="cxc-acts">${sw(true)}<button class="btn btn-ghost btn-sm cxc-hist-b" type="button">기록<svg class="cxc-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg></button><button class="btn btn-ghost btn-sm" type="button">지금 수집</button><button class="btn btn-ghost btn-sm" type="button">설정</button></div></div>`;
const lastTx = (t, n, mo) => `마지막 ${t} · 새 자료 <b class="num">${n}</b> · 바뀐 자료 <b class="num is-u">${mo}</b>`;
const SOURCES = `<div class="ctx-stacked"><div class="cxc">
  <div class="cxc-head"><div class="cxc-head-main"><h3 class="cxc-title"><span>수집기 설정</span><span class="cxc-title-n num">수집기 4개</span><span class="liv-sum">${livIc()}<span><b class="num">4개 모두</b> 리브가 세팅했어요</span></span></h3><p class="cxc-lead">외부 앱을 연결하면 리브가 수집기를 자동으로 만들어 둡니다. 직접 만드는 것은 토큰을 손으로 넣어 붙일 때뿐입니다.</p></div><div class="cxc-head-acts"><button class="btn btn-primary" type="button">+ 수집기 만들기</button></div></div>
  <div class="cxc-list">
    <div class="cxc-row cxc-row-local" data-f="colLocal"><span class="svc-tile cxc-tile cxc-tile-local" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${MONITOR}"></path></svg></span><div class="cxc-main"><div class="cxc-t"><span class="cxc-name">내 컴퓨터</span><span class="cxc-state is-on"><span class="cxc-state-dot" aria-hidden="true"></span><span>올리는 순간 수집</span></span></div><div class="cxc-m" data-f="colLocalN">자료 412건 · 마지막 접수 3분 전</div><div class="cxc-m">올린 폴더 3개 — 제안서 18건 · 계약서 9건 · 영업회의 14건</div></div></div>
    ${colRow('colSlack', 'slack', '#4A154B', 'Slack — 영업팀 채널', 'Slack 수집기', '5분마다 자동 수집', lastTx('15:58', 3, 1))}
    ${colRow('colNotion', 'notion', '#191919', 'Notion — 팀 문서', 'Notion 수집기', '10분마다 자동 수집', lastTx('15:52', 0, 2))}
    ${colRow('colGit', 'github', '#181717', 'GitHub — 제품 저장소의 이슈·PR', 'GitHub 수집기', '10분마다 자동 수집', lastTx('15:50', 1, 0))}
  </div>
</div></div>`;

// ════════════════════════════════════════════════════════════════════════════
//  증류기 설정(web/distillers.ts 가 세우는 DOM)
// ════════════════════════════════════════════════════════════════════════════
const ARR = '<svg class="dsl-arr" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>';
const chips = (xs) => `<div class="dsl-chips">${xs.map(([t, c]) => `<span class="dsl-chip${c ? ' ' + c : ''}">${t}</span>`).join('')}</div>`;
const dslCard = (id, svc, brand, name, desc, kind, last, read, unread, crit, dest, destDefault, unit) => `<article class="dsl-card liv-card" data-f="${id}">
  <div class="dsl-head"><span class="dsl-faces"><span class="svc-tile cxc-tile" data-svc="${svc}" style="--svc-brand:${brand}">${logo(svc)}</span></span>
    <div class="cxc-main"><div class="cxc-t"><a class="cxc-name">${name}</a><span class="cxc-state is-on"><span class="cxc-state-dot" aria-hidden="true"></span><span>켜짐</span></span></div><p class="cxc-desc">${desc}</p>
      <div class="cxc-m"><span class="cxc-kind">${kind}</span>${livMark}<span class="cxc-sep" aria-hidden="true">·</span><span class="cxc-last" data-f="${id}Last">${last}</span></div></div>
    <div class="cxc-acts">${sw(true)}<a class="btn btn-ghost btn-sm">설정</a></div></div>
  <div class="dsl-flow">
    <div class="dsl-st" data-f="${id}Read"><span class="dsl-st-k">읽는 곳</span><div class="dsl-st-b">${chips(read)}</div><div class="dsl-st-f"><span><b class="num">${unread}건</b> <span>아직 읽지 않음</span></span></div></div>
    <span class="dsl-wire is-flow">${ARR}</span>
    <div class="dsl-st" data-f="${id}Crit"><span class="dsl-st-k">남길 기준</span><div class="dsl-st-b"><p class="dsl-crit">${crit}</p></div><div class="dsl-st-f"><span>읽은 것을 전부 AI가 판단합니다</span></div></div>
    <span class="dsl-wire is-flow">${ARR}</span>
    <div class="dsl-st" data-f="${id}Dest"><span class="dsl-st-k">지식이 가는 곳</span><div class="dsl-st-b"><div><p class="dsl-dest${destDefault ? ' is-default' : ''}">${dest}</p></div></div><div class="dsl-st-f"><span>${unit}</span></div></div>
  </div>
</article>`;
const DISTILL = `<div class="ctx-stacked"><div class="cxc dsl">
  <div class="cxc-head"><div class="cxc-head-main"><h3 class="cxc-title"><span>증류기 설정</span><span class="cxc-title-n num">증류기 3개</span><span class="liv-sum">${livIc()}<span><b class="num">3개 모두</b> 리브가 세팅했어요</span></span></h3><p class="cxc-lead">증류기는 쌓인 자료를 읽고 남길 가치가 있는 것만 지식으로 씁니다. 자료 하나는 증류기 하나만 읽습니다. 위에서부터 조건에 맞는 첫 증류기가 읽고, 어느 것에도 맞지 않는 자료는 맨 아래 「안전망」이 읽습니다.</p></div><div class="cxc-head-acts"><a class="btn btn-primary">+ 자료 증류기 만들기</a></div></div>
  <div class="dsl-stats"><div class="dsl-stat"><b class="dsl-stat-n num">3 / 3</b><span class="dsl-stat-l">켜진 증류기</span></div><div class="dsl-stat"><b class="dsl-stat-n num">12건</b><span class="dsl-stat-l">아직 읽지 않은 자료</span></div><div class="dsl-stat is-ok"><b class="dsl-stat-n num">0건</b><span class="dsl-stat-l">맡은 증류기가 없는 자료</span></div></div>
  <p class="cxc-sub cxc-group-t"><span>돌고 있는 자료 증류기</span><span class="cxc-title-n num">3</span></p>
  <div class="dsl-cards">
    ${dslCard('dsl1', 'slack', '#4A154B', '영업팀 슬랙 대화 → 영업', '가격 · 계약 · 고객 요청이 오간 스레드만', '슬랙 증류기',
      '오늘 8회 · 새 지식 <b class="num">2</b> · 고침 <b class="num is-u">5</b>',
      [['#영업'], ['#고객-문의'], ['빼는 채널 1', 'is-ex'], ['봇 제외', 'is-ex']], 3,
      '판정 단위 — 스레드 하나가 한 건이다. 가격 · 할인 · 계약 조건이 정해졌거나 바뀐 것, 고객이 요청하거나 거절한 것만 남긴다. 인사 · 잡담 · 일정 조율은 버린다.',
      '영업', false, '대화를 묶어 하나로')}
    ${dslCard('dsl2', 'notion', '#191919', '팀 문서 → 주제별', '회의록 · 결정 문서', '노션 증류기',
      '오늘 3회 · 새 지식 <b class="num">1</b> · 고침 <b class="num is-u">2</b>',
      [['모든 페이지', 'is-all'], ['빼는 페이지 2', 'is-ex']], 0,
      '판정 단위 — 페이지 하나가 한 건이다. 회의록에서는 정한 것과 할 일만, 결정 문서에서는 결론과 그 근거만 남긴다.',
      'AI가 내용에 맞는 카테고리를 고릅니다', true, '페이지마다 하나')}
  </div>
</div></div>`;

// ════════════════════════════════════════════════════════════════════════════
//  AI 주입기 설정 › 세션 시작(web/context-deliver.ts 가 세우는 DOM)
// ════════════════════════════════════════════════════════════════════════════
const dnav = (id, t, m, on, cls = '') => `<a class="dlv-nav-i${cls}" data-f="${id}"><span class="dlv-dot${on ? ' on' : ''}"></span><span class="dlv-nav-b"><span class="dlv-nav-t">${t}</span><span class="dlv-nav-m">${m}</span></span></a>`;
const DELIVER = `<div class="dlv">
  <nav class="dlv-nav" aria-label="AI 주입기 설정">
    <div class="dlv-nav-g" data-f="dnInject"><div class="dlv-nav-h">세션 주입</div>
      ${dnav('dnStart', '세션 시작', '켜짐 · 문서 2 · 훅 4', true, ' on flow')}
      ${dnav('dnWork', '작업 중', '켜짐 · 훅 6', true, ' flow')}
      ${dnav('dnStop', '세션 종료', '켜짐 · 훅 2', true, ' flow')}
      ${dnav('dnKit', '키트 자동 업데이트', '켜짐', true)}
      ${dnav('dnEtc', '기타 이벤트', '훅 1', false)}
    </div>
    <div class="dlv-nav-g" data-f="dnTools"><div class="dlv-nav-h">MCP 도구</div>
      ${dnav('dnBuiltin', '기본 제공 도구', '120 / 124', false)}
      ${dnav('dnApi', '사내 API 도구', '3', false)}
      ${dnav('dnMcp', '외부 도구 서버', '켜짐 1', false)}
    </div>
    <div class="dlv-nav-g" data-f="dnSearch"><div class="dlv-nav-h">검색 · 공개범위</div>
      ${dnav('dnSem', '의미 검색', '켜짐', true)}
      ${dnav('dnAccess', '공개범위', '맥락 5/5 · 자료 규칙 0', false)}
    </div>
  </nav>
  <div class="dlv-panel"><div class="dlv-page">
    <div class="dlv-ph"><div class="dlv-ph-main"><h3 class="dlv-ph-t"><span>세션 시작</span><code class="dlv-ev">SessionStart</code></h3><p class="dlv-ph-hint">세션이 열릴 때 조직 헤더 다음에 아래 문서들을 순서대로 넣습니다.</p></div><div class="dlv-ph-right"><label class="dlv-sw">${sw(true)}<span class="dlv-sw-w">켜짐</span></label></div></div>
    <div class="dlv-col">
      <section class="dlv-box" data-f="dlvDocs"><h4 class="dlv-box-h"><span>주입 문서</span><span class="dlv-n">2</span></h4><div class="dlv-list">
        <div class="dlv-row dlv-row-auto"><span class="dlv-row-n">0</span><div class="dlv-row-b"><div class="dlv-row-t">조직 헤더</div><div class="dlv-row-s">조직 이름 · 지금 접속한 사람 — 자동으로 맨 앞에 붙습니다.</div></div></div>
        <div class="dlv-row"><span class="dlv-row-n">1</span><div class="dlv-row-b"><div class="dlv-row-t"><span>org-defaults</span></div><div class="dlv-row-s">회사 배경 + 항상 지킬 규칙 + AI 말투 (회사 소개·규칙·성격)</div></div><div class="dlv-row-a"><button class="dlv-ib" type="button">↑</button><button class="dlv-ib" type="button">↓</button><button class="btn btn-text" type="button">편집</button><button class="btn btn-text btn-text-danger" type="button">삭제</button></div></div>
        <div class="dlv-row"><span class="dlv-row-n">2</span><div class="dlv-row-b"><div class="dlv-row-t"><span>context-ontology-guide</span><span class="pill">제품 소유</span></div><div class="dlv-row-s">AI 가 라이블리(맥락·카테고리·프로젝트·지식) 쓰는 법을 익히는 문서 — 제품이 관리하며 업데이트마다 자동 갱신됩니다.</div></div><div class="dlv-row-a"><button class="dlv-ib" type="button">↑</button><button class="dlv-ib" type="button">↓</button><button class="btn btn-text" type="button">보기</button><label class="dlv-sw">${sw(true)}<span class="dlv-sw-w">켜짐</span></label></div></div>
      </div><div class="dlv-box-acts"><button class="btn btn-text" type="button">실제 주입 전문 보기</button><button class="btn btn-ghost btn-sm" type="button">＋ 문서 추가</button></div></section>
      <section class="dlv-box" data-f="dlvTokens"><h4 class="dlv-box-h">자동으로 채워지는 값</h4><p class="dlv-box-hint">문서 본문의 \${ } 자리에 매 세션 실제 데이터가 들어갑니다.</p><div class="dlv-tokens">
        <div class="dlv-token"><code class="dlv-token-k">\${team}</code><div class="dlv-token-b"><b>우리 팀</b><span>보는 사람이 속한 팀 이름</span></div></div>
        <div class="dlv-token" data-f="tokCats"><code class="dlv-token-k">\${categories}</code><div class="dlv-token-b"><b>카테고리 지도</b><span>전 카테고리(주제) 목록</span></div></div>
        <div class="dlv-token"><code class="dlv-token-k">\${wiki}</code><div class="dlv-token-b"><b>WIKI 인덱스</b><span>핀 꽂은 지식의 제목·소환키(본문 제외)</span></div></div>
      </div></section>
    </div>
  </div></div>
</div>`;

// ════════════════════════════════════════════════════════════════════════════
//  WIKI 문서(web/v2/wiki-main.ts · 지식 꼬리 kn-links · kn-projlinks · wk-related)
// ════════════════════════════════════════════════════════════════════════════
const block = (cls, html) => `<div class="be-block"><div class="be-gutter"></div><div class="be-main"><div class="be-text ${cls}">${html}</div></div></div>`;
const linkRow = (rel, relCls, title, id = '') => `<a class="kn-linkrow"${id ? ` data-f="${id}"` : ''}><span class="kn-link-rel${relCls ? ' ' + relCls : ''}">${rel}</span><span class="kn-linkrow-title">${title}</span></a>`;
const WIKI = `<div class="kn-shell-flat"><article class="wk-doc wk-doc-page" data-f="wkDoc">
  <div class="wk-folio"><nav class="wk-folio-crumbs"><a class="wk-crumb">WIKI</a><span class="wk-crumb-sep">›</span><a class="wk-crumb">영업</a><span class="wk-crumb-sep">›</span><span class="wk-crumb wk-crumb-cur">3단계 요금제 — Basic · Pro · Team</span></nav><div class="wk-folio-actions"><button class="wk-folio-btn wk-pin" type="button">📌 핀</button><button class="wk-folio-btn wk-more" type="button">⋯</button></div></div>
  <div class="wk-doc-head"><h1 class="wk-doc-title">3단계 요금제 — Basic · Pro · Team</h1></div>
  <div class="wk-propline" data-f="wkProps"><span class="wk-tick"></span><button class="wk-prop-it clickable" type="button">결정</button><button class="wk-prop-it clickable" type="button">영업</button><button class="wk-prop-it time clickable" type="button">갱신 방금 · 판 4</button><button class="wk-prop-it all clickable" type="button">속성 모두</button></div>
  <div class="wk-doc-body"><div class="be">
    ${block('be-h be-h2', '정한 것')}
    ${block('be-p', '10월 영업 회의에서 요금제를 세 단계로 나누기로 했다. 연간 계약은 두 달을 깎아 준다.')}
    ${block('be-li', '<b>Basic</b> — 월 9,000원 · 5명까지')}
    ${block('be-li', '<b>Pro</b> — 월 19,000원 · 20명까지')}
    ${block('be-li', '<b>Team</b> — 월 32,000원 · 인원 제한 없음 <span class="tg-upd">11월 12일 슬랙에서 29,000원 → 32,000원으로 고침</span>')}
    ${block('be-h be-h2', '왜 이렇게 정했나')}
    ${block('be-p', '경쟁사 셋 모두 20명 언저리에서 값이 크게 뛴다. 그 자리에 Pro 를 두고, 큰 팀은 인원 대신 값으로 나눈다.')}
  </div></div>
  <div class="wk-doc-tail">
    <div class="wk-doc-end"></div>
    <div class="kn-links"><div class="sec-label sec-label-row"><span>연결된 지식</span><button class="btn btn-ghost btn-sm" type="button">＋ 지식 연결</button></div>
      <div class="kn-links-body"><div class="kn-linkrows">${linkRow('관련', '', '할인 승인 규칙 — 20% 넘으면 팀장 승인')}</div></div>
      <div class="sec-label" data-f="srcLabel">출처 자료</div>
      <div class="kn-linkrows" data-f="srcRows">${linkRow('증류', 'kn-link-source', '슬랙 #영업 — 11월 12일 «Team 요금 다시 보죠» 스레드', 'src1')}${linkRow('증류', 'kn-link-source', '영업회의_1009.pdf')}${linkRow('증류', 'kn-link-source', '가격표.xlsx')}${linkRow('증류', 'kn-link-source', '노션 «요금제 개편안 v2»')}</div>
    </div>
    <div class="kn-projlinks"><div class="sec-label sec-label-row"><span>연결된 프로젝트</span><button class="btn btn-ghost btn-sm" type="button">＋ 프로젝트 연결</button></div>
      <div class="kn-linkrows">${linkRow('산출', '', '10월 영업 회의 #8')}${linkRow('참고', '', '제안서 수정 #12')}</div></div>
    <div class="wk-related" data-f="related"><div class="sec-label sec-label-row"><span>비슷한 지식</span><span class="kn-sim-hint">자동 · 의미 유사도</span></div>
      <div class="kn-linkrows">${linkRow('84%', 'kn-link-sim', '경쟁사 요금 비교 — ACME · Bolt · Corex')}${linkRow('77%', 'kn-link-sim', '할인 승인 규칙 — 20% 넘으면 팀장 승인')}${linkRow('71%', 'kn-link-sim', '연간 계약 조건 — 두 달 할인 · 중도 해지')}${linkRow('63%', 'kn-link-sim', '고객 문의 — 요금 관련 자주 묻는 것')}</div></div>
  </div>
</article></div>`;

const pageDoc = `<!doctype html>
<html lang="ko" data-theme="light">
<head>
<meta charset="utf-8">
<title>동작원리 영상의 화면 — 앱 프레임</title>
${LINKS}
<style>
${FREEZE}
#view { min-height: 100vh; }
${CTX_ROOM}
/* WIKI 문서는 줄이지 않는다(zoom 은 수집 · 증류에만) — 문서 쪽은 제 크기 그대로. */
html.wk { zoom: 1; }
html.wk main#view { max-width: none; padding: 0; }
.be-li { padding-left: 18px; position: relative; } .be-li::before { content: '•'; position: absolute; left: 4px; color: var(--muted); }
.tg-upd { display: inline-block; margin-left: 6px; padding: 0 7px; border-radius: 6px; font-size: 12.5px; font-weight: 700; color: var(--blue-deep, #1d4ed8); background: var(--bg-punch, #eaf1ff); }
[data-f="wkScroll"] { will-change: transform; }
</style>
</head>
<body class="embed">
<div id="app"><main id="view">
  <div data-f="vCtx"><div class="pjv-board-wrap ctx-board-wrap" data-stage="home" data-f="ctxWrap"><div class="card pjv-listboard ctx-board">
    ${ctxHeader('home', 3)}
    <div class="ctx-body">
      <div data-f="sHome">${flowMap()}${runsCard()}</div>
      <div data-f="sSources" hidden>${SOURCES}</div>
      <div data-f="sDistill" hidden>${DISTILL}</div>
      <div data-f="sDeliver" hidden>${DELIVER}</div>
    </div>
  </div></div></div>
  <div data-f="vWiki" hidden><div data-f="wkScroll">${WIKI}</div></div>
</main></div>
</body>
</html>
`;

// ════════════════════════════════════════════════════════════════════════════
//  셸 — 레일 · 위키 곁칸 · 홈 · 세션(터미널 + 곁칸 콘솔) · 앱 찾기
// ════════════════════════════════════════════════════════════════════════════
const PAD = [
  ['세션 목록', 'chat'], ['프로젝트', 'proj'], ['WIKI', 'wiki'], ['자료', 'src'], ['분류체계', 'tags'], ['수집 · 증류', 'ctx'], ['세션 이력', 'sess'],
  ['사용 가이드', 'learn'], ['앱빌더', 'builder'],
  ['외부 앱 연결', 'link', 'M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5 M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5'],
  ['지난 세션', 'archive', 'M3 4h18v4H3z M5 8v12h14V8 M10 12h4'],
  ['휴지통', 'trash', 'M4 7h16 M6 7l1 13h10l1-13 M9 7V4h6v3 M10 11v6 M14 11v6'],
  ['확인할 것', 'bell', 'M6 17v-7a6 6 0 0 1 12 0v7 M4 17h16 M10 20.5h4'],
  ['웹 브라우저', 'web', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z'],
];
const padItem = ([t, name, d]) => `<a class="v2-pad-item" role="listitem"${t === 'WIKI' ? ' data-f="padWiki"' : ''}><span class="v2-pad-ico">${gi(name, '', d || null)}</span><b>${t}</b></a>`;

const catRow = (name, n, on = false) => `<a class="v2-wcat v2-ptl v2-kcat${on ? ' on' : ''}"${on ? ' data-f="catOn"' : ''}>${lineIc('list', 'v2-ptl-ic')}<span class="n">${name}</span><span class="v2-cnt">${n}</span></a>`;
const ksp = (name, n, rows) => `<section class="v2-ksp open"><div class="v2-ksp-h"><button class="v2-ksp-t" type="button"><span class="v2-car" aria-hidden="true">›</span>${lineIc('layers', 'v2-ksp-ic')}<span class="n">${name}</span></button><span class="v2-cnt">${n}</span></div><div class="v2-ksp-b">${rows}</div></section>`;
const WIKI_SIDE = `<section class="v2-app-space" aria-label="위키">
  <div class="v2-app-space-head"><span class="v2-k">위키</span><span class="v2-app-count">212</span><a class="v2-app-new"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg></a></div>
  <nav class="v2-kviews"><a class="v2-wcat v2-ptl v2-kview">${lineIc('wiki', 'v2-ptl-ic')}<span class="n">전체 문서</span><span class="v2-cnt">212</span></a><a class="v2-wcat v2-ptl v2-kview">${lineIc('pin', 'v2-ptl-ic')}<span class="n">인덱스</span><span class="v2-cnt">6</span></a></nav>
  <div class="v2-app-list v2-kshelf" data-f="kshelf">
    <div class="v2-app-group v2-kgroup" role="presentation"><span class="n">분류</span><a class="v2-kedit">${lineIc('pen', 'v2-kedit-ic')}<span>편집</span></a></div>
    ${ksp('사업', 128, catRow('영업', 74, true) + catRow('시장 · 경쟁', 31) + catRow('고객', 23))}
    ${ksp('제품', 61, catRow('요금 · 과금', 26) + catRow('기능 기획', 21) + catRow('고객 문의', 14))}
    ${ksp('운영', 23, catRow('회의 · 결정', 15) + catRow('인사', 8))}
  </div>
</section>`;

const tl = (id, cls, html) => `<div class="tf-ln ${cls}" data-f="${id}">${html}</div>`;
const SEL = (cls, w, label) => `<select class="v2-run-sel ${cls}" style="width: ${w}px;"><option>${label}</option></select>`;
const dockIt = (id, name, label, glyph) => `<button class="tf-dk${id === 'dkCon' ? ' on' : ''}" type="button" data-f="${id}"><span class="tf-dk-ic">${gi(name, '', glyph ? ic(glyph) : null)}</span><span class="tf-dk-t">${label}</span></button>`;
const pnI = (name, cls = 'pn-i sm') => `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true"><path d="${ic(name)}"></path></svg>`;
const conRow = (id, iconName, cls, q, m, act) => `<div class="pn-con-row" data-f="${id}">${pnI(iconName, 'pn-i sm' + (cls ? ' ' + cls : ''))}<div class="pn-con-row-b"><div class="pn-con-row-q ell1">${q}</div><div class="pn-con-row-m ell1">${m}</div></div><button class="pn-con-a" type="button">${act}</button></div>`;
const ck = (id, name, val, act) => `<div class="pn-con-ck" data-f="${id}"><span class="pn-con-st done" aria-hidden="true">${pnI('check', 'pn-i')}</span><div class="pn-con-ck-b"><div class="pn-con-ck-n">${name}</div><div class="pn-con-ck-v">${val}</div></div><button class="pn-con-a" type="button">${act}</button></div>`;
const ASIDE = `<aside class="tf-aside" data-f="aside"><div class="tf-aside-in">
  <div class="tf-dock">${dockIt('dkWeb', 'web', '웹')}${dockIt('dkCon', 'term', '콘솔', 'console')}${dockIt('dkProj', 'proj', '프로젝트')}${dockIt('dkFiles', 'src', '자료')}${dockIt('dkWiki', 'wiki', '지식')}</div>
  <div class="tf-pane"><div class="pn-part pn-con"><div class="pn-con-body">
    <div class="pn-con-hd"><div class="pn-con-t ell1">경쟁사 요금 비교</div><div class="pn-con-s ell1" data-f="conSub">작업 중 · 질문 1 · 파일 1</div></div>
    <div class="pn-con-sum"><b>처음 시킨 것</b><div class="ell3">경쟁사 요금 조사해서 우리 요금제랑 비교표 만들어 줘</div></div>
    <div class="pn-con-sh" data-f="givenH"><span>알려 준 것</span><span class="n">지식 3 · 선행 1</span></div>
    ${ck('ckPrior', '선행 프로젝트', '#8 10월 영업 회의 — 남긴 지식 4건', '바꾸기')}
    ${ck('ckKn', '지식', '3단계 요금제 외 2건', '고르기')}
    <div class="pn-con-sh" data-f="leftH"><span>남긴 것</span></div>
    <div data-f="leftRows">
      ${conRow('lv3', 'wiki', '', '경쟁사 요금 비교 — ACME · Bolt · Corex', '지식 고침 · 방금', '읽기')}
      ${conRow('lv2', 'doc', '', '요금제_비교.xlsx', '파일 만듦 · 방금', '열기')}
      ${conRow('lv1', 'wiki', 'dim', '3단계 요금제 — Basic · Pro · Team', '참고 · 1분 전', '읽기')}
    </div>
  </div></div></div>
</div></aside>`;

const appDoc = `<!doctype html>
<html lang="ko" data-theme="light">
<head>
<meta charset="utf-8">
<title>동작원리 영상의 화면 — 셸</title>
${LINKS}
<style>
${FREEZE}
${SHELL_CSS}
.tf-ln.hook { color: var(--warn-text, #B36E18); }
.tf-ln .tool { font-weight: 700; color: var(--ink); }
.tf-ln .mcp { color: var(--muted); }
.pn-con-body { padding-bottom: 12px; }
/* 위키 곁칸 — 영상에서는 여닫는 것을 장면이 정한다(root 의 side-closed). */
</style>
</head>
<body>
<div id="app">
<div id="v2-root" class="rail-mode no-aside side-closed" data-f="root">
  <nav class="v2-rail closed" aria-label="구역">
    <div class="v2-rail-top"><div class="v2-rail-ws"><button class="v2-rail-stack" type="button"><span class="v2-rail-stack-t"><span class="v2-wscard-big v2-wsface-set" style="background:#2D6BF0;color:#ffffff">L</span></span></button></div></div>
    <div class="v2-rail-mid"><div class="v2-rail-main">
      <button class="v2-rail-it on" type="button" data-f="rHome" data-kind="sec">${railIc('home')}<span class="v2-rail-t">홈</span></button>
      <a class="v2-rail-it pinned" data-f="rCtx" data-kind="pin">${railIc('ctx')}<span class="v2-rail-t">수집 · 증류</span></a>
    </div><div class="v2-rail-hr" role="presentation"></div><div class="v2-rail-recent"><a class="v2-rail-it" data-f="rWiki" data-kind="recent" style="opacity:0">${railIc('wiki')}<span class="v2-rail-t">WIKI</span></a></div></div>
    <footer class="v2-rail-foot">
      <button class="v2-rail-it" type="button" data-f="rApps">${railIc('apps')}<span class="v2-rail-t">앱</span></button>
      <button class="v2-rail-it v2-rail-me" type="button"><span class="v2-rail-avaw"><span class="pava v2-ava" aria-hidden="true" style="background: rgb(102, 138, 204);">지</span></span><span class="v2-rail-t">지원</span></button>
    </footer>
  </nav>
  <nav id="v2-side" class="v2-side" data-f="side">${WIKI_SIDE}</nav>
  <div class="v2-split v2-split-x"></div>
  <div id="v2-main" class="v2-main">

    <!-- 홈 -->
    <div class="v2-tabpane" data-f="pHome"><section class="v2-home v2-home-launch">
      <div class="v2-home-eyebrow"><span>3월 3일 월요일</span><span class="sp"></span><button class="v2-bell" type="button"><svg viewBox="0 0 24 24" class="v2-bell-ic" aria-hidden="true"><path d="M6 17v-7a6 6 0 0 1 12 0v7 M4 17h16 M10 20.5h4"></path></svg></button></div>
      <h1 class="v2-h1">좋은 오후예요, 지원님.</h1>
      <p class="v2-home-sub">무엇을 할까요?</p>
      <div class="v2-dest-grid">
        <div class="v2-dest-wrap"><div class="v2-dest" data-f="dProj"><span class="v2-dest-lbl">프로젝트</span><input class="v2-dest-in" type="text" placeholder="프로젝트를 고르거나 새 프로젝트 이름을 적으세요"><span class="v2-dest-slot"></span></div></div>
        <div class="v2-dest-wrap"><div class="v2-dest" data-f="dPre"><span class="v2-dest-lbl">선행</span><input class="v2-dest-in" type="text" placeholder=""><span class="v2-dest-slot"><span class="v2-dest-chip" data-f="preChip"><span class="t">10월 영업 회의</span><button class="x" type="button">✕</button></span></span></div></div>
      </div>
      <div class="v2-launch" data-f="launch">
        <div class="v2-launch-in tf-in" data-f="launchIn"><span class="tf-ph" data-f="launchPh">무엇이든 시키세요
@이름 을 적으면 그 사람을 이 세션에 초대해요</span><span class="tx"></span><span class="tf-caret" data-f="caret"></span></div>
        <div class="v2-launch-row">
          <div class="v2-launch-ctl"><div class="v2-run">${SEL('v2-run-node', 138, '자동 · 중앙 컴퓨터')}<span class="v2-run-sep" aria-hidden="true"></span>${SEL('v2-run-prov', 163, 'Anthropic · Claude Code')}<span class="v2-run-sep" aria-hidden="true"></span>${SEL('v2-run-model', 89, '모델 · Opus')}<span class="v2-run-sep" aria-hidden="true"></span>${SEL('v2-run-effort', 81, '추론 · 높음')}</div></div>
          <div class="v2-launch-act"><button class="v2-launch-gear" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${GEAR}"></path></svg></button><button class="v2-launch-att" type="button"><span aria-hidden="true">＋</span></button><button class="btn btn-primary v2-launch-send" type="button" data-f="send"><span>시키기</span></button></div>
        </div>
      </div>
    </section></div>

    <!-- 앱 프레임(수집 · 증류 · WIKI) -->
    <div class="v2-tabpane" data-f="pApp" hidden><div class="v2-app v2-app-frameless"><iframe class="v2-frame" id="pageFrame" src="guide-page.gen.html"></iframe></div></div>

    <!-- 세션 -->
    <div class="v2-tabpane" data-f="pSess" hidden><div class="tf-row"><div class="tf-sess">
      <header class="tf-door"><span class="tf-proj"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ic('proj')}"></path></svg>경쟁사 요금 비교</span><span class="mono">#14</span><span class="sep">·</span><span class="tf-run">진행 중</span><span class="sp"></span><button class="btn btn-ghost btn-sm" type="button"><span>프로젝트 상세</span></button><button class="btn btn-primary btn-sm" type="button"><span>새 세션</span></button><button class="tf-sidebtn" type="button" data-f="sideBtn" aria-label="곁칸"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4z M15 5v14"></path></svg></button></header>
      <div class="tf-head">
        <div class="tf-head-1"><i class="tf-dot"></i><h2>경쟁사 요금 비교</h2><span class="sp"></span><span class="tf-conn">연결됨</span><span class="tf-more">···</span></div>
        <div class="tf-head-2"><span class="pava" style="background: rgb(102, 138, 204);">지</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ic('folder')}"></path></svg><span class="sp"></span><span class="tf-pick">Opus</span><span class="tf-pick">추론강도 · 높음</span></div>
      </div>
      <div class="tf-term"><div class="tf-scroll" data-f="scroll">
        ${tl('l0', 'me', '❯ 경쟁사 요금 조사해서 우리 요금제랑 비교표 만들어 줘')}
        ${tl('l1', '', '<span class="ok">⏺</span> <span class="tool" data-f="callT">Calling lively…</span> <span class="mcp" data-f="callX"></span>')}
        ${tl('l2', 'sub', '  ⎿ lively - <span class="tool">knowledge_search</span> <span class="mcp">(MCP)</span>(q: "경쟁사 요금")')}
        ${tl('l3', 'sub', '  ⎿ lively - <span class="tool">knowledge_grep</span> <span class="mcp">(MCP)</span>(q: "Team 요금")')}
        ${tl('l4', 'sub', '  ⎿ lively - <span class="tool">knowledge_get</span> <span class="mcp">(MCP)</span>(name: "3단계 요금제", offset: 40, limit: 30)')}
        ${tl('l5', 'gap', '<span class="ok">⏺</span> 웹에서 경쟁사 세 곳의 요금을 읽고 우리 요금제와 나란히 놓았습니다.')}
        ${tl('l6', '', '  Pro 는 세 곳보다 싸고, Team 은 Bolt 와 거의 같습니다.')}
        ${tl('l7', 'sub', '  ⎿ 저장: <span class="file">요금제_비교.xlsx</span>')}
        ${tl('l8', 'gap hook', '⏺ Stop hook feedback:')}
        ${tl('l9', 'sub', '  ⎿ 파일 작업을 했는데 컨텍스트 스토어 기록이 없습니다. 마무리 전에 기록하세요(세션당 1회)')}
        ${tl('l10', 'gap', '<span class="ok">⏺</span> <span class="tool">Agent</span>(기록: 경쟁사 요금 비교)')}
        ${tl('l11', 'sub', '  ⎿ lively - <span class="tool">knowledge_save</span> — 비슷한 지식이 있어 고쳤습니다 · 판 2 → 판 3')}
        <div class="tf-box" data-f="lbox">❯ <span class="tx"></span><span class="tf-bcaret" data-f="bcaret"></span></div>
      </div></div>
    </div>
    ${ASIDE}
    </div></div>

  </div>
</div>
</div>

<!-- 앱 찾기 — 제품처럼 body 에 붙는다 -->
<div class="v2-pad" data-f="pad" role="dialog" aria-label="앱 찾기" hidden>
  <div class="v2-pad-top"><div class="v2-pad-field" data-f="padField"><svg class="v2-pad-mag" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.75"></circle><path d="M16.1 16.1 21 21"></path></svg><input class="v2-pad-search" type="search" placeholder="앱 찾기"><kbd class="v2-pad-esc">esc</kbd></div></div>
  <div class="v2-pad-body">
    <section class="v2-pad-sec" data-group="base"><h3 class="v2-pad-sec-h">기본 앱</h3><div class="v2-pad-grid" role="list">${PAD.map(padItem).join('')}</div></section>
  </div>
</div>
</body>
</html>
`;

writeFileSync(path.join(here, 'guide-page.gen.html'), pageDoc);
writeFileSync(path.join(here, 'guide-app.gen.html'), appDoc);
console.log('[welcome-film] guide-app.gen.html · guide-page.gen.html — 스타일시트 ' + SHEETS + '장');
