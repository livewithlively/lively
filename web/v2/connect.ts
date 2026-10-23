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
import { api, el, errorNote, hasScope, relTime, state, sv, toast, uiText } from '../core.js';
import { confirmDialog, skeleton } from '../ui-primitives.js';
import { svcTile } from '../svc-icons.js';
import { iconPath } from '../lib/icon-paths.js';   // #4233 선 아이콘 한 벌
import { CRED_KINDS, openGitCredentialManager, svcTokenForm } from '../admin-credentials.js';
import { LOGIN_SERVICES, partition, slackChannelPolicyCard, type SvcView } from '../me-logins.js';
//  #3778 — 상세 «연결 두 가지» 의 잣대(순수). 화면은 그리기만 하고 판정은 저기서 한다(그래서 시험된다).
import { appAxes, collectTally, pendingAxes, skipKey,
  type AppAxes, type CollectTally } from '../lib/connect-axes.js';
import { shellPrefStore, shellPrefsTouch } from './shell-prefs.js';   // #2460 — «사람이 고른 것»의 정본은 서버다
import { NOTION_PICK_TIP, notionCollectedLine, notionCollectedPages } from './notion-pick.js';   // #1968 — 노션 고르기 안내·모은 페이지 수(처음 설정과 한 벌)
import { outlookAdminConsentBox } from './outlook-admin.js';   // #4211 — 회사 계정 «관리자 허용» 안내(세 화면이 한 벌)
import { appRows, loadConnectStatus, routesSection, type ConnectAppStatus, type ConnectStatus } from './connect-routes.js';   // #4970 — 앱마다 연결 길(목록 한 줄 · 상세 길 칸 · 앱 등록)
import { openConnectSession, ownAiStepsHtml, wireOwnAiSteps } from './connect-own-ai.js';   // #4970 — [연결 도와줘](처음 설정의 [연결할게요]와 한 벌)
//  #2556 — 관리탭 [데이터 연결] 묶음을 여기로 걷어 왔다. 화면만 옮겼고 **패널은 그것 그대로 부른다**(사본 0):
//   레포·DB 는 아래 [코드와 데이터] 두 화면이, 아웃바운드 둘은 노션·클릭업 **앱 상세의 [내보내기] 칸**이 편다.
//   그 패널들은 host 에 붙은 표식(markEmbedded)을 보고 자기 제목만 접는다 — 저장 경로·조회 경로는 한 벌.
import { loadAdmin } from '../admin-rerender.js';
import { markEmbedded } from '../admin-widgets.js';
import { reposPanel } from '../admin-repos.js';
import { dbSourceEditor } from '../admin-db-sources.js';
import { feedTargetsEditor, projectOutboundEditor } from '../admin-outbound.js';
//  #2243 — 조직 층(connect-admin.ts 의 «조직에 열기» 카드)은 이 화면에서 뺐다. 셀프서브 앱에서 «조직이 열었나»는 사용자의
//   세계관이 아니고(원준 2026-08-28), 관리자의 도구 발행·닫기는 관리 ▸ AI 능력 ▸ AI 도구에 그대로 있다.
import { overlay } from '../ui-primitives.js';

type Svc = (typeof LOGIN_SERVICES)[number];

// 화면이 그때그때 서버에서 읽는다 — 연결 상태는 서버에만 있고 셸 데이터(V2Data)에는 없다.
async function load(): Promise<{ v: SvcView }> {
  const creds = await api('/api/ui/me/credentials');
  const oauth = await api('/api/ui/me/oauth/connectors').catch(() => ({ connectors: [] }));
  return { v: partition(oauth, creds) };
}

/**
 * 두 번째 축 — «자료 가져오기»가 앱마다 켜져 있나 (#3778).
 *  ⚠ 앱마다 `/api/ui/org/<app>/collect` 를 부르면 목록 한 장에 여덟 번 왕복이다. 목록은 수집기 레지스트리를
 *   **한 번** 읽어 preset 으로 앱에 배분한다(그 창구는 인증만 있으면 읽힌다 — scope null).
 *  못 읽어도 화면을 비우지 않는다: 빈 표면 카드가 «아직 꺼짐» 으로 떨어지는 대신, 아래 axesOf 가 그 사실을
 *   숨기지 않도록 목록 머리에 한 줄을 띄운다(collectErr).
 */
async function loadCollect(): Promise<{ tally: Map<string, CollectTally>; ok: boolean }> {
  try {
    const r: any = await api('/api/ui/org/collectors');
    return { tally: collectTally(r?.collectors), ok: true };
  } catch (_) { return { tally: new Map(), ok: false }; }
}

// ══ «이 축은 안 쓴다» 는 결정 (#3778, 원준 2026-09-20) ═══════════════════════════
//  수집기는 흔히 저절로 생기므로 «둘 중 하나만 켜진» 상태가 사실상 기본값이다. 그걸 «연결됨» 한 칸에
//  섞어 두면 **덜 끝난 것이 끝난 것처럼** 보인다. 그래서 그 상태를 「연결 중」으로 따로 세우고, 끝내는
//  길을 둘 준다 — 나머지를 켜거나, «안 쓴다»고 정하거나. 정한 것은 미완이 아니므로 둘 다 「연결 완료」다.
//  ⚠ 이건 **정책이 아니라 표시**다 — «안 쓴다»가 서버의 무엇도 끄지 않는다(끄는 건 그 축의 스위치다).
//   그래서 계정에 묶인 개인 결정으로 둔다(기기마다 다시 정하게 하면 그게 더 이상하다).
const SKIP_STORE = shellPrefStore('lively_v2_connect_skip', 'list');
function loadSkip(): Set<string> {
  try { const a = JSON.parse(localStorage.getItem(SKIP_STORE) || '[]'); return new Set<string>(Array.isArray(a) ? a : []); }
  catch (_) { return new Set<string>(); }
}
function saveSkip(s: Set<string>): void {
  try { if (s.size) localStorage.setItem(SKIP_STORE, JSON.stringify([...s])); else localStorage.removeItem(SKIP_STORE); }
  catch (_) { /* 못 남겨도 이번 화면은 된다 */ }
  shellPrefsTouch(SKIP_STORE);   // 캐시는 즉시, 서버는 디바운스(#2460)
}
/** 축의 이름 — 목록 카드·상세·결정 줄이 **한 벌로** 쓴다. 한 사실을 세 자리가 다르게 부르면 안 된다. */
const AXIS_LABEL: Record<'use' | 'get', string> = { use: '내 계정으로 직접 사용', get: '자료 가져오기' };


//  ⚠ 표(LOGIN_SERVICES)만 뒤지면 안 된다 — 관리자가 등록한 커넥터는 서버에서 와서 v.all 에만 있다.
const findSvc = (v: SvcView, key: string): Svc | undefined =>
  (v.all as Svc[]).find((s) => s.key === key) || LOGIN_SERVICES.find((s) => s.key === key);

/** 이 앱이 지금 어떤 상태인가 — 세 갈래. 목록의 구역도, 상세의 문구도 이 하나로 갈린다. */
type State = 'on' | 'off' | 'blocked';
function stateOf(v: SvcView, svc: Svc): State {
  //  ★ «켜져 있나»는 목록 배치가 아니라 **자격 원본**으로 판정한다. 준비 중이 목록에서 connected 를 이기므로
  //   배치로 물으면 이미 연결해 둔 앱이 상세에서 «준비 중»이 돼 스위치가 잠긴다 — 돌고 있는 것을 못 끄게 된다.
  if ((svc.oauth && v.oauthMap.get(svc.oauth)?.connected) || (svc.token && v.credMap.get(svc.token)?.has_secret)) return 'on';
  if (v.connected.some((s: Svc) => s.key === svc.key)) return 'on';
  if (v.blockedOAuth.some((s: Svc) => s.key === svc.key)) return 'blocked';
  if (v.soon.some((s: Svc) => s.key === svc.key)) return 'blocked';   // #2243 카탈로그가 준비 중이라 한 앱도 같은 자리
  return 'off';
}

// ══ 목록 (#/connect) ═══════════════════════════════════════════════════════════
//  #4970 — 앱마다 한 줄(어떤 길로 연결돼 있나 · 다음 걸음)은 connect-routes.ts 가 그린다. 여기엔 그 밖의 칸(표에 없는 앱 ·
//   코드와 데이터 · 상태를 못 읽었을 때의 앱 줄)만 남는다. 종전 «진열대» 카드(#2243 안 2)와 두 축 카드(#3778)는 걷었다.
/** 우리 자산(코드 저장소·데이터베이스) 타일 — 앱 타일과 같은 라운드 스퀘어에 우리 색. 글자 «{ }»·«DB» 를 쓰지 않는다. */
function assetTile(ic: string): HTMLElement {
  return el('span', { class: 'svc-tile cn-asset-tile', 'aria-hidden': 'true' }, icon(ic));
}

//  ★ #4970(상민님 2026-10-23) — 목록은 앱마다 한 줄: «어떤 길로 연결돼 있나 · 내가 할 다음 걸음». 길과 상태는 서버(org_connect_status)가
//   정하고 connect-routes.ts 가 그린다. 종전 맨 위 «앱 × 구성원» 표(T13)는 앱 상세의 Claude 길 칸으로, 두 축 카드(#3778)는 상세의
//   «연결 두 가지» 로 옮겼다 — 목록이 답할 물음은 «이 앱은 지금 어떻게 이어져 있고, 나는 무엇을 하면 되나» 하나다.
export async function renderConnect(host: HTMLElement): Promise<void> {
  host.replaceChildren(el('div', { class: 'v2-center' }, skeleton('연결 상태를 불러오는 중')));
  //  내 연결 표(me-logins)도 같이 읽는다 — 관리자가 등록한 «표에 없는 앱»(원준 2026-08-21 «흘려보내지 않는다»)과,
  //   연결 상태를 못 읽었을 때 앱 상세로 들어갈 줄이 거기서 나온다.
  const [status, view] = await Promise.all([
    loadConnectStatus().catch(() => null),
    load().then((r) => r.v).catch(() => null),
  ]);

  let q = '';
  const listHost = el('div', { class: 'cn-groups' });
  const paint = (): void => { listHost.replaceChildren(appRows(status, q), ...otherRows(view, status, q)); };
  const search = el('input', {
    class: 'cn-find', type: 'search', placeholder: '앱 이름으로 찾기', 'aria-label': '앱 찾기',
    oninput: (e: any) => { q = String(e.target.value || '').trim().toLowerCase(); paint(); },
  }) as HTMLInputElement;
  paint();

  const groupHead = (title: string, note: string): HTMLElement =>
    el('div', { class: 'cn-gh' }, el('b', { text: title }), el('span', { class: 'h', text: note }));
  //  앱이 아니라 **우리 자산**을 잇는 자리(#2556) — 코드 저장소와 데이터베이스. 앱 목록과 섞지 않고 그 아래 별도 묶음으로 둔다.
  const gitCard = assetCard('_git', 'repo', '코드 저장소', '우리 저장소를 등록하고, 코드를 받아오고 올릴 때 쓰는 열쇠를 둡니다');
  const dbCard = hasScope('admin')
    ? assetCard('_db', 'db', '데이터베이스', 'AI가 조회할 수 있는 데이터베이스를 등록하고 어디까지 보여줄지 정합니다')
    : null;
  host.replaceChildren(el('div', { class: 'v2-wide v2-connect' },
    el('h1', { class: 'v2-title', text: '외부 앱 연결' }),
    //  ★ #4970 — 맨 위는 «연결을 시작하는 문» 이다. 처음 설정의 [연결할게요]와 같은 문: 서버에 로그인된 AI 가 있으면 연결 스킬(liv-connect)을
    //   부르는 대화를 열고, 없으면 «쓰는 AI 에서 하기» 세 걸음을 이 자리에 그린다.
    connectStarter(),
    el('p', { class: 'v2-desc', text: '앱마다 지금 어떻게 연결돼 있는지와 내가 할 다음 걸음을 보여 줘요. 앱을 누르면 연결하는 길을 권하는 순서대로 볼 수 있어요.' }),
    el('div', { class: 'cn-top' }, search),
    listHost,
    //  목록에 없는 앱 — 라이블리 전용 연결이 없어도 길이 있다(키로 읽기 · 웹훅 · 파일). 앱마다 되는 길이 달라 AI 가 그 앱 문서를 읽고 찾는다(liv-connect 4).
    el('p', { class: 'v2-desc cn-rt-other', text: '목록에 없는 앱도 [연결 도와줘]를 누르고 앱 이름을 말하면, AI 가 그 앱에서 되는 길(키로 읽어 오기 · 웹훅으로 받기 · 파일 올리기)을 찾아 한 걸음씩 도와드려요.' }),
    el('section', { class: 'cn-group cn-extra' },
      groupHead('코드와 데이터', '앱이 아니라 우리 코드 저장소와 데이터베이스를 잇습니다'),
      el('div', { class: 'cn-cards' }, gitCard.node, ...(dbCard ? [dbCard.node] : [])))));
  //  개수는 화면이 선 뒤에 채운다 — 목록을 여는 속도가 관리 데이터 조회에 매달리면 안 된다(실패해도 카드는 산다).
  void fillGitCounts(gitCard.stat);
  if (dbCard) void fillDbCount(dbCard.stat);
}

/**
 * (#4970) 길 목록(org_connect_status 의 앱 아홉) 밖의 줄.
 *  · 관리자가 등록한 «표에 없는 앱»(svcFromConnector — dynamic) — AI 가 내 계정으로 직접 쓰는 연결이라 자료를 모으는 길은 없다.
 *  · 연결 상태를 못 읽었을 때(권한 · 서버 오류) — 앱마다 상세로 들어갈 줄만(거짓 «연결 전» 을 만들지 않는다).
 */
function otherRows(view: SvcView | null, status: ConnectStatus | null, q: string): HTMLElement[] {
  if (!view) return [];
  const hit = (s: Svc): boolean => !q || s.label.toLowerCase().includes(q) || s.key.includes(q);
  const isOn = (s: Svc): boolean => (view.connected as Svc[]).some((x) => x.key === s.key);
  const row = (s: Svc, word: string): HTMLElement => el('a', { class: 'cn-row cn-rt-row b-off', href: '#/connect/' + encodeURIComponent(s.key), title: s.label },
    svcTile(s.key, s.label, true),
    el('span', { class: 'cn-row-main' },
      el('span', { class: 't' }, el('span', { text: s.label }), isOn(s) ? el('span', { class: 'cn-dot on', 'aria-label': '연결됨' }) : null),
      el('span', { class: 'm cn-rt-word', text: word })),
    el('span', { class: 'cn-row-go', 'aria-hidden': 'true', text: '›' }));
  const group = (title: string, note: string, items: HTMLElement[]): HTMLElement => el('section', { class: 'cn-group' },
    el('div', { class: 'cn-gh' }, el('b', { text: title }), el('span', { class: 'n', text: String(items.length) }), el('span', { class: 'h', text: note })),
    el('div', { class: 'cn-list cn-rt-list' }, ...items));
  const out: HTMLElement[] = [];
  const known = new Set((status?.apps ?? []).map((a) => a.app));
  if (!status) {
    const base = (view.all as Svc[]).filter((s) => !(s as any).dynamic && hit(s));
    if (base.length) out.push(group('앱', '앱을 누르면 그 앱의 연결을 볼 수 있어요', base.map((s) => row(s, isOn(s) ? '내 계정으로 연결됨' : '앱을 눌러 연결 상태를 봐 주세요'))));
  }
  const dyn = (view.all as Svc[]).filter((s) => (s as any).dynamic && !known.has(s.key) && hit(s));
  if (dyn.length) out.push(group('그 밖에 연결할 수 있는 앱', '관리자가 등록한 앱이에요 — AI 가 내 계정으로 직접 써요(자료를 모으지는 않아요)',
    dyn.map((s) => row(s, isOn(s) ? '내 계정으로 연결됨' : '아직 연결 전 — 계정으로 한 번 허용하면 돼요'))));
  return out;
}

/** (#4970) 계정 연결 길이 있어도 개인 토큰 칸을 늘 보이는 앱 — 위 «개인 토큰으로 연결» 주석. */
const PAT_ALWAYS = new Set(['gitlab', 'github']);

/** (#4970) [연결 도와줘] — 리브에게 외부 앱 연결을 맡긴다(리브 세션이 없으면 연결 말로 열고, 있으면 그 세션에 넣는다 — me_liv_open).
 *  로그인된 AI 도 리브 세션도 없으면 «쓰는 AI 에서 하기» 를 그 자리에 펼친다. 다시 눌러도 같은 리브 세션으로 간다 — 같은 말은 1분 안에
 *  두 번 넣지 않는다(서버 LIV_REPEAT_MS). 실패는 서버 말 그대로 보여 준다. */
function connectStarter(): HTMLElement {
  const out = el('div', { class: 'cn-start-out' });
  const btn = el('button', { class: 'btn btn-primary', type: 'button', text: '연결 도와줘' }) as HTMLButtonElement;
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = '확인하고 있어요…';
    try {
      const r = await openConnectSession();
      if (r.ai) { location.hash = r.href; return; }
      out.innerHTML = ownAiStepsHtml();
      wireOwnAiSteps(out);
      btn.textContent = '연결 도와줘';
    } catch (e: any) {
      toast('연결을 도와드릴 대화를 열지 못했어요 — ' + ((e && e.message) || e), true);
      btn.textContent = '연결 도와줘';
    } finally { btn.disabled = false; }
  };
  return el('section', { class: 'cn-start' },
    el('p', { class: 'v2-desc', text: '[연결 도와줘]를 누르면 AI가 앱마다 무엇이 준비됐는지 보고, 연결을 한 걸음씩 도와드려요.' }),
    btn, out);
}

/** [코드와 데이터] 카드 — 앱 카드와 **같은 껍데기**(타일·이름·설명·상태줄·발). 상태줄만 축 대신 «등록 개수»다. */
function assetCard(page: string, ic: string, title: string, note: string): { node: HTMLElement; stat: HTMLElement } {
  const stat = el('div', { class: 'cn-axes' }, el('div', { class: 'cn-ax cn-ax-load' },
    el('span', { class: 'cn-ax-lb', text: '불러오는 중…' })));
  const node = el('a', { class: 'cn-card cn-card-asset', href: '#/connect/' + page, title },
    el('div', { class: 'cn-card-hd' }, assetTile(ic),
      el('div', { class: 'cn-card-tt' },
        el('div', { class: 'cn-card-nm' }, el('span', { text: title })),
        el('div', { class: 'cn-card-st', text: '우리 것' }))),
    el('p', { class: 'cn-card-bl', text: note }), stat,
    el('div', { class: 'cn-card-ft' }, el('span', { class: 'cn-card-go', text: '관리 ›' })));
  return { node, stat };
}

/** 상태줄 한 칸 — 앱 카드의 axisRow 와 같은 모양이라 두 묶음이 한 화면으로 읽힌다. */
function statRow(ic: string, label: string, n: number | null, unit: string): HTMLElement {
  const has = n != null && n > 0;
  return el('div', { class: 'cn-ax cn-ax-' + (has ? 'on' : 'off') },
    el('span', { class: 'cn-ax-ic', 'aria-hidden': 'true' }, icon(ic)),
    el('span', { class: 'cn-ax-lb', text: label }),
    el('span', { class: 'cn-ax-st' }, el('span', { class: 'cn-ax-dot', 'aria-hidden': 'true' }),
      el('span', { text: n == null ? '알 수 없어요' : has ? `${n}${unit}` : '아직 없어요' })));
}

/** 코드 저장소 — 이 화면의 두 반쪽(등록된 저장소 · git 열쇠)을 그대로 센다. 둘 중 하나만 있으면 아직 못 가져온다. */
async function fillGitCounts(stat: HTMLElement): Promise<void> {
  const repos = await api('/api/ui/repos').then((r: any) => (Array.isArray(r?.repos) ? r.repos.length : null)).catch(() => null);
  const keys = await api('/api/ui/me/git-credential').then((r: any) => (Array.isArray(r?.credentials) ? r.credentials.length : null)).catch(() => null);
  stat.replaceChildren(statRow('repo', '등록된 저장소', repos, '개'), statRow('key', '내 git 열쇠', keys, '개'));
}

/** 데이터베이스 — 등록된 소스와, 그 중 몇 곳에 행 보안(RLS)이 걸려 있나. */
async function fillDbCount(stat: HTMLElement): Promise<void> {
  const r: any = await api('/api/ui/org/db-sources').catch(() => null);
  const src: any[] | null = Array.isArray(r?.sources) ? r.sources : null;
  stat.replaceChildren(
    statRow('db', '등록된 데이터베이스', src ? src.length : null, '곳'),
    statRow('shield', '행 보안(RLS) 켠 곳', src ? src.filter((s: any) => s?.rls).length : null, '곳'));
}

// ══ 코드와 데이터 (#/connect/_git · #/connect/_db) — #2556 ══════════════════════
//  관리탭 [데이터 연결] 묶음이 없어지고 그 넷이 흩어진 자리다: 아웃바운드 둘은 노션·클릭업 **앱 상세**로,
//  레포·DB 는 여기로. 앱이 아니므로 앱 목록에 섞지 않고 그 아래 별도 묶음에서 들어온다.
//  ⚠ 화면만 옮겼다 — 목록·폼·저장은 관리탭이 쓰던 패널(reposPanel · dbSourceEditor) **그대로**다. 두 자리에서
//   같은 행을 고치므로 어느 쪽에서 고쳐도 반영된다(관리탭 쪽은 클래식 화면에 남아 있다).
//  ⚠ 주소에 밑줄을 붙인 이유 — 이 자리는 `#/connect/<앱키>`(앱 상세)와 같은 깊이다. 언젠가 'git' 이라는
//   커넥터가 생겨도 이 화면을 가리지 않게 앱 키가 될 수 없는 모양으로 둔다.

/** 관리 데이터 1회 조회 + 패널이 보는 권한 상태 준비 — 관리탭을 한 번도 안 거쳐도 버튼이 살아 있게(renderAdmin 과 같은 값). */
async function adminData(): Promise<any> {
  const data = await loadAdmin();
  state.admin.canEdit = !!data.canEdit;
  state.admin.canRuntime = !!data.canRuntime;
  state.admin.canContext = hasScope('context');
  return data;
}

/** git 열쇠 한 줄 — 누르면 자격 관리 창이 뜬다(내 것 · 게이트웨이 것, 창은 한 벌). */
function keyRow(title: string, note: string, scope: 'me' | 'gateway'): HTMLElement {
  return el('button', { class: 'cn-row cn-row-btn', type: 'button', onclick: () => openGitCredentialManager(scope) },
    el('span', { class: 'cn-git-ic', 'aria-hidden': 'true' }, icon('key')),
    el('div', { class: 'cn-row-main' }, el('div', { class: 't', text: title }), el('div', { class: 'm', text: note })),
    el('span', { class: 'cn-row-go', 'aria-hidden': 'true', text: '›' }));
}

/** 이 묶음 안의 소제목 — 앱 상세의 번호 매긴 머리(sectHead)와 달리 순서가 아니라 그냥 칸이다. */
function dataSect(title: string, note: string, body: Node): HTMLElement {
  return el('section', { class: 'cn-sect' },
    el('div', { class: 'cn-gh' }, el('b', { text: title }), el('span', { class: 'h', text: note })), body);
}

export async function renderConnectData(host: HTMLElement, page: string): Promise<void> {
  const git = page === '_git';
  const body = el('div', {});
  host.replaceChildren(el('div', { class: 'v2-wide v2-connect-app' },
    backLink(),
    el('div', { class: 'cn-head' },
      assetTile(git ? 'repo' : 'db'),
      el('div', { class: 'cn-head-tt' },
        el('h1', { class: 'v2-title', text: git ? '코드 저장소' : '데이터베이스' }),
        el('p', { class: 'v2-desc', style: 'margin-top:4px', text: git
          ? '우리 코드 저장소를 등록하고, 코드를 받아오고 올릴 때 쓰는 열쇠를 여기 둡니다.'
          : 'AI가 조회할 수 있는 데이터베이스를 등록하고, 어느 테이블까지 어떻게 보여줄지 정합니다.' }))),
    body));

  const panel = el('div', {});
  if (git) {
    //  목록과 열쇠는 한 일의 두 반쪽이다 — 저장소를 등록해도 열쇠가 없으면 못 받아오고, 열쇠만 있으면 받아올
    //   것이 없다. 종전엔 목록은 관리탭, 열쇠는 이 앱 목록 발치에 있어 그 둘을 잇는 사람이 아무도 없었다.
    body.replaceChildren(
      dataSect('등록된 저장소', '여기 등록한 저장소로 도메인맵을 만들고, 프로젝트에서 코드 작업을 할 때 내려받습니다', panel),
      dataSect('git 인증', '저장소에서 코드를 받아오고 올릴 때 쓰는 열쇠입니다',
        el('div', {},
          keyRow('내 인증', 'GitHub·GitLab 저장소를 내 이름으로 받아오고 올릴 때 씁니다', 'me'),
          //  게이트웨이 열쇠 — 서버가 공유 클론을 받아올 때 쓰는 것이라 사람의 열쇠와 다른 물건이다. 종전엔
          //   레포 목록 위 버튼이었는데(관리탭), 열쇠는 열쇠끼리 두는 편이 찾기 쉽다. 관리자만.
          ...(hasScope('admin') ? [keyRow('게이트웨이 인증', '라이블리 서버가 공유 클론을 받아오고 최신화할 때 씁니다', 'gateway')] : []))));
  } else {
    //  DB 쪽은 칸 제목을 덧대지 않는다 — 패널이 이미 «등록된 DB 소스»·«DB 접속 안전범위» 두 카드로 나뉘어 있어,
    //   그 위에 또 소제목을 얹으면 같은 말이 두 줄 겹친다(실측 2026-09-03).
    body.replaceChildren(panel);
    if (!hasScope('admin')) {
      panel.replaceChildren(el('p', { class: 'v2-empty', text: '워크스페이스 관리자만 데이터베이스를 등록하고 고칠 수 있어요.' }));
      return;
    }
  }
  panel.replaceChildren(skeleton(git ? '저장소를 불러오는 중' : '데이터베이스를 불러오는 중'));
  let data: any;
  try { data = await adminData(); }
  catch (e) { panel.replaceChildren(errorNote(e, git ? '저장소를 불러오지 못했습니다' : '데이터베이스 목록을 불러오지 못했습니다')); return; }
  markEmbedded(panel);
  if (git) void reposPanel(panel, data); else dbSourceEditor(panel, data);
}


// ══ 앱 상세 (#/connect/<key>) — #2243 안 B «설정 패널» ═══════════════════════════════
//  **모든 앱이 같은 틀**이다 — 앱마다 바뀌는 건 칸 안의 명사(페이지·대화·저장소·파일)와 어댑터뿐. 연결은 **둘**:
//   · 내 계정으로 직접 사용(= MCP) — AI 가 내 계정으로 그 앱에 들어가 다룬다. 내가 요청할 때만 · 복사 없음 · 나만.
//     쓰기는 **이 연결의 성질**이지 세 번째 연결이 아니다(카드 안 상자).
//   · 자료 가져오기(= 수집기) — 내가 고른 것만 라이블리가 미리 읽어 자료함으로 가져온다. 주기적 · 워크스페이스 함께.
//  이름 근거: 원준 2026-08-30 — «읽기/쓰기/모으기가 감이 안 온다 · 실제로 연결하는 건 수집과 MCP 둘». 흩어져 있던
//   이름 11개(수집기·자료 가져오기·모아 두기·가져오기 / 외부 앱 연결·AI 도구·외부 서비스·바로 쓰기…)를 이 둘로 모았다.
//   ⚠ 비유로 짓지 않는다(같은 날 지시) — 기능을 그대로 쓴 말만.
//  이름 둘은 임시다(원준님 검토 중, 2026-08-28) — 바꾸면 여기 문구와 상세 «연결 두 가지» 줄을 같이.
//  종전의 «연결 안 됨 + 워크스페이스 2곳에서 모으는 중» 모순(#2202 B1)은 문패의 두 상태 한 줄로 푼다.
type CollectState = (text: string, on: boolean) => void;
const SCOPE_NOUN: Record<string, string> = {
  notion: '페이지', linear: '이슈', slack: '대화', google: 'Drive 파일과 캘린더 일정', github: '저장소', gitlab: '프로젝트',
  clickup: '작업', figma: '파일', prometheus: '지표', 'claude-headless': '분류·크론 실행', outlook: '메일과 일정',
};
const COLLECT_UNIT: Record<string, string> = { slack: '대화', notion: '페이지', google: '문서', figma: '파일의 코멘트', clickup: '작업', github: '저장소의 이슈·PR 대화', gitlab: '프로젝트의 이슈·MR 대화', linear: '이슈', outlook: '메일' };
//  #4233: 이 화면의 그림도 lib/icon-paths.ts 한 벌에 있다(이름에 cn- 이 붙는다). 모양은 그대로다.
/**
 * 목적격 조사 — 앞 글자 받침으로 «을/를». 화면에 «저장소을(를)» 같은 자리가 남으면 사람이 «기계가 쓴 글»로 읽는다.
 * 한글이 아니면(영문 앱 이름 등) «를». 순수라 테스트가 표를 돈다.
 */
export function eulReul(word: string): string {
  const c = (word || '').charCodeAt((word || '').length - 1);
  if (!(c >= 0xAC00 && c <= 0xD7A3)) return '를';
  return (c - 0xAC00) % 28 ? '을' : '를';
}
const icon = (k: string): SVGElement => sv('svg', { class: 'v2-ic', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, sv('path', { d: iconPath('cn-' + k) })) as SVGElement;

/** 설정 줄 — «라벨 | 값 | 동작». 값은 문자열(uiText)이나 노드. */
// ══ #2243 3차 «다듬은 안 B» — 상세 화면 부품 ═══════════════════════════════════════════════
//  종전 상세는 두 패널이 같은 모양이라 «뭐가 다른지»를 배울 단서가 없었고, 그 뒤 읽기·쓰기·모으기 세 줄로 갔더니
//  연결이 셋으로 보였다(실제로는 둘). 이제 화면은 세 부분이다: ① 연결 두 가지 ② 가져올 자료 정하기
//  (무엇을·얼마나 자주·언제부터·어디서) ③ 보는 사람. 제목은 질문이 아니라 서술문(원준 2026-08-30).

/** 서술형 섹션 머리 — «① AI가 내 GitHub 계정으로 하는 일». 오른쪽에 전체/해제 같은 동작을 달 수 있다. */
function sectHead(n: string, title: string, sub = '', acts: HTMLElement[] = []): HTMLElement {
  return el('div', { class: 'cn-sect-h' },
    el('span', { class: 'cn-sect-n', 'aria-hidden': 'true', text: n }),
    el('h3', { class: 'cn-sect-t', text: title }),
    ...(sub ? [el('span', { class: 'cn-sect-s', text: sub })] : []),
    ...(acts.length ? [el('span', { class: 'cn-sect-a' }, ...acts)] : []));
}

export interface ActRow {
  /** 연결은 둘뿐이다 — 내 계정으로 직접 사용(MCP) · 자료 가져오기(수집). 쓰기는 앞엣것의 성질이지 세 번째 연결이 아니다. */
  kind: 'use' | 'collect';
  verb: string;             // «읽기» · «쓰기 — 내 이름으로 GitHub에 남습니다»
  detail: Node[];           // 그 줄이 실제로 무엇을 하는지(굵은 조각 포함)
  on: boolean;
  pill: { text: string; cls: string; ic?: string };
  sw?: HTMLInputElement;    // 없으면 스위치 자리를 비운다(상태만 보여 주는 줄)
  sub?: HTMLElement;        // 쓰기의 «쓰기 전에 물어보기» 같은 딸린 줄
}

/** «하는 일» 한 줄. 쓰기만 색이 다르다 — 이 화면에서 유일하게 되돌릴 수 없는 것이라서. */
function actRow(a: ActRow): HTMLElement {
  return el('div', { class: 'cn-act cn-act-' + a.kind + (a.on ? ' on' : ' off') + (a.kind === 'collect' ? ' collect' : '') },
    el('span', { class: 'cn-act-ic', 'aria-hidden': 'true' }, icon(a.kind === 'use' ? 'zap' : 'box')),
    el('span', { class: 'cn-act-tx' },
      el('span', { class: 'cn-act-v', text: a.verb }),
      el('span', { class: 'cn-act-m' }, ...a.detail),
      ...(a.sub ? [a.sub] : [])),
    el('span', { class: 'cn-act-rt' },
      ...(a.sw ? [a.sw] : []),
      el('span', { class: 'cn-pill ' + a.pill.cls }, ...(a.pill.ic ? [icon(a.pill.ic)] : []), el('span', { text: a.pill.text }))));
}

/** 개인화 설정 한 줄 — 왼쪽에 «무엇을» 같은 이름과 한 줄 설명, 오른쪽에 컨트롤. */
function setRow(label: string, note: string, body: Node[], hint = ''): HTMLElement {
  return el('div', { class: 'cn-set' },
    el('span', { class: 'cn-set-lb' }, el('b', { text: label }), ...(note ? [el('i', { text: note })] : [])),
    el('span', { class: 'cn-set-bd' }, ...body, ...(hint ? [el('span', { class: 'cn-set-hint', text: hint })] : [])));
}

/** 세그먼트 — 주기·기간처럼 «하나만 고르는» 값. 값은 opts 의 id. */
function segment(opts: Array<{ id: string; label: string }>, cur: string, onPick: (id: string) => void): HTMLElement {
  const wrap = el('div', { class: 'cn-seg', role: 'radiogroup' });
  const btns: HTMLButtonElement[] = [];
  for (const o of opts) {
    const b = el('button', {
      type: 'button', class: o.id === cur ? 'on' : '', role: 'radio',
      'aria-checked': o.id === cur ? 'true' : 'false', text: o.label,
      onclick: () => { for (const x of btns) { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', on ? 'true' : 'false'); } onPick(o.id); },
    }) as HTMLButtonElement;
    btns.push(b); wrap.appendChild(b);
  }
  return wrap;
}

/** 종류 칩 — 여러 개 고르는 값(이슈 대화·PR 리뷰 대화…). 체크박스를 품어 키보드로도 켜진다. */
function chipSet(opts: Array<{ id: string; label: string }>, cur: Set<string>, onChange: (picked: Set<string>) => void): HTMLElement {
  const wrap = el('div', { class: 'cn-chips' });
  for (const o of opts) {
    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = cur.has(o.id);
    const lab = el('label', { class: 'cn-chip' + (cb.checked ? ' on' : '') }, cb, el('span', { text: o.label }));
    cb.onchange = () => {
      lab.classList.toggle('on', cb.checked);
      if (cb.checked) cur.add(o.id); else cur.delete(o.id);
      onChange(cur);
    };
    wrap.appendChild(lab);
  }
  return wrap;
}

function srow(k: string, v: string | Node[], acts: HTMLElement[] = [], cls = ''): HTMLElement {
  return el('div', { class: 'cn-srow' + (cls ? ' ' + cls : '') },
    el('span', { class: 'k', text: k }),
    el('span', { class: 'v' }, ...(typeof v === 'string' ? uiText(v) : v)),
    ...acts);
}
/**
 * 자료 가져오기 얼굴 — #2243 3차로 **두 조각**이 됐다.
 *  · row      : 섹션 ① «연결 두 가지»의 «자료 가져오기» 한 줄(스위치·상태·결과)
 *  · box      : 섹션 ② «자료함에 모아 두는 것»의 본문(무엇을·얼마나 자주·언제부터·어디서)
 * 앱별 어댑터(slack·notion·google·memberToken) 넷이 전부 이걸로 만든다 — 한 자리를 고치면 넷이 같이 움직인다.
 * 종전엔 스위치·«누가 봐요»가 카드마다 따로 있어 화면에 같은 말이 세 번 나왔다.
 */
export interface CollectFace { box: HTMLElement; row: HTMLElement }
function collectFace(onState: CollectState, teamSee = true, countKind = '', countSystem = ''): CollectFace & { body: HTMLElement; set: (chk: HTMLInputElement, stateText: string, notes: string[], extra: HTMLElement[]) => void } {
  const rowHost = el('div');
  //  ★ ② 는 어떤 앱에서도 같은 «카드 + 라벨 열» 이어야 한다(#2243 최우선 요구). 어댑터가 무엇을 넣든
  //   이 틀 안에 들어간다 — 종전엔 노션·구글이 라벨 없이 체크박스만 떨궈 ①·③ 과 딴판이었다(원준 실측 2026-08-30).
  const body = el('div', { class: 'cn-setlist' }, el('span', { class: 'cn-set-hint', text: '불러오는 중…' }));
  const box = el('div', { class: 'cn-collect-body', id: 'cn-collect' }, body);
  return {
    box, row: rowHost, body,
    set(chk, stateText, notes, extra) {
      chk.className = 'cn-sw'; chk.setAttribute('role', 'switch'); chk.setAttribute('aria-label', '자료 가져오기');
      rowHost.replaceChildren(actRow({
        kind: 'collect', verb: '자료 가져오기',
        detail: uiText(notes.join(' ')),
        on: chk.checked, sw: chk,
        pill: chk.checked && teamSee
          ? { text: '함께 봐요', cls: 'cn-pill-team', ic: 'team' }
          : { text: chk.checked ? '나만 봐요' : '아직 꺼짐', cls: chk.checked ? 'cn-pill-me' : 'cn-pill-off', ic: chk.checked ? 'usr' : undefined },
      }));
      body.replaceChildren(...extra);
      onState(stateText, chk.checked);
      //  자료함에 실제로 몇 건 들어왔는지 — 목록 총계를 한 번 물어 줄 앞에 붙인다(본문은 안 받는다: limit=1).
      if (chk.checked && countKind) {
        //  #4211 — 같은 kind 를 두 앱이 나눠 쓰면(email = Gmail·Outlook) system 으로 좁힌다. 안 그러면 남의 앱 수를 제 것으로 말한다.
        void api(`/api/ui/sources?kind=${encodeURIComponent(countKind)}${countSystem ? `&system=${encodeURIComponent(countSystem)}` : ''}&limit=1`)
          .then((r: any) => {
            const n = Number(r?.total);
            if (!Number.isFinite(n) || n <= 0) return;
            const m = rowHost.querySelector('.cn-act-m');
            if (m) m.prepend(...uiText(`지금까지 **${n.toLocaleString('ko-KR')}건** 가져왔어요. `));
          })
          .catch(() => { /* 숫자는 덤이다 — 없다고 줄이 비면 안 된다 */ });
      }
    },
  };
}
/** 얼굴이 없는(또는 아직 못 켜는) 앱 — 칸을 비우지 않는다. 틀이 흔들리면 앱마다 다른 화면이 된다. */
function quietCollectFace(stateText: string, note: string, onState: CollectState): CollectFace {
  onState(stateText, false);
  return {
    row: actRow({
      kind: 'collect', verb: '자료 가져오기', detail: uiText(note), on: false,
      pill: { text: stateText, cls: 'cn-pill-off' },
    }),
    //  아직 못 켠 앱 — 정할 것을 «회색으로 미리» 보여 준다. 안내문만 두 줄 떨구면 ①·③ 은 카드인데 여기만 맨 텍스트가 된다.
    box: el('div', { class: 'cn-collect-body', id: 'cn-collect' },
      el('div', { class: 'cn-setlist off' },
        el('div', { class: 'cn-set-why' }, icon('box'), el('span', { text: note })),
        ...['무엇을', '얼마나 자주', '언제부터', '어디서'].map((k) =>
          setRow(k, '', [el('span', { class: 'cn-set-hint', style: 'margin-top:0', text: '켜면 여기서 정합니다' })])))),
  };
}

/**
 * 「연결 중」을 끝내는 줄 (#3778, 원준 2026-09-20).
 *  하나만 켜진 앱은 목록에서 «연결 중»으로 서고, 여기 들어오면 **끝내는 길 둘**을 그 자리에서 고른다 —
 *   나머지를 켜거나(아래 스위치), «안 쓴다»고 정하거나(이 줄의 단추). 정한 것은 이 상세에만 남는다 — (#4970) 목록은 서버의 길 상태로 선다.
 *  ⚠ «안 쓴다»는 **표시일 뿐 아무것도 끄지 않는다** — 그래서 되돌리는 단추를 늘 같은 자리에 둔다.
 */
function decideRows(label: string, a: AppAxes, skip: Set<string>, key: string, reload: () => void): HTMLElement[] {
  const out: HTMLElement[] = [];
  const set = (axis: 'use' | 'get', on: boolean) => {
    if (on) skip.add(skipKey(key, axis)); else skip.delete(skipKey(key, axis));
    saveSkip(skip);
    toast(on ? `${AXIS_LABEL[axis]}는 안 쓰는 것으로 정했어요 — 이 칸은 더 묻지 않아요`
             : `${AXIS_LABEL[axis]}를 다시 «아직 안 정함»으로 되돌렸어요`);
    reload();
  };
  for (const axis of pendingAxes(a)) {
    out.push(el('div', { class: 'cn-decide' }, icon('zap'),
      el('span', { class: 'm' }, ...uiText(`**${AXIS_LABEL[axis]}** 를 아직 안 정했어요 — 아래에서 켜면 연결이 완료돼요. 안 쓸 거면 그렇게 정해 두세요.`)),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '안 쓸래요', onclick: () => set(axis, true) })));
  }
  for (const axis of ['use', 'get'] as const) {
    if (a[axis] !== 'skip') continue;
    out.push(el('div', { class: 'cn-decide done' }, icon('check'),
      el('span', { class: 'm' }, ...uiText(`**${AXIS_LABEL[axis]}** 는 안 쓰기로 했어요 — 켜 두진 않았어요. 다시 쓰려면 [다시 정하기]를 누르세요.`)),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '다시 정하기', onclick: () => set(axis, false) })));
  }
  return out;
}

//  이 앱에 대한 모든 것이 여기 있다 — 두 얼굴의 상태 · 범위 · 방식 · 해제.
export async function renderConnectApp(host: HTMLElement, key: string): Promise<void> {
  //  먼저 읽고 나서 앱을 찾는다 — 이 키가 표에 없는 커넥터일 수 있고, 그건 서버 응답에만 있다.
  host.replaceChildren(el('div', { class: 'v2-center' }, backLink(), skeleton('연결 상태를 불러오는 중')));
  let v: SvcView;
  try { ({ v } = await load()); }
  catch (e) { host.replaceChildren(el('div', { class: 'v2-center' }, backLink(), errorNote(e, '연결 상태를 불러오지 못했습니다'))); return; }
  const svc = findSvc(v, key);
  if (!svc) { host.replaceChildren(el('div', { class: 'v2-center' }, backLink(), el('p', { class: 'v2-empty', text: '그런 앱이 없어요.' }))); return; }

  const st = stateOf(v, svc);
  //  #3778 — 상세도 목록과 **같은 잣대**로 두 축을 읽는다. 여기서 «하나 남았다»를 말하고 그 자리에서 끝낸다.
  //  (#4970) 연결 길은 서버가 정한다 — 수집기 집계와 같이 읽는다(못 읽어도 아래 칸은 그린다).
  const [{ tally }, connStatus] = await Promise.all([loadCollect(), loadConnectStatus().catch(() => null)]);
  const connApp: ConnectAppStatus | null = connStatus?.apps.find((x) => x.app === svc.key) || null;
  const skip = loadSkip();
  const axes = appAxes(svc.key, st === 'blocked' ? 'soon' : st, tally, skip);
  const reload = () => { void renderConnectApp(host, key); };
  const oc = svc.oauth ? v.oauthMap.get(svc.oauth) : null;
  const cred = svc.token ? v.credMap.get(svc.token) : null;
  const viaOAuth = !!oc?.connected;
  const viaToken = !!cred?.has_secret;
  const spec = svc.token ? CRED_KINDS.find((x: any) => x.kind === svc.token) : null;
  //  지금 이 앱을 켜는 길 — 조직이 등록한 OAuth 가 있거나 전용 창구(appConnect)가 있을 때. svc.oauth 만 보면 Slack 처럼 OAuth 가 안 열린 앱이 막다른 버튼이 된다(#2202 A1).
  const account = !!((svc.oauth && v.oauthMap.has(svc.oauth)) || (svc as any).appConnect);
  //  2026-09-12 대표 결정 — 팀 수집·쓰기 도구·아웃바운드는 «워크스페이스를 어떻게 굴릴까»라 구성원이 한다.
  //   (관리자 전용으로 남는 것은 인원 관리와 인프라뿐 — 데이터베이스·게이트웨이 열쇠는 위에서 따로 admin 을 본다.)
  const isAdmin = hasScope('memory') || hasScope('admin');
  const noun = SCOPE_NOUN[svc.key] || '것';

  //  #2232 — OAuth 릴레이에서 **막 돌아온 탭**이다(main.ts 가 표식을 남긴다). 이 탭은 [허용]을 누르느라 새로 열린 탭이라
  //   사람은 «그래서 이제 뭘 하지?» 상태다(원준님 실측 2026-08-28, Slack). 원래 하던 화면으로 돌아가라고 **글로** 말한다.
  let arrivedFrom = false;
  try { arrivedFrom = sessionStorage.getItem('lively.connect.return') === key; if (arrivedFrom) sessionStorage.removeItem('lively.connect.return'); } catch (_) { arrivedFrom = false; }
  const arrived = arrivedFrom ? el('div', { class: 'cn-arrived' + (st === 'on' ? ' on' : ' off') },
    el('b', { text: st === 'on' ? `${svc.label} 연결이 끝났어요. ` : `${svc.label} 연결을 아직 확인하지 못했어요. ` }),
    el('span', { text: st === 'on'
      ? '처음 설정이나 다른 화면에서 시작하셨다면 이 탭은 닫고 원래 탭으로 돌아가세요. 거기 화면이 «연결됨» 으로 저절로 바뀝니다.'
      : '아래 [내 계정으로 직접 사용] 스위치로 한 번 더 해 보세요.' })) : null;
  //  #2243 — 카탈로그에서 **내려 둔** 앱(LOGIN_SERVICES.hidden). 목록엔 없고 주소로만 들어온다 — 그 사실을 화면이 먼저 말한다.
  //   행을 지우지 않는 이유는 me-logins.ts 표 머리말에: 이미 등록한 토큰(헤드리스 크론이 그걸로 돈다)의 관리 창구를 없애면 안 된다.
  const hiddenNote = (svc as any).hidden ? el('div', { class: 'cn-arrived off' },
    el('b', { text: '이 앱은 지금 외부 앱 목록에 내밀지 않아요. ' }),
    el('span', { text: '이 주소로만 들어올 수 있어요. 등록해 둔 토큰이 있으면 여기서 그대로 교체·해제할 수 있습니다.' })) : null;

  // ── 해제 — 두 얼굴을 한 번에. 잃는 것만 말한다(#1582). ──
  const disconnect = async (): Promise<void> => {
    if (!await confirmDialog({
      title: svc.label + ' 연결을 해제할까요?', danger: true, confirmText: '연결 해제',
      message: 'AI가 이 앱을 내 계정으로 쓰지 못하게 됩니다.',
      note: '저장해 둔 로그인 정보가 지워집니다 — 다시 쓰려면 처음부터 연결해야 합니다.',
    })) { reload(); return; }
    try {
      if (viaOAuth) await api('/api/ui/me/oauth/disconnect', { method: 'POST', body: JSON.stringify({ server: svc.oauth }) });
      if (viaToken) await api('/api/ui/me/credential/delete', { method: 'POST', body: JSON.stringify({ kind: svc.token, scope_key: cred.scope_key || '' }) });
      toast('연결을 해제했습니다'); reload();
    } catch (e: any) { toast((e && e.message) || '해제하지 못했습니다', true); reload(); }
  };

  // ══ 화면 — 세 부분(#2243 3차) ═════════════════════════════════════════════════════════
  //  ① 연결 두 가지 — 내 계정으로 직접 사용 · 자료 가져오기 (종전엔 «바로 쓰기 / 모아 두기»
  //     두 패널이 같은 모양이라 차이를 배울 단서가 없었다)
  //  ② 자료함에 모아 두는 것 — 무엇을 · 얼마나 자주 · 언제부터 · 어디서 (전부 사람이 정한다)
  //  ③ 보는 사람 — 이 화면의 진짜 차이라 표 한 줄이 아니라 비교 카드
  //  왼쪽 목차는 걷었다 — 칸이 셋이라 목차가 화면보다 길었다.

  // ── 연결 ① 「내 계정으로 직접 사용」 — 켜면 계정 로그인·토큰 창, 끄면 자격 삭제. 쓰기는 이 연결의 성질이라 이 카드 안에 있다. ──
  const sw = el('input', { type: 'checkbox', class: 'cn-sw', role: 'switch', 'aria-label': '내 계정으로 직접 사용' }) as HTMLInputElement;
  sw.checked = st === 'on';
  if (st === 'blocked') sw.disabled = true;
  sw.onchange = () => {
    if (sw.checked) {
      //  켜짐은 서버가 확인해야 켜진 것 — 스위치는 되돌리고, 외부 동의(또는 토큰 창)로 보낸 뒤 돌아오면 다시 그린다.
      sw.checked = false;
      if (account) { sw.disabled = true; void startOAuth(svc, reload); }
      else openToken(svc, reload);
    } else { sw.checked = true; void disconnect(); }
  };
  //  #4211 — Outlook 은 어느 계정(회사/개인)으로 붙었는지가 곧 «누구 메일인지»다. 서버가 connectors[].account 로 준다.
  const acct = svc.key === 'outlook' && oc?.account?.email
    ? ` · ${oc.account.email}${oc.account.type === 'work' ? '(회사 계정)' : oc.account.type === 'personal' ? '(개인 계정)' : ''}` : '';
  const howNow = viaOAuth ? '계정 로그인으로 연결했어요' + acct : viaToken ? '토큰으로 연결했어요' : '';
  const usedAt = viaToken && cred?.last_used_at ? ` · ${relTime(cred.last_used_at)}에 마지막으로 썼어요`
    : viaToken && cred?.updated_at ? ` · ${relTime(cred.updated_at)}에 연결했어요` : '';
  const readDetail = st === 'on'
    ? `내가 요청할 때 AI가 내 ${svc.label} 계정으로 들어가 ${noun}${eulReul(noun)} **내 계정 권한 그대로** 다룹니다. 라이블리에는 남지 않아요.`
    : st === 'blocked'
      ? String((svc as any).soon || '라이블리가 이 앱을 준비하고 있어요 — 준비를 마치면 여기서 바로 켤 수 있어요.')
      : account ? `켜면 ${svc.label} 화면에서 «허용»을 한 번 누르는 것으로 끝나요.` : '켜면 토큰을 넣는 창이 열려요.';
  const readActs = el('div', { class: 'cn-act-row' });
  if (st === 'on' && (howNow || usedAt)) readActs.appendChild(el('span', { class: 'cn-act-note', style: 'flex:1 1 100%', text: howNow + usedAt }));
  if (st === 'on') {
    if (viaOAuth) readActs.appendChild(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '다시 연결', onclick: () => void startOAuth(svc, reload) }));
    if (viaToken) readActs.appendChild(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '토큰 교체', onclick: () => openToken(svc, reload) }));
    if (svc.key === 'slack') readActs.appendChild(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '대화별 허용 정하기', onclick: () => overlay('Slack 대화별 허용', slackChannelPolicyCard()) }));
    if (svc.key === 'github') readActs.appendChild(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '열린 저장소 보기', onclick: () => overlay('GitHub 열린 저장소', githubReposCard()) }));
  } else if (svc.key === 'outlook' && st === 'off') {
    //  #4211 — 연결 **전에** 관리자 링크를 곁에 둔다. 회사 계정은 Microsoft 화면에서 막히고 이 화면으로 안 돌아오는 일이 많다.
    readActs.appendChild(el('div', { style: 'flex:1 1 100%' }, outlookAdminConsentBox(null)));
  } else if (spec && (spec.help || spec.docUrl) && !account) {
    readActs.appendChild(el('span', { class: 'h', style: 'margin-left:0', text: String(spec.help || '') }));
    if (spec.docUrl) readActs.appendChild(el('a', { class: 'btn btn-ghost btn-sm', href: spec.docUrl, target: '_blank', rel: 'noopener noreferrer', text: '발급 페이지 열기 ↗' }));
  }
  //  #4970 — 깃허브·깃랩은 개인 토큰 칸이 **늘** 있어야 한다. 깃랩은 계정 로그인 토큰으로는 자료를 못 읽고(수집은 read_api 개인 토큰),
  //   앱을 아직 등록하지 않은 셀프호스트의 깃허브는 계정 연결 길이 막혀 있다. 처음 설정의 토큰 단계가 없어진 뒤로는 이 자리가 웹의 유일한 입력칸이다.
  //   스위치는 계정 길(account)로 가므로, 토큰 길은 옆의 버튼으로 연다(svcTokenForm — 호스트·헤더 형식은 CRED_KINDS 가 정한다).
  if (PAT_ALWAYS.has(svc.key) && svc.token && !viaToken) {
    readActs.appendChild(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '개인 토큰으로 연결', onclick: () => openToken(svc, reload) }));
  }
  //  쓰기 상자가 이 카드 «안»에 들어간다 — 연결은 하나인데 쓰기를 옆줄로 세우면 연결이 둘로 보인다(원준 2026-08-30).
  const writeBox = el('div');
  const readRow = actRow({
    kind: 'use', verb: '내 계정으로 직접 사용', detail: uiText(readDetail), on: st === 'on', sw: st === 'blocked' ? undefined : sw,
    pill: st === 'on' ? { text: '나만 봐요', cls: 'cn-pill-me', ic: 'usr' }
      : { text: st === 'blocked' ? '준비 중' : '아직 꺼짐', cls: 'cn-pill-off' },
    sub: el('div', { class: 'cn-act-more' }, writeBox, readActs),
  });

  // ── 쓰기 — 이 연결의 «되돌릴 수 없는 부분». 세 번째 연결이 아니라 ① 안의 상자다. ──
  const paintWrite = async (): Promise<void> => {
    let tools: { tools: Array<{ name: string; title: string; write: boolean; enabled: boolean }> } | null = null;
    try { tools = await api(`/api/ui/org/${encodeURIComponent(svc.key)}/tools`); } catch (_) { tools = null; }
    const all = tools?.tools ?? [];
    const writes = all.filter((t) => t.write);
    const reads = all.filter((t) => !t.write);
    if (!writes.length) {
      //  쓰기 도구가 아예 없는 앱(GitLab·Figma·ClickUp) — 칸을 지우지 않고 사실을 말한다.
      writeBox.replaceChildren(el('span', { class: 'cn-act-note',
        text: `${svc.label}에는 쓰기 도구가 없어요 — AI가 읽기만 하고, ${svc.label}에 남는 기록은 없습니다.` }));
      return;
    }
    const off = writes.every((t) => !t.enabled);
    const btn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: off ? '쓰기 켜기' : '쓰기 끄기' }) as HTMLButtonElement;
    btn.disabled = !isAdmin;
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api(`/api/ui/org/${encodeURIComponent(svc.key)}/tools/write`, { method: 'POST', body: JSON.stringify({ enabled: off }) });
        toast(off ? '쓰기를 켰어요' : `쓰기를 껐어요 — AI가 ${svc.label}에 아무것도 남기지 않습니다`);
      } catch (e: any) { toast((e && e.message) || '바꾸지 못했습니다', true); btn.disabled = false; return; }
      await paintWrite();
    };
    writeBox.replaceChildren(el('div', { class: 'cn-write' + (off ? ' off' : '') },
      el('div', { class: 'cn-write-t' }, icon('pen'),
        el('span', { text: off ? `쓰기는 꺼져 있어요 — ${svc.label}에 아무것도 남기지 않습니다` : `내 이름으로 ${svc.label}에 남습니다` })),
      el('span', { class: 'cn-write-m' }, ...uiText(off
        ? `켜면 AI가 **내 ${svc.label} 계정**으로 ${writes.map((t) => t.title).join(' · ')}.`
        : `AI가 **내 ${svc.label} 계정**으로 ${writes.map((t) => t.title).join(' · ')}. 받는 사람은 내가 한 것으로 봅니다 — 되돌리려면 ${svc.label}에서 직접 지워야 해요.`)),
      el('div', { class: 'cn-write-ft' },
        el('span', { class: 'cn-write-n', text: `읽기 ${reads.length} · 쓰기 ${writes.length}` }),
        ...(off ? [] : [el('span', { class: 'cn-write-ok' }, icon('check'), el('span', { text: '쓰기 전에 내 컴퓨터에서 한 번 확인을 받습니다' }))]),
        btn),
      ...(isAdmin ? [el('span', { class: 'cn-write-m', style: 'margin-top:7px; opacity:.8',
        text: '쓰기를 끄고 켜는 것은 워크스페이스 전체에 적용돼요 — 사람마다 따로 끄는 건 아직 없습니다.' })] : [])));
  };
  void paintWrite();

  // ── 연결 ② 「자료 가져오기」 줄 + 섹션 ② 설정 — 앱별 어댑터. 없는 앱도 칸을 비우지 않는다. ──
  const onCollect: CollectState = () => { /* 목차가 사라져 더 알릴 곳이 없다 — 줄 자체가 상태다 */ };
  const unit = COLLECT_UNIT[svc.key];
  let collect: CollectFace;
  //  ⚠ 자료 가져오기를 «직접 사용» 축에 매달지 않는다 — 근거가 달라 어긋난다(#2202 실측: 수집기가 돌고 있는데 화면은 «꺼짐»).
  if (svc.key === 'slack') collect = !isAdmin ? quietCollectFace('권한 필요', '이 워크스페이스의 구성원이 켤 수 있어요 — 켜면 공개 채널이 함께 보는 자료함으로 들어옵니다.', onCollect)
    : slackTeamCollectCard(onCollect);
  else if (svc.key === 'notion') collect = isAdmin ? notionTeamCollectCard(onCollect)
    : quietCollectFace('관리자만', '워크스페이스 관리자가 켤 수 있어요 — 노션에서 고른 페이지만 함께 보는 자료함으로 들어옵니다.', onCollect);
  else if (svc.key === 'google') collect = isAdmin ? googleTeamCollectCard(onCollect)
    : quietCollectFace('관리자만', '워크스페이스 관리자가 켤 수 있어요 — Drive 문서가 함께 보는 자료함으로 들어옵니다.', onCollect);
  else if (svc.key === 'outlook') collect = isAdmin ? memberTokenCollectCard(svc.key, onCollect)
    : quietCollectFace('권한 필요', '이 워크스페이스의 구성원이 켤 수 있어요 — 켜면 내 메일이 함께 보는 자료함으로 들어옵니다.', onCollect);
  else if (svc.key === 'linear') collect = isAdmin ? memberTokenCollectCard(svc.key, onCollect)
    : quietCollectFace('관리자만', '워크스페이스 관리자가 켤 수 있어요 — 켜면 이슈·댓글·문서가 함께 보는 자료함으로 들어옵니다.', onCollect);
  else if (svc.key === 'gitlab') collect = !isAdmin ? quietCollectFace('권한 필요', '이 워크스페이스의 구성원이 켤 수 있어요 — 켜면 고른 프로젝트의 이슈·MR 대화가 함께 보는 자료함으로 들어옵니다.', onCollect)
    : !(cred && cred.has_secret) ? quietCollectFace('꺼짐', 'GitLab 은 계정 로그인 토큰으로는 자료를 못 읽어요 — 위 [내 계정으로 직접 사용]에서 개인 액세스 토큰(read_api)을 저장하면 여기서 켤 수 있어요.', onCollect)
    : memberTokenCollectCard(svc.key, onCollect);
  else if (svc.key === 'figma' || svc.key === 'clickup' || svc.key === 'github') collect = !isAdmin ? quietCollectFace('권한 필요', `이 워크스페이스의 구성원이 켤 수 있어요 — 켜면 ${svc.label}의 ${unit}${eulReul(unit) === '을' ? '이' : '가'} 함께 보는 자료함으로 들어옵니다.`, onCollect)
    : st !== 'on' ? quietCollectFace('꺼짐', svc.key === 'github' ? '위 [내 계정으로 직접 사용]을 먼저 켜면 여기서 켤 수 있어요 — 연결 화면에서 고른 저장소가 범위가 돼요.' : '위 [내 계정으로 직접 사용]에서 토큰을 저장하면 여기서 켤 수 있어요 — 내 토큰으로 읽어 와요.', onCollect)
    : memberTokenCollectCard(svc.key, onCollect);
  else collect = quietCollectFace('아직 없어요',
    `${svc.label}는 아직 자료 가져오기가 없어요. 위 [내 계정으로 직접 사용]으로 ${noun}${eulReul(noun)} 그때그때 읽어요 — 준비되면 여기서 켤 수 있어요.`, onCollect);

  // ── ③ 보는 사람 ──
  const whos = el('div', { class: 'cn-whos' },
    el('div', { class: 'cn-who' },
      el('div', { class: 'cn-who-t' }, icon('usr'), el('span', { text: '내 계정으로 직접 사용 — 나만' })),
      el('span', { class: 'cn-who-s', text: `내 ${svc.label} 계정으로 그 자리에서 일어납니다. 라이블리에 남지 않으니 다른 사람은 볼 수 없어요.` })),
    el('div', { class: 'cn-who team' },
      el('div', { class: 'cn-who-t' }, icon('team'), el('span', { text: '가져온 자료 — 워크스페이스 함께' })),
      el('span', { class: 'cn-who-s', text: '자료함에 쌓인 것은 이 워크스페이스 사람들의 AI가 함께 찾아봅니다. 그래서 «무엇을 가져올지»를 위에서 고릅니다.' })));

  // ── 내보내기(#2556) — 이 앱 **으로** 우리 것을 보내는 자리 ──
  //  종전엔 관리탭 [데이터 연결]에 «위키 아웃바운드»·«프로젝트 아웃바운드»라는 별개 화면으로 있었다. 그런데 그 둘은
  //  각각 «노션 이야기»·«클릭업 이야기»다 — 같은 앱을 두 화면에서 설명하면 노션을 보러 온 사람이 자기 노션 설정의
  //  절반을 못 찾는다. 그래서 그 앱 상세의 칸 하나로 들어왔다. 앞의 두 연결과 **반대 방향**이고, 켜고 끄는 것이
  //  워크스페이스 전체에 걸리는 설정이라 구성원 권한(memory)에서 보인다(2026-09-12 — 종전 admin 전용).
  const outbound = isAdmin && (svc.key === 'notion' || svc.key === 'clickup') ? el('div', {}) : null;
  if (outbound) {
    outbound.replaceChildren(skeleton('내보내기 설정을 불러오는 중'));
    void adminData().then((data) => {
      markEmbedded(outbound);
      if (svc.key === 'notion') void feedTargetsEditor(outbound, data); else void projectOutboundEditor(outbound, data);
    }).catch((e) => outbound.replaceChildren(errorNote(e, '내보내기 설정을 불러오지 못했습니다')));
  }

  // ── 연결 지우기 — 잃는 것만 말한다(#1582) ──
  const gone = st === 'on' ? el('div', { class: 'cn-gone' }, icon('x'),
    el('span', { class: 'm', text: '연결을 지우면 직접 사용도 자료 가져오기도 함께 멈추고, 이미 가져온 자료는 자료함에 남습니다.' }),
    el('button', { class: 'btn btn-ghost btn-sm cn-dz-btn', type: 'button', text: svc.label + ' 연결 지우기', onclick: () => void disconnect() })) : null;

  //  ★ #4970 — 맨 위 «연결하는 길»: 이 앱을 잇는 길을 권하는 순서대로(서버 org_connect_status). 권하는 길이 지금 할 일 하나를 먼저 보인다.
  //   라이블리 앱 길의 [연결]은 그 자리에서 시작할 수 있는 앱(슬랙·깃허브 — 계정 허용 한 번)만 바로 열고, 나머지(노션 페이지 고르기 ·
  //   구글 서비스 고르기 · 리니어·아웃룩 켜기)는 그 앱만의 단추가 있는 아래 «자료 가져오기» 칸으로 보낸다(같은 연결을 두 벌로 만들지 않는다).
  const toCollect = (): void => {
    const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById('cn-tool')?.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
    collect.row.classList.add('cn-flash');
    setTimeout(() => collect.row.classList.remove('cn-flash'), 1800);
  };
  //  연결 상태를 못 읽었어도 길 칸은 선다(다시 불러오기 단추) — 아래 칸들이 «위 «연결하는 길» 을 봐 주세요» 라고 가리키는 자리가 늘 있게.
  const routesApp: ConnectAppStatus = connApp ?? {
    app: svc.key, label: svc.label, app_ready: null, routes: null, recommended: null, blocked_before: null,
    can_register: false, connect_url: null, skill: '', note: null, error: '연결 상태를 불러오지 못했어요',
  };
  const routes = routesSection(routesApp, {
    startAppConnect: account && (svc.key === 'slack' || svc.key === 'github') ? () => { void startOAuth(svc, reload); } : null,
    toCollect, openToken: svc.token ? () => openToken(svc, reload) : null, reload, canManage: isAdmin,
  });

  host.replaceChildren(el('div', { class: 'v2-wide v2-connect-app' },
    backLink(),
    ...(hiddenNote ? [hiddenNote] : []),
    ...(arrived ? [arrived] : []),
    el('div', { class: 'cn-head' }, svcTile(svc.key, svc.label, st === 'on'),
      el('div', { class: 'cn-head-tt' }, el('h1', { class: 'v2-title', text: svc.label }),
        el('p', { class: 'v2-desc', style: 'margin-top:4px', text: String((svc as any).blurb || '') }))),
    routes,
    el('section', { class: 'cn-sect', id: 'cn-tool' },
      sectHead('1', `${svc.label} 연결 두 가지`, '따로 켜고 끕니다'),
      ...decideRows(svc.label, axes, skip, svc.key, reload),
      el('div', { class: 'cn-actlist' }, readRow, collect.row)),
    el('section', { class: 'cn-sect', id: 'cn-collect-sect' },
      sectHead('2', '가져올 자료 정하기', '내 쓰임에 맞게 정합니다'),
      collect.box),
    ...(outbound ? [el('section', { class: 'cn-sect', id: 'cn-out' },
      sectHead('3', '내보내기', svc.key === 'notion' ? '우리 위키의 지식을 노션으로 보냅니다' : '우리 프로젝트와 과업의 변경을 ClickUp으로 보냅니다'),
      outbound)] : []),
    el('section', { class: 'cn-sect', id: 'cn-who' },
      sectHead(outbound ? '4' : '3', '보는 사람', '직접 사용은 나만, 가져온 자료는 워크스페이스가 함께'),
      whos),
    ...(gone ? [gone] : [])));
}

// ── 자료 가져오기(#1881) — 슬랙 수집을 토글 하나로. 상태·토글·비공개 채널 안내를 한 카드에. ──
// ── 연결된 저장소(#1881 G10) — "목록에 보이는 것"과 "clone 되는 것"의 경계를 드러낸다 ──────────────
//  레포 목록은 user token(`/user/repos`)이라 내가 볼 수 있는 전부가 나오고, clone 은 installation token 이라
//  설치 때 고른 것만 된다. 목록을 좁히는 건 답이 아니다(드롭다운은 제안이지 제약이 아니다 — #825).
//  대신 **어느 것이 열려 있는지 표시하고**, 안 열린 걸 쓰려면 GitHub 설치 화면으로 보낸다.
function githubReposCard(): HTMLElement {
  const body = el('div', { class: 'cn-help' }, ...uiText('불러오는 중…'));
  const box = el('div', {}, body);   // #2243 — [열린 저장소 보기] 로 펼쳐지는 상자
  const paint = async (): Promise<void> => {
    let st: any, disc: any;
    try {
      st = await api('/api/ui/org/github/connect');
      disc = await api('/api/ui/repos/discover', { method: 'POST', body: JSON.stringify({ host: 'github.com' }) }).catch(() => ({ options: [] }));
    } catch (e) { body.replaceChildren(errorNote(e, '저장소 목록을 불러오지 못했습니다')); return; }

    const open: string[] | null = Array.isArray(st?.open_repositories) ? st.open_repositories : null;
    const openSet = new Set((open ?? []).map((x) => String(x).toLowerCase()));
    const all = (disc?.options ?? []) as Array<{ full_path: string; private?: boolean }>;
    const rows: HTMLElement[] = [];

    if (open === null) {
      //  알 수 없음 — 목록을 막지 않는다. 매니지드는 private key 가 CP 에 있어 여기서 못 물어볼 수 있다.
      rows.push(el('p', { class: 'cn-help' }, ...uiText('어느 저장소가 열려 있는지 확인하지 못했습니다 — 아래 목록은 내 계정이 볼 수 있는 전부입니다.')));
    } else {
      rows.push(el('p', { class: 'cn-help' }, ...uiText(
        open.length
          ? `AI가 코드를 가져올 수 있는 저장소는 ${open.length}개입니다. 나머지는 목록에 보여도 가져오지 못합니다.`
          : '아직 열어 준 저장소가 없습니다 — 아래 [저장소 고르기]에서 고르면 그때부터 코드를 가져올 수 있어요.')));
    }

    for (const r of all.slice(0, 40)) {
      const isOpen = openSet.has(String(r.full_path).toLowerCase());
      rows.push(el('div', { class: 'cn-repo-row' },
        el('span', { class: 'v2-k', text: r.full_path }),
        r.private ? el('span', { class: 'dm-tag', text: '비공개' }) : null,
        open === null ? null
          : el('span', { class: isOpen ? 'dm-tag dm-tag-ok' : 'dm-tag', text: isOpen ? '열림' : '안 열림' })));
    }
    if (all.length > 40) rows.push(el('p', { class: 'cn-help' }, ...uiText(`… 외 ${all.length - 40}개`)));

    //  안 열린 저장소를 쓰려면 GitHub 설치 화면에서 추가해야 한다 — 우리 화면에서 할 수 있는 일이 아니다.
    const add = el('button', {
      class: 'btn btn-ghost btn-sm', type: 'button', text: '저장소 고르기 (GitHub에서)',
      onclick: async () => {
        try {
          const r: any = await api('/api/ui/org/github/connect', { method: 'POST', body: JSON.stringify({}) });
          if (r?.authorization_url) window.open(r.authorization_url, '_blank', 'noopener');
          toast('GitHub 화면에서 저장소를 고르고 허용하면 이 목록에 반영됩니다');
        } catch (e: any) { toast((e && e.message) || '열지 못했습니다', true); }
      },
    });
    const refresh = el('button', { class: 'btn-text', type: 'button', text: '새로고침', onclick: () => void paint() });
    body.replaceChildren(...rows, el('div', { class: 'cn-acts' }, add, refresh));
  };
  void paint();
  return box;
}

function slackTeamCollectCard(onState: CollectState): CollectFace {
  const panel = collectFace(onState, true, 'slack');
  const body = panel.body;
  const paint = async (): Promise<void> => {
    let s: any;
    try { s = await api('/api/ui/org/slack/collect'); }
    catch (e) { body.replaceChildren(errorNote(e, '수집 상태를 불러오지 못했습니다')); return; }
    const chk = el('input', { type: 'checkbox' }) as HTMLInputElement;
    chk.checked = !!(s.search && s.search.enabled);
    //  아직 아무도 안 켰고 내 Slack 연결도 없다 → 켤 수 없다고 카드가 직접 말한다(빈 스위치를 켜 봐야 서버가 거절한다).
    const noCred = !chk.checked && s.me_connected === false;
    if (noCred) chk.disabled = true;
    const notes: string[] = [];
    if (noCred) {
      notes.push('위 [내 계정으로 직접 사용]을 먼저 켜 주세요 — 내 Slack 연결로 공개 채널을 읽어 옵니다.');
    } else if (s.search && s.search.enabled) {
      const last = s.last_run?.finished_at || s.last_run?.started_at;
      notes.push(`**${everyLabel(s.sync_interval_sec)}마다** 저절로 미리 읽어 자료함에 둡니다.`
        + (last ? ` ${relTime(last)}에 마지막으로 읽었어요.` : ' 첫 수집을 기다리는 중이에요.')
        + (s.search.member ? ` ${s.search.member} 님의 연결로 돌고 있어요.` : '')
        + (s.search.member_connected === false ? ' 그 연결이 끊겼습니다 — 껐다 켜면 내 연결로 바뀝니다.' : ''));
    } else {
      notes.push('켜면 내 Slack 연결로 공개 채널을 읽어 옵니다. 팀원 모두의 AI가 그 자료를 찾아볼 수 있어요.');
    }
    if (!noCred) notes.push(s.bot && s.bot.available
      ? (s.bot.enabled ? '비공개 채널도 모으려면 그 채널에서 `/invite @Lively` 를 입력하세요 — 초대된 채널만 읽습니다.'
                       : '비공개 채널은 켜면 함께 가져옵니다 — 그 채널에서 `/invite @Lively` 로 초대한 것만.')
      : '비공개 채널까지 모으려면 Lively 봇이 필요해요 — [다시 연결]하면 봇이 함께 설치됩니다.');

    chk.onchange = async () => {
      chk.disabled = true;
      try {
        await api('/api/ui/org/slack/collect', { method: 'POST', body: JSON.stringify({ enabled: chk.checked }) });
        toast(chk.checked ? '자료 가져오기를 켰어요 — 첫 수집은 잠시 뒤 시작됩니다' : '자료 가져오기를 껐어요');
      } catch (e: any) { toast((e && e.message) || '바꾸지 못했습니다', true); }
      await paint();
    };
    //  #2243 — 채널도 여기서 고른다. 종전엔 관리탭 수집기 설정에만 있었고, 검색 모드(개인 연결)에는 포함 지정 자체가 없었다.
    const scopeNode = scopeChooser('slack', { channels: String(s.channels ?? '') }, true, async (sc) => {
      try {
        await api('/api/ui/org/slack/collect', { method: 'POST', body: JSON.stringify({ enabled: true, channels: sc.channels ?? '' }) });
        toast(String(sc.channels ?? '').trim() ? '가져올 채널을 저장했어요' : '전체 공개 채널을 가져옵니다');
      } catch (e: any) { toast((e && e.message) || '바꾸지 못했습니다', true); }
      await paint();
    });
    const chanExtra = collectSettings({
      key: 'slack',
      s: { ...s, scope: {}, collector_id: s.search?.collector_id ?? null, enabled: !!s.search?.enabled },
      scopeNode: setRow('어디서', '가져올 대화', [scopeNode]),
      since: String(s.backfill_since ?? ''),
      save: async (patch) => {
        try {
          await api('/api/ui/org/slack/collect', { method: 'POST', body: JSON.stringify({ enabled: !!s.search?.enabled, ...patch }) });
          toast('저장했어요');
        } catch (e: any) { toast((e && e.message) || '바꾸지 못했습니다', true); }
        await paint();
      },
    });
    panel.set(chk, chk.checked ? '켜짐' : '꺼짐', notes, chanExtra);
  };
  void paint();
  return { box: panel.box, row: panel.row };
}

// ── 모아 두기(#2247 피그마·ClickUp) — 토큰형 앱의 공통 카드. 서버는 org_<app>_collect(_set) 한 쌍(member-collect.ts 팩토리).
//  피그마는 범위(파일 링크/팀 id)가 없으면 서버가 needs_scope 로 켜 주지 않는다 — 그래서 이 카드에 범위 칸이 있다.
const MEMBER_COLLECT_TEXT: Record<string, { desc: string; on: string; off: string; where: string }> = {
  figma: { desc: '내가 고른 파일의 코멘트만 라이블리가 미리 읽어 자료함으로 가져와요. 워크스페이스가 함께 봐요.',
    on: '고른 파일의 코멘트를 가져오고 있어요.', off: '켜면 내 Figma 토큰으로 고른 파일의 코멘트를 읽어 옵니다.', where: '워크스페이스 함께 — 가져온 자료는 함께 검색해요' },
  clickup: { desc: '내 ClickUp 워크스페이스의 작업·댓글을 라이블리 프로젝트 탭으로 가져와요. 자료함이 아니라 프로젝트로 들어옵니다.',
    on: '작업·댓글을 프로젝트 탭으로 가져오고 있어요.', off: '켜면 내 ClickUp 토큰으로 워크스페이스의 작업·댓글을 프로젝트 탭으로 가져옵니다.', where: '워크스페이스 함께 — 프로젝트 탭에서 같이 봐요' },
  linear: { desc: '워크스페이스의 이슈·댓글과 문서를 라이블리가 미리 읽어 자료함으로 가져와요. 팀으로 좁힐 수 있어요. 워크스페이스가 함께 봐요.',
    on: '이슈·댓글·문서를 가져오고 있어요.', off: '켜면 Linear 화면이 열려요. «허용» 한 번이면 연결과 가져오기가 함께 켜집니다.', where: '워크스페이스 함께 — 가져온 자료는 함께 검색해요' },
  //  #4211 — Outlook 은 Linear 처럼 토글이 곧 연결이다(자격이 없으면 Microsoft 동의 화면이 열린다).
  outlook: { desc: '내 메일(받은·보낸 편지함 등)을 라이블리가 미리 읽어 자료함으로 가져와요. 지운 편지함·정크·임시 보관함은 빼요. 워크스페이스가 함께 봐요.',
    on: '내 메일을 가져오고 있어요.', off: '켜면 Microsoft 화면이 열려요. «허용» 한 번이면 연결과 가져오기가 함께 켜집니다.', where: '워크스페이스 함께 — 가져온 자료는 함께 검색해요' },
  gitlab: { desc: '내가 고른 프로젝트의 이슈·MR 대화와 릴리스 노트만 라이블리가 미리 읽어 자료함으로 가져와요. 워크스페이스가 함께 봐요.',
    on: '고른 프로젝트의 이슈·MR 대화를 가져오고 있어요.', off: '켜면 내 GitLab 개인 토큰으로 고른 프로젝트의 이슈·MR 대화를 읽어 옵니다.', where: '워크스페이스 함께 — 가져온 자료는 함께 검색해요' },
  github: { desc: '내가 고른 저장소의 이슈·PR 대화와 릴리스 노트만 라이블리가 미리 읽어 자료함으로 가져와요. 워크스페이스가 함께 봐요.',
    on: '고른 저장소의 이슈·PR 대화를 가져오고 있어요.', off: '켜면 내 GitHub 연결로 고른 저장소의 이슈·PR 대화를 읽어 옵니다. 연결 화면에서 고른 저장소가 기본 범위예요.', where: '워크스페이스 함께 — 가져온 자료는 함께 검색해요' },
};
/**
 * 라이블리 소유 OAuth 앱이 있어야 켜지는 앱(#2247 Linear · #4211 Outlook) — 앱이 없으면(app_ready=false) 스위치를 막는다.
 *  앱 등록은 이 칸이 아니라 위 «연결하는 길» 의 앱 등록 칸에서 한다(#4970 — 앱마다 흩어진 등록 칸을 한 벌로 모았다).
 */
const NEEDS_APP: ReadonlySet<string> = new Set(['linear', 'outlook']);
/** 범위 칸 — 앱마다 «무엇을 적는가»만 다르다. parse 가 입력 문자열을 서버 scope 로 바꾼다. */
const SCOPE_FIELD: Record<string, { ph: string; keys: string[]; parse: (t: string) => Record<string, string>; missing: string; note: string }> = {
  figma: { ph: '피그마 파일 링크 — 주소창에서 복사, 여러 개면 공백으로. 팀 전체는 팀 id', keys: ['file_keys', 'team_ids'], parse: (t) => figmaScopeOf(t) as Record<string, string>,
    missing: '파일 링크나 팀 id 를 하나는 넣어 주세요', note: '아직 범위가 없어요 — 아래에 파일 링크(또는 팀 id)를 넣고 켜 주세요. 피그마엔 목록이 없어서 링크로 정합니다.' },
  linear: { ph: '팀 키 — 예 ENG PRD (비우면 워크스페이스 전체)', keys: ['teams'], parse: (t): Record<string, string> => ({ teams: t.trim() }),
    missing: '', note: '' },
  gitlab: { ph: 'group/project — 여러 개면 공백으로. GitLab 주소를 그대로 붙여넣어도 돼요', keys: ['projects'], parse: (t): Record<string, string> => (t.trim() ? { projects: t.trim() } : {}),
    missing: '프로젝트 경로를 하나는 넣어 주세요(group/project)', note: '아직 범위가 없어요 — 아래에 프로젝트 경로(group/project)를 넣고 켜 주세요.' },
  github: { ph: 'owner/repo — 여러 개면 공백으로. GitHub 주소를 그대로 붙여넣어도 돼요', keys: ['repos'], parse: (t): Record<string, string> => (t.trim() ? { repos: t.trim() } : {}),
    missing: '저장소를 하나는 넣어 주세요(owner/repo)', note: '아직 범위가 없어요 — 아래에 저장소(owner/repo)를 넣고 켜 주세요. [계정으로 연결]에서 저장소를 골랐다면 켤 때 그게 기본값이 됩니다.' },
};
/** 피그마 범위 입력 → 서버 scope. 숫자만인 토막은 팀 id, 나머지는 파일 링크(키). */
export function figmaScopeOf(text: string): { file_keys?: string; team_ids?: string } {
  const toks = String(text || '').split(/\s+/).map((x) => x.trim()).filter(Boolean);
  const teams = toks.filter((x) => /^\d{5,}$/.test(x)), files = toks.filter((x) => !/^\d{5,}$/.test(x));
  const out: { file_keys?: string; team_ids?: string } = {};
  if (files.length) out.file_keys = files.join(' ');
  if (teams.length) out.team_ids = teams.join(' ');
  return out;
}
/**
 * 범위 고르기(#2243) — **외부 앱에 들어가지 않고** 우리 화면에서 토글로 고른다.
 *
 *  왜: 범위의 최소 단위(저장소·프로젝트·팀·파일·리스트·채널)를 동의 화면에서 고르게 해 주는 앱은 셋뿐이라
 *   (노션·GitHub·ClickUp OAuth), 나머지는 사용자가 `owner/repo`·팀 키를 **외워서 손으로 쳐야** 했다
 *   (조사: collector-scope-personalization-per-app-2243). 그 사람의 자격으로 목록을 받아 체크박스로 준다.
 *  ⚠ 목록을 못 만드는 경우가 **정상적으로 존재한다**(피그마는 팀 id 없이 열거 불가 — 상류 제약).
 *   그때는 에러가 아니라 종전 텍스트 칸으로 떨어진다. 목록이 없다고 범위를 못 정하면 그게 막다른 길이다.
 */
function scopeChooser(app: string, cur: Record<string, string>, enabled: boolean,
  save: (scope: Record<string, string>) => Promise<void>): HTMLElement {
  const host = el('div', { class: 'cn-pick' }, srow('범위', '고를 수 있는 목록을 불러오는 중…', [], 'note'));
  const vals = (v: unknown): string[] => String(v ?? '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  void (async () => {
    let o: any = null;
    try { o = await api(`/api/ui/org/${app}/collect/options`); } catch (_) { o = null; }
    host.replaceChildren();
    const SF = SCOPE_FIELD[app];
    //  ── 목록을 못 만들었다 → 이유를 말하고 텍스트 칸으로(그 앱에 칸이 있으면).
    if (!o || o.freeform || !Array.isArray(o.options) || o.options.length === 0) {
      if (o && o.note) host.append(srow('', String(o.note), [], 'note'));
      if (!SF) return;
      const inp = el('input', { type: 'text', class: 'cn-scope-in', value: SF.keys.map((k) => cur[k]).filter(Boolean).join(' '), placeholder: SF.ph }) as HTMLInputElement;
      const btn = el('button', { class: 'btn btn-sm', type: 'button', text: enabled ? '범위 저장' : '이 범위로 켜기', onclick: async () => {
        const sc = SF.parse(inp.value);
        if (SF.missing && !Object.keys(sc).length) { toast(SF.missing, true); inp.focus(); return; }
        btn.setAttribute('disabled', 'true');
        await save(sc);
      } });
      host.append(el('div', { class: 'cn-scope-row' }, inp, btn));
      return;
    }
    //  ── 토글 목록.
    const chosen = new Set(vals(cur[o.key]));
    const rows: Array<{ id: string; box: HTMLInputElement; row: HTMLElement; text: string }> = [];
    const list = el('div', { class: 'cn-pick-list' });
    const count = el('span', { class: 'cn-pick-n' });
    const picked = (): string[] => rows.filter((r) => r.box.checked).map((r) => r.id);
    const summary = (): string => {
      const n = picked().length;
      if (n > 0) return `${n}개 선택됨`;
      return o.emptyMeansAll ? `아무것도 안 고르면 전체 ${o.unit}를 가져와요` : `가져올 ${o.unit}${eulReul(o.unit)} 하나는 골라 주세요`;
    };
    for (const opt of o.options as Array<{ id: string; label: string; hint?: string }>) {
      const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
      box.checked = chosen.has(opt.id);
      box.onchange = () => { count.textContent = summary(); };
      const row = el('label', { class: 'cn-pick-row' }, box, el('span', { class: 't', text: opt.label }),
        opt.hint ? el('span', { class: 'h', text: opt.hint }) : null);
      rows.push({ id: opt.id, box, row, text: (opt.label + ' ' + (opt.hint ?? '')).toLowerCase() });
      list.append(row);
    }
    count.textContent = summary();
    const bar: HTMLElement[] = [];
    //  많으면 찾기 칸 — 저장소·채널은 수백 개가 되기도 한다.
    if (rows.length > 8) {
      const q = el('input', { type: 'search', class: 'cn-pick-q', placeholder: `${o.unit} 이름으로 찾기`,
        oninput: () => { const t = q.value.trim().toLowerCase(); for (const r of rows) r.row.style.display = !t || r.text.includes(t) ? '' : 'none'; } }) as HTMLInputElement;
      bar.push(q);
    }
    const save1 = el('button', { class: 'btn btn-sm', type: 'button', text: enabled ? '범위 저장' : '이 범위로 켜기', onclick: async () => {
      const sel = picked();
      if (!sel.length && !o.emptyMeansAll) { toast(`가져올 ${o.unit}${eulReul(o.unit)} 하나는 골라 주세요`, true); return; }
      save1.setAttribute('disabled', 'true');
      await save({ [o.key]: sel.join(' ') });
    } });
    host.append(
      el('div', { class: 'cn-pick-hd' }, ...bar, count,
        el('button', { class: 'btn-text', type: 'button', text: '전체', onclick: () => { for (const r of rows) if (r.row.style.display !== 'none') r.box.checked = true; count.textContent = summary(); } }),
        el('button', { class: 'btn-text', type: 'button', text: '해제', onclick: () => { for (const r of rows) r.box.checked = false; count.textContent = summary(); } })),
      list,
      el('div', { class: 'cn-pick-ft' }, save1));
  })();
  return host;
}

// ══ 섹션 ② «자료함에 모아 두는 것» — 무엇을 · 얼마나 자주 · 언제부터 · 어디서 (#2243 3차) ═══════════
//  원준 2026-08-30: «저 30분이라는 숫자와 상세 설정들도 사용자가 개인화할 수 있도록 하고싶은데 그런 UI가 없음».
//  서버는 원래 수집기별로 갖고 있었다(org_collector.sync_interval_sec → 크론 collector-<id>) — 막혀 있던 건
//  멤버 창구뿐이라 이번에 뚫었다. 종류(include_*)·언제부터(backfill_since)도 커넥터가 이미 읽는 config 키다.

/** 앱이 «무엇을» 고르게 하는 종류 — 값은 config 키. 없는 앱은 그 줄을 «전부» 한 줄로 대신한다. */
const COLLECT_KINDS: Record<string, { always: string; opts: Array<{ id: string; label: string }> }> = {
  github: { always: '이슈 대화', opts: [{ id: 'include_prs', label: 'PR 리뷰 대화' }, { id: 'include_releases', label: '릴리스 노트' }] },
  gitlab: { always: '이슈 대화', opts: [{ id: 'include_mrs', label: 'MR 리뷰 대화' }, { id: 'include_releases', label: '릴리스 노트' }] },
  linear: { always: '이슈·댓글', opts: [{ id: 'include_documents', label: 'Linear 문서' }] },
};
/** «언제부터» 를 지원하는 앱(커넥터가 backfill_since 를 since 하한으로 쓴다). */
const HAS_BACKFILL = new Set(['github', 'gitlab', 'linear', 'slack', 'outlook']);
/** 자료함에 들어가는 kind — src/v6/mirror/mirror-source.ts 의 sourceKindOf 와 같은 표. ClickUp 은 프로젝트 미러라 없다. */
export const COLLECT_KIND_OF: Record<string, string> = {
  github: 'github_issue', gitlab: 'gitlab_issue', linear: 'linear_issue', figma: 'figma_comment', slack: 'slack', notion: 'notion_doc',
  outlook: 'email',
};
/** kind 를 다른 앱과 나눠 쓰는 앱의 system(#4211 — email 은 Gmail·Outlook 이 같이 쓴다). 자료 수를 셀 때 좁힌다. */
const COLLECT_SYSTEM_OF: Record<string, string> = { outlook: 'outlook' };
const SINCE_OPTS = [{ id: '30', label: '최근 30일' }, { id: '90', label: '90일' }, { id: '365', label: '1년' }, { id: '', label: '전부' }];
const EVERY_OPTS = [{ id: '600', label: '10분' }, { id: '1800', label: '30분' }, { id: '3600', label: '1시간' }, { id: '10800', label: '3시간' }, { id: '86400', label: '하루 한 번' }];

/** 저장된 날짜 → 세그먼트 id(가장 가까운 눈금). 비어 있으면 «전부». */
export function sinceBucket(iso: string): string {
  const t = Date.parse(String(iso || '').length === 10 ? iso + 'T00:00:00Z' : iso);
  if (!Number.isFinite(t)) return '';
  const days = Math.round((Date.now() - t) / 86400000);
  let best = SINCE_OPTS[0];
  for (const o of SINCE_OPTS) { if (!o.id) continue; if (Math.abs(Number(o.id) - days) < Math.abs(Number(best.id) - days)) best = o; }
  return best.id;
}
/** 세그먼트 id → 저장할 날짜(YYYY-MM-DD). «전부»는 빈 문자열. */
function sinceValue(id: string): string {
  if (!id) return '';
  return new Date(Date.now() - Number(id) * 86400000).toISOString().slice(0, 10);
}
const everyLabel = (sec: number | null): string =>
  EVERY_OPTS.find((o) => Number(o.id) === sec)?.label ?? (sec ? Math.round(sec / 60) + '분' : '30분');

interface SettingsCtx {
  key: string;
  /** 서버 상태(scope·sync_interval_sec·backfill_since·collector_id·enabled). */
  s: any;
  /** 바꾼 값을 저장한다 — 앱마다 창구가 달라(slack 은 최상위 키) 카드가 넘긴다. */
  save: (patch: Record<string, unknown>) => Promise<void>;
  /** 범위 칸(어디서) — 이미 만들어 둔 노드. */
  scopeNode: HTMLElement;
  /** 지금 저장된 «언제부터»(YYYY-MM-DD 또는 ''). */
  since: string;
}

/** 네 줄을 만든다 — 앱이 못 하는 줄은 지우지 않고 사실을 말한다(틀이 흔들리면 앱마다 다른 화면이 된다). */
function collectSettings(c: SettingsCtx): HTMLElement[] {
  const rows: HTMLElement[] = [];

  // ① 무엇을
  const K = COLLECT_KINDS[c.key];
  if (K) {
    const cur = new Set(K.opts.filter((o) => String(c.s.scope?.[o.id] ?? 'on') !== 'off').map((o) => o.id));
    rows.push(setRow('무엇을', '고른 종류만 가져옵니다', [
      el('div', { class: 'cn-chips' },
        el('span', { class: 'cn-chip on', style: 'cursor:default; opacity:.75' }, el('span', { text: K.always + ' (늘 모음)' })),
        chipSet(K.opts, cur, (picked) => {
          const patch: Record<string, string> = {};
          for (const o of K.opts) patch[o.id] = picked.has(o.id) ? 'on' : 'off';
          void c.save({ scope: patch });
        })),
    ]));
  } else {
    rows.push(setRow('무엇을', '', [el('span', { class: 'cn-set-hint', style: 'margin-top:0',
      text: c.key === 'figma' ? '고른 파일의 코멘트를 가져옵니다 — 이 앱은 종류를 나눠 고를 수 없어요.'
        : c.key === 'outlook' ? '메일 본문과 보낸 사람·받는 사람을 가져옵니다 — 지운 편지함·정크·임시 보관함은 빼요.'
        : c.key === 'clickup' ? '작업·댓글·시간기록을 함께 가져옵니다 — 이 앱은 종류를 나눠 고를 수 없어요.'
        : '대화와 올린 파일 제목을 가져옵니다 — 이 앱은 종류를 나눠 고를 수 없어요.' })]));
  }

  // ② 얼마나 자주
  const cur = String(c.s.sync_interval_sec ?? 1800);
  const perDay = Math.round(86400 / Number(cur || 1800));
  rows.push(setRow('얼마나 자주', '다시 읽는 주기', [
    segment(EVERY_OPTS, EVERY_OPTS.some((o) => o.id === cur) ? cur : '1800', (id) => { void c.save({ sync_interval_sec: Number(id) }); }),
  ], `자주 읽을수록 최신이지만 그 앱의 사용량을 더 씁니다. 지금 설정이면 하루 ${perDay}번 읽어요.`));

  // ③ 언제부터
  if (HAS_BACKFILL.has(c.key)) {
    const b = sinceBucket(c.since);
    rows.push(setRow('언제부터', '처음 읽을 때 거슬러 올라갈 범위', [
      segment(SINCE_OPTS, b, (id) => { void c.save({ backfill_since: sinceValue(id) }); }),
      ...(c.s.collector_id ? [el('div', { style: 'margin-top:9px' },
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '지금 전부 다시 읽기', onclick: async (ev: Event) => {
          const b2 = ev.currentTarget as HTMLButtonElement; b2.disabled = true;
          try { await api(`/api/ui/org/collectors/${c.s.collector_id}/sync`, { method: 'POST', body: JSON.stringify({ full: true }) }); toast('처음부터 다시 읽기 시작했어요'); }
          catch (e: any) { toast((e && e.message) || '시작하지 못했습니다', true); b2.disabled = false; }
        } }))] : []),
    ], '이미 모은 것은 그대로 둡니다. 범위를 넓혔으면 [지금 전부 다시 읽기]를 눌러야 과거가 들어와요.'));
  } else {
    rows.push(setRow('언제부터', '', [el('span', { class: 'cn-set-hint', style: 'margin-top:0',
      text: '이 앱은 내가 볼 수 있는 것 전체를 훑고, 그 뒤로는 바뀐 것만 따라갑니다 — 시작 시점을 정할 수 없어요.' })]));
  }

  // ④ 어디서
  rows.push(c.scopeNode);
  return rows;
}

function memberTokenCollectCard(key: string, onState: CollectState): CollectFace {
  const T = MEMBER_COLLECT_TEXT[key];
  const panel = collectFace(onState, T.where !== '나만 봐요', COLLECT_KIND_OF[key] ?? '', COLLECT_SYSTEM_OF[key] ?? '');
  const body = panel.body;
  const post = async (bodyObj: any): Promise<any> => api(`/api/ui/org/${key}/collect`, { method: 'POST', body: JSON.stringify(bodyObj) });
  const paint = async (): Promise<void> => {
    let s: any;
    try { s = await api(`/api/ui/org/${key}/collect`); }
    catch (e) { body.replaceChildren(errorNote(e, '수집 상태를 불러오지 못했습니다')); return; }
    const chk = el('input', { type: 'checkbox' }) as HTMLInputElement;
    chk.checked = !!s.enabled;
    const notes: string[] = [];
    if (s.enabled) {
      const last = s.last_run?.finished_at || s.last_run?.started_at;
      notes.push(`**${everyLabel(s.sync_interval_sec)}마다** 저절로 미리 읽어 자료함에 둡니다.`
        + (last ? ` ${relTime(last)}에 마지막으로 읽었어요.` : ' 첫 수집을 기다리는 중이에요.')
        + (s.member ? ` ${s.member} 님의 연결로 돌고 있어요.` : '')
        + (s.member_connected === false ? ' 그 토큰이 지워졌습니다 — 껐다 켜면 내 토큰으로 바뀝니다.' : ''));
    } else notes.push(T.off);
    //  #2243 — 범위는 목록에서 토글로 고른다(못 만들면 텍스트 칸으로 떨어진다).
    //  #4211 Outlook 은 고를 범위가 없다(내 메일함 하나) — 목록을 물을 창구도 없으니 사실만 말한다.
    const scopeNode = key === 'outlook' ? el('span', { class: 'cn-set-hint', style: 'margin-top:0', text: '연결한 내 메일함 전체예요 — 지운 편지함·정크·임시 보관함은 빼고 가져옵니다.' })
      : scopeChooser(key, (s.scope ?? {}) as Record<string, string>, !!s.enabled, async (sc) => {
      try {
        const r: any = await post({ enabled: true, scope: sc });
        if (r && r.ok) toast(s.enabled ? '범위를 저장했어요' : '자료 가져오기를 켰어요 — 첫 수집은 잠시 뒤 시작됩니다');
        else toast((r && r.message) || '바꾸지 못했습니다', true);
      } catch (e: any) { toast((e && e.message) || '바꾸지 못했습니다', true); }
      await paint();
    });
    //  #2243 3차 — «무엇을·얼마나 자주·언제부터» 는 켜기와 무관하게 저장된다(꺼져 있어도 미리 정해 둘 수 있다).
    const extra: HTMLElement[] = collectSettings({
      key, s, scopeNode: setRow('어디서', key === 'outlook' ? '가져올 메일' : SCOPE_NOUN[key] ? `가져올 ${SCOPE_NOUN[key]}` : '', [scopeNode]),
      since: String(s.scope?.backfill_since ?? ''),
      save: async (patch) => {
        try {
          const r: any = await post({ enabled: !!s.enabled, ...patch });
          if (r && r.ok) toast('저장했어요');
          else toast((r && r.message) || '바꾸지 못했습니다', true);
        } catch (e: any) { toast((e && e.message) || '바꾸지 못했습니다', true); }
        await paint();
      },
    });
    const SF = SCOPE_FIELD[key];
    if (s.needs_scope && SF && SF.note) notes.push(SF.note);
    //  #2247 Linear · #4211 Outlook — 라이블리 소유 OAuth 앱이 아직 등록되지 않았으면(app_ready=false) 스위치를 막고 그 사실을 말한다.
    //   (#4970) 등록 값은 위 «연결하는 길» 의 앱 등록 칸이 금고(조직 슬롯 <kind>/oauth:client)로 바로 넣는다 — 채팅·문서에 붙여넣을 일이 없다.
    const REG = NEEDS_APP.has(key);
    //  #4211 — 매니지드는 앱을 CP 가 쥔다(준비는 라이블리의 일). 준비 전이면 그 사실만 말한다.
    //   «켜면 … 화면이 열려요»(T.off)는 지운다 — 준비 전엔 열리지 않으니 두 문장이 서로를 부정한다(jsdom 실측).
    //  (#4970) 셀프호스트의 앱 등록은 위 «연결하는 길» 의 앱 등록 칸 한 곳에서 한다 — 여기엔 그리로 가라는 말만 남긴다.
    if (REG && s.app_ready === false) notes.splice(0, notes.length, s.managed === true
      ? `${key === 'outlook' ? 'Outlook' : 'Linear'} 연결은 라이블리가 준비하고 있어요 — 준비를 마치면 여기서 바로 켤 수 있습니다.`
      : '앱 등록이 먼저예요 — 위 «연결하는 길» 의 앱 등록 칸에서 할 수 있어요.');
    //  #4211 — Outlook 관리자 허용 링크는 ① «내 계정으로 직접 사용» 줄에 **한 번만** 둔다(연결은 하나라 안내도 하나 —
    //   두 칸에 같은 상자를 두면 화면에 같은 말이 두 번 선다. jsdom 실측으로 잡았다).
    //  #2247 Linear — 토글이 곧 연결. 자격이 없으면 서버가 동의 URL 을 준다: 새 탭으로 열고, 돌아온 것(me_connected)이 보이면 다시 켠다.
    const consentThen = async (r: any): Promise<boolean> => {
      if (!(r && r.needs_connect && r.authorization_url)) return false;
      window.open(r.authorization_url, '_blank', 'noopener');
      toast(T.desc.split(' ')[0] === '워크스페이스의' ? 'Linear 화면에서 «허용»을 누르세요. 돌아오면 여기가 저절로 켜집니다' : '새 탭에서 «허용»을 누르세요. 돌아오면 여기가 저절로 켜집니다');
      const until = Date.now() + 4 * 60 * 1000;
      const tick = async (): Promise<void> => {
        if (Date.now() > until) { await paint(); return; }
        let st: any = null;
        try { st = await api('/api/ui/org/' + key + '/collect'); } catch (_) { /* 다음 tick */ }
        if (st && st.me_connected) {
          try { const r2: any = await post({ enabled: true }); if (r2 && r2.ok) toast('자료 가져오기를 켰어요 — 첫 수집은 잠시 뒤 시작됩니다'); } catch (_) { /* 화면이 상태를 보여준다 */ }
          await paint(); return;
        }
        setTimeout(() => { void tick(); }, 3000);
      };
      setTimeout(() => { void tick(); }, 3000);
      return true;
    };
    chk.onchange = async () => {
      chk.disabled = true;
      try {
        const r: any = await post({ enabled: chk.checked });
        if (r && r.ok) toast(chk.checked ? '자료 가져오기를 켰어요 — 첫 수집은 잠시 뒤 시작됩니다' : '자료 가져오기를 껐어요');
        else if (await consentThen(r)) { /* 동의 창을 열었다 — 폴링이 켠다 */ }
        else { toast((r && r.message) || '바꾸지 못했습니다', true); }
      } catch (e: any) { toast((e && e.message) || '바꾸지 못했습니다', true); }
      await paint();
    };
    if (REG && s.app_ready === false) chk.disabled = true;   // 앱이 없으면 켤 수 없다 — 등록 칸이 먼저
    panel.set(chk, chk.checked ? '켜짐' : (REG && s.app_ready === false ? (s.managed === true ? '준비 중' : '앱 등록 필요') : (s.needs_scope && SF ? '범위 필요' : '꺼짐')), notes, extra);
  };
  void paint();
  return { box: panel.box, row: panel.row };
}

// ── 자료 가져오기(#1881 노션) — 토글이 곧 연결: 켜면 노션 화면이 열리고 거기서 고른 페이지가 수집 범위가 된다.
//  슬랙 카드와 달리 개인 연결 상태를 보지 않는다 — 조직 슬롯(공개 통합 토큰)이 따로 있고, 이 카드가 그 전부를 다룬다.
function notionTeamCollectCard(onState: CollectState): CollectFace {
  const panel = collectFace(onState);
  const body = panel.body;
  const openConsent = (url: string, after: () => void): void => {
    window.open(url, '_blank', 'noopener');
    toast(`${NOTION_PICK_TIP} 다 고르고 [액세스 허용]을 누르면 이 화면이 갱신됩니다`);
    window.addEventListener('focus', () => after(), { once: true });
  };
  const paint = async (): Promise<void> => {
    let s: any;
    try { s = await api('/api/ui/org/notion/collect'); }
    catch (e) { body.replaceChildren(errorNote(e, '수집 상태를 불러오지 못했습니다')); return; }
    const wsAll = (s && s.workspaces) || [];
    const wsName = (w: any): string => (w && (w.name || w.id)) || '';
    const on = wsAll.filter((w: any) => w.enabled);
    const chk = el('input', { type: 'checkbox' }) as HTMLInputElement;
    chk.checked = !!(s && s.enabled);
    if (!(s && s.ready) && !wsAll.length) chk.disabled = true; // 시작할 길이 없다 — 눌러도 안 되는 토글을 내밀지 않는다
    const notes: string[] = [];
    if (s && s.enabled) {
      notes.push(on.length > 1
        ? `노션 워크스페이스 ${on.length}곳에서 가져오고 있어요 — 각 워크스페이스에서 고른 페이지(와 그 하위)만 읽습니다.`
        : `'${wsName(on[0] || wsAll[0])}' 워크스페이스에서 가져오고 있어요 — 노션에서 고른 페이지(와 그 하위)만 읽습니다.`);
      //  #1968 — 첫 수집이 끝나면 모은 페이지 수로 말한다. 끝나기 전엔 수를 말하지 않는다(그때의 0 은 «0개»가 아니다).
      const n = notionCollectedPages(s);
      if (n !== null) notes.push(`${notionCollectedLine(n)} ${n > 0 ? '빠진 페이지는 아래 [페이지 더 고르기]로 보태면 됩니다.' : '아래 [페이지 더 고르기]로 모을 페이지를 골라 주세요.'}`);
      else if (on.some((w: any) => !w.first_sync_done)) notes.push('첫 수집이 끝나면 모은 페이지 수가 여기 보여요.');
    }
    else if (wsAll.length) notes.push(wsAll.length > 1
      ? `노션 워크스페이스 ${wsAll.length}곳이 연결돼 있어요 — 켜면 바로 모으기 시작합니다.`
      : '연결은 돼 있어요 — 켜면 바로 모으기 시작합니다.');
    else if (s && s.ready) notes.push(`켜면 노션 화면이 열려요. ${NOTION_PICK_TIP} 토큰이나 설정을 만질 일은 없어요.`);
    //  (#4970) 셀프호스트의 노션 통합 등록은 위 «연결하는 길» 의 앱 등록 칸 한 곳에서 한다(종전 이 자리의 «통합 값 저장» 칸을 그리로 모았다).
    else notes.push('노션 연결 준비가 아직 안 됐어요 — 위 «연결하는 길» 을 봐 주세요.');
    const extra: HTMLElement[] = [];
    if (wsAll.length > 1) {
      // 워크스페이스마다 한 줄 — 하나가 실패해도 나머지는 돈다(수집기가 워크스페이스당 하나, #1881 N7).
      extra.push(el('div', { class: 'cn-ws-list' }, ...wsAll.map((w: any) => {
        const c = el('input', { type: 'checkbox' }) as HTMLInputElement;
        c.checked = !!w.enabled;
        c.onchange = async () => {
          c.disabled = true;
          try {
            await api('/api/ui/org/notion/collect', { method: 'POST', body: JSON.stringify({ enabled: c.checked, workspace_id: w.id }) });
            toast(c.checked ? `'${wsName(w)}' 모으기를 켰어요` : `'${wsName(w)}' 모으기를 껐어요`);
          } catch (e: any) { toast((e && e.message) || '바꾸지 못했습니다', true); }
          await paint();
        };
        //  #1968 — 첫 수집이 끝난 워크스페이스는 모은 페이지 수를 이름 옆에 붙인다(어느 곳에서 빠졌는지 보이게).
        const counted = w.first_sync_done && typeof w.pages === 'number' ? ` · 페이지 ${w.pages.toLocaleString('ko-KR')}개` : '';
        return el('label', { class: 'cn-toggle' }, c, el('span', { text: ' ' + wsName(w) + counted }));
      })));
    }
    if (wsAll.length) {
      extra.push(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: wsAll.length > 1 ? '페이지 더 고르기 · 워크스페이스 추가' : '페이지 더 고르기 · 다른 워크스페이스 추가',
        onclick: async () => {
          try {
            const r: any = await api('/api/ui/org/notion/collect/connect', { method: 'POST' });
            if (r && r.authorization_url) openConsent(r.authorization_url, () => void paint());
            else toast('노션 화면을 열지 못했습니다', true);
          } catch (e: any) { toast((e && e.message) || '노션 화면을 열지 못했습니다', true); }
        } }));
      //  #1968 — 다시 고르러 가는 버튼 바로 아래에 같은 안내를 둔다(노션 화면엔 전체 선택이 없다).
      extra.push(el('span', { class: 'cn-set-hint', text: NOTION_PICK_TIP }));
    }
    chk.onchange = async () => {
      chk.disabled = true;
      try {
        const r: any = await api('/api/ui/org/notion/collect', { method: 'POST', body: JSON.stringify({ enabled: chk.checked }) });
        if (r && r.needs_connect && r.authorization_url) {
          // 동의가 먼저다 — 노션에서 페이지를 고르고 돌아오면 다시 켜서 수집기를 만든다(멱등).
          openConsent(r.authorization_url, () => {
            void api('/api/ui/org/notion/collect', { method: 'POST', body: JSON.stringify({ enabled: true }) })
              .then((rr: any) => { if (rr && rr.ok) toast('자료 가져오기를 켰어요 — 첫 수집은 잠시 뒤 시작됩니다'); })
              .catch(() => { /* 동의 전에 돌아옴 — 화면 갱신만 */ })
              .finally(() => void paint());
          });
        } else if (r && r.ok) {
          toast(chk.checked ? '자료 가져오기를 켰어요 — 첫 수집은 잠시 뒤 시작됩니다' : '자료 가져오기를 껐어요');
        }
      } catch (e: any) { toast((e && e.message) || '바꾸지 못했습니다', true); }
      await paint();
    };
    //  #2243 — 노션의 범위는 «노션 동의 화면에서 고른 페이지»다. 그래도 칸 이름은 다른 앱과 같아야 한다.
    panel.set(chk, (s && s.enabled) ? (on.length > 1 ? `켜짐 · ${on.length}곳` : '켜짐') : '꺼짐', notes, [
      setRow('무엇을', '고른 페이지와 그 하위', [el('span', { class: 'cn-set-hint', style: 'margin-top:0',
        text: '노션은 종류를 나눠 고를 수 없어요 — 고른 페이지 아래의 문서를 함께 가져옵니다.' })]),
      setRow('얼마나 자주', '다시 읽는 주기', [el('span', { class: 'cn-set-hint', style: 'margin-top:0',
        text: '노션은 아직 주기를 고를 수 없어요 — 기본 주기로 돕니다.' })]),
      setRow('어디서', '가져올 워크스페이스와 페이지', extra),
    ]);
  };
  void paint();
  return { box: panel.box, row: panel.row };
}

// ── 자료 가져오기 · 구글(#1881 G5) ─────────────────────────────────────────────
//  슬랙·노션 카드와 같은 뼈대인데 축이 하나 더 있다: **어떤 서비스를 모을지**.
//  그게 취향 문제가 아니라 돈 문제라서다 — Gmail 은 구글 '제한범위'라 앱 심사(CASA, 연 수백~수천 달러)나
//  미검증 100명 한도를 끌고 오고, 드라이브는 그렇지 않다. 그 100 은 프로젝트 수명 누적이고 되돌릴 수 없어서,
//  안 쓰는 Gmail 을 기본으로 켜 두면 구성원 한 명이 연결할 때마다 한 칸씩 영구히 사라진다.
//  → 기본은 드라이브만. Gmail 은 사람이 명시적으로 고르고, 그 대가를 화면이 먼저 말한다.
//  (근거·수치: 지식 google-single-connect-design-1881 §9)
function googleTeamCollectCard(onState: CollectState): CollectFace {
  const panel = collectFace(onState);
  const body = panel.body;
  const openConsent = (url: string, after: () => void): void => {
    window.open(url, '_blank', 'noopener');
    toast('구글 화면에서 «허용»을 누르세요. 돌아오면 이 화면이 갱신됩니다');
    window.addEventListener('focus', () => after(), { once: true });
  };
  const paint = async (): Promise<void> => {
    let s: any;
    try { s = await api('/api/ui/org/google/collect'); }
    catch (e) { body.replaceChildren(errorNote(e, '수집 상태를 불러오지 못했습니다')); return; }
    const cols: any[] = (s && s.collectors) || [];
    const of = (k: string) => cols.find((c) => c.service === k) || {};
    const drive = of('drive'), gmail = of('gmail');
    // 도구 전용(수집기 없음) — 일정은 자료로 모으지 않고 AI 가 그때그때 읽는다. 서버가 tools 로 내려 준다.
    const tools: any[] = (s && s.tools) || [];
    const cal = tools.find((t) => t.service === 'calendar') || {};
    const connected = !!(s && s.connected);
    const anyOn = !!(drive.enabled || gmail.enabled);

    // 서비스 선택 — 체크박스가 곧 요청 scope 다(안 고른 건 동의도 안 받는다 = 최소 권한).
    // Gmail 을 팔지 않는 게이트웨이(옛 판·판매 목록 밖)는 서버가 offered:false 로 알려 준다. 칸을 아예 내밀지 않되,
    //  **이미 켜 둔 조직에는 상태만 보여 준다**(칸이 사라지면 "왜 아직 메일이 모이지?" 를 아무도 설명 못 한다).
    //  #4211 — 지금 판은 Gmail 도 판다(2026-09-22). 이 갈래는 옛 게이트웨이·되돌림을 위해 남긴다.
    const gmailOffered = gmail.offered !== false;
    const gmailLegacy = !gmailOffered && !!gmail.enabled;
    const dChk = el('input', { type: 'checkbox' }) as HTMLInputElement;
    const gChk = el('input', { type: 'checkbox' }) as HTMLInputElement;
    dChk.checked = drive.enabled !== false && (drive.enabled || !anyOn); // 기본 드라이브만
    gChk.checked = !!gmail.enabled;
    const calOffered = cal.offered !== false;
    const cChk = el('input', { type: 'checkbox' }) as HTMLInputElement;
    cChk.checked = !!cal.scope_ok; // 수집기가 없으니 '켜짐'의 뜻은 '허용했나' 하나뿐이다
    const picked = (): string[] => [
      ...(dChk.checked ? ['drive'] : []),
      ...(gmailOffered && gChk.checked ? ['gmail'] : []),
      ...(calOffered && cChk.checked ? ['calendar'] : []),
    ];

    const chk = el('input', { type: 'checkbox' }) as HTMLInputElement;
    chk.checked = anyOn;
    if (!(s && s.ready) && !connected) chk.disabled = true; // 시작할 길이 없다 — 눌러도 안 되는 토글을 내밀지 않는다

    const notes: string[] = [];
    if (anyOn) {
      const on = [drive.enabled ? 'Google Drive' : '', gmail.enabled ? 'Gmail' : ''].filter(Boolean).join(' · ');
      notes.push(`${on} 에서 가져오고 있어요 — 켠 사람(${(s.connected && s.connected.kind) ? '내' : '내'}) 구글 연결로 돕니다.`);
    } else if (connected) notes.push('연결은 돼 있어요 — 모을 서비스를 고르고 켜면 바로 시작합니다.');
    else if (s && s.ready) notes.push('켜면 구글 화면이 열려요. «허용»만 누르면 바로 시작됩니다. 토큰이나 설정을 만질 일은 없어요.');
    else notes.push('구글 연결 준비가 아직 안 됐어요 — 아래에 구글 OAuth 클라이언트 값 두 개를 넣으면 열립니다.');

    // ★ 비용 고지 — Gmail 을 고른 순간(또는 이미 켜진 순간) 무슨 대가가 붙는지 먼저 말한다.
    // ★ 여기서 거짓말을 하지 않는 것이 중요하다. Gmail 을 뺐다고 심사·한도가 0이 되는 게 아니다 —
    //  팀 문서를 통째로 읽는 범위(drive.readonly)도 구글은 민감하게 본다. 100명은 되돌릴 수 없으므로
    //  "제한 없음"으로 읽히면 그 오해의 대가를 나중에 치른다.
    const costLine = (): string =>
      gmailLegacy
        ? 'Gmail 은 지금 새로 켤 수 없어요(구글 심사 범위라 준비 중입니다) — 이미 켜져 있어서 그대로 돌아갑니다.'
        : '구글 심사를 마치기 전에는 회사 전체에서 100명까지 연결할 수 있어요(그 수는 되돌릴 수 없습니다). 연결할 때 구글이 "확인되지 않은 앱" 경고를 띄우는데, [고급] → [이동]으로 넘어가면 됩니다.';
    const cost = el('p', { class: 'cn-help' }, ...uiText(costLine()));
    const repaintCost = () => cost.replaceChildren(...uiText(costLine()));
    dChk.onchange = repaintCost; gChk.onchange = repaintCost; cChk.onchange = repaintCost;

    const svcRow = el('div', { class: 'cn-sec-form' },
      el('label', { class: 'cn-toggle' }, dChk, el('span', { text: ' Google Drive 문서' })),
      ...(calOffered ? [el('label', { class: 'cn-toggle' }, cChk,
        el('span', { text: ' 캘린더 일정 — AI가 읽기만 합니다(자료로 모으지 않아요)' }))] : []),
      ...(gmailOffered ? [el('label', { class: 'cn-toggle' }, gChk, el('span', { text: ' Gmail 메일' }))]
        : gmailLegacy ? [el('p', { class: 'cn-help' }, ...uiText('· Gmail 메일 — 예전에 켜 두신 것이 그대로 돌고 있어요'))]
        : []));

    const extra: HTMLElement[] = [];
    // 동의는 했는데 그 서비스 범위가 빠진 경우 — 켜 봐야 상류가 거부하므로 먼저 범위를 넓히게 한다.
    const missing = [
      !drive.scope_ok && dChk.checked ? 'Google Drive' : '',
      gmailOffered && !gmail.scope_ok && gChk.checked ? 'Gmail' : '',
      calOffered && !cal.scope_ok && cChk.checked ? '캘린더' : '',
    ].filter(Boolean);
    if (connected && missing.length) {
      // 캘린더는 '모으기'가 아니라 '읽기'다 — 문구가 하는 일과 어긋나면 사람이 다른 걸 기대한다.
      const onlyCal = missing.length === 1 && missing[0] === '캘린더';
      extra.push(el('p', { class: 'cn-help' }, ...uiText(
        `${missing.join(' · ')} 는 아직 허용하지 않으셨어요 — [권한 넓히기]로 한 번 더 허용하면 ` +
        (onlyCal ? 'AI가 일정을 읽을 수 있습니다.' : '바로 시작합니다.'))));
    }
    if (connected) {
      // ★ 이미 가진 범위만 골라 놓고 누르면 구글 화면을 한 바퀴 돌고도 **아무것도 안 바뀐다** —
      //  그런데 화면상으론 "허용 완료"라서 사람은 됐다고 믿는다(2026-08-27 실측: 두 번 돌았는데 캘린더가
      //  안 열렸다. 캘린더 칸이 '아직 안 받았으니' 꺼진 채 시작하는데, 그걸 켜지 않고 버튼만 눌렀다).
      //  넓힐 게 없으면 구글로 보내지 말고, 무엇을 체크해야 하는지 말한다.
      const granted = (svc: string): boolean =>
        svc === 'drive' ? !!drive.scope_ok : svc === 'gmail' ? !!gmail.scope_ok : !!cal.scope_ok;
      const widenTargets = (): string[] => picked().filter((svc) => !granted(svc));
      extra.push(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '권한 넓히기',
        onclick: async () => {
          const add = widenTargets();
          if (add.length === 0) {
            const rest = [!drive.scope_ok ? 'Google Drive 문서' : '', gmailOffered && !gmail.scope_ok ? 'Gmail 메일' : '',
              calOffered && !cal.scope_ok ? '캘린더 일정' : '']
              .filter(Boolean).join(' · ');
            toast(rest ? `위에서 ${rest} 을 체크한 뒤 눌러 주세요 — 지금은 넓힐 게 없어요` : '이미 다 허용돼 있어요', true);
            return;
          }
          try {
            const r: any = await api('/api/ui/org/google/collect/connect', { method: 'POST', body: JSON.stringify({ services: picked() }) });
            if (r && r.authorization_url) openConsent(r.authorization_url, () => void paint());
            else toast('구글 화면을 열지 못했습니다', true);
          } catch (e: any) { toast((e && e.message) || '구글 화면을 열지 못했습니다', true); }
        } }));
    }
    //  (#4970) 클라이언트 등록은 위 «연결하는 길» 의 앱 등록 칸 한 곳에서 한다(종전 이 자리의 «클라이언트 값 저장» 칸을 그리로 모았다).
    //   ready 만 본다 — 조직에 클라이언트가 없는데 나는 예전 방식으로 연결돼 있어도 그 사실을 말해야 한다(2026-08-26 dev 실측).
    if (!(s && s.ready)) extra.push(el('p', { class: 'cn-help', text: '구글 연결 준비가 아직 안 됐어요 — 위 «연결하는 길» 을 봐 주세요.' }));

    chk.onchange = async () => {
      chk.disabled = true;
      const services = picked();
      if (chk.checked && services.length === 0) { toast('모을 서비스를 하나 이상 골라 주세요', true); chk.checked = false; chk.disabled = false; return; }
      try {
        const r: any = await api('/api/ui/org/google/collect', { method: 'POST', body: JSON.stringify({ enabled: chk.checked, services }) });
        if (r && r.needs_connect && r.authorization_url) {
          // 동의가 먼저다 — 구글에서 허용하고 돌아오면 다시 켜서 수집기를 만든다(멱등).
          openConsent(r.authorization_url, () => {
            void api('/api/ui/org/google/collect', { method: 'POST', body: JSON.stringify({ enabled: true, services }) })
              .then((rr: any) => { if (rr && rr.ok) toast('자료 가져오기를 켰어요 — 첫 수집은 잠시 뒤 시작됩니다'); })
              .catch(() => { /* 동의 전에 돌아옴 — 화면 갱신만 */ })
              .finally(() => void paint());
          });
        } else if (r && r.ok) {
          const skipped = (r.skipped || []) as Array<{ service: string; reason: string }>;
          if (skipped.length) toast(`${skipped.map((x) => x.service === 'gmail' ? 'Gmail' : 'Google Drive').join(' · ')} 는 아직 허용 전이라 켜지 못했어요 — [권한 넓히기]를 눌러 주세요`, true);
          else toast(chk.checked ? '자료 가져오기를 켰어요 — 첫 수집은 잠시 뒤 시작됩니다' : '자료 가져오기를 껐어요');
        }
      } catch (e: any) { toast((e && e.message) || '바꾸지 못했습니다', true); }
      await paint();
    };
    panel.set(chk, anyOn ? '켜짐' : '꺼짐', notes, [
      setRow('무엇을', '가져올 구글 서비스', [svcRow, cost]),
      setRow('얼마나 자주', '다시 읽는 주기', [el('span', { class: 'cn-set-hint', style: 'margin-top:0',
        text: '구글은 아직 주기를 고를 수 없어요 — 기본 주기로 돕니다.' })]),
      ...(extra.length ? [setRow('어디서', '가져올 범위', extra)] : []),
    ]);
  };
  void paint();
  return { box: panel.box, row: panel.row };
}

function backLink(): HTMLElement {
  return el('a', { class: 'cn-back', href: '#/connect' }, el('span', { 'aria-hidden': 'true', text: '←' }), el('span', { text: '외부 앱 연결' }));
}

// ── 연결 동작 — me-logins 와 같은 경로다(엔드포인트·복귀 감지 모두). ──
//  OAuth 는 새 탭 동의 → **창 포커스 한 번**으로 복귀를 안다(타이머 폴링 없음): 이 탭으로 돌아온 순간이
//  곧 '동의가 끝났거나 그만뒀다'는 시점이라 그때 한 번만 다시 읽으면 충분하다.
async function startOAuth(svc: Svc, reload: () => void): Promise<void> {
  try {
    //  #1881 G5 — GitHub 은 MCP 서버 행이 없어 공용 창구(/me/oauth/connect)를 못 탄다. 전용 op 가 설치+인가를
    //   한 번에 여는 URL 을 준다(그 화면의 저장소 선택이 곧 접근 범위 선언이다).
    const ep = (svc as any).appConnect ? '/api/ui/org/github/connect' : '/api/ui/me/oauth/connect';
    const r: any = await api(ep, { method: 'POST', body: JSON.stringify((svc as any).appConnect ? {} : { server: svc.oauth }) });
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
