// distill-fill.ts — 증류기의 「카테고리 붙이기」(#4194). [맥락 관리 ▸ 증류기] 화면 아래 절.
//
//  증류기는 «지식을 완성시킨다»(완성 = 본문·유형·카테고리가 다 있는 상태). 두 종류가 한 탭에 선다:
//   · 자료 → 지식(web/distillers.ts 위 절) — 쌓인 자료를 읽어 남길 것만 지식으로 쓴다.
//   · 카테고리 붙이기(이 파일) — 카테고리가 없는 지식(미분류 지식)에 알맞은 카테고리를 붙인다. 본문은 안 건드린다.
//     미분류 지식은 저장 경로(새 지식은 카테고리 필수)를 우회하는 데서만 생긴다 — 노션 같은 «지식 직행» 수집 · 카테고리 삭제 ·
//     휴지통 복원 · 카테고리 제안 반려.
//  옛 이름은 「분류기」였고 [카테고리] 탭에 있었다(web/context-classify.ts — 이 파일이 대체). 저장소(org_classifier)·
//   자동 실행 잡(classify-knowledge-headless)은 그대로다 — 까닭은 src/org/distill/lanes.ts 머리말.
//  화면 말: 단위는 늘 «증류기»(자료 쪽과 같다 — «레인» 은 개발·에이전트 말이다), 대상은 «미분류 지식».
//
//  ⚠ 쓰기·미리보기는 **/api/ui/org/classifiers*** 로 한다(#4194 적대검증). 배포 중엔 새 화면이 옛 게이트웨이 프로세스와 잠시
//   공존한다 — /org/distillers 에 {input:'knowledge'} 를 보내면 옛 코어는 input 을 모른 채 **자료 증류기**를 끄거나 지운다.
//   이 경로는 옛·새 코어 모두에서 같은 뜻이다. 목록만 증류기 목록 응답(knowledge_lanes)을 쓰고, 그게 없으면(옛 코어)
//   같은 경로의 GET 으로 떨어진다.
import { api, busy, cardHead, el, fmtNum, personSelect, relTime, toast, uiText } from './core.js';
import { confirmDialog } from './ui-primitives.js';
import { stageJobCard } from './context-stage-job.js';   // 단계 공용 '언제 도나' 카드(#1618)
import { runConfig } from './context-run-config.js';    // #4008 제공자·모델·추론강도 공용 선택기

/** 이 증류기 종류의 이름 — 화면 문구가 전부 이 한 곳을 쓴다. */
export const FILL_LANE = '카테고리 붙이기';

/** 목록·커버리지 — 증류기 목록 응답(knowledge_lanes · coverage.knowledge)에서, 없으면(옛 코어·그 부분 실패) 호환 경로에서. */
async function loadLanes(res?: any): Promise<{ list: any[]; cov: KnowledgeCoverage }> {
  if (res && Array.isArray(res.knowledge_lanes) && res.coverage && res.coverage.knowledge) {
    return { list: res.knowledge_lanes, cov: res.coverage.knowledge };
  }
  const r = await api('/api/ui/org/classifiers');
  const c = (r && r.coverage) || {};
  return { list: (r && r.classifiers) || [], cov: { total_unclassified: Number(c.total_unclassified || 0), uncovered: Number(c.uncovered || 0), lanes: c.classifiers || [] } };
}

let editingKey: string | null = null;
let creating = false;

type KnowledgeCoverage = { total_unclassified: number; uncovered: number; lanes: Array<{ id: number; key: string; backlog: number; reviewed: number }> };

/**
 * 절 하나를 host 에 그린다. res 는 /api/ui/org/distillers 응답(증류기 화면이 이미 받아 둔 것) — 없거나 그 안에
 *  knowledge_lanes 가 없으면(옛 코어·그 부분 실패) 호환 경로(/api/ui/org/classifiers)에서 받는다(loadLanes).
 *  ⚠ 증류기 목록 응답의 distillers[] 는 **자료 → 지식만**이다(기존 소비자 무변경). 이 종류는 knowledge_lanes[] 로 따로 온다.
 */
export async function renderFillLanes(host: HTMLElement, res?: any): Promise<void> {
  if (!res) busy(host, el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: FILL_LANE + ' 증류기를 불러오는 중…' })));
  let list: any[]; let cov: KnowledgeCoverage;
  try { ({ list, cov } = await loadLanes(res)); }
  catch (e) {
    host.replaceChildren(el('div', { class: 'card' },
      el('p', { class: 'admin-hint', text: FILL_LANE + ' 증류기를 불러오지 못했습니다 — ' + (e as Error).message })));
    return;
  }
  const stat = (id: number) => cov.lanes.find((x) => x.id === id) || ({} as any);
  const reload = () => { void renderFillLanes(host); };

  const body = el('div', { class: 'dfl' });
  body.append(el('div', { class: 'cxc-head' },
    el('div', { class: 'cxc-head-main' },
      el('h3', { class: 'cxc-title' }, el('span', { text: FILL_LANE }), el('span', { class: 'cxc-title-n num', text: String(list.length) })),
      el('p', { class: 'cxc-lead' }, ...uiText(
        '노션처럼 지식으로 바로 들어온 문서나, 카테고리를 지워 칸을 잃은 지식은 카테고리가 없습니다(미분류 지식). 이 증류기가 내용을 읽고 알맞은 카테고리를 붙입니다 — 본문은 바꾸지 않습니다. ' +
        '출처·팀마다 기준을 다르게 하려면 여러 개 만드세요. 한 지식은 우선순위가 가장 높은 것 하나만 맡습니다. 이미 붙은 카테고리가 틀린 것은 여기가 아니라 [점검]이 찾아냅니다.')))));

  // 현황 — 사각지대를 목록보다 먼저(자료 레인 절과 같은 순서).
  const covCard = el('div', { class: 'card ctx-cov' }, cardHead('미분류 지식'));
  covCard.append(el('div', { class: 'ctx-cov-row' },
    el('span', { class: 'ctx-tag', text: '미분류 지식 ' + fmtNum(cov.total_unclassified) }),
    el('span', { class: 'ctx-tag', text: `켜진 증류기 ${list.filter(working).length}/${list.length}` }),
    //  «어느 증류기도 안 맡는 지식» 은 켜진 증류기가 있을 때만 뜻이 있다 — 없으면 기본 기준 하나가 전부 본다(서버도 0 을 준다).
    list.some(working) ? el('span', { class: 'ctx-tag' + (cov.uncovered ? ' ctx-tag-warn' : ''), text: '어느 증류기도 안 맡는 지식 ' + fmtNum(cov.uncovered) }) : null));
  if (cov.uncovered > 0 && list.some(working)) {
    covCard.append(el('p', { class: 'admin-hint ctx-warn-line' },
      ...uiText(`켜진 증류기 어디에도 안 걸리는 지식이 ${fmtNum(cov.uncovered)}건 있습니다. 이대로 두면 카테고리가 영영 안 붙어 검색에 안 잡힙니다 — 우선순위를 낮춘 넓은 증류기를 하나 만들어 나머지를 받게 하세요.`)));
  }
  body.append(covCard);

  if (!list.some(working) && !creating) {
    // ⚠ '없습니다'로 끝내면 **아무 일도 안 일어난다**로 읽힌다 — 실제로는 기본 기준 하나로 돌고 있다(어니스트 실박스 오독).
    //  켜 둔 것이 하나도 없을 때(전부 꺼짐·폐지 모드)도 같다 — 크론은 그때도 기본 기준으로 돈다(classify.ts 레거시 경로).
    body.append(el('div', { class: 'card ctx-empty' },
      el('p', { class: 'ctx-empty-t', text: (list.length ? '켜 둔 증류기 없음' : '증류기 없음') + ' — 기본 기준 하나로 카테고리를 붙이고 있습니다' }),
      el('p', { class: 'admin-hint', text: '미분류 지식 전부를 한 기준으로 봅니다. 출처·팀마다 기준을 나누고 대상·모델·주기를 따로 주려면 증류기를 만들거나 켜세요. 아예 멈추려면 아래 자동 실행을 끄세요.' })));
  }

  for (const c of list) body.append(editingKey === c.key ? editor(c, reload) : summary(c, stat(c.id), reload));

  if (creating) body.append(editor(null, reload));
  else {
    const add = el('button', { class: 'btn btn-primary', text: '+ ' + FILL_LANE + ' 증류기 만들기' });
    add.addEventListener('click', () => { creating = true; editingKey = null; reload(); });
    body.append(el('div', { class: 'ctx-actions' }, add));
  }
  host.replaceChildren(body);
  // '언제 도나' — 설정(레인)과 실행(잡)은 별개 축이라 둘 다 안 보이면 "설정했는데 왜 안 되지"의 답이 화면에 없다.
  //  host 를 이미 교체한 뒤 비동기로 붙인다 — 크론 조회(권한 없으면 403)가 이 절 전체를 막지 않게.
  //  ⚠ create 명세(id·action·주기)는 src/org/pipeline/default-jobs.ts 의 기본 잡과 **같아야 한다**(default-jobs.test C5 가 잰다).
  body.append(await stageJobCard({
    stage: FILL_LANE,
    title: FILL_LANE + ' 자동 실행',
    // 헤드리스판이 현행 권장 경로다(#1061 — 매 배치 새 세션이라 옛 should 로 판단하는 관성이 없다).
    //  구 세션주입판(classify_knowledge)이 켜져 있으면 그쪽을 그대로 보여 준다(멋대로 갈아타지 않는다).
    actions: ['classify_knowledge_headless', 'classify_knowledge'],
    create: {
      id: 'classify-knowledge-headless', label: '카테고리 붙이기 (미분류 지식→카테고리, 헤드리스)',
      action: 'classify_knowledge_headless', params: {}, interval_sec: 3600,
      note: '켜진 카테고리 붙이기 증류기별로 미분류 지식 배치를 헤드리스 AI 세션에 접수. 켜진 것이 없으면 전 지식 공통 기본 기준.',
    },
    missingLine: FILL_LANE + ' 자동 실행이 없습니다 — 증류기를 만들어도 미분류 지식에 카테고리가 붙지 않습니다.',
    // 신규 워크스페이스에 **꺼진 채 시드되는** 구 세션주입판(classify-unmapped-knowledge)이 이 자리에 앉는다.
    //  그건 params.session 이 필수라, 상시 세션을 먼저 등록하지 않고 켜면 매 틱 "타깃 상시 세션 미설정" error 를 낸다.
    unrunnable: (j) => (j.action === 'classify_knowledge' && !(j.params && j.params.session))
      ? '지금 등록된 ' + FILL_LANE + ' 자동 실행은 늘 켜 둔 AI 세션이 있어야 도는 옛 방식인데, 그 세션이 정해져 있지 않습니다 — 이대로 켜면 매번 실패합니다.'
      : null,
    usesAi: true,
  }, reload));
}

/** 폐지된 재분류 모드(target=low_confidence)인가 — 아무 지식도 맡지 않는다(서버 scopeWhere · lanes.ts isActiveLane). */
const retired = (c: any) => !!c && c.target === 'low_confidence';
/** 실제로 일하나 — 켜져 있고 폐지 모드가 아니다(서버 isActiveLane 과 같은 판정). */
const working = (c: any) => !!c && c.enabled === true && !retired(c);

function summary(c: any, st: any, reload: () => void) {
  const card = el('div', { class: 'card ctx-row' });
  card.append(el('div', { class: 'ctx-row-head' },
    el('span', { class: 'ctx-row-title', text: c.label || c.key }),
    el('span', { class: 'ctx-state' },
      el('span', { class: 'ctxp-dot ' + (c.enabled ? 'ctxp-dot-ok' : 'ctxp-dot-off'), 'aria-hidden': 'true' }),
      el('span', { text: c.enabled ? '켜짐' : '꺼짐' })),
    el('span', { class: 'ctx-tag', text: '우선순위 ' + c.priority }),
    el('span', { class: 'ctx-tag' + (retired(c) ? ' ctx-tag-warn' : ''), text: retired(c) ? '맡는 지식 없음' : '맡은 지식 ' + fmtNum(st.backlog ?? 0) })));
  card.append(el('div', { class: 'ctx-row-meta', text: c.scope_text || '미분류 지식 전체' }));
  card.append(el('div', { class: 'ctx-row-meta',
    text: c.last_run_at ? `마지막 실행 ${relTime(c.last_run_at)} · ${c.last_status || ''}` : '아직 실행된 적 없음' }));

  const acts = el('div', { class: 'ctx-row-acts' });
  const toggle = el('button', { class: 'btn btn-ghost btn-sm', text: c.enabled ? '끄기' : '켜기' });
  toggle.addEventListener('click', async () => {
    try { await api('/api/ui/org/classifiers', { method: 'POST', body: JSON.stringify({ id: c.id, enabled: !c.enabled }) }); toast('저장했습니다'); reload(); }
    catch (e) { toast((e as Error).message, true); }
  });
  const edit = el('button', { class: 'btn btn-ghost btn-sm', text: '설정 열기' });
  edit.addEventListener('click', () => { editingKey = c.key; creating = false; reload(); });
  const prev = el('button', { class: 'btn btn-ghost btn-sm', text: '맡은 지식 보기' });
  prev.addEventListener('click', () => openPreview(c));
  const del = el('button', { class: 'btn-text btn-text-danger', text: '삭제' });
  del.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: `증류기 ‘${c.label || c.key}’ 를 삭제할까요?`,
      lines: ['이미 붙은 카테고리와 제안은 그대로 남습니다. 이 증류기가 맡던 지식은 다른 증류기로 넘어가고, 켜진 것이 하나도 안 남으면 기본 기준 하나가 봅니다.'],
      confirmText: '삭제', danger: true,
    });
    if (!ok) return;
    try { await api('/api/ui/org/classifiers/remove', { method: 'POST', body: JSON.stringify({ id: c.id }) }); toast('삭제했습니다'); reload(); }
    catch (e) { toast((e as Error).message, true); }
  });
  acts.append(toggle, prev, edit, del);
  card.append(acts);
  return card;
}

function editor(c: any | null, reload: () => void) {
  const isNew = !c;
  const card = el('div', { class: 'card ctx-editor' });
  const S = 'width:100%;padding:7px 9px;font:inherit;box-sizing:border-box';
  const F = (label: string, hint: string | null, ctrl: any) => el('div', { class: 'ctx-field' },
    el('div', { class: 'field-label', text: label }),
    hint ? el('p', { class: 'admin-hint ctx-field-hint', text: hint }) : null, ctrl);

  const keyIn = el('input', { type: 'text', style: S, value: c?.key ?? '', placeholder: 'notion-mirror', ...(isNew ? {} : { disabled: true }) }) as HTMLInputElement;
  const labelIn = el('input', { type: 'text', style: S, value: c?.label ?? '', placeholder: '노션 문서 카테고리 붙이기' }) as HTMLInputElement;
  const prioIn = el('input', { type: 'number', style: S, value: String(c?.priority ?? 0) }) as HTMLInputElement;
  const enabledChk = el('input', { type: 'checkbox' }) as HTMLInputElement;
  enabledChk.checked = c ? !!c.enabled : true;

  const systemsIn = el('input', { type: 'text', style: S, value: (c?.match_systems || []).join(', '), placeholder: '비우면 전체 (notion, domain-wiki …)' }) as HTMLInputElement;
  const critIn = el('textarea', { style: S + ';min-height:100px;resize:vertical',
    placeholder: '예) 제품 사양·설계 문서는 반드시 해당 도메인으로. 회의록은 주제가 여럿이면 가장 많이 다룬 쪽으로. 부모 문서가 이미 카테고리를 가졌으면 그쪽을 먼저 본다.' }) as HTMLTextAreaElement;
  critIn.value = c?.criteria_md ?? '';
  const candIn = el('textarea', { style: S + ';min-height:70px;resize:vertical',
    placeholder: '카테고리 key 를 줄바꿈·쉼표로. 비우면 전체 중에서 고릅니다.' }) as HTMLTextAreaElement;
  candIn.value = (c?.candidate_categories || []).join('\n');
  const thIn = el('input', { type: 'number', style: S, step: '0.05', min: '0', max: '1', value: String(c?.confirm_threshold ?? 0.8) }) as HTMLInputElement;
  const batchIn = el('input', { type: 'number', style: S, min: '1', max: '500', value: String(c?.batch_size ?? 50) }) as HTMLInputElement;
  //  실행 계정(#4052) — 이름으로 찾아 고른다.
  const reqPick = personSelect({ value: c?.requester ?? '', emptyText: '비워 두면 자동 실행에 정한 계정으로 돕니다', label: '실행 계정' });
  //  제공자·모델·추론강도(#4008) — 비우면 그 하네스의 자동화 기본값(가장 비싼 모델로 돌지 않게 라이블리가 정한다).
  const run = runConfig({ harness: c?.harness ?? null, model: c?.model ?? null, effort: c?.effort ?? null }, S);
  const resetChk = el('input', { type: 'checkbox' }) as HTMLInputElement;

  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '증류기 만들기' : '저장' }) as HTMLButtonElement;
  saveBtn.addEventListener('click', async () => {
    const key = keyIn.value.trim();
    if (!key) { toast('식별자를 입력하세요', true); return; }
    saveBtn.disabled = true;
    try {
      await api('/api/ui/org/classifiers', { method: 'POST', body: JSON.stringify({
        ...(c ? { id: c.id } : {}), key,
        label: labelIn.value.trim() || null, enabled: enabledChk.checked,
        priority: Number(prioIn.value) || 0,
        //  폐지된 재분류 모드였던 레인은 저장하면 «미분류 지식» 을 맡게 된다 — 편집기가 그 사실을 위에서 말한다.
        ...(retired(c) ? { target: 'unmapped' } : {}),
        match_systems: systemsIn.value,
        criteria_md: critIn.value.trim() || null, candidate_categories: candIn.value,
        confirm_threshold: Number(thIn.value), batch_size: Number(batchIn.value) || 50,
        requester: reqPick.value() || null,
        ...run.value(),
        reset_seen: resetChk.checked,
      }) });
      toast(isNew ? '증류기를 만들었습니다' : '저장했습니다');
      editingKey = null; creating = false; reload();
    } catch (e) { toast('실패 — ' + (e as Error).message, true); saveBtn.disabled = false; }
  });
  const cancelBtn = el('button', { class: 'btn-text', text: '닫기' });
  cancelBtn.addEventListener('click', () => { editingKey = null; creating = false; reload(); });

  card.append(
    el('div', { class: 'ctx-row-head' }, el('span', { class: 'ctx-row-title', text: isNew ? '새 증류기 — ' + FILL_LANE : `설정 — ${c.label || c.key}` })),
    retired(c) ? el('p', { class: 'admin-hint ctx-warn-line', text: '이 증류기는 없어진 «확신 낮은 분류 재검토» 모드라 지금 아무 지식도 맡지 않습니다. 저장하면 미분류 지식을 맡도록 바뀝니다 — 이미 붙은 카테고리가 틀린 것은 [점검]이 찾거나 사람이 옮깁니다.' }) : null,
    F('식별자', isNew ? '영문·숫자 슬러그. 만든 뒤에는 바꾸지 않습니다.' : '만든 뒤에는 바꾸지 않습니다.', keyIn),
    F('이름', '목록에 보일 이름입니다.', labelIn),
    F('우선순위', '높을수록 지식을 먼저 가져갑니다. 낮은 값 + 넓은 범위 = 나머지를 받는 기본 증류기.', prioIn),
    F('대상 출처 제한', '이 출처에서 들어온 지식만 봅니다(예: notion). 비우면 전체.', systemsIn),
    F('고르는 기준', '이 팀에서 무엇을 어느 카테고리에 넣을지 그대로 쓰세요. 이 문장이 AI 의 판단 기준이 됩니다.', critIn),
    F('후보 카테고리 제한', '이 카테고리들 중에서만 고르게 합니다. 팀이 자기 카테고리 안에서만 정하게 할 때.', candIn),
    F('확정 기준 확신도', '이 값 이상이면 바로 확정, 미만이면 사람 확인(확인할 것 ▸ 카테고리 제안)으로 보냅니다. 높일수록 사람 손이 늘고 정확해집니다.', thIn),
    F('한 번에 처리할 지식 수', '', batchIn),
    F('실행 계정', '이 사람의 AI 계정으로 돌고, 비용도 그 계정에 붙습니다.', reqPick.el),
    F('AI 제공자', '이 증류기를 어느 AI 로 돌릴지. 「자동」이면 실행 계정이 로그인한 AI 중에서 고릅니다(클로드 우선).', run.harnessSel),
    F('모델', '기준이 까다로우면 더 좋은 모델을 권합니다. 정확해지는 만큼 비쌉니다.', run.modelSel),
    F('추론 강도', '높일수록 정확하고 비쌉니다.', run.effortSel),
    run.hint,
    el('label', { class: 'admin-check' }, resetChk, ' 이미 본 지식을 다시 보기 — 기준을 바꿨을 때 켜세요'),
    el('label', { class: 'admin-check' }, enabledChk, ' 이 증류기 사용'),
    el('div', { class: 'ctx-actions' }, saveBtn, cancelBtn));
  return card;
}

async function openPreview(c: any) {
  const { overlay } = await import('./ui-primitives.js');
  const box = el('div', {}, el('p', { class: 'admin-hint', text: '확인 중…' }));
  overlay(`맡은 지식 — ${c.label || c.key}`, box);
  try {
    const r = await api('/api/ui/org/classifiers/preview?' + new URLSearchParams({ key: c.key, limit: '20' }));
    const sample: any[] = r.sample || [];
    if (!sample.length) {
      box.replaceChildren(el('p', { class: 'admin-hint', text: retired(c)
        ? '이 증류기는 없어진 재검토 모드라 아무 지식도 맡지 않습니다 — 설정을 열어 저장하면 미분류 지식을 맡습니다.'
        : '지금 맡은 지식이 0건입니다 — 범위가 좁거나, 우선순위가 높은 증류기가 먼저 가져갔거나, 이미 본 것들입니다(설정에서 “다시 보기”를 켜면 되돌릴 수 있습니다).' }));
      return;
    }
    const list = el('div', { class: 'ctx-preview-list' });
    for (const s of sample) {
      list.append(el('div', { class: 'ctx-preview-row' },
        el('a', { class: 'ctx-preview-t', href: '#/k/' + encodeURIComponent(s.name), text: s.title || s.name }),
        el('div', { class: 'ctx-preview-m', text: [s.type, s.provenance === 'observed' ? '바로 들어온 문서' : '직접 쓴 문서'].filter(Boolean).join(' · ') })));
    }
    box.replaceChildren(el('p', { class: 'admin-hint', text: `지금 맡은 지식 ${fmtNum(r.backlog)}건 중 ${sample.length}건입니다.` }), list);
  } catch (e) { box.replaceChildren(el('p', { class: 'admin-hint', text: '실패: ' + (e as Error).message })); }
}
