// 보는 사람의 판으로 앱 행을 읽는다(#4667) — 판정(appViewFor)은 visibility.ts(순수), 여기는 판 행을 읽어 갈아 끼우는 일.
//  공개 앱에 초안이 있으면 초안을 만든 사람만 설치된 상태(org_app 행 · 화면 자산)를 보고, 나머지는 판 행(org_app_version)의 공개 판을 본다.
//  앱의 제목·매니페스트를 읽어 «이 사람에게 무엇을 보이나 · 무엇을 허락하나» 를 정하는 자리(목록 · 동의 · 도구 다리 · 세션에 붙은 앱 · AI 지침)는
//  org_app.manifest 를 바로 읽지 말고 이걸 지난다 — 남의 초안이 선언한 도구·지침이 내 화면·내 AI 에 새지 않게.
import { getAppVersionHead, type AppVersionHead, type OrgApp } from "../org/store/apps.js";
import { appViewFor, declaredTableNames, type AppView, type Viewer } from "./visibility.js";
import { isBuiltinSource } from "./store-ddl.js";
import { isOverrideSource } from "./app-versions.js";
import { logger } from "../log.js";

/**
 * 공개 판을 보는 사람에게 — 앱 행의 제목·판·매니페스트·해시를 공개 판의 것으로 갈아 끼운다(설치된 상태는 초안이다).
 *  고친 사람 · 때(updated_*)와 출처(덮어쓴 빌트인인가)도 공개 판의 것으로 — 초안을 누가 언제 깔았나가 남에게 새지 않게(격리 리뷰 NB-6 · NB-8).
 */
export function asPublished(app: OrgApp, head: Pick<AppVersionHead, "version_no" | "version" | "manifest" | "content_hash"> & Partial<Pick<AppVersionHead, "origin" | "saved_by" | "saved_at">>): OrgApp {
  const t = (head.manifest as { title?: unknown } | null)?.title;
  const builtin = isBuiltinSource(app.source);
  const src = !builtin || !head.origin ? app.source
    : head.origin === "builtin" ? (isOverrideSource(app.source) ? { kind: "builtin" } : app.source)
      : (isOverrideSource(app.source) ? app.source : { ...(app.source as Record<string, unknown>), overrides_builtin: true });
  return {
    ...app, title: typeof t === "string" && t ? t : app.title, version: head.version, manifest: head.manifest, content_hash: head.content_hash, current_version_no: head.version_no,
    source: src, updated_by: app.published_by ?? head.saved_by ?? null, updated_at: app.published_at ?? head.saved_at ?? app.installed_at,
  };
}

/** 이 사람이 볼 판으로 — 공개 판 행이 없으면(불변식 위반) 설치된 상태를 보이고 남긴다(앱이 아무에게도 안 보이는 것보다 낫다). */
export async function viewAppFor(app: OrgApp, who: Viewer): Promise<{ view: AppView; app: OrgApp }> {
  const view = appViewFor(app, who);
  if (view !== "published") return { view, app };
  const head = await getAppVersionHead(app.id, app.published_version_no as number);
  if (!head) { logger.warn({ app: app.id, published: app.published_version_no }, "공개 판 행이 없어 설치된 상태를 보인다(#4667 불변식)"); return { view: "installed", app }; }
  return { view, app: asPublished(app, head) };
}

/**
 * 이 앱의 물리 표를 지금 받치는 매니페스트들(#4667) — 설치된 판, 그리고 공개 앱에 초안이 걸려 있으면 공개 판(초안이 뺀 표도 공개할 때까지 남는다 —
 *  install-run keepTables). 떠 두기 · 지우기 · 자유 SQL 의 앱 역할처럼 «있는 표 전부» 를 다루는 자리가 쓴다(격리 리뷰 B3 · NB-7).
 *  공개 판 행을 못 읽으면 설치된 판만(남은 표는 다음 「공개하기」 가 정리한다).
 */
export async function liveManifests(app: OrgApp): Promise<unknown[]> {
  if (app.visibility !== "all" || !app.draft_by || app.published_version_no == null) return [app.manifest];
  const head = await getAppVersionHead(app.id, app.published_version_no).catch(() => null);
  return head ? [app.manifest, head.manifest] : [app.manifest];
}

/** 이 앱의 물리 표 이름 전부(설치된 판 ∪ 공개 판) — 떠 두기 · 지우기가 쓴다(격리 리뷰 NB-7). */
export async function liveTableNames(app: OrgApp): Promise<string[]> {
  const out: string[] = [];
  for (const m of await liveManifests(app)) for (const t of declaredTableNames(m)) if (!out.includes(t)) out.push(t);
  return out;
}
