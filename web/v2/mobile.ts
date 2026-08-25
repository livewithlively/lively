// v2/mobile.ts — 새 셸의 **모바일 크롬**(#1777, 상민님 2026-08-19 "모바일 화면 대응 — 특히 세션뷰").
//
//  ≤900px 에선 세 칸 그리드(사이드바 | 가운데 | 우패널)를 그대로 둘 수 없다 — 390px 폰에서 사이드바 220px 를 빼면
//  대화창이 164px 로 남는다(실측). 그래서 폭이 좁으면:
//   · 가운데가 화면 전부를 쓴다(1열).
//   · 사이드바 = 왼쪽 **서랍**(오프캔버스). ☰ 로 열고, 배경 탭·Esc·**어디로든 이동**(hashchange)하면 닫힌다.
//   · 우패널(타임라인) = 오른쪽 서랍. 상단 바 오른쪽 [타임라인] 으로 연다. no-aside 화면(앱 프레임)에선 버튼이 없다.
//   · 상단 바 하나(.v2-mbar): [☰] [현재 앱 이름] [타임라인]. 열린 앱 사이 이동·닫기는 왼쪽 서랍의 앱 목록이 맡고,
//     바에는 현재 위치만 한 줄로 보여 준다(폰에서 크롬 한 줄은 대화 세 줄이다).
//  데스크톱(>900px)에선 바·배경막이 display:none 이고 서랍 클래스도 무시된다(40-v2.css) — 데스크톱 그림은 그대로다.
//  판정은 CSS 미디어쿼리 하나(MQ)와 같은 문턱을 JS 도 본다(matchMedia) — 두 곳이 어긋나면 서랍이 열렸는데 안 보인다.
import { el, sv } from '../core.js';

export const MOBILE_MQ = '(max-width: 900px)';   // = 40-v2.css 모바일 블록의 문턱(종전 우패널 숨김 문턱과 같다 — 태블릿 세로 포함)

export interface MobileChrome {
  bar: HTMLElement;
  scrim: HTMLElement;
  /** 이전 셸 호환용 — 전달된 탭 줄을 모바일 바로 옮기고 데스크톱에서 제자리로 돌린다. 새 셸은 호출하지 않는다. */
  adoptStrip(strip: HTMLElement, restore: () => void): void;
  /** 우측 서랍 버튼 — false 면 숨긴다(no-aside 화면). */
  setAside(on: boolean): void;
  /** 우측 서랍을 연다 — 곁칸에 무언가를 실었을 때(미리보기). 데스크톱에선 상주 열이라 할 일이 없다. */
  openAside(): void;
  /** 사이드바 서랍 여닫이(☰) — 데스크톱 앱에선 이 단추가 창 맨 윗줄 맨 왼쪽으로 간다(#1954 3차). */
  menuBtn: HTMLElement;
  closeAll(): void;
  isMobile(): boolean;
}

/** #v2-root 에 모바일 크롬을 단다. bar 는 root 맨 앞, scrim 은 맨 뒤에 호출자가 끼운다(그리드 열 순서를 안 건드리게). */
export function mountMobileChrome(root: HTMLElement, side: HTMLElement, aside: HTMLElement): MobileChrome {
  const mq = window.matchMedia(MOBILE_MQ);
  const isMobile = (): boolean => mq.matches;

  // 아이콘 — 라인, 채움 없음(DS 규약). 24 뷰박스, 사이드바·탭과 같은 붓.
  const icon = (paths: string[]): SVGElement => sv('svg', { viewBox: '0 0 24 24', class: 'v2-mbar-ic', 'aria-hidden': 'true' }, ...paths.map((d) => sv('path', { d })));
  const menuBtn = el('button', { class: 'v2-mbar-btn v2-mbar-menu', type: 'button', 'aria-label': '탐색 열기', 'aria-expanded': 'false', 'aria-controls': 'v2-side' },
    icon(['M4 7h16M4 12h16M4 17h16'])) as HTMLButtonElement;
  //  제목은 두지 않는다(#1954 3차 상민님) — 창 맨 윗줄은 폭이 넓든 좁든 **같은 것**이어야 한다.
  //  지금 무엇을 보고 있는지는 좌측 목록의 활성 행이 이미 말하고, 화면 제목은 본문 문패가 든다.
  const slot = el('div', { class: 'v2-mbar-slot' });
  const asideBtn = el('button', { class: 'v2-mbar-btn v2-mbar-aside', type: 'button', 'aria-label': '타임라인 열기', 'aria-expanded': 'false', 'aria-controls': 'v2-aside', title: '이 화면의 타임라인' },
    icon(['M12 4v16', 'M12 8h6', 'M12 14h6', 'M6 6h2', 'M6 12h2', 'M6 18h2'])) as HTMLButtonElement;
  const bar = el('div', { class: 'v2-mbar' }, menuBtn, slot, asideBtn) as HTMLElement;
  const scrim = el('div', { class: 'v2-scrim', hidden: true, 'aria-hidden': 'true' }) as HTMLElement;
  side.id = side.id || 'v2-side';
  aside.id = aside.id || 'v2-aside';
  // 서랍 자체가 포커스를 받을 수 있어야 열었을 때 초점이 안으로 들어간다(검색칸에 바로 주면 iOS 키보드가 튀어 오른다).
  side.tabIndex = -1; aside.tabIndex = -1;

  type Which = 'side' | 'aside';
  let open: Which | null = null;
  const paint = (): void => {
    root.classList.toggle('m-side', open === 'side');
    root.classList.toggle('m-aside', open === 'aside');
    scrim.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open === 'side'));
    asideBtn.setAttribute('aria-expanded', String(open === 'aside'));
  };
  // returnFocus — 키보드(Esc)로 닫았을 때만 연 버튼으로 초점을 돌려준다(서랍이 닫혔는데 초점이 보이지 않는 곳에 남으면 키보드·
  //  스크린리더 사용자가 길을 잃는다). 손가락으로 닫았을 땐 초점을 흘려보낸다 — 버튼에 초점을 주면 브라우저가 포커스 링을 그린다.
  const closeAll = (returnFocus = false): void => {
    if (!open) return;
    const was = open;
    open = null; paint();
    const panel = was === 'side' ? side : aside;
    if (returnFocus) { (was === 'side' ? menuBtn : asideBtn).focus({ preventScroll: true }); }
    else if (panel.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  };
  const openOne = (w: Which): void => {
    if (!isMobile()) return;
    open = w; paint();
    const panel = w === 'side' ? side : aside;
    panel.focus({ preventScroll: true });
    // 사이드바 트리는 수백 행 — 지금 보는 행이 보이게 살짝 굴린다(열린 뒤라야 굴릴 스크롤 상자가 화면 안에 있다).
    if (w === 'side') { const on = side.querySelector<HTMLElement>('.v2-tree .on'); if (on) on.scrollIntoView({ block: 'center' }); }
  };
  menuBtn.addEventListener('click', () => (open === 'side' ? closeAll() : openOne('side')));
  asideBtn.addEventListener('click', () => (open === 'aside' ? closeAll() : openOne('aside')));
  scrim.addEventListener('click', () => closeAll());
  document.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Escape' && open) { e.stopPropagation(); closeAll(true); } }, true);
  // 서랍 안에서 어디로든 가면 닫는다 — 링크(프로젝트·세션·리브·앱)와 런치패드 버튼. 펼침 화살표·필터·돋보기는 stopPropagation 이라 안 닫힌다.
  //  같은 곳을 다시 누르면 hashchange 가 없으므로 클릭에서도 닫아야 한다.
  side.addEventListener('click', (e: Event) => {
    const t = e.target as HTMLElement | null;
    if (t && t.closest && t.closest('a[href], .v2-apps-btn, .v2-ws-item, .v2-ws-team-open')) closeAll();
  });
  aside.addEventListener('click', (e: Event) => {
    const t = e.target as HTMLElement | null;
    if (t && t.closest && t.closest('a[href]')) closeAll();
  });
  window.addEventListener('hashchange', () => closeAll());

  // 탭 줄 입양 — 모바일이면 바 가운데, 아니면 제자리. 회전·리사이즈로 문턱을 넘나들 때마다 옮긴다(DOM 이동이라 탭 상태는 그대로).
  let strip: { el: HTMLElement; restore: () => void } | null = null;
  const placeStrip = (): void => {
    if (!strip) return;
    if (isMobile()) { if (strip.el.parentElement !== slot) slot.replaceChildren(strip.el); }
    else if (strip.el.parentElement === slot) strip.restore();
  };
  // 창이 넓어지면(회전·리사이즈) 서랍 상태를 버린다 — 데스크톱 그리드에 m-side 가 남아 있으면 안 된다.
  const onMq = (): void => { if (!mq.matches) closeAll(); placeStrip(); };
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onMq); else (mq as any).addListener(onMq);

  return {
    bar, scrim, isMobile, closeAll: () => closeAll(),
    adoptStrip(el0: HTMLElement, restore: () => void): void { strip = { el: el0, restore }; placeStrip(); },
    setAside(on: boolean): void {
      asideBtn.hidden = !on;
      if (!on && open === 'aside') closeAll();
    },
    openAside(): void { if (isMobile() && !asideBtn.hidden && open !== 'aside') openOne('aside'); },
    menuBtn,
  };
}
