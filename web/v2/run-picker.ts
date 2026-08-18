// v2/run-picker.ts — '어디서 · 무엇으로 열까' 칸(**실행 노드 · 제공자 · 모델 · 추론강도**)과 그 기억(#1758·#1744).
//
//  ── 왜 제공자인가 ──
//  사람은 'Claude Code' 보다 '앤트로픽' 을 먼저 떠올린다. 그래서 화면은 **제공자**를 묻고, 그 답이 곧 어떤 CLI 가
//  뜨는지를 정한다 — 앤트로픽=Claude Code · 오픈AI=Codex · 제미나이=Antigravity · xAI=Grok Build · 그 밖=OpenCode.
//  매핑은 여기 있지 않다: 서버 카탈로그(src/terminal/catalog.ts)가 하네스마다 provider 를 들고 있고 이 모듈은 그걸
//  그대로 읽는다. 화면에 매핑을 복사해 두면 하네스가 늘 때 한쪽만 고쳐진다.
//
//  ── 실행 노드(#1744) ──
//  기본은 **중앙 컴퓨터**(게이트웨이 박스). 등록된 노드(내 PC ∪ 관리자가 공유로 지정한 노드)가 있으면 그 앞에 '실행 노드'
//  칸이 뜬다 — 어느 컴퓨터에서 세션이 도느냐다. 노드마다 깔린 AI 가 달라서(그 PC 가 hello 로 보고한 harnesses) **노드를
//  고르면 제공자 목록이 그 PC 가 실제로 띄울 수 있는 것만 남는다**(클래식 '새 AI 세션' 폼과 같은 규칙 — 못 고르게만 하고
//  끝내지 않으려 목록 자체를 좁힌다). 노드가 하나도 없으면 이 칸은 아예 안 그린다(중앙만 있는 사람에게 군더더기 금지).
//
//  ── 기본값 = 직전 세팅 ──
//  칸들의 기본은 **내가 지난번에 고른 값**이다 — 클래식 '새 AI 세션' 폼이 쓰는 것과 **같은 localStorage 키**
//  (lively_term_create_prefs, 사용자별)를 읽고, 여기서 고른 값도 거기에 되쓴다. 두 화면이 서로의 기억을 잇는다.
//  모델·추론강도의 빈 값은 '(자동)' 이 아니라 **'지난번 그대로'** 다 — 그 플래그를 아예 안 넘겨 그 AI 가 자기
//  설정(마지막에 고른 모델)으로 뜬다는 뜻이고, 화면은 그 뜻을 그대로 적는다(session-form.ts 와 같은 문구).
//  실행 노드는 기억하되 **지금 온라인인 노드일 때만** 기본으로 되살린다(오프라인 노드에는 세션을 못 만든다 — 서버 409).
//
//  ── 소비자 ──
//  홈 입력창(v2/views.ts) · 프로젝트 '클로드로 실행' 기본값(projects/selection.ts) · 세션 대화창(session-chat.ts —
//  거기선 제공자·노드가 고정이고 모델·추론강도만 바꾼다: 이미 뜬 프로세스는 다른 회사 모델·다른 컴퓨터로 못 옮긴다).
import { api, el, state } from '../core.js';

export interface RunFlagDef { name: string; label: string; desc?: string; type?: string; choices?: string[]; default?: string }
export interface RunHarness {
  key: string; label: string; bin?: string;
  provider?: { id: string; label: string };
  flags: RunFlagDef[];
  hasAutoApprove?: boolean;
  // 이미 떠 있는 세션에서 그 축을 바꿀 수 있나(슬래시 명령이 있는 하네스만 — 서버 catalog.ts runtimeCmd).
  runtime?: { model?: boolean; effort?: boolean };
}
// 실행 노드(#869·#1744) — 서버 /terminal/config 의 cfg.nodes 그대로. harnesses = 그 PC 가 띄울 수 있는 하네스 키(미보고면 기준선).
export interface RunNode { id: string; name?: string; kind?: string; shared?: boolean; online?: boolean; harnesses?: string[] }

/** 추론강도 값 → 사람 말. 서버가 주는 값은 low|medium|high|xhigh|max 로 하네스마다 일부만 쓴다. */
export const EFFORT_KO: Record<string, string> = { low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대' };
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

// ── 카탈로그 — /terminal/config 를 한 번만 받아 세션 내내 나눠 쓴다(홈·프로젝트·대화창이 각자 부른다) ──
//  하네스와 노드를 같은 응답에서 얻으므로 원문 config 를 캐시하고 둘을 파생한다(runCatalog 시그니처는 그대로 — session-chat 등 소비자 무변).
interface RunConfig { harnesses: RunHarness[]; nodes: RunNode[] }
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
        };
        return cached;
      })
      .catch(() => ({ harnesses: [] as RunHarness[], nodes: [] as RunNode[] }))   // 못 받으면 빈 목록 — 부르는 쪽이 칸을 안 그리고 지난번 설정 그대로 연다
      .finally(() => { inflight = null; });
  }
  return inflight;
}
export function runCatalog(): Promise<RunHarness[]> { return loadConfig().then((c) => c.harnesses); }
/** 실행 노드 목록(#1744) — 내가 세션을 만들 수 있는 노드(서버가 소유·공유로 이미 필터). 온라인만 실제 생성 가능(폼이 게이트). */
export function runNodes(): Promise<RunNode[]> { return loadConfig().then((c) => c.nodes); }
/** 이 하네스가 카탈로그에 있나 — 없으면 null(모르는 하네스로 다룬다, claude 로 추측하지 않는다). */
export const findHarness = (hs: RunHarness[], key: string): RunHarness | null => hs.find((h) => h.key === key) || null;
export const flagChoices = (h: RunHarness | null, name: string): string[] =>
  ((h && h.flags) || []).find((f) => f.name === name)?.choices?.filter(Boolean) ?? [];

// ── 실행 설정 기억 — 클래식 '새 AI 세션' 폼과 **같은 키**(사용자별 → 옛 전역 키 폴백) ──
//  그 모듈(terminal/session-form.ts)을 import 하지 않는 이유: v2 → terminal 방향의 런타임 의존을 만들지 않으려고
//  (check-imports 순환 게이트). 키 규약만 공유한다 — quick-session.ts 가 종전에 하던 것과 같은 약속이다.
const PREFS_KEY = 'lively_term_create_prefs';
const prefsKey = (): string => PREFS_KEY + '::' + ((state.me && (state.me.userId || state.me.email)) || 'anon');
export interface RunPrefs { harness?: string; flags?: Record<string, string>; autoApprove?: boolean; node?: string; [k: string]: unknown }
export function runPrefs(): RunPrefs {
  try {
    const raw = localStorage.getItem(prefsKey()) || localStorage.getItem(PREFS_KEY) || '{}';
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? p : {};
  } catch { return {}; }
}
/** 고른 값을 **덧쓴다**(통째 교체 아님) — 폼이 기억해 둔 나머지(자동 승인·스냅샷)를 지우지 않는다. */
export function saveRunPrefs(patch: RunPrefs): void {
  try { localStorage.setItem(prefsKey(), JSON.stringify({ ...runPrefs(), ...patch })); } catch { /* localStorage 불가 — 기억만 못 할 뿐 */ }
}

export interface RunPick { harness: string; flags: Record<string, string>; node: string }
export interface RunPicker {
  /** 칸들을 담은 요소 — 부르는 쪽이 원하는 자리에 붙인다. */
  el: HTMLElement;
  /** 지금 고른 값. flags 는 **빈 값을 뺀다**(안 넘기는 게 '지난번 그대로'라서). node='' = 중앙 컴퓨터. */
  value(): RunPick;
  /** 입력 잠금(보내는 중). */
  disable(on: boolean): void;
}

/**
 * 실행 노드·제공자·모델·추론강도 칸을 만든다. 카탈로그는 비동기로 오므로 **먼저 빈 자리를 반환하고** 도착하면 채운다 —
 * 그 사이에 사람이 Enter 를 쳐도 value() 가 저장된 직전 설정을 그대로 돌려주므로 세션은 정상적으로 열린다.
 */
export function createRunPicker(opts?: { onChange?: (p: RunPick) => void; remember?: boolean }): RunPicker {
  const remember = opts?.remember !== false;
  const prefs = runPrefs();
  const savedFlags: Record<string, string> = (prefs.flags && typeof prefs.flags === 'object') ? { ...prefs.flags } as Record<string, string> : {};
  let harnesses: RunHarness[] = [];
  let nodes: RunNode[] = [];
  let harnessKey = String(prefs.harness && prefs.harness !== 'shell' ? prefs.harness : 'claude');
  let nodeKey = String(prefs.node || '');   // 도착한 노드 목록으로 온라인 검증 후 확정(오프라인·삭제된 노드면 중앙으로).

  const sel = (cls: string, title: string): HTMLSelectElement =>
    el('select', { class: 'v2-run-sel ' + cls, title, 'aria-label': title }) as HTMLSelectElement;
  const nodeSel = sel('v2-run-node', '어느 컴퓨터에서 실행할까요');
  const provSel = sel('v2-run-prov', '어느 회사 모델로 열까요');
  const modelSel = sel('v2-run-model', '모델을 고릅니다');
  const effortSel = sel('v2-run-effort', '추론강도를 고릅니다');
  const root = el('div', { class: 'v2-run' }, nodeSel, provSel, modelSel, effortSel);
  nodeSel.hidden = true;   // 노드가 하나라도 있을 때만 그린다(paint 에서 결정)
  provSel.replaceChildren(el('option', { value: '' }, '불러오는 중…'));
  provSel.disabled = true; modelSel.hidden = true; effortSel.hidden = true;

  const cur = (): RunHarness | null => findHarness(harnesses, harnessKey);
  const nodeOf = (id: string): RunNode | null => nodes.find((n) => n.id === id) || null;
  // 이 노드가 띄울 수 있는 하네스 키 집합(없거나 미보고면 null = 제한 없음 — 클래식 폼과 같은 규칙).
  const nodeAllow = (): Set<string> | null => {
    const n = nodeKey ? nodeOf(nodeKey) : null;
    return n && Array.isArray(n.harnesses) && n.harnesses.length ? new Set(n.harnesses) : null;
  };
  const AXES = ['--model', '--effort'];
  const boxOf = (name: string): HTMLSelectElement => (name === '--model' ? modelSel : effortSel);
  // 그 하네스가 안 받는 축(예: OpenCode 의 모델)은 **값을 안 낸다** — 서버가 조용히 버릴 값을 넘기면
  //  화면은 고른 대로 됐다고 믿게 된다. 대신 기억(savedFlags)에는 남겨 둬서 그 하네스로 돌아오면 되살아난다.
  const visVal = (name: string): string => (boxOf(name).hidden ? '' : boxOf(name).value);

  function paintFlag(box: HTMLSelectElement, name: string, emptyText: string, label: (v: string) => string): void {
    const choices = flagChoices(cur(), name);
    box.hidden = !choices.length;
    if (!choices.length) return;
    const want = box.value || String(savedFlags[name] || '');
    box.replaceChildren(el('option', { value: '' }, emptyText), ...choices.map((c) => el('option', { value: c }, label(c))));
    box.value = choices.includes(want) ? want : '';
  }
  function paintNode(): void {
    // 노드가 없으면 칸 자체를 숨긴다(중앙만 있는 사람에겐 군더더기). 기억한 노드가 지금 온라인이 아니면 중앙으로 되돌린다.
    nodeSel.hidden = !nodes.length;
    if (!nodes.length) { nodeKey = ''; return; }
    if (nodeKey && !(nodeOf(nodeKey)?.online)) nodeKey = '';   // 오프라인·삭제된 노드엔 못 만든다 → 중앙
    nodeSel.replaceChildren(
      el('option', { value: '' }, '중앙 컴퓨터 (기본)'),
      ...nodes.map((n) => {
        const label = '🖥 ' + (n.name || n.id) + (n.shared ? ' (공유)' : '') + (n.online ? '' : ' — 오프라인');
        const o = el('option', { value: n.id }, label) as HTMLOptionElement;
        if (!n.online) o.disabled = true;   // 연결돼 있어야 생성 가능(서버도 409 재검증)
        return o;
      }));
    nodeSel.value = nodeKey;
  }
  function paint(): void {
    paintNode();
    // 셸은 AI 가 아니라 여기 후보가 아니다 — 이 칸은 '무엇에게 시킬까'를 묻는다. 노드를 골랐으면 그 PC 가 띄울 수 있는 것만.
    const allow = nodeAllow();
    const list = harnesses.filter((h) => h.key !== 'shell' && (!allow || allow.has(h.key)));
    provSel.disabled = !list.length;
    if (!list.length) { provSel.replaceChildren(el('option', { value: '' }, '지난번 설정 그대로')); modelSel.hidden = true; effortSel.hidden = true; return; }
    if (!list.some((h) => h.key === harnessKey)) harnessKey = list[0].key;   // 그 노드가 못 띄우는 하네스였으면 첫 후보로
    provSel.replaceChildren(...list.map((h) => el('option', { value: h.key }, providerLabel(h) + ' · ' + h.label)));
    provSel.value = harnessKey;
    paintFlag(modelSel, '--model', '모델 · 지난번 그대로', (v) => v);
    paintFlag(effortSel, '--effort', '추론강도 · 지난번 그대로', effortKo);
  }
  const changed = (): void => {
    for (const n of AXES) if (!boxOf(n).hidden) savedFlags[n] = boxOf(n).value;
    if (remember) saveRunPrefs({ harness: harnessKey, flags: { ...savedFlags }, node: nodeKey });
    opts?.onChange?.(pick());
  };
  nodeSel.addEventListener('change', () => { nodeKey = nodeSel.value; modelSel.value = ''; effortSel.value = ''; paint(); changed(); });
  provSel.addEventListener('change', () => { harnessKey = provSel.value; modelSel.value = ''; effortSel.value = ''; paint(); changed(); });
  modelSel.addEventListener('change', changed);
  effortSel.addEventListener('change', changed);

  const pick = (): RunPick => {
    const flags: Record<string, string> = {};
    for (const n of AXES) { const v = visVal(n); if (v) flags[n] = v; }
    return { harness: harnessKey, flags, node: nodeKey };
  };

  void loadConfig().then((c) => { harnesses = c.harnesses; nodes = c.nodes; paint(); });

  return {
    el: root,
    value: pick,
    disable(on: boolean) { nodeSel.disabled = on || !nodes.length; provSel.disabled = on || !harnesses.length; modelSel.disabled = on; effortSel.disabled = on; },
  };
}
