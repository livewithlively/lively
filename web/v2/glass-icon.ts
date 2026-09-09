// v2/glass-icon.ts — 유리 앱 아이콘(#1841)의 집. **리프 모듈**(import 0) — apps.ts 에서 떼어 냈다(#3830).
//  왜 떼었나: 맥락 관리 표지(web/context-map.ts, 클래식 번들)가 역마다 유리 문패를 세운다. 그 화면이 apps.ts 를
//  물면 셸 레지스트리(shell-prefs·app-session·app-instance)가 통째로 따라오고 되짚는 간선이 생긴다.
//  심볼의 집이 되짚지 않는 리프면 읽는 쪽이 몇이어도 간선이 안 는다(scripts/check-imports.mjs 주석의 그 기준).
//  apps.ts 는 여기서 받아 그대로 다시 내보낸다 — 기존 import 자리(views.ts 등)는 그대로다.

// ── 런치패드 아이콘 — 유리 (#1841) ──────────────────────────────────────────
//  위 appIcon() 은 **선 글리프**다(사이드바 행·칸 머리처럼 글자 옆 16px 자리). 런치패드는 다르다:
//  거기서 아이콘은 글자를 거드는 표식이 아니라 **그 앱 자체**라 채운 그림이어야 한다.
//  자료 폴더 아이콘(panes-kit folderIcon)이 같은 이유로 혼자 채운 그림인 것과 같은 판단이다.
//
//  ⚠ **아이콘만** 바꾼다(원준 2026-08-22: "배경 블러 정도 바꾸지 말고 그냥 다른 거 바꾸지 마").
//   런치패드의 배경·흐림·격자·카드·제목·설명 줄은 손대지 않는다 — 한 번 그 전부를 같이 바꿨다가
//   화면이 통째로 달라져 반려됐다. 여기서 더하는 CSS 도 `.v2-gi*` 와 램프 토큰뿐이다.
//
//  ── 규칙(레퍼런스 해부 + 리뷰 6회로 굳은 것) ──
//   ① 색은 **한 계열 하나**. 구분은 색이 아니라 **형태**가 한다.
//      예외 둘 다 램프를 안 벗어난다: 설정은 우리 회색 토큰 램프(muted), 웹은 램프의 앞자락만(span).
//   ② 구성은 **둘의 겹침** — 진한 색 도형 하나 + 서리 도형 하나. 그 겹친 자리가 유리다.
//   ③ 서리는 **색이 평평**하다. 투명도만 20% 폭으로 눕혀 깊이를 준다.
//   ④ 그림자·글로우 **없음**. 색 halo 를 깔면 그게 '네온'이 된다.
//   ⑤ 유리 뒤는 **초점이 나간다**. 겹친 자리에만 흐린 색을 되돌린다.
//   ⑥ 흰색은 서리 + 빛띠 **둘까지**. 안쪽 흰 모서리까지 얹으면 도형마다 흰 테가 돈다
//      (웹만 rim 예외 — 서리 고리가 색 구체를 가로지르는 구성이라 없으면 고리가 묻힌다).
//   ⑦ 서리끼리는 겹치지 않는다. 겹치면 한 덩어리로 뭉개진다.
//
//  ⚠ 색 램프는 **CSS 토큰**이다(--gi-r0..3 / 설정용 --gi-m0..3). 라이트에선 끝을 밝게 가야 한다 —
//   다크에서 좋던 딥블루가 라이트에선 혼자 무겁다. 가운데는 두 테마 모두 시그니처 민트(--mint).
//  ⚠ 서리 **색**은 CSS 에서 `.v2-gi { color: … }` 로 준다. 서리의 옅은 기울기가 currentColor 를 쓰는데,
//   그건 그라디언트가 얹힌 **svg 자신의** color 를 보지 참조하는 도형의 color 를 보지 않는다.
//  ⚠ id 는 인스턴스마다 유일해야 한다 — 같은 id 가 여럿이면 브라우저가 첫 것만 써서 색이 굳는다.

interface GlassArt {
  span?: number[];      // 램프가 가로지를 구간 = 그 아이콘 **색 도형의 바운딩 박스** 대각선.
                        //  공통 대각선으로 두면 색 도형이 그 일부만 차지하는 아이콘은 램프 앞자락(민트)만 쓴다.
  color?: string;       // 진한 색 도형
  frost?: string;       // 서리 도형
  punch?: string;       // 흰색으로 뚫은 자리(유리에 난 구멍)
  over?: string;        // 유리 **위에** 색으로 얹는 것 — 흰색으로는 대비가 안 나는 자리
  overFrost?: string;   // 유리 스타일로 맨 위에 — 행성 고리가 구체 **앞을 지나는** 반쪽
  frostFirst?: boolean; // 서리가 색 뒤로 가는 구성
  rim?: boolean;        // 흰 안쪽 테두리(규칙 ⑥의 예외)
  muted?: boolean;      // 탈색 램프(설정)
}

const GLASS_ART: Record<string, GlassArt> = {
  // 대시보드 — 머리띠(서리) · 본문 판(색) · 곁 위젯 하나(서리). 판 넷은 번잡했다.
  //  세 덩어리면 '화면 배치'가 읽히고, 그 이상은 잔무늬가 된다.
  home: {
    span: [5, 15, 40, 58],
    color: '<rect x="5" y="15" width="33" height="43" rx="4.5"/>',
    frost: '<rect x="5" y="5" width="54" height="15" rx="4.5"/><rect x="42" y="25" width="17" height="33" rx="4.5"/>',
    punch: '<rect x="11" y="29" width="20" height="2.8" rx="1.4"/><rect x="11" y="37" width="13" height="2.8" rx="1.4"/>',
  },
  // 터미널 창 — 색 타이틀바 + 서리 본문. 프롬프트는 **유리 위에** 색으로 얹는다(over).
  //  흰색으로 뚫으면 옅은 서리 위라 대비가 안 나 안 읽힌다.
  term: {
    span: [5, 11, 59, 53],
    color: '<path d="M10.5 11h43a5 5 0 0 1 5 5v7.5H5.5V16a5 5 0 0 1 5-5z"/>',
    frost: '<path d="M5.5 20.5h53V48a5 5 0 0 1-5 5h-43a5 5 0 0 1-5-5z"/>',
    punch: '<circle cx="14" cy="17.5" r="2.5"/><circle cx="22.6" cy="17.5" r="2.5"/><circle cx="31.2" cy="17.5" r="2.5"/>',
    over: '<path d="M15 32.5l7 6.4-7 6.4" stroke-width="3.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<path d="M28 45.4h14.5" stroke-width="3.7" fill="none" stroke-linecap="round"/>',
  },
  // 태스크 목록 + 체크 — 서리 카드에 흰 줄(할 일) 세 개, 그 위를 색 체크가 가로지른다.
  //  체크의 오른팔은 카드 **밖으로 나간다** — 유리 안에서는 부옇고 밖에서는 선명하다(겹침의 문법).
  proj: {
    span: [13, 14, 58, 46],
    color: '<path d="M24.5 36.5l7.5 7.5L58 13.5" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    frost: '<rect x="5" y="10" width="39" height="44" rx="5.5"/>',
    punch: '<rect x="13" y="21" width="21" height="3.6" rx="1.8"/><rect x="13" y="31" width="15" height="3.6" rx="1.8"/>',
  },
  // 자료 — **어긋나게 포갠 낱장 둘**. 뒤 장(색)이 기울어 있고 앞 장(서리)이 정면으로 겹친다.
  //  겹친 자리가 유리이고, 뒤 장이 왼쪽·아래로 삐져나오는 자리가 층을 만든다.
  //  ⚠ 상자로 그리지 마라 — 사이드바 발치의 「아카이브」와 같은 형태가 된다(첫 판이 그랬다, 원준 지적).
  //   책(위키)·카드+체크(프로젝트)·판 셋(홈)과도 갈린다: 자료는 **제본되지 않은 낱장이 여러 장**이다.
  //   접힌 모서리는 흰색으로 뚫어(punch) 서리 위에서도 읽히게 한다.
  src: {
    span: [7, 10, 41, 58],
    color: '<rect x="7" y="10" width="34" height="48" rx="5" transform="rotate(-13 24 34)"/>',
    frost: '<path d="M30 11h13l9 9v33a4 4 0 0 1-4 4H30a4 4 0 0 1-4-4V15a4 4 0 0 1 4-4z"/>',
    punch: '<path d="M43 11v9h9z"/>',
  },
  // 펼친 책 — 오른쪽 면이 색, 왼쪽 면이 서리. 두 면의 재질이 달라 펼쳐진 게 읽힌다.
  wiki: {
    span: [33, 11, 59, 53],
    color: '<path d="M33.6 17.2c4.9-3.9 11.3-6 18.1-6h4.7a2.6 2.6 0 0 1 2.6 2.6v30.5a2.6 2.6 0 0 1-2.6 2.6h-4.7c-6.8 0-13.2 2.1-18.1 6z"/>',
    frost: '<path d="M30.4 17.2c-4.9-3.9-11.3-6-18.1-6H7.6A2.6 2.6 0 0 0 5 13.8v30.5a2.6 2.6 0 0 0 2.6 2.6h4.7c6.8 0 13.2 2.1 18.1 6z"/>',
  },
  // 깔때기 — 위로 들어온 것이 좁아지며 걸러진다. 수집→증류→분류가 이 형태 하나에 다 있다.
  //  서리 입구 바가 깔때기 아가리를 덮는다(레퍼런스 폴더의 '탭이 삐져나오는' 문법과 같은 자리).
  ctx: {
    span: [8, 17, 56, 56],
    color: '<path d="M9.5 17h45a2 2 0 0 1 1.5 3.3L38.2 40.4v11.3a2 2 0 0 1-1.1 1.8l-6.8 3.4A2 2 0 0 1 27.4 55V40.4L8 20.3A2 2 0 0 1 9.5 17z"/>',
    frost: '<rect x="8" y="6" width="38" height="12.5" rx="4"/>',
  },
  // 겹친 말풍선 — 세션 이력의 실체는 시간이 아니라 **지난 대화 기록**이다.
  //  시계는 게으른 은유였다: '이력=시계'는 이 앱이 무엇인지 아무것도 말하지 않는다(원준 2026-08-21 반려).
  // AI 세션 — 말풍선 하나(색) + 흰 줄 둘. 사이드바 세션 행의 말풍선과 같은 뜻(#2016 6차, 터미널 창 아이콘 폐기).
  chat: {
    span: [5, 8, 59, 56],
    color: '<path d="M14 8h36a9 9 0 0 1 9 9v22a9 9 0 0 1-9 9H30l-13 11 1.8-11H14a9 9 0 0 1-9-9V17a9 9 0 0 1 9-9z"/>',
    punch: '<rect x="15" y="20" width="26" height="3.6" rx="1.8"/><rect x="15" y="29" width="17" height="3.6" rx="1.8"/>',
  },
  //  앞 풍선이 색, 뒤 풍선이 서리 — 뒤집기 전(앞이 서리)에는 색 덩어리가 뒤로 밀려 창백했다.
  //  ⚠ 안의 흰 것은 **줄**이지 점이 아니다. 점 셋은 '지금 입력 중'으로 읽혀 지난 기록과 뜻이 어긋난다.
  sess: {
    span: [5, 21, 43, 48],
    frost: '<path d="M36 7h17a6 6 0 0 1 6 6v14a6 6 0 0 1-6 6H36a6 6 0 0 1-6-6V13a6 6 0 0 1 6-6z"/>',
    color: '<path d="M11 21h26a6 6 0 0 1 6 6v13a6 6 0 0 1-6 6h-9.5l-9 8 1.2-8H11a6 6 0 0 1-6-6V27a6 6 0 0 1 6-6z"/>',
    punch: '<rect x="11.5" y="29.5" width="20" height="3.2" rx="1.6"/><rect x="11.5" y="36.5" width="13" height="3.2" rx="1.6"/>',
    frostFirst: true,
  },
  // 톱니 — **별이 되는 조건**을 피한 비율이다. 앞판은 골이 4°뿐이라 이빨 사이가 뾰족한 점으로 만났고,
  //  그게 정확히 별의 정의였다. 기어로 읽히려면 ① 골이 원호로 충분히 보이고(12°) ② 깊이가 얕고(22%)
  //  ③ 이빨 사이로 **원형 몸통**이 드러나야 한다. 실제 기어는 피치원에서 이빨과 골의 폭이 비슷하다.
  //  8톱니 · 이빨 20° · 옆면 6.5°×2 · 골 12° · 팁 26 / 골바닥 20.4.
  sys: {
    span: [7, 6, 58, 58],
    muted: true,   // 기계는 무채색으로
    color: '<path d="M27.49 6.39A26 26 0 0 1 36.51 6.39L37.79 12.44A20.4 20.4 0 0 1 41.73 14.07L46.91 10.7A26 26 0 0 1 53.3 17.09L49.93 22.27A20.4 20.4 0 0 1 51.56 26.21L57.61 27.49A26 26 0 0 1 57.61 36.51L51.56 37.79A20.4 20.4 0 0 1 49.93 41.73L53.3 46.91A26 26 0 0 1 46.91 53.3L41.73 49.93A20.4 20.4 0 0 1 37.79 51.56L36.51 57.61A26 26 0 0 1 27.49 57.61L26.21 51.56A20.4 20.4 0 0 1 22.27 49.93L17.09 53.3A26 26 0 0 1 10.7 46.91L14.07 41.73A20.4 20.4 0 0 1 12.44 37.79L6.39 36.51A26 26 0 0 1 6.39 27.49L12.44 26.21A20.4 20.4 0 0 1 14.07 22.27L10.7 17.09A26 26 0 0 1 17.09 10.7L22.27 14.07A20.4 20.4 0 0 1 26.21 12.44Z"/>',
    frost: '<circle cx="32" cy="32" r="10.6"/>',
  },
  // 행성 — 고리가 구체를 **감싼다**. 앞판은 타원이 구체 '위에 얹혀' 있어 행성으로 안 읽혔다(원준 2026-08-21).
  //  감싸려면 고리를 두 번 그린다: ① 고리 전체를 구체 **밑에** → ② 구체 → ③ 앞쪽 반만 다시 **위에**(overFrost).
  //  앞쪽 반은 클립이 아니라 기하로 잘랐다 — 바깥·안쪽 타원의 아래쪽 호만 이은 고리 조각.
  web: {
    span: [12, 12, 52, 52],
    frost: '<path fill-rule="evenodd" d="M2 32A30 9.6 0 1 0 62 32A30 9.6 0 1 0 2 32ZM6.8 32A25.2 5.6 0 1 1 57.2 32A25.2 5.6 0 1 1 6.8 32Z" transform=\"rotate(-18 32 32)\"/>',
    color: '<circle cx="32" cy="32" r="20"/>',
    overFrost: '<path d="M2 32A30 9.6 0 0 0 62 32L57.2 32A25.2 5.6 0 0 1 6.8 32Z" transform=\"rotate(-18 32 32)\"/>',
    frostFirst: true,
  },
  // 학사모 — 색 판(위에서 보는 면) + 서리 몸통.
  learn: {
    span: [5, 8, 59, 34],
    color: '<path d="M30.8 7.9a2.8 2.8 0 0 1 2.4 0l25.4 11.4a1.7 1.7 0 0 1 0 3.1L33.2 33.8a2.8 2.8 0 0 1-2.4 0L5.4 22.4a1.7 1.7 0 0 1 0-3.1z"/>',
    frost: '<path d="M15 28.5v13.4c0 5.8 7.6 10.5 17 10.5s17-4.7 17-10.5V28.5L33.4 35.1a4.2 4.2 0 0 1-2.8 0z"/>',
  },
  // 사각 넷 — 둘은 색, 둘은 서리. 대각으로 엇갈린다.
  apps: {
    span: [5, 5, 59, 59],
    color: '<rect x="5.5" y="5.5" width="24" height="24" rx="5.5"/><rect x="34.5" y="34.5" width="24" height="24" rx="5.5"/>',
    frost: '<rect x="34.5" y="5.5" width="24" height="24" rx="5.5"/><rect x="5.5" y="34.5" width="24" height="24" rx="5.5"/>',
  },
  // 리브 — 색 고리 + 유리 원반 + 색 코어. 펄스 돗이 퍼져 나가는 모양 그대로다.
  //  고리를 서리로 두면 세트에서 혼자 창백해진다 — 색 덩어리를 바깥에 준다.
  liv: {
    span: [7, 7, 57, 57],
    color: '<path fill-rule="evenodd" d="M32 7.5a24.5 24.5 0 1 0 0 49 24.5 24.5 0 1 0 0-49Zm0 5.4a19.1 19.1 0 1 1 0 38.2 19.1 19.1 0 1 1 0-38.2Z"/>',
    frost: '<circle cx="32" cy="32" r="16"/>',
    over: '<circle cx="32" cy="32" r="8.4"/>',
  },
};

let glassSeq = 0;
/** 런치패드용 유리 앱 아이콘(64×64). 글자 옆 16px 자리에는 이걸 쓰지 말고 appIcon() 을 쓴다. */
export function appGlassIcon(icon: string, cls?: string): SVGElement {
  const n = ++glassSeq;
  const a: GlassArt = GLASS_ART[icon] || GLASS_ART.apps;
  const color = a.color || '', frost = a.frost || '';
  const sp = a.span || [6, 4, 58, 60];
  const pre = a.muted ? '--gi-m' : '--gi-r';
  const R = [0, 1, 2, 3].map((i) => `var(${pre}${i})`);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('class', 'v2-gi ' + (cls || ''));
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    `<defs>`
    + `<linearGradient id="gk${n}" gradientUnits="userSpaceOnUse" x1="${sp[0]}" y1="${sp[1]}" x2="${sp[2]}" y2="${sp[3]}">`
    + `<stop offset="0" stop-color="${R[0]}"/><stop offset=".32" stop-color="${R[1]}"/>`
    + `<stop offset=".66" stop-color="${R[2]}"/><stop offset="1" stop-color="${R[3]}"/></linearGradient>`
    + `<linearGradient id="gf${n}" gradientUnits="userSpaceOnUse" x1="8" y1="6" x2="56" y2="58">`
    + `<stop offset="0" stop-color="currentColor" stop-opacity="1"/>`
    + `<stop offset="1" stop-color="currentColor" stop-opacity=".74"/></linearGradient>`
    + `<linearGradient id="gh${n}" gradientUnits="userSpaceOnUse" x1="6" y1="10" x2="34" y2="46">`
    + `<stop offset="0" stop-color="#FFFFFF" stop-opacity="0"/>`
    + `<stop offset=".45" stop-color="#FFFFFF" stop-opacity=".26"/>`
    + `<stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>`
    + `<clipPath id="gp${n}">${frost}</clipPath>`
    + `<filter id="gs${n}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.6"/></filter>`
    + `</defs>`
    + (a.frostFirst
      ? `<g class="v2-gi-frost" fill="url(#gf${n})">${frost}</g><g fill="url(#gk${n})" stroke="url(#gk${n})">${color}</g>`
      : `<g fill="url(#gk${n})" stroke="url(#gk${n})">${color}</g>`
        + `<g class="v2-gi-frost" fill="url(#gf${n})">${frost}</g>`
        + `<g clip-path="url(#gp${n})" filter="url(#gs${n})" fill="url(#gk${n})" stroke="url(#gk${n})" opacity=".5">${color}</g>`)
    + `<g clip-path="url(#gp${n})"><rect x="-18" y="-12" width="26" height="120" fill="url(#gh${n})" transform="rotate(-32 32 32)"/></g>`
    + `<g clip-path="url(#gp${n})" class="v2-gi-edge">`
    + (a.rim ? `<g fill="none" stroke="#FFFFFF" stroke-opacity=".8" stroke-width="2" transform="translate(-1.1 -1.1)">${frost}</g>` : '')
    + `<g fill="none" stroke="#0B2A3A" stroke-opacity=".085" stroke-width="2.6" transform="translate(1.3 1.3)">${frost}</g>`
    + `</g>`
    + (a.punch ? `<g class="v2-gi-punch">${a.punch}</g>` : '')
    + (a.over ? `<g fill="${R[3]}" stroke="${R[3]}">${a.over}</g>` : '')
    + (a.overFrost ? `<g class="v2-gi-frost" fill="url(#gf${n})">${a.overFrost}</g>` : '');
  return svg;
}
