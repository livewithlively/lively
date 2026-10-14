// 보는 사람의 판으로 앱 행을 읽는다(#4667) — 판정(appViewFor)은 visibility.ts(순수), 여기는 판 행을 읽어 갈아 끼우는 일.
//  공개 앱에 초안이 있으면 초안을 만든 사람만 설치된 상태(org_app 행 · 화면 자산)를 보고, 나머지는 판 행(org_app_version)의 공개 판을 본다.
//  앱의 제목·매니페스트를 읽어 «이 사람에게 무엇을 보이나 · 무엇을 허락하나» 를 정하는 자리(목록 · 동의 · 도구 다리 · 세션에 붙은 앱 · AI 지침)는
//  org_app.manifest 를 바로 읽지 말고 이걸 지난다 — 남의 초안이 선언한 도구·지침이 내 화면·내 AI 에 새지 않게.
import { getAppVersionHead, type AppVersionHead, type OrgApp } from "../org/store/apps.js";
import { appViewFor, type AppView, type Viewer } from "./visibility.js";
import { logger } from "../log.js";

/** 공개 판을 보는 사람에게 — 앱 행의 제목·판·매니페스트·해시를 공개 판의 것으로 갈아 끼운다(설치된 상태는 초안이다). */
export function asPublished(app: OrgApp, head: Pick<AppVersionHead, "version_no" | "version" | "manifest" | "content_hash">): OrgApp {
  const t = (head.manifest as { title?: unknown } | null)?.title;
  return { ...app, title: typeof t === "string" && t ? t : app.title, version: head.version, manifest: head.manifest, content_hash: head.content_hash, current_version_no: head.version_no };
}

/** 이 사람이 볼 판으로 — 공개 판 행이 없으면(불변식 위반) 설치된 상태를 보이고 남긴다(앱이 아무에게도 안 보이는 것보다 낫다). */
export async function viewAppFor(app: OrgApp, who: Viewer): Promise<{ view: AppView; app: OrgApp }> {
  const view = appViewFor(app, who);
  if (view !== "published") return { view, app };
  const head = await getAppVersionHead(app.id, app.published_version_no as number);
  if (!head) { logger.warn({ app: app.id, published: app.published_version_no }, "공개 판 행이 없어 설치된 상태를 보인다(#4667 불변식)"); return { view: "installed", app }; }
  return { view, app: asPublished(app, head) };
}
