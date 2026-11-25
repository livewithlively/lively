// 둘러보기 영상(tour · 온보딩 영상(기초))의 «제품 화면» 을 만든다 — tour-app.gen.html(셸: 레일 · 홈 · 세션 · 앱 찾기).
//  수집 · 증류 화면은 이 영상에서 뺐다(원준 2026-11-19 «원리 · 과정 설명하는 쪽에 넣는 게 낫다») — 동작원리 영상(gen-guide.mjs)에 있다.
//  그리지 않는다. 제품의 스타일시트(public/styles — index.html 이 거는 차례 그대로)를 걸고, 제품이 실제로 세우는 DOM 을
//  밝은 테마 · 예시 데이터로 세운다. 그래서 색 · 글자 · 간격이 제품과 같고, 스타일이 바뀌면 다시 구울 때 영상도 따라 바뀐다.
//  아이콘 · 서비스 로고 · 흐름 지도 · 자동 실행 칸은 동작원리 영상(gen-guide.mjs)과 함께 gen-common.mjs 에서 읽는다.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { here, LINKS, SHEETS, FREEZE, SHELL_CSS, ic, railIc, gi, GEAR } from './gen-common.mjs';


// ════════════════════════════════════════════════════════════════════════════
//  셸 — 레일 · 홈 · 세션 · 앱 찾기
// ════════════════════════════════════════════════════════════════════════════
//  앱 찾기의 «기본 앱» — 이름 · 차례는 제품(web/v2/apps.ts)과 같다. 표에 없는 그림 넷은 제품 화면에서 읽은 선이다.
const PAD = [
  ['세션 목록', 'chat'], ['프로젝트', 'proj'], ['WIKI', 'wiki'], ['자료', 'src'], ['분류체계', 'tags'], ['수집 · 증류', 'ctx'], ['세션 이력', 'sess'],
  ['사용 가이드', 'learn'], ['앱빌더', 'builder'],
  ['외부 앱 연결', 'link', 'M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5 M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5'],
  ['지난 세션', 'archive', 'M3 4h18v4H3z M5 8v12h14V8 M10 12h4'],
  ['휴지통', 'trash', 'M4 7h16 M6 7l1 13h10l1-13 M9 7V4h6v3 M10 11v6 M14 11v6'],
  ['확인할 것', 'bell', 'M6 17v-7a6 6 0 0 1 12 0v7 M4 17h16 M10 20.5h4'],
  ['웹 브라우저', 'web', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z'],
];
const padItem = ([t, name, d]) => `<a class="v2-pad-item" role="listitem"><span class="v2-pad-ico">${gi(name, '', d || null)}</span><b>${t}</b></a>`;

// ── 곁칸 — 세션 오른쪽의 앱 칸(web/v2/panes*.ts). 독 · 프로젝트(이 세션의 태스크) · 자료(공유 폴더) · 웹. ──
const dockIt = (id, name, label, glyph) => `<button class="tf-dk" type="button" data-f="${id}"><span class="tf-dk-ic">${gi(name, '', glyph ? ic(glyph) : null)}</span><span class="tf-dk-t">${label}</span></button>`;
const ppRow = (id, n, name, tid, state) => `<div class="pp-row pj-ts ${state === 'now' ? 'now' : state === 'done' ? 'done' : ''}" data-f="${id}"><span class="pp-num">${n}</span><div class="pp-main"><div class="pp-l1"><span class="pn-tk-st ${state === 'now' ? 'doing' : state}" data-f="${id}St"></span><span class="pn-tk-rname pp-name"><span class="ell">${name}</span></span></div><div class="pp-meta"><span class="${state === 'now' ? 'pp-now' : 'pp-mute'}" data-f="${id}Meta">${state === 'now' ? '지금 하는 일' : state === 'done' ? '끝냄' : '다음 차례'}</span><span class="pp-id">#${tid}</span></div></div></div>`;
const FILE_IC = { doc: '#2D6BF0', pdf: '#D14343', xls: '#1F9D55' };
const fRow = (id, kind, name, type, size, cls = '') => `<div class="pn-frow2 ${cls}" data-f="${id}"><span class="tf-fic" style="--fc:${FILE_IC[kind]}">${kind.toUpperCase()}</span><b class="pn-fname1">${name}</b><span class="pn-fcol k">${type}</span><span class="pn-fcol s">${size}</span></div>`;
const ASIDE = `<aside class="tf-aside" data-f="aside"><div class="tf-aside-in">
  <div class="tf-dock">${dockIt('dkWeb', 'web', '웹')}${dockIt('dkCon', 'term', '콘솔', 'console')}${dockIt('dkProj', 'proj', '프로젝트')}${dockIt('dkFiles', 'src', '자료')}${dockIt('dkWiki', 'wiki', '지식')}</div>
  <div class="tf-pane" data-f="aProj"><div class="pn-part pn-tk pj">
    <div class="pn-tk-head"><div class="pn-tk-head-row"><svg viewBox="0 0 24 24" class="tf-pi" aria-hidden="true"><path d="${ic('proj')}"></path></svg><b class="pn-tk-name">제안서 수정</b><span class="pn-fine pn-tk-count" data-f="tkCount">1/3 끝냄</span></div><div class="pn-tk-bar"><div class="pn-tk-bar-fill" data-f="tkBar" style="width:33%"></div></div></div>
    <div class="pj-sec pj-tssec"><div class="pn-tk-gh"><span>이 세션의 태스크</span><span class="n">3</span></div>
      ${ppRow('t1', 1, '회의에서 정한 것 정리', 31, 'done')}${ppRow('t2', 2, '제안서 고치기', 32, 'now')}${ppRow('t3', 3, '고객에게 보낼 메일 초안', 33, 'todo')}
    </div>
  </div></div>
  <div class="tf-pane" data-f="aFiles" hidden><div class="pn-part pn-files">
    <div class="tf-fhead"><span class="tf-fcrumb"><svg viewBox="0 0 24 24" class="tf-pi" aria-hidden="true"><path d="${ic('folder')}"></path></svg>제안서 수정</span><span class="pn-fine">공유 폴더 · 4개</span></div>
    <div class="tf-flist">${fRow('f4', 'doc', '제안서_v4.docx', '문서', '84KB', 'tf-new')}${fRow('f1', 'doc', '제안서_v3.docx', '문서', '81KB')}${fRow('f2', 'pdf', '영업회의_1009.pdf', 'PDF', '1.2MB')}${fRow('f3', 'xls', '가격표.xlsx', '표', '36KB')}</div>
    <div class="tf-drop">파일을 끌어다 놓으면 올라갑니다 · 이 프로젝트의 모든 세션이 같이 봅니다</div>
  </div></div>
  <div class="tf-pane" data-f="aWeb" hidden><div class="tf-web">
    <div class="tf-url"><span class="tf-url-ic">${'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11V8a5 5 0 0 1 10 0v3 M5 11h14v10H5z"></path></svg>'}</span><span class="tf-url-tx" data-f="url"><span class="tx"></span></span></div>
    <div class="tf-page" data-f="page">
      <div class="tf-pg-nav"><b>ACME</b><span>제품</span><span>요금</span><span>고객 사례</span></div>
      <div class="tf-pg-h">요금제</div>
      <div class="tf-pg-cards"><div><b>Basic</b><i></i><i></i></div><div class="on"><b>Pro</b><i></i><i></i></div><div><b>Team</b><i></i><i></i></div></div>
      <div class="tf-pg-ln"></div><div class="tf-pg-ln s"></div>
    </div>
    <div class="tf-ai" data-f="webAi"><span class="ok">●</span> AI가 이 페이지에서 경쟁사 요금을 읽었습니다</div>
    <div class="tf-mail" data-f="mail">
      <div class="tf-mh"><i></i>새 메일</div>
      <div class="tf-mf"><b>받는 사람</b><span data-f="mTo"><span class="tx"></span></span></div>
      <div class="tf-mf"><b>제목</b><span data-f="mSub"><span class="tx"></span></span></div>
      <div class="tf-mbody" data-f="mBody"><span class="tx"></span></div>
      <div class="tf-matt" data-f="mAtt"><span class="tf-fic" style="--fc:#2D6BF0">DOC</span>제안서_v4.docx · 84KB</div>
      <div class="tf-mfoot"><button class="tf-msend" type="button" data-f="mSend">보내기</button><span class="tf-msent" data-f="mSent">✓ 보냈습니다</span></div>
    </div>
  </div></div>
</div></aside>`;

const SEL = (cls, w, label) => `<select class="v2-run-sel ${cls}" data-f="${cls}" style="width: ${w}px;"><option>${label}</option></select>`;
const tl = (id, cls, html) => `<div class="tf-ln ${cls}" data-f="${id}">${html}</div>`;

const appDoc = `<!doctype html>
<html lang="ko" data-theme="light">
<head>
<meta charset="utf-8">
<title>라이블리 — 둘러보기 영상의 화면</title>
${LINKS}
<style>
${FREEZE}
${SHELL_CSS}
</style>
</head>
<body>
<div id="app">
<div id="v2-root" class="rail-mode no-aside side-closed">
  <nav class="v2-rail closed" aria-label="구역">
    <div class="v2-rail-top"><div class="v2-rail-ws" data-f="rWs"><button class="v2-rail-stack" type="button"><span class="v2-rail-stack-t"><span class="v2-wscard-big v2-wsface-set" style="background:#2D6BF0;color:#ffffff">L</span></span></button></div></div>
    <div class="v2-rail-mid"><div class="v2-rail-main">
      <button class="v2-rail-it on" type="button" data-f="rHome" data-kind="sec">${railIc('home')}<span class="v2-rail-t">홈</span></button>
      <a class="v2-rail-it pinned" data-f="rCtx" data-kind="pin">${railIc('ctx')}<span class="v2-rail-t">수집 · 증류</span></a>
    </div><div class="v2-rail-hr" data-f="rHr" role="presentation"></div><div class="v2-rail-recent" data-f="rRecent"><a class="v2-rail-it" data-f="rc1" data-kind="recent">${railIc('wiki')}<span class="v2-rail-t">WIKI</span></a><a class="v2-rail-it" data-f="rc2" data-kind="recent">${railIc('src')}<span class="v2-rail-t">자료</span></a></div></div>
    <footer class="v2-rail-foot">
      <button class="v2-rail-it" type="button" data-f="rApps">${railIc('apps')}<span class="v2-rail-t">앱</span></button>
      <button class="v2-rail-it v2-rail-me" type="button" data-f="rMe"><span class="v2-rail-avaw"><span class="pava v2-ava" aria-hidden="true" style="background: rgb(102, 138, 204);">지</span></span><span class="v2-rail-t">지원</span></button>
    </footer>
  </nav>
  <nav id="v2-side" class="v2-side"></nav>
  <div class="v2-split v2-split-x"></div>
  <div id="v2-main" class="v2-main">

    <!-- 홈 -->
    <div class="v2-tabpane" data-f="pHome"><section class="v2-home v2-home-launch">
      <div class="v2-home-eyebrow"><span>3월 3일 월요일</span><span class="sp"></span><button class="v2-bell" type="button"><svg viewBox="0 0 24 24" class="v2-bell-ic" aria-hidden="true"><path d="M6 17v-7a6 6 0 0 1 12 0v7 M4 17h16 M10 20.5h4"></path></svg></button></div>
      <h1 class="v2-h1">좋은 아침이에요, 지원님.</h1>
      <p class="v2-home-sub">무엇을 할까요?</p>
      <div class="v2-dest-grid">
        <div class="v2-dest-wrap"><div class="v2-dest"><span class="v2-dest-lbl">프로젝트</span><input class="v2-dest-in" data-f="dProj" type="text" placeholder="프로젝트를 고르거나 새 프로젝트 이름을 적으세요"><span class="v2-dest-slot"></span></div></div>
        <div class="v2-dest-wrap" style="position:relative"><div class="v2-dest"><span class="v2-dest-lbl">선행</span><input class="v2-dest-in" data-f="dPre" type="text" placeholder="참고할 선행 프로젝트가 있다면 고르세요"><span class="v2-dest-slot"><span class="v2-dest-chip" data-f="preChip" style="display:none"><span class="t">10월 영업 회의</span><button class="x" type="button">✕</button></span></span></div>
          <div class="v2-dest-pop" data-f="prePop" hidden><div class="v2-dest-hd">검색 결과</div><div class="v2-dest-list">
            <button class="v2-dest-row" type="button" data-f="preRow1"><span class="n">10월 영업 회의</span><span class="b">완료</span><span class="m mono">#8</span></button>
            <button class="v2-dest-row" type="button"><span class="n">영업 제안서 템플릿 정리</span><span class="m mono">#10</span></button>
            <button class="v2-dest-row" type="button"><span class="n">상반기 영업 파이프라인 점검</span><span class="b">완료</span><span class="m mono">#5</span></button>
          </div></div></div>
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

    <!-- 수집 · 증류 -->

    <!-- 세션 -->
    <div class="v2-tabpane" data-f="pSess" hidden><div class="tf-row"><div class="tf-sess">
      <header class="tf-door"><span class="tf-proj"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ic('proj')}"></path></svg>제안서 수정</span><span class="mono">#12</span><span class="sep">·</span><span class="tf-run">진행 중</span><span class="sp"></span><button class="btn btn-ghost btn-sm" type="button"><span>프로젝트 상세</span></button><button class="btn btn-primary btn-sm" type="button"><span>새 세션</span></button><button class="tf-sidebtn" type="button" data-f="sideBtn" aria-label="곁칸"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4z M15 5v14"></path></svg></button></header>
      <div class="tf-head">
        <div class="tf-head-1"><i class="tf-dot"></i><h2>제안서 고치기</h2><span class="sp"></span><span class="tf-conn">연결됨</span><span class="tf-more">···</span></div>
        <div class="tf-head-2"><span class="pava" style="background: rgb(102, 138, 204);">지</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ic('folder')}"></path></svg><span class="sp"></span><span class="tf-pick">Opus</span><span class="tf-pick">추론강도 · 높음</span></div>
      </div>
      <div class="tf-term"><div class="tf-scroll" data-f="scroll">
        ${tl('l0', 'me', '❯ 지난주 회의에서 정한 대로 제안서 고쳐 줘')}
        ${tl('lw', 'sub', '<span class="wait">✻</span> 라이블리에서 관련 지식을 찾는 중…')}
        ${tl('l1', '', '<span class="ok">●</span> 라이블리에서 관련 지식 3건을 읽었습니다')}
        ${tl('l2', 'sub', '  └ 영업 회의 결정')}
        ${tl('l3', 'sub', '    3단계 요금제')}
        ${tl('l4', 'sub', '    제안서 검토 의견')}
        ${tl('l5', 'gap', '<span class="ok">●</span> 회의에서 정한 세 가지를 제안서에 반영했습니다.')}
        ${tl('l6', '', '  1. 가격표를 3단계 요금제로 바꿨습니다')}
        ${tl('l7', '', '  2. 도입 일정을 11월 시작으로 고쳤습니다')}
        ${tl('l8', '', '  3. 보안 항목에 감사 기록을 더했습니다')}
        ${tl('l9', 'sub', '  └ 저장: <span class="file">제안서_v4.docx</span>')}
        ${tl('m0', 'me gap2', '❯ 김 팀장님께 제안서_v4 메일로 보내 줘')}
        ${tl('mw', 'sub', '<span class="wait">✻</span> 웹 칸에서 메일을 쓰는 중…')}
        ${tl('m1', '', '<span class="ok">●</span> 김 팀장님께 메일을 보냈습니다')}
        ${tl('m2', 'sub', '  └ 받는 사람 minsu.kim@example.com')}
        ${tl('m3', 'sub', '    첨부 <span class="file">제안서_v4.docx</span>')}
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

writeFileSync(path.join(here, 'tour-app.gen.html'), appDoc);
console.log('[welcome-film] tour-app.gen.html — 스타일시트 ' + SHEETS + '장');
