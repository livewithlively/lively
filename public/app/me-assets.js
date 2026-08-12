// me-assets.ts — [내 설정 ▸ 내 스킬·훅] 패널: 라이블리 배포분 opt-on/off + 내 컴퓨터별 로컬 하네스 조회·토글
//  (#1313 R38, admin.ts 에서 verbatim 분리).
//  ⚠ myAssetsSection 안의 클로저(pcChips·summarize·onOffSeg·livelyRow·group)는 **일부러 그대로 뒀다** —
//   전부 reload/machines 클로저에 묶여 있어 최상위 승격은 인자 계약을 새로 세워야 한다(별도 항목). 이번엔 통짜 이동만.
import { api, busy, cardHead, el, infoPop, renderMarkdown, toast, uiText } from './core.js';
import { overlay } from './ui-primitives.js';
import { sectionHead } from './admin-widgets.js';
// ── [내 설정 ▸ 내 스킬·훅] — 라이블리 배포분 opt-on/off(#699) + 내 컴퓨터별 로컬 하네스 조회·토글(#891/893). ──
//  #893: 온보딩(#/start/harness)에 있던 걸 여기로 통합 — 하네스 관리는 상시라 관리탭이 정주소(온보딩은 링크).
const HARNESS_KIND_LABEL = { skill: '스킬', subagent: '서브에이전트', command: '커맨드', hook: '훅' };
// 라이블리가 배포한 스킬·훅 본문(설명 전문 + md)을 모달로 — 로컬 것은 서버에 본문 없음(메타만).
async function showHarnessDetail(kind, id, name) {
    const box = overlay(name || id);
    const body = box.querySelector('.ov-box');
    const slot = el('div', { class: 'md-rendered admin-md-box', style: 'max-height:60vh; overflow:auto; margin-top:8px' }, el('p', { class: 'admin-hint' }, ...uiText('불러오는 중…')));
    body?.append(slot);
    try {
        const d = await api(`/api/ui/me/harness/detail?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`);
        const parts = [];
        if (d.description)
            parts.push(el('p', { style: 'color:var(--ink-sub); margin:0 0 10px', text: d.description }));
        if (d.body)
            parts.push(el('div', { class: 'md md-rendered' }, renderMarkdown(String(d.body))));
        if (!parts.length)
            parts.push(el('p', { class: 'admin-hint' }, ...uiText('(본문이 없습니다)')));
        slot.replaceChildren(...parts);
    }
    catch (e) {
        slot.replaceChildren(el('p', { class: 'admin-hint', text: '불러오지 못했습니다 — ' + ((e && e.message) || '') }));
    }
}
async function myAssetsSection(detail) {
    const bodyBox = el('div', {});
    // 펼쳐 둔 그룹(아래 group 의 [더 보기]) — **재적재 너머로 살아남아야 한다**(#1635). 스위치를 하나 누르면
    //  이 패널을 통째로 다시 그리는데, 펼침이 매번 초기화되면 목록이 접히며 문서가 짧아져 보던 자리가 사라진다
    //  (실측: 문서 6082→2362px, 방금 누른 행이 화면 밖으로). 켜고 끄기는 목록을 접는 동작이 아니다.
    const openGroups = new Set();
    detail.replaceChildren(sectionHead('내 스킬 · 훅', '내 AI가 쓰는 스킬·훅이 어느 컴퓨터에 설치됐는지 보고, 켜고 끕니다. 켜고 끈 변경은 다음 세션부터 적용됩니다.'), el('div', { class: 'card' }, cardHead('설치 상태'), bodyBox));
    const reload = async () => {
        busy(bodyBox, el('p', { class: 'admin-hint' }, ...uiText('불러오는 중…')));
        let d;
        try {
            d = await api('/api/ui/me/harness');
        }
        catch (e) {
            bodyBox.replaceChildren(el('p', { class: 'admin-hint', text: (e && e.message) || '불러오지 못했습니다' }));
            return;
        }
        // 관측된 내 컴퓨터들 + 표시 이름/하네스 호환 헬퍼 (라이블리가 준 것이 어느 PC에 깔렸는지 대조에 씀).
        const machines = d.machines || [];
        const machineName = (m) => m.alias || m.host || '내 컴퓨터';
        const compat = (ah, mh) => ah === 'all' || !mh || ah === mh; // 배포분 하네스 vs 머신 하네스
        const mIndex = machines.map((m) => {
            const map = new Map();
            for (const a of (m.assets || []))
                map.set(`${a.kind}:${a.id}`, a);
            return { m, map };
        });
        // 라이블리가 준 것 1건이 각 PC 에 어떻게 있는지 칩으로. 훅=중앙 디스패치(배선된 PC 전부 실행), 스킬=파일 설치 대조.
        const pcChips = (it, kind) => {
            let missing = false;
            if (!it.effective)
                return { row: el('span', { class: 'pc-chip muted', text: '꺼짐 · 어느 PC에도 적용 안 함' }), missing };
            if (!machines.length)
                return { row: el('span', { class: 'admin-hint' }, ...uiText('아직 관측된 PC 없음')), missing };
            const chips = [];
            for (const { m, map } of mIndex) {
                const nm = machineName(m);
                if (kind === 'hook') {
                    if (compat(it.harness || 'all', m.harness))
                        chips.push(el('span', { class: 'pc-chip', text: nm }));
                    continue;
                }
                const hit = map.get(`${it.kind}:${it.id}`);
                if (hit && hit.overlap === 'managed')
                    chips.push(el('span', { class: 'pc-chip', text: nm }));
                else if (hit && hit.overlap === 'shadow')
                    chips.push(el('span', { class: 'pc-chip warn', text: nm + ' · 로컬이 가림' }));
                else if (compat(it.harness || 'all', m.harness)) {
                    chips.push(el('span', { class: 'pc-chip warn', text: nm + ' · 미설치' }));
                    missing = true;
                }
            }
            if (!chips.length)
                return { row: el('span', { class: 'admin-hint' }, ...uiText('적용되는 PC 없음')), missing };
            return { row: el('div', { class: 'pc-chips' }, ...chips), missing };
        };
        // 항목 한 줄 — [이름 · 상태] + [용도 한 줄] + [설치된 PC 칩] | 오른쪽 [켜기/끄기].
        //  회색 줄에 본문 앞부분을 그대로 잘라 넣었더니 무슨 용도인지가 안 읽혔다(사용자 지적) → **첫 문장만**
        //  요약으로 쓰고 전문은 눌렀을 때 뜨는 팝업에 맡긴다. 종류(스킬/훅)는 이제 그룹 제목이 말하므로 뺀다.
        //  1순위 = summary(관리자가 쓴 '무슨 기능인지' 한 줄, [AI 능력 ▸ 스킬…]에서 편집).
        //  2순위 = description 첫 문장. description 은 하네스가 '언제 이 스킬을 쓸지' 판단하는 트리거 문장이라
        //   길고 기술적이다 — 그대로 깔면 무슨 기능인지 안 읽힌다(사용자 지적). 전문은 눌렀을 때 팝업에서 본다.
        const summarize = (it) => {
            const sum = String(it.summary || '').trim();
            if (sum)
                return sum;
            const t = String(it.description || it.note || '').replace(/\s+/g, ' ').trim();
            if (!t)
                return '';
            const cut = t.search(/[.。!?]\s|—|\s·\s/); // 첫 문장·첫 구획까지만
            const head = (cut > 12 ? t.slice(0, cut) : t).trim();
            return head.length > 64 ? head.slice(0, 64) + '…' : head;
        };
        // 켜기/끄기 2버튼. 조직 기본값을 따르는 중이면 '기본' 배지로 알리고, 내가 바꿔 둔 상태면 되돌릴 링크를 준다
        //  (버튼 3개는 과했다 — 사용자 지적).
        // 켬/끔 컨트롤 — 스위치가 **현재 상태**를, 옆 작은 글이 **그게 기본값인지**를 말한다.
        //  ⚠ 껐다가 다시 켜면 '내가 바꿈'이 남아 원래 상태로 안 돌아간 것처럼 보였다(사용자 지적) →
        //   **기본값과 같은 값으로 되돌리면 개인 설정을 지운다**(clear). 그래서 '되돌리기' 버튼도 필요 없다.
        const onOffSeg = (targetKind, it) => {
            const def = !!it.byDefault;
            const following = it.override === null || it.override === undefined;
            const on = following ? def : !!it.override;
            const set = async (v) => {
                try {
                    const b = { target_kind: targetKind, ref_id: it.id };
                    if (v === def)
                        b.clear = true; // 기본값과 같아짐 = 개인 설정 해제(자동)
                    else
                        b.state = v;
                    await api('/api/ui/me/asset-pref', { method: 'POST', body: JSON.stringify(b) });
                    await reload();
                }
                catch (e) {
                    toast((e && e.message) || '실패', true);
                }
            };
            const sw = el('button', { type: 'button', class: 'sw' + (on ? ' on' : ''), role: 'switch',
                'aria-checked': on ? 'true' : 'false', 'aria-label': on ? '켜짐 — 누르면 끕니다' : '꺼짐 — 누르면 켭니다' });
            sw.addEventListener('click', () => void set(!on));
            // 기본값과 같으면 '기본값', 다르면 기본이 무엇인지만 짧게 알린다(길게 쓰면 과하다는 지적).
            const note = on === def ? '기본값' : (def ? '기본값 켬' : '기본값 끔');
            return el('div', { class: 'hrow-act' }, el('div', { class: 'sw-labels' }, el('span', { class: 'sw-state' + (on ? ' on' : ''), text: on ? '켜짐' : '꺼짐' }), el('span', { class: 'sw-note' }, ...uiText(note))), sw);
        };
        const livelyRow = (targetKind, it, kind) => {
            const titleEl = el('span', { class: 'mini-title' }, el('span', { text: it.label || it.id }), el('span', { class: 'pill' + (it.effective ? ' pill-ok' : ''), text: it.effective ? '적용 중' : '미적용' }));
            const { row: chipRow, missing } = pcChips(it, kind);
            const sum = summarize(it);
            const left = el('div', { class: 'harness-click', style: 'flex:1; min-width:0;', title: '눌러서 내용 보기' }, titleEl, el('div', { class: 'mini-meta', text: sum || '눌러서 내용 보기' }), el('div', { style: 'margin-top:6px' }, chipRow));
            left.addEventListener('click', () => showHarnessDetail(kind, it.id, it.label || it.id));
            return { node: el('div', { class: 'mini-row hrow' }, left, onOffSeg(targetKind, it)), missing };
        };
        // 접이식 그룹 — 목록이 길어 한 화면에 안 들어오던 걸, 제목·개수만 먼저 보이고 눌러서 펼치게(사용자 요구).
        // 그룹 — 통째로 감추면 뭐가 있는지 모른다(사용자 요구: 프로젝트 탭 '연결된 지식'처럼 몇 개는 보이고
        //  나머지는 [더 보기]). 앞 PEEK 개는 항상 보이고, 넘치는 만큼만 접어 둔다.
        const PEEK = 3;
        //  key = 이 그룹의 신원(펼침을 재적재 너머로 기억하는 축). 같은 제목이 PC 마다 반복되므로 제목은 못 쓴다.
        const group = (key, title, count, items) => {
            const head = el('div', { class: 'hgroup-head-row' }, el('span', { class: 'hgroup-title', text: title }), el('span', { class: 'hgroup-count', text: String(count) }));
            const shown = items.slice(0, PEEK);
            const rest = items.slice(PEEK);
            const restBox = el('div', { class: 'hgroup-rest' }, ...rest);
            const kids = [head, el('div', { class: 'hgroup-body' }, ...shown, restBox)];
            let open = openGroups.has(key);
            restBox.style.display = open ? 'block' : 'none';
            if (rest.length) {
                const lbl = el('span', { class: 'lbl', text: open ? '접기' : '더 보기 ' + rest.length + '개' });
                const caret = el('span', { class: 'caret', text: open ? '⌃' : '⌄' });
                const btn = el('button', { type: 'button', class: 'proj-detail-body-expand' }, lbl, caret);
                btn.addEventListener('click', () => {
                    open = !open;
                    if (open)
                        openGroups.add(key);
                    else
                        openGroups.delete(key);
                    restBox.style.display = open ? 'block' : 'none';
                    lbl.textContent = open ? '접기' : '더 보기 ' + rest.length + '개';
                    caret.textContent = open ? '⌃' : '⌄';
                });
                kids.push(el('div', { class: 'hgroup-more' }, btn));
            }
            return el('div', { class: 'hgroup' }, ...kids);
        };
        // 위계는 두 층이다: **위 = 어디서 온 것인가**(조직 배포 / 내 컴퓨터), **아래 = 종류**(스킬 · 커스텀 훅).
        //  전에는 h4/h5 크기 차이만으로 눌러 담아 두 층이 안 읽혔다(사용자 지적) → 층마다 자기 머리를 갖게 한다.
        const rows = [];
        const lskills = d.lively?.skills || [];
        const lhooks = d.lively?.hooks || [];
        let anyMissing = false;
        const skillNodes = lskills.map((sk) => { const r = livelyRow('harness_asset', sk, sk.kind || 'skill'); anyMissing = anyMissing || r.missing; return r.node; });
        const hookNodes = lhooks.map((h) => livelyRow('org_hook', h, 'hook').node);
        rows.push(el('div', { class: 'hlayer' }, el('div', { class: 'hlayer-head' }, el('h4', { class: 'hlayer-title', text: '라이블리 스킬 · 훅' }), infoPop('라이블리가 팀 전체에 배포한 스킬·훅입니다. 내 세션에 적용할지 여기서 켜고 끌 수 있고, 끄면 나에게만 적용되지 않습니다.')), group('lively:skill', '스킬', skillNodes.length, skillNodes.length ? skillNodes : [el('p', { class: 'admin-hint' }, ...uiText('배포된 스킬이 없습니다.'))]), group('lively:hook', '커스텀 훅', hookNodes.length, hookNodes.length ? hookNodes : [el('p', { class: 'admin-hint' }, ...uiText('배포된 커스텀 훅이 없습니다.'))])));
        if (anyMissing)
            rows.unshift(el('div', { class: 'sync-warn' }, el('b', { text: '켜져 있지만 아직 설치되지 않은 PC(‘미설치’ 표시)가 있습니다. ' }), '그 PC에서 claude(또는 codex) 세션을 한 번 열면 자동으로 설치됩니다.'));
        // ── 내 컴퓨터별: 내가 직접 만든 로컬 스킬·훅만 (라이블리가 준 건 위에서 PC 칩으로 봤어요). ──
        if (machines.length) {
            const myLayer = el('div', { class: 'hlayer' }, el('div', { class: 'hlayer-head' }, el('h4', { class: 'hlayer-title', text: '내 로컬 스킬 · 훅' }), infoPop('내가 각 컴퓨터에 직접 만들어 둔 스킬·훅입니다(라이블리 배포분은 위 목록에서 PC 칩으로 확인합니다). 컴퓨터마다 따로 보입니다.')));
            rows.push(myLayer);
            for (const m of machines) {
                const nm = machineName(m);
                const head = el('div', { style: 'display:flex; align-items:center; gap:8px; margin:14px 0 6px; flex-wrap:wrap' }, el('h5', { style: 'margin:0; font-size:14px', text: nm }));
                const editName = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '✎ 이름' });
                editName.addEventListener('click', async () => {
                    const v = prompt(`이 컴퓨터의 별명 (비우면 해제). 관측된 호스트명: ${m.host || '?'}`, m.alias || '');
                    if (v === null)
                        return;
                    try {
                        await api('/api/ui/me/harness/machine-alias', { method: 'POST', body: JSON.stringify({ machine_id: m.machine_id, alias: v }) });
                        toast('이름을 바꿨습니다');
                        await reload();
                    }
                    catch (e) {
                        toast((e && e.message) || '실패', true);
                    }
                });
                head.append(editName);
                if (m.alias && m.host)
                    head.append(el('span', { class: 'mini-meta', text: '· ' + m.host }));
                if (m.at)
                    head.append(el('span', { class: 'mini-meta', text: '· ' + new Date(m.at).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }) + ' 마지막 확인' }));
                const del = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', style: 'margin-left:auto', text: '이 컴퓨터 지우기' });
                del.addEventListener('click', async () => {
                    if (!confirm(`'${nm}' 의 하네스 관측을 목록에서 지울까요? (그 컴퓨터에서 다시 세션을 열면 자동으로 다시 나타납니다.)`))
                        return;
                    try {
                        await api('/api/ui/me/harness/machine-remove', { method: 'POST', body: JSON.stringify({ machine_id: m.machine_id }) });
                        toast('지웠습니다');
                        await reload();
                    }
                    catch (e) {
                        toast((e && e.message) || '실패', true);
                    }
                });
                head.append(del);
                myLayer.append(head);
                const own = (m.assets || []).filter((a) => a.overlap === 'local-only');
                if (!own.length) {
                    myLayer.append(el('p', { class: 'admin-hint' }, ...uiText('이 컴퓨터에 직접 만든 스킬·훅은 없습니다(라이블리 배포분만 있습니다).')));
                    continue;
                }
                const byKind = {};
                for (const a of own) {
                    const isHook = a.kind === 'hook'; // 훅은 settings.json 항목(파일 아님) — 비파괴 토글 불가라 여기선 표시만.
                    // 종류(스킬/훅)는 이제 그룹 제목이 말한다 — 줄마다 다시 붙이지 않는다.
                    const meta = isHook ? 'settings.json 에 직접 추가한 훅 — 여기서는 켜고 끌 수 없습니다.' : ('내가 이 컴퓨터에서 만든 것' + (a.disabled ? ' · 꺼둠' : ''));
                    let tb = null;
                    if (!isHook) {
                        tb = el('button', { type: 'button', class: 'btn btn-sm btn-ghost', style: 'flex-shrink:0', text: a.disabled ? '켜기' : '끄기' });
                        tb.addEventListener('click', async () => {
                            try {
                                await api('/api/ui/me/harness-local-pref', { method: 'POST', body: JSON.stringify({ machine_id: m.machine_id, kind: a.kind, id: a.id, disabled: !a.disabled }) });
                                toast(a.disabled ? '켬 — 다음 세션부터 적용됩니다' : '끔 — 다음 세션부터 적용됩니다');
                                await reload();
                            }
                            catch (e) {
                                toast((e && e.message) || '실패', true);
                            }
                        });
                    }
                    (byKind[a.kind] ||= []).push(el('div', { class: 'mini-row hrow' }, el('div', { style: 'flex:1; min-width:0;' }, el('span', { class: 'mini-title', text: a.id }), el('div', { class: 'mini-meta' }, ...uiText(meta))), el('div', { class: 'hrow-act' }, tb)));
                }
                for (const [k, list] of Object.entries(byKind))
                    myLayer.append(group(m.machine_id + ':' + k, HARNESS_KIND_LABEL[k] || k, list.length, list));
            }
        }
        else {
            rows.push(el('div', { class: 'hlayer' }, el('div', { class: 'hlayer-head' }, el('h4', { class: 'hlayer-title', text: '내 로컬 스킬 · 훅' })), el('p', { class: 'admin-hint' }, ...uiText('아직 내 컴퓨터의 하네스를 확인하지 못했습니다. 내 컴퓨터에서 claude(또는 codex)를 한 번 켜면 다음 세션에 자동으로 나타납니다. 컴퓨터가 여러 대면 각각 따로 보입니다. (웹 [AI 세션]은 회사 서버에서 돌아 로컬이 보이지 않습니다.)'))));
        }
        bodyBox.replaceChildren(...rows);
    };
    await reload();
}
export { myAssetsSection, };
