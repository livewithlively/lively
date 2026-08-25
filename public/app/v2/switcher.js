// v2/switcher.ts — 좌상단 워크스페이스 스위처(#1750, 노션 문법). 사이드바 맨 위.
//  이 워크스페이스가 개인인지 팀인지 배지로 보이고, 누르면 메뉴가 뜬다:
//   · 계정 이메일 · 이 워크스페이스(활성) · 연결한 팀 워크스페이스(열기) · [팀 워크스페이스 연결](주소+토큰)
//   · 매니지드면 [다른 워크스페이스 · 새로 만들기 →](허브) · 승인 대기 중인 승격 요청(있으면 배지+승인/거절).
//  워크스페이스 1개 = 게이트웨이 1개라, '전환'은 그 게이트웨이 주소를 새 탭으로 여는 것이다(개인↔팀은 서로 다른 게이트웨이).
//  메뉴는 body 에 떠서(fixed) 사이드바 20초 재렌더에 지워지지 않는다. 데이터(연결·승격)는 **열 때** 한 번만 당긴다.
import { api, currentWorkspace, el, personFace, profileAvatar, setCurrentWorkspace, state, toast } from '../core.js';
let openPanel = null;
function closeMenu() { if (openPanel) {
    openPanel.remove();
    openPanel = null;
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
} }
function onDoc(e) { if (openPanel && !openPanel.contains(e.target) && !e.target.closest('.v2-ws'))
    closeMenu(); }
function onKey(e) { if (e.key === 'Escape')
    closeMenu(); }
function ws() {
    const m = (state && state.me) || {};
    const w = m.workspace || {};
    // registry(다중 워크스페이스)가 켜져 있으면 **등록부의 이름·종류가 정답**이다 — org_name 을 쓰면
    //  버튼("Lively")과 메뉴 목록("라이블리")이 같은 워크스페이스를 두 이름으로 부른다(2026-08-19 실측 신고).
    const reg = m.workspace_registry || {};
    const name = (reg.active && reg.name) ? String(reg.name) : String(m.org_name || m.email || '내 워크스페이스');
    const kind = (reg.active && reg.kind) ? (reg.kind === 'personal' ? 'personal' : 'team') : (w.kind === 'personal' ? 'personal' : 'team');
    return { kind, hub: w.hub_url || null, name };
}
// 상단 노드 — **워크스페이스 문패 카드**(2026-08-20 원준, 사이드바 개편 안3의 문패 채택).
//  이력: ① 워드마크 줄 + 스위처 줄 두 줄 → 같은 글자 중복·머리 196px(실측)로 한 줄로 접음 ② 그 한 줄은
//  이름+글자배지뿐이라 '문패'가 아니라 '텍스트 라벨'로 읽혔다 — 개인↔팀 전환이 장소 이동이라는 감각이 없었고,
//  그 오인은 잘못 시키기(개인 일을 팀에)로 직결된다. 그래서 **카드로 격상**한다(노션 문법):
//   · 팀 = 조직 타일(이니셜, 둥근 사각) + 이름 + "팀 워크스페이스 · N명" + 멤버 얼굴 스택(최대 3+n)
//   · 개인 = 내 얼굴(원형) + 이름 + "개인 워크스페이스 · 나만"
//  얼굴 스택은 "여기서 하는 일은 이 사람들이 본다"를 매 순간 말한다 — 공개 범위 오인을 줄이는 가장 싼 장치.
//  누르면 종전과 같은 전환·연결 메뉴가 뜬다(기능 무변경 — #1750 메뉴 그대로).
export function switcherTop(opts) {
    const w = ws();
    const me = (state && state.me) || {};
    const kindText = w.kind === 'personal' ? '개인' : '팀';
    const people = (opts && opts.people) || {};
    const ids = Object.keys(people);
    const sub = w.kind === 'personal' ? '개인 워크스페이스 · 나만'
        : `팀 워크스페이스${ids.length ? ' · ' + ids.length + '명' : ''}`;
    // 아바타 — 개인은 내 얼굴(계정 아바타 그대로), 팀은 조직 이니셜 타일. 팀 로고 이미지는 아직 없다(있으면 여기).
    const face = w.kind === 'personal'
        ? profileAvatar(me.avatar, w.name, me.userId, 'v2-wscard-big round', { char: me.avatar_char, color: me.avatar_color })
        : el('span', { class: 'v2-wscard-big', text: (w.name || '?').trim().slice(0, 1) });
    // 팀 얼굴 스택 — **세션을 가진 사람들**(호출자가 추린 실재 협업자, 나 먼저) 최대 3명 + 나머지는 숫자.
    //  멤버 명부를 그대로 쓰면 더미·테스트 계정이 먼저 잡힌다(dev 실측) — 얼굴은 '지금 여기서 일하는 사람'이어야 맞다.
    const pool = (opts && opts.faces && opts.faces.length ? opts.faces : ids);
    const faceIds = w.kind === 'team' ? [String(me.userId || ''), ...pool.filter((x) => x !== String(me.userId || ''))].filter((x) => people[x]).slice(0, 3) : [];
    const more = w.kind === 'team' ? Math.max(0, ids.length - faceIds.length) : 0;
    const btn = el('button', { class: 'v2-ws v2-wscard', type: 'button', 'aria-haspopup': 'menu', title: `${w.name} · ${kindText} 워크스페이스 — 누르면 전환·연결` }, face, el('span', { class: 'v2-wscard-tt' }, el('b', { text: w.name }), el('span', { text: sub })), faceIds.length ? el('span', { class: 'v2-wscard-faces', 'aria-hidden': 'true' }, ...faceIds.map((id) => personFace(id, 'v2-wscard-face', String(people[id]?.display_name || id))), more ? el('i', { class: 'v2-wscard-more', text: '+' + more }) : null) : null, el('span', { class: 'v2-ws-car', 'aria-hidden': 'true', text: '▾' }));
    btn.onclick = (e) => { e.preventDefault(); if (openPanel) {
        closeMenu();
        return;
    } openMenu(btn); };
    return el('div', { class: 'v2-side-top' }, btn);
}
function sectionLabel(text) { return el('div', { class: 'v2-ws-sec', text }); }
async function openMenu(anchor) {
    closeMenu();
    const w = ws();
    const panel = el('div', { class: 'v2-ws-menu', role: 'menu' });
    const email = String((state.me && state.me.email) || '');
    panel.append(email ? el('div', { class: 'v2-ws-acct', text: email }) : null);
    // ── 이 게이트웨이 안의 워크스페이스 목록(#1750 S1, 셀프호스트 registry 모드) — 전환·만들기·관리. ──
    //  '올릴 팀'(다른 게이트웨이, 새 탭)과 축이 다르다: 이 목록은 **같은 게이트웨이의 다른 워크스페이스**라
    //  전환 = 헤더 선택 + 리로드다. registry 가 아니면(단일·매니지드) 지금 것 한 줄만 — 종전 그대로.
    //  ⚠ registry 가 켜져 있으면 지금 워크스페이스를 **따로 한 줄 더 그리지 않는다** — 목록 안의 ✓ 가 그 역할이다.
    //   (org_profile 이름과 registry 이름이 다를 수 있어, 두 줄로 그리면 같은 것이 다른 이름으로 두 번 보인다 — 실측 혼란.)
    const reg = (state.me && state.me.workspace_registry) || {};
    if (reg.active) {
        const mineWrap = el('div', { class: 'v2-ws-team' }, sectionLabel('워크스페이스'), el('p', { class: 'v2-ws-loading', text: '불러오는 중…' }));
        panel.append(mineWrap);
        const createForm = el('div', { class: 'v2-ws-linkform', hidden: true });
        panel.append(el('button', { class: 'v2-ws-item add', type: 'button', text: '＋ 워크스페이스 만들기', onclick: () => { createForm.hidden = !createForm.hidden; if (!createForm.hidden)
                createForm.querySelector('input')?.focus(); } }), createForm);
        buildCreateForm(createForm);
        void refreshMine(mineWrap);
    }
    else {
        // registry 비활성 — 지금 워크스페이스 한 줄만 그린다(전환할 목록 자체가 없다).
        panel.append(sectionLabel('워크스페이스'), el('div', { class: 'v2-ws-cur' }, el('span', { class: 'v2-ws-badge ' + w.kind, text: w.kind === 'personal' ? '개인' : '팀' }), el('span', { class: 'v2-ws-name', text: w.name }), el('span', { class: 'v2-ws-check', 'aria-hidden': 'true', text: '✓ 지금 여기' })));
        // 비활성(= 부팅 자동 활성화 대기/실패 또는 매니지드) — **조용히 숨기지 않는다.** 만들기 섹션이
        //  없는 이유를 화면이 답하지 못하면 "기능이 없다"로 읽힌다. 매니지드(mode=managed)는 허브 링크가
        //  이미 그 답이라 아무것도 더하지 않고, 셀프호스트 single 만 진단 한 줄을 붙인다(admin 은 실패 사유까지).
        const diagSlot = el('div');
        panel.append(diagSlot);
        void (async () => {
            try {
                const d = await api('/api/ui/me/workspaces');
                if (!openPanel || d?.mode !== 'single')
                    return;
                diagSlot.append(el('p', { class: 'v2-ws-empty', text: d.activation_error
                        ? '다중 워크스페이스 자동 활성화 실패 — ' + d.activation_error
                        : '다중 워크스페이스 준비 중이에요(부팅 자동 활성화). 계속 안 되면 관리자 로그를 확인하세요.' }));
            }
            catch (_) { /* 진단 실패는 침묵 — 메뉴 본기능과 무관 */ }
        })();
    }
    // ── 올릴 팀 연결(다른 게이트웨이의 팀, 새 탭) — **개인 워크스페이스에서만** 뜬다.
    //  이 축은 "개인에서 만든 지식·프로젝트를 어느 팀으로 올릴 것인가"(#1750 승격)라서, 이미 팀 워크스페이스에
    //  있는 사람에게 "연결한 팀이 없어요"라고 말하는 건 헛소리다(실측: 팀 안에서 그 문장을 보고 이해가 안 간다는
    //  피드백). 팀에서는 통째로 숨기되, 이미 연결해 둔 게 있으면(데이터가 있으면) 보여서 관리는 할 수 있게 한다.
    const teamSection = el('div', { hidden: true });
    const teamWrap = el('div', { class: 'v2-ws-team' }, sectionLabel('개인의 것을 올릴 팀'), el('p', { class: 'v2-ws-loading', text: '불러오는 중…' }));
    const linkForm = el('div', { class: 'v2-ws-linkform', hidden: true });
    teamSection.append(teamWrap, el('button', { class: 'v2-ws-item add', type: 'button', text: '＋ 팀 워크스페이스 연결', onclick: () => { linkForm.hidden = !linkForm.hidden; if (!linkForm.hidden)
            linkForm.querySelector('input')?.focus(); } }), linkForm);
    panel.append(teamSection);
    buildLinkForm(linkForm, () => refreshTeam(teamWrap));
    if (w.hub)
        panel.append(el('a', { class: 'v2-ws-item', href: w.hub, target: '_blank', rel: 'noopener', text: '다른 워크스페이스 · 새로 만들기 →' }));
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
    void refreshTeam(teamWrap).then((n) => { if (openPanel === panel && (w.kind === 'personal' || n > 0))
        teamSection.hidden = false; });
    void refreshPromos(promoWrap);
}
// ── 내 워크스페이스(registry) — 전환·이름변경·보관 ──────────────────────────
async function refreshMine(wrap) {
    try {
        const d = await api('/api/ui/me/workspaces');
        const rows = (d && d.workspaces) || [];
        const cur = currentWorkspace() || 'primary';
        wrap.replaceChildren(sectionLabel('워크스페이스'), ...(rows.length ? rows.map((w) => mineRow(w, w.slug === cur || (w.is_primary && cur === 'primary'), wrap))
            : [el('p', { class: 'v2-ws-empty', text: '목록을 불러오지 못했어요.' })]));
    }
    catch (_e) {
        wrap.replaceChildren(sectionLabel('워크스페이스'), el('p', { class: 'v2-ws-empty', text: '목록을 불러오지 못했어요.' }));
    }
}
function switchTo(slug) {
    setCurrentWorkspace(slug === 'primary' ? '' : slug);
    location.hash = '#/';
    location.reload(); // 화면 전체가 그 워크스페이스의 데이터로 다시 선다 — 부분 갱신은 반쪽 상태를 만든다
}
function mineRow(w, active, wrap) {
    const open = el('button', { class: 'v2-ws-team-open', type: 'button', title: active ? '지금 이 워크스페이스예요' : '이 워크스페이스로 전환',
        onclick: () => { if (!active)
            switchTo(String(w.slug)); } }, el('span', { class: 'v2-ws-badge ' + (w.kind === 'personal' ? 'personal' : 'team'), text: w.kind === 'personal' ? '개인' : '팀' }), el('span', { class: 'v2-ws-name', text: String(w.name || w.slug) }), active ? el('span', { class: 'v2-ws-check', 'aria-hidden': 'true', text: '✓ 지금 여기' }) : null);
    const acts = [];
    if (w.role === 'owner' && !w.is_primary) {
        acts.push(el('button', { class: 'v2-ws-auto', type: 'button', title: '이름 변경', text: '✎', onclick: async () => {
                const name = prompt('워크스페이스 이름', String(w.name || ''));
                if (!name || !name.trim())
                    return;
                try {
                    await api('/api/ui/me/workspaces/update', { method: 'POST', body: JSON.stringify({ slug: w.slug, name: name.trim() }) });
                    await refreshMine(wrap);
                }
                catch (e) {
                    toast('바꾸지 못했어요 — ' + (e?.message || e), true);
                }
            } }));
        acts.push(el('button', { class: 'v2-ws-del', type: 'button', title: '보관(스위처에서 숨김 — 데이터는 남아요)', text: '✕', onclick: async () => {
                if (!confirm(`'${w.name || w.slug}' 워크스페이스를 보관할까요? 데이터는 지워지지 않아요.`))
                    return;
                try {
                    await api('/api/ui/me/workspaces/delete', { method: 'POST', body: JSON.stringify({ slug: w.slug }) });
                    if (active) {
                        switchTo('primary');
                        return;
                    }
                    await refreshMine(wrap);
                }
                catch (e) {
                    toast('보관하지 못했어요 — ' + (e?.message || e), true);
                }
            } }));
    }
    return el('div', { class: 'v2-ws-team-row' }, open, ...acts);
}
function buildCreateForm(form) {
    const name = el('input', { class: 'v2-ws-in', type: 'text', placeholder: '워크스페이스 이름', 'aria-label': '워크스페이스 이름' });
    const kind = el('select', { class: 'v2-ws-in', 'aria-label': '종류' }, el('option', { value: 'personal', text: '개인 — 나만 봐요' }), el('option', { value: 'team', text: '팀 — 사람을 초대해요' }));
    const note = el('span', { class: 'v2-ws-note' });
    const go = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '만들기', onclick: async () => {
            if (!name.value.trim()) {
                note.textContent = '이름을 입력하세요.';
                return;
            }
            go.setAttribute('disabled', '');
            note.textContent = '만드는 중…';
            try {
                const d = await api('/api/ui/me/workspaces', { method: 'POST', body: JSON.stringify({ name: name.value.trim(), kind: kind.value }) });
                toast(`'${d?.workspace?.name || name.value.trim()}' 워크스페이스를 만들었어요.`);
                switchTo(String(d?.workspace?.slug || '')); // 만들자마자 그 워크스페이스로 — 빈 목록 앞에서 헤매지 않게
            }
            catch (e) {
                note.textContent = e?.message || String(e);
                go.removeAttribute('disabled');
            }
        } });
    form.replaceChildren(name, kind, el('div', { class: 'v2-ws-formrow' }, go, note), el('p', { class: 'v2-ws-hint', text: '개인 워크스페이스는 관리자를 포함해 다른 사람에게 보이지 않아요. 팀은 만든 뒤 멤버를 초대할 수 있어요.' }));
}
async function refreshTeam(wrap) {
    try {
        const d = await api('/api/ui/me/linked-workspaces');
        const links = (d && d.links) || [];
        wrap.replaceChildren(sectionLabel('개인의 것을 올릴 팀'), ...(links.length ? links.map((l) => teamRow(l, wrap)) : [el('p', { class: 'v2-ws-empty', text: '여기서 만든 지식·프로젝트를 올릴 팀을 아직 연결하지 않았어요. 팀 주소와 토큰으로 연결합니다.' })]));
        return links.length;
    }
    catch (_e) {
        wrap.replaceChildren(sectionLabel('개인의 것을 올릴 팀'), el('p', { class: 'v2-ws-empty', text: '연결 목록을 불러오지 못했어요.' }));
        return 0;
    }
}
function teamRow(l, wrap) {
    const open = el('a', { class: 'v2-ws-team-open', href: l.base_url, target: '_blank', rel: 'noopener' }, el('span', { class: 'v2-ws-badge team', text: '팀' }), el('span', { class: 'v2-ws-name', text: String(l.name || l.scope_key) }), l.state === 'error' ? el('span', { class: 'v2-ws-err', title: l.last_error || '연결 오류', text: '!' }) : null);
    const auto = el('button', { class: 'v2-ws-auto' + (l.auto_promote ? ' on' : ''), type: 'button',
        title: l.auto_promote ? '자동 올리기 켜짐 — AI 승격을 바로 반영합니다(눌러서 끔)' : '자동 올리기 꺼짐 — AI 승격은 승인 대기(눌러서 켬)',
        text: l.auto_promote ? '자동 ✓' : '자동',
        onclick: async () => {
            try {
                await api('/api/ui/me/linked-workspaces', { method: 'POST', body: JSON.stringify({ url: l.base_url, auto_promote: !l.auto_promote }) });
                await refreshTeam(wrap);
            }
            catch (e) {
                toast('바꾸지 못했어요 — ' + (e?.message || e), true);
            }
        } });
    const del = el('button', { class: 'v2-ws-del', type: 'button', title: '연결 해제', text: '✕',
        onclick: async () => { try {
            await api('/api/ui/me/linked-workspaces/remove', { method: 'POST', body: JSON.stringify({ scope_key: l.scope_key }) });
            await refreshTeam(wrap);
        }
        catch (e) {
            toast('해제하지 못했어요 — ' + (e?.message || e), true);
        } } });
    return el('div', { class: 'v2-ws-team-row' }, open, auto, del);
}
function buildLinkForm(form, onDone) {
    const url = el('input', { class: 'v2-ws-in', type: 'url', placeholder: '팀 워크스페이스 주소 (https://team…)', 'aria-label': '워크스페이스 주소' });
    const tok = el('input', { class: 'v2-ws-in', type: 'text', placeholder: '그 워크스페이스에서 발급한 내 토큰 (lvk_…)', 'aria-label': '토큰', autocomplete: 'off' });
    const note = el('span', { class: 'v2-ws-note' });
    const go = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '연결', onclick: async () => {
            if (!url.value.trim() || !tok.value.trim()) {
                note.textContent = '주소와 토큰을 모두 입력하세요.';
                return;
            }
            go.setAttribute('disabled', '');
            note.textContent = '연결 확인 중…';
            try {
                const d = await api('/api/ui/me/linked-workspaces', { method: 'POST', body: JSON.stringify({ url: url.value.trim(), token: tok.value.trim() }) });
                toast(`'${d?.link?.name || '팀 워크스페이스'}' 에 연결했어요.`);
                url.value = '';
                tok.value = '';
                form.hidden = true;
                onDone();
            }
            catch (e) {
                note.textContent = e?.message || String(e);
            }
            finally {
                go.removeAttribute('disabled');
            }
        } });
    form.replaceChildren(url, tok, el('div', { class: 'v2-ws-formrow' }, go, note), el('p', { class: 'v2-ws-hint', text: '팀 워크스페이스에서 [내 토큰 발급](memory·context 스코프)으로 만든 토큰을 붙여넣으세요. 그 토큰으로만 올립니다.' }));
}
async function refreshPromos(wrap) {
    try {
        const d = await api('/api/ui/me/promotions?state=pending');
        const ps = (d && d.promotions) || [];
        if (!ps.length) {
            wrap.replaceChildren();
            return;
        }
        wrap.replaceChildren(sectionLabel(`팀으로 올릴 것 · 승인 대기 ${ps.length}`), ...ps.map((p) => promoRow(p, wrap)));
    }
    catch (e) {
        wrap.replaceChildren();
    }
}
function promoRow(p, wrap) {
    const resolve = async (decision) => {
        try {
            const d = await api('/api/ui/me/promotions/' + p.id + '/resolve', { method: 'POST', body: JSON.stringify({ decision }) });
            const st = d?.promotion?.state;
            toast(decision === 'reject' ? '올리기를 취소했어요.' : st === 'done' ? '팀 워크스페이스에 올렸어요.' : st === 'failed' ? ('올리지 못했어요 — ' + (d?.promotion?.error || '')) : '처리했어요.', st === 'failed');
            await refreshPromos(wrap);
        }
        catch (e) {
            toast('처리하지 못했어요 — ' + (e?.message || e), true);
        }
    };
    return el('div', { class: 'v2-ws-promo' }, el('div', { class: 'v2-ws-promo-main' }, el('span', { class: 'v2-ws-promo-kind', text: p.kind === 'knowledge' ? '지식' : '프로젝트' }), el('span', { class: 'v2-ws-promo-title', text: String(p.title || p.target_ref) })), el('div', { class: 'v2-ws-promo-acts' }, el('button', { class: 'btn btn-primary btn-xs', type: 'button', text: '올리기', onclick: () => resolve('approve') }), el('button', { class: 'btn btn-ghost btn-xs', type: 'button', text: '취소', onclick: () => resolve('reject') })));
}
