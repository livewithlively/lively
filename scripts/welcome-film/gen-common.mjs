// 영상 두 편(둘러보기 tour · 동작원리 guide)이 함께 쓰는 «제품 화면» 부품.
//  그리지 않는다 — 제품의 스타일시트(public/styles, index.html 이 거는 차례 그대로)를 걸고, 제품이 실제로 세우는 DOM 을
//  밝은 테마 · 예시 데이터로 세운다. 아이콘 · 서비스 로고도 제품의 표에서 읽는다(먼저 `node scripts/build-web.mjs`).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '../..');

// ── 제품의 표 ────────────────────────────────────────────────────────────────
export const { ICONS } = await import(pathToFileURL(path.join(root, 'public/app/lib/icon-paths.js')).href);
const logoSrc = readFileSync(path.join(root, 'public/app/svc-logos.js'), 'utf8');
const li = logoSrc.indexOf('const SVC_LOGO = {'), lj = logoSrc.indexOf('\n};', li);
if (li < 0 || lj < 0) throw new Error('svc-logos.js 에서 SVC_LOGO 표를 못 찾았다');
export const SVC = new Function('return ' + logoSrc.slice(li + 'const SVC_LOGO = '.length, lj + 2))();

const index = readFileSync(path.join(root, 'public/index.html'), 'utf8');
const sheets = [...index.matchAll(/<link rel="stylesheet" href="\.\/styles\/([^"]+)">/g)].map((m) => m[1]);
if (sheets.length < 40) throw new Error('index.html 에서 스타일시트 목록을 못 읽었다');
export const SHEETS = sheets.length;
export const LINKS = sheets.map((f) => `<link rel="stylesheet" href="/public/styles/${f}">`).join('\n');

export const ic = (name) => { if (!ICONS[name]) throw new Error('아이콘 표에 없는 이름: ' + name); return ICONS[name]; };
export const railIc = (name) => `<svg viewBox="0 0 24 24" class="v2-rail-ic" aria-hidden="true"><path d="${ic(name)}"></path></svg>`;
/** 선 아이콘(web/v2/icons.ts icon() 이 그리는 그대로). */
export const lineIc = (name, cls) => `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true"><path d="${ic(name)}"></path></svg>`;
/** 앱 아이콘 — 타일 하나 + 색 선 하나(web/v2/glass-icon.ts 가 그리는 그대로). */
export const gi = (name, cls = '', d = null) => `<svg viewBox="0 0 64 64" class="v2-gi ${cls}" aria-hidden="true"><rect class="v2-gi-tile" x="1.5" y="1.5" width="61" height="61" rx="16"></rect><path class="v2-gi-glyph" stroke="var(--gi-c-${name})" transform="translate(14.72 14.72) scale(1.44)" d="${d || ic(name)}"></path></svg>`;
export const logo = (name) => { const L = SVC[name]; if (!L) throw new Error('로고 표에 없는 이름: ' + name); return `<svg viewBox="${L.vb}" aria-hidden="true" focusable="false">${L.p.map((p) => `<path d="${p.d}"${p.fill ? ` fill="${p.fill}"` : ''}></path>`).join('')}</svg>`; };
/** «리브가 세팅» 표식(web/liv-mark.ts livIcon). */
export const livIc = (cls = 'liv-ic') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="2.5"></circle></svg>`;
export const livMark = `<span class="liv-mark">${livIc()}<span>리브가 세팅</span></span>`;
export const GEAR = 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z';
//  제품이 세션 칸에 쓰는 Claude 표식(web/v2 의 v2me-plogo-svg) — 흐름 지도의 «AI 세션» 칸에 그대로 나온다.
export const CLAUDE = 'M4.709 15.955l4.72-2.647.079-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.004 1.81 2.508 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z';
export const claudeTile = (id = 'tClaude') => `<span class="svc-tile" data-f="${id}" style="--svc-brand:#D97757"><svg class="v2me-plogo-svg" viewBox="0 0 24 24" aria-hidden="true" fill="#D97757"><path d="${CLAUDE}"></path></svg></span>`;

//  굽는 쪽은 프레임마다 시각을 정해 찍는다 — 제품의 CSS 애니메이션 · 전환은 벽시계로 돌아서 끈다(움직임은 장면 스크립트가 준다).
export const FREEZE = `*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent; }
::-webkit-scrollbar { display: none; }
html, body { overflow: hidden; }`;

// ════════════════════════════════════════════════════════════════════════════
//  수집 · 증류 — 머리(탭 줄)
// ════════════════════════════════════════════════════════════════════════════
const CTX_TABS = [['home', '실시간 현황', ' ctx-vtab-ov'], ['sources', '수집기 설정', ''], ['distill', '증류기 설정', ''], ['checks', '점검 설정', ''], ['deliver', 'AI 주입기 설정', '']];
/** 탭 줄 — 탭마다 data-f="tab<key>" 를 단다(장면이 눌러 바꾼다). tray = 확인할 것 배지 수(없으면 배지 없음). */
export const ctxHeader = (active = 'home', tray = 0) => `<div class="pjv-board-header ctx-board-header"><div class="pjv-vtabs ctx-vtabs" role="tablist">
    <a class="ctx-hd-app"><svg class="pjv-crumb-ic ctx-crumb-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ic('ctx')}"></path></svg><span>수집 · 증류</span></a>
    ${CTX_TABS.map(([k, label, cls]) => `<a class="pjv-vtab ctx-vtab${cls}${k === active ? ' active' : ''}" role="tab" data-f="tab-${k}"><span class="ctx-vtab-label">${label}</span></a>`).join('\n    ')}
    <span class="ctx-vtabs-sp" aria-hidden="true"></span>
    <a class="pjv-vtab ctx-vtab ctx-vtab-tray" role="tab" data-f="tab-inbox"><span class="ctx-vtab-label">확인할 것</span>${tray ? `<b class="ctx-tray-n num" data-f="trayN">${tray}</b>` : ''}</a>
  </div></div>`;

// ════════════════════════════════════════════════════════════════════════════
//  수집 · 증류 — 실시간 현황의 흐름 지도(context-map.ts 가 세우는 DOM)
// ════════════════════════════════════════════════════════════════════════════
const machine = (id, name, sub, every) => `<span class="cxm-duct-c"><button type="button" class="cxm-mc" data-f="${id}"><span class="cxm-mc-n"><svg viewBox="0 0 24 24" class="cxm-mc-ic" aria-hidden="true"><path d="${GEAR}"></path></svg><span>${name}</span></span><span class="cxm-mc-s">${sub}</span><span class="cxm-mc-p is-ok">켜짐</span><span class="cxm-mc-e"><i class="cxm-dot" aria-hidden="true"></i><span>${every}</span></span></button></span>`;
const duct = (id, m) => `<div class="cxm-duct"><span class="cxm-wire is-still" data-f="wire${id}" aria-hidden="true"></span><svg viewBox="0 0 24 24" class="cxm-arr" aria-hidden="true"><path d="M9 18l6-6-6-6"></path></svg>${m}</div>`;
const srcRow = (id, mark, name, n) => `<span class="cxm-src-row" data-f="${id}"><i class="cxm-src-mk cxm-src-mk--logo">${mark}</i><span class="cxm-src-t">${name}</span><b class="num" data-n="${n}">${n.toLocaleString('en-US')}</b></span>`;
const knRow = (id, title, when) => `<span class="cxm-kn-row" data-f="${id}"><b class="cxm-kn-t">${title}</b><span class="cxm-kn-m">${when}</span></span>`;
export const tile = (id, brand, svg) => `<span class="svc-tile" data-f="${id}" style="--svc-brand:${brand}">${svg}</span>`;

/** 흐름 지도 — n = 처음 적어 둘 수(움직이는 장면은 0 에서 센다). */
export function flowMap(n = { apps: 3, src: 1284, kn: 212, ai: 1 }) {
  return `<div class="cxm">
    <p class="cxm-cap"><b>흐름 지도</b><span>자료가 지식이 되어 AI 에 닿기까지 — 흰 카드는 장소, 어두운 칩은 그 사이에서 도는 기계입니다. 선이 흐르면 그 기계가 돌고 있는 것입니다</span></p>
    <div class="cxm-floor"><div class="cxm-lane">
      <a class="cxm-st" data-f="stApps"><span class="cxm-st-h">${gi('apps', 'cxm-st-gi')}<b class="cxm-st-t">외부 앱</b><b class="cxm-st-n num"><span data-f="nApps">${n.apps}</span><small>종</small></b></span><span class="cxm-st-def">슬랙·노션·깃허브처럼 자료가 생기는 곳입니다</span><span class="cxm-st-x"><span class="cxm-svts">${tile('tSlack', '#4A154B', logo('slack'))}${tile('tNotion', '#191919', logo('notion'))}${tile('tGit', '#181717', logo('github'))}</span></span><span class="cxm-st-more" data-f="moreApps">수집 연결 3개</span></a>
      ${duct('1', machine('mc1', '수집기', '3 · 켜짐 3', '5분마다'))}
      <a class="cxm-st" data-f="stSrc"><span class="cxm-st-h">${gi('src', 'cxm-st-gi')}<b class="cxm-st-t">자료</b><b class="cxm-st-n num"><span data-f="nSrc">${n.src.toLocaleString('en-US')}</span><small>건</small></b></span><span class="cxm-st-def">가져온 원문을 그대로 둡니다</span><span class="cxm-st-x"><span class="cxm-srcs">${srcRow('sSlack', logo('slack'), '슬랙', 812)}${srcRow('sNotion', logo('notion'), '노션', 316)}${srcRow('sGit', logo('github'), '깃허브', 156)}</span></span><span class="cxm-st-more" data-f="moreSrc">오늘 +1,284</span></a>
      ${duct('2', machine('mc2', '증류기', '3 · 켜짐 3', '30분마다'))}
      <a class="cxm-st" data-f="stKn"><span class="cxm-st-h">${gi('wiki', 'cxm-st-gi')}<b class="cxm-st-t">지식</b><b class="cxm-st-n num"><span data-f="nKn">${n.kn}</span><small>건</small></b></span><span class="cxm-st-def">증류를 통과해 남은 것입니다</span><span class="cxm-st-x"><span class="cxm-kns">${knRow('k1', '영업 회의 결정', '방금')}${knRow('k2', '3단계 요금제', '방금')}${knRow('k3', '제안서 검토 의견', '방금')}</span></span><span class="cxm-st-more" data-f="moreKn">모두 카테고리에 들어 있음</span></a>
      ${duct('3', `<span class="cxm-duct-c"><a class="cxm-mc" data-f="mc3"><span class="cxm-mc-n"><svg viewBox="0 0 24 24" class="cxm-mc-ic" aria-hidden="true"><path d="${GEAR}"></path></svg><span>AI 주입기</span></span><span class="cxm-mc-s">시작 문서 2 · 검색</span><span class="cxm-mc-p is-ok">켜짐</span><span class="cxm-mc-e"><i class="cxm-dot" aria-hidden="true"></i><span>세션 시작마다</span></span></a></span>`)}
      <a class="cxm-st" data-f="stAi"><span class="cxm-st-h">${gi('chat', 'cxm-st-gi')}<b class="cxm-st-t">AI 세션</b><b class="cxm-st-n num"><span data-f="nAi">${n.ai}</span><small>작업 중</small></b></span><span class="cxm-st-def">시작할 때 읽고, 대화 중에 검색해 씁니다</span><span class="cxm-st-x"><span class="cxm-svts">${claudeTile()}</span></span><span class="cxm-st-more" data-f="moreAi">검색 대상 212건</span></a>
    </div></div>
  </div>`;
}

// ════════════════════════════════════════════════════════════════════════════
//  수집 · 증류 — 실시간 현황의 «자동 실행»(context-runs.ts runsPanel · dayTimeline 이 세우는 DOM)
// ════════════════════════════════════════════════════════════════════════════
const RW = 1200, GUT = 52, PADR = 44, RY = { c: 22, d: 60 }, RHH = 100;   // 제품의 시간 막대 치수(context-runs.ts)
/** 오늘 9시부터 지금(16:02)까지 — 수집은 5분마다(대개 바뀐 것 없음), 증류는 30분마다. 바뀐 실행은 점(크기 = √바뀐 수). */
function runsTimeline() {
  const from = 9 * 60 - 20, now = 16 * 60 + 2, last = now + 4;
  const x = (m) => GUT + ((m - from) / (last - from)) * (RW - GUT - PADR);
  let s = '';
  for (let h = 9; h <= 16; h++) { const gx = x(h * 60).toFixed(1); s += `<line class="t-grid" x1="${gx}" x2="${gx}" y1="6" y2="${RHH - 22}"></line><text class="t-axis" x="${gx}" y="${RHH - 6}" text-anchor="middle">${h}시</text>`; }
  //  예시 데이터 — 같은 소스는 늘 같은 그림(난수 없음).
  const changedC = { 545: 3, 600: 1, 655: 6, 720: 2, 790: 1, 835: 4, 880: 2, 930: 1, 958: 3 };
  const changedD = { 570: [4, 2], 630: [3, 1], 690: [6, 3], 750: [2, 0], 810: [5, 2], 870: [3, 2], 930: [4, 3] };
  for (const k of ['c', 'd']) {
    const y = RY[k];
    s += `<g class="t-g is-${k}"><text class="t-lane" x="0" y="${y + 4}">${k === 'c' ? '수집' : '증류'}</text><line class="t-base" x1="${GUT - 6}" x2="${x(last).toFixed(1)}" y1="${y}" y2="${y}"></line>`;
    const step = k === 'c' ? 5 : 30, start = k === 'c' ? 545 : 570;
    for (let m = start; m <= now; m += step) {
      const cx = x(m).toFixed(1);
      const ch = k === 'c' ? changedC[m] : changedD[m] ? changedD[m][0] + changedD[m][1] : 0;
      s += ch ? `<g class="t-r is-ch"><circle class="t-mk t-${k}" cx="${cx}" cy="${y}" r="${Math.min(10.5, 4.5 + 1.8 * Math.sqrt(ch)).toFixed(2)}"></circle></g>`
        : `<g class="t-r"><rect class="t-mk t-z" x="${(x(m) - 1).toFixed(1)}" y="${y - 4}" width="2" height="8" rx="1"></rect></g>`;
    }
    s += '</g>';
  }
  const nx = x(now).toFixed(1);
  s += `<line class="t-now" x1="${nx}" x2="${nx}" y1="4" y2="${RHH - 22}"></line><circle class="t-nowd" cx="${nx}" cy="4" r="3.5"></circle><text class="t-nowl" x="${(x(now) + 7).toFixed(1)}" y="8">지금 16:02</text>`;
  return `<div class="cxr-tl"><svg viewBox="0 0 ${RW} ${RHH}" role="img" aria-label="오늘 자동 실행">${s}</svg></div>`;
}
const runTile = (svc, glyph) => `<span class="cxr-tile"${svc ? ` data-svc="${svc}"` : ''}>${svc ? logo(svc) : lineIc(glyph, 'cxr-gl')}</span>`;
const num = (v) => (v ? `<b class="num">${v}</b>` : '<span class="is-z num">0</span>');
const runRow = (id, t, svc, glyph, name, kind, sum) => `<div class="cxr-it" data-f="${id}"><a class="cxr-row"><span class="cxr-t num">${t}</span>${runTile(svc, glyph)}<span class="cxr-n"><b>${name}</b><span class="cxr-kt${kind === 'd' ? ' is-d' : ''}">${kind === 'c' ? '수집기' : '증류기'}</span></span>${sum}<span class="cxr-chev" aria-hidden="true">›</span></a></div>`;
export function runsCard() {
  return `<section class="cxr" data-f="runs" aria-label="자동 실행">
    <div class="cxr-head"><b class="cxr-h">자동 실행</b><div class="cxr-stepper"><button type="button" class="cxr-stp">‹</button><button type="button" class="cxr-stp-lbl">3월 3일 (월)<small>오늘</small></button><button type="button" class="cxr-stp" disabled>›</button></div><div class="cxr-seg" role="tablist"><span class="cxr-seg-ind" aria-hidden="true" style="width:46px;transform:translateX(3px)"></span><button type="button" class="is-on">하루</button><button type="button">7일</button><button type="button">30일</button></div><span class="cxr-sub">실행 98회 · 변화 있던 실행 16회</span><a class="cxr-more-link">자세히 보기 →</a></div>
    <div class="cxr-body">${runsTimeline()}</div>
    <div class="cxr-legend"><button type="button" class="cxr-lgf is-on">전체</button><button type="button" class="cxr-lgf"><i class="cxr-dot" aria-hidden="true"></i>수집기</button><button type="button" class="cxr-lgf"><i class="cxr-dot is-d" aria-hidden="true"></i>증류기</button><span class="cxr-lsep" aria-hidden="true"></span><span><i class="cxr-lz" aria-hidden="true"></i>바뀐 것 없음</span><span class="cxr-sched"><span class="is-c">수집 5분마다 · 4분 전</span><span class="is-d">증류 30분마다 · 2분 전</span></span><span class="cxr-sp">점이 클수록 많이 바뀌었어요</span></div>
    <div class="cxr-feed">
      ${runRow('run1', '16:00', null, 'wiki', '영업팀 슬랙 대화 → 영업', 'd', `<span class="cxr-s"><span>읽은 자료 ${num(12)}</span><span class="cxr-ar">→</span><span>새 지식 ${num(2)} · 고친 지식 ${num(5)}</span></span>`)}
      ${runRow('run2', '15:58', 'slack', null, 'Slack — 영업팀 채널', 'c', `<span class="cxr-s"><span>새 자료 ${num(3)} · 바뀐 자료 ${num(1)}</span></span>`)}
      ${runRow('run3', '15:30', 'notion', null, 'Notion — 팀 문서', 'c', `<span class="cxr-s"><span>새 자료 ${num(0)} · 바뀐 자료 ${num(2)}</span></span>`)}
    </div>
  </section>`;
}

//  흐름 지도의 손질 — 영상 창은 좁다(제품의 1060px 칸). 그대로 세우면 기계 칩이 관보다 넓어 흰 카드에 겹쳐 붙는다
//   (원준 2026-11-19 «수집기랑 증류기가 너무 다닥다닥»). 화면 전체를 조금 줄여(zoom) 넓은 창의 비율로 세우고(제품의 main 폭 상한 1200 도 푼다),
//   관을 넓혀 칩 양옆으로 흐르는 선과 화살표가 보이게 한다.
export const CTX_ROOM = `html { zoom: .78; }
main#view { max-width: none; padding: 22px 26px 0; }
.ctx-board-wrap { padding-left: 0; padding-right: 0; }
.cxm-floor { padding: 24px 22px; }
.cxm-lane { overflow: visible; }
.cxm-st { min-width: 0; flex: 3 1 0; }
.cxm-duct { min-width: 0; flex: 2.4 1 0; }
.cxm-duct-c { width: 108px; }
.cxm-svts { grid-template-columns: repeat(3, 40px); gap: 9px; justify-content: center; }
[data-f="stAi"] .cxm-svts { grid-template-columns: 40px; }
.cxm-st-def { min-height: 3.1em; }
.cxr { margin-top: 14px; }
/* 도는 관 — 제품은 CSS 애니메이션으로 파선을 흘린다. 여기서는 시각 t 가 자리를 정한다(--fx). */
.cxm-wire.is-flow::after { background-position: var(--fx, 0px) 0; }`;

//  셸(레일 · 홈 · 세션 · 곁칸)을 영상에 세울 때 더하는 생김새 — 제품의 세션 화면을 그 치수로 옮긴 것과, 찍을 때만 필요한 것(깜빡이 막대 등).
//   백틱 안이다 — 템플릿 자리(${'$'}{…})를 쓰지 않는다.
export const SHELL_CSS = String.raw`@font-face { font-family: "TourMono"; src: url("/public/fonts/D2Coding.woff2") format("woff2"); font-weight: 400; }
@font-face { font-family: "TourMono"; src: url("/public/fonts/D2Coding-Bold.woff2") format("woff2"); font-weight: 700; }
/* 영상은 곁칸(세션 목록)을 접은 채로 찍는다 — 접으면 레일 위에 서는 검색 칸도 뺀다(레일의 두 칸만 보이게). */
.v2-rail-search { display: none !important; }
/* 이 가지에 아직 없는 앱 셋의 색 — 제품(밝은 테마)에서 읽은 값이다. */
:root { --gi-c-link: #0E7C86; --gi-c-archive: #8A6D3B; --gi-c-trash: #C2410C; }
.v2-frame { flex: 1; width: 100%; border: 0; display: block; background: var(--bg); }
/* 홈의 입력 칸 — textarea 는 찍을 때 깜빡이 막대가 안 나온다. 같은 생김새의 칸에 글 · 막대를 따로 그린다. */
.tf-in { position: relative; height: 65px; white-space: pre-wrap; color: var(--ink); }
.tf-ph { color: var(--muted-2); }
.tf-caret { display: inline-block; width: 1.5px; height: 1.15em; margin-left: 1px; vertical-align: -0.18em; background: var(--blue); opacity: 0; }
/* 세션 — 머리 줄과 터미널. 제품의 세션 화면을 그 치수로 옮겼다(머리 41 · 제목 22/800 · 터미널 D2Coding 13.5). */
.tf-sess { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--bg); }
.tf-door { flex: none; height: 41px; display: flex; align-items: center; gap: 10px; padding: 0 20px 0 24px; border-bottom: 1px solid var(--line); }
.tf-door .tf-proj { display: inline-flex; align-items: center; gap: 7px; font-size: 14.5px; font-weight: 800; color: var(--ink); }
.tf-door .tf-proj svg { width: 15px; height: 15px; fill: none; stroke: var(--muted); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.tf-door .mono { font-family: "TourMono", ui-monospace, monospace; font-size: 12.5px; color: var(--muted); margin-left: 12px; }
.tf-door .sep { color: var(--muted-2); }
.tf-door .tf-run { font-size: 12.5px; font-weight: 700; color: var(--blue); }
.tf-door .sp { flex: 1; }
.tf-head { flex: none; padding: 18px 28px 14px 30px; border-bottom: 1px solid var(--line); }
.tf-head-1 { display: flex; align-items: center; gap: 10px; }
.tf-head-1 .tf-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--blue); opacity: .75; }
.tf-head-1 h2 { margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -0.02em; color: var(--ink); }
.tf-head-1 .sp { flex: 1; }
.tf-head-1 .tf-conn { font-size: 13.5px; font-weight: 600; color: var(--ink-2, var(--ink)); }
.tf-head-1 .tf-more { margin-left: 18px; font-size: 16px; letter-spacing: 1px; color: var(--muted); }
.tf-head-2 { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
.tf-head-2 .pava { width: 26px; height: 26px; border-radius: 50%; display: inline-grid; place-items: center; font-size: 12px; font-weight: 800; color: #fff; }
.tf-head-2 svg { width: 17px; height: 17px; fill: none; stroke: var(--muted); stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.tf-head-2 .sp { flex: 1; }
.tf-head-2 .tf-pick { font-size: 14px; font-weight: 500; color: var(--ink); }
.tf-head-2 .tf-pick::after { content: ''; display: inline-block; margin-left: 7px; border: 4.5px solid transparent; border-top-color: var(--muted); vertical-align: -3px; }
.tf-term { flex: 1; min-height: 0; clip-path: inset(16px 0 0 0); padding: 20px 30px; font-family: "TourMono", ui-monospace, monospace; font-size: 13.5px; line-height: 1.55; color: var(--ink); overflow: hidden; }
.tf-ln { white-space: pre; min-height: 1.55em; }
.tf-ln.me { background: var(--bg-tint-2); margin: 0 -8px 16px; padding: 1px 8px; border-radius: 3px; font-weight: 700; }
.tf-ln.sub { color: var(--muted); }
.tf-ln.gap { margin-top: 14px; }
.tf-ln .ok { color: var(--mint-deep, #0E9F7B); }
.tf-ln .file { color: var(--blue); font-weight: 700; }
.tf-ln .wait { color: var(--warn-text, #B36E18); }
.tf-row { flex: 1; min-height: 0; display: flex; }
.tf-row > .tf-sess { min-width: 0; }
.tf-sidebtn { margin-left: 6px; width: 30px; height: 30px; display: grid; place-items: center; border: 0; border-radius: 7px; background: none; color: var(--muted); }
.tf-sidebtn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linejoin: round; }
.tf-sidebtn.on { background: var(--bg-tint-2); color: var(--ink); }
.tf-aside { flex: none; width: 0; overflow: hidden; border-left: 1px solid var(--line); background: var(--bg); }
.tf-aside-in { width: 372px; height: 100%; display: flex; flex-direction: column; }
.tf-dock { flex: none; display: flex; gap: 6px; padding: 12px 14px 10px; border-bottom: 1px solid var(--line); }
.tf-dk { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 6px 0 5px; border: 0; border-radius: 10px; background: none; font: inherit; }
.tf-dk-ic svg { display: block; width: 36px; height: 36px; }
.tf-dk-ic .v2-gi-tile { fill: var(--gi-tile); stroke: var(--gi-tile-line); }
.tf-dk-ic .v2-gi-glyph { fill: none; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.tf-dk-t { font-size: 11px; font-weight: 600; color: var(--muted); }
.tf-dk.on { background: var(--bg-tint-2); }
.tf-dk.on .tf-dk-t { color: var(--ink); font-weight: 800; }
.tf-pane { flex: 1; min-height: 0; overflow: hidden; }
.tf-pane > .pn-part { height: 100%; }
.tf-pi { width: 14px; height: 14px; fill: none; stroke: var(--muted); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.pn-tk-name { font-size: 13px; font-weight: 800; color: var(--ink); }
.pn-tk-count { margin-left: auto; }
.tf-fhead { display: flex; align-items: center; gap: 8px; padding: 12px 14px 10px; border-bottom: 1px solid var(--line); }
.tf-fcrumb { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 800; color: var(--ink); }
.tf-fhead .pn-fine { margin-left: auto; }
.tf-flist { padding: 8px; display: flex; flex-direction: column; gap: 2px; }
.tf-flist .pn-frow2 { padding: 7px 8px; }
.tf-flist .pn-fname1 { flex: 1; min-width: 0; font-weight: 600; }
.tf-flist .pn-fcol { font-size: 11.5px; color: var(--muted-2); }
.tf-flist .pn-fcol.k { width: 38px; } .tf-flist .pn-fcol.s { width: 46px; text-align: right; }
.tf-fic { flex: none; width: 26px; height: 20px; border-radius: 4px; display: grid; place-items: center; font-size: 7.5px; font-weight: 800; letter-spacing: .02em; color: #fff; background: var(--fc); }
.tf-new { background: color-mix(in srgb, var(--blue) 9%, transparent); border-color: color-mix(in srgb, var(--blue) 30%, transparent) !important; }
.tf-drop { margin: 6px 14px; padding: 12px; border: 1.5px dashed var(--line-net, var(--line)); border-radius: 10px; font-size: 11.5px; line-height: 1.5; color: var(--muted); text-align: center; }
.tf-web { height: 100%; display: flex; flex-direction: column; }
.tf-url { flex: none; margin: 10px 12px 8px; height: 30px; display: flex; align-items: center; gap: 6px; padding: 0 10px; border-radius: 8px; background: var(--bg-tint-2); font-size: 12px; color: var(--ink); }
.tf-url-ic svg { display: block; width: 12px; height: 12px; fill: none; stroke: var(--muted); stroke-width: 2; }
.tf-page { flex: none; margin: 0 12px; height: 300px; border: 1px solid var(--line); border-radius: 10px; padding: 14px; background: #fff; opacity: 0; }
.tf-pg-nav { display: flex; gap: 12px; align-items: baseline; font-size: 10.5px; color: #6b7280; }
.tf-pg-nav b { font-size: 13px; color: #111827; margin-right: auto; letter-spacing: .04em; }
.tf-pg-h { margin: 22px 0 12px; font-size: 20px; font-weight: 800; color: #111827; }
.tf-pg-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.tf-pg-cards > div { padding: 10px 8px; border: 1px solid #e5e7eb; border-radius: 8px; display: flex; flex-direction: column; gap: 6px; }
.tf-pg-cards > div.on { border-color: #7c3aed; box-shadow: 0 0 0 1px #7c3aed; }
.tf-pg-cards b { font-size: 12px; color: #111827; }
.tf-pg-cards i { display: block; height: 6px; border-radius: 3px; background: #eef0f4; }
.tf-pg-ln { margin-top: 18px; height: 7px; border-radius: 4px; background: #eef0f4; } .tf-pg-ln.s { width: 60%; margin-top: 8px; }
.tf-ai { margin: 12px 12px 0; padding: 9px 11px; border-radius: 8px; background: var(--bg-tint); font-size: 12px; color: var(--ink); opacity: 0; }
.tf-ai .ok { color: var(--mint-deep, #0E9F7B); }
.tf-ln.me.gap2 { margin-top: 18px; }
.tf-bcaret { display: inline-block; width: 7px; height: 1.15em; margin-left: 1px; vertical-align: -3px; background: var(--ink); opacity: 0; }
.tf-mail { flex: none; margin: 0 12px; border: 1px solid var(--line); border-radius: 10px; background: #fff; overflow: hidden; opacity: 0; }
.tf-mh { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-bottom: 1px solid #eef0f4; font-size: 12px; font-weight: 800; color: #111827; }
.tf-mh i { width: 16px; height: 16px; border-radius: 4px; background: #2D6BF0; display: inline-block; }
.tf-mf { display: flex; gap: 8px; padding: 8px 12px; border-bottom: 1px solid #f1f3f6; font-size: 12px; color: #111827; min-height: 33px; align-items: center; }
.tf-mf > b { width: 48px; flex: none; font-weight: 500; color: #6b7280; }
.tf-mbody { padding: 10px 12px; font-size: 12px; line-height: 1.6; color: #111827; height: 112px; white-space: pre-wrap; }
.tf-matt { display: inline-flex; align-items: center; gap: 6px; margin: 0 12px 10px; padding: 5px 9px; border: 1px solid #e5e7eb; border-radius: 7px; font-size: 11.5px; font-weight: 600; color: #111827; opacity: 0; }
.tf-mfoot { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-top: 1px solid #eef0f4; }
.tf-msend { padding: 6px 16px; border: 0; border-radius: 7px; background: #2D6BF0; color: #fff; font: inherit; font-size: 12px; font-weight: 700; }
.tf-msent { margin-left: auto; font-size: 11.5px; font-weight: 700; color: var(--mint-deep, #0E9F7B); opacity: 0; }
.v2-dest-row.tf-hov { background: var(--bg-tint); }
.tf-box { margin-top: 22px; border-top: 1px solid var(--line-net, var(--line)); border-bottom: 1px solid var(--line-net, var(--line)); padding: 7px 0; color: var(--muted); }
`;
