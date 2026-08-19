// v2/switcher.ts — 좌상단 워크스페이스 스위처(#1750, 노션 문법). 사이드바 맨 위.
//  이 워크스페이스가 개인인지 팀인지 배지로 보이고, 누르면 메뉴가 뜬다:
//   · 계정 이메일 · 이 워크스페이스(활성) · 연결한 팀 워크스페이스(열기) · [팀 워크스페이스 연결](주소+토큰)
//   · 매니지드면 [다른 워크스페이스 · 새로 만들기 →](허브) · 승인 대기 중인 승격 요청(있으면 배지+승인/거절).
//  워크스페이스 1개 = 게이트웨이 1개라, '전환'은 그 게이트웨이 주소를 새 탭으로 여는 것이다(개인↔팀은 서로 다른 게이트웨이).
//  메뉴는 body 에 떠서(fixed) 사이드바 20초 재렌더에 지워지지 않는다. 데이터(연결·승격)는 **열 때** 한 번만 당긴다.
import { api, currentWorkspace, el, setCurrentWorkspace, state, toast } from '../core.js';

let openPanel: HTMLElement | null = null;
function closeMenu(): void { if (openPanel) { openPanel.remove(); openPanel = null; document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); } }
function onDoc(e: MouseEvent): void { if (openPanel && !openPanel.contains(e.target as Node) && !(e.target as HTMLElement).closest('.v2-ws')) closeMenu(); }
function onKey(e: KeyboardEvent): void { if (e.key === 'Escape') closeMenu(); }

function ws(): { kind: 'personal' | 'team'; hub: string | null; name: string } {
  const m: any = (state && state.me) || {};
  const w = m.workspace || {};
  return { kind: w.kind === 'personal' ? 'personal' : 'team', hub: w.hub_url || null, name: String(m.org_name || m.email || '내 워크스페이스') };
}

// 상단 노드 — **한 줄**: 브랜드 심볼(=홈) + 워크스페이스 스위처. side.ts 가 이걸 v2-side-top 자리에 넣는다.
//  ⚠ 예전엔 워드마크 'Lively' 줄과 스위처 줄이 **따로** 있었다. 그러면 조직 이름이 'Lively' 일 때
//   같은 글자가 세로로 두 번 나오고(실측), 목록이 시작되기 전에 196px 를 머리로 쓴다(사이드바 높이의 20%).
//   심볼이 홈을 겸하게 해 한 줄로 접었다 — 141px. 심볼에 글자를 넣지 않는 이유는 리브 아바타('L')와 겹치기 때문.
export function switcherTop(): HTMLElement {
  const w = ws();
  const kindText = w.kind === 'personal' ? '개인' : '팀';
  const btn = el('button', { class: 'v2-ws', type: 'button', 'aria-haspopup': 'menu', title: `${w.name} · ${kindText} 워크스페이스 — 누르면 전환·연결` },
    el('span', { class: 'v2-ws-badge ' + w.kind, text: kindText }),
    el('span', { class: 'v2-ws-name', text: w.name }),
    el('span', { class: 'v2-ws-car', 'aria-hidden': 'true', text: '▾' })) as HTMLButtonElement;
  btn.onclick = (e) => { e.preventDefault(); if (openPanel) { closeMenu(); return; } openMenu(btn); };
  return el('div', { class: 'v2-side-top' },
    el('a', { class: 'v2-mark', href: '#/', title: '라이블리 홈으로', 'aria-label': '홈으로', 'data-nav': 'home' },
      el('span', { class: 'v2-mark-dot', 'aria-hidden': 'true' })),
    btn);
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

function switchTo(slug: string): void {
  setCurrentWorkspace(slug === 'primary' ? '' : slug);
  location.hash = '#/';
  location.reload(); // 화면 전체가 그 워크스페이스의 데이터로 다시 선다 — 부분 갱신은 반쪽 상태를 만든다
}

function mineRow(w: any, active: boolean, wrap: HTMLElement): HTMLElement {
  const open = el('button', { class: 'v2-ws-team-open', type: 'button', title: active ? '지금 이 워크스페이스예요' : '이 워크스페이스로 전환',
    onclick: () => { if (!active) switchTo(String(w.slug)); } },
    el('span', { class: 'v2-ws-badge ' + (w.kind === 'personal' ? 'personal' : 'team'), text: w.kind === 'personal' ? '개인' : '팀' }),
    el('span', { class: 'v2-ws-name', text: String(w.name || w.slug) }),
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
      switchTo(String(d?.workspace?.slug || '')); // 만들자마자 그 워크스페이스로 — 빈 목록 앞에서 헤매지 않게
    } catch (e: any) { note.textContent = e?.message || String(e); go.removeAttribute('disabled'); }
  } });
  form.replaceChildren(name, kind, el('div', { class: 'v2-ws-formrow' }, go, note),
    el('p', { class: 'v2-ws-hint', text: '개인 워크스페이스는 관리자를 포함해 다른 사람에게 보이지 않아요. 팀은 만든 뒤 멤버를 초대할 수 있어요.' }));
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
