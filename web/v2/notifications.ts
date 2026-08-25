// v2/notifications.ts — 내가 받은 알림(#1891). inbox 앱이 그리는 이력의 자료·표현을 한곳에 둔다.
//
// 종전 「확인할 것」은 **라이브 세션에서 파생**돼 이력이 없었다 — 화면을 안 보고 있으면 그냥 지나갔고
//  "무슨 알림이 왔었지"를 물을 데가 없었다. 이제 서버가 남기고(org_app_notification) 여기가 읽는다.
import { api, el, relTime } from '../core.js';

export interface AppNotification {
  id: string;
  app_id: string;
  title: string;
  body: string | null;
  href: string | null;
  created_at: string;
  read_at: string | null;
}

export interface NotificationFeed { notifications: AppNotification[]; unread: number }

export async function loadNotifications(opts: { limit?: number } = {}): Promise<NotificationFeed> {
  const q = opts.limit ? `?limit=${encodeURIComponent(String(opts.limit))}` : '';
  const out = await api('/api/ui/me/notifications' + q) as Partial<NotificationFeed> | null;
  return { notifications: Array.isArray(out?.notifications) ? out!.notifications! : [], unread: Number(out?.unread) || 0 };
}

/** ids 를 주면 그것만, 생략하면 안 읽은 것 전부. */
export async function markNotificationsRead(ids?: string[]): Promise<void> {
  await api('/api/ui/me/notifications/read', { method: 'POST', body: JSON.stringify(ids ? { ids } : {}) });
}

// ── 브라우저·데스크톱 배너 ──────────────────────────────────────────────────
//  데스크톱 앱은 이 웹 UI 를 그대로 싣는 Electron 이라 **표준 Notification API 가 네이티브 배너로 뜬다**
//  (별도 IPC 불필요). 브라우저에서는 사용자가 권한을 준 경우에만 뜬다.
//
//  ⚠ 권한을 **먼저 묻지 않는다.** 들어오자마자 뜨는 권한 창은 거의 항상 거부당하고, 한 번 거부되면
//   그 뒤로는 물을 수도 없다. 사람이 「알림 켜기」를 누를 때만 요청한다.

const SEEN_STORE = 'lively_v2_notified';   // 이미 배너로 띄운 알림 id(이 브라우저 기준)

function seen(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_STORE) || '[]') as string[]); }
  catch { return new Set(); }
}
function remember(ids: string[]): void {
  try {
    //  최근 200건만 남긴다 — 무한히 자라면 저장소가 찬다.
    localStorage.setItem(SEEN_STORE, JSON.stringify([...seen(), ...ids].slice(-200)));
  } catch { /* 사파리 프라이빗 등 — 배너가 두 번 뜨는 정도의 손해라 무시 */ }
}

export function notificationPermission(): 'granted' | 'denied' | 'default' | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function askNotificationPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  try { return (await Notification.requestPermission()) === 'granted'; }
  catch { return false; }
}

/**
 * 아직 배너로 안 띄운 알림만 띄운다. 권한이 없으면 조용히 아무것도 안 한다(이력은 화면에 남아 있다).
 * @returns 실제로 띄운 건수
 */
export function raiseBanners(list: readonly AppNotification[]): number {
  if (notificationPermission() !== 'granted') return 0;
  const already = seen();
  const fresh = list.filter((n) => !n.read_at && !already.has(n.id));
  if (!fresh.length) return 0;
  //  한 번에 여러 개가 쏟아지면 배너로 도배된다 — 최근 3건만 띄우고 나머지는 화면에서 본다.
  const show = fresh.slice(0, 3);
  for (const n of show) {
    try {
      const banner = new Notification(n.title, { body: n.body || undefined, tag: n.id });
      if (n.href) banner.onclick = () => { try { window.focus(); location.hash = n.href!.replace(/^#/, ''); } catch { /* 창이 닫혔다 */ } };
    } catch { /* 배너 실패는 기능 실패가 아니다 */ }
  }
  remember(fresh.map((n) => n.id));
  return show.length;
}

// ── 표현 ────────────────────────────────────────────────────────────────────

/** 알림 한 줄. href 가 있으면 누를 수 있는 행, 없으면 그냥 행. */
export function notificationRow(n: AppNotification): HTMLElement {
  const inner = [
    el('span', { class: 'v2-noti-dot' + (n.read_at ? '' : ' on'), 'aria-hidden': 'true' }),
    el('span', { class: 'tw' },
      el('span', { class: 't', text: n.title }),
      n.body ? el('span', { class: 'p', text: n.body }) : null),
    el('span', { class: 'st', text: relTime(n.created_at) }),
  ];
  const cls = 'v2-now-row v2-noti-row' + (n.read_at ? '' : ' unread');
  return n.href
    ? el('a', { class: cls, href: n.href }, ...inner)
    : el('div', { class: cls }, ...inner);
}
