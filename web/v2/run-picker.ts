// v2/run-picker.ts — '무엇으로 열까' 줄(**제공자 · 모델 · 추론강도**)과 [⚙] 새 세션 기본값(#1758·#1744·#3778).
//
//  ── 왜 제공자인가 ──
//  사람은 'Claude Code' 보다 '앤트로픽' 을 먼저 떠올린다. 그래서 화면은 **제공자**를 묻고, 그 답이 곧 어떤 CLI 가
//  뜨는지를 정한다 — 앤트로픽=Claude Code · 오픈AI=Codex · 제미나이=Antigravity · xAI=Grok Build · 그 밖=OpenCode.
//  매핑은 여기 있지 않다: 서버 카탈로그(src/terminal/catalog.ts)가 하네스마다 provider 를 들고 있고 이 모듈은 그걸
//  그대로 읽는다. 화면에 매핑을 복사해 두면 하네스가 늘 때 한쪽만 고쳐진다.
//
//  ── 줄엔 셋만, 나머지는 [⚙](#3778 안 C, 원준 2026-09-09) ──
//  종전엔 실행 노드까지 넷이 한 줄에 섰다. 노드는 #2172 규칙(켜진 내 컴퓨터 우선)이 이미 자동으로 정하는 값이라 세션마다
//  바꿀 일이 드물고, 라이블리 모드·실행 승인·기록 범위도 같다. 그 넷은 [⚙] 「새 세션 기본값」 창(session-defaults.ts)으로
//  가고, 줄에는 세션마다 실제로 바꾸는 셋 — AI · 모델 · 추론강도 — 만 남는다. 값은 run-prefs.ts 가 한 곳에서 읽는다.
//
//  ── 칸 폭 = 고른 값(#3778) ──
//  <select> 의 폭은 브라우저가 **가장 긴 선택지**로 정한다. 그래서 «Opus 4.5» 를 골라도 칸은 가장 긴 선택지만큼이고,
//  글자와 ▾ 사이 빈칸이 칸마다 달라 줄이 들쭉날쭉했다(원준 2026-09-09 실측 — 여백 CSS 로는 안 고쳐진다). 그래서 고른
//  option 의 글자를 같은 글꼴의 숨은 span 으로 재서 폭을 직접 준다(fit). 칸 사이는 gap 이 아니라 가는 세로선이 경계를 말한다.
//  세 칸의 문구는 모두 «축 · 값» 이다(제공자 칸은 «회사 · 도구» 가 곧 그 형식이다).
//
//  ── 기본값 = 직전 세팅 ──
//  제공자·모델·추론강도의 기본은 **내가 지난번에 고른 값**이다 — 클래식 '새 AI 세션' 폼과 같은 localStorage 키
//  (run-prefs.ts). 고른 적이 없으면 **서버 카탈로그가 선언한 기본값**을 골라 둔다(#3778) — 화면에 보이는 값이 곧 그
//  세션이 열리는 값이다. 종전엔 빈 값이 골라져 «AI 기본값» 이라고만 적혔는데, 그 실제 값은 격리 계정 홈에 있어 화면이
//  읽을 수 없다 — «알 수 없음» 을 «기본값» 이라 적고 있었다(원준 2026-09-09 «기본값이 뭔지 사용자가 알 수가 없잖아»).
//
//  ── 소비자 ──
//  홈 입력창(v2/views.ts) · 프로젝트 새 세션 자리(v2/panes-parts.ts) · 프로젝트 '클로드로 실행' 기본값(projects/selection.ts) ·
//  세션 대화창(session-chat.ts — 헬퍼만).
import { api, el, toast } from '../core.js';
import { isAiHarness, resolveNodeChoice, resolveNodeDefault, runPrefs, saveRunPrefs, sessionDefaults, type RunNode } from './run-prefs.js';
import { defaultsSummary, openSessionDefaults } from './session-defaults.js';
import type { MentionMember } from './mention-text.js';
// 잎 모듈로 옮긴 것들의 재수출 — 종전 import 경로(run-picker)를 그대로 쓰는 소비자를 깨지 않는다.
export { defaultNodeId, nodeCanRunAi, runPrefs, saveRunPrefs, type RunNode, type RunPrefs } from './run-prefs.js';

export interface RunFlagDef { name: string; label: string; desc?: string; type?: string; choices?: string[]; default?: string }
export interface RunHarness {
  key: string; label: string; bin?: string;
  provider?: { id: string; label: string };
  flags: RunFlagDef[];
  effortsByModel?: Record<string, string[]>;
  hasAutoApprove?: boolean;
  // 이미 떠 있는 세션에서 그 축을 바꿀 수 있나(슬래시 명령이 있는 하네스만 — 서버 catalog.ts runtimeCmd).
  runtime?: { model?: boolean; effort?: boolean };
}

/** 추론강도 값 → 사람 말. 서버가 주는 값은 low|medium|high|xhigh|max 로 하네스마다 일부만 쓴다. */
export const EFFORT_KO: Record<string, string> = { none: '없음', low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대', ultra: '울트라' };
export const effortKo = (v: string): string => EFFORT_KO[v] || v;

/** 모델 id 를 읽을 만하게 — 'claude-opus-4-5-20251101' → 'Opus 4 5'. 대화창 칩이 쓰던 규칙 그대로. */
export function prettyModel(m: string): string {
  return String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '')
    .split('-').map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

// 서버 카탈로그가 provider 를 안 주는 경우(옛 게이트웨이 + 새 번들이 캐시로 남은 조합)의 폴백.
//  없는 하네스는 '그 밖의 제공자' 로 접는다 — 이름을 지어내지 않는다.
const PROVIDER_FALLBACK: Record<string, string> = {
  claude: 'Anthropic', codex: 'OpenAI', antigravity: 'Google Gemini', grok: 'xAI', opencode: '그 밖의 제공자', shell: 'AI 없음',
};
export const providerLabel = (h: RunHarness | null | undefined): string =>
  (h && h.provider && h.provider.label) || (h ? (PROVIDER_FALLBACK[h.key] || '그 밖의 제공자') : '');

// ── 카탈로그 — /terminal/config 를 한 번만 받아 세션 내내 나눠 쓴다(홈·프로젝트·대화창·@초대가 각자 부른다) ──
//  하네스·노드·구성원을 같은 응답에서 얻으므로 원문 config 를 캐시하고 셋을 파생한다(runCatalog 시그니처는 그대로).
interface RunConfig { harnesses: RunHarness[]; nodes: RunNode[]; members: MentionMember[] }
let cached: RunConfig | null = null;
let inflight: Promise<RunConfig> | null = null;
function loadConfig(): Promise<RunConfig> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = api('/api/ui/terminal/config')
      .then((cfg: any) => {
        cached = {
          harnesses: Array.isArray(cfg && cfg.harnesses) ? cfg.harnesses : [],
          nodes: Array.isArray(cfg && cfg.nodes) ? cfg.nodes : [],
          members: Array.isArray(cfg && cfg.members) ? cfg.members : [],
        };
        nodesAt = Date.now();
        return cached;
      })
      .catch(() => ({ harnesses: [] as RunHarness[], nodes: [] as RunNode[], members: [] as MentionMember[] }))   // 못 받으면 빈 목록 — 부르는 쪽이 칸을 안 그리고 지난번 설정 그대로 연다
      .finally(() => { inflight = null; });
  }
  return inflight;
}

// ── 노드 축은 «지금» 이다 (#3833) ────────────────────────────────────────────────
//  하네스·구성원은 세션 내내 안 변하지만 online 은 초 단위로 변한다. 종전엔 셋이 한 캐시에 묶여 **무효화 경로가
//  아예 없었고**, 그래서 탭을 연 순간의 스냅샷이 탭 수명 내내 남았다 — 게이트웨이가 재시작한 몇 초 사이에 그 값을
//  받은 사람은 켜져 있는 자기 맥북을 «지금 꺼짐» 으로 계속 보고, [시키기]는 딴 컴퓨터로 폴백했다(윤상민 2026-09-09).
//  세션 스트림은 다른 경로라 멀쩡히 붙어 있어서 «세션은 되는데 홈만 꺼졌다고 한다» 가 됐다.
//  그래서 이 축만 다시 읽는 문을 둔다 — [⚙] 를 열 때와 [시키기] 직전, 즉 그 값이 실제로 쓰이는 두 자리에서 부른다.
let nodesAt = 0;
let nodesInflight: Promise<RunNode[]> | null = null;
/** 노드 축만 재조회. maxAgeMs 안에 이미 읽었으면 그대로 쓴다(연타·두 자리 연속 호출이 요청을 겹치지 않게). */
export async function refreshNodes(maxAgeMs = 0): Promise<RunNode[]> {
  if (!cached) return (await loadConfig()).nodes;   // 첫 로드가 곧 최신이다
  if (maxAgeMs > 0 && nodesAt && Date.now() - nodesAt < maxAgeMs) return cached.nodes;
  if (!nodesInflight) {
    nodesInflight = api('/api/ui/terminal/config?only=nodes')
      .then((out: any) => {
        const ns = Array.isArray(out && out.nodes) ? out.nodes as RunNode[] : null;
        if (!ns || !cached) return cached ? cached.nodes : [];
        nodesAt = Date.now();
        cached.nodes = ns;
        return ns;
      })
      // 못 받으면 **지금 아는 대로** 간다 — 여기서 빈 목록을 내면 «노드가 하나도 없다» 로 읽혀 중앙으로 폴백한다.
      .catch(() => (cached ? cached.nodes : []))
      .finally(() => { nodesInflight = null; });
  }
  return nodesInflight;
}
export function runCatalog(): Promise<RunHarness[]> { return loadConfig().then((c) => c.harnesses); }
/** 실행 노드 목록(#1744) — 내가 세션을 만들 수 있는 노드(서버가 소유·공유로 이미 필터). 온라인만 실제 생성 가능(폼이 게이트). */
export function runNodes(): Promise<RunNode[]> { return loadConfig().then((c) => c.nodes); }
/** 초대 후보(#3778 @이름) — 활성 구성원(시스템 계정 제외). 서버가 세션 생성 때 다시 검증한다(validInvites). */
export function runMembers(): Promise<MentionMember[]> { return loadConfig().then((c) => c.members); }
/** 이 하네스가 카탈로그에 있나 — 없으면 null(모르는 하네스로 다룬다, claude 로 추측하지 않는다). */
export const findHarness = (hs: RunHarness[], key: string): RunHarness | null => hs.find((h) => h.key === key) || null;
export const flagChoices = (h: RunHarness | null, name: string): string[] =>
  ((h && h.flags) || []).find((f) => f.name === name)?.choices?.filter(Boolean) ?? [];
/** 그 축의 **기본값**(서버 카탈로그가 선언한 것) — 화면은 이 값을 골라 두고 그대로 넘긴다(#3778). 없으면 ''. */
export const flagDefault = (h: RunHarness | null, name: string): string => {
  const f = ((h && h.flags) || []).find((x) => x.name === name);
  const d = String((f && f.default) || '');
  return d && (f?.choices || []).includes(d) ? d : '';
};
export const effortChoices = (h: RunHarness | null, model: string): string[] => {
  const scoped = h?.effortsByModel?.[model];
  return Array.isArray(scoped) ? scoped : flagChoices(h, '--effort');
};

/** 지금 고른 값 + 기본값 창의 넷 — 생성 바디로 간다. flags 는 **빈 값을 뺀다**(빈 값 = 그 축을 안 넘긴다). node='' = 중앙 컴퓨터. */
export interface RunPick {
  harness: string; flags: Record<string, string>; node: string;
  mode: 'normal' | 'readonly' | 'incognito'; autoApprove: boolean; writeVis: string;
}
export interface RunPicker {
  /** 세 칸을 담은 요소 — 줄 왼쪽(.v2-launch-ctl)에 붙인다. */
  el: HTMLElement;
  /** [⚙] 새 세션 기본값 단추 — 줄 오른쪽 행동 묶음(.v2-launch-act)에서 [＋] 왼쪽에 선다. */
  gear: HTMLElement;
  value(): RunPick;
  /**
   * [시키기] 직전의 값(#3833) — **노드 축을 다시 읽고** 정한다. value() 와 달리 비동기인 이유는 그것이 이 축의
   *  성질이기 때문이다: 어느 컴퓨터가 켜져 있나는 «지금» 을 물어야 하고, 그 답이 틀리면 세션이 딴 데서 열린다.
   *  고른 컴퓨터가 아닌 데로 가게 되면 그 사실을 한 줄로 말한다(조용히 바꾸지 않는다).
   */
  resolve(): Promise<RunPick>;
  /** 입력 잠금(보내는 중). */
  disable(on: boolean): void;
}

const GEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

/**
 * 제공자·모델·추론강도 칸과 [⚙]를 만든다. 카탈로그는 비동기로 오므로 **먼저 빈 자리를 반환하고** 도착하면 채운다 —
 * 그 사이에 사람이 Enter 를 쳐도 value() 가 저장된 직전 설정을 그대로 돌려주므로 세션은 정상적으로 열린다.
 */
export function createRunPicker(opts?: { onChange?: (p: RunPick) => void; remember?: boolean }): RunPicker {
  const remember = opts?.remember !== false;
  const prefs = runPrefs();
  const savedFlags: Record<string, string> = (prefs.flags && typeof prefs.flags === 'object') ? { ...prefs.flags } as Record<string, string> : {};
  let harnesses: RunHarness[] = [];
  let nodes: RunNode[] = cached ? cached.nodes : [];
  let harnessKey = String(prefs.harness && prefs.harness !== 'shell' ? prefs.harness : 'claude');

  const sel = (cls: string, title: string): HTMLSelectElement =>
    el('select', { class: 'v2-run-sel ' + cls, title, 'aria-label': title }) as HTMLSelectElement;
  const provSel = sel('v2-run-prov', '어느 회사 모델로 열까요');
  const modelSel = sel('v2-run-model', '모델을 고릅니다');
  const effortSel = sel('v2-run-effort', '추론강도를 고릅니다');
  const sep1 = el('span', { class: 'v2-run-sep', 'aria-hidden': 'true' });
  const sep2 = el('span', { class: 'v2-run-sep', 'aria-hidden': 'true' });
  const measure = el('span', { class: 'v2-run-measure', 'aria-hidden': 'true' });
  const root = el('div', { class: 'v2-run' }, provSel, sep1, modelSel, sep2, effortSel, measure);
  provSel.replaceChildren(el('option', { value: '' }, '불러오는 중…'));
  provSel.disabled = true; modelSel.hidden = true; effortSel.hidden = true;

  // [⚙] — 기본값 창. 저장하면 툴팁을 다시 쓰고, 노드가 바뀌었을 수 있으니 제공자 목록도 다시 그린다.
  //  아이콘은 톱니(프로젝트 화면 태그 설정과 같은 모양) — 첫 판의 «원 + 빛살 여덟» 은 해로 읽혔다(원준 2026-09-09).
  const gear = el('button', { class: 'v2-launch-gear', type: 'button', 'aria-label': '새 세션 기본값' }) as HTMLButtonElement;
  gear.innerHTML = GEAR_SVG;
  gear.addEventListener('click', () => {
    // 목록의 «지금 꺼짐» 은 **지금** 사실이어야 한다 — 창을 열기 전에 노드 축만 다시 읽는다(#3833).
    void refreshNodes(3000)
      .then((ns) => { nodes = ns; paintGear(); return openSessionDefaults({ nodes, hasAutoApprove: !!cur()?.hasAutoApprove }); })
      .then((saved) => { if (saved) { paint(); opts?.onChange?.(pick()); } });
  });
  const paintGear = (): void => { gear.title = '새 세션 기본값 — ' + defaultsSummary(sessionDefaults(), nodes); };

  const cur = (): RunHarness | null => findHarness(harnesses, harnessKey);
  /** 기본값 창이 정한 실행 노드 — 규칙(#2172)이거나 사람이 고른 것. 꺼졌으면 규칙으로. */
  const nodeKey = (): string => resolveNodeDefault(nodes, sessionDefaults().nodeDefault);
  // 이 노드가 띄울 수 있는 하네스 키 집합(없거나 미보고면 null = 제한 없음 — 클래식 폼과 같은 규칙).
  const nodeAllow = (): Set<string> | null => {
    const id = nodeKey();
    const n = id ? nodes.find((x) => x.id === id) || null : null;
    return n && Array.isArray(n.harnesses) && n.harnesses.length ? new Set(n.harnesses) : null;
  };
  const AXES = ['--model', '--effort'];
  const boxOf = (name: string): HTMLSelectElement => (name === '--model' ? modelSel : effortSel);
  // 그 하네스가 안 받는 축(예: OpenCode 의 모델)은 **값을 안 낸다** — 서버가 조용히 버릴 값을 넘기면
  //  화면은 고른 대로 됐다고 믿게 된다. 대신 기억(savedFlags)에는 남겨 둬서 그 하네스로 돌아오면 되살아난다.
  const visVal = (name: string): string => (boxOf(name).hidden ? '' : boxOf(name).value);

  /** 칸 폭 = 고른 option 의 글자 폭(머리말 참조). 카드에 붙기 전엔 잴 수 없어 ResizeObserver 가 붙는 순간 다시 잰다. */
  function fit(): void {
    for (const s of [provSel, modelSel, effortSel]) {
      if (s.hidden) continue;
      const o = s.selectedOptions && s.selectedOptions[0];
      measure.textContent = o ? (o.textContent || '') : '';
      const w = measure.offsetWidth;
      if (w > 0) s.style.width = Math.min(w + 30, 240) + 'px';   // 8 왼쪽 + 18 ▾ 자리 + 4 여유
    }
    sep1.hidden = modelSel.hidden || provSel.disabled;
    sep2.hidden = effortSel.hidden || modelSel.hidden;
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => fit()).observe(root);

  function paintFlag(box: HTMLSelectElement, name: string, emptyText: string, label: (v: string) => string): void {
    const choices = name === '--effort' ? effortChoices(cur(), modelSel.value) : flagChoices(cur(), name);
    box.hidden = !choices.length;
    if (!choices.length) return;
    // 고른 적이 없으면 **카탈로그가 선언한 기본값**을 골라 둔다(#3778) — 보이는 값이 곧 열리는 값이다.
    //  ⚠ 이 값은 기억에 저장하지 않는다(changed() 는 사람이 만진 축만 저장) — 카탈로그가 기본을 올리면 따라온다.
    const want = box.value || String(savedFlags[name] || '') || flagDefault(cur(), name);
    box.replaceChildren(el('option', { value: '' }, emptyText), ...choices.map((c) => el('option', { value: c }, label(c))));
    box.value = choices.includes(want) ? want : '';
  }
  function paint(): void {
    paintGear();
    // 셸은 AI 가 아니라 여기 후보가 아니다 — 이 칸은 '무엇에게 시킬까'를 묻는다. 기본 노드가 정해졌으면 그 PC 가 띄울 수 있는 것만.
    const allow = nodeAllow();
    const list = harnesses.filter((h) => isAiHarness(h.key) && (!allow || allow.has(h.key)));
    provSel.disabled = !list.length;
    if (!list.length) {
      // 고를 것이 없는 두 경우는 **사람에게 다른 사실**이라 문구를 나눈다(종전엔 한 문장이 둘을 덮어, AI 가 없는
      //  PC 가 기본으로 잡혔을 때 "왜 못 고르지"가 화면에서 답을 못 얻었다 — 윤상민 2026-08-28 신고).
      //  ⚠ "없어요"라고 **단정하지 않는다**(#2172 실측) — PATH 를 못 물려받은 노드 에이전트는 깔린 AI 도 못 찾는다.
      provSel.title = harnesses.length
        ? '이 컴퓨터의 노드 에이전트가 claude·codex 같은 AI 명령을 찾지 못했어요. 그 컴퓨터에서 `claude --version` 이 되는지, 노드를 다시 시작하면 잡히는지 확인해 보세요.'
        : '어느 AI 가 있는지 아직 못 받아서, 지난번 설정 그대로 엽니다.';
      provSel.replaceChildren(el('option', { value: '' }, harnesses.length ? 'AI 를 못 찾았어요' : '지난번 설정 그대로'));
      modelSel.hidden = true; effortSel.hidden = true; fit(); return;
    }
    if (!list.some((h) => h.key === harnessKey)) harnessKey = list[0].key;   // 그 노드가 못 띄우는 하네스였으면 첫 후보로
    provSel.title = '어느 회사 모델로 열까요';
    provSel.replaceChildren(...list.map((h) => el('option', { value: h.key }, providerLabel(h) + ' · ' + h.label)));
    provSel.value = harnessKey;
    // 문구는 셋 다 «축 · 값». 모델은 다듬어 적는다(prettyModel) — 'claude-opus-4-5-20251101' 은 칸을 통째로 먹고도 안 보인다.
    //  빈 값('AI 설정 그대로')은 이제 **사람이 일부러 고르는 선택지**다 — 그 축을 안 넘겨 그 AI 계정의 저장된 설정을 따른다.
    paintFlag(modelSel, '--model', '모델 · AI 설정 그대로', (v) => '모델 · ' + prettyModel(v));
    paintFlag(effortSel, '--effort', '추론 · AI 설정 그대로', (v) => '추론 · ' + effortKo(v));
    fit();
  }
  const changed = (): void => {
    for (const n of AXES) if (!boxOf(n).hidden) savedFlags[n] = boxOf(n).value;
    if (remember) saveRunPrefs({ harness: harnessKey, flags: { ...savedFlags } });
    fit();
    opts?.onChange?.(pick());
  };
  provSel.addEventListener('change', () => { harnessKey = provSel.value; modelSel.value = ''; effortSel.value = ''; paint(); changed(); });
  modelSel.addEventListener('change', () => { paintFlag(effortSel, '--effort', '추론 · AI 설정 그대로', (v) => '추론 · ' + effortKo(v)); changed(); });
  effortSel.addEventListener('change', changed);

  const pick = (): RunPick => {
    const flags: Record<string, string> = {};
    for (const n of AXES) { const v = visVal(n); if (v) flags[n] = v; }
    const d = sessionDefaults();
    return {
      harness: harnessKey, flags, node: nodeKey(),
      mode: d.mode,
      // 자동 승인 플래그가 없는 AI 엔 안 넘긴다 — 서버가 조용히 버릴 값을 화면이 «켰다»고 믿게 두지 않는다.
      autoApprove: d.autoApprove && !!cur()?.hasAutoApprove,
      writeVis: d.mode === 'normal' ? d.writeVis : '',
    };
  };

  /** 폴백 사유 → 사람 말. 사유를 안 적으면 «왜 딴 데서 열렸지» 가 화면 어디에도 답을 못 얻는다. */
  const FELL_BACK: Record<'offline' | 'gone' | 'no-ai', string> = {
    offline: '가 지금 꺼져 있어',
    gone: '를 지금 목록에서 못 찾아',
    'no-ai': '에서 띄울 수 있는 AI 를 못 찾아',
  };
  const resolve = async (): Promise<RunPick> => {
    nodes = await refreshNodes(3000);
    paintGear();
    const ch = resolveNodeChoice(nodes, sessionDefaults().nodeDefault);
    if (ch.fellBack) {
      const to = ch.id ? (nodes.find((n) => n.id === ch.id)?.name || ch.id) : '중앙 컴퓨터';
      toast(`«${ch.fellBack.name}»${FELL_BACK[ch.fellBack.why]} «${to}» 에서 엽니다.`);
    }
    return { ...pick(), node: ch.id };
  };

  void loadConfig().then((c) => { harnesses = c.harnesses; nodes = c.nodes; paint(); });

  return {
    el: root, gear,
    value: pick, resolve,
    disable(on: boolean) { provSel.disabled = on || !harnesses.length; modelSel.disabled = on; effortSel.disabled = on; gear.disabled = on; },
  };
}
