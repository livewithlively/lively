// me-logins.ts — [내 설정 ▸ 외부 서비스 관리] 패널: 서비스 로그인 · 슬랙 대화별 열람/발송 정책 · 레포 접근
//  (#1313 R38, admin.ts 에서 verbatim 분리 / #1597 서비스 로그인 UI 전면 재설계).
//  토큰 입력 폼(svcTokenForm)과 git 자격 오버레이는 자격 금고(admin-credentials.ts) 소유를 그대로 받아 쓴다 —
//   CRED_KINDS 스펙 표를 여기서 다시 만들지 않는다(단일 거처).
//
// ── #1597 재설계 — 무엇을 왜 버렸나 ────────────────────────────────────────────────
//  구조: [서비스 탭] + [＋ 서비스 연결] 탭. 두 자리의 경계가 **연결 여부가 아니라 '조직이 그 서비스를
//   OAuth 로 등록해 뒀는가'** 였다. 그래서 아직 연결 안 한 Notion·Linear·Slack 은 탭에 있고, 역시 연결
//   안 한 GitHub·Figma 는 [＋] 뒤에 숨는 — 사용자가 설명할 수 없는 분할이 생겼다(사용자 지적).
//  또 탭은 한 번에 하나만 보여줘서 "지금 뭐가 켜져 있나"를 답하려면 탭을 전부 눌러 봐야 했다. 이 화면에서
//   사람이 하는 질문은 사실상 그거 하나다.
//  그래서 경계를 **연결됨 / 연결할 수 있음** 으로 다시 긋고, 둘 다 한 화면에 편다. [＋ 서비스 연결] 은
//   가리키는 대상이 없어져(연결 가능한 서비스가 이미 다 보인다) 사라진다.
//  아이콘은 이모지 대신 서비스별 브랜드 마크를 직접 그린다(svc-icons.ts) — 대시보드 알림 타일과 같은 형태 언어.
import { api, busy, cardHead, el, errorNote, relTime, toast, uiText } from './core.js';
import { confirmDialog, overlay, skeleton } from './ui-primitives.js';
import { sectionHead } from './admin-widgets.js';
import { openGitCredentialManager, svcTokenForm } from './admin-credentials.js';
import { svcTile } from './svc-icons.js';

// ── 지원 서비스 표 ──
//  blurb — '무엇을 허용하는 것인지'를 그대로 말한다(#1085). '나로서 …해요' 는 무슨 일이 벌어지는지 모호했다.
//  oauth = 조직이 등록해 둔 OAuth 커넥터(프록시 MCP 서버) 이름 · token = 내가 직접 붙여넣는 자격 종류.
const LOGIN_SERVICES: Array<{ key: string; label: string; icon: string; oauth?: string; token?: string; blurb: string }> = [
  { key: 'notion', label: 'Notion', icon: '📔', oauth: 'notion', blurb: 'AI가 내 Notion 계정에 로그인해서 직접 문서를 읽고 작성할 수 있습니다.' },
  { key: 'linear', label: 'Linear', icon: '📐', oauth: 'linear', blurb: 'AI가 내 Linear 계정에 로그인해서 직접 이슈를 보고 만들 수 있습니다.' },
  { key: 'slack', label: 'Slack', icon: '💬', oauth: 'slack', token: 'slack_user_token', blurb: 'AI가 내 Slack 계정에 로그인해서 직접 메시지를 검색하고 보낼 수 있습니다.' },
  { key: 'google-gmail', label: 'Gmail', icon: '✉️', oauth: 'google-gmail', blurb: 'AI가 내 Gmail 계정에 로그인해서 직접 메일을 읽고 보낼 수 있습니다.' },
  { key: 'google-drive', label: 'Google Drive', icon: '📁', oauth: 'google-drive', blurb: 'AI가 내 Google Drive 계정에 로그인해서 직접 파일을 읽을 수 있습니다.' },
  { key: 'google-calendar', label: 'Google 캘린더', icon: '📅', oauth: 'google-calendar', blurb: 'AI가 내 Google 캘린더 계정에 로그인해서 직접 일정을 확인할 수 있습니다.' },
  { key: 'github', label: 'GitHub', icon: '🐙', token: 'github_pat', blurb: 'AI가 내 GitHub 계정으로 이슈·PR·커밋을 읽고, 이슈를 만들거나 댓글을 답니다. 코드 저장소를 작업용으로 붙이는 것은 아래 [코드 저장소 접근]에서 따로 설정합니다.' },
  { key: 'gitlab', label: 'GitLab', icon: '🦊', oauth: 'gitlab', token: 'gitlab_pat', blurb: 'AI가 내 GitLab 계정으로 이슈·MR·파이프라인·위키를 다룹니다. [연결]은 AI 도구용 권한만 받습니다 — 저장소를 작업용으로 붙이는 것은 GitLab 정책상 별도 설정이 필요합니다.' },
  { key: 'clickup', label: 'ClickUp', icon: '🗂️', token: 'clickup_token', blurb: 'AI가 내 ClickUp 계정에 로그인해서 직접 작업을 확인할 수 있습니다.' },
  { key: 'figma', label: 'Figma', icon: '🎨', token: 'figma_token', blurb: 'AI가 내 Figma 계정에 로그인해서 직접 디자인을 읽을 수 있습니다.' },
  { key: 'prometheus', label: 'Prometheus', icon: '📊', token: 'prometheus_bearer', blurb: 'AI가 내 Prometheus 계정에 로그인해서 직접 지표를 조회할 수 있습니다.' },
  { key: 'claude-headless', label: 'Claude (헤드리스 실행)', icon: '🤖', token: 'claude_setup_token', blurb: '헤드리스 분류·에이전트 크론(claude -p)이 내 Claude 계정으로 인증·실행됩니다 — 터미널에서 `claude setup-token` 으로 발급한 토큰을 등록하세요(구독 크레딧 과금).' },
];

// ── 화면 상태 — 한 번 불러서 두 구역(연결됨/연결 가능)이 같은 사실을 본다 ──
interface SvcView {
  oauthMap: Map<string, any>;
  credMap: Map<string, any>;
  connected: any[];       // 지금 AI 가 쓸 수 있는 서비스
  available: any[];       // 내가 지금 바로 켤 수 있는 서비스
  blockedOAuth: any[];    // 관리자가 조직에 등록해야만 켤 수 있는 서비스(내 힘으로 안 되는 것)
  all: any[];             // 위 셋 전부 — 상세 화면(#/connect/<key>)이 키로 되찾을 때 쓴다
  /** #1675 ③ 헤드리스 자격의 마지막 실패(있으면). `{ at, label, task_id }`. */
  authFailure?: { at: string | null; label: string; task_id: number } | null;
}

/** 표에 없는 커넥터를 화면에 세울 최소 정보로 감싼다 — 관리자가 방금 등록한 앱이 여기로 들어온다. */
function svcFromConnector(server: string, c: any): any {
  //  이름: 커넥터 이름이 곧 사람이 아는 이름인 경우가 많다('notion' → 'Notion'). 아니면 관리자가 note 에 쓴다.
  const label = String(server || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()).trim() || server;
  const used = Array.isArray(c && c.used_by) && c.used_by.length ? ` (${c.used_by.join(', ')})` : '';
  return {
    key: server, label, icon: '',
    oauth: server,
    blurb: String((c && c.note) || `관리자가 조직에 등록한 앱이에요. 연결하면 AI가 내 ${label} 계정으로 직접 일할 수 있습니다.`) + used,
    dynamic: true,   // 표에 없던 것 — 로고가 없어 이름 첫 글자 타일로 그려진다
  };
}

function partition(oauth: any, creds: any): SvcView {
  const oauthMap = new Map<string, any>((oauth.connectors || []).map((c: any) => [c.server, c]));
  const credMap = new Map<string, any>((creds.credentials || []).filter((c: any) => c.kind !== 'aws_role_arn').map((c: any) => [c.kind, c]));
  const oauthOn = (s: any) => !!(s.oauth && oauthMap.get(s.oauth)?.connected);
  const tokenOn = (s: any) => !!(s.token && credMap.get(s.token)?.has_secret);
  // 내 힘으로 켤 수 있나 — OAuth 는 조직 등록이 선행돼야 하고, 토큰형은 내가 붙여넣으면 그만이다.
  const selfServe = (s: any) => !!((s.oauth && oauthMap.has(s.oauth)) || s.token);
  const connected: any[] = [], available: any[] = [], blockedOAuth: any[] = [];
  for (const s of LOGIN_SERVICES) {
    if (oauthOn(s) || tokenOn(s)) connected.push(s);
    else if (selfServe(s)) available.push(s);
    else blockedOAuth.push(s);   // OAuth 전용인데 조직 미등록 → 카드로 내밀면 눌러도 안 되는 버튼이 된다
  }
  // ── 표에 없는 커넥터도 흘려보내지 않는다(원준 2026-08-21) ────────────────────────────
  //  종전엔 이 반복문이 LOGIN_SERVICES 만 돌아서, **관리자가 새 MCP 서버를 등록해도 이 화면엔 안 떴다** —
  //  코드를 고쳐 표에 한 줄 넣어야 보였다. "내가 연결한 앱·안 한 앱을 하나하나 본다"는 이 화면의 약속과
  //  어긋난다. 그래서 서버가 내려준 커넥터 중 표가 못 덮는 것을 그대로 세운다(로고만 없을 뿐 연결은 된다).
  const covered = new Set(LOGIN_SERVICES.map((s) => s.oauth).filter(Boolean) as string[]);
  for (const [server, c] of oauthMap) {
    if (covered.has(server)) continue;
    const svc = svcFromConnector(server, c);
    (c && c.connected ? connected : available).push(svc);
  }
  // #1675 ③ — 헤드리스 자격이 마지막으로 **실패**한 기록(서버가 org_task 에서 뽑아 준다). 없으면 null.
  const authFailure = creds.headless_auth_failure ?? null;
  return { oauthMap, credMap, connected, available, blockedOAuth, authFailure, all: [...connected, ...available, ...blockedOAuth] };
}

// ── 화면 그리기 ──
//  host 하나를 통째로 다시 그린다(상태가 서버에 있고 화면엔 없어서, 부분 갱신할 게 없다).
async function renderServices(host: any) {
  // ⚠ 여기서 host.isConnected 로 '이미 화면을 떠났나'를 거르면 안 된다 — 관리탭 셸은 detach 된 detail 노드에
  //  **먼저 그린 다음** 붙인다(admin-shell.ts). 그래서 최초 렌더 시점의 host 는 항상 미부착이고, 그걸 거르면
  //  화면이 통째로 비어 버린다(실측). OAuth 복귀 focus 훅이 뒤늦게 부르는 경우는 {once:true} 라 1회뿐이고,
  //  미부착 노드에 그리는 건 무해하다 — 막을 값이 못 된다.
  busy(host, el('div', { class: 'card' }, skeleton('연결 상태를 불러오는 중')));
  let creds: any = { credentials: [] }, oauth: any = { connectors: [] };
  try {
    creds = await api('/api/ui/me/credentials');
    oauth = await api('/api/ui/me/oauth/connectors').catch(() => ({ connectors: [] }));
  } catch (e: any) { host.replaceChildren(errorNote(e, '내 로그인을 불러오지 못했습니다')); return; }

  const v = partition(oauth, creds);
  const reload = () => renderServices(host);
  host.replaceChildren(connectedCard(v, reload), availableCard(v, reload));
}

// ── 구역 1 · 연결된 서비스 ──
function connectedCard(v: SvcView, reload: () => void) {
  const refresh = el('button', { type: 'button', class: 'btn-text', text: '새로고침', onclick: reload });
  const card = el('div', { class: 'card' },
    cardHead('연결된 서비스',
      'AI가 지금 내 계정으로 쓸 수 있는 서비스입니다. 연결은 나에게만 적용되고, 토큰 값은 저장한 뒤 다시 볼 수 없습니다.',
      v.connected.length ? el('span', { class: 'head-badge', text: String(v.connected.length) }) : null,
      refresh));
  if (!v.connected.length) {
    card.append(el('div', { class: 'svc-empty' },
      el('span', { class: 'svc-empty-t', text: '아직 연결한 서비스가 없습니다.' }),
      el('span', { class: 'svc-empty-s' }, ...uiText('아래 [연결할 수 있는 서비스]에서 하나를 고르면 AI가 그 계정으로 일할 수 있습니다.'))));
    return card;
  }
  card.append(el('div', { class: 'svc-conn-list' }, ...v.connected.map((s) => connectedRow(s, v, reload))));
  return card;
}

function connectedRow(svc: any, v: SvcView, reload: () => void) {
  const oc = svc.oauth ? v.oauthMap.get(svc.oauth) : null;
  const cred = svc.token ? v.credMap.get(svc.token) : null;
  const viaOAuth = !!oc?.connected;
  const viaToken = !!cred?.has_secret;
  const box = el('div', { class: 'svc-conn' });
  const expand = el('div');   // 슬랙 대화 정책이 열리는 자리(닫혀 있으면 비어 있다)

  const acts: any[] = [];
  // 슬랙은 '연결했다 = 내 대화가 통째로 열렸다' 라서, 연결 다음에 할 일이 하나 더 있다(#1226). 그게 첫 동작.
  if (svc.key === 'slack') {
    const toggle = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '대화별 허용' });
    toggle.onclick = () => {
      if (expand.firstChild) { expand.replaceChildren(); toggle.textContent = '대화별 허용'; return; }
      expand.replaceChildren(el('div', { class: 'svc-expand' }, slackChannelPolicyCard()));
      toggle.textContent = '대화별 허용 닫기';
    };
    acts.push(toggle);
  }
  if (viaOAuth) {
    acts.push(el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '다시 연결', onclick: () => void startOAuth(svc, reload) }));
  }
  if (viaToken) {
    acts.push(el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '토큰 교체', onclick: () => openTokenForm(svc, reload) }));
  }
  acts.push(el('button', {
    type: 'button', class: 'btn-text btn-text-danger', text: '연결 해제',
    onclick: async () => {
      if (!await confirmDialog({
        title: svc.label + ' 연결을 해제할까요?', danger: true, confirmText: '연결 해제',
        message: 'AI가 이 서비스를 내 계정으로 쓰지 못하게 됩니다.',
        note: '저장해 둔 로그인 정보가 지워집니다 — 다시 쓰려면 처음부터 연결해야 합니다.',
      })) return;
      try {
        if (viaOAuth) await api('/api/ui/me/oauth/disconnect', { method: 'POST', body: JSON.stringify({ server: svc.oauth }) });
        if (viaToken) await api('/api/ui/me/credential/delete', { method: 'POST', body: JSON.stringify({ kind: svc.token, scope_key: cred.scope_key || '' }) });
        toast('연결을 해제했습니다'); reload();
      } catch (e: any) { toast((e && e.message) || '해제하지 못했습니다', true); }
    },
  }));

  // 메타 — 토큰형만 시각이 남는다(OAuth 커넥터 목록은 연결 여부만 알려준다). 없으면 아예 안 쓴다.
  const metaBits: string[] = [];
  if (viaToken && cred?.scope_key) metaBits.push(cred.scope_key);
  if (viaToken && cred?.last_used_at) metaBits.push('마지막 사용 ' + relTime(cred.last_used_at));
  else if (viaToken && cred?.updated_at) metaBits.push('연결 ' + relTime(cred.updated_at));

  // #1675 ③ — **이 토큰이 지금 살아 있나.** '마지막 사용'만으로는 성공했는지 실패했는지 알 수 없어서,
  //  토큰이 폐기돼도 이 화면은 멀쩡해 보였다(전면장애 때 사람이 그 사실을 알 길이 알림 하나뿐이었다).
  //  실패가 **마지막 등록보다 나중**일 때만 경고한다 — 다시 등록했으면 지난 실패는 이미 해결된 것이다.
  let authWarn: any = null;
  if (svc.key === 'claude-headless' && viaToken && v.authFailure) {
    const failAt = v.authFailure.at ? new Date(v.authFailure.at).getTime() : 0;
    const setAt = cred?.updated_at ? new Date(cred.updated_at).getTime() : 0;
    if (failAt > setAt) {
      authWarn = el('div', { class: 'svc-conn-blurb' },
        el('span', { class: 'pill pill-warn', text: '인증 실패' }),
        el('span', { text: ' ' + relTime(v.authFailure.at) + ' · ' + v.authFailure.label
          + ' — 내 계정으로 실행된 작업이 인증에 실패했습니다. 여기 등록한 토큰이 원인이라면'
          + ' `claude setup-token` 으로 다시 발급해 [토큰 교체]를 누르세요.'
          + ' 내 PC(노드)에서 실행된 작업이었다면 그 PC 의 Claude 로그인을 다시 하셔야 합니다 —'
          + ' 그 경우 이 안내는 30일 뒤 저절로 사라집니다.'
          + ' 이 실패로 멈춘 예약 작업이 있다면 관리 ▸ 자동화에서 다시 켜세요.' }));
    }
  }

  box.append(
    el('div', { class: 'svc-conn-row' },
      svcTile(svc.key, svc.label, true),
      el('div', { class: 'svc-conn-main' },
        el('div', { class: 'svc-conn-nm' },
          el('span', { text: svc.label }),
          el('span', { class: 'svc-state', text: '연결됨' }),
          metaBits.length ? el('span', { class: 'svc-meta', text: metaBits.join(' · ') }) : null),
        el('div', { class: 'svc-conn-blurb' }, ...uiText(svc.blurb)),
        authWarn),
      el('div', { class: 'svc-conn-acts' }, ...acts)),
    expand);
  return box;
}

// ── 구역 2 · 연결할 수 있는 서비스 ──
//  카드 전체가 [연결] 버튼이다 — 카드 안에 또 버튼을 넣으면 어디를 눌러야 하는지 두 번 판단하게 된다.
//  primary 버튼을 12개 늘어놓지 않는 이유도 같다(디자인시스템: 한 화면 동일 우선순위 primary 는 1개).
//  진짜 확정(토큰 저장·OAuth 동의)은 그 다음 단계에서 일어나고, primary 는 거기에 있다.
function availableCard(v: SvcView, reload: () => void) {
  const card = el('div', { class: 'card' },
    cardHead('연결할 수 있는 서비스',
      '아직 연결하지 않은 서비스입니다. 카드를 누르면 그 자리에서 연결이 시작됩니다 — Google·Notion처럼 계정 로그인으로 연결하는 서비스는 새 탭이 열리고, 나머지는 토큰을 붙여넣습니다.',
      v.available.length ? el('span', { class: 'head-badge', text: String(v.available.length) }) : null));
  if (!v.available.length) {
    card.append(el('div', { class: 'svc-empty' },
      el('span', { class: 'svc-empty-t', text: '연결할 수 있는 서비스를 모두 연결했습니다.' }),
      el('span', { class: 'svc-empty-s' }, ...uiText('새 서비스는 관리자가 조직에 등록하면 여기에 나타납니다.'))));
  } else {
    card.append(el('div', { class: 'svc-grid' }, ...v.available.map((s) => availableCardItem(s, reload))));
  }
  // 내 힘으로 못 켜는 것 — 목록에서 빼되, 왜 안 보이는지는 말해 준다(안 그러면 '왜 Gmail 이 없지?' 가 남는다).
  if (v.blockedOAuth.length) {
    card.append(el('p', { class: 'admin-hint', style: 'margin:12px 0 0' }, ...uiText(
      '관리자가 조직에 먼저 등록해야 연결할 수 있는 서비스는 목록에 없습니다 — '
      + v.blockedOAuth.map((s) => s.label).join(' · ') + '. 필요하면 관리자에게 요청하세요.')));
  }
  return card;
}

function availableCardItem(svc: any, reload: () => void) {
  const viaOAuth = !!svc.oauth;
  const btn = el('button', { type: 'button', class: 'svc-card' },
    el('span', { class: 'svc-card-top' }, svcTile(svc.key, svc.label, false), el('span', { class: 'svc-card-nm', text: svc.label })),
    el('span', { class: 'svc-card-blurb' }, ...uiText(svc.blurb)),
    el('span', { class: 'svc-card-cta', text: viaOAuth ? '계정으로 연결 →' : '토큰으로 연결 →' }));
  btn.onclick = () => { if (viaOAuth) void startOAuth(svc, reload); else openTokenForm(svc, reload); };
  return btn;
}

// ── 연결 동작 ──
//  OAuth — 새 탭에서 동의를 받고 온다. 돌아왔는지는 타이머로 캐묻지 않고 **창 포커스 한 번**으로 안다:
//   사용자가 이 탭으로 돌아오는 순간이 곧 '동의 끝났거나 그만뒀다' 는 시점이라, 그때 한 번만 다시 읽으면 된다.
async function startOAuth(svc: any, reload: () => void) {
  try {
    const r = await api('/api/ui/me/oauth/connect', { method: 'POST', body: JSON.stringify({ server: svc.oauth }) });
    if (r.authorized) { toast('이미 연결되어 있습니다'); reload(); return; }
    window.open(r.authorization_url, '_blank', 'noopener');
    toast('새 탭에서 로그인하고 동의하세요 — 끝나고 이 화면으로 돌아오면 자동으로 반영됩니다');
    window.addEventListener('focus', () => reload(), { once: true });
  } catch (e: any) { toast((e && e.message) || '연결을 시작하지 못했습니다', true); }
}

// 토큰 — 모달로 받는다. 인라인으로 펼치면 그리드가 밀려 다른 카드 위치가 흔들린다.
function openTokenForm(svc: any, reload: () => void) {
  const host = el('div', { class: 'svc-form-host', style: 'min-width:min(460px, 78vw)' });
  const back = overlay(svc.label + ' 연결', host);
  host.append(svcTokenForm(svc.token, () => { back.remove(); reload(); }));
}

// ── [Slack] 대화별 열람·발송 허용(#1226 · 기본값 재설계 #1262) ──
//  체크를 끄면 그 대화는 AI 의 슬랙 호출에서 걸러진다(게이트웨이가 요청을 막고 응답에서 지운다).
//  #1262: **기본값이 대화 종류로 갈린다** — 공개 채널은 열려 있고, 비공개·그룹DM·DM 은 닫혀 있다.
//   그래서 화면이 '지금 켜져 있나' 만 보여주면 부족하다. 왜 그 상태인지(기본값인지 내가 바꾼 건지)를 같이
//   보여줘야 하고, **규칙 자체를 화면에서 설명해야 한다** — 이건 슬랙 기능이 아니라 우리가 만든 동작이라,
//   설명이 없으면 사람은 "왜 AI 가 이 채널을 못 읽지?" 를 알아낼 방법이 아예 없다.
const CH_TYPE_LABEL: Record<string, string> = { public: '공개', private: '비공개', group_dm: '그룹 DM', dm: 'DM', unknown: '목록 밖' };

// 규칙 설명 — 기술 용어 없이. '무엇이 기본인지 · 왜 그런지 · 새로 생기는 대화는 어떻게 되는지' 세 가지를 답한다.
function channelRuleExplainer() {
  const rule = (icon: string, title: string, body: string) => el('div', { style: 'display:flex; gap:9px; align-items:flex-start; padding:7px 0' },
    el('span', { style: 'font-size:15px; line-height:1.35', text: icon }),
    el('span', { style: 'display:flex; flex-direction:column; gap:1px' },
      el('span', { class: 'mini-title', text: title }),
      el('span', { class: 'mini-meta' }, ...uiText(body))));
  return el('div', { style: 'margin:0 0 12px' },
    el('p', { class: 'admin-hint', style: 'margin:0 0 4px' }, ...uiText(
      '슬랙은 “이 채널만 빼고” 같은 권한을 주지 않습니다 — 한 번 연결하면 내가 볼 수 있는 대화가 통째로 열려요. '
      + '그래서 라이블리가 대신 걸러 줍니다. 아무것도 설정하지 않아도 아래 규칙이 자동으로 적용됩니다.')),
    rule('🌐', '공개 채널 — 처음부터 열려 있어요',
      'AI 가 읽고 보낼 수 있습니다. 워크스페이스 사람이면 누구나 볼 수 있는 대화라 기본을 열어 둡니다. 보여주고 싶지 않으면 체크를 끄세요.'),
    rule('🔒', '비공개 채널 · 그룹 DM · 1:1 DM — 처음부터 닫혀 있어요',
      'AI 가 읽지도, 보내지도 못합니다. 필요한 대화만 직접 체크를 켜서 여세요.'),
    el('p', { class: 'admin-hint', style: 'margin:6px 0 0' }, ...uiText(
      '나중에 새로 만들어지거나 새로 초대된 대화도 같은 규칙을 따릅니다 — 비공개 대화는 내가 직접 켜기 전까지 계속 닫혀 있어요. '
      + '연결만 해 두고 잊어버려도 사적인 대화가 새지 않습니다.')));
}

function slackChannelPolicyCard() {
  const listBox = el('div', { class: 'svc-list' });
  const summary = el('p', { class: 'admin-hint', style: 'margin:0 0 10px' }, ...uiText('불러오는 중…'));
  const search = el('input', { type: 'search', placeholder: '채널 이름으로 찾기', style: 'max-width:260px' });
  const notice = el('div');
  let all: any[] = [];

  const label = (c: any) => (c.type === 'dm' || c.type === 'group_dm' ? c.name : '#' + String(c.name || '').replace(/^#/, ''));
  const isDefault = (c: any) => c.allow_read === c.default_read && c.allow_write === c.default_write;
  let connected = true;
  const paint = () => {
    // '목록이 비었다'를 '전부 허용'이라고 말하면 거짓 안심이 된다 — 연결이 없어서 못 읽은 것과 구분한다.
    if (!connected) { summary.replaceChildren(...uiText('슬랙 연결을 확인하지 못했습니다 — 위에서 [연결]을 마치면 내가 속한 대화가 여기에 뜹니다.')); return; }
    if (!all.length) { summary.replaceChildren(...uiText('내가 속한 대화를 찾지 못했습니다. 슬랙에서 채널에 참여한 뒤 [새로고침]하세요.')); return; }
    // 사람이 알고 싶은 건 '몇 개가 AI 에게 열려 있나' 다. 닫힌 개수는 그 나머지로 자연히 읽힌다.
    const open = all.filter((c) => c.allow_read).length;
    const closed = all.length - open;
    summary.replaceChildren(...uiText(
      `대화 ${all.length}개 중 AI 가 읽을 수 있는 건 ${open}개입니다`
      + (closed ? ` — 나머지 ${closed}개는 닫혀 있어요.` : '.')));
  };
  const rowOf = (c: any) => {
    const mk = (checked: boolean) => { const b = el('input', { type: 'checkbox' }); b.checked = checked; return b; };
    const readChk = mk(c.allow_read), writeChk = mk(c.allow_write);
    const badges = el('span', { style: 'display:inline-flex; gap:4px; align-items:center' });
    const resetWrap = el('span');
    const paintRow = () => {
      badges.replaceChildren(
        el('span', { class: 'pill', text: CH_TYPE_LABEL[c.type] || c.type }),
        // 기본값 그대로면 굳이 배지를 달지 않는다(대부분이 그 상태라 시끄럽기만 하다).
        ...(isDefault(c) ? [] : [el('span', { class: 'pill', text: '직접 설정' })]));
      resetWrap.replaceChildren(...(isDefault(c) ? [] : [el('button', {
        class: 'btn-text', text: '기본값으로',
        onclick: () => { readChk.checked = c.default_read; writeChk.checked = c.default_write; void save(); },
      })]));
    };
    const save = async () => {
      readChk.disabled = writeChk.disabled = true;
      try {
        await api('/api/ui/me/channel-policy', { method: 'POST', body: JSON.stringify({
          system: 'slack', channel_id: c.id, channel_name: c.name,
          // 대화 종류 — 서버가 '기본값과 같아졌는지'를 판정하고, 집행 때 쓸 종류 캐시도 이 값으로 채운다.
          channel_type: c.type,
          // DM 은 상대 user_id 도 보낸다 — 슬랙이 DM 을 U… 로도 열어서, 이게 없으면 그 경로로 차단이 뚫린다.
          ...(c.peer_id ? { peer_id: c.peer_id } : {}),
          allow_read: readChk.checked, allow_write: writeChk.checked }) });
        c.allow_read = readChk.checked; c.allow_write = writeChk.checked;
        paintRow(); paint();
      } catch (e: any) {
        readChk.checked = c.allow_read; writeChk.checked = c.allow_write;   // 저장 실패 = 화면도 되돌린다(거짓 안심 방지)
        toast((e && e.message) || '저장하지 못했습니다', true);
      }
      readChk.disabled = writeChk.disabled = false;
    };
    readChk.addEventListener('change', () => void save());
    writeChk.addEventListener('change', () => void save());
    const box = (chk: any, text: string) => el('label', { style: 'display:inline-flex; align-items:center; gap:5px; font-size:12.5px; color:var(--ink-sub); cursor:pointer' }, chk, el('span', { text }));
    paintRow();
    return el('div', { class: 'svc-item' },
      el('span', { class: 'svc-item-main' },
        el('span', { class: 'mini-title' }, el('span', { text: label(c) }), badges),
        c.from_policy ? el('span', { class: 'mini-meta' }, ...uiText('지금 내 대화 목록엔 없습니다(나갔거나 권한 밖) — 설정만 남아 있어요.')) : null),
      el('span', { class: 'svc-item-actions' }, resetWrap, box(readChk, '열람'), box(writeChk, '발송')));
  };
  const draw = () => {
    const q = String(search.value || '').trim().toLowerCase();
    const rows = all.filter((c) => !q || String(c.name || '').toLowerCase().includes(q) || String(c.id).toLowerCase().includes(q));
    listBox.replaceChildren(...(rows.length ? rows.map(rowOf) : [el('p', { class: 'admin-hint', style: 'margin:0' }, ...uiText('찾는 대화가 없습니다.'))]));
  };
  search.addEventListener('input', draw);

  const load = async () => {
    let d: any;
    try { d = await api('/api/ui/me/slack/channels'); }
    catch (e: any) { summary.replaceChildren(); listBox.replaceChildren(errorNote(e, '대화 목록을 불러오지 못했습니다')); return; }
    all = d.channels || [];
    connected = d.connected !== false;
    const notes: any[] = [];
    // 목록을 못 받은 경우에도 이미 저장된 설정은 보여 준다 — 그래야 잘못 걸어 둔 차단을 풀 수 있다.
    if (d.error) notes.push(el('p', { class: 'admin-hint', style: 'margin:0 0 8px' }, ...uiText('슬랙에서 대화 목록을 받지 못했습니다(' + d.error + '). 아래는 이미 저장해 둔 설정입니다.')));
    if (d.warning) notes.push(el('p', { class: 'admin-hint', style: 'margin:0 0 8px' }, ...uiText(d.warning)));
    notice.replaceChildren(...notes);
    paint(); draw();
  };
  void load();

  // 카드가 아니라 '연결된 슬랙 행에 딸린 상세' 다 — 카드 안 카드를 만들지 않는다(디자인시스템 금지 §9).
  return el('div', {},
    cardHead('대화별 열람 · 발송 허용', 'AI 가 내 슬랙에서 무엇을 읽고 어디로 보낼 수 있는지 대화 단위로 정합니다. 여기서 끄면 게이트웨이가 AI 의 슬랙 요청에서 그 대화를 걸러냅니다.'),
    channelRuleExplainer(),
    notice, summary,
    el('div', { class: 'admin-actions', style: 'margin:0 0 10px' }, search, el('button', { class: 'btn-text', text: '새로고침', onclick: () => void load() })),
    el('div', { style: 'max-height:420px; overflow:auto' }, listBox));
}

// ── [내 설정 ▸ 외부 서비스 관리] — member_secret vault + OAuth 연결 + git 인증 ──
async function myLoginsSection(detail) {
  // 제목은 카드 밖에 고정하고, 서비스 카드 두 장만 안쪽 host 가 다시 그린다.
  const svcHost = el('div', { class: 'admin-stack' });
  const gitCard = el('div', { class: 'card' },
    cardHead('리포지토리 접근', '코드 저장소(GitHub·GitLab)에서 클론·푸시할 때 쓰는 SSH 키·토큰입니다. 코드 작업을 하지 않으면 설정하지 않아도 됩니다.', el('span', { class: 'head-badge head-badge-aud', text: '개발자용' })),
    el('div', { class: 'admin-actions' },
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'git 인증 관리', onclick: () => openGitCredentialManager('me') })));
  detail.replaceChildren(
    sectionHead('외부 서비스 관리', 'AI가 내 계정으로 외부 서비스를 쓸 수 있게 연결하고, 연결한 뒤 어디까지 허용할지 정합니다. 여기 설정은 나에게만 적용되고 팀에는 공유되지 않습니다.'),
    el('div', { class: 'admin-stack' }, svcHost, gitCard));
  await renderServices(svcHost);
}

export {
  CH_TYPE_LABEL,
  LOGIN_SERVICES,
  channelRuleExplainer,
  myLoginsSection,
  partition,          // #1719 새 셸 [외부 앱 연결](v2/connect.ts)이 **같은 판정**을 쓴다 — 표도 술어도 두 벌이 되면 어긋난다
  renderServices,     // #1898 내 프로필 창 [외부 서비스] 탭(v2/me-modal.ts)이 **이 본체를 그대로** 쓴다
  slackChannelPolicyCard,
};
export type { SvcView };
