// admin-credentials.ts — 자격(커넥터 로그인) 금고 UI + git 자격 오버레이 (#1313 R38, admin.ts 에서 verbatim 분리).
//  ⭐ CRED_KINDS — 자격 종류 스펙 표의 **단일 거처**다. 관리자 폼(credVaultCard·toolForm 인증칸)과 개인 폼
//   (me-logins.ts 의 서비스 탭 → svcTokenForm)이 같은 표를 본다. 표가 두 벌이 되면 한쪽에만 종류가 늘어
//   조용히 어긋난다 — 그래서 여기 한 곳에만 둔다.
//  소비자 import 문을 지키려고 admin.ts 가 아래 전부를 그대로 재수출한다.
import { api, busy, cardHead, el, errorNote, memberCombo, secretInput, secretRow, toast, uiText } from './core.js';
import { copyButton, field, overlay, skeleton } from './ui-primitives.js';
import { sectionHead } from './admin-widgets.js';

// git 자격 관리 오버레이(#540) — 레포 클론·세션 git 용 SSH/HTTPS 자격. scope='me'(본인 자가등록) | 'gateway'(조직 머신계정·admin).
//  SSH 는 박스가 키페어를 만들고 **공개키만** 보여준다(사용자가 GitHub 에 등록 — 개인키는 박스 밖으로 안 나감). HTTPS 는 토큰 저장.
//  provision 클론은 요청 멤버 자격(없으면 gateway)을 주입, 세션 안 git 은 멤버 자격을 멤버 홈에 materialize(Slice 2).
function openGitCredentialManager(scope: 'me' | 'gateway') {
  const isGw = scope === 'gateway';
  const base = isGw ? '/api/ui/org/git-credential' : '/api/ui/me/git-credential';
  const body = el('div', { style: 'min-width:520px; max-width:640px;' });
  const back = overlay(isGw ? '게이트웨이 git 계정' : 'git 인증 (레포 접근)', body);
  document.body.append(back);

  const reload = async () => {
    busy(body, skeleton('불러오는 중'));
    try { render(await api(base)); }
    catch (e: any) { body.replaceChildren(el('p', { class: 'gate-error', text: (e && e.message) || '불러오기 실패' })); }
  };

  const credRow = (c: any) => {
    const head = el('div', { style: 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;' },
      el('span', { class: 'pill pill-ok', text: String(c.kind || '').toUpperCase() }),
      el('span', { class: 'mini-meta' }, ...uiText(c.host)),
      c.kind === 'ssh' && c.ssh_public_key ? copyButton(() => c.ssh_public_key, '공개키 복사') : null,
      el('button', {
        class: 'btn btn-ghost btn-sm', text: '삭제',
        onclick: async () => {
          if (!confirm(`${c.host} (${c.kind}) 자격을 삭제할까요?`)) return;
          try { await api(base + '/delete', { method: 'POST', body: JSON.stringify({ host: c.host }) }); toast('삭제됨'); reload(); }
          catch (e: any) { toast((e && e.message) || '삭제 실패', true); }
        },
      }));
    const box = el('div', { class: 'card', style: 'padding:10px 12px; margin:6px 0;' }, head);
    if (c.kind === 'ssh' && c.ssh_public_key) {
      box.append(el('pre', { class: 'admin-preview', style: 'white-space:pre-wrap; word-break:break-all; margin:8px 0 0; font-size:11.5px;', text: c.ssh_public_key }));
      box.append(el('p', { class: 'admin-hint', style: 'margin:6px 0 0' }, ...uiText('이 공개키를 호스트에 등록하세요 — GitHub: 레포 Settings ▸ Deploy keys · GitLab: 레포 Settings ▸ Repository ▸ Deploy keys(또는 계정 ▸ SSH keys). 셀프호스팅 GitLab 도 동일.')));
    }
    return box;
  };

  const render = (data: any) => {
    const rows: any[] = [];
    rows.push(el('p', { class: 'admin-hint', style: 'margin:0 0 10px', text: isGw
      ? '조직 머신 git 계정입니다. 프로젝트 provision 클론에서 요청한 구성원 자격이 없을 때 이 자격으로 클론합니다 — private 레포면 여기(또는 각 구성원)에 자격이 있어야 클론됩니다.'
      : '내 git 자격입니다. private 레포 클론과 세션(shell·Claude) 안 git 에 이 자격이 쓰입니다. SSH 는 박스가 키를 만들고 공개키만 호스트(GitHub·GitLab·셀프호스팅)에 등록하면 됩니다(개인키는 박스 밖으로 안 나갑니다).' }));
    if (!data.encryption_ready) rows.push(el('p', { class: 'gate-error', style: 'margin:0 0 10px', text: '⚠ 서버에 CONNECTOR_SECRET_KEY 가 설정되지 않아 자격을 저장할 수 없습니다 — 관리자에게 게이트웨이 env(CONNECTOR_SECRET_KEY) 설정을 요청하세요.' }));

    const creds = (data.credentials || []) as any[];
    if (creds.length) rows.push(...creds.map(credRow));
    else rows.push(el('p', { class: 'admin-hint' }, ...uiText('등록된 자격이 없습니다.')));

    // ── 새 자격 추가 ──
    rows.push(el('div', { style: 'border-top:1px solid var(--line); margin:14px 0 10px;' }));
    const hostIn = el('input', { type: 'text', value: 'github.com', placeholder: 'github.com' });
    const kindSel = { v: 'ssh' as 'ssh' | 'https' };
    const sshBox = el('div', {}, el('p', { class: 'admin-hint', style: 'margin:0' }, ...uiText('박스가 ed25519 키페어를 생성합니다. 생성 후 공개키를 호스트(GitHub·GitLab 등)에 Deploy key 로 등록하세요.')));
    const userIn = el('input', { type: 'text', placeholder: '사용자명(선택 — GitHub PAT 는 비워도 됨, GitLab 은 보통 계정명/oauth2)' });
    // 깃 PAT 은 이 사이트 계정의 비밀번호가 아니다 — type=password 로 두면 [사용자명]+[토큰] 쌍이 로그인 폼으로
    //  보여서 크롬이 사용자명칸에 저장된 이메일을 채우고 저장까지 제안한다(#1250). 텍스트칸+CSS 가림으로.
    const tokenIn = secretInput({ placeholder: 'HTTPS 토큰 / PAT' });
    const httpsBox = el('div', { style: 'display:none' }, field('사용자명(선택)', userIn), field('토큰', secretRow(tokenIn)));
    const kindChips = el('div', { class: 'chips' },
      ...(['ssh', 'https'] as const).map((k) => {
        const chip = el('button', { type: 'button', class: 'chip' + (kindSel.v === k ? ' on' : ''), text: k === 'ssh' ? 'SSH 키 (박스 생성)' : 'HTTPS 토큰' });
        chip.onclick = () => {
          kindSel.v = k;
          Array.from(kindChips.children).forEach((c: any, i) => c.classList.toggle('on', (['ssh', 'https'] as const)[i] === k));
          sshBox.style.display = k === 'ssh' ? '' : 'none';
          httpsBox.style.display = k === 'https' ? '' : 'none';
          submit.textContent = k === 'ssh' ? 'SSH 키 생성' : '토큰 저장';
        };
        return chip;
      }));
    const submit = el('button', { class: 'btn btn-primary', text: 'SSH 키 생성' });
    const status = el('span', { class: 'admin-status' });
    submit.addEventListener('click', async () => {
      if (!data.encryption_ready) { toast('CONNECTOR_SECRET_KEY 미설정 — 저장할 수 없습니다', true); return; }
      const host = hostIn.value.trim() || 'github.com';
      const payload: any = { kind: kindSel.v, host };
      if (kindSel.v === 'https') {
        if (!tokenIn.value.trim()) { toast('토큰을 입력하세요', true); return; }
        payload.token = tokenIn.value; if (userIn.value.trim()) payload.username = userIn.value.trim();
      }
      (submit as any).disabled = true; status.textContent = kindSel.v === 'ssh' ? '키 생성 중…' : '저장 중…';
      try {
        await api(base, { method: 'POST', body: JSON.stringify(payload) });
        toast(kindSel.v === 'ssh' ? 'SSH 키 생성됨 — 아래 공개키를 호스트에 Deploy key 로 등록하세요' : '토큰 저장됨');
        reload();
      } catch (e: any) { status.textContent = ''; (submit as any).disabled = false; toast((e && e.message) || '실패', true); }
    });
    rows.push(el('div', { class: 'card', style: 'padding:12px;' },
      el('div', { class: 'field-label', style: 'margin-bottom:8px', text: '새 자격 추가' }),
      kindChips, field('호스트', el('div', {}, hostIn, el('p', { class: 'admin-hint', style: 'margin:4px 0 0' }, ...uiText('GitHub·GitLab·셀프호스팅(예: git.example.com) 모두 지원 — 레포 호스트를 정확히 입력. HTTPS 가 막힌 호스트는 SSH 로 등록하세요.')))), sshBox, httpsBox,
      el('div', { class: 'admin-actions', style: 'margin-top:10px' }, submit, status)));

    body.replaceChildren(...rows);
  };
  reload();
}

// ── 자격(커넥터 로그인) vault UI(#746 P1) — 능동 커넥터가 쓰는 per-user 토큰. 텍스트 최소화·드롭다운 위주. ──
//  kind 는 드롭다운(친숙한 라벨), kind 별 필요한 필드만 노출, 헤더 형식은 프리셋(고급 토글 없이 숨김). '내 자격'은 전원,
//  '통합 자격'·AWS 역할은 admin. secret 은 password 입력이고 목록엔 등록됨(✓)만 보인다(값 비노출).
const CRED_KINDS: Array<{ kind: string; label: string; secretLabel: string; secretPh?: string; scope?: string; scopePh?: string; meta?: Record<string, string>; help?: string; docUrl?: string; memberOnly?: boolean }> = [
  { kind: 'gitlab_pat', label: 'GitLab 개인 토큰(PAT)', secretLabel: 'GitLab 토큰', secretPh: 'glpat-…', scope: 'GitLab 호스트', scopePh: 'git.example.com', meta: { auth_header: 'PRIVATE-TOKEN', token_prefix: '' }, help: 'GitLab ▸ 우측상단 프로필 ▸ Preferences ▸ Access Tokens 에서 발급(read_api·read_repository). 여러 GitLab 서버를 쓰면 호스트로 구분하세요. 레포(git) 관리의 [목록에서 선택] 드롭다운도 이 토큰으로 조회합니다 — git 전송을 SSH 로 하더라도 이 토큰만 있으면 목록을 불러올 수 있습니다.' },
  { kind: 'github_pat', label: 'GitHub 토큰(PAT)', secretLabel: 'GitHub 토큰', secretPh: 'ghp_… / github_pat_…', scope: 'GitHub 호스트', scopePh: 'github.com', docUrl: 'https://github.com/settings/tokens', meta: { auth_header: 'Authorization', token_prefix: 'Bearer ' }, help: 'GitHub ▸ Settings ▸ Developer settings ▸ Personal access tokens 에서 발급(classic=repo / fine-grained=Metadata read). 레포(git) 관리의 [목록에서 선택] 드롭다운이 이 토큰으로 조회합니다 — git 전송을 SSH(deploy key)로 하더라도 이 토큰만 있으면 목록을 불러올 수 있습니다.' },
  { kind: 'slack_user_token', label: 'Slack 사용자 토큰(xoxp)', secretLabel: 'xoxp- 토큰', secretPh: 'xoxp-…', help: '메시지 검색(search.messages)은 봇 토큰이 안 되고 사용자 토큰(xoxp)이 필요합니다. 내가 초대된 채널만 검색됩니다.', docUrl: 'https://api.slack.com/apps' },
  // notion_token·google_oauth_refresh 제거(#746) — 이 서비스는 OAuth 커넥터(관리탭 MCP 서버)로 연결. 정적 토큰 슬롯은 중복·미사용(죽은 옵션)이었음.
  { kind: 'clickup_token', label: 'ClickUp 토큰', secretLabel: 'ClickUp 토큰', secretPh: 'pk_…', meta: { token_prefix: '' }, help: 'ClickUp ▸ Settings ▸ Apps 에서 개인 API 토큰(pk_…) 발급.', docUrl: 'https://app.clickup.com/settings/apps' },
  { kind: 'prometheus_bearer', label: 'Prometheus Bearer 토큰', secretLabel: 'Bearer 토큰' },
  { kind: 'figma_token', label: 'Figma 토큰', secretLabel: 'Figma 토큰', secretPh: 'figd_…', meta: { auth_header: 'X-Figma-Token', token_prefix: '' }, help: 'Figma ▸ Settings ▸ Security ▸ Personal access tokens 에서 발급(figd_…).', docUrl: 'https://www.figma.com/settings' },
  // #1101(b)/#1299 — 헤드리스 claude -p(위탁) 실행 인증. task-scheduler 가 requester 의 member_secret(kind=claude_setup_token)을 CLAUDE_CODE_OAUTH_TOKEN 으로 리스한다. member 전용(격리 박스엔 공유 폴백 없음 — #1014) → 조직 자격 폼에선 숨긴다(memberOnly).
  //  ⚠ kind 는 member-secret-store 의 KIND_RE(소문자·숫자·_)를 지켜야 한다 — 하이픈이면 저장 단계에서 거부된다(#1299 초판 결함).
  { kind: 'claude_setup_token', label: 'Claude 헤드리스 토큰(setup-token)', secretLabel: 'setup-token', help: '터미널에서 `claude setup-token` 을 실행해 나온 토큰을 붙여넣으세요(클로드에 로그인된 상태에서 발급). 헤드리스 분류·에이전트 크론(claude -p)이 이 토큰으로 내 Claude 계정으로 인증·실행됩니다(구독 크레딧 과금). 내 세션·에이전트 실행에만 쓰이고 타 구성원에게 노출되지 않습니다.', memberOnly: true },
];
const AWS_REGIONS = ['ap-northeast-2', 'ap-northeast-1', 'us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1'];

// 커넥터 현황(#746 imp#4·#5) — 기본 카탈로그 각 커넥터의 등록/설정 상태 개관(관리자 온보딩 지도).
function catalogStatusCard(catalog: any[], servers: any[]) {
  const byName = new Map((servers || []).map((s: any) => [s.name, s]));
  const rows: any[] = [cardHead('기본 제공 도구 서버 상태', '기본 제공되는 외부 도구 서버(MCP) 프리셋의 현재 상태입니다 — 외부 자료 수집(미러)과는 별개 항목입니다. 추가·발행은 [AI 도구 ▸ 외부 도구 서버]에서 하고, 구성원은 각자 [연결]에서 자기 계정을 연결합니다.')];
  for (const c of (catalog || [])) {
    const s = byName.get(c.name);
    let chip: any; let hint = '';
    if (s && s.enabled !== false) { chip = el('span', { class: 'pill pill-ok', text: '✓ 등록됨' }); hint = c.dcr ? '구성원이 [연결]을 마치면 사용할 수 있습니다.' : 'OAuth client 시딩 확인 후 [연결]'; }
    else if (c.dcr) { chip = el('span', { class: 'pill', text: '+ 추가 가능(자동)' }); hint = 'MCP 서버 ▸ 프리셋에서 추가(DCR — client 불필요)'; }
    else { chip = el('span', { class: 'pill', style: 'background:var(--amber-bg);color:var(--amber-mid)', text: '⚙ 설정 필요' }); hint = 'OAuth client 를 만들어 사전 등록한 뒤 프리셋으로 추가하세요.'; }
    rows.push(el('div', { class: 'card', style: 'padding:9px 12px;margin:6px 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
      el('span', { style: 'font-weight:650;min-width:150px', text: c.label }),
      chip,
      el('span', { class: 'mini-meta' }, ...uiText(hint))));
  }
  if (!(catalog || []).length) rows.push(el('p', { class: 'admin-hint' }, ...uiText('프리셋을 불러오지 못했습니다.')));
  // 외부 도구 서버(MCP) 기본 프리셋 현황 — org_connector(외부 자료 수집)와 무관하다(#837 에서 엔드포인트도 개명).
  return el('div', { class: 'admin-section', style: 'margin-top:18px' }, el('h3', { class: 'admin-subhead', text: '외부 도구 서버 현황 (기본 프리셋)' }), ...rows);
}

// ── [서비스 로그인] — 조직 자격만(#837). ──
//  개인 vault('내 자격' + OAuth 연결)는 **조직 관리가 아니라 개인 설정**이라 [내 프로필] 모달로 옮겼다.
//  그것 때문에 이 섹션이 권한 게이트 없이 전 구성원에게 열려 있었고(ADMIN_ONLY 밖), 조직 관리 화면에
//  개인 설정이 섞여 있었다. 이제 섹션은 admin 전용이고, 안에 조직 자격·AWS 역할·프리셋 현황만 남는다.
async function credentialsEditor(detail) {
  busy(detail, el('div', { class: 'card' }, skeleton('자격을 불러오는 중')));
  let mine: any = { encryption_ready: true };
  let org: any = { credentials: [] };
  let awsRoles: any = { credentials: [] };
  let catalog: any = { catalog: [] };
  let mcpServers: any = { servers: [] };
  try {
    mine = await api('/api/ui/me/credentials');   // 암호화 키 준비 여부(encryption_ready)만 본다
    org = await api('/api/ui/org/credentials');
    // aws_role_arn 은 전 owner(통합 기본 + 구성원 오버라이드) 개관이 필요 → by-kind 조회
    awsRoles = await api('/api/ui/org/credentials?kind=aws_role_arn').catch(() => ({ credentials: [] }));
    // 외부 도구 서버(MCP) 프리셋 — '외부 자료 수집'(org_connector 미러)과 무관하다.
    catalog = await api('/api/ui/org/mcp-server-presets').catch(() => ({ catalog: [] }));
    mcpServers = await api('/api/ui/org/mcp-servers').catch(() => ({ servers: [] }));
  } catch (e: any) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '자격을 불러오지 못했습니다'))); return; }

  const encReady = mine.encryption_ready !== false;
  const cards: any[] = [
    sectionHead('서비스 로그인 (조직)', 'AI가 외부 서비스를 조직 공용 계정으로 쓸 수 있게 미리 로그인해 둡니다. 개인 계정으로 쓰게 하려면 각자 [외부 서비스 관리]에서 넣습니다.'),
    encReady ? null : el('p', { class: 'gate-error', text: '⚠ 서버에 암호화 키(CONNECTOR_SECRET_KEY)가 없어 자격을 저장할 수 없습니다 — 관리자에게 요청하세요.' }),
    catalogStatusCard(catalog.catalog || [], mcpServers.servers || []),
    credVaultCard('org', '통합 자격', '개인 로그인이 없는 구성원이 조회(비-PII read)할 때 공용으로 쓰는 로그인입니다. 쓰기·외부 발신·민감정보 접근에는 쓰이지 않습니다 — 이 작업들에는 개인 로그인이 필요합니다.', (org.credentials || []).filter((c: any) => c.kind !== 'aws_role_arn'), encReady, () => credentialsEditor(detail)),
    awsRoleCard(awsRoles.credentials || [], () => credentialsEditor(detail)),
  ];
  detail.replaceChildren(...cards.filter(Boolean));   // encReady 면 위 항목이 null → 'null' 텍스트 렌더 방지(#req)
}

// 특정 종류(kind) 토큰 입력 폼 — CRED_KINDS 스펙 사용.
function svcTokenForm(kind: string, reload: () => void) {
  const spec = CRED_KINDS.find((x) => x.kind === kind);
  if (!spec) return el('div', {});
  const scopeIn = el('input', { type: 'text', placeholder: spec.scopePh || '' });
  const secretIn = secretInput({ placeholder: spec.secretPh || '토큰 값 붙여넣기' });   // 계정 비번 아님 — #1250
  const submit = el('button', { class: 'btn btn-primary btn-sm', text: '저장' });
  const status = el('span', { class: 'admin-status' });
  submit.addEventListener('click', async () => {
    if (!secretIn.value.trim()) { toast('토큰을 입력하세요', true); return; }
    const payload: any = { kind: spec.kind, secret: secretIn.value };
    if (spec.scope && scopeIn.value.trim()) payload.scope_key = scopeIn.value.trim();
    if (spec.meta) payload.meta = spec.meta;
    (submit as any).disabled = true; status.textContent = '저장 중…';
    try { await api('/api/ui/me/credential', { method: 'POST', body: JSON.stringify(payload) }); toast('저장됨'); reload(); }
    catch (e: any) { status.textContent = ''; (submit as any).disabled = false; toast((e && e.message) || '저장 실패', true); }
  });
  return el('div', { class: 'card', style: 'padding:14px' },
    spec.scope ? field(spec.scope + '(선택)', scopeIn) : null,
    field(spec.secretLabel, secretRow(secretIn)),
    spec.help ? el('p', { class: 'admin-hint', style: 'margin:2px 0 0' }, ...uiText(spec.help)) : null,
    spec.docUrl ? el('a', { class: 'admin-hint', href: spec.docUrl, target: '_blank', rel: 'noopener', style: 'display:inline-block; margin:6px 0 0', text: '토큰 발급 페이지 열기 ↗' }) : null,
    el('div', { class: 'admin-actions', style: 'margin-top:10px' }, submit, status));
}

// 자격 목록 + 추가 폼 카드(me 또는 org). aws_role_arn 은 별도(awsRoleCard).
function credVaultCard(owner: 'me' | 'org', title: string, intro: string, creds: any[], encReady: boolean, reload: () => void) {
  const base = owner === 'me' ? '/api/ui/me/credential' : '/api/ui/org/credential';
  const kindLabel = (k: string) => (CRED_KINDS.find((x) => x.kind === k)?.label || k);
  const rows: any[] = [cardHead(title, intro)];

  // 등록된 자격 — 균일 보더 행(svc-item). 칩 + scope_key + 삭제(값 비노출).
  if (creds.length) {
    const list = el('div', { class: 'svc-list' });
    for (const c of creds) {
      list.append(el('div', { class: 'svc-item' },
        el('span', { class: 'pill pill-ok', text: kindLabel(c.kind) }),
        c.scope_key ? el('span', { class: 'mini-meta' }, ...uiText(c.scope_key)) : null,
        el('span', { class: 'mini-meta', text: c.has_secret ? '토큰 등록됨 ✓' : '토큰 없음' }),
        el('span', { class: 'svc-item-actions' }, el('button', { class: 'btn btn-ghost btn-sm', text: '삭제', onclick: async () => {
          if (!confirm(`${kindLabel(c.kind)}${c.scope_key ? ' (' + c.scope_key + ')' : ''} 자격을 삭제할까요?`)) return;
          try { await api(base + '/delete', { method: 'POST', body: JSON.stringify({ kind: c.kind, scope_key: c.scope_key || '' }) }); toast('삭제됨'); reload(); }
          catch (e: any) { toast((e && e.message) || '삭제 실패', true); }
        } }))));
    }
    rows.push(list);
  } else rows.push(el('p', { class: 'admin-hint', style: 'margin:0' }, ...uiText('등록된 자격이 없습니다.')));

  // ── 추가 폼 — kind 드롭다운 → 필요한 필드만 노출 ──
  const kindSel = el('select', {}, ...CRED_KINDS.filter((k) => owner === 'me' || !k.memberOnly).map((k) => el('option', { value: k.kind, text: k.label })));
  const scopeIn = el('input', { type: 'text', placeholder: '' });
  const scopeField = field('대상 구분(선택)', scopeIn);
  const secretIn = secretInput({ placeholder: '' });          // 계정 비번 아님 — #1250
  const secretField = field('토큰', secretRow(secretIn));
  const helpP = el('p', { class: 'admin-hint', style: 'margin:2px 0 0' });
  const docLink = el('a', { class: 'admin-hint', target: '_blank', rel: 'noopener', style: 'display:none;margin:4px 0 0' });
  const submit = el('button', { class: 'btn btn-primary', text: '저장' });
  const status = el('span', { class: 'admin-status' });

  const syncKind = () => {
    const spec = CRED_KINDS.find((x) => x.kind === kindSel.value)!;
    scopeField.style.display = spec.scope ? '' : 'none';
    (scopeField.querySelector('.field-label') as HTMLElement).textContent = (spec.scope || '대상 구분') + '(선택)';
    scopeIn.placeholder = spec.scopePh || '';
    (secretField.querySelector('.field-label') as HTMLElement).textContent = spec.secretLabel;
    secretIn.placeholder = spec.secretPh || '토큰 값 붙여넣기';
    helpP.textContent = spec.help || '';
    helpP.style.display = spec.help ? '' : 'none';
    if (spec.docUrl) { docLink.setAttribute('href', spec.docUrl); (docLink as any).textContent = '토큰 발급 페이지 열기 ↗'; docLink.style.display = ''; } else { docLink.style.display = 'none'; }
  };
  kindSel.addEventListener('change', syncKind); syncKind();

  submit.addEventListener('click', async () => {
    if (!encReady) { toast('암호화 키 미설정 — 저장 불가', true); return; }
    if (!secretIn.value.trim()) { toast('토큰을 입력하세요', true); return; }
    const spec = CRED_KINDS.find((x) => x.kind === kindSel.value)!;
    const payload: any = { kind: spec.kind, secret: secretIn.value };
    if (spec.scope && scopeIn.value.trim()) payload.scope_key = scopeIn.value.trim();
    if (spec.meta) payload.meta = spec.meta; // 헤더 형식 프리셋(사용자가 신경 안 써도 됨)
    (submit as any).disabled = true; status.textContent = '저장 중…';
    try { await api(base, { method: 'POST', body: JSON.stringify(payload) }); toast('저장됨'); reload(); }
    catch (e: any) { status.textContent = ''; (submit as any).disabled = false; toast((e && e.message) || '저장 실패', true); }
  });

  rows.push(el('div', { class: 'card', style: 'padding:12px; margin-top:10px;' },
    cardHead('새 자격 추가'),
    field('서비스', kindSel), scopeField, secretField, helpP, docLink,
    el('div', { class: 'admin-actions', style: 'margin-top:10px' }, submit, status)));

  return el('div', { class: 'admin-section', style: 'margin-top:18px' }, el('h3', { class: 'admin-subhead', text: title }), ...rows);
}

// AWS 역할 카드(통합 자격의 특수형 — secret 없이 role ARN·리전·service). 게이트웨이가 이 역할을 각 구성원 이름으로 가정해 15분 단기자격 발급.
//  owner=gateway → 전원 기본(readonly 권장), owner=member:<id> → 그 구성원 오버라이드(write 포함 가능). #746 P1 오버라이드 체인.
function awsRoleCard(creds: any[], reload: () => void) {
  const ownerLabel = (o: string) => (o && o.startsWith('member:') ? '구성원 ' + o.slice(7) : '전원 기본');
  const ownerMember = (o: string) => (o && o.startsWith('member:') ? o.slice(7) : ''); // '' = 조직 통합
  const rows: any[] = [cardHead('AWS 역할', 'AWS 는 토큰 대신 "역할(role)"을 등록합니다. 게이트웨이가 이 역할을 각 구성원 이름으로 가정(assume)해 15분 동안 유효한 단기 자격을 발급합니다 — 장기 키를 저장하지 않으므로 유출 위험이 없고, 누가 무엇을 했는지 AWS CloudTrail 에 기록됩니다. "전원 기본"은 조회(readonly) 역할로 두고, 쓰기가 필요한 구성원만 개별 오버라이드하세요. (역할·신뢰관계는 AWS 관리자가 먼저 만들어야 합니다.)')];
  // owner 정렬: 전원 기본(gateway) 먼저, 그 다음 구성원 오버라이드.
  const sorted = [...creds].sort((a, b) => (ownerMember(a.owner) ? 1 : 0) - (ownerMember(b.owner) ? 1 : 0) || String(a.owner).localeCompare(String(b.owner)));
  for (const c of sorted) {
    const m = c.meta || {};
    const mem = ownerMember(c.owner);
    rows.push(el('div', { class: 'card', style: 'padding:9px 12px; margin:6px 0; display:flex; gap:10px; align-items:center; flex-wrap:wrap;' },
      el('span', { class: mem ? 'pill' : 'pill pill-ok', text: mem ? '오버라이드' : '전원 기본' }),
      el('span', { class: 'mini-meta', text: ownerLabel(c.owner) }),
      c.scope_key ? el('span', { class: 'mini-meta' }, ...uiText(c.scope_key)) : null,
      el('span', { class: 'mini-meta', text: (m.role_arn || '(role_arn 미설정)') + (m.region ? ' · ' + m.region : '') + (m.service ? ' · ' + m.service : '') }),
      el('button', { class: 'btn btn-ghost btn-sm', style: 'margin-left:auto', text: '삭제', onclick: async () => {
        if (!confirm(ownerLabel(c.owner) + ' AWS 역할 자격을 삭제할까요?')) return;
        const body: any = { kind: 'aws_role_arn', scope_key: c.scope_key || '' };
        if (mem) body.member = mem;
        try { await api('/api/ui/org/credential/delete', { method: 'POST', body: JSON.stringify(body) }); toast('삭제됨'); reload(); }
        catch (e: any) { toast((e && e.message) || '삭제 실패', true); }
      } })));
  }
  if (!creds.length) rows.push(el('p', { class: 'admin-hint' }, ...uiText('등록된 AWS 역할이 없습니다.')));

  // ── 추가/오버라이드 폼 ──
  const targetSel = el('select', {},
    el('option', { value: '', text: '전원 기본 (조직 통합 · readonly 권장)' }),
    el('option', { value: 'member', text: '특정 구성원 오버라이드' })) as HTMLSelectElement;
  const member = memberCombo({ placeholder: '구성원 id 선택/검색 (예: daon)' });
  const memberField = field('대상 구성원', member.el);
  const arnIn = el('input', { type: 'text', placeholder: 'arn:aws:iam::123456789012:role/lively-readonly' });
  const regionSel = el('select', {}, ...AWS_REGIONS.map((r) => el('option', { value: r, text: r })));
  const serviceIn = el('input', { type: 'text', placeholder: 'execute-api (기본) — aws-mcp 엔드포인트 서명 대상' });
  const extIn = el('input', { type: 'text', placeholder: '역할 신뢰관계가 ExternalId 를 요구할 때만' });
  const scopeIn = el('input', { type: 'text', placeholder: '여러 역할을 등록할 때 구별할 이름' });
  const submit = el('button', { class: 'btn btn-primary', text: '저장' });
  const status = el('span', { class: 'admin-status' });

  const syncTarget = () => { memberField.style.display = targetSel.value === 'member' ? '' : 'none'; };
  targetSel.addEventListener('change', syncTarget); syncTarget();

  submit.addEventListener('click', async () => {
    if (!arnIn.value.trim()) { toast('역할 ARN 을 입력하세요', true); return; }
    const isOverride = targetSel.value === 'member';
    if (isOverride && !member.value()) { toast('오버라이드할 구성원을 선택하세요', true); return; }
    const meta: any = { role_arn: arnIn.value.trim(), region: regionSel.value };
    if (serviceIn.value.trim()) meta.service = serviceIn.value.trim();
    if (extIn.value.trim()) meta.external_id = extIn.value.trim();
    const body: any = { kind: 'aws_role_arn', scope_key: scopeIn.value.trim() || '', meta };
    if (isOverride) body.member = member.value();
    (submit as any).disabled = true; status.textContent = '저장 중…';
    try {
      await api('/api/ui/org/credential', { method: 'POST', body: JSON.stringify(body) });
      toast('저장됨'); reload();
    } catch (e: any) { status.textContent = ''; (submit as any).disabled = false; toast((e && e.message) || '저장 실패', true); }
  });
  rows.push(el('div', { class: 'card', style: 'padding:12px; margin-top:10px;' },
    cardHead('AWS 역할 등록 · 오버라이드'),
    field('적용 대상', targetSel), memberField,
    field('역할 ARN (role ARN)', arnIn), field('리전 (region)', regionSel),
    field('서명 서비스 (선택 · 기본 execute-api)', serviceIn), field('ExternalId (선택)', extIn), field('구분 이름 (선택)', scopeIn),
    el('div', { class: 'admin-actions', style: 'margin-top:10px' }, submit, status)));

  return el('div', { class: 'admin-section', style: 'margin-top:18px' }, el('h3', { class: 'admin-subhead', text: 'AWS 역할 (단기 자격)' }), ...rows);
}

export {
  AWS_REGIONS,
  CRED_KINDS,
  awsRoleCard,
  catalogStatusCard,
  credVaultCard,
  credentialsEditor,
  openGitCredentialManager,
  svcTokenForm,
};
