// admin-tools.ts — [AI 도구] 화면의 사내 API 도구 · 기본 제공 도구 패널 (#1313 R40, admin.ts 에서 verbatim 분리).
//  같은 화면의 세 번째 서브탭(외부 도구 서버 MCP)은 admin-mcp-servers.ts 가 소유한다 — 권한 축이 다르다
//  (여기 둘은 runtime, MCP 등록은 admin. 그래서 셸이 MIXED_SECTIONS 로 합집합 판정을 한다).
//  ⚠ CRED_KINDS 의 단일 거처는 admin-credentials.ts(#1313 R38)다 — 여기서 다시 선언하지 말고 받아 쓴다.
//  재렌더는 R37 의 rerenderPanel('tools-proxy') 레지스트리 경유(셸↔패널 순환 절단).
import { api, cardHead, el, state, toast, uiText } from './core.js';
import { field } from './ui-primitives.js';
import { loadAdmin, rerenderPanel } from './admin-rerender.js';
import { allowlistCard, mcpFieldsEl } from './admin-widgets.js';
import { CRED_KINDS } from './admin-credentials.js';

// ── AI 도구(MCP 툴) — runtime 권한 ──
function toolsEditor(detail, data) {
  const proxyTools = (data.tools || []).filter((t) => t.kind === 'http_proxy');
  const sel = state.admin.toolSel;
  const listCol = el('div', { class: 'admin-sublist' });
  listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ 도구 추가',
    onclick: () => { state.admin.toolSel = '__new__'; rerenderPanel(detail, 'tools-proxy', data); } }));
  if (!proxyTools.length) listCol.append(el('p', { class: 'admin-hint' }, ...uiText('아직 등록된 사내 API 도구가 없습니다 — [+ 도구 추가]로 첫 도구를 등록하세요.')));
  for (const t of proxyTools) {
    listCol.append(el('div', { class: 'mini-row' + (t.name === sel ? ' sel' : ''),
      onclick: () => { state.admin.toolSel = t.name; rerenderPanel(detail, 'tools-proxy', data); } },
      el('div', { class: 'mini-title', text: t.name },
        t.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null,
        t.auto_approve ? el('span', { class: 'pill pill-warn', text: '자동승인' }) : null),
      el('div', { class: 'mini-meta', text: (t.method || 'GET') + ' · ' + (t.scope || '-') })));
  }
  const right = el('div', {});
  const editing = sel === '__new__'
    ? { name: '', kind: 'http_proxy', enabled: true, auto_approve: false, title: '', description: '', scope: 'items', method: 'GET', url: '', auth_env: '', input_schema: '', note: '' }
    : proxyTools.find((t) => t.name === sel);
  if (editing) toolForm(right, editing, data, detail, sel === '__new__');
  // 빌트인 토글은 #837 에서 [기본 제공 도구] 서브탭으로 분리 — 여기서 또 그리면 같은 화면에 두 번 나온다.
  else right.append(
    el('p', { class: 'admin-hint' }, ...uiText('사내 API를 AI가 호출할 수 있는 도구로 등록합니다. 저장 즉시(재설치 없이) 구성원 AI가 쓸 수 있습니다. 호출은 아래 [외부 호출 안전범위]에 등록한 호스트로만 나가고, 인증은 환경변수 이름으로만 지정합니다.')));
  const pol = data.toolPolicy || { url_allowlist: [], allowed_auth_envs: [] };
  const toolsSafety = allowlistCard(data, '외부 호출 안전범위 (allowlist)',
    '사내 API 도구가 호출할 수 있는 외부 호스트 범위 — 이 목록 밖은 차단됩니다(SSRF 방어). 사내 API 도구를 안 쓰면 비워둬도 됩니다.',
    [
      { key: 'url_allowlist', label: '허용 호스트 (url_allowlist)', initial: pol.url_allowlist, placeholder: 'api.acme.com\n.internal.acme.com (앞에 . = 서브도메인)' },
      { key: 'allowed_auth_envs', label: '허용 인증 환경변수 이름 (allowed_auth_envs)', initial: pol.allowed_auth_envs, placeholder: 'ACME_API_TOKEN\n줄당 환경변수 이름(값 아님)' },
    ]);
  detail.replaceChildren(
    el('div', { class: 'card' }, cardHead('등록된 AI 도구'), el('div', { class: 'admin-two admin-two-cols' }, listCol, right)),
    toolsSafety);
}

function builtinToggles(data) {
  const byName = {}; for (const t of (data.tools || [])) if (t.kind === 'builtin') byName[t.name] = t;
  const wrap = el('div', { class: 'builtin-toggles' },
    el('div', { class: 'admin-subhead', text: '기본 제공 도구 (MCP 노출)' }),
    el('p', { class: 'admin-hint' }, ...uiText('게이트웨이 MCP 도구의 노출을 켜고 끕니다(저장 즉시 반영). 코드 기본값을 덮어쓰므로 「기본 미노출」 도구도 여기서 켤 수 있습니다. 자동승인을 켜면 구성원 AI가 이 도구를 실행할 때 매번 묻는 확인 없이 바로 실행합니다.')),
    el('p', { class: 'admin-hint' }, ...uiText('‘주입’: Claude Code가 이 도구를 세션 시작에 미리 로드할지(항상), 필요할 때 검색해 로드할지(deferred) 정합니다 — Claude Code 전용입니다(Codex는 모든 MCP 도구를 항상 미리 로드합니다).')));
  // 노출 정렬: 기본 노출 먼저, 기본 미노출(켤 수 있는 후보)을 아래로. 같은 그룹은 이름순.
  const cands = (data.builtins || []).map((c) => (typeof c === 'string' ? { name: c, title: '', defaultExposed: true } : c))
    .slice().sort((a, b) => (a.defaultExposed === b.defaultExposed ? a.name.localeCompare(b.name) : (a.defaultExposed ? -1 : 1)));
  for (const cand of cands) {
    const name = cand.name;
    const def = cand.defaultExposed !== false;       // 코드 기본값(expose.mcp)
    const override = byName[name];                    // org_tool builtin 행(있으면 운영자 재정의)
    const exposed = override ? override.enabled !== false : def;  // 최종 노출
    const enChk = el('input', { type: 'checkbox' }); enChk.checked = exposed;
    const aaChk = el('input', { type: 'checkbox' }); aaChk.checked = override ? !!override.auto_approve : false;
    // 주입모드(#187): 코드 기본값(defAlways) + 운영자 override(always_load). '' = 기본, 'always' = 항상, 'deferred' = 검색 시 로드. Claude Code 전용.
    const defAlways = cand.alwaysLoadDefault === true;
    const alSel = el('select', {},
      el('option', { value: '', text: '기본(' + (defAlways ? '항상' : 'deferred') + ')' }),
      el('option', { value: 'always', text: '항상 주입' }),
      el('option', { value: 'deferred', text: '검색 시 주입 (deferred)' }));
    alSel.value = (override && override.always_load != null) ? (override.always_load ? 'always' : 'deferred') : '';
    const save = async () => {
      try { const always_load = alSel.value === '' ? null : (alSel.value === 'always'); await api('/api/ui/org/tool', { method: 'POST', body: JSON.stringify({ name, kind: 'builtin', enabled: enChk.checked, auto_approve: aaChk.checked, always_load }) }); await loadAdmin(true); toast('저장됨'); }
      catch (e) { toast(e.message, true); }
    };
    enChk.addEventListener('change', save); aaChk.addEventListener('change', save); alSel.addEventListener('change', save);
    // MCP 상세 — 하네스가 보는 description + inputSchema(필드). 접힘 기본, 클릭 시 펼침.
    const detail = el('div', { style: 'display:none; margin:2px 0 8px 14px; padding:6px 10px; border-left:2px solid var(--border, #ddd)' },
      cand.description ? el('p', { class: 'admin-hint', style: 'white-space:pre-wrap; margin:0 0 6px' }, ...uiText(cand.description)) : null,
      el('div', { class: 'admin-subhead', text: '입력 필드 (MCP inputSchema)' }),
      mcpFieldsEl(cand.inputSchema));
    const expand = el('button', { class: 'btn btn-ghost btn-sm', text: 'MCP 상세 ▾',
      onclick: () => { const open = detail.style.display === 'none'; detail.style.display = open ? 'block' : 'none'; expand.textContent = open ? 'MCP 상세 ▴' : 'MCP 상세 ▾'; } });
    wrap.append(el('div', { class: 'builtin-row' },
      el('span', { class: 'builtin-name', text: name },
        cand.title ? el('span', { class: 'mini-meta', text: ' · ' + cand.title }) : null,
        !def ? el('span', { class: 'pill', text: '기본 미노출' }) : null,
        (override && exposed !== def) ? el('span', { class: 'pill pill-warn', text: '재정의' }) : null,
        (override && override.always_load != null && override.always_load !== defAlways) ? el('span', { class: 'pill pill-warn', text: '주입 재정의' }) : null),
      el('label', { class: 'admin-check' }, enChk, ' 노출'),
      el('label', { class: 'admin-check' }, aaChk, ' 자동승인'),
      el('label', { class: 'admin-check' }, '주입 ', alSel),
      expand), detail);
  }
  return wrap;
}

function toolForm(root, t, data, detail, isNew) {
  const policy = data.toolPolicy || { allowed_auth_envs: [], url_allowlist: [] };
  const nameIn = el('input', { type: 'text', value: t.name, placeholder: '도구 이름 (소문자/숫자/_-)', disabled: isNew ? null : '' });
  const titleIn = el('input', { type: 'text', value: t.title || '', placeholder: '표시 이름(선택)' });
  const descTa = el('textarea', { rows: '2', placeholder: 'AI에게 이 도구가 무엇인지 설명(AI가 언제 쓸지 판단)' }); descTa.value = t.description || '';
  const scopeSel = el('select', {}, ...['items', 'context', 'db', 'memory', 'code'].map((s) => el('option', { value: s, text: s })));
  scopeSel.value = t.scope || 'items';
  const methodSel = el('select', {}, ...['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => el('option', { value: m, text: m })));
  methodSel.value = t.method || 'GET';
  const urlIn = el('input', { type: 'text', value: t.url || '', placeholder: 'https://api.acme.com/v1/search' });
  // 등급(#746 P2) — 이 도구가 하는 일의 성격. L2(집행)는 자동승인에서 강제 제외돼 매번 하네스 확인.
  const levelSel = el('select', {},
    el('option', { value: 'L0', text: 'L0 · 조회 (읽기)' }),
    el('option', { value: 'L1', text: 'L1 · 제안 (MR·초안 만들기)' }),
    el('option', { value: 'L2', text: 'L2 · 집행 (외부발신·상태변경 — 매번 확인)' }));
  levelSel.value = t.level || 'L0';
  // ── 인증 방식(#746 P1) — 조직 공용(환경변수) vs 구성원 개인 자격(vault). 드롭다운으로 전환. ──
  const authEnvSel = policy.allowed_auth_envs.length
    ? el('select', {}, el('option', { value: '', text: '(선택)' }), ...policy.allowed_auth_envs.map((e) => el('option', { value: e, text: e })))
    : el('input', { type: 'text', placeholder: '아래 외부 호출 안전범위에 allowed_auth_envs 를 먼저 등록하세요', disabled: '' });
  if ((authEnvSel as any).tagName === 'SELECT') (authEnvSel as any).value = t.auth_env || '';
  const authKindSel = el('select', {}, ...CRED_KINDS.map((k) => el('option', { value: k.kind, text: k.label })));
  if (t.auth_kind) authKindSel.value = t.auth_kind;
  const authScopeIn = el('input', { type: 'text', value: t.auth_scope_key || '', placeholder: '대상 구분(선택 · 예 git 호스트)' });
  const initialMode = t.auth_kind ? 'kind' : (t.auth_env ? 'env' : 'none');
  const authModeSel = el('select', {},
    el('option', { value: 'none', text: '인증 없음 (공개 API)' }),
    el('option', { value: 'env', text: '조직 공용 (환경변수) — 전원 같은 자격' }),
    el('option', { value: 'kind', text: '구성원 개인 자격 (요청자별)' }));
  authModeSel.value = initialMode;
  const envField = field('공용 자격 (auth_env)', authEnvSel);
  const kindField = field('개인 자격 종류 (auth_kind)', el('div', {}, authKindSel,
    el('p', { class: 'admin-hint', style: 'margin:4px 0 0' }, ...uiText('L2(집행)면 개인 자격이 필수예요. L0/L1(읽기·제안)이면 개인 자격이 없을 때 「통합 자격」으로 대신 로그인해요. 구성원은 [내 설정 ▸ 외부 서비스 관리]에서 자기 로그인을 넣습니다.'))));
  const kindScopeField = field('개인 자격 대상(선택)', authScopeIn);
  const syncAuthMode = () => {
    const m = authModeSel.value;
    envField.style.display = m === 'env' ? '' : 'none';
    kindField.style.display = m === 'kind' ? '' : 'none';
    kindScopeField.style.display = m === 'kind' ? '' : 'none';
  };
  authModeSel.addEventListener('change', syncAuthMode); syncAuthMode();
  const schemaTa = el('textarea', { rows: '5', class: 'admin-ta', placeholder: '{ "type":"object", "properties": { "q": {"type":"string"} }, "required":["q"] }' });
  schemaTa.value = typeof t.input_schema === 'string' ? t.input_schema : (t.input_schema ? JSON.stringify(t.input_schema, null, 2) : '');
  const enChk = el('input', { type: 'checkbox' }); enChk.checked = t.enabled !== false;
  const aaChk = el('input', { type: 'checkbox' }); aaChk.checked = !!t.auto_approve;
  const piiChk = el('input', { type: 'checkbox' }); piiChk.checked = !!t.pii_scrub;
  const logArgsChk = el('input', { type: 'checkbox' }); logArgsChk.checked = !!t.log_args; // #1082 — 기본 꺼짐(인자 값 미저장)
  const hostHint = el('p', { class: 'admin-hint' }, ...uiText(policy.url_allowlist.length ? '허용 호스트: ' + policy.url_allowlist.join(', ') : '⚠ 허용 호스트가 없습니다 — 아래 「외부 호출 안전범위」의 url_allowlist 에 먼저 추가해야 호출됩니다.'));
  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    if (!nameIn.value.trim()) { toast('이름 필수', true); return; }
    let schema: any;
    if (schemaTa.value.trim()) { try { schema = JSON.parse(schemaTa.value); } catch { toast('입력 스키마가 올바른 JSON 이 아닙니다', true); return; } }
    saveBtn.disabled = true;
    try {
      const mode = authModeSel.value;
      const payload: any = {
        name: nameIn.value.trim(), kind: 'http_proxy', enabled: enChk.checked, auto_approve: aaChk.checked,
        title: titleIn.value.trim() || null, description: descTa.value.trim(), scope: scopeSel.value,
        method: methodSel.value, url: urlIn.value.trim(), input_schema: schema,
        level: levelSel.value, pii_scrub: piiChk.checked, log_args: logArgsChk.checked,
        // 인증 방식 — 배타(서버도 강제). env 모드면 auth_env, kind 모드면 auth_kind(+scope), none 이면 둘 다 비움.
        auth_env: mode === 'env' ? ((authEnvSel as any).value || '').trim() || null : null,
        auth_kind: mode === 'kind' ? authKindSel.value : null,
        auth_scope_key: mode === 'kind' ? (authScopeIn.value.trim() || null) : null,
      };
      await api('/api/ui/org/tool', { method: 'POST', body: JSON.stringify(payload) });
      await loadAdmin(true); state.admin.toolSel = payload.name; toast('저장됨 — 구성원 다음 대화부터 즉시'); rerenderPanel(detail, 'tools-proxy', state.admin.data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });
  const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
  if (!isNew) actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
    if (!confirm(`도구 '${t.name}' 제거? 구성원 AI 도구 목록에서 즉시 사라집니다.`)) return;
    try { await api('/api/ui/org/tool/remove', { method: 'POST', body: JSON.stringify({ name: t.name }) }); await loadAdmin(true); state.admin.toolSel = null; toast('제거됨'); rerenderPanel(detail, 'tools-proxy', state.admin.data); }
    catch (e) { toast(e.message, true); }
  } }));
  root.replaceChildren(
    field('이름', nameIn), field('표시 이름', titleIn), field('설명 (AI용)', descTa),
    field('권한 (이 도구를 쓸 수 있는 scope)', scopeSel),
    field('등급 (하는 일의 성격)', levelSel),
    field('HTTP 메서드', methodSel), field('URL (https)', urlIn), hostHint,
    field('인증 방식', authModeSel), envField, kindField, kindScopeField,
    el('label', { class: 'admin-check' }, piiChk, ' 응답에서 개인정보(PII) 자동 가리기'),
    el('label', { class: 'admin-check' }, logArgsChk, ' 호출 인자 값 기록(감사로그)'),
    el('p', { class: 'admin-hint' }, ...uiText('평소엔 꺼두세요. 이 도구로 보낸 내용이 감사로그에 그대로 남습니다. 꺼져 있어도 "누가·언제 이 도구를 썼는지"는 남습니다.')),
    field('입력 스키마 (JSON Schema, 선택)', schemaTa),
    el('label', { class: 'admin-check' }, enChk, ' 활성'),
    el('label', { class: 'admin-check' }, aaChk, ' 자동 승인 (구성원 확인 없이 실행 — 주의)'),
    actions);
}

export {
  toolsEditor,
  builtinToggles,
};
