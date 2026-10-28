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

/** ③ 「세션 위젯으로 보기」 의 **시험 세션** 이름 — «"이름" 앱 시험»(원준 2026-10-15 «수정을 위한 AI 세션이 아니어야 · 회의록 위젯을 가지고 세션과 상호작용 ·
 *  다른 사이드바나 이런 곳에 노출하지는 말고»). 사람이 지은 이름으로 박혀(AI 가 못 덮는다) 이 꼴이 곧 표식이다 — 목록 어디에도 세우지 않는다(isTrySession). */
export const TRY_SESSION_RE = /^"(.+)" 앱 시험$/;
export function trySessionLabel(name: string | null | undefined): string {
  const n = String(name || '').replace(/[\t\n\r"]/g, ' ').trim().slice(0, 40);
  return `"${n || '앱'}" 앱 시험`;
}
/** 앱빌더의 시험 세션인가 — 셸의 세션 목록(사이드바 · 홈 · 서랍 · 대시보드)에서 뺀다. 앱빌딩 세션도 아니다. */
export function isTrySession(label: string | null | undefined): boolean {
  return TRY_SESSION_RE.test(String(label || '').trim());
}

/** 시험 세션의 **대화 제목**(첫 사람 말 = 앱빌더가 보낸 첫 지시 lib/studio-flow tryBrief 의 머리)인가 — 박스가 사라져 기록만 남은 줄은 이름(name)이
 *  사람이 지은 이름이 아니라 첫 말에서 지은 이름이라(v6/session-log-store mapSessionRow) 이 머리로 알아본다(격리 리뷰). tryBrief 를 바꾸면 여기도. */
export const TRY_TITLE_RE = /^이 세션은 「.+」 앱\(app_id [^)\s]+\)을 시험해 보는 세션이야/;
export function isTrySessionTitle(title: string | null | undefined): boolean {
  return TRY_TITLE_RE.test(String(title || '').trim());
}
/** 목록의 한 줄이 시험 세션인가 — 박스 줄(label = 사람이 지은 이름) · 기록 줄(name · title) · 접힌 줄(logTitle) · 날 줄(raw.title) 어느 꼴이든.
 *  셸 · 세션 이력 · 대시보드 · 클래식 탭이 모두 이 한 판정으로 거른다(«다른 사이드바나 이런 곳에 노출하지는 말고»). */
export function isTrySessionRow(r: { label?: unknown; name?: unknown; title?: unknown; logTitle?: unknown; raw?: { title?: unknown } | null } | null | undefined): boolean {
  if (!r) return false;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return isTrySession(str(r.label)) || isTrySession(str(r.name)) || isTrySessionTitle(str(r.title)) || isTrySessionTitle(str(r.logTitle)) || isTrySessionTitle(str(r.raw && r.raw.title));
}
/** 목록 줄 가운데 이 앱의 시험 세션 — 이름(«"이름" 앱 시험»)과 앱빌더 프로젝트가 맞는 첫 줄의 박스 id. 기록을 잃었어도(다른 컴퓨터 · 붙이기 실패 ·
 *  띄우는 도중 떠남) 같은 세션을 다시 쓰게 — 숨긴 세션이라 사람은 못 찾는다(격리 리뷰 #1). 프로젝트를 모르는 줄은 이름만으로 맞춘다. 없으면 빈 글. */
export function findTrySession(rows: ReadonlyArray<{ id?: unknown; label?: unknown; projectId?: unknown; project_id?: unknown } | null | undefined>, label: string, projectId: number): string {
  const want = String(label || '').trim();
  if (!want || !isTrySession(want)) return '';
  for (const r of rows) {
    if (!r || typeof r.id !== 'string' || !r.id) continue;
    const x = r as { owned?: unknown; trashedAt?: unknown; trashed_at?: unknown };
    if (x.owned === false || x.trashedAt || x.trashed_at) continue;   // 남의 세션(붙이기가 막힌다) · 치운 세션(되살리지 않는다)은 건너뛴다
    if (String(r.label || '').trim() !== want) continue;
    const pid = Number(r.projectId ?? r.project_id ?? 0) || 0;
    if (pid && projectId && pid !== projectId) continue;
    return r.id;
  }
  return '';
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
  if (isTrySession(label)) return false;   // 앱빌더 프로젝트에 살지만 만드는 세션이 아니다 — 시험 세션
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

export type BuilderView = 'list' | 'new' | 'resume' | 'app' | 'spec';
export interface BuilderWhere { view: BuilderView; id: string; how: 'edit' | 'copy' }
/** 주소 뒤 칸을 읽는다 — 모르는 꼴은 목록. 목록의 id 는 고른 카드(?sel= — 앱 id, 만들던 앱이면 «draft:<세션>»). */
export function parseBuilderRoute(segs: readonly string[], params?: { get(k: string): string | null } | null): BuilderWhere {
  //  틀린 %-꼴은 그대로 둔다 — 사이드바가 그리기마다 이 주소를 읽는다(parseBuilderHash). 여기서 던지면 사이드바 · 셸의 결이 통째로 멈춘다.
  const dec = (x: string): string => { try { return decodeURIComponent(x); } catch (_) { return x; } };
  const s1 = String(segs[1] || ''), s2 = segs[2] ? dec(String(segs[2])) : '';
  const how = params && params.get('how') === 'copy' ? 'copy' : 'edit';
  if (s1 === 'new') return { view: 'new', id: '', how };
  if (s1 === 's' && s2) return { view: 'resume', id: s2, how };
  if (s1 === 'app' && s2) return { view: 'app', id: s2, how };
  if (s1 === 'spec' && s2) return { view: 'spec', id: s2, how };   // #4632 앱 「개발 정보」(코드 기준 명세)
  return { view: 'list', id: s1 ? '' : String((params && params.get('sel')) || '').trim(), how };
}
/** 주소 한 줄(#/builder/…?…)을 읽는다 — 앱빌더 주소가 아니면 null. 사이드바가 지금 탭의 주소로 켜진 줄을 정할 때 쓴다. */
export function parseBuilderHash(hash: string | null | undefined): BuilderWhere | null {
  const h = String(hash || '').replace(/^#\/?/, '');
  const q = h.indexOf('?');
  const segs = (q >= 0 ? h.slice(0, q) : h).split('/').filter(Boolean);
  if (segs[0] !== 'builder') return null;
  return parseBuilderRoute(segs, new URLSearchParams(q >= 0 ? h.slice(q + 1) : ''));
}
/** 앱빌더 안의 주소를 짓는다. */
export function builderRoute(view: BuilderView, id = '', how: 'edit' | 'copy' = 'edit'): string {
  if (view === 'new') return '#/builder/new';
  if (view === 'resume') return '#/builder/s/' + encodeURIComponent(id);
  if (view === 'app') return '#/builder/app/' + encodeURIComponent(id) + (how === 'copy' ? '?how=copy' : '');
  if (view === 'spec') return '#/builder/spec/' + encodeURIComponent(id);
  return id ? '#/builder?sel=' + encodeURIComponent(id) : '#/builder';
}
/** ③ 「세션 위젯으로 보기」 · 「앱 화면으로 보기」 — 만들고 있는 앱을 **실제 화면**으로 써 보는 중(#4632).
 *  그 화면의 주인은 만들고 있는 앱이라 앱빌더 사이드바를 접는다(원준 2026-10-19 «3단계에서 앱 전체화면 보면서 만들 때 … 앱 빌더의 사이드바가 등장하네. 안그렇게 해줘»).
 *  주소에 적는다(#/builder/s/<세션>?see=widget|app) — 사이드바 주인(lib/side-owner)이 주소 하나로 정하고, 새로고침해도 접힌 채 그 화면으로 돌아온다. */
export type BuilderSee = 'widget' | 'app';
export function builderSeeRoute(sid: string, see: BuilderSee): string { return builderRoute('resume', sid) + '?see=' + see; }
/** 이 주소가 ③ 실제 화면을 보는 중인가 — 이어 만드는 주소(#/builder/s/<세션>)에 see=widget|app 이 있을 때만. 그 밖(모르는 값 · 다른 앱빌더 화면 · 다른 앱)은 ''. */
export function builderSeeing(hash: string | null | undefined): BuilderSee | '' {
  const h = String(hash || '').replace(/^#\/?/, '');
  const q = h.indexOf('?');
  const segs = (q >= 0 ? h.slice(0, q) : h).split('/').filter(Boolean);
  if (segs[0] !== 'builder' || segs[1] !== 's' || !segs[2]) return '';
  const v = new URLSearchParams(q >= 0 ? h.slice(q + 1) : '').get('see');
  return v === 'widget' || v === 'app' ? v : '';
}
/** 앱빌더 사이드바에서 켜질 줄 — 「모든 앱」('all') · 「새 앱 만들기」('new') · 만들던 앱 하나(«draft:<세션>») · 앱 하나(«app:<앱>»).
 *  만들던 앱을 이어 만드는 화면이면 그 만들던 앱이, 있는 앱을 고치는(사본 포함) 화면이면 그 앱이 켜진다. 목록에서 고른 카드도 같은 줄을 켠다. */
export function builderSideKey(where: BuilderWhere): string {
  if (where.view === 'new') return 'new';
  if (where.view === 'resume') return 'draft:' + where.id;
  if (where.view === 'app' || where.view === 'spec') return 'app:' + where.id;
  if (!where.id) return 'all';
  return where.id.startsWith('draft:') ? where.id : 'app:' + where.id;
}
/** 탭 이름 — 목록이면 「앱빌더」, 만드는 중이면 「앱빌더 · 새 앱」 처럼. */
export function builderTabTitle(where: BuilderWhere): string {
  if (where.view === 'new') return '앱빌더 · 새 앱';
  if (where.view === 'resume') return '앱빌더 · 이어서';
  if (where.view === 'app') return where.how === 'copy' ? '앱빌더 · 사본' : '앱빌더 · 고치기';
  if (where.view === 'spec') return '앱빌더 · 개발 정보';
  return '앱빌더';
}
/** 만들던 앱 한 줄의 상태 글 — 앱이 아직 없으면 ② 카드(첫 판을 만드는 중이면 ③ 만드는 중), 있으면 그 단계. 다섯 단계(studio-flow STAGES). */
export function draftStageText(stage: string, hasApp: boolean, done: boolean, fixing = false): string {
  if (done) return '다 만든 앱 · 이어서 고치기';
  if (hasApp && fixing) return '③ AI가 수정하고 있어요';   // 「수정하기」 를 보내 두었다(기록 fixing) — 줄만 봐도 다시 누를 일이 아님을 안다
  if (!hasApp) return stage === 'draft' ? '③ 시안 만드는 중' : '② 세부 기획 정하기';
  const n: Record<string, string> = { draft: '③ 시안 확인 · 수정', fix: '③ 시안 확인 · 수정', check: '④ 확인', put: '⑤ 넣기' };
  return n[stage] || '③ 시안 확인 · 수정';
}

/** 사이드바 한 줄에 들어가는 짧은 단계 — 「③ 시안」 처럼. 긴 글(draftStageText)은 줄의 툴팁과 가운데 카드가 쓴다. */
export function draftStageShort(stage: string, hasApp: boolean, done: boolean, fixing = false): string {
  if (done) return '다 만듦';
  if (hasApp && fixing) return '③ 수정 중';
  if (!hasApp) return stage === 'draft' ? '③ 시안' : '② 기획';
  const n: Record<string, string> = { check: '④ 확인', put: '⑤ 넣기' };
  return n[stage] || '③ 시안';
}

/** 이 세션이 앱빌더에서 **새 앱을 만드는** 세션인가 — 이름 «"이름" 앱 제작» · 「새 앱 제작」 · 옛 「앱 만들기 · 」, 또는 그 밖의 이름이어도
 *  앱빌더 프로젝트 소속(AI 가 이름을 덮은 옛 세션 — 「회의록 기획카드」). 「… 앱 고치기」(있는 앱 고치기 · 사본)는 아니다 — 쓰던 앱을 고치는 중이다.
 *  보통 AI 세션(앱빌더 밖)이 저장한 앱도 아니다: 그 앱은 만든 대로 다 된 앱이다(서버는 어느 세션이 첫 저장을 해도 build_session 을 적는다). */
export function isBuildingSession(label: string | null | undefined, projectName: string | null | undefined): boolean {
  const l = String(label || '').trim();
  if (isTrySession(l)) return false;   // 시험 세션은 만드는 세션이 아니다(같은 앱빌더 프로젝트에 산다)
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
