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
  //  ★ «켜져 있나»는 목록 배치가 아니라 **자격 원본**으로 판정한다. 준비 중이 목록에서 connected 를 이기므로
  //   배치로 물으면 이미 연결해 둔 앱이 상세에서 «준비 중»이 돼 스위치가 잠긴다 — 돌고 있는 것을 못 끄게 된다.
  if ((svc.oauth && v.oauthMap.get(svc.oauth)?.connected) || (svc.token && v.credMap.get(svc.token)?.has_secret)) return 'on';
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
      //  준비 중인데 이미 연결해 둔 앱 — «준비 중»이라고 쓰던 연결을 없는 척하지 않는다(뺏지 않는다).
      const on = (v as any).soonConnected?.has?.(svc.key);
      return el('a', { class: 'cn-card soon' + (on ? ' soon-on' : ''), href, title: svc.label },
        head(svc.oauth ? '계정 로그인' : '토큰'), blurb,
        el('div', { class: 'cn-card-ft' },
          el('span', { class: 'cn-pill-soon', text: '준비 중' }),
          el('span', { class: 'cn-card-h', text: on ? '지금 연결돼 있어요 — 쓰던 연결은 그대로 돕니다'
            : String((svc as any).soon || '준비를 마치면 여기서 바로 켤 수 있어요') })));
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
      group('연결된 앱', '연결해 둔 앱이에요', v.connected, 'on'),
      group('연결할 수 있는 앱', '눌러서 바로 켤 수 있어요', v.available, 'off'),
      group('준비하고 있어요', '라이블리가 준비를 마치면 여기서 바로 켤 수 있어요', soon, 'soon'),
    ].filter(Boolean) as HTMLElement[];
    if (!kids.length) kids.push(el('p', { class: 'v2-empty', text: `'${q}' 와(과) 맞는 앱이 없어요.` }));
    listHost.replaceChildren(...kids);
  }
  paint();

  host.replaceChildren(el('div', { class: 'v2-wide v2-connect' },
    el('h1', { class: 'v2-title', text: '외부 앱 연결' }),
    //  «팀에는 공유되지 않습니다»를 뺐다 — 자료 가져오기는 워크스페이스가 함께 보므로 그 문장이 틀려진다. 범위 이야기는 상세가 한다.
    el('p', { class: 'v2-desc', text: '앱마다 연결이 두 가지예요 — AI가 내 계정으로 직접 쓰는 것(나만 봐요)과, 자료를 미리 가져와 자료함에 두는 것(워크스페이스가 함께 봐요). 앱을 눌러 각각 켭니다.' }),
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
//  **모든 앱이 같은 틀**이다 — 앱마다 바뀌는 건 칸 안의 명사(페이지·대화·저장소·파일)와 어댑터뿐. 연결은 **둘**:
//   · 내 계정으로 직접 사용(= MCP) — AI 가 내 계정으로 그 앱에 들어가 다룬다. 내가 요청할 때만 · 복사 없음 · 나만.
//     쓰기는 **이 연결의 성질**이지 세 번째 연결이 아니다(카드 안 상자).
//   · 자료 가져오기(= 수집기) — 내가 고른 것만 라이블리가 미리 읽어 자료함으로 가져온다. 주기적 · 워크스페이스 함께.
//  이름 근거: 원준 2026-08-30 — «읽기/쓰기/모으기가 감이 안 온다 · 실제로 연결하는 건 수집과 MCP 둘». 흩어져 있던
//   이름 11개(수집기·자료 가져오기·모아 두기·가져오기 / 외부 앱 연결·AI 도구·외부 서비스·바로 쓰기…)를 이 둘로 모았다.
//   ⚠ 비유로 짓지 않는다(같은 날 지시) — 기능을 그대로 쓴 말만.
//  이름 둘은 임시다(원준님 검토 중, 2026-08-28) — 바꾸면 여기 문구와 목록 카드 메타(connMeta)를 같이.
//  종전의 «연결 안 됨 + 워크스페이스 2곳에서 모으는 중» 모순(#2202 B1)은 문패의 두 상태 한 줄로 푼다.
type CollectState = (text: string, on: boolean) => void;
const SCOPE_NOUN: Record<string, string> = {
  notion: '페이지', linear: '이슈', slack: '대화', google: 'Drive 파일과 캘린더 일정', github: '저장소', gitlab: '프로젝트',
  clickup: '작업', figma: '파일', prometheus: '지표', 'claude-headless': '분류·크론 실행',
};
const COLLECT_UNIT: Record<string, string> = { slack: '대화', notion: '페이지', google: '문서', figma: '파일의 코멘트', clickup: '작업', github: '저장소의 이슈·PR 대화', gitlab: '프로젝트의 이슈·MR 대화', linear: '이슈' };
const ICON_PATH: Record<string, string> = {
  zap: 'M13 2L4 14h7l-1 8 9-12h-7z',
  box: 'M3 5h18v4H3zM5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4',
  check: 'M5 12l4 4L19 7',
  x: 'M6 6l12 12M18 6L6 18',
  //  #2243 3차 — «하는 일» 세 동사와 «보는 사람» 두 축.
  eye: 'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z M12 9.4a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2Z',
  pen: 'M4.5 19.5h4L20 8l-4-4L4.5 15.5z M14.5 5.5l4 4',
  usr: 'M12 4.4a3.6 3.6 0 1 1 0 7.2 3.6 3.6 0 0 1 0-7.2Z M4.5 20c0-3.8 3.4-6 7.5-6s7.5 2.2 7.5 6',
  team: 'M9 5.3a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4Z M2.5 19.5c0-3.4 2.9-5.4 6.5-5.4s6.5 2 6.5 5.4 M16.5 6.6a3.2 3.2 0 0 1 0 6.3 M18 14.6c2.2.6 3.5 2.3 3.5 4.9',
};
/**
 * 목적격 조사 — 앞 글자 받침으로 «을/를». 화면에 «저장소을(를)» 같은 자리가 남으면 사람이 «기계가 쓴 글»로 읽는다.
 * 한글이 아니면(영문 앱 이름 등) «를». 순수라 테스트가 표를 돈다.
 */
export function eulReul(word: string): string {
  const c = (word || '').charCodeAt((word || '').length - 1);
  if (!(c >= 0xAC00 && c <= 0xD7A3)) return '를';
  return (c - 0xAC00) % 28 ? '을' : '를';
}
const icon = (k: string): SVGElement => sv('svg', { class: 'v2-ic', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, sv('path', { d: ICON_PATH[k] })) as SVGElement;

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
function collectFace(onState: CollectState, teamSee = true, countKind = ''): CollectFace & { body: HTMLElement; set: (chk: HTMLInputElement, stateText: string, notes: string[], extra: HTMLElement[]) => void } {
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
        void api(`/api/ui/sources?kind=${encodeURIComponent(countKind)}&limit=1`)
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

  //  #2232 — OAuth 릴레이에서 **막 돌아온 탭**이다(main.ts 가 표식을 남긴다). 이 탭은 [허용]을 누르느라 새로 열린 탭이라
  //   사람은 «그래서 이제 뭘 하지?» 상태다(원준님 실측 2026-08-28, Slack). 원래 하던 화면으로 돌아가라고 **글로** 말한다.
  let arrivedFrom = false;
  try { arrivedFrom = sessionStorage.getItem('lively.connect.return') === key; if (arrivedFrom) sessionStorage.removeItem('lively.connect.return'); } catch (_) { arrivedFrom = false; }
  const arrived = arrivedFrom ? el('div', { class: 'cn-arrived' + (st === 'on' ? ' on' : ' off') },
    el('b', { text: st === 'on' ? `${svc.label} 연결이 끝났어요. ` : `${svc.label} 연결을 아직 확인하지 못했어요. ` }),
    el('span', { text: st === 'on'
      ? '처음 설정이나 다른 화면에서 시작하셨다면 이 탭은 닫고 원래 탭으로 돌아가세요. 거기 화면이 «연결됨» 으로 저절로 바뀝니다.'
      : '아래 [내 계정으로 직접 사용] 스위치로 한 번 더 해 보세요.' })) : null;

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
  const howNow = viaOAuth ? '계정 로그인으로 연결했어요' : viaToken ? '토큰으로 연결했어요' : '';
  const usedAt = viaToken && cred?.last_used_at ? ` · ${relTime(cred.last_used_at)}에 마지막으로 썼어요`
    : viaToken && cred?.updated_at ? ` · ${relTime(cred.updated_at)}에 연결했어요` : '';
  const readDetail = st === 'on'
    ? `내가 요청할 때 AI가 내 ${svc.label} 계정으로 들어가 ${noun}${eulReul(noun)} **내 계정 권한 그대로** 다룹니다. 라이블리에는 남지 않아요.`
    : st === 'blocked'
      ? String((svc as any).soon || '라이블리가 이 앱을 준비하고 있어요 — 준비를 마치면 여기서 바로 켤 수 있어요.')
      : account ? `켜면 ${svc.label} 화면에서 [허용]을 한 번 누르는 것으로 끝나요.` : '켜면 토큰을 넣는 창이 열려요.';
  const readActs = el('div', { class: 'cn-act-row' });
  if (st === 'on' && (howNow || usedAt)) readActs.appendChild(el('span', { class: 'cn-act-note', style: 'flex:1 1 100%', text: howNow + usedAt }));
  if (st === 'on') {
    if (viaOAuth) readActs.appendChild(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '다시 연결', onclick: () => void startOAuth(svc, reload) }));
    if (viaToken) readActs.appendChild(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '토큰 교체', onclick: () => openToken(svc, reload) }));
    if (svc.key === 'slack') readActs.appendChild(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '대화별 허용 정하기', onclick: () => overlay('Slack 대화별 허용', slackChannelPolicyCard()) }));
    if (svc.key === 'github') readActs.appendChild(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '열린 저장소 보기', onclick: () => overlay('GitHub 열린 저장소', githubReposCard()) }));
  } else if (spec && (spec.help || spec.docUrl) && !account) {
    readActs.appendChild(el('span', { class: 'h', style: 'margin-left:0', text: String(spec.help || '') }));
    if (spec.docUrl) readActs.appendChild(el('a', { class: 'btn btn-ghost btn-sm', href: spec.docUrl, target: '_blank', rel: 'noopener noreferrer', text: '발급 페이지 열기 ↗' }));
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
  if (svc.key === 'slack') collect = !isAdmin ? quietCollectFace('관리자만', '워크스페이스 관리자가 켤 수 있어요 — 켜면 공개 채널이 함께 보는 자료함으로 들어옵니다.', onCollect)
    : slackTeamCollectCard(onCollect);
  else if (svc.key === 'notion') collect = isAdmin ? notionTeamCollectCard(onCollect)
    : quietCollectFace('관리자만', '워크스페이스 관리자가 켤 수 있어요 — 노션에서 고른 페이지만 함께 보는 자료함으로 들어옵니다.', onCollect);
  else if (svc.key === 'google') collect = isAdmin ? googleTeamCollectCard(onCollect)
    : quietCollectFace('관리자만', '워크스페이스 관리자가 켤 수 있어요 — Drive 문서가 함께 보는 자료함으로 들어옵니다.', onCollect);
  else if (svc.key === 'linear') collect = isAdmin ? memberTokenCollectCard(svc.key, onCollect)
    : quietCollectFace('관리자만', '워크스페이스 관리자가 켤 수 있어요 — 켜면 이슈·댓글·문서가 함께 보는 자료함으로 들어옵니다.', onCollect);
  else if (svc.key === 'gitlab') collect = !isAdmin ? quietCollectFace('관리자만', '워크스페이스 관리자가 켤 수 있어요 — 켜면 고른 프로젝트의 이슈·MR 대화가 함께 보는 자료함으로 들어옵니다.', onCollect)
    : !(cred && cred.has_secret) ? quietCollectFace('꺼짐', 'GitLab 은 계정 로그인 토큰으로는 자료를 못 읽어요 — 위 [내 계정으로 직접 사용]에서 개인 액세스 토큰(read_api)을 저장하면 여기서 켤 수 있어요.', onCollect)
    : memberTokenCollectCard(svc.key, onCollect);
  else if (svc.key === 'figma' || svc.key === 'clickup' || svc.key === 'github') collect = !isAdmin ? quietCollectFace('관리자만', `워크스페이스 관리자가 켤 수 있어요 — 켜면 ${svc.label}의 ${unit}${eulReul(unit) === '을' ? '이' : '가'} 함께 보는 자료함으로 들어옵니다.`, onCollect)
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

  // ── 연결 지우기 — 잃는 것만 말한다(#1582) ──
  const gone = st === 'on' ? el('div', { class: 'cn-gone' }, icon('x'),
    el('span', { class: 'm', text: '연결을 지우면 직접 사용도 자료 가져오기도 함께 멈추고, 이미 가져온 자료는 자료함에 남습니다.' }),
    el('button', { class: 'btn btn-ghost btn-sm cn-dz-btn', type: 'button', text: svc.label + ' 연결 지우기', onclick: () => void disconnect() })) : null;

  host.replaceChildren(el('div', { class: 'v2-wide v2-connect-app' },
    backLink(),
    ...(arrived ? [arrived] : []),
    el('div', { class: 'cn-head' }, svcTile(svc.key, svc.label, st === 'on'),
      el('div', { class: 'cn-head-tt' }, el('h1', { class: 'v2-title', text: svc.label }),
        el('p', { class: 'v2-desc', style: 'margin-top:4px', text: String((svc as any).blurb || '') }))),
    el('section', { class: 'cn-sect', id: 'cn-tool' },
      sectHead('1', `${svc.label} 연결 두 가지`, '따로 켜고 끕니다'),
      el('div', { class: 'cn-actlist' }, readRow, collect.row)),
    el('section', { class: 'cn-sect', id: 'cn-collect-sect' },
      sectHead('2', '가져올 자료 정하기', '내 쓰임에 맞게 정합니다'),
      collect.box),
    el('section', { class: 'cn-sect', id: 'cn-who' },
      sectHead('3', '보는 사람', '직접 사용은 나만, 가져온 자료는 워크스페이스가 함께'),
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
    on: '이슈·댓글·문서를 가져오고 있어요.', off: '켜면 Linear 화면이 열려요 — [허용] 한 번이면 연결과 가져오기가 함께 켜집니다.', where: '워크스페이스 함께 — 가져온 자료는 함께 검색해요' },
  gitlab: { desc: '내가 고른 프로젝트의 이슈·MR 대화와 릴리스 노트만 라이블리가 미리 읽어 자료함으로 가져와요. 워크스페이스가 함께 봐요.',
    on: '고른 프로젝트의 이슈·MR 대화를 가져오고 있어요.', off: '켜면 내 GitLab 개인 토큰으로 고른 프로젝트의 이슈·MR 대화를 읽어 옵니다.', where: '워크스페이스 함께 — 가져온 자료는 함께 검색해요' },
  github: { desc: '내가 고른 저장소의 이슈·PR 대화와 릴리스 노트만 라이블리가 미리 읽어 자료함으로 가져와요. 워크스페이스가 함께 봐요.',
    on: '고른 저장소의 이슈·PR 대화를 가져오고 있어요.', off: '켜면 내 GitHub 연결로 고른 저장소의 이슈·PR 대화를 읽어 옵니다. 연결 화면에서 고른 저장소가 기본 범위예요.', where: '워크스페이스 함께 — 가져온 자료는 함께 검색해요' },
};
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
const HAS_BACKFILL = new Set(['github', 'gitlab', 'linear', 'slack']);
/** 자료함에 들어가는 kind — src/v6/mirror/mirror-source.ts 의 sourceKindOf 와 같은 표. ClickUp 은 프로젝트 미러라 없다. */
export const COLLECT_KIND_OF: Record<string, string> = {
  github: 'github_issue', gitlab: 'gitlab_issue', linear: 'linear_issue', figma: 'figma_comment', slack: 'slack', notion: 'notion_doc',
};
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
  const panel = collectFace(onState, T.where !== '나만 봐요', COLLECT_KIND_OF[key] ?? '');
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
    const scopeNode = scopeChooser(key, (s.scope ?? {}) as Record<string, string>, !!s.enabled, async (sc) => {
      try {
        const r: any = await post({ enabled: true, scope: sc });
        if (r && r.ok) toast(s.enabled ? '범위를 저장했어요' : '자료 가져오기를 켰어요 — 첫 수집은 잠시 뒤 시작됩니다');
        else toast((r && r.message) || '바꾸지 못했습니다', true);
      } catch (e: any) { toast((e && e.message) || '바꾸지 못했습니다', true); }
      await paint();
    });
    //  #2243 3차 — «무엇을·얼마나 자주·언제부터» 는 켜기와 무관하게 저장된다(꺼져 있어도 미리 정해 둘 수 있다).
    const extra: HTMLElement[] = collectSettings({
      key, s, scopeNode: setRow('어디서', SCOPE_NOUN[key] ? `가져올 ${SCOPE_NOUN[key]}` : '', [scopeNode]),
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
    //  #2247 Linear — 라이블리 Linear OAuth 앱이 아직 등록되지 않았으면(app_ready=false) 관리자에게 등록 칸을 먼저 낸다.
    //   값은 이 화면에서 금고(조직 슬롯 linear_app/oauth:client)로 바로 간다 — 채팅·문서에 붙여넣을 일이 없다.
    if (key === 'linear' && s.app_ready === false) {
      const idIn = el('input', { type: 'text', class: 'cn-scope-in', placeholder: 'Client ID', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
      const secIn = el('input', { type: 'password', class: 'cn-scope-in', placeholder: 'Client Secret', autocomplete: 'new-password' }) as HTMLInputElement;
      const reg = el('button', { class: 'btn btn-sm', type: 'button', text: '앱 등록', onclick: async () => {
        const cid = idIn.value.trim(), sec = secIn.value.trim();
        if (!cid || !sec) { toast('Client ID 와 Client Secret 둘 다 넣어 주세요', true); (cid ? secIn : idIn).focus(); return; }
        reg.setAttribute('disabled', 'true');
        try {
          await api('/api/ui/org/credential', { method: 'POST', body: JSON.stringify({ kind: 'linear_app', scope_key: 'oauth:client', label: 'Linear 라이블리 앱(OAuth 클라이언트)', secret: JSON.stringify({ client_id: cid, client_secret: sec }) }) });
          secIn.value = ''; toast('Linear 앱을 등록했어요 — 이제 스위치를 켜면 Linear 화면이 열립니다');
        } catch (e: any) { toast((e && e.message) || '등록하지 못했습니다', true); }
        await paint();
      } });
      notes.push('라이블리 Linear 앱이 아직 등록되지 않았어요 — Linear ▸ Settings ▸ API ▸ OAuth Applications 에서 만든 앱의 Client ID 와 Client Secret 을 아래에 넣어 주세요(관리자 1회). 값은 금고로 바로 저장되고 다시 보이지 않습니다.');
      extra.push(el('div', { class: 'cn-scope-row' }, el('span', { class: 'k', text: '앱 등록' }), idIn, secIn, reg));
    }
    //  #2247 Linear — 토글이 곧 연결. 자격이 없으면 서버가 동의 URL 을 준다: 새 탭으로 열고, 돌아온 것(me_connected)이 보이면 다시 켠다.
    const consentThen = async (r: any): Promise<boolean> => {
      if (!(r && r.needs_connect && r.authorization_url)) return false;
      window.open(r.authorization_url, '_blank', 'noopener');
      toast(T.desc.split(' ')[0] === '워크스페이스의' ? 'Linear 화면에서 [허용]을 누르세요 — 돌아오면 여기가 저절로 켜집니다' : '새 탭에서 [허용]을 누르세요 — 돌아오면 여기가 저절로 켜집니다');
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
    if (key === 'linear' && s.app_ready === false) chk.disabled = true;   // 앱이 없으면 켤 수 없다 — 등록 칸이 먼저
    panel.set(chk, chk.checked ? '켜짐' : (key === 'linear' && s.app_ready === false ? '앱 등록 필요' : (s.needs_scope && SF ? '범위 필요' : '꺼짐')), notes, extra);
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
    toast('노션 화면에서 가져올 페이지를 고르고 [액세스 허용]을 누르세요 — 돌아오면 이 화면이 갱신됩니다');
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
    }
    else if (wsAll.length) notes.push(wsAll.length > 1
      ? `노션 워크스페이스 ${wsAll.length}곳이 연결돼 있어요 — 켜면 바로 모으기 시작합니다.`
      : '연결은 돼 있어요 — 켜면 바로 모으기 시작합니다.');
    else if (s && s.ready) notes.push('켜면 노션 화면이 열려요 — 거기서 가져올 페이지를 고르면 바로 시작됩니다. 토큰이나 설정을 만질 일은 없어요.');
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
      notes.push(`${on} 에서 가져오고 있어요 — 켠 사람(${(s.connected && s.connected.kind) ? '내' : '내'}) 구글 연결로 돕니다.`);
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
