// lib/builder-flow.ts — 「앱빌더」(#4632, 원준 2026-10-14)의 **순수** 규칙. 화면(v2/builder.ts · side.ts · main.ts · apps.ts)이 같은 자로 잰다.
//  · 앱빌더 프로젝트: 앱빌더가 여는 세션은 전부 이 이름의 프로젝트에 붙는다. 사람에게 프로젝트로 보이지 않고 앱빌더가 그 문이다 —
//    프로젝트 화면으로 가는 어느 길(#/p/<id> · 사이드바 머리줄 · [→])도 앱빌더를 연다.
//  · 앱빌딩 세션: 본질은 AI 세션이지만 사람에게는 「앱빌딩 세션」 — 그 프로젝트의 세션, 또는 이름이 「앱 만들기 · 」 「앱 고치기 · 」 로
//    시작하는 세션(앱빌더가 짓는 이름 · 옛 「앱 만들기」 프로젝트의 것도 이 이름이라 같이 잡힌다). 사이드바에서 다른 그림이고,
//    누르면 세션 화면이 아니라 앱빌더 안 그 앱의 만들기 화면으로 간다.
//  · 주소: #/builder(목록) · #/builder/new(새 앱 ①) · #/builder/s/<세션>(이어서) · #/builder/app/<앱>?how=edit|copy(고치기 · 사본)
//  시험: scripts/builder-flow.test.mjs
export const BUILDER_PROJECT_NAME = '앱빌더';
export const BUILDER_SESSION_PREFIXES: readonly string[] = ['앱 만들기 · ', '앱 고치기 · '];   // 옛 꼴(2026-10-14 이전) — 그대로 잡는다
/** 앱빌더가 짓는 세션 이름 — 사람이 정한 앱 이름을 그대로 못 박는다(원준 2026-10-14 «"<사용자가 정한 앱 이름>" 앱 제작 으로 하드하게»). */
export const BUILDER_SESSION_RE = /^"(.+)" 앱 (제작|고치기)$/;
export const BUILDER_SESSION_UNNAMED = '새 앱 제작';
export function builderSessionLabel(name: string | null | undefined, mode: 'new' | 'copy' | 'edit' = 'new'): string {
  const n = String(name || '').replace(/[\t\n\r"]/g, ' ').trim().slice(0, 40);
  if (mode === 'new') return n ? `"${n}" 앱 제작` : BUILDER_SESSION_UNNAMED;
  return `"${n || '앱'}" 앱 고치기`;
}

/** 이 이름의 프로젝트가 앱빌더 프로젝트인가 — 정확히 「앱빌더」 만. 옛 「앱 만들기」 는 사람이 지은 프로젝트와 겹쳐(#4632 가 그 이름이다) 이름으로 못 가른다. */
export function isBuilderProjectName(name: string | null | undefined): boolean {
  return String(name || '').trim() === BUILDER_PROJECT_NAME;
}
/** 세션 이름이 앱빌더가 지은 꼴인가. */
export function isBuilderSessionLabel(label: string | null | undefined): boolean {
  const l = String(label || '').trim();
  return BUILDER_SESSION_RE.test(l) || l === BUILDER_SESSION_UNNAMED || BUILDER_SESSION_PREFIXES.some((p) => l.startsWith(p));
}
/** 앱빌딩 세션인가 — 이름 꼴이거나 앱빌더 프로젝트 소속이면. 위탁 워커(task 표식)는 부르는 쪽이 먼저 가른다. */
export function isBuilderSession(label: string | null | undefined, projectName: string | null | undefined): boolean {
  return isBuilderSessionLabel(label) || isBuilderProjectName(projectName);
}
/** 세션 이름에서 앱빌더 머리말을 뗀 「무엇을」 — 「앱 만들기 · 회의 안건」 → 「회의 안건」. 머리말이 없으면 그대로. */
export function builderSessionWhat(label: string | null | undefined): string {
  const l = String(label || '').trim();
  const m = BUILDER_SESSION_RE.exec(l); if (m) return m[1].trim();
  if (l === BUILDER_SESSION_UNNAMED) return '';
  const p = BUILDER_SESSION_PREFIXES.find((x) => l.startsWith(x));
  return (p ? l.slice(p.length) : l).trim();
}

export type BuilderView = 'list' | 'new' | 'resume' | 'app';
export interface BuilderWhere { view: BuilderView; id: string; how: 'edit' | 'copy' }
/** 주소 뒤 칸을 읽는다 — 모르는 꼴은 목록. */
export function parseBuilderRoute(segs: readonly string[], params?: { get(k: string): string | null } | null): BuilderWhere {
  const s1 = String(segs[1] || ''), s2 = segs[2] ? decodeURIComponent(String(segs[2])) : '';
  const how = params && params.get('how') === 'copy' ? 'copy' : 'edit';
  if (s1 === 'new') return { view: 'new', id: '', how };
  if (s1 === 's' && s2) return { view: 'resume', id: s2, how };
  if (s1 === 'app' && s2) return { view: 'app', id: s2, how };
  return { view: 'list', id: '', how };
}
/** 앱빌더 안의 주소를 짓는다. */
export function builderRoute(view: BuilderView, id = '', how: 'edit' | 'copy' = 'edit'): string {
  if (view === 'new') return '#/builder/new';
  if (view === 'resume') return '#/builder/s/' + encodeURIComponent(id);
  if (view === 'app') return '#/builder/app/' + encodeURIComponent(id) + (how === 'copy' ? '?how=copy' : '');
  return '#/builder';
}
/** 탭 이름 — 목록이면 「앱빌더」, 만드는 중이면 「앱빌더 · 새 앱」 처럼. */
export function builderTabTitle(where: BuilderWhere): string {
  if (where.view === 'new') return '앱빌더 · 새 앱';
  if (where.view === 'resume') return '앱빌더 · 이어서';
  if (where.view === 'app') return where.how === 'copy' ? '앱빌더 · 사본' : '앱빌더 · 고치기';
  return '앱빌더';
}
/** 만들던 앱 한 줄의 상태 글 — 앱이 아직 없으면 ② 카드(첫 판을 만드는 중이면 ③ 만드는 중), 있으면 그 단계. 다섯 단계(studio-flow STAGES). */
export function draftStageText(stage: string, hasApp: boolean, done: boolean): string {
  if (done) return '다 만든 앱 · 이어서 고치기';
  if (!hasApp) return stage === 'draft' ? '③ 시안 만드는 중' : '② 세부 기획 정하기';
  const n: Record<string, string> = { draft: '③ 시안 확인 · 고치기', fix: '③ 시안 확인 · 고치기', check: '④ 확인', put: '⑤ 넣기' };
  return n[stage] || '③ 시안 확인 · 고치기';
}

/** 이 세션이 앱빌더에서 **새 앱을 만드는** 세션인가 — 이름 «"이름" 앱 제작» · 「새 앱 제작」 · 옛 「앱 만들기 · 」, 또는 그 밖의 이름이어도
 *  앱빌더 프로젝트 소속(AI 가 이름을 덮은 옛 세션 — 「회의록 기획카드」). 「… 앱 고치기」(있는 앱 고치기 · 사본)는 아니다 — 쓰던 앱을 고치는 중이다.
 *  보통 AI 세션(앱빌더 밖)이 저장한 앱도 아니다: 그 앱은 만든 대로 다 된 앱이다(서버는 어느 세션이 첫 저장을 해도 build_session 을 적는다). */
export function isBuildingSession(label: string | null | undefined, projectName: string | null | undefined): boolean {
  const l = String(label || '').trim();
  const m = BUILDER_SESSION_RE.exec(l);
  if (m) return m[2] === '제작';
  if (l === BUILDER_SESSION_UNNAMED || l.startsWith(BUILDER_SESSION_PREFIXES[0])) return true;
  if (l.startsWith(BUILDER_SESSION_PREFIXES[1])) return false;
  return isBuilderProjectName(projectName);
}
/** 아직 다 만들지 않은 앱인가 — 앱 찾기에 앱으로 서지 않고 앱빌더 「만들던 앱」 에만 선다(원준 2026-10-15 «끝까지 안 만들었는데 왜 먼저 앱으로 나와»).
 *  = 나만 보는 앱 · 첫 판이 있다(빈 예약은 따로) · ⑤ 「이대로 넣기」 전 · **앱빌더가 새로 만드는 중**(building — 그 앱의 만들기 세션이 isBuildingSession,
 *  또는 이 브라우저의 새 앱 만들기 기록이 열려 있다. 부르는 쪽이 잰다). 공개한 앱은 고치는 중이어도(초안) 모두가 쓰는 앱이라 그대로 선다.
 *  모르는 공개 범위는 'all' 로 읽는다(서버 apps/visibility.ts 와 같은 쪽). */
export function isAppInProgress(a: { visibility?: unknown; empty?: boolean | null; studio?: { put?: unknown } | null }, building: boolean): boolean {
  if (a.visibility !== 'me' || a.empty) return false;
  if (a.studio && a.studio.put === true) return false;
  return building;
}
/** 앱빌더가 지은 세션 이름 «"이름" 앱 제작 · 고치기» 에 박힌 앱 이름 — 그 꼴이 아니면(옛 머리말 · AI 가 지은 이름 · 「새 앱 제작」) 빈 글. */
export function builderSessionName(label: string | null | undefined): string {
  const m = BUILDER_SESSION_RE.exec(String(label || '').trim());
  return m ? m[1].trim() : '';
}
/** 「만들던 앱」 카드의 이름 — 사람이 정한 앱 이름이 먼저다(원준 2026-10-15 «내가 이름 정해 주지 않았나? 그걸로»).
 *  ① 기록의 이름(①에서 적은 것 · ②에서 고친 것) ② 기획 카드의 이름 ③ 앱빌더가 지은 세션 이름 «"이름" 앱 제작» 의 이름 ④ 첫 판이 있는 앱의 이름
 *  ⑤ 옛 세션 이름에서 머리말을 뗀 것(AI 가 지은 이름이면 그대로) ⑥ 적은 설명의 첫 줄 ⑦ 「이름 없는 앱」. 공백뿐인 값은 없는 것으로 본다. */
export function draftTitle(src: { title?: string | null; cardName?: string | null; label?: string | null; appTitle?: string | null; what?: string | null }): string {
  const t = (s: string | null | undefined): string => String(s || '').trim();
  return t(src.title) || t(src.cardName) || builderSessionName(src.label) || t(src.appTitle)
    || builderSessionWhat(src.label) || t(String(src.what || '').split('\n')[0]) || '이름 없는 앱';
}
