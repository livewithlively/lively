// projects/access-ui.ts — 프로젝트를 «누가 보나» 의 화면 부품(#5598, 상민 2026-11-18).
//
//  셋이 여기 있다:
//   · projAccessTag  — 목록 줄 · 카드의 작은 표시(자물쇠 «나만» · «2명과 공유» · 지구본 «전체 공개»).
//   · projAccessChip — 프로젝트 화면 속성 띠의 칩. 누르면 [공유] 창이 열린다.
//   · openProjectSharePopover — 프로젝트 [공유] 창. 세션의 [공유](v2/share-session.ts)와 같은 틀 · 같은 손놀림이다
//     (이름으로 찾기 → ↵ 담기 → ↵ 초대, lib/share-enter). 프로젝트는 여기에 «공개 범위»(초대한 사람만 ↔ 전체 공개)가 하나 더 있다.
//
//  말과 판정은 lib/proj-access.ts 한 벌이다 — 이 파일은 그리기만 한다.
//  서버 규칙(src/v6/project-invite.ts): 넣기(초대)는 그 프로젝트를 보는 사람 누구나 · 남을 빼기와 공개 범위 바꾸기는 만든 사람만.
import { anchoredPopover, api, el, personFace, state, sv, toast } from '../core.js';
import { ICONS } from '../lib/icon-paths.js';
import {
  ACCESS_CONFIG_DEFAULT, ACCESS_LABEL_INVITE, ACCESS_LABEL_OPEN, isPendingOpen, isPrivateProj, projAccessBadge, projAudience, showAccessBadge,
  type AccessConfig, type AccessLike,
} from '../lib/proj-access.js';
import { inviteAdded, inviteDirty, shareEnterAction } from '../lib/share-enter.js';

// ── 워크스페이스 설정(새 프로젝트 공개 방식 · 축 켜짐) ──────────────────────────────
//  프로젝트 목록 응답이 access 를 함께 준다(src/capabilities/projects-v6.ts) — 목록을 받는 자리가 setAccessConfig 로 넣는다.
//  목록을 안 거치는 자리(프로젝트 화면을 주소로 바로 연 때 · 새로 만들기 창)는 loadAccessConfig 로 한 번 묻는다.
let cfg: AccessConfig = ACCESS_CONFIG_DEFAULT;
let cfgLoaded = false;
let cfgP: Promise<AccessConfig> | null = null;

export function setAccessConfig(raw: any): void {
  if (!raw || typeof raw !== 'object') return;
  cfg = { mode: raw.mode === 'open' ? 'open' : 'invite', enforced: raw.enforced !== false };
  cfgLoaded = true;
}
export function accessConfig(): AccessConfig { return cfg; }
/** 설정을 받아 둔다(이미 받았으면 그 값). 실패하면 기본값(초대제 · 켜짐) — 닫힌 것을 닫혔다고 말하는 쪽이다. */
export function loadAccessConfig(force = false): Promise<AccessConfig> {
  if (cfgLoaded && !force) return Promise.resolve(cfg);
  if (!cfgP || force) {
    cfgP = api('/api/ui/v6/project-access').then((d: any) => { setAccessConfig(d); return cfg; })
      .catch(() => cfg).finally(() => { cfgP = null; });
  }
  return cfgP;
}

const meIdOf = (): string => String((state.me && ((state.me as any).userId || (state.me as any).email)) || '');

// ── 구성원 이름(설명에 적을 것) ─────────────────────────────────────────────
//  프로젝트 행에는 팀원의 이름만 실리고 **만든 사람의 이름은 없다**(created_by 는 id). 설명에 id 가 그대로 나가지 않게
//  명부를 한 번 받아 둔다. 표시는 명부를 기다리지 않고 그리고, 설명(title)은 올렸을 때 그때의 명부로 다시 적는다.
const dirNames = new Map<string, string>();
let dirP: Promise<void> | null = null;
function loadDirectory(): Promise<void> {
  if (!dirP) {
    dirP = api('/api/ui/dash/members').then((d: any) => {
      for (const m of (d && d.members) || []) if (m && m.id) dirNames.set(String(m.id), String(m.display_name || m.id));
    }).catch(() => { dirP = null; });
  }
  return dirP;
}

function glyph(name: 'lock' | 'web'): SVGElement {
  return sv('svg', { class: 'pj-acc-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, sv('path', { d: ICONS[name] }));
}

/** 행에 실린 팀원(member_id · display_name)에서 이름 찾기 — 없으면 id 그대로. */
function nameFinder(p: AccessLike): (id: string) => string {
  const m = new Map<string, string>(dirNames);
  for (const x of (p.members || []) as any[]) {
    const id = typeof x === 'string' ? x : String(x?.member_id ?? x?.id ?? '');
    const nm = typeof x === 'string' ? '' : String(x?.display_name ?? '');
    if (id && nm) m.set(id, nm);
  }
  return (id) => m.get(id) || id;
}

/**
 * 목록 줄 · 카드의 작은 표시. 그릴 것이 없으면 null(축이 꺼진 워크스페이스 · 전체 공개 방식에서의 열린 프로젝트).
 *  compact — 열린 프로젝트는 지구본만 그린다(글자는 설명에). 닫힌 프로젝트는 늘 글자까지 — «나만» 이 읽혀야 한다.
 */
export function projAccessTag(p: AccessLike | null | undefined, opts: { compact?: boolean } = {}): HTMLElement | null {
  if (!p) return null;
  const b = projAccessBadge(p, meIdOf(), nameFinder(p));
  if (!showAccessBadge(b, cfg)) return null;
  const iconOnly = !b.locked && opts.compact;
  const tipOf = (): string => (iconOnly ? b.label + ' — ' : '') + projAccessBadge(p, meIdOf(), nameFinder(p)).tip;
  const tag = el('span', { class: 'pj-acc-tag pj-acc-' + b.kind + (iconOnly ? ' pj-acc-icononly' : ''), title: tipOf(), 'aria-label': b.label },
    glyph(b.locked ? 'lock' : 'web'), iconOnly ? null : el('span', { class: 'pj-acc-t', text: b.label })) as HTMLElement;
  freshTip(tag, tipOf);
  return tag;
}

/** 올렸을 때 설명을 그때의 명부로 다시 적는다(처음 그릴 때는 명부가 아직 안 왔을 수 있다). 닫힌 표시에만 이름이 든다. */
function freshTip(node: HTMLElement, tipOf: () => string): void {
  void loadDirectory();
  node.addEventListener('mouseenter', () => { if (node.hasAttribute('title')) node.title = tipOf(); });
}

/** 프로젝트 화면 속성 띠의 칩 — 지금 누가 보는지 말하고, 누르면 [공유] 창. 축이 꺼진 워크스페이스에서는 null. */
export function projAccessChip(p: any, members: any[], reload: () => void): HTMLElement | null {
  if (!cfg.enforced) return null;
  const row = { ...p, members };
  const b = projAccessBadge(row, meIdOf(), nameFinder(row));
  const tipOf = (): string => projAccessBadge(row, meIdOf(), nameFinder(row)).tip + ' 누르면 공유 창이 열려요.';
  const btn = el('button', { class: 'pjh-acc-btn pj-acc-' + b.kind, type: 'button', title: tipOf(),
    'aria-haspopup': 'dialog' }, glyph(b.locked ? 'lock' : 'web'), el('span', { text: b.label })) as HTMLButtonElement;
  freshTip(btn, tipOf);
  btn.onclick = () => openProjectSharePopover(btn, row, reload);
  return el('div', { class: 'pjh-fact pjh-fact-acc' + (b.locked ? ' locked' : '') }, btn);
}

interface MemberRow { id: string; display_name?: string | null }
const nameOf = (m: MemberRow): string => String(m.display_name || m.id);
const sec = (t: string): HTMLElement => el('div', { class: 'pn-share-sec', text: t });
const fine = (t: string, cls = ''): HTMLElement => el('p', { class: 'pn-share-fine' + (cls ? ' ' + cls : ''), text: t });

/**
 * 프로젝트 [공유] 창. p = 프로젝트 행(+ members). onChanged — 저장 뒤 화면을 다시 그릴 때 부른다.
 */
export function openProjectSharePopover(anchor: HTMLElement, p: any, onChanged?: () => void): void {
  const meId = meIdOf();
  const ownerId = String(p.created_by || '');
  const isOwner = !!meId && ownerId === meId;
  //  팀원(= 초대한 사람). 만든 사람은 명단에 따로 서지 않는다 — 늘 본다.
  let invited: string[] = projAudience(p).filter((id) => id !== ownerId);
  const chosen = new Set<string>(invited);
  let members: MemberRow[] = [];
  let priv = isPrivateProj(p);
  let pending = isPendingOpen(p);
  const listLocked = p.list_locked === true;   // 잠긴 리스트 안 — «전체 공개» 로 바꿔도 그 리스트 대상만 본다
  const everyone = listLocked ? '이 리스트를 볼 수 있는 사람 모두' : '워크스페이스 구성원 모두';

  const body = el('div', { class: 'pn-share-body' }, fine('불러오는 중…')) as HTMLElement;
  const panel = el('div', { class: 'pn-share pj-share', role: 'dialog', 'aria-label': '프로젝트 공유' },
    el('div', { class: 'pn-share-head' },
      el('b', { text: '공유' }),
      el('span', { class: 'pn-share-sub ell1', title: String(p.name || ''), text: String(p.name || '') })),
    body) as HTMLElement;
  const close = anchoredPopover(anchor, panel);
  const memberName = (id: string): string => nameOf(members.find((m) => m.id === id) || { id });
  const done = (): void => { try { onChanged?.(); } catch (_) { /* 다시 그리기 실패는 저장과 무관 */ } };

  // ── 공개 범위 바꾸기(만든 사람만) — 누르면 그 자리에서 한 번 더 묻는다 ─────────────────────
  async function setAccess(access: 'invite' | 'open', btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      const r: any = await api('/api/ui/v6/projects/' + p.id + '/access', { method: 'POST', body: JSON.stringify({ access }) });
      const np = (r && r.project) || {};
      p.invite_only = np.invite_only === true; p.draft = np.draft === true;
      if (Array.isArray(r?.member_ids)) { invited = r.member_ids.map(String).filter((id: string) => id !== ownerId); chosen.clear(); for (const id of invited) chosen.add(id); }
      p.members = invited.map((id) => ({ member_id: id, display_name: memberName(id) }));
      priv = isPrivateProj(p); pending = isPendingOpen(p);
      toast(access === 'open' ? `전체 공개로 바꿨어요 — ${everyone}가 봐요.`
        : (invited.length ? `초대한 사람만 보게 바꿨어요 — 나와 ${invited.length}명만 봐요.` : '초대한 사람만 보게 바꿨어요 — 이제 나만 봐요.'));
      done(); paint();
    } catch (e: any) { btn.disabled = false; toast('바꾸지 못했어요 — ' + (e?.message || '알 수 없는 오류'), true); }
  }

  function accessSwitch(): HTMLElement | null {
    if (!isOwner) {
      return fine(ownerId ? `공개 범위는 만든 사람(${memberName(ownerId)}님)만 바꿀 수 있어요.` : '공개 범위는 만든 사람만 바꿀 수 있어요.');
    }
    const host = el('div', { class: 'pj-share-switch' }) as HTMLElement;
    const ask = (to: 'invite' | 'open'): void => {
      const go = el('button', { class: 'btn btn-sm ' + (to === 'open' ? 'btn-danger' : 'btn-primary'), type: 'button',
        text: to === 'open' ? ACCESS_LABEL_OPEN + '로 바꾸기' : '초대한 사람만 보게 하기' }) as HTMLButtonElement;
      go.onclick = () => { void setAccess(to, go); };
      host.replaceChildren(
        el('p', { class: 'pj-share-warn', text: to === 'open'
          ? `${everyone}가 이 프로젝트의 본문 · 태스크 · 파일을 보게 돼요. 프로젝트의 세션은 그대로 초대한 사람만 봐요.`
          //  닫을 때 서버가 «이미 일하던 사람»(세션에 초대한 사람 · 태스크 담당자)을 팀원으로 함께 넣는다(project-store.setProjectAccess).
          : '지금부터 나와 팀원만 봐요 — 이 프로젝트의 세션에 초대한 사람과 태스크 담당자는 팀원으로 함께 남아요. 그 밖의 구성원의 목록과 검색에서는 사라져요.' }),
        el('div', { class: 'pn-share-act' },
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '취소', onclick: () => host.replaceChildren(link()) }), go));
    };
    const link = (): HTMLElement => priv && !pending
      ? el('button', { class: 'pj-share-link', type: 'button', text: ACCESS_LABEL_OPEN + '로 바꾸기…', onclick: () => ask('open') })
      : pending
        //  풀리면 열리는 초안 — 두 길을 다 준다: 계속 닫아 두기(초대제로 못 박기) · 지금 열기.
        ? el('div', { class: 'pj-share-links' },
            el('button', { class: 'pj-share-link', type: 'button', text: '계속 초대한 사람만 보게 하기…', onclick: () => ask('invite') }),
            el('button', { class: 'pj-share-link', type: 'button', text: '지금 ' + ACCESS_LABEL_OPEN + '…', onclick: () => ask('open') }))
        : el('button', { class: 'pj-share-link', type: 'button', text: '초대한 사람만 보게 바꾸기…', onclick: () => ask('invite') });
    host.append(link());
    return host;
  }

  function stateBlock(): HTMLElement {
    const line = (icon: 'lock' | 'web', t: string): HTMLElement => el('div', { class: 'pj-share-state' + (icon === 'lock' ? ' locked' : '') }, glyph(icon), el('b', { text: t }));
    if (!priv) {
      //  잠긴 리스트 안이면 «모두가 봐요» 가 아니다 — 그 리스트를 볼 수 있는 사람만 본다(리스트 공개범위는 리스트 설정이 맡는다).
      return el('div', { class: 'pn-share-block' }, sec('공개 범위'),
        listLocked ? line('lock', '이 리스트를 볼 수 있는 사람만 봐요') : line('web', '워크스페이스 구성원 모두가 봐요'),
        listLocked ? fine('리스트의 공개범위가 걸려 있어요 — 누가 보는지는 리스트 설정에서 바꿉니다.') : null,
        fine('프로젝트의 세션은 세션마다 초대한 사람만 봐요.'), accessSwitch());
    }
    return el('div', { class: 'pn-share-block' }, sec('공개 범위'),
      //  말하는 사람의 자리에서 적는다 — 만든 사람에게는 «나와 초대한 N명», 초대받은 사람에게는 «○○님과 초대받은 N명».
      line('lock', isOwner
        ? (invited.length ? `나와 초대한 ${invited.length}명만 봐요` : '나만 봐요')
        : (ownerId ? `${memberName(ownerId)}님과 초대받은 ${invited.length}명만 봐요` : `초대받은 ${invited.length}명만 봐요`)),
      pending ? fine('초안인 동안만 닫혀 있어요 — 작업을 남기거나 제목 · 본문을 정리하면 전체 공개돼요.', 'pj-share-pending') : null,
      accessSwitch());
  }

  // ── 초대 편집(닫힌 프로젝트) — 세션 [공유] 와 같은 손놀림 ───────────────────────────────
  function editorBlock(): HTMLElement {
    const q = el('input', { class: 'pn-share-in', type: 'text', placeholder: '이름으로 찾기', 'aria-label': '초대할 사람 찾기' }) as HTMLInputElement;
    const chips = el('div', { class: 'pn-share-chips' }) as HTMLElement;
    const list = el('div', { class: 'pn-share-list' }) as HTMLElement;
    const save = el('button', { class: 'btn btn-primary btn-sm pn-share-save', type: 'button' }) as HTMLButtonElement;
    const hint = el('p', { class: 'pn-share-fine pn-share-hint', 'aria-live': 'polite' }) as HTMLElement;
    let saving = false;
    let top: MemberRow | null = null;
    const dirty = (): boolean => inviteDirty(invited, chosen);
    const enterNow = (mod = false) => shareEnterAction({ query: q.value, hasTop: !!top, dirty: dirty(), mod });
    const paintAct = (): void => {
      const toSave = enterNow() === 'save';
      save.replaceChildren(el('span', { text: inviteAdded(invited, chosen).length ? '초대' : '저장' }),
        ...(toSave ? [el('span', { class: 'pn-share-kbd pn-share-kbd--btn', 'aria-hidden': 'true', text: '↵' })] : []));   // replaceChildren 은 null 을 글자 «null» 로 붙인다 — 없는 조각은 넘기지 않는다
      save.disabled = saving || !dirty();
      hint.textContent = toSave
        ? (inviteAdded(invited, chosen).length ? '↵ 한 번 더 누르면 초대해요 · 더 부르려면 이름을 이어서 치세요.' : '↵ 를 누르면 저장해요.')
        : '';
      hint.hidden = !toSave;
    };
    //  빼기 — 만든 사람은 누구든, 그 밖의 사람은 이번에 자기가 담은 사람만(서버가 남을 빼는 저장을 403 으로 거절한다).
    const canRemove = (id: string): boolean => isOwner || !invited.includes(id);
    const drawChips = (): void => {
      chips.replaceChildren(...(chosen.size
        ? [...chosen].map((id) => {
            const nm = memberName(id);
            return el('span', { class: 'pn-share-chip' },
              personFace(id, 'pn-share-face', nm), el('span', { text: nm }),
              canRemove(id)
                ? el('button', { class: 'pn-share-x', type: 'button', title: nm + ' 빼기', 'aria-label': nm + ' 빼기',
                    onclick: () => { chosen.delete(id); drawChips(); drawList(); q.focus(); } }, el('span', { text: '×' }))
                : null);
          })
        : [el('span', { class: 'pn-share-fine', text: '아직 아무도 없어요 — 나만 보는 프로젝트예요.' })]));
    };
    const pick = (m: MemberRow): void => { chosen.add(m.id); q.value = ''; drawChips(); drawList(); q.focus(); };
    const drawList = (): void => {
      const kw = q.value.trim().toLowerCase();
      const cand = members.filter((m) => m.id !== ownerId && !chosen.has(m.id)
        && (!kw || nameOf(m).toLowerCase().includes(kw) || m.id.toLowerCase().includes(kw)));
      const shown = cand.slice(0, 8);
      top = shown[0] || null;
      const pickMark = enterNow() === 'pick';
      list.replaceChildren(...(shown.length
        ? shown.map((m, i) => el('button', { class: 'pn-share-row' + (i === 0 && pickMark ? ' on' : ''), type: 'button', onclick: () => pick(m) },
            personFace(m.id, 'pn-share-face', nameOf(m)), el('span', { text: nameOf(m) }),
            i === 0 && pickMark ? el('span', { class: 'pn-share-kbd', text: '↵' }) : null))
        : [el('p', { class: 'pn-share-fine', text: kw ? '그런 사람이 없어요.' : '부를 사람이 더 없어요.' })]));
      paintAct();
    };
    q.addEventListener('input', drawList);
    q.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing) return;   // 한글 조합 중의 Enter 는 확정이다(share-session.ts 와 같은 가드)
      e.preventDefault();
      const act = enterNow(e.metaKey || e.ctrlKey);
      if (act === 'pick' && top) pick(top);
      else if (act === 'save' && !save.disabled) save.click();
    });
    save.onclick = async (): Promise<void> => {
      if (save.disabled || saving) return;
      saving = true; save.disabled = true;
      const next = [...chosen];
      const added = inviteAdded(invited, next);
      try {
        const r: any = await api('/api/ui/v6/projects/' + p.id + '/members', { method: 'POST', body: JSON.stringify({ members: next }) });
        invited = Array.isArray(r?.member_ids) ? r.member_ids.map(String).filter((id: string) => id !== ownerId) : next;
        //  부른 쪽이 든 행도 새 명단으로 — 다시 그릴 때(문패 꼬리표 등) 옛 명단으로 «나만» 이라고 말하지 않게.
        p.members = invited.map((id) => ({ member_id: id, display_name: memberName(id) }));
        const names = added.map(memberName);
        const sent = Number(r && r.notified) > 0;
        toast(added.length
          ? `${names.length > 2 ? names.slice(0, 2).join(', ') + ` 외 ${names.length - 2}명` : names.join(', ')}님을 초대했어요` + (sent ? ' — 알림을 보냈어요.' : '.')
          : invited.length ? `${invited.length}명이 이 프로젝트를 함께 봐요.` : '이제 나만 보는 프로젝트예요.');
        close(); done();
      } catch (e: any) { saving = false; paintAct(); toast('초대 실패 — ' + (e?.message || '알 수 없는 오류'), true); }
    };
    drawChips(); drawList();
    setTimeout(() => { if (q.isConnected) q.focus(); }, 0);
    //  초대받은 사람만 나간다(세션 [공유] 의 «이 세션에서 나가기» 와 같은 자리 · 만든 사람에게는 없다). 명단에서 나 하나만 뺀다 —
    //   서버는 남을 빼는 저장을 거절하고 자기만 빼는 저장은 받는다(src/v6/project-invite.ts memberEditRefusal).
    const leaveHost = el('div', { class: 'pj-share-leave' }) as HTMLElement;
    const leaveLink = (): HTMLElement => el('button', { class: 'btn btn-ghost btn-sm pn-share-leave', type: 'button', text: '이 프로젝트에서 나가기', onclick: () => {
      const go = el('button', { class: 'btn btn-danger btn-sm', type: 'button', text: '나가기' }) as HTMLButtonElement;
      go.onclick = async () => {
        go.disabled = true;
        try {
          await api('/api/ui/v6/projects/' + p.id + '/members', { method: 'POST', body: JSON.stringify({ members: invited.filter((id) => id !== meId) }) });
          toast('프로젝트에서 나갔어요 — 다시 보려면 만든 사람이 다시 초대해야 해요.');
          close();
          location.hash = '#/projects2';
        } catch (e: any) { go.disabled = false; toast('나가지 못했어요 — ' + (e?.message || '알 수 없는 오류'), true); }
      };
      leaveHost.replaceChildren(
        el('p', { class: 'pj-share-warn', text: '나가면 이 프로젝트가 내 목록과 검색에서 사라지고, 이 프로젝트의 세션도 더는 열 수 없어요.' }),
        el('div', { class: 'pn-share-act' },
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '취소', onclick: () => leaveHost.replaceChildren(leaveLink()) }), go));
    } });
    const canLeave = !isOwner && !!meId && invited.includes(meId);
    if (canLeave) leaveHost.append(leaveLink());
    return el('div', { class: 'pj-share-editor' },
      el('div', { class: 'pn-share-block' }, sec('함께 볼 사람'),
        ownerId ? el('div', { class: 'pn-share-people' }, el('span', { class: 'pn-share-person' },
          personFace(ownerId, 'pn-share-face', memberName(ownerId)),
          el('span', { text: memberName(ownerId) + (ownerId === meId ? ' (나)' : '') + ' · 만든 사람' }))) : null,
        chips, q, list, hint),
      fine('고른 사람만 이 프로젝트를 볼 수 있어요. 프로젝트의 세션은 세션마다 따로 초대해야 열려요.'),
      el('div', { class: 'pn-share-act' },
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '닫기', onclick: () => close() }), save),
      canLeave ? leaveHost : null);
  }

  function paint(): void {
    body.replaceChildren(...[stateBlock(), priv ? editorBlock() : null].filter(Boolean) as HTMLElement[]);
  }

  void (async () => {
    try {
      const d: any = await api('/api/ui/dash/members');
      members = ((d && d.members) || []).map((m: any) => ({ id: String(m.id), display_name: m.display_name }));
    } catch (_) { members = []; }   // 명부를 못 받아도 창은 뜬다 — 이름 자리에 id 가 나갈 뿐이다
    if (!panel.isConnected) return;
    paint();
  })();
}

export { ACCESS_LABEL_INVITE };
