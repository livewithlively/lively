// context-classify.ts — 분류기 관리(#1419 T4). [맥락 관리 ▸ 분류] 화면의 '분류기' 서브탭.
//  (같은 화면의 '분류축' 서브탭은 기존 categories.ts 를 그대로 재사용한다 — 합치는 건 화면이지 데이터가 아니다.)
import { api, busy, cardHead, el, fmtNum, relTime, toast, uiText } from './core.js';
import { confirmDialog } from './admin.js';
import { stageJobCard } from './context-stage-job.js'; // 단계 공용 '언제 도나' 카드(#1618)
let editingKey = null;
let creating = false;
export async function renderClassifiers(host) {
    busy(host, el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '분류기를 불러오는 중…' })));
    let d;
    try {
        d = await api('/api/ui/org/classifiers');
    }
    catch (e) {
        host.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '불러오지 못했습니다 — ' + e.message })));
        return;
    }
    const list = d.classifiers || [];
    const cov = d.coverage || { total_unclassified: 0, uncovered: 0, classifiers: [] };
    const stat = (id) => cov.classifiers.find((x) => x.id === id) || {};
    const reload = () => { void renderClassifiers(host); };
    const body = el('div', {});
    body.append(el('p', { class: 'admin-hint' }, ...uiText('지식이 어느 갈래에 속하는지 AI 가 정합니다. 팀·도메인마다 기준이 다르면 분류기를 여러 개 만드세요 — 한 지식은 우선순위가 가장 높은 분류기 하나에만 배정됩니다.')));
    // 현황 — 사각지대를 목록보다 먼저(증류기 화면의 검증된 순서).
    const covCard = el('div', { class: 'card ctx-cov' }, cardHead('분류 현황'));
    covCard.append(el('div', { class: 'ctx-cov-row' }, el('span', { class: 'ctx-tag', text: '미분류 지식 ' + fmtNum(cov.total_unclassified) }), el('span', { class: 'ctx-tag', text: `켜진 분류기 ${list.filter((c) => c.enabled).length}/${list.length}` }), el('span', { class: 'ctx-tag' + (cov.uncovered ? ' ctx-tag-warn' : ''), text: '사각지대 ' + fmtNum(cov.uncovered) })));
    if (cov.uncovered > 0 && list.some((c) => c.enabled)) {
        covCard.append(el('p', { class: 'admin-hint ctx-warn-line' }, ...uiText(`켜진 분류기 어디에도 안 걸리는 지식이 ${fmtNum(cov.uncovered)}건 있습니다. 이대로 두면 영영 분류되지 않습니다 — 우선순위를 낮춘 넓은 분류기를 하나 만들어 나머지를 받게 하세요.`)));
    }
    body.append(covCard);
    if (!list.length && !creating) {
        // ⚠ '없습니다'로 끝내면 **아무 일도 안 일어난다**로 읽힌다 — 실제로는 전역 기본 분류가 돌고 있다.
        //  어니스트 실박스에서 정확히 그 오독이 났다: 개요는 "분류 1시간마다"인데 이 카드는 "분류기가 없습니다".
        //  그래서 제목부터 '설정 안 됨'이 아니라 '기본값으로 돌고 있음'을 말한다. 실제 잡 상태는 아래 [언제 도나]가 잰다.
        body.append(el('div', { class: 'card ctx-empty' }, el('p', { class: 'ctx-empty-t', text: '분류기 없음 — 전역 기본 분류로 돌고 있습니다' }), el('p', { class: 'admin-hint', text: '전 미분류 지식을 한 기준으로 봅니다(설정할 것이 없는 종전 동작). 팀·도메인마다 기준을 나누고 대상·모델·주기를 따로 주려면 분류기를 만드세요.' })));
    }
    for (const c of list)
        body.append(editingKey === c.key ? editor(c, reload) : summary(c, stat(c.id), reload));
    if (creating)
        body.append(editor(null, reload));
    else {
        const add = el('button', { class: 'btn btn-primary', text: '+ 분류기 만들기' });
        add.addEventListener('click', () => { creating = true; editingKey = null; reload(); });
        body.append(el('div', { class: 'ctx-actions' }, add));
    }
    host.replaceChildren(body);
    // '언제 도나' — 설정(분류기)과 실행(잡)은 별개 축이라 둘 다 안 보이면 "설정했는데 왜 안 되지"의 답이
    //  화면에 없다. host 를 이미 교체한 뒤 비동기로 붙인다 — 크론 조회(권한 없으면 403)가 이 탭 전체를 막지 않게.
    //  #1618: 종전엔 잡이 없을 때 "[설정 ▸ 자동화]에서 만드세요"라는 **문장만** 줬다(만들기 버튼도, 주기
    //   조절도 없었다). 그래서 분류를 세우려면 이 탭을 떠나야 했고, 떠나면 무엇이 밀렸는지를 못 본 채
    //   크론 목록에서 액션 이름을 골라야 했다. 이제 여기서 끝난다.
    body.append(await stageJobCard({
        stage: '분류',
        // 헤드리스판이 현행 권장 경로다(#1061 — 매 배치 새 세션이라 옛 should 로 판단하는 관성이 없다).
        //  구 세션주입판(classify_knowledge)이 켜져 있으면 그쪽을 그대로 보여 준다(멋대로 갈아타지 않는다).
        actions: ['classify_knowledge_headless', 'classify_knowledge'],
        create: {
            id: 'classify-knowledge-headless', label: '미분류 지식 분류 (헤드리스)',
            action: 'classify_knowledge_headless', params: {}, interval_sec: 3600,
            note: '켜진 분류기별로 미분류 지식 배치를 헤드리스 AI 세션에 접수. 분류기가 없으면 전역 기본 분류.',
        },
        missingLine: '분류 자동 실행이 없습니다 — 분류기를 만들어도 아무것도 분류되지 않습니다.',
        // 신규 워크스페이스에 **꺼진 채 시드되는** 구 세션주입판(classify-unmapped-knowledge)이 이 자리에 앉는다.
        //  그건 params.session 이 필수라, 상시 세션을 먼저 등록하지 않고 켜면 매 틱 "타깃 상시 세션 미설정"
        //  error 를 낸다. 그 상태에서 '켜기'를 보여주면 못 지킬 약속이 된다.
        unrunnable: (j) => (j.action === 'classify_knowledge' && !(j.params && j.params.session))
            ? '지금 등록된 분류 잡은 상시 세션이 있어야 도는 구 방식인데, 그 세션이 지정돼 있지 않습니다 — 이대로 켜면 매번 실패합니다.'
            : null,
        usesAi: true,
    }, reload));
}
const TARGET_LABEL = {
    unmapped: '미분류 지식', low_confidence: '확신도 낮은 분류 재검토', both: '미분류 + 재검토',
};
function summary(c, st, reload) {
    const card = el('div', { class: 'card ctx-row' });
    card.append(el('div', { class: 'ctx-row-head' }, el('span', { class: 'ctx-row-title', text: c.label || c.key }), el('span', { class: 'ctx-state' }, el('span', { class: 'ctxp-dot ' + (c.enabled ? 'ctxp-dot-ok' : 'ctxp-dot-off'), 'aria-hidden': 'true' }), el('span', { text: c.enabled ? '켜짐' : '꺼짐' })), el('span', { class: 'ctx-tag', text: '우선순위 ' + c.priority }), el('span', { class: 'ctx-tag', text: '맡은 지식 ' + fmtNum(st.backlog ?? 0) })));
    card.append(el('div', { class: 'ctx-row-meta', text: c.scope_text || '전체' }));
    card.append(el('div', { class: 'ctx-row-meta',
        text: c.last_run_at ? `마지막 실행 ${relTime(c.last_run_at)} · ${c.last_status || ''}` : '아직 실행된 적 없음' }));
    const acts = el('div', { class: 'ctx-row-acts' });
    const toggle = el('button', { class: 'btn btn-ghost btn-sm', text: c.enabled ? '끄기' : '켜기' });
    toggle.addEventListener('click', async () => {
        try {
            await api('/api/ui/org/classifiers', { method: 'POST', body: JSON.stringify({ id: c.id, enabled: !c.enabled }) });
            toast('저장했습니다');
            reload();
        }
        catch (e) {
            toast(e.message, true);
        }
    });
    const edit = el('button', { class: 'btn btn-ghost btn-sm', text: '설정 열기' });
    edit.addEventListener('click', () => { editingKey = c.key; creating = false; reload(); });
    const prev = el('button', { class: 'btn btn-ghost btn-sm', text: '맡은 지식 보기' });
    prev.addEventListener('click', () => openPreview(c));
    const del = el('button', { class: 'btn-text btn-text-danger', text: '삭제' });
    del.addEventListener('click', async () => {
        const ok = await confirmDialog({
            title: `‘${c.label || c.key}’ 분류기를 삭제할까요?`,
            lines: ['이미 만들어진 분류 제안은 그대로 남습니다.'], confirmText: '삭제', danger: true,
        });
        if (!ok)
            return;
        try {
            await api('/api/ui/org/classifiers/remove', { method: 'POST', body: JSON.stringify({ id: c.id }) });
            toast('삭제했습니다');
            reload();
        }
        catch (e) {
            toast(e.message, true);
        }
    });
    acts.append(toggle, prev, edit, del);
    card.append(acts);
    return card;
}
function editor(c, reload) {
    const isNew = !c;
    const card = el('div', { class: 'card ctx-editor' });
    const S = 'width:100%;padding:7px 9px;font:inherit;box-sizing:border-box';
    const F = (label, hint, ctrl) => el('div', { class: 'ctx-field' }, el('div', { class: 'field-label', text: label }), hint ? el('p', { class: 'admin-hint ctx-field-hint', text: hint }) : null, ctrl);
    const keyIn = el('input', { type: 'text', style: S, value: c?.key ?? '', placeholder: 'product-domain', ...(isNew ? {} : { disabled: true }) });
    const labelIn = el('input', { type: 'text', style: S, value: c?.label ?? '', placeholder: '제품 도메인 분류기' });
    const prioIn = el('input', { type: 'number', style: S, value: String(c?.priority ?? 0) });
    const enabledChk = el('input', { type: 'checkbox' });
    enabledChk.checked = c ? !!c.enabled : true;
    const targetSel = el('select', { style: S });
    for (const [v, t] of Object.entries(TARGET_LABEL))
        targetSel.append(el('option', { value: v, text: t }));
    targetSel.value = c?.target ?? 'unmapped';
    const spacesIn = el('input', { type: 'text', style: S, value: (c?.match_spaces || []).join(', '), placeholder: '비우면 전체 (business, product, system)' });
    const systemsIn = el('input', { type: 'text', style: S, value: (c?.match_systems || []).join(', '), placeholder: '비우면 전체 (notion, slack …)' });
    const critIn = el('textarea', { style: S + ';min-height:100px;resize:vertical',
        placeholder: '예) 제품 사양·설계 문서는 반드시 해당 도메인으로. 회의록은 주제가 여럿이면 가장 많이 다룬 쪽으로.' });
    critIn.value = c?.criteria_md ?? '';
    const candIn = el('textarea', { style: S + ';min-height:70px;resize:vertical',
        placeholder: '분류축 key 를 줄바꿈·쉼표로. 비우면 전체 중에서 고릅니다.' });
    candIn.value = (c?.candidate_categories || []).join('\n');
    const thIn = el('input', { type: 'number', style: S, step: '0.05', min: '0', max: '1', value: String(c?.confirm_threshold ?? 0.8) });
    const batchIn = el('input', { type: 'number', style: S, min: '1', max: '500', value: String(c?.batch_size ?? 50) });
    const reqIn = el('input', { type: 'text', style: S, value: c?.requester ?? '', placeholder: '비우면 잡 생성자' });
    const resetChk = el('input', { type: 'checkbox' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '분류기 만들기' : '저장' });
    saveBtn.addEventListener('click', async () => {
        const key = keyIn.value.trim();
        if (!key) {
            toast('식별자를 입력하세요', true);
            return;
        }
        saveBtn.disabled = true;
        try {
            await api('/api/ui/org/classifiers', { method: 'POST', body: JSON.stringify({
                    ...(c ? { id: c.id } : {}), key,
                    label: labelIn.value.trim() || null, enabled: enabledChk.checked,
                    priority: Number(prioIn.value) || 0, target: targetSel.value,
                    match_spaces: spacesIn.value, match_systems: systemsIn.value,
                    criteria_md: critIn.value.trim() || null, candidate_categories: candIn.value,
                    confirm_threshold: Number(thIn.value), batch_size: Number(batchIn.value) || 50,
                    requester: reqIn.value.trim() || null,
                    reset_seen: resetChk.checked,
                }) });
            toast(isNew ? '분류기를 만들었습니다' : '저장했습니다');
            editingKey = null;
            creating = false;
            reload();
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
            saveBtn.disabled = false;
        }
    });
    const cancelBtn = el('button', { class: 'btn-text', text: '닫기' });
    cancelBtn.addEventListener('click', () => { editingKey = null; creating = false; reload(); });
    card.append(el('div', { class: 'ctx-row-head' }, el('span', { class: 'ctx-row-title', text: isNew ? '새 분류기' : `설정 — ${c.label || c.key}` })), F('식별자', isNew ? '영문·숫자 슬러그. 만든 뒤에는 바꾸지 않습니다.' : '만든 뒤에는 바꾸지 않습니다.', keyIn), F('이름', '목록에 보일 이름입니다.', labelIn), F('우선순위', '높을수록 지식을 먼저 가져갑니다. 낮은 값 + 넓은 범위 = 나머지를 받는 기본 분류기.', prioIn), F('무엇을 분류할까', '미분류만 볼지, 이미 붙었지만 확신이 낮은 것도 다시 볼지 정합니다.', targetSel), F('대상 갈래 제한', '이 space 의 지식만 봅니다. 비우면 전체.', spacesIn), F('대상 출처 제한', '이 출처에서 온 지식만 봅니다. 비우면 전체.', systemsIn), F('분류 기준', '이 팀에서 무엇을 어디에 넣을지 그대로 쓰세요. 이 문장이 AI 의 판단 기준이 됩니다.', critIn), F('후보 분류축 제한', '이 축들 중에서만 고르게 합니다. 팀이 자기 갈래 안에서만 분류하게 할 때.', candIn), F('확정 기준 확신도', '이 값 이상이면 바로 확정, 미만이면 사람 검토로 보냅니다. 높일수록 사람 손이 늘고 정확해집니다.', thIn), F('한 번에 처리할 지식 수', '', batchIn), F('의뢰자', '이 사람의 AI 계정으로 실행되고 과금됩니다.', reqIn), el('label', { class: 'admin-check' }, resetChk, ' 이미 판정한 지식을 다시 보기 — 기준을 바꿨을 때 켜세요'), el('label', { class: 'admin-check' }, enabledChk, ' 이 분류기 사용'), el('div', { class: 'ctx-actions' }, saveBtn, cancelBtn));
    return card;
}
async function openPreview(c) {
    const { overlay } = await import('./ui-primitives.js');
    const box = el('div', {}, el('p', { class: 'admin-hint', text: '확인 중…' }));
    overlay(`맡은 지식 — ${c.label || c.key}`, box);
    try {
        const r = await api('/api/ui/org/classifiers/preview?' + new URLSearchParams({ key: c.key, limit: '20' }));
        const sample = r.sample || [];
        if (!sample.length) {
            box.replaceChildren(el('p', { class: 'admin-hint', text: '지금 맡은 지식이 0건입니다 — 범위가 좁거나, 우선순위가 높은 분류기가 먼저 가져갔거나, 이미 판정한 것들입니다(설정에서 “다시 보기”를 켜면 되돌릴 수 있습니다).' }));
            return;
        }
        const list = el('div', { class: 'ctx-preview-list' });
        for (const s of sample) {
            list.append(el('div', { class: 'ctx-preview-row' }, el('a', { class: 'ctx-preview-t', href: '#/k/' + encodeURIComponent(s.name), text: s.title || s.name }), el('div', { class: 'ctx-preview-m', text: [s.type, s.provenance === 'observed' ? '미러' : '저작'].filter(Boolean).join(' · ') })));
        }
        box.replaceChildren(el('p', { class: 'admin-hint', text: `지금 맡은 지식 ${fmtNum(r.backlog)}건 중 ${sample.length}건입니다.` }), list);
    }
    catch (e) {
        box.replaceChildren(el('p', { class: 'admin-hint', text: '실패: ' + e.message }));
    }
}
