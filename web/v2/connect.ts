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
import { api, el, errorNote, hasScope, relTime, sv, toast, uiText } from '../core.js';
import { confirmDialog, skeleton } from '../ui-primitives.js';
import { svcTile } from '../svc-icons.js';
import { CRED_KINDS, openGitCredentialManager, svcTokenForm } from '../admin-credentials.js';
import { LOGIN_SERVICES, partition, slackChannelPolicyCard, type SvcView } from '../me-logins.js';
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

//  ⚠ 표(LOGIN_SERVICES)만 뒤지면 안 된다 — 관리자가 등록한 커넥터는 서버에서 와서 v.all 에만 있다.
const findSvc = (v: SvcView, key: string): Svc | undefined =>
  (v.all as Svc[]).find((s) => s.key === key) || LOGIN_SERVICES.find((s) => s.key === key);

/** 이 앱이 지금 어떤 상태인가 — 세 갈래. 목록의 구역도, 상세의 문구도 이 하나로 갈린다. */
type State = 'on' | 'off' | 'blocked';
function stateOf(v: SvcView, svc: Svc): State {
  if (v.connected.some((s: Svc) => s.key === svc.key)) return 'on';
  if (v.blockedOAuth.some((s: Svc) => s.key === svc.key)) return 'blocked';
  if (v.soon.some((s: Svc) => s.key === svc.key)) return 'blocked';   // #2243 카탈로그가 준비 중이라 한 앱도 같은 자리
  return 'off';
}

// ══ 목록 (#/connect) ═══════════════════════════════════════════════════════════
//  #2243 안 2 «진열대» — 행이 아니라 카드다. 카드마다 «무엇을 해 주는지» 한 줄(LOGIN_SERVICES.short)이 있어 누르기 전에 고를 수 있다.
//  상태는 셋뿐: 연결됨 · 연결할 수 있음 · 준비 중. «조직에 열어 둠»은 이 앱(셀프서브·비엔터프라이즈)에서 사용자의 세계관이
//   아니다(원준 2026-08-28) — 조직이 아직 안 연 OAuth 앱은 사용자 눈엔 «라이블리가 아직 준비 중»과 같고, 온보딩(#2232)도
//   같은 판정(soon || blocked)을 쓴다. 그래서 요약 칩·구역·관리자 문구가 전부 사라졌다.
//  «둘 다 비활성처럼 보이면 헷갈린다»를 이렇게 푼다 — 회색 로고의 뜻을 «준비 중» 하나로 좁히고, 켤 수 있는 앱은 제 색 로고에
//   [연결] 버튼이 붙어 «누를 수 있다»가 보인다. 준비 중 카드는 점선 테두리·틴트 바탕에 갈 곳(버튼) 대신 «준비 중 + 이유».
type ListState = 'on' | 'off' | 'soon';
export async function renderConnect(host: HTMLElement): Promise<void> {
  host.replaceChildren(el('div', { class: 'v2-center' }, skeleton('연결 상태를 불러오는 중')));
  let v: SvcView;
  try { ({ v } = await load()); }
  catch (e) { host.replaceChildren(el('div', { class: 'v2-center' }, errorNote(e, '연결 상태를 불러오지 못했습니다'))); return; }
  const soon = [...(v.soon as Svc[]), ...(v.blockedOAuth as Svc[])];
  const reload = () => { void renderConnect(host); };

  let q = '';
  const listHost = el('div', { class: 'cn-groups' });
  const search = el('input', {
    class: 'cn-find', type: 'search', placeholder: '앱 이름으로 찾기', 'aria-label': '앱 찾기',
    oninput: (e: any) => { q = String(e.target.value || '').trim().toLowerCase(); paint(); },
  }) as HTMLInputElement;

  // 요약 — «몇 개 켜져 있나 · 더 켤 수 있나 · 아직 못 켜는 게 있나». 준비 중은 있을 때만 센다(0 은 소음).
  const sum = el('div', { class: 'cn-sum' },
    el('span', { class: 'cn-sum-i on' }, el('b', { text: String(v.connected.length) }), el('span', { text: '연결됨' })),
    el('span', { class: 'cn-sum-i' }, el('b', { text: String(v.available.length) }), el('span', { text: '연결할 수 있음' })),
    ...(soon.length ? [el('span', { class: 'cn-sum-i soon' }, el('b', { text: String(soon.length) }), el('span', { text: '준비 중' }))] : []));

  /** 지금 이 앱을 켜는 길 — 계정(조직이 등록한 OAuth 또는 전용 창구)이 있으면 그것, 아니면 토큰.
   *  ⚠ svc.oauth 만 보면 안 된다: Slack 처럼 oauth·token 을 다 가진 앱은 OAuth 가 안 열려 있어도 토큰으로 «켤 수 있음»에 온다
   *   (#2202 A1). 그때 계정 길을 내밀면 눌러도 안 되는 버튼이 된다 — 실제로 열려 있는 길만 버튼에 건다. */
  const viaAccount = (svc: Svc) => !!((svc.oauth && v.oauthMap.has(svc.oauth)) || (svc as any).appConnect);

  function groupHead(title: string, n: number | null, note: string): HTMLElement {
    // 한글 소제목 — .v2-k(영문 대문자 스타일) 대신 굵은 잉크 + 개수 + 힌트(#2202 C1).
    return el('div', { class: 'cn-gh' }, el('b', { text: title }),
      n == null ? null : el('span', { class: 'n', text: String(n) }), el('span', { class: 'h', text: note }));
  }

  function group(title: string, note: string, items: Svc[], st: ListState): HTMLElement | null {
    const hit = items.filter((s) => !q || s.label.toLowerCase().includes(q) || s.key.includes(q));
    if (!hit.length) return null;
    return el('section', { class: 'cn-group' }, groupHead(title, hit.length, note),
      el('div', { class: 'cn-cards' }, ...hit.map((s) => card(s, st))));
  }

  function card(svc: Svc, st: ListState): HTMLElement {
    const href = '#/connect/' + svc.key;
    const head = (sub: string) => el('div', { class: 'cn-card-hd' },
      //  회색 로고 = 준비 중뿐. 켤 수 있는 앱도 제 색이다(무엇인지 먼저 읽히고, 버튼이 «누를 수 있다»를 말한다).
      svcTile(svc.key, svc.label, st !== 'soon'),
      el('div', { class: 'cn-card-tt' },
        el('div', { class: 'cn-card-nm' }, el('span', { text: svc.label }),
          st === 'on' ? el('span', { class: 'cn-dot on', 'aria-label': '연결됨' }) : null),
        el('div', { class: 'cn-card-st', text: sub })));
    const blurb = el('p', { class: 'cn-card-bl', text: String((svc as any).short || svc.blurb || '') });
    if (st === 'on') {
      return el('a', { class: 'cn-card', href, title: svc.label },
        head(connMeta(v, svc)), blurb,
        el('div', { class: 'cn-card-ft' }, el('span', { class: 'pill pill-state confirmed', text: '연결됨' }),
          el('span', { class: 'cn-card-go', text: '관리 ›' })));
    }
    if (st === 'soon') {
      return el('a', { class: 'cn-card soon', href, title: svc.label },
        head(svc.oauth ? '계정 로그인' : '토큰'), blurb,
        el('div', { class: 'cn-card-ft' }, el('span', { class: 'cn-pill-soon', text: '준비 중' }),
          el('span', { class: 'cn-card-h', text: String((svc as any).soon || '준비를 마치면 여기서 바로 켤 수 있어요') })));
    }
    //  켤 수 있음 — 카드는 상세로, [연결]은 그 자리에서 바로 시작. 버튼은 <a> 안에 못 들어가므로 카드가 role=link 인 div 가 된다.
    const account = viaAccount(svc);
    const go = () => { location.hash = href; };
    return el('div', {
      class: 'cn-card', role: 'link', tabindex: '0', title: svc.label, onclick: go,
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } },
    },
      head(account ? '계정 로그인' : '토큰'), blurb,
      el('div', { class: 'cn-card-ft' }, el('span', { class: 'cn-card-h', text: '아직 연결 안 함' }),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '연결',
          onclick: (e: Event) => { e.stopPropagation(); if (account) void startOAuth(svc, reload); else openToken(svc, reload); } })));
  }

  function paint(): void {
    const kids = [
      group('연결된 앱', 'AI가 지금 내 계정으로 쓸 수 있어요', v.connected, 'on'),
      group('연결할 수 있는 앱', '눌러서 바로 켤 수 있어요', v.available, 'off'),
      group('준비하고 있어요', '라이블리가 준비를 마치면 여기서 바로 켤 수 있어요', soon, 'soon'),
    ].filter(Boolean) as HTMLElement[];
    if (!kids.length) kids.push(el('p', { class: 'v2-empty', text: `'${q}' 와(과) 맞는 앱이 없어요.` }));
    listHost.replaceChildren(...kids);
  }
  paint();

  host.replaceChildren(el('div', { class: 'v2-wide v2-connect' },
    el('h1', { class: 'v2-title', text: '외부 앱 연결' }),
    //  «팀에는 공유되지 않습니다»를 뺐다 — 팀 자료로 모으기는 워크스페이스가 함께 보므로 그 문장이 틀려진다. 범위 이야기는 상세가 한다.
    el('p', { class: 'v2-desc', text: 'AI가 내 계정으로 쓸 수 있는 앱이에요. 원하는 앱을 골라 바로 연결하세요.' }),
    el('div', { class: 'cn-top' }, sum, search),
    listHost,
    // 레포 접근 — 같은 '외부 연결'인데 종전엔 관리탭에만 있었다. 개발 안 하면 안 건드려도 되는 것이라 맨 아래.
    el('section', { class: 'cn-group cn-extra' },
      groupHead('코드 저장소 접근', null, '개발자용 — 클론·푸시에 쓰는 SSH 키·토큰'),
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

// ══ 앱 상세 (#/connect/<key>) — #2243 안 B «설정 패널» ═══════════════════════════════
//  왼쪽 목차(앱 문패 + 바로 쓰기 / 모아 두기 / 범위 / 연결 해제) · 오른쪽 패널 셋. **모든 앱이 같은 틀**이다 — 앱마다 바뀌는 건
//  칸 안의 명사(페이지·대화·저장소·파일)와 모아 두기 어댑터뿐. 두 얼굴:
//   · 바로 쓰기(= AI 도구·MCP) — AI 가 내 계정으로 그 앱에 직접 들어가 일한다. 내가 시킬 때만 · 그 앱 안에서 · 복사 없음 · 나만.
//   · 모아 두기(= 수집기) — 내가 고른 것만 라이블리가 미리 읽어 자료함에 둔다. 주기적 · 워크스페이스 함께.
//  이름 둘은 임시다(원준님 검토 중, 2026-08-28) — 바꾸면 여기 문구와 목록 카드 메타(connMeta)를 같이.
//  종전의 «연결 안 됨 + 워크스페이스 2곳에서 모으는 중» 모순(#2202 B1)은 문패의 두 상태 한 줄로 푼다.
type CollectState = (text: string, on: boolean) => void;
const SCOPE_NOUN: Record<string, string> = {
  notion: '페이지', linear: '이슈', slack: '대화', google: 'Drive 파일과 캘린더 일정', github: '저장소', gitlab: '프로젝트',
  clickup: '작업', figma: '파일', prometheus: '지표', 'claude-headless': '분류·크론 실행',
};
const COLLECT_UNIT: Record<string, string> = { slack: '대화', notion: '페이지', google: '문서', figma: '파일의 코멘트', clickup: '작업' };
const ICON_PATH: Record<string, string> = {
  zap: 'M13 2L4 14h7l-1 8 9-12h-7z',
  box: 'M3 5h18v4H3zM5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4',
  check: 'M5 12l4 4L19 7',
  x: 'M6 6l12 12M18 6L6 18',
};
const icon = (k: string): SVGElement => sv('svg', { class: 'v2-ic', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, sv('path', { d: ICON_PATH[k] })) as SVGElement;

/** 설정 줄 — «라벨 | 값 | 동작». 값은 문자열(uiText)이나 노드. */
function srow(k: string, v: string | Node[], acts: HTMLElement[] = [], cls = ''): HTMLElement {
  return el('div', { class: 'cn-srow' + (cls ? ' ' + cls : '') },
    el('span', { class: 'k', text: k }),
    el('span', { class: 'v' }, ...(typeof v === 'string' ? uiText(v) : v)),
    ...acts);
}
/** 패널 — 머리(아이콘·제목·설명·오른쪽 슬롯) + 줄들. */
function panel(id: string, ic: string, title: string, desc: string, right: HTMLElement[], rows: HTMLElement[]): HTMLElement {
  return el('section', { class: 'cn-panel', id },
    el('div', { class: 'cn-ph' }, el('span', { class: 'cn-fi', 'aria-hidden': 'true' }, icon(ic)),
      el('div', { class: 'tt' }, el('div', { class: 't', text: title }), el('div', { class: 's', text: desc })),
      ...right),
    ...rows);
}
/** 모아 두기 패널 — 앱별 어댑터(slack·notion·google 카드)가 스위치·줄을 채운다. body 는 오류 표시용 자리. */
function collectPanel(desc: string, onState: CollectState): { box: HTMLElement; body: HTMLElement; set: (chk: HTMLInputElement, stateText: string, notes: string[], extra: HTMLElement[]) => void } {
  const swWrap = el('span', { class: 'cn-swwrap' });
  const body = el('div', { class: 'cn-prows' }, srow('상태', '불러오는 중…', [], 'note'));
  const box = panel('cn-collect', 'box', '모아 두기', desc, [swWrap], [body]);
  return {
    box, body,
    set(chk, stateText, notes, extra) {
      chk.className = 'cn-sw'; chk.setAttribute('role', 'switch'); chk.setAttribute('aria-label', '모아 두기');
      swWrap.replaceChildren(el('span', { class: 'cn-swl', text: stateText }), chk);
      body.replaceChildren(
        ...notes.map((t, i) => srow(i === 0 ? '지금' : '', t, [], 'note')),
        srow('누가 봐요', '워크스페이스 함께 — 모아 둔 자료는 함께 검색해요'),
        ...(extra.length ? [el('div', { class: 'cn-srow stack' }, ...extra)] : []));
      onState(stateText, chk.checked);
    },
  };
}
function quietCollectPanel(desc: string, stateText: string, note: string, onState: CollectState): HTMLElement {
  onState(stateText, false);
  return panel('cn-collect', 'box', '모아 두기', desc, [el('span', { class: 'cn-pill-soon', text: stateText })],
    [srow('', note, [], 'note')]);
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
  const reload = () => { void renderConnectApp(host, key); };
  const oc = svc.oauth ? v.oauthMap.get(svc.oauth) : null;
  const cred = svc.token ? v.credMap.get(svc.token) : null;
  const viaOAuth = !!oc?.connected;
  const viaToken = !!cred?.has_secret;
  const spec = svc.token ? CRED_KINDS.find((x: any) => x.kind === svc.token) : null;
  //  지금 이 앱을 켜는 길 — 목록(viaAccount)과 같은 판정. svc.oauth 만 보면 Slack 처럼 OAuth 가 안 열린 앱이 막다른 버튼이 된다(#2202 A1).
  const account = !!((svc.oauth && v.oauthMap.has(svc.oauth)) || (svc as any).appConnect);
  const isAdmin = hasScope('admin');
  const noun = SCOPE_NOUN[svc.key] || '것';
  const toolWord = st === 'on' ? '켜짐' : st === 'off' ? '꺼짐' : '준비 중';

  //  #2232 — OAuth 릴레이에서 **막 돌아온 탭**이다(main.ts 가 표식을 남긴다). 이 탭은 [허용]을 누르느라 새로 열린 탭이라
  //   사람은 «그래서 이제 뭘 하지?» 상태다(원준님 실측 2026-08-28, Slack). 원래 하던 화면으로 돌아가라고 **글로** 말한다.
  let arrivedFrom = false;
  try { arrivedFrom = sessionStorage.getItem('lively.connect.return') === key; if (arrivedFrom) sessionStorage.removeItem('lively.connect.return'); } catch (_) { arrivedFrom = false; }
  const arrived = arrivedFrom ? el('div', { class: 'cn-arrived' + (st === 'on' ? ' on' : ' off') },
    el('b', { text: st === 'on' ? `${svc.label} 연결이 끝났어요. ` : `${svc.label} 연결을 아직 확인하지 못했어요. ` }),
    el('span', { text: st === 'on'
      ? '처음 설정이나 다른 화면에서 시작하셨다면 이 탭은 닫고 원래 탭으로 돌아가세요. 거기 화면이 «연결됨» 으로 저절로 바뀝니다.'
      : '아래 바로 쓰기 스위치로 한 번 더 해 보세요.' })) : null;

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

  // ── 왼쪽 목차 ──
  const navSub = el('span', { class: 's', text: `바로 쓰기 ${toolWord}` });
  const navCollectDot = el('span', { class: 'cn-dot soon', 'aria-hidden': 'true' });
  const navBtns = new Map<string, HTMLElement>();
  const jump = (id: string): void => {
    const t = host.querySelector('#' + id);
    if (t) (t as HTMLElement).scrollIntoView({ block: 'start' });
    for (const [k, b] of navBtns) b.classList.toggle('on', k === id);
  };
  const navItem = (id: string, ic: string, label: string, dot: HTMLElement | null, cls = ''): HTMLElement => {
    const b = el('button', { class: 'cn-sn' + (cls ? ' ' + cls : ''), type: 'button', onclick: () => jump(id) }, icon(ic), el('span', { text: label }), dot);
    navBtns.set(id, b);
    return b;
  };
  const nav = el('nav', { class: 'cn-snav', 'aria-label': svc.label + ' 설정 목차' },
    el('div', { class: 'cn-snav-app' }, svcTile(svc.key, svc.label, st === 'on'),
      el('div', { style: 'min-width:0' }, el('b', { text: svc.label }), navSub)),
    navItem('cn-tool', 'zap', '바로 쓰기', el('span', { class: 'cn-dot' + (st === 'on' ? ' on' : st === 'off' ? ' off' : ' soon'), 'aria-hidden': 'true' })),
    navItem('cn-collect', 'box', '모아 두기', navCollectDot),
    navItem('cn-scope', 'check', '범위', null),
    ...(st === 'on' ? [navItem('cn-dz', 'x', '연결 해제', null, 'danger')] : []));
  navBtns.get('cn-tool')!.classList.add('on');

  // ── 패널 1 · 바로 쓰기 ──
  const sw = el('input', { type: 'checkbox', class: 'cn-sw', role: 'switch', 'aria-label': '바로 쓰기' }) as HTMLInputElement;
  const swl = el('span', { class: 'cn-swl', text: toolWord });
  sw.checked = st === 'on';
  if (st === 'blocked') sw.disabled = true;
  sw.onchange = () => {
    if (sw.checked) {
      //  켜짐은 서버가 확인해야 켜진 것 — 스위치는 되돌리고, 외부 동의(또는 토큰 창)로 보낸 뒤 돌아오면 다시 그린다.
      sw.checked = false;
      if (account) { swl.textContent = '동의 기다리는 중'; sw.disabled = true; void startOAuth(svc, reload); }
      else openToken(svc, reload);
    } else { sw.checked = true; void disconnect(); }
  };
  const howText = svc.oauth && svc.token ? '계정 로그인 또는 토큰' : (svc.oauth || (svc as any).appConnect) ? '계정 로그인 — 그 서비스에서 동의 한 번' : '토큰 붙여넣기';
  const howRow = st === 'on'
    ? srow('방식', [el('span', { text: viaOAuth ? '계정 로그인' : '토큰' }),
        ...(viaToken && cred?.scope_key ? [el('span', { class: 'h', text: String(cred.scope_key) })] : []),
        ...(viaToken && cred?.last_used_at ? [el('span', { class: 'h', text: '마지막 사용 ' + relTime(cred.last_used_at) })]
          : viaToken && cred?.updated_at ? [el('span', { class: 'h', text: '연결 ' + relTime(cred.updated_at) })] : [])],
      [...(viaOAuth ? [el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '다시 연결', onclick: () => void startOAuth(svc, reload) })] : []),
       ...(viaToken ? [el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '토큰 교체', onclick: () => openToken(svc, reload) })] : [])])
    : srow('방식', st === 'blocked' ? howText : [el('span', { text: account ? '계정 로그인' : '토큰 붙여넣기' }),
        el('span', { class: 'h', text: account ? '켜면 ' + svc.label + ' 화면에서 [허용] 한 번' : '켜면 토큰을 넣는 창이 열려요' })]);

  //  범위 — 앱마다 다르다. 슬랙은 대화별 허용(#1226), GitHub 은 설치 때 고른 저장소(#1881 G10). 나머지는 계정 권한 그대로.
  let scopeRow: HTMLElement;
  const expandHost = el('div');
  const expander = (label: string, build: () => HTMLElement): HTMLElement => {
    let open = false;
    const btn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: label }) as HTMLButtonElement;
    btn.onclick = () => {
      open = !open;
      btn.textContent = open ? label.replace(/보기|고르기/, '닫기') : label;
      expandHost.replaceChildren(...(open ? [el('div', { class: 'cn-expand cn-slack' }, build())] : []));
    };
    return btn;
  };
  if (svc.key === 'slack') {
    scopeRow = srow('범위', [el('span', { text: '대화별로 정해요' }), el('span', { class: 'h', text: '비공개 대화와 DM은 기본 꺼짐' })],
      st === 'on' ? [expander('범위 고르기', () => slackChannelPolicyCard())] : []);
  } else if (svc.key === 'github') {
    scopeRow = srow('범위', [el('span', { text: '이슈·PR·댓글은 내 계정 권한 그대로' }), el('span', { class: 'h', text: '코드는 설치할 때 고른 저장소만' })],
      st === 'on' ? [expander('저장소 보기', () => githubReposCard())] : []);
  } else if (svc.key === 'claude-headless') {
    scopeRow = srow('범위', '헤드리스 분류·에이전트 크론이 이 계정으로 실행돼요 — 구독 크레딧이 쓰입니다');
  } else {
    scopeRow = srow('범위', `내 계정이 볼 수 있는 ${noun} 전부`);
  }
  scopeRow.id = 'cn-scope';
  const toolRows: HTMLElement[] = [howRow, scopeRow, expandHost, srow('누가 봐요', '나만 — 라이블리에 복사되지 않아요')];
  if (st === 'blocked') toolRows.splice(0, 0, srow('지금', String((svc as any).soon || '라이블리가 이 앱을 준비하고 있어요 — 준비를 마치면 여기서 바로 켤 수 있어요.'), [], 'note'));
  //  발급 방법 — CRED_KINDS 의 help·docUrl 을 그대로 읽는다. 토큰형인데 아직 연결 안 했을 때 가장 막히는 자리다.
  if (spec && (spec.help || spec.docUrl) && st !== 'on' && !account) {
    toolRows.push(srow('토큰 발급', String(spec.help || ''),
      spec.docUrl ? [el('a', { class: 'btn btn-ghost btn-sm', href: spec.docUrl, target: '_blank', rel: 'noopener noreferrer', text: '발급 페이지 열기 ↗' })] : [], 'note'));
  }
  const toolPanel = panel('cn-tool', 'zap', '바로 쓰기',
    `AI가 내 계정으로 ${svc.label}에 직접 들어가 일해요. 내가 시킬 때만, 라이블리에 복사 없이.`,
    [el('span', { class: 'cn-swwrap' }, swl, sw)], toolRows);

  // ── 패널 2 · 모아 두기 — 앱별 어댑터. 없는 앱도 칸을 비우지 않는다(틀이 흔들리면 앱마다 다른 화면이 된다). ──
  const onCollect: CollectState = (text, on) => {
    navSub.textContent = `바로 쓰기 ${toolWord} · 모아 두기 ${text}`;
    navCollectDot.className = 'cn-dot' + (on ? ' on' : text === '꺼짐' ? ' off' : ' soon');
  };
  const unit = COLLECT_UNIT[svc.key];
  const collectDesc = unit ? `내가 고른 ${unit}만 라이블리가 미리 읽어 자료함에 둬요. 워크스페이스가 함께 봐요.` : '내가 고른 것만 라이블리가 미리 읽어 자료함에 둬요. 워크스페이스가 함께 봐요.';
  let collect: HTMLElement;
  //  #1881 슬랙 — 연결이 곧 토큰이라 켜면 수집기가 그 연결로 돈다. 계정이 먼저.
  if (svc.key === 'slack') collect = !isAdmin ? quietCollectPanel(collectDesc, '관리자만', '워크스페이스 관리자가 켤 수 있어요 — 켜면 공개 채널이 함께 보는 자료함에 모여요.', onCollect)
    : st !== 'on' ? quietCollectPanel(collectDesc, '꺼짐', '위에서 바로 쓰기(계정 연결)를 먼저 켜면 여기서 켤 수 있어요 — 내 연결로 공개 채널을 읽어 와요.', onCollect)
    : slackTeamCollectCard(onCollect);
  //  #1881 노션 — 개인 연결(MCP)과 무관. 토글이 여는 노션 화면(페이지 선택)이 곧 연결이자 범위다.
  else if (svc.key === 'notion') collect = isAdmin ? notionTeamCollectCard(onCollect)
    : quietCollectPanel(collectDesc, '관리자만', '워크스페이스 관리자가 켤 수 있어요 — 노션에서 고른 페이지만 함께 보는 자료함에 모여요.', onCollect);
  //  #1881 G5 구글 — 무엇을 켜느냐가 곧 비용이라 서비스를 고르게 한다.
  else if (svc.key === 'google') collect = isAdmin ? googleTeamCollectCard(onCollect)
    : quietCollectPanel(collectDesc, '관리자만', '워크스페이스 관리자가 켤 수 있어요 — Drive 문서가 함께 보는 자료함에 모여요.', onCollect);
  //  #2247 피그마·ClickUp — 토큰이 곧 자격. 위에서 토큰을 저장했으면 여기서 켠다(수집기는 그 토큰을 가리킨다, 복사 0).
  else if (svc.key === 'figma' || svc.key === 'clickup') collect = !isAdmin ? quietCollectPanel(collectDesc, '관리자만', `워크스페이스 관리자가 켤 수 있어요 — 켜면 ${svc.label}의 ${COLLECT_UNIT[svc.key]}이(가) 함께 보는 곳에 모여요.`, onCollect)
    : st !== 'on' ? quietCollectPanel(collectDesc, '꺼짐', '위에서 바로 쓰기(토큰 저장)를 먼저 켜면 여기서 켤 수 있어요 — 내 토큰으로 읽어 와요.', onCollect)
    : memberTokenCollectCard(svc.key, onCollect);
  else collect = quietCollectPanel(collectDesc, '아직 없어요',
    `${svc.label}는 아직 모아 두기가 없어요. 바로 쓰기로 ${noun}을(를) 그때그때 읽어요 — 준비되면 여기서 켤 수 있어요.`, onCollect);

  // ── 패널 3 · 연결 해제 ──
  const dz = st === 'on' ? panel('cn-dz', 'x', '연결 해제', '저장해 둔 로그인 정보가 지워지고, 이 연결로 돌던 모아 두기도 멈춰요.',
    [el('button', { class: 'btn btn-ghost btn-sm cn-dz-btn', type: 'button', text: svc.label + ' 연결 모두 해제', onclick: () => void disconnect() })], []) : null;

  host.replaceChildren(el('div', { class: 'v2-wide v2-connect-app' },
    backLink(),
    ...(arrived ? [arrived] : []),
    el('div', { class: 'cn-settings' }, nav,
      el('div', { class: 'cn-panels' }, toolPanel, collect, ...(dz ? [dz] : [])))));
}

// ── 팀 자료로 모으기(#1881) — 슬랙 수집을 토글 하나로. 상태·토글·비공개 채널 안내를 한 카드에. ──
// ── 연결된 저장소(#1881 G10) — "목록에 보이는 것"과 "clone 되는 것"의 경계를 드러낸다 ──────────────
//  레포 목록은 user token(`/user/repos`)이라 내가 볼 수 있는 전부가 나오고, clone 은 installation token 이라
//  설치 때 고른 것만 된다. 목록을 좁히는 건 답이 아니다(드롭다운은 제안이지 제약이 아니다 — #825).
//  대신 **어느 것이 열려 있는지 표시하고**, 안 열린 걸 쓰려면 GitHub 설치 화면으로 보낸다.
function githubReposCard(): HTMLElement {
  const body = el('div', { class: 'cn-help' }, ...uiText('불러오는 중…'));
  const box = el('div', {}, body);   // #2243 — 바로 쓰기 «범위» 줄 아래로 펼쳐지는 상자(패널 안의 패널을 만들지 않는다)
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

function slackTeamCollectCard(onState: CollectState): HTMLElement {
  const panel = collectPanel("내가 고른 대화만 라이블리가 미리 읽어 자료함에 둬요. 공개 채널이 기본이고, 워크스페이스가 함께 봐요.", onState);
  const box = panel.box, body = panel.body;
  const paint = async (): Promise<void> => {
    let s: any;
    try { s = await api('/api/ui/org/slack/collect'); }
    catch (e) { body.replaceChildren(errorNote(e, '수집 상태를 불러오지 못했습니다')); return; }
    const chk = el('input', { type: 'checkbox' }) as HTMLInputElement;
    chk.checked = !!(s.search && s.search.enabled);
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
    panel.set(chk, chk.checked ? '켜짐' : '꺼짐', notes, []);
  };
  void paint();
  return box;
}

// ── 모아 두기(#2247 피그마·ClickUp) — 토큰형 앱의 공통 카드. 서버는 org_<app>_collect(_set) 한 쌍(member-collect.ts 팩토리).
//  피그마는 범위(파일 링크/팀 id)가 없으면 서버가 needs_scope 로 켜 주지 않는다 — 그래서 이 카드에 범위 칸이 있다.
const MEMBER_COLLECT_TEXT: Record<string, { desc: string; on: string; off: string; where: string }> = {
  figma: { desc: '내가 고른 파일의 코멘트만 라이블리가 미리 읽어 자료함에 둬요. 워크스페이스가 함께 봐요.',
    on: '고른 파일의 코멘트를 모으고 있어요.', off: '켜면 내 Figma 토큰으로 고른 파일의 코멘트를 읽어 옵니다.', where: '워크스페이스 함께 — 모아 둔 자료는 함께 검색해요' },
  clickup: { desc: '내 ClickUp 워크스페이스의 작업·댓글을 라이블리 프로젝트 탭으로 가져와요. 자료함이 아니라 프로젝트로 들어옵니다.',
    on: '작업·댓글을 프로젝트 탭으로 가져오고 있어요.', off: '켜면 내 ClickUp 토큰으로 워크스페이스의 작업·댓글을 프로젝트 탭으로 가져옵니다.', where: '워크스페이스 함께 — 프로젝트 탭에서 같이 봐요' },
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
function memberTokenCollectCard(key: string, onState: CollectState): HTMLElement {
  const T = MEMBER_COLLECT_TEXT[key];
  const panel = collectPanel(T.desc, onState);
  const box = panel.box, body = panel.body;
  const post = async (bodyObj: any): Promise<any> => api(`/api/ui/org/${key}/collect`, { method: 'POST', body: JSON.stringify(bodyObj) });
  const paint = async (): Promise<void> => {
    let s: any;
    try { s = await api(`/api/ui/org/${key}/collect`); }
    catch (e) { body.replaceChildren(errorNote(e, '수집 상태를 불러오지 못했습니다')); return; }
    const chk = el('input', { type: 'checkbox' }) as HTMLInputElement;
    chk.checked = !!s.enabled;
    const notes: string[] = [];
    if (s.enabled) {
      notes.push((s.member ? `${s.member} 님의 연결로 ` : '') + T.on
        + (s.member_connected === false ? ' 그 토큰이 지워졌습니다 — 껐다 켜면 내 토큰으로 바뀝니다.' : ''));
    } else notes.push(T.off);
    const extra: HTMLElement[] = [];
    if (key === 'figma') {
      //  범위 — 피그마엔 목록이 없어서 링크로 정한다. 켜져 있어도 여기서 바꾼다(enabled:true + scope).
      const cur = [s.scope && s.scope.file_keys, s.scope && s.scope.team_ids].filter(Boolean).join(' ');
      const inp = el('input', { type: 'text', class: 'cn-scope-in', value: cur, placeholder: '피그마 파일 링크 — 주소창에서 복사, 여러 개면 공백으로. 팀 전체는 팀 id' }) as HTMLInputElement;
      const save = el('button', { class: 'btn btn-sm', type: 'button', text: s.enabled ? '범위 저장' : '이 범위로 켜기', onclick: async () => {
        const sc = figmaScopeOf(inp.value);
        if (!sc.file_keys && !sc.team_ids) { toast('파일 링크나 팀 id 를 하나는 넣어 주세요', true); inp.focus(); return; }
        save.setAttribute('disabled', 'true');
        try {
          const r: any = await post({ enabled: true, scope: sc });
          if (r && r.ok) toast(s.enabled ? '범위를 저장했어요' : '모아 두기를 켰어요 — 첫 수집은 잠시 뒤 시작됩니다');
          else toast((r && r.message) || '바꾸지 못했습니다', true);
        } catch (e: any) { toast((e && e.message) || '바꾸지 못했습니다', true); }
        await paint();
      } });
      extra.push(el('div', { class: 'cn-scope-row' }, el('span', { class: 'k', text: '범위' }), inp, save));
      if (s.needs_scope) notes.push('아직 범위가 없어요 — 아래에 파일 링크(또는 팀 id)를 넣고 켜 주세요. 피그마엔 목록이 없어서 링크로 정합니다.');
    }
    chk.onchange = async () => {
      chk.disabled = true;
      try {
        const r: any = await post({ enabled: chk.checked });
        if (r && r.ok) toast(chk.checked ? '모아 두기를 켰어요 — 첫 수집은 잠시 뒤 시작됩니다' : '모아 두기를 껐어요');
        else { toast((r && r.message) || '바꾸지 못했습니다', true); }
      } catch (e: any) { toast((e && e.message) || '바꾸지 못했습니다', true); }
      await paint();
    };
    panel.set(chk, chk.checked ? '켜짐' : (s.needs_scope && key === 'figma' ? '범위 필요' : '꺼짐'), notes, extra);
  };
  void paint();
  return box;
}

// ── 팀 자료로 모으기(#1881 노션) — 토글이 곧 연결: 켜면 노션 화면이 열리고 거기서 고른 페이지가 수집 범위가 된다.
//  슬랙 카드와 달리 개인 연결 상태를 보지 않는다 — 조직 슬롯(공개 통합 토큰)이 따로 있고, 이 카드가 그 전부를 다룬다.
function notionTeamCollectCard(onState: CollectState): HTMLElement {
  const panel = collectPanel("내가 고른 페이지(와 그 하위)만 라이블리가 미리 읽어 자료함에 둬요. 워크스페이스가 함께 봐요.", onState);
  const box = panel.box, body = panel.body;
  const openConsent = (url: string, after: () => void): void => {
    window.open(url, '_blank', 'noopener');
    toast('노션 화면에서 모을 페이지를 고르고 [액세스 허용]을 누르세요 — 돌아오면 이 화면이 갱신됩니다');
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
        ? `노션 워크스페이스 ${on.length}곳에서 모으고 있어요 — 각 워크스페이스에서 고른 페이지(와 그 하위)만 읽습니다.`
        : `'${wsName(on[0] || wsAll[0])}' 워크스페이스에서 모으고 있어요 — 노션에서 고른 페이지(와 그 하위)만 읽습니다.`);
    }
    else if (wsAll.length) notes.push(wsAll.length > 1
      ? `노션 워크스페이스 ${wsAll.length}곳이 연결돼 있어요 — 켜면 바로 모으기 시작합니다.`
      : '연결은 돼 있어요 — 켜면 바로 모으기 시작합니다.');
    else if (s && s.ready) notes.push('켜면 노션 화면이 열려요 — 거기서 모을 페이지를 고르면 바로 시작됩니다. 토큰이나 설정을 만질 일은 없어요.');
    else notes.push('노션 연결 준비가 아직 안 됐어요 — 아래에 Lively Notion 통합의 값 두 개를 넣으면 열립니다. 지금 당장은 관리 화면의 외부 자료 수집에서 토큰 방식으로도 연결할 수 있어요.');
    const extra: HTMLElement[] = [];
    if (!(s && s.ready) && !wsAll.length) {
      // 직결(셀프호스팅·dev) 준비 폼 — 슬랙 T7 의 client 2칸과 대칭. 매니지드 테넌트는 CP 가 릴레이를 주입해 이 폼이 보일 일이 없다.
      //  client_secret 은 이 사이트 계정의 비밀번호가 아니다 — type=password 금지(#1250), 텍스트칸+CSS 가림.
      const idIn = el('input', { type: 'text', placeholder: 'OAuth client ID', autocomplete: 'off', style: 'width:100%' }) as HTMLInputElement;
      const secIn = el('input', { type: 'text', class: 'secret-input', placeholder: 'OAuth client secret', autocomplete: 'off', style: 'width:100%' }) as HTMLInputElement;
      const saveBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '통합 값 저장' }) as HTMLButtonElement;
      saveBtn.onclick = async () => {
        const cid = idIn.value.trim(), sec = secIn.value.trim();
        if (!cid || !sec) { toast('ID 와 시크릿을 모두 넣어 주세요', true); return; }
        saveBtn.disabled = true;
        try {
          await api('/api/ui/org/credential', { method: 'POST', body: JSON.stringify({ kind: 'notion_public', scope_key: 'oauth:client', secret: JSON.stringify({ client_id: cid, client_secret: sec }) }) });
          toast('저장했어요 — 이제 토글을 켜면 노션 화면이 열립니다');
        } catch (e: any) { toast((e && e.message) || '저장하지 못했습니다', true); saveBtn.disabled = false; return; }
        await paint();
      };
      extra.push(el('div', { class: 'cn-sec-form' },
        idIn, secIn, saveBtn,
        el('p', { class: 'cn-help' }, ...uiText('notion.so/my-integrations 의 Lively 공개 통합 ▸ 구성(Configuration)에서 ID 와 시크릿을 복사해 넣으세요. 그 통합의 redirect URI 에는 ' + location.origin + '/oauth/callback 이 등록돼 있어야 합니다.'))));
    }
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
        return el('label', { class: 'cn-toggle' }, c, el('span', { text: ' ' + wsName(w) }));
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
    }
    chk.onchange = async () => {
      chk.disabled = true;
      try {
        const r: any = await api('/api/ui/org/notion/collect', { method: 'POST', body: JSON.stringify({ enabled: chk.checked }) });
        if (r && r.needs_connect && r.authorization_url) {
          // 동의가 먼저다 — 노션에서 페이지를 고르고 돌아오면 다시 켜서 수집기를 만든다(멱등).
          openConsent(r.authorization_url, () => {
            void api('/api/ui/org/notion/collect', { method: 'POST', body: JSON.stringify({ enabled: true }) })
              .then((rr: any) => { if (rr && rr.ok) toast('팀 자료 모으기를 켰어요 — 첫 수집은 잠시 뒤 시작됩니다'); })
              .catch(() => { /* 동의 전에 돌아옴 — 화면 갱신만 */ })
              .finally(() => void paint());
          });
        } else if (r && r.ok) {
          toast(chk.checked ? '팀 자료 모으기를 켰어요 — 첫 수집은 잠시 뒤 시작됩니다' : '팀 자료 모으기를 껐어요');
        }
      } catch (e: any) { toast((e && e.message) || '바꾸지 못했습니다', true); }
      await paint();
    };
    panel.set(chk, (s && s.enabled) ? (on.length > 1 ? `켜짐 · ${on.length}곳` : '켜짐') : '꺼짐', notes, extra);
  };
  void paint();
  return box;
}

// ── 팀 자료로 모으기 · 구글(#1881 G5) ─────────────────────────────────────────────
//  슬랙·노션 카드와 같은 뼈대인데 축이 하나 더 있다: **어떤 서비스를 모을지**.
//  그게 취향 문제가 아니라 돈 문제라서다 — Gmail 은 구글 '제한범위'라 앱 심사(CASA, 연 수백~수천 달러)나
//  미검증 100명 한도를 끌고 오고, 드라이브는 그렇지 않다. 그 100 은 프로젝트 수명 누적이고 되돌릴 수 없어서,
//  안 쓰는 Gmail 을 기본으로 켜 두면 구성원 한 명이 연결할 때마다 한 칸씩 영구히 사라진다.
//  → 기본은 드라이브만. Gmail 은 사람이 명시적으로 고르고, 그 대가를 화면이 먼저 말한다.
//  (근거·수치: 지식 google-single-connect-design-1881 §9)
function googleTeamCollectCard(onState: CollectState): HTMLElement {
  const panel = collectPanel("내가 고른 구글 문서만 라이블리가 미리 읽어 자료함에 둬요. 워크스페이스가 함께 봐요.", onState);
  const box = panel.box, body = panel.body;
  const openConsent = (url: string, after: () => void): void => {
    window.open(url, '_blank', 'noopener');
    toast('구글 화면에서 [허용]을 누르세요 — 돌아오면 이 화면이 갱신됩니다');
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
    // ★ Gmail 은 1차 런칭 대상이 아니다(2026-08-26) — 서버가 offered:false 로 알려 준다. 칸을 아예 내밀지 않되,
    //  **이미 켜 둔 조직에는 상태만 보여 준다**(칸이 사라지면 "왜 아직 메일이 모이지?" 를 아무도 설명 못 한다).
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
      notes.push(`${on} 에서 모으고 있어요 — 켠 사람(${(s.connected && s.connected.kind) ? '내' : '내'}) 구글 연결로 돕니다.`);
    } else if (connected) notes.push('연결은 돼 있어요 — 모을 서비스를 고르고 켜면 바로 시작합니다.');
    else if (s && s.ready) notes.push('켜면 구글 화면이 열려요 — [허용]만 누르면 바로 시작됩니다. 토큰이나 설정을 만질 일은 없어요.');
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
            const rest = [!drive.scope_ok ? 'Google Drive 문서' : '', calOffered && !cal.scope_ok ? '캘린더 일정' : '']
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
    // ★ 조건이 `!ready && !connected` 였다: 조직에 client 가 없는데 나는 (예전 방식으로) 연결돼 있으면
    //  폼이 안 떠서 **client 를 넣을 길이 자체가 사라진다**(2026-08-26 dev 에서 이 막다른 상태를 실제로 밟았다).
    //  client 는 조직 것이고 내 연결 여부와 독립이다 — ready 만 본다.
    if (!(s && s.ready)) {
      // 직결(셀프호스팅·dev) 준비 폼 — 노션 카드와 대칭. 매니지드 테넌트는 CP 릴레이가 있어 이 폼이 보일 일이 없다.
      //  client_secret 은 이 사이트 계정의 비밀번호가 아니다 — type=password 금지(#1250), 텍스트칸+CSS 가림.
      const idIn = el('input', { type: 'text', placeholder: 'OAuth 클라이언트 ID', autocomplete: 'off', style: 'width:100%' }) as HTMLInputElement;
      const secIn = el('input', { type: 'text', class: 'secret-input', placeholder: 'OAuth 클라이언트 보안 비밀', autocomplete: 'off', style: 'width:100%' }) as HTMLInputElement;
      const saveBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '클라이언트 값 저장' }) as HTMLButtonElement;
      saveBtn.onclick = async () => {
        const cid = idIn.value.trim(), sec = secIn.value.trim();
        if (!cid || !sec) { toast('ID 와 보안 비밀을 모두 넣어 주세요', true); return; }
        saveBtn.disabled = true;
        try {
          await api('/api/ui/org/credential', { method: 'POST', body: JSON.stringify({ kind: 'google_oauth', scope_key: 'oauth:client', secret: JSON.stringify({ client_id: cid, client_secret: sec }) }) });
          toast('저장했어요 — 이제 토글을 켜면 구글 화면이 열립니다');
        } catch (e: any) { toast((e && e.message) || '저장하지 못했습니다', true); saveBtn.disabled = false; return; }
        await paint();
      };
      extra.push(el('div', { class: 'cn-sec-form' },
        idIn, secIn, saveBtn,
        el('p', { class: 'cn-help' }, ...uiText('Google Cloud 콘솔 ▸ API 및 서비스 ▸ 사용자 인증 정보에서 만든 **웹 애플리케이션** 클라이언트의 ID·보안 비밀입니다. 그 클라이언트의 승인된 리디렉션 URI 에 ' + location.origin + '/oauth/callback 이 등록돼 있어야 하고, OAuth 동의 화면은 반드시 게시(In production) 상태여야 합니다 — 테스트 상태면 7일마다 연결이 끊깁니다.'))));
    }

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
              .then((rr: any) => { if (rr && rr.ok) toast('팀 자료 모으기를 켰어요 — 첫 수집은 잠시 뒤 시작됩니다'); })
              .catch(() => { /* 동의 전에 돌아옴 — 화면 갱신만 */ })
              .finally(() => void paint());
          });
        } else if (r && r.ok) {
          const skipped = (r.skipped || []) as Array<{ service: string; reason: string }>;
          if (skipped.length) toast(`${skipped.map((x) => x.service === 'gmail' ? 'Gmail' : 'Google Drive').join(' · ')} 는 아직 허용 전이라 켜지 못했어요 — [권한 넓히기]를 눌러 주세요`, true);
          else toast(chk.checked ? '팀 자료 모으기를 켰어요 — 첫 수집은 잠시 뒤 시작됩니다' : '팀 자료 모으기를 껐어요');
        }
      } catch (e: any) { toast((e && e.message) || '바꾸지 못했습니다', true); }
      await paint();
    };
    panel.set(chk, anyOn ? '켜짐' : '꺼짐', notes, [svcRow, cost, ...extra]);
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
