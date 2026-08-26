// admin-mcp-servers.ts — [AI 도구 ▸ 외부 도구 서버(MCP)] 패널 (#1313 R40, admin.ts 에서 verbatim 분리).
//  여기서 다루는 'MCP 서버'는 **액티브 프록시**다 — AI 가 그때그때 호출하는 외부 서버(org_mcp_server).
//  외부 자료를 우리 DB 로 당겨오는 **패시브 미러**(커넥터 · admin-connectors.ts)와 반대 축이니 헷갈리지 말 것.
//  ⚠ 유일한 구조 변경: mcpForm 안에 100줄 넘게 인라인돼 있던 **프리셋 위저드**를 mcpPresetField 로 뺐다.
//   클로저로 잡던 입력칸·동기화 함수를 인자 하나(f)로 넘겨받게 했을 뿐, 채우는 필드·순서·문구·조건은 그대로다.
//  재렌더는 셸 역호출이 아니라 R37 의 rerenderPanel('mcp') 레지스트리를 경유한다(셸↔패널 순환 절단).
import { api, cardHead, el, secretInput, secretRow, state, toast, uiText } from './core.js';
import { field } from './ui-primitives.js';
import { loadAdmin, rerenderPanel } from './admin-rerender.js';
import { allowlistCard } from './admin-widgets.js';

function mcpEditor(detail, data) {
  const servers = data.mcpServers || [];
  const sel = state.admin.mcpSel;
  const listCol = el('div', { class: 'admin-sublist' });
  listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ MCP 서버 추가',
    onclick: () => { state.admin.mcpSel = '__new__'; rerenderPanel(detail, 'mcp', data); } }));
  for (const s of servers) {
    listCol.append(el('div', { class: 'mini-row' + (s.name === sel ? ' sel' : ''),
      onclick: () => { state.admin.mcpSel = s.name; rerenderPanel(detail, 'mcp', data); } },
      el('div', { class: 'mini-title', text: s.name }, s.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null),
      el('div', { class: 'mini-meta', text: (s.transport || 'http') + ' · ' + (s.transport === 'stdio' ? (s.command || '-') : (s.url || '-')) })));
  }
  const right = el('div', {});
  const editing = sel === '__new__' ? { name: '', transport: 'http', url: '', command: '', auth_env: '', note: '', enabled: true } : servers.find((s) => s.name === sel);
  if (editing) mcpForm(right, editing, data, detail, sel === '__new__');
  else right.append(el('p', { class: 'admin-hint' }, ...uiText('lively 게이트웨이는 기본으로 등록되어 있습니다. 추가로 쓸 외부 도구 서버(MCP)를 여기서 등록합니다. 인증은 환경변수 이름만 적습니다(시크릿 값 입력 금지).')));
  // 내부 MCP 안전범위(#837) — `allowed_internal_hosts` 는 서버·스키마·감사까지 다 있는데 **편집 UI 만 없었다.**
  //  runtime_config 1행을 5개 화면이 나눠 쓰는데 아무도 그 행 전체를 소유하지 않아 필드 하나가 통째로 샜다.
  //  증상: 내부 MCP 를 등록하면 SSRF 가드에 조용히 막히고, 에러가 "allowed_internal_hosts 등록 필요" 라며
  //  **관리탭에서 도달할 수 없는 필드 이름**을 댔다. 등록하다 막히는 바로 이 화면에 둔다.
  const rcMcp = data.runtimeConfig || { allowed_internal_hosts: [] };
  const mcpSafety = allowlistCard(data, '내부 접속 안전범위 (allowlist)',
    '사설·localhost 주소로 나가는 접속은 기본 전면 차단입니다(SSRF 방어). 여기 등록한 호스트만 통과합니다 — ①내부 MCP 서버 ②OAuth 브로커 ③내부 경보 웹훅 셋에 공통 적용됩니다. 외부 공인 주소(https)는 등록할 필요가 없습니다.',
    [
      { key: 'allowed_internal_hosts', label: '허용 내부 호스트 (allowed_internal_hosts)', initial: rcMcp.allowed_internal_hosts,
        placeholder: 'localhost\nmcp.internal.acme.com\n줄당 호스트 한 개(포트·경로 없이)' },
    ]);
  detail.replaceChildren(el('div', { class: 'card' },
    cardHead('등록된 외부 도구 서버', '하네스가 호출할 수 있는 외부 MCP 서버입니다. 자료를 우리 DB 로 가져오는 [외부 자료 수집]과 반대로, 여기 등록된 서버는 세션에서 그때그때 호출됩니다.'),
    el('div', { class: 'admin-two admin-two-cols' }, listCol, right)),
    mcpSafety);
}

// 프록시 자격 종류 힌트(datalist) — 오타 방지용 제안. 신규 커넥터가 확장 가능(자유입력 허용).
const MCP_AUTH_KINDS = ['notion_oauth', 'slack_oauth', 'google_oauth', 'gitlab_pat', 'slack_user_token', 'notion_token', 'clickup_token', 'prometheus_bearer', 'figma_token'];

function mcpForm(root, s, data, detail, isNew) {
  const nameIn = el('input', { type: 'text', value: s.name, placeholder: '서버 이름(영문/숫자)', disabled: isNew ? null : '' });
  const transSel = el('select', {}, ...['http', 'stdio'].map((t) => el('option', { value: t, text: t })));
  transSel.value = s.transport || 'http';
  const urlIn = el('input', { type: 'text', value: s.url || '', placeholder: 'https://host/mcp' });
  const cmdIn = el('input', { type: 'text', value: s.command || '', placeholder: 'node /path/server.mjs --arg' });
  const authIn = el('input', { type: 'text', value: s.auth_env || '', placeholder: '예: ACME_TOKEN (값 아님)' });
  const noteIn = el('input', { type: 'text', value: s.note || '', placeholder: '설명(선택)' });
  const enChk = el('input', { type: 'checkbox' }); enChk.checked = s.enabled !== false;
  const urlField = field('URL (http)', urlIn);
  const cmdField = field('command (stdio)', cmdIn);

  // ── 방식(mode) — client(멤버 클라 직접등록, 통제 없음) / proxy(게이트웨이가 대신 호출·통제·재노출, #746) ──
  const modeSel = el('select', {},
    el('option', { value: 'client', text: 'client — 멤버 클라에 직접 등록(게이트웨이 통제 없음)' }),
    el('option', { value: 'proxy', text: 'proxy — 게이트웨이가 대신 호출(권한·PII·감사 통제)' }));
  modeSel.value = s.mode || 'client';
  const scopeSel = el('select', {}, ...['items', 'context', 'db', 'memory', 'code'].map((v) => el('option', { value: v, text: v })));
  scopeSel.value = s.scope || 'items';
  const levelSel = el('select', {},
    el('option', { value: 'L0', text: 'L0 — 조회(read)' }),
    el('option', { value: 'L1', text: 'L1 — 제안(MR·draft)' }),
    el('option', { value: 'L2', text: 'L2 — 집행(개인 자격 필수)' }));
  levelSel.value = s.level || 'L0';
  const authModeSel = el('select', {},
    el('option', { value: 'bearer', text: 'bearer — 정적 토큰(vault 저장)' }),
    el('option', { value: 'oauth', text: 'oauth — 구성원별 OAuth 연결' }),
    el('option', { value: 'sigv4', text: 'sigv4 — AWS 요청서명(역할 assume)' }));
  authModeSel.value = s.auth_mode || 'bearer';
  const kindsListId = 'mcp-auth-kinds';
  const kindsList = el('datalist', { id: kindsListId }, ...MCP_AUTH_KINDS.map((k) => el('option', { value: k })));
  const authKindIn = el('input', { type: 'text', value: s.auth_kind || '', placeholder: '예: notion_oauth', list: kindsListId });
  const authScopeIn = el('input', { type: 'text', value: s.auth_scope_key || '', placeholder: '대상 구분(선택 · 예 워크스페이스)' });
  const piiChk = el('input', { type: 'checkbox' }); piiChk.checked = !!s.pii_scrub;
  // #1082 — 호출 인자 값 저장. 기본 꺼짐(값 미저장): 프록시 인자에는 조직 밖으로 나가는 본문(슬랙 DM·메일)이 실린다.
  const logArgsChk = el('input', { type: 'checkbox' }); logArgsChk.checked = !!s.log_args;

  // 발행/새로고침 — 상류 tools/list 캡처(핀). 저장된 proxy 서버만.
  const snapN = (s.tools_snapshot && s.tools_snapshot.length) || 0;
  const snapInfo = el('div', { class: 'caption', text: snapN
    ? `발행됨 · 툴 ${snapN}개${s.snapshot_at ? ' · ' + String(s.snapshot_at).slice(0, 16).replace('T', ' ') : ''}`
    : '미발행 — 발행하면 상류 tools/list 를 캡처해 다음 세션부터 구성원에게 노출됩니다.' });
  const refreshBtn = el('button', { class: 'btn btn-ghost btn-sm', text: snapN ? '새로고침(상류 툴 재캡처)' : '발행(상류 툴 캡처)' });
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try { const r = await api('/api/ui/org/mcp-server/refresh', { method: 'POST', body: JSON.stringify({ name: s.name }) }); toast(`발행됨 — 툴 ${r.tool_count}개`); await loadAdmin(true); rerenderPanel(detail, 'mcp', state.admin.data); }
    catch (e) { toast(e.message, true); refreshBtn.disabled = false; }
  });
  const oauthHint = el('div', { class: 'admin-hint' }, ...uiText('OAuth: 구성원이 각자 [자격] 화면(또는 me_oauth_connect)에서 [연결]로 브라우저 인증합니다. 게이트웨이가 토큰을 구성원별로 보관·자동 갱신합니다.'));
  const sigv4Hint = el('div', { class: 'admin-hint' }, ...uiText('AWS(sigv4): 자격 종류는 aws_role_arn 으로 두세요. 실제 역할(role ARN·리전·service)과 구성원별 오버라이드는 [자격] 탭 ▸ "AWS 역할"에서 등록·할당합니다. 툴 등급은 자동(describe=조회 / put·delete=집행 컨펌).'));
  // OAuth 클라이언트(선택) — 상류가 자동등록(DCR)을 지원하면 비워둠(게이트웨이가 자동 등록). Google·Slack 등 콘솔 앱은 사전등록 client 를 입력.
  //  저장 시 (gateway,auth_kind,'oauth:client') 슬롯에 시딩 → SDK 가 client_secret 유무로 confidential/public 자동 판정. 비우면 기존 유지.
  const oauthClientIdIn = el('input', { type: 'text', value: '', placeholder: '비우면 자동등록(DCR). Google·Slack 등은 콘솔 client_id 입력' });
  // client_secret 은 상류 앱의 시크릿이지 이 사이트 계정의 비밀번호가 아니다 — type=password 로 두면 크롬이
  //  이 폼을 로그인 폼으로 오인해 바로 위 client_id 칸에 저장된 이메일을 채운다(#1250). 텍스트칸+CSS 가림으로.
  const oauthClientSecretIn = secretInput({ placeholder: 'confidential 앱이면 client_secret (변경할 때만 입력)' });
  const oauthCallback = ((data && data.profile && data.profile.gateway_url) || location.origin).replace(/\/mcp$/, '').replace(/\/$/, '') + '/oauth/callback';
  const oauthClientBox = el('div', { class: 'admin-subcard', style: 'margin-top:8px' },
    el('div', { class: 'admin-subhead', text: 'OAuth 클라이언트 (선택 — 자동등록 미지원 상류만)' }),
    el('div', { class: 'admin-hint' }, ...uiText('상류 MCP 가 동적 클라이언트 등록(DCR)을 지원하면 비워두세요 — 게이트웨이가 자동 등록합니다. Google·Slack처럼 콘솔에서 앱을 미리 만들어야 하는 상류만 그 client_id/secret 을 입력하고, 콘솔의 redirect URI 에 아래 콜백을 등록하세요. (설정/변경 시 client_id 를 입력 — 비우면 기존 유지)')),
    field('client_id', oauthClientIdIn),
    field('client_secret', secretRow(oauthClientSecretIn)),
    el('div', { class: 'admin-hint', text: `redirect URI(콜백): ${oauthCallback}  — 이 값을 상류 콘솔(Google/Slack 등)의 허용 redirect URI 에 그대로 등록하세요.` }));
  const authEnvField = field('인증 환경변수 이름 (auth_env)', authIn);
  const proxyBox = el('div', { class: 'admin-subcard' },
    el('div', { class: 'admin-subhead', text: '프록시 통제(#746)' }),
    field('접근 권한 scope', scopeSel),
    field('권한 등급(기본 · 툴별 자동분류)', levelSel),
    field('인증 방식', authModeSel),
    field('자격 종류 (auth_kind)', el('div', {}, authKindIn, kindsList)),
    field('자격 대상 구분 (선택)', authScopeIn),
    el('label', { class: 'admin-check' }, piiChk, ' 응답 PII 마스킹(비정형 텍스트)'),
    el('label', { class: 'admin-check' }, logArgsChk, ' 호출 인자 값 기록(감사로그)'),
    el('div', { class: 'admin-hint' }, ...uiText('평소엔 꺼두세요. 이 서버로 보낸 내용(메시지 본문·메일 내용 등)이 감사로그에 그대로 남습니다 — 비밀 채널이나 DM 이면 그 내용까지 관리자에게 보입니다. 꺼져 있어도 "누가·언제·어떤 도구를 썼는지"는 남으니 감사에는 지장이 없습니다. 켤 만한 경우: 개인 통신이 오가지 않는 내부 전용 서버라 인자를 봐야 디버깅이 되는 때.')),
    oauthHint, oauthClientBox, sigv4Hint,
    isNew ? el('div', { class: 'caption' }, ...uiText('저장 후 [발행]으로 상류 툴을 캡처하세요.')) : el('div', { class: 'admin-actions' }, refreshBtn, snapInfo));

  const syncTransport = () => { urlField.style.display = transSel.value === 'http' ? '' : 'none'; cmdField.style.display = transSel.value === 'stdio' ? '' : 'none'; };
  const syncMode = () => {
    const proxy = modeSel.value === 'proxy';
    proxyBox.style.display = proxy ? '' : 'none';
    // proxy 는 auth_kind(vault)로 인증 → auth_env(client 전용) 숨김. oauth 면 auth_kind 는 vault kind(토큰 슬롯).
    authEnvField.style.display = proxy ? 'none' : '';
    oauthHint.style.display = proxy && authModeSel.value === 'oauth' ? '' : 'none';
    oauthClientBox.style.display = proxy && authModeSel.value === 'oauth' ? '' : 'none';
    sigv4Hint.style.display = proxy && authModeSel.value === 'sigv4' ? '' : 'none';
    if (proxy && authModeSel.value === 'sigv4' && !authKindIn.value.trim()) authKindIn.value = 'aws_role_arn';
  };
  transSel.addEventListener('change', syncTransport);
  modeSel.addEventListener('change', syncMode);
  authModeSel.addEventListener('change', syncMode);

  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    if (!nameIn.value.trim()) { toast('이름 필수', true); return; }
    saveBtn.disabled = true;
    try {
      const http = transSel.value === 'http';
      const proxy = modeSel.value === 'proxy';
      const payload = {
        name: nameIn.value.trim(), transport: transSel.value,
        url: http ? urlIn.value.trim() : null, command: http ? null : cmdIn.value.trim(),
        auth_env: proxy ? null : (authIn.value.trim() || null),
        note: noteIn.value.trim() || null, enabled: enChk.checked,
        mode: modeSel.value,
        scope: proxy ? scopeSel.value : null,
        level: proxy ? levelSel.value : null,
        auth_mode: proxy ? authModeSel.value : null,
        auth_kind: proxy ? (authKindIn.value.trim() || null) : null,
        auth_scope_key: proxy ? (authScopeIn.value.trim() || null) : null,
        pii_scrub: proxy ? piiChk.checked : false,
        log_args: proxy ? logArgsChk.checked : false, // #1082
      };
      await api('/api/ui/org/mcp-server', { method: 'POST', body: JSON.stringify(payload) });
      // OAuth 클라이언트(선택) — client_id 입력 시 (gateway,auth_kind,'oauth:client') 슬롯에 시딩. 비우면 기존 유지(DCR 상류는 불요).
      if (proxy && authModeSel.value === 'oauth' && oauthClientIdIn.value.trim()) {
        const kind = authKindIn.value.trim();
        if (!kind) { toast('OAuth 클라이언트를 저장하려면 자격 종류(auth_kind)가 필요합니다', true); }
        else {
          const seed: any = { client_id: oauthClientIdIn.value.trim() };
          if (oauthClientSecretIn.value.trim()) seed.client_secret = oauthClientSecretIn.value.trim();
          await api('/api/ui/org/credential', { method: 'POST', body: JSON.stringify({ kind, scope_key: 'oauth:client', secret: JSON.stringify(seed) }) });
          oauthClientIdIn.value = ''; oauthClientSecretIn.value = '';
        }
      }
      await loadAdmin(true); state.admin.mcpSel = payload.name; toast('저장됨 — 다음 세션부터 반영'); rerenderPanel(detail, 'mcp', state.admin.data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });
  const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
  if (!isNew) actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
    if (!confirm(`MCP 서버 '${s.name}' 제거?`)) return;
    try { await api('/api/ui/org/mcp-server/remove', { method: 'POST', body: JSON.stringify({ name: s.name }) }); await loadAdmin(true); state.admin.mcpSel = null; toast('제거됨'); rerenderPanel(detail, 'mcp', state.admin.data); }
    catch (e) { toast(e.message, true); }
  } }));
  // ── 프리셋 — 신규 등록 시 선택하면 필드 자동 채움(#746 imp#3). 코드 SoT=mcp-server-presets.ts. ──
  //  위저드 본체는 mcpPresetField 로 뺐다(#1313 R40) — 아래 입력칸들을 그대로 넘겨 프리셋이 채우게 한다.
  const presetField = mcpPresetField({ nameIn, transSel, urlIn, modeSel, authModeSel, authKindIn, scopeSel, levelSel, piiChk, logArgsChk, syncTransport, syncMode }, data, isNew);

  root.replaceChildren(...[
    isNew ? presetField : null,
    field('이름', nameIn), field('방식', modeSel), field('전송 방식', transSel), urlField, cmdField,
    authEnvField, field('설명', noteIn),
    el('label', { class: 'admin-check' }, enChk, ' 활성'),
    proxyBox,
    actions,
  ].filter(Boolean));
  syncTransport();
  syncMode();
}

// ── 프리셋 위저드(#746 imp#3 → #1313 R40 로 mcpForm 에서 적출) ──
//  f = mcpForm 이 만든 입력 엘리먼트·동기화 함수 묶음(참조 그대로 전달 — 프리셋이 그 칸들에 값을 써 넣는다).
//  반환값은 신규 등록 폼 맨 위에 꽂는 '프리셋(기본 카탈로그)' 필드.
function mcpPresetField(f, data, isNew) {
  const { nameIn, transSel, urlIn, modeSel, authModeSel, authKindIn, scopeSel, levelSel, piiChk, logArgsChk, syncTransport, syncMode } = f;
  const presetSel = el('select', {}, el('option', { value: '', text: '— 직접 입력 —' }));
  const presetHint = el('div', { class: 'admin-hint', style: 'display:none;margin-top:6px' });
  let catalog: any[] = [];
  api('/api/ui/org/mcp-server-presets').then((r: any) => {
    catalog = r.catalog || [];
    for (const c of catalog) presetSel.append(el('option', {
      value: c.name,
      // 레인 C(#1881)는 게이트웨이가 대리하지 않는다 — 'OAuth client 필요' 와 정반대라 라벨을 따로 준다.
      text: c.label + (c.mode === 'client' ? ' · 내 PC 에 설치' : c.dcr ? ' · 자동(DCR)' : ' · client 필요'),
    }));
  }).catch(() => {});
  presetSel.addEventListener('change', () => {
    const c = catalog.find((x) => x.name === presetSel.value);
    if (!c) { presetHint.style.display = 'none'; return; }
    if (isNew) nameIn.value = c.name;
    transSel.value = 'http'; urlIn.value = c.url;
    // 레인(#1881) — client 는 게이트웨이가 토큰을 갖지 않는다(금고 슬롯·OAuth 모드 없음).
    const lanC = c.mode === 'client';
    modeSel.value = lanC ? 'client' : 'proxy'; authModeSel.value = lanC ? 'bearer' : 'oauth';
    authKindIn.value = lanC ? '' : (c.auth_kind || ''); scopeSel.value = c.scope; levelSel.value = c.level; piiChk.checked = !!c.pii_scrub;
    logArgsChk.checked = false; // #1082 — 프리셋은 전부 외부 SaaS(슬랙·노션·리니어…). 인자 값 기록은 항상 꺼진 상태로 시작한다.
    syncTransport(); syncMode();
    // 셋업 위저드(imp#1) — DCR이면 0세팅, 아니면 provider 콘솔 체크리스트 + 정확한 콜백 URL.
    const cb = ((data && data.profile && data.profile.gateway_url) || location.origin).replace(/\/mcp$/, '').replace(/\/$/, '') + '/oauth/callback';
    presetHint.replaceChildren();
    if (c.mode === 'client') {
      // 레인 C — [발행]을 누르면 게이트웨이가 상류에 붙으려다 실패한다(상류가 클라이언트를 allowlist 로 가림). 저장만 하면 된다.
      presetHint.append(el('div', { text: `${c.label}: 구성원 PC 의 AI 도구에 직접 등록됩니다 — OAuth client·[발행] 모두 불필요합니다. 저장만 하세요.` }));
      if (c.guide && Array.isArray(c.guide.steps) && c.guide.steps.length) {
        presetHint.append(el('ol', { style: 'margin:6px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:4px' },
          ...c.guide.steps.map((s: string) => el('li', {}, ...uiText(String(s))))));
      }
    } else if (c.dcr) {
      presetHint.append(el('div', { text: `${c.label}: 자동 클라이언트 등록(DCR) — OAuth client 입력 불필요. 저장 → [발행](연결 테스트) → 구성원이 [연결]하면 끝.` }));
    } else if (c.guide && Array.isArray(c.guide.steps) && c.guide.steps.length) {
      // 서비스별 실제 절차(프리셋 guide) — 범용 템플릿은 슬랙에 "웹 애플리케이션 OAuth 클라이언트"(구글 용어) 같은
      //  안 맞는 문구를 띄웠고, 슬랙 필수 단계(MCP 접근 활성화·User Token Scopes)가 통째로 빠져 있었다.
      //  steps 의 {callback} 은 이 게이트웨이의 실제 콜백 URL 로 치환한다.
      presetHint.append(el('div', { style: 'font-weight:600;margin-bottom:4px', text: `${c.label} 셋업` }));
      if (c.guide.intro) presetHint.append(el('div', { class: 'caption', style: 'margin:0 0 6px' }, ...uiText(c.guide.intro)));
      presetHint.append(el('ol', { style: 'margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px' },
        ...c.guide.steps.map((s: string) => {
          const parts = String(s).split('{callback}');
          const li = el('li', {});
          parts.forEach((p, i) => { li.append(...uiText(p)); if (i < parts.length - 1) li.append(el('code', { text: cb })); });
          return li;
        })));
      // #1881 슬랙 — 매니페스트(이름·스코프·봇·콜백)가 채워진 생성 링크를 서버가 만든다(콜백이 게이트웨이마다 다르다).
      if (c.name === 'slack') {
        const mkBtn = el('button', { class: 'btn btn-sm', type: 'button', text: 'Slack 앱 만들기 링크 열기 ↗', style: 'margin-top:6px;margin-right:8px' });
        mkBtn.addEventListener('click', async () => {
          mkBtn.disabled = true;
          try { const r = await api('/api/ui/org/slack/app-manifest'); if (r && r.create_url) window.open(r.create_url, '_blank', 'noopener'); else toast('링크를 받지 못했습니다', true); }
          catch (e: any) { toast((e && e.message) || '링크를 만들지 못했습니다', true); }
          finally { mkBtn.disabled = false; }
        });
        presetHint.append(mkBtn);
      }
      if (c.guide.url) presetHint.append(el('a', { class: 'admin-hint', href: c.guide.url, target: '_blank', rel: 'noopener', style: 'display:inline-block;margin-top:6px', text: '설정 페이지 열기 ↗' }));
    } else {
      presetHint.append(
        el('div', { style: 'font-weight:600;margin-bottom:4px', text: `${c.label}: 사전등록 OAuth client 필요 — provider 콘솔 셋업:` }),
        el('ol', { style: 'margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px' },
          el('li', { text: 'provider 콘솔에서 OAuth 클라이언트 생성(유형은 서비스 문서 참조)' }),
          el('li', { text: '아래 [필요한 OAuth 허용범위] 를 그 콘솔의 스코프 설정에 추가' }),
          el('li', {}, '승인된 redirect URI 에 게이트웨이 콜백 등록 → ', el('code', { text: cb })),
          el('li', {}, '발급된 client_id/secret 를 아래 ', el('b', { text: 'OAuth 클라이언트' }), ' 필드에 입력'),
          el('li', {}, ...uiText('저장 → 본인 [연결] → [발행](막히면 스코프/콜백 재확인)'))));
    }
    // 스코프는 이미 이 응답으로 내려와 있었는데 화면이 안 썼다 — "note 참조"라 해놓고 note 엔 없었다(#1226 지적).
    //  콘솔에 그대로 붙여넣는 값이라 복사할 수 있게 노출한다.
    if (c.oauth_scope) {
      const scopeBox = el('code', { style: 'display:block;white-space:pre-wrap;word-break:break-all;margin:4px 0 0;padding:6px 8px;background:var(--bg-sub);border-radius:6px;font-size:11.5px', text: c.oauth_scope });
      const copyBtn = el('button', { type: 'button', class: 'btn-text', style: 'margin-top:2px', text: '복사' });
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(c.oauth_scope).then(() => toast('복사됨'), () => toast('복사하지 못했습니다', true));
      });
      presetHint.append(
        el('div', { style: 'margin-top:8px;font-weight:600' }, ...uiText('필요한 OAuth 허용범위')),
        scopeBox, copyBtn);
    }
    if (c.note) presetHint.append(el('div', { class: 'caption', style: 'margin-top:6px' }, ...uiText(c.note)));
    presetHint.style.display = '';
  });
  return field('프리셋(기본 카탈로그)', el('div', {}, presetSel, presetHint));
}

export {
  mcpEditor,
};
