// v2/connect.ts — 새 셸 [외부 앱 연결] 화면 (#1719, 원준 2026-08-20).
//
// 왜 사이드바 일급 자리인가: 종전에 이 기능은 관리탭 안쪽([설정 ▸ 외부 서비스 관리])에만 있었다. 그런데
//  "AI가 내 노션·슬랙을 쓸 수 있나"는 **설정이 아니라 능력**이다 — 시키기 전에 알아야 하고, 안 되면 그
//  자리에서 켜야 한다. 관리탭 두 단계 뒤에 있으면 아무도 안 켜고, 안 켜면 AI가 할 수 있는 일이 반토막이다.
//
// 무엇을 재사용하나(새로 만들지 않은 것):
//  · 서비스 표(LOGIN_SERVICES)와 판정(partition) — me-logins.ts 한 곳. **표가 두 벌이 되면 조용히 어긋난다**
//    (admin-credentials.ts CRED_KINDS 주석이 같은 교훈을 이미 적어 뒀다).
//  · 브랜드 타일(svcTile) · 토큰 폼(svcTokenForm) · 슬랙 대화 정책(slackChannelPolicyCard) · git 자격 오버레이.
//  · 발급 방법·발급처 링크 — CRED_KINDS 의 help·docUrl 을 **그대로 읽는다**(내가 지어내면 틀린다).
//
// 구조: 목록(#/connect) → 앱 상세(#/connect/<key>). 한 화면에 다 펼치지 않는 이유 — 앱마다 설정이 다르고
//  (슬랙은 대화별 허용, 토큰형은 발급 안내) 그걸 목록에 다 펴면 12개가 스크롤 3배가 된다. 상세는 그 앱에
//  대한 **모든 것이 있는 한 자리**다: 지금 상태 · 무엇을 허용하는지 · 설정 · 연결/해제.
import { api, el, errorNote, relTime, toast, uiText } from '../core.js';
import { confirmDialog, skeleton } from '../ui-primitives.js';
import { svcTile } from '../svc-icons.js';
import { CRED_KINDS, openGitCredentialManager, svcTokenForm } from '../admin-credentials.js';
import { LOGIN_SERVICES, partition, slackChannelPolicyCard, type SvcView } from '../me-logins.js';
//  관리자 절반(조직에 앱 열기) — 같은 화면의 다른 층. 관리자가 아니면 통째로 null 이라 화면에 자국도 남지 않는다.
import { loadOrgMcp, orgAdminSection, presetOf, type OrgMcp } from './connect-admin.js';
import { overlay } from '../ui-primitives.js';

type Svc = (typeof LOGIN_SERVICES)[number];

// 화면이 그때그때 서버에서 읽는다 — 연결 상태는 서버에만 있고 셸 데이터(V2Data)에는 없다.
async function load(): Promise<{ v: SvcView; org: OrgMcp | null }> {
  const creds = await api('/api/ui/me/credentials');
  const oauth = await api('/api/ui/me/oauth/connectors').catch(() => ({ connectors: [] }));
  //  조직 쪽(등록된 MCP 서버·프리셋)은 **관리자에게만** 내려온다 — 아니면 null 이고 화면의 그 층이 사라진다.
  const org = await loadOrgMcp().catch(() => null);
  return { v: partition(oauth, creds), org };
}

//  ⚠ 표(LOGIN_SERVICES)만 뒤지면 안 된다 — 관리자가 등록한 커넥터는 서버에서 와서 v.all 에만 있다.
const findSvc = (v: SvcView, key: string): Svc | undefined =>
  (v.all as Svc[]).find((s) => s.key === key) || LOGIN_SERVICES.find((s) => s.key === key);

/** 이 앱이 지금 어떤 상태인가 — 세 갈래. 목록의 구역도, 상세의 문구도 이 하나로 갈린다. */
type State = 'on' | 'off' | 'blocked';
function stateOf(v: SvcView, svc: Svc): State {
  if (v.connected.some((s: Svc) => s.key === svc.key)) return 'on';
  if (v.blockedOAuth.some((s: Svc) => s.key === svc.key)) return 'blocked';
  return 'off';
}

// ══ 목록 (#/connect) ═══════════════════════════════════════════════════════════
export async function renderConnect(host: HTMLElement): Promise<void> {
  host.replaceChildren(el('div', { class: 'v2-center' }, skeleton('연결 상태를 불러오는 중')));
  let v: SvcView, org: OrgMcp | null;
  try { ({ v, org } = await load()); }
  catch (e) { host.replaceChildren(el('div', { class: 'v2-center' }, errorNote(e, '연결 상태를 불러오지 못했습니다'))); return; }
  //  관리자에게는 셋째 묶음이 '남에게 부탁할 것'이 아니라 **내가 지금 할 수 있는 일**이다 — 이름부터 바꾼다.
  const iAmAdmin = !!(org && org.admin);

  let q = '';
  const listHost = el('div', { class: 'cn-groups' });
  const search = el('input', {
    class: 'cn-find', type: 'search', placeholder: '앱 이름으로 찾기', 'aria-label': '앱 찾기',
    oninput: (e: any) => { q = String(e.target.value || '').trim().toLowerCase(); paint(); },
  }) as HTMLInputElement;

  // 요약 — 세 숫자가 이 화면의 전부다("몇 개 켜져 있나 · 더 켤 수 있나 · 내가 못 켜는 게 있나").
  const sum = el('div', { class: 'cn-sum' },
    el('span', { class: 'cn-sum-i on' }, el('b', { text: String(v.connected.length) }), el('span', { text: '연결됨' })),
    el('span', { class: 'cn-sum-i' }, el('b', { text: String(v.available.length) }), el('span', { text: '연결할 수 있음' })),
    ...(v.blockedOAuth.length ? [el('span', { class: 'cn-sum-i' }, el('b', { text: String(v.blockedOAuth.length) }),
      el('span', { text: iAmAdmin ? '내가 열 수 있음' : '관리자 필요' }))] : []),
    ...(iAmAdmin ? [el('span', { class: 'cn-sum-i cn-sum-adm' }, el('b', { text: String(org!.servers.length) }), el('span', { text: '조직에 열어 둠' }))] : []));

  function group(title: string, note: string, items: Svc[], st: State): HTMLElement | null {
    const hit = items.filter((s) => !q || s.label.toLowerCase().includes(q) || s.key.includes(q));
    if (!hit.length) return null;
    return el('section', { class: 'cn-group' },
      el('div', { class: 'cn-group-h' }, el('span', { class: 'v2-k', text: `${title} · ${hit.length}` }),
        el('span', { class: 'cn-group-note', text: note })),
      el('div', { class: 'cn-list' }, ...hit.map((s) => row(s, st))));
  }

  function row(svc: Svc, st: State): HTMLElement {
    const how = svc.oauth ? '계정 로그인' : '토큰';
    const meta = st === 'on' ? connMeta(v, svc)
      : st === 'blocked' ? (iAmAdmin
        ? (presetOf(org, svc.key) ? '조직에 열면 팀 전체가 쓸 수 있어요 — 내가 열 수 있습니다' : '조직에 열어야 해요 — 관리탭에서 직접 등록')
        : '관리자가 조직에 등록해야 연결할 수 있어요')
      : how + '으로 연결';
    return el('a', { class: 'cn-row' + (st === 'blocked' ? ' blocked' : ''), href: '#/connect/' + svc.key, title: svc.label },
      svcTile(svc.key, svc.label, st === 'on'),
      el('div', { class: 'cn-row-main' },
        el('div', { class: 't' }, el('span', { text: svc.label }),
          st === 'on' ? el('span', { class: 'cn-dot on', 'aria-label': '연결됨' }) : null),
        el('div', { class: 'm', text: meta })),
      el('span', { class: 'cn-row-go', 'aria-hidden': 'true', text: '›' }));
  }

  function paint(): void {
    const kids = [
      group('연결된 앱', 'AI가 지금 내 계정으로 쓸 수 있어요', v.connected, 'on'),
      group('연결할 수 있는 앱', '지금 바로 내가 켤 수 있어요', v.available, 'off'),
      group(iAmAdmin ? '아직 조직에 열지 않은 앱' : '관리자가 등록해야 하는 앱',
        iAmAdmin ? '열면 팀 전체가 각자 계정으로 연결할 수 있어요' : '내 힘으로는 켤 수 없어요', v.blockedOAuth, 'blocked'),
    ].filter(Boolean) as HTMLElement[];
    if (!kids.length) kids.push(el('p', { class: 'v2-empty', text: `'${q}' 와(과) 맞는 앱이 없어요.` }));
    listHost.replaceChildren(...kids);
  }
  paint();

  host.replaceChildren(el('div', { class: 'v2-wide v2-connect' },
    el('h1', { class: 'v2-title', text: '외부 앱 연결' }),
    el('p', { class: 'v2-desc' }, ...uiText('AI가 내 계정으로 쓸 수 있는 앱이에요. 연결은 **나에게만** 적용되고 팀에는 공유되지 않습니다.')),
    el('div', { class: 'cn-top' }, sum, search),
    listHost,
    // 레포 접근 — 같은 '외부 연결'인데 종전엔 관리탭에만 있었다. 개발 안 하면 안 건드려도 되는 것이라 맨 아래.
    el('section', { class: 'cn-group cn-extra' },
      el('div', { class: 'cn-group-h' }, el('span', { class: 'v2-k', text: '코드 저장소 접근' }),
        el('span', { class: 'cn-group-note', text: '개발자용 — 클론·푸시에 쓰는 SSH 키·토큰' })),
      el('button', { class: 'cn-row cn-row-btn', type: 'button', onclick: () => openGitCredentialManager('me') },
        el('span', { class: 'cn-git-ic', 'aria-hidden': 'true', text: '{ }' }),
        el('div', { class: 'cn-row-main' }, el('div', { class: 't', text: 'git 인증' }),
          el('div', { class: 'm', text: 'GitHub·GitLab 저장소에서 코드를 받아오고 올릴 때 씁니다' })),
        el('span', { class: 'cn-row-go', 'aria-hidden': 'true', text: '›' })))));
  window.setTimeout(() => search.focus(), 30);
}

/** 연결된 앱의 한 줄 메타 — 토큰형만 시각이 남는다(OAuth 커넥터 목록은 연결 여부만 알려준다). */
function connMeta(v: SvcView, svc: Svc): string {
  const cred = svc.token ? v.credMap.get(svc.token) : null;
  const bits: string[] = [svc.oauth && v.oauthMap.get(svc.oauth)?.connected ? '계정 로그인' : '토큰'];
  if (cred?.has_secret) {
    if (cred.scope_key) bits.push(cred.scope_key);
    if (cred.last_used_at) bits.push('마지막 사용 ' + relTime(cred.last_used_at));
    else if (cred.updated_at) bits.push('연결 ' + relTime(cred.updated_at));
  }
  return bits.join(' · ');
}

// ══ 앱 상세 (#/connect/<key>) ══════════════════════════════════════════════════
//  이 앱에 대한 모든 것이 여기 있다 — 상태 · 무엇을 허용하는지 · 발급 방법 · 설정 · 연결/해제.
export async function renderConnectApp(host: HTMLElement, key: string): Promise<void> {
  //  먼저 읽고 나서 앱을 찾는다 — 이 키가 표에 없는 커넥터일 수 있고, 그건 서버 응답에만 있다.
  host.replaceChildren(el('div', { class: 'v2-center' }, backLink(), skeleton('연결 상태를 불러오는 중')));
  let v: SvcView, org: OrgMcp | null;
  try { ({ v, org } = await load()); }
  catch (e) { host.replaceChildren(el('div', { class: 'v2-center' }, backLink(), errorNote(e, '연결 상태를 불러오지 못했습니다'))); return; }
  const svc = findSvc(v, key);
  if (!svc) { host.replaceChildren(el('div', { class: 'v2-center' }, backLink(), el('p', { class: 'v2-empty', text: '그런 앱이 없어요.' }))); return; }

  const st = stateOf(v, svc);
  const reload = () => { void renderConnectApp(host, key); };
  const oc = svc.oauth ? v.oauthMap.get(svc.oauth) : null;
  const cred = svc.token ? v.credMap.get(svc.token) : null;
  const viaOAuth = !!oc?.connected;
  const viaToken = !!cred?.has_secret;
  const spec = svc.token ? CRED_KINDS.find((x: any) => x.kind === svc.token) : null;

  // ── 동작 줄 ──
  const acts: HTMLElement[] = [];
  if (st === 'on') {
    if (viaOAuth) acts.push(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '다시 연결', onclick: () => void startOAuth(svc, reload) }));
    if (viaToken) acts.push(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '토큰 교체', onclick: () => openToken(svc, reload) }));
    acts.push(el('button', {
      class: 'btn-text btn-text-danger', type: 'button', text: '연결 해제',
      onclick: async () => {
        if (!await confirmDialog({
          title: svc.label + ' 연결을 해제할까요?', danger: true, confirmText: '연결 해제',
          message: 'AI가 이 앱을 내 계정으로 쓰지 못하게 됩니다.',
          note: '저장해 둔 로그인 정보가 지워집니다 — 다시 쓰려면 처음부터 연결해야 합니다.',
        })) return;
        try {
          if (viaOAuth) await api('/api/ui/me/oauth/disconnect', { method: 'POST', body: JSON.stringify({ server: svc.oauth }) });
          if (viaToken) await api('/api/ui/me/credential/delete', { method: 'POST', body: JSON.stringify({ kind: svc.token, scope_key: cred.scope_key || '' }) });
          toast('연결을 해제했습니다'); reload();
        } catch (e: any) { toast((e && e.message) || '해제하지 못했습니다', true); }
      },
    }));
  } else if (st === 'off') {
    acts.push(el('button', { class: 'btn btn-primary', type: 'button', text: svc.oauth ? '계정으로 연결' : '토큰으로 연결',
      onclick: () => { if (svc.oauth) void startOAuth(svc, reload); else openToken(svc, reload); } }));
  } else if (!(org && org.admin)) {
    // 관리자 필요 — 눌러도 안 되는 버튼을 내밀지 않는다. 대신 **그대로 전달할 수 있는 문장**을 복사해 준다.
    //  ⚠ 관리자에게는 이 버튼을 주지 않는다 — 자기가 열 수 있는데 자기에게 부탁 문구를 복사시키는 꼴이 된다.
    //   그 자리는 아래 '조직 설정' 구역(orgAdminSection)이 받는다.
    const ask = `라이블리에서 ${svc.label} 을(를) 쓰고 싶습니다. 관리 ▸ 외부 서비스에서 ${svc.label} 커넥터를 등록해 주세요.`;
    acts.push(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '요청 문구 복사',
      onclick: () => { void navigator.clipboard?.writeText(ask).then(() => toast('요청 문구를 복사했어요 — 관리자에게 그대로 보내세요')).catch(() => toast('복사하지 못했습니다', true)); } }));
  }

  // ── 사실 줄 — 화면이 아는 것만 쓴다(모르면 그 줄을 아예 안 쓴다) ──
  const facts: Array<[string, string]> = [];
  facts.push(['연결 방식', svc.oauth && svc.token ? '계정 로그인 또는 토큰' : svc.oauth ? '계정 로그인(그 서비스에서 동의)' : '토큰 붙여넣기']);
  facts.push(['적용 범위', '나만 — 팀에는 공유되지 않아요']);
  if (viaToken && cred?.scope_key) facts.push(['대상', String(cred.scope_key)]);
  if (viaToken && cred?.last_used_at) facts.push(['마지막 사용', relTime(cred.last_used_at)]);
  else if (viaToken && cred?.updated_at) facts.push(['연결한 때', relTime(cred.updated_at)]);

  // ── 설정 — 앱마다 다르다. 지금은 슬랙만(대화별 허용). 없으면 그 자리를 만들지 않는다. ──
  const settings: HTMLElement[] = [];
  //  조직 쪽 손잡이(관리자만) — 이 앱을 팀 전체에 열고 닫는 자리. 개인 설정보다 위에 둔다:
  //  아직 안 열린 앱이면 **여기가 먼저 해결돼야** 아래 내 연결이 의미를 갖는다.
  const orgSec = orgAdminSection(svc, org, reload);
  if (orgSec) settings.push(orgSec);
  //  #1881 "팀 자료로 모으기" — 관리자에게만. 연결이 곧 토큰이라 여기서 켜면 수집기가 그 연결로 돈다(관리탭·토큰 복사 없음).
  if (svc.key === 'slack' && st === 'on' && org && org.admin) settings.push(slackTeamCollectCard());
  if (svc.key === 'slack' && st === 'on') {
    settings.push(el('section', { class: 'cn-sec' },
      el('div', { class: 'cn-sec-h' }, el('span', { class: 'v2-k', text: '이 앱의 설정' })),
      el('div', { class: 'cn-slack' }, slackChannelPolicyCard())));
  }

  host.replaceChildren(el('div', { class: 'v2-wide v2-connect-app' },
    backLink(),
    el('div', { class: 'cn-head' },
      svcTile(svc.key, svc.label, st === 'on'),
      el('div', { class: 'cn-head-tt' },
        el('h1', { class: 'v2-title', text: svc.label }),
        el('div', { class: 'cn-head-st' + (st === 'on' ? ' on' : '') },
          st === 'on' ? [el('span', { class: 'cn-dot on', 'aria-hidden': 'true' }), el('span', { text: '연결됨' })]
            : st === 'off' ? el('span', { text: '연결 안 됨' })
            : el('span', { text: org && org.admin ? '아직 조직에 열지 않음' : '관리자가 등록해야 해요' })))),
    el('p', { class: 'v2-desc' }, ...uiText(svc.blurb)),
    el('div', { class: 'cn-acts' }, ...acts),
    // 아래 절반은 **두 칸**이다(넓은 화면에서만 — 좁으면 CSS 가 한 칸으로 되돌린다): 왼쪽 = 이 연결의 사실과
    //  발급 방법, 오른쪽 = 그 앱의 설정. 세로로 쌓으면 슬랙처럼 설정이 긴 앱은 사실 표가 화면 밖으로 밀린다.
    el('div', { class: 'cn-body' },
      el('div', { class: 'cn-col' },
        el('dl', { class: 'cn-facts' }, ...facts.flatMap(([k, val]) => [el('dt', { text: k }), el('dd', { text: val })])),
        // 발급 방법 — CRED_KINDS 의 help·docUrl 을 그대로 읽는다. 토큰형인데 아직 연결 안 했을 때 가장 막히는 자리다.
        ...(spec && (spec.help || spec.docUrl) && st !== 'on' ? [el('section', { class: 'cn-sec' },
          el('div', { class: 'cn-sec-h' }, el('span', { class: 'v2-k', text: '토큰 발급 방법' })),
          el('p', { class: 'cn-help' }, ...uiText(String(spec.help || ''))),
          ...(spec.docUrl ? [el('a', { class: 'btn btn-ghost btn-sm', href: spec.docUrl, target: '_blank', rel: 'noopener noreferrer', text: '발급 페이지 열기 ↗' })] : []))] : [])),
      ...(settings.length ? [el('div', { class: 'cn-col' }, ...settings)] : []))));
}

// ── 팀 자료로 모으기(#1881) — 슬랙 수집을 토글 하나로. 상태·토글·비공개 채널 안내를 한 카드에. ──
function slackTeamCollectCard(): HTMLElement {
  const body = el('div', { class: 'cn-help' }, ...uiText('불러오는 중…'));
  const box = el('section', { class: 'cn-sec' },
    el('div', { class: 'cn-sec-h' }, el('span', { class: 'v2-k', text: '팀 자료로 모으기' })),
    body);
  const paint = async (): Promise<void> => {
    let s: any;
    try { s = await api('/api/ui/org/slack/collect'); }
    catch (e) { body.replaceChildren(errorNote(e, '수집 상태를 불러오지 못했습니다')); return; }
    const chk = el('input', { type: 'checkbox' }) as HTMLInputElement;
    chk.checked = !!(s.search && s.search.enabled);
    const lab = el('label', { class: 'cn-toggle' }, chk, el('span', { text: ' 공개 채널의 대화를 팀 자료함에 자동으로 모읍니다' }));
    const notes: string[] = [];
    if (s.search && s.search.enabled) {
      notes.push((s.search.member ? `${s.search.member} 님의 연결로 모으고 있어요.` : '모으고 있어요.')
        + (s.search.member_connected === false ? ' 그 연결이 끊겼습니다 — 껐다 켜면 내 연결로 바뀝니다.' : ''));
    } else {
      notes.push('켜면 내 Slack 연결로 공개 채널을 읽어 옵니다. 팀원 모두의 AI가 그 자료를 찾아볼 수 있어요.');
    }
    notes.push(s.bot && s.bot.available
      ? (s.bot.enabled ? '비공개 채널도 모으려면 그 채널에서 `/invite @Lively` 를 입력하세요 — 초대된 채널만 읽습니다.'
                       : '비공개 채널은 켜면 함께 모읍니다 — 그 채널에서 `/invite @Lively` 로 초대한 것만.')
      : '비공개 채널까지 모으려면 Lively 봇이 필요해요 — [다시 연결]하면 봇이 함께 설치됩니다.');
    chk.onchange = async () => {
      chk.disabled = true;
      try {
        await api('/api/ui/org/slack/collect', { method: 'POST', body: JSON.stringify({ enabled: chk.checked }) });
        toast(chk.checked ? '팀 자료 모으기를 켰어요 — 첫 수집은 잠시 뒤 시작됩니다' : '팀 자료 모으기를 껐어요');
      } catch (e: any) { toast((e && e.message) || '바꾸지 못했습니다', true); }
      await paint();
    };
    body.replaceChildren(lab, ...notes.map((t) => el('p', { class: 'cn-help' }, ...uiText(t))));
  };
  void paint();
  return box;
}

function backLink(): HTMLElement {
  return el('a', { class: 'cn-back', href: '#/connect' }, el('span', { 'aria-hidden': 'true', text: '←' }), el('span', { text: '외부 앱 연결' }));
}

// ── 연결 동작 — me-logins 와 같은 경로다(엔드포인트·복귀 감지 모두). ──
//  OAuth 는 새 탭 동의 → **창 포커스 한 번**으로 복귀를 안다(타이머 폴링 없음): 이 탭으로 돌아온 순간이
//  곧 '동의가 끝났거나 그만뒀다'는 시점이라 그때 한 번만 다시 읽으면 충분하다.
async function startOAuth(svc: Svc, reload: () => void): Promise<void> {
  try {
    const r: any = await api('/api/ui/me/oauth/connect', { method: 'POST', body: JSON.stringify({ server: svc.oauth }) });
    const url = r && (r.authorization_url || r.url); // 서버는 authorization_url 을 준다(me-logins 와 동일) — r.url 만 보던 v2 는 늘 실패했다(#1881)
    if (r && r.authorized) { toast('이미 연결돼 있어요'); reload(); return; }
    if (url) {
      window.open(url, '_blank', 'noopener');
      toast('새 탭에서 ' + svc.label + ' 로그인을 마치면 이 화면이 자동으로 갱신됩니다');
      window.addEventListener('focus', () => reload(), { once: true });
    } else { toast('연결 주소를 받지 못했습니다', true); }
  } catch (e: any) { toast((e && e.message) || '연결을 시작하지 못했습니다', true); }
}

function openToken(svc: Svc, reload: () => void): void {
  const body = el('div', { style: 'min-width:460px; max-width:560px' });
  const back = overlay(svc.label + ' 토큰 등록', body);
  document.body.append(back);
  body.replaceChildren(svcTokenForm(String(svc.token), () => { back.remove(); reload(); }));
}
