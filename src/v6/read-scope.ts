// 앱 맥락 범위(#5100 앱 v2-43) — 앱 토큰 요청이 읽을 수 있는 지식·자료를 좁히는 «읽기 범위» 를 요청 단위로 싣는다.
//
//  왜 — 앱 토큰은 도구 허용 목록(apps/principal.ts requireAppTool)으로만 좁혀졌다. knowledge_search 를 허용하면 실행 멤버가 보는
//   지식이 전부 나와서, 질의응답 앱의 에이전트가 같은 워크스페이스의 «앱을 만드는 과정의 설계 문서» 를 답의 근거로 끌어왔다(이슈 #1573).
//   앱이 매니페스트 `context` 로 읽을 범위를 선언하면(apps/app-context.ts), 그 앱 토큰의 읽기는 공개범위 ∩ 이 범위가 된다.
//
//  ── 어디에 거나 ──
//   공개범위 술어의 단일 진입점(knowledgeVisWhere · canSeeKnowledge · sourceVisWhere)에 AND 로 건다. 그래서 그 술어를 지나는 표면
//   (목록·grep·하이브리드 두 채널·유사·상세·링크·트리·카테고리 집계·db_query self 의 행 보안)이 따로 고치지 않아도 같이 좁혀진다.
//   술어를 손으로 옮겨 적은 사본이 공개범위를 세 번 흘린 저장소라(knowledge-common.ts 머리말), 범위도 사본을 만들지 않는다.
//
//  ── 왜 인자가 아니라 요청 맥락(AsyncLocalStorage)인가 ──
//   범위는 뷰어와 같은 «누가 보나» 의 일부인데, 뷰어 문자열(Viewer)은 수십 곳에서 SQL 파라미터로 바로 쓰여 모양을 바꿀 수 없다.
//   대신 어댑터 세 곳(MCP instrument · REST capability 어댑터 · 앱 화면 다리 runAppTool)이 앱 토큰 요청을 이 저장소로 감싼다
//   (apps/app-context.ts runWithAppReadScope). 테넌트 고정(org/tenant-context.ts)과 같은 방식이다.
//
//  ── 언제 걸리나(규칙 하나) ──
//   범위는 **뷰어가 구성원 문자열일 때만** 건다 — 사람 읽기(ctx.viewer)와 같은 배선을 탄다. null(특권 — 내부 시스템 경로)과
//   undefined(미배선)에는 걸지 않는다: 앱 요청 안에서 도는 내부 판정(저장 전 이름 충돌 · 시드 · 백그라운드 정비)이 범위 때문에 틀리지 않게.
//   공개범위가 배선되지 않은 표면은 범위도 배선되지 않는다 — 고칠 자리가 한 곳(그 표면에 뷰어를 넘기기)이다.
//   긴급 열람(break-glass)은 범위를 넓히지 않는다 — 긴급 열람은 사람의 권한을 여는 문이고, 범위는 앱이 스스로 좁힌 선언이다.
//
//  ── 범위 밖 = 닫힘 ──
//   범위를 선언한 앱이 적지 않은 종류는 하나도 못 읽는다(빈 배열 = FALSE). 범위를 선언하지 않은 앱은 저장소가 비어 종전과 같다(무회귀).
import { AsyncLocalStorage } from "node:async_hooks";

/** 앱 토큰 요청이 읽을 수 있는 범위. 빈 배열 = 그 종류는 하나도 못 읽는다(닫힘). */
export interface ReadScope {
  appId: string;
  /**
   * 지식은 이 카테고리 가운데 하나에 (거절이 아닌) 연결이 있어야 읽힌다 — knowledge_list 의 카테고리 필터와 같은 기준(state<>'rejected').
   *  «확인됨만» 으로 좁히지 않은 까닭(격리 리뷰 N5): 사람이 저장한 지식 · 미러(target_category)는 처음부터 confirmed 이고, 분류기도 확신 0.8 이상이면
   *  confirmed 로 넣는다(knowledge-store proposeKnowledgeCategory) — proposed 는 미분류였던 지식에 붙은 낮은 확신의 제안뿐이다. 그것만 빼면
   *  막는 폭은 작고, 목록 · 사이드바 · 집계와 «그 카테고리에 든 지식» 의 뜻이 갈라진다.
   */
  knowledgeCategoryIds: readonly number[];
  /** 자료는 종류(source.kind)가 이 가운데 하나여야 읽힌다. */
  sourceKinds: readonly string[];
}

//  범위는 늦게 푼다 — 앱 토큰의 호출 대부분(store_* · app_* 등)은 지식·자료를 안 읽으므로, 술어가 처음 물을 때 한 번만 푼다(요청 안에서 기억).
interface Slot { resolve: () => Promise<ReadScope | null>; memo?: Promise<ReadScope | null> }
const store = new AsyncLocalStorage<Slot | null>();

/** fn 을 이 범위 안에서 돌린다 — 어댑터(apps/app-context.ts runWithAppReadScope)만 부른다. resolve 는 처음 물을 때 한 번 돈다. */
export function withReadScope<T>(resolve: () => Promise<ReadScope | null>, fn: () => Promise<T>): Promise<T> {
  return store.run({ resolve }, fn);
}

/**
 * fn 을 범위 **밖**에서 돌린다. 쓰는 자리는 둘뿐이다 — ⓐ «범위 밖이라 거절» 과 «없음» 을 가르는 판정(범위 없이 보였나만 본다 · 내용을 돌려주지 않는다)
 *  ⓑ 1판 범위가 다루지 않는 파일 권한(project_files · workspace_files — 그 권한 자체가 경계다, #5100 결정 ②: 폴더는 다음 판).
 *  여기서 읽은 내용을 앱에 그대로 돌려주는 새 자리를 만들지 마라 — 그게 곧 범위 우회다.
 */
export function outsideReadScope<T>(fn: () => Promise<T>): Promise<T> {
  return store.run(null, fn);
}

/** 지금 요청의 읽기 범위 — 앱 토큰 요청이 아니거나 앱이 범위를 선언하지 않았으면 null. 풀다가 실패하면 던진다(읽기도 실패 — 닫는 쪽). */
export function currentReadScope(): Promise<ReadScope | null> {
  const slot = store.getStore();
  if (!slot) return Promise.resolve(null);
  slot.memo ??= slot.resolve();
  return slot.memo;
}

/** 뷰어에게 범위를 걸어야 하나 — 구성원 문자열 뷰어만(머리말 «언제 걸리나»). */
export async function readScopeFor(viewer: string | null | undefined): Promise<ReadScope | null> {
  return typeof viewer === "string" ? await currentReadScope() : null;
}

/**
 * 지식 행(별칭 a)이 이 카테고리들 가운데 하나에 들었나 — 앱 범위와 검색의 category 인자가 같은 식을 쓴다.
 *  기준은 knowledge_list 의 카테고리 필터와 같다(거절 아닌 연결 — knowledge-store knowledgeListFilter). 빈 목록이면 FALSE.
 *  ⚠ 파라미터를 여기서 push 한다(knowledgeVisWhere 와 같은 규약) — 반환된 문자열은 그 params 를 쓰는 쿼리에만 써라.
 */
export function knowledgeInCategoriesSql(ids: readonly number[], params: unknown[], a = "k"): string {
  const clean = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!clean.length) return "FALSE";
  params.push(clean);
  return `EXISTS(SELECT 1 FROM knowledge_category kc_scope WHERE kc_scope.name=${a}.name AND kc_scope.state<>'rejected'
            AND kc_scope.category_id = ANY($${params.length}::int[]))`;
}

/** 자료 행(별칭 s)의 종류가 이 가운데 하나인가. 빈 목록이면 FALSE. 파라미터 규약은 위와 같다. */
export function sourceKindsSql(kinds: readonly string[], params: unknown[], a = "s"): string {
  const clean = [...new Set(kinds.map(String).filter(Boolean))];
  if (!clean.length) return "FALSE";
  params.push(clean);
  return `${a}.kind = ANY($${params.length}::text[])`;
}

/**
 * 검색 후보를 좁힐 카테고리 — 부른 쪽이 고른 카테고리(category 인자)와 앱 범위의 교집합. null = 좁히지 않는다.
 *  공개범위 술어(최종 SELECT)만으로는 하이브리드 검색의 후보(채널마다 상위 N)가 범위 밖 문서로 채워져 결과가 비는 일을 못 막는다 —
 *  그래서 검색은 후보를 고르는 단계부터 이 제한을 건다(knowledge-search.ts).
 */
export async function knowledgeCategoryRestriction(viewer: string | null | undefined, asked?: readonly number[] | null): Promise<readonly number[] | null> {
  const scope = await readScopeFor(viewer);
  if (!scope) return asked ?? null;
  if (!asked) return scope.knowledgeCategoryIds;
  const allow = new Set(scope.knowledgeCategoryIds);
  return asked.filter((id) => allow.has(id));
}
