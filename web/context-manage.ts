// context-manage.ts — 관리기 + 발견 큐(#1419 T5). [맥락 관리 ▸ 관리] 화면.
//
//  두 서브탭: '발견'(일감)이 먼저고 '관리기'(설정)가 뒤다 — 여기 오는 사람의 90%는 설정을 바꾸러 오는 게
//  아니라 **쌓인 것을 처리하러** 온다. 설정 화면을 먼저 보여 주면 매번 한 번 더 눌러야 한다.
import { api, cardHead, el, fmtNum, relTime, toast, uiText } from './core.js';
import { confirmDialog } from './admin.js';

let editingKey: string | null = null;
let creating = false;
let findingFilter: { kind: string; severity: string } = { kind: '', severity: '' };

const KIND_LABEL: Record<string, string> = {
  mismatch: '분류 어긋남 보정', outdated: '지식 아웃데이티드',
  contradiction: '지식 간 모순', code_drift: '지식 ↔ 코드 비교',
};
const KIND_WHAT: Record<string, string> = {
  mismatch: '지금 분류보다 다른 분류 정의에 더 가까운 지식을 찾습니다. 계산만으로 판정해 비용이 들지 않습니다.',
  outdated: '근거 자료가 지식보다 더 최신인 것을 찾습니다. 계산만으로 판정해 비용이 들지 않습니다.',
  contradiction: '서로 어긋나는 말을 하는 지식 쌍을 찾습니다. 닮은 쌍을 추린 뒤 AI 가 실제 상충인지 판정합니다.',
  code_drift: '도메인 정의와 실제 코드가 어긋난 곳을 찾습니다. AI 가 코드를 읽고 판정합니다.',
};
const SEV_LABEL: Record<string, string> = { high: '중요', warn: '주의', note: '참고' };

// ── 발견 큐 ────────────────────────────────────────────────────────────────
export async function renderFindings(host: HTMLElement): Promise<void> {
  host.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '불러오는 중…' })));
  let d: any;
  try {
    const qs = new URLSearchParams({ limit: '200' });
    if (findingFilter.kind) qs.set('kind', findingFilter.kind);
    if (findingFilter.severity) qs.set('severity', findingFilter.severity);
    d = await api('/api/ui/org/manager-findings?' + qs);
  } catch (e) {
    host.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '불러오지 못했습니다 — ' + (e as Error).message })));
    return;
  }
  const findings: any[] = d.findings || [];
  const reload = () => { void renderFindings(host); };

  const body = el('div', {});
  body.append(el('p', { class: 'admin-hint' },
    ...uiText('관리기가 찾아낸 것들입니다. 확인해서 고치거나, 문제가 아니면 반려하세요 — 반려한 것은 다음 검사에서 다시 올라오지 않습니다.')));

  // 필터 — 종류·심각도. 칩 형태(선택 상태가 보이게).
  const filters = el('div', { class: 'ctx-filters' });
  const chip = (label: string, active: boolean, on: () => void) => {
    const b = el('button', { class: 'ctx-chip' + (active ? ' ctx-chip-on' : ''), type: 'button', text: label,
      'aria-pressed': active ? 'true' : 'false' });
    b.addEventListener('click', on);
    return b;
  };
  filters.append(chip('전체', !findingFilter.kind, () => { findingFilter.kind = ''; reload(); }));
  for (const [k, l] of Object.entries(KIND_LABEL)) {
    filters.append(chip(l, findingFilter.kind === k, () => { findingFilter.kind = k; reload(); }));
  }
  filters.append(el('span', { class: 'ctx-filter-sep' }));
  filters.append(chip('심각도 전체', !findingFilter.severity, () => { findingFilter.severity = ''; reload(); }));
  for (const s of ['high', 'warn'] as const) {
    filters.append(chip(SEV_LABEL[s], findingFilter.severity === s, () => { findingFilter.severity = s; reload(); }));
  }
  body.append(filters);

  if (!findings.length) {
    body.append(el('div', { class: 'card ctx-empty' },
      el('p', { class: 'ctx-empty-t', text: '처리할 발견이 없습니다' }),
      el('p', { class: 'admin-hint', text: findingFilter.kind || findingFilter.severity ? '이 조건에 해당하는 것이 없습니다. 필터를 풀어 보세요.' : '관리기가 아직 아무것도 찾지 못했거나, 전부 처리했습니다.' })));
    host.replaceChildren(body);
    return;
  }

  // '조치안 제시'(propose) 관리기가 낸 **적용 가능한** 발견 — 한 번에 적용할 수 있다(#1419 T9).
  //  report 와의 실질 차이가 여기다: report 는 목록만, propose 는 이 묶음 바가 뜬다.
  const proposed = findings.filter((f: any) => f.actionable && f.action_level === 'propose');
  if (proposed.length) {
    const bar = el('div', { class: 'ctx-bulk' });
    const btn = el('button', { class: 'btn btn-primary btn-sm', text: `제안된 조치 ${proposed.length}건 한 번에 적용` });
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: `제안된 조치 ${proposed.length}건을 적용할까요?`,
        lines: ['분류 이동은 원래 분류가 이력에 남아 되돌릴 수 있습니다.',
          '적용되지 않는 항목은 그대로 목록에 남습니다.'],
        confirmText: '적용',
      });
      if (!ok) return;
      (btn as HTMLButtonElement).disabled = true;
      try {
        const r = await api('/api/ui/org/manager-findings/apply', {
          method: 'POST', body: JSON.stringify({ ids: proposed.map((f: any) => f.id) }) });
        toast(`적용 ${r.applied}건${r.failed ? ` · 실패 ${r.failed}건` : ''}${r.skipped ? ` · 건너뜀 ${r.skipped}건` : ''}`);
        reload();
      } catch (e) { toast((e as Error).message, true); (btn as HTMLButtonElement).disabled = false; }
    });
    bar.append(
      el('span', { class: 'ctx-bulk-t', text: '적용 대기' }),
      el('span', { class: 'ctx-bulk-d', text: '관리기가 조치안까지 만들어 뒀습니다. 확인하고 한 번에 적용하세요.' }),
      btn);
    body.append(bar);
  }

  const list = el('div', { class: 'ctx-findings' });
  for (const f of findings) list.append(findingRow(f, reload));
  body.append(list);
  host.replaceChildren(body);
}

function findingRow(f: any, reload: () => void) {
  const card = el('div', { class: 'card ctx-finding ctx-sev-' + f.severity });
  const head = el('div', { class: 'ctx-finding-head' },
    el('span', { class: 'ctx-sev', text: SEV_LABEL[f.severity] || f.severity }),
    el('span', { class: 'ctx-tag', text: KIND_LABEL[f.kind] || f.kind }),
    f.seen_count > 1 ? el('span', { class: 'ctx-tag', title: '이 문제가 반복해서 발견된 횟수', text: `${f.seen_count}회 발견` }) : null,
    // '적용 대기' — 조치안이 준비돼 있고 관리기가 propose 모드일 때만(#1419 T9). report 모드에선 안 뜬다.
    (f.actionable && f.action_level === 'propose')
      ? el('span', { class: 'ctx-tag ctx-tag-ready', title: '관리기가 조치안까지 만들어 뒀습니다', text: '적용 대기' }) : null,
    el('span', { class: 'ctx-finding-when', text: relTime(f.last_seen_at) }));
  card.append(head);
  card.append(el('p', { class: 'ctx-finding-sum', text: f.summary }));

  // 대상으로 가는 링크 — 판단하려면 원문을 봐야 한다.
  if (f.target_kind === 'knowledge') {
    card.append(el('a', { class: 'ctx-finding-target', href: '#/k/' + encodeURIComponent(f.target_ref),
      text: (f.target_title || f.target_ref) + ' →' }));
  } else if (f.target_kind === 'category') {
    card.append(el('a', { class: 'ctx-finding-target', href: '#/context/classify', text: `분류축 ${f.target_ref} →` }));
  }

  if (f.evidence) {
    const det = el('details', { class: 'ctx-evidence' }, el('summary', { text: '근거 보기' }),
      el('p', { class: 'ctx-evidence-b', text: f.evidence }));
    card.append(det);
  }

  const acts = el('div', { class: 'ctx-row-acts' });
  const pa = f.proposed_action as any;
  // 적용 가능한 조치가 있을 때만 '적용' 버튼 — 없는데 버튼만 있으면 눌러도 아무 일이 없다.
  //  ⚠ 판정은 **서버가 준 f.actionable** 을 쓴다(화이트리스트 단일 출처). 여기서 op 를 직접 보면
  //   서버 규칙이 바뀔 때 화면만 뒤처져 '눌러도 안 되는 버튼'이 남는다 — 그게 이 코드의 원래 모습이었다.
  if (f.actionable && pa?.op === 'move_category') {
    const apply = el('button', { class: 'btn btn-primary btn-sm', text: `‘${pa.to_category_key}’ 로 옮기기` });
    apply.addEventListener('click', async () => {
      (apply as HTMLButtonElement).disabled = true;
      try {
        const r = await api(`/api/ui/org/manager-findings/${f.id}/resolve`, {
          method: 'POST', body: JSON.stringify({ state: 'accepted', apply: true }) });
        toast(r.applied ? '분류를 옮겼습니다 — 원래 분류는 이력에 남습니다' : '처리했지만 적용은 되지 않았습니다');
        reload();
      } catch (e) { toast((e as Error).message, true); (apply as HTMLButtonElement).disabled = false; }
    });
    acts.append(apply);
  }
  const done = el('button', { class: 'btn btn-ghost btn-sm', text: '직접 고침' });
  done.addEventListener('click', async () => {
    try { await api(`/api/ui/org/manager-findings/${f.id}/resolve`, { method: 'POST', body: JSON.stringify({ state: 'resolved' }) }); toast('처리했습니다'); reload(); }
    catch (e) { toast((e as Error).message, true); }
  });
  const reject = el('button', { class: 'btn-text', text: '문제 아님' });
  reject.addEventListener('click', async () => {
    try { await api(`/api/ui/org/manager-findings/${f.id}/resolve`, { method: 'POST', body: JSON.stringify({ state: 'rejected' }) }); toast('반려했습니다 — 다시 올라오지 않습니다'); reload(); }
    catch (e) { toast((e as Error).message, true); }
  });
  acts.append(done, reject);
  card.append(acts);
  return card;
}

// ── 관리기 설정 ────────────────────────────────────────────────────────────
export async function renderManagers(host: HTMLElement): Promise<void> {
  host.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '관리기를 불러오는 중…' })));
  let d: any;
  try { d = await api('/api/ui/org/managers'); }
  catch (e) {
    host.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '불러오지 못했습니다 — ' + (e as Error).message })));
    return;
  }
  const list: any[] = d.managers || [];
  const ov = d.overview || { by_kind: [] };
  const reload = () => { void renderManagers(host); };

  const body = el('div', {});
  body.append(el('p', { class: 'admin-hint' },
    ...uiText('쌓인 지식이 낡거나 어긋나지 않게 자동으로 살핍니다. 찾아낸 것은 [발견]에 쌓이고, 사람이 확인해서 고치거나 반려합니다.')));

  // 종류별 현황 — 4종 중 무엇이 켜져 있는지 한눈에(안 켠 종류를 발견하는 자리).
  const kinds = el('div', { class: 'card ctx-cov' }, cardHead('종류별 현황'));
  const grid = el('div', { class: 'ctx-kind-grid' });
  for (const k of ov.by_kind || []) {
    grid.append(el('div', { class: 'ctx-kind' },
      el('div', { class: 'ctx-kind-h' },
        el('span', { class: 'ctxp-dot ' + (k.enabled ? 'ctxp-dot-ok' : 'ctxp-dot-off'), 'aria-hidden': 'true' }),
        el('span', { class: 'ctx-kind-t', text: k.label })),
      el('div', { class: 'ctx-kind-m', text: k.enabled ? `확인 필요 ${fmtNum(k.open)}건` : '꺼짐' })));
  }
  kinds.append(grid);
  body.append(kinds);

  if (!list.length && !creating) {
    body.append(el('div', { class: 'card ctx-empty' },
      el('p', { class: 'ctx-empty-t', text: '아직 관리기가 없습니다' }),
      el('p', { class: 'admin-hint', text: '분류 어긋남·낡은 지식은 계산만으로 찾아낼 수 있어 비용이 들지 않습니다 — 그 둘부터 켜 보세요.' })));
  }

  for (const m of list) body.append(editingKey === m.key ? managerEditor(m, reload) : managerSummary(m, reload));

  if (creating) body.append(managerEditor(null, reload));
  else {
    const add = el('button', { class: 'btn btn-primary', text: '+ 관리기 만들기' });
    add.addEventListener('click', () => { creating = true; editingKey = null; reload(); });
    body.append(el('div', { class: 'ctx-actions' }, add));
  }
  host.replaceChildren(body);
}

const ACTION_LABEL: Record<string, string> = {
  report: '찾기만 함', propose: '조치안까지 제시', auto: '자동으로 고침',
};

function managerSummary(m: any, reload: () => void) {
  const card = el('div', { class: 'card ctx-row' });
  card.append(el('div', { class: 'ctx-row-head' },
    el('span', { class: 'ctx-row-title', text: m.label || m.key }),
    el('span', { class: 'ctx-tag', text: KIND_LABEL[m.kind] || m.kind }),
    el('span', { class: 'ctx-state' },
      el('span', { class: 'ctxp-dot ' + (m.enabled ? 'ctxp-dot-ok' : 'ctxp-dot-off'), 'aria-hidden': 'true' }),
      el('span', { text: m.enabled ? '켜짐' : '꺼짐' })),
    el('span', { class: 'ctx-tag', text: ACTION_LABEL[m.action_level] || m.action_level }),
    m.open_findings ? el('span', { class: 'ctx-tag ctx-tag-warn', text: `확인 필요 ${fmtNum(m.open_findings)}` }) : null));
  card.append(el('div', { class: 'ctx-row-meta', text: KIND_WHAT[m.kind] || '' }));
  card.append(el('div', { class: 'ctx-row-meta',
    text: m.last_run_at ? `마지막 실행 ${relTime(m.last_run_at)} · ${m.last_status || ''}` : '아직 실행된 적 없음' }));

  const acts = el('div', { class: 'ctx-row-acts' });
  const toggle = el('button', { class: 'btn btn-ghost btn-sm', text: m.enabled ? '끄기' : '켜기' });
  toggle.addEventListener('click', async () => {
    try { await api('/api/ui/org/managers', { method: 'POST', body: JSON.stringify({ id: m.id, enabled: !m.enabled }) }); toast('저장했습니다'); reload(); }
    catch (e) { toast((e as Error).message, true); }
  });
  // 결정적 종류만 즉시 실행 — 판단이 필요한 종류는 배치라 여기서 못 끝낸다(버튼을 아예 안 만든다).
  const instant = m.kind === 'mismatch' || m.kind === 'outdated';
  const run = el('button', { class: 'btn btn-ghost btn-sm', text: '지금 검사' });
  run.addEventListener('click', async () => {
    (run as HTMLButtonElement).disabled = true;
    try {
      const r = await api('/api/ui/org/managers/run', { method: 'POST', body: JSON.stringify({ id: m.id }) });
      toast(r.skipped ? r.skipped : `검사 완료 — 새로 ${r.created ?? 0}건, 다시 ${r.repeated ?? 0}건`);
      reload();
    } catch (e) { toast((e as Error).message, true); (run as HTMLButtonElement).disabled = false; }
  });
  const edit = el('button', { class: 'btn btn-ghost btn-sm', text: '설정 열기' });
  edit.addEventListener('click', () => { editingKey = m.key; creating = false; reload(); });
  const del = el('button', { class: 'btn-text btn-text-danger', text: '삭제' });
  del.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: `‘${m.label || m.key}’ 관리기를 삭제할까요?`,
      lines: ['이 관리기가 찾아낸 발견도 함께 사라집니다.'], confirmText: '삭제', danger: true,
    });
    if (!ok) return;
    try { await api('/api/ui/org/managers/remove', { method: 'POST', body: JSON.stringify({ id: m.id }) }); toast('삭제했습니다'); reload(); }
    catch (e) { toast((e as Error).message, true); }
  });
  acts.append(toggle, ...(instant && m.enabled ? [run] : []), edit, del);
  card.append(acts);
  return card;
}

function managerEditor(m: any | null, reload: () => void) {
  const isNew = !m;
  const card = el('div', { class: 'card ctx-editor' });
  const S = 'width:100%;padding:7px 9px;font:inherit;box-sizing:border-box';
  const F = (label: string, hint: string | null, ctrl: any) => el('div', { class: 'ctx-field' },
    el('div', { class: 'field-label', text: label }),
    hint ? el('p', { class: 'admin-hint ctx-field-hint', text: hint }) : null, ctrl);

  const kindSel = el('select', { style: S, ...(isNew ? {} : { disabled: true }) }) as HTMLSelectElement;
  for (const [k, l] of Object.entries(KIND_LABEL)) kindSel.append(el('option', { value: k, text: l }));
  if (m) kindSel.value = m.kind;
  const kindWhat = el('p', { class: 'admin-hint ctx-field-hint', text: KIND_WHAT[kindSel.value] });
  kindSel.addEventListener('change', () => { kindWhat.textContent = KIND_WHAT[kindSel.value]; syncSensitivity(); });

  const keyIn = el('input', { type: 'text', style: S, value: m?.key ?? '', placeholder: 'drift-product', ...(isNew ? {} : { disabled: true }) }) as HTMLInputElement;
  const labelIn = el('input', { type: 'text', style: S, value: m?.label ?? '', placeholder: '제품 도메인 어긋남 검사' }) as HTMLInputElement;
  const enabledChk = el('input', { type: 'checkbox' }) as HTMLInputElement;
  enabledChk.checked = m ? !!m.enabled : true;

  const actionSel = el('select', { style: S }) as HTMLSelectElement;
  actionSel.append(el('option', { value: 'report', text: '찾기만 함 — 목록에 쌓고 사람이 판단 (권장)' }));
  actionSel.append(el('option', { value: 'propose', text: '조치안까지 제시 — 사람이 한 번에 적용' }));
  actionSel.append(el('option', { value: 'auto', text: '자동으로 고침 — 되돌릴 수 있는 조치만' }));
  actionSel.value = m?.action_level ?? 'report';

  const spacesIn = el('input', { type: 'text', style: S, value: (m?.match_spaces || []).join(', '), placeholder: '비우면 전체' }) as HTMLInputElement;
  const catsIn = el('input', { type: 'text', style: S, value: (m?.match_categories || []).join(', '), placeholder: '비우면 전체' }) as HTMLInputElement;

  // 민감도 — kind 마다 뜻이 다르므로 라벨·힌트를 바꿔 단다(같은 칸에 다른 의미가 들어가면 잘못 넣는다).
  const thIn = el('input', { type: 'number', style: S, step: '0.05', value: m?.threshold != null ? String(m.threshold) : '' }) as HTMLInputElement;
  const staleIn = el('input', { type: 'number', style: S, value: m?.stale_days != null ? String(m.stale_days) : '' }) as HTMLInputElement;
  const thField = F('민감도', '', thIn);
  const staleField = F('며칠 이상 뒤처지면', '근거 자료가 지식보다 이만큼 더 최신이면 낡았다고 봅니다. 비우면 30일.', staleIn);
  const syncSensitivity = () => {
    const k = kindSel.value;
    thField.hidden = k === 'outdated' || k === 'code_drift';
    staleField.hidden = k !== 'outdated';
    const lbl = thField.querySelector('.field-label') as HTMLElement | null;
    const hint = thField.querySelector('.ctx-field-hint') as HTMLElement | null;
    if (k === 'mismatch') {
      if (lbl) lbl.textContent = '어긋남 판정 기준';
      if (hint) hint.textContent = '다른 분류에 이만큼 더 가까우면 어긋났다고 봅니다. 낮출수록 많이 잡히고 오탐도 늘어납니다. 비우면 0.1.';
      thIn.placeholder = '0.1';
    } else if (k === 'contradiction') {
      if (lbl) lbl.textContent = '후보로 볼 유사도';
      if (hint) hint.textContent = '이만큼 닮은 지식 쌍만 AI 에게 보냅니다. 낮출수록 많이 검사하고 비용도 늡니다. 비우면 0.85.';
      thIn.placeholder = '0.85';
    }
  };

  const critIn = el('textarea', { style: S + ';min-height:90px;resize:vertical',
    placeholder: '예) 고객 대응 문서는 표현이 달라도 결론이 같으면 모순이 아니다.' }) as HTMLTextAreaElement;
  critIn.value = m?.criteria_md ?? '';
  const batchIn = el('input', { type: 'number', style: S, min: '1', max: '200', value: String(m?.batch_size ?? 20) }) as HTMLInputElement;
  const reqIn = el('input', { type: 'text', style: S, value: m?.requester ?? '', placeholder: '판단이 필요한 종류에만 쓰입니다' }) as HTMLInputElement;

  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '관리기 만들기' : '저장' }) as HTMLButtonElement;
  saveBtn.addEventListener('click', async () => {
    const key = keyIn.value.trim();
    if (!key) { toast('식별자를 입력하세요', true); return; }
    saveBtn.disabled = true;
    try {
      await api('/api/ui/org/managers', { method: 'POST', body: JSON.stringify({
        ...(m ? { id: m.id } : { kind: kindSel.value }), key,
        label: labelIn.value.trim() || null, enabled: enabledChk.checked,
        action_level: actionSel.value,
        match_spaces: spacesIn.value, match_categories: catsIn.value,
        threshold: thIn.value.trim() ? Number(thIn.value) : null,
        stale_days: staleIn.value.trim() ? Number(staleIn.value) : null,
        criteria_md: critIn.value.trim() || null,
        batch_size: Number(batchIn.value) || 20,
        requester: reqIn.value.trim() || null,
      }) });
      toast(isNew ? '관리기를 만들었습니다' : '저장했습니다');
      editingKey = null; creating = false; reload();
    } catch (e) { toast('실패 — ' + (e as Error).message, true); saveBtn.disabled = false; }
  });
  const cancelBtn = el('button', { class: 'btn-text', text: '닫기' });
  cancelBtn.addEventListener('click', () => { editingKey = null; creating = false; reload(); });

  card.append(
    el('div', { class: 'ctx-row-head' }, el('span', { class: 'ctx-row-title', text: isNew ? '새 관리기' : `설정 — ${m.label || m.key}` })),
    F('무엇을 검사할까', null, el('div', {}, kindSel, kindWhat)),
    isNew ? null : el('p', { class: 'admin-hint ctx-field-hint', text: '검사 종류는 만든 뒤 바꿀 수 없습니다 — 판정 기준이 통째로 달라 기존 발견이 섞입니다.' }),
    F('식별자', '영문·숫자 슬러그.', keyIn),
    F('이름', '목록에 보일 이름입니다.', labelIn),
    F('찾은 뒤 어떻게 할까', '자동으로 고치는 것은 되돌릴 수 있는 조치에만 적용됩니다. 처음에는 “찾기만 함”으로 두고 결과를 보세요.', actionSel),
    F('검사할 갈래', '이 space 만 검사합니다. 비우면 전체.', spacesIn),
    F('검사할 분류축', '이 분류축의 지식만 검사합니다. 비우면 전체.', catsIn),
    thField, staleField,
    F('판단 기준', '이 조직에서 무엇을 문제로 볼지 적으세요. 판단이 필요한 종류(모순·코드 비교)의 AI 지시문에 들어갑니다.', critIn),
    F('한 번에 검사할 수', '', batchIn),
    F('의뢰자', '모순·코드 비교는 AI 가 판정합니다 — 이 사람의 계정으로 실행·과금됩니다.', reqIn),
    el('label', { class: 'admin-check' }, enabledChk, ' 이 관리기 사용'),
    el('div', { class: 'ctx-actions' }, saveBtn, cancelBtn));
  syncSensitivity();
  return card;
}
