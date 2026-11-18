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
import { ACCESS_MODE_OPTIONS } from './lib/proj-access.js';   // #5598 새 프로젝트 공개 방식

//  bare(#5159) — [AI 주입기 설정 ▸ 공개범위] 페이지는 자기 상자·제목을 그린다. 그때는 행 목록만 그린다.
export async function visibilityAxesPanel(detail, opts: { bare?: boolean; onChange?: () => void } = {}): Promise<void> {
  const reload = () => { opts.onChange?.(); return visibilityAxesPanel(detail, opts); };
  busy(detail, el('div', { class: opts.bare ? '' : 'card' }, skeleton('맥락 공개범위 설정을 불러오는 중')));

  let axes: any[];
  try { axes = (await api('/api/ui/vis/axes')).axes || []; }
  catch (e) { detail.replaceChildren(el('div', { class: opts.bare ? '' : 'card' }, errorNote(e, '설정을 불러오지 못했습니다'))); return; }

  const rows = axes.map((a) => axisRow(a, reload));
  //  #5598 새 프로젝트 공개 방식 — 축 목록 위에 선다(가장 먼저 정할 것: «우리 워크스페이스에서 새 프로젝트를 누가 보나»).
  //   못 받아도 축 설정은 그대로 그린다(구 서버 · 일시 오류).
  let access: any = null;
  try { access = await api('/api/ui/v6/project-access'); } catch (_) { access = null; }
  //  기존 프로젝트 중 아직 전체 공개인 것(초대제로 한꺼번에 바꾸기의 미리보기). 못 받으면 그 줄만 안 선다.
  let existing: any = null;
  if (access) { try { existing = await api('/api/ui/v6/project-access/existing'); } catch (_) { existing = null; } }
  const accessBox = access ? projectAccessBox(access, reload, existing) : null;
  if (opts.bare) { detail.replaceChildren(...[accessBox, el('div', { class: 'vax-list vax-list-bare' }, ...rows)].filter(Boolean) as HTMLElement[]); return; }

  detail.replaceChildren(el('div', {},
    el('div', { class: 'section-title' }, el('h2', { text: '맥락 공개범위' })),
    accessBox ? el('div', { class: 'card' }, accessBox) : null,
    el('div', { class: 'card' },
      el('p', { class: 'muted', text:
        '맥락 유형별로 공개범위 기능을 쓸지 정합니다. 끄면 그 유형은 조직 전원에게 공개됩니다(종전 동작). ' +
        '개별 항목을 잠그는 것은 각 화면에서 하세요 — 여기서는 기능 자체를 켜고 끕니다.' }),
      el('div', { class: 'vax-list' }, ...rows)),
  ));
}

// ── #5598 새 프로젝트 공개 방식(초대제 | 전체 공개) ────────────────────────────────
//  축 끄기와 달리 이 설정은 공개 사건이 아니다 — 새로 만드는 프로젝트의 기본값만 바뀌고 이미 있는 프로젝트는 그대로다
//  (src/v6/project-access.ts). 그래서 확인 창 없이 바로 바꾸고, 그 사실을 선택지 아래에 늘 적어 둔다.
function projectAccessBox(access: { mode: string; enforced: boolean }, reload: () => void, existing?: ExistingOpen | null): HTMLElement {
  const cur = access.mode === 'open' ? 'open' : 'invite';
  const opt = (o: (typeof ACCESS_MODE_OPTIONS)[number]): HTMLElement => {
    const on = o.mode === cur;
    const b = el('button', { class: 'pax-opt' + (on ? ' on' : ''), type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false' },
      el('span', { class: 'pax-radio', 'aria-hidden': 'true' }),
      el('span', { class: 'pax-body' },
        el('b', { class: 'pax-t', text: o.title + (o.mode === 'invite' ? ' (기본)' : '') }),
        el('span', { class: 'pax-d', text: o.desc }))) as HTMLButtonElement;
    b.onclick = async () => {
      if (on) return;
      b.disabled = true;
      try {
        await api('/api/ui/v6/project-access', { method: 'POST', body: JSON.stringify({ mode: o.mode }) });
        toast(`새 프로젝트 공개 방식을 «${o.title}» 로 바꿨습니다 — 이미 있는 프로젝트는 그대로입니다.`);
        reload();
      } catch (e: any) { b.disabled = false; toast('설정을 바꾸지 못했습니다 — ' + e.message, true); }
    };
    return b;
  };
  return el('div', { class: 'pax' },
    el('div', { class: 'pax-head' }, el('b', { text: '새 프로젝트 공개 방식' }),
      el('span', { class: 'muted', text: '이 워크스페이스에서 새로 만드는 프로젝트를 누가 보는지 정합니다.' })),
    el('div', { class: 'pax-opts', role: 'radiogroup', 'aria-label': '새 프로젝트 공개 방식' }, ...ACCESS_MODE_OPTIONS.map(opt)),
    el('p', { class: 'pax-note muted', text:
      '이미 있는 프로젝트의 공개 범위는 바뀌지 않습니다 — 새로 만드는 프로젝트의 기본값만 바뀝니다. ' +
      '프로젝트 하나의 공개 범위는 그 프로젝트를 만든 사람이 프로젝트 화면의 [공유]에서 바꿉니다.' }),
    access.enforced ? null : el('p', { class: 'pax-note pax-warn', text:
      '지금은 아래 «프로젝트» 공개범위가 꺼져 있어 모든 프로젝트를 전원이 봅니다 — 이 설정이 적용되려면 그 항목을 켜세요.' }),
    access.enforced ? existingRow(existing, reload) : null);
}

// ── 기존 프로젝트도 초대제로(#5598 후속, 상민 2026-11-18 «단추로 가») ─────────────────────────
//  방식 설정은 새 프로젝트의 기본값이라 이미 있는 프로젝트는 계속 전체 공개다. 이 줄이 그것을 **이 워크스페이스에서 한 번에** 닫는 문이다.
//  좁히는 방향이지만 동료가 보던 프로젝트가 그 순간 사라지고 되돌리는 단추가 없다(만든 사람이 하나씩 다시 연다) — 그래서 몇 건이
//  누구 것인지 먼저 보여 주고 받는다. 서버도 confirm 없으면 400(src/capabilities/vis-axes.ts).
interface ExistingOpen { open: number; excluded: number; by_creator: Array<{ member_id: string; display_name?: string | null; count: number }> }

function existingRow(ex: ExistingOpen | null | undefined, reload: () => void): HTMLElement | null {
  if (!ex) return null;
  const excludedNote = ex.excluded > 0 ? ` 만든 사람이 없거나 지금 구성원이 아닌 ${ex.excluded}건은 닫지 않습니다(닫으면 볼 사람이 없습니다).` : '';
  if (ex.open <= 0) {
    return el('div', { class: 'pax-existing done' },
      el('b', { text: '기존 프로젝트' }),
      el('span', { class: 'muted', text: '초대제가 아닌 기존 프로젝트가 없습니다.' + excludedNote }));
  }
  const btn = el('button', { class: 'btn btn-sm', type: 'button', text: '기존 프로젝트도 초대제로 바꾸기…' }) as HTMLButtonElement;
  btn.onclick = () => confirmCloseExisting(ex, reload);
  return el('div', { class: 'pax-existing' },
    el('div', { class: 'pax-existing-t' },
      el('b', { text: '기존 프로젝트' }),
      //  «전체 공개인 N건» 이라고 하지 않는다 — 이 수에는 아직 풀리지 않은 초안(이미 만든 사람만 본다)과 잠긴 리스트 안의 프로젝트도 든다.
      el('span', { class: 'muted', text: `초대제가 아닌 프로젝트가 ${ex.open}건 있습니다 — 위 설정은 새 프로젝트에만 적용됩니다.` + excludedNote })),
    btn);
}

function confirmCloseExisting(ex: ExistingOpen, reload: () => void): void {
  const cancel = el('button', { class: 'btn', type: 'button', text: '취소' });
  const go = el('button', { class: 'btn btn-danger', type: 'button', text: '이해했고 초대제로 바꿉니다' }) as HTMLButtonElement;
  const top = ex.by_creator.slice(0, 8);
  const back = overlayBox('기존 프로젝트를 초대제로 바꾸기',
    el('div', { class: 'vax-warn' },
      el('b', { text: `프로젝트 ${ex.open}건이 만든 사람과 팀원에게만 보이게 됩니다` }),
      el('span', { text: '팀원이 아닌 구성원의 목록과 검색에서는 그 순간 사라집니다 — 관리자도 남의 프로젝트는 못 봅니다. 되돌리는 단추는 없습니다. 다시 열려면 프로젝트마다 만든 사람이 [공유]에서 «전체 공개» 로 바꿉니다.' })),
    el('ul', { class: 'vax-samples' },
      ...top.map((c) => el('li', { text: `${c.display_name || c.member_id} — ${c.count}건` })),
      ex.by_creator.length > top.length ? el('li', { class: 'muted', text: `외 ${ex.by_creator.length - top.length}명` }) : null),
    el('p', { class: 'pax-note muted', text:
      '그 프로젝트의 기존 팀원, 그 프로젝트에서 세션을 돌리거나 세션에 초대돼 있던 사람, 프로젝트 · 태스크 담당자는 팀원으로 남아 계속 봅니다.'
      + (ex.excluded > 0 ? ` 만든 사람이 없거나 지금 구성원이 아닌 ${ex.excluded}건은 그대로 둡니다.` : '') }),
    el('div', { class: 'ov-actions' }, cancel, go));
  cancel.onclick = () => back.remove();
  go.onclick = async () => {
    go.disabled = true;
    try {
      const r: any = await api('/api/ui/v6/project-access/existing', { method: 'POST', body: JSON.stringify({ confirm: true }) });
      back.remove();
      toast(`기존 프로젝트 ${Number(r && r.converted) || 0}건을 초대제로 바꿨습니다.`);
      reload();
    } catch (e: any) { go.disabled = false; toast('바꾸지 못했습니다 — ' + e.message, true); }
  };
}

function axisRow(a, reload) {
  const sw = el('span', { class: 'pjv-switch' + (a.on ? ' on' : '') }, el('span', { class: 'pjv-switch-knob' }));
  // 잠긴 항목 수는 **끄면 무엇이 공개되나**의 크기다 — 켜져 있을 때만 의미가 있어 그때만 보여준다.
  const meta = a.on && a.locked > 0
    ? el('span', { class: 'vax-locked', text: `🔒 ${a.locked}건 제한 중` })
    : (a.on ? el('span', { class: 'vax-none', text: '제한된 항목 없음' })
            : el('span', { class: 'vax-off', text: '전원 공개' }));

  const row = el('div', { class: 'vax-row' + (a.on ? '' : ' off') },
    el('div', { class: 'vax-main' },
      el('div', { class: 'vax-label', text: a.label }),
      meta),
    sw);

  sw.onclick = async () => {
    if (!a.on) {                      // 켜기 — 좁히는 방향이라 새로 공개되는 게 없다. 확인 없이 바로.
      try { await api('/api/ui/vis/axes', { method: 'POST', body: JSON.stringify({ axis: a.axis, on: true }) }); reload(); }
      catch (e: any) { toast('설정을 바꾸지 못했습니다 — ' + e.message, true); }
      return;
    }
    if (!a.locked) {                  // 끄지만 잠긴 게 없다 — 공개될 것이 없으므로 확인도 필요 없다.
      try { await api('/api/ui/vis/axes', { method: 'POST', body: JSON.stringify({ axis: a.axis, on: false }) }); reload(); }
      catch (e: any) { toast('설정을 바꾸지 못했습니다 — ' + e.message, true); }
      return;
    }
    confirmDisable(a, reload);        // 공개 사건 — 무엇이 열리는지 보여주고 받는다.
  };
  return row;
}

function confirmDisable(a, reload) {
  const reasonI = el('input', { class: 'inp', type: 'text', placeholder: '왜 끄는지 (작업기록에 남습니다)' });
  const cancel = el('button', { class: 'btn', type: 'button', text: '취소' });
  const go = el('button', { class: 'btn btn-danger', type: 'button', text: '이해했고 공개합니다' });

  const back = overlayBox('공개범위 끄기 · ' + a.label,
    el('div', { class: 'vax-warn' },
      el('b', { text: `지금 제한된 ${a.locked}건이 조직 전원에게 공개됩니다` }),
      el('span', { text: '이 유형의 공개범위 설정이 전부 무효가 됩니다. 다시 켜면 설정은 그대로 살아납니다.' })),
    a.samples && a.samples.length
      ? el('ul', { class: 'vax-samples' },
          ...a.samples.map((n) => el('li', { text: String(n) })),
          a.locked > a.samples.length ? el('li', { class: 'muted', text: `외 ${a.locked - a.samples.length}건` }) : null)
      : null,
    el('div', { class: 'ov-field' }, reasonI),
    el('div', { class: 'ov-actions' }, cancel, go));

  cancel.onclick = () => back.remove();
  go.onclick = async () => {
    go.disabled = true;
    try {
      await api('/api/ui/vis/axes', { method: 'POST', body: JSON.stringify(
        { axis: a.axis, on: false, confirm: true, reason: reasonI.value.trim() || undefined }) });
      back.remove(); reload();
    } catch (e: any) { go.disabled = false; toast('끄지 못했습니다 — ' + e.message, true); }
  };
}
