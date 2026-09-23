// v2/notify-bell.ts — 홈의 **종**(#4180): 안 읽은 알림 수 + 누르면 그 자리에 목록(팝오버).
//
//  회의(2026-09-21 상민·원준): «확인할 것이 사이드바 아래에 있으면 안 되고, 사이드바와 겹친다. 홈으로 옮기고, 종 아이콘과
//  숫자만 보이다가 누르면 목록이 뜬다. 모달은 되도록 쓰지 않는다(경험이 좋지 않고 모바일에서 어렵다. 슬랙도 파일 미리보기
//  정도만 모달).»
//  · 레일의 [확인할 것] 구역·사이드바 구획·폰 아래 탭은 걷었다(rail.ts · side.ts · mobile.ts). 이 종이 입구다.
//  · 팝오버는 **모달이 아니다** — 바깥 클릭·Esc·이동(hashchange)·프레임 초점으로 닫힌다(lib/overlay anchoredPopover).
//  · 폰(≤640px)에선 팝오버가 서기 어려워(원준: «모바일에서 어렵고») 「확인할 것」 화면(#/inbox)을 연다 — 같은 목록, 화면 한 장.
//  · 숫자는 서버가 센 것(notifications.ts 의 시계) — 종이 4 인데 목록이 3 이면 어느 쪽이 거짓말인지 화면이 못 말한다.
import { anchoredPopover, el } from '../core.js';
import { icon } from './icons.js';
import {
  askNotificationPermission, loadNotifications, markNotificationsRead, notificationPermission, notificationRow, onUnread, unreadCount,
} from './notifications.js';

/** = mobile.ts PHONE_MQ · 50-mobile.css 폰 블록의 문턱. 값을 여기 다시 적는 이유: mobile.ts 를 물면 레일·런치패드까지 끌려온다. */
const PHONE_MQ = '(max-width: 640px)';
const POP_LIMIT = 30;

let pop: { panel: HTMLElement; close: () => void } | null = null;

function closePopover(): void {
  if (!pop) return;
  const p = pop; pop = null;
  p.close();
}

/** 홈 머리줄의 종. 판이 다시 그려져 사라진 종은 시계 구독을 스스로 뗀다. */
export function notifyBell(): HTMLElement {
  const n = el('span', { class: 'v2-bell-n', hidden: true });
  const btn = el('button', { class: 'v2-bell', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
    icon('bell', 'v2-bell-ic'), n) as HTMLButtonElement;
  const paint = (count: number): void => {
    n.hidden = count <= 0;
    n.textContent = count > 99 ? '99+' : String(count);
    const label = count > 0 ? `확인할 것 — 안 읽은 알림 ${count}개` : '확인할 것 — 받은 알림';
    btn.setAttribute('aria-label', label); btn.title = label;
  };
  paint(unreadCount());
  //  구독 직후의 동기 호출은 종이 아직 DOM 에 안 붙은 때라, «떨어졌다» 판정은 한 프레임 뒤부터 한다.
  let mounted = false;
  window.requestAnimationFrame(() => { mounted = true; });
  const off = onUnread((c) => {
    if (mounted && !btn.isConnected) { off(); return; }
    paint(c);
  });
  btn.addEventListener('click', () => {
    if (window.matchMedia(PHONE_MQ).matches) { location.hash = '#/inbox'; return; }
    //  팝오버는 바깥 클릭에 스스로 닫히므로(anchoredPopover) «열려 있나» 는 손잡이가 아니라 판이 붙어 있나로 본다.
    const open = !!pop && pop.panel.isConnected;
    closePopover();
    if (!open) openPopover(btn);
  });
  return btn;
}

function openPopover(anchor: HTMLButtonElement): void {
  const head = el('div', { class: 'v2-noti-pop-h' }, el('span', { class: 'v2-k', text: '확인할 것' }));
  const list = el('div', { class: 'v2-noti-pop-b', role: 'list' }, el('p', { class: 'v2-noti-pop-empty', text: '불러오는 중…' }));
  const panel = el('div', { class: 'v2-noti-pop', role: 'dialog', 'aria-label': '확인할 것 — 받은 알림' },
    head, list,
    el('div', { class: 'v2-noti-pop-f' }, el('a', { href: '#/inbox', text: '전체 보기 →' })));
  const close = anchoredPopover(anchor, panel);
  //  종은 머리줄 **오른쪽 끝**에 선다 — 판의 왼쪽을 종에 맞추면 화면 밖으로 밀려 붙잡힌다. 오른쪽을 종의 오른쪽에 맞춘다.
  const r = anchor.getBoundingClientRect();
  panel.style.left = Math.max(8, Math.round(r.right - panel.offsetWidth)) + 'px';
  const onHash = (): void => closePopover();
  window.addEventListener('hashchange', onHash);
  anchor.setAttribute('aria-expanded', 'true'); anchor.classList.add('on');
  pop = {
    panel,
    close: () => {
      close();
      window.removeEventListener('hashchange', onHash);
      anchor.setAttribute('aria-expanded', 'false'); anchor.classList.remove('on');
    },
  };
  const paint = async (): Promise<void> => {
    let feed;
    try { feed = await loadNotifications({ limit: POP_LIMIT, scope: 'inbox' }); }
    catch { if (panel.isConnected) list.replaceChildren(el('p', { class: 'v2-noti-pop-empty', text: '알림을 불러오지 못했어요.' })); return; }
    if (!panel.isConnected) return;
    head.replaceChildren(
      el('span', { class: 'v2-k', text: feed.unread ? `확인할 것 · 안 읽음 ${feed.unread}` : '확인할 것' }),
      //  ⚠ 권한은 사람이 누를 때만 묻는다(notifications.ts 머리말) — 여기 단추가 그 자리다.
      notificationPermission() === 'default'
        ? el('button', { class: 'btn btn-sm', type: 'button', text: '알림 켜기', title: '브라우저 배너로도 받기',
            onclick: (e: Event) => { void askNotificationPermission().then(() => (e.target as HTMLElement)?.remove()); } })
        : null,
      feed.unread
        ? el('button', { class: 'btn btn-sm', type: 'button', text: '모두 읽음',
            onclick: () => { void markNotificationsRead(undefined, 'inbox').then(() => paint()); } })
        : null);
    if (!feed.notifications.length) {
      list.replaceChildren(el('p', { class: 'v2-noti-pop-empty', text: '새 알림이 없어요. 댓글·언급, 리브의 답, 앱이 보낸 알림이 오면 여기에 모여요.' }));
      return;
    }
    list.replaceChildren(...feed.notifications.map((x) => notificationRow(x, { onOpen: () => closePopover() })));
  };
  void paint();
}
