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
import { api, el, profileAvatar, state, toast } from '../core.js';
import { confirmDialog, overlay } from '../ui-primitives.js';

export interface PeopleData {
  workspace: { slug: string; name: string; kind_effective: 'personal' | 'team'; member_count: number | null };
  member_count: number;
  kind_effective: 'personal' | 'team';
  can_invite: boolean;
  members: Array<{ member_id: string; role: string; email: string | null; display_name: string | null; is_creator: boolean }>;
  pending: Array<{ id: string; email: string; role: string; invited_by: string; created_at: string }>;
  candidates: Array<{ id: string; email: string; display_name: string | null }>;
}

const who = (m: PeopleData['members'][number]): string => m.display_name || m.email || m.member_id;

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
      toast(r?.known_member
        ? `${email} 님에게 초대를 보냈어요. 그분 화면에 수락 요청이 뜹니다.`
        : `${email} 님을 불러 뒀어요. 그분이 이 워크스페이스에 로그인하면 수락 요청이 뜹니다.`);
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

/** 구성원 모달을 연다. slug = 대상 워크스페이스, wsName = 표시 이름(모달 제목). */
export function openMemberModal(slug: string, wsName: string): void {
  const body = el('div', { class: 'v2-mem' }, el('p', { class: 'v2-ws-loading', text: '불러오는 중…' })) as HTMLElement;
  const back = overlay(wsName + ' · 구성원', body);
  const close = () => back.remove();
  void paintModal(body, slug, close);
}

async function paintModal(body: HTMLElement, slug: string, close: () => void): Promise<void> {
  let d: PeopleData;
  try { d = await api('/api/ui/me/workspaces/people?slug=' + encodeURIComponent(slug)) as PeopleData; }
  catch (e: any) { body.replaceChildren(el('p', { class: 'v2-ws-empty', text: e?.message || '구성원을 불러오지 못했어요.' })); return; }
  const again = () => { void paintModal(body, slug, close); document.dispatchEvent(new CustomEvent('lively:ws-people-changed')); };
  const meId = String((state.me as any)?.userId || '');
  const personal = d.kind_effective === 'personal';
  const kids: (HTMLElement | null)[] = [];

  // 이 집이 지금 개인인지 팀인지 — 첫 줄에서 말한다(초대의 무게가 여기서 갈린다).
  kids.push(el('div', { class: 'v2-mem-kind' + (personal ? ' personal' : '') },
    el('b', { text: personal ? '개인 워크스페이스' : `팀 워크스페이스 · ${d.member_count}명` }),
    el('span', { text: personal ? '지금은 나만 봐요. 사람을 들이면 팀이 됩니다.' : '초대받은 분이 수락하면 구성원이 됩니다.' })));

  // ── 초대(만든 사람·owner 만) — 슬랙 문법: 이메일 여러 명 + 명부에서 고르기. ──
  if (d.can_invite) kids.push(inviteBlock(d, slug, again));

  // ── 명부 ──
  kids.push(el('div', { class: 'v2-ws-sec', text: `구성원 ${d.member_count}명` }));
  for (const m of d.members) kids.push(modalMemberRow(d, m, slug, meId, again));

  // ── 보류 초대 ──
  if (d.pending.length) {
    kids.push(el('div', { class: 'v2-ws-sec', text: `수락 대기 ${d.pending.length}` }));
    for (const p of d.pending) kids.push(el('div', { class: 'v2-mem-row pending' },
      el('span', { class: 'v2-ws-person-face waiting', 'aria-hidden': 'true', text: '…' }),
      el('span', { class: 'v2-ws-person-tt' }, el('b', { text: p.email }), el('span', { text: '수락 대기' })),
      d.can_invite ? el('button', { class: 'v2-mem-act', type: 'button', text: '취소', title: '초대 취소', onclick: async () => {
        if (!await confirmDialog({ title: '초대를 취소할까요?', message: `${p.email} 님에게 보낸 초대를 취소합니다.`, confirmText: '취소하기', cancelText: '그만두기' })) return;
        try { await api('/api/ui/me/workspaces/invite/resolve', { method: 'POST', body: JSON.stringify({ invite_id: p.id, decision: 'revoke' }) }); toast('초대를 취소했어요.'); again(); }
        catch (e: any) { toast('취소하지 못했어요 — ' + (e?.message || e), true); }
      } }) : null));
  }

  if (!d.can_invite) kids.push(el('p', { class: 'v2-ws-hint', text: '사람을 부르고 권한을 바꾸는 건 이 워크스페이스를 만든 사람이 합니다.' }));
  body.replaceChildren(...kids.filter(Boolean) as HTMLElement[]);
}

function inviteBlock(d: PeopleData, slug: string, again: () => void): HTMLElement {
  const input = el('textarea', { class: 'v2-mem-emails', rows: '2',
    placeholder: '예: ellis@lvly.io, maria@lvly.io', 'aria-label': '초대할 이메일(여러 명은 콤마로)', list: 'v2-ws-cand' }) as HTMLTextAreaElement;
  const list = el('datalist', { id: 'v2-ws-cand' },
    ...d.candidates.map((c) => el('option', { value: c.email, label: c.display_name || c.email }))) as HTMLElement;
  const note = el('span', { class: 'v2-ws-note' });
  const go = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '초대 보내기' }) as HTMLButtonElement;

  const send = async () => {
    const emails = parseEmails(input.value);
    if (!emails.length) { note.textContent = '이메일을 입력하세요.'; input.focus(); return; }
    const bad = emails.filter((e) => !EMAIL_RE.test(e));
    if (bad.length) { note.textContent = '이메일 형식이 아니에요: ' + bad.join(', '); return; }
    // ★ 개인 → 팀은 되돌릴 수 없다(내보내도 그분이 본 것은 되돌아오지 않는다) — 강하게 한 번 확인한다.
    if (d.kind_effective === 'personal') {
      const ok = await confirmDialog({
        title: `'${d.workspace.name}' 에 사람을 들이면 팀이 됩니다`,
        lines: [
          `${emails.join(', ')} 님을 초대합니다.`,
          '수락하면 이 워크스페이스는 팀이 되고, 여기 있는 자료·프로젝트를 그분이 보게 됩니다.',
          '한 번 공유하면 그분이 본 것은 되돌릴 수 없어요.',
        ],
        confirmText: '초대 보내기', cancelText: '그만두기', danger: true });
      if (!ok) return;
    }
    go.setAttribute('disabled', ''); note.textContent = '보내는 중…';
    const okd: string[] = []; const failed: string[] = [];
    for (const email of emails) {
      try { await api('/api/ui/me/workspaces/invite', { method: 'POST', body: JSON.stringify({ slug, email }) }); okd.push(email); }
      catch (e: any) { failed.push(email + '(' + (e?.message || e) + ')'); }
    }
    go.removeAttribute('disabled');
    if (okd.length) { input.value = ''; toast(`${okd.length}명 초대했어요 — 그분이 수락하면 구성원이 됩니다.`); }
    note.textContent = failed.length ? '못 보냄: ' + failed.join(' · ') : '';
    again();
  };
  go.onclick = () => void send();
  //  Enter=줄바꿈(여러 명 입력), Cmd/Ctrl+Enter=보내기.
  input.addEventListener('keydown', (e) => { const k = e as KeyboardEvent; if (k.key === 'Enter' && (k.metaKey || k.ctrlKey)) { e.preventDefault(); void send(); } });

  return el('div', { class: 'v2-mem-invite' }, list,
    el('label', { class: 'v2-mem-label', text: '이메일로 초대' }), input,
    el('div', { class: 'v2-ws-formrow' }, go, note));
}

function modalMemberRow(d: PeopleData, m: PeopleData['members'][number], slug: string, meId: string, again: () => void): HTMLElement {
  const isMe = m.member_id === meId;
  const nm = who(m) + (isMe ? ' (나)' : '');
  const roleText = m.is_creator ? '만든 사람' : m.role === 'owner' ? '공동 관리자' : '구성원';
  const acts: (HTMLElement | null)[] = [];
  // 권한(만든 사람이 아닌 사람에 한해, owner 만 조작) — 관리자↔구성원 토글.
  if (d.can_invite && !m.is_creator && !isMe) {
    const mkOwner = m.role !== 'owner';
    acts.push(el('button', { class: 'v2-mem-act', type: 'button',
      title: mkOwner ? '공동 관리자로 올리기 — 사람 초대·권한 변경을 함께 할 수 있어요' : '구성원으로 내리기',
      text: mkOwner ? '관리자로' : '구성원으로',
      onclick: async () => {
        try { await api('/api/ui/me/workspaces/members/add', { method: 'POST', body: JSON.stringify({ slug, member_id: m.member_id, role: mkOwner ? 'owner' : 'member' }) });
          toast(mkOwner ? `${who(m)} 님을 공동 관리자로 올렸어요.` : `${who(m)} 님을 구성원으로 내렸어요.`); again(); }
        catch (e: any) { toast('바꾸지 못했어요 — ' + (e?.message || e), true); }
      } }));
    // 내보내기(추방) — 만든 사람은 못 뺀다(서버도 막는다).
    acts.push(el('button', { class: 'v2-mem-act danger', type: 'button', title: '이 워크스페이스에서 내보내기', text: '내보내기',
      onclick: async () => {
        if (!await confirmDialog({ title: `${who(m)} 님을 내보낼까요?`,
          lines: [`'${d.workspace.name}' 의 구성원에서 뺍니다.`, '그분이 만든 자료·프로젝트는 그대로 남아요.', d.member_count <= 2 ? '둘만 남은 팀이라, 내보내면 다시 개인 워크스페이스가 됩니다.' : ''].filter(Boolean),
          confirmText: '내보내기', cancelText: '그만두기', danger: true })) return;
        try { await api('/api/ui/me/workspaces/members/remove', { method: 'POST', body: JSON.stringify({ slug, member_id: m.member_id }) }); toast(`${who(m)} 님을 내보냈어요.`); again(); }
        catch (e: any) { toast('내보내지 못했어요 — ' + (e?.message || e), true); }
      } }));
  }
  return el('div', { class: 'v2-mem-row' },
    profileAvatar((m as any).avatar, who(m), m.member_id, 'v2-ws-person-face', { char: (m as any).avatar_char, color: (m as any).avatar_color }),
    el('span', { class: 'v2-ws-person-tt' }, el('b', { text: nm }), el('span', { text: roleText + (m.email && !m.is_creator ? ' · ' + m.email : '') })),
    ...acts.filter(Boolean) as HTMLElement[]);
}
