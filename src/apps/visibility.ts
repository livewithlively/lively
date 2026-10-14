// 앱의 공개 범위(#4632, 원준 2026-10-14 «디폴트가 내가 만든 앱은 나만이어야 해»). 순수 — 값으로 검증한다(visibility.test.ts).
//
//  · 'all' — 워크스페이스 구성원 모두(설치 앱 · 기본 앱 · 관리자 설치의 기본)
//  · 'me'  — 만든 사람만(앱빌더 · app_save 로 **새로** 생긴 앱의 기본). 그 사람과 관리자 말고는 목록 · 상세 · 화면 · 동의 · 붙이기 · 인스턴스 ·
//            판 이력 · 지우기 어디서도 그 앱이 없는 것과 같다. 만든 사람 = org_app.installed_by, 또는 매니페스트 studio.made_by(세션의 AI 가
//            대신 저장해도 사람이 만든 앱이다 — app-studio putApp 이 적는다).
//  모르는 값은 'all' 로 읽는다 — 칸이 깨져도 앱이 갑자기 잠기지 않게(잠그는 쪽이 아니라 여는 쪽으로 틀린다).
import type { OrgApp } from "../org/store/apps.js";

export type AppVisibility = "all" | "me";
export const APP_VISIBILITIES: readonly AppVisibility[] = ["all", "me"];
export interface AppViewer { userId: string; scopes?: readonly string[] }
type AppLike = Pick<OrgApp, "installed_by" | "manifest"> & { visibility?: unknown; title?: string; id?: string };

export function appVisibilityOf(app: { visibility?: unknown }): AppVisibility {
  return app.visibility === "me" ? "me" : "all";
}
/** 이 앱을 만든 사람들 — installed_by 와 매니페스트 studio.made_by(둘 다 있으면 둘 다). 빈 값은 뺀다. */
export function appOwnerIds(app: Pick<OrgApp, "installed_by" | "manifest">): string[] {
  const out: string[] = [];
  const by = String(app.installed_by ?? "").trim(); if (by) out.push(by);
  const m = app.manifest as { studio?: { made_by?: unknown } } | null;
  const made = String(m?.studio?.made_by ?? "").trim(); if (made && !out.includes(made)) out.push(made);
  return out;
}
export function isAppOwner(app: Pick<OrgApp, "installed_by" | "manifest">, who: AppViewer): boolean {
  const me = String(who.userId ?? "").trim();
  return !!me && appOwnerIds(app).includes(me);
}
/** 이 사람에게 이 앱이 보이나 — 'all' 이면 누구나, 'me' 면 만든 사람과 관리자만. */
export function appVisibleTo(app: AppLike, who: AppViewer): boolean {
  if (appVisibilityOf(app) === "all") return true;
  if ((who.scopes ?? []).includes("admin")) return true;
  return isAppOwner(app, who);
}
/** 안 보이는 까닭(사람에게 그대로 보인다) · 보이면 null. */
export function appVisibilityDenial(app: AppLike, who: AppViewer): string | null {
  if (appVisibleTo(app, who)) return null;
  const name = String(app.title || app.id || "").trim();
  return `「${name || "이 앱"}」 은(는) 만든 사람만 쓰는 앱입니다(공개 범위 「나만」) — 만든 사람이 앱빌더의 배포 설정에서 「워크스페이스 모두」 로 바꾸면 쓸 수 있습니다`;
}
/** 공개 범위를 바꿀 수 있나 — 만든 사람 · 관리자. */
export function canSetAppVisibility(app: Pick<OrgApp, "installed_by" | "manifest">, who: AppViewer): boolean {
  return (who.scopes ?? []).includes("admin") || isAppOwner(app, who);
}
