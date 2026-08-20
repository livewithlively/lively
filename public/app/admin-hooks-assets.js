// admin-hooks-assets.ts — [스킬 · 훅] 화면의 두 패널 (#1313 R40, admin.ts 에서 verbatim 분리).
//  둘 다 runtime 권한이고 둘 다 '구성원 컴퓨터에서 도는 것'을 정의한다 — 커스텀 훅(코드)과
//  하네스 자산(스킬·서브에이전트·커맨드). 자산의 paired_hook_id 가 훅을 참조하므로 한 파일에 둔다.
//  릴레이·grace 정책 카드(relayPolicyCard·gracePolicyCard)는 훅 실행 런너의 노브라 훅 패널과 동거한다.
//  재렌더는 R37 의 rerenderPanel('custom-hooks'/'harness-assets') 레지스트리 경유(셸↔패널 순환 절단).
import { api, cardHead, el, state, toast, uiText } from './core.js';
import { field } from './ui-primitives.js';
import { loadAdmin, rerenderPanel } from './admin-rerender.js';
import { targetMembersField } from './admin-widgets.js';
// ── 커스텀 훅 — runtime 권한 ──
function customHookEditor(detail, data) {
    const hooks = data.orgHooks || [];
    const sel = state.admin.hookSel;
    const listCol = el('div', { class: 'admin-sublist' });
    listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ 추가',
        onclick: () => { state.admin.hookSel = '__new__'; rerenderPanel(detail, 'custom-hooks', data); } }));
    const lockedIds = data.lockedHookIds || []; // #1836 — 라이블리가 배포하는 훅(코드가 SoT). 조직은 켜고 끄기만.
    for (const h of hooks) {
        const failed = Object.keys(h.health || {}).length; // #892 — 죽은 훅을 목록에서 바로 보이게(조용한 죽음 방지)
        listCol.append(el('div', { class: 'mini-row' + (h.id === sel ? ' sel' : ''),
            onclick: () => { state.admin.hookSel = h.id; rerenderPanel(detail, 'custom-hooks', data); } }, el('div', { class: 'mini-title', text: h.id }, lockedIds.includes(h.id) ? el('span', { class: 'pill', text: '제품 기본' }) : null, h.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null, failed ? el('span', { class: 'pill pill-warn', text: '⚠ 실패 ' + failed + '대' }) : null), el('div', { class: 'mini-meta', text: h.event + (h.matcher ? ' · ' + h.matcher : '') + ' · ' + (h.harness || 'all')
                + (h.target_members && h.target_members.length ? ' · 지정 ' + h.target_members.length + '명' : '') })));
    }
    const right = el('div', {});
    const editing = sel === '__new__'
        ? { id: '', label: '', harness: 'all', event: 'PostToolUse', matcher: '', source_code: '', timeout_sec: 10, note: '', target_members: null, enabled: true }
        : hooks.find((h) => h.id === sel);
    if (editing)
        hookForm(right, editing, data, detail, sel === '__new__', lockedIds.includes(editing.id));
    else
        right.append(
        // origin/main(#968 계열)의 개선된 안내 문구 + #892 의 정책 카드 — 둘 다 유지.
        el('p', { class: 'admin-hint' }, ...uiText('구성원 머신에서 특정 시점에 자동 실행되는 코드입니다. 본문은 구성원 디스크에 저장되지 않고 매 세션 게이트웨이에서 받아 실행됩니다(비활성화하면 다음 세션부터 실행되지 않습니다). 왼쪽 목록에서 항목을 선택하면 내용을 보고 편집할 수 있습니다. 「제품 기본」 표시가 붙은 훅은 라이블리가 배포하는 것이라 본문은 볼 수만 있고, 조직은 켜고 끄는 것과 대상 구성원만 정합니다.')), relayPolicyCard(data, detail), gracePolicyCard(data, detail));
    detail.replaceChildren(el('div', { class: 'card' }, cardHead('커스텀 훅'), el('div', { class: 'admin-two admin-two-cols' }, listCol, right)));
}
// PreToolUse 결정 전파 정책(#892) — 러너가 훅의 permissionDecision 중 무엇을 하네스로 넘길지.
//  훅 하나가 아니라 러너 전체에 걸리는 org 정책이라 훅 폼이 아니라 목록 화면(훅 미선택 시)에 둔다.
function relayPolicyCard(data, detail) {
    const rc = data.runtimeConfig;
    if (!rc)
        return el('span', {}); // 비-admin 은 runtimeConfig 를 못 받는다 → 정책 카드 숨김
    const cur = new Set(rc.hook_relay_decisions || ['deny', 'ask', 'defer']);
    const DESC = {
        deny: 'deny — 도구 실행을 막는다(게이트). 훅이 준 사유가 AI 에게 전달된다.',
        ask: 'ask — 사용자에게 권한 프롬프트를 띄운다.',
        defer: 'defer — 비대화형(-p) 실행에서 판단을 미룬다.',
        allow: 'allow — 권한 프롬프트를 건너뛰고 즉시 허용. ⚠ 구성원의 동의 화면이 사라집니다.',
    };
    const boxes = ['deny', 'ask', 'defer', 'allow'].map((d) => {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = cur.has(d);
        cb.dataset.decision = d;
        return el('label', { class: 'admin-check' }, cb, el('span', { text: DESC[d] }));
    });
    const save = el('button', { class: 'btn btn-primary btn-sm', text: '정책 저장' });
    save.addEventListener('click', async () => {
        const picked = boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.dataset.decision);
        // deny 를 빼는 건 allow 를 켜는 것보다 위험하다 — 모든 PreToolUse 게이트가 조용히 무력해진다.
        //  #892 자체가 'deny 가 조용히 전파를 멈춘' 사고였다. 그 상태를 클릭 한 번에 만들 수 있으면 안 된다.
        if (!picked.includes('deny')
            && !confirm(picked.length
                ? 'deny 를 빼면 도구를 막는 훅(게이트)이 전부 무력해집니다 — 훅은 돌지만 아무것도 못 막습니다. 계속할까요?'
                : '전부 해제하면 모든 PreToolUse 훅의 결정이 무시됩니다(게이트 전면 해제). 계속할까요?'))
            return;
        if (picked.includes('allow') && !confirm('allow 를 전파하면 관리자 훅이 구성원의 권한 프롬프트(동의 화면)를 건너뛸 수 있습니다. 계속할까요?'))
            return;
        save.disabled = true;
        try {
            await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ hook_relay_decisions: picked }) });
            await loadAdmin(true);
            toast('저장됨 — 구성원 다음 세션부터');
            rerenderPanel(detail, 'custom-hooks', state.admin.data);
        }
        catch (e) {
            toast(e.message, true);
            save.disabled = false;
        }
    });
    return el('div', { class: 'admin-subcard' }, el('h4', { text: '도구 게이트 정책 (PreToolUse)' }), el('p', { class: 'admin-hint' }, ...uiText('PreToolUse 훅이 내리는 결정 중 러너가 하네스로 실제 전달할 값입니다. 체크 해제하면 그 결정은 무시됩니다(훅은 돌지만 효과 없음). 기본값은 deny·ask·defer — allow 는 구성원의 동의 화면을 없애므로 기본에서 빠져 있습니다.')), ...boxes, el('div', { class: 'admin-actions' }, save));
}
// 오프라인 캐시 유효기간(#1008) — 게이트웨이에 연결 안 되는 동안 마지막으로 받은 커스텀 훅을 얼마나 오래 계속 실행할지.
//  러너 전체에 걸리는 org 정책이라 relayPolicyCard 와 같은 목록 화면(훅 미선택 시)에 둔다. 무제한(기본) = 마지막 접속 기준
//  영구 실행 → 게이트웨이 없이도 동작하는 로컬 훅(스킬 라우터·품질 게이트)이 오프라인에서 유지된다. 기간을 정하면 회수창.
function gracePolicyCard(data, detail) {
    const rc = data.runtimeConfig;
    if (!rc)
        return el('span', {}); // 비-admin 은 runtimeConfig 를 못 받는다 → 카드 숨김
    // 프리셋: '' = 무제한(null), '0' = 즉시 중단, 그 외는 ms. 현재값이 프리셋에 없으면 아래에서 별도 옵션으로 추가.
    const PRESETS = [
        ['', '무제한 — 마지막 접속 기준 영구 실행 (기본·권장)'],
        ['0', '즉시 중단 — 연결이 끊기면 바로 커스텀 훅 정지 (가장 보수적)'],
        ['600000', '10분 (종전 기본값)'],
        ['3600000', '1시간'],
        ['21600000', '6시간'],
        ['86400000', '1일'],
        ['604800000', '7일'],
    ];
    const curVal = (rc.hook_grace_ms === null || rc.hook_grace_ms === undefined) ? '' : String(rc.hook_grace_ms);
    const sel = el('select', {}, ...PRESETS.map(([v, label]) => el('option', { value: v, text: label })));
    if (!PRESETS.some(([v]) => v === curVal))
        sel.append(el('option', { value: curVal, text: `현재 설정: ${curVal}ms` }));
    sel.value = curVal;
    const save = el('button', { class: 'btn btn-primary btn-sm', text: '정책 저장' });
    save.addEventListener('click', async () => {
        const v = sel.value === '' ? null : Number(sel.value);
        save.disabled = true;
        try {
            await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ hook_grace_ms: v }) });
            await loadAdmin(true);
            toast('저장됨 — 구성원 다음 세션부터');
            rerenderPanel(detail, 'custom-hooks', state.admin.data);
        }
        catch (e) {
            toast(e.message, true);
            save.disabled = false;
        }
    });
    return el('div', { class: 'admin-subcard' }, el('h4', { text: '오프라인 캐시 유효기간 (게이트웨이 미연결 시)' }), el('p', { class: 'admin-hint' }, ...uiText('게이트웨이에 연결되지 않는 동안, 마지막으로 받은 커스텀 훅을 얼마나 오래 계속 실행할지입니다. 무제한(기본)이면 마지막 접속 기준으로 계속 실행됩니다 — 게이트웨이 없이 동작하는 로컬 훅(스킬 라우터·품질 게이트 등)이 오프라인에서도 유지됩니다. 기간을 정하면 그 시간이 지난 뒤 커스텀 훅 실행을 멈춥니다(제거한 훅의 회수 목적). 어느 경우든 훅 본문 무결성(content_hash)은 캐시에서도 검증되고, 재연결 시 즉시 갱신·회수됩니다.')), field('연결 끊긴 뒤 유지 기간', sel), el('div', { class: 'admin-actions' }, save));
}
function hookForm(root, h, data, detail, isNew, locked) {
    const idIn = el('input', { type: 'text', value: h.id, placeholder: '훅 id (소문자/숫자/_-)', disabled: isNew ? null : '' });
    const labelIn = el('input', { type: 'text', value: h.label || '', placeholder: '표시 이름(선택)' });
    // 구성원 화면([내 스킬·훅])에 보이는 쉬운 한 줄(#1085) — 스킬과 같은 규격.
    const hSumIn = el('input', { type: 'text', value: h.summary || '', placeholder: '예: 세션이 끝날 때 기록을 남겼는지 점검합니다' });
    const harnessSel = el('select', {}, ...['all', 'claude', 'codex', 'openclaw', 'opencode', 'antigravity', 'grok'].map((x) => el('option', { value: x, text: x })));
    harnessSel.value = h.harness || 'all';
    const eventSel = el('select', {}, ...['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'Notification'].map((x) => el('option', { value: x, text: x })));
    eventSel.value = h.event || 'PostToolUse';
    const matcherIn = el('input', { type: 'text', value: h.matcher || '', placeholder: '예: Bash (PreToolUse/PostToolUse 의 도구 매처)' });
    const codeTa = el('textarea', { rows: '12', class: 'admin-ta', placeholder: '#!/usr/bin/env node\n// 훅 입력은 stdin(JSON), 응답은 stdout / exit code' });
    codeTa.value = h.source_code || '';
    const timeoutIn = el('input', { type: 'number', value: String(h.timeout_sec || 10), min: '1', max: '120' });
    const tm = targetMembersField('org_hook', h, isNew);
    const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
    const status = el('span', { class: 'admin-status' });
    saveBtn.addEventListener('click', async () => {
        if (!locked && !idIn.value.trim()) {
            toast('id 필수', true);
            return;
        }
        const bad = tm.validate();
        if (bad) {
            toast(bad, true);
            return;
        }
        if (!locked && !confirm('이 코드는 구성원 컴퓨터에서 그들의 권한으로 실제 실행됩니다. 저장할까요?'))
            return;
        saveBtn.disabled = true;
        try {
            // #1836 — 시드 훅은 본문·실행정의를 코드가 소유한다. 조직이 정하는 것만 보낸다(잠긴 필드를 보내면 409).
            const payload = locked
                ? { id: h.id, target_members: tm.targetMembers(), enabled: tm.enabled() }
                : { id: idIn.value.trim(), label: labelIn.value.trim() || null, harness: harnessSel.value, event: eventSel.value, matcher: matcherIn.value.trim() || null, source_code: codeTa.value, timeout_sec: Number(timeoutIn.value) || 10, summary: hSumIn.value, target_members: tm.targetMembers(), enabled: tm.enabled() };
            await api('/api/ui/org/hook', { method: 'POST', body: JSON.stringify(payload) });
            await loadAdmin(true);
            state.admin.hookSel = payload.id;
            toast('저장됨 — 구성원 다음 세션부터');
            rerenderPanel(detail, 'custom-hooks', state.admin.data);
        }
        catch (e) {
            toast(e.message, true);
            saveBtn.disabled = false;
        }
    });
    const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
    if (!isNew && !locked)
        actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
                if (!confirm(`커스텀 훅 '${h.id}' 제거? 다음 세션부터 실행되지 않습니다(미접속 머신은 직전 상태 유지).`))
                    return;
                try {
                    await api('/api/ui/org/hook/remove', { method: 'POST', body: JSON.stringify({ id: h.id }) });
                    await loadAdmin(true);
                    state.admin.hookSel = null;
                    toast('제거됨');
                    rerenderPanel(detail, 'custom-hooks', state.admin.data);
                }
                catch (e) {
                    toast(e.message, true);
                }
            } }));
    // #1836 — 잠긴(제품 기본) 훅: 코드가 단일 출처라 본문·실행정의 입력을 읽기 전용으로 둔다.
    //  숨기지 않고 **보여주되 못 고치게** 한다 — 무엇이 도는지는 조직이 알아야 하고(감사), 못 바꾼다는 사실만 분명하면 된다.
    if (locked) {
        for (const inp of [idIn, labelIn, hSumIn, harnessSel, eventSel, matcherIn, codeTa, timeoutIn]) {
            inp.setAttribute('disabled', '');
        }
    }
    root.replaceChildren(locked
        ? el('div', { class: 'admin-subcard' }, el('h4', { text: '제품 소유 · 자동 갱신' }), el('p', { class: 'admin-hint' }, ...uiText('라이블리가 배포하는 기본 훅입니다. 본문과 실행 조건은 제품 코드가 단일 출처이고 업데이트마다 자동으로 갱신되므로 여기서 고칠 수 없습니다. 조직이 정하는 것은 **쓸지 말지**입니다 — 아래에서 끄면 그 상태는 업데이트에도 그대로 유지됩니다. 동작을 바꾸고 싶으면 이 훅을 끄고 [+ 추가]로 새 훅을 만드세요.')))
        : el('div', { class: 'warn-badge', text: '⚠ 이 코드는 구성원 컴퓨터에서 그들의 권한으로 실제 실행됩니다.' }), hookHealthCard(h), field('id', idIn), field('표시 이름', labelIn), field('쉬운 한 줄 (구성원 화면에 보이는 말)', hSumIn), field('하네스', harnessSel), field('이벤트(실행 시점)', eventSel), field('매처(선택 — PreToolUse/PostToolUse 의 도구명)', matcherIn), field('코드 (Node.js)', codeTa), field('타임아웃(초, 1~120)', timeoutIn), field('대상 구성원', tm.node), actions);
}
// 훅 건강(#892) — 구성원 러너가 보고한 마지막 실행 실패. 종전엔 훅이 죽어도 화면상 '활성'이라
//  spec-blind guard/tracker 가 등록 이래 내내 죽은 걸 아무도 몰랐다. 실패가 없으면 아무것도 안 그린다.
function hookHealthCard(h) {
    const health = h.health || {};
    const ids = Object.keys(health);
    if (!ids.length)
        return el('span', {});
    const REASON = {
        crash: '실행 중 오류로 죽음', timeout: '타임아웃(시간 초과)',
        hash_mismatch: '무결성 해시 불일치 — 실행 안 함', spawn_error: '실행 자체 실패',
        // 훅은 정상 종료했지만 출력이 결정으로 안 읽혀 하네스가 통째로 무시한 경우 — 죽은 것과 결과가 같다.
        bad_output: '출력을 결정으로 읽을 수 없음 — 하네스가 무시함(게이트 안 걸림)',
    };
    return el('div', { class: 'admin-subcard warn-badge-soft' }, el('h4', { text: '⚠ 이 훅이 구성원 컴퓨터에서 실패하고 있습니다 (' + ids.length + '대)' }), el('p', { class: 'admin-hint' }, ...uiText('실패한 훅은 아무 효과가 없습니다 — 화면상 "활성"이어도 실제로는 동작하지 않습니다.')), ...ids.map((m) => {
        const e = health[m] || {};
        return el('div', { class: 'mini-row' }, el('div', { class: 'mini-title', text: m + ' · ' + (REASON[e.reason] || e.reason || '알 수 없음') }), el('div', { class: 'mini-meta', text: (e.at ? new Date(e.at).toLocaleString() : '') + (e.exit_code != null ? ' · exit ' + e.exit_code : '') }), e.stderr ? el('pre', { class: 'admin-pre', text: String(e.stderr).slice(-400) }) : null);
    }));
}
// ── 스킬 · 서브에이전트 · 슬래시커맨드 (org_harness_asset) — runtime 권한 ──
//  화면에서 '자산'이라 부르지 않는다(#859) — 식별자만 asset. 위 §용어 사전 참조.
function harnessAssetEditor(detail, data) {
    const assets = data.orgHarnessAssets || [];
    const sel = state.admin.assetSel;
    const KIND_LABEL = { skill: '스킬', subagent: '서브에이전트', command: '커맨드' };
    // 멤버 셀프업로드(#990) 초안 = draft- 네임스페이스 + 비활성 + 제출자. 관리자가 [승격]으로 배포한다.
    const isDraft = (a) => a.id && a.id.indexOf('draft-') === 0 && a.enabled === false && a.created_by;
    const listCol = el('div', { class: 'admin-sublist' });
    listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ 추가',
        onclick: () => { state.admin.assetSel = '__new__'; rerenderPanel(detail, 'harness-assets', data); } }));
    for (const a of assets) {
        listCol.append(el('div', { class: 'mini-row' + (a.id === sel ? ' sel' : ''),
            onclick: () => { state.admin.assetSel = a.id; rerenderPanel(detail, 'harness-assets', data); } }, el('div', { class: 'mini-title', text: a.id }, isDraft(a) ? el('span', { class: 'pill pill-warn', text: '제출 · ' + a.created_by })
            : (a.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null)), el('div', { class: 'mini-meta', text: (KIND_LABEL[a.kind] || a.kind) + ' · ' + (a.harness || 'all')
                + (a.target_members && a.target_members.length ? ' · 지정 ' + a.target_members.length + '명' : '')
                + (a.paired_hook_id ? ' · 연결 훅:' + a.paired_hook_id : '') })));
    }
    const right = el('div', {});
    const editing = sel === '__new__'
        ? { id: '', kind: 'skill', label: '', harness: 'all', description: '', body: '', frontmatter: {}, target_members: null, paired_hook_id: '', enabled: true }
        : assets.find((a) => a.id === sel);
    if (editing)
        assetForm(right, editing, data, detail, sel === '__new__');
    else
        right.append(el('p', { class: 'admin-hint' }, ...uiText('스킬(작업 방법서)·서브에이전트(보조 AI)·슬래시커맨드(단축 명령)를 정의해 구성원 하네스에 배포합니다. 저장하면 구성원 세션 시작 때 디스크에 동기화되며, 스킬·커맨드는 진행 중인 세션에도 즉시 반영됩니다. 왼쪽 목록에서 항목을 선택하면 내용을 보고 편집할 수 있습니다.')));
    detail.replaceChildren(el('div', { class: 'card' }, cardHead('스킬 · 서브에이전트 · 커맨드'), el('div', { class: 'admin-two admin-two-cols' }, listCol, right)));
}
function assetForm(root, a, data, detail, isNew) {
    const idIn = el('input', { type: 'text', value: a.id, placeholder: 'id (소문자/숫자/_-)', disabled: isNew ? null : '' });
    const labelIn = el('input', { type: 'text', value: a.label || '', placeholder: '표시 이름(선택)' });
    const kindSel = el('select', {}, ...[['skill', '스킬'], ['subagent', '서브에이전트'], ['command', '슬래시커맨드']].map(([v, t]) => el('option', { value: v, text: t })));
    kindSel.value = a.kind || 'skill';
    const harnessSel = el('select', {}, ...['all', 'claude', 'codex', 'openclaw', 'opencode', 'antigravity', 'grok'].map((x) => el('option', { value: x, text: x })));
    harnessSel.value = a.harness || 'all';
    const descIn = el('input', { type: 'text', value: a.description || '', placeholder: 'AI가 이것을 언제 쓸지 판단하는 한 줄 설명(상시 노출)' });
    // 표시용 한 줄(#1085) — 위 '설명'은 AI 트리거 문장이라 길고 기술적이다. 사람 화면([내 스킬·훅])에는 이걸 보여준다.
    const sumIn = el('input', { type: 'text', value: a.summary || '', placeholder: '예: 코드 변경만 보고 기능을 유추해 문서화 품질을 점검합니다' });
    const bodyTa = el('textarea', { rows: '12', class: 'admin-ta', placeholder: '본문(마크다운) — 스킬 방법서 / 에이전트 시스템 프롬프트 / 커맨드 프롬프트' });
    bodyTa.value = a.body || '';
    const fmTa = el('textarea', { rows: '4', class: 'admin-ta', placeholder: '추가 frontmatter(JSON, 선택) — 예: {"model":"opus","allowed-tools":["Read","Grep"]}' });
    fmTa.value = (a.frontmatter && Object.keys(a.frontmatter).length) ? JSON.stringify(a.frontmatter, null, 2) : '';
    const tm = targetMembersField('harness_asset', a, isNew);
    const pairedIn = el('input', { type: 'text', value: a.paired_hook_id || '', placeholder: '연결 훅 id(선택) — 위험 통제용 커스텀 훅' });
    const codexNote = el('p', { class: 'admin-hint' });
    const syncNote = () => {
        codexNote.textContent = (kindSel.value !== 'skill' && (harnessSel.value === 'codex' || harnessSel.value === 'all'))
            ? '※ 서브에이전트·슬래시커맨드는 Codex 네이티브 미지원 — Codex 세션엔 배포되지 않습니다(스킬만 양 하네스). Claude 에만 적용됩니다.' : '';
    };
    kindSel.addEventListener('change', syncNote);
    harnessSel.addEventListener('change', syncNote);
    syncNote();
    const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
    const status = el('span', { class: 'admin-status' });
    saveBtn.addEventListener('click', async () => {
        if (!idIn.value.trim()) {
            toast('id 필수', true);
            return;
        }
        let fm = {};
        if (fmTa.value.trim()) {
            try {
                fm = JSON.parse(fmTa.value);
            }
            catch {
                toast('frontmatter 가 올바른 JSON 이 아닙니다', true);
                return;
            }
        }
        const bad = tm.validate();
        if (bad) {
            toast(bad, true);
            return;
        }
        if (!confirm('구성원 하네스에 배포되어 그들의 AI가 사용합니다. 스킬은 도구·셸을 실행할 수 있습니다. 저장할까요?'))
            return;
        saveBtn.disabled = true;
        try {
            const payload = { id: idIn.value.trim(), kind: kindSel.value, label: labelIn.value.trim() || null, harness: harnessSel.value,
                description: descIn.value, summary: sumIn.value, body: bodyTa.value, frontmatter: fm,
                target_members: tm.targetMembers(), paired_hook_id: pairedIn.value.trim() || null, enabled: tm.enabled() };
            await api('/api/ui/org/harness-asset', { method: 'POST', body: JSON.stringify(payload) });
            await loadAdmin(true);
            state.admin.assetSel = payload.id;
            toast('저장됨 — 구성원 다음 세션부터');
            rerenderPanel(detail, 'harness-assets', state.admin.data);
        }
        catch (e) {
            toast(e.message, true);
            saveBtn.disabled = false;
        }
    });
    const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
    // #990 멤버 초안 승격 — draft- 네임스페이스 비활성 자산이면 클린 id 로 복제·활성화(초안 제거)하는 [승격] 노출.
    const isDraft = !isNew && a.id && a.id.indexOf('draft-') === 0 && a.enabled === false && a.created_by;
    if (isDraft)
        actions.append(el('button', { class: 'btn btn-primary', text: '승격 →', onclick: async () => {
                const suggested = a.id.replace(/^draft-[0-9a-f]+-/, '');
                const newId = (prompt('조직에 배포할 클린 id (스킬 이름이 됩니다):', suggested) || '').trim().toLowerCase();
                if (!newId)
                    return;
                if (!confirm(`'${a.created_by}' 님의 초안을 '${newId}' 로 승격해 배포합니다(초안은 제거). 계속할까요?`))
                    return;
                try {
                    await api('/api/ui/org/harness-asset/adopt', { method: 'POST', body: JSON.stringify({ draft_id: a.id, new_id: newId, enabled: true }) });
                    await loadAdmin(true);
                    state.admin.assetSel = newId;
                    toast('승격됨 — 구성원 다음 세션부터');
                    rerenderPanel(detail, 'harness-assets', state.admin.data);
                }
                catch (e) {
                    toast(e.message, true);
                }
            } }));
    if (!isNew)
        actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
                if (!confirm(`'${a.id}' 제거? 다음 세션부터 구성원 하네스에서 제거됩니다(미접속 머신은 직전 상태 유지).`))
                    return;
                try {
                    await api('/api/ui/org/harness-asset/remove', { method: 'POST', body: JSON.stringify({ id: a.id }) });
                    await loadAdmin(true);
                    state.admin.assetSel = null;
                    toast('제거됨');
                    rerenderPanel(detail, 'harness-assets', state.admin.data);
                }
                catch (e) {
                    toast(e.message, true);
                }
            } }));
    root.replaceChildren(el('div', { class: 'warn-badge', text: '⚠ 여기서 정의한 것은 구성원 하네스에 배포됩니다. 스킬은 도구·셸을 실행할 수 있어 훅과 같은 실행권한입니다 — 위험 통제는 연결 훅으로.' }), field('id', idIn), field('표시 이름', labelIn), field('종류', kindSel), field('하네스', harnessSel), codexNote, field('설명(AI가 언제 쓸지 판단 — 상시 노출)', descIn), field('쉬운 한 줄 (구성원 화면에 보이는 말)', sumIn), field('본문(마크다운)', bodyTa), field('추가 frontmatter (JSON, 선택)', fmTa), field('연결 훅 id(선택 — 위험 통제)', pairedIn), field('대상 구성원', tm.node), actions);
}
export { customHookEditor, harnessAssetEditor, };
