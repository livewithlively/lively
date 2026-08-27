// desktop-update.ts — 데스크톱 앱이 **이미 받아 둔** 업데이트를 일하는 화면에서 알리고, 그 자리에서 반영한다 (#1838).
//
// ── 왜 이 자리에 생겼나 ──
// 앱은 진작부터 뒤에서 알아서 받아 왔다(켤 때 + 6시간마다 확인 · autoDownload). 빠진 것은 **알리는 자리**였다:
//  받아 둔 업데이트의 입구가 트레이 메뉴와 설치 마법사뿐이라, 라이블리 화면을 띄워 두고 일하는 사람에게는
//  아무 신호도 가지 않았다(상민님 2026-08-20: "트레이에서 설치 노드 설정 들어가서 업데이트 확인을 눌러야 되는데,
//  유저가 명시적으로 업데이트해야 하는 게 너무 복잡하고 현실성 낮다"). 게다가 앱은 **창이 보이는 동안엔 자동으로
//  적용하지 않는다** — 보고 있는 사람 앞에서 앱이 사라지면 그건 고장으로 읽히기 때문이다(desktop/main/update-policy.mjs).
//  그래서 창을 계속 켜 두는 사람일수록 업데이트가 오래 앉아 있었다. 이 모듈이 그 사각을 메운다.
//
// ── 규약 ──
//  · 능력 감지는 **다리의 유무**로만 한다(`livelyDesktop.update`). 브라우저에서 연 웹 UI, 그리고 이 다리가 없는
//    구 데스크톱 앱에서는 아무것도 그리지 않는다 — 플랫폼·UA 로 추측하지 않는다(구 앱·새 웹 조합에서 어긋난다).
//  · 화면은 **받아 둔 것이 있을 때만** 뜬다. 확인 중·받는 중은 알리지 않는다(사람이 할 일이 없는 구간이라
//    그때 띄우면 '자꾸 뭔가 뜨는 앱'이 된다 — 진행률은 앱 쪽 마법사·트레이가 이미 말한다).
//  · 누르면 앱이 스스로 닫고·설치하고·**다시 뜬다**. 사람이 손으로 켤 일이 없다(그 함정의 기록은 앱 쪽 머리말).
//  · 구독은 페이지에 **하나만** 둔다. 셸이 사이드바를 다시 그릴 때마다 새로 걸면 리스너가 쌓여 같은 갱신이
//    여러 번 그려진다 — 붙은 자리(host)만 갈아 끼우고, 화면에서 떨어진 자리는 다음 그리기에서 스스로 빠진다.
import { el, toast } from './core.js';

interface UpdateState { ready: boolean; version: string; busy: boolean }
interface UpdateBridge {
  get(): Promise<UpdateState>;
  apply(): Promise<{ ok?: boolean; error?: string }>;
  onChange(cb: (s: UpdateState) => void): () => void;
}
const bridge = (): UpdateBridge | null => {
  const d = (window as any).livelyDesktop;
  const u = d && d.update;
  return u && typeof u.get === 'function' && typeof u.apply === 'function' ? (u as UpdateBridge) : null;
};

/** 이 화면이 데스크톱 앱 안이고, 그 앱이 업데이트를 스스로 받아 두는 판인가. */
export function hasDesktopUpdate(): boolean { return !!bridge(); }

type Variant = 'bar' | 'row';
interface Slot { variant: Variant; seen: boolean }   // seen = 한 번이라도 문서에 붙은 적이 있다(아래 정리 규칙)
const hosts = new Map<HTMLElement, Slot>();
let cur: UpdateState = { ready: false, version: '', busy: false };
let applying = false;      // 눌렀다 — 이 창은 곧 사라진다(설치기가 앱을 닫는다). 두 번 누르지 못하게.
let wired = false;

// ── 나중에 하기 (#2203) ────────────────────────────────────────────────────────────────
// ★ 실측(2026-08-27 원준): "저거에 X버튼 없는 상황도 이해가 안 가네." — 맞는 지적이다. 종전엔 이 띠를 접는 길이
//  **재시작뿐**이었다. 지금 재시작할 수 없는 사정(작업 중·회의 중)은 늘 있는데 화면은 그걸 인정하지 않았다.
//  → 닫기를 준다. 다만 **그 버전에 대해서만** 접는다: 다음 버전이 오면 다시 뜬다(닫기가 자동 업데이트를
//    영구히 꺼 버리면 그건 보안 픽스까지 막는 스위치가 된다). 닫은 뒤에도 트레이 메뉴에 항목이 그대로 있다.
const DISMISS_KEY = 'deskup-dismissed';
const dismissKey = (s: UpdateState): string => s.version || 'unknown';   // 버전을 못 받은 판(구 앱)도 접히긴 해야 한다
function readDismissed(): string {
  try { return localStorage.getItem(DISMISS_KEY) || ''; } catch (_) { return ''; }   // 프라이빗 창·저장 차단
}
let dismissed = readDismissed();
function dismiss(): void {
  dismissed = dismissKey(cur);
  try { localStorage.setItem(DISMISS_KEY, dismissed); } catch (_) { /* 못 남겨도 이번 화면에선 접힌다 */ }
  paint();
}

/**
 * 붙일 자리를 하나 등록한다. 셸이 그 자리를 다시 만들 때마다 그냥 다시 부르면 된다 —
 *  화면에서 떨어진 옛 자리는 다음 그리기에서 저절로 정리된다(누수·중복 그리기 없음).
 *  · 'bar' 클래식 셸 상단 띠(전폭 한 줄) · 'row' 새 셸 사이드바 발치(두 줄짜리 작은 칸)
 */
export function mountDesktopUpdate(host: HTMLElement, variant: Variant = 'bar'): void {
  const b = bridge();
  if (!b) { host.hidden = true; return; }   // 브라우저·구 앱 — 자리만 접어 둔다(레이아웃에서 사라진다)
  // 같은 자리의 옛 등록 중 **문서에 붙지 못한 것**을 먼저 버린다 — 그리다 만 렌더(중간에 갈아엎힌 사이드바)가
  //  남기는 유일한 찌꺼기다. 붙어 있는 것은 건드리지 않는다(그게 지금 보이는 화면이다).
  for (const [h, sl] of hosts) if (sl.variant === variant && !h.isConnected) hosts.delete(h);
  hosts.set(host, { variant, seen: host.isConnected });
  if (!wired) {
    wired = true;
    // 밀어 주는 값이 정본이다(앱이 받자마자 온다). 첫 값만 물어본다 — preload 는 문서 시작 때 도는데
    //  업데이트는 그 뒤에 받아지므로, 부팅 값에 실어 두면 늘 한 박자 낡는다.
    try { b.onChange((s) => { cur = norm(s); paint(); }); } catch (_) { /* 다리가 낡았다 — get 만으로 산다 */ }
    void b.get().then((s) => { cur = norm(s); paint(); }).catch(() => { /* 못 물어봤다 — 다음 밀기를 기다린다 */ });
  }
  paint();
}

const norm = (s: any): UpdateState => ({
  ready: !!(s && s.ready), version: String((s && s.version) || '').trim(), busy: !!(s && s.busy),
});

function paint(): void {
  for (const [host, slot] of hosts) {
    // ⚠ '아직 안 붙었다' 와 '떨어졌다' 는 다르다 — 셸은 자리를 **만들면서** 등록하므로(그 시점엔 문서 밖이다)
    //  붙은 적 없는 자리를 정리하면 방금 만든 칸이 그대로 사라진다. 한 번 붙은 뒤 떨어진 것만 버린다.
    if (host.isConnected) slot.seen = true;
    else if (slot.seen) { hosts.delete(host); continue; }      // 셸이 그 자리를 갈아 끼웠다
    render(host, slot.variant);
  }
}

function render(host: HTMLElement, variant: Variant): void {
  // 접는 조건 둘 — 받아 둔 게 없다 / 이 버전은 사람이 "나중에" 라고 했다(다음 버전이 오면 다시 뜬다)
  if (!cur.ready || dismissed === dismissKey(cur)) { host.replaceChildren(); host.hidden = true; return; }
  const ver = cur.version ? '새 버전 ' + cur.version : '';
  // 닫기 — 지금 재시작할 수 없는 사람에게 주는 유일한 출구다(#2203). 아이콘만 두므로 이름을 반드시 붙인다.
  const x = el('button', {
    class: 'deskup-x', type: 'button', 'aria-label': '나중에 하기',
    title: '나중에 하기 — 트레이 메뉴에서 언제든 반영할 수 있습니다.',
    onclick: () => dismiss(),
  }, '×') as HTMLButtonElement;
  // 작업 중(설치·노드 기동 등)엔 앱이 적용을 거절한다 — 누르고 나서 거절당하는 대신 미리 잠그고 이유를 적는다.
  // 버튼은 기성 고스트(흰 바탕 + 헤어라인)다 — 채운 블루 primary 는 화면당 하나라는 예산이 있고(디자인 시스템 §0.5),
  //  이 띠는 화면의 과업이 아니라 **크롬**이라 그 하나를 가져가면 안 된다.
  const btn = el('button', {
    class: 'btn btn-ghost btn-sm deskup-btn', type: 'button', disabled: applying || cur.busy || null,
    onclick: () => void apply(),
  }, applying ? '다시 시작하는 중입니다…' : '다시 시작하여 반영하기') as HTMLButtonElement;
  const why = cur.busy ? '지금 도는 작업이 끝나면 반영할 수 있습니다.' : '';

  if (variant === 'row') {
    // 사이드바 발치 — 폭이 좁아 두 줄로 쌓는다. 문장은 짧게 하되 어미는 남긴다.
    //  닫기는 머리줄 오른쪽 끝에 둔다(카드의 관례 자리) — 반영 버튼과 나란히 두면 둘 중 뭘 누를지 헷갈린다.
    host.replaceChildren(
      el('div', { class: 'deskup-t' },
        el('span', { class: 'deskup-dot', 'aria-hidden': 'true' }),
        el('span', { text: '업데이트 준비가 완료되었습니다.' }),
        x),
      ...(ver || why ? [el('p', { class: 'deskup-sub', text: why || ver })] : []),
      btn);
  } else {
    host.replaceChildren(
      el('span', { class: 'deskup-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'deskup-txt', text: '업데이트 준비가 완료되었습니다. 다시 시작하면 반영됩니다.' }),
      ...(ver ? [el('span', { class: 'deskup-ver', text: ver })] : []),
      ...(why ? [el('span', { class: 'deskup-ver', text: why })] : []),
      btn, x);
  }
  host.className = 'deskup deskup-' + variant;
  host.setAttribute('role', 'status');
  host.hidden = false;
}

async function apply(): Promise<void> {
  const b = bridge();
  if (!b || applying) return;
  applying = true; paint();
  try {
    const r = await b.apply();
    // 성공이면 이 창은 곧 사라진다(설치기가 앱을 닫고 새 버전을 띄운다) — 되돌릴 화면이 없다.
    if (r && r.ok === false) { applying = false; paint(); toast(r.error || '업데이트를 적용하지 못했습니다.', true); }
  } catch (e: any) {
    applying = false; paint();
    toast('업데이트를 적용하지 못했습니다 — ' + (e && e.message ? e.message : e), true);
  }
}
