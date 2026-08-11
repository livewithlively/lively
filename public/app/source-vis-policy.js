// #1291 v4 관리탭 ▸ AI 맥락 ▸ 자료 공개범위 — 커넥터(+채널)별로 수집물의 공개범위를 정한다.
//
//  왜 이 화면이 필요한가: 자료의 생산자는 사람이 아니라 커넥터다. 개별 자료를 하나씩 잠그는 건 현실적이지
//  않아(어니스트 실측 슬랙 11,378건/67채널) 생산 지점에 규칙을 건다. 화면의 일은 **규칙 한 줄이 무엇을
//  뜻하는지** 보이게 하는 것이다 — 어느 자료에 걸리고(매칭) 누가 보게 되나(대상).
//
//  ⚠ 두 가지를 화면이 분명히 해야 한다:
//   ① **채널은 매칭 축일 뿐, 슬랙 채널 멤버십을 따르는 게 아니다.** 대상은 라이블리에서 따로 고른다
//     (슬랙 신원 매핑이 없어 자동 연결이 불가능하다 — 실측 0/66명). 안 그러면 "채널 멤버면 보이겠지"로 오해한다.
//   ② **규칙은 앞으로 수집되는 것에 적용된다.** 이미 쌓인 자료는 소급 적용(백필)을 눌러야 한다. 이걸 안 보이게
//     하면 "정책을 켰는데 옛 자료가 그대로 보인다"가 된다.
import { api, el, errorNote, toast } from './core.js';
import { overlayBox, skeleton } from './learn.js';
// ⚠ 배럴(./projects.js)에서 가져오면 프로젝트 모듈 그래프 전체를 끌고 와 admin ↔ projects ↔ terminal
//  **import 순환**이 생긴다(CI check-imports 가 419건을 잡았다). 프리미티브가 실제로 사는 모듈에서 직접 가져온다.
import { compactPicker } from './projects/popover.js';
import { memberPicker } from './projects/files.js';
import { sectionHead } from './admin-widgets.js';
export async function sourceVisPolicyPanel(detail) {
    const reload = () => sourceVisPolicyPanel(detail);
    const head = () => sectionHead('자료 공개범위', '슬랙·지메일 같은 커넥터로 수집되는 자료를 누가 볼 수 있는지 정합니다. 채널별로 예외를 둘 수 있어요.');
    detail.replaceChildren(el('div', {}, head(), el('div', { class: 'card' }, skeleton('정책을 불러오는 중'))));
    let data, targets;
    try {
        [data, targets] = await Promise.all([api('/api/ui/source-vis-policy'), api('/api/ui/source-vis-policy/targets')]);
    }
    catch (e) {
        // Enterprise 미탑재(#1601) — 이건 고장이 아니라 '이 배포엔 없는 기능'이다. 에러로 그리면 관리자는
        //  서버 장애·권한 문제와 구분하지 못하고 새로고침만 반복한다. 무엇이 없어서 안 되는지 그대로 말한다.
        const body = e?.body?.enterprise_required
            ? el('div', { class: 'svp-warn' }, el('b', { text: '이 배포에는 자료 공개범위 정책 기능이 없어요' }), el('span', { text: String(e.message ?? '') }))
            : errorNote(e, '정책을 불러오지 못했습니다');
        detail.replaceChildren(el('div', {}, head(), el('div', { class: 'card' }, body)));
        return;
    }
    const rules = data.rules || [];
    const axisOn = data.axis_on !== false;
    // 축이 꺼져 있으면 여기서 정한 규칙이 강제되지 않는다 — 설정만 남고 안 걸리는 상태를 만들지 않게 먼저 말한다.
    const axisWarn = axisOn ? null : el('div', { class: 'svp-warn' }, el('b', { text: '자료 공개범위가 꺼져 있어요' }), el('span', { text: '여기서 규칙을 만들어도 지금은 강제되지 않습니다. [맥락 공개범위]에서 자료 축을 먼저 켜세요.' }));
    const addBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '+ 규칙 추가' });
    addBtn.onclick = () => openRuleForm(null, targets, reload);
    const backfillBtn = el('button', { class: 'btn', type: 'button', text: '기존 자료에 소급 적용' });
    backfillBtn.onclick = () => openBackfill(reload);
    detail.replaceChildren(el('div', {}, head(), el('div', { class: 'card' }, axisWarn, el('p', { class: 'muted', text: '규칙은 앞으로 수집되는 자료에 적용됩니다. 채널을 지정한 규칙이 커넥터 전체 규칙보다 우선해요. ' +
            '이미 쌓인 자료에도 적용하려면 [기존 자료에 소급 적용]을 누르세요.' }), rules.length ? el('div', { class: 'svp-list' }, ...rules.map((r) => ruleRow(r, targets, reload)))
        : el('p', { class: 'admin-hint', text: '아직 규칙이 없어요 — 모든 수집 자료가 전원에게 공개됩니다.' }), el('div', { class: 'svp-actions' }, addBtn, backfillBtn))));
}
function ruleRow(r, targets, reload) {
    const scope = r.match_channel
        ? el('span', { class: 'svp-scope' }, el('b', { text: r.match_system }), el('span', { text: ' ▸ ' + r.match_channel }))
        : el('span', { class: 'svp-scope' }, el('b', { text: r.match_system }), el('span', { class: 'muted', text: ' 전체' }));
    const who = r.visibility === 'members'
        ? el('span', { class: 'svp-who' }, '🔒 ' + (r.members || []).length + '명/팀만')
        : el('span', { class: 'svp-who svp-open', text: '전원 공개' });
    const edit = el('button', { class: 'btn-text', type: 'button', text: '수정' });
    edit.onclick = () => openRuleForm(r, targets, reload);
    const del = el('button', { class: 'btn-text', type: 'button', text: '삭제' });
    del.onclick = async () => {
        if (!confirm(`이 규칙을 지울까요?\n\n이미 잠긴 자료의 공개범위는 그대로 남고, 앞으로 수집되는 것만 달라집니다.`))
            return;
        try {
            await api('/api/ui/source-vis-policy/delete', { method: 'POST', body: JSON.stringify({ id: r.id }) });
            reload();
        }
        catch (e) {
            toast('지우지 못했습니다 — ' + e.message, true);
        }
    };
    // 이 규칙이 지금 몇 건에 걸리나 — 0건이면 잠근 줄 알았는데 아무것도 안 잠긴 상태다(조용한 무효).
    const hits = typeof r.matches === 'number'
        ? (r.matches > 0
            ? el('span', { class: 'svp-hits', text: `자료 ${r.matches}건` })
            : el('span', { class: 'svp-hits svp-zero', title: '이 조건에 맞는 자료가 없어요 — 채널명이 다르거나 아직 수집되지 않았을 수 있어요',
                text: '⚠ 걸리는 자료 0건' }))
        : null;
    return el('div', { class: 'svp-row' + (r.visibility === 'members' ? ' locked' : '') }, el('div', { class: 'svp-main' }, scope, who, hits), el('div', { class: 'svp-row-actions' }, edit, del));
}
function openRuleForm(r, targets, reload) {
    const editing = !!r;
    const systems = (targets && targets.systems) || [];
    // ⚠ 커넥터·채널을 타이핑하게 두지 않는다. 오타 한 글자면 규칙이 **아무것도 안 걸리는데** 화면은 저장됐다고
    //  말한다 — 권한 기능에서 가장 나쁜 실패(조용한 무효)다. 실제 수집된 값에서만 고르게 하고 건수를 함께 보여준다.
    const sysIn = el('select', { class: 'inp' });
    const chIn = el('select', { class: 'inp' });
    const paintSystems = () => {
        sysIn.replaceChildren(el('option', { value: '', text: systems.length ? '— 커넥터 선택 —' : '수집된 자료가 없어요' }), ...systems.map((sv) => el('option', { value: sv.system, text: `${sv.system} (자료 ${sv.n}건)` })));
        if (r?.match_system)
            sysIn.value = r.match_system;
    };
    const paintChannels = () => {
        const sv = systems.find((x) => x.system === sysIn.value);
        const chans = (sv && sv.channels) || [];
        chIn.replaceChildren(el('option', { value: '', text: '이 커넥터 전체' }), ...chans.map((c) => el('option', { value: c.name, text: `${c.name} (${c.n}건)` })));
        if (r?.match_channel) {
            // 저장된 채널이 지금 목록에 없을 수 있다(수집이 멈췄거나 이름이 바뀜) — 값을 잃지 않게 그대로 살려 둔다.
            if (!chans.some((c) => c.name === r.match_channel)) {
                chIn.append(el('option', { value: r.match_channel, text: `${r.match_channel} (지금은 자료 없음)` }));
            }
            chIn.value = r.match_channel;
        }
        chIn.disabled = !sysIn.value;
    };
    paintSystems();
    paintChannels();
    sysIn.onchange = () => paintChannels();
    let vis = r?.visibility === 'members' ? 'members' : 'open';
    const sw = el('span', { class: 'pjv-switch' + (vis === 'members' ? ' on' : '') }, el('span', { class: 'pjv-switch-knob' }));
    const visRow = el('div', { class: 'pjv-visrow' + (vis === 'members' ? ' on' : ''), role: 'switch', tabindex: '0',
        'aria-checked': vis === 'members' ? 'true' : 'false' }, el('span', { class: 'pjv-visrow-txt' }, el('span', { class: 'pjv-visrow-title', text: '공개범위를 지정한 사람으로 제한' }), el('span', { class: 'pjv-visrow-hint', text: '켜면 이 규칙에 걸리는 자료와 거기서 증류된 지식이 대상 외에는 보이지 않아요.' })), sw);
    // 대상 컨트롤은 리스트·스페이스·공유폴더와 **같은 것**을 쓴다 — 같은 개념이 화면마다 다르게 생기면 규칙을 두 번 배운다.
    const preselect = (r?.members || []).filter((m) => m.subject_kind !== 'team').map((m) => m.member_id);
    const picker = compactPicker('공개 대상', (onChange) => memberPicker(preselect, { includeMe: !editing, onChange }), { emptyText: '대상 없음 — 저장할 수 없어요', avatars: true, maxChips: 6 });
    const audField = el('div', { class: 'field', style: 'margin-top:12px' + (vis === 'members' ? '' : ';display:none') }, el('label', { class: 'field-label', text: '공개 대상' }), picker.trigger, 
    // 오해 방지 — 이 한 줄이 이 화면에서 가장 중요하다.
    el('div', { class: 'admin-hint', style: 'margin-top:6px',
        text: '※ 채널은 “어느 자료에 이 규칙을 걸지” 고르는 조건일 뿐이에요. 슬랙 채널 멤버가 자동으로 대상이 되지는 않습니다 — 여기서 직접 고르세요.' }));
    const toggle = () => {
        vis = vis === 'members' ? 'open' : 'members';
        const on = vis === 'members';
        visRow.classList.toggle('on', on);
        sw.classList.toggle('on', on);
        visRow.setAttribute('aria-checked', on ? 'true' : 'false');
        audField.style.display = on ? '' : 'none';
    };
    visRow.onclick = (e) => { e.stopPropagation(); toggle(); };
    visRow.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
    } });
    const save = el('button', { class: 'btn btn-primary', type: 'button', text: '저장' });
    const cancel = el('button', { class: 'btn', type: 'button', text: '취소' });
    const back = overlayBox(editing ? '규칙 수정' : '새 규칙', el('div', { class: 'field' }, el('label', { class: 'field-label', text: '커넥터' }), sysIn), el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '채널 (선택 — 비우면 커넥터 전체)' }), chIn), el('div', { class: 'field', style: 'margin-top:12px' }, visRow), audField, el('div', { class: 'ov-actions' }, save, cancel));
    cancel.onclick = () => back.remove();
    save.onclick = async () => {
        const body = {
            id: r?.id, match_system: sysIn.value.trim(),
            match_channel: chIn.value.trim() || undefined,
            visibility: vis,
            members: vis === 'members' ? picker.getSelected().map((id) => ({ member_id: id })) : [],
        };
        if (!body.match_system) {
            toast('커넥터를 고르세요', true);
            return;
        }
        save.disabled = true;
        try {
            const res = await api('/api/ui/source-vis-policy', { method: 'POST', body: JSON.stringify(body) });
            back.remove();
            reload();
            // 저장은 됐지만 걸리는 자료가 0건이면 조용히 넘어가지 않는다 — 잠근 줄 알고 끝내는 게 제일 위험하다.
            if (res && res.matches === 0)
                toast('저장했지만 지금 이 조건에 맞는 자료가 0건이에요 — 채널 이름을 확인하세요', true);
        }
        catch (e) {
            save.disabled = false;
            toast(e.message, true);
        }
    };
}
/** 소급 적용 — 되돌리기 어려운 대량 변경이라 **미리보기를 먼저 보여주고** 확인을 받는다(서버도 기본이 dry_run). */
function openBackfill(reload) {
    const out = el('div', { class: 'svp-dry' }, el('span', { class: 'admin-hint', text: '무엇이 바뀌는지 확인하는 중…' }));
    const go = el('button', { class: 'btn btn-danger', type: 'button', text: '적용', disabled: true });
    const cancel = el('button', { class: 'btn', type: 'button', text: '닫기' });
    const back = overlayBox('기존 자료에 소급 적용', el('p', { class: 'muted', text: '지금 규칙을 이미 수집된 자료에 적용합니다. 먼저 무엇이 바뀌는지 확인하세요.' }), out, el('div', { class: 'ov-actions' }, go, cancel));
    cancel.onclick = () => back.remove();
    (async () => {
        try {
            const d = await api('/api/ui/source-vis-policy/backfill', { method: 'POST', body: JSON.stringify({}) });
            out.replaceChildren(el('div', { class: 'svp-warn' }, el('b', { text: `${d.locked}건이 새로 잠깁니다` }), el('span', { text: `검사 ${d.scanned}건 · 이미 잠김 ${d.already_locked}건 · 규칙 없음 ${d.no_rule}건` })), (d.samples || []).length
                ? el('ul', { class: 'vax-samples' }, ...(d.samples || []).map((s) => el('li', { text: String(s) })))
                : null);
            go.disabled = !d.locked;
        }
        catch (e) {
            out.replaceChildren(errorNote(e, '미리보기에 실패했습니다'));
        }
    })();
    go.onclick = async () => {
        go.disabled = true;
        try {
            const d = await api('/api/ui/source-vis-policy/backfill', { method: 'POST', body: JSON.stringify({ dry_run: false }) });
            toast(`${d.locked}건에 적용했습니다`);
            back.remove();
            reload();
        }
        catch (e) {
            go.disabled = false;
            toast('적용하지 못했습니다 — ' + e.message, true);
        }
    };
}
