// v2/ws-people.ts — 워크스페이스 **구성원 · 초대**(#1875). 좌상단 스위처 메뉴 안에 산다.
//
// 왜 여기인가: 스위처는 이미 "여기가 어느 집인가"를 말하는 자리다(#1719 문패). 누가 이 집에 사는지와
//  누구를 부를지는 같은 질문의 뒷면이라 같은 자리에 있어야 한다 — 설정 어딘가로 보내면, 사람을 부르는
//  일이 '관리 업무'가 되어 실제로는 아무도 부르지 않는다(종전: 초대 화면이 매니지드 관리페이지에만
//  있었고 셀프호스트에는 초대라는 동작 자체가 없었다).
//
// ★ 이 화면의 명제 하나: **개인이냐 팀이냐는 지금 명부에 몇 명인가**다. 그래서 배지·문구가 전부
//  member_count 에서 나오고, 서버도 같은 값으로 판정한다(kind_effective). 어디에도 "팀으로 바꾸기"
//  버튼이 없는 이유 — 사람이 들어오는 것이 곧 전환이다.
import { api, el, personName, profileAvatar, state, toast } from '../core.js';
import { confirmDialog, copyButton, skeletonRows } from '../ui-primitives.js';
import { ctxMenu } from './panes-kit.js';   // ⋯ 메뉴 — 곁칸·프로젝트 행과 같은 부품

export interface PeopleData {
  workspace: { slug: string; name: string; kind_effective: 'personal' | 'team'; member_count: number | null };
  member_count: number;
  kind_effective: 'personal' | 'team';
  can_invite: boolean;
  members: Array<{ member_id: string; role: string; email: string | null; display_name: string | null; is_creator: boolean }>;
  pending: Array<{ id: string; email: string; role: string; invited_by: string; created_at: string }>;
  candidates: Array<{ id: string; email: string; display_name: string | null }>;
}

const who = (m: PeopleData['members'][number]): string => personName(m as never) || m.member_id;

/**
 * 개인 워크스페이스의 **첫 초대**만 한 번 확인받는다. 되돌리기 어려운 전환이라서인데,
 *  겁주는 경고가 아니라 **실제로 달라지는 것만** 적는다([[ui-destructive-confirm-state-what-is-actually-lost-1582]]).
 *  두 번째 이후(이미 팀)에는 묻지 않는다 — 매번 물으면 확인이 아니라 잡음이 된다.
 */
function confirmBecomesTeam(wsName: string, email: string): boolean {
  return confirm(
    `'${wsName}' 은 지금 혼자 쓰는 개인 워크스페이스예요.\n\n` +
    `${email} 님이 수락하면:\n` +
    `· 이 워크스페이스는 팀이 됩니다.\n` +
    `· 여기 있는 자료·프로젝트를 그분도 보게 됩니다.\n` +
    `· 보내는 것만으로는 아직 아무것도 바뀌지 않아요 — 수락해야 들어옵니다.\n\n` +
    `초대를 보낼까요?`);
}

/** 구성원 섹션 한 덩어리. 호출자(스위처)가 메뉴에 끼워 넣고, 갱신은 이 안에서 스스로 한다. */
export function peopleSection(slug: string, onChanged?: () => void): HTMLElement {
  const wrap = el('div', { class: 'v2-ws-people' },
    el('div', { class: 'v2-ws-sec', text: '구성원' }),
    el('p', { class: 'v2-ws-loading', text: '불러오는 중…' })) as HTMLElement;
  void refresh(wrap, slug, onChanged);
  return wrap;
}

async function refresh(wrap: HTMLElement, slug: string, onChanged?: () => void): Promise<void> {
  let d: PeopleData;
  try {
    d = await api('/api/ui/me/workspaces/people?slug=' + encodeURIComponent(slug)) as PeopleData;
  } catch (e: any) {
    // primary·비구성원은 여기 올 수 있다 — 사유를 그대로 보여 준다(빈 칸보다 낫다).
    wrap.replaceChildren(el('div', { class: 'v2-ws-sec', text: '구성원' }),
      el('p', { class: 'v2-ws-empty', text: e?.message || '구성원을 불러오지 못했어요.' }));
    return;
  }
  const again = () => { void refresh(wrap, slug, onChanged); onChanged?.(); };
  const n = d.member_count;
  const kids: (HTMLElement | null)[] = [
    el('div', { class: 'v2-ws-sec', text: d.kind_effective === 'team' ? `구성원 ${n}명` : '구성원 · 나만' }),
  ];

  for (const m of d.members) kids.push(memberRow(d, m, slug, again));

  for (const p of d.pending) {
    kids.push(el('div', { class: 'v2-ws-person pending' },
      el('span', { class: 'v2-ws-person-face waiting', 'aria-hidden': 'true', text: '…' }),
      el('span', { class: 'v2-ws-person-tt' },
        el('b', { text: p.email }),
        el('span', { text: '수락 대기' })),
      el('button', {
        class: 'v2-ws-del', type: 'button', title: '초대 취소', text: '✕',
        onclick: async () => {
          if (!confirm(`${p.email} 님에게 보낸 초대를 취소할까요?`)) return;
          try {
            await api('/api/ui/me/workspaces/invite/resolve', { method: 'POST', body: JSON.stringify({ invite_id: p.id, decision: 'revoke' }) });
            toast('초대를 취소했어요.'); again();
          } catch (e: any) { toast('취소하지 못했어요 — ' + (e?.message || e), true); }
        },
      })));
  }

  if (d.can_invite) kids.push(inviteForm(d, slug, again));
  else kids.push(el('p', { class: 'v2-ws-hint', text: '사람을 부르는 건 이 워크스페이스를 만든 사람이 합니다.' }));

  wrap.replaceChildren(...kids.filter(Boolean) as HTMLElement[]);
}

function memberRow(d: PeopleData, m: PeopleData['members'][number], slug: string, again: () => void): HTMLElement {
  const meId = String((state.me as any)?.userId || '');
  const isMe = m.member_id === meId;
  // 만든 사람은 뺄 수 없다(서버도 막는다) — 뺄 수 없는 것에 ✕ 를 그려 놓고 눌렀을 때 오류를 내지 않는다.
  const canRemove = d.can_invite && !m.is_creator && !isMe;
  return el('div', { class: 'v2-ws-person' },
    el('span', { class: 'v2-ws-person-face', 'aria-hidden': 'true', text: (who(m).trim()[0] || '?').toUpperCase() }),
    el('span', { class: 'v2-ws-person-tt' },
      el('b', { text: who(m) + (isMe ? ' (나)' : '') }),
      el('span', { text: m.is_creator ? '만든 사람' : m.role === 'owner' ? '공동 owner' : m.email || '구성원' })),
    canRemove ? el('button', {
      class: 'v2-ws-del', type: 'button', title: '이 워크스페이스에서 빼기', text: '✕',
      onclick: async () => {
        if (!confirm(`${who(m)} 님을 '${d.workspace.name}' 에서 뺄까요? 그분이 만든 자료는 남습니다.`)) return;
        try {
          await api('/api/ui/me/workspaces/members/remove', { method: 'POST', body: JSON.stringify({ slug, member_id: m.member_id }) });
          toast(`${who(m)} 님을 뺐어요.`); again();
        } catch (e: any) { toast('빼지 못했어요 — ' + (e?.message || e), true); }
      },
    }) : null);
}

function inviteForm(d: PeopleData, slug: string, again: () => void): HTMLElement {
  const input = el('input', {
    class: 'v2-ws-in', type: 'email', placeholder: '부를 사람의 이메일', 'aria-label': '초대할 이메일',
    autocomplete: 'off', list: 'v2-ws-cand',
  }) as HTMLInputElement;
  // 이 박스에 이미 있는 사람은 골라 넣게 — 이메일을 외워 치게 만들지 않는다.
  const list = el('datalist', { id: 'v2-ws-cand' },
    ...d.candidates.map((c) => el('option', { value: c.email, label: c.display_name || c.email }))) as HTMLElement;
  const note = el('span', { class: 'v2-ws-note' });

  const send = async () => {
    const email = input.value.trim().toLowerCase();
    if (!email) { note.textContent = '이메일을 입력하세요.'; return; }
    // 개인 → 팀은 되돌리기 어렵다. 첫 초대에서만 한 번 확인한다.
    if (d.kind_effective === 'personal' && !confirmBecomesTeam(d.workspace.name, email)) return;
    go.setAttribute('disabled', ''); note.textContent = '보내는 중…';
    try {
      const r: any = await api('/api/ui/me/workspaces/invite', { method: 'POST', body: JSON.stringify({ slug, email }) });
      input.value = '';
      //  #2188 매니지드 — 계정 서버는 메일을 보내지 않는다. 링크가 오면 그것이 초대이므로 **링크를 준다**
      //   ("보냈어요" 라고 말하면 거짓이고, 사람은 아무도 안 오는 이유를 영영 모른다).
      if (r?.invite?.url) {
        note.replaceChildren(
          el('span', { text: `${email} 님의 초대 링크예요 — 전해 주세요: ` }),
          el('a', { href: String(r.invite.url), target: '_blank', rel: 'noopener', text: String(r.invite.url) }));
        toast('초대 링크를 만들었어요 — 아래 링크를 전해 주세요.');
      } else {
        toast(r?.known_member
          ? `${email} 님에게 초대를 보냈어요. 그분 화면에 수락 요청이 뜹니다.`
          : `${email} 님을 불러 뒀어요. 그분이 이 워크스페이스에 로그인하면 수락 요청이 뜹니다.`);
      }
      again();
    } catch (e: any) { note.textContent = e?.message || String(e); }
    finally { go.removeAttribute('disabled'); }
  };
  const go = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '초대', onclick: () => void send() }) as HTMLButtonElement;
  input.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); void send(); } });

  return el('div', { class: 'v2-ws-invite' },
    list, input,
    el('div', { class: 'v2-ws-formrow' }, go, note),
    el('p', { class: 'v2-ws-hint', text: d.kind_effective === 'personal'
      ? '수락하면 이 워크스페이스는 팀이 됩니다. 보내는 것만으로는 아직 아무것도 바뀌지 않아요.'
      : '보낸 뒤에도 상대가 수락해야 구성원이 됩니다.' }));
}

// ── 나에게 온 초대 ──────────────────────────────────────────────────────────
//
// 받는 사람 쪽 화면이 없으면 초대는 반쪽이다(보낸 사람만 뭔가를 한 것으로 끝난다).
//  workspace_registry_status 가 내 이메일로 훑어 주므로, 지금 어느 워크스페이스에 있든 여기에 뜬다.

export interface InviteForMe {
  id: string; workspace_slug: string; workspace_name: string; role: string; invited_by: string; created_at: string;
}

export function inboxSection(invites: InviteForMe[], onResolved: (accepted: { slug: string; becameTeam: boolean } | null) => void): HTMLElement | null {
  if (!invites.length) return null;
  return el('div', { class: 'v2-ws-inbox' },
    el('div', { class: 'v2-ws-sec', text: `나에게 온 초대 ${invites.length}` }),
    ...invites.map((i) => inviteRow(i, onResolved)));
}

function inviteRow(i: InviteForMe, onResolved: (r: { slug: string; becameTeam: boolean } | null) => void): HTMLElement {
  const act = async (decision: 'accept' | 'decline') => {
    try {
      const r: any = await api('/api/ui/me/workspaces/invite/resolve', { method: 'POST', body: JSON.stringify({ invite_id: i.id, decision }) });
      if (decision === 'decline') { toast('초대를 거절했어요. 내 워크스페이스는 그대로예요.'); onResolved(null); return; }
      toast(r?.became_team
        ? `'${r.workspace_name || i.workspace_name}' 에 들어왔어요 — 이제 팀 워크스페이스예요.`
        : `'${r.workspace_name || i.workspace_name}' 에 들어왔어요.`);
      onResolved({ slug: String(r?.workspace || i.workspace_slug), becameTeam: !!r?.became_team });
    } catch (e: any) { toast('처리하지 못했어요 — ' + (e?.message || e), true); }
  };
  return el('div', { class: 'v2-ws-invite-row' },
    el('div', { class: 'v2-ws-invite-main' },
      el('b', { text: i.workspace_name }),
      el('span', { text: '초대받았어요' })),
    el('div', { class: 'v2-ws-invite-acts' },
      el('button', { class: 'btn btn-primary btn-xs', type: 'button', text: '들어가기', onclick: () => void act('accept') }),
      el('button', { class: 'btn btn-ghost btn-xs', type: 'button', text: '거절', onclick: () => void act('decline') })));
}


// ── #1875 구성원 모달 — 각 워크스페이스 문패 오른쪽 「사람 추가」 아이콘이 연다(원준 2026-08-26). ─────
//  종전엔 워크스페이스 목록 드롭다운에 「구성원」이 한 줄을 차지했는데, "어디서 추가하는지 느낌이 안 온다"는
//  지적이 있었다 — 초대는 **그 워크스페이스에 딸린 행동**이라 목록의 형제 항목이 아니라 그 행의 조작이어야 한다.
//  슬랙의 'Invite people to …' 모달을 참고하되(이메일 여러 명·명부·권한) 우리 모델(이메일→앱 내 수락)에 맞춘다.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 콤마·공백·줄바꿈으로 나눈 이메일들(슬랙처럼 여러 명). 빈 것·중복 제거. */
function parseEmails(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw.split(/[\s,;]+/)) { const e = t.trim().toLowerCase(); if (e && !seen.has(e)) { seen.add(e); out.push(e); } }
  return out;
}

// ── 구성원 모달 (#1875) — 슬랙 「사람 초대」 문법. 문패 오른쪽 「사람 추가」 아이콘이 연다. ──────────
//
// 한 창에서 끝난다: 부르기(이메일 여러 명) · 명부 · 권한 · 수락 대기. **설정으로 보내지 않는다**(원준 2026-08-26
//  "그 모달에서 하고 설정으로 보내지 말자"). primary(박스의 팀 워크스페이스)도 같은 창이다 — 거긴 명부 대신
//  박스 계정이 곧 구성원이라, 이메일을 넣으면 **계정이 만들어지고 임시 비밀번호가 이 창에서 바로** 나온다
//  (서버 org_member_upsert 가 새 사람에게 한 번만 돌려주는 initialPassword). 셀프호스트 박스는 메일을 못
//  보내므로 그 비밀번호를 사람이 직접 전한다 — 그래서 '보냈어요'가 아니라 '만들었어요 · 전해 주세요'다.
//
// 창의 뼈대는 [나] 창(me-modal, #1843)과 같은 문법 — 머리(얼굴·제목·부제·✕) + 스크롤 몸통. 관리 계열의
//  overlay()(「닫기」 글자 단추)를 쓰지 않는 이유: 새 셸의 창은 전부 이 문법이라, 섞이면 두 시대가 한 화면에 선다.

export interface MemberModalOpts {
  /** primary(박스 팀) — 명부 대신 박스 계정. 초대 = 계정 생성. */
  primary?: boolean;
  /** 머리에 앉힐 워크스페이스 얼굴(rail 이 workspaceFace 로 만들어 준다 — 여기서 switcher 를 부르면 순환). */
  face?: HTMLElement | null;
}

type Role = 'creator' | 'owner' | 'admin' | 'member';
interface Person {
  id: string; name: string; email: string | null; role: Role;
  avatar?: string | null; avatar_char?: string | null; avatar_color?: string | null;
  scopes?: string[];
}
interface View {
  wsName: string; kind: 'personal' | 'team'; count: number; canManage: boolean;
  people: Person[]; pending: PeopleData['pending']; candidates: PeopleData['candidates'];
}
/**
 * 방금 만든 계정의 임시 비밀번호, 또는 방금 만든 **초대 링크** — 창을 닫으면 사라진다(서버가 다시 주지 않는다).
 *
 * #2188 — 매니지드에서 초대는 **링크**다. 계정 서버(app.lvly.io)가 메일을 보내지 않으므로, 화면이
 *  "보냈어요" 라고 말하면 그건 거짓이고 사람은 아무도 안 오는 이유를 영영 모른다. 그래서 **줄 것을 준다.**
 */
interface Issued { title: string; email: string; password?: string; inviteUrl?: string; note?: string }

const ROLE_LABEL: Record<Role, string> = { creator: '만든 사람', owner: '공동 관리자', admin: '관리자', member: '구성원' };

function svg(paths: string[], cls: string): SVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', cls); s.setAttribute('aria-hidden', 'true');
  for (const d of paths) { const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60); if (h < 24) return `${h}시간 전`;
  const d = Math.round(h / 24); return d < 30 ? `${d}일 전` : `${Math.round(d / 30)}달 전`;
}

/** 구성원 모달을 연다. slug = 대상 워크스페이스, wsName = 표시 이름. */
export function openMemberModal(slug: string, wsName: string, opts: MemberModalOpts = {}): void {
  const primary = !!opts.primary;
  const issued: Issued[] = [];

  const sub = el('div', { class: 'v2mem-h-sub', text: '불러오는 중…' });
  const close = (): void => { back.remove(); document.removeEventListener('keydown', onKey, true); };
  // Esc — 위에 확인창(.ov-back)이나 ⋯ 메뉴(.pn-ctx)가 떠 있으면 그쪽이 먼저 먹는다.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || document.querySelector('.ov-back, .pn-ctx')) return;
    e.stopPropagation(); close();
  };
  const head = el('header', { class: 'v2mem-h' },
    opts.face ? el('span', { class: 'v2mem-h-facewrap' }, opts.face) : null,
    el('div', { class: 'v2mem-h-txt' }, el('h2', { class: 'v2mem-h-title', text: `${wsName}에 사람 초대` }), sub),
    el('button', { class: 'v2mem-x', type: 'button', 'aria-label': '닫기', title: '닫기 (Esc)', onclick: close },
      svg(['M6 6l12 12', 'M18 6 6 18'], 'v2mem-x-ic')));
  const body = el('div', { class: 'v2mem-b' }, skeletonRows(3)) as HTMLElement;
  const box = el('div', { class: 'v2mem', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${wsName} 구성원` }, head, body);
  const back = el('div', { class: 'v2mem-back' }, box) as HTMLElement;
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);

  const paint = async (): Promise<void> => {
    let v: View;
    try { v = primary ? await loadBoxView(wsName) : await loadWsView(slug, wsName); }
    catch (e: any) { body.replaceChildren(el('p', { class: 'v2mem-err', text: e?.message || '구성원을 불러오지 못했어요.' })); return; }
    sub.textContent = v.kind === 'personal' ? '개인 워크스페이스 · 지금은 나만 봐요' : `팀 워크스페이스 · 구성원 ${v.count}명`;
    const again = (): void => { void paint(); document.dispatchEvent(new CustomEvent('lively:ws-people-changed')); };
    const meId = String((state.me as any)?.userId || '');
    const kids: (HTMLElement | null)[] = [];

    for (const i of issued) kids.push(issuedCard(i));
    if (v.canManage) kids.push(inviteBlock(v, slug, primary, (i) => { issued.unshift(i); }, again));

    kids.push(el('div', { class: 'v2mem-sec' }, el('b', { text: '구성원' }), el('span', { text: String(v.count) })));
    for (const p of v.people) kids.push(personRow(v, p, slug, primary, meId, (i) => { issued.unshift(i); }, again));

    if (v.pending.length) {
      kids.push(el('div', { class: 'v2mem-sec' }, el('b', { text: '수락 대기' }), el('span', { text: String(v.pending.length) })));
      for (const p of v.pending) kids.push(pendingRow(v, p, again));
    }
    if (!v.canManage) kids.push(el('p', { class: 'v2mem-note', text: primary
      ? '사람을 부르고 권한을 바꾸는 건 관리자가 합니다.'
      : '사람을 부르고 권한을 바꾸는 건 이 워크스페이스를 만든 사람이 합니다.' }));
    body.replaceChildren(...kids.filter(Boolean) as HTMLElement[]);
  };
  void paint();
}

// ── 데이터 — 두 집(워크스페이스 명부 / 박스 계정)을 한 모양(View)으로. ─────────────────────────

async function loadWsView(slug: string, wsName: string): Promise<View> {
  const d = await api('/api/ui/me/workspaces/people?slug=' + encodeURIComponent(slug)) as PeopleData;
  return {
    wsName: d.workspace?.name || wsName, kind: d.kind_effective, count: d.member_count, canManage: d.can_invite,
    people: d.members.map((m: any) => ({
      id: m.member_id, name: who(m), email: m.email, role: m.is_creator ? 'creator' : m.role === 'owner' ? 'owner' : 'member',
      avatar: m.avatar, avatar_char: m.avatar_char, avatar_color: m.avatar_color })),
    pending: d.pending, candidates: d.candidates,
  };
}

/** primary — 박스 계정이 곧 구성원(로그인 = 접근). 이메일·scope 는 admin 에게만 온다(그 밖은 이름만). */
async function loadBoxView(wsName: string): Promise<View> {
  const [org, dash] = await Promise.all([api('/api/ui/org/members') as Promise<any>, api('/api/ui/dash/members').catch(() => null) as Promise<any>]);
  const faces = new Map<string, any>(((dash && dash.members) || []).map((m: any) => [String(m.id), m]));
  const rows: any[] = ((org && org.members) || []).filter((m: any) => m.kind === 'human' && m.state === 'active');
  const people: Person[] = rows.map((m) => {
    const f = faces.get(String(m.id)) || {};
    const scopes: string[] = Array.isArray(m.scopes) ? m.scopes : [];
    return { id: String(m.id), name: personName(m as never) || String(m.id), email: m.email || null,
      role: scopes.includes('admin') ? 'admin' : 'member', scopes,
      avatar: f.avatar ?? m.avatar, avatar_char: f.avatar_char ?? m.avatar_char, avatar_color: f.avatar_color ?? m.avatar_color };
  });
  return { wsName, kind: 'team', count: people.length, canManage: !!(org && org.canEdit), people, pending: [], candidates: [] };
}

// ── 부르기 — 이메일 칩 입력 + 권한 + [초대하기]. ─────────────────────────────────────────────

function chipInput(candidates: PeopleData['candidates'], onSubmit: () => void) {
  const emails: string[] = [];
  const wrap = el('div', { class: 'v2mem-chips', role: 'group', 'aria-label': '초대할 이메일' }) as HTMLElement;
  const input = el('input', { class: 'v2mem-chip-in', type: 'text', autocomplete: 'off', spellcheck: 'false',
    placeholder: '예: ellis@lvly.io, maria@lvly.io', 'aria-label': '이메일 주소 — 여러 명은 쉼표·Enter 로' }) as HTMLInputElement;
  let list: HTMLElement | null = null;
  if (candidates.length) {
    list = el('datalist', { id: 'v2mem-cand' }, ...candidates.map((c) => el('option', { value: c.email, label: c.display_name || c.email }))) as HTMLElement;
    input.setAttribute('list', 'v2mem-cand');
  }
  // ★ 입력칸은 한 번 붙이고 **절대 떼지 않는다** — 칩만 그 앞에 갈아 끼운다. 입력칸을 떼었다 붙이면 포커스가
  //  빠져서 "a@x.com, b@x.com" 을 치다 쉼표에서 글자가 허공으로 간다(프리뷰 실측: 둘째 주소 뒷부분이 사라졌다).
  wrap.append(input, ...(list ? [list] : []));
  const render = (): void => {
    wrap.querySelectorAll('.v2mem-chip').forEach((c) => c.remove());
    const chips = emails.map((e, i) => el('span', { class: 'v2mem-chip' + (EMAIL_RE.test(e) ? '' : ' bad'), title: EMAIL_RE.test(e) ? e : '이메일 형식이 아니에요' },
      el('span', { text: e }),
      el('button', { class: 'v2mem-chip-x', type: 'button', 'aria-label': `${e} 빼기`, onclick: () => { emails.splice(i, 1); render(); input.focus(); } },
        svg(['M6 6l12 12', 'M18 6 6 18'], 'v2mem-chip-x-ic'))));
    input.before(...chips);
    input.placeholder = emails.length ? '' : '예: ellis@lvly.io, maria@lvly.io';
  };
  const commit = (): void => {
    for (const e of parseEmails(input.value)) if (!emails.includes(e)) emails.push(e);
    input.value = ''; render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); onSubmit(); return; }
    if (e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === ' ' || e.key === 'Tab') {
      if (input.value.trim()) { e.preventDefault(); commit(); } else if (e.key !== 'Tab') e.preventDefault();
      return;
    }
    if (e.key === 'Backspace' && !input.value && emails.length) { emails.pop(); render(); input.focus(); }
  });
  input.addEventListener('blur', commit);
  input.addEventListener('paste', () => setTimeout(commit, 0));
  wrap.addEventListener('click', (e) => { if (e.target === wrap) input.focus(); });
  render();
  return {
    el: wrap,
    values: (): string[] => { commit(); return [...emails]; },
    clear: (): void => { emails.length = 0; input.value = ''; render(); },
    focus: (): void => input.focus(),
  };
}

function inviteBlock(v: View, slug: string, primary: boolean, onIssued: (i: Issued) => void, again: () => void): HTMLElement {
  const note = el('p', { class: 'v2mem-invnote', 'aria-live': 'polite' });
  const go = el('button', { class: 'btn btn-primary', type: 'button', text: '초대하기' }) as HTMLButtonElement;
  const roleSel = primary ? null : el('select', { class: 'v2mem-sel', 'aria-label': '초대할 권한' },
    el('option', { value: 'member', text: '구성원으로' }), el('option', { value: 'owner', text: '공동 관리자로' })) as HTMLSelectElement | null;
  const chips = chipInput(v.candidates, () => void send());

  const send = async (): Promise<void> => {
    let linkIssued = false;   // #2188 — 링크를 준 경우엔 "보냈어요" 라고 말하지 않는다(우리가 안 보냈다)
    const emails = chips.values();
    if (!emails.length) { note.textContent = '이메일을 넣어 주세요.'; chips.focus(); return; }
    const bad = emails.filter((e) => !EMAIL_RE.test(e));
    if (bad.length) { note.textContent = '이메일 형식이 아니에요: ' + bad.join(', '); return; }
    const mine = String((state.me as any)?.email || '').toLowerCase();
    if (mine && emails.includes(mine)) { note.textContent = '내 주소는 넣을 수 없어요.'; return; }
    // ★ 개인 → 팀은 되돌릴 수 없다(내보내도 그분이 본 것은 되돌아오지 않는다) — 첫 초대 한 번만 강하게 확인한다.
    if (!primary && v.kind === 'personal') {
      const ok = await confirmDialog({
        title: `'${v.wsName}' 에 사람을 들이면 팀이 됩니다`,
        lines: [
          `${emails.join(', ')} 님을 초대합니다.`,
          '수락하면 이 워크스페이스는 팀이 되고, 여기 있는 자료·프로젝트를 그분이 보게 됩니다.',
          '한 번 공유하면 그분이 본 것은 되돌릴 수 없어요.',
        ],
        confirmText: '초대 보내기', cancelText: '그만두기', danger: true });
      if (!ok) return;
    }
    go.disabled = true; note.textContent = primary ? '계정을 만드는 중…' : '보내는 중…';
    const okd: string[] = []; const failed: string[] = [];
    for (const email of emails) {
      try {
        if (primary) {
          // 박스 계정 생성 — 서버가 새 사람에게 임시 비밀번호를 **한 번만** 돌려준다. 여기서 받아 카드로 보인다.
          const r: any = await api('/api/ui/org/member', { method: 'POST', body: JSON.stringify({ kind: 'human', email, display_name: email.split('@')[0] }) });
          if (r?.initialPassword) onIssued({ title: `${email} 계정을 만들었어요`, email, password: String(r.initialPassword) });
        } else {
          const r: any = await api('/api/ui/me/workspaces/invite', { method: 'POST', body: JSON.stringify({ slug, email, role: roleSel?.value || 'member' }) });
          //  #2188 매니지드 — 계정 서버는 메일을 보내지 않고 **링크**를 준다. 받으면 그대로 보여 준다.
          if (r?.invite?.url) {
            linkIssued = true;
            onIssued({ title: `${email} 님을 초대했어요`, email, inviteUrl: String(r.invite.url),
              note: r.invite.becomes_team
                ? '이 링크를 그분에게 전해 주세요. 수락하면 이 워크스페이스가 팀이 됩니다.'
                : '이 링크를 그분에게 전해 주세요. 열어서 수락해야 구성원이 됩니다.' });
          }
        }
        okd.push(email);
      } catch (e: any) { failed.push(`${email} — ${e?.message || e}`); }
    }
    go.disabled = false;
    if (okd.length) {
      chips.clear();
      toast(primary ? `${okd.length}명의 계정을 만들었어요 — 임시 비밀번호를 전해 주세요.`
        : linkIssued ? `초대 링크를 만들었어요 — 아래 링크를 전해 주세요.`
        : `${okd.length}명에게 초대를 보냈어요 — 수락하면 구성원이 됩니다.`);
    }
    note.textContent = failed.length ? '못 했어요: ' + failed.join(' · ') : '';
    if (okd.length) again();
  };
  go.onclick = () => void send();

  return el('section', { class: 'v2mem-invite' },
    el('label', { class: 'v2mem-label', text: '이메일 주소' }),
    chips.el,
    el('p', { class: 'v2mem-help', text: primary
      ? '계정이 만들어지고 임시 비밀번호가 이 창에 나와요 — 그분에게 직접 전해 주세요.'
      : '초대받은 분이 로그인하면 초대가 보여요. 수락해야 구성원이 됩니다.' }),
    el('div', { class: 'v2mem-invrow' }, roleSel, note, go));
}

/** 방금 만든 계정 — 임시 비밀번호는 지금만 보인다. 세 줄을 한 번에 복사해 그분에게 전한다. */
function issuedCard(i: Issued): HTMLElement {
  const row = (k: string, val: string, mono = false): HTMLElement =>
    el('div', { class: 'v2mem-cred-row' }, el('span', { class: 'v2mem-cred-k', text: k }), el('span', { class: 'v2mem-cred-v' + (mono ? ' mono' : ''), text: val }));
  const head = el('div', { class: 'v2mem-cred-h' }, svg(['M5 12.5l4.2 4.2L19 7'], 'v2mem-cred-ic'), el('b', { text: i.title }));

  //  #2188 초대 링크 — 이 링크가 곧 초대다. 상대에게 **전달해야** 한다(우리가 메일을 보내지 않는다).
  if (i.inviteUrl) {
    const text = `${i.email} 님을 라이블리 워크스페이스에 초대했습니다.\n${i.inviteUrl}`;
    return el('section', { class: 'v2mem-cred', role: 'status' }, head,
      row('초대한 사람', i.email), row('초대 링크', i.inviteUrl, true),
      el('div', { class: 'v2mem-cred-f' },
        el('span', { class: 'v2mem-help', text: i.note || '이 링크를 그분에게 전해 주세요. 열어서 수락해야 구성원이 됩니다. 창을 닫으면 링크를 다시 볼 수 없어요.' }),
        copyButton(() => text, '초대 링크 복사')));
  }

  const loginUrl = location.origin;
  const text = `로그인 주소: ${loginUrl}\n이메일: ${i.email}\n임시 비밀번호: ${i.password}`;
  return el('section', { class: 'v2mem-cred', role: 'status' }, head,
    row('로그인 주소', loginUrl), row('이메일', i.email), row('임시 비밀번호', String(i.password || ''), true),
    el('div', { class: 'v2mem-cred-f' },
      el('span', { class: 'v2mem-help', text: '처음 로그인하면 새 비밀번호를 정해요. 이 창을 닫으면 임시 비밀번호는 다시 볼 수 없어요.' }),
      copyButton(() => text, '세 줄 복사')));
}

// ── 명부 — 한 줄에 얼굴·이름·권한, 조작은 ⋯ 메뉴(둘 이상이라 줄에 늘어놓지 않는다). ─────────

function personRow(v: View, p: Person, slug: string, primary: boolean, meId: string, onIssued: (i: Issued) => void, again: () => void): HTMLElement {
  const isMe = p.id === meId;
  const rows: Array<{ label: string; run?: () => void; danger?: boolean; sep?: boolean }> = [];
  if (v.canManage && !isMe && p.role !== 'creator') {
    if (primary) {
      const isAdmin = p.role === 'admin';
      rows.push({ label: isAdmin ? '관리자에서 내리기' : '관리자로 올리기', run: async () => {
        const scopes = isAdmin ? (p.scopes || []).filter((s) => s !== 'admin') : [...new Set([...(p.scopes || []), 'admin'])];
        try { await api('/api/ui/org/member', { method: 'POST', body: JSON.stringify({ id: p.id, scopes }) }); toast(isAdmin ? `${p.name} 님을 관리자에서 내렸어요.` : `${p.name} 님을 관리자로 올렸어요.`); again(); }
        catch (e: any) { toast('바꾸지 못했어요 — ' + (e?.message || e), true); }
      } });
      rows.push({ label: '비밀번호 재설정', run: async () => {
        if (!await confirmDialog({ title: `${p.name} 님의 비밀번호를 재설정할까요?`, lines: ['지금 비밀번호는 바로 못 쓰게 되고, 새 임시 비밀번호가 이 창에 나와요.', '그 비밀번호를 그분에게 직접 전해 주세요.'], confirmText: '재설정', cancelText: '그만두기' })) return;
        try { const r: any = await api('/api/ui/org/member/reset-password', { method: 'POST', body: JSON.stringify({ id: p.id }) });
          onIssued({ title: `${p.name} 님의 비밀번호를 재설정했어요`, email: p.email || p.id, password: String(r?.password || '') }); again(); }
        catch (e: any) { toast('재설정하지 못했어요 — ' + (e?.message || e), true); }
      } });
      rows.push({ label: '', sep: true });
      rows.push({ label: '비활성화', danger: true, run: async () => {
        if (!await confirmDialog({ title: `${p.name} 님을 비활성화할까요?`, lines: ['로그인할 수 없게 돼요. 그분이 만든 자료·프로젝트는 그대로 남아요.', '설정 ▸ 구성원에서 다시 활성화할 수 있어요.'], confirmText: '비활성화', cancelText: '그만두기', danger: true })) return;
        try { await api('/api/ui/org/member', { method: 'POST', body: JSON.stringify({ id: p.id, state: 'inactive' }) }); toast(`${p.name} 님을 비활성화했어요.`); again(); }
        catch (e: any) { toast('비활성화하지 못했어요 — ' + (e?.message || e), true); }
      } });
    } else {
      const mkOwner = p.role !== 'owner';
      rows.push({ label: mkOwner ? '공동 관리자로 올리기' : '구성원으로 내리기', run: async () => {
        try { await api('/api/ui/me/workspaces/members/add', { method: 'POST', body: JSON.stringify({ slug, member_id: p.id, role: mkOwner ? 'owner' : 'member' }) });
          toast(mkOwner ? `${p.name} 님을 공동 관리자로 올렸어요.` : `${p.name} 님을 구성원으로 내렸어요.`); again(); }
        catch (e: any) { toast('바꾸지 못했어요 — ' + (e?.message || e), true); }
      } });
      rows.push({ label: '', sep: true });
      rows.push({ label: '내보내기', danger: true, run: async () => {
        if (!await confirmDialog({ title: `${p.name} 님을 내보낼까요?`,
          lines: [`'${v.wsName}' 의 구성원에서 뺍니다.`, '그분이 만든 자료·프로젝트는 그대로 남아요.', v.count <= 2 ? '둘만 남은 팀이라, 내보내면 다시 개인 워크스페이스가 됩니다.' : ''].filter(Boolean),
          confirmText: '내보내기', cancelText: '그만두기', danger: true })) return;
        try { await api('/api/ui/me/workspaces/members/remove', { method: 'POST', body: JSON.stringify({ slug, member_id: p.id }) }); toast(`${p.name} 님을 내보냈어요.`); again(); }
        catch (e: any) { toast('내보내지 못했어요 — ' + (e?.message || e), true); }
      } });
    }
  }
  const more = rows.length ? el('button', { class: 'v2mem-more', type: 'button', 'aria-label': `${p.name} 님 조작 메뉴`, title: '권한 · 내보내기',
    onclick: (e: Event) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); ctxMenu(r.right, r.bottom + 4, rows); } },
    svg(['M5 12h.01', 'M12 12h.01', 'M19 12h.01'], 'v2mem-more-ic')) : null;
  return el('div', { class: 'v2mem-row' },
    profileAvatar(p.avatar ?? null, p.name, p.id, 'v2mem-face', { char: p.avatar_char, color: p.avatar_color }),
    el('div', { class: 'v2mem-tt' }, el('b', { text: p.name + (isMe ? ' (나)' : '') }), el('span', { text: p.email || '' })),
    el('span', { class: 'v2mem-role' + (p.role === 'member' ? '' : ' lead'), text: ROLE_LABEL[p.role] }),
    more);
}

function pendingRow(v: View, p: PeopleData['pending'][number], again: () => void): HTMLElement {
  return el('div', { class: 'v2mem-row pending' },
    el('span', { class: 'v2mem-face waiting', 'aria-hidden': 'true', text: '…' }),
    el('div', { class: 'v2mem-tt' }, el('b', { text: p.email }), el('span', { text: `${ago(p.created_at)} 보냄 · ${p.role === 'owner' ? '공동 관리자로' : '구성원으로'}` })),
    el('span', { class: 'v2mem-role', text: '수락 대기' }),
    v.canManage ? el('button', { class: 'btn-text v2mem-cancel', type: 'button', text: '취소', title: '초대 취소', onclick: async () => {
      if (!await confirmDialog({ title: '초대를 취소할까요?', message: `${p.email} 님에게 보낸 초대를 거둡니다.`, confirmText: '취소하기', cancelText: '그만두기' })) return;
      try { await api('/api/ui/me/workspaces/invite/resolve', { method: 'POST', body: JSON.stringify({ invite_id: p.id, decision: 'revoke' }) }); toast('초대를 취소했어요.'); again(); }
      catch (e: any) { toast('취소하지 못했어요 — ' + (e?.message || e), true); }
    } }) : null);
}
