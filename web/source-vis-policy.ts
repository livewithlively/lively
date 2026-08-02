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
import { compactPicker, memberPicker } from './projects.js';
import { sectionHead } from './admin-widgets.js';

export async function sourceVisPolicyPanel(detail): Promise<void> {
  const reload = () => sourceVisPolicyPanel(detail);
  const head = () => sectionHead('자료 공개범위',
    '슬랙·지메일 같은 커넥터로 수집되는 자료를 누가 볼 수 있는지 정합니다. 채널별로 예외를 둘 수 있어요.');
  detail.replaceChildren(el('div', {}, head(), el('div', { class: 'card' }, skeleton('정책을 불러오는 중'))));

  let data: any;
  try { data = await api('/api/ui/source-vis-policy'); }
  catch (e) { detail.replaceChildren(el('div', {}, head(), el('div', { class: 'card' }, errorNote(e, '정책을 불러오지 못했습니다')))); return; }

  const rules = data.rules || [];
  const axisOn = data.axis_on !== false;

  // 축이 꺼져 있으면 여기서 정한 규칙이 강제되지 않는다 — 설정만 남고 안 걸리는 상태를 만들지 않게 먼저 말한다.
  const axisWarn = axisOn ? null : el('div', { class: 'svp-warn' },
    el('b', { text: '자료 공개범위가 꺼져 있어요' }),
    el('span', { text: '여기서 규칙을 만들어도 지금은 강제되지 않습니다. [맥락 공개범위]에서 자료 축을 먼저 켜세요.' }));

  const addBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '+ 규칙 추가' });
  addBtn.onclick = () => openRuleForm(null, reload);

  const backfillBtn = el('button', { class: 'btn', type: 'button', text: '기존 자료에 소급 적용' });
  backfillBtn.onclick = () => openBackfill(reload);

  detail.replaceChildren(el('div', {},
    head(),
    el('div', { class: 'card' },
      axisWarn,
      el('p', { class: 'muted', text:
        '규칙은 앞으로 수집되는 자료에 적용됩니다. 채널을 지정한 규칙이 커넥터 전체 규칙보다 우선해요. ' +
        '이미 쌓인 자료에도 적용하려면 [기존 자료에 소급 적용]을 누르세요.' }),
      rules.length ? el('div', { class: 'svp-list' }, ...rules.map((r) => ruleRow(r, reload)))
                   : el('p', { class: 'admin-hint', text: '아직 규칙이 없어요 — 모든 수집 자료가 전원에게 공개됩니다.' }),
      el('div', { class: 'svp-actions' }, addBtn, backfillBtn)),
  ));
}

function ruleRow(r, reload) {
  const scope = r.match_channel
    ? el('span', { class: 'svp-scope' }, el('b', { text: r.match_system }), el('span', { text: ' ▸ ' + r.match_channel }))
    : el('span', { class: 'svp-scope' }, el('b', { text: r.match_system }), el('span', { class: 'muted', text: ' 전체' }));

  const who = r.visibility === 'members'
    ? el('span', { class: 'svp-who' }, '🔒 ' + (r.members || []).length + '명/팀만')
    : el('span', { class: 'svp-who svp-open', text: '전원 공개' });

  const edit = el('button', { class: 'btn-text', type: 'button', text: '수정' });
  edit.onclick = () => openRuleForm(r, reload);
  const del = el('button', { class: 'btn-text', type: 'button', text: '삭제' });
  del.onclick = async () => {
    if (!confirm(`이 규칙을 지울까요?\n\n이미 잠긴 자료의 공개범위는 그대로 남고, 앞으로 수집되는 것만 달라집니다.`)) return;
    try { await api('/api/ui/source-vis-policy/delete', { method: 'POST', body: JSON.stringify({ id: r.id }) }); reload(); }
    catch (e: any) { toast('지우지 못했습니다 — ' + e.message, true); }
  };

  return el('div', { class: 'svp-row' + (r.visibility === 'members' ? ' locked' : '') },
    el('div', { class: 'svp-main' }, scope, who),
    el('div', { class: 'svp-row-actions' }, edit, del));
}

function openRuleForm(r, reload) {
  const editing = !!r;
  const sysIn = el('input', { class: 'inp', type: 'text', placeholder: 'slack · gmail · discord …', value: r?.match_system || '' });
  const chIn = el('input', { class: 'inp', type: 'text', placeholder: '비우면 이 커넥터 전체', value: r?.match_channel || '' });

  let vis = r?.visibility === 'members' ? 'members' : 'open';
  const sw = el('span', { class: 'pjv-switch' + (vis === 'members' ? ' on' : '') }, el('span', { class: 'pjv-switch-knob' }));
  const visRow = el('div', { class: 'pjv-visrow' + (vis === 'members' ? ' on' : ''), role: 'switch', tabindex: '0',
    'aria-checked': vis === 'members' ? 'true' : 'false' },
    el('span', { class: 'pjv-visrow-txt' },
      el('span', { class: 'pjv-visrow-title', text: '공개범위를 지정한 사람으로 제한' }),
      el('span', { class: 'pjv-visrow-hint', text: '켜면 이 규칙에 걸리는 자료와 거기서 증류된 지식이 대상 외에는 보이지 않아요.' })),
    sw);

  // 대상 컨트롤은 리스트·스페이스·공유폴더와 **같은 것**을 쓴다 — 같은 개념이 화면마다 다르게 생기면 규칙을 두 번 배운다.
  const preselect = (r?.members || []).filter((m) => m.subject_kind !== 'team').map((m) => m.member_id);
  const picker = compactPicker('공개 대상',
    (onChange) => memberPicker(preselect, { includeMe: !editing, onChange }),
    { emptyText: '대상 없음 — 저장할 수 없어요', avatars: true, maxChips: 6 });
  const audField = el('div', { class: 'field', style: 'margin-top:12px' + (vis === 'members' ? '' : ';display:none') },
    el('label', { class: 'field-label', text: '공개 대상' }), picker.trigger,
    // 오해 방지 — 이 한 줄이 이 화면에서 가장 중요하다.
    el('div', { class: 'admin-hint', style: 'margin-top:6px',
      text: '※ 채널은 “어느 자료에 이 규칙을 걸지” 고르는 조건일 뿐이에요. 슬랙 채널 멤버가 자동으로 대상이 되지는 않습니다 — 여기서 직접 고르세요.' }));

  const toggle = () => {
    vis = vis === 'members' ? 'open' : 'members';
    const on = vis === 'members';
    visRow.classList.toggle('on', on); sw.classList.toggle('on', on);
    visRow.setAttribute('aria-checked', on ? 'true' : 'false');
    audField.style.display = on ? '' : 'none';
  };
  visRow.onclick = (e) => { e.stopPropagation(); toggle(); };
  visRow.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });

  const save = el('button', { class: 'btn btn-primary', type: 'button', text: '저장' });
  const cancel = el('button', { class: 'btn', type: 'button', text: '취소' });
  const back = overlayBox(editing ? '규칙 수정' : '새 규칙',
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '커넥터' }), sysIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '채널 (선택)' }), chIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, visRow),
    audField,
    el('div', { class: 'ov-actions' }, save, cancel));
  cancel.onclick = () => back.remove();

  save.onclick = async () => {
    const body: any = {
      id: r?.id, match_system: sysIn.value.trim(),
      match_channel: chIn.value.trim() || undefined,
      visibility: vis,
      members: vis === 'members' ? picker.getSelected().map((id) => ({ member_id: id })) : [],
    };
    if (!body.match_system) { toast('커넥터를 입력하세요', true); return; }
    save.disabled = true;
    try { await api('/api/ui/source-vis-policy', { method: 'POST', body: JSON.stringify(body) }); back.remove(); reload(); }
    catch (e: any) { save.disabled = false; toast(e.message, true); }
  };
}

/** 소급 적용 — 되돌리기 어려운 대량 변경이라 **미리보기를 먼저 보여주고** 확인을 받는다(서버도 기본이 dry_run). */
function openBackfill(reload) {
  const out = el('div', { class: 'svp-dry' }, el('span', { class: 'admin-hint', text: '무엇이 바뀌는지 확인하는 중…' }));
  const go = el('button', { class: 'btn btn-danger', type: 'button', text: '적용', disabled: true } as any);
  const cancel = el('button', { class: 'btn', type: 'button', text: '닫기' });
  const back = overlayBox('기존 자료에 소급 적용',
    el('p', { class: 'muted', text: '지금 규칙을 이미 수집된 자료에 적용합니다. 먼저 무엇이 바뀌는지 확인하세요.' }),
    out, el('div', { class: 'ov-actions' }, go, cancel));
  cancel.onclick = () => back.remove();

  (async () => {
    try {
      const d = await api('/api/ui/source-vis-policy/backfill', { method: 'POST', body: JSON.stringify({}) });
      out.replaceChildren(
        el('div', { class: 'svp-warn' },
          el('b', { text: `${d.locked}건이 새로 잠깁니다` }),
          el('span', { text: `검사 ${d.scanned}건 · 이미 잠김 ${d.already_locked}건 · 규칙 없음 ${d.no_rule}건` })),
        (d.samples || []).length
          ? el('ul', { class: 'vax-samples' }, ...(d.samples || []).map((s) => el('li', { text: String(s) })))
          : null);
      (go as any).disabled = !d.locked;
    } catch (e: any) { out.replaceChildren(errorNote(e, '미리보기에 실패했습니다')); }
  })();

  go.onclick = async () => {
    (go as any).disabled = true;
    try {
      const d = await api('/api/ui/source-vis-policy/backfill', { method: 'POST', body: JSON.stringify({ dry_run: false }) });
      toast(`${d.locked}건에 적용했습니다`); back.remove(); reload();
    } catch (e: any) { (go as any).disabled = false; toast('적용하지 못했습니다 — ' + e.message, true); }
  };
}
