// v2/connect-routes.ts — [외부 앱 연결]의 «연결 길» (#4970, 상민님 2026-10-23).
//
//  목록은 앱마다 한 줄이다 — 어떤 길로 연결돼 있나 · 내가 할 다음 걸음 하나. 상세는 그 앱의 길을 우선순위대로 쌓는다 —
//   권하는 길은 펼쳐 두고, 나머지는 «다른 길» 아래에 접는다. 셀프호스트의 앱 등록도 여기서 끝까지 한다(걸음 · 붙여 넣을 값 ·
//   넣을 칸 · [등록]). 길과 상태는 서버가 정한다(org_connect_status — src/org/connect-routes.ts). 이 파일은 그리기만 하고,
//   말은 lib/connect-routes-view.ts(순수 — 시험 있음)가 정한다. 같은 판정을 화면이 다시 하면 AI(연결 스킬)와 화면이 서로 다른 길을 권한다.
//  비밀 값은 이 화면에서만 받는다 — 금고로 바로 가고 다시 보이지 않는다. 칸은 type=password 가 아니다(#1250 — 브라우저가 이 사이트
//   로그인 비밀번호로 저장하려 든다). 레포 도우미 secretInput · secretRow(가림 · 비밀번호 관리자 막기 · [보기])를 쓴다.
//  (#4991) 등록한 뒤에도 같은 칸에서 «앱 등록 보기 · 바꾸기 · 지우기» 를 한다 — 종전엔 등록 칸이 등록 전에만 보여 Client ID 를
//   다른 앱으로 바꾸거나 지울 길이 화면에 없었다(위시스트 2026-10-25). 보일지는 서버가 정하고(can_edit_registration — 매니지드는
//   라이블리가 앱을 쥐어 늘 false), 바꾸거나 지우면 무엇이 끊기는지도 서버가 말한다(org_connect_registration impact — 스킬과 같은 문장).
import { api, el, toast } from '../core.js';
import { confirmDialog } from '../ui-primitives.js';
import { svcTile } from '../svc-icons.js';
import { CLAUDE_CONNECTORS_URL, scanErrorText } from '../lib/claude-connectors.js';
import {
  ROUTE_NAME, looksLikePrivateKey, looksLoopbackAddress, regValues, routeBlurb, routeOrder, routeStateText, rowSummary, rowView,
  type ConnectAppIn, type RegistrationIn, type RouteIn, type RowBucket,
} from '../lib/connect-routes-view.js';
import { secretInput, secretRow } from '../lib/widgets.js';   // #1250 — 비밀 칸(가림 · 자동 채움 막기 · [보기])
import { openMeModal } from './me-modal.js';
import { renderAppClaude } from './connect-board.js';

export interface ConnectAppStatus extends ConnectAppIn {
  can_register: boolean;
  /** (#4991) 등록한 앱을 이 사람이 보고 바꾸고 지울 수 있나 — 셀프호스트 · 등록 권한 · 앱 준비됨. 옛 서버는 이 칸이 없다(= 안 보인다). */
  can_edit_registration?: boolean;
  connect_url: string | null;
  skill: string;
  note: string | null;
}
export interface ConnectStatus {
  prereq: { vault_ready: boolean; callback_url: string | null };
  can_collect: boolean;
  gateway_url: string | null;
  apps: ConnectAppStatus[];
}

/**
 * 상세의 길 칸에 쓸 앱 — 서버가 그 앱을 길 목록에 실었으면 그것(그 앱만 못 읽었으면 error 가 실려 온다).
 *  상태를 통째로 못 읽었으면 «못 읽음» 칸(다시 불러오기). 길 목록에 원래 없는 앱(관리자가 등록한 앱 · 내려 둔 앱)이면 null —
 *  칸을 세우지 않는다(못 읽은 것이 아니다 — 다시 불러와도 같다).
 */
export function routesAppFor(status: ConnectStatus | null, key: string, label: string): ConnectAppStatus | null {
  if (status) return status.apps.find((a) => a.app === key) ?? null;
  return {
    app: key, label, app_ready: null, routes: null, recommended: null, blocked_before: null,
    can_register: false, connect_url: null, skill: '', note: null, error: '연결 상태를 불러오지 못했어요',
  };
}

export async function loadConnectStatus(): Promise<ConnectStatus> {
  const r: any = await api('/api/ui/org/connect-status');
  return { prereq: r?.prereq || { vault_ready: true, callback_url: null }, can_collect: !!r?.can_collect, gateway_url: r?.gateway_url ?? null, apps: Array.isArray(r?.apps) ? r.apps : [] };
}

// ══ 목록 ═══════════════════════════════════════════════════════════════════════════

const GROUPS: Array<{ b: RowBucket[]; title: string; note: string }> = [
  { b: ['half'], title: '하나만 더 하면 돼요', note: '무엇을 모을지 정하거나, 다시 로그인하면 돼요' },
  { b: ['off'], title: '바로 연결할 수 있어요', note: '눌러서 안내대로 하면 돼요' },
  { b: ['on'], title: '연결돼 있어요', note: '모으고 있거나, Claude 커넥터로 이어 두었어요' },
  { b: ['soon'], title: '먼저 준비가 필요해요', note: '관리자나 라이블리가 먼저 할 일이 있어요' },
  { b: ['err'], title: '상태를 불러오지 못했어요', note: '앱을 누르면 그 앱만 다시 불러와요' },
];

/** 앱 한 줄 — 이름 · «어떻게 연결돼 있나» · 막힌 앞 길 한 줄 · 다음 걸음 단추. 줄 전체가 그 앱 상세로 간다(걸음은 상세가 이끈다). */
function appRow(a: ConnectAppStatus): HTMLElement {
  const v = rowView(a);
  return el('a', { class: 'cn-row cn-rt-row b-' + v.bucket, href: '#/connect/' + encodeURIComponent(a.app), title: a.label },
    svcTile(a.app, a.label, v.bucket !== 'soon' && v.bucket !== 'err'),
    el('span', { class: 'cn-row-main' },
      el('span', { class: 't' }, el('span', { text: a.label }), v.bucket === 'on' ? el('span', { class: 'cn-dot on', 'aria-label': '모으는 중' }) : null),
      el('span', { class: 'm cn-rt-word', text: v.word }),
      v.blockedNote ? el('span', { class: 'm cn-rt-blk', text: v.blockedNote }) : null),
    v.button ? el('span', { class: 'btn btn-ghost btn-sm cn-rt-btn', text: v.button }) : null,
    el('span', { class: 'cn-row-go', 'aria-hidden': 'true', text: '›' }));
}

/** 목록 — 묶음 넷(정할 것 · 바로 연결 · 모으는 중 · 준비 필요)과 요약. 못 읽으면 그 사실만 말한다(거짓 «연결 전» 을 만들지 않는다). */
export function appRows(status: ConnectStatus | null, q = ''): HTMLElement {
  if (!status) return el('p', { class: 'v2-desc', style: 'color:var(--warn-text)', text: '앱 연결 상태를 불러오지 못했어요. 잠시 뒤 다시 열어 주세요.' });
  const hit = status.apps.filter((a) => !q || a.label.toLowerCase().includes(q) || a.app.includes(q));
  const n = rowSummary(status.apps);
  const sum = el('div', { class: 'cn-sum' },
    el('span', { class: 'cn-sum-i on' }, el('b', { text: String(n.on) }), el('span', { text: '연결됨' })),
    ...(n.half ? [el('span', { class: 'cn-sum-i half' }, el('b', { text: String(n.half) }), el('span', { text: '하나만 더' }))] : []),
    el('span', { class: 'cn-sum-i' }, el('b', { text: String(n.off) }), el('span', { text: '바로 연결할 수 있음' })),
    ...(n.soon ? [el('span', { class: 'cn-sum-i soon' }, el('b', { text: String(n.soon) }), el('span', { text: '준비 필요' }))] : []));
  const groups = GROUPS.map((g) => {
    const items = hit.filter((a) => g.b.includes(rowView(a).bucket));
    if (!items.length) return null;
    return el('section', { class: 'cn-group' },
      el('div', { class: 'cn-gh' }, el('b', { text: g.title }), el('span', { class: 'n', text: String(items.length) }), el('span', { class: 'h', text: g.note })),
      el('div', { class: 'cn-list cn-rt-list' }, ...items.map(appRow)));
  }).filter(Boolean) as HTMLElement[];
  const warn = status.prereq.vault_ready === false
    ? el('p', { class: 'cn-arrived off' }, el('b', { text: '연결 정보를 저장할 수 없는 상태예요. ' }),
      el('span', { text: '라이블리를 설치·운영하는 분께 «자격 금고 키(CONNECTOR_SECRET_KEY) 설정» 을 부탁해 주세요. 그 전에는 어떤 앱도 연결되지 않아요.' }))
    : null;
  return el('div', { class: 'cn-rt-list-wrap' }, ...(warn ? [warn] : []), sum,
    ...(groups.length ? groups : [el('p', { class: 'v2-empty', text: q ? `'${q}' 와(과) 맞는 앱이 없어요.` : '연결할 수 있는 앱이 없어요.' })]));
}

/** 내 연결 표(me-logins SvcView)의 줄 — 길 목록 밖의 줄을 그리는 데 쓰는 칸만. */
export interface OtherAppIn { key: string; label: string; dynamic?: boolean }

/**
 * 길 목록(org_connect_status 의 앱 아홉) 밖의 줄.
 *  · 관리자가 등록한 «표에 없는 앱»(me-logins svcFromConnector — dynamic) — AI 가 내 계정으로 직접 쓰는 연결이라 자료를 모으는 길은 없다.
 *    원준 2026-08-21 «표에 없는 커넥터도 흘려보내지 않는다».
 *  · 연결 상태를 못 읽었을 때(권한 · 서버 오류) — 앱마다 상세로 들어갈 줄만(거짓 «연결 전» 을 만들지 않는다).
 */
export function otherRows(view: { all: OtherAppIn[]; connected: OtherAppIn[] } | null, status: ConnectStatus | null, q: string): HTMLElement[] {
  if (!view) return [];
  const hit = (s: OtherAppIn): boolean => !q || s.label.toLowerCase().includes(q) || s.key.includes(q);
  const isOn = (s: OtherAppIn): boolean => view.connected.some((x) => x.key === s.key);
  const row = (s: OtherAppIn, word: string): HTMLElement => el('a', { class: 'cn-row cn-rt-row b-off', href: '#/connect/' + encodeURIComponent(s.key), title: s.label },
    svcTile(s.key, s.label, true),
    el('span', { class: 'cn-row-main' },
      el('span', { class: 't' }, el('span', { text: s.label }), isOn(s) ? el('span', { class: 'cn-dot on', 'aria-label': '연결됨' }) : null),
      el('span', { class: 'm cn-rt-word', text: word })),
    el('span', { class: 'cn-row-go', 'aria-hidden': 'true', text: '›' }));
  const group = (title: string, note: string, items: HTMLElement[]): HTMLElement => el('section', { class: 'cn-group' },
    el('div', { class: 'cn-gh' }, el('b', { text: title }), el('span', { class: 'n', text: String(items.length) }), el('span', { class: 'h', text: note })),
    el('div', { class: 'cn-list cn-rt-list' }, ...items));
  const out: HTMLElement[] = [];
  const known = new Set((status?.apps ?? []).map((a) => a.app));
  if (!status) {
    const base = view.all.filter((s) => !s.dynamic && hit(s));
    if (base.length) out.push(group('앱', '앱을 누르면 그 앱의 연결을 볼 수 있어요', base.map((s) => row(s, isOn(s) ? '내 계정으로 연결됨' : '앱을 눌러 연결 상태를 봐 주세요'))));
  }
  const dyn = view.all.filter((s) => s.dynamic && !known.has(s.key) && hit(s));
  if (dyn.length) out.push(group('그 밖에 연결할 수 있는 앱', '관리자가 등록한 앱이에요 — AI 가 내 계정으로 직접 써요(자료를 모으지는 않아요)',
    dyn.map((s) => row(s, isOn(s) ? '내 계정으로 연결됨' : '아직 연결 전 — 계정으로 한 번 허용하면 돼요'))));
  return out;
}

// ══ 상세 — 연결 길 ═══════════════════════════════════════════════════════════════════

export interface RoutesCtx {
  /** 라이블리 앱으로 그 자리에서 계정 연결을 시작한다(슬랙·깃허브처럼 한 번에 되는 앱). 없으면 아래 «자료 가져오기» 칸으로 보낸다. */
  startAppConnect: (() => void) | null;
  /** 아래 «자료 가져오기» 칸으로 — 범위 정하기 · 켜기 · 그 앱만의 연결 단추가 거기 있다. */
  toCollect: () => void;
  /** 개인 토큰 창. */
  openToken: (() => void) | null;
  /** 다시 그린다(서버를 다시 읽는다). */
  reload: () => void;
  /** 워크스페이스 관리 권한 — 공개 주소 넣기. */
  canManage: boolean;
}

/** 상세 맨 위 «연결 길» 칸 — 권하는 길 펼침 + «다른 길». */
export function routesSection(a: ConnectAppStatus, ctx: RoutesCtx): HTMLElement {
  const head = el('div', { class: 'cn-gh' }, el('b', { role: 'heading', 'aria-level': '2', text: '연결하는 길' }), el('span', { class: 'h', text: '위에서부터 권하는 순서예요' }));
  if (a.error || !Array.isArray(a.routes)) {
    //  못 읽었으면 막다른 칸으로 두지 않는다 — 다시 불러오기 단추와, 그래도 안 되면 할 수 있는 일(아래 칸 · [연결 도와줘]).
    return el('section', { class: 'cn-sect cn-rt', id: 'cn-routes' }, head,
      el('div', { class: 'cn-rt-card' },
        el('p', { class: 'cn-rt-st', style: 'color:var(--warn-text)', text: `${a.label} 연결 상태를 불러오지 못했어요.` }),
        el('p', { class: 'cn-rt-bl', text: '잠시 뒤 다시 불러와 보세요. 그동안은 아래 칸에서 직접 켜거나, 목록 위 [연결 도와줘]로 AI 에게 맡길 수 있어요.' }),
        el('div', { class: 'cn-rt-body' }, el('div', { class: 'cn-rt-acts' }, btn('다시 불러오기', ctx.reload, true)))));
  }
  const { first, rest } = routeOrder(a);
  const kids: HTMLElement[] = [];
  if (first) {
    const c = routeCard(first, a, ctx, true);
    kids.push(c.node);
    c.load?.();
  }
  if (rest.length) {
    const cards = rest.map((r) => routeCard(r, a, ctx, false));
    const more = el('details', { class: 'cn-rt-more' },
      el('summary', { text: `다른 길 ${rest.length}가지` }), ...cards.map((c) => c.node)) as HTMLDetailsElement;
    //  접힌 칸은 펼 때 불러온다 — 구성원·수집 단위 조회 다섯 건을 아무도 안 보는 칸 때문에 매번 부르지 않게.
    let loaded = false;
    more.addEventListener('toggle', () => { if (more.open && !loaded) { loaded = true; for (const c of cards) c.load?.(); } });
    kids.push(more);
  }
  if (!kids.length) kids.push(el('p', { class: 'v2-desc', text: `${a.label}에는 지금 연결할 수 있는 길이 없어요.` }));
  return el('section', { class: 'cn-sect cn-rt', id: 'cn-routes' }, head, ...kids);
}

function routeCard(r: RouteIn, a: ConnectAppStatus, ctx: RoutesCtx, primary: boolean): { node: HTMLElement; load: (() => void) | null } {
  const body = el('div', { class: 'cn-rt-body' });
  const node = el('div', { class: 'cn-rt-card' + (primary ? ' primary' : '') + ' s-' + r.state },
    el('div', { class: 'cn-rt-hd' },
      el('b', { text: ROUTE_NAME[r.kind] }),
      primary ? el('span', { class: 'cn-rt-rec', text: '권하는 길' }) : null,
      el('span', { class: 'cn-rt-st', text: routeStateText(r, a) })),
    el('p', { class: 'cn-rt-bl', text: routeBlurb(r, a.label) }),
    body);
  return { node, load: fillRouteBody(body, r, a, ctx) };
}

function btn(text: string, onclick: () => void, primary = false): HTMLButtonElement {
  return el('button', { class: 'btn btn-sm ' + (primary ? 'btn-primary' : 'btn-ghost'), type: 'button', text, onclick }) as HTMLButtonElement;
}

/** 길 칸 안 — 그 길의 단추와 칸. 따로 불러올 것이 있으면(Claude 길의 구성원·모으는 곳) 그 일을 돌려준다(펼칠 때 부른다). */
function fillRouteBody(body: HTMLElement, r: RouteIn, a: ConnectAppStatus, ctx: RoutesCtx): (() => void) | null {
  const acts = el('div', { class: 'cn-rt-acts' });
  if (r.kind === 'app') {
    if (r.state === 'register' && a.registration) { body.appendChild(registrationPanel(a, a.registration, ctx, true)); return null; }
    if (r.state === 'ask_admin' && a.app_ready === false) {
      body.appendChild(adminAsk(a, '라이블리 관리자에게 이 화면 주소를 보내 «앱 등록» 을 부탁해 주세요.'));
      if (a.registration) body.appendChild(el('details', { class: 'cn-rt-more' }, el('summary', { text: '관리자가 할 일 보기' }), registrationPanel(a, a.registration, ctx, false)));
      return null;
    }
    if (r.state === 'connect') acts.appendChild(ctx.startAppConnect ? btn('연결', ctx.startAppConnect, true) : btn('아래 «자료 가져오기» 에서 켜기 ↓', ctx.toCollect, true));
    if (r.state === 'set_scope') acts.appendChild(btn('무엇을 모을지 정하기 ↓', ctx.toCollect, true));
    if (r.state === 'collecting') acts.appendChild(btn('모으는 범위 보기 ↓', ctx.toCollect));
    if (r.state === 'ask_admin') body.appendChild(adminAsk(a, '수집을 켜는 건 관리자가 해요. 관리자에게 이 화면 주소를 보내 주세요.'));
    if (a.can_edit_registration) {
      //  등록한 뒤의 칸은 접어 둔다 — 늘 쓰는 일이 아니고, 펼 때 불러온다(구성원 연결 수를 세는 조회를 아무도 안 보는 칸 때문에 매번 부르지 않게).
      if (acts.childNodes.length) body.appendChild(acts);
      body.appendChild(registrationManage(a, ctx));
      return null;
    }
  } else if (r.kind === 'ai') {
    if (r.state === 'off') return null;
    if (r.needs === 'claude_login') acts.appendChild(btn('Claude 로그인하기', () => openMeModal({ tab: 'aiacct' }), true));
    else if (r.state === 'connect' || r.state === 'reconnect') {
      acts.appendChild(el('a', { class: 'btn btn-sm btn-primary', href: CLAUDE_CONNECTORS_URL, target: '_blank', rel: 'noopener', text: r.state === 'reconnect' ? 'Claude 에서 다시 연결 ↗' : 'Claude 에서 연결 ↗',
        title: 'Claude 웹의 커넥터 설정을 엽니다. 라이블리에 로그인해 둔 그 Claude 계정이어야 해요.' }));
    }
    if (r.needs !== 'claude_login') acts.appendChild(refreshBtn(ctx.reload));
    const who = el('div', { class: 'cn-rt-who' });
    body.append(acts, who);
    //  공개범위·모을지를 바꿔도 길 상태는 그대로라 화면 전체를 다시 그리지 않는다(그 칸만 다시 그린다 — renderAppClaude 안의 repaint).
    const aiApp = r.ai_app;
    return aiApp ? () => { void renderAppClaude(who, aiApp); } : null;
  } else {
    if (r.state === 'connect' && ctx.openToken) acts.appendChild(btn('토큰 넣기', ctx.openToken, true));
    if (r.state === 'set_scope') acts.appendChild(btn('무엇을 모을지 정하기 ↓', ctx.toCollect, true));
    if (r.state === 'collecting') acts.appendChild(btn('모으는 범위 보기 ↓', ctx.toCollect));
    if (r.state === 'ask_admin') body.appendChild(adminAsk(a, '수집을 켜는 건 관리자가 해요. 관리자에게 이 화면 주소를 보내 주세요.'));
  }
  if (acts.childNodes.length) body.appendChild(acts);
  return null;
}

/** [내 Claude 앱 새로 확인] — 서버가 내 Claude 커넥터를 다시 본다(15초 안에 다시 누르면 방금 값). */
function refreshBtn(reload: () => void): HTMLButtonElement {
  const b = btn('다시 확인', async () => {
    b.disabled = true; b.textContent = '확인하는 중…';
    try {
      const r: any = await api('/api/ui/me/ai-connectors/refresh', { method: 'POST', body: '{}' });
      if (r?.skipped === 'policy-off') toast('이 워크스페이스는 구성원 Claude 커넥터를 쓰지 않아요(관리자 설정).');
      else if (r?.skipped === 'recent') toast('방금 확인한 값이에요. 잠시 뒤 다시 눌러 주세요.');
      else if (r?.record?.scan && !r.record.scan.ok) toast(scanErrorText(r.record.scan.error));
      else toast('새로 확인했어요.');
    } catch (e: any) { toast(`확인하지 못했어요 — ${(e && e.message) || e}`, true); }
    reload();
  });
  return b;
}

/** 남이 할 일 — 무엇을 부탁하면 되는지 한 줄과 이 화면 주소 복사. */
function adminAsk(a: ConnectAppStatus, say: string): HTMLElement {
  const url = a.connect_url || location.href;
  return el('div', { class: 'cn-rt-ask' },
    el('span', { text: say }),
    btn('주소 복사', () => { void copyText(url, '이 화면 주소를 복사했어요 — 관리자에게 보내 주세요.'); }));
}

async function copyText(text: string, done: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); toast(done); }
  catch (_) { toast('복사하지 못했어요 — 직접 선택해서 복사해 주세요.', true); }
}

// ══ 앱 등록 칸 ═══════════════════════════════════════════════════════════════════════

/**
 * 앱 등록 — 누가 · 몇 분 → (공개 주소가 없으면 그것부터) → 걸음(링크 · 붙여 넣을 값) → 넣을 칸 → [등록]. editable=false 면 읽기만(관리자가 할 일 보기).
 *  mode='replace'(#4991) 는 등록한 뒤 값을 바꿀 때 — 같은 앱의 값만 새로 넣는 일이 많아 걸음은 접어 두고, 단추는 [바꾸기].
 */
function registrationPanel(a: ConnectAppStatus, reg: RegistrationIn, ctx: RoutesCtx, editable: boolean, mode: 'register' | 'replace' = 'register'): HTMLElement {
  const wrap = el('div', { class: 'cn-reg' });
  if (mode === 'register') wrap.appendChild(el('p', { class: 'cn-reg-who', text: `만들 것: ${reg.what} · 할 수 있는 사람: ${reg.who} · 약 ${reg.minutes}분` }));
  if (reg.missing.length) wrap.appendChild(addressFirst(ctx));
  const ol = el('ol', { class: 'cn-reg-steps' });
  for (const s of reg.steps) {
    //  번호는 목록이 붙인다(li 는 list-item 그대로) — 칸 배치는 안쪽 상자가 한다. li 를 flex 로 만들면 번호가 사라진다(화면 실측).
    //  바꾸기 칸의 단추는 [바꾸기] 다 — 걸음 글의 «[등록] 을 누릅니다» 를 단추 이름에 맞춘다(안내 데이터는 화면·스킬 한 벌이라 여기서만 바꾼다).
    const text = mode === 'replace' ? s.text.replace('[등록] 을', '[바꾸기] 를') : s.text;
    const li = el('div', { class: 'cn-reg-li' }, el('span', { class: 'cn-reg-t', text }));
    if (s.link) li.appendChild(stepLink(s.link));
    if (s.copy) {
      li.appendChild(s.copy.value
        ? el('div', { class: 'cn-reg-copy' }, el('code', { text: s.copy.value }), copyBtn(s.copy.what, s.copy.value))
        : el('div', { class: 'cn-reg-copy none', text: '공개 주소를 넣으면 여기에 붙여 넣을 값이 보여요.' }));
    }
    ol.appendChild(el('li', {}, li));
  }
  wrap.appendChild(mode === 'replace'
    ? el('details', { class: 'cn-rt-more' }, el('summary', { text: `새 앱을 만드는 걸음 보기 — ${reg.who} · 약 ${reg.minutes}분` }), ol)
    : ol);
  if (editable) wrap.appendChild(regForm(a, reg, ctx, mode));
  if (reg.notes.length) wrap.appendChild(el('div', { class: 'cn-reg-notes' }, el('b', { text: '알아 둘 것' }), el('ul', {}, ...reg.notes.map((n) => el('li', { text: n })))));
  return wrap;
}

/** [복사] — 같은 화면에 여럿이라 무엇을 복사하는지 이름으로 말한다(화면 읽기). */
function copyBtn(what: string, value: string): HTMLButtonElement {
  const name = what === 'callback_url' ? '돌아올 주소' : what === 'gateway_url' ? '라이블리 주소' : '값';
  const b = btn('복사', () => { void copyText(value, `${name}${name === '값' ? '을' : '를'} 복사했어요.`); });
  b.setAttribute('aria-label', `${name} 복사`);
  return b;
}

function stepLink(link: NonNullable<RegistrationIn['steps'][number]['link']>): HTMLElement {
  if (link.kind === 'url') return el('a', { class: 'btn btn-ghost btn-sm', href: link.url, target: '_blank', rel: 'noopener noreferrer', text: link.label + ' ↗' });
  //  슬랙 — 이름·권한·돌아올 주소가 채워진 «앱 만들기» 링크는 서버가 만든다(이 워크스페이스의 공개 주소가 들어간다).
  const b = btn(link.label + ' ↗', async () => {
    b.disabled = true;
    try {
      const r: any = await api('/api/ui/org/slack/app-manifest');
      if (!r?.create_url) throw new Error('앱 만들기 링크를 받지 못했어요');
      window.open(r.create_url, '_blank', 'noopener');
    } catch (e: any) { toast((e && e.message) || '앱 만들기 링크를 받지 못했어요', true); }
    b.disabled = false;
  }, true);
  return b;
}

/** 공개 주소가 없으면 돌아올 주소를 만들 수 없다 — 관리 권한이 있으면 이 자리에서 넣는다(지금 브라우저 주소가 기본값). */
function addressFirst(ctx: RoutesCtx): HTMLElement {
  if (!ctx.canManage) {
    return el('div', { class: 'cn-rt-ask' }, el('span', { text: '먼저 이 워크스페이스의 공개 주소가 필요해요. 워크스페이스 관리자에게 «공개 주소 넣기» 를 부탁해 주세요.' }));
  }
  const inp = el('input', { type: 'url', class: 'cn-scope-in', value: location.origin, 'aria-label': '이 워크스페이스의 공개 주소', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  //  지금 주소가 «이 컴퓨터 자신» 이면 그대로 저장하지 않게 먼저 말한다 — 다른 사람의 브라우저는 그 주소로 못 돌아온다.
  const warn = el('p', { class: 'cn-reg-t', style: 'color:var(--warn-text)' });
  const check = (): void => { warn.textContent = looksLoopbackAddress(inp.value.trim()) ? '이 주소는 이 컴퓨터에서만 열려요 — 다른 사람이 라이블리를 여는 주소(예: https://lively.회사.com)를 넣어 주세요.' : ''; };
  inp.addEventListener('input', check);
  check();
  const save = btn('주소 저장', async () => {
    const v = inp.value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^/\s]+/.test(v)) { toast('http:// 또는 https:// 로 시작하는 주소를 넣어 주세요', true); inp.focus(); return; }
    save.disabled = true;
    try {
      await api('/api/ui/org/profile', { method: 'POST', body: JSON.stringify({ gateway_url: v }) });
      toast('공개 주소를 저장했어요.');
      ctx.reload();
    } catch (e: any) { toast((e && e.message) || '저장하지 못했어요', true); save.disabled = false; }
  }, true);
  return el('div', { class: 'cn-reg-addr' },
    el('p', { class: 'cn-reg-t', text: '먼저 이 워크스페이스의 공개 주소를 넣어요 — 외부 앱이 연결을 마치고 돌아올 주소가 여기서 만들어져요. 보통은 지금 브라우저 주소창의 앞부분이에요.' }),
    el('div', { class: 'cn-scope-row' }, inp, save), warn);
}

/** 넣을 칸 + [등록] — 값은 금고로 바로 가고 다시 보이지 않는다. 빠진 칸은 서버에 보내기 전에 말한다. replace 는 같은 문으로 덮어쓴다(#4991). */
function regForm(a: ConnectAppStatus, reg: RegistrationIn, ctx: RoutesCtx, mode: 'register' | 'replace' = 'register'): HTMLElement {
  const verb = mode === 'replace' ? '바꾸기' : '등록';
  const vals: Record<string, string> = {};
  const rows = reg.fields.map((f) => {
    if (f.file) {
      //  고르기 전엔 말을 붙이지 않는다 — 브라우저가 이미 «선택된 파일 없음» 을 보인다(두 말이 겹친다).
      const name = el('span', { class: 'cn-reg-file-n' });
      const inp = el('input', { type: 'file', accept: '.pem,application/x-pem-file,text/plain', 'aria-label': f.label }) as HTMLInputElement;
      inp.onchange = async () => {
        const file = inp.files && inp.files[0];
        vals[f.key] = '';
        if (!file) { name.textContent = ''; return; }
        const text = await file.text().catch(() => '');
        if (!looksLikePrivateKey(text)) { name.textContent = `${file.name} — 키 파일이 아니에요`; toast('Private key 파일(.pem)을 골라 주세요 — [Generate a private key] 로 받은 파일이에요.', true); inp.value = ''; return; }
        vals[f.key] = text;
        name.textContent = `${file.name} — 골랐어요`;
      };
      return el('label', { class: 'cn-reg-f' }, el('span', { class: 'k', text: f.label }), el('span', { class: 'cn-reg-file' }, inp, name));
    }
    const inp = f.secret
      ? secretInput({ class: 'cn-scope-in', placeholder: f.label, 'aria-label': f.label })
      : el('input', { type: 'text', class: 'cn-scope-in', placeholder: f.label, 'aria-label': f.label, autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
    inp.addEventListener('input', () => { vals[f.key] = String(inp.value || ''); });
    return el('label', { class: 'cn-reg-f' }, el('span', { class: 'k', text: f.label }), f.secret ? secretRow(inp) : inp);
  });
  const go = btn(verb, async () => {
    const v = regValues(reg.fields, vals);
    if (!v.ok) { toast(`«${v.missing}» 칸을 채워 주세요`, true); return; }
    go.disabled = true; go.textContent = mode === 'replace' ? '바꾸는 중…' : '등록하는 중…';
    try {
      await api('/api/ui/org/connect/register', { method: 'POST', body: JSON.stringify({ app: a.app, values: v.values }) });
      for (const k of Object.keys(vals)) vals[k] = '';
      toast(mode === 'replace' ? `${a.label} 앱 등록 값을 바꿨어요.` : `${a.label} 앱을 등록했어요 — 위 «연결하는 길» 의 다음 단추를 누르면 돼요.`);
      ctx.reload();
    } catch (e: any) {
      toast((e && e.message) || (mode === 'replace' ? '바꾸지 못했어요' : '등록하지 못했어요'), true);
      go.disabled = false; go.textContent = verb;
    }
  }, true);
  return el('div', { class: 'cn-reg-form' },
    el('b', { text: '라이블리에 넣기' }),
    el('span', { class: 'cn-reg-t', text: '여기 넣은 값은 금고로 바로 저장되고 다시 보이지 않아요. 대화에 붙여 넣지 마세요.' }),
    ...rows, el('div', { class: 'cn-rt-acts' }, go));
}

// ══ 앱 등록 보기 · 바꾸기 · 지우기 (#4991) ═════════════════════════════════════════════════════════

/** org_connect_registration 응답 — 비밀 값은 오지 않는다. */
export interface RegistrationInfo {
  current: { source: 'vault' | 'env' | 'relay' | null; client_id: string | null; app_id?: string | null; app_slug?: string | null; private_key?: boolean; updated_at: string | null };
  impact: { replace: string[]; remove: string[] };
  registration: RegistrationIn | null;
}

/** 등록한 뒤의 칸 — 접어 두고 펼 때 불러온다. 못 읽으면 그 사실과 [다시 불러오기]. */
function registrationManage(a: ConnectAppStatus, ctx: RoutesCtx): HTMLElement {
  const box = el('div', { class: 'cn-reg-man' });
  const det = el('details', { class: 'cn-rt-more cn-reg-mgr' }, el('summary', { text: '앱 등록 보기 · 바꾸기 · 지우기' }), box) as HTMLDetailsElement;
  let loaded = false;
  const paint = async (): Promise<void> => {
    box.replaceChildren(el('p', { class: 'cn-reg-t', text: '앱 등록을 불러오는 중이에요…' }));
    let g: RegistrationInfo;
    try { g = await api('/api/ui/org/connect/registration?app=' + encodeURIComponent(a.app)); }
    catch (e: any) {
      box.replaceChildren(
        el('p', { class: 'cn-reg-t', style: 'color:var(--warn-text)', text: `앱 등록을 불러오지 못했어요 — ${(e && e.message) || e}` }),
        el('div', { class: 'cn-rt-acts' }, btn('다시 불러오기', () => { void paint(); })));
      return;
    }
    box.replaceChildren(...manageBody(a, g, ctx));
  };
  det.addEventListener('toggle', () => { if (det.open && !loaded) { loaded = true; void paint(); } });
  return det;
}

/** 지금 등록 — 무엇이 등록돼 있는지 이름표와 값으로(Client ID 는 연결 화면 주소에 늘 실리는 공개 값이다). 비밀 값은 오지 않는다. */
function currentBlock(c: RegistrationInfo['current']): HTMLElement {
  if (c.source === 'relay') return el('p', { class: 'cn-reg-cur', text: '이 앱은 라이블리 클라우드로 연결해요 — 이 서버에는 바꾸거나 지울 앱 등록이 없어요.' });
  if (c.source === 'env') return el('p', { class: 'cn-reg-cur', text: '지금은 서버 설정(환경 변수)에 있는 앱으로 연결해요. 여기서 값을 넣으면 그 값이 먼저 쓰여요.' });
  if (c.source !== 'vault') return el('p', { class: 'cn-reg-cur', text: '등록된 앱 값을 찾지 못했어요.' });
  const rows: Array<[string, string]> = [];
  if (c.app_id) rows.push(['App ID', c.app_id]);
  rows.push(['Client ID', c.client_id || '읽지 못했어요']);
  if (c.app_slug) rows.push(['앱 주소 이름', c.app_slug]);
  if (c.private_key !== undefined) rows.push(['키 파일', c.private_key ? '들어 있어요' : '아직 없어요']);
  const when = c.updated_at ? new Date(c.updated_at) : null;
  if (when && !isNaN(when.getTime())) rows.push(['넣은 날', when.toLocaleDateString('ko-KR')]);
  return el('div', { class: 'cn-reg-cur' }, el('b', { text: '지금 등록된 앱' }),
    el('dl', {}, ...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])));
}

function manageBody(a: ConnectAppStatus, g: RegistrationInfo, ctx: RoutesCtx): HTMLElement[] {
  const out: HTMLElement[] = [currentBlock(g.current)];
  if (g.current.source === 'relay') return out;
  const swap = el('div', { class: 'cn-reg-swap' });
  swap.hidden = true;
  let filled = false;
  const acts = el('div', { class: 'cn-rt-acts' });
  if (g.registration) {
    const reg = g.registration;
    acts.appendChild(btn(g.current.source === 'vault' ? '등록 값 바꾸기' : '등록 값 넣기', () => {
      if (!filled) {
        filled = true;
        swap.append(
          el('p', { class: 'cn-reg-t', text: '같은 앱의 값만 새로 받은 거라면(Client ID 가 같으면) 이미 된 연결은 그대로예요. 다른 앱으로 바꾸면 이렇게 돼요.' }),
          el('ul', { class: 'cn-reg-impact' }, ...g.impact.replace.map((t) => el('li', { text: t }))),
          registrationPanel(a, reg, ctx, true, 'replace'));
      }
      swap.hidden = !swap.hidden;
    }));
  }
  if (g.current.source === 'vault') {
    const del = btn('등록 지우기', () => { void removeRegistration(a, g, ctx); });
    del.classList.add('cn-dz-btn');
    acts.appendChild(del);
  }
  if (acts.childNodes.length) out.push(acts);
  out.push(swap);
  return out;
}

/**
 * [등록 지우기] — 끊기는 것을 먼저 보이고(서버 impact.remove), 확인을 받은 뒤 지운다. 지운 뒤 다시 그리면 등록 칸이 다시 선다.
 *  확인 창 직전에 다시 읽는다 — 칸을 편 채 두는 동안 연결 수가 바뀔 수 있고, 확인 창은 누르는 그때 참인 것만 말해야 한다.
 *  못 읽으면 칸을 펼 때 읽은 값으로 묻는다. 그새 누가 지웠으면(vault 아님) 묻지 않고 다시 그린다.
 */
async function removeRegistration(a: ConnectAppStatus, loaded: RegistrationInfo, ctx: RoutesCtx): Promise<void> {
  let g = loaded;
  try { g = await api('/api/ui/org/connect/registration?app=' + encodeURIComponent(a.app)); } catch (_) { g = loaded; }
  if (g.current.source !== 'vault') { toast('지울 앱 등록이 이미 없어요 — 화면을 다시 그릴게요.'); ctx.reload(); return; }
  const yes = await confirmDialog({
    title: `${a.label} 앱 등록을 지울까요?`, danger: true, confirmText: '등록 지우기',
    message: '라이블리에 넣어 둔 이 앱의 등록 값을 지워요. 이미 된 연결과 모은 자료는 지우지 않아요.',
    lines: g.impact.remove,
  });
  if (!yes) return;
  try {
    const r: any = await api('/api/ui/org/connect/unregister', { method: 'POST', body: JSON.stringify({ app: a.app }) });
    if (!r?.deleted) toast('지울 앱 등록이 없었어요.');
    else if (r.app_ready) toast(`${a.label} 앱 등록을 지웠어요 — 서버 설정(환경 변수)의 앱으로 계속 연결해요.`);
    else toast(`${a.label} 앱 등록을 지웠어요 — 위 «연결하는 길» 에서 다시 등록할 수 있어요.`);
  } catch (e: any) { toast((e && e.message) || '지우지 못했어요', true); }
  ctx.reload();
}
