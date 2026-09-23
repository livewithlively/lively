// v2/mobile.ts — 새 셸의 **모바일 크롬**(#1777, 상민님 2026-08-19 "모바일 화면 대응 — 특히 세션뷰" · #4088 폰 전면 정비).
//
//  ≤900px 에선 세 칸 그리드(사이드바 | 가운데 | 우패널)를 그대로 둘 수 없다 — 390px 폰에서 사이드바 220px 를 빼면
//  대화창이 164px 로 남는다(실측). 그래서 폭이 좁으면:
//   · 가운데가 화면 전부를 쓴다(1열).
//   · 사이드바 = 왼쪽 **서랍**(오프캔버스). ☰ 로 열고, 배경 탭·Esc·**어디로든 이동**(hashchange)하면 닫힌다.
//   · 우패널(타임라인) = 오른쪽 서랍. 맨 윗줄 오른쪽 [타임라인] 으로 연다. no-aside 화면(앱 프레임)에선 버튼이 없다.
//   · 상단 바 하나(.v2-mbar): 이전 셸 호환용 — 새 셸은 ☰·[타임라인] 을 창 맨 윗줄로 옮겨 이 바는 비어 있다(숨김).
//  데스크톱(>900px)에선 바·배경막이 display:none 이고 서랍 클래스도 무시된다(40-v2.css) — 데스크톱 그림은 그대로다.
//  판정은 CSS 미디어쿼리 하나(MQ)와 같은 문턱을 JS 도 본다(matchMedia) — 두 곳이 어긋나면 서랍이 열렸는데 안 보인다.
//
//  ── 폰(≤640px, #4088 원준 2026-09-19 "슬랙 웹·모바일 뷰 참고 — 반응형이 아니라 레이아웃을 다시") ────────────
//   태블릿까지는 위 서랍 셸이 맞는데, 폰에선 왼쪽 끝 레일(56px)이 폭의 14% 를 늘 먹고 서랍은 그 옆에 쪽문처럼 열렸다.
//   슬랙 모바일 문법으로 바꾼다:
//   · **아래 탭 바**(.v2-mtabs) 가 구역을 맡는다 — [홈] [확인할 것] [AI 세션] [프로젝트] [위키] [더보기]. 레일은 없다.
//   · 구역 탭을 누르면 그 구역의 **목록이 화면 한 장**으로 선다(사이드바 서랍을 전폭으로) — 슬랙의 「홈」탭이 채널 목록인 것과
//     같다. 목록에서 하나를 고르면 본문이 전폭으로 열리고, 같은 탭을 다시 누르면 목록으로 돌아온다.
//   · [더보기] = 슬랙의 「더보기」 — 리브·자료·맥락 관리·사용 가이드 같은 앱과 [내 프로필·환경설정] 이 아래 판(.v2-msheet)으로.
//   · 맨 윗줄은 [☰] [검색 전폭] [타임라인] 한 줄 — 뒤로·앞으로는 브라우저 몫이라 폰에선 뺀다(CSS, 50-mobile.css).
//   JS 짝은 이 파일, CSS 짝은 public/styles/50-mobile.css(≤640 블록). 문턱은 PHONE_MQ 하나다.
import { el, personName, state, sv } from '../core.js';
import { ICONS, icon } from './icons.js';
import { appHref, appIcon, openLaunchpad, visibleApps } from './apps.js';
import { openMeModal } from './me-modal.js';
import { railSection, railSections, setRailSection, type RailSection } from './rail.js';

export const MOBILE_MQ = '(max-width: 900px)';   // = 40-v2.css 모바일 블록의 문턱(종전 우패널 숨김 문턱과 같다 — 태블릿 세로 포함)
export const PHONE_MQ = '(max-width: 640px)';    // = 50-mobile.css 폰 블록의 문턱 — 아래 탭 바가 서는 폭

export interface MobileChrome {
  bar: HTMLElement;
  scrim: HTMLElement;
  /** 폰 아래 탭 바(#4088) — 호출자가 #v2-root 맨 뒤에 끼운다. >640px 에선 CSS 가 숨긴다. */
  tabs: HTMLElement;
  /** 이전 셸 호환용 — 전달된 탭 줄을 모바일 바로 옮기고 데스크톱에서 제자리로 돌린다. 새 셸은 호출하지 않는다. */
  adoptStrip(strip: HTMLElement, restore: () => void): void;
  /** 우측 서랍 버튼 — false 면 숨긴다(no-aside 화면). */
  setAside(on: boolean): void;
  /** 우측 서랍을 연다 — 곁칸에 무언가를 실었을 때(미리보기). 데스크톱에선 상주 열이라 할 일이 없다. */
  openAside(): void;
  /** 사이드바 서랍 여닫이(☰) — 데스크톱 앱에선 이 단추가 창 맨 윗줄 맨 왼쪽으로 간다(#1954 3차). */
  menuBtn: HTMLElement;
  /** 우측 서랍 여닫이([타임라인]) — 브라우저 셸은 이 단추도 창 맨 윗줄 오른쪽 끝으로 옮긴다(#4088). */
  asideBtn: HTMLElement;
  /** 우측 서랍이 무엇인가 — 우패널(타임라인)인가, 칸 셸의 곁칸(자료·지식·타임라인)인가. 단추의 아이콘·이름이 따라 바뀐다(#4088 후속). */
  setAsideKind(kind: 'timeline' | 'panes'): void;
  /** 우측 서랍으로 열릴 **실제 판**(칸 셸의 곁칸) — 열 때 초점을 여기로 보낸다. null 이면 우패널(.v2-aside). */
  setAsideTarget(target: HTMLElement | null): void;
  /** 문턱(≤900)을 넘나들 때 — 셸이 활성 탭의 크롬(서랍 단추)을 다시 맞춘다. 돌려주는 함수로 뗀다. */
  onChange(fn: () => void): () => void;
  /** 아래 탭 바의 켜짐·배지를 지금 상태로 맞춘다 — 레일을 다시 그릴 때(main.ts drawSide) 함께 부른다. */
  syncTabs(counts?: { inbox?: number }): void;
  closeAll(): void;
  isMobile(): boolean;
  isPhone(): boolean;
}

/** #v2-root 에 모바일 크롬을 단다. bar 는 root 맨 앞, scrim·tabs 는 맨 뒤에 호출자가 끼운다(그리드 열 순서를 안 건드리게). */
export function mountMobileChrome(root: HTMLElement, side: HTMLElement, aside: HTMLElement): MobileChrome {
  const mq = window.matchMedia(MOBILE_MQ);
  const pmq = window.matchMedia(PHONE_MQ);
  const isMobile = (): boolean => mq.matches;
  const isPhone = (): boolean => pmq.matches;

  // 아이콘 — 라인, 채움 없음(DS 규약). 24 뷰박스, 사이드바·탭과 같은 붓.
  const mkIcon = (paths: string[]): SVGElement => sv('svg', { viewBox: '0 0 24 24', class: 'v2-mbar-ic', 'aria-hidden': 'true' }, ...paths.map((d) => sv('path', { d })));
  const menuBtn = el('button', { class: 'v2-mbar-btn v2-mbar-menu', type: 'button', 'aria-label': '탐색 열기', 'aria-expanded': 'false', 'aria-controls': 'v2-side' },
    //  좁은 폭 = ☰(서랍) · 넓은 폭 = 패널 아이콘(레일 여닫기 — 슬랙 창 맨 윗줄 맨 왼쪽의 그것, #2016). 둘 중 하나만 보인다(CSS).
    sv('svg', { viewBox: '0 0 24 24', class: 'v2-mbar-ic v2-mbar-ic--m', 'aria-hidden': 'true' }, sv('path', { d: 'M4 7h16M4 12h16M4 17h16' })),
    sv('svg', { viewBox: '0 0 24 24', class: 'v2-mbar-ic v2-mbar-ic--w', 'aria-hidden': 'true' }, sv('path', { d: ICONS.panel }))) as HTMLButtonElement;
  //  제목은 두지 않는다(#1954 3차 상민님) — 창 맨 윗줄은 폭이 넓든 좁든 **같은 것**이어야 한다.
  //  지금 무엇을 보고 있는지는 좌측 목록의 활성 행이 이미 말하고, 화면 제목은 본문 문패가 든다.
  const slot = el('div', { class: 'v2-mbar-slot' });
  //  아이콘 둘 중 하나만 보인다(47-v2-rail.css): 우패널(타임라인) ↔ 칸 셸의 곁칸(폴더 — 자료가 그 서랍의 첫 탭이다, #4088 후속).
  const tlIcon = mkIcon(['M12 4v16', 'M12 8h6', 'M12 14h6', 'M6 6h2', 'M6 12h2', 'M6 18h2']); tlIcon.classList.add('v2-mbar-ic--tl');
  const pnIcon = mkIcon([ICONS.folder]); pnIcon.classList.add('v2-mbar-ic--pn');
  const asideBtn = el('button', { class: 'v2-mbar-btn v2-mbar-aside', type: 'button', 'aria-label': '타임라인 열기', 'aria-expanded': 'false', 'aria-controls': 'v2-aside', title: '이 화면의 타임라인' },
    tlIcon, pnIcon) as HTMLButtonElement;
  let asideTarget: HTMLElement | null = null;
  const bar = el('div', { class: 'v2-mbar' }, menuBtn, slot, asideBtn) as HTMLElement;
  const scrim = el('div', { class: 'v2-scrim', hidden: true, 'aria-hidden': 'true' }) as HTMLElement;
  side.id = side.id || 'v2-side';
  aside.id = aside.id || 'v2-aside';
  // 서랍 자체가 포커스를 받을 수 있어야 열었을 때 초점이 안으로 들어간다(검색칸에 바로 주면 iOS 키보드가 튀어 오른다).
  side.tabIndex = -1; aside.tabIndex = -1;

  type Which = 'side' | 'aside';
  let open: Which | null = null;
  let sheetOpen = false;
  const paint = (): void => {
    root.classList.toggle('m-side', open === 'side');
    root.classList.toggle('m-aside', open === 'aside');
    root.classList.toggle('m-sheet', sheetOpen);
    scrim.hidden = !open && !sheetOpen;
    menuBtn.setAttribute('aria-expanded', String(open === 'side'));
    asideBtn.setAttribute('aria-expanded', String(open === 'aside'));
    paintTabs();
  };
  // returnFocus — 키보드(Esc)로 닫았을 때만 연 버튼으로 초점을 돌려준다(서랍이 닫혔는데 초점이 보이지 않는 곳에 남으면 키보드·
  //  스크린리더 사용자가 길을 잃는다). 손가락으로 닫았을 땐 초점을 흘려보낸다 — 버튼에 초점을 주면 브라우저가 포커스 링을 그린다.
  const closeAll = (returnFocus = false): void => {
    if (!open && !sheetOpen) return;
    const was = open;
    const wasSheet = sheetOpen;
    open = null; sheetOpen = false; paint();
    //  [더보기] 판도 같은 규칙 — Esc 로 닫았으면 초점을 연 단추([더보기])로 돌려준다(판이 hidden 이 되면 초점이 body 로 떨어진다).
    if (!was) { if (wasSheet && returnFocus && moreBtn) moreBtn.focus({ preventScroll: true }); return; }
    const panel = was === 'side' ? side : (asideTarget || aside);
    if (returnFocus) { (was === 'side' ? menuBtn : asideBtn).focus({ preventScroll: true }); }
    else if (panel.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  };
  const openOne = (w: Which): void => {
    if (!isMobile()) return;
    open = w; sheetOpen = false; paint();
    const panel = w === 'side' ? side : (asideTarget || aside);
    panel.focus({ preventScroll: true });
    // 사이드바 트리는 수백 행 — 지금 보는 행이 보이게 살짝 굴린다(열린 뒤라야 굴릴 스크롤 상자가 화면 안에 있다).
    if (w === 'side') { const on = side.querySelector<HTMLElement>('.v2-tree .on'); if (on) on.scrollIntoView({ block: 'center' }); }
  };
  menuBtn.addEventListener('click', () => (open === 'side' ? closeAll() : openOne('side')));
  asideBtn.addEventListener('click', () => (open === 'aside' ? closeAll() : openOne('aside')));
  scrim.addEventListener('click', () => closeAll());
  document.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Escape' && (open || sheetOpen)) { e.stopPropagation(); closeAll(true); } }, true);
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

  // ── 폰 아래 탭 바(#4088) ──────────────────────────────────────────────────────
  //  구역 넷 + [더보기]. 레일(rail.ts)과 같은 표(railSections)를 읽으므로 구역이 늘거나 이름이 바뀌면 여기도 따라온다.
  //  ⚠ 여기서는 구역만 다룬다 — 독에 고정한 앱·최근 앱은 폰에선 [더보기] 판이 맡는다(탭 바는 여섯을 넘기지 않는다).
  const tabs = el('nav', { class: 'v2-mtabs', 'aria-label': '구역' }) as HTMLElement;
  const sheet = el('div', { class: 'v2-msheet', hidden: true, role: 'dialog', 'aria-label': '더보기' }) as HTMLElement;
  let inboxCount = 0;
  const secBtns = new Map<RailSection, HTMLButtonElement>();
  let moreBtn: HTMLButtonElement | null = null;
  const tabIcon = (name: string): SVGElement => icon(name, 'v2-mtab-ic');
  const moreIcon = (): SVGElement => sv('svg', { viewBox: '0 0 24 24', class: 'v2-mtab-ic', 'aria-hidden': 'true' },
    sv('circle', { cx: '5', cy: '12', r: '1.4' }), sv('circle', { cx: '12', cy: '12', r: '1.4' }), sv('circle', { cx: '19', cy: '12', r: '1.4' }));
  function onSectionTap(sec: RailSection): void {
    if (!isPhone()) return;
    //  홈·확인할 것은 **화면**이다(목록이 아니라) — 그 화면으로 간다. 이미 그 구역이면 setRailSection 이 changed=false 라
    //   navigate 를 명시해야 주소가 옮겨진다(같은 탭을 다시 눌러 첫 화면으로 돌아오는 손짓).
    if (sec === 'home' || sec === 'inbox') { closeAll(); setRailSection(sec, { navigate: true }); return; }
    //  AI 세션·프로젝트·위키는 **목록**이다 — 사이드바(그 구역의 목록)를 화면 한 장으로 연다. 같은 탭을 다시 누르면 닫는다.
    if (railSection() === sec && open === 'side') { closeAll(); return; }
    sheetOpen = false;
    setRailSection(sec, { navigate: false });
    openOne('side');
  }
  function buildSheet(): void {
    const skip = new Set(['terminal', 'projects2', 'knowledge']);   // 아래 탭 바에 이미 있는 구역의 앱
    const rows: HTMLElement[] = [];
    const row = (ic: SVGElement, label: string, attrs: Record<string, unknown>, tag: 'a' | 'button' = 'a'): HTMLElement =>
      el(tag, { class: 'v2-msheet-row', ...(tag === 'button' ? { type: 'button' } : {}), ...attrs }, ic, el('span', { class: 'v2-msheet-t', text: label }), sv('svg', { viewBox: '0 0 24 24', class: 'v2-msheet-go', 'aria-hidden': 'true' }, sv('path', { d: 'M9 6l6 6-6 6' }))) as HTMLElement;
    rows.push(row(tabIcon('liv'), '리브', { href: '#/liv' }));
    for (const a of visibleApps()) { if (skip.has(a.key)) continue; rows.push(row(appIcon(a.icon, 'v2-mtab-ic'), a.title, { href: appHref(a) })); }
    rows.push(row(tabIcon('link'), '외부 앱 연결', { href: '#/connect' }));
    rows.push(row(tabIcon('apps'), '모든 앱', { onclick: () => { closeAll(); openLaunchpad(); } }, 'button'));
    const me: any = state.me || {};
    rows.push(row(tabIcon('gear'), (personName(me) || '나') + ' — 내 프로필 · 환경설정', { onclick: () => { closeAll(); openMeModal({}); } }, 'button'));
    sheet.replaceChildren(
      el('div', { class: 'v2-msheet-h' }, el('span', { class: 'v2-msheet-ht', text: '더보기' }),
        el('button', { class: 'v2-msheet-x', type: 'button', 'aria-label': '닫기', onclick: () => closeAll() }, icon('x', 'v2-mtab-ic'))),
      el('div', { class: 'v2-msheet-list' }, ...rows));
  }
  function toggleSheet(): void {
    if (!isPhone()) return;
    if (sheetOpen) { closeAll(); return; }
    open = null; sheetOpen = true; buildSheet(); paint();
  }
  sheet.addEventListener('click', (e: Event) => {
    const t = e.target as HTMLElement | null;
    if (t && t.closest && t.closest('a[href]')) closeAll();
  });
  function buildTabs(): void {
    secBtns.clear();
    const btns: HTMLElement[] = railSections().map((s) => {
      const b = el('button', { class: 'v2-mtab', type: 'button', 'data-sec': s.key, onclick: () => onSectionTap(s.key) },
        el('span', { class: 'v2-mtab-icw' }, tabIcon(s.icon)),
        el('span', { class: 'v2-mtab-t', text: s.label })) as HTMLButtonElement;
      secBtns.set(s.key, b);
      return b;
    });
    moreBtn = el('button', { class: 'v2-mtab v2-mtab--more', type: 'button', onclick: () => toggleSheet(), 'aria-haspopup': 'dialog' },
      el('span', { class: 'v2-mtab-icw' }, moreIcon()),
      el('span', { class: 'v2-mtab-t', text: '더보기' })) as HTMLButtonElement;
    tabs.replaceChildren(...btns, moreBtn, sheet);
    paintTabs();
  }
  function paintTabs(): void {
    const sec = railSection();
    for (const [k, b] of secBtns) {
      const on = !sheetOpen && k === sec;
      b.classList.toggle('on', on);
      b.setAttribute('aria-current', on ? 'page' : 'false');
      if (k === 'inbox') {
        let bd = b.querySelector<HTMLElement>('.v2-mtab-bd');
        if (inboxCount > 0) {
          if (!bd) { bd = el('span', { class: 'v2-mtab-bd', role: 'img' }) as HTMLElement; b.querySelector('.v2-mtab-icw')?.append(bd); }
          bd.textContent = inboxCount > 99 ? '99+' : String(inboxCount);
          bd.setAttribute('aria-label', `확인할 것 ${inboxCount}건`);
        } else if (bd) bd.remove();
      }
      //  목록을 여는 구역만 «펼침» 상태를 갖는다 — 같은 자리를 다시 누르면 닫힌다는 손짓. 홈·확인할 것은 화면으로 가는 단추라 그 속성이 없다.
      if (k === 'home' || k === 'inbox') b.removeAttribute('aria-expanded');
      else b.setAttribute('aria-expanded', String(open === 'side' && k === sec));
    }
    if (moreBtn) { moreBtn.classList.toggle('on', sheetOpen); moreBtn.setAttribute('aria-expanded', String(sheetOpen)); }
    sheet.hidden = !sheetOpen;
  }
  buildTabs();

  // 탭 줄 입양 — 모바일이면 바 가운데, 아니면 제자리. 회전·리사이즈로 문턱을 넘나들 때마다 옮긴다(DOM 이동이라 탭 상태는 그대로).
  let strip: { el: HTMLElement; restore: () => void } | null = null;
  const placeStrip = (): void => {
    if (!strip) return;
    if (isMobile()) { if (strip.el.parentElement !== slot) slot.replaceChildren(strip.el); }
    else if (strip.el.parentElement === slot) strip.restore();
  };
  // 창이 넓어지면(회전·리사이즈) 서랍 상태를 버린다 — 데스크톱 그리드에 m-side 가 남아 있으면 안 된다.
  const changeFns = new Set<() => void>();
  const onMq = (): void => { if (!mq.matches) closeAll(); placeStrip(); for (const fn of [...changeFns]) { try { fn(); } catch (_) { /* 한 구독이 넘어져도 나머지는 간다 */ } } };
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onMq); else (mq as any).addListener(onMq);
  //  폰 문턱을 벗어나면 더보기 판도 접는다 — 탭 바가 사라지는데 판만 떠 있으면 닫을 길이 없다.
  const onPmq = (): void => { if (!pmq.matches && sheetOpen) closeAll(); };
  if (typeof pmq.addEventListener === 'function') pmq.addEventListener('change', onPmq); else (pmq as any).addListener(onPmq);

  return {
    bar, scrim, tabs, isMobile, isPhone, closeAll: () => closeAll(),
    adoptStrip(el0: HTMLElement, restore: () => void): void { strip = { el: el0, restore }; placeStrip(); },
    setAside(on: boolean): void {
      asideBtn.hidden = !on;
      if (!on && open === 'aside') closeAll();
    },
    openAside(): void { if (isMobile() && !asideBtn.hidden && open !== 'aside') openOne('aside'); },
    setAsideKind(kind: 'timeline' | 'panes'): void {
      const panes = kind === 'panes';
      asideBtn.classList.toggle('is-panes', panes);
      asideBtn.setAttribute('aria-label', panes ? '자료·곁칸 열기' : '타임라인 열기');
      asideBtn.title = panes ? '이 세션의 자료·지식·타임라인' : '이 화면의 타임라인';
    },
    setAsideTarget(target: HTMLElement | null): void { asideTarget = target; },
    onChange(fn: () => void): () => void { changeFns.add(fn); return () => { changeFns.delete(fn); }; },
    syncTabs(counts?: { inbox?: number }): void {
      if (counts && typeof counts.inbox === 'number') inboxCount = counts.inbox;
      //  구역 표가 바뀌었을 수 있다(navOn 토글) — 개수가 다르면 다시 짓는다.
      if (secBtns.size !== railSections().length) buildTabs(); else paintTabs();
    },
    menuBtn, asideBtn,
  };
}
