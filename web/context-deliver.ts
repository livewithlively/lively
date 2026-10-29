// context-deliver.ts — [수집·증류 ▸ AI 주입 설정] 탭(#5159). 왼쪽 목차 + 오른쪽 세부 페이지 하나.
//
//  요구 원문(원준 2026-10-29): "AI 주입 설정 칸에서 이게 세로로 쭉 늘어져 있는데 … 층위 위에 탭으로 만들든 잘 정리하고 ·
//   너무 많이 늘어져 있는 훅들이나 이런 것들 세부 페이지를 나누든 웬만하면 한 페이지 안에 스크롤 안 해도 되게 ·
//   그냥 아예 레이아웃 구성을 다시 해 봐."
//  실측(1440×900, 고치기 전): 세션 주입 다섯 시점 + 의미 검색 + 맥락 공개범위 + 자료 공개범위를 한 판에 세로로 쌓아
//   5,577px — 화면 여섯 장 남짓이었다. 그래서:
//   ① **왼쪽 목차 = 층위 그대로.** 「세션 주입」(시작 → 작업 중 → 종료는 세로 선으로 이어 순서를 보인다 · 키트 · 기타 이벤트)
//     과 「검색 · 공개범위」 두 묶음. 줄마다 켜짐/꺼짐 점 + 낱말 + 개수 — 목차만 봐도 지금 상태가 읽힌다.
//   ② **오른쪽 = 고른 페이지 하나만.** 페이지마다 머리(제목 · 훅 이벤트 이름 · 스위치) + 2단 상자. 한 화면 안에 든다.
//   ③ 주소는 `#/context/deliver/<page>` — 목차를 눌러도 셸을 다시 그리지 않고 제자리에서 바꾸며 주소만 맞춘다(runs 필터와 같은 수법).
//  저장 경로(API)는 하나도 안 바꿨다 — 바뀐 건 화면이다(#837 불변식).
import { api, el, hasScope, replaceKids } from './core.js';
import { injectionMap, injectionStatus, type InjectionMoment } from './admin-injection.js';
import { embeddingsEditor } from './admin-embeddings.js';
import { visibilityAxesPanel } from './visibility-axes.js';
import { sourceVisPolicyPanel } from './source-vis-policy.js';
import { loadAdmin } from './admin-rerender.js';
import { dlvBox, dlvHead } from './lib/dlv.js';

export type DeliverPage = InjectionMoment | 'search' | 'access';

type NavItem = { key: DeliverPage; label: string; admin?: boolean; flow?: boolean };
const GROUPS: Array<{ label: string; admin?: boolean; items: NavItem[] }> = [
  {
    label: '세션 주입',
    items: [
      { key: 'start', label: '세션 시작', flow: true },
      { key: 'work', label: '작업 중', flow: true },
      { key: 'stop', label: '세션 종료', flow: true },
      { key: 'kit', label: '키트 자동 업데이트' },
      { key: 'events', label: '기타 이벤트' },
    ],
  },
  {
    //  의미 검색 · 공개범위는 GET 부터 관리자 몫이다(#1618) — 비관리자에겐 묶음째 숨는다.
    label: '검색 · 공개범위', admin: true,
    items: [
      { key: 'search', label: '의미 검색', admin: true },
      { key: 'access', label: '공개범위', admin: true },
    ],
  },
];

/** 이 탭의 페이지 키 전부 — context.ts 의 STAGES 가 이 표로 항목을 만든다. */
export const DELIVER_PAGES: NavItem[] = GROUPS.flatMap((g) => g.items);
/** 옛 주소(#1618 의 `#/context/deliver/<옛 키>`) → 새 페이지. 관리탭 SECTION_EXIT 가 아직 옛 키로 보낸다. */
export const DELIVER_ALIAS: Record<string, DeliverPage> = { injection: 'start', embeddings: 'search', visibility: 'access' };

type Status = { on: boolean | null; meta: string };

export async function renderDeliver(host: HTMLElement, first: DeliverPage): Promise<void> {
  const data = await loadAdmin().catch(() => ({} as any));
  const isAdmin = hasScope('admin');
  const visible = (i: NavItem) => !i.admin || isAdmin;
  let cur: DeliverPage = DELIVER_PAGES.some((i) => i.key === first && visible(i)) ? first : 'start';

  // 목차 상태 — 주입 시점은 관리 데이터에서 바로, 검색·공개범위는 자기 API 에서 뒤늦게(목차를 늦추지 않는다).
  const status: Partial<Record<DeliverPage, Status>> = {};
  const fillInjection = () => Object.assign(status, injectionStatus(data));
  fillInjection();

  const nav = el('nav', { class: 'dlv-nav', 'aria-label': 'AI 주입 설정' });
  const panel = el('div', { class: 'dlv-panel' });
  replaceKids(host, el('div', { class: 'dlv' }, nav, panel));

  function paintNav() {
    replaceKids(nav, ...GROUPS.filter((g) => !g.admin || isAdmin).map((g) => el('div', { class: 'dlv-nav-g' },
      el('div', { class: 'dlv-nav-h', text: g.label }),
      ...g.items.filter(visible).map((i) => {
        const s = status[i.key];
        const word = s && s.on != null ? (s.on ? '켜짐' : '꺼짐') : '';
        const meta = [word, s ? s.meta : ''].filter(Boolean).join(' · ');
        const a = el('a', {
          class: 'dlv-nav-i' + (i.key === cur ? ' on' : '') + (i.flow ? ' flow' : ''),
          href: '#/context/deliver/' + i.key, 'data-page': i.key,
          'aria-current': i.key === cur ? 'page' : null,
        },
          el('span', { class: 'dlv-dot' + (s && s.on === true ? ' on' : s && s.on === false ? ' off' : ''), 'aria-hidden': 'true' }),
          el('span', { class: 'dlv-nav-b' },
            el('span', { class: 'dlv-nav-t', text: i.label }),
            meta ? el('span', { class: 'dlv-nav-m', text: meta }) : null));
        a.addEventListener('click', (e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;   // 새 탭으로 열기는 브라우저에 맡긴다
          e.preventDefault();
          go(i.key);
        });
        return a;
      }))));
  }

  async function refreshAdminStatus() {
    if (!isAdmin) return;
    const [emb, axes, svp] = await Promise.all([
      api('/api/ui/org/embeddings').catch(() => null),
      api('/api/ui/vis/axes').catch(() => null),
      api('/api/ui/source-vis-policy').catch(() => null),
    ]);
    if (emb) {
      const on = (emb.config && emb.config.provider) === 'http';
      const pending = (emb.backlog && emb.backlog.pending) || 0;
      status.search = { on, meta: on && pending ? '남은 ' + pending + '건' : '' };
    }
    const ax = (axes && axes.axes) || null;
    const rules = (svp && svp.rules) || null;
    if (ax || rules) {
      status.access = { on: null, meta: [ax ? '맥락 ' + ax.filter((a) => a.on).length + '/' + ax.length : '', rules ? '자료 규칙 ' + rules.length : ''].filter(Boolean).join(' · ') };
    }
    paintNav();
  }

  const onChange = () => { fillInjection(); paintNav(); };

  function paintPanel() {
    panel.scrollTop = 0;
    if (cur === 'search') {
      const body = el('div');
      replaceKids(panel, el('div', { class: 'dlv-page' },
        dlvHead('의미 검색', 'AI와 사람이 지식을 단어가 아니라 뜻으로 찾게 합니다. 꺼 두면 단어가 그대로 들어간 지식만 찾습니다.'),
        body));
      embeddingsEditor(body, data, { bare: true });
      return;
    }
    if (cur === 'access') {
      const axesHost = el('div'); const svpHost = el('div');
      const refresh = () => { void refreshAdminStatus(); };
      replaceKids(panel, el('div', { class: 'dlv-page' },
        dlvHead('공개범위', '맥락이 누구에게 보이는지 정합니다. 왼쪽은 유형별 기능 스위치, 오른쪽은 수집 자료에 거는 규칙입니다.'),
        el('div', { class: 'dlv-grid dlv-grid-2' },
          dlvBox('맥락 공개범위', '유형마다 공개범위 기능을 쓸지 정합니다. 끄면 그 유형은 조직 전원에게 공개됩니다.', axesHost),
          dlvBox('자료 공개범위', '커넥터·채널별로 수집 자료를 볼 사람을 정합니다. 앞으로 수집되는 자료에 적용됩니다.', svpHost))));
      void visibilityAxesPanel(axesHost, { bare: true, onChange: refresh });
      void sourceVisPolicyPanel(svpHost, { bare: true, onChange: refresh });
      return;
    }
    injectionMap(panel, data, { only: cur, onChange });
  }

  function go(key: DeliverPage) {
    cur = key;
    try { history.replaceState(history.state, '', '#/context/deliver/' + key); } catch { /* 액자 안 등 — 주소 동기화는 덤 */ }
    paintNav();
    paintPanel();
  }

  paintNav();
  paintPanel();
  void refreshAdminStatus();
}
