// 앱 공개 상태 · 만든 사람 · 책임자 (#4667, 앱 v2-15) — **순수 판정**. DB 는 org/store/apps.ts, 노출은 capabilities/apps.ts.
//
//  왜 — 종전엔 app_save 가 곧 «워크스페이스 모두에게» 였다. 앱 만들기 화면(#4592 · #4632)의 「나만」 과 「공개하기」 는 그 위에서
//   그릴 수 없었고, 누가 만들었나 · 어느 세션이 만들었나 · 무엇의 사본인가는 매니페스트 `studio` 칸(앱 코드 — 아무나 고쳐 저장할 수
//   있다)과 브라우저 localStorage 에만 있었다. 설계: 지식 app-framework-v2-general-web-design §3-F · §12 ⑦ · 결정(상민 2026-10-14).
//
//  ── 판 포인터 둘 ──────────────────────────────────────────────────────────────
//   · 설치된 상태(org_app 행 + 화면 자산 = current_version_no) = **고친 사람이 보는 판**. app_save · app_revert 가 늘 여기에 깐다.
//   · 공개 판(published_version_no) = **나머지 모두가 보는 판**. 「공개하기」(app_publish)가 설치된 상태로 옮긴다.
//   둘이 같으면(draft_by 가 비었으면) 모두가 설치된 상태를 본다 — 대부분의 앱이 늘 이 상태라 추가 조회가 없다.
//   다르면(draft_by = 그 초안을 만든 사람) 그 사람만 설치된 상태를, 나머지는 판 행(org_app_version)의 공개 판을 본다.
//   ★ 공개 판은 판 행에 못 박혀 있어야 한다 — 초안이 생기기 **전에** 지금 상태를 판으로 떠 두고 가리킨다(capabilities/apps.ts pinPublished).
//     보관 정리(app-versions.ts)는 공개 판을 지우지 않는다.
//
//  ── 나만 보는 앱(visibility 'private') ────────────────────────────────────────
//   app_save 로 새로 생기는 앱과 앱 만들기 「만들기 시작」 이 예약한 앱은 나만 보는 앱으로 시작한다. 책임자(와 관리자)만 열고 고치고,
//   목록(앱 찾기 · 붙이기 고르기)에는 책임자에게만 선다. 「공개하기」 한 번이면 모두의 앱이 된다. 관리자 설치(org_app_install)·빌트인은
//   처음부터 공개다(칸 기본값 'public' — 이 칸 이전의 앱도 전부 공개로 남는다).
//
//  ── 만든 사람 · 책임자 ────────────────────────────────────────────────────────
//   made_by = 처음 만든 사람(서버가 만들 때 한 번 찍고 바꾸지 않는다). owner_member = 지금 책임자(처음엔 만든 사람).
//   만든 사람이 떠나면 책임자만 «관리자»(NULL)로 바뀌고 관리자 모두에게 알린다(member-deactivation.ts) — 기록은 남는다.
//   v2-12 앱 자체 주체의 책임자 · 자동화 실패 알림 대상이 이 칸이다(설계 §6 · §12 ⑤-4).

/** 판정에 쓰는 사람 — 토큰의 구성원 id 와 scope. */
export interface Viewer { userId: string; scopes?: readonly string[] }

/** 판정에 쓰는 앱의 칸들(org_app 의 부분). */
export interface AppVisState {
  visibility: "private" | "public";
  owner_member: string | null;
  draft_by: string | null;
  published_version_no: number | null;
  content_hash?: string | null;
}

export const isAdminViewer = (who: Viewer): boolean => (who.scopes ?? []).includes("admin");

/** 이 사람이 이 앱의 책임자인가. 책임자 칸이 비었으면(만든 사람이 떠났거나 처음부터 없던 앱) 관리자가 책임자다. */
export function isAppOwner(app: Pick<AppVisState, "owner_member">, who: Viewer): boolean {
  if (!who.userId) return false;
  if (app.owner_member) return app.owner_member === who.userId;
  return isAdminViewer(who);
}

/**
 * 이 앱을 직접 열 수 있나(상세 · 화면 · 내려받기 · 동의 · 붙이기 · 도구 다리 · 데이터). 공개 앱은 누구나,
 *  나만 보는 앱은 책임자와 관리자(관리 화면에서 보고 지울 수 있어야 한다). 못 보면 «없는 앱» 과 같이 다룬다(404).
 */
export function canSeeApp(app: Pick<AppVisState, "visibility" | "owner_member">, who: Viewer): boolean {
  return app.visibility !== "private" || isAppOwner(app, who) || isAdminViewer(who);
}

/** 목록(앱 찾기 · 붙이기 고르기 · 앱빌더)에 서나 — 나만 보는 앱은 책임자에게만. 관리자에게도 남이 만들고 있는 앱은 목록에 서지 않는다. */
export function listsAppFor(app: Pick<AppVisState, "visibility" | "owner_member">, who: Viewer): boolean {
  return app.visibility !== "private" || isAppOwner(app, who);
}

/** 아직 첫 판이 없는 예약 앱인가(「만들기 시작」 이 만든 빈 앱 — AI 의 첫 app_save 가 채운다). 목록·붙이기에 서지 않는다. */
export function isEmptyDraftApp(app: { content_hash?: string | null }): boolean {
  return app.content_hash == null;
}

/**
 * 이 사람에게 보일 판 — 'none'(못 본다) · 'installed'(설치된 상태 = 고친 사람의 판) · 'published'(판 행의 공개 판).
 *  공개 앱에 초안이 있을 때만 'published' 가 나온다(초안을 만든 사람은 'installed').
 *  공개 판 번호가 없는데 초안 표식이 서 있는 상태는 불변식 위반이다 — 앱이 아무에게도 안 보이는 것보다 설치된 상태를 보이는 쪽을 고른다.
 */
export type AppView = "none" | "installed" | "published";
export function appViewFor(app: AppVisState, who: Viewer): AppView {
  if (!canSeeApp(app, who)) return "none";
  if (app.visibility === "private") return "installed";
  if (!app.draft_by || app.published_version_no == null) return "installed";
  return app.draft_by === who.userId ? "installed" : "published";
}

/**
 * 공개 앱에 설치를 마친 뒤의 초안 표식(순수) — 설치된 내용이 공개 판과 같으면 초안 없음(null), 다르면 그 일을 한 사람의 초안.
 *  나만 보는 앱엔 초안 표식이 없다(앱 전체가 책임자의 것이다).
 */
export function draftByAfterInstall(visibility: "private" | "public", installedHash: string | null, publishedHash: string | null, actor: string): string | null {
  if (visibility === "private") return null;
  if (installedHash != null && installedHash === publishedHash) return null;
  return actor || null;
}

/**
 * 「공개하기」 를 할 수 있나 — null = 된다 · 문자열 = 안 되는 까닭(사람에게 그대로 보인다).
 *  나만 보는 앱: 책임자 · 관리자. 공개 앱의 초안: 그 초안을 만든 사람 · 책임자 · 관리자 — 다른 구성원은 그 초안을 보지 못한 채 모두에게 내보내게 된다.
 *  editDenial(이 사람이 이 앱을 고칠 수 있나)이 막혀 있으면 공개도 막는다(고칠 수 없는 사람이 남의 초안을 내보내지 않게).
 */
export function publishDenial(app: AppVisState & { title?: string; id?: string }, who: Viewer, editDenial: string | null): string | null {
  const name = `「${app.title || app.id || "앱"}」`;
  if (app.visibility === "private") {
    if (isAppOwner(app, who) || isAdminViewer(who)) return null;
    return `${name} 은(는) 다른 사람이 만들고 있는 앱이라 공개할 수 없습니다`;
  }
  if (!app.draft_by) return null;   // 이미 공개 판 그대로 — 할 일 없음(호출부가 changed:false 로 답한다)
  if (editDenial && !isAdminViewer(who)) return editDenial;
  if (app.draft_by === who.userId || isAppOwner(app, who) || isAdminViewer(who)) return null;
  return `${name} 의 지금 초안은 ${app.draft_by} 님이 고친 것이라 그 사람이나 책임자 · 관리자만 공개할 수 있습니다`;
}

/** 「나만 보기로 되돌리기」(공개 취소)를 할 수 있나 — 책임자 · 관리자만. 공개 앱을 쓰던 다른 사람은 그 순간부터 못 연다. */
export function unpublishDenial(app: Pick<AppVisState, "owner_member"> & { title?: string; id?: string }, who: Viewer): string | null {
  if (isAppOwner(app, who) || isAdminViewer(who)) return null;
  return `「${app.title || app.id || "앱"}」 의 공개를 거둘 수 있는 사람은 책임자와 관리자입니다`;
}

// ── 데이터 표 — 초안이 공개 판의 표를 지우지 않게 ─────────────────────────────────
//  표는 판마다 따로가 아니라 앱에 한 벌이다(app.<앱>__<표>). 초안이 매니페스트에서 표를 빼도 공개 판은 아직 그 표를 쓴다 — 그래서
//  초안 설치는 공개 판이 선언한 표를 지우지 않고(installLoadedApp keepTables), 「공개하기」 가 옛 공개 판에만 있던 표를 그때 정리한다.

/** 매니페스트의 data.tables 이름들. 모양이 어긋나도 던지지 않는다(저장된 매니페스트를 읽는 자리). */
export function declaredTableNames(manifest: unknown): string[] {
  const t = (manifest as { data?: { tables?: Array<{ name?: unknown }> } } | null)?.data?.tables;
  return Array.isArray(t) ? t.map((x) => String(x?.name ?? "")).filter(Boolean) : [];
}

/** 「공개하기」 때 정리할 표 — 옛 공개 판에 있었는데 새로 공개하는 판(= 설치된 판)에 없는 것. */
export function tablesGoneAtPublish(oldPublishedManifest: unknown, newManifest: unknown): string[] {
  const next = new Set(declaredTableNames(newManifest));
  return declaredTableNames(oldPublishedManifest).filter((t) => !next.has(t));
}

/** store_* 가 받는 표 — 설치된 판과 공개 판(초안이 있을 때) 어느 쪽이든 선언한 것. 둘 다 물리 표가 살아 있다(위 규칙). */
export function tablesUsableNow(installedManifest: unknown, publishedManifest: unknown | null): string[] {
  const out = declaredTableNames(installedManifest);
  for (const t of publishedManifest ? declaredTableNames(publishedManifest) : []) if (!out.includes(t)) out.push(t);
  return out;
}

// ── 예약 앱 id ────────────────────────────────────────────────────────────────
//  「만들기 시작」 이 AI 보다 먼저 앱을 만든다 — id 는 서버가 짓는다(매니페스트 규칙 /^[a-z0-9][a-z0-9-]{1,31}$/).
//  이름에 영문·숫자가 있으면 그것을 앞에(사람이 DB·도구 인자에서 알아보게), 없으면 «app». 뒤에 6자로 겹침을 피한다.
export function draftAppIdFrom(title: string, rand6: string): string {
  const slug = String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20).replace(/-+$/g, "");
  const base = /^[a-z0-9]/.test(slug) && slug.length >= 2 ? slug : "app";
  const tail = String(rand6 || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "000000";
  return `${base}-${tail}`.slice(0, 32);
}
