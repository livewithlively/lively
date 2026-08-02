// admin-connectors.ts — [외부 자료 수집] 커넥터 패널 + 멤버 매핑 (#1313 R40, admin.ts 에서 verbatim 분리).
//  커넥터 = **패시브 미러**(외부 SaaS → 우리 DB). 외부 MCP 서버(admin-mcp-servers.ts)와 정반대 축이다.
//  ⚠ renderConnectorMemberPanel 의 postIdentities 가 서버와 맺은 **부분 페이로드 계약**을 그대로 옮겼다. 손대지 마라:
//   보내는 것은 { id, identities } **둘뿐**이다. display_name·email·scopes·body_md 는 **일부러 생략**한다 —
//   서버(org_member_upsert)가 undefined 를 '미변경'으로 읽어 보존하므로, 낡은 화면값으로 다른 필드를 덮어쓰는 사고를 막는다.
//   그리고 이 저장이 #697 소급 재해소 훅을 태워 매핑 이전에 raw 로 굳은 미러 데이터까지 되돌려 고친다 —
//   그래서 매핑은 반드시 이 엔드포인트를 통해야 한다(구성원 화면의 '외부 계정 연결'은 읽기 전용).
//  재렌더는 R37 의 rerenderPanel('connectors') 레지스트리 경유(셸↔패널 순환 절단).
import { api, cardHead, el, relTime, secretInput, secretRow, state, toast, uiText } from './core.js';
import { field, overlay } from './ui-primitives.js';
import { loadAdmin, rerenderPanel } from './admin-rerender.js';
import { sectionHead, sectionTitle } from './admin-widgets.js';

// ── 커넥터(외부 소스) — admin 전용 (프로젝트 #541 · #586 UX 개편). ──
//  #586: 활성화=자동 싱크(sync-<system> 크론 자동 등록/해제 — 스케줄러 별도 등록 불필요),
//  [지금 싱크]=비동기 run(connector_run 엔티티 — 로그·진행상황 폴링, 프록시 타임아웃 없음),
//  스코프 픽커([목록에서 선택] — discover API 로 노션 페이지/클릭업 리스트 조회), 토큰 발급 가이드.
function connectorEditor(detail, data) {
  const connectors = data.connectors || [];
  const sel = state.admin.connectorSel || (connectors[0] && connectors[0].system);
  const listCol = el('div', { class: 'admin-sublist' });
  for (const c of connectors) {
    const setCount = Object.values(c.secretsSet || {}).filter(Boolean).length;
    const secTotal = (c.fields || []).filter((f) => f.secret).length;
    listCol.append(el('div', { class: 'mini-row' + (c.system === sel ? ' sel' : ''),
      onclick: () => { state.admin.connectorSel = c.system; rerenderPanel(detail, 'connectors', data); } },
      el('div', { class: 'mini-title', text: c.label }, c.enabled ? el('span', { class: 'pill', text: '자동 싱크' }) : null),
      el('div', { class: 'mini-meta', text: secTotal ? `토큰 ${setCount}/${secTotal} 등록됨` : '토큰 불필요' })));
  }
  const right = el('div', {});
  const editing = connectors.find((c) => c.system === sel);
  if (editing) {
    connectorStatusCard(right, editing);
    connectorForm(right, editing, data, detail);
  } else right.append(el('p', { class: 'admin-hint' }, ...uiText('수집할 외부 소스를 선택하세요.')));
  // 사람 매핑 패널(#541 → #837 일반화) — 커넥터가 사용자 목록을 줄 수 있으면 붙인다.
  //  서버가 supported:false 로 답하면 패널이 스스로 사라진다(gmail·gdrive 는 개인 OAuth 라 '멤버' 개념이 없다).
  if (editing && editing.system && editing.system !== '__new__') {
    const panel = el('div', { class: 'card', style: 'margin-top:12px' });
    right.append(panel);
    void renderConnectorMemberPanel(panel, editing.system);
  }
  const banner = (editing && editing.secrets_enabled === false)
    ? el('div', { class: 'admin-hint' }, ...uiText('⚠ CONNECTOR_SECRET_KEY 미설정 — 토큰 암호화 저장이 비활성입니다. 게이트웨이 .env 에 CONNECTOR_SECRET_KEY(openssl rand -hex 32)를 설정하면 여기서 토큰을 저장할 수 있습니다(그 전엔 .env 폴백만 동작).'))
    : null;
  detail.replaceChildren(
    sectionHead('외부 자료 수집', '슬랙·노션·클릭업 같은 외부 도구의 자료를 주기적으로 가져옵니다.', data.meaning && data.meaning['connector']),
    el('div', { class: 'card' }, banner,
      cardHead('연결된 외부 도구'),
      el('div', { class: 'admin-two admin-two-cols' }, listCol, right)));
}

// 실행 상태 라벨/소요 — run 카드·기록·로그 공용.
function runStatusLabel(st) { return st === 'ok' ? '✅ 성공' : st === 'running' ? '⏳ 진행 중' : st === 'canceled' ? '⏹ 중지됨' : '❌ 실패'; }
function runDurLabel(a, b) {
  const s = Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`;
}

// 상태 카드(#586) — 자동 싱크 상태 + 최근 실행 + [지금 싱크]/[전체 다시 싱크]/[실행 기록].
function connectorStatusCard(root, c) {
  const dot = el('span', { class: c.enabled ? 'st ok' : 'st dim', text: c.enabled ? '자동 싱크 켬' : '자동 싱크 꺼짐' });
  const jobText = c.enabled
    ? (c.sync_job && c.sync_job.enabled
        ? ` · ${Math.max(1, Math.round((c.sync_job.interval_sec || 600) / 60))}분마다 자동 실행`
        : ' · 저장하면 자동 싱크가 등록됩니다')
    : ' · 켜고 저장하면 10분 주기 자동 싱크가 시작됩니다';
  const lastLine = el('div', { class: 'admin-hint' }, ...uiText('실행 이력 확인 중…'));
  const syncBtn = el('button', { class: 'btn btn-primary btn-sm', text: '지금 싱크',
    title: '백그라운드로 즉시 실행 — 로그 창이 열립니다', onclick: () => startSyncRun(c.system, false) });
  const fullBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '전체 다시 싱크',
    title: '커서를 무시하고 전체 재수집(삭제/보관 전파 포함) — 페이지 수에 비례해 오래 걸립니다',
    onclick: () => { if (confirm('전체를 다시 수집할까요? 원본 규모에 따라 몇 분~수십 분 걸립니다(백그라운드 실행).')) startSyncRun(c.system, true); } });
  const runsBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '실행 기록', onclick: () => openConnectorRuns(c) });
  root.append(el('div', { class: 'conn-status' },
    el('div', { class: 'conn-status-line' }, dot, el('span', { class: 'mini-meta' }, ...uiText(jobText))),
    lastLine,
    el('div', { class: 'admin-actions conn-status-actions' }, syncBtn, fullBtn, runsBtn)));
  (async () => {
    try {
      const r = await api('/api/ui/org/connector/runs?' + new URLSearchParams({ system: c.system, limit: '1' }));
      const run = (r.runs || [])[0];
      if (!run) { lastLine.replaceChildren(...uiText('아직 실행 이력이 없습니다 — 토큰 저장 후 [지금 싱크]로 시작하세요.')); return; }
      lastLine.replaceChildren(
        el('span', { text: `최근 실행: ${runStatusLabel(run.status)}${run.stale ? ' ⚠ 추적 끊김' : ''} · ${run.mode === 'full' ? '전체' : '증분'} · ${relTime(run.started_at)}` +
          (run.finished_at ? ` · ${runDurLabel(run.started_at, run.finished_at)}` : '') }),
        ' ',
        el('a', { href: '#', text: '로그 보기', onclick: (e) => { e.preventDefault(); openRunLog(c.system, run.id); } }));
    } catch (_) { lastLine.textContent = ''; }
  })();
}

// 비동기 싱크 시작(#586) — run_id 즉시 수신 → 로그 창(진행 폴링). 프록시 타임아웃과 무관.
async function startSyncRun(system, full) {
  try {
    const r = await api('/api/ui/org/connector/sync', { method: 'POST', body: JSON.stringify({ system, full: !!full }) });
    toast(r.already_running ? '이미 실행 중이라 그 실행의 로그를 엽니다' : '싱크를 시작했습니다(백그라운드)');
    openRunLog(system, r.run_id);
  } catch (e) { toast('싱크 시작 실패 — ' + e.message, true); }
}

// 실행 기록(#586) — 최근 20건. 행 클릭 = 로그.
async function openConnectorRuns(c) {
  const listBox = el('div', { class: 'run-list' }, el('p', { class: 'admin-hint' }, ...uiText('불러오는 중…')));
  overlay(`실행 기록 · ${c.label}`, listBox);
  try {
    const r = await api('/api/ui/org/connector/runs?' + new URLSearchParams({ system: c.system, limit: '20' }));
    const runs = r.runs || [];
    if (!runs.length) { listBox.replaceChildren(el('p', { class: 'admin-hint' }, ...uiText('실행 이력이 없습니다.'))); return; }
    listBox.replaceChildren(...runs.map((run) => el('div', { class: 'mini-row', onclick: () => openRunLog(c.system, run.id) },
      el('div', { class: 'mini-title', text: `${runStatusLabel(run.status)}${run.stale ? ' ⚠ 추적 끊김' : ''}  ${run.mode === 'full' ? '전체' : '증분'} · ${run.trigger === 'manual' ? '수동' : '자동'}` }),
      el('div', { class: 'mini-meta', text: `${relTime(run.started_at)}${run.finished_at ? ` · ${runDurLabel(run.started_at, run.finished_at)}` : ' · 진행 중'} · run #${run.id}` }))));
  } catch (e) { listBox.replaceChildren(el('p', { class: 'admin-hint', text: '로드 실패: ' + e.message })); }
}

// run 로그 뷰(#586) — 진행 중이면 2초 폴링으로 청크를 이어붙인다(창 닫으면 중단).
async function openRunLog(system, runId) {
  const status = el('div', { class: 'admin-hint' }, ...uiText('불러오는 중…'));
  const cancelBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '⏹ 중지', style: 'display:none', onclick: async () => {
    if (!confirm('이 실행을 중지할까요? 커서가 전진하지 않아 데이터 손실은 없고, 다음 실행이 이어서 재수집합니다.')) return;
    try { const r = await api(`/api/ui/org/connector/runs/${runId}/cancel`, { method: 'POST', body: '{}' }); toast(r.message || (r.ok === false ? '중지 실패' : '중지 요청됨'), r.ok === false); }
    catch (e) { toast('중지 실패 — ' + e.message, true); }
  } });
  const head = el('div', { class: 'run-log-head' }, status, cancelBtn);
  const pre = el('pre', { class: 'run-log' });
  const back = overlay(`싱크 로그 · ${system} · run #${runId}`, head, pre);
  let offset = 0;
  let timer: any = null;
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  const tick = async () => {
    if (!document.body.contains(back)) { stop(); return; } // 창 닫힘 → 폴링 중단
    try {
      let r;
      // 드레인 루프 — 완료된 긴 로그(청크 64KB 초과)도 한 tick 에 끝까지 이어붙인다(가드 100청크 ≈ 6.5MB).
      for (let i = 0; i < 100; i++) {
        r = await api(`/api/ui/org/connector/runs/${runId}?offset=${offset}`);
        const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
        if (r.skipped > 0) pre.append(document.createTextNode(`\n[…앞부분 ${r.skipped.toLocaleString()}자 잘림(로그 캡)…]\n`));
        if (r.log_chunk) pre.append(document.createTextNode(r.log_chunk));
        if (r.next_offset != null) offset = r.next_offset;
        if (atBottom) pre.scrollTop = pre.scrollHeight;
        if (offset >= (r.log_size ?? 0)) break;
      }
      status.textContent = `${runStatusLabel(r.status)} · ${r.mode === 'full' ? '전체' : '증분'} · 시작 ${relTime(r.started_at)}`
        + (r.finished_at ? ` · 소요 ${runDurLabel(r.started_at, r.finished_at)}` : r.stale
          ? ' · ⚠ 추적 끊김(게이트웨이 재시작 추정) — 곧 자동 정리되며, 재시작 직후라면 새로 싱크를 시작하세요'
          : ' · 진행 중 — 자동 갱신');
      cancelBtn.style.display = r.status === 'running' ? '' : 'none';
      if (r.status !== 'running') stop();
    } catch (e) { status.textContent = '로그 로드 실패: ' + e.message; stop(); }
  };
  await tick();
  if (!timer) timer = setInterval(tick, 2000);
}

// 스코프 픽커(#586) — 저장된 토큰으로 소스의 선택지(discover)를 조회해 체크박스로 고른다. id 복붙 제거.
async function openScopePicker(c, f, inp) {
  const box = el('div', {}, el('p', { class: 'admin-hint', text: `${c.label}에서 목록을 조회하는 중…` }));
  const back = overlay(`${f.label || f.key} — 목록에서 선택`, box);
  try {
    const r = await api('/api/ui/org/connector/discover', { method: 'POST', body: JSON.stringify({ system: c.system }) });
    const opts = (r.fields && r.fields[f.key]) || [];
    if (!opts.length) { box.replaceChildren(el('p', { class: 'admin-hint' }, ...uiText(r.note || '고를 항목이 없습니다 — 값을 직접 입력하세요.'))); return; }
    const multi = f.key !== 'container_list_id'; // 컨테이너는 1개(라디오)
    // 기존 입력값(URL/슬러그/id 혼재 가능)과 옵션 id 매칭 — 끝 32hex 정규화 비교(노션), 그 외 원문 비교.
    const normId = (v) => { const h = String(v).toLowerCase().replace(/[^0-9a-f]/g, ''); return h.length >= 32 ? h.slice(-32) : String(v).trim(); };
    const selected = new Set(String(inp.value || '').split(',').map((x) => normId(x)).filter(Boolean));
    const checks = new Map();
    const rows = opts.map((o) => {
      const cb = el('input', { type: multi ? 'checkbox' : 'radio', name: 'conn-scope-pick' });
      cb.checked = selected.has(normId(o.id));
      checks.set(o.id, cb);
      const icon = o.kind === 'database' ? '🗄' : o.kind === 'root_page' ? '📄' : o.kind === 'list' ? '📋' : '·';
      return el('label', { class: 'conn-pick-item' }, cb,
        el('span', { class: 'conn-pick-label', text: `${icon} ${o.label}` }),
        el('span', { class: 'mini-meta mono', text: String(o.id).slice(0, 10) + '…' }));
    });
    const apply = el('button', { class: 'btn btn-primary btn-sm', text: '적용', onclick: () => {
      const ids = [...checks.entries()].filter(([, cb]) => cb.checked).map(([id]) => id);
      inp.value = ids.join(',');
      back.remove();
      toast(ids.length ? `${ids.length}개 선택됨 — [저장]을 눌러야 반영됩니다` : '선택을 비웠습니다 — [저장]을 눌러야 반영됩니다');
    } });
    box.replaceChildren(
      r.note ? el('p', { class: 'admin-hint' }, ...uiText(r.note)) : null,
      el('div', { class: 'conn-pick-list' }, ...rows),
      el('div', { class: 'admin-actions' }, apply));
  } catch (e) { box.replaceChildren(el('p', { class: 'admin-hint', text: '조회 실패: ' + e.message })); }
}

function connectorForm(root, c, data, detail) {
  const inputs: Record<string, { el: any; secret: boolean }> = {}; // key → { el, secret }
  const fieldEls: any[] = [];
  for (const f of (c.fields || [])) {
    let inp;
    if (f.secret) {
      const isSet = c.secretsSet && c.secretsSet[f.key];
      // 커넥터 토큰은 이 사이트 계정의 비밀번호가 아니다 — type=password 금지(#1250). 가림은 CSS로.
      inp = secretInput({ value: '', placeholder: isSet ? '● 설정됨 — 변경할 때만 입력' : (f.hint || '미설정') });
    } else {
      inp = el('input', { type: 'text', value: (c.config && c.config[f.key]) || '', placeholder: f.hint || '' });
    }
    inputs[f.key] = { el: inp, secret: !!f.secret };
    const lbl = (f.label || f.key) + (f.required ? ' *' : '') + (f.secret ? ' 🔒' : '');
    // 스코프 픽커(#586) — picker 지정 필드는 입력 옆 [목록에서 선택].
    const ctrl = f.picker
      ? el('div', { class: 'conn-pick-row' }, inp,
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '목록에서 선택',
            title: '저장된 토큰으로 소스에서 목록을 조회해 고릅니다', onclick: () => openScopePicker(c, f, inp) }))
      : (f.secret ? secretRow(inp) : inp);
    fieldEls.push(field(lbl, ctrl));
  }
  // 토큰 발급 가이드(#586) — 접이식(처음 설정하는 사람 기준 단계별).
  let guideEl: any = null;
  if (c.guide && (c.guide.steps || []).length) {
    guideEl = el('details', { class: 'conn-guide', ...(Object.values(c.secretsSet || {}).some(Boolean) ? {} : { open: '' }) },
      el('summary', { text: `🔑 ${c.label} 토큰 발급 방법` }));
    if (c.guide.intro) guideEl.append(el('p', { class: 'admin-hint' }, ...uiText(c.guide.intro)));
    const ol = el('ol', { class: 'conn-guide-steps' });
    for (const st of (c.guide.steps || [])) ol.append(el('li', { text: st }));
    guideEl.append(ol);
    if (c.guide.url) guideEl.append(el('p', { class: 'conn-guide-link' },
      el('a', { href: c.guide.url, target: '_blank', rel: 'noopener noreferrer', text: '발급 페이지 열기 ↗' })));
  }
  const enChk = el('input', { type: 'checkbox' }); enChk.checked = !!c.enabled;
  const noteIn = el('input', { type: 'text', value: c.note || '', placeholder: '선택 사항 — 이 커넥터에 대한 운영 메모' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const config: Record<string, string> = {}, secrets: Record<string, string> = {};
      for (const k of Object.keys(inputs)) {
        const { el: inp, secret } = inputs[k];
        const v = inp.value;
        if (secret) { if (v) secrets[k] = v; } // 빈=미변경(기존 암호문 유지)
        else config[k] = (v || '').trim();
      }
      const payload = { system: c.system, enabled: enChk.checked, config, secrets, note: noteIn.value.trim() || null };
      await api('/api/ui/org/connector', { method: 'POST', body: JSON.stringify(payload) });
      await loadAdmin(true); state.admin.connectorSel = c.system;
      toast(enChk.checked ? '저장됨 — 자동 싱크 등록(10분 주기). [지금 싱크]로 바로 시작할 수 있어요' : '저장됨 — 자동 싱크 꺼짐');
      rerenderPanel(detail, 'connectors', state.admin.data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });
  const actions = el('div', { class: 'admin-actions' }, saveBtn);
  actions.append(el('button', { class: 'btn-text', text: '설정·토큰 삭제(.env 값 사용)', onclick: async () => {
    if (!confirm(`${c.label} 설정·토큰을 제거하고 .env 폴백으로 되돌릴까요?`)) return;
    try { await api('/api/ui/org/connector/remove', { method: 'POST', body: JSON.stringify({ system: c.system }) }); await loadAdmin(true); toast('초기화됨'); rerenderPanel(detail, 'connectors', state.admin.data); }
    catch (e) { toast(e.message, true); }
  } }));
  root.append(
    guideEl,
    el('label', { class: 'admin-check' }, enChk, ' 싱크 활성 — 저장하면 10분 주기 자동 싱크가 등록됩니다'),
    ...fieldEls,
    field('메모', noteIn),
    el('p', { class: 'admin-hint' }, ...uiText('🔒 토큰은 게이트웨이 키로 암호화되어 저장됩니다. 값을 비워두면 기존 토큰이 유지됩니다.')),
    actions);
}

// ── ClickUp 멤버 매핑(#541) — ClickUp 팀 멤버 ↔ 구성원(org_member) 연결 패널. ──
//  어사이니 해소는 person_identity(system='clickup') → org_member 로 이뤄지고, 수동 매핑의 SoT 는
//  org_member.identities(JSONB) — 저장/해제는 POST /api/ui/org/member(identities 병합) 재사용(서버가
//  person_identity 로 즉시 동기). 매핑 상태는 GET /api/ui/org/connector/clickup/members 가 계산해 준다.
// ── 사람 매핑(#541 clickup → #837 커넥터 일반) ──────────────────────────────────
//  **편집 SoT 는 여기다**(구성원 화면이 아니라). 매핑은 "외부 시스템의 사람 ↔ 우리 구성원"인데,
//  구성원 화면은 외부 목록을 안 가져오므로 관리자가 외부 id 를 손으로 타이핑해야 했다 —
//  ClickUp 숫자 id 를 어디서 찾는지도 모르고, 시스템명 오타는 조용히 매칭 실패로 끝난다.
//  여기선 커넥터가 실제 사용자 목록을 주므로 드롭다운으로 고르기만 하면 된다(오타 불가).
//  → 구성원 화면의 '외부 계정 연결'은 읽기 전용 + 이리로 오는 링크가 됐다(#837).
async function renderConnectorMemberPanel(panel, system) {
  const spec = (state.admin.data && (state.admin.data.connectors || []).find((c) => c.system === system)) || {};
  const label = spec.label || system;
  panel.replaceChildren(el('p', { class: 'admin-hint', text: label + ' 사용자 불러오는 중…' }));
  let res;
  try { res = await api('/api/ui/org/connector/' + encodeURIComponent(system) + '/members'); }
  catch (e) { panel.replaceChildren(el('p', { class: 'admin-hint', text: label + ' 사용자 로드 실패: ' + e.message })); return; }

  // 이 커넥터는 사람 매핑을 지원하지 않는다(gmail·gdrive 등) — 패널을 아예 안 그린다.
  if (res.supported === false) { panel.remove(); return; }

  const head = sectionTitle('멤버 매핑 · ' + label,
    label + ' 사용자를 조직 구성원과 연결합니다 — 연결하면 다음 싱크부터 작성자·담당자가 해당 구성원으로 매칭됩니다. 이메일이 같으면 자동매치 후보가 미리 선택됩니다. **매핑 편집은 이 화면에서 합니다** — 구성원 화면에서는 결과만 표시됩니다.');
  if (res.error) { panel.replaceChildren(head, el('p', { class: 'admin-hint', text: '⚠ ' + res.error })); return; }
  const users = res.users || [];
  if (!users.length) { panel.replaceChildren(head, el('p', { class: 'admin-hint', text: label + ' 사용자가 없습니다.' })); return; }

  const members = (state.admin.data && state.admin.data.members) || [];
  const activeMembers = members.filter((m) => (m.state || 'active') === 'active');
  const nameOf = (id) => { const m = members.find((x) => x.id === id); return m ? (m.display_name || m.id) : id; };

  // 저장/해제 — 대상 구성원의 identities 에 이 시스템 신원을 병합(add)/제거(remove) 후 **부분 페이로드**
  //  { id, identities } 로 POST(다른 필드는 서버가 보존 — 낡은 화면값으로 덮어쓰기 방지).
  //  ⚠ 이 저장이 #697 의 소급 재해소 훅(delivery.org_member_upsert)을 태운다 — 매핑 이전에 raw 로 굳은
  //    미러 데이터까지 되돌려 고쳐 준다. 그래서 매핑은 반드시 이 엔드포인트를 통해야 한다.
  const postIdentities = async (memberId, u, add) => {
    const m = members.find((x) => x.id === memberId);
    if (!m) throw new Error('구성원을 찾을 수 없습니다 — 새로고침 후 다시 시도하세요');
    const emailLower = (u.email || '').trim().toLowerCase();
    const isThis = (idn) => idn.system === system
      && (idn.external_id === String(u.id) || (!!emailLower && (idn.external_id || '').toLowerCase() === emailLower));
    const identities = (m.identities || []).filter((idn) => !isThis(idn));
    if (add) {
      identities.push({ system, external_id: String(u.id), email: u.email || undefined, instance: u.instance || res.instance || undefined });
    } else if (identities.length === (m.identities || []).length) {
      // 구성원 identities 밖에서 온 신원(게이트웨이 바인딩 파일 등) — 여기선 해제 불가.
      throw new Error('이 연결은 구성원의 외부 계정 목록 밖에서 온 신원이라 여기서 해제할 수 없어요');
    }
    await api('/api/ui/org/member', { method: 'POST', body: JSON.stringify({ id: m.id, identities }) });
    await loadAdmin(true); // members(identities) 최신화 — 패널 재조회 전 로컬 데이터 동기
  };

  const tbl = el('table', { class: 'fields-table cu-map-table' });
  tbl.append(el('tr', {}, el('th', { text: label + ' 사용자' }), el('th', { text: '연결된 구성원' }), el('th', {})));
  for (const r of users) {
    const u = r.user || {};
    // 아바타 — 외부 색은 검증된 hex 일 때만 style 로(외부 데이터 CSS 주입 방지), 이니셜은 textContent.
    const dot = el('span', { class: 'cu-avatar', text: (u.initials || String(u.name || u.id || '?').slice(0, 2)).toUpperCase() });
    if (/^#[0-9a-fA-F]{3,8}$/.test(u.color || '')) { dot.style.background = u.color; dot.style.color = '#fff'; }
    const userCell = el('td', { class: u.inactive ? 'cu-inactive' : '' }, el('div', { class: 'cu-user' }, dot,
      el('div', {},
        el('div', { class: 'mini-title' }, el('span', { text: u.name || ('id ' + u.id) }),
          u.inactive ? el('span', { class: 'pill', text: '비활성' }) : null),
        el('div', { class: 'mini-meta', text: u.email || ('id ' + u.id) }))));
    if (r.mapped_via === 'identity') {
      const unlink = el('button', { class: 'btn-text', text: '해제' });
      unlink.addEventListener('click', async () => {
        if (!confirm(`'${u.name || u.id}' ↔ '${nameOf(r.mapped_member_id)}' 연결을 해제할까요?`)) return;
        unlink.disabled = true;
        try { await postIdentities(r.mapped_member_id, u, false); toast('연결 해제됨 — 다음 싱크부터 반영'); void renderConnectorMemberPanel(panel, system); }
        catch (e) { toast(e.message, true); unlink.disabled = false; }
      });
      tbl.append(el('tr', {}, userCell,
        el('td', {}, el('span', { class: 'pill pill-ok', text: '연결됨' }), ' ', nameOf(r.mapped_member_id)),
        el('td', {}, unlink)));
    } else {
      const selBox = el('select', { class: 'cu-map-sel' }, el('option', { value: '', text: '구성원 선택…' }),
        ...activeMembers.map((m) => el('option', { value: m.id, text: (m.display_name || m.id) + (m.email ? ' (' + m.email + ')' : '') })));
      if (r.suggested_member_id) selBox.value = r.suggested_member_id;
      const saveB = el('button', { class: 'btn btn-ghost btn-sm', text: '연결' });
      saveB.addEventListener('click', async () => {
        if (!selBox.value) { toast('연결할 구성원을 선택하세요', true); return; }
        saveB.disabled = true;
        try { await postIdentities(selBox.value, u, true); toast('연결됨 — 다음 싱크부터 반영'); void renderConnectorMemberPanel(panel, system); }
        catch (e) { toast(e.message, true); saveB.disabled = false; }
      });
      tbl.append(el('tr', {}, userCell,
        el('td', {}, r.mapped_via === 'email' ? el('span', { class: 'pill', text: '이메일 자동매치' }) : null, ' ', selBox),
        el('td', {}, saveB)));
    }
  }
  panel.replaceChildren(head, tbl);
}

export {
  connectorEditor,
  renderConnectorMemberPanel,
};
