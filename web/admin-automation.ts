// admin-automation.ts — 자동화 섹션의 두 패널: 스케줄(cron) · 상시 에이전트(managed session)
//  (#1313 R37, admin.ts 에서 verbatim 분리 — 셸 역호출 없는 자족 패널).
import { api, busy, cardHead, el, errorNote, memberCombo, relTime, toast, withTip } from './core.js';
import { overlayBox, skeleton } from './ui-primitives.js';
import { psBlock, psInputStyle } from './admin-widgets.js';
import { cronOwner } from './cron-owner.js';   // 잡 → 전용 화면 매핑(#1618 후속, 단일 출처)

// ── 스케줄러(자동화) — org_cron 잡 관리(admin). is 신선화·미매핑 LLM 분류(세션 주입)·sync 를 주기 실행. ──
//  map_unmapped 잡은 '타깃 LLM 세션'(상시 시드 세션)을 골라 거기에 분류 태스크를 주입한다(팀플랜 과금 — headless 토큰 아님).
async function cronPanel(detail, data) {
  const reload = () => cronPanel(detail, data);
  busy(detail, el('div', { class: 'card' }, skeleton('스케줄 잡을 불러오는 중')));
  let jobs; let actions: any[] = []; let tz = 'Asia/Seoul'; // tz(#778) = cron식을 해석하는 벽시계 기준(조직 시간대)
  try { const r = await api('/api/ui/cron'); jobs = (r && r.jobs) || []; actions = (r && r.actions) || []; tz = (r && r.timezone) || tz; }
  catch (e) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '스케줄 잡을 불러오지 못했습니다'))); return; }

  // 자동 생성 잡(#837) — 수집기를 켜면 서버가 싱크 잡을 **자동으로 등록/해제**한다(syncCollectorJob).
  //  관리자가 만든 게 아닌데 목록에선 구분이 안 돼 "내가 이걸 언제 만들었지?"가 됐고, 손으로 지우면
  //  수집기는 켜져 있는데 싱크만 안 도는 상태가 됐다.
  //  ⚠ 두 계보를 모두 잡는다 — 수집기 소유(`collector-<id>`, 현행)와 구 커넥터 축(`sync-<system>`).
  //   종전엔 후자만 봐서 **현행 수집기 잡에 '자동' 표시가 안 붙었다**(정작 지금 자동으로 도는 쪽인데).
  const autoSystemOf = (j) => {
    if (j.action !== 'connector_sync') return null;
    if (/^collector-\d+(-full)?$/.test(String(j.id))) return '수집기';
    const sys = j.params && j.params.system;
    if (!sys) return null;
    return (j.id === 'sync-' + sys || j.id === 'sync-' + sys + '-full') ? String(sys) : null;
  };

  const rows = el('div', { class: 'wikicat-rows' });
  if (!jobs.length) rows.append(el('div', { class: 'wikicat-empty', text: '아직 스케줄 잡이 없습니다.' }));
  for (const j of jobs) {
    const autoSys = autoSystemOf(j);
    // fix#75: 주기 표시만 사람 단위로 — 60 배수는 분, 3600 배수는 시간(원값 괄호 병기). 저장·입력 단위(초)는 그대로.
    const fmtInterval = (s) => (s >= 3600 && s % 3600 === 0) ? ('매 ' + (s / 3600) + '시간(' + s + '초)')
      : (s >= 60 && s % 60 === 0) ? ('매 ' + (s / 60) + '분') : ('매 ' + s + '초');
    const sched = j.run_once ? '한 번만 (1회성)' : (j.cron_expr ? ('cron: ' + j.cron_expr) : fmtInterval(j.interval_sec || 0));
    const sess = (j.params && j.params.session) ? (' → ' + j.params.session) : '';
    const last = j.last_run_at ? (relTime(j.last_run_at) + ' · ' + (j.last_status || '')) : '미실행';
    // 주인 화면(#1618 후속) — 이 잡을 소유한 전용 화면이 있으면 그 자리를 밝히고 링크한다.
    //  표기하지 않으면 "여기서 고쳐도 되나"를 사람이 매번 추측해야 하고, 실제로 그 추측이 틀리면
    //  (예: 수집 싱크 잡만 끄기) 주인 설정과 어긋난 상태가 만들어진다. 주인이 없는 잡(도메인맵·범용)은
    //  아무것도 붙이지 않는다 — 그건 이 표가 곧 주인이라는 뜻이다.
    const owner = cronOwner(j.action, j.id);
    const main = el('div', { class: 'wikicat-row-main' },
      el('span', { class: 'wikicat-name', text: j.label || j.id }),
      autoSys ? withTip(el('span', { class: 'pill', text: '자동' }),
        autoSys === '수집기'
          ? '[맥락 관리 ▸ 수집]에서 수집기를 켜서 자동 등록된 잡입니다. 싱크를 멈추려면 이 잡이 아니라 수집기를 끄세요.'
          : autoSys + ' 커넥터를 켜서 자동 등록된 구 방식 잡입니다. 지금은 [맥락 관리 ▸ 수집]의 수집기가 이 일을 합니다.') : null,
      el('span', { class: 'wikicat-key mono', text: j.action + sess }),
      owner
        ? withTip(owner.href
            ? el('a', { class: 'wikicat-owner', href: owner.href, text: owner.label + ' →' })
            : el('span', { class: 'wikicat-owner', text: owner.label }),
          '이 잡의 전용 화면입니다. ' + owner.why)
        : null,
      el('span', { class: 'dm-tag', text: j.enabled ? sched : '꺼짐' }),
      el('span', { class: 'wikicat-should' }, el('span', { class: 'wikicat-should-label', text: '최근' }), last));
    const acts = el('div', { class: 'wikicat-row-acts' },
      el('button', { class: 'btn btn-ghost btn-sm', text: '지금 실행', onclick: () => cronRunNow(j.id, reload) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: j.enabled ? '끄기' : '켜기', onclick: () => cronToggle(j, reload) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '수정', onclick: () => openCronForm(j, actions, reload, tz) }),
      el('button', { class: 'btn btn-ghost btn-sm btn-ghost-danger', text: '삭제', onclick: () => cronDelete(j.id, reload, autoSys) }));
    rows.append(el('div', { class: 'wikicat-row' }, main, acts));
  }
  const head = el('div', { class: 'wikicat-grouphead' },
    el('span', { class: 'wikicat-grouptitle', text: '스케줄 잡' }),
    el('span', { class: 'wikicat-groupcount', text: String(jobs.length) }),
    el('button', { class: 'btn btn-ghost btn-sm wikicat-add', text: '+ 잡 추가', onclick: () => openCronForm(null, actions, reload, tz) }));
  const card = el('div', { class: 'card' },
    cardHead('정기 실행 잡', '게이트웨이가 정해진 주기마다 실행하는 잡입니다. 실제 코드 의존(is) 최신화(refresh), 미매핑 코드 유닛 LLM 분류(map_unmapped — 타깃 상시 에이전트에 주입, 팀플랜 과금), 외부 자료 수집 싱크 등이 있습니다. 주기는 초 단위 간격 또는 cron식으로 지정합니다. cron식의 시각은 '),
    // 두 종류가 한 표에 섞여 있다는 사실을 표보다 먼저 말한다(#1618 후속) — 행마다 붙는 링크만으로는
    //  "왜 어떤 줄에만 있지?"가 되고, 없는 줄이 '누락'인지 '원래 없는 것'인지 구분이 안 된다.
    el('p', { class: 'admin-hint', style: 'margin:0 0 10px' },
      el('b', { text: '전용 화면이 있는 잡과 없는 잡이 섞여 있습니다. ' }),
      el('span', { text: '오른쪽에 화면 이름이 붙은 잡은 그곳이 정본입니다 — 거기서 켜고 끄면 주기·의뢰자 같은 짝이 함께 맞춰집니다(여기서 고칠 수도 있지만 어긋나기 쉽습니다). 이름이 없는 잡은 이 표가 곧 주인입니다.' })),
    el('div', { class: 'wikicat' }, el('div', { class: 'wikicat-group' }, head, rows)));
  detail.replaceChildren(card);
}

// 잡 추가/수정 폼(오버레이) — id·이름·액션·주기(초 또는 cron식)·켬 + 액션별 params(map_unmapped=세션 피커, refresh_repo=repo, connector_sync=system).
// actions = 액션 레지스트리(cron_list 의 actions = CRON_ACTIONS). 드롭다운·파라미터 필드를 여기서 데이터로 생성(하드코딩 X).
async function openCronForm(job, actions, reload, tz) {
  const isNew = !job;
  tz = tz || 'Asia/Seoul'; // cron식 해석 기준(조직 시간대) — 폼에서 명시해 UTC 오해를 막는다(#778).
  const jp = (job && job.params) || {};

  const idInp = el('input', { type: 'text', style: psInputStyle, value: job ? job.id : '', placeholder: 'my-job', ...(isNew ? {} : { disabled: true }) });
  const labelInp = el('input', { type: 'text', style: psInputStyle, value: (job && job.label) || '', placeholder: '잡 이름' });
  const actionSel = el('select', { style: psInputStyle });
  for (const a of (actions || [])) actionSel.append(el('option', { value: a.key, text: a.label }));
  if (job && job.action) actionSel.value = job.action; // 신뢰 가능한 선택(속성 spread 대신 value 할당)
  const intervalInp = el('input', { type: 'number', style: psInputStyle, value: String((job && job.interval_sec) || 1800), min: '60' });
  const cronInp = el('input', { type: 'text', style: psInputStyle, value: (job && job.cron_expr) || '', placeholder: '예: 0 9 * * 1-5 (비우면 위 주기초 사용)' });
  const enabledChk = el('input', { type: 'checkbox', ...((job ? job.enabled : false) ? { checked: true } : {}) });
  const onceChk = el('input', { type: 'checkbox', ...((job && job.run_once) ? { checked: true } : {}) });

  // 액션별 파라미터 — 레지스트리의 params 스펙에서 동적 생성. kind=session → 상시 세션 피커, 그 외 → 텍스트.
  const paramsWrap = el('div');
  const paramInputs: Record<string, any> = {};
  let managedSessions: any[] | null = null;
  let distillers: any[] | null = null;   // #1289 증류기 피커 — 한 번만 받아 재사용(액션 전환 시 재요청 안 함)
  let classifiers: any[] | null = null;  // #1419 T4 분류기 피커 — 같은 캐시 규칙
  let managers: any[] | null = null;     // #1419 T5 관리기 피커 — 같은 캐시 규칙
  async function renderParams() {
    const a = (actions || []).find((x) => x.key === actionSel.value);
    paramsWrap.replaceChildren();
    for (const k of Object.keys(paramInputs)) delete paramInputs[k];
    if (!a) return;
    for (const p of (a.params || [])) {
      let inp: any;
      if (p.kind === 'session') {
        inp = el('select', { style: psInputStyle });
        inp.append(el('option', { value: '', text: '(상시 세션 선택)' }));
        if (managedSessions == null) { try { const r = await api('/api/ui/managed-sessions'); managedSessions = (r && r.sessions) || []; } catch { managedSessions = []; } }
        for (const s of (managedSessions || [])) inp.append(el('option', { value: s.id, text: (s.label || s.id) + ' — ' + (s.account || '계정?') + (s.enabled ? '' : ' (꺼짐)') }));
        if (jp[p.name]) inp.value = jp[p.name];
      } else if (p.kind === 'distiller') {
        // #1289 자료 증류기 피커 — [AI 맥락 ▸ 자료 증류기]에서 등록한 것. 비우면 액션이 스스로 고른다.
        inp = el('select', { style: psInputStyle });
        inp.append(el('option', { value: '', text: '(비움 — 켜진 증류기 전체)' }));
        if (distillers == null) { try { const r = await api('/api/ui/org/distillers'); distillers = (r && r.distillers) || []; } catch { distillers = []; } }
        for (const d of (distillers || [])) inp.append(el('option', { value: d.key, text: (d.label || d.key) + (d.enabled ? '' : ' (꺼짐)') }));
        // 잡이 가리키던 증류기가 지워졌으면 조용히 '전체'로 바뀌지 않게 — 없어졌다고 말해 준다(저장 시 의도치 않은 확대 방지).
        if (jp[p.name] && !(distillers || []).some((d) => d.key === jp[p.name])) {
          inp.append(el('option', { value: jp[p.name], text: jp[p.name] + ' (등록되지 않음 — 확인 필요)' }));
        }
        if (jp[p.name]) inp.value = jp[p.name];
      } else if (p.kind === 'classifier') {
        // #1419 T4 분류기 피커 — [맥락 관리 ▸ 분류기]에서 등록한 것. 증류기 피커와 같은 규칙.
        inp = el('select', { style: psInputStyle });
        inp.append(el('option', { value: '', text: '(비움 — 켜진 분류기 전체)' }));
        if (classifiers == null) { try { const r = await api('/api/ui/org/classifiers'); classifiers = (r && r.classifiers) || []; } catch { classifiers = []; } }
        for (const c of (classifiers || [])) inp.append(el('option', { value: c.key, text: (c.label || c.key) + (c.enabled ? '' : ' (꺼짐)') }));
        // 지워진 분류기를 가리키던 잡이 조용히 '전체'로 확대되지 않게 — 없어졌다고 말해 준다.
        if (jp[p.name] && !(classifiers || []).some((c) => c.key === jp[p.name])) {
          inp.append(el('option', { value: jp[p.name], text: jp[p.name] + ' (등록되지 않음 — 확인 필요)' }));
        }
        if (jp[p.name]) inp.value = jp[p.name];
      } else if (p.kind === 'manager') {
        // #1419 T5 관리기 피커 — 증류기·분류기 피커와 같은 규칙.
        inp = el('select', { style: psInputStyle });
        inp.append(el('option', { value: '', text: '(비움 — 켜진 관리기 전체)' }));
        if (managers == null) { try { const r = await api('/api/ui/org/managers'); managers = (r && r.managers) || []; } catch { managers = []; } }
        for (const g of (managers || [])) inp.append(el('option', { value: g.key, text: (g.label || g.key) + ' · ' + g.kind + (g.enabled ? '' : ' (꺼짐)') }));
        if (jp[p.name] && !(managers || []).some((g) => g.key === jp[p.name])) {
          inp.append(el('option', { value: jp[p.name], text: jp[p.name] + ' (등록되지 않음 — 확인 필요)' }));
        }
        if (jp[p.name]) inp.value = jp[p.name];
      } else if (p.kind === 'select') {
        // #1101 정적 choices 드롭다운(헤드리스 모델·effort 등) — 값은 CronActionParam.choices(서버 레지스트리)에서 온다.
        inp = el('select', { style: psInputStyle });
        for (const c of (p.choices || [])) inp.append(el('option', { value: c, text: c || '(기본)' }));
        if (jp[p.name]) inp.value = jp[p.name];
      } else if (p.kind === 'textarea') {
        // 긴 작업 프롬프트 — 멀티라인 입력(주입 시 백엔드가 개행→공백 평탄화). value 는 속성 아닌 프로퍼티로 설정.
        inp = el('textarea', { style: psInputStyle + ';min-height:96px;resize:vertical', placeholder: p.hint || '', rows: '5' });
        inp.value = jp[p.name] || '';
      } else {
        inp = el('input', { type: 'text', style: psInputStyle, value: jp[p.name] || '', placeholder: p.hint || '' });
      }
      paramInputs[p.name] = inp;
      paramsWrap.append(psBlock(p.label, p.hint || '', inp));
    }
  }
  actionSel.onchange = renderParams;
  await renderParams();

  const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: isNew ? '잡 추가' : '저장' });
  const form = el('div', { class: 'proj-settings' },
    psBlock('잡 id', isNew ? '소문자 슬러그(a-z0-9_-). 잡의 고유 키.' : 'id 는 변경 불가.', idInp),
    psBlock('이름', '관리 목록에 보일 이름.', labelInp),
    psBlock('액션', '게이트웨이가 실행할 작업(등록된 액션 레지스트리). 액션마다 필요한 인자가 아래에 자동으로 뜹니다.', actionSel),
    paramsWrap,
    psBlock('주기 (초)', '이 간격마다 실행(최소 60). cron식이 있으면 그게 우선.', intervalInp),
    psBlock('cron식 (선택)', '벽시계 스케줄 — 시각은 ' + tz + ' 기준입니다. 예: 0 9 * * 1-5 = 평일 ' + tz + ' 09:00. 비우면 주기초.', cronInp),
    psBlock('한 번만 실행', '체크 시 주기·cron 무시 → 1회 실행 후 자동으로 꺼짐(반복 안 함). 부트스트랩 등 일회성 잡용.', el('label', { class: 'inline' }, onceChk, el('span', { text: ' run once (1회 실행 후 비활성)' }))),
    psBlock('켬', '', el('label', { class: 'inline' }, enabledChk, el('span', { text: ' 활성화' }))),
    el('div', { class: 'ps-rules-actions' }, saveBtn));
  const back = overlayBox(isNew ? '스케줄 잡 추가' : '스케줄 잡 수정 — ' + job.id, form);
  const boxw = back.querySelector('.ov-box'); if (boxw) boxw.classList.add('ov-box-wide');
  saveBtn.onclick = async () => {
    const id = idInp.value.trim();
    if (!id) { toast('잡 id 가 필요합니다', true); return; }
    const p: Record<string, string> = {};
    for (const k of Object.keys(paramInputs)) { const v = String(paramInputs[k].value || '').trim(); if (v) p[k] = v; }
    const body = { id, label: labelInp.value.trim() || null, action: actionSel.value, params: p,
      interval_sec: Number(intervalInp.value) || 1800, cron_expr: cronInp.value.trim(), run_once: onceChk.checked, enabled: enabledChk.checked };
    saveBtn.disabled = true;
    try { await api('/api/ui/cron', { method: 'POST', body: JSON.stringify(body) }); toast(isNew ? '잡을 추가했습니다' : '저장했습니다'); back.remove(); reload(); }
    catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
}

async function cronRunNow(id, reload) {
  try { const r = await api('/api/ui/cron/' + encodeURIComponent(id) + '/run', { method: 'POST' }); toast('실행: ' + ((r && r.status) || 'ok')); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}
async function cronToggle(job, reload) {
  try { await api('/api/ui/cron', { method: 'POST', body: JSON.stringify({ id: job.id, enabled: !job.enabled }) }); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}
// autoSys 가 있으면 이 잡은 [외부 자료 수집]이 만든 것 — 지워도 커넥터를 다시 켜면 되살아나고(ON CONFLICT DO UPDATE),
//  그 사이엔 "커넥터는 켜져 있는데 싱크는 안 도는" 상태가 된다. 그러니 지우지 말고 커넥터를 끄라고 말해 준다.
async function cronDelete(id, reload, autoSys?) {
  const warn = autoSys
    ? '⚠ 이 잡은 [외부 자료 수집 ▸ ' + autoSys + ']이(가) 자동으로 만든 것입니다.\n\n지워도 그 커넥터를 다시 켜면 되살아나고, '
      + '그때까지는 커넥터만 켜져 있고 싱크는 안 도는 상태가 됩니다.\n싱크를 멈추려면 이 잡이 아니라 **커넥터를 끄세요**.\n\n그래도 삭제할까요?'
    : '스케줄 잡 ‘' + id + '’을(를) 삭제할까요?';
  if (!confirm(warn)) return;
  try { await api('/api/ui/cron/' + encodeURIComponent(id) + '/delete', { method: 'POST' }); toast('삭제했습니다'); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}

// 인입 허용선(게이트) · 검토 큐 패널은 web/review.ts 로 분리(#783) — 이 파일은 라우팅만.

// ── 상시 세션(에이전트) — 항상 떠있는 에이전트 세션 CRUD + 격리 워크스페이스 + keep-alive. 크론(map_unmapped 등)이 타깃. ──
//  '에이전트를 위한 프로젝트' — createSession + 공유폴더(managed/<id>) 재사용. account=라이블리 계정/프로필(클로드 로그인, 멀티프로필 대비).
async function managedSessionsPanel(detail, data) {
  const reload = () => managedSessionsPanel(detail, data);
  busy(detail, el('div', { class: 'card' }, skeleton('상시 에이전트를 불러오는 중')));
  let sessions; let live: string[] = [];
  try { const r = await api('/api/ui/managed-sessions'); sessions = (r && r.sessions) || []; }
  catch (e) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '상시 에이전트를 불러오지 못했습니다'))); return; }
  try { const t = await api('/api/ui/terminal/sessions'); live = ((t && t.sessions) || []).map((s) => s.id); } catch { /* 세션목록 실패 무시 */ }

  const rows = el('div', { class: 'wikicat-rows' });
  if (!sessions.length) rows.append(el('div', { class: 'wikicat-empty', text: '아직 상시 에이전트가 없습니다. ‘+ 상시 에이전트 추가’로 등록하면 keep-alive 가 항상 실행 상태로 유지합니다.' }));
  for (const m of sessions) {
    const alive = m.session_id && live.includes(m.session_id);
    const main = el('div', { class: 'wikicat-row-main' },
      el('span', { class: 'wikicat-name', text: m.label || m.id }),
      el('span', { class: 'wikicat-key mono', text: (m.account || '계정 미지정') + ' · ' + (m.harness || 'claude') }),
      el('span', { class: 'dm-tag', text: m.enabled ? (alive ? '실행중' : '대기(재생성 예정)') : '비활성' }),
      el('span', { class: 'wikicat-should' }, el('span', { class: 'wikicat-should-label', text: '세션' }), m.session_id || '미생성'));
    const acts = el('div', { class: 'wikicat-row-acts' },
      el('button', { class: 'btn btn-ghost btn-sm', text: '시작/재생성', onclick: () => managedEnsure(m.id, reload) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: m.enabled ? '끄기' : '켜기', onclick: () => managedToggle(m, reload) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '수정', onclick: () => openManagedSessionForm(m, reload) }),
      el('button', { class: 'btn btn-ghost btn-sm btn-ghost-danger', text: '삭제', onclick: () => managedDelete(m.id, reload) }));
    rows.append(el('div', { class: 'wikicat-row' }, main, acts));
  }
  const head = el('div', { class: 'wikicat-grouphead' },
    el('span', { class: 'wikicat-grouptitle', text: '상시 에이전트' }),
    el('span', { class: 'wikicat-groupcount', text: String(sessions.length) }),
    el('button', { class: 'btn btn-ghost btn-sm wikicat-add', text: '+ 상시 에이전트 추가', onclick: () => openManagedSessionForm(null, reload) }));
  const card = el('div', { class: 'card' },
    cardHead('상시 실행 에이전트', '항상 실행 상태로 유지되는 에이전트 세션입니다. 격리 워크스페이스(공유폴더)에서 실행되며, keep-alive 점검에서 세션이 없으면 자동으로 다시 만듭니다. 크론 잡(미매핑 분류 등)이 이 세션에 작업을 전달합니다 — 팀플랜 과금. account 는 이 세션을 실행할 라이블리 계정(클로드 로그인)입니다.'),
    el('div', { class: 'wikicat' }, el('div', { class: 'wikicat-group' }, head, rows)));
  detail.replaceChildren(card);
}

function openManagedSessionForm(m, reload) {
  const isNew = !m;
  const idInp = el('input', { type: 'text', style: psInputStyle, value: m ? m.id : '', placeholder: 'box-map-agent', ...(isNew ? {} : { disabled: true }) });
  const labelInp = el('input', { type: 'text', style: psInputStyle, value: (m && m.label) || '', placeholder: '도메인 분류 배치 LLM' });
  const account = memberCombo({ value: (m && m.account) || '', placeholder: '구성원 id 선택/검색 (예: daon)' });
  const wsInp = el('input', { type: 'text', style: psInputStyle, value: (m && m.workspace_subpath) || '', placeholder: '비우면 managed/<id>' });
  const harnessSel = el('select', { style: psInputStyle });
  for (const h of ['claude', 'codex', 'shell']) harnessSel.append(el('option', { value: h, text: h, ...((m && m.harness === h) ? { selected: true } : {}) }));
  // 모델·effort = claude 하네스 플래그(--model/--effort) → flags JSONB. 세션 스폰 시 claude argv 로 적용.
  const mflags = (m && m.flags) || {};
  const modelSel = el('select', { style: psInputStyle });
  for (const v of ['', 'opus', 'sonnet', 'haiku']) modelSel.append(el('option', { value: v, text: v || '(기본)', ...((mflags['--model'] === v) ? { selected: true } : {}) }));
  const effortSel = el('select', { style: psInputStyle });
  for (const v of ['', 'low', 'medium', 'high', 'xhigh', 'max']) effortSel.append(el('option', { value: v, text: v || '(기본)', ...((mflags['--effort'] === v) ? { selected: true } : {}) }));
  const autoChk = el('input', { type: 'checkbox', ...((m ? m.auto_approve : true) ? { checked: true } : {}) });
  const enabledChk = el('input', { type: 'checkbox', ...((m ? m.enabled : true) ? { checked: true } : {}) });
  const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: isNew ? '상시 세션 추가' : '저장' });
  const form = el('div', { class: 'proj-settings' },
    psBlock('세션 id', isNew ? '소문자 슬러그(a-z0-9_-). 고유 키.' : 'id 는 변경 불가.', idInp),
    psBlock('이름', '관리 목록·세션 탭에 보일 이름.', labelInp),
    psBlock('라이블리 계정/프로필', '이 세션을 띄울 클로드 로그인(프로필=구성원). 목록에서 고르거나 입력. 각 프로필은 provision + 웹터미널 /login 후 사용.', account.el),
    psBlock('격리 워크스페이스(하위경로)', '공유폴더 아래 이 세션 전용 작업폴더. 비우면 managed/<id>.', wsInp),
    psBlock('하네스', '', harnessSel),
    psBlock('모델 (claude)', '이 세션의 claude 모델. 판단 무거운 작업(부트스트랩·분류)은 opus 권장. 비우면 기본.', modelSel),
    psBlock('effort (claude)', '추론 강도(low~max). 무거운 판단은 high+ 권장. 비우면 기본.', effortSel),
    psBlock('자동 승인', '도구 실행을 묻지 않고 진행(무인 작업에 필요).', el('label', { class: 'inline' }, autoChk, el('span', { text: ' --dangerously-skip-permissions' }))),
    psBlock('항상 켬(keep-alive)', '죽으면 재생성.', el('label', { class: 'inline' }, enabledChk, el('span', { text: ' enabled' }))),
    el('div', { class: 'ps-rules-actions' }, saveBtn));
  const back = overlayBox(isNew ? '상시 세션 추가' : '상시 세션 수정 — ' + m.id, form);
  const boxw = back.querySelector('.ov-box'); if (boxw) boxw.classList.add('ov-box-wide');
  saveBtn.onclick = async () => {
    const id = idInp.value.trim();
    if (!id) { toast('세션 id 가 필요합니다', true); return; }
    const flags: Record<string, string> = {};
    if (harnessSel.value === 'claude') { // model/effort 는 claude 플래그 — 다른 하네스엔 flags 미전송(기존 보존)
      if (modelSel.value) flags['--model'] = modelSel.value;
      if (effortSel.value) flags['--effort'] = effortSel.value;
    }
    const body = { id, label: labelInp.value.trim() || null, account: account.value() || null,
      workspace_subpath: wsInp.value.trim() || null, harness: harnessSel.value,
      auto_approve: autoChk.checked, enabled: enabledChk.checked,
      ...(harnessSel.value === 'claude' ? { flags } : {}) };
    saveBtn.disabled = true;
    try { await api('/api/ui/managed-sessions', { method: 'POST', body: JSON.stringify(body) }); toast(isNew ? '추가했습니다 (켜져 있으면 곧 keep-alive 가 띄웁니다)' : '저장했습니다'); back.remove(); reload(); }
    catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
}

async function managedEnsure(id, reload) {
  try { const r = await api('/api/ui/managed-sessions/' + encodeURIComponent(id) + '/ensure', { method: 'POST' }); toast('세션: ' + ((r && r.action) || 'ok') + (r && r.session_id ? ' (' + r.session_id + ')' : '')); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}
async function managedToggle(m, reload) {
  try { await api('/api/ui/managed-sessions', { method: 'POST', body: JSON.stringify({ id: m.id, enabled: !m.enabled }) }); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}
async function managedDelete(id, reload) {
  if (!confirm('상시 세션 등록 ‘' + id + '’을(를) 삭제할까요? (살아있는 터미널 세션은 별도로 종료)')) return;
  try { await api('/api/ui/managed-sessions/' + encodeURIComponent(id) + '/delete', { method: 'POST' }); toast('삭제했습니다'); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}

export {
  cronPanel,
  managedSessionsPanel,
};
