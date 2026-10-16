// 앱 공개 범위 · 만든 사람 · 책임자 — **순수 판정**(#4632 「나만」 · #4667 앱 v2-15). DB 는 org/store/apps.ts, 노출은 capabilities/apps.ts.
//
//  왜 — 종전엔 app_save 가 곧 «워크스페이스 모두에게» 였다. #4632(원준 2026-10-14 «디폴트가 내가 만든 앱은 나만이어야 해»)가 공개 범위
//   'me'(나만) · 'all'(모두)를 세웠고, #4667 이 그 위에 공개 판 · 고친 사람의 초안 · 서버가 기록하는 만든 사람 · 책임자를 얹었다.
//   누가 만들었나 · 어느 세션이 만들었나 · 무엇의 사본인가는 종전엔 매니페스트 `studio` 칸(앱 코드 — 아무나 고쳐 저장할 수 있다)과
//   브라우저 localStorage 에만 있었다 — 이제 서버 칸(made_by · owner_member · build_session · origin_app_id)이 정본이다.
//   설계: 지식 app-framework-v2-general-web-design §3-F · §12 ⑦ · 결정(상민 2026-10-14).
//
//  ── 판 포인터 둘 ──────────────────────────────────────────────────────────────
//   · 설치된 상태(org_app 행 + 화면 자산 = current_version_no) = **고친 사람이 보는 판**. app_save · app_revert 가 늘 여기에 깐다.
//   · 공개 판(published_version_no) = **나머지 모두가 보는 판**. 「공개하기」(app_visibility_set 'all')가 설치된 상태로 옮긴다.
//   둘이 같으면(draft_by 가 비었으면) 모두가 설치된 상태를 본다 — 대부분의 앱이 늘 이 상태라 추가 조회가 없다.
//   다르면(draft_by = 그 초안을 만든 사람) 그 사람만 설치된 상태를, 나머지는 판 행(org_app_version)의 공개 판을 본다.
//   ★ 공개 판은 판 행에 못 박혀 있어야 한다 — 초안이 생기기 **전에** 지금 상태를 판으로 떠 두고 가리킨다(capabilities/apps.ts pinPublished).
//     보관 정리(app-versions.ts)는 공개 판을 지우지 않는다.
//
//  ── 나만 보는 앱(visibility 'me') ─────────────────────────────────────────────
//   app_save 로 새로 생기는 앱과 앱 만들기 「만들기 시작」 이 예약한 앱은 나만 보는 앱으로 시작한다. 책임자(와 관리자)만 열고 고치고,
//   목록(앱 찾기 · 붙이기 고르기)에는 책임자에게만 선다 — 남에게는 없는 앱과 같다(404). 「공개하기」 한 번이면 모두의 앱이 된다.
//   관리자 설치(org_app_install)·빌트인은 처음부터 'all' 이다(칸 기본값 — 이 칸 이전의 앱도 전부 'all' 로 남는다).
//   모르는 값은 'all' 로 읽는다 — 칸이 깨져도 앱이 갑자기 잠기지 않게(잠그는 쪽이 아니라 여는 쪽으로 틀린다, #4632).
//
//  ── 만든 사람 · 책임자 ────────────────────────────────────────────────────────
//   made_by = 처음 만든 사람(서버가 만들 때 한 번 찍고 바꾸지 않는다). owner_member = 지금 책임자(처음엔 만든 사람).
//   ★ 매니페스트 studio.made_by 는 판정에 쓰지 않는다 — 고칠 수 있는 사람이면 누구나 그 칸을 바꿔 저장할 수 있다(#4667 완료 조건).
//   만든 사람이 떠나면 책임자만 «관리자»(NULL)로 바뀌고 관리자 모두에게 알린다(member-deactivation.ts) — 기록은 남는다.
//   v2-12 앱 자체 주체의 책임자 · 자동화 실패 알림 대상이 이 칸이다(설계 §6 · §12 ⑤-4).
import type { AppVisibility } from "../org/store/apps.js";

export type { AppVisibility };
export const APP_VISIBILITIES: readonly AppVisibility[] = ["all", "me"];

/** 저장된 값 → 공개 범위. 'me' 만 나만 보는 앱이고 나머지(빈 칸 · 모르는 값)는 'all'. */
export function appVisibilityOf(app: { visibility?: unknown }): AppVisibility {
  return app.visibility === "me" ? "me" : "all";
}

/**
 * 판정에 쓰는 사람 — 토큰의 구성원 id 와 scope.
 *  address — 앱 주소(<앱>-<워크스페이스>[-draft].lvly.app)의 `/_lively/*` 로 들어온 호출이면 그 주소의 판(#4482 v2-3). 그때는 보는 판을
 *   사람이 아니라 **주소**가 정한다(addressViewFor) — 공개 주소의 화면은 초안을 고친 사람에게도 공개 판이라, 그 화면이 부르는 도구 · 표도
 *   공개 판의 선언이어야 한다(설계 §14 덧붙임 «남은 확인 2»). 앞단이 서명한 값에서만 채운다(apps/app-front-api.ts).
 */
export interface Viewer { userId: string; scopes?: readonly string[]; address?: "pub" | "draft" }

/** 판정에 쓰는 앱의 칸들(org_app 의 부분). */
export interface AppVisState {
  visibility: AppVisibility;
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
  return appVisibilityOf(app) === "all" || isAppOwner(app, who) || isAdminViewer(who);
}

/** 목록(앱 찾기 · 붙이기 고르기 · 앱빌더)에 서나 — 나만 보는 앱은 책임자에게만. 관리자에게도 남이 만들고 있는 앱은 목록에 서지 않는다. */
export function listsAppFor(app: Pick<AppVisState, "visibility" | "owner_member">, who: Viewer): boolean {
  return appVisibilityOf(app) === "all" || isAppOwner(app, who);
}

/**
 * 아직 첫 판이 없는 예약 앱인가(「만들기 시작」 이 만든 빈 앱 — AI 의 첫 app_save 가 채운다). 목록·붙이기에 서지 않는다.
 *  내용 해시와 판 번호가 **둘 다** 비어야 빈 예약이다 — 예약 행 정리(store dropEmptyDraftApp · dropStaleEmptyDrafts)와 같은 자(격리 리뷰 2-9).
 */
export function isEmptyDraftApp(app: { content_hash?: string | null; current_version_no?: number | null }): boolean {
  return app.content_hash == null && app.current_version_no == null;
}

/**
 * 이 사람에게 보일 판 — 'none'(못 본다) · 'installed'(설치된 상태 = 고친 사람의 판) · 'published'(판 행의 공개 판).
 *  공개 앱에 초안이 있을 때만 'published' 가 나온다(초안을 만든 사람은 'installed').
 *  공개 판 번호가 없는데 초안 표식이 서 있는 상태는 불변식 위반이다 — 앱이 아무에게도 안 보이는 것보다 설치된 상태를 보이는 쪽을 고른다.
 */
export type AppView = "none" | "installed" | "published";
export function appViewFor(app: AppVisState, who: Viewer): AppView {
  if (who.address) return addressViewFor(app, who, who.address);   // #4482 앱 주소로 들어온 호출 — 주소의 판
  if (!canSeeApp(app, who)) return "none";
  if (appVisibilityOf(app) === "me") return "installed";
  if (!app.draft_by || app.published_version_no == null) return "installed";
  return app.draft_by === who.userId ? "installed" : "published";
}

/**
 * 앱 주소의 두 판(#4480 v2-1 · 설계 §13-5)에서 이 사람이 보는 판 — 공개 주소(`<앱>-<워크스페이스>`)는 **모두에게 공개 판**(초안을 고친 사람에게도),
 *  초안 주소(`…-draft`)는 설치된 상태이되 공개 앱에 남의 초안이 걸려 있으면 없는 판('none' — 그 초안은 고친 사람만 본다).
 *  주소를 나눈 까닭이 «초안 코드가 남긴 서비스 워커 · 저장소가 공개 판 주소에 남지 않게» 라서, 초안 코드는 초안 주소에서만 돈다.
 *  나만 보는 앱은 판이 하나(설치된 상태)라 두 주소 모두 그 판이다. 못 보는 앱은 'none'.
 */
export function addressViewFor(app: AppVisState, who: Viewer, variant: "pub" | "draft"): AppView {
  if (!canSeeApp(app, who)) return "none";
  const pending = appVisibilityOf(app) === "all" && !!app.draft_by && app.published_version_no != null;
  if (variant === "draft") return pending && app.draft_by !== who.userId ? "none" : "installed";
  return pending ? "published" : "installed";
}

/** 주소 종류를 정하지 않고 열 때 고를 주소 — 이 사람이 고친 초안이 걸려 있으면 초안 주소, 아니면 공개 주소(라이블리 화면이 이 사람에게 보이는 판과 같다 · appViewFor). */
export function addressVariantFor(app: AppVisState, who: Viewer): "pub" | "draft" {
  return appVisibilityOf(app) === "all" && !!app.draft_by && app.draft_by === who.userId && app.published_version_no != null ? "draft" : "pub";
}

/**
 * 공개 앱에 설치를 마친 뒤의 초안 표식(순수) — 설치된 내용이 공개 판과 같으면 초안 없음(null), 다르면 그 일을 한 사람의 초안.
 *  나만 보는 앱엔 초안 표식이 없다(앱 전체가 책임자의 것이다).
 */
export function draftByAfterInstall(visibility: AppVisibility, installedHash: string | null, publishedHash: string | null, actor: string): string | null {
  if (visibility === "me") return null;
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
  if (appVisibilityOf(app) === "me") {
    if (isAppOwner(app, who) || isAdminViewer(who)) return null;
    return `${name} 은(는) 다른 사람이 만들고 있는 앱이라 공개할 수 없습니다`;
  }
  if (!app.draft_by) return null;   // 이미 공개 판 그대로 — 할 일 없음(호출부가 changed:false 로 답한다)
  if (editDenial && !isAdminViewer(who)) return editDenial;
  if (app.draft_by === who.userId || isAppOwner(app, who) || isAdminViewer(who)) return null;
  return `${name} 의 지금 초안은 ${app.draft_by} 님이 고친 것이라 그 사람이나 책임자 · 관리자만 공개할 수 있습니다`;
}

/**
 * 남의 공개 전 판인가(격리 리뷰 NB-6) — 공개 판 뒤에(번호가 크고, 「공개하기」 를 한 적이 있으면 그 뒤에) 다른 사람이 저장한 판은 그 사람의 초안이다.
 *  책임자 · 관리자가 아니면 판 이력에서 보이지 않고 되돌리기 대상도 아니다(남의 초안 판으로 되돌린 뒤 공개해 그 초안을 대신 내보내는 길을 막는다).
 *  번호를 먼저 보는 까닭: 공개 판을 못 박는 판과 그 직후의 초안 판은 같은 순간에 생긴다(시각으로는 못 가른다). 시각(publishedAt, ms)은
 *  옛 판으로 되돌려 공개한 경우 — 공개 판 번호보다 큰 옛 이력 판을 초안으로 잘못 가리지 않게 — 에만 더 본다. 공개 판이 없으면 아무것도 가리지 않는다.
 */
export function isOthersPendingVersion(
  app: Pick<AppVisState, "visibility" | "owner_member" | "published_version_no">, v: { version_no: number; saved_by: string | null; saved_at: string; origin?: string },
  who: Viewer, publishedAt: number | null,
): boolean {
  if (appVisibilityOf(app) !== "all" || app.published_version_no == null || v.version_no <= app.published_version_no) return false;
  if (v.origin === "builtin") return false;   // 릴리스 원본 판은 누구의 초안도 아니다
  if (publishedAt != null) { const t = Date.parse(v.saved_at); if (!Number.isFinite(t) || t <= publishedAt) return false; }
  if (isAppOwner(app, who) || isAdminViewer(who)) return false;
  return v.saved_by !== who.userId;
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
