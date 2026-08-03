// distillers.ts — 자료 증류기(#1289). 관리탭 [AI 맥락 ▸ 자료 증류기].
//
//  왜 이 화면이 있나(실측 ernest-slack-distill-zero-measurement-1289): 고객사 A 슬랙 10,900건 중 증류 13건(0.12%).
//  수집은 도는데 증류가 안 돌았고, 크론을 켜도 인박스가 전역 하나뿐이라 팀별로 다른 대상 채널·지식화 기준·
//  결과 형식을 표현할 데가 없었다. 그래서 '증류기'를 n개 세우고 각각을 여기서 설정한다.
//
//  화면 설계 원칙:
//   · **목록과 편집이 한 페이지에** — 편집을 모달로 띄우면 설정을 만지면서 다른 증류기의 잔량·사각지대를 못 본다.
//     이 화면의 판단은 대부분 비교(어디에 몇 건이 밀렸나)라, 맥락을 가리는 모달이 특히 나쁘다.
//   · **레버 먼저, 세부는 접어서** — 채널마다 기준이 달라 결국 튜닝해야 하는데 축이 4개면 감이 안 온다.
//     슬라이더 하나로 강도를 잡고, 그 값이 실제로 몇 건을 통과시키는지 **즉시 숫자로** 보여준다(추측 금지).
//     세부 축은 접힌 채 두되 제한하지 않는다 — 열면 축별로 덮어쓸 수 있다.
//   · **사각지대를 맨 위에** — "증류기를 켰는데 왜 안 줄지?"의 답이 목록보다 먼저 보인다.
//   · **채널은 고르는 것** — 실재하는 채널 목록(건수·잔량 포함)에서 눌러 담는다(오타 원천 차단).
import { api, cardHead, el, relTime, toast } from './core.js';

const PAGE_TYPES = ['', 'decision', 'concept', 'how-to', 'reference', 'research', 'entity'];
const KINDS = ['slack', 'email', 'discord', 'transcript', 'minutes', 'notion_doc', 'clickup_doc', 'drive_file', 'other'];

// 화면 상태 — 지금 어떤 증류기를 펼쳐 편집 중인가(목록을 다시 그려도 유지).
let editingKey: string | null = null;
let creatingNew = false;

export async function distillersPanel(detail, data) {
  const head = () => el('div', { class: 'admin-sechead' },
    el('div', { class: 'section-title' }, el('h2', { text: '자료 증류기' })),
    el('p', { class: 'admin-hint', text: '수집된 원본 자료를 무슨 기준으로 어떤 형식의 지식으로 만들지 정합니다. 팀·채널마다 다르게 여러 개 만들 수 있습니다.' }));

  detail.replaceChildren(head(), el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '증류기 불러오는 중…' })));

  let res;
  try { res = await api('/api/ui/org/distillers'); }
  catch (e) { detail.replaceChildren(head(), el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '로드 실패: ' + e.message }))); return; }

  const distillers = res.distillers || [];
  const coverage = res.coverage || { total_undistilled: 0, uncovered: 0, distillers: [], uncovered_channels: [] };
  const stat = (id) => coverage.distillers.find((x) => x.id === id) || {};
  const rerender = () => { void distillersPanel(detail, data); };

  const body = el('div', {});

  body.append(el('p', { class: 'admin-hint' },
    el('span', { text: '증류기는 수집된 원본 자료(슬랙·메일 등)를 읽어 지식으로 만드는 생산 라인입니다. 한 자료는 ' }),
    el('b', { text: '우선순위가 가장 높은 증류기 하나' }),
    el('span', { text: '에만 배정됩니다(중복 증류 없음). 우선순위를 낮게 준 넓은 증류기는 자연히 나머지를 받는 기본 라인이 됩니다.' })));

  body.append(coverageCard(coverage, distillers));

  if (!distillers.length && !creatingNew) {
    body.append(el('p', { class: 'admin-hint' },
      el('span', { text: '아직 증류기가 없습니다. 증류기가 하나도 없으면 증류 잡은 ' }),
      el('b', { text: '전 자료 공통 기본 증류' }), el('span', { text: '로 동작합니다(채널·기준 구분 없음).' })));
  }

  for (const d of distillers) {
    body.append(editingKey === d.key ? editorCard(d, rerender) : summaryCard(d, stat(d.id), rerender));
  }

  if (creatingNew) body.append(editorCard(null, rerender));
  else {
    const add = el('button', { class: 'btn', text: '+ 증류기 만들기' });
    add.addEventListener('click', () => { creatingNew = true; editingKey = null; rerender(); });
    body.append(el('div', { style: 'margin-top:14px' }, add));
  }

  body.append(await runJobCard(rerender));
  detail.replaceChildren(head(), body);
}

// ── 현황(사각지대 먼저) ────────────────────────────────────────────────────
function coverageCard(cov, distillers) {
  const card = el('div', { class: 'card', style: 'margin-top:12px' }, cardHead('증류 현황'));
  const on = distillers.filter((d) => d.enabled).length;
  card.append(el('div', { class: 'mini-meta' },
    el('span', { class: 'pill', text: '미증류 자료 ' + (cov.total_undistilled || 0).toLocaleString() + '건' }),
    el('span', { class: 'pill' + (on ? ' pill-ok' : ''), text: '켜진 증류기 ' + on + '/' + distillers.length }),
    el('span', { class: 'pill' + (cov.uncovered ? '' : ' pill-ok'), text: '사각지대 ' + (cov.uncovered || 0).toLocaleString() + '건' })));

  if (cov.uncovered > 0 && on > 0) {
    card.append(el('p', { class: 'admin-hint', style: 'margin-top:8px' },
      el('b', { text: '⚠ 사각지대 ' + cov.uncovered.toLocaleString() + '건' }),
      el('span', { text: ' — 켜진 증류기 어디에도 안 걸리는 자료입니다. 이대로 두면 영영 증류되지 않습니다. 아래 채널을 기존 증류기 범위에 넣거나, 우선순위를 낮춘 넓은 증류기를 하나 만들어 나머지를 받게 하세요.' })));
    if ((cov.uncovered_channels || []).length) {
      const grid = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px' });
      for (const c of cov.uncovered_channels) grid.append(el('span', { class: 'pill', text: (c.channel || '(채널 없음)') + ' · ' + c.n.toLocaleString() }));
      card.append(grid);
    }
  }
  return card;
}

// ── 접힌 카드(목록) ────────────────────────────────────────────────────────
function summaryCard(d, st, rerender) {
  const card = el('div', { class: 'card', style: 'margin-top:12px' });
  card.append(el('div', { class: 'mini-title' },
    el('span', { text: d.label || d.key }),
    el('span', { class: 'pill' + (d.enabled ? ' pill-ok' : ''), text: d.enabled ? '켜짐' : '꺼짐' }),
    el('span', { class: 'pill', text: '우선순위 ' + d.priority }),
    el('span', { class: 'pill', text: '남은 자료 ' + Number(st.backlog || 0).toLocaleString() + '건' }),
    st.reviewed ? el('span', { class: 'pill', text: '판정 ' + Number(st.reviewed).toLocaleString() }) : null,
    d.prefilter_level ? el('span', { class: 'pill', text: '사전필터 ' + d.prefilter_level }) : null));
  card.append(el('div', { class: 'mini-meta' }, el('span', { text: d.scope_text || '범위 전체' })));
  card.append(el('div', { class: 'mini-meta' }, el('span', {
    text: d.last_run_at ? ('마지막 실행 ' + relTime(d.last_run_at) + ' · ' + (d.last_status || '')) : '아직 실행된 적 없음' })));

  const chk = el('input', { type: 'checkbox' });
  (chk as HTMLInputElement).checked = !!d.enabled;
  chk.addEventListener('change', async () => {
    try { await api('/api/ui/org/distillers', { method: 'POST', body: JSON.stringify({ ...settable(d), enabled: (chk as HTMLInputElement).checked }) }); toast('저장됨'); rerender(); }
    catch (e) { toast(e.message, true); (chk as HTMLInputElement).checked = !(chk as HTMLInputElement).checked; }
  });
  const edit = el('button', { class: 'btn btn-ghost btn-sm', text: '설정 열기' });
  edit.addEventListener('click', () => { editingKey = d.key; creatingNew = false; rerender(); });
  const del = el('button', { class: 'btn-text', text: '삭제' });
  del.addEventListener('click', async () => {
    if (!confirm(`증류기 '${d.label || d.key}' 를 삭제할까요? (이미 만들어진 지식은 그대로 남습니다)`)) return;
    try { await api('/api/ui/org/distillers/remove', { method: 'POST', body: JSON.stringify({ id: d.id }) }); toast('삭제됨'); rerender(); }
    catch (e) { toast(e.message, true); }
  });
  card.append(el('div', { style: 'display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap' },
    el('label', { class: 'inline' }, chk, el('span', { text: ' 켜기' })), edit, del));
  return card;
}

// upsert 는 전 필드 교체라, 부분 저장 시 나머지가 날아가지 않게 현재 값을 그대로 되보낸다.
function settable(d) {
  return {
    id: d.id, key: d.key, label: d.label, priority: d.priority, enabled: d.enabled,
    match_kinds: d.match_kinds, match_system: d.match_system,
    include_channels: d.include_channels, exclude_channels: d.exclude_channels,
    include_authors: d.include_authors, exclude_authors: d.exclude_authors,
    exclude_bots: d.exclude_bots, min_chars: d.min_chars, lookback_days: d.lookback_days,
    criteria_md: d.criteria_md, format_md: d.format_md, target_category: d.target_category,
    default_type: d.default_type, name_prefix: d.name_prefix, thread_aware: d.thread_aware,
    prefilter_level: d.prefilter_level, prefilter_rules: d.prefilter_rules,
    batch_size: d.batch_size, batch_max_msgs: d.batch_max_msgs, mode: d.mode, session_ref: d.session_ref,
    model: d.model, effort: d.effort, requester: d.requester, note: d.note,
  };
}

// ── 페이지 내 편집기 ───────────────────────────────────────────────────────
function editorCard(d, rerender) {
  const isNew = !d;
  const card = el('div', { class: 'card', style: 'margin-top:12px;border-left:3px solid var(--accent,#4a7)' });
  const S = 'width:100%;padding:7px 9px;font:inherit;box-sizing:border-box';

  // 한 줄 필드 — 라벨·설명·입력을 묶어 일관되게. 설명은 '왜 이 값을 정하나'를 말한다.
  const F = (label, hint, ctrl) => el('div', { style: 'margin:0 0 14px' },
    el('div', { class: 'field-label', text: label }),
    hint ? el('p', { class: 'admin-hint', style: 'margin:2px 0 6px', text: hint }) : null, ctrl);
  // 접이식 — 세부 옵션을 숨기되 막지는 않는다(커스텀 상한 없음).
  const fold = (title, ...kids) => {
    const box = el('div', { style: 'display:none;margin-top:10px' }, ...kids);
    const btn = el('button', { type: 'button', class: 'btn-text', text: '▸ ' + title });
    btn.addEventListener('click', () => {
      const open = box.style.display === 'none';
      box.style.display = open ? 'block' : 'none';
      btn.textContent = (open ? '▾ ' : '▸ ') + title;
    });
    return el('div', { style: 'margin:6px 0 0' }, btn, box);
  };

  const v = (k, dflt: any = '') => (d && d[k] != null ? d[k] : dflt);
  const listText = (x) => Array.isArray(x) ? x.join('\n') : (x || '');

  const keyIn = el('input', { type: 'text', style: S, value: v('key'), placeholder: 'hf-yeosin', ...(isNew ? {} : { disabled: true }) });
  const labelIn = el('input', { type: 'text', style: S, value: v('label'), placeholder: '여신 제품팀 증류기' });
  const prioIn = el('input', { type: 'number', style: S, value: String(v('priority', 0)) });
  const enabledChk = el('input', { type: 'checkbox', ...(v('enabled', false) ? { checked: true } : {}) });

  // ① 범위
  const kindBoxes: Record<string, HTMLInputElement> = {};
  const kindsWrap = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px' });
  const curKinds = new Set(v('match_kinds', []) || []);
  for (const k of KINDS) {
    const cb = el('input', { type: 'checkbox', value: k }) as HTMLInputElement;
    cb.checked = curKinds.has(k); kindBoxes[k] = cb;
    kindsWrap.append(el('label', { class: 'pill' }, cb, el('span', { text: ' ' + k })));
  }
  const incCh = el('textarea', { style: S + ';min-height:70px;resize:vertical', placeholder: '한 줄에 채널 하나. 비우면 채널 무관(전체)' }) as HTMLTextAreaElement;
  incCh.value = listText(v('include_channels', null));
  const excCh = el('textarea', { style: S + ';min-height:52px;resize:vertical', placeholder: '제외할 채널(한 줄에 하나)' }) as HTMLTextAreaElement;
  excCh.value = listText(v('exclude_channels', null));
  const botChk = el('input', { type: 'checkbox', ...(v('exclude_bots', true) ? { checked: true } : {}) });
  const minIn = el('input', { type: 'number', style: S, value: String(v('min_chars', 0)), min: '0' });
  const lookIn = el('input', { type: 'number', style: S, value: d && d.lookback_days ? String(d.lookback_days) : '', placeholder: '비우면 전체 기간(과거 백필 포함)' });

  const chPick = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;max-height:150px;overflow:auto;margin-top:8px' },
    el('span', { class: 'admin-hint', text: '채널 목록 불러오는 중…' }));
  void (async () => {
    try {
      const r = await api('/api/ui/org/source-channels?limit=200');
      const chans = (r.channels || []).filter((c) => c.channel);
      chPick.replaceChildren();
      if (!chans.length) { chPick.append(el('span', { class: 'admin-hint', text: '수집된 채널이 아직 없습니다.' })); return; }
      for (const c of chans) {
        const b = el('button', { type: 'button', class: 'pill', title: '클릭하면 대상 채널에 추가',
          text: c.channel + ' · 미증류 ' + Number(c.undistilled).toLocaleString() });
        b.addEventListener('click', () => {
          const cur = incCh.value.split('\n').map((s) => s.trim()).filter(Boolean);
          if (!cur.includes(c.channel)) { cur.push(c.channel); incCh.value = cur.join('\n'); }
        });
        chPick.append(b);
      }
    } catch { chPick.replaceChildren(el('span', { class: 'admin-hint', text: '채널 목록을 불러오지 못했습니다(직접 입력해도 됩니다).' })); }
  })();

  // ② 사전 필터 — 축별 수치가 정본(레버 폐기). 최적값은 AI 가 실측으로 정한다.
  const rules = (d && d.prefilter_rules) || {};
  const rIn = (k, ph) => {
    const i = el('input', { type: 'number', style: S, placeholder: ph }) as HTMLInputElement;
    if (rules[k] != null) i.value = String(rules[k]);
    return i;
  };
  const rDec = rIn('min_decisive', '비우면 조건 없음'), rAut = rIn('min_authors', '비우면 조건 없음');
  const rMsg = rIn('min_msgs', '비우면 조건 없음'), rChr = rIn('min_chars', '비우면 조건 없음');
  const rKw = el('textarea', { style: S + ';min-height:96px;resize:vertical',
    placeholder: '한 줄에 하나. 이 채널에서 실제로 쓰는 말을 많이 넣을수록 좋습니다(도메인 용어가 특히 잘 듣습니다).' }) as HTMLTextAreaElement;
  rKw.value = Array.isArray(rules.keywords) ? rules.keywords.join('\n') : '';
  const rMatch = el('select', { style: S }) as HTMLSelectElement;
  rMatch.append(el('option', { value: 'any', text: '하나만 만족해도 통과 (OR · 권장)' }));
  rMatch.append(el('option', { value: 'all', text: '모든 조건을 만족해야 통과 (AND · 유실 큼)' }));
  rMatch.value = rules.match === 'all' ? 'all' : 'any';

  // ③ 기준·형식
  const critIn = el('textarea', { style: S + ';min-height:110px;resize:vertical',
    placeholder: '예) 제품 사양 결정·장애 원인과 조치·운영 규칙 합의만 지식화한다. 일정 조율·단순 질의응답은 제외.' }) as HTMLTextAreaElement;
  critIn.value = v('criteria_md');
  const fmtIn = el('textarea', { style: S + ';min-height:110px;resize:vertical',
    placeholder: '예) 제목은 “[여신] <결정 한 줄>”. 본문은 배경 / 결정 / 근거 / 영향 순서의 섹션으로.' }) as HTMLTextAreaElement;
  fmtIn.value = v('format_md');
  const catIn = el('input', { type: 'text', style: S, value: v('target_category'), placeholder: '비우면 AI가 내용에 맞는 분류를 고름' });
  const typeSel = el('select', { style: S }) as HTMLSelectElement;
  for (const t of PAGE_TYPES) typeSel.append(el('option', { value: t, text: t || '(자동)' }));
  if (v('default_type')) typeSel.value = v('default_type');
  const prefixIn = el('input', { type: 'text', style: S, value: v('name_prefix'), placeholder: '예: hf-yeosin-' });
  const threadChk = el('input', { type: 'checkbox', ...(v('thread_aware', true) ? { checked: true } : {}) });

  // ④ 실행
  const batchIn = el('input', { type: 'number', style: S, value: String(v('batch_size', 3)), min: '1', max: '200' });
  const batchMsgIn = el('input', { type: 'number', style: S, value: String(v('batch_max_msgs', 20)), min: '1', max: '2000' });
  const modeSel = el('select', { style: S }) as HTMLSelectElement;
  modeSel.append(el('option', { value: 'headless', text: '헤드리스 — 매 배치 새 세션(권장)' }));
  modeSel.append(el('option', { value: 'session', text: '상시 세션에 주입' }));
  if (v('mode')) modeSel.value = v('mode');
  const sessIn = el('input', { type: 'text', style: S, value: v('session_ref'), placeholder: '실행 방식이 상시 세션일 때만' });
  const modelSel = el('select', { style: S }) as HTMLSelectElement;
  for (const m of ['', 'opus', 'sonnet', 'haiku']) modelSel.append(el('option', { value: m, text: m || '(계정 기본)' }));
  if (v('model')) modelSel.value = v('model');
  const effortSel = el('select', { style: S }) as HTMLSelectElement;
  for (const m of ['', 'low', 'medium', 'high', 'xhigh', 'max']) effortSel.append(el('option', { value: m, text: m || '(기본)' }));
  if (v('effort')) effortSel.value = v('effort');
  const reqIn = el('input', { type: 'text', style: S, value: v('requester'), placeholder: '비우면 잡 생성자 — 이 사람의 AI 계정으로 실행·과금' });

  const collect = () => {
    const kw = rKw.value.split('\n').map((s) => s.trim()).filter(Boolean);
    const pr: any = {};
    const put = (k, i) => { const x = (i as HTMLInputElement).value.trim(); if (x !== '') pr[k] = Number(x); };
    put('min_decisive', rDec); put('min_authors', rAut); put('min_msgs', rMsg); put('min_chars', rChr);
    if (kw.length) pr.keywords = kw;
    if (rMatch.value === 'any') pr.match = 'any';
    return {
      ...(d ? { id: d.id } : {}),
      key: (keyIn as HTMLInputElement).value.trim(),
      label: (labelIn as HTMLInputElement).value.trim() || null,
      enabled: (enabledChk as HTMLInputElement).checked,
      priority: Number((prioIn as HTMLInputElement).value) || 0,
      match_kinds: Object.keys(kindBoxes).filter((k) => kindBoxes[k].checked),
      include_channels: incCh.value, exclude_channels: excCh.value,
      exclude_bots: (botChk as HTMLInputElement).checked,
      min_chars: Number((minIn as HTMLInputElement).value) || 0,
      lookback_days: (lookIn as HTMLInputElement).value.trim() ? Number((lookIn as HTMLInputElement).value) : null,
      prefilter_level: 0,   // 레버 폐기 — rules 가 정본
      prefilter_rules: Object.keys(pr).length ? pr : null,
      criteria_md: critIn.value.trim() || null,
      format_md: fmtIn.value.trim() || null,
      target_category: (catIn as HTMLInputElement).value.trim() || null,
      default_type: typeSel.value || null,
      name_prefix: (prefixIn as HTMLInputElement).value.trim() || null,
      thread_aware: (threadChk as HTMLInputElement).checked,
      batch_size: Number((batchIn as HTMLInputElement).value) || 3,
      batch_max_msgs: Number((batchMsgIn as HTMLInputElement).value) || 20,
      mode: modeSel.value,
      session_ref: (sessIn as HTMLInputElement).value.trim() || null,
      model: modelSel.value || null, effort: effortSel.value || null,
      requester: (reqIn as HTMLInputElement).value.trim() || null,
      // 조각: 손대지 않은(빈) 칸은 **키를 아예 안 보낸다** — 미지정=기본값이고, 빈 문자열은 '그 조각을 뺀다'는
      //  다른 뜻이기 때문이다. 조각 UI 를 아직 안 불러왔으면 이 필드를 건드리지 않는다(기존 설정 보존).
      ...(sectionsLoaded.v ? { prompt_sections: (() => {
        const o: Record<string, string> = {};
        for (const [id, ta] of Object.entries(sectionInputs)) if (ta.value !== '') o[id] = ta.value;
        return Object.keys(o).length ? o : null;
      })() } : {}),
    };
  };

  // ── 프롬프트 조각 덮어쓰기(#1419-B) ──────────────────────────────────────────
  //  프롬프트가 코드에 통으로 박혀 있으면 무엇이 나가는지 파악도 수정도 어렵다. 조각만 덮어쓴다.
  //  · 편집란은 **비어 있는 게 기본** — 비면 코드 기본값이 나가고, 제품 개선이 계속 흘러든다.
  //  · [기본값 보기]로 원문을 펼쳐 확인한 뒤 덮어쓴다(무엇을 대체하는지 모르면 덮어쓸 수 없다).
  //  · 대상 지정·안전 문구는 불변이라 여기 없다(스코프 누출·주입 방어 상실 방지).
  const SECTION_HINT: Record<string, string> = {
    intro: '배치 첫 문장. 증류기 이름과 자료 건수를 알립니다.',
    criteria: '무엇을 지식화할지. 위 [지식화 기준] 칸이 이 조각의 저장소입니다 — 여기에 쓰면 그 칸 대신 이게 나갑니다.',
    format: '결과 문서 형식. 위 [문서 형식] 칸이 저장소입니다.',
    thread: '스레드를 한 덩어리로 묶으라는 지시. 스레드 묶기를 끄면 애초에 안 나갑니다.',
    procedure: '절차 ①~⑤(본문 읽기·중복확인·저장·허용선·skip).',
  };
  const sectionInputs: Record<string, HTMLTextAreaElement> = {};
  const sectionsHost = el('div');
  const sectionsLoaded = { v: false };

  function renderSections(views: any[]): void {
    const rows: HTMLElement[] = [];
    for (const v of (views || [])) {
      const ta = el('textarea', { rows: '4', style: 'width:100%;font-size:12px', placeholder: '비어 있으면 기본값이 나갑니다' }) as HTMLTextAreaElement;
      ta.value = typeof v.override === 'string' ? v.override : '';
      sectionInputs[v.id] = ta;
      rows.push(el('div', { style: 'margin-bottom:12px' },
        el('div', { class: 'mini-meta' },
          el('span', { class: 'pill', text: v.label }),
          el('span', { class: 'admin-hint', text: ' ' + (SECTION_HINT[v.id] || '') })),
        ta,
        el('details', { style: 'margin-top:4px' },
          el('summary', { class: 'admin-hint', text: '기본값 보기' }),
          el('pre', { style: 'white-space:pre-wrap;font-size:11px;max-height:200px;overflow:auto', text: v.def || '(이 조각은 지금 설정에선 나가지 않습니다)' }))));
    }
    sectionsLoaded.v = true;
    sectionsHost.replaceChildren(
      el('p', { class: 'admin-hint', text: '비워 두면 코드 기본값이 나갑니다(제품이 개선되면 자동 반영). 내용을 쓰면 그 조각만 대체됩니다. 대상 자료 지정과 안전 문구는 바꿀 수 없어 여기 없습니다.' }),
      ...rows);
  }

  // ── 반사판(우측) — "지금 이 설정이 무엇을 집는가"를 입력 즉시 보여준다 ──────────
  //  종전 화면의 가장 큰 불편이 여기였다: 미리보기가 **저장된 값**만 읽고 폼 맨 아래에 나와서,
  //  채널 하나 고치려면 저장→스크롤→확인을 반복해야 했다(새 증류기는 미리보기 자체가 거부됐다).
  //  이제 입력이 바뀌면 draft 로 서버에 물어 오른쪽이 갱신된다 — 저장 없이. DB 는 안 건드린다.
  const rBacklog = el('div', { class: 'mini-title', text: '—' });
  const rFilter = el('p', { class: 'admin-hint', style: 'margin:2px 0 0' });
  const rLoss = el('p', { style: 'margin:6px 0 0;font-size:12px' });
  const rSample = el('div', { style: 'display:grid;gap:3px;margin-top:10px' });
  const rPrompt = el('pre', { style: 'white-space:pre-wrap;font-size:11px;max-height:300px;overflow:auto;margin:6px 0 0' });
  const rState = el('p', { class: 'admin-hint', style: 'margin:0' , text: '설정을 바꾸면 여기가 갱신됩니다.' });

  function paint(r) {
    rState.textContent = '';
    rBacklog.textContent = '집힐 자료 ' + Number(r.backlog || 0).toLocaleString() + '건';
    const fi = r.filter_impact;
    if (!fi) { rFilter.textContent = ''; rLoss.replaceChildren(); }
    else if (!fi.filtered) {
      rFilter.textContent = '사전 필터 꺼짐 — 이 범위의 자료를 전부 AI에게 보냅니다.';
      rLoss.replaceChildren();
    } else {
      rFilter.textContent = '필터 통과 ' + Number(fi.pass_msgs).toLocaleString() + '건'
        + (fi.pass_pct != null ? ' (' + fi.pass_pct + '%)' : '') + ' · 범위 전체 ' + Number(fi.msgs).toLocaleString() + '건';
      // ⚠ 유실률이 이 화면의 핵심 숫자다 — 절감은 눈에 띄지만 유실은 안 보여주면 아무도 모른 채 지식을 버린다.
      if (fi.loss_pct == null) {
        rLoss.replaceChildren(el('span', { class: 'admin-hint', text: '이 범위엔 아직 지식이 된 스레드가 없어 유실률을 잴 수 없습니다.' }));
      } else {
        const bad = fi.loss_pct > 5;
        rLoss.replaceChildren(el('b', { style: 'color:' + (bad ? 'var(--danger,#c33)' : 'var(--ok,#2a7)'),
          text: (bad ? '⚠ ' : '✓ ') + '이미 지식이 된 스레드의 ' + fi.loss_pct + '% 가 이 필터에 걸러집니다' }),
          el('span', { class: 'admin-hint', text: ' (' + (fi.known_threads - fi.kept_known) + '/' + fi.known_threads + '건)' }),
          bad ? el('p', { class: 'admin-hint', style: 'margin:4px 0 0', text: '그만큼 앞으로 지식을 놓칩니다. AI에게 "이 증류기 사전 필터를 튜닝해줘"라고 하면 유실을 억제한 값을 실측으로 찾아줍니다.' }) : null);
      }
    }
    rSample.replaceChildren();
    for (const s of (r.sample || [])) {
      rSample.append(el('div', { class: 'mini-meta' },
        el('span', { class: 'pill', text: String(s.channel || s.kind) }),
        el('span', { text: ' ' + String(s.title || '(제목 없음)').slice(0, 70) })));
    }
    if (!(r.sample || []).length) {
      rSample.append(el('p', { class: 'admin-hint', text: '지금 집히는 자료가 0건입니다 — 채널명 오타, 사전 필터가 과함, 또는 우선순위가 높은 증류기가 먼저 가져가는지 확인하세요.' }));
    }
    rPrompt.textContent = r.prompt || '';
    if (r.sections) renderSections(r.sections);
  }

  let seq = 0, timer: any = null;
  async function refresh() {
    const my = ++seq;
    rState.textContent = '계산 중…';
    try {
      const body: any = { draft: collect(), limit: 8 };
      if (!isNew) body.key = d.key;
      const r = await api('/api/ui/org/distillers/preview', { method: 'POST', body: JSON.stringify(body) });
      if (my !== seq) return;            // 늦게 온 응답이 최신 결과를 덮지 않게
      paint(r);
    } catch (e) { if (my === seq) { rState.textContent = '미리보기 실패: ' + e.message; } }
  }
  // 입력 변경 → 디바운스 → 갱신. 타이핑마다 서버를 때리지 않는다.
  const onEdit = () => { clearTimeout(timer); timer = setTimeout(refresh, 600); };
  card.addEventListener('input', onEdit);
  card.addEventListener('change', onEdit);

  const reflector = el('div', { class: 'card', style: 'margin:0;position:sticky;top:12px;align-self:start' },
    el('div', { class: 'mini-meta', style: 'margin-bottom:6px' }, el('span', { class: 'pill', text: '지금 이 설정이' })),
    rBacklog, rFilter, rLoss, rState, rSample,
    el('details', { style: 'margin-top:10px' },
      el('summary', { class: 'admin-hint', text: 'AI 에게 나갈 지시문 전문' }), rPrompt));

  // ── 단계 탭(좌측) — 필드 20개를 한 화면에 세로로 쌓지 않는다 ──────────────────
  const STEPS = [
    { key: 'scope', label: '① 범위', hint: '어떤 자료를 이 증류기가 맡을지' },
    { key: 'filter', label: '② 사전 필터', hint: 'AI에게 보내기 전에 서버가 걸러낼 기준' },
    { key: 'what', label: '③ 기준·형식', hint: '무엇을 지식으로, 어떤 문서로' },
    { key: 'run', label: '④ 실행', hint: '배치 크기·의뢰자·모델' },
    { key: 'prompt', label: '⑤ 지시문', hint: 'AI에게 나갈 문장을 조각별로 손보기' },
  ];
  const panes: Record<string, HTMLElement> = {};
  const tabsRow = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 4px' });
  const paneHost = el('div', { style: 'margin-top:10px' });
  const stepHint = el('p', { class: 'admin-hint', style: 'margin:0' });
  function showStep(k) {
    for (const s of STEPS) {
      const on = s.key === k;
      (tabsRow.querySelector('[data-step="' + s.key + '"]') as HTMLElement)?.classList.toggle('active', on);
    }
    stepHint.textContent = (STEPS.find((s) => s.key === k) || STEPS[0]).hint;
    paneHost.replaceChildren(panes[k]);
  }
  for (const s of STEPS) {
    const b = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-step': s.key, text: s.label });
    b.addEventListener('click', () => showStep(s.key));
    tabsRow.append(b);
  }

  panes.scope = el('div', {},
    F('자료 종류', '비우면 전체. 슬랙만 다루는 증류기면 slack 만 고르세요.', kindsWrap),
    F('대상 채널', '한 줄에 하나. 비우면 채널을 가리지 않습니다. 아래 목록에서 눌러 담으면 오타가 없습니다.', el('div', {}, incCh, chPick)),
    F('제외 채널', '알림봇·모니터링 채널처럼 지식화할 게 없는 곳을 빼세요. (이미 수집된 뒤라면 커넥터에서 막는 게 낫습니다 — 저장공간을 계속 먹습니다.)', excCh),
    el('label', { class: 'inline' }, botChk, el('span', { text: ' 봇이 쓴 메시지는 제외' })),
    fold('세부 조건(길이·기간)',
      F('본문 최소 길이', '이 길이보다 짧은 자료는 건너뜁니다. 0이면 제한 없음.', minIn),
      F('기간', '최근 며칠치만 다룰지. 비우면 과거 전체를 백필합니다.', lookIn)),
    fold('우선순위 — 다른 증류기와 겹칠 때',
      F('우선순위', '높을수록 먼저 가져갑니다. 한 자료는 우선순위가 높은 증류기 하나만 처리합니다. 낮은 값 + 넓은 범위 = 나머지를 받는 기본 라인(catch-all).', prioIn)));

  panes.filter = el('div', {},
    el('p', { class: 'admin-hint', style: 'margin:0 0 10px' },
      el('span', { text: 'AI에게 보내기 ' }), el('b', { text: '전에' }),
      el('span', { text: ' 서버가 스레드를 걸러냅니다. 비워두면 필터가 꺼집니다(전부 보냄). 오른쪽에서 ' }),
      el('b', { text: '유실률' }), el('span', { text: '을 보며 정하세요 — 그게 앞으로 놓칠 지식의 비율입니다.' })),
    el('p', { class: 'admin-hint', style: 'margin:0 0 12px;padding:8px 10px;border-radius:6px;background:var(--bg-soft,#f6f7f9)' },
      el('b', { text: '값을 감으로 정하지 마세요. ' }),
      el('span', { text: 'AI에게 "이 증류기 사전 필터를 튜닝해줘"라고 하면 실측으로 정합니다 — 이 채널에서 판별력 높은 단어가 무엇인지, 조합별 절감 대비 유실이 얼마인지 계산해 최적값을 넣어줍니다.' })),
    F('결정성 키워드 최소 등장', '아래 목록의 말이 스레드에 몇 번 나와야 하는지.', rDec),
    F('결정성 키워드 목록', '이 채널에서 실제로 쓰는 말. 실측상 "결정·장애" 같은 일반어보다 "할인일시납·플랫폼이용료" 같은 도메인 용어가 훨씬 잘 듣습니다. 많이 넣으세요.', rKw),
    F('스레드 최소 길이(자)', '짧은 잡담을 거르는 데 가장 안전한 축입니다.', rChr),
    fold('참여자·메시지 수 조건 (신중히)',
      el('p', { class: 'admin-hint', text: '⚠ 이 두 축이 유실을 많이 냅니다 — 한 사람이 길게 쓴 분석 보고, 짧지만 결론이 담긴 스레드가 잘립니다.' }),
      F('최소 참여자 수', '', rAut),
      F('최소 메시지 수', '', rMsg)),
    F('조건 결합', 'OR 권장. AND 는 모든 축을 만족해야 해서 값진 스레드를 많이 버립니다(실측 21% 유실).', rMatch));

  panes.what = el('div', {},
    F('지식화 기준', '이 팀에서 무엇이 남길 가치가 있는지 그대로 쓰세요. 이 문장이 AI의 판단 기준이 됩니다.', critIn),
    F('결과 문서 형식', '제목 규칙·섹션 구성 등을 자유롭게 쓰세요.', fmtIn),
    el('label', { class: 'inline' }, threadChk, el('span', { text: ' 스레드를 묶어 하나의 지식으로 (권장)' })),
    fold('분류·이름 규칙',
      F('분류 고정', '항상 한 분류에 넣으려면 분류 key 를 쓰세요. 비우면 AI가 내용에 맞게 고릅니다.', catIn),
      F('문서 유형 기본값', '', typeSel),
      F('지식 이름 접두어', '산출 지식의 이름을 이 문자열로 시작하게 합니다.', prefixIn)));

  panes.run = el('div', {},
    F('한 번에 처리할 스레드 수', '배치는 스레드 단위로 자릅니다 — 스레드를 쪼개면 대화가 끊겨 증류가 안 됩니다. 2~3 권장.', batchIn),
    F('한 배치 메시지 상한', '스레드를 최근순으로 담다가 이 수를 넘으면 멈춥니다. ⚠ 첫 스레드는 예외 — 상한보다 커도 통째로 담습니다(대화를 자르지 않으려고). 20~40 권장.', batchMsgIn),
    F('의뢰자', '이 사람의 AI 계정으로 실행되고 과금됩니다.', reqIn),
    fold('실행 방식·모델',
      F('실행 방식', '헤드리스는 매 배치 새 세션이라 이전 판단에 끌려가지 않습니다(권장).', modeSel),
      F('상시 세션 id', '실행 방식이 상시 세션일 때만 필요합니다.', sessIn),
      F('모델', '판단이 무거운 기준이면 sonnet 이상을 권합니다.', modelSel),
      F('추론 강도', '', effortSel)));

  panes.prompt = el('div', {}, sectionsHost);

  // ── 저장 ──────────────────────────────────────────────────────────────────
  const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: isNew ? '증류기 만들기' : '저장' });
  const cancelBtn = el('button', { class: 'btn-text', text: '닫기' });
  saveBtn.addEventListener('click', async () => {
    const body = collect();
    if (!body.key) { toast('식별자(key)가 필요합니다', true); showStep('scope'); return; }
    (saveBtn as HTMLButtonElement).disabled = true;
    try {
      await api('/api/ui/org/distillers', { method: 'POST', body: JSON.stringify(body) });
      toast(isNew ? '증류기를 만들었습니다' : '저장했습니다');
      // 저장 후에도 편집을 이어갈 수 있게 카드를 닫지 않는다(연속 조정이 이 화면의 주 용도다).
      editingKey = body.key; creatingNew = false; rerender();
    } catch (e) { toast('실패 — ' + e.message, true); (saveBtn as HTMLButtonElement).disabled = false; }
  });
  cancelBtn.addEventListener('click', () => { editingKey = null; creatingNew = false; rerender(); });

  const left = el('div', {},
    el('div', { class: 'mini-title' }, el('span', { text: isNew ? '새 증류기' : ('설정 — ' + (d.label || d.key)) })),
    F('이름', '목록에 보일 이름.', labelIn),
    F('식별자(key)', isNew ? '소문자 슬러그(a-z0-9._-). 만든 뒤에는 바꾸지 않는 것을 권합니다.' : '만든 뒤에는 바꾸지 않습니다.', keyIn),
    el('label', { class: 'inline' }, enabledChk, el('span', { text: ' 이 증류기 사용' })),
    tabsRow, stepHint, paneHost,
    el('div', { style: 'display:flex;gap:10px;align-items:center;margin-top:18px;padding-top:14px;border-top:1px solid var(--line,#e5e7eb)' },
      saveBtn, cancelBtn));

  // 2열 — 좁은 화면에서는 자동으로 1열로 떨어진다(반사판이 아래로).
  card.append(el('div', { style: 'display:grid;gap:18px;grid-template-columns:minmax(0,1fr) minmax(260px,var(--reflector,340px));align-items:start' },
    left, reflector));
  showStep('scope');
  void refresh();   // 카드를 열면 바로 지금 상태를 보여준다(버튼을 누르게 하지 않는다)

  return card;
}

// ── 실행 잡 ────────────────────────────────────────────────────────────────
const DISTILL_JOB_ID = 'distill-sources-headless';

async function runJobCard(rerender) {
  const card = el('div', { class: 'card', style: 'margin-top:14px' }, cardHead('언제 도나'));
  let jobs: any[] = [];
  try { const r = await api('/api/ui/cron'); jobs = (r && r.jobs) || []; }
  catch { card.append(el('p', { class: 'admin-hint', text: '스케줄 잡 상태를 볼 권한이 없습니다(관리자에게 문의).' })); return card; }
  const job = jobs.find((j) => j.action === 'distill_sources_headless' || j.action === 'distill_sources');

  if (job) {
    card.append(el('div', { class: 'mini-meta' },
      el('span', { class: 'pill' + (job.enabled ? ' pill-ok' : ''), text: job.enabled ? '켜짐' : '꺼짐' }),
      el('span', { class: 'pill', text: job.id }),
      el('span', { class: 'pill', text: Math.round((job.interval_sec || 0) / 60) + '분마다' }),
      el('span', { text: job.last_run_at ? ('  마지막 실행 ' + relTime(job.last_run_at) + ' · ' + (job.last_status || '')) : '  아직 실행 전' })));
    if (!job.enabled) {
      const on = el('button', { class: 'btn btn-sm', text: '증류 잡 켜기' });
      on.addEventListener('click', async () => {
        (on as HTMLButtonElement).disabled = true;
        try { await api('/api/ui/cron', { method: 'POST', body: JSON.stringify({ id: job.id, enabled: true }) }); toast('증류 잡을 켰습니다'); rerender(); }
        catch (e) { toast(e.message, true); (on as HTMLButtonElement).disabled = false; }
      });
      card.append(el('p', { class: 'admin-hint' }, el('span', { text: '잡이 꺼져 있어 증류가 돌지 않습니다.  ' }), on));
    }
    card.append(el('p', { class: 'admin-hint', text: '주기·의뢰자는 [AI 능력 ▸ 자동화]에서 조정합니다. 증류기를 지정하지 않으면 켜진 증류기 전부가 매 주기 각각 접수됩니다(병렬).' }));
    return card;
  }

  card.append(el('p', { class: 'admin-hint' },
    el('b', { text: '증류 스케줄 잡이 없습니다 — 증류기를 만들어도 아무것도 돌지 않습니다.' }),
    el('span', { text: ' 증류기는 "무엇을 어떻게"만 정하고, 실제로 자료를 집어 AI에게 넘기는 건 스케줄 잡입니다.' })));
  const mk = el('button', { class: 'btn', text: '증류 잡 만들기 (30분마다, 꺼진 상태로)' });
  mk.addEventListener('click', async () => {
    (mk as HTMLButtonElement).disabled = true;
    try {
      await api('/api/ui/cron', { method: 'POST', body: JSON.stringify({
        id: DISTILL_JOB_ID, label: '자료 증류 (수집된 원본→지식, 헤드리스)',
        action: 'distill_sources_headless', params: {}, interval_sec: 1800, enabled: false,
        note: '켜진 증류기별로 미증류 자료 배치를 헤드리스 AI 세션에 접수. 증류기가 없으면 전 자료 공통 기본 증류.',
      }) });
      toast('증류 잡을 만들었습니다 — 증류기를 설정한 뒤 켜세요'); rerender();
    } catch (e) { toast('실패 — ' + e.message, true); (mk as HTMLButtonElement).disabled = false; }
  });
  card.append(el('div', { style: 'margin-top:10px' }, mk));
  return card;
}
