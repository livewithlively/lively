// v2/switcher.ts — 좌상단 워크스페이스 스위처(#1750, 노션 문법). 사이드바 맨 위.
//  이 워크스페이스가 개인인지 팀인지 배지로 보이고, 누르면 메뉴가 뜬다:
//   · 계정 이메일 · 이 워크스페이스(활성) · 연결한 팀 워크스페이스(열기) · [팀 워크스페이스 연결](주소+토큰)
//   · 매니지드면 [다른 워크스페이스 · 새로 만들기 →](허브) · 승인 대기 중인 승격 요청(있으면 배지+승인/거절).
//  워크스페이스 1개 = 게이트웨이 1개라, '전환'은 그 게이트웨이 주소를 새 탭으로 여는 것이다(개인↔팀은 서로 다른 게이트웨이).
//  메뉴는 body 에 떠서(fixed) 사이드바 20초 재렌더에 지워지지 않는다. 데이터(연결·승격)는 **열 때** 한 번만 당긴다.
import { api, currentWorkspace, el, personFace, profileAvatar, setCurrentWorkspace, state, toast } from '../core.js';
import { inboxSection, peopleSection, type InviteForMe } from './ws-people.js';   // #1875 구성원·초대

let openPanel: HTMLElement | null = null;
function closeMenu(): void { if (openPanel) { openPanel.remove(); openPanel = null; document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); } }
function onDoc(e: MouseEvent): void { if (openPanel && !openPanel.contains(e.target as Node) && !(e.target as HTMLElement).closest('.v2-ws')) closeMenu(); }
function onKey(e: KeyboardEvent): void { if (e.key === 'Escape') closeMenu(); }

// #1875 — 인원 수가 최근에 확인된 값. status 를 부를 때마다 갱신하고, 문패는 이 값으로 배지를 그린다.
//  ⚠ 서버(kindEffective)와 **같은 식**이어야 한다 — 두 곳이 다르면 화면과 게이트가 다른 말을 한다.
let liveCount: number | null = null;
export function kindFromCount(n: number): 'personal' | 'team' { return n >= 2 ? 'team' : 'personal'; }

function ws(): { kind: 'personal' | 'team'; hub: string | null; name: string; count: number | null } {
  const m: any = (state && state.me) || {};
  const w = m.workspace || {};
  // registry(다중 워크스페이스)가 켜져 있으면 **등록부의 이름이 정답**이다 — org_name 을 쓰면
  //  버튼("Lively")과 메뉴 목록("라이블리")이 같은 워크스페이스를 두 이름으로 부른다(2026-08-19 실측 신고).
  const reg: any = m.workspace_registry || {};
  // 이름의 출처: registry(다중 ws) 활성 → 등록부 이름 / 아니면 **org_profile 이름**(모두가 같은 값을 본다).
  //  ⚠ org_name 이 비었을 때 **m.email 로 폴백하지 않는다**(#1875, 2026-08-27 원준 신고) — 이메일은 '지금 보는
  //   사람'의 것이라, 같은 팀 워크스페이스가 사람마다 다른 이름(각자 자기 이메일)으로 보였다. 워크스페이스 이름은
  //   워크스페이스의 것이지 개인의 것이 아니다. 공유 이름이 없으면 중립 라벨로 떨어진다(매니지드 프로비저닝·
  //   이름 동기가 org_name 을 채우면 이 폴백은 안 닿는다). 종류(personal/team)는 아래에서 정해지므로 여기선 못 쓴다.
  const name = (reg.active && reg.name) ? String(reg.name) : String(m.org_name || '워크스페이스');
  // ★ 종류는 **저장된 값이 아니라 지금 몇 명인가**에서 나온다(#1875). 컬럼(reg.kind)은 만들 때의 의도라
  //  사람이 들고 나면 조용히 거짓이 된다 — 혼자 남은 '팀', 둘이 쓰는 '개인'이 거기서 생긴다.
  //  인원을 아직 못 받았을 때만(첫 그리기) 컬럼으로 임시 표시하고, status 가 오면 바로 정정된다.
  const n = liveCount ?? (typeof reg.member_count === 'number' ? reg.member_count : null);
  const kind = n !== null ? kindFromCount(n)
    : (reg.active && reg.kind) ? (reg.kind === 'personal' ? 'personal' : 'team')
    : (w.kind === 'personal' ? 'personal' : 'team');
  return { kind, hub: w.hub_url || null, name, count: n };
}

/** 문패를 다시 그리게 만드는 신호 — 인원이 바뀌면(초대 수락·구성원 제거) 배지가 즉시 따라와야 한다. */
function repaintCard(): void {
  document.dispatchEvent(new CustomEvent('lively:ws-people-changed'));
}

// 상단 노드 — **워크스페이스 문패 카드**(2026-08-20 원준, 사이드바 개편 안3의 문패 채택).
//  이력: ① 워드마크 줄 + 스위처 줄 두 줄 → 같은 글자 중복·머리 196px(실측)로 한 줄로 접음 ② 그 한 줄은
//  이름+글자배지뿐이라 '문패'가 아니라 '텍스트 라벨'로 읽혔다 — 개인↔팀 전환이 장소 이동이라는 감각이 없었고,
//  그 오인은 잘못 시키기(개인 일을 팀에)로 직결된다. 그래서 **카드로 격상**한다(노션 문법):
//   · 팀 = 조직 타일(이니셜, 둥근 사각) + 이름 + "팀 워크스페이스 · N명" + 멤버 얼굴 스택(최대 3+n)
//   · 개인 = 내 얼굴(원형) + 이름 + "개인 워크스페이스 · 나만"
//  얼굴 스택은 "여기서 하는 일은 이 사람들이 본다"를 매 순간 말한다 — 공개 범위 오인을 줄이는 가장 싼 장치.
//  누르면 종전과 같은 전환·연결 메뉴가 뜬다(기능 무변경 — #1750 메뉴 그대로).
export function switcherTop(opts?: { people?: Record<string, any>; faces?: string[] }): HTMLElement {
  const w = ws();
  const me: any = (state && state.me) || {};
  const kindText = w.kind === 'personal' ? '개인' : '팀';
  const people = (opts && opts.people) || {};
  const ids = Object.keys(people);
  // 부제도 같은 값에서 — 명부 인원(count)이 있으면 그걸 쓰고, 아직 없으면 얼굴 수로 폴백한다.
  //  두 숫자가 다르면 명부가 정답이다(얼굴은 '세션을 가진 사람'이라 명부의 부분집합).
  const shown = w.count ?? (ids.length || null);
  const sub = w.kind === 'personal' ? '개인 워크스페이스 · 나만'
    : `팀 워크스페이스${shown ? ' · ' + shown + '명' : ''}`;
  // 아바타 — 개인은 내 얼굴(계정 아바타 그대로), 팀은 조직 이니셜 타일. 팀 로고 이미지는 아직 없다(있으면 여기).
  const face = workspaceFace(w, 'v2-wscard-big');
  // 팀 얼굴 스택 — **세션을 가진 사람들**(호출자가 추린 실재 협업자, 나 먼저) 최대 3명 + 나머지는 숫자.
  //  멤버 명부를 그대로 쓰면 더미·테스트 계정이 먼저 잡힌다(dev 실측) — 얼굴은 '지금 여기서 일하는 사람'이어야 맞다.
  const pool = (opts && opts.faces && opts.faces.length ? opts.faces : ids);
  const faceIds = w.kind === 'team' ? [String(me.userId || ''), ...pool.filter((x) => x !== String(me.userId || ''))].filter((x) => people[x]).slice(0, 3) : [];
  const more = w.kind === 'team' ? Math.max(0, ids.length - faceIds.length) : 0;
  const btn = el('button', { class: 'v2-ws v2-wscard', type: 'button', 'aria-haspopup': 'menu', title: `${w.name} · ${kindText} 워크스페이스 — 누르면 전환·연결` },
    face,
    el('span', { class: 'v2-wscard-tt' }, el('b', { text: w.name }), el('span', { text: sub })),
    faceIds.length ? el('span', { class: 'v2-wscard-faces', 'aria-hidden': 'true' },
      ...faceIds.map((id) => personFace(id, 'v2-wscard-face', String(people[id]?.display_name || id))),
      more ? el('i', { class: 'v2-wscard-more', text: '+' + more }) : null) : null,
    el('span', { class: 'v2-ws-car', 'aria-hidden': 'true', text: '▾' })) as HTMLButtonElement;
  btn.onclick = (e) => { e.preventDefault(); openWorkspaceMenu(btn); };
  return el('div', { class: 'v2-side-top' }, btn);
}

function sectionLabel(text: string): HTMLElement { return el('div', { class: 'v2-ws-sec', text }); }

async function openMenu(anchor: HTMLElement): Promise<void> {
  closeMenu();
  const w = ws();
  const panel = el('div', { class: 'v2-ws-menu', role: 'menu' }) as HTMLElement;
  const email = String((state.me && state.me.email) || '');
  panel.append(email ? el('div', { class: 'v2-ws-acct', text: email }) : null);

  // ── 이 게이트웨이 안의 워크스페이스 목록(#1750 S1, 셀프호스트 registry 모드) — 전환·만들기·관리. ──
  //  '올릴 팀'(다른 게이트웨이, 새 탭)과 축이 다르다: 이 목록은 **같은 게이트웨이의 다른 워크스페이스**라
  //  전환 = 헤더 선택 + 리로드다. registry 가 아니면(단일·매니지드) 지금 것 한 줄만 — 종전 그대로.
  //  ⚠ registry 가 켜져 있으면 지금 워크스페이스를 **따로 한 줄 더 그리지 않는다** — 목록 안의 ✓ 가 그 역할이다.
  //   (org_profile 이름과 registry 이름이 다를 수 있어, 두 줄로 그리면 같은 것이 다른 이름으로 두 번 보인다 — 실측 혼란.)
  const reg: any = ((state.me as any) && (state.me as any).workspace_registry) || {};
  if (reg.active) {
    const mineWrap = el('div', { class: 'v2-ws-team' }, sectionLabel('워크스페이스'), el('p', { class: 'v2-ws-loading', text: '불러오는 중…' }));
    panel.append(mineWrap);
    const createForm = el('div', { class: 'v2-ws-linkform', hidden: true }) as HTMLElement;
    panel.append(
      el('button', { class: 'v2-ws-item add', type: 'button', text: '＋ 워크스페이스 만들기', onclick: () => { createForm.hidden = !createForm.hidden; if (!createForm.hidden) (createForm.querySelector('input') as HTMLInputElement)?.focus(); } }),
      createForm);
    buildCreateForm(createForm);
    void refreshMine(mineWrap);
  } else {
    // registry 비활성 — 지금 워크스페이스 한 줄만 그린다(전환할 목록 자체가 없다).
    panel.append(
      sectionLabel('워크스페이스'),
      el('div', { class: 'v2-ws-cur' },
        el('span', { class: 'v2-ws-badge ' + w.kind, text: w.kind === 'personal' ? '개인' : '팀' }),
        el('span', { class: 'v2-ws-name', text: w.name }),
        // (registry 비활성 — 명부 축이 없으므로 인원을 적지 않는다)
        el('span', { class: 'v2-ws-check', 'aria-hidden': 'true', text: '✓ 지금 여기' })));
    // 비활성(= 부팅 자동 활성화 대기/실패 또는 매니지드) — **조용히 숨기지 않는다.** 만들기 섹션이
    //  없는 이유를 화면이 답하지 못하면 "기능이 없다"로 읽힌다. 매니지드(mode=managed)는 허브 링크가
    //  이미 그 답이라 아무것도 더하지 않고, 셀프호스트 single 만 진단 한 줄을 붙인다(admin 은 실패 사유까지).
    const diagSlot = el('div');
    panel.append(diagSlot);
    void (async () => {
      try {
        const d: any = await api('/api/ui/me/workspaces');
        if (!openPanel || d?.mode !== 'single') return;
        diagSlot.append(el('p', { class: 'v2-ws-empty', text: d.activation_error
          ? '다중 워크스페이스 자동 활성화 실패 — ' + d.activation_error
          : '다중 워크스페이스 준비 중이에요(부팅 자동 활성화). 계속 안 되면 관리자 로그를 확인하세요.' }));
      } catch (_) { /* 진단 실패는 침묵 — 메뉴 본기능과 무관 */ }
    })();
  }

  // ── 올릴 팀 연결(다른 게이트웨이의 팀, 새 탭) — **개인 워크스페이스에서만** 뜬다.
  //  이 축은 "개인에서 만든 지식·프로젝트를 어느 팀으로 올릴 것인가"(#1750 승격)라서, 이미 팀 워크스페이스에
  //  있는 사람에게 "연결한 팀이 없어요"라고 말하는 건 헛소리다(실측: 팀 안에서 그 문장을 보고 이해가 안 간다는
  //  피드백). 팀에서는 통째로 숨기되, 이미 연결해 둔 게 있으면(데이터가 있으면) 보여서 관리는 할 수 있게 한다.
  const teamSection = el('div', { hidden: true }) as HTMLElement;
  const teamWrap = el('div', { class: 'v2-ws-team' }, sectionLabel('개인의 것을 올릴 팀'), el('p', { class: 'v2-ws-loading', text: '불러오는 중…' }));
  const linkForm = el('div', { class: 'v2-ws-linkform', hidden: true }) as HTMLElement;
  teamSection.append(teamWrap,
    el('button', { class: 'v2-ws-item add', type: 'button', text: '＋ 팀 워크스페이스 연결', onclick: () => { linkForm.hidden = !linkForm.hidden; if (!linkForm.hidden) (linkForm.querySelector('input') as HTMLInputElement)?.focus(); } }),
    linkForm);
  panel.append(teamSection);
  buildLinkForm(linkForm, () => refreshTeam(teamWrap));

  if (w.hub) panel.append(el('a', { class: 'v2-ws-item', href: w.hub, target: '_blank', rel: 'noopener', text: '다른 워크스페이스 · 새로 만들기 →' }));

  // #1875 — 나에게 온 초대. 제일 위에 온다: 내가 결정해 줘야 다른 사람이 기다림을 멈춘다.
  const inboxWrap = el('div', { class: 'v2-ws-inbox-slot' });
  panel.prepend(inboxWrap);
  void refreshInbox(inboxWrap);

  // #1875 — 이 워크스페이스의 구성원 · 초대. primary 는 명부가 없어 서버가 400 을 주므로 아예 걸지 않는다.
  const curSlug = currentWorkspace() || 'primary';
  if (curSlug !== 'primary') {
    panel.append(peopleSection(curSlug, () => { void refreshStatusCount(); repaintCard(); }));
  }

  const promoWrap = el('div', { class: 'v2-ws-promos' });
  panel.append(promoWrap);

  // 위치 — 버튼 아래 왼쪽 정렬. 화면을 벗어나면 위로.
  const r = anchor.getBoundingClientRect();
  panel.style.position = 'fixed';
  panel.style.left = Math.max(8, r.left) + 'px';
  panel.style.top = (r.bottom + 6) + 'px';
  panel.style.minWidth = Math.max(240, r.width) + 'px';
  document.body.append(panel);
  openPanel = panel;
  setTimeout(() => { document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true); }, 0);

  void refreshTeam(teamWrap).then((n) => { if (openPanel === panel && (w.kind === 'personal' || n > 0)) teamSection.hidden = false; });
  void refreshPromos(promoWrap);
}

// ── #1875 인원 수 · 나에게 온 초대 ─────────────────────────────────────────

/** 지금 워크스페이스의 명부 인원을 받아 문패 배지를 정정한다. 메뉴를 열지 않아도 부팅 때 한 번 돈다. */
export async function refreshStatusCount(): Promise<void> {
  try {
    const d: any = await api('/api/ui/me/workspaces');
    const cur = currentWorkspace() || 'primary';
    const row = (d?.workspaces || []).find((w: any) => w.slug === cur || (w.is_primary && cur === 'primary'));
    // primary 는 명부를 쓰지 않는다(박스 로그인 = 접근) — 서버가 member_count:null 을 준다. 배지는 종전대로.
    if (row && typeof row.member_count === 'number') { liveCount = row.member_count; repaintCard(); }
  } catch (_) { /* 배지 정정 실패는 침묵 — 종전 표시가 남는다 */ }
}

async function refreshInbox(wrap: HTMLElement): Promise<void> {
  try {
    const d: any = await api('/api/ui/me/workspaces');
    const list: InviteForMe[] = (d && d.invites_for_me) || [];
    const sec = inboxSection(list, (accepted) => {
      if (!accepted) { void refreshInbox(wrap); return; }
      // 수락했으면 그 워크스페이스로 간다 — 들어왔다고 말해 놓고 원래 자리에 두면 사람이 길을 잃는다.
      switchTo(accepted.slug);
    });
    wrap.replaceChildren(...(sec ? [sec] : []));
  } catch (_) { wrap.replaceChildren(); }
}

// ── 내 워크스페이스(registry) — 전환·이름변경·보관 ──────────────────────────
async function refreshMine(wrap: HTMLElement): Promise<void> {
  try {
    const d: any = await api('/api/ui/me/workspaces');
    const rows: any[] = (d && d.workspaces) || [];
    const cur = currentWorkspace() || 'primary';
    wrap.replaceChildren(sectionLabel('워크스페이스'),
      ...(rows.length ? rows.map((w) => mineRow(w, w.slug === cur || (w.is_primary && cur === 'primary'), wrap))
        : [el('p', { class: 'v2-ws-empty', text: '목록을 불러오지 못했어요.' })]));
  } catch (_e) {
    wrap.replaceChildren(sectionLabel('워크스페이스'), el('p', { class: 'v2-ws-empty', text: '목록을 불러오지 못했어요.' }));
  }
}

// ── 워크스페이스 얼굴 — **단 하나의 출처**(#1875, 원준 2026-08-26 "왜 서로 다른 색이 있지 … 같은 데에서 갖다써야 되는데"). ──
//  종전엔 이 얼굴을 네 자리(문패 카드·타일·레일 스택·팝오버 행)에서 제각각 그렸다: 개인이면서 '지금 것'일 때만
//  내 아바타(내 색)를 쓰고, 그 밖엔 **색 없는 검은 사각**(CSS var(--ink))으로 떨어졌다. 그래서 같은 개인
//  워크스페이스가 지금 것일 땐 하늘색, 목록의 한 줄일 땐 검정 — 두 색으로 보였다.
//  ★ 개인 워크스페이스는 **소유자만 본다**(#1750) — 내 목록에 있는 개인 ws 는 전부 내 것이라 늘 내 얼굴·내 색이다.
//   팀·primary 는 이니셜 타일(어두운 문패). 색은 CSS(.v2-wscard-big)가 준다.
export function workspaceFace(w: { name: string; kind: string }, cls: string): HTMLElement {
  const me: any = (state && state.me) || {};
  if (w.kind === 'personal') return profileAvatar(me.avatar, w.name, me.userId, cls + ' round', { char: me.avatar_char, color: me.avatar_color });
  return el('span', { class: cls, text: (w.name || '?').trim().slice(0, 1) });
}

// ── 레일(#2016)에서 쓰는 출구 셋 ────────────────────────────────────────────
//  좌측 레일이 접혀 있을 때 문패는 **타일 하나**로 서고, 워크스페이스가 여럿이면 그 타일이 세로로 쌓인다.
//  그 셋 다 이 모듈이 이미 갖고 있던 것(메뉴·전환·목록)을 밖으로 여는 것뿐이다 — 전환 규약을 두 벌로 두지 않는다.

/** 접힌 레일의 문패 = 조직 이니셜(팀) 또는 내 얼굴(개인) 타일. 누르면 종전 전환 메뉴가 그대로 뜬다. */
export function switcherTile(): HTMLElement {
  const w = ws();
  const kindText = w.kind === 'personal' ? '개인' : '팀';
  const face = workspaceFace(w, 'v2-wscard-big');
  const btn = el('button', { class: 'v2-ws v2-rail-tile', type: 'button', 'aria-haspopup': 'menu',
    title: `${w.name} · ${kindText} 워크스페이스 — 누르면 전환·연결` }, face) as HTMLButtonElement;
  btn.onclick = (e) => { e.preventDefault(); openWorkspaceMenu(btn); };
  return btn;
}

/** 레일이 접혀 있을 때 워크스페이스 **이름**이 서는 자리 = 사이드바 머리(슬랙의 「HonestAI ▾」 그 자리).
 *  펼친 레일에는 문패 카드가 있으므로 그때는 그리지 않는다 — 같은 것을 두 자리에 두지 않는다. */
export function switcherName(): HTMLElement {
  const w = ws();
  const kindText = w.kind === 'personal' ? '개인' : '팀';
  const btn = el('button', { class: 'v2-ws v2-side-wsn', type: 'button', 'aria-haspopup': 'menu',
    title: `${w.name} · ${kindText} 워크스페이스 — 누르면 전환·연결` },
    el('span', { class: 'v2-side-wsn-t', text: w.name }),
    el('span', { class: 'v2-ws-car', 'aria-hidden': 'true', text: '▾' })) as HTMLButtonElement;
  btn.onclick = (e) => { e.preventDefault(); openWorkspaceMenu(btn); };
  return btn;
}

/** 이 게이트웨이의 워크스페이스 목록. registry 가 꺼져 있으면 빈 배열(전환할 목록 자체가 없다). */
export async function listWorkspaces(): Promise<Array<{ slug: string; name: string; kind: string; is_primary?: boolean; member_count?: number | null; kind_effective?: string; enter_url?: string; id?: string; tenant_state?: string | null; is_current?: boolean }>> {
  if (!registryActive()) return [];
  try {
    const d: any = await api('/api/ui/me/workspaces');
    //  #1875 — 같은 응답이 「나에게 온 초대」도 싣고 온다. 그 하나를 위해 같은 주소를 두 번 부르지 않는다.
    lastInvites = ((d && d.invites_for_me) || []) as InviteForMe[];
    return ((d && d.workspaces) || []) as Array<{ slug: string; name: string; kind: string; is_primary?: boolean; member_count?: number | null; kind_effective?: string; enter_url?: string; id?: string; tenant_state?: string | null; is_current?: boolean }>;
  } catch (_) { return []; }
}

// #1875 — 마지막으로 받아 둔 「나에게 온 초대」. 목록을 그리는 쪽(레일 팝오버)이 같은 조회를 또 하지 않게
//  여기 남긴다. **비어 있음이 곧 '없음'은 아니다** — 아직 한 번도 안 불렀을 수 있으므로, 부르는 쪽이
//  listWorkspaces() 를 먼저 await 한 뒤 읽는다.
let lastInvites: InviteForMe[] = [];
export function myInvites(): InviteForMe[] { return lastInvites; }

/** 지금 워크스페이스의 slug('primary' 폴백) — 레일 타일 스택의 활성 표시가 이걸로 판정한다. */
export function activeWorkspaceSlug(): string { return currentWorkspace() || 'primary'; }

/** 그 워크스페이스로 전환(헤더 선택 + 리로드). 메뉴 안의 전환과 **같은 경로**다. */
/**
 * 그 워크스페이스로 간다.
 *
 * ★ 매니지드에서는 **헤더 전환이 성립하지 않는다** — 워크스페이스 1개 = 테넌트 1개 = 주소 1개라(1:1),
 *  같은 게이트웨이에 헤더만 바꿔 봐야 그 워크스페이스가 거기 없다. 그래서 계정 서버가 준 `enter_url` 로
 *  **이동**한다(그 주소가 로그인까지 태워 준다). 셀프호스트(registry)는 종전대로 헤더+새로고침.
 */
export function switchWorkspace(slug: string, enterUrl?: string | null): void {
  if (enterUrl) { window.location.assign(enterUrl); return; }
  switchTo(slug);
}

/** 지금 워크스페이스의 이름·종류 — 레일의 스택 타일·팝오버가 쓴다. */
export function workspaceInfo(): { kind: 'personal' | 'team'; hub: string | null; name: string } { return ws(); }

/** 종전 전환·만들기·연결 메뉴를 그대로 연다 — 레일 팝오버의 [＋ 워크스페이스 추가]가 여기로 온다(폼을 두 벌 만들지 않는다). */
// ── 워크스페이스 메뉴는 **하나**다(#1875, 원준 2026-08-26 "고르는 칸이 두 번 존재해야 할 이유가 있을까").
//  레일(rail.ts)이 있으면 그쪽 팝오버가 유일한 메뉴이고, 아래 openMenu 는 레일이 없는 임베더용 폴백일 뿐이다.
//  레일이 마운트될 때 자기 팝오버를 여기 등록하고, 문패·사이드바 머리·타일이 무엇을 눌러도 같은 것이 뜬다.
let menuOpener: ((anchor: HTMLElement) => void) | null = null;
export function registerWorkspaceMenu(fn: (anchor: HTMLElement) => void): void { menuOpener = fn; }
export function openWorkspaceMenu(anchor: HTMLElement): void {
  if (menuOpener) { menuOpener(anchor); return; }
  if (openPanel) { closeMenu(); return; }
  void openMenu(anchor);
}

/**
 * 이 리로드가 «워크스페이스 전환»이라고 부팅부에 알리는 표식(#2171).
 *
 * 전환은 `location.reload()` 를 거치므로(아래 switchTo) **부팅 판정을 처음부터 다시 탄다.** 그런데
 *  옮겨 간 워크스페이스에는 그 사람의 흔적이 0이라(거기서 MCP 를 부른 적도, 세션을 연 적도 없다)
 *  코어의 «흔적 없으면 처음 오는 사람» 판정이 참이 되어 **전환할 때마다 처음 설정이 떴다**
 *  (원준님 신고 2026-08-27, 데스크톱 앱에서 워크스페이스 전환 중).
 *
 * 전환은 «처음 오는 것»이 아니라 «있던 곳으로 가는 것»이다 — 그 자리는 언제나 홈이어야 한다.
 *  처음 설정이 필요한 사람에게는 홈의 «처음 설정 이어서 하기»(me.welcome_pending)가 남는다.
 *
 * sessionStorage 인 이유: 이 표식은 **딱 다음 부팅 한 번**만 살아야 한다. localStorage 에 두면 지우기
 *  전까지 자동 진입이 영영 죽고, 그러면 새로 온 사람이 처음 설정을 못 본다.
 *
 * ★ #2230 — 표식을 읽는 자리가 하나 더 늘었다. 아래 `location.hash = '#/'` 만으로는 «도착지는 홈»이
 *  성립하지 않았다: 셸은 `#/` 를 딥링크로 치지 않아서, 그 워크스페이스에 저장된 **열린 탭**이 복원되며
 *  마지막에 보던 세션이 그대로 다시 떴다(원준님 신고 2026-08-27 "전환하면 맨 위 세션이 떠 있다").
 *  그래서 셸(main.ts bootV2)이 이 표식을 보고 착지 탭과 레일 구역까지 홈으로 되돌린다.
 */
export const WS_SWITCH_KEY = 'lively_ws_switching';

/**
 * @param landing 도착해서 열 화면. 기본은 홈이다 — **전환의 도착지는 언제나 홈**(위 ★).
 *   방금 **만든** 워크스페이스로 갈 때만 처음 설정(`#/welcome?resume=1`)을 명시적으로 준다:
 *   그 한 번이 «워크스페이스 만드는 과정의 마지막» 이고, 그건 휴리스틱이 아니라 **만든 쪽이 가리켜야** 한다
 *   (매니지드 CP 가 첫 입장에 `?to=#/welcome` 을 싣는 것과 같은 규칙 — lvly-cloud workspaces.ts).
 */
function switchTo(slug: string, landing?: string): void {
  setCurrentWorkspace(slug === 'primary' ? '' : slug);
  try { sessionStorage.setItem(WS_SWITCH_KEY, '1'); } catch (_) { /* 프라이빗 모드 — 표식이 없으면 종전 동작 */ }
  location.hash = landing || '#/';
  location.reload(); // 화면 전체가 그 워크스페이스의 데이터로 다시 선다 — 부분 갱신은 반쪽 상태를 만든다
}

function mineRow(w: any, active: boolean, wrap: HTMLElement): HTMLElement {
  const open = el('button', { class: 'v2-ws-team-open', type: 'button', title: active ? '지금 이 워크스페이스예요' : '이 워크스페이스로 전환',
    onclick: () => { if (!active) switchTo(String(w.slug)); } },
    // #1875 — 서버가 준 파생값(kind_effective)을 그대로 쓴다. 목록과 문패가 같은 규칙을 지나가야
    //  "여기선 팀인데 저기선 개인"이 생기지 않는다. 인원도 함께 적어 판정 근거를 감추지 않는다.
    el('span', { class: 'v2-ws-badge ' + (w.kind_effective === 'team' ? 'team' : 'personal'),
      text: w.kind_effective === 'team' ? (typeof w.member_count === 'number' ? '팀 ' + w.member_count : '팀') : '개인' }),
    el('span', { class: 'v2-ws-name', text: String(w.name || w.slug) }),
    w.pending_invites ? el('span', { class: 'v2-ws-pend', title: `수락 대기 ${w.pending_invites}명`, text: '대기 ' + w.pending_invites }) : null,
    active ? el('span', { class: 'v2-ws-check', 'aria-hidden': 'true', text: '✓ 지금 여기' }) : null) as HTMLButtonElement;
  const acts: HTMLElement[] = [];
  if (w.role === 'owner' && !w.is_primary) {
    acts.push(el('button', { class: 'v2-ws-auto', type: 'button', title: '이름 변경', text: '✎', onclick: async () => {
      const name = prompt('워크스페이스 이름', String(w.name || ''));
      if (!name || !name.trim()) return;
      try { await api('/api/ui/me/workspaces/update', { method: 'POST', body: JSON.stringify({ slug: w.slug, name: name.trim() }) }); await refreshMine(wrap); }
      catch (e: any) { toast('바꾸지 못했어요 — ' + (e?.message || e), true); } } }) as HTMLElement);
    acts.push(el('button', { class: 'v2-ws-del', type: 'button', title: '보관(스위처에서 숨김 — 데이터는 남아요)', text: '✕', onclick: async () => {
      if (!confirm(`'${w.name || w.slug}' 워크스페이스를 보관할까요? 데이터는 지워지지 않아요.`)) return;
      try { await api('/api/ui/me/workspaces/delete', { method: 'POST', body: JSON.stringify({ slug: w.slug }) });
        if (active) { switchTo('primary'); return; }
        await refreshMine(wrap); }
      catch (e: any) { toast('보관하지 못했어요 — ' + (e?.message || e), true); } } }) as HTMLElement);
  }
  return el('div', { class: 'v2-ws-team-row' }, open, ...acts);
}

function buildCreateForm(form: HTMLElement): void {
  const name = el('input', { class: 'v2-ws-in', type: 'text', placeholder: '워크스페이스 이름', 'aria-label': '워크스페이스 이름' }) as HTMLInputElement;
  const kind = el('select', { class: 'v2-ws-in', 'aria-label': '종류' },
    el('option', { value: 'personal', text: '개인 — 나만 봐요' }),
    el('option', { value: 'team', text: '팀 — 사람을 초대해요' })) as HTMLSelectElement;
  const note = el('span', { class: 'v2-ws-note' });
  const go = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '만들기', onclick: async () => {
    if (!name.value.trim()) { note.textContent = '이름을 입력하세요.'; return; }
    go.setAttribute('disabled', ''); note.textContent = '만드는 중…';
    try {
      const d: any = await api('/api/ui/me/workspaces', { method: 'POST', body: JSON.stringify({ name: name.value.trim(), kind: kind.value }) });
      toast(`'${d?.workspace?.name || name.value.trim()}' 워크스페이스를 만들었어요.`);
      // 만들자마자 그 워크스페이스로 — 빈 목록 앞에서 헤매지 않게.
      //  ★ 여기가 «워크스페이스 만드는 과정의 마지막»이라 처음 설정으로 **명시적으로** 보낸다(#2171).
      //   코어의 자동 진입은 전환 부팅에서 꺼지므로(main.ts wsSwitched), 안 가리키면 아무도 못 본다.
      switchTo(String(d?.workspace?.slug || ''), '#/welcome?resume=1');
    } catch (e: any) { note.textContent = e?.message || String(e); go.removeAttribute('disabled'); }
  } });
  form.replaceChildren(name, kind, el('div', { class: 'v2-ws-formrow' }, go, note),
    el('p', { class: 'v2-ws-hint', text: '개인 워크스페이스는 관리자를 포함해 다른 사람에게 보이지 않아요. 나중에 사람을 부르면 그때 팀이 됩니다 — 지금 고르는 건 시작 모습일 뿐이에요.' }));
}

async function refreshTeam(wrap: HTMLElement): Promise<number> {
  try {
    const d: any = await api('/api/ui/me/linked-workspaces');
    const links: any[] = (d && d.links) || [];
    wrap.replaceChildren(sectionLabel('개인의 것을 올릴 팀'),
      ...(links.length ? links.map((l) => teamRow(l, wrap)) : [el('p', { class: 'v2-ws-empty', text: '여기서 만든 지식·프로젝트를 올릴 팀을 아직 연결하지 않았어요. 팀 주소와 토큰으로 연결합니다.' })]));
    return links.length;
  } catch (_e) {
    wrap.replaceChildren(sectionLabel('개인의 것을 올릴 팀'), el('p', { class: 'v2-ws-empty', text: '연결 목록을 불러오지 못했어요.' }));
    return 0;
  }
}

function teamRow(l: any, wrap: HTMLElement): HTMLElement {
  const open = el('a', { class: 'v2-ws-team-open', href: l.base_url, target: '_blank', rel: 'noopener' },
    el('span', { class: 'v2-ws-badge team', text: '팀' }),
    el('span', { class: 'v2-ws-name', text: String(l.name || l.scope_key) }),
    l.state === 'error' ? el('span', { class: 'v2-ws-err', title: l.last_error || '연결 오류', text: '!' }) : null);
  const auto = el('button', { class: 'v2-ws-auto' + (l.auto_promote ? ' on' : ''), type: 'button',
    title: l.auto_promote ? '자동 올리기 켜짐 — AI 승격을 바로 반영합니다(눌러서 끔)' : '자동 올리기 꺼짐 — AI 승격은 승인 대기(눌러서 켬)',
    text: l.auto_promote ? '자동 ✓' : '자동',
    onclick: async () => {
      try { await api('/api/ui/me/linked-workspaces', { method: 'POST', body: JSON.stringify({ url: l.base_url, auto_promote: !l.auto_promote }) }); await refreshTeam(wrap); }
      catch (e: any) { toast('바꾸지 못했어요 — ' + (e?.message || e), true); } } });
  const del = el('button', { class: 'v2-ws-del', type: 'button', title: '연결 해제', text: '✕',
    onclick: async () => { try { await api('/api/ui/me/linked-workspaces/remove', { method: 'POST', body: JSON.stringify({ scope_key: l.scope_key }) }); await refreshTeam(wrap); } catch (e: any) { toast('해제하지 못했어요 — ' + (e?.message || e), true); } } });
  return el('div', { class: 'v2-ws-team-row' }, open, auto, del);
}

function buildLinkForm(form: HTMLElement, onDone: () => void): void {
  const url = el('input', { class: 'v2-ws-in', type: 'url', placeholder: '팀 워크스페이스 주소 (https://team…)', 'aria-label': '워크스페이스 주소' }) as HTMLInputElement;
  const tok = el('input', { class: 'v2-ws-in', type: 'text', placeholder: '그 워크스페이스에서 발급한 내 토큰 (lvk_…)', 'aria-label': '토큰', autocomplete: 'off' }) as HTMLInputElement;
  const note = el('span', { class: 'v2-ws-note' });
  const go = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '연결', onclick: async () => {
    if (!url.value.trim() || !tok.value.trim()) { note.textContent = '주소와 토큰을 모두 입력하세요.'; return; }
    go.setAttribute('disabled', ''); note.textContent = '연결 확인 중…';
    try { const d: any = await api('/api/ui/me/linked-workspaces', { method: 'POST', body: JSON.stringify({ url: url.value.trim(), token: tok.value.trim() }) });
      toast(`'${d?.link?.name || '팀 워크스페이스'}' 에 연결했어요.`); url.value = ''; tok.value = ''; form.hidden = true; onDone(); }
    catch (e: any) { note.textContent = e?.message || String(e); }
    finally { go.removeAttribute('disabled'); } } });
  form.replaceChildren(url, tok, el('div', { class: 'v2-ws-formrow' }, go, note),
    el('p', { class: 'v2-ws-hint', text: '팀 워크스페이스에서 [내 토큰 발급](memory·context 스코프)으로 만든 토큰을 붙여넣으세요. 그 토큰으로만 올립니다.' }));
}

async function refreshPromos(wrap: HTMLElement): Promise<void> {
  try {
    const d: any = await api('/api/ui/me/promotions?state=pending');
    const ps: any[] = (d && d.promotions) || [];
    if (!ps.length) { wrap.replaceChildren(); return; }
    wrap.replaceChildren(sectionLabel(`팀으로 올릴 것 · 승인 대기 ${ps.length}`),
      ...ps.map((p) => promoRow(p, wrap)));
  } catch (e: any) { wrap.replaceChildren(); }
}

function promoRow(p: any, wrap: HTMLElement): HTMLElement {
  const resolve = async (decision: 'approve' | 'reject') => {
    try { const d: any = await api('/api/ui/me/promotions/' + p.id + '/resolve', { method: 'POST', body: JSON.stringify({ decision }) });
      const st = d?.promotion?.state;
      toast(decision === 'reject' ? '올리기를 취소했어요.' : st === 'done' ? '팀 워크스페이스에 올렸어요.' : st === 'failed' ? ('올리지 못했어요 — ' + (d?.promotion?.error || '')) : '처리했어요.', st === 'failed');
      await refreshPromos(wrap); }
    catch (e: any) { toast('처리하지 못했어요 — ' + (e?.message || e), true); } };
  return el('div', { class: 'v2-ws-promo' },
    el('div', { class: 'v2-ws-promo-main' },
      el('span', { class: 'v2-ws-promo-kind', text: p.kind === 'knowledge' ? '지식' : '프로젝트' }),
      el('span', { class: 'v2-ws-promo-title', text: String(p.title || p.target_ref) })),
    el('div', { class: 'v2-ws-promo-acts' },
      el('button', { class: 'btn btn-primary btn-xs', type: 'button', text: '올리기', onclick: () => resolve('approve') }),
      el('button', { class: 'btn btn-ghost btn-xs', type: 'button', text: '취소', onclick: () => resolve('reject') })));
}


// ── #1875 — 레일 팝오버(rail.ts)가 쓰는 워크스페이스 조작. 옛 메뉴(openMenu)의 인라인 fetch 를 꺼낸 것이다.
//  화면은 rail.ts 가 새 문법으로 그리고, 서버와 말하는 법은 여기 한 곳에 둔다(주소·본문이 두 벌로 갈리지 않게).
export async function createWorkspace(name: string, kind: 'personal' | 'team'): Promise<{ slug: string; name: string; enter_url?: string }> {
  const d: any = await api('/api/ui/me/workspaces', { method: 'POST', body: JSON.stringify({ name, kind }) });
  //  enter_url 은 매니지드에서만 온다(새 워크스페이스 = 새 테넌트 = 새 주소). 셀프호스트는 undefined 라
  //  호출부가 종전대로 헤더 전환을 탄다 — 한 함수가 두 배포를 덮는다.
  return { slug: String(d?.workspace?.slug || ''), name: String(d?.workspace?.name || name), enter_url: d?.workspace?.enter_url || undefined };
}
export async function renameWorkspace(slug: string, name: string): Promise<void> {
  await api('/api/ui/me/workspaces/update', { method: 'POST', body: JSON.stringify({ slug, name }) });
}
export async function archiveWorkspace(slug: string): Promise<void> {
  await api('/api/ui/me/workspaces/delete', { method: 'POST', body: JSON.stringify({ slug }) });
}
/** 나가기(#1875 D5') — 나 하나만 빠진다. 보관과 **서로 배타**다(인원 2명 이상이면 보관이 막히고 이것만 열린다). */
export async function leaveWorkspace(slug: string): Promise<void> {
  await api('/api/ui/me/workspaces/leave', { method: 'POST', body: JSON.stringify({ slug }) });
}
/** 연결한 팀(다른 게이트웨이, 승격 경로 #1750). */
export async function linkedTeams(): Promise<any[]> {
  try { const d: any = await api('/api/ui/me/linked-workspaces'); return (d && d.links) || []; } catch (_) { return []; }
}
export async function linkTeam(url: string, token: string): Promise<{ name: string }> {
  const d: any = await api('/api/ui/me/linked-workspaces', { method: 'POST', body: JSON.stringify({ url, token }) });
  return { name: String(d?.link?.name || '팀 워크스페이스') };
}
export async function setAutoPromote(url: string, on: boolean): Promise<void> {
  await api('/api/ui/me/linked-workspaces', { method: 'POST', body: JSON.stringify({ url, auto_promote: on }) });
}
export async function unlinkTeam(scopeKey: string): Promise<void> {
  await api('/api/ui/me/linked-workspaces/remove', { method: 'POST', body: JSON.stringify({ scope_key: scopeKey }) });
}
export async function pendingPromotions(): Promise<any[]> {
  try { const d: any = await api('/api/ui/me/promotions?state=pending'); return (d && d.promotions) || []; } catch (_) { return []; }
}
/** 승격 처리 — 결과 상태(done·failed·…)와 오류를 그대로 돌려준다(문구는 화면이 정한다). */
export async function resolvePromotion(id: string | number, decision: 'approve' | 'reject'): Promise<{ state: string; error?: string }> {
  const d: any = await api('/api/ui/me/promotions/' + id + '/resolve', { method: 'POST', body: JSON.stringify({ decision }) });
  return { state: String(d?.promotion?.state || ''), error: d?.promotion?.error };
}
/**
 * 여기서 워크스페이스를 **만들고 고를 수 있는가**.
 *
 * 축이 둘이다(#2188) — `active` 는 이 박스의 등록부가 도는 것(셀프호스트 다중), `managed` 는 계정 서버
 *  (app.lvly.io)가 대신 해 주는 것(매니지드). 화면 입장에서는 **둘 다 "여기서 된다"** 이므로 하나로 본다.
 *  종전엔 `active` 만 봐서 매니지드가 전부 꺼진 것으로 읽혔고, 그래서 목록도 만들기도 없이
 *  "그건 app.lvly.io 에서 하세요" 링크만 남았다 — 원준 신고 *"????? 이건 왜..?"*.
 */
export function registryActive(): boolean {
  const reg: any = ((state.me as any) && (state.me as any).workspace_registry) || {};
  return !!reg.active || !!reg.managed;
}
/** 매니지드인가 — 전환이 **헤더가 아니라 이동**이라는 뜻이다(워크스페이스마다 주소가 다르다). */
export function managedWorkspaces(): boolean {
  const reg: any = ((state.me as any) && (state.me as any).workspace_registry) || {};
  return !!reg.managed;
}
