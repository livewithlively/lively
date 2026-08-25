// context-collectors.ts — 수집기 관리(#1419 T1·T2·T3). [맥락 관리 ▸ 수집] 화면.
//
//  구 [설정 ▸ 외부 자료 수집](admin-connectors.ts)과의 차이: 저것은 **커넥터 종류 목록**이었다(슬랙 칸 하나,
//  노션 칸 하나 — 고정된 7줄). 여기는 **내가 만든 수집기 목록**이다. 같은 슬랙으로 셋을 만들 수 있고,
//  각자 자기 계정·범위·주기·산출정책을 갖는다. 그래서 화면 문법도 '설정 폼'이 아니라 '목록 + 만들기'다.
//
//  화면 설계(증류기 화면의 검증된 문법을 따른다 — 같은 자리에서 비교하며 만지게):
//   · 목록과 편집이 한 페이지에. 편집을 모달로 띄우면 다른 수집기의 상태를 못 보면서 설정하게 된다.
//   · 만들기는 **프리셋 고르기부터** — 무엇을 붙이는지가 첫 결정이고, 나머지는 그 결정에서 파생된다.
import { api, busy, cardHead, el, relTime, toast, uiText } from './core.js';
import { confirmDialog } from './admin.js';
import { overlay } from './ui-primitives.js';
import { stageJobCard } from './context-stage-job.js'; // 단계 공용 '언제 도나' 카드(#1618)
let editingId = null;
let creatingPreset = null; // 프리셋을 고른 뒤 생성 폼
let choosingPreset = false;
export async function renderCollectors(host) {
    busy(host, el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '수집기를 불러오는 중…' })));
    let d;
    try {
        d = await api('/api/ui/org/collectors');
    }
    catch (e) {
        host.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '불러오지 못했습니다 — ' + e.message })));
        return;
    }
    const collectors = d.collectors || [];
    const presets = (d.presets || []).filter((p) => p.enabled !== false);
    // 편집 가능 여부는 **서버 판정을 그대로 받는다**(scope 를 프론트가 재해석하지 않는다) — 어긋나면
    //  버튼은 있는데 눌러야 403 이 나고, 사용자는 '고장'으로 읽는다.
    const canEdit = !!d.canEdit;
    const reload = () => { void renderCollectors(host); };
    const body = el('div', {});
    body.append(el('p', { class: 'admin-hint' }, ...uiText('슬랙·노션 같은 외부 도구의 내용을 주기적으로 가져옵니다. 같은 종류로 여러 개를 만들 수 있습니다 — 워크스페이스가 둘이거나, 채널 그룹마다 주기·산출 방식을 다르게 하고 싶을 때 나눠서 만드세요.')));
    // 권한 안내는 **모두에게** 보인다(관리자에게도). 관리자만 보이는 안내는 정작 막힌 사람에게 안 닿고,
    //  비-admin 에게만 보이면 관리자는 자기 화면과 남의 화면이 다르다는 걸 모른 채 "그냥 만드세요"라고 말한다.
    //  비-admin 에겐 여기에 [읽기 전용] 표식이 더 붙는다(무엇이 다른지가 한 줄 안에서 끝나게).
    body.append(el('p', { class: 'admin-hint ctx-perm-line' }, canEdit ? null : el('span', { class: 'pill', text: '읽기 전용' }), el('span', { class: 'admin-only-badge', text: '관리자' }), ' 수집기를 만들고 고치고 삭제하는 일과 [지금 수집]은 관리자 전용입니다 — 외부 서비스의 접속 토큰을 다루기 때문입니다. ', canEdit ? '무엇이 언제 수집되는지는 모든 구성원이 볼 수 있습니다.'
        : '무엇이 언제 수집되는지는 아래에서 그대로 보실 수 있습니다.'));
    // '내 컴퓨터' 정보 타일(#1881 L5) — 수집기 인스턴스가 아니다(자격 0·싱크 잡 0): 사람이 파일을 끌어다 놓는
    //  순간이 곧 수집이라, 여기선 '들어오고 있는지'만 보여준다. 로컬이 첫 번째 수집원이라는 결정(0824 회의)대로 맨 앞.
    body.append(await localTile());
    if (!collectors.length && !creatingPreset && !choosingPreset) {
        body.append(el('div', { class: 'card ctx-empty' }, el('p', { class: 'ctx-empty-t', text: '아직 수집기가 없습니다' }), el('p', { class: 'admin-hint', text: canEdit
                ? '외부 도구를 연결하면 그 내용이 자료로 쌓이고, 다음 단계(증류)가 그중 남길 가치가 있는 것을 지식으로 만듭니다.'
                : '외부 도구가 아직 연결되지 않았습니다. 연결은 관리자가 합니다 — 필요한 도구가 있으면 관리자에게 요청하세요.' })));
    }
    for (const c of collectors) {
        body.append(canEdit && editingId === c.id
            ? collectorEditor(c, presets, reload)
            : collectorSummary(c, reload, canEdit));
    }
    // 편집 UI(프리셋 고르기·에디터·만들기 버튼)는 admin 에게만. 위 안내가 '왜 없는지'를 이미 말했으므로
    //  여기서 또 비활성 버튼을 그리지 않는다 — 누를 수 없는 버튼은 안내가 아니라 미끼다.
    if (!canEdit) {
        host.replaceChildren(body);
        return;
    }
    if (choosingPreset)
        body.append(presetChooser(presets, reload));
    else if (creatingPreset) {
        const p = presets.find((x) => x.key === creatingPreset);
        body.append(p ? collectorEditor(null, presets, reload, p) : el('div', {}));
    }
    else {
        const add = el('button', { class: 'btn btn-primary', text: '+ 수집기 만들기' });
        add.addEventListener('click', () => { choosingPreset = true; editingId = null; reload(); });
        body.append(el('div', { class: 'ctx-actions' }, add));
    }
    host.replaceChildren(body);
    // '언제 도나'(#1618) — 이 단계만 잡을 스스로 소유한다(수집기를 켜면 syncCollectorJob 이 크론을 만들고
    //  켠다). 그래서 만들기 버튼은 주지 않되, **주기·지금 실행·마지막 실행 결과**는 다른 세 단계와 같은
    //  자리·같은 말로 보여 준다 — 네 단계의 실행 상태를 같은 시각 언어로 읽을 수 있어야 '어디가 막혔나'가
    //  단계를 오가며 비교된다. host 교체 뒤 비동기로 붙인다(크론 조회 403 이 이 탭을 막지 않게).
    body.append(await stageJobCard({
        stage: '수집',
        actions: ['connector_sync'],
        // ⚠ id 로 한 번 더 거른다 — `connector_sync` 를 쓰는 잡이 두 계보다. 수집기 소유(`collector-<id>`)와
        //  구 커넥터 축(`sync-<system>`). 후자를 집으면 이 카드가 엉뚱한 잡을 가리키고, 켜기 버튼이 봉인된
        //  잡을 되살린다 — sync-clickup 은 커넥터가 꺼진 채 홀로 돌며 사람이 지운 리스트를 4분마다 되살린
        //  전력으로 비활성해 둔 것이다(#1534). 실제로 이 필터 없이 짰더니 화면이 정확히 그걸 집었다.
        matchId: (id) => id.startsWith('collector-'),
        readOnly: true, // 잡의 주인은 수집기(enabled → syncCollectorJob). 여기서 켜고 끄면 주인과 어긋난다.
        missingLine: '자동 수집이 아직 없습니다 — 켜진 수집기가 없기 때문입니다.',
        managedElsewhere: '수집은 잡을 따로 만들지 않습니다. 위에서 수집기를 켜면 그 수집기의 자동 싱크가 함께 등록되고, 끄면 같이 멈춥니다.',
    }, reload));
}
// ── '내 컴퓨터' 타일(#1881 L5) — 로컬 업로드가 자료로 쌓이는 현황. 만들 것도 켤 것도 없다. ──
//  숫자 셋: 자료 n건(source_list kind=local_file total) · 마지막 접수 · 읽지 않은 폴더(local 채널 중 미증류 남은 것).
async function localTile() {
    const card = el('div', { class: 'card ctx-row' });
    card.append(el('div', { class: 'ctx-row-head' }, el('span', { class: 'ctx-row-title', text: '내 컴퓨터' }), el('span', { class: 'ctx-tag', text: '올리는 순간 수집' })));
    let meta = '파일이나 폴더를 자료 칸·세션 입력창에 끌어다 놓으면 그대로 자료가 됩니다.';
    let folders = '';
    try {
        const [src, ch] = await Promise.all([
            api('/api/ui/sources?kind=local_file&limit=1'),
            api('/api/ui/org/source-channels?limit=200'),
        ]);
        const total = Number(src?.total || 0);
        const last = src?.entries?.[0]?.updated_at ? new Date(src.entries[0].updated_at) : null;
        const undone = (ch?.channels || []).filter((c) => c.kind === 'local_file' && Number(c.undistilled) > 0);
        if (total > 0) {
            meta = `자료 ${total.toLocaleString()}건` + (last ? ` · 마지막 접수 ${last.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '');
            if (undone.length)
                folders = `읽지 않은 폴더 ${undone.length}개 — ` + undone.slice(0, 4).map((c) => `${c.channel ?? '(폴더 없음)'} ${c.undistilled}건`).join(' · ') + (undone.length > 4 ? ' …' : '');
        }
    }
    catch { /* 조회 실패 — 안내 문구만 남긴다 */ }
    card.append(el('div', { class: 'ctx-row-meta', text: meta }));
    if (folders)
        card.append(el('div', { class: 'ctx-row-meta', text: folders }));
    card.append(el('p', { class: 'admin-hint', text: '데스크톱 앱으로 프로젝트 폴더를 쓰면 그 안의 문서도 저절로 따라 들어옵니다. 올린 파일 가운데 남길 가치가 있는 것은 라이블리가 읽어 지식으로 정리합니다.' }));
    return card;
}
/** 접힌 카드 — 무엇을·어디서·어떻게 내보내는지 한 줄로. canEdit=false 면 상태만 보이고 액션 줄은 없다. */
function collectorSummary(c, reload, canEdit = true) {
    const card = el('div', { class: 'card ctx-row' });
    const outLabel = c.output_mode === 'source' ? '자료로 저장'
        : c.output_mode === 'knowledge' ? '지식 직행'
            : c.output_mode === 'both' ? '자료 + 지식' : '기본';
    card.append(el('div', { class: 'ctx-row-head' }, el('span', { class: 'ctx-row-title', text: c.label || c.key }), el('span', { class: 'ctx-tag', text: c.preset_label }), el('span', { class: 'ctx-state' }, el('span', { class: 'ctxp-dot ' + (c.enabled ? 'ctxp-dot-ok' : 'ctxp-dot-off'), 'aria-hidden': 'true' }), el('span', { text: c.enabled ? '켜짐' : '꺼짐' })), el('span', { class: 'ctx-tag', text: outLabel })));
    const secTotal = (c.fields || []).filter((f) => f.secret).length;
    const secSet = Object.values(c.secretsSet || {}).filter(Boolean).length;
    const meta = [];
    if (secTotal)
        meta.push(`토큰 ${secSet}/${secTotal} 등록`);
    meta.push(c.sync_interval_sec >= 3600
        ? `${Math.round(c.sync_interval_sec / 3600)}시간마다`
        : `${Math.max(1, Math.round(c.sync_interval_sec / 60))}분마다`);
    if (c.last_run)
        meta.push(`최근 ${relTime(c.last_run.started_at)} · ${c.last_run.status === 'ok' ? '성공' : c.last_run.status === 'running' ? '진행 중' : '실패'}`);
    else
        meta.push('아직 실행된 적 없음');
    card.append(el('div', { class: 'ctx-row-meta', text: meta.join(' · ') }));
    // 읽는 사람에게는 여기서 끝 — 상태·주기·최근 실행까지가 '무엇이 언제 수집되나'의 전부다.
    if (!canEdit)
        return card;
    const acts = el('div', { class: 'ctx-row-acts' });
    const toggle = el('button', { class: 'btn btn-ghost btn-sm', text: c.enabled ? '끄기' : '켜기' });
    toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        try {
            await api('/api/ui/org/collectors', { method: 'POST', body: JSON.stringify({ id: c.id, enabled: !c.enabled }) });
            toast(c.enabled ? '껐습니다' : '켰습니다 — 자동 수집이 등록됐습니다');
            reload();
        }
        catch (e) {
            toast(e.message, true);
            toggle.disabled = false;
        }
    });
    const sync = el('button', { class: 'btn btn-ghost btn-sm', text: '지금 수집' });
    sync.addEventListener('click', async () => {
        try {
            const r = await api(`/api/ui/org/collectors/${c.id}/sync`, { method: 'POST', body: '{}' });
            toast(r.already_running ? '이미 실행 중입니다' : '수집을 시작했습니다');
            openRunLog(c, r.run_id);
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
        }
    });
    const edit = el('button', { class: 'btn btn-ghost btn-sm', text: '설정 열기' });
    edit.addEventListener('click', () => { editingId = c.id; creatingPreset = null; choosingPreset = false; reload(); });
    const del = el('button', { class: 'btn-text btn-text-danger', text: '삭제' });
    del.addEventListener('click', async () => {
        const ok = await confirmDialog({
            title: `‘${c.label || c.key}’ 수집기를 삭제할까요?`,
            lines: ['이미 수집된 자료와 지식은 그대로 남습니다.',
                '같은 이름으로 다시 만들면 중단된 지점부터 이어서 수집합니다.'],
            confirmText: '삭제', danger: true,
        });
        if (!ok)
            return;
        try {
            await api(`/api/ui/org/collectors/${c.id}/remove`, { method: 'POST', body: '{}' });
            toast('삭제했습니다');
            reload();
        }
        catch (e) {
            toast(e.message, true);
        }
    });
    acts.append(toggle, sync, edit, del);
    card.append(acts);
    return card;
}
/** 프리셋 고르기 — 만들기의 첫 화면. 내장과 커스텀을 갈라 보여 준다. */
function presetChooser(presets, reload) {
    const card = el('div', { class: 'card' }, cardHead('무엇을 연결할까요?'));
    const builtin = presets.filter((p) => p.builtin);
    const custom = presets.filter((p) => !p.builtin);
    const grid = (list) => {
        const g = el('div', { class: 'ctx-preset-grid' });
        for (const p of list) {
            const b = el('button', { class: 'ctx-preset', type: 'button' });
            b.append(el('span', { class: 'ctx-preset-t', text: p.label }), el('span', { class: 'ctx-preset-d', text: p.description || driverHint(p.driver) }));
            b.addEventListener('click', () => { creatingPreset = p.key; choosingPreset = false; reload(); });
            g.append(b);
        }
        return g;
    };
    if (builtin.length) {
        card.append(el('p', { class: 'ctx-sub', text: '기본 제공' }), grid(builtin));
    }
    if (custom.length) {
        card.append(el('p', { class: 'ctx-sub', text: '직접 만든 방식' }), grid(custom));
    }
    card.append(el('p', { class: 'admin-hint', style: 'margin-top:12px' }, ...uiText('찾는 도구가 없나요? [설정 ▸ 수집 방식]에서 사내 API·RSS·웹훅을 코드 없이 직접 정의할 수 있습니다.')));
    const cancel = el('button', { class: 'btn-text', text: '취소' });
    cancel.addEventListener('click', () => { choosingPreset = false; reload(); });
    card.append(el('div', { class: 'ctx-actions' }, cancel));
    return card;
}
function driverHint(driver) {
    return driver === 'http' ? '사내 API 를 직접 정의한 방식'
        : driver === 'rss' ? 'RSS·Atom 피드'
            : driver === 'webhook' ? '외부에서 밀어 넣는 방식'
                : driver === 'clone' ? '기본 제공을 변형한 템플릿' : '';
}
/** 편집기 — 만들기와 수정이 같은 폼(다른 것은 프리셋 고정 여부뿐). */
function collectorEditor(c, presets, reload, newPreset) {
    const isNew = !c;
    const preset = newPreset ?? presets.find((p) => p.key === c.preset_key) ?? { key: c?.preset_key, label: c?.preset_label, fields: c?.fields ?? [], guide: c?.guide };
    const card = el('div', { class: 'card ctx-editor' });
    const S = 'width:100%;padding:7px 9px;font:inherit;box-sizing:border-box';
    const F = (label, hint, ctrl) => el('div', { class: 'ctx-field' }, el('div', { class: 'field-label', text: label }), hint ? el('p', { class: 'admin-hint ctx-field-hint', text: hint }) : null, ctrl);
    const labelIn = el('input', { type: 'text', style: S, value: c?.label ?? '',
        placeholder: isNew ? `${preset.label} — 예: 제품팀 채널` : '' });
    const keyIn = el('input', { type: 'text', style: S, value: c?.key ?? '',
        placeholder: '비우면 자동 생성', ...(isNew ? {} : { disabled: true }) });
    const enabledChk = el('input', { type: 'checkbox' });
    enabledChk.checked = c ? !!c.enabled : true;
    // 설정 필드 — 프리셋이 정한다(시크릿은 값 비노출, 빈 값 = 미변경).
    const inputs = {};
    const fieldEls = [];
    for (const f of (preset.fields || [])) {
        const isSet = c?.secretsSet?.[f.key];
        const inp = el('input', {
            type: 'text', style: S,
            value: f.secret ? '' : (c?.config?.[f.key] ?? ''),
            placeholder: f.secret ? (isSet ? '● 설정됨 — 바꿀 때만 입력' : (f.hint || '')) : (f.hint || ''),
            ...(f.secret ? { class: 'secret-input', autocomplete: 'off', spellcheck: 'false' } : {}),
        });
        inputs[f.key] = { el: inp, secret: !!f.secret };
        // 픽커 지원 필드(노션 페이지·클릭업 리스트) — 저장된 수집기에서만 조회할 수 있다(토큰이 있어야 하므로).
        const ctrl = (f.picker && c)
            ? el('div', { class: 'ctx-pick-row' }, inp, el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '목록에서 선택',
                onclick: () => openScopePicker(c, f, inp) }))
            : inp;
        fieldEls.push(F((f.label || f.key) + (f.required ? ' *' : ''), f.hint && !f.picker ? null : (f.hint ?? null), ctrl));
    }
    // 주기
    const intervalSel = el('select', { style: S });
    for (const [v, t] of [[300, '5분마다'], [600, '10분마다'], [1800, '30분마다'], [3600, '1시간마다'], [21600, '6시간마다'], [86400, '하루에 한 번']]) {
        intervalSel.append(el('option', { value: String(v), text: t }));
    }
    intervalSel.value = String(c?.sync_interval_sec ?? 600);
    // 산출 정책(T3)
    const outSel = el('select', { style: S });
    outSel.append(el('option', { value: 'preset', text: '기본 — 이 도구에 맞는 방식으로' }));
    outSel.append(el('option', { value: 'source', text: '자료로 저장 — 증류기가 골라 지식으로' }));
    outSel.append(el('option', { value: 'knowledge', text: '지식 직행 — 가져오는 즉시 지식으로' }));
    outSel.append(el('option', { value: 'both', text: '둘 다 — 원문을 남기면서 지식도' }));
    outSel.value = c?.output_mode ?? 'preset';
    const catIn = el('input', { type: 'text', style: S,
        value: c?.output_config?.target_category ?? '', placeholder: '비우면 분류기가 정합니다' });
    const catField = F('지식 분류 고정', '지식 직행일 때, 만들어진 지식을 항상 이 분류에 넣습니다.', catIn);
    const syncCatVis = () => { catField.hidden = outSel.value !== 'knowledge' && outSel.value !== 'both'; };
    outSel.addEventListener('change', syncCatVis);
    syncCatVis();
    const noteIn = el('input', { type: 'text', style: S, value: c?.note ?? '', placeholder: '선택 사항' });
    // 토큰 발급 안내 — 처음 설정하는 사람 기준. 이미 토큰이 있으면 접어 둔다.
    let guideEl = null;
    if (preset.guide?.steps?.length) {
        const hasToken = Object.values(c?.secretsSet ?? {}).some(Boolean);
        guideEl = el('details', { class: 'ctx-guide', ...(hasToken ? {} : { open: '' }) }, el('summary', { text: `${preset.label} 연결 방법` }));
        if (preset.guide.intro)
            guideEl.append(el('p', { class: 'admin-hint', text: preset.guide.intro }));
        const ol = el('ol', { class: 'ctx-guide-steps' });
        for (const st of preset.guide.steps)
            ol.append(el('li', { text: st }));
        guideEl.append(ol);
        if (preset.guide.url) {
            guideEl.append(el('p', {}, el('a', { class: 'ctx-guide-link', href: preset.guide.url, target: '_blank', rel: 'noopener noreferrer', text: '발급 페이지 열기 ↗' })));
        }
    }
    const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '수집기 만들기' : '저장' });
    saveBtn.addEventListener('click', async () => {
        const config = {}, secrets = {};
        for (const [k, v] of Object.entries(inputs)) {
            if (v.secret) {
                if (v.el.value)
                    secrets[k] = v.el.value;
            }
            else
                config[k] = v.el.value.trim();
        }
        // 필수값 검사는 저장 전에 — 서버 오류로 알게 하지 않는다(비개발자 화면 요구).
        const missing = (preset.fields || []).filter((f) => f.required && !(f.secret ? (secrets[f.key] || c?.secretsSet?.[f.key]) : config[f.key]));
        if (missing.length) {
            toast(`${missing.map((f) => f.label || f.key).join(', ')} 을(를) 입력하세요`, true);
            return;
        }
        saveBtn.disabled = true;
        try {
            await api('/api/ui/org/collectors', { method: 'POST', body: JSON.stringify({
                    ...(c ? { id: c.id } : { preset_key: preset.key }),
                    key: keyIn.value.trim() || undefined,
                    label: labelIn.value.trim() || null,
                    enabled: enabledChk.checked,
                    config, secrets,
                    sync_interval_sec: Number(intervalSel.value),
                    output_mode: outSel.value,
                    output_config: catIn.value.trim() ? { target_category: catIn.value.trim() } : {},
                    note: noteIn.value.trim() || null,
                }) });
            toast(isNew ? '수집기를 만들었습니다' : '저장했습니다');
            editingId = null;
            creatingPreset = null;
            reload();
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
            saveBtn.disabled = false;
        }
    });
    const cancelBtn = el('button', { class: 'btn-text', text: '닫기' });
    cancelBtn.addEventListener('click', () => { editingId = null; creatingPreset = null; reload(); });
    const actions = el('div', { class: 'ctx-actions' }, saveBtn, cancelBtn);
    if (c) {
        const runs = el('button', { class: 'btn btn-ghost btn-sm', text: '실행 기록' });
        runs.addEventListener('click', () => openRuns(c));
        const preview = el('button', { class: 'btn btn-ghost btn-sm', text: '지금 뭐가 잡히는지 보기' });
        preview.addEventListener('click', () => openPreview(c));
        actions.append(runs, preview);
    }
    card.append(el('div', { class: 'ctx-row-head' }, el('span', { class: 'ctx-row-title', text: isNew ? `새 수집기 — ${preset.label}` : `설정 — ${c.label || c.key}` })), guideEl, F('이름', '목록에 보일 이름입니다.', labelIn), F('식별자', isNew ? '영문·숫자 슬러그. 비우면 자동으로 만듭니다.' : '만든 뒤에는 바꾸지 않습니다.', keyIn), ...fieldEls, F('수집 주기', '자주 가져올수록 최신이지만 외부 서비스 호출도 늘어납니다.', intervalSel), F('수집 결과', '가져온 내용을 자료로 쌓을지, 바로 지식으로 만들지 정합니다.', outSel), catField, F('메모', null, noteIn), el('label', { class: 'admin-check' }, enabledChk, ' 이 수집기 사용 — 켜면 위 주기로 자동 수집합니다'), actions);
    return card;
}
// ── 보조 오버레이 ──────────────────────────────────────────────────────────
async function openScopePicker(c, f, inp) {
    const box = el('div', {}, el('p', { class: 'admin-hint', text: '목록을 불러오는 중…' }));
    const back = overlay(`${f.label || f.key} — 목록에서 선택`, box);
    try {
        const r = await api(`/api/ui/org/collectors/${c.id}/discover`, { method: 'POST', body: '{}' });
        const opts = (r.fields && r.fields[f.key]) || [];
        if (!opts.length) {
            box.replaceChildren(el('p', { class: 'admin-hint', text: r.note || '고를 항목이 없습니다 — 직접 입력하세요.' }));
            return;
        }
        const normId = (v) => { const h = String(v).toLowerCase().replace(/[^0-9a-f]/g, ''); return h.length >= 32 ? h.slice(-32) : String(v).trim(); };
        const selected = new Set(String(inp.value || '').split(',').map(normId).filter(Boolean));
        const checks = new Map();
        const rows = opts.map((o) => {
            const cb = el('input', { type: 'checkbox' });
            cb.checked = selected.has(normId(o.id));
            checks.set(o.id, cb);
            return el('label', { class: 'ctx-pick-item' }, cb, el('span', { text: o.label }));
        });
        const apply = el('button', { class: 'btn btn-primary btn-sm', text: '적용' });
        apply.addEventListener('click', () => {
            inp.value = [...checks.entries()].filter(([, cb]) => cb.checked).map(([id]) => id).join(',');
            back.remove();
            toast('선택했습니다 — [저장]을 눌러야 반영됩니다');
        });
        box.replaceChildren(el('div', { class: 'ctx-pick-list' }, ...rows), el('div', { class: 'ctx-actions' }, apply));
    }
    catch (e) {
        box.replaceChildren(el('p', { class: 'admin-hint', text: '조회 실패: ' + e.message }));
    }
}
async function openPreview(c) {
    const box = el('div', {}, el('p', { class: 'admin-hint', text: '실제로 한 번 호출해 보는 중…' }));
    overlay(`미리보기 — ${c.label || c.key}`, box);
    try {
        const r = await api(`/api/ui/org/collectors/${c.id}/preview`, { method: 'POST', body: '{}' });
        if (!r.ok) {
            box.replaceChildren(el('p', { class: 'admin-hint', text: '가져오지 못했습니다 — ' + (r.error || '알 수 없는 오류') }));
            return;
        }
        const sample = r.sample || [];
        if (!sample.length) {
            // ⚠ 0건의 원인을 **단정하지 않는다.** 예전엔 "설정(범위·필드 매핑)을 확인하세요"라고 못박았는데,
            //  실제로 가장 흔한 원인은 자격 실패였다(#1631 실측: 노션 401 인데 이 문구가 범위를 보라고 보냈다).
            //  이제 자격·범위 실패는 서버가 오류로 올려 주므로(failure-class.ts) 여기까지 온 0건은
            //  "정말 없거나 · 매핑 문제"다. 그래도 순서를 흔한 것부터 두고 단정은 피한다.
            box.replaceChildren(el('p', { class: 'admin-hint', text: '지금 잡히는 것이 0건입니다. 그 범위에 실제로 자료가 없거나, 고유 id 매핑이 비어 항목이 버려졌을 수 있습니다(매핑이 비면 전부 버려집니다).' }));
            return;
        }
        const list = el('div', { class: 'ctx-preview-list' });
        for (const s of sample) {
            list.append(el('div', { class: 'ctx-preview-row' }, el('div', { class: 'ctx-preview-t', text: s.title || '(제목 없음)' }), el('div', { class: 'ctx-preview-m', text: [s.author, s.container_name, s.occurred_at?.slice(0, 10)].filter(Boolean).join(' · ') }), s.body_preview ? el('div', { class: 'ctx-preview-b', text: s.body_preview }) : null));
        }
        box.replaceChildren(el('p', { class: 'admin-hint', text: `이 설정으로 지금 이런 것들이 들어옵니다(샘플 ${sample.length}건 — 저장하지 않았습니다).` }), list);
    }
    catch (e) {
        box.replaceChildren(el('p', { class: 'admin-hint', text: '실패: ' + e.message }));
    }
}
async function openRuns(c) {
    const box = el('div', {}, el('p', { class: 'admin-hint', text: '불러오는 중…' }));
    overlay(`실행 기록 — ${c.label || c.key}`, box);
    try {
        const r = await api('/api/ui/org/connector/runs?' + new URLSearchParams({ collector_id: String(c.id), limit: '20' }));
        const runs = r.runs || [];
        if (!runs.length) {
            box.replaceChildren(el('p', { class: 'admin-hint', text: '실행 이력이 없습니다.' }));
            return;
        }
        box.replaceChildren(...runs.map((run) => {
            const row = el('div', { class: 'ctx-run-row' }, el('span', { class: 'ctxp-dot ' + (run.status === 'ok' ? 'ctxp-dot-ok' : run.status === 'running' ? 'ctxp-dot-note' : 'ctxp-dot-warn'), 'aria-hidden': 'true' }), el('span', { class: 'ctx-run-t', text: run.status === 'ok' ? '성공' : run.status === 'running' ? '진행 중' : run.status === 'canceled' ? '중지됨' : '실패' }), el('span', { class: 'ctx-run-m', text: `${run.mode === 'full' ? '전체' : '증분'} · ${relTime(run.started_at)}` }));
            row.addEventListener('click', () => openRunLog(c, run.id));
            return row;
        }));
    }
    catch (e) {
        box.replaceChildren(el('p', { class: 'admin-hint', text: '실패: ' + e.message }));
    }
}
/** 실행 로그 — 진행 중이면 2초 폴링(구 커넥터 화면의 검증된 동작을 그대로). */
async function openRunLog(c, runId) {
    const status = el('div', { class: 'admin-hint', text: '불러오는 중…' });
    const pre = el('pre', { class: 'run-log' });
    const back = overlay(`수집 로그 — ${c.label || c.key}`, status, pre);
    let offset = 0, timer = null;
    const stop = () => { if (timer) {
        clearInterval(timer);
        timer = null;
    } };
    const tick = async () => {
        if (!document.body.contains(back)) {
            stop();
            return;
        }
        try {
            const r = await api(`/api/ui/org/connector/runs/${runId}?offset=${offset}`);
            if (r.log_chunk)
                pre.append(document.createTextNode(r.log_chunk));
            if (r.next_offset != null)
                offset = r.next_offset;
            pre.scrollTop = pre.scrollHeight;
            status.textContent = (r.status === 'ok' ? '성공' : r.status === 'running' ? '진행 중 — 자동 갱신' : r.status === 'canceled' ? '중지됨' : '실패')
                + ` · ${r.mode === 'full' ? '전체' : '증분'}`;
            if (r.status !== 'running')
                stop();
        }
        catch (e) {
            status.textContent = '로그를 불러오지 못했습니다: ' + e.message;
            stop();
        }
    };
    await tick();
    if (!timer)
        timer = setInterval(tick, 2000);
}
