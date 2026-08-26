// v2/share-session.ts — 세션 공유(#2116). 문패 오른쪽 [공유] 가 여는 팝오버.
//
// 왜 필요했나(실측 2026-08-26): 상민님이 원준님 세션 링크를 열었더니 403(no-access)·404 로 안 열렸다.
//  서버에는 초대(invites)가 처음부터 다 있었다 — `canAttach`(terminal/sessions.ts) · `canSeeSession`(write-cap.ts) ·
//  `nodeSessionVisible`(node/protocol.ts) 셋 다 초대를 본다. **없던 건 이 화면의 입구뿐**이었다:
//  구 셸엔 [이름·초대 수정] 이 있는데 새 셸엔 세션 초대가 아예 없어서, 소유자가 남을 부를 방법이 없었다.
//
// 그래서 여기서 넓히는 건 정책이 아니라 **입구**다. 서버 규칙은 그대로 두고, 소유자가 명시적으로 고른 사람만
//  들어온다(프로젝트에 붙었다고 자동으로 열리지 않는다 — 그건 다른 축이고 대표 판단이 필요한 일이다).
//
// ⚠ 초대는 **소유자만** 바꿀 수 있다(서버 assertManage — admin 도 예외가 아니다). 남의 세션에서는 이 창이
//  '누가 볼 수 있나'를 읽기 전용으로 보여주고, 무엇을 눌러야 하는지(소유자에게 요청)를 말한다. 눌러 보고
//  403 을 받게 두지 않는다.
import { anchoredPopover, api, el, personFace, state, toast } from '../core.js';
import { viewersOf, type Viewer } from './presence.js';

interface ShareSess {
  id: string;
  label: string;
  node: string | null;
  owned: boolean;
  owner: string;
  invites: string[];
}

interface MemberRow { id: string; display_name?: string | null }

const nameOf = (m: MemberRow): string => String(m.display_name || m.id);

/** 세션 행(v2 Sess)에서 공유에 필요한 것만 뽑는다. raw 가 비어도 안전한 기본값으로 떨어진다. */
export function shareSessOf(s: any): ShareSess | null {
  if (!s || !s.id) return null;
  const raw = s.raw || {};
  return {
    id: String(s.id),
    label: String(s.label || s.id),
    node: s.node ? String(s.node) : null,
    owned: !!s.owned,
    owner: String(raw.owner || ''),
    invites: Array.isArray(raw.invites) ? raw.invites.map((x: any) => String(x)) : [],
  };
}

const sec = (t: string): HTMLElement => el('div', { class: 'pn-share-sec', text: t });
const fine = (t: string): HTMLElement => el('p', { class: 'pn-share-fine', text: t });

/** 지금 보고 있는 사람 줄 — 팝오버 맨 위(구글 문서와 같은 자리). 아무도 없으면 통째로 생략한다. */
function viewersBlock(sid: string, meId: string): HTMLElement | null {
  const vs: Viewer[] = viewersOf(sid);
  if (!vs.length) return null;
  return el('div', { class: 'pn-share-block' },
    sec('지금 보고 있는 사람'),
    el('div', { class: 'pn-share-people' },
      ...vs.map((v) => el('span', { class: 'pn-share-person' },
        personFace(v.id, 'pn-share-face', v.name),
        el('span', { text: v.name + (v.id === meId ? ' (나)' : '') })))));
}

export function openSharePopover(anchor: HTMLElement, s: ShareSess, onSaved?: (invites: string[]) => void): void {
  const meId = String((state.me as any)?.userId || '');
  const chosen = new Set<string>(s.invites);
  let members: MemberRow[] = [];

  const body = el('div', { class: 'pn-share-body' }, el('p', { class: 'pn-share-fine', text: '불러오는 중…' })) as HTMLElement;
  const panel = el('div', { class: 'pn-share', role: 'dialog', 'aria-label': '세션 공유' },
    el('div', { class: 'pn-share-head' },
      el('b', { text: '공유' }),
      el('span', { class: 'pn-share-sub ell1', title: s.label, text: s.label })),
    body) as HTMLElement;
  const close = anchoredPopover(anchor, panel);

  // ── 남의 세션 — 읽기 전용 + 무엇을 해야 하는지 ──────────────────────────────────
  function paintReadOnly(): void {
    const ownerNm = members.length ? nameOf(members.find((m) => m.id === s.owner) || { id: s.owner }) : s.owner;
    const withMe = [s.owner, ...s.invites];
    body.replaceChildren(...[
      viewersBlock(s.id, meId),
      el('div', { class: 'pn-share-block' },
        sec('이 세션을 볼 수 있는 사람'),
        el('div', { class: 'pn-share-people' },
          ...withMe.map((id) => {
            const nm = members.length ? nameOf(members.find((m) => m.id === id) || { id }) : id;
            return el('span', { class: 'pn-share-person' },
              personFace(id, 'pn-share-face', nm),
              el('span', { text: nm + (id === s.owner ? ' · 소유자' : '') }));
          }))),
      fine(`초대는 소유자만 바꿀 수 있어요 — ${ownerNm}님께 이 세션에 초대해 달라고 요청하세요.`),
    ].filter(Boolean) as HTMLElement[]);
  }

  // ── 내 세션 — 초대 편집 ──────────────────────────────────────────────────────
  function paintEditor(): void {
    const q = el('input', { class: 'pn-share-in', type: 'text', placeholder: '이름으로 찾기', 'aria-label': '초대할 사람 찾기' }) as HTMLInputElement;
    const chips = el('div', { class: 'pn-share-chips' }) as HTMLElement;
    const list = el('div', { class: 'pn-share-list' }) as HTMLElement;
    const save = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '저장' }) as HTMLButtonElement;

    const drawChips = (): void => {
      chips.replaceChildren(...(chosen.size
        ? [...chosen].map((id) => {
            const nm = nameOf(members.find((m) => m.id === id) || { id });
            return el('span', { class: 'pn-share-chip' },
              personFace(id, 'pn-share-face', nm), el('span', { text: nm }),
              el('button', { class: 'pn-share-x', type: 'button', title: nm + ' 빼기', 'aria-label': nm + ' 빼기',
                onclick: () => { chosen.delete(id); drawChips(); drawList(); } }, el('span', { text: '×' })));
          })
        : [el('span', { class: 'pn-share-fine', text: '아직 아무도 없어요 — 나만 보는 비공개 세션이에요.' })]));
    };
    const drawList = (): void => {
      const kw = q.value.trim().toLowerCase();
      // 나·소유자는 후보가 아니다(이미 볼 수 있다 — 서버 validInvites 도 소유자를 걸러낸다).
      const cand = members.filter((m) => m.id !== s.owner && !chosen.has(m.id)
        && (!kw || nameOf(m).toLowerCase().includes(kw) || m.id.toLowerCase().includes(kw)));
      list.replaceChildren(...(cand.length
        ? cand.slice(0, 8).map((m) => el('button', { class: 'pn-share-row', type: 'button',
            onclick: () => { chosen.add(m.id); q.value = ''; drawChips(); drawList(); } },
            personFace(m.id, 'pn-share-face', nameOf(m)), el('span', { text: nameOf(m) })))
        : [el('p', { class: 'pn-share-fine', text: kw ? '그런 사람이 없어요.' : '부를 사람이 더 없어요.' })]));
    };
    q.addEventListener('input', drawList);

    save.onclick = async (): Promise<void> => {
      save.disabled = true;
      const invites = [...chosen];
      try {
        const b: Record<string, unknown> = { invites };
        if (s.node) b.node = s.node;   // 노드 세션은 게이트웨이가 그 노드로 중계한다(routes.ts 가 body.node 를 본다)
        await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'POST', body: JSON.stringify(b) });
        s.invites = invites;
        onSaved?.(invites);
        toast(invites.length ? `${invites.length}명이 이 세션을 볼 수 있어요.` : '비공개로 바꿨어요 — 이제 나만 봅니다.');
        close();
      } catch (e: any) { save.disabled = false; toast('공유 실패 — ' + (e?.message || '알 수 없는 오류'), true); }
    };

    body.replaceChildren(...[
      viewersBlock(s.id, meId),
      el('div', { class: 'pn-share-block' }, sec('함께 볼 사람'), chips, q, list),
      fine('고른 사람만 이 세션을 보고 열 수 있어요.'),
      el('div', { class: 'pn-share-act' },
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '취소', onclick: () => close() }), save),
    ].filter(Boolean) as HTMLElement[]);
    drawChips(); drawList();
  }

  void (async () => {
    try {
      const d: any = await api('/api/ui/dash/members');
      members = ((d && d.members) || []).map((m: any) => ({ id: String(m.id), display_name: m.display_name }));
    } catch (_) { members = []; }   // 명부를 못 받아도 창은 뜬다 — 이름 자리에 id 가 나갈 뿐이다
    if (!panel.isConnected) return;
    if (s.owned) paintEditor(); else paintReadOnly();
  })();
}
