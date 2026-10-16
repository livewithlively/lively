// v2/connect-board.ts — [외부 앱 연결] 맨 위의 «앱 × 구성원» 현황판(#4213 T13, 상민님 2026-10-15 To-Be §7).
//
//  기본 연결은 각 구성원의 Claude 커넥터다(T9). 그래서 이 화면이 가장 먼저 답할 물음은 «누가 어떤 앱을 Claude 로 연결했고,
//   그 앱에서 어디를 모으고 있나» 다. 줄 = 앱, 칸 = 구성원(«Claude로 연결됨» · 다시 로그인 필요 · «○○님 연결 필요» …),
//   줄 끝 = 연결 경로(Claude 커넥터 · 라이블리 수집기 · 리브가 연결함)와 모으는 곳(수집 단위) 수. 줄을 펼치면 단위마다
//   공개범위 · 모으는 사람 · 마지막으로 읽은 때 · 설명이 보인다.
//  고치는 것은 둘뿐이다 — 공개범위(나만 · 볼 수 있는 사람만 · 모두)와 모을지(모으기 · 빼기). 설명·메타데이터는 리브가 쓴다(사람 편집 화면 없음, 설계 §3).
//   이 둘은 «수집 전 검토» 자리다(T10 댓글 #451) — 처음 연결 대화에서 리브가 제안한 것을 사람이 여기서 다시 볼 수 있다.
//  판정은 lib/connect-board.ts(순수 — 시험 있음), 말은 lib/claude-connectors.ts(처음 설정·관리 탭과 한 벌).
//  ⚠ 서버가 허락의 정본이다 — 버튼을 보일지는 서버 규칙을 따라 미리 가리지만, 실제 거절(403·404·409)은 서버 말 그대로 보여 준다.
import { api, el, hasScope, loadPeopleAvatars, personFace, relTime, state, toast } from '../core.js';
import { confirmDialog } from '../ui-primitives.js';
import { svcTile, presetSvcKey } from '../svc-icons.js';
import { CLAUDE_CONNECTORS_URL, scanErrorText } from '../lib/claude-connectors.js';
import {
  KIND_LABEL, STATE_LABEL, VIS_LABEL, assigneeText, boardPeople, buildBoard, canEditUnit, routeText, unitDisplayName, unitSummaryText, visibilityChoices, widens,
  type Board, type BoardApp, type BoardCell, type UnitIn, type Visibility,
} from '../lib/connect-board.js';

interface BoardData {
  board: Board;
  hidden: number;
  enforced: boolean;
  me: string;
  isAdmin: boolean;
  names: Map<string, string>;
  myScan: { ok: boolean; error: string | null; scanned_at?: string | null } | null;
  errors: string[];
}

async function loadBoard(): Promise<BoardData> {
  //  ⚠ 보는 사람은 state.me.userId 다(/api/ui/me 의 키 — member_id 가 아니다. 매니지드 실측 2026-10-17).
  const me = String((state.me && (state.me as { userId?: string }).userId) || '');
  const isAdmin = hasScope('admin');
  const errors: string[] = [];
  //  따로 읽는다 — 하나가 실패해도 나머지로 그린다(못 읽은 것은 머리에 한 줄로 밝힌다 — 거짓 «안 씀» 을 만들지 않게).
  const [avatars, roster, conn, units, cols] = await Promise.all([
    loadPeopleAvatars().catch(() => ({})),
    api('/api/ui/org/members').then((r: any) => (Array.isArray(r?.members) ? r.members : null)).catch(() => { errors.push('구성원 명부'); return null; }),
    api('/api/ui/member-ai-connectors').catch(() => { errors.push('구성원 Claude 커넥터'); return null; }),
    api('/api/ui/collect/units').catch(() => { errors.push('수집 단위'); return null; }),
    api('/api/ui/org/collectors').catch(() => { errors.push('라이블리 수집기'); return null; }),
  ]);
  const av = (avatars || {}) as Record<string, any>;
  const members = boardPeople(roster, (conn?.members || []).map((m: any) => String(m.member_id)), me,
    (id) => (av[id] && av[id].display_name ? String(av[id].display_name) : null));
  const names = new Map<string, string>(members.map((m) => [m.id, m.name]));
  //  모으는 사람이 열 밖의 사람이어도(예: 나간 사람) 이름은 아바타 명부에서 찾는다.
  for (const [id, m] of Object.entries(av)) if (!names.has(id)) names.set(id, String((m && m.display_name) || id));
  const policy = (conn?.policy?.state as Board['policy']) || 'unknown';
  const connectorMembers = (conn?.members || []).map((m: any) => ({
    member_id: String(m.member_id), scan: m.scan || null,
    connectors: (m.connectors || []).map((c: any) => ({ app: String(c.app), status: String(c.status) })),
  }));
  const board = buildBoard({
    me, isAdmin, members, policy, connectorMembers,
    units: ((units?.units || []) as UnitIn[]),
    collectors: ((cols?.collectors || []) as Array<{ preset_key: string; enabled: boolean; label?: string }>),
  });
  const mine = connectorMembers.find((m: { member_id: string }) => m.member_id === me) || null;
  return { board, hidden: Number(units?.hidden || 0), enforced: units ? units.visibility_enforced !== false : true, me, isAdmin, names, myScan: mine ? mine.scan : null, errors };
}

/** 칸 하나 — 점 + 말. 채운 컬러 알약을 쓰지 않는다(디자인 시스템 «점 + 말»). */
function cellNode(c: BoardCell): HTMLElement {
  return el('td', { class: 'cn-bd-cell cn-bd-' + c.state, title: c.scanError ? scanErrorText(c.scanError) : c.label },
    c.state === 'off' || c.state === 'blocked' ? null : el('span', { class: 'cn-bd-dot', 'aria-hidden': 'true' }),
    el('span', { text: c.label }));
}

/** 연결 경로 — 이 앱이 어떤 길로 이어져 있나(말은 lib routeText — 시험 있음). */
function routeLine(a: BoardApp): HTMLElement {
  return el('div', { class: 'cn-bd-route', text: routeText(a) });
}


export async function renderConnectBoard(host: HTMLElement, opts: { onChanged?: () => void } = {}): Promise<void> {
  const open = new Set<string>();     // 펼친 앱 줄 — 다시 그려도 펼친 채로
  let last: BoardData | null = null;  // 마지막으로 읽은 값 — 펼치기·접기는 이것으로 다시 그린다(서버를 다시 읽지 않는다)
  const paint = async (reload = true): Promise<void> => {
    let d: BoardData;
    try { d = reload || !last ? await loadBoard() : last; last = d; }
    catch (e) {
      host.replaceChildren(el('p', { class: 'v2-desc', style: 'color:var(--warn-text)', text: `현황판을 불러오지 못했어요 — ${(e as Error)?.message || e}` }));
      return;
    }
    const nameOf = (id: string): string => d.names.get(id) || id;
    const refreshBtn = el('button', {
      class: 'btn btn-ghost btn-sm', type: 'button', text: '내 Claude 앱 새로 확인',
      onclick: async () => {
        refreshBtn.disabled = true; refreshBtn.textContent = '확인하는 중…';
        try {
          const r: any = await api('/api/ui/me/ai-connectors/refresh', { method: 'POST', body: '{}' });
          if (r?.skipped === 'policy-off') toast('이 워크스페이스는 구성원 Claude 커넥터를 쓰지 않아요(관리자 설정).');
          else if (r?.skipped === 'recent') toast('방금 확인한 값이에요. 잠시 뒤 다시 눌러 주세요.');
          else if (r?.record?.scan && !r.record.scan.ok) toast(scanErrorText(r.record.scan.error));
          else toast('새로 확인했어요.');
        } catch (e) { toast(`확인하지 못했어요 — ${(e as Error)?.message || e}`); }
        await paint();
      },
    }) as HTMLButtonElement;
    const tools = el('div', { class: 'cn-bd-tools' },
      el('a', { class: 'btn btn-ghost btn-sm', href: CLAUDE_CONNECTORS_URL, target: '_blank', rel: 'noopener', text: 'Claude에서 연결 ↗',
        title: 'Claude 웹의 커넥터 설정을 엽니다. 처음 설정에서 로그인한 그 Claude 계정이어야 해요.' }),
      d.board.policy === 'blocked' ? null : refreshBtn);

    const notes: HTMLElement[] = [];
    if (d.board.policy === 'blocked') notes.push(el('p', { class: 'cn-bd-note', text: '이 워크스페이스는 관리자 설정으로 구성원 Claude 커넥터를 쓰지 않아요. 앱 자료는 아래 «라이블리로 직접 연결» 로 가져옵니다.' }));
    if (d.board.policy === 'unknown' && !d.errors.length) notes.push(el('p', { class: 'cn-bd-note', text: '구성원 Claude 커넥터 정책을 읽지 못했어요 — 그동안은 쓰지 않는 것으로 봅니다.' }));
    if (!d.enforced) notes.push(el('p', { class: 'cn-bd-note', text: '이 워크스페이스는 자료 공개범위를 쓰지 않아서, 무엇을 골라도 모은 자료가 모두에게 보여요.' }));
    if (d.errors.length) notes.push(el('p', { class: 'cn-bd-note', style: 'color:var(--warn-text)', text: `${d.errors.join(' · ')} 상태를 불러오지 못했어요 — 그 칸은 지금 정확하지 않을 수 있어요.` }));
    if (d.myScan && !d.myScan.ok) notes.push(el('p', { class: 'cn-bd-note', text: `내 Claude 앱 마지막 확인: ${scanErrorText(d.myScan.error)}` }));

    if (!d.board.apps.length) {
      host.replaceChildren(el('section', { class: 'cn-group cn-board' },
        el('div', { class: 'cn-gh' }, el('b', { text: '앱 × 구성원' }), el('span', { class: 'h', text: '누가 어떤 앱을 Claude 로 연결했는지, 어디를 모으는지 보여 줘요' })),
        tools, ...notes,
        el('p', { class: 'v2-empty', text: '아직 연결된 앱이 없어요. Claude 에서 Slack·Notion·Gmail 같은 앱을 연결하면 리브가 그 앱에서 일 자료를 모아요.' })));
      return;
    }

    const cols = d.board.members.length + 2;
    const head = el('tr', {},
      el('th', { class: 'cn-bd-app', scope: 'col', text: '앱' }),
      ...d.board.members.map((m) => el('th', { class: 'cn-bd-mem', scope: 'col', title: m.name },
        personFace(m.id, 'cn-bd-face', m.name), el('span', { class: 'cn-bd-mname', text: m.id === d.me ? `${m.name}(나)` : m.name }))),
      el('th', { class: 'cn-bd-units', scope: 'col', text: '모으는 곳' }));
    const body: HTMLElement[] = [];
    for (const a of d.board.apps) {
      const isOpen = open.has(a.key);
      const hasUnits = a.units.list.length > 0;
      const toggle = hasUnits ? el('button', {
        class: 'btn-text cn-bd-more', type: 'button', 'aria-expanded': String(isOpen),
        text: isOpen ? '접기 ▴' : '자세히 ▾',
        onclick: () => { if (open.has(a.key)) open.delete(a.key); else open.add(a.key); void paint(false); },
      }) : null;
      body.push(el('tr', { class: 'cn-bd-row' },
        el('th', { class: 'cn-bd-app', scope: 'row' },
          el('div', { class: 'cn-bd-appname' }, svcTile(presetSvcKey(a.key), a.label, a.claudeMembers > 0 || a.collector || a.livDirect), el('b', { text: a.label })),
          routeLine(a)),
        ...a.cells.map(cellNode),
        el('td', { class: 'cn-bd-units' }, el('span', { text: unitSummaryText(a) }), toggle)));
      if (isOpen && hasUnits) {
        body.push(el('tr', { class: 'cn-bd-detail' },
          el('td', { colspan: String(cols) }, el('div', { class: 'cn-bd-unitlist' },
            ...a.units.list.map((u) => unitNode(u, d, nameOf, paint, opts.onChanged))))));
      }
    }
    const table = el('table', { class: 'cn-bd-tbl' }, el('thead', {}, head), el('tbody', {}, ...body));
    host.replaceChildren(el('section', { class: 'cn-group cn-board' },
      el('div', { class: 'cn-gh' }, el('b', { text: '앱 × 구성원' }), el('span', { class: 'h', text: '누가 어떤 앱을 Claude 로 연결했는지, 어디를 모으는지 보여 줘요' })),
      tools, ...notes,
      el('div', { class: 'cn-bd-scroll' }, table),
      d.hidden ? el('p', { class: 'cn-bd-note', text: `다른 구성원만 볼 수 있는 곳 ${d.hidden}곳은 이름을 보여 드리지 않아요.` }) : null));
  };
  host.replaceChildren(el('p', { class: 'v2-desc', text: '앱 × 구성원 현황을 불러오는 중이에요…' }));
  await paint();
}

/** 단위 한 줄 — 이름 · 종류 · 상태 · 공개범위(고를 수 있으면 고르는 칸) · 모으는 사람 · 마지막으로 읽은 때 · 설명. */
function unitNode(u: UnitIn, d: BoardData, nameOf: (id: string) => string, repaint: () => Promise<void>, onChanged?: () => void): HTMLElement {
  const full = u.access === 'full';
  const name = unitDisplayName(u);
  const editable = canEditUnit(u, d.me, d.isAdmin);
  const choices = visibilityChoices(u, d.me, d.isAdmin);
  const visNode = editable && choices.length > 1
    ? el('select', {
      class: 'cn-bd-vis', 'aria-label': `${name} 공개범위`,
      onchange: (e: Event) => { void setVisibility(u, (e.target as HTMLSelectElement).value as Visibility, repaint, onChanged); },
    }, ...choices.map((v) => el('option', { value: v, text: VIS_LABEL[v], ...(v === u.visibility ? { selected: 'selected' } : {}) })))
    : el('span', { text: VIS_LABEL[u.visibility] });
  const read = u.read_at ? `${relTime(u.read_at)} 읽음` : (u.state === 'active' ? '아직 안 읽음' : '');
  const acts: HTMLElement[] = [];
  if (editable) {
    if (u.state !== 'active') acts.push(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: u.state === 'excluded' ? '다시 모으기' : '모으기',
      onclick: () => void setState(u, 'active', repaint, onChanged) }));
    if (u.state !== 'excluded') acts.push(el('button', { class: 'btn-text', type: 'button', text: '빼기',
      onclick: () => void setState(u, 'excluded', repaint, onChanged) }));
  }
  return el('div', { class: 'cn-bd-unit cn-bd-u-' + u.state },
    el('div', { class: 'cn-bd-uhd' },
      el('b', { text: name }),
      el('span', { class: 'cn-bd-ukind', text: KIND_LABEL[u.kind] || u.kind }),
      el('span', { class: 'cn-bd-ust', text: STATE_LABEL[u.state] })),
    el('div', { class: 'cn-bd-umeta' },
      el('span', { class: 'cn-bd-ulab', text: '공개범위' }), visNode,
      el('span', { class: 'cn-bd-ulab', text: '모으는 사람' }), el('span', { text: assigneeText(u, nameOf) }),
      read ? el('span', { class: 'cn-bd-uread', text: read }) : null),
    full && u.description ? el('p', { class: 'cn-bd-udesc', text: u.description }) : null,
    acts.length ? el('div', { class: 'cn-bd-uact' }, ...acts) : null);
}

async function setVisibility(u: UnitIn, next: Visibility, repaint: () => Promise<void>, onChanged?: () => void): Promise<void> {
  if (next === u.visibility) return;
  const send = (confirm: boolean) => api(`/api/ui/collect/units/${u.id}`, { method: 'POST', body: JSON.stringify(confirm ? { visibility: next, confirm: true } : { visibility: next }) });
  try {
    try { await send(false); }
    catch (e: any) {
      //  넓히기에 이미 모은 자료가 있으면 서버가 건수와 함께 확인을 요구한다(409) — 사람에게 몇 건이 누구에게 열리는지 말하고 받는다.
      if (e?.status !== 409 || !widens(u.visibility, next)) throw e;
      const n = Number(/자료 (\d+)건/.exec(String(e.message || ''))?.[1] || 0);
      const ok = await confirmDialog({
        title: '이미 모은 자료가 더 넓게 열려요',
        message: `«${unitDisplayName(u)}» 에서 이미 모은 자료${n ? ` ${n}건` : ''}이 «${VIS_LABEL[next]}» 에게 보이게 됩니다.`,
        note: '되돌리려면 공개범위를 다시 좁히면 돼요. 다만 이미 정리된 지식은 따라 좁혀지지 않아요.',
        confirmText: '넓히기',
      });
      if (!ok) { await repaint(); return; }
      await send(true);
    }
    toast(`공개범위를 «${VIS_LABEL[next]}» 으로 바꿨어요.${widens(next, u.visibility) ? ' 이미 정리된 지식은 따라 좁혀지지 않아요.' : ''}`);
    onChanged?.();
  } catch (e) {
    toast(`바꾸지 못했어요 — ${(e as Error)?.message || e}`);
  }
  await repaint();
}

async function setState(u: UnitIn, next: 'active' | 'excluded', repaint: () => Promise<void>, onChanged?: () => void): Promise<void> {
  try {
    await api(`/api/ui/collect/units/${u.id}`, { method: 'POST', body: JSON.stringify({ state: next }) });
    toast(next === 'active' ? '모으기로 했어요. 다음 수집에서 읽어요.' : '이곳은 이제 모으지 않아요.');
    onChanged?.();
  } catch (e) {
    toast(`바꾸지 못했어요 — ${(e as Error)?.message || e}`);
  }
  await repaint();
}
