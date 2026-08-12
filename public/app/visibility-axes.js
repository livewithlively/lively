// #1291 관리탭 ▸ AI 맥락 ▸ 맥락 공개범위 — 유형별로 이 기능을 쓸지 말지 정한다.
//
//  개별 항목을 잠그는 건 각 화면(리스트 설정·폴더 공개범위…)에서 하고, 여기선 **축 자체**를 켜고 끈다.
//  축이 5개로 늘면서 전부가 필요하지 않은 조직엔 정보 흐름만 복잡해지기 때문이다.
//
//  ⚠ 이 화면의 핵심은 토글이 아니라 **끄기 확인**이다. 잠긴 항목이 있는 축을 끄면 지금까지 일부만 보던 내용이
//   그 순간 전원에게 열린다. 그래서 무엇이 몇 건 공개되는지 이름까지 보여주고 나서 받는다. 서버도 같은 규칙을
//   강제한다(confirm 없으면 400) — 화면은 실수를 줄이고, 경계는 서버가 지킨다.
import { api, busy, el, errorNote, toast } from './core.js';
import { overlayBox, skeleton } from './learn.js';
export async function visibilityAxesPanel(detail) {
    const reload = () => visibilityAxesPanel(detail);
    busy(detail, el('div', { class: 'card' }, skeleton('맥락 공개범위 설정을 불러오는 중')));
    let axes;
    try {
        axes = (await api('/api/ui/vis/axes')).axes || [];
    }
    catch (e) {
        detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '설정을 불러오지 못했습니다')));
        return;
    }
    const rows = axes.map((a) => axisRow(a, reload));
    detail.replaceChildren(el('div', {}, el('div', { class: 'section-title' }, el('h2', { text: '맥락 공개범위' })), el('div', { class: 'card' }, el('p', { class: 'muted', text: '맥락 유형별로 공개범위 기능을 쓸지 정합니다. 끄면 그 유형은 조직 전원에게 공개됩니다(종전 동작). ' +
            '개별 항목을 잠그는 것은 각 화면에서 하세요 — 여기서는 기능 자체를 켜고 끕니다.' }), el('div', { class: 'vax-list' }, ...rows))));
}
function axisRow(a, reload) {
    const sw = el('span', { class: 'pjv-switch' + (a.on ? ' on' : '') }, el('span', { class: 'pjv-switch-knob' }));
    // 잠긴 항목 수는 **끄면 무엇이 공개되나**의 크기다 — 켜져 있을 때만 의미가 있어 그때만 보여준다.
    const meta = a.on && a.locked > 0
        ? el('span', { class: 'vax-locked', text: `🔒 ${a.locked}건 제한 중` })
        : (a.on ? el('span', { class: 'vax-none', text: '제한된 항목 없음' })
            : el('span', { class: 'vax-off', text: '전원 공개' }));
    const row = el('div', { class: 'vax-row' + (a.on ? '' : ' off') }, el('div', { class: 'vax-main' }, el('div', { class: 'vax-label', text: a.label }), meta), sw);
    sw.onclick = async () => {
        if (!a.on) { // 켜기 — 좁히는 방향이라 새로 공개되는 게 없다. 확인 없이 바로.
            try {
                await api('/api/ui/vis/axes', { method: 'POST', body: JSON.stringify({ axis: a.axis, on: true }) });
                reload();
            }
            catch (e) {
                toast('설정을 바꾸지 못했습니다 — ' + e.message, true);
            }
            return;
        }
        if (!a.locked) { // 끄지만 잠긴 게 없다 — 공개될 것이 없으므로 확인도 필요 없다.
            try {
                await api('/api/ui/vis/axes', { method: 'POST', body: JSON.stringify({ axis: a.axis, on: false }) });
                reload();
            }
            catch (e) {
                toast('설정을 바꾸지 못했습니다 — ' + e.message, true);
            }
            return;
        }
        confirmDisable(a, reload); // 공개 사건 — 무엇이 열리는지 보여주고 받는다.
    };
    return row;
}
function confirmDisable(a, reload) {
    const reasonI = el('input', { class: 'inp', type: 'text', placeholder: '왜 끄는지 (작업기록에 남습니다)' });
    const cancel = el('button', { class: 'btn', type: 'button', text: '취소' });
    const go = el('button', { class: 'btn btn-danger', type: 'button', text: '이해했고 공개합니다' });
    const back = overlayBox('공개범위 끄기 · ' + a.label, el('div', { class: 'vax-warn' }, el('b', { text: `지금 제한된 ${a.locked}건이 조직 전원에게 공개됩니다` }), el('span', { text: '이 유형의 공개범위 설정이 전부 무효가 됩니다. 다시 켜면 설정은 그대로 살아납니다.' })), a.samples && a.samples.length
        ? el('ul', { class: 'vax-samples' }, ...a.samples.map((n) => el('li', { text: String(n) })), a.locked > a.samples.length ? el('li', { class: 'muted', text: `외 ${a.locked - a.samples.length}건` }) : null)
        : null, el('div', { class: 'ov-field' }, reasonI), el('div', { class: 'ov-actions' }, cancel, go));
    cancel.onclick = () => back.remove();
    go.onclick = async () => {
        go.disabled = true;
        try {
            await api('/api/ui/vis/axes', { method: 'POST', body: JSON.stringify({ axis: a.axis, on: false, confirm: true, reason: reasonI.value.trim() || undefined }) });
            back.remove();
            reload();
        }
        catch (e) {
            go.disabled = false;
            toast('끄지 못했습니다 — ' + e.message, true);
        }
    };
}
