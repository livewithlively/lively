// 앱 레지스트리 capability (#1780, design D2) — 조회 + 멤버 grant + enabled 토글 + 설치/제거(관리자).
//  설치/제거(org_app_install/remove)는 패키지 소스(git·로컬 경로·inline 파일 묶음)를 스테이지 디렉터리로 추출한 뒤
//   loader→installLoadedApp(builtin 시더와 공용 코어)로 저널드 전개한다. 업로드(tar)는 후속(멀티파트 라우트 선행).
//  경로 prefix = /api/ui/apps.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import * as store from "../org/store/apps.js";
import { parseAppManifest } from "../apps/manifest.js";
import { resolveGrant } from "../apps/grant.js";
import { loadAppPackage } from "../apps/loader.js";
import { stageAppSource, parseAppSource } from "../apps/install-source.js";
import { installLoadedApp } from "../apps/install-run.js";
import { removeInstalledApp, dropEmptyDraft, dropStaleDrafts } from "../apps/remove-run.js";
import {
  archiveLeftoverAppFolder, listAppFolderArchives, clearAppFolderArchives, restoreAppFolderArchive, archiveOrphanAppFolders,
} from "../apps/app-folder-archive.js";   // #4778 앱 폴더 보관
import { isBuiltinSource } from "../apps/store-ddl.js";
import { restartWorkersForApp, stopWorkersForApp, stopWorkersForMemberApp } from "../apps/worker-service.js";
import { editDenial, memberAppViolations } from "../apps/member-app.js";
import { listAppSnapshots, restoreAppSnapshot } from "../apps/app-snapshot.js";
import { builtinAppDir } from "../apps/builtin-root.js";
import {
  filesFromStored, hasPackageDir, isOverrideSource, originOfCurrent, overlayFiles, overrideSourceMeta,
  readPackageDir, uiPagesFromFiles, versionsToPrune, type AppFile,
} from "../apps/app-versions.js";
//  #4481 앱 v2-2 — 판 파일은 파일 목록(bundle) + 저장소(S3 · 자가호스팅 DB). 읽기·쓰기는 app-version-files 한 자리를 지난다.
import { appBundlePolicy, insertVersion, publishedScreens, pullFiles, recordVersion, refreshOrigin, stageVersion, storeVersionBundle, versionBundle, versionFiles } from "../apps/app-version-files.js";
import { bundleFromDir, bundleFromFiles } from "../apps/app-bundle.js";
import { bundleFilesToWrite, hasRefFiles, stageFromDir, stageFromRefs, takeSkipped, writeFilesToDir, type SaveFileInput } from "../apps/app-bundle-source.js";
import { webRootOf } from "../apps/manifest.js";
import { sessionDirAccess } from "./app-bundle-dir.js";
import type { StagedSource } from "../apps/install-source.js";
import {
  APP_VISIBILITIES, appViewFor, canSeeApp, declaredTableNames, draftAppIdFrom, draftByAfterInstall, isAdminViewer, isAppOwner, isEmptyDraftApp, isOthersPendingVersion,
  listsAppFor, publishDenial, tablesGoneAtPublish, unpublishDenial, type AppView, type AppVisibility, type Viewer,
} from "../apps/visibility.js";   // #4632 공개 범위(나만 · 모두) · #4667 공개 판 · 초안 · 책임자
import { asPublished, liveTableNames, viewAppFor } from "../apps/app-view.js";
import { multiFileFallbackHtml } from "../apps/app-front-page.js";
import { appAddressUrlFor } from "./app-launch.js";   // #4482 맨 앱 주소(새 탭에서 열기)
import { filesCspSource } from "../files/app-screen-csp.js";   // #4673 앱 폴더 서명 주소 자리(앱 화면 CSP)
import { cleanupDroppedTables, appSchemaFor, ensureAppTables, tableSpecsOf, declaredColumnsOf, emptyTableReport, mergeReport, planDroppedTables, appTableCounts, type AppTableFailure, type AppTableReport } from "../apps/store-schema.js";
import { describeTableChanges, previewLimits, splitFailures, type GoneTablePlan, type PublishPreview } from "../apps/publish-preview.js";
import { listAppArchives, clearAppArchives } from "../apps/app-archive.js";
import type { ArchiveReason } from "../apps/archive-meta.js";
import { notifyAppInstaller } from "../apps/notify.js";
import { afterPublishServer, afterRevertServer, installedBuildState, newFunctionDenial, publishServerDenial } from "../apps/app-server-deploy.js";
import { appServerPolicy } from "../apps/app-server-store.js";
import { appServerEnv, serverDeclOf } from "../apps/app-server-config.js";
import { publishAppEvent, sessionOwnerOf } from "../apps/session-apps.js";
import { resyncSessionsWithApp } from "../apps/session-app-folders.js";   // #4684 — 앱 상태·공개·동의가 바뀌면 붙은 세션의 앱 폴더를 다시 맞춘다
import { appFolderUsageForView, folderFields } from "../apps/app-folder-quota.js";   // #4785 — 앱 폴더 상한 · 사용량 칸
import { getMember } from "../org/store/members.js";
import { itemsPool } from "../db/client.js";
import { logger } from "../log.js";
import { randomInt } from "node:crypto";
import type { LivelyUser } from "../context.js";
import type { WriteCtx } from "../org/store/audit.js";
import { audit } from "../org/store/audit.js";

const actorOf = (u: { userId?: string; email?: string } | undefined): string => u?.userId || u?.email || "unknown";
const wctx = (u: { userId?: string; email?: string } | undefined, ctx?: { source?: string }) => ({ actor: actorOf(u), source: ctx?.source ?? "web" });
const viewerOf = (u: LivelyUser | undefined): Viewer => ({ userId: actorOf(u), scopes: u?.scopes ?? [] });

function appId(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) throw new HttpError(400, "app_id 가 필요합니다");
  return s;
}

// ── #4667 공개 상태 · 보는 판 — 판정은 apps/visibility.ts, 여기는 행을 읽고 갈아 끼우는 일 ──
//  못 보는 앱(남이 만들고 있는 나만 보는 앱)은 «없는 앱» 과 같은 404 — 존재도 내용도 흘리지 않는다.
async function requireVisibleApp(id: string, who: Viewer): Promise<store.OrgApp> {
  const app = await store.getApp(id);
  if (!app || !canSeeApp(app, who)) throw new HttpError(404, `앱 없음: ${id}`);
  return app;
}

const viewApp = viewAppFor;

/**
 * 목록·상세가 함께 싣는 공개 상태 칸 — 화면(앱 찾기 · 앱빌더 · 앱 만들기)은 **이 칸을** 읽는다(매니페스트 studio 칸이 아니라).
 *  초안(그 판 번호·만든 사람)과 만들기 세션은 책임자·초안을 만든 사람(·관리자)에게만 — 나머지에겐 공개 판이 전부다.
 */
function stateFields(app: store.OrgApp, who: Viewer, view: AppView, origin: store.OrgApp | null, edit: string | null): Record<string, unknown> {
  const owner = isAppOwner(app, who);
  const admin = isAdminViewer(who);
  const draftPending = app.visibility === "all" && !!app.draft_by;
  return {
    visibility: app.visibility,
    made_by: app.made_by,
    owner_member: app.owner_member,
    origin_app_id: app.origin_app_id,
    origin: app.origin_app_id ? (origin && canSeeApp(origin, who) ? { id: origin.id, title: origin.title, made_by: origin.made_by } : { id: app.origin_app_id }) : null,
    published_version_no: app.visibility === "all" ? app.published_version_no : null,
    published_at: app.published_at,
    published_by: app.published_by,
    view,
    is_owner: owner,
    draft: draftPending && (app.draft_by === who.userId || owner || admin) ? { by: app.draft_by, version_no: app.current_version_no } : null,
    build_session: owner || admin ? app.build_session : null,
    empty: isEmptyDraftApp(app),
    can_publish: !isEmptyDraftApp(app) && (app.visibility === "me" || draftPending) && publishDenial(app, who, edit) === null,
    can_unpublish: app.visibility === "all" && !isBuiltinSource(app.source) && unpublishDenial(app, who) === null,
  };
}

/** 응답에 실을 앱 한 줄 — 보는 판으로 갈아 끼우되 초안 표식·만들기 세션 같은 칸은 stateFields 가 정한 만큼만. */
function appRow(installed: store.OrgApp, shown: store.OrgApp, who: Viewer, view: AppView, origin: store.OrgApp | null): Record<string, unknown> {
  const { draft_by: _d, build_session: _b, ...rest } = shown;
  const edit = editDenial(installed, who, safeManifest(installed));
  return { ...rest, can_edit: edit === null, ...stateFields(installed, who, view, origin, edit) };
}

// ── 앱 목록(설치된 앱) ──
const appsIndex: Capability = {
  name: "org_apps",
  title: "설치된 앱 목록",
  description: "이 워크스페이스의 앱 목록(id·제목·버전·상태·활성) — 보는 사람에게 보이는 판으로. 공개 앱은 모두에게, 나만 보는 앱(visibility 'me' — 공개 전)은 " +
    "책임자에게만 선다. 공개 앱에 다른 사람의 초안이 있으면 공개 판의 제목·매니페스트가 실린다(view 'published'). 칸: visibility · made_by(만든 사람) · " +
    "owner_member(책임자 — null = 관리자) · origin(사본이면 원본) · published_version_no · draft(내 초안이면 그 판) · build_session(책임자에게만) · can_edit · can_publish. " +
    "session 을 주면 그 세션이 만드는 앱만(세션 → 앱 역조회 — 다른 기기에서 이어 만들기). include_empty 면 아직 첫 판이 없는 예약 앱도. 런치패드·앱빌더·앱 관리 화면이 소비.",
  scope: null,
  input: {
    session: z.string().max(128).optional().describe("이 세션이 만드는(만들기 세션으로 이어진) 앱만 — 세션 → 앱 역조회"),
    include_empty: z.boolean().optional().describe("아직 첫 판이 없는 예약 앱(「만들기 시작」 직후)도 싣는다 — 앱빌더용"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/apps"], parse: (req) => {
      const q = (req.query ?? {}) as Record<string, unknown>;
      return { session: q.session == null || q.session === "" ? undefined : String(q.session), include_empty: q.include_empty === "1" || q.include_empty === "true" };
    } }],
  },
  //  #4225 — can_edit: **이 요청자가** app_save 로 이 앱을 고칠 수 있나(화면이 [고치기]·설정 메뉴를 그릴지 정한다). 판정은 member-app.ts.
  handler: async (input: Record<string, unknown>, user: LivelyUser) => {
    const who = viewerOf(user);
    const all = await store.listApps();
    const byId = new Map(all.map((a) => [a.id, a]));
    const session = input.session == null ? "" : String(input.session).trim();
    let rows = all.filter((a) => listsAppFor(a, who));
    if (session) rows = rows.filter((a) => a.build_session === session && (isAppOwner(a, who) || isAdminViewer(who)));
    else if (input.include_empty !== true) rows = rows.filter((a) => !isEmptyDraftApp(a));
    //  공개 판을 볼 사람의 앱만 판 머리를 한 번에 읽는다 — 초안이 없는 앱(거의 전부)은 추가 조회가 없다.
    const heads = await store.listPublishedHeads(rows.filter((a) => appViewFor(a, who) === "published").map((a) => a.id));
    //  #4785 앱 폴더 상한 · 사용량 — 한 번에 읽는다(CP 가 재어 보낸 것. 셀프호스트엔 없다).
    const usage = await appFolderUsageForView(rows.map((a) => a.id));
    return {
      apps: rows.map((a) => {
        const v0 = appViewFor(a, who);
        const head = v0 === "published" ? heads.get(a.id) : undefined;
        const view: AppView = v0 === "published" && !head ? "installed" : v0;
        return { ...appRow(a, head ? asPublished(a, head) : a, who, view, a.origin_app_id ? byId.get(a.origin_app_id) ?? null : null),
          folder: folderFields(a, usage.get(a.id), isAppOwner(a, who) || isAdminViewer(who)) };
      }),
    };
  },
};

/** 저장된 매니페스트를 다시 읽는다 — 못 읽으면 null(판정은 보수적으로: 확장 여부를 모르면 app_save 로 못 고치게 editDenial 이 다룬다). */
function safeManifest(a: store.OrgApp): ReturnType<typeof parseAppManifest> | null {
  try { return parseAppManifest(a.manifest); } catch { return null; }
}

// ── 앱 판(#4600) 보조 — 지금 서빙 중인 패키지 파일 묶음 · 판 떠 두기 ──
//  빌트인은 폴더(apps/builtin/<id>)가 전부다(bin/·README 포함). DB 에는 매니페스트·화면만 남으므로, 덮어쓴 빌트인은 폴더 위에
//  DB 의 매니페스트·화면을 덮어 «지금 서빙 중인 것» 을 만든다. 폴더가 없는 앱(세션이 만든 앱)은 DB 가 전부다.
async function currentPackageFiles(app: store.OrgApp): Promise<{ files: AppFile[]; from: "version" | "folder" | "folder+db" | "db" }> {
  //  덮어쓴 빌트인은 구성원이 저장한 **판의 파일 묶음 그대로**가 지금 서빙본이다(bin/ 을 고쳤어도 거기 있다 — DB 에는 매니페스트·화면만 남아
  //  폴더+DB 로 되살리면 구성원이 고친 bin/ 이 릴리스 것으로 돌아간다. 격리 리뷰 7a). 그 판이 지금 내용과 같을 때만(해시) 믿는다.
  //  #4481 — 덮어쓴 빌트인만이 아니라 판 행이 지금 내용 그대로인 앱 전부(세션이 만든 앱도 — DB 로 되살리면 매니페스트·화면 말고는 잃는다:
  //   bin/ · 여러 파일 앱의 dist/). 판 묶음은 저장소에서 읽는다.
  if (app.current_version_no != null) {
    const cur = await store.getAppVersion(app.id, app.current_version_no);
    if (cur && cur.content_hash != null && cur.content_hash === app.content_hash) return { files: await versionFiles(cur), from: "version" };
  }
  const stored = filesFromStored(app.manifest, await store.listUiAssetsFull(app.id));
  if (isBuiltinSource(app.source)) {
    const dir = builtinAppDir(app.id);
    if (await hasPackageDir(dir)) {
      const folder = await readPackageDir(dir);
      return isOverrideSource(app.source) ? { files: overlayFiles(folder, stored), from: "folder+db" } : { files: folder, from: "folder" };
    }
  }
  return { files: stored, from: "db" };
}

/** 지금 상태를 판으로 떠 둔다(저장·되돌리기 직전). 호출부가 설치 락 안에서 부른다. 반환 = 판 번호. */
async function snapshotCurrentVersion(app: store.OrgApp, savedBy: string | null, note: string): Promise<number> {
  const { files, from } = await currentPackageFiles(app);
  //  #4481 여러 파일 앱은 DB 에 매니페스트·entry HTML 만 남는다 — 거기서 되살린 판은 dist/ 를 잃은 «깨진 판» 이다. 떠 두지 않고 알린다.
  if (from === "db" && webRootOf(app.manifest) !== null) {
    throw new HttpError(409, `「${app.title || app.id}」 의 지금 상태를 판으로 떠 둘 파일 묶음이 없습니다 — 앱 폴더에서 다시 저장해 주세요(app_save {dir})`);
  }
  return recordVersion(app.id, {
    origin: originOfCurrent(app.source), version: app.version, manifest: app.manifest,
    content_hash: app.content_hash, note, saved_by: savedBy,
  }, bundleFromFiles(files));
}

/**
 * #4481 구성원 저장(app_save · 그 판으로 되돌리기)이 하네스 자산을 싣지 않게 — 로더는 매니페스트 harness 칸이 없어도 패키지 맨 위의
 *  skills/ · agents/ · commands/ 를 하네스 자산으로 읽어 조직 전체에 깐다(loader scanHarnessAssets). 설명의 «스킬·훅은 관리자 설치로만» 을
 *  코드로 지킨다 — 폴더째 저장(dir)이 생기며 앱 폴더의 그런 폴더가 모르게 딸려 올 수 있게 됐다. 있으면 사람에게 보일 까닭, 없으면 null.
 */
function memberHarnessAssets(loaded: { items: ReadonlyArray<{ comp: { kind: string; orig_name?: string | null } }> }): string | null {
  const names = loaded.items.filter((it) => it.comp.kind === "harness_asset").map((it) => String(it.comp.orig_name ?? ""));
  if (!names.length) return null;
  return `앱 폴더 맨 위에 하네스 자산(skills/ · agents/ · commands/ — 구성원 컴퓨터에 까는 스킬·명령)이 있어 app_save 로 저장할 수 없습니다: ${names.slice(0, 5).join(" · ")}${names.length > 5 ? " …" : ""} — 그 폴더를 빼거나(이름을 바꾸거나) 관리자 설치(org_app_install)를 부탁하세요`;
}

/**
 * #4481 app_save 입력 → 설치 스테이지. dir(세션 프로젝트 폴더 — 게이트웨이가 직접 읽는다) · files 의 지문 줄(이 워크스페이스에 이미 있는 파일)
 *  · files 내용만(종전 inline 길 — 옛 상한 그대로) 중 하나. 판 상한(app_bundle_limits)은 앞의 둘이 걷는 자리에서 먼저 본다.
 */
async function stageSaveInput(input: Record<string, unknown>, user: LivelyUser, ctx: { session?: string } | undefined): Promise<StagedSource> {
  const files = Array.isArray(input.files) ? (input.files as SaveFileInput[]) : null;
  const dir = input.dir == null || String(input.dir).trim() === "" ? null : String(input.dir);
  if (dir && files?.length) throw new HttpError(400, "files 와 dir 중 하나만 주세요");
  if (dir) {
    const { acc, shown } = await sessionDirAccess(ctx, actorOf(user), dir);
    return stageFromDir(acc, shown, await appBundlePolicy());
  }
  if (!files?.length) throw new HttpError(400, "files(파일 묶음) 또는 dir(이 세션의 앱 폴더)가 필요합니다");
  if (hasRefFiles(files)) return stageFromRefs(files, await appBundlePolicy());
  return stageAppSource(parseAppSource({ kind: "inline", files }));
}

/** 구성원 판을 보관 수만큼만 남긴다(원본 판은 세지 않는다).
 *  #4667 지금 판과 공개 판은 보관 수 밖이어도 남긴다(공개 판은 초안이 있는 동안 나머지 모두가 보는 판이다).
 *  #4481 — 종전의 «워크스페이스 총량(DB 64MiB)을 넘으면 앱 불문 오래된 판부터 더 지우기» 는 걷었다. 판 파일이 S3 로 가며 총량은
 *   워크스페이스 상한(app_bundle_limits workspace_max_mb, 기본 10GB)이 되었고, 넘으면 저장이 413 으로 알린다 — 남의 앱 이력을 말없이 지우지 않는다.
 *   지운 판만 가리키던 파일은 하우스키핑 정리(app-bundle-migrate)가 하루 뒤 걷는다. */
async function pruneVersions(appId: string): Promise<void> {
  const app = await store.getApp(appId);
  await store.deleteAppVersions(appId, versionsToPrune(await store.listAppVersions(appId), undefined, [app?.current_version_no, app?.published_version_no]));
}

/** 지금 서빙 중인 내용이 이 판 그대로인가 — 번호가 아니라 **내용(해시)** 으로 본다(관리자 org_app_install 이 내용을 바꿔도 맞게 · 격리 리뷰 7b). */
const isCurrentVersion = (app: store.OrgApp, v: { content_hash: string | null }): boolean => v.content_hash != null && v.content_hash === app.content_hash;

/**
 * 설치된 상태가 어느 판 행인가 — 지금 판 번호가 그 내용이면 그대로, 아니면 같은 내용의 판을 찾고, 없으면 떠 둔다. 반환 = 판 번호.
 *  찾거나 떠 둔 번호를 current_version_no 로도 맞춘다(설치된 상태 = 그 판). 호출부가 설치 락 안에서 부른다.
 */
async function versionOfInstalled(app: store.OrgApp, actor: string | null, note: string): Promise<number> {
  let no: number | null = null;
  if (app.content_hash) {
    for (const cand of [app.current_version_no, app.published_version_no]) {
      if (cand == null || no != null) continue;
      const h = await store.getAppVersionHead(app.id, cand);
      if (h && isCurrentVersion(app, h)) no = cand;
    }
    if (no == null) no = await store.findVersionByHash(app.id, app.content_hash);
  }
  if (no == null) no = await snapshotCurrentVersion(app, actor, note);
  if (app.current_version_no !== no) { await store.setAppCurrentVersion(app.id, no); app.current_version_no = no; }
  return no;
}

/**
 * #4667 공개 앱에 초안을 깔기 **직전** — 지금 모두가 보는 판을 판 행에 못 박는다(초안이 생기면 나머지는 그 행을 본다).
 *  이미 초안이 있으면 공개 판은 못 박혀 있다. 없으면 설치된 상태가 곧 공개 판이다 — 그 판 행을 찾거나 떠 두고 가리킨다.
 *  반환 = 공개 판의 번호·매니페스트(초안 설치가 그 판의 표를 지우지 않게)·해시.
 */
async function pinPublished(app: store.OrgApp, actor: string): Promise<{ no: number; manifest: unknown; hash: string | null }> {
  if (app.draft_by && app.published_version_no != null) {
    const head = await store.getAppVersionHead(app.id, app.published_version_no);
    if (head) return { no: head.version_no, manifest: head.manifest, hash: head.content_hash };
    logger.warn({ app: app.id, published: app.published_version_no }, "초안이 있는데 공개 판 행이 없다 — 설치된 상태를 공개 판으로 다시 못 박는다(#4667)");
  }
  //  떠 두는 판은 지금 모두가 쓰는 내용이다 — 저장한 사람은 이 일을 시작한 사람(actor)이 아니라 그 내용을 깐 사람(릴리스 원본이면 없음).
  //   세션 훅이 «저장: 누구» 를 AI 에 싣는다(#4595 신뢰 경계) — 관리자가 쓴 지침을 고치러 온 사람의 글로 보이지 않게(격리 리뷰 NB-8).
  const builtinOrigin = originOfCurrent(app.source) === "builtin";
  const author = builtinOrigin ? null : (app.updated_by || app.installed_by || actor);
  const no = await versionOfInstalled(app, author, builtinOrigin ? `원본 · 릴리스 ${app.version}` : "저장 전 상태");
  if (app.published_version_no !== no) await store.setAppPublishedPointer(app.id, no);
  return { no, manifest: app.manifest, hash: app.content_hash };
}

/** 설치를 마친 뒤 초안 표식을 다시 맞춘다 — 공개 판 행과 내용이 같으면 초안 없음, 다르면 이 일을 한 사람의 초안(나만 보는 앱은 늘 없음). */
async function settleDraft(appId: string, actor: string, deferredPending = false): Promise<void> {
  const app = await store.getApp(appId);
  if (!app || app.visibility !== "all") return;
  const head = app.published_version_no != null ? await store.getAppVersionHead(app.id, app.published_version_no) : null;
  //  #4724 내용이 공개 판과 같아져도 이번 설치가 표 변경을 미뤘으면(공개 판의 칸을 지키느라 — 초안이 풀어 둔 not_null 을 다시 조이기 등)
  //   초안으로 남긴다. 표식을 걷으면 미룬 일이 올 때(「공개하기」)가 사라진다(격리 리뷰 — 초안에서 푼 not_null 뒤 빈 행이 생긴 채 공개 판과
  //   같은 파일을 다시 저장하면 조이기가 영영 안 왔다).
  const next = draftByAfterInstall("all", app.content_hash, head?.content_hash ?? null, actor);
  await store.setAppDraftBy(appId, next ?? (deferredPending ? actor : null));
}

/**
 * 공개 앱에 초안을 깔기 **직전** — 초안 표식을 먼저 이 사람으로 세운다(격리 리뷰 B1). 설치하는 동안에도, 설치 뒤 표식 맞추기(settleDraft)가 실패해도
 *  나머지는 공개 판을 본다(fail-closed). 반환 = 원래 표식(설치가 실패하면 되돌린다) · 밀려나는 남의 초안(알림 재료 — 판 번호는 밀려나기 전 설치된 판).
 */
async function claimDraft(app: store.OrgApp, actor: string): Promise<{ before: string | null; displaced: { by: string; version_no: number | null } | null }> {
  const before = app.draft_by;
  if (before !== actor) await store.setAppDraftBy(app.id, actor);
  return { before, displaced: before && before !== actor ? { by: before, version_no: app.current_version_no } : null };
}

/** 「공개하기」 를 한 시각(ms) — 한 적이 없으면 null(그땐 공개 판 번호만으로 남의 초안 판을 가른다 · isOthersPendingVersion). */
const publishedAtMs = (app: store.OrgApp): number | null => { const t = app.published_at ? Date.parse(app.published_at) : NaN; return Number.isFinite(t) ? t : null; };

/** 남의 초안을 밀어낸 저장 · 되돌리기 · 관리자 설치 — 그 초안을 만든 사람에게 알린다. 초안은 판 이력에 남아 되살릴 수 있다(격리 리뷰 Q-3). */
async function notifyDraftDisplaced(app: { id: string; title: string }, displaced: { by: string; version_no: number | null }, actor: string): Promise<void> {
  await notifyAppInstaller({
    appId: app.id, memberId: displaced.by,
    title: `앱 '${app.title}' 의 내 초안이 ${actor} 님의 고침으로 밀려났습니다`,
    body: `내 초안${displaced.version_no ? `(${displaced.version_no}판)` : ""}은 판 이력에 남아 있습니다 — 앱빌더 ▸ 배포 설정의 판 목록에서 「이 판으로」, 또는 app_revert 로 되살릴 수 있습니다.`,
  }).catch((err) => logger.warn({ err, id: app.id }, "밀려난 초안 알림 실패(비치명)"));
}

/** 「공개하기」 가 표를 맞추나 — 초안이 걸린 공개 앱만(나만 보는 앱의 첫 공개엔 미룬 것이 없고 · 초안이 없으면 공개할 것이 없고 ·
 *  기본 앱의 공유 표는 저장 때 이미 더하기만 받았다). 공개(publishCurrent)와 공개 미리 보기(#4732)가 같이 쓴다 — 한쪽만 바뀌어 갈라지지 않게. */
function publishTouchesTables(app: store.OrgApp): boolean {
  return !isBuiltinSource(app.source) && app.visibility === "all" && !!app.draft_by;
}

/**
 * 「공개하기」 의 몸통(설치 락 안) — 설치된 상태를 판 행에 맞추고 모두가 보는 판으로 옮긴다. 옛 공개 판에만 있던 표는 이때 정리한다
 *  (초안을 까는 동안은 공개 판이 그 표를 아직 썼다 — install-run keepTables). changed=false 면 이미 그 판이 공개돼 있었다.
 */
async function publishCurrent(appId: string, who: Viewer, w: WriteCtx): Promise<{ version_no: number | null; changed: boolean; tables?: AppTableReport }> {
  const app = await store.getApp(appId);
  if (!app || !canSeeApp(app, who)) throw new HttpError(404, `앱 없음: ${appId}`);
  if (isEmptyDraftApp(app)) throw new HttpError(409, `「${app.title || app.id}」 은(는) 아직 첫 판이 없어 공개할 것이 없습니다 — 먼저 app_save 로 저장하세요`);
  const why = publishDenial(app, who, editDenial(app, who, safeManifest(app)));
  if (why) throw new HttpError(403, why);
  if (app.visibility === "all" && !app.draft_by) return { version_no: app.published_version_no ?? app.current_version_no, changed: false };
  //  #4484 서버 앱 — 공개할 판의 서버 빌드가 이미 있어야 한다(결정 상민 2026-10-15 «공개는 빌드가 끝난 판만»). 표를 만지기 전에 본다.
  //   빌드는 「이대로 넣기」·app_server_deploy 가 그 판을 저장한 사람의 세션에서 한다 — 공개는 그 zip 을 함수의 공개 판(pub)으로 옮길 뿐이다.
  const serverWhy = await publishServerDenial(app);
  if (serverWhy) throw new HttpError(409, serverWhy);
  //  표와 무관한 준비(옛 공개 판 · 공개할 판 번호)는 표를 바꾸기 **전에** — 표를 바꾼 뒤엔 공개 표시 한 줄만 남긴다(격리 리뷰: 그 사이에 던지면
  //   표는 새 판인데 공개 판은 옛 판인 채 남는다).
  const old = app.visibility === "all" && app.published_version_no != null ? await store.getAppVersionHead(app.id, app.published_version_no) : null;
  const no = await versionOfInstalled(app, who.userId, "공개한 판");
  //  #4724 초안이 미뤄 둔 표 변경(공개 판의 칸을 지키느라 하지 않은 지우기·이름·형 바꾸기·조이기)을 지금 한다 — 새 공개 판의 선언으로 표를
  //   지키는 칸 없이 끝까지 맞춘다. 있던 데이터가 새 규칙에 어긋나면 여기서 409(몇 행인지)로 멈춰 **공개하지 않는다**(초안은 그대로 남는다).
  //   표 전부를 한 트랜잭션으로(atomic) — 앞 표만 바뀐 채 멈추면 아직 공개 판인 옛 코드가 그 표에서 깨진다.
  //   초안이 걸린 공개 앱만(나만 보는 앱의 첫 공개엔 미룬 것이 없다) · 기본 앱의 공유 표는 하지 않는다(저장 때 이미 더하기만 받았다).
  const tables = publishTouchesTables(app) ? emptyTableReport() : undefined;
  if (tables) {
    await ensureAppTables(app.id, tableSpecsOf(app.manifest), { schema: appSchemaFor(false), strict: true, sqlRole: true, atomic: true, report: tables, archiveReason: "publish" });
  }
  try {
    await store.markAppPublished(app.id, no, who.userId, w);
  } catch (err) {
    if (!tables) throw err;
    //  다시 공개하면 표는 이미 맞아 응답 tables 가 비므로, 이번에 한 일(지운 칸 · 보관 자리)을 여기서 남긴다(격리 리뷰).
    const did = tables.dropped_columns.map((d) => `${d.table}.${d.column}${d.archived_as ? ` → ${d.archived_as}` : ""}`);
    logger.error({ err, id: app.id, no, tables }, "표는 새 공개 판에 맞췄는데 공개 표시를 못 했다");
    throw new HttpError(503, `표는 새 공개 판(${no}판)에 맞췄지만 공개 표시를 하지 못했습니다 — 같은 공개를 다시 하면 이어서 됩니다`
      + `${did.length ? ` (지운 칸: ${did.join(" · ")})` : ""}(${(err as Error)?.message ?? err})`, { cause: err, body: { tables } });
  }
  if (old && !isBuiltinSource(app.source)) {
    const gone = tablesGoneAtPublish(old.manifest, app.manifest);
    if (gone.length) await cleanupGoneTables(app, gone, who.userId, "새 공개 판", "publish");
  }
  return { version_no: no, changed: true, tables };
}

/**
 * #4732 공개 미리 보기(설치 락 안) — 지금 「공개하기」(versionNo 없음) 또는 그 판으로 되돌리고 바로 공개(versionNo)하면 표에 할 일.
 *  아무것도 바꾸지 않는다: 공개(publishCurrent)와 같은 표 맞추기를 **한 트랜잭션으로 걸어 보고 늘 되돌린다**(dryRun · 지킴 없음 — 공개는 칸을 지키지 않는다).
 *  그래서 미리 보기와 실제가 같은 규칙으로 계산된다(따로 된 판정기를 두지 않는다 — #4724 격리 리뷰). 걸어 보는 동안 바뀌는 표는 잠기므로
 *  잠금 대기 · 문장 시간을 짧게 둔다(previewLimits) — 넘으면 «다 보지 못했다»(incomplete)로 돌아오고, 그동안 그 표를 쓰는 사람은 그 시간만 기다린다.
 *  되돌려 공개(versionNo)는 «그 판 설치(칸 지킴) → 공개(지킴 없음)» 의 합이라 그 판의 선언을 지킴 없이 걸어 본 것과 같다. 정리될 표는
 *  지금 물리 표(설치된 판 ∪ 공개 판) 중 그 판에 없는 것(설치 때 · 공개 때 정리가 나눠 한다).
 */
async function previewPublish(appId: string, who: Viewer, versionNo: number | null): Promise<PublishPreview> {
  const app = await store.getApp(appId);
  if (!app || !canSeeApp(app, who)) throw new HttpError(404, `앱 없음: ${appId}`);
  if (isEmptyDraftApp(app)) throw new HttpError(409, `「${app.title || app.id}」 은(는) 아직 첫 판이 없어 공개할 것이 없습니다 — 먼저 app_save 로 저장하세요`);
  const base: PublishPreview = {
    app_id: app.id, kind: versionNo == null ? "publish" : "revert", version_no: versionNo ?? app.current_version_no ?? null,
    published_version_no: app.visibility === "all" ? app.published_version_no ?? null : null,
    changes: [], notes: [], blocked: [], incomplete: null, tables: null, gone_tables: [],
  };
  let target: unknown;
  let gone: string[];
  if (versionNo == null) {
    const why = publishDenial(app, who, editDenial(app, who, safeManifest(app)));
    if (why) throw new HttpError(403, why);
    //  공개가 표를 만지는 경우만(publishCurrent 와 같은 판정) — 나만 보는 앱의 첫 공개 · 초안 없는 공개 앱 · 기본 앱(공유 표)은 할 일이 없다.
    if (!publishTouchesTables(app)) return base;
    target = app.manifest;
    const old = app.published_version_no != null ? await store.getAppVersionHead(app.id, app.published_version_no) : null;
    gone = old ? tablesGoneAtPublish(old.manifest, app.manifest) : [];
  } else {
    const why = editDenial(app, who, safeManifest(app));
    if (why) throw new HttpError(403, why);
    const ver = await store.getAppVersion(app.id, versionNo);
    if (!ver || isOthersPendingVersion(app, ver, who, publishedAtMs(app))) throw new HttpError(404, `앱 '${app.id}' 에 ${versionNo}판이 없습니다`);
    //  기본 앱의 공유 표는 되돌려도 더하기만 한다(깨는 판은 되돌리기가 409 — assertSharedTablesAccept).
    if (isBuiltinSource(app.source)) return base;
    target = ver.manifest;
    const keep = new Set(declaredTableNames(ver.manifest));
    gone = (await liveTableNames(app)).filter((t) => !keep.has(t));
  }
  const report = emptyTableReport();
  const failures: AppTableFailure[] = [];
  const lim = previewLimits();
  await ensureAppTables(app.id, tableSpecsOf(target), {
    schema: appSchemaFor(false), atomic: true, dryRun: true, report, failures,
    lockMs: lim.lockMs, statementMs: lim.statementMs, deadlineAt: Date.now() + lim.totalMs, surfaceTimeouts: true,
  });
  //  보관 자리 이름은 공개하는 시각으로 정해진다 — 걸어 본 이름(되돌려 없어진 표)을 내보내지 않는다.
  for (const d of report.dropped_columns) d.archived_as = null;
  const { blocked, incomplete } = splitFailures(failures);
  let goneTables: GoneTablePlan[] = [];
  let goneError: string | null = null;
  try { goneTables = await planDroppedTables(app.id, gone, appSchemaFor(false), { lockMs: lim.lockMs, statementMs: lim.statementMs }); }
  catch (err) {
    const code = (err as { code?: unknown })?.code;
    goneError = code === "55P03" || code === "57014"
      ? `새 판에 없는 표(${gone.join(", ")})는 지금 쓰는 사람이 있거나 커서 다 세지 못했습니다 — 공개할 때 행이 있으면 지우지 않고 보관합니다`
      : `새 판에 없는 표(${gone.join(", ")})를 어떻게 정리할지 보지 못했습니다: ${(err as Error)?.message ?? err}`;
  }
  const { changes, notes } = describeTableChanges(report, goneTables);
  return {
    ...base, tables: report, gone_tables: goneTables, blocked, changes, notes,
    incomplete: [incomplete, goneError].filter(Boolean).join(" · ") || null,
  };
}

/** #4484 공개가 끝난 뒤(설치 락 밖) — 공개 판의 서버 빌드를 함수의 pub · cur 로 옮긴다. 서버 앱이 아니면 null. 실패해도 공개는 됐다(응답 server 에 실는다). */
async function serverAfterPublish(id: string): Promise<Awaited<ReturnType<typeof afterPublishServer>>> {
  const app = await store.getApp(id);
  if (!app || !serverDeclOf(app.manifest) || !appServerEnv()) return null;
  return afterPublishServer(app, await appServerPolicy());
}

/** publish:true 의 공개 단계 — 실패해도 저장(설치 · 판 행 · 초안 표식)은 이미 끝났다. 잡아서 돌려주면 부르는 쪽이 저장 사건을 낸 뒤
 *  «저장은 됐다» 를 붙여 던진다(#4724 격리 리뷰: 공개 때 데이터가 어긋나는 409 는 흔하다 — «저장 실패» 로 읽고 같은 파일로 다시 저장하며 판만 쌓지 않게). */
async function tryPublish(id: string, who: Viewer, w: WriteCtx): Promise<{ pub: Awaited<ReturnType<typeof publishCurrent>> | null; pubError: unknown }> {
  try { return { pub: await publishCurrent(id, who, w), pubError: null }; }
  catch (e) { return { pub: null, pubError: e }; }
}
function publishFailed(saved: string, e: unknown): HttpError {
  const st = (e as { status?: unknown })?.status;
  return new HttpError(typeof st === "number" ? st : 500, `${saved} — 공개는 하지 못했습니다: ${(e as Error)?.message ?? String(e)}`,
    { cause: e, body: e instanceof HttpError ? e.body : undefined });
}

/**
 * #4724 기본 앱의 표는 여러 워크스페이스가 나눠 쓰는 공유 표다 — 늘 지금 있는 칸 전부를 지켜서(store-schema "existing") 깨는 변경은 미뤄도
 *  할 때가 오지 않는다. 그래서 저장 · 되돌리기 전에 이 선언을 **걸어 보고 되돌려서**(dryRun — 한 트랜잭션) 이번 저장이 새로 만드는 미룸이 있으면 409.
 *  매니페스트를 견주는 따로 된 판정이 아니라 실제 표 보장을 돌리므로 둘이 어긋나지 않는다(격리 리뷰 — 판정기와 표 보장의 규칙이 갈라졌었다).
 *  · 선언이 그대로인 표는 보지 않고, 바뀐 표도 지금 깔린 선언을 걸어 본 미룸(릴리스가 담았다가 시딩이 미룬 조이기 등 — 이 저장이 만든 것이
 *    아니다)을 빼고 견준다(격리 리뷰 — 화면만 고친 저장이 남의 미룸으로 409 가 되지 않게).
 *  · 판정 자체가 못 돌면(잠금 시간 초과 · 연결) 저장은 막지 않는다 — 기본 앱 설치도 표 일은 비치명이다(#4600 · 깔 때 미뤄지면 경고 로그).
 */
async function assertSharedTablesAccept(appId: string, current: unknown, next: unknown): Promise<void> {
  const before = new Map(tableSpecsOf(current).map((t) => [t.table, JSON.stringify(t)]));
  const changed = tableSpecsOf(next).filter((t) => before.get(t.table) !== JSON.stringify(t));
  if (!changed.length) return;
  const deferredOf = async (specs: ReturnType<typeof tableSpecsOf>): Promise<Set<string>> => {
    if (!specs.length) return new Set();
    const r = emptyTableReport();
    await ensureAppTables(appId, specs, { schema: appSchemaFor(true), tenantScopedIndexes: true, report: r, dryRun: true });
    return new Set(r.deferred.map((d) => d.change));
  };
  let introduced: string[];
  try {
    const base = await deferredOf(tableSpecsOf(current).filter((t) => changed.some((c) => c.table === t.table)));
    introduced = [...(await deferredOf(changed))].filter((c) => !base.has(c));
  } catch (err) {
    logger.warn({ err, appId }, "기본 앱 공유 표 판정을 하지 못했다(비치명 — 저장은 계속, 깔 때 미뤄지면 경고 로그)");
    return;
  }
  if (introduced.length) {
    throw new HttpError(409, `기본 앱의 표는 여러 워크스페이스가 나눠 써서 이 변경을 할 수 없습니다: ${introduced.join(" · ")} — `
      + "칸을 지우거나 이름·종류를 바꾸거나 조이지 말고, 새 칸을 더하는 쪽으로 바꾸세요(검사 · 기본값을 바꾸는 것도 안 됩니다)");
  }
}

/**
 * 옛 공개 판에만 있던 표를 정리한다(비었으면 삭제 · 데이터 있으면 보관) — 「공개하기」 · 관리자 설치가 부른다. 공개는 이미 끝난 뒤라
 *  정리가 실패해도 던지지 않는다(표는 그 자리에 남고 다음 정리가 다시 본다 · 격리 리뷰 NB-10). 보관했거나 실패했으면 그 일을 한 사람에게 알린다.
 */
async function cleanupGoneTables(app: { id: string; title: string }, gone: string[], actor: string, why: string, reason: ArchiveReason): Promise<void> {
  const cleaned = await cleanupDroppedTables(app.id, gone, appSchemaFor(false), new Date(), reason).catch((err) => {
    logger.warn({ err, id: app.id, gone }, "옛 공개 판 표 정리 실패(비치명 — 표는 그 자리에 남는다)");
    return null;
  });
  if (!cleaned || !(cleaned.archived.length || cleaned.failed.length)) return;
  const parts = [
    ...cleaned.archived.map((a) => `'${a.table}'(${a.rows}행) → ${a.archived_as} 로 보관`),
    ...cleaned.failed.map((f) => `'${f.table}' 정리 실패 — 그 자리에 둠`),
  ];
  await notifyAppInstaller({
    appId: app.id, memberId: actor,
    title: `앱 '${app.title}' 의 ${why}에서 빠진 테이블에 데이터가 있어 보관했습니다`,
    body: `옛 공개 판만 쓰던 테이블을 지우지 않고 옮겨 두었습니다: ${parts.join(" · ")}.`,
  }).catch((err) => logger.warn({ err, id: app.id }, "표 보관 알림 발송 실패(비치명)"));
}

/** 이 앱을 지금 붙여 둔 사람들 — 공개 판이 바뀌면 그 사람들의 앱 칸이 새 판을 다시 띄운다(사건은 사람마다 따로 간다). */
async function attachedMembers(appId: string): Promise<string[]> {
  const r = await itemsPool.query(`SELECT DISTINCT member_id FROM org_session_app WHERE app_id=$1 AND detached_at IS NULL`, [appId]).catch(() => ({ rows: [] as Array<{ member_id: unknown }> }));
  return r.rows.map((x) => String(x.member_id)).filter(Boolean);
}

/** 이 요청이 말한 세션(x-lively-session)이 **이 사람의** 세션이면 그 id — 만들기 세션 기록은 자기 세션만(남의 세션 id 를 찍지 않는다). */
async function ownSessionOf(ctx: { session?: string } | undefined, member: string): Promise<string | null> {
  const sid = String(ctx?.session ?? "").trim();
  if (!sid || !member) return null;
  const owner = await sessionOwnerOf(sid).catch(() => null);
  return owner === member ? sid : null;
}

/** 사본의 원본 — 있고 이 사람이 볼 수 있는 앱이어야 한다(서버가 기록하는 칸이라 아무 id 나 받지 않는다). */
async function validOrigin(originId: string, id: string, who: Viewer): Promise<string> {
  if (originId === id) throw new HttpError(400, "원본 앱 id 가 저장하는 앱 id 와 같습니다");
  const o = await store.getApp(originId);
  if (!o || !canSeeApp(o, who) || isEmptyDraftApp(o)) throw new HttpError(404, `원본 앱 없음: ${originId}`);
  return o.id;
}

// ── 앱 상세(+구성요소) ──
const appGet: Capability = {
  name: "org_app_get",
  title: "앱 상세",
  description: "앱 1건 + 전개된 구성요소(component) 목록. app_id 로 조회.",
  scope: null,
  input: { app_id: z.string() },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/apps/:id"], parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id }) }],
  },
  //  #4667 — 보는 사람의 판으로(공개 판을 보는 사람에겐 공개 판의 제목·매니페스트) + 공개 상태 칸. 남이 만들고 있는 앱은 404.
  handler: async (input: Record<string, unknown>, user: LivelyUser) => {
    const id = appId(input.app_id);
    const who = viewerOf(user);
    const app = await requireVisibleApp(id, who);
    const { view, app: shown } = await viewApp(app, who);
    const origin = app.origin_app_id ? await store.getApp(app.origin_app_id) : null;
    const usage = (await appFolderUsageForView([id])).get(id);   // #4785
    return { app: { ...appRow(app, shown, who, view, origin), folder: folderFields(app, usage, isAppOwner(app, who) || isAdminViewer(who)) },
      components: await store.listComponents(id) };
  },
};

// ── 앱 활성/비활성 토글(관리자) ──
//  비파괴 토글 — 세션·물질화 자산·토큰은 보존하되, 별도 worker는 새 실행을 막고 현재 run도 정지한다.
const appSetEnabled: Capability = {
  name: "org_app_set_enabled",
  title: "앱 활성/비활성",
  description: "앱을 켜거나 끈다(비파괴). 끄면 새 실행을 막고 현재 worker run은 정지한다. AI 세션·설치 자산은 보존한다.",
  scope: "memory",
  input: { app_id: z.string(), enabled: z.boolean() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/enabled"],
      parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id, enabled: (req.body as Record<string, unknown>)?.enabled !== false }) }],
  },
  handler: async (input: Record<string, unknown>, user, ctx) => {
    const id = appId(input.app_id);
    //  #4667 남이 만들고 있는(나만 보는) 앱은 없는 앱과 같다 — 남이 끄고 켜지 못한다(격리 리뷰 NB-4).
    await requireVisibleApp(id, viewerOf(user));
    await store.setAppEnabled(id, !!input.enabled, wctx(user, ctx));
    if (!input.enabled) await stopWorkersForApp(id, "app_disabled");
    //  #4684 — 끄면 붙은 세션에서 앱 폴더가 떨어지고, 다시 켜면 다시 붙는다(판정은 folderAppsFor — 기다리지 않는다).
    resyncSessionsWithApp(id, input.enabled ? "앱 켬" : "앱 끔");
    return { ok: true, app_id: id, enabled: !!input.enabled };
  },
};

// ── 멤버 grant(동의) — 이 앱을 내 자격으로 쓰겠다 ──
//  scope null(본인). 부여 scope/tool 은 매니페스트 선언의 **부분집합**만(resolveGrant, design D3).
const appGrant: Capability = {
  name: "me_app_grant",
  title: "앱 사용 동의",
  description: "이 앱을 내 자격으로 쓰겠다고 동의한다. 부여되는 권한(scope·도구)은 앱이 선언한 상한의 부분집합만 — scopes/tools 를 주면 그만큼만, 안 주면 앱 선언 전체.",
  scope: null,
  input: { app_id: z.string(), scopes: z.array(z.string()).optional(), tools: z.array(z.string()).optional() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/grant"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { app_id: (req.params as Record<string, string>)?.id, scopes: b.scopes, tools: b.tools };
      } }],
  },
  handler: async (input: Record<string, unknown>, user, ctx) => {
    const id = appId(input.app_id);
    //  #4667 — 못 보는 앱엔 동의할 수 없다(404). 상한은 **이 사람이 보는 판**의 선언 — 남의 초안이 새로 선언한 도구까지 미리 동의하지 않는다.
    const who = viewerOf(user);
    const { app } = await viewApp(await requireVisibleApp(id, who), who);
    const m = parseAppManifest(app.manifest);
    const requested = (input.scopes !== undefined || input.tools !== undefined)
      ? { scopes: input.scopes as string[] | undefined, tools: input.tools as string[] | undefined }
      : undefined;
    const g = resolveGrant(m, requested);
    const row = await store.upsertGrant(id, actorOf(user), g.scopes, g.tools, wctx(user, ctx));
    //  #4684 — 동의를 거둬 떨어졌던 앱 폴더가, 이 사람이 붙여 둔 세션에 다시 붙는다(기다리지 않는다).
    resyncSessionsWithApp(id, "동의", actorOf(user));
    return { granted: row };
  },
};

const appRevoke: Capability = {
  name: "me_app_revoke",
  title: "앱 사용 동의 철회",
  description: "이 앱에 준 내 동의를 철회한다. 이후 이 앱으로는 내 자격의 새 세션이 열리지 않는다. " +
    "revoked=true 면 이번 호출이 살아있던 동의를 껐다는 뜻이고, false 면 애초에 없었거나 이미 꺼져 있었다. 그런 앱이 없으면 404.",
  scope: null,
  input: { app_id: z.string() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/revoke"],
      parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id }) }],
  },
  handler: async (input: Record<string, unknown>, user) => {
    const id = appId(input.app_id);
    const owner = actorOf(user);
    // #2646 — 종전엔 앱 id 를 잘못 넣어도 {ok:true} 였다. 동의 철회는 사람이 «껐다»고 믿고 자리를 뜨는
    //  동작이라, 오타 하나가 살아 있는 동의를 그대로 남긴다.
    //  ⚠ 회수를 **먼저** 한다 — 앱 존재를 선검사하면 지워진 앱에 남은 동의를 영영 못 끈다(그건 더 나쁘다).
    const revoked = await store.revokeGrant(id, owner);
    await stopWorkersForMemberApp(owner, id, "grant_revoked");
    //  #4684 — 이 사람이 붙여 둔 세션에서 그 앱 폴더를 뗀다(붙인 사람의 동의가 폴더의 근거다 — folderAppsFor).
    if (revoked) resyncSessionsWithApp(id, "동의 회수", owner);
    // 아무것도 안 껐는데 그런 앱도 없다 = 오타다. (앱이 지워졌어도 살아있는 동의가 있었다면 위에서 껐으므로
    //  여기로 오지 않는다.) revoked=false 인데 앱은 있는 경우는 «이미 꺼져 있었다» — 약속된 결과 상태는
    //  성립하므로 성공이되 그 사실을 구분해 답한다.
    //  #4667 남의 나만 보는 앱도 «그런 앱이 없다» 로 — 있는지 없는지를 답으로 가르지 않는다(격리 리뷰 NB-4).
    if (!revoked) { const a = await store.getApp(id); if (!a || !canSeeApp(a, viewerOf(user))) throw new HttpError(404, `그런 앱이 없습니다: ${id}`); }
    return { ok: true, app_id: id, revoked };
  },
};

// ── 앱 설치/업데이트(관리자) — 패키지 소스 추출 → 로드 → 저널드 전개(#1780 설치 verb) ──
//  builtin 시더가 쓰는 공용 코어(installLoadedApp)를 그대로 태운다 — git/로컬경로만 다르고 설치 시맨틱은 동일.
//  같은 앱의 동시 설치/제거는 withAppInstallLock 으로 직렬화(반쯤 전개된 조인 덮어쓰기 방지, R2-5).
const appInstall: Capability = {
  name: "org_app_install",
  title: "앱 설치·업데이트",
  description: "패키지 소스에서 앱을 설치(같은 id 면 업데이트)한다. source.kind='git'(https:// url·선택 ref) · 'path'(게이트웨이 로컬 경로) · " +
    "'inline'(files=[{path, content, encoding?:'utf8'|'base64'}] — 세션이 만든 파일 묶음을 그대로 올린다. lively-app.json 필수 · 최대 200개·8MB, " +
    "MCP 로는 요청 1MB 안). 매니지드에선 게이트웨이가 세션 폴더를 못 읽으므로 path 대신 inline 을 쓴다. " +
    "데이터 테이블: 새 칸은 ADD COLUMN(칸 삭제·타입 변경은 안 함 — 응답 tables.type_mismatches) · 매니페스트에서 빠진 테이블은 비었으면 삭제, " +
    "데이터가 있으면 보관 스키마로 옮기고 설치한 사람에게 알림(tables.archived) · 워크스페이스 앱 테이블이 500개를 넘게 되면 거절(409). " +
    "저널드 2-phase — 실패 시 역순 보상. 관리자.",
  scope: "admin",
  input: { source: z.object({
    kind: z.enum(["git", "path", "inline"]), url: z.string().optional(), ref: z.string().optional(), path: z.string().optional(),
    files: z.array(z.object({ path: z.string(), content: z.string(), encoding: z.enum(["utf8", "base64"]).optional() })).optional(),
  }) },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/install"], parse: (req) => ({ source: (req.body as Record<string, unknown>)?.source }) }],
  },
  handler: async (input: Record<string, unknown>, user, ctx) => {
    const source = parseAppSource(input.source);
    const staged = await stageAppSource(source);
    try {
      const loaded = await loadAppPackage(staged.dir);
      let previousHash: string | null = null;
      const actor = actorOf(user);
      //  #4481 여러 파일 앱(web.root)은 화면 파일이 판 묶음에만 있다(설치는 매니페스트·entry HTML 만 보존한다) — 관리자 설치도 판으로 적어
      //   앱 주소가 그 판을 낸다. 파일은 **설치 전에** 저장소에 둔다 — 상한(413)·저장소 실패가 설치를 반쯤 해 둔 채(화면 파일 없는 여러 파일 앱)
      //   끝나지 않게. 화면 한 장 앱(v1)은 종전 그대로(판 이력은 처음 고칠 때 생긴다).
      const bundled = webRootOf(loaded.manifest) !== null ? await storeVersionBundle(await bundleFromDir(staged.dir)) : null;
      const outcome = await store.withAppInstallLock(loaded.manifest.id, async () => {
        const before = await store.getApp(loaded.manifest.id);
        //  같은 id 의 남의 나만 보는 앱 위에는 깔지 않는다 — 관리자 목록엔 그 앱이 서지 않으니 덮는 줄 모르고 남의 앱 코드를 바꾸게 된다(격리 리뷰 2-1).
        if (before && before.visibility === "me" && !isAppOwner(before, viewerOf(user))) {
          throw new HttpError(409, `앱 id '${before.id}' 는 다른 사람이 만들고 있는 앱(공개 전)이 쓰고 있습니다 — 다른 id 로 설치하거나, 책임자에게 넘겨받은 뒤(app_owner_set) 설치하세요`);
        }
        previousHash = before?.content_hash ?? null;
        //  #4667 — 관리자 설치는 곧 모두의 판이다. 공개 앱에 초안이 걸려 있었으면 옛 공개 판 머리를 먼저 읽어 둔다(설치 뒤엔 그 판이 선언했던 표를
        //   알 길이 없다). 표식 걷기 · 표 정리까지 설치 락 안에서 — 그 사이 끼어든 저장의 초안을 걷지 않게(격리 리뷰 B2).
        const pendingDraft = before && before.visibility === "all" && before.draft_by ? before : null;
        const oldPub = pendingDraft && pendingDraft.published_version_no != null ? await store.getAppVersionHead(pendingDraft.id, pendingDraft.published_version_no) : null;
        const out = await installLoadedApp(loaded, staged.meta, wctx(user, ctx));
        if (bundled) {
          const no = await insertVersion(out.id, { origin: "member", version: loaded.manifest.version, manifest: loaded.manifest, content_hash: loaded.contentHash, note: "관리자 설치", saved_by: actor }, bundled);
          await store.setAppCurrentVersion(out.id, no);
        }
        if (pendingDraft) {
          await store.setAppDraftBy(out.id, null);
          await store.setAppPublishedPointer(out.id, null);
          //  설치 코어는 초안 판(설치돼 있던 매니페스트)에 견줘 빠진 표만 정리한다 — 옛 공개 판에만 있던 표(초안이 빼서 공개 때까지 남겨 둔 표)는
          //   여기서 「공개하기」 처럼 정리한다(비었으면 삭제 · 데이터 있으면 보관 + 알림).
          const draftTables = new Set(declaredTableNames(pendingDraft.manifest));
          const gone = oldPub && !isBuiltinSource(pendingDraft.source) ? tablesGoneAtPublish(oldPub.manifest, loaded.manifest).filter((t) => !draftTables.has(t)) : [];
          if (gone.length) await cleanupGoneTables({ id: out.id, title: loaded.manifest.title }, gone, actor, "관리자 설치", "install");
          if (pendingDraft.draft_by && pendingDraft.draft_by !== actor) await notifyDraftDisplaced({ id: out.id, title: loaded.manifest.title }, { by: pendingDraft.draft_by, version_no: pendingDraft.current_version_no }, actor);
        }
        return out;
      });
      const workerRestart = !outcome.created && previousHash !== loaded.contentHash
        ? await restartWorkersForApp(outcome.id) : null;
      //  #4667 — 관리자 설치는 곧 공개다(칸 기본값 'all'). 새로 생긴 앱은 설치한 사람이 만든 사람·책임자.
      //  #4484 — 관리자 설치는 «공개는 빌드된 판만»(publishCurrent) 을 거치지 않는다: 관리자가 직접 고른 묶음이라 믿는 길이고, 서버(web.server)는
      //   설치한 관리자(= 저장한 사람)가 이어서 app_server_deploy 로 올린다(그 전에는 화면만 돌고 서버 호출은 «아직 없음»).
      if (outcome.created && actor !== "unknown") await store.stampAppCreatorIfMissing(outcome.id, actor).catch((err) => logger.warn({ err, id: outcome.id }, "만든 사람 기록 실패(비치명)"));
      const app = await store.getApp(outcome.id);
      return { app, created: outcome.created, components: outcome.components, tables: outcome.tables ?? null, worker_restart: workerRestart };
    } finally {
      await staged.cleanup();
    }
  },
};

// ── 앱 저장(구성원 누구나) — #4225 «워크스페이스가 마음에 안 드는 곳을 바로 고쳐 쓴다» ──
//  org_app_install(관리자)과 같은 설치 코어를 탄다(inline 파일 묶음 → 스테이지 → 로드 → 저널드 설치). 다른 것은 두 관문뿐:
//   ① 담을 수 있는 것 = 화면 + 데이터(member-app.ts memberAppViolations) ② 이미 있는 앱이면 그 앱의 고치기 설정(editDenial).
//  새 앱은 누구나 만든다 — 만든 사람이 installed_by 로 남고, 고치기 설정은 기본(전원)이다.
const appSave: Capability = {
  name: "app_save",
  title: "앱 저장(만들기·고치기)",
  description: "세션이 만든 앱 파일 묶음을 이 워크스페이스에 저장한다 — 새 id 면 만들고, 있는 id 면 고친다(재설치 = 갱신, 롤 불필요). " +
    "files=[{path, content, encoding?:'utf8'|'base64'}] · lively-app.json 필수. " +
    "★ 여러 파일 앱(#4481 — 빌드한 dist/ · 이미지 · 폰트): 매니페스트 web.root 에 화면 폴더(예 \"dist\")를 적고 ui.pages[].entry 를 그 안(예 \"dist/index.html\")으로, " +
    "그리고 files 대신 **dir**(이 세션의 프로젝트 폴더 안 앱 폴더 — 게이트웨이가 직접 읽는다)로 저장한다. 그 폴더의 파일이 전부 앱 주소에서 그 경로로 뜬다" +
    "(없는 경로는 index.html — 한 페이지 앱). app_pull 이 준 큰 파일은 content 없이 sha256 만 넣어도 된다. 판·파일 상한은 app_bundle_limits. " +
    "구성원 누구나 쓸 수 있고, 담을 수 있는 것은 **화면(ui.pages) + 데이터(data.tables) + " +
    "선언한 라이블리 도구(permissions.tools — 쓰는 사람이 동의한 만큼만)**까지다. 스킬·훅·정기 작업·MCP/HTTP 도구·서버 worker·외부 호스트·화면의 직접 네트워크는 관리자 설치(org_app_install)로만. " +
    "★ 공개 범위(#4632 · #4667): 새로 만든 앱은 **나만 보는 앱**(visibility 'me' — 만든 사람만 앱 찾기·세션에서 본다)으로 시작하고, 이미 공개된 앱을 고치면 그 판은 **저장한 사람만 보는 초안**이다 — " +
    "다른 구성원은 공개 판을 계속 쓴다. 모두에게 보이게 하려면 app_visibility_set {app_id, visibility:'all'}(또는 이 호출에 publish: true). 만든 사람·만들기 세션·사본의 원본(origin_app_id)은 서버가 기록한다(매니페스트 studio 칸은 기록이 아니다). " +
    "앱 만들기 세션이 예약해 둔 앱이 있으면 그 id 로 저장해야 한다(다른 id 면 409 가 그 id 를 알려 준다). " +
    "있는 앱은 그 앱의 고치기 설정(기본 전원 · 관리자가 지정한 사람만으로 좁힐 수 있음 · 책임자는 늘)을 따른다. " +
    "기본 앱(빌트인)도 화면·데이터만으로 된 앱이면 고칠 수 있다 — 그러면 이 워크스페이스의 판이 릴리스 원본을 덮고(데이터 표는 그대로), " +
    "원본으로 되돌리려면 app_revert(원본 판). 저장마다 판이 남는다(app_versions · note 에 요지 한 줄). " +
    "앱 화면은 평범한 웹처럼 돈다(#4482) — 폼 제출(onsubmit) · confirm · print · 내려받기가 되고, 앱 주소를 새 탭 · 폰에서 열어도 같은 SDK(window.lively)가 같은 주소의 /_lively/* 로 표 · 설정 · 앱 폴더를 쓴다(세션에 붙는 chat.send 등은 라이블리 화면 안에서만). 마이크 · 카메라는 web.devices 에 선언한 앱만. 칸 추가는 ADD COLUMN, 빠진 테이블은 비었으면 삭제·데이터 있으면 보관(공개 판이 아직 쓰는 표는 공개할 때까지 그대로). " +
    "★ 표 구조(#4724): 공개 앱의 초안에서 새 표 · 새 칸 · 풀기(not_null · 검사 빼기)는 저장 때 바로 되고, 공개 판이 쓰는 표를 깨는 변경은 공개할 때 적용된다 — " +
    "공개 판의 칸을 지우기(drop_columns) · 이름 · 종류 바꾸기 · not_null · unique · 외래키 조이기 · 기본값 더하기/바꾸기/빼기, 그 표의 새 검사 전부(새 칸 것까지), " +
    "기본값 없는 not_null 새 칸, 같은 값 기본값이 있는 칸의 unique · 외래키(옛 코드의 INSERT 는 모르는 칸을 빼고 넣는다). 목록은 응답 tables.deferred · hint — " +
    "그때까지 초안도 바뀌기 전 표로 돈다. 이름 · 종류를 바꾸려면 새 칸을 더해 쓰고 옛 칸은 공개할 때 drop_columns 로 지운다. 기본 앱의 표는 여러 워크스페이스가 나눠 써서 깨는 변경이면 409.",
  scope: null,
  input: {
    files: z.array(z.object({
      path: z.string(), content: z.string().optional(), encoding: z.enum(["utf8", "base64"]).optional(),
      sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional().describe("content 대신 — 이 워크스페이스에 이미 있는 파일의 내용 지문(app_pull 이 준 sha256). content 가 있으면 content 가 이긴다"),
    })).optional(),
    dir: z.string().max(1024).optional().describe("files 대신 — 이 세션의 프로젝트 폴더 안 앱 폴더(lively-app.json 이 있는 곳 · 프로젝트 폴더 기준 상대경로 또는 세션 안 절대경로). " +
      "게이트웨이가 그 폴더를 직접 읽는다 — 빌드한 여러 파일 앱(dist/)처럼 도구 본문에 옮겨 적을 수 없는 묶음은 이걸로. 숨김 파일(.git · .env)·node_modules · 심링크 · " +
      "비밀 열쇠 꼴 파일(*.pem · *.key · *.p12 · *.pfx · *.jks · *.keystore · id_rsa 등)은 뺀다 — 뺀 열쇠 꼴 파일 이름은 응답 skipped(꼭 실어야 하는 공개 인증서면 files 로)"),
    note: z.string().max(500).optional().describe("이 판의 요지 한 줄(판 이력에 남는다 — 예: «글 줄 칸을 아래로 · 보낸 줄 접힘»)"),
    publish: z.boolean().optional().describe("저장하면서 바로 모두에게 공개한다(app_visibility_set visibility:'all' 과 같다). 생략하면 새 앱은 나만 보는 앱, 공개 앱은 저장한 사람만 보는 초안으로 남는다. " +
      "공개한 앱의 표를 지우거나 조이는 저장이면 publish 없이 저장 → app_publish_preview 로 표에 할 일을 본 뒤 공개한다"),
    origin_app_id: z.string().max(64).optional().describe("새로 만드는 앱이 다른 앱의 사본일 때 원본 앱 id — 서버가 «원본» 으로 기록한다(있는 앱을 고칠 때는 무시)"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/save"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return { files: b.files, dir: b.dir == null || b.dir === "" ? undefined : String(b.dir), note: b.note, publish: b.publish === true ? true : undefined, origin_app_id: b.origin_app_id == null || b.origin_app_id === "" ? undefined : String(b.origin_app_id) };
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    const staged = await stageSaveInput(input, user, ctx);
    //  폴더째 저장이 뺀 비밀 열쇠 꼴 파일 이름 — 이 응답에만 싣는다(앱 행의 source 에 남기면 앱을 보는 모두에게 그 이름이 보인다 · 격리 리뷰 재검토 7).
    const skipped = takeSkipped(staged.meta);
    try {
      const loaded = await loadAppPackage(staged.dir);
      const bad = memberAppViolations(loaded.manifest);
      if (bad.length) {
        throw new HttpError(403, `이 앱은 화면·데이터 밖의 기능을 선언해서 app_save 로 저장할 수 없습니다: ${bad.join(" · ")} — 빼고 저장하거나 관리자 설치(org_app_install)를 부탁하세요`);
      }
      const harness = memberHarnessAssets(loaded);
      if (harness) throw new HttpError(403, harness);
      //  #4481 — 판 파일을 저장소에 **먼저** 둔다(상한 413 · 업로드 실패가 초안 표식·예약을 건드리기 전에 나게). 저장이 뒤에서 실패하면
      //   이 파일들은 어떤 판도 안 가리켜 하루 뒤 정리된다.
      const bundled = await storeVersionBundle(await bundleFromDir(staged.dir));
      const id = loaded.manifest.id;
      const who = viewerOf(user);
      const note = input.note == null || String(input.note).trim() === "" ? null : String(input.note).trim();
      //  #4667 — 만들기 세션 기록은 **이 사람의 세션**일 때만(요청이 말한 세션은 형식만 검증된 자기주장이다).
      const sessionId = await ownSessionOf(ctx, who.userId);
      //  앱 만들기가 이 세션에 예약해 둔 앱이 아직 비었으면 그 id 로만 — AI 가 제 id 를 지어 앱이 둘 생기지 않게(첫 저장).
      if (sessionId) {
        const reserved = (await store.findAppsByBuildSession(sessionId)).find((a) => isEmptyDraftApp(a) && isAppOwner(a, who));
        if (reserved && reserved.id !== id) {
          throw new HttpError(409, `이 만들기 세션이 만드는 앱의 id 는 '${reserved.id}' 입니다 — lively-app.json 의 id 를 '${reserved.id}' 로 바꿔 다시 저장하세요`);
        }
      }
      const r = await store.withAppInstallLock(id, async () => {
        let existing = await store.getApp(id);
        let reservedHere = false;
        if (existing) {
          //  남의 나만 보는 앱(#4632 「나만」)은 editDenial 이 막는다 — 제목을 밝히지 않고 다른 id 로 저장하라고 답한다.
          const why = editDenial(existing, who, safeManifest(existing));
          if (why) throw new HttpError(403, why);
        } else {
          //  #4667 새 앱 — 나만 보는 앱으로 먼저 예약한다. 만든 사람 · 책임자 · 만들기 세션 · 원본이 여기서 한 번 찍히고, 설치(upsertApp)는
          //   내용 칸만 채운다. 그래서 설치되는 순간에도 이 앱은 만든 사람에게만 보인다(공개로 생겼다가 닫히는 틈이 없다).
          const origin = input.origin_app_id ? await validOrigin(String(input.origin_app_id), id, who) : null;
          //  #4778 — 같은 id 의 앱 폴더가 남아 있으면(지운 앱의 것) 먼저 보관으로 옮긴다. 새 앱은 빈 앱 폴더로 시작한다(못 보면 503).
          await archiveLeftoverAppFolder(id, who.userId);
          if (!(await store.reserveDraftApp({ id, title: loaded.manifest.title, made_by: who.userId, build_session: sessionId, origin_app_id: origin }, wctx(user, ctx)))) {
            throw new HttpError(409, `앱 id '${id}' 를 다른 저장이 막 만들었습니다 — 잠시 뒤 다시 저장하세요`);
          }
          reservedHere = true;
          existing = await store.getApp(id);
          if (!existing) throw new HttpError(500, `앱 '${id}' 예약 뒤 행을 읽지 못했습니다`);
        }
        const app0 = existing;
        const firstFill = isEmptyDraftApp(app0);
        //  공개 앱 — 초안을 깔기 **전에** 지금 모두가 보는 판을 판 행에 못 박는다(나머지는 그 판을 계속 본다).
        const published = app0.visibility === "all" ? await pinPublished(app0, who.userId) : null;
        //  #4724 초안 = «개인 대상 프로덕션»(상민 2026-10-15) — 공개 판을 쓰는 사람들의 옛 코드가 같은 물리 표를 쓰는 동안, 그 코드를 깨는
        //   표 변경(칸 지우기·이름·형 바꾸기·조이기 …)은 공개할 때까지 미룬다(설치가 공개 판의 칸을 지킨다 — protect). 새 표·새 칸은 바로 생긴다.
        //  기본 앱(여러 워크스페이스가 나눠 쓰는 공유 표)은 늘 지키므로 미뤄도 할 수 없다 — 초안 표식을 걸기 전에 거절한다.
        if (isBuiltinSource(app0.source)) await assertSharedTablesAccept(id, app0.manifest, loaded.manifest);
        const claim = published ? await claimDraft(app0, who.userId) : null;
        //  #4600 — 이력이 비어 있는 나만 보는 앱을 처음 고치면 지금 상태를 먼저 판으로 떠 둔다(예약만 된 빈 앱은 떠 둘 것이 없다).
        if (!published && !firstFill && (await store.listAppVersions(id)).length === 0) {
          await snapshotCurrentVersion(app0, who.userId, "저장 전 상태");
        }
        //  빌트인을 고치면 source 는 kind 'builtin' 을 유지한 채 overrides_builtin 이 붙는다(app-versions.ts 머리 — 데이터 표가 사는 스키마가 그 값으로 갈린다).
        //  그러면 부팅 시딩이 이 앱을 덮지 않는다(seed.ts seedShouldSkipOverride).
        const meta = isBuiltinSource(app0.source) ? overrideSourceMeta(staged.meta, id) : staged.meta;
        //  판 행을 **설치 전에** 먼저 쓴다(격리 리뷰 7c) — 설치가 됐는데 판 기록이 없는 상태(되돌릴 곳 없음)를 만들지 않는다.
        //  설치가 실패하면 그 행을 거둔다(best-effort — 남아도 current_version_no 가 안 가리키므로 is_current 가 아니다).
        const versionNo = await insertVersion(id, {
          origin: "member", version: loaded.manifest.version, manifest: loaded.manifest,
          content_hash: loaded.contentHash, note, saved_by: who.userId,
        }, bundled);
        let outcome;
        try {
          //  공개 판이 선언한 표는 초안이 빼도 지우지 않는다 — 공개 판을 쓰는 사람들의 데이터다(「공개하기」 가 그때 정리한다).
          outcome = await installLoadedApp(loaded, meta, wctx(user, ctx), {
            keepTables: published ? declaredTableNames(published.manifest) : [],
            protect: published ? declaredColumnsOf(published.manifest) : undefined,
          });
        } catch (e) {
          await store.deleteAppVersions(id, [versionNo]).catch((err) => logger.warn({ err, id, versionNo }, "설치 실패 뒤 판 행 회수 실패(비치명)"));
          if (reservedHere) await dropEmptyDraft(id, who.userId).catch((err) => logger.warn({ err, id }, "설치 실패 뒤 예약 행 회수 실패(비치명)"));
          if (claim && claim.before !== who.userId) await store.setAppDraftBy(id, claim.before).catch((err) => logger.warn({ err, id }, "설치 실패 뒤 초안 표식 되돌리기 실패(비치명 — 공개 판 쪽으로 틀린다)"));
          throw e;
        }
        await store.setAppCurrentVersion(id, versionNo);
        //  예약 행이 설치 도중 사라졌다가(오래된 빈 예약 정리와 엇갈림) 설치 코어가 칸 기본값('all')으로 다시 만들었으면 나만 보는 앱으로 되돌린다
        //   (격리 리뷰 NB-13 — 드물지만 새 앱이 공개로 생기는 틈을 남기지 않는다).
        if (reservedHere || firstFill) {
          const now = await store.getApp(id);
          if (now && now.visibility !== "me") await store.markAppPrivate(id, wctx(user, ctx));
          if (now && !now.made_by) await store.stampAppCreatorIfMissing(id, who.userId);
        }
        if (published) await settleDraft(id, who.userId, (outcome.tables?.deferred.length ?? 0) > 0);
        if (claim?.displaced) await notifyDraftDisplaced({ id, title: loaded.manifest.title }, claim.displaced, who.userId);
        const { pub, pubError } = input.publish === true ? await tryPublish(id, who, wctx(user, ctx)) : { pub: null, pubError: null };
        await pruneVersions(id).catch((err) => logger.warn({ err, id }, "판 보관 정리 실패(비치명 — 다음 저장이 다시 정리)"));
        return { outcome, versionNo, created: reservedHere || firstFill, pub, pubError };
      });
      const versionNo = r.versionNo;
      //  #4484 서버 앱 — 이 저장이 공개까지 했으면 공개 판의 서버를 옮긴다 · 아니면 «서버는 아직 이 판으로 빌드 안 됨» 을 알린다(저장은 빌드하지 않는다).
      const server = r.pub?.changed ? await serverAfterPublish(id) : null;
      const bs = !server && serverDeclOf(loaded.manifest) && appServerEnv() ? await installedBuildState((await store.getApp(id))!).catch(() => null) : null;
      const serverNote = !bs ? null : {
        state: bs.deployed ? "deployed" : bs.built ? "built" : "not_built", declared: true, built: bs.built, deployed: bs.deployed,
        hint: bs.deployed ? "이 판의 서버는 이미 올라가 있습니다(같은 코드 — 매니페스트만 바뀌었다)"
          : bs.built ? `같은 코드의 빌드가 있어 app_server_deploy {app_id:'${id}'} 하면 빌드 없이 바로 올라갑니다`
            : `서버(web.server)는 저장만으로 빌드되지 않습니다 — 이 판을 시험하려면 app_server_deploy {app_id:'${id}'}(이 세션에서 빌드 · 몇 분), 사람은 앱 만들기 「이대로 넣기」`,
      };
      //  세션 옆 앱 칸이 이 사건을 받아 그 앱 화면을 다시 띄운다(«N판 · 방금 고침 · 되돌리기»). 공개 판이 바뀌었으면 그 앱을 붙여 둔 사람들에게도.
      publishAppEvent(who.userId, { kind: "updated", app_id: id, session: null, version_no: versionNo, note, source: ctx?.source });
      if (r.pub?.changed) for (const m of await attachedMembers(id)) if (m !== who.userId) publishAppEvent(m, { kind: "updated", app_id: id, session: null, version_no: versionNo, note, source: ctx?.source });
      const app = await store.getApp(r.outcome.id);
      const state = app?.visibility === "me" ? "me" : app?.draft_by ? "draft" : "published";
      if (r.pubError) throw publishFailed(state === "me" ? `${versionNo}판을 나만 보는 앱으로 저장했습니다` : `${versionNo}판을 초안으로 저장했습니다(저장한 사람만 봅니다)`, r.pubError);
      const deferredNow = state === "draft" ? (r.outcome.tables?.deferred ?? []) : [];
      //  #4724 publish:true — 설치가 미뤄 둔 변경은 이어진 공개가 바로 적용했다(그 일을 보고서에 합치고 «미룸» 은 비운다).
      const tables = r.outcome.tables ?? null;
      if (tables && r.pub?.tables) { mergeReport(tables, r.pub.tables); tables.deferred = []; }
      return {
        app, created: r.created, tables, version_no: versionNo,
        visibility: app?.visibility ?? null, state, ...(skipped.length ? { skipped } : {}),
        ...(server ? { server } : serverNote ? { server: serverNote } : {}),
        hint: state === "me" ? `나만 보는 앱으로 저장했습니다(책임자에게만 보임) — 워크스페이스 모두가 쓰게 하려면 app_visibility_set {app_id:'${id}', visibility:'all'}`
          : state === "draft" ? `초안으로 저장했습니다 — ${versionNo}판은 저장한 사람에게만 보이고 다른 구성원은 공개 판을 계속 씁니다. 모두에게 내보내려면 app_visibility_set {app_id:'${id}', visibility:'all'}`
            + (deferredNow.length ? ` · 공개 판이 쓰는 칸이라 공개할 때 반영할 표 변경 ${deferredNow.length}개: ${deferredNow.map((d) => d.change).join(" · ")}`
              + " — 그때까지 이 초안도 바뀌기 전 칸으로 돈다(이름·종류를 바꾸려면 새 칸을 더해 쓰고, 옛 칸은 공개할 때 drop_columns 로 지운다)" : "")
            : `${versionNo}판이 공개 판입니다(워크스페이스 모두가 봅니다)`,
      };
    } finally {
      await staged.cleanup();
    }
  },
};

// ── 앱 소스 내려받기(#4600) — 「AI 에게 고치기」 의 첫 걸음 ──
//  지금 서빙 중인 판의 파일 묶음을 그대로 준다. 세션의 AI 가 이걸 폴더에 풀어 고친 뒤 app_save 로 올린다.
//  빌트인은 폴더 전체(bin/·README 포함 — 장표 수정 앱의 세션 스크립트가 거기 있다), 덮어쓴 빌트인은 폴더 위에 DB 의 매니페스트·화면,
//  세션이 만든 앱은 DB(매니페스트 + 화면)만 — 설치가 보존하는 것이 그 둘뿐이다.
const appPull: Capability = {
  name: "app_pull",
  title: "앱 소스 내려받기",
  description: "앱의 지금 서빙 중인 판을 파일 묶음(files=[{path, content, encoding?}])으로 준다 — 고치려면 이걸 폴더에 풀어 고치고 app_save {files, note} 로 올린다. " +
    "기본 앱(빌트인)은 패키지 폴더 전체(bin/ 의 세션 스크립트 · README 포함), 워크스페이스가 덮어쓴 기본 앱은 그 위에 지금 화면, 세션이 만든 앱은 매니페스트 + 화면. " +
    "source_kind · overrides_builtin · builtin_version(폴더의 릴리스 판) · current_version_no 도 함께. 구성원 누구나.",
  scope: null,
  input: {
    app_id: z.string(),
    dir: z.string().max(1024).optional().describe("#4481 내용을 응답에 싣는 대신 이 세션의 프로젝트 폴더 안 새 폴더(없거나 빈 폴더)에 판 파일을 푼다 — 큰 여러 파일 앱으로 사본을 뜰 때"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/apps/:id/pull"], parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id }) }],
  },
  //  #4667 — 보는 사람의 판을 준다: 초안을 만든 사람(과 나만 보는 앱의 책임자)은 설치된 상태, 나머지는 공개 판의 파일 묶음.
  //   그래서 남의 앱 「내 사본」 은 늘 모두가 쓰는 공개 판에서 떠진다(남의 초안이 사본에 섞이지 않는다).
  //  #4481 — 판 행(공개 판 · 지금 내용 그대로인 판)이 있으면 그 묶음을 준다. 줄마다 sha256 · size 를 싣고, 큰 판(2MB 넘음)은 작은 글 파일만 내용,
  //   나머지는 지문만 — 지문만 받은 줄은 그대로 app_save files 에 다시 넣으면 된다(앱 만들기 화면의 사본 · 설정 바꾸기가 이 길).
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    const id = appId(input.app_id);
    const who = viewerOf(user);
    const installed = await requireVisibleApp(id, who);
    if (isEmptyDraftApp(installed)) throw new HttpError(404, `앱 '${id}' 은(는) 아직 첫 판이 없습니다 — 먼저 app_save 로 저장하세요`);
    const view = appViewFor(installed, who);
    const pub = view === "published" ? await store.getAppVersion(id, installed.published_version_no as number) : null;
    const cur = !pub && installed.current_version_no != null ? await store.getAppVersion(id, installed.current_version_no) : null;
    const row = pub ?? (cur && cur.content_hash != null && cur.content_hash === installed.content_hash ? cur : null);
    const base = row ? null : await currentPackageFiles(installed);
    const from = row ? "version" as const : (base as { from: "version" | "folder" | "folder+db" | "db" }).from;
    //  #4481 여러 파일 앱인데 판 묶음이 없다 — DB 로 되살리면 dist/ 가 빠진 묶음을 사본·고치기 재료로 주게 된다.
    if (from === "db" && webRootOf(installed.manifest) !== null) {
      throw new HttpError(409, `「${installed.title || id}」 의 파일 묶음을 찾지 못했습니다 — 앱 폴더에서 다시 저장한 뒤 내려받으세요`);
    }
    const app = pub ? asPublished(installed, pub) : installed;
    const src = (app.source ?? {}) as { kind?: unknown };
    const head = {
      app_id: id, title: app.title, version: app.version, source_kind: String(src.kind ?? ""), overrides_builtin: isOverrideSource(app.source),
      builtin_version: app.builtin_version, current_version_no: app.current_version_no, from,
      view: pub ? "published" : "installed", visibility: installed.visibility,
    };
    if (input.dir != null && String(input.dir).trim() !== "") {
      const { acc, shown } = await sessionDirAccess(ctx, who.userId, input.dir);
      const vb = row ? versionBundle(row) : null;
      const items = vb ? bundleFilesToWrite(vb.kind, vb.bundle) : ((row ? row.files : (base as { files: AppFile[] }).files) as AppFile[]).map((f) => {
        const bytes = Buffer.from(f.content, f.encoding === "base64" ? "base64" : "utf8");
        return { p: f.path, s: bytes.length, read: async () => bytes };
      });
      const written = await writeFilesToDir(acc, shown, items);
      return { ...head, dir: shown, written, files: items.map((x) => ({ path: x.p, size: x.s })) };
    }
    const pulled = await pullFiles(row ?? { files: (base as { files: AppFile[] }).files });
    return {
      ...head, files: pulled.files,
      ...(pulled.refs ? { refs: pulled.refs, hint: `큰 판이라 파일 ${pulled.refs}개는 내용 없이 지문(sha256)만 실었습니다 — 고쳐 저장할 땐 그 줄을 그대로 app_save files 에 넣으면 되고(내용 없이 sha256), 파일 내용이 필요하면 app_pull {app_id, dir} 로 세션 폴더에 푸세요` } : {}),
    };
  },
};

// ── 앱 판 이력(#4600) ──
const appVersions: Capability = {
  name: "app_versions",
  title: "앱 판 이력",
  description: "앱 코드의 판 목록(최신 먼저) — version_no · origin('builtin'=릴리스 원본 · 'member'=구성원이 저장) · version · note(요지) · saved_by · saved_at · is_current. " +
    "되돌리기는 app_revert {app_id, version_no}. 구성원 판은 최근 20개만 남고 원본 판은 늘 남는다. 구성원 누구나.",
  scope: null,
  input: { app_id: z.string() },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/apps/:id/versions"], parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id }) }],
  },
  //  #4667 — is_current 는 **이 사람이 지금 보는 판**(공개 판을 보는 사람에겐 공개 판) · is_published 는 모두가 보는 판(공개 앱만).
  handler: async (input: Record<string, unknown>, user: LivelyUser) => {
    const id = appId(input.app_id);
    const who = viewerOf(user);
    const app = await requireVisibleApp(id, who);
    const sees = appViewFor(app, who) === "published" ? app.published_version_no : null;
    const pubNo = app.visibility === "all" ? (app.draft_by ? app.published_version_no : null) : null;
    //  남의 공개 전 판(마지막 공개 뒤 다른 사람이 저장한 판)은 그 사람 · 책임자 · 관리자에게만 선다(격리 리뷰 NB-6).
    const since = publishedAtMs(app);
    const versions = (await store.listAppVersions(id)).filter((v) => !isOthersPendingVersion(app, v, who, since)).map((v) => ({
      ...v,
      is_current: sees != null ? v.version_no === sees : isCurrentVersion(app, v),
      //  초안이 없으면 설치된 상태가 곧 공개 판이다 — 그 판(내용 기준)을 공개 판으로 표시한다.
      is_published: app.visibility === "all" && (pubNo != null ? v.version_no === pubNo : isCurrentVersion(app, v)),
    }));
    return {
      app_id: id, current_version_no: sees ?? app.current_version_no, builtin_version: app.builtin_version, overrides_builtin: isOverrideSource(app.source), versions,
      visibility: app.visibility, published_version_no: app.visibility === "all" ? (pubNo ?? versions.find((v) => v.is_published)?.version_no ?? null) : null,
      draft: app.visibility === "all" && app.draft_by && (app.draft_by === who.userId || isAppOwner(app, who) || isAdminViewer(who)) ? { by: app.draft_by, version_no: app.current_version_no } : null,
    };
  },
};

// ── 앱 「개발 정보」(#4632, 원준 2026-10-26 «코드를 SSOT로 해서 코드 내용을 자연어로 번역해준 … 앱에 대한 명세») ──
//  보는 사람이 지금 쓰는 판(app_pull 과 같은 판 — 공개 판 또는 내 초안)의 코드로 두 층을 준다:
//   facts = 코드에서 바로 읽은 것(apps/app-spec.specFacts — 열 때마다 계산 · 늘 코드와 같다) · spec = AI 가 쓴 쉬운 말 설명(판의 코드 지문마다 · apps/app-spec-run).
//  그 판의 설명이 아직 없으면 이 자리가 쓰기 시작한다(새 판 저장 뒤의 예약을 놓쳤거나 되돌린 판). 실패한 설명은 저절로 다시 쓰지 않는다 — regenerate 로.
const appSpec: Capability = {
  name: "app_spec",
  title: "앱 개발 정보(코드 기준 명세)",
  description: "앱의 「개발 정보」 — 지금 보는 판의 코드를 기준으로 한 명세. facts(코드에서 바로 읽은 것: 화면 · 표와 칸 · 권한 · 바깥 호출과 그 자리 파일:줄 · 파일 목록)와 " +
    "spec(AI 가 코드를 읽고 쓴 쉬운 말 설명: 요약 · 화면 · 저장하는 정보 · 기능 · 바깥 서비스와 API · 권한 · 한계 · 이번 버전에서 달라진 점). " +
    "설명은 새 판이 저장되면 저절로 다시 쓰인다. spec_state: ok(이 판 기준) · stale(앞 판 설명 · 새로 쓰는 중) · writing · failed · unavailable(워크스페이스 API 키 없음) · limit(오늘 쓸 몫을 다 씀). " +
    "regenerate:true 면 이 판 설명을 다시 쓴다(실패했을 때). 구성원 누구나(볼 수 있는 앱만).",
  scope: null,
  input: { app_id: z.string(), regenerate: z.boolean().optional() },
  expose: {
    mcp: true,
    rest: [
      { method: "GET", paths: ["/api/ui/apps/:id/spec"], parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id }) },
      { method: "POST", paths: ["/api/ui/apps/:id/spec"], parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id, regenerate: (req.body as Record<string, unknown> | undefined)?.regenerate === true }) },
    ],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser) => {
    const id = appId(input.app_id);
    const who = viewerOf(user);
    const installed = await requireVisibleApp(id, who);
    if (isEmptyDraftApp(installed)) throw new HttpError(404, `앱 '${id}' 은(는) 아직 첫 판이 없습니다 — 먼저 app_save 로 저장하세요`);
    //  보는 판 — app_pull 과 같은 판정(#4667 공개 판 · 초안을 만든 사람은 설치된 상태).
    const view = appViewFor(installed, who);
    const pub = view === "published" ? await store.getAppVersion(id, installed.published_version_no as number) : null;
    const cur = !pub && installed.current_version_no != null ? await store.getAppVersion(id, installed.current_version_no) : null;
    const row = pub ?? (cur && cur.content_hash != null && cur.content_hash === installed.content_hash ? cur : null);
    const versionNo = row ? row.version_no : (pub ? installed.published_version_no : installed.current_version_no) ?? null;
    const contentHash = row ? row.content_hash : installed.content_hash ?? null;
    const { specFacts, specKeyOf, decideSpec } = await import("../apps/app-spec.js");
    const specStore = await import("../apps/app-spec-store.js");
    const run = await import("../apps/app-spec-run.js");
    const key = specKeyOf(contentHash, versionNo);
    //  판의 파일은 설명을 쓰기 시작할 때와 사실을 처음 읽을 때만 꺼낸다 — 화면은 쓰는 동안 6초마다 다시 묻는다(사실은 지문마다 run.factsCache).
    let target: import("../apps/app-spec-run.js").SpecTarget | null = null;
    const loadTarget = async (): Promise<import("../apps/app-spec-run.js").SpecTarget> => target ??= {
      versionNo, contentHash, manifest: row ? row.manifest : installed.manifest,
      files: row ? await versionFiles(row) : (await currentPackageFiles(installed)).files,
    };
    const available = await run.specAvailable();
    const rows = await specStore.listAppSpecs(id);
    //  대신 보일 앞 판 설명은 이 사람이 볼 수 있는 판의 것만 — app_versions 와 같은 판정(남의 공개 전 판 빼기 · 격리 리뷰 NB-6 · #4632 격리 리뷰).
    const since = publishedAtMs(installed);
    const visible = new Set((await store.listAppVersions(id)).filter((v) => !isOthersPendingVersion(installed, v, who, since)).map((v) => v.version_no));
    const budget = await run.specBudgetOk();
    let d = decideSpec(key, versionNo, rows, { now: Date.now(), available, visible, budget });
    let retryAfter: number | null = null;
    //  「다시 만들기」 는 실패한 이 판에만 — 다 쓴 · 쓰는 중인 설명은 그대로 둔다(누를 때마다 돈이 나가지 않게).
    if (input.regenerate === true && d.failed && available && !budget) d = { ...d, failed: null, limit: true };   // 다시 쓸 몫이 없다고 말한다(격리 리뷰 N2)
    else if (input.regenerate === true && d.failed && available) {
      //  다시 쓰기 간격(1분) 안이면 쓰기를 맡지 않는다(writeAppSpec 이 'busy' 로 조용히 돌아와 화면은 같은 실패 문구로 돌아갔다) — 언제 다시 누를지 알린다(감사 4-11).
      const lastStart = await specStore.lastSpecStart(id);
      const wait = lastStart == null ? 0 : lastStart + run.SPEC_FORCE_GAP_MS - Date.now();
      if (wait > 0) retryAfter = wait;
      else {
        void run.writeAppSpec(id, await loadTarget(), { force: true }).catch(() => { /* 행에 까닭이 남는다 */ });
        d = { ...d, failed: null, writing: true };
      }
    } else if (d.kick) {
      void run.writeAppSpec(id, await loadTarget(), { force: false }).catch(() => { /* 행에 까닭이 남는다 */ });
    }
    const state = d.unavailable ? "unavailable" : d.show && !d.stale ? "ok" : d.failed ? "failed" : d.limit ? "limit" : d.stale ? "stale" : "writing";
    const facts = await run.factsCache(id, key, async () => { const t = await loadTarget(); return specFacts(t.manifest, t.files); });
    const doc = d.show ? await specStore.getAppSpecDoc(id, d.show.content_hash) : null;
    return {
      //  제목도 보는 사람의 판 이름 — 공개 판을 보는 사람에게 공개 전 새 이름이 새지 않게(감사 6-4).
      app_id: id, title: (pub && typeof (pub.manifest as { title?: unknown } | null)?.title === "string" && (pub.manifest as { title: string }).title) || installed.title, version_no: versionNo, content_hash: contentHash, view: pub ? "published" : "installed",
      facts,
      spec_state: state, spec_error: state === "failed" ? d.failed : null, retry_after_ms: retryAfter,
      spec: d.show && doc ? { version_no: d.show.version_no, made_at: d.show.made_at ? new Date(d.show.made_at).toISOString() : null, model: d.show.model, doc } : null,
    };
  },
};

// ── 앱 되돌리기(#4600) — 어느 판으로든, 원본(릴리스)으로도 ──
//  권한은 app_save 와 같다(editDenial). 되돌리기 직전의 지금 상태도 판으로 떠 둔다(되돌리기도 되돌릴 수 있게) — 다만 지금 상태가
//  이미 어떤 판 그대로면(current_version_no 의 content_hash 일치) 같은 것을 두 번 적지 않는다.
//  원본 판(origin 'builtin')으로 가면 패키지 폴더에서 **빌트인으로 재설치**한다 — 덮어쓰기 표식이 걷히고 부팅 시딩이 다시 따라붙는다.
const appRevert: Capability = {
  name: "app_revert",
  title: "앱 되돌리기",
  description: "앱 코드를 app_versions 의 어느 판으로 되돌린다(데이터 표는 그대로). 원본 판(origin 'builtin')이면 릴리스 원본으로 재설치돼 워크스페이스 덮어쓰기가 풀린다. " +
    "되돌리기 직전 지금 상태를 먼저 판으로 떠 둔다. 권한은 app_save 와 같다(그 앱의 고치기 설정). " +
    "공개 앱에서 공개 판이 아닌 판으로 되돌리면 그것도 되돌린 사람만 보는 초안이다(#4667) — 모두에게 그 판을 쓰게 하려면 publish: true(또는 뒤이어 app_visibility_set visibility:'all'). " +
    "표 구조는 app_save 와 같은 규칙(#4724): 공개 판이 쓰는 칸을 깨는 변경은 공개할 때 적용되고 응답 deferred 에 목록이 온다 · 기본 앱의 표를 깨는 판으로는 409.",
  scope: null,
  input: {
    app_id: z.string(), version_no: z.number().int().positive(),
    publish: z.boolean().optional().describe("되돌린 판을 바로 모두에게 공개한다(앱빌더 「배포 설정 ▸ 이 판으로」) — 표에 할 일은 먼저 app_publish_preview {version_no} 로 본다"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/revert"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return { app_id: (req.params as Record<string, string>)?.id, version_no: Number(b.version_no), publish: b.publish === true ? true : undefined };
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    const id = appId(input.app_id);
    const target = Number(input.version_no);
    if (!Number.isInteger(target) || target < 1) throw new HttpError(400, "version_no 는 1 이상의 정수여야 합니다");
    const who = viewerOf(user);
    const result = await store.withAppInstallLock(id, async () => {
      const app = await store.getApp(id);
      if (!app || !canSeeApp(app, who)) throw new HttpError(404, `앱 없음: ${id}`);
      const why = editDenial(app, who, safeManifest(app));
      if (why) throw new HttpError(403, why);
      const ver = await store.getAppVersion(id, target);
      //  남의 공개 전 판은 없는 판과 같다 — 되돌려서 공개하는 길로 남의 초안을 대신 내보내지 않게(격리 리뷰 NB-6).
      if (!ver || isOthersPendingVersion(app, ver, who, publishedAtMs(app))) throw new HttpError(404, `앱 '${id}' 에 ${target}판이 없습니다`);
      //  #4667 공개 앱 — 되돌리기도 설치다. 지금 모두가 보는 판을 먼저 판 행에 못 박는다(되돌린 판이 공개 판과 다르면 되돌린 사람의 초안이 된다).
      const published = app.visibility === "all" ? await pinPublished(app, who.userId) : null;
      //  «이미 그 판» 은 내용(해시)으로 — 번호가 달라도 내용이 같으면 할 일이 없다(가리키는 번호만 맞춘다).
      if (isCurrentVersion(app, ver)) {
        if (app.current_version_no !== target) await store.setAppCurrentVersion(id, target);
        const pub = input.publish === true ? await publishCurrent(id, who, wctx(user, ctx)) : null;
        return { app: await store.getApp(id), version_no: target, changed: !!pub?.changed, published: !!pub?.changed };
      }

      //  #4724 — app_save 와 같은 규칙: 공개 판의 칸은 지키고(깨는 변경은 공개할 때) · 기본 앱의 공유 표를 깨는 판으로는 되돌리지 않는다
      //   (판을 떠 두기 전에 — 거절하면 아무것도 남기지 않는다). 원본 판(릴리스)으로 가는 길은 부팅 시딩과 같은 것을 까니 보지 않는다.
      if (isBuiltinSource(app.source) && !(ver.origin === "builtin" && (await hasPackageDir(builtinAppDir(id))))) await assertSharedTablesAccept(id, app.manifest, ver.manifest);
      // 지금 상태가 어느 판 그대로가 아니면 먼저 떠 둔다.
      const cur = app.current_version_no == null ? null : await store.getAppVersion(id, app.current_version_no);
      if (!cur || !isCurrentVersion(app, cur)) await snapshotCurrentVersion(app, who.userId, "되돌리기 직전");
      const keepTables = published ? declaredTableNames(published.manifest) : [];
      const protect = published && target !== published.no ? declaredColumnsOf(published.manifest) : undefined;
      let deferred: Array<{ table: string; change: string }> = [];
      const claim = published ? await claimDraft(app, who.userId) : null;
      try {
        const builtinLineage = isBuiltinSource(app.source);
        const dir = builtinAppDir(id);
        if (ver.origin === "builtin" && builtinLineage && (await hasPackageDir(dir))) {
          //  원본으로 — 폴더(지금 실린 릴리스)에서 빌트인으로 재설치. 덮어쓰기 표식이 걷힌다.
          const loaded = await loadAppPackage(dir);
          await installLoadedApp(loaded, { kind: "builtin" }, wctx(user, ctx), { keepTables, protect });
          //  떠 둔 원본 판은 처음 고친 날의 릴리스다. 그 사이 릴리스가 올랐으면 방금 깐 것과 다르다 — 원본 판을 **지금 깐 것**으로 맞춘다
          //   (안 맞추면 판 이력에 «지금» 이 없고, 다음 되돌리기가 원본을 한 벌 더 떠 둔다). 실패해도 되돌리기 자체는 끝났다(로그만).
          const fresh = await store.getApp(id);
          if (fresh && !isCurrentVersion(fresh, ver)) {
            await currentPackageFiles(fresh)
              .then(({ files }) => refreshOrigin(id, target, {
                version: fresh.version, manifest: fresh.manifest, content_hash: fresh.content_hash, note: `원본 · 릴리스 ${fresh.version}`,
              }, bundleFromFiles(files)))
              .catch((err) => logger.warn({ err, id, target }, "원본 판을 지금 릴리스로 맞추지 못했다(비치명 — 되돌리기는 끝났다)"));
          }
        } else {
          //  #4481 — 판 묶음은 저장소에서 풀어 깐다(옛 inline 상한 8MiB 를 지나지 않는다 · 여러 파일 앱 되돌리기). 옛 판은 종전 inline 길.
          const staged = await stageVersion(ver);
          try {
            const loaded = await loadAppPackage(staged.dir);
            if (loaded.manifest.id !== id) throw new HttpError(409, `${target}판의 매니페스트 id(${loaded.manifest.id})가 앱 id 와 다릅니다`);
            const bad = memberAppViolations(loaded.manifest);
            if (bad.length) throw new HttpError(403, `${target}판은 화면·데이터 밖의 기능을 선언해서 app_save 경로로 되돌릴 수 없습니다: ${bad.join(" · ")}`);
            const harness = memberHarnessAssets(loaded);
            if (harness) throw new HttpError(403, `${target}판 — ${harness}`);
            const out = await installLoadedApp(loaded, builtinLineage ? overrideSourceMeta(staged.meta, id) : staged.meta, wctx(user, ctx), { keepTables, protect });
            deferred = out.tables?.deferred ?? [];
          } finally {
            await staged.cleanup();
          }
        }
      } catch (e) {
        if (claim && claim.before !== who.userId) await store.setAppDraftBy(id, claim.before).catch((err) => logger.warn({ err, id }, "되돌리기 실패 뒤 초안 표식 되돌리기 실패(비치명 — 공개 판 쪽으로 틀린다)"));
        throw e;
      }
      if (claim?.displaced) await notifyDraftDisplaced({ id, title: app.title }, claim.displaced, who.userId);
      await store.setAppCurrentVersion(id, target).catch((err) => logger.warn({ err, id, target }, "되돌린 판 번호 기록 실패(비치명 — is_current 는 해시로 판정)"));
      //  공개 판 그 자체로 되돌렸으면 초안이 없다 — 해시로 견주지 않는다: 못 박아 둔 판(저장 전 상태 · 되돌리기 직전)의 파일은 DB 에서 다시 엮은 것이라
      //   다시 깔면 내용 해시가 원래와 달라질 수 있다(매니페스트 재직렬화). 그 밖의 판은 해시로 맞춘다.
      if (published) { if (target === published.no) await store.setAppDraftBy(id, null); else await settleDraft(id, who.userId, deferred.length > 0); }
      const { pub, pubError } = input.publish === true ? await tryPublish(id, who, wctx(user, ctx)) : { pub: null, pubError: null };
      await pruneVersions(id).catch((err) => logger.warn({ err, id }, "판 보관 정리 실패(비치명)"));
      return { app: await store.getApp(id), version_no: target, changed: true, published: !!pub?.changed, deferred: pub?.changed ? [] : deferred, pubError };
    });
    if (result.changed) publishAppEvent(who.userId, { kind: "updated", app_id: id, session: null, version_no: target, note: `되돌림 → ${target}판`, source: ctx?.source });
    //  #4484 서버 앱 — 공개까지 했으면 공개 판의 서버를 옮기고(기다린다), 되돌리기만이면 그 판의 빌드가 있을 때 cur 를 뒤에서 따라가게 한다
    //   (빌드 없음 · 함수 판을 새로 올리면 수십 초 — 되돌리기 응답을 붙잡지 않는다). 빌드가 없던 판이면 서버는 그대로다(app_server_status 에 보인다).
    let server: Awaited<ReturnType<typeof afterPublishServer>> | { state: "following"; following: true; message: string } | null = null;
    if (result.published && !("pubError" in result && result.pubError)) server = await serverAfterPublish(id);
    else if (result.changed && result.app && serverDeclOf(result.app.manifest) && appServerEnv()) {
      const app1 = result.app;
      const p = await appServerPolicy();
      //  #4792 함수가 없는 앱이 워크스페이스 함수 수 상한에 닿았으면 뒤에서 옮기다 조용히 멈추지 말고 지금 알린다(격리 리뷰 — 줄이 없어 last_error 를 적을 곳이 없다).
      const capWhy = await newFunctionDenial(app1.id, p).catch(() => null);
      if (capWhy) server = { ok: false, state: "failed", message: `서버를 되돌린 판으로 옮기지 못했습니다: ${capWhy}` };
      else {
        void afterRevertServer(app1, p).catch((err) => logger.warn({ err, id }, "되돌린 뒤 앱 서버 따라가기 실패(비치명)"));
        server = { state: "following", following: true, message: "그 판의 서버 빌드가 있으면 뒤에서 cur 를 옮깁니다 — app_server_status 로 보세요" };
      }
    }
    if (result.published) for (const m of await attachedMembers(id)) if (m !== who.userId) publishAppEvent(m, { kind: "updated", app_id: id, session: null, version_no: target, note: `되돌림 → ${target}판`, source: ctx?.source });
    const after = result.app;
    if ("pubError" in result && result.pubError) {
      throw publishFailed(after?.visibility === "me" ? `${target}판으로 되돌렸습니다` : `${target}판으로 되돌렸습니다(초안 — 되돌린 사람만 봅니다)`, result.pubError);
    }
    //  #4724 공개 판이 쓰는 칸이라 공개할 때로 미룬 표 변경 — app_save 응답의 tables.deferred 와 같은 모양.
    const deferred = "deferred" in result ? result.deferred : [];
    return {
      ok: true, app_id: id, version_no: result.version_no, changed: result.changed, app: after,
      visibility: after?.visibility ?? null, state: after?.visibility === "me" ? "me" : after?.draft_by ? "draft" : "published",
      deferred, ...(server ? { server } : {}),
    };
  },
};

// ── 공개 범위(#4632 app_visibility_set · #4667 공개 판 · 초안) · 만들기 시작(초안 앱 예약) · 책임자 · 나만 보는 앱 지우기 ──
//  판정은 apps/visibility.ts(publishDenial · unpublishDenial · isAppOwner). 모두 설치 락 안에서 — 저장·되돌리기와 엇갈리지 않게.
const appVisibilitySet: Capability = {
  name: "app_visibility_set",
  title: "앱 공개 범위",
  description: "앱의 공개 범위를 정한다. 'all' = 「공개하기」 — 나만 보는 앱('me')이면 워크스페이스 모두에게 처음 공개하고, 공개한 앱에 초안(고친 사람만 보는 판)이 있으면 " +
    "그 초안을 모두가 쓰는 판으로 올린다(이미 공개 판 그대로면 changed=false). 공개 판이 바뀌면 다른 구성원의 앱 찾기 · 세션 옆 앱 · 그 세션의 AI 지침이 그 판을 쓰고, " +
    "옛 공개 판에만 있던 데이터 표는 이때 정리한다(비었으면 삭제 · 데이터 있으면 보관). 초안 저장 때 공개 판이 쓰는 칸이라 미뤄 둔 표 변경(칸 지우기 · 이름 · 형 바꾸기 · 조이기)도 " +
    "이때 적용한다 — 있던 데이터가 새 규칙에 어긋나면 409(몇 행인지)로 공개하지 않는다(어느 표도 바뀌지 않고 초안은 그대로). 'me' = 「나만」 으로 되돌리기 — 다른 구성원은 그 순간부터 이 앱을 열지 못하고 " +
    "그 세션의 AI 도 이 앱 표를 못 쓴다(데이터 · 판 이력 · 동의는 그대로라 다시 공개하면 이어서 쓴다). " +
    "'all' 전에 app_publish_preview 로 표에 할 일(지울 칸 · 조이기 · 막힐 행)을 볼 수 있다. " +
    "누가: 나만 보는 앱의 공개 · 'me' 로 되돌리기 = 책임자 · 관리자 / 공개 앱의 초안 공개 = 그 초안을 고친 사람 · 책임자 · 관리자. 기본 앱(빌트인)은 'me' 로 못 바꾼다. " +
    "app_save 로 새로 생긴 앱과 앱 만들기가 예약한 앱은 'me' 로 시작한다.",
  scope: null,
  input: { app_id: z.string(), visibility: z.enum(["all", "me"]) },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/visibility"], parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id, visibility: (req.body as Record<string, unknown>)?.visibility }) }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    const id = appId(input.app_id);
    const v = String(input.visibility ?? "");
    if (!APP_VISIBILITIES.includes(v as AppVisibility)) throw new HttpError(400, "visibility 는 'all' 또는 'me'");
    const who = viewerOf(user);
    if (v === "all") {
      const out = await store.withAppInstallLock(id, () => publishCurrent(id, who, wctx(user, ctx)));
      if (out.changed) {
        const ev = { kind: "updated" as const, app_id: id, session: null, version_no: out.version_no ?? undefined, note: `${out.version_no ?? ""}판 공개`, source: ctx?.source };
        publishAppEvent(who.userId, ev);
        for (const m of await attachedMembers(id)) if (m !== who.userId) publishAppEvent(m, ev);
        //  #4684 — 다시 공개하면 «나만» 일 때 떨어졌던 남의 세션에 앱 폴더가 다시 붙는다.
        resyncSessionsWithApp(id, "공개");
      }
      const app = await store.getApp(id);
      //  #4484 서버 앱 — 공개 판의 서버 빌드를 함수의 pub · cur 로(설치 락 밖에서 · 실패해도 공개는 됐다).
      const server = out.changed ? await serverAfterPublish(id) : null;
      //  tables — 공개하며 적용한 표 변경(초안이 미뤄 둔 칸 지우기 · 이름 · 형 바꾸기 · 조이기 — 지운 칸의 값은 dropped_columns.archived_as 에 보관).
      return { ok: true, app_id: id, visibility: app?.visibility ?? "all", version_no: out.version_no, changed: out.changed, published_at: app?.published_at ?? null, tables: out.tables ?? null, ...(server ? { server } : {}) };
    }
    const changed = await store.withAppInstallLock(id, async () => {
      const app = await requireVisibleApp(id, who);
      if (isBuiltinSource(app.source)) throw new HttpError(409, `기본 앱(빌트인) '${id}' 은 「나만」 으로 바꿀 수 없습니다 — 끄려면 org_app_set_enabled`);
      const why = unpublishDenial(app, who);
      if (why) throw new HttpError(403, why);
      if (app.visibility === "me") return false;
      //  초안이 걸려 있으면 막는다 — 「나만」 의 판은 하나(설치된 상태)라 남의 초안이 책임자의 판이 되고, 다시 공개하면 아무도 「공개하기」 를 누르지 않은
      //   그 초안이 나간다(격리 리뷰 2-3). 초안을 공개하거나 공개 판으로 되돌린 뒤(app_revert) 바꾸게 한다.
      if (app.draft_by) {
        throw new HttpError(409, `「${app.title || id}」 에 ${app.draft_by === who.userId ? "내" : `${app.draft_by} 님의`} 초안이 걸려 있어 「나만」 으로 바꿀 수 없습니다 — 초안을 공개하거나, 판 목록에서 공개 판(${app.published_version_no ?? "?"}판)으로 되돌린 뒤 바꾸세요`);
      }
      await store.markAppPrivate(id, wctx(user, ctx));
      return true;
    });
    //  붙여 둔 다른 사람들의 앱 칸이 곧바로 다시 읽게 — 그 사람들에겐 이제 없는 앱이다(격리 리뷰 2-5).
    if (changed) {
      const ev = { kind: "updated" as const, app_id: id, session: null, note: "「나만」 으로 바꿈", source: ctx?.source };
      publishAppEvent(who.userId, ev);
      for (const m of await attachedMembers(id)) if (m !== who.userId) publishAppEvent(m, ev);
      //  #4684 — 남이 붙여 둔 세션에서는 그 앱 폴더도 떨어진다(붙인 사람이 이제 못 보는 앱 — folderAppsFor).
      resyncSessionsWithApp(id, "「나만」 으로 바꿈");
    }
    return { ok: true, app_id: id, visibility: "me", changed };
  },
};

// ── 공개 미리 보기(#4732) — 「공개하기」 · 「이 판으로」(되돌려 공개) 전에 표에 할 일을 본다. 아무것도 바꾸지 않는다 ──
//  읽기전용(#1007) 세션에선 막힌다(POST 파생 = 쓰기) — 아무것도 바꾸지 않지만 진짜 표에 DDL 을 걸었다 되돌리고, 미리 보는 까닭인 공개가
//   읽기전용에선 어차피 막힌다. 읽기로 열면 «POST 인데 읽기» 예외 목록(readonly.test)만 늘어난다.
/** 미리 보기가 설치 락(저장 · 공개 · 되돌리기)을 기다리는 상한 — 다른 저장이 끝나기를 1분씩 말없이 기다리지 않게. */
const PREVIEW_INSTALL_LOCK_WAIT_MS = 3_000;
const appPublishPreview: Capability = {
  name: "app_publish_preview",
  title: "공개 미리 보기",
  description: "공개하기 전에 «이번 공개가 표에 무엇을 하는지» 본다 — 아무것도 바꾸지 않는다. version_no 없음 = 지금 app_visibility_set visibility:'all' 을 하면 · " +
    "version_no 있음 = app_revert {version_no, publish:true} 를 하면. changes = 할 일(칸 지우기와 값이 있는 행 수 — 값은 따로 보관 · 이름 · 종류 바꾸기 · " +
    "꼭 채우기 · 겹치는 값 막기 · 다른 표 가리키기 · 새 값 검사 · 기본값 · 새 판에 없는 표의 정리) · blocked = 이대로 공개하면 409 로 멈추는 까닭(표 · 칸 · 행 수 — " +
    "그 행을 고친 뒤 다시 본다) · incomplete = 그 표를 지금 쓰는 사람이 있거나 표가 커서 다 보지 못함(잠시 뒤 다시). changes 가 비었으면 표에 할 일이 없다. " +
    "notes = 바뀌는 일은 아니지만 알아 둘 것(새 판에 없지만 값을 지키려고 남겨 둔 칸 · 종류를 못 바꿔 그대로 둔 칸). " +
    "실제 공개와 같은 표 맞추기를 한 트랜잭션으로 걸어 보고 되돌려 계산한다 — 그동안 바뀌는 표를 잠근다(보통 1초 안쪽 · 잠금 대기 1.5초 · 문장마다 5초 · 전체 8초를 넘으면 남은 표는 incomplete). " +
    "누가: 공개할 수 있는 사람(version_no 면 되돌릴 수 있는 사람). 나만 보는 앱의 첫 공개 · 초안 없는 공개 앱 · 기본 앱은 할 일이 없다.",
  scope: null,
  input: { app_id: z.string(), version_no: z.number().int().min(1).optional() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/publish-preview"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return { app_id: (req.params as Record<string, string>)?.id, ...(b.version_no == null ? {} : { version_no: Number(b.version_no) }) };
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser) => {
    const id = appId(input.app_id);
    const v = input.version_no == null ? null : Number(input.version_no);
    if (v != null && (!Number.isInteger(v) || v < 1)) throw new HttpError(400, "version_no 는 1 이상의 정수여야 합니다");
    //  저장 · 되돌리기 · 공개와 같은 설치 락 안에서 — 걸어 보는 동안 다른 설치가 같은 표를 바꾸지 않게(서로 잠금을 기다리다 멈추지 않게).
    //   다른 저장 · 공개가 쥐고 있으면 짧게만 기다리고 «다 못 봄» 으로 돌려준다(화면이 말없이 멈춰 있지 않게).
    try {
      return await store.withAppInstallLock(id, () => previewPublish(id, viewerOf(user), v), { waitMs: PREVIEW_INSTALL_LOCK_WAIT_MS });
    } catch (err) {
      if ((err as { code?: unknown })?.code !== store.APP_INSTALL_LOCK_TIMEOUT) throw err;
      const busy: PublishPreview = {
        app_id: id, kind: v == null ? "publish" : "revert", version_no: v, published_version_no: null,
        changes: [], notes: [], blocked: [], tables: null, gone_tables: [],
        incomplete: "이 앱을 다른 사람(또는 다른 창)이 지금 저장 · 공개하고 있어 보지 못했습니다 — 잠시 뒤 다시 보세요",
      };
      return busy;
    }
  },
};

/** 예약 앱 id 의 뒤 6자 — 소문자·숫자(매니페스트 id 규칙). */
const rand6 = (): string => Array.from({ length: 6 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[randomInt(36)]).join("");

const appBuildStart: Capability = {
  name: "app_build_start",
  title: "앱 만들기 시작(초안 앱 예약)",
  description: "앱 만들기 세션을 시작할 때 부른다 — 비어 있는 «나만 보는 앱» 을 만들고 그 id 를 돌려준다(만든 사람 = 나 · 만들기 세션 = session_id). " +
    "그 세션의 AI 는 이 id 로 app_save 해야 한다(다른 id 로 저장하면 409 가 이 id 를 알려 준다). 같은 세션으로 다시 부르면 같은 앱을 돌려준다(멱등). " +
    "app_id 를 주면 이미 있는 앱에 이 세션을 만들기 세션으로 잇는다(책임자일 때만 — 아니면 bound=false 로 그대로 둔다). session_id 생략 = 이 요청을 보낸 세션 자신. 자기 세션만.",
  scope: null,
  input: {
    session_id: z.string().max(128).optional().describe("만들기 세션 id — 생략하면 이 요청을 보낸 세션"),
    title: z.string().max(200).optional().describe("앱 이름(비우면 «새 앱» — AI 가 첫 저장 때 매니페스트 title 로 바꾼다)"),
    app_id: z.string().max(64).optional().describe("이미 있는 앱을 이 세션에서 이어 고칠 때 그 앱 id"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/build-start"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return { session_id: b.session_id == null ? undefined : String(b.session_id), title: b.title == null ? undefined : String(b.title), app_id: b.app_id == null || b.app_id === "" ? undefined : String(b.app_id) };
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    const who = viewerOf(user);
    if (!who.userId || who.userId === "unknown") throw new HttpError(401, "인증이 필요합니다");
    const sid = String(input.session_id ?? "").trim() || String(ctx?.session ?? "").trim();
    if (!sid) throw new HttpError(400, "세션을 특정할 수 없습니다 — session_id 를 넘기세요");
    const owner = await sessionOwnerOf(sid).catch(() => null);
    if (!owner) throw new HttpError(404, `세션을 찾을 수 없습니다: ${sid}`);
    if (owner !== who.userId) throw new HttpError(403, "자기 세션만 앱 만들기 세션으로 쓸 수 있습니다");
    if (input.app_id) {
      const app = await requireVisibleApp(appId(input.app_id), who);
      const bound = isAppOwner(app, who);
      if (bound && app.build_session !== sid) await store.setAppBuildSession(app.id, sid);
      return { app_id: app.id, created: false, bound, build_session: bound ? sid : app.build_session && isAdminViewer(who) ? app.build_session : null, visibility: app.visibility };
    }
    const mine = (await store.findAppsByBuildSession(sid)).find((a) => isAppOwner(a, who));
    if (mine) return { app_id: mine.id, created: false, bound: true, build_session: sid, visibility: mine.visibility, empty: isEmptyDraftApp(mine) };
    //  그만둔 만들기가 남긴 빈 예약(첫 판 없이 사흘 지난 내 것)은 새로 시작할 때 거둔다 — 따로 도는 청소 잡을 두지 않는다.
    await dropStaleDrafts(who.userId).catch((err) => logger.warn({ err, member: who.userId }, "오래된 빈 예약 앱 정리 실패(비치명)"));
    const title = String(input.title ?? "").trim().slice(0, 200) || "새 앱";
    for (let i = 0; i < 6; i++) {
      const id = draftAppIdFrom(title, rand6());
      //  #4778 — 새 id 라도 같은 이름의 앱 폴더가 남아 있으면 먼저 보관으로 옮긴다(app_save 의 새 id 와 같은 규칙 · 설치 락 안에서 «없음» 을 본다).
      const reserved = await store.withAppInstallLock(id, async () => {
        if (await store.getApp(id)) return false;
        await archiveLeftoverAppFolder(id, who.userId);
        return store.reserveDraftApp({ id, title, made_by: who.userId, build_session: sid, origin_app_id: null }, wctx(user, ctx));
      });
      if (reserved) {
        return { app_id: id, created: true, bound: true, build_session: sid, visibility: "me", empty: true };
      }
    }
    throw new HttpError(503, "앱 id 를 정하지 못했습니다 — 다시 시도해 주세요");
  },
};

const appOwnerSet: Capability = {
  name: "app_owner_set",
  title: "앱 책임자 바꾸기",
  description: "앱의 책임자(지금 책임지는 사람 — 앱 자동화의 책임자 · 실패 알림 대상 · 나만 보는 앱을 볼 수 있는 사람)를 바꾼다. member_id 를 비우면(null) «관리자». " +
    "만든 사람(made_by) 기록은 바뀌지 않는다. 만든 사람이 떠나면 책임자는 저절로 관리자로 넘어온다 — 다른 구성원에게 맡길 때 쓴다. 관리자.",
  scope: "admin",
  input: { app_id: z.string(), member_id: z.string().max(200).nullable().optional() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/owner"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return { app_id: (req.params as Record<string, string>)?.id, member_id: b.member_id == null || b.member_id === "" ? null : String(b.member_id) };
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    const id = appId(input.app_id);
    const member = input.member_id == null || String(input.member_id).trim() === "" ? null : String(input.member_id).trim();
    if (!(await store.getApp(id))) throw new HttpError(404, `앱 없음: ${id}`);
    if (member) {
      const m = await getMember(member);
      if (!m || m.state !== "active") throw new HttpError(404, `활성 구성원이 아닙니다: ${member}`);
    }
    const after = await store.setAppOwner(id, member, wctx(user, ctx));
    return { ok: true, app_id: id, owner_member: after?.owner_member ?? null, made_by: after?.made_by ?? null };
  },
};

const appDraftRemove: Capability = {
  name: "app_draft_remove",
  title: "나만 보는 앱 지우기",
  description: "아직 공개하지 않은(나만 보는) 앱을 지운다 — 그만둔 앱 만들기의 초안 정리. 데이터가 있으면 지우기 직전에 떠 둔다(7일, app_data_snapshots). " +
    "앱 폴더(apps/<앱>/)는 보관으로 옮긴다(응답 app_folder · 7일 뒤 지움). 책임자·관리자. 공개한 앱은 관리자가 org_app_remove 로 지운다.",
  scope: null,
  input: { app_id: z.string() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/discard"], parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id }) }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    const id = appId(input.app_id);
    const who = viewerOf(user);
    return store.withAppInstallLock(id, async () => {
      const app = await requireVisibleApp(id, who);
      if (app.visibility !== "me") throw new HttpError(409, `「${app.title || id}」 은(는) 공개한 앱이라 관리자가 지웁니다(org_app_remove) — 먼저 「나만」 으로 되돌리면(app_visibility_set visibility:'me') 여기서 지울 수 있습니다`);
      if (isBuiltinSource(app.source)) throw new HttpError(409, `기본 앱(빌트인) '${id}' 은 지울 수 없습니다`);
      if (!isAppOwner(app, who) && !isAdminViewer(who)) throw new HttpError(403, `「${app.title || id}」 은(는) 책임자와 관리자만 지울 수 있습니다`);
      return { ok: true, removed: id, ...(await removeInstalledApp(app, wctx(user, ctx), "discard")) };
    });
  },
};

// ── 누가 이 앱을 고칠 수 있나(관리자) — #4225 ──
const appEditPolicySet: Capability = {
  name: "app_edit_policy_set",
  title: "앱 고치기 설정",
  description: "이 앱을 누가 고칠 수 있는지(app_save) 정한다. mode='all' — 구성원 전원(기본) · mode='members' — members 에 적은 사람만(관리자는 늘 된다). " +
    "기본 앱(빌트인)은 고칠 수 없어 설정 대상이 아니다. 관리자.",
  scope: "admin",
  input: { app_id: z.string(), mode: z.enum(["all", "members"]), members: z.array(z.string().max(200)).max(500).optional() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/edit-policy"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return { app_id: (req.params as Record<string, string>)?.id, mode: b.mode, members: b.members };
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    const id = appId(input.app_id);
    const app = await requireVisibleApp(id, viewerOf(user));
    //  #4600 — 화면·데이터만으로 된 빌트인은 이제 고칠 수 있으므로 고치기 설정도 뜻이 있다. 셸 렌더러 같은 그 밖 빌트인만 설정 대상이 아니다.
    if (isBuiltinSource(app.source)) {
      const m = safeManifest(app);
      if (!m || memberAppViolations(m).length) throw new HttpError(400, "이 기본 앱(빌트인)은 화면·데이터만으로 된 앱이 아니라 고칠 수 없어 고치기 설정이 없습니다");
    }
    const mode = input.mode === "members" ? "members" : "all";
    const members = Array.isArray(input.members) ? (input.members as unknown[]).map(String) : [];
    const after = await store.setAppEditPolicy(id, mode, members, wctx(user, ctx));
    return { app_id: id, edit_mode: after?.edit_mode ?? mode, edit_members: after?.edit_members ?? [] };
  },
};

// ── 앱 제거(관리자) — 전개물 회수 + 레지스트리 삭제 ──
//  전개된 대상(하네스 자산·크론·툴·호스트 병합)은 CASCADE 밖(별도 스토어)이라 **먼저 reclaim** 한 뒤 앱 행을 지운다
//  (조인 component/grant 는 deleteApp 이 CASCADE). builtin 은 제거해도 부팅 시 재시드되므로 막고 enabled 토글로 안내.
const appRemove: Capability = {
  name: "org_app_remove",
  title: "앱 제거",
  description: "앱과 그 전개물(하네스 자산·크론·툴·호스트)을 회수하고 레지스트리에서 삭제한다. 데이터 표와 그 앱의 보관 표(archives)는 지우기 직전 떠 둔다(7일, app_data_snapshots). "
    + "앱 폴더(apps/<앱>/)는 보관으로 옮긴다(응답 app_folder — 같은 id 로 새로 만든 앱은 빈 앱 폴더로 시작 · 7일 뒤 지움 · app_folder_archives · 되돌리기 app_folder_restore). "
    + "builtin(코드 소유) 앱은 제거 대신 org_app_set_enabled 로 끈다(부팅 재시드). 관리자.",
  scope: "admin",
  input: { app_id: z.string() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/remove"], parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id }) }],
  },
  handler: async (input: Record<string, unknown>, user, ctx) => {
    const id = appId(input.app_id);
    return store.withAppInstallLock(id, async () => {
      const app = await requireVisibleApp(id, viewerOf(user));
      const src = (app.source ?? {}) as { kind?: string };
      if (src.kind === "builtin") throw new HttpError(409, `builtin 앱 '${id}' 은 제거 대신 org_app_set_enabled 로 끄세요(부팅 시 재시드됩니다)`);
      //  지우는 순서(회수 → 데이터 떠 두기 → 테이블 → 앱 폴더 보관 → 인스턴스 → 앱 행)는 공용 코어에 있다 — 시더의 은퇴 앱 회수와 같은 길(#4554).
      return { ok: true, removed: id, ...(await removeInstalledApp(app, wctx(user, ctx), "remove")) };
    });
  },
};

// ── 앱 활동 관측(관리자) — mcp_call_log.app 집계. design D3-5(관측 전용, 권한 판정 불사용) ──
//  앱 세션/UI 가 자기 자격으로 부른 도구를 앱별·도구별로 집계(호출수·성공/실패·최근시각). 인자·actor 는 노출 안 함.
const appActivityCap: Capability = {
  name: "org_app_activity",
  title: "앱 활동 로그",
  description: "설치된 앱들이 자기 자격으로 호출한 도구 활동을 앱별·도구별로 집계한다(호출수·성공/실패·최근시각). app_id 를 주면 그 앱만, days 로 기간(기본 7·최대 365). 관측 전용. 관리자.",
  scope: "memory",
  input: { app_id: z.string().optional(), days: z.number().optional() },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/app-activity"], parse: (req) => {
      const q = (req.query ?? {}) as Record<string, unknown>;
      return { app_id: q.app_id, days: q.days == null ? undefined : Number(q.days) };
    } }],
  },
  handler: async (input: Record<string, unknown>) => {
    const id = input.app_id ? appId(input.app_id) : null;
    const days = input.days != null && Number.isFinite(Number(input.days)) ? Number(input.days) : 7;
    return { activity: await store.appActivity(id, days) };
  },
};

/**
 * 화면 파일이 없다 — 서버가 화면을 만드는 앱(#4485 · web.server)이면 종전 화면(srcdoc)으로는 못 열고 앱 주소로만 열린다고 말한다
 *  (앱 주소 쿠키를 막는 브라우저가 라이블리 안에서 이 길로 온다 — 새 탭은 된다). 그 자리엔 «새 탭에서 열기» 단추가 없을 수 있어 주소를 글에 싣는다.
 */
function noUiPage(id: string, manifest: unknown, appUrl: string | null): HttpError {
  return new HttpError(404, serverDeclOf(manifest) && appServerEnv()
    ? `앱 '${id}' 은(는) 서버가 화면을 만드는 앱이라 이 화면에서는 열 수 없습니다 — 새 탭에서 앱 주소${appUrl ? `(${appUrl})` : ""}로 열어 주세요`
    : `앱 '${id}' 에 UI 페이지가 없습니다`);
}

// ── 앱 UI 페이지 서빙(#1780 PR5) — 샌드박스 srcdoc iframe 용 entry HTML ──
//  정적 URL 이 아니라 **인증 API**로 준다: 앱 UI 는 호스트가 fetch → sandbox="allow-scripts" srcdoc 으로 실어
//  오리진 격리(불투명)·네트워크 없음. tools/call 은 postMessage 로 호스트가 앱 grant 로 제약(PR5b). scope null —
//  설치된(active·enabled) 앱의 UI 는 워크스페이스 멤버가 열 수 있다(브리지 없이는 아무 부작용 없는 정적 표시).
const appUi: Capability = {
  name: "org_app_ui",
  title: "앱 UI 페이지",
  description: "설치된 앱의 UI 페이지/위젯 entry HTML 을 준다(샌드박스 iframe srcdoc 용). page 미지정이면 첫 페이지. 앱이 active·enabled 여야 한다.",
  scope: null,
  input: { app_id: z.string(), page: z.string().optional() },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/apps/:id/ui", "/api/ui/apps/:id/ui/:page"],
      parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id, page: (req.params as Record<string, string>)?.page }) }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser) => {
    const id = appId(input.app_id);
    const who = viewerOf(user);
    const app = await requireVisibleApp(id, who);   // #4667 — 남이 만들고 있는(나만 보는) 앱의 화면은 404
    if (app.status !== "active" || !app.enabled) throw new HttpError(409, `앱 '${id}' 이 활성 상태가 아닙니다`);
    //  #4667 공개 판을 보는 사람 — 설치된 화면(초안을 만든 사람의 판)이 아니라 공개 판 행의 파일에서 화면을 꺼낸다.
    if (appViewFor(app, who) === "published") {
      const pub = await publishedScreens(id, app.published_version_no as number);
      if (pub) {
        //  #4481 — 화면 entry 파일만 꺼낸다(판 묶음이면 저장소에서 그 파일만 · 앱 주소 · 앱 열기와 같은 자리).
        const ui = uiPagesFromFiles(pub.manifest, pub.files);
        if (ui.length === 0) throw noUiPage(id, pub.manifest, appAddressUrlFor(app, who, null));
        const pick = input.page ? ui.find((u) => u.page_key === String(input.page)) : ui[0];
        if (!pick) throw new HttpError(404, `UI 페이지 없음: ${String(input.page)}`);
        const csp = { ...(((pub.manifest as { csp?: unknown } | null)?.csp ?? {}) as Record<string, unknown>), files: await filesCspSource(pub.manifest) };
        const multi = webRootOf(pub.manifest) !== null;
        const appUrl = appAddressUrlFor(app, who, input.page ? pick.page_key : null);
        return { app_id: id, page_key: pick.page_key, kind: pick.kind, title: pick.title, html: multi ? multiFileFallbackHtml(pick.title ?? app.title, appUrl) : pick.html, pages: ui.map((u) => ({ page_key: u.page_key, kind: u.kind, title: u.title })), csp, view: "published", app_url: appUrl, ...(multi ? { multi_file: true } : {}) };
      }
      logger.warn({ app: id, published: app.published_version_no }, "공개 판 행이 없어 설치된 화면을 준다(#4667 불변식)");
    }
    const pages = await store.listUiAssets(id);
    if (pages.length === 0) throw noUiPage(id, app.manifest, appAddressUrlFor(app, who, null));
    const key = input.page ? String(input.page) : pages[0].page_key;
    const a = await store.getUiAsset(id, key);
    if (!a) throw new HttpError(404, `UI 페이지 없음: ${key}`);
    // csp = 매니페스트 선언(없으면 빈 객체 = 네트워크·프레임 0). 호스트(app-ui.ts)가 이걸로 srcdoc CSP 를 짓는다 —
    //  선언에 없는 것은 브라우저가 막는다(우리 코드가 아니라 브라우저가 집행하는 경계).
    //  #4673 앱 폴더를 선언한 앱은 그 서명 주소 자리(files)를 더 연다 — files/app-screen-csp.
    const csp = { ...(((app.manifest as { csp?: unknown } | null)?.csp ?? {}) as Record<string, unknown>), files: await filesCspSource(app.manifest) };
    //  #4481 여러 파일 앱(web.root)은 앱 주소에서만 돈다 — srcdoc(이 길)으로는 /assets/… 를 못 싣는다. 쿠키가 막힌 브라우저가 이 길로 오면 까닭을 보인다.
    const multi = webRootOf(app.manifest) !== null;
    //  #4482 맨 앱 주소 — 화면이 「새 탭에서 열기」 를 그린다(쿠키가 막힌 브라우저도 새 탭은 맨 위 페이지라 된다).
    const appUrl = appAddressUrlFor(app, who, input.page ? a.page_key : null);
    return { app_id: id, page_key: a.page_key, kind: a.kind, title: a.title, html: multi ? multiFileFallbackHtml(a.title ?? app.title, appUrl) : a.html, pages, csp, view: "installed", app_url: appUrl, ...(multi ? { multi_file: true } : {}) };
  },
};

// ── 앱 데이터 떠 둔 것 보기·되돌리기(#4226, 관리자) ──
//  워크스페이스가 만든 앱의 데이터를 하루 한 번(+ 제거·되돌리기 직전) 떠 둔다(7일). AI 가 자유 SQL 로 행을 잘못 지웠을 때
//  한 워크스페이스·한 앱만 그 시점으로 되돌리는 길이다(RDS 백업은 DB 전체 단위라 이게 안 된다).
const appDataSnapshots: Capability = {
  name: "app_data_snapshots",
  title: "앱 데이터 떠 둔 것 목록",
  description: "워크스페이스가 만든 앱의 데이터를 떠 둔 목록(하루 한 번 + 앱 제거·되돌리기·보관 표 비우기 직전, 7일 보관). app_id 를 주면 그 앱만. "
    + "항목 = 시각·까닭(daily·before-remove·before-restore·before-clear)·테이블별 행 수. 보관 표는 «archive:<이름>»(archive:true)으로 담기고 되살리지 않는다. 관리자.",
  scope: "admin",
  input: { app_id: z.string().optional() },
  expose: {
    mcp: true,
    //  /api/ui/apps/snapshots 는 앞서 마운트된 GET /api/ui/apps/:id(org_app_get)에 가려진다(매니지드 끝단 실측) — app-activity 와 같은 모양으로.
    rest: [{ method: "GET", paths: ["/api/ui/app-snapshots"], parse: (req) => ({ app_id: (req.query as Record<string, unknown>)?.app_id }) }],
  },
  handler: async (input: Record<string, unknown>) => {
    const id = input.app_id == null || input.app_id === "" ? null : String(input.app_id);
    return { snapshots: await listAppSnapshots(id) };
  },
};

const appDataRestore: Capability = {
  name: "app_data_restore",
  title: "앱 데이터 되돌리기",
  description: "떠 둔 시점(taken_at — app_data_snapshots 의 값 그대로)으로 앱 테이블을 되돌린다. table 을 주면 그 테이블만, 없으면 그 묶음의 테이블 전부. "
    + "이 워크스페이스 행을 통째로 그 시점으로 바꾸고(원래 id 유지), 되돌리기 직전 지금 상태를 먼저 떠 둔다(before-restore — 되돌리기도 되돌릴 수 있다). 직전 상태를 못 떠 두면(너무 큰 앱) force 없이는 멈춘다. "
    + "묶음에 담긴 보관 표(archive:…)는 되살리지 않고 건너뛴다(archives_skipped). 관리자.",
  scope: "admin",
  input: { app_id: z.string(), taken_at: z.string(), table: z.string().optional(), force: z.boolean().optional().describe("되돌리기 직전 상태를 떠 두지 못해도(너무 큰 앱 등) 되돌린다 — 되돌린 것을 다시 되돌릴 수 없다") },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/restore"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return { app_id: (req.params as Record<string, string>)?.id, taken_at: b.taken_at, table: b.table, force: b.force };
    } }],
  },
  handler: async (input: Record<string, unknown>) => {
    const id = appId(input.app_id);
    return store.withAppInstallLock(id, async () => {
      const table = input.table == null || input.table === "" ? null : String(input.table);
      const out = await restoreAppSnapshot(id, String(input.taken_at ?? ""), table, { force: input.force === true });
      return { ok: true, app_id: id, restored: out.restored, before_restore: out.safety.taken_at, archives_skipped: out.archives_skipped };
    });
  },
};

// ── 앱 보관 표 보기·비우기(#4733, 관리자) ──
//  앱 표를 선언에서 빼거나(데이터가 있을 때) 칸을 지우면(drop_columns · 값이 있을 때) 데이터를 잃지 않으려고 보관 자리로 옮긴다
//  (store-schema). 보관 표도 워크스페이스 표 개수 한도에 세어지는데 앱을 고쳐서는 줄지 않는다 — 관리자가 보고 비운다(백업 뒤).
//  앱을 지우면 그 앱의 보관 표는 제거가 함께 지운다(remove-run). 판정 · 이름 규칙은 apps/archive-meta.ts, 실행은 apps/app-archive.ts.
const appArchivesList: Capability = {
  name: "app_archives",
  title: "앱 보관 표 목록",
  description: "이 워크스페이스의 앱 보관 표 — 앱 표를 선언에서 빼거나(데이터가 있을 때) 칸을 지울 때(drop_columns, 값이 있을 때) 데이터를 잃지 않으려고 옮겨 둔 표. "
    + "항목 = name(비우기에 그대로) · app_id · owner(recorded 보관할 때 남긴 기록 · guessed 이름으로 짐작 · unknown 주인 모름) · kind(table 표 통째 · column 지운 칸의 값) · "
    + "table · column · rows · bytes · archived_at · reason(install 설치·저장 · publish 공개). 보관 표도 워크스페이스 표 개수 한도에 센다(table_limit). "
    + "app_id 를 주면 그 앱 것만. 비우기는 app_archive_clear. 관리자.",
  scope: "admin",
  input: { app_id: z.string().optional() },
  expose: {
    mcp: true,
    //  /api/ui/apps/archives 는 앞서 마운트된 GET /api/ui/apps/:id(org_app_get)에 가려진다 — app-snapshots 와 같은 모양으로.
    rest: [{ method: "GET", paths: ["/api/ui/app-archives"], parse: (req) => ({ app_id: (req.query as Record<string, unknown>)?.app_id }) }],
  },
  handler: async (input: Record<string, unknown>) => {
    const id = input.app_id == null || input.app_id === "" ? null : appId(input.app_id);
    const { schema, archives } = await listAppArchives(id);
    const counts = await appTableCounts(appSchemaFor(false));
    return { schema, archives, count: archives.length, bytes: archives.reduce((n, a) => n + a.bytes, 0), table_limit: counts };
  },
};

const appArchiveClear: Capability = {
  name: "app_archive_clear",
  title: "앱 보관 표 비우기",
  description: "앱 보관 표를 지운다 — 지우기 직전 앱 데이터 백업(app_data_snapshots · 7일 · «archive:<이름>» · 까닭 before-clear)에 담는다. 되살리기는 하지 않는다(백업에만 남는다). "
    + "names(app_archives 의 name 그대로) 또는 app_id(그 앱의 보관 표 전부) 중 하나. 보관 자리에 없는 이름은 건드리지 않고 missing 으로 알린다. "
    + "백업하기엔 너무 크거나 백업이 실패하면 지우지 않고 kept 로 알린다 — force 를 주면 백업 없이 지운다(되살릴 길이 없다). 지우면 표 개수 한도 셈(table_limit)이 준다. "
    + "주인 모름 보관 표의 백업은 app_id '~unknown' 으로 담긴다(app_data_snapshots {app_id:'~unknown'}). 관리자.",
  scope: "admin",
  input: {
    names: z.array(z.string()).optional(),
    app_id: z.string().optional(),
    force: z.boolean().optional().describe("백업하지 못해도(너무 큼 · 실패) 지운다 — 지운 것을 되살릴 길이 없다"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/app-archives/clear"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return { names: b.names, app_id: b.app_id, force: b.force };
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    //  REST 는 zod 를 거치지 않는다 — 모양이 틀린 names 를 조용히 [] 로 읽고 app_id 로 그 앱 것을 전부 지우지 않게 거절한다(격리 리뷰).
    if (input.names != null && !Array.isArray(input.names)) throw new HttpError(400, "names 는 보관 표 이름의 배열이어야 합니다");
    const names = Array.isArray(input.names) ? [...new Set(input.names.map((n) => String(n ?? "").trim()).filter(Boolean))] : [];
    const id = input.app_id == null || input.app_id === "" ? null : appId(input.app_id);
    if (!names.length && !id) throw new HttpError(400, "names(보관 표 이름들) 또는 app_id 가 필요합니다 — app_archives 로 목록을 보세요");
    if (names.length && id) throw new HttpError(400, "names 와 app_id 중 하나만 주세요");
    const run = async (): Promise<Record<string, unknown>> => {
      const list = names.length ? names : (await listAppArchives(id, { countRows: false })).archives.map((a) => a.name);
      const out = await clearAppArchives(list, { reason: "before-clear", force: input.force === true });
      //  표를 지우는 관리자 동작 — 누가 무엇을 지웠고 무엇이 남았나를 감사에 남긴다(백업은 7일이면 사라진다).
      if (out.cleared.length || out.kept.length) {
        await audit("app_archive", id ?? null, "clear", { names: list, force: input.force === true },
          { cleared: out.cleared, kept: out.kept, backup_taken_at: out.taken_at }, user?.userId, ctx?.source).catch((err) => logger.warn({ err }, "보관 표 비우기 감사 기록 실패(비치명)"));
      }
      return { ok: true, ...out, table_limit: await appTableCounts(appSchemaFor(false)) };
    };
    //  앱 단위로 비우면 그 앱의 설치 · 공개(보관 표를 새로 만들 수 있다)와 엇갈리지 않게 같은 잠금 안에서.
    return id ? store.withAppInstallLock(id, run) : run();
  },
};

// ── 앱 폴더 보관 보기 · 비우기 · 되돌리기 · 고아 옮기기(#4778, 관리자) ──
//  앱을 지우면 그 앱 폴더(apps/<앱>/)는 apps 주소로 닿지 않는 보관 자리로 옮겨지고(remove-run), 보관 기간(앱 데이터 떠 두기와 같은 7일)이 지나면
//  정비가 지운다. 관리자는 목록을 보고 비우거나, 같은 id 로 다시 만든 앱에 되돌린다(명시로만 — app_data_restore 와 같은 자세). 앱 행 없이 폴더만
//  남은 것(고아)은 정비가 훑지 않는다 — 여기서 보고 보관으로 옮긴다(상민 2026-10-16). 실행 · 규칙은 apps/app-folder-archive.ts.
const appFolderArchivesList: Capability = {
  name: "app_folder_archives",
  title: "앱 폴더 보관 목록",
  description: "앱을 지울 때 보관으로 옮긴 앱 폴더(apps/<앱>/)와, 앱 없이 남은 앱 폴더(고아)를 본다. archives 항목 = name(비우기 · 되돌리기에 그대로) · app_id · "
    + "archived_at · archived_by · entry(remove 관리자 제거 · discard 나만 보는 앱 지우기 · retire 기본 앱 은퇴 · draft-drop 빈 예약 거두기 · create 같은 id 로 새로 만들 때 남아 있던 것 · "
    + "orphan 고아를 옮김 · unknown 기록 없이 파일만 있던 것) · files · bytes · truncated(세다 멈춤) · expires_at(이때 지운다) · expired(보관 기간이 지나 정비가 지우는 중) · "
    + "last_error · last_try_at(지우려다 멈춘 보관의 까닭 · 시각 — 권한 · 시간 예산, 다시 비우면 이어서 지운다) · app_exists(같은 id 의 앱이 지금 있나) · "
    + "missing(기록만 있고 파일이 없다). 되돌리기는 app_exists 이고 expired · last_try_at 이 없을 때만. "
    + "orphans 항목 = app_id · files · bytes — app_folder_orphans_archive 로 보관에 옮긴다. 관리자.",
  scope: "admin",
  input: {},
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/app-folder-archives"], parse: () => ({}) }],
  },
  handler: async (_input: Record<string, unknown>, user: LivelyUser) => listAppFolderArchives(actorOf(user)),
};

const appFolderArchiveClear: Capability = {
  name: "app_folder_archive_clear",
  title: "앱 폴더 보관 비우기",
  description: "보관한 앱 폴더를 지운다(app_folder_archives 의 name 그대로) — 되살릴 길이 없다(그 보관이 마지막 사본이다). 보관 이름 꼴이 아니거나 없는 이름은 "
    + "건드리지 않고 missing 으로 알린다 · 못 지운 것은 kept(까닭). 보관 기간이 지난 것은 정비가 스스로 지운다. 관리자.",
  scope: "admin",
  input: { names: z.array(z.string()).min(1).max(200) },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/app-folder-archives/clear"], parse: (req) => ({ names: (req.body as Record<string, unknown> | undefined)?.names }) }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    //  REST 는 zod 를 거치지 않는다 — 모양이 틀린 names 를 조용히 [] 로 읽지 않게 거절한다(app_archive_clear 와 같은 까닭).
    if (!Array.isArray(input.names) || !input.names.length) throw new HttpError(400, "names(보관 이름들)가 필요합니다 — app_folder_archives 로 목록을 보세요");
    const names = input.names.map((n) => String(n ?? ""));
    const out = await clearAppFolderArchives(names, actorOf(user));
    //  파일을 지우는 관리자 동작 — 누가 무엇을 지웠고 무엇이 남았나를 감사에 남긴다.
    if (out.cleared.length || out.kept.length) {
      await audit("app_folder_archive", null, "clear", { names }, { cleared: out.cleared, kept: out.kept }, user?.userId, ctx?.source)
        .catch((err) => logger.warn({ err }, "앱 폴더 보관 비우기 감사 기록 실패(비치명)"));
    }
    return { ok: true, ...out };
  },
};

const appFolderRestore: Capability = {
  name: "app_folder_restore",
  title: "앱 폴더 되돌리기",
  description: "보관한 앱 폴더를 같은 id 의 앱 폴더(apps/<앱>/)로 되돌린다 — 그 앱이 지금 있고(지운 앱을 같은 id 로 다시 만든 뒤) 그 앱 폴더가 없거나 비었을 때만. "
    + "앱 폴더에 파일이 있으면 409(새 앱의 파일을 덮지 않는다 · 아무것도 바꾸지 않는다). 앱이 없으면 409 · 보관 기간이 지났거나(expired) 지우다 멈춘 보관(last_try_at — "
    + "일부가 이미 지워졌을 수 있다)이면 409 · 보관이 이미 지워졌으면 410. 앱 데이터는 app_data_restore 로 따로. 관리자.",
  scope: "admin",
  input: { name: z.string().max(200) },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/app-folder-archives/restore"], parse: (req) => ({ name: (req.body as Record<string, unknown> | undefined)?.name }) }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    const name = String(input.name ?? "").trim();
    const out = await restoreAppFolderArchive(name, actorOf(user));
    await audit("app_folder_archive", out.app_id, "restore", { name }, out, user?.userId, ctx?.source)
      .catch((err) => logger.warn({ err }, "앱 폴더 되돌리기 감사 기록 실패(비치명)"));
    return { ok: true, restored: out.name, app_id: out.app_id };
  },
};

const appFolderOrphansArchive: Capability = {
  name: "app_folder_orphans_archive",
  title: "고아 앱 폴더 보관으로",
  description: "앱 행 없이 남은 앱 폴더(app_folder_archives 의 orphans)를 보관으로 옮긴다 — 앱 id 마다 설치 락 안에서 «그 앱이 없음» 을 다시 본 뒤. "
    + "같은 id 의 앱이 있으면 건너뛴다(skipped — 그 앱의 폴더다). 옮긴 것은 다른 보관처럼 보관 기간 뒤 지운다. 관리자.",
  scope: "admin",
  input: { app_ids: z.array(z.string().max(64)).min(1).max(200) },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/app-folder-archives/orphans"], parse: (req) => ({ app_ids: (req.body as Record<string, unknown> | undefined)?.app_ids }) }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    if (!Array.isArray(input.app_ids) || !input.app_ids.length) throw new HttpError(400, "app_ids(고아 앱 폴더의 앱 id 들)가 필요합니다 — app_folder_archives 의 orphans 를 보세요");
    const ids = input.app_ids.map((n) => String(n ?? ""));
    const out = await archiveOrphanAppFolders(ids, actorOf(user));
    if (out.archived.length) {
      await audit("app_folder_archive", null, "archive_orphans", { app_ids: ids }, { archived: out.archived.map((a) => a.name), skipped: out.skipped }, user?.userId, ctx?.source)
        .catch((err) => logger.warn({ err }, "고아 앱 폴더 보관 감사 기록 실패(비치명)"));
    }
    return { ok: true, ...out };
  },
};

export const appCapabilities: Capability[] = [appsIndex, appGet, appSetEnabled, appGrant, appRevoke, appInstall, appSave, appPull, appVersions, appSpec, appRevert,
  appEditPolicySet, appVisibilitySet, appPublishPreview, appBuildStart, appOwnerSet, appDraftRemove, appRemove, appActivityCap, appUi, appDataSnapshots, appDataRestore,
  appArchivesList, appArchiveClear, appFolderArchivesList, appFolderArchiveClear, appFolderRestore, appFolderOrphansArchive];
