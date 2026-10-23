// v2/connect-routes.ts — [외부 앱 연결]의 «연결 길» (#4970, 상민님 2026-10-23).
//
//  목록은 앱마다 한 줄이다 — 어떤 길로 연결돼 있나 · 내가 할 다음 걸음 하나. 상세는 그 앱의 길을 우선순위대로 쌓는다 —
//   권하는 길은 펼쳐 두고, 나머지는 «다른 길» 아래에 접는다. 셀프호스트의 앱 등록도 여기서 끝까지 한다(걸음 · 붙여 넣을 값 ·
//   넣을 칸 · [등록]). 길과 상태는 서버가 정한다(org_connect_status — src/org/connect-routes.ts). 이 파일은 그리기만 하고,
//   말은 lib/connect-routes-view.ts(순수 — 시험 있음)가 정한다. 같은 판정을 화면이 다시 하면 AI(연결 스킬)와 화면이 서로 다른 길을 권한다.
//  비밀 값은 이 화면에서만 받는다 — 금고로 바로 가고 다시 보이지 않는다. 칸은 type=password 가 아니다(#1250 — 브라우저가 이 사이트
//   로그인 비밀번호로 저장하려 든다). 글자 칸 + 가림(.secret-input).
import { api, el, toast } from '../core.js';
import { svcTile } from '../svc-icons.js';
import { CLAUDE_CONNECTORS_URL, scanErrorText } from '../lib/claude-connectors.js';
import {
  ROUTE_NAME, looksLikePrivateKey, regValues, routeBlurb, routeOrder, routeStateText, rowSummary, rowView,
  type ConnectAppIn, type RegistrationIn, type RouteIn, type RowBucket,
} from '../lib/connect-routes-view.js';
import { openMeModal } from './me-modal.js';
import { renderAppClaude } from './connect-board.js';

export interface ConnectAppStatus extends ConnectAppIn {
  can_register: boolean;
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

export async function loadConnectStatus(): Promise<ConnectStatus> {
  const r: any = await api('/api/ui/org/connect-status');
  return { prereq: r?.prereq || { vault_ready: true, callback_url: null }, can_collect: !!r?.can_collect, gateway_url: r?.gateway_url ?? null, apps: Array.isArray(r?.apps) ? r.apps : [] };
}

// ══ 목록 ═══════════════════════════════════════════════════════════════════════════

const GROUPS: Array<{ b: RowBucket[]; title: string; note: string }> = [
  { b: ['half'], title: '정할 것이 남았어요', note: '연결은 됐어요 — 하나만 더 하면 모으기 시작해요' },
  { b: ['off'], title: '바로 연결할 수 있어요', note: '눌러서 안내대로 하면 돼요' },
  { b: ['on'], title: '연결돼 있어요', note: '모으고 있거나, Claude 커넥터로 이어 두었어요' },
  { b: ['soon', 'err'], title: '먼저 준비가 필요해요', note: '관리자나 라이블리가 먼저 할 일이 있어요' },
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
    ...(n.half ? [el('span', { class: 'cn-sum-i half' }, el('b', { text: String(n.half) }), el('span', { text: '정할 것 남음' }))] : []),
    el('span', { class: 'cn-sum-i' }, el('b', { text: String(n.off) }), el('span', { text: '바로 연결할 수 있음' })),
    ...(n.soon + n.err ? [el('span', { class: 'cn-sum-i soon' }, el('b', { text: String(n.soon + n.err) }), el('span', { text: '준비 필요' }))] : []));
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
  if (a.error || !Array.isArray(a.routes)) {
    return el('section', { class: 'cn-sect cn-rt', id: 'cn-routes' },
      el('p', { class: 'v2-desc', style: 'color:var(--warn-text)', text: `${a.label} 연결 상태를 불러오지 못했어요 — 아래 칸에서 직접 확인할 수 있어요.` }));
  }
  const { first, rest } = routeOrder(a);
  const kids: HTMLElement[] = [];
  if (first) kids.push(routeCard(first, a, ctx, true));
  if (rest.length) {
    const more = el('details', { class: 'cn-rt-more' },
      el('summary', { text: `다른 길 ${rest.length}가지` }),
      ...rest.map((r) => routeCard(r, a, ctx, false)));
    kids.push(more);
  }
  if (!kids.length) kids.push(el('p', { class: 'v2-desc', text: `${a.label}에는 지금 연결할 수 있는 길이 없어요.` }));
  return el('section', { class: 'cn-sect cn-rt', id: 'cn-routes' },
    el('div', { class: 'cn-gh' }, el('b', { text: '연결하는 길' }), el('span', { class: 'h', text: '위에서부터 권하는 순서예요' })),
    ...kids);
}

function routeCard(r: RouteIn, a: ConnectAppStatus, ctx: RoutesCtx, primary: boolean): HTMLElement {
  const body = el('div', { class: 'cn-rt-body' });
  const card = el('div', { class: 'cn-rt-card' + (primary ? ' primary' : '') + ' s-' + r.state },
    el('div', { class: 'cn-rt-hd' },
      el('b', { text: ROUTE_NAME[r.kind] }),
      primary ? el('span', { class: 'cn-rt-rec', text: '권하는 길' }) : null,
      el('span', { class: 'cn-rt-st', text: routeStateText(r, a) })),
    el('p', { class: 'cn-rt-bl', text: routeBlurb(r.kind, a.label) }),
    body);
  fillRouteBody(body, r, a, ctx);
  return card;
}

function btn(text: string, onclick: () => void, primary = false): HTMLButtonElement {
  return el('button', { class: 'btn btn-sm ' + (primary ? 'btn-primary' : 'btn-ghost'), type: 'button', text, onclick }) as HTMLButtonElement;
}

function fillRouteBody(body: HTMLElement, r: RouteIn, a: ConnectAppStatus, ctx: RoutesCtx): void {
  const acts = el('div', { class: 'cn-rt-acts' });
  if (r.kind === 'app') {
    if (r.state === 'register' && a.registration) { body.appendChild(registrationPanel(a, a.registration, ctx, true)); return; }
    if (r.state === 'ask_admin' && a.app_ready === false) {
      body.appendChild(adminAsk(a, '라이블리 관리자에게 이 화면 주소를 보내 «앱 등록» 을 부탁해 주세요.'));
      if (a.registration) body.appendChild(el('details', { class: 'cn-rt-more' }, el('summary', { text: '관리자가 할 일 보기' }), registrationPanel(a, a.registration, ctx, false)));
      return;
    }
    if (r.state === 'connect') acts.appendChild(ctx.startAppConnect ? btn('연결', ctx.startAppConnect, true) : btn('아래 «자료 가져오기» 에서 켜기 ↓', ctx.toCollect, true));
    if (r.state === 'set_scope') acts.appendChild(btn('무엇을 모을지 정하기 ↓', ctx.toCollect, true));
    if (r.state === 'collecting') acts.appendChild(btn('모으는 범위 보기 ↓', ctx.toCollect));
    if (r.state === 'ask_admin') body.appendChild(adminAsk(a, '수집을 켜는 건 관리자가 해요. 관리자에게 이 화면 주소를 보내 주세요.'));
  } else if (r.kind === 'ai') {
    if (r.state === 'off') return;
    if (r.needs === 'claude_login') acts.appendChild(btn('Claude 로그인하기', () => openMeModal({ tab: 'aiacct' }), true));
    else if (r.state === 'connect' || r.state === 'reconnect') {
      acts.appendChild(el('a', { class: 'btn btn-sm btn-primary', href: CLAUDE_CONNECTORS_URL, target: '_blank', rel: 'noopener', text: r.state === 'reconnect' ? 'Claude 에서 다시 연결 ↗' : 'Claude 에서 연결 ↗',
        title: 'Claude 웹의 커넥터 설정을 엽니다. 라이블리에 로그인해 둔 그 Claude 계정이어야 해요.' }));
    }
    if (r.needs !== 'claude_login') acts.appendChild(refreshBtn(ctx.reload));
    const who = el('div', { class: 'cn-rt-who' });
    body.append(acts, who);
    if (r.ai_app) void renderAppClaude(who, r.ai_app, { onChanged: ctx.reload });
    return;
  } else {
    if (r.state === 'connect' && ctx.openToken) acts.appendChild(btn('토큰 넣기', ctx.openToken, true));
    if (r.state === 'set_scope') acts.appendChild(btn('무엇을 모을지 정하기 ↓', ctx.toCollect, true));
    if (r.state === 'collecting') acts.appendChild(btn('모으는 범위 보기 ↓', ctx.toCollect));
    if (r.state === 'ask_admin') body.appendChild(adminAsk(a, '수집을 켜는 건 관리자가 해요. 관리자에게 이 화면 주소를 보내 주세요.'));
  }
  if (acts.childNodes.length) body.appendChild(acts);
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

/** 앱 등록 — 누가 · 몇 분 → (공개 주소가 없으면 그것부터) → 걸음(링크 · 붙여 넣을 값) → 넣을 칸 → [등록]. editable=false 면 읽기만(관리자가 할 일 보기). */
function registrationPanel(a: ConnectAppStatus, reg: RegistrationIn, ctx: RoutesCtx, editable: boolean): HTMLElement {
  const wrap = el('div', { class: 'cn-reg' });
  wrap.appendChild(el('p', { class: 'cn-reg-who', text: `만들 것: ${reg.what} · 할 수 있는 사람: ${reg.who} · 약 ${reg.minutes}분` }));
  if (reg.missing.length) wrap.appendChild(addressFirst(ctx));
  const ol = el('ol', { class: 'cn-reg-steps' });
  for (const s of reg.steps) {
    //  번호는 목록이 붙인다(li 는 list-item 그대로) — 칸 배치는 안쪽 상자가 한다. li 를 flex 로 만들면 번호가 사라진다(화면 실측).
    const li = el('div', { class: 'cn-reg-li' }, el('span', { class: 'cn-reg-t', text: s.text }));
    if (s.link) li.appendChild(stepLink(s.link));
    if (s.copy) {
      li.appendChild(s.copy.value
        ? el('div', { class: 'cn-reg-copy' }, el('code', { text: s.copy.value }), btn('복사', () => { void copyText(s.copy!.value!, '복사했어요.'); }))
        : el('div', { class: 'cn-reg-copy none', text: '공개 주소를 넣으면 여기에 붙여 넣을 값이 보여요.' }));
    }
    ol.appendChild(el('li', {}, li));
  }
  wrap.appendChild(ol);
  if (editable) wrap.appendChild(regForm(a, reg, ctx));
  if (reg.notes.length) wrap.appendChild(el('div', { class: 'cn-reg-notes' }, el('b', { text: '알아 둘 것' }), el('ul', {}, ...reg.notes.map((n) => el('li', { text: n })))));
  return wrap;
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
  const save = btn('주소 저장', async () => {
    const v = inp.value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^/\s]+/.test(v)) { toast('https:// 로 시작하는 주소를 넣어 주세요', true); inp.focus(); return; }
    save.disabled = true;
    try {
      await api('/api/ui/org/profile', { method: 'POST', body: JSON.stringify({ gateway_url: v }) });
      toast('공개 주소를 저장했어요.');
      ctx.reload();
    } catch (e: any) { toast((e && e.message) || '저장하지 못했어요', true); save.disabled = false; }
  }, true);
  return el('div', { class: 'cn-reg-addr' },
    el('p', { class: 'cn-reg-t', text: '먼저 이 워크스페이스의 공개 주소를 넣어요 — 외부 앱이 연결을 마치고 돌아올 주소가 여기서 만들어져요. 보통은 지금 브라우저 주소창의 앞부분이에요.' }),
    el('div', { class: 'cn-scope-row' }, inp, save));
}

/** 넣을 칸 + [등록] — 값은 금고로 바로 가고 다시 보이지 않는다. 빠진 칸은 서버에 보내기 전에 말한다. */
function regForm(a: ConnectAppStatus, reg: RegistrationIn, ctx: RoutesCtx): HTMLElement {
  const vals: Record<string, string> = {};
  const rows = reg.fields.map((f) => {
    if (f.file) {
      const name = el('span', { class: 'cn-reg-file-n', text: '아직 고르지 않았어요' });
      const inp = el('input', { type: 'file', accept: '.pem,application/x-pem-file,text/plain', 'aria-label': f.label }) as HTMLInputElement;
      inp.onchange = async () => {
        const file = inp.files && inp.files[0];
        vals[f.key] = '';
        if (!file) { name.textContent = '아직 고르지 않았어요'; return; }
        const text = await file.text().catch(() => '');
        if (!looksLikePrivateKey(text)) { name.textContent = `${file.name} — 키 파일이 아니에요`; toast('Private key 파일(.pem)을 골라 주세요 — [Generate a private key] 로 받은 파일이에요.', true); inp.value = ''; return; }
        vals[f.key] = text;
        name.textContent = `${file.name} — 골랐어요`;
      };
      return el('label', { class: 'cn-reg-f' }, el('span', { class: 'k', text: f.label }), el('span', { class: 'cn-reg-file' }, inp, name));
    }
    const inp = el('input', {
      type: 'text', class: 'cn-scope-in' + (f.secret ? ' secret-input' : ''), placeholder: f.label, 'aria-label': f.label,
      autocomplete: 'off', spellcheck: 'false',
      oninput: (e: any) => { vals[f.key] = String(e.target.value || ''); },
    }) as HTMLInputElement;
    return el('label', { class: 'cn-reg-f' }, el('span', { class: 'k', text: f.label }), inp);
  });
  const go = btn('등록', async () => {
    const v = regValues(reg.fields, vals);
    if (!v.ok) { toast(`«${v.missing}» 을(를) 넣어 주세요`, true); return; }
    go.disabled = true; go.textContent = '등록하는 중…';
    try {
      await api('/api/ui/org/connect/register', { method: 'POST', body: JSON.stringify({ app: a.app, values: v.values }) });
      for (const k of Object.keys(vals)) vals[k] = '';
      toast(`${a.label} 앱을 등록했어요 — 이제 [연결]을 누르면 돼요.`);
      ctx.reload();
    } catch (e: any) {
      toast((e && e.message) || '등록하지 못했어요', true);
      go.disabled = false; go.textContent = '등록';
    }
  }, true);
  return el('div', { class: 'cn-reg-form' },
    el('b', { text: '라이블리에 넣기' }),
    el('span', { class: 'cn-reg-t', text: '여기 넣은 값은 금고로 바로 저장되고 다시 보이지 않아요. 대화에 붙여 넣지 마세요.' }),
    ...rows, el('div', { class: 'cn-rt-acts' }, go));
}
