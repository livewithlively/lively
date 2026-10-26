// lib/studio-ai.ts — 앱 만들기 세션을 **어느 AI · 어느 모델 · 어떤 생각 깊이**로 여나(#4632, 원준 2026-10-26).
//  화면(web/v2/app-studio.ts)이 실행 컴퓨터를 고른 뒤 여기 함수로 AI 를 정한다. 사람은 이 셋을 고르지 않는다(원준 2026-10-14).
//  시험: scripts/studio-ai.test.mjs
//
//  ── 왜 하네스별 표인가 ──
//  종전엔 claude 로 못 박혀 있었다(opus · 높음). 그래서 Codex 나 Antigravity 하나만 연결한 사람은 로그인 안 된 claude 로
//   세션이 떠서 앱 만들기가 시작조차 안 됐다(원준 2026-10-26 «코덱스만 연결되어있거나 다른거 하나만 연결되어있는 사람도 그 비슷한 정도로»).
//  그래서 하네스마다 «claude opus · 높음» 에 맞먹는 값을 둔다 — 그 하네스의 가장 센 최신 모델 + 높음.
//   · claude      opus                  · high
//   · codex       gpt-5.6-sol           · high  (새 세션 기본이자 무인 기본 모델 — 그 위 강도는 xhigh/max/ultra 지만 claude 의 high 에 맞춘다)
//   · antigravity gemini-3.8-flash-high · high  (이 하네스는 모델 이름에도 강도가 박혀 있다 — 둘 다 high)
//   · grok        grok-4.6              · high  (모델이 하나뿐)
//  opencode 는 무료 모델 묶음뿐이라 앱 만들기에 맞먹는 값이 없다 — 표에 넣지 않는다(고르지 않는다).
//
//  ── 어느 AI 로 여나 — 순서가 전부다 ──
//  ① 그 컴퓨터가 띄울 수 있고 **로그인이 확인된** AI — 둘 이상이면 표 순서(claude 먼저: claude 를 쓰던 사람은 종전과 같다)
//  ② 없으면 **로그인 안 됐다고 확인되지 않은**(모름) AI — 자격이 파일로 안 남는 Antigravity 가 여기서 잡힌다
//  ③ 그래도 없으면 claude(종전 기본 — 거기서 로그인 안내를 받는다), claude 를 못 띄우는 컴퓨터면 띄울 수 있는 첫 AI
//  «모름» 을 «안 됨» 으로 접지 않는다(profiles.ts aiAccountStatus 와 같은 교리 — 모르면서 막으면 로그인한 사람을 막는다).

export interface StudioAiRun { model: string; effort: string }
/** 표 순서 = 동률일 때 고르는 순서. */
export const STUDIO_AI: ReadonlyArray<{ key: string } & StudioAiRun> = [
  { key: 'claude', model: 'opus', effort: 'high' },
  { key: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
  { key: 'antigravity', model: 'gemini-3.8-flash-high', effort: 'high' },
  { key: 'grok', model: 'grok-4.6', effort: 'high' },
];
export const studioAiRun = (key: string): StudioAiRun | null => {
  const r = STUDIO_AI.find((x) => x.key === key);
  return r ? { model: r.model, effort: r.effort } : null;
};

/**
 * 어느 AI 로 열지 정한다(순수).
 *  catalog  — 서버 카탈로그에 있는 하네스 key(없으면 고르지 않는다 — 옛 게이트웨이)
 *  runnable — 고른 컴퓨터가 띄울 수 있는 하네스. null = 모름(제한 없음)
 *  yes      — 로그인이 확인된 하네스
 *  no       — 로그인 안 됐다고 **확인된** 하네스(모름은 넣지 않는다)
 */
export function pickStudioAi(i: { catalog: readonly string[]; runnable: readonly string[] | null; yes: readonly string[]; no: readonly string[] }): string {
  const cat = new Set(i.catalog), run = i.runnable ? new Set(i.runnable) : null;
  const base = STUDIO_AI.map((x) => x.key).filter((k) => cat.has(k) && (!run || run.has(k)));
  const yes = new Set(i.yes), no = new Set(i.no);
  return base.find((k) => yes.has(k)) || base.find((k) => !no.has(k)) || (base.includes('claude') || !base.length ? 'claude' : base[0]);
}

/**
 * 그 하네스에 넘길 --model · --effort. 카탈로그가 받지 않는 값이면 그 축은 넘기지 않는다(AI 설정 그대로 — 종전과 같은 규칙).
 *  models  — 그 하네스의 --model 선택지(빈 목록 = 카탈로그를 못 받음 → 표 값을 그대로 넘긴다)
 *  efforts — 그 모델이 받는 강도(effortsByModel 이 있으면 그것, 없으면 --effort 선택지). 빈 목록 = 모름 → 그대로
 */
export function studioAiFlags(key: string, models: readonly string[], efforts: (model: string) => readonly string[]): Record<string, string> {
  const r = studioAiRun(key); if (!r) return {};
  const out: Record<string, string> = {};
  if (!models.length || models.includes(r.model)) out['--model'] = r.model;
  const es = efforts(out['--model'] || '');
  if (!es.length || es.includes(r.effort)) out['--effort'] = r.effort;
  return out;
}
