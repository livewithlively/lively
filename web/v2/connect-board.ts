// v2/connect-board.ts — [외부 앱 연결] 상세의 «Claude 커넥터» 길 칸(#4970 — 종전 #4213 T13 목록 맨 위 «앱 × 구성원» 현황판).
//
//  구성원 Claude 커넥터는 앱마다 있는 여러 길 중 하나다(#4970, 상민님 2026-10-23 — 이미 연결된 길 → 라이블리 앱 → Claude 커넥터 → 토큰 …).
//   그래서 «누가 이 앱을 Claude 로 이어 뒀고 그 길로 어디를 모으나» 는 목록이 아니라 그 앱 상세의 Claude 길 칸에서 답한다.
//   칸 = 구성원(«Claude로 연결됨» · 다시 로그인 필요 …) · 모으는 곳(수집 단위)마다 공개범위 · 모으는 사람 · 마지막으로 읽은 때 · 설명.
//  고치는 것은 둘뿐이다 — 공개범위(나만 · 볼 수 있는 사람만 · 모두)와 모을지(모으기 · 빼기). 설명·메타데이터는 리브가 쓴다(사람 편집 화면 없음, 설계 §3).
//   이 둘은 «수집 전 검토» 자리다(T10 댓글 #451) — 처음 연결 대화에서 리브가 제안한 것을 사람이 여기서 다시 볼 수 있다.
//  판정은 lib/connect-board.ts(순수 — 시험 있음), 말은 lib/claude-connectors.ts(처음 설정·관리 탭과 한 벌).
//  ⚠ 서버가 허락의 정본이다 — 버튼을 보일지는 서버 규칙을 따라 미리 가리지만, 실제 거절(403·404·409)은 서버 말 그대로 보여 준다.
import { api, el, hasScope, loadPeopleAvatars, relTime, state, toast } from '../core.js';
import { confirmDialog } from '../ui-primitives.js';
import { scanErrorText } from '../lib/claude-connectors.js';
import {
  KIND_LABEL, STATE_LABEL, VIS_LABEL, assigneeText, boardPeople, buildBoard, canEditUnit, unitDisplayName, unitReadText, visibilityChoices, widens,
  type Board, type BoardCell, type UnitIn, type Visibility,
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

/** 구성원 한 사람 — 점 + 이름 + 말. 채운 컬러 알약을 쓰지 않는다(디자인 시스템 «점 + 말»). */
function personNode(c: BoardCell, name: string): HTMLElement {
  return el('span', { class: 'cn-bd-cell cn-bd-' + c.state, title: c.scanError ? scanErrorText(c.scanError) : c.label },
    el('span', { class: 'cn-bd-dot', 'aria-hidden': 'true' }), el('b', { text: name }), el('span', { text: ' ' + c.label }));
}

/** Claude 로 이어 둔 상태 — 연결됨 · 다시 로그인 필요 · 실패 · 연결 중 · 모름. «연결 필요» · «확인 전» · «안 씀» 은 사람 목록에 세우지 않는다(소음). */
const LINKED_CELLS: ReadonlySet<BoardCell['state']> = new Set<BoardCell['state']>(['connected', 'needs-auth', 'failed', 'pending', 'unknown']);

/**
 * (#4970) 상세 «Claude 커넥터» 길 칸 — 이 앱을 Claude 로 이어 둔 구성원과, 이 길로 모으는 곳(공개범위 · 모을지).
 *  목록 맨 위에 있던 «앱 × 구성원» 표(T13)를 앱마다 그 앱 상세로 옮겼다(상민님 2026-10-23 — 목록은 앱마다 «어떤 길로 연결됐나»,
 *  구성원 목록은 그 앱의 Claude 길에서). 판정·말은 그대로 lib/connect-board.ts 다.
 *  aiApp 은 커넥터의 앱 키다(구글 = gmail).
 */
export async function renderAppClaude(host: HTMLElement, aiApp: string, opts: { onChanged?: () => void } = {}): Promise<void> {
  const paint = async (): Promise<void> => {
    let d: BoardData;
    try { d = await loadBoard(); }
    catch (e) {
      host.replaceChildren(el('p', { class: 'cn-bd-note', style: 'color:var(--warn-text)', text: `구성원 연결을 불러오지 못했어요 — ${(e as Error)?.message || e}` }));
      return;
    }
    const nameOf = (id: string): string => d.names.get(id) || id;
    const notes: HTMLElement[] = [];
    if (!d.enforced) notes.push(el('p', { class: 'cn-bd-note', text: '이 워크스페이스는 자료 공개범위를 쓰지 않아서, 무엇을 골라도 모은 자료가 모두에게 보여요.' }));
    if (d.errors.length) notes.push(el('p', { class: 'cn-bd-note', style: 'color:var(--warn-text)', text: `${d.errors.join(' · ')} 상태를 불러오지 못했어요 — 아래는 지금 정확하지 않을 수 있어요.` }));
    if (d.myScan && !d.myScan.ok) notes.push(el('p', { class: 'cn-bd-note', text: `내 Claude 앱 마지막 확인: ${scanErrorText(d.myScan.error)}` }));
    const a = d.board.apps.find((x) => x.key === aiApp);
    const people = a ? a.cells.filter((c) => LINKED_CELLS.has(c.state)) : [];
    //  이 길(구성원 Claude 커넥터)로 모으는 곳만 — 라이블리 수집기가 맡은 곳은 아래 «자료 가져오기» 칸의 범위다.
    const units = a ? a.units.list.filter((u) => u.route === 'member_ai') : [];
    const count = (st: string): number => units.filter((u) => u.state === st).length;
    const unitSum = units.length ? [count('active') ? `모으는 중 ${count('active')}` : '', count('candidate') ? `후보 ${count('candidate')}` : '', count('excluded') ? `뺌 ${count('excluded')}` : ''].filter(Boolean).join(' · ') : '';
    host.replaceChildren(
      el('div', { class: 'cn-rt-sub' },
        el('b', { text: 'Claude 로 이어 둔 구성원' }),
        people.length
          ? el('div', { class: 'cn-rt-people' }, ...people.map((c) => personNode(c, c.member === d.me ? `${nameOf(c.member)}(나)` : nameOf(c.member))))
          : el('span', { class: 'cn-bd-note', text: '아직 없어요. Claude 에서 이 앱을 연결하면 여기 보여요.' })),
      el('div', { class: 'cn-rt-sub' },
        el('b', { text: '이 길로 모으는 곳' }),
        unitSum ? el('span', { class: 'cn-bd-note', text: unitSum }) : null,
        units.length
          //  다섯 곳이 넘으면 접어 둔다 — 길 칸에서 먼저 보여야 할 것은 «다음 걸음» 이고, 곳마다의 검토는 펼쳐서 한다.
          ? (units.length > 5
            ? el('details', { class: 'cn-rt-more' }, el('summary', { text: `모으는 곳 ${units.length}곳 보기 · 공개범위와 모을지 정하기` }),
              el('div', { class: 'cn-bd-unitlist' }, ...units.map((u) => unitNode(u, d, nameOf, paint, opts.onChanged))))
            : el('div', { class: 'cn-bd-unitlist' }, ...units.map((u) => unitNode(u, d, nameOf, paint, opts.onChanged))))
          : el('span', { class: 'cn-bd-note', text: '아직 없어요. 연결한 뒤 [연결 도와줘]로 AI 에게 맡기면 모을 곳을 찾아 제안해요.' })),
      //  ⚠ replaceChildren 에 null 을 직접 넘기면 글자 «null» 이 찍힌다(lib/dom.ts replaceKids 머리말) — 있을 때만 펼친다.
      ...(d.hidden ? [el('p', { class: 'cn-bd-note', text: `다른 구성원만 볼 수 있는 곳 ${d.hidden}곳은 이름을 보여 드리지 않아요.` })] : []),
      ...notes);
  };
  host.replaceChildren(el('p', { class: 'cn-bd-note', text: '구성원 연결을 불러오는 중이에요…' }));
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
  const read = unitReadText(u, relTime);
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
