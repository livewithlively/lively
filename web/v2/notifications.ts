// v2/notifications.ts — 내가 받은 알림(#1891 · #4180). 「확인할 것」이 그리는 이력의 자료·표현과, 종(안 읽은 수)의 시계를 한곳에 둔다.
//
// 종전 「확인할 것」은 **라이브 세션에서 파생**돼 이력이 없었다 — 화면을 안 보고 있으면 그냥 지나갔고
//  "무슨 알림이 왔었지"를 물을 데가 없었다. 이제 서버가 남기고(org_app_notification) 여기가 읽는다.
//
// ── #4180 (회의 2026-09-21 상민·원준) ──
//  · 세션 대기·완료 알림은 「확인할 것」에서 뺀다 — 서버가 종류(kind)로 가르고, 이 화면은 **inbox 렌즈**로 읽는다.
//    배너 폴링만 **all 렌즈**로 읽는다(세션 대기 배너는 8/24 결정대로 남는다).
//  · 알림은 내용이 있어야 한다 — 댓글·언급(누가·어디에·무슨 말)·리브의 답(답 앞부분)·앱 알림. 행의 앞자리가 «누가» 를 말한다.
//  · 입구는 레일 구역이 아니라 **홈의 종**(notify-bell.ts) — 안 읽은 수는 여기 시계(startUnreadWatch)가 한 벌로 센다.
import { api, el, personFace, relTime } from '../core.js';
import { icon } from './icons.js';
import { deviceStore } from './shell-prefs.js';   // #2460 — 배너를 이 창에서 이미 띄웠나(기기의 사실)
import { browserBannerText } from './banner-text.js';   // #4054 — 윗줄은 워크스페이스 이름

export type NotifyKind = 'app' | 'session' | 'liv' | 'comment' | 'mention';
/** 렌즈 — inbox(확인할 것 · 세션 대기·완료 제외) / all(배너 · 전부). 서버 notify-policy 와 같은 두 값. */
export type NotifyScope = 'inbox' | 'all';

export interface AppNotification {
  id: string;
  app_id: string;
  title: string;
  body: string | null;
  href: string | null;
  created_at: string;
  read_at: string | null;
  /** 종류(#4180) — 구 게이트웨이 응답엔 없다(→ 'app' 으로 본다). */
  kind?: NotifyKind | string;
  /** 이 알림을 만든 사람(구성원 id)과 명부에서 붙인 이름 — 댓글·언급에만. */
  actor?: string | null;
  actor_name?: string | null;
}

export interface NotificationFeed { notifications: AppNotification[]; unread: number }

export async function loadNotifications(opts: { limit?: number; scope?: NotifyScope } = {}): Promise<NotificationFeed> {
  const q = new URLSearchParams();
  if (opts.limit) q.set('limit', String(opts.limit));
  q.set('scope', opts.scope || 'inbox');
  const out = await api('/api/ui/me/notifications?' + q.toString()) as Partial<NotificationFeed> | null;
  return { notifications: Array.isArray(out?.notifications) ? out!.notifications! : [], unread: Number(out?.unread) || 0 };
}

/** ids 를 주면 그것만, 생략하면 안 읽은 것 전부 — 그 렌즈 안에서(기본 inbox). 끝나면 종의 수를 다시 센다. */
export async function markNotificationsRead(ids?: string[], scope: NotifyScope = 'inbox'): Promise<void> {
  await api('/api/ui/me/notifications/read', { method: 'POST', body: JSON.stringify(ids ? { ids } : { scope }) });
  refreshUnread(0);
}

// ── 안 읽은 수의 시계(#4180) — 종(홈)·「확인할 것」 화면이 같은 값을 본다 ──────────────────
//  ⚠ 셈은 서버가 한다(unreadCount · inbox 렌즈). 화면이 목록을 세어 배지를 만들면 «배지는 4 인데 목록은 3» 이 된다.
let unread = -1;                                   // -1 = 아직 모른다(첫 응답 전)
const subs = new Set<(n: number) => void>();
let refreshTimer = 0;
let watchTimer = 0;
let inflight: Promise<void> | null = null;

/** 지금 아는 안 읽은 수(모르면 0 — 종은 조용히 시작한다). */
export function unreadCount(): number { return unread < 0 ? 0 : unread; }

/** 안 읽은 수가 바뀔 때 부른다. 돌려주는 함수로 뗀다. 이미 아는 값이 있으면 바로 한 번 부른다. */
export function onUnread(cb: (n: number) => void): () => void {
  subs.add(cb);
  if (unread >= 0) { try { cb(unread); } catch { /* 구독자 오류가 시계를 세우지 않는다 */ } }
  return () => { subs.delete(cb); };
}

function setUnread(n: number): void {
  const changed = n !== unread;
  unread = n;
  if (!changed) return;
  for (const cb of [...subs]) { try { cb(n); } catch { /* 위와 같다 */ } }
}

/** 서버에 다시 묻는다(창으로 합친다 — 스트림이 사건 20건을 한꺼번에 밀어도 요청은 하나). */
export function refreshUnread(delayMs = 300): void {
  if (refreshTimer) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = 0;
    if (inflight) { inflight.then(() => refreshUnread(0)); return; }   // 겹치면 끝난 뒤 한 번 더 — 최신 값을 놓치지 않게
    inflight = loadNotifications({ limit: 1, scope: 'inbox' })
      .then((f) => setUnread(f.unread))
      .catch(() => { /* 다음 틱 */ })
      .finally(() => { inflight = null; });
  }, delayMs);
}

/**
 * 셸 부팅 때 한 번. 30초마다 세고, 화면으로 돌아오거나 창이 초점을 받으면 그 자리에서 다시 센다.
 *  실시간 사건(세션 전이 스트림)은 main.ts 가 refreshUnread 로 잇는다 — 리브의 답은 그 전이 직후 알림이 된다.
 */
export function startUnreadWatch(intervalMs = 30_000): void {
  if (watchTimer) return;
  refreshUnread(0);
  watchTimer = window.setInterval(() => { if (!document.hidden) refreshUnread(0); }, intervalMs);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshUnread(0); });
  window.addEventListener('focus', () => refreshUnread(0));
}

// ── 브라우저·데스크톱 배너 ──────────────────────────────────────────────────
//  데스크톱 앱은 이 웹 UI 를 그대로 싣는 Electron 이라 **표준 Notification API 가 네이티브 배너로 뜬다**
//  (별도 IPC 불필요). 브라우저에서는 사용자가 권한을 준 경우에만 뜬다.
//
//  ⚠ 권한을 **먼저 묻지 않는다.** 들어오자마자 뜨는 권한 창은 거의 항상 거부당하고, 한 번 거부되면
//   그 뒤로는 물을 수도 없다. 사람이 「알림 켜기」를 누를 때만 요청한다.

const SEEN_STORE = deviceStore('lively_v2_notified');   // #1875 — 알림 id 는 워크스페이스의 것   // 이미 배너로 띄운 알림 id(이 브라우저 기준)

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
export function raiseBanners(list: readonly AppNotification[], wsName?: string | null): number {
  // ⚠ 데스크톱 앱 안에서는 **배너를 만들지 않는다** — 그 앱(#1842)이 트레이에서 SSE 로 같은 사건을
  //  이미 배너로 띄운다. 여기서도 띄우면 한 사건에 배너가 두 장 뜬다. 능력 감지는 다리의 유무로만
  //  한다(플랫폼·UA 추측 금지 — 구 앱·새 웹 조합에서 어긋난다).
  //  앱이 창을 닫아도 알려 주는 반면 브라우저는 탭이 열려 있을 때만 알 수 있다 — 그게 두 표면의 차이다.
  if ((window as any).livelyDesktop) return 0;
  if (notificationPermission() !== 'granted') return 0;
  const already = seen();
  const fresh = list.filter((n) => !n.read_at && !already.has(n.id));
  if (!fresh.length) return 0;
  //  한 번에 여러 개가 쏟아지면 배너로 도배된다 — 최근 3건만 띄우고 나머지는 화면에서 본다.
  const show = fresh.slice(0, 3);
  for (const n of show) {
    try {
      const text = browserBannerText(n.title, n.body, wsName);
      const banner = new Notification(text.title, { body: text.body, tag: n.id });
      if (n.href) banner.onclick = () => { try { window.focus(); location.hash = n.href!.replace(/^#/, ''); } catch { /* 창이 닫혔다 */ } };
    } catch { /* 배너 실패는 기능 실패가 아니다 */ }
  }
  remember(fresh.map((n) => n.id));
  return show.length;
}

// ── 셸 전역 폴링 ────────────────────────────────────────────────────────────
//  ⚠ 배너를 「확인할 것」 화면 안에서만 띄우면 **보고 있어야 알림이 뜬다** — 알림의 목적과 정반대다
//   (2026-08-25 상민님 신고: "왜 알림 안 오냐"). 그래서 셸이 켜져 있는 동안 어느 화면에서든 돈다.
let bannerTimer = 0;

/**
 * 셸 부팅 때 한 번. 데스크톱 앱 안이면 아무것도 하지 않는다(그 앱이 이미 띄운다).
 * @param wsName 이 탭의 워크스페이스 이름(배너 윗줄, #4054) — 부를 때마다 읽는다(이름이 바뀌어도 따라간다)
 */
export function startNotificationBanners(intervalMs = 30_000, wsName?: () => string | null | undefined): void {
  if (bannerTimer) return;
  if ((window as any).livelyDesktop) return;
  const tick = (): void => {
    if (notificationPermission() !== 'granted') return;   // 권한이 없으면 서버를 부를 이유도 없다
    //  배너는 **all 렌즈** — 세션 대기 알림은 「확인할 것」엔 안 서도 배너로는 온다(#4180).
    void loadNotifications({ limit: 20, scope: 'all' }).then((feed) => raiseBanners(feed.notifications, wsName ? wsName() : null)).catch(() => { /* 다음 tick */ });
  };
  tick();
  bannerTimer = window.setInterval(tick, intervalMs);
}

// ── 표현 ────────────────────────────────────────────────────────────────────

/** 행의 앞자리 — «누가·무엇이»: 사람(얼굴) · 리브(L) · 앱(종) · 세션(상태점, all 렌즈에서만 보인다). */
function leadOf(n: AppNotification): HTMLElement {
  const kind = String(n.kind || 'app');
  if ((kind === 'comment' || kind === 'mention') && n.actor) {
    return el('span', { class: 'v2-noti-lead' }, personFace(n.actor, 'pava v2-noti-ava', n.actor_name || n.actor));
  }
  if (kind === 'liv') return el('span', { class: 'v2-noti-lead' }, el('span', { class: 'v2-noti-mark liv', 'aria-label': '리브', text: 'L' }));
  if (kind === 'session') return el('span', { class: 'v2-noti-lead' }, el('span', { class: 'v2-noti-mark sess', 'aria-hidden': 'true' }));
  return el('span', { class: 'v2-noti-lead' }, el('span', { class: 'v2-noti-mark app', 'aria-hidden': 'true' }, icon('bell', 'v2-noti-mark-ic')));
}

/**
 * 알림 한 줄. href 가 있으면 누를 수 있는 행, 없으면 그냥 행.
 *  누르면 그 알림을 읽음으로 돌린다(누른 것이 곧 확인이다) — 서버 응답을 기다리지 않고 이동한다.
 */
export function notificationRow(n: AppNotification, opts: { onOpen?: (n: AppNotification) => void } = {}): HTMLElement {
  const inner = [
    leadOf(n),
    el('span', { class: 'tw' },
      el('span', { class: 't', text: n.title }),
      n.body ? el('span', { class: 'p', text: n.body }) : null),
    el('span', { class: 'st', text: relTime(n.created_at) }),
    el('span', { class: 'v2-noti-dot' + (n.read_at ? '' : ' on'), 'aria-hidden': 'true' }),
  ];
  const cls = 'v2-now-row v2-noti-row' + (n.read_at ? '' : ' unread');
  //  #3784 — 우클릭 메뉴 표(읽음 표시·열기). id 는 읽음 처리의 열쇠.
  const row = n.href
    ? el('a', { class: cls, href: n.href, 'data-ctx': 'noti', 'data-nid': n.id }, ...inner)
    : el('div', { class: cls, 'data-ctx': 'noti', 'data-nid': n.id }, ...inner);
  row.addEventListener('click', () => {
    if (!n.read_at) { n.read_at = new Date().toISOString(); row.classList.remove('unread'); row.querySelector('.v2-noti-dot')?.classList.remove('on'); void markNotificationsRead([n.id]).catch(() => { /* 다음 조회가 정답 */ }); }
    opts.onOpen?.(n);
  });
  return row;
}
