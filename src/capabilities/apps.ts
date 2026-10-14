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
import { removeInstalledApp } from "../apps/remove-run.js";
import { isBuiltinSource } from "../apps/store-ddl.js";
import { restartWorkersForApp, stopWorkersForApp, stopWorkersForMemberApp } from "../apps/worker-service.js";
import { editDenial, memberAppViolations } from "../apps/member-app.js";
import { listAppSnapshots, restoreAppSnapshot } from "../apps/app-snapshot.js";
import { builtinAppDir } from "../apps/builtin-root.js";
import {
  filesFromStored, filesToInline, hasPackageDir, isOverrideSource, originOfCurrent, overlayFiles, overrideSourceMeta,
  readPackageDir, versionsToPrune, versionsToPruneForQuota, APP_VERSION_TOTAL_MAX_BYTES, type AppFile,
} from "../apps/app-versions.js";
import { publishAppEvent } from "../apps/session-apps.js";
import { logger } from "../log.js";
import type { LivelyUser } from "../context.js";

const actorOf = (u: { userId?: string; email?: string } | undefined): string => u?.userId || u?.email || "unknown";
const wctx = (u: { userId?: string; email?: string } | undefined, ctx?: { source?: string }) => ({ actor: actorOf(u), source: ctx?.source ?? "web" });

function appId(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) throw new HttpError(400, "app_id 가 필요합니다");
  return s;
}

// ── 앱 목록(설치된 앱) ──
const appsIndex: Capability = {
  name: "org_apps",
  title: "설치된 앱 목록",
  description: "이 워크스페이스에 설치된 앱 목록(id·제목·버전·상태·활성). 런치패드·앱 관리 화면이 소비.",
  scope: null,
  input: {},
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/apps"], parse: () => ({}) }],
  },
  //  #4225 — can_edit: **이 요청자가** app_save 로 이 앱을 고칠 수 있나(화면이 [고치기]·설정 메뉴를 그릴지 정한다). 판정은 member-app.ts.
  handler: async (_input: Record<string, unknown>, user: LivelyUser) => {
    const apps = await store.listApps();
    return { apps: apps.map((a) => ({ ...a, can_edit: editDenial(a, { userId: actorOf(user), scopes: user?.scopes }, safeManifest(a)) === null })) };
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
  if (isOverrideSource(app.source) && app.current_version_no != null) {
    const cur = await store.getAppVersion(app.id, app.current_version_no);
    if (cur && cur.content_hash != null && cur.content_hash === app.content_hash) return { files: cur.files, from: "version" };
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
async function snapshotCurrentVersion(app: store.OrgApp, savedBy: string, note: string): Promise<number> {
  const { files } = await currentPackageFiles(app);
  return store.insertAppVersion(app.id, {
    origin: originOfCurrent(app.source), version: app.version, manifest: app.manifest, files,
    content_hash: app.content_hash, note, saved_by: savedBy,
  });
}

/** app_save 입력 파일을 판에 적을 모양으로(순수) — 경로·내용·인코딩만 남긴다. */
function inputFilesForVersion(files: unknown): AppFile[] {
  return (Array.isArray(files) ? files : []).map((f) => {
    const o = (f ?? {}) as Record<string, unknown>;
    const enc = o.encoding === "base64" ? "base64" as const : undefined;
    return enc ? { path: String(o.path ?? ""), content: String(o.content ?? ""), encoding: enc } : { path: String(o.path ?? ""), content: String(o.content ?? "") };
  });
}

/** 구성원 판을 보관 수만큼만 남기고(원본 판은 세지 않는다), 워크스페이스 총량 상한을 넘겼으면 앱 불문 오래된 구성원 판부터 더 지운다. */
async function pruneVersions(appId: string): Promise<void> {
  await store.deleteAppVersions(appId, versionsToPrune(await store.listAppVersions(appId)));
  const total = await store.appVersionBytesTotal();
  if (total <= APP_VERSION_TOTAL_MAX_BYTES) return;
  const victims = versionsToPruneForQuota(await store.listMemberVersionsOldestFirst(), total);
  const byApp = new Map<string, number[]>();
  for (const v of victims) byApp.set(v.app_id, [...(byApp.get(v.app_id) ?? []), v.version_no]);
  for (const [id, nos] of byApp) await store.deleteAppVersions(id, nos);
}

/** 지금 서빙 중인 내용이 이 판 그대로인가 — 번호가 아니라 **내용(해시)** 으로 본다(관리자 org_app_install 이 내용을 바꿔도 맞게 · 격리 리뷰 7b). */
const isCurrentVersion = (app: store.OrgApp, v: { content_hash: string | null }): boolean => v.content_hash != null && v.content_hash === app.content_hash;

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
  handler: async (input: Record<string, unknown>) => {
    const id = appId(input.app_id);
    const app = await store.getApp(id);
    if (!app) throw new HttpError(404, `앱 없음: ${id}`);
    return { app, components: await store.listComponents(id) };
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
    if (!(await store.getApp(id))) throw new HttpError(404, `앱 없음: ${id}`);
    await store.setAppEnabled(id, !!input.enabled, wctx(user, ctx));
    if (!input.enabled) await stopWorkersForApp(id, "app_disabled");
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
    const app = await store.getApp(id);
    if (!app) throw new HttpError(404, `앱 없음: ${id}`);
    const m = parseAppManifest(app.manifest);
    const requested = (input.scopes !== undefined || input.tools !== undefined)
      ? { scopes: input.scopes as string[] | undefined, tools: input.tools as string[] | undefined }
      : undefined;
    const g = resolveGrant(m, requested);
    const row = await store.upsertGrant(id, actorOf(user), g.scopes, g.tools, wctx(user, ctx));
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
    // 아무것도 안 껐는데 그런 앱도 없다 = 오타다. (앱이 지워졌어도 살아있는 동의가 있었다면 위에서 껐으므로
    //  여기로 오지 않는다.) revoked=false 인데 앱은 있는 경우는 «이미 꺼져 있었다» — 약속된 결과 상태는
    //  성립하므로 성공이되 그 사실을 구분해 답한다.
    if (!revoked && !(await store.getApp(id))) throw new HttpError(404, `그런 앱이 없습니다: ${id}`);
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
      const outcome = await store.withAppInstallLock(loaded.manifest.id, async () => {
        previousHash = (await store.getApp(loaded.manifest.id))?.content_hash ?? null;
        return installLoadedApp(loaded, staged.meta, wctx(user, ctx));
      });
      const workerRestart = !outcome.created && previousHash !== loaded.contentHash
        ? await restartWorkersForApp(outcome.id) : null;
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
    "files=[{path, content, encoding?:'utf8'|'base64'}] · lively-app.json 필수. 구성원 누구나 쓸 수 있고, 담을 수 있는 것은 **화면(ui.pages) + 데이터(data.tables) + " +
    "선언한 라이블리 도구(permissions.tools — 쓰는 사람이 동의한 만큼만)**까지다. 스킬·훅·정기 작업·MCP/HTTP 도구·서버 worker·외부 호스트·화면의 직접 네트워크는 관리자 설치(org_app_install)로만. " +
    "있는 앱은 그 앱의 고치기 설정(기본 전원 · 관리자가 지정한 사람만으로 좁힐 수 있음)을 따른다. " +
    "기본 앱(빌트인)도 화면·데이터만으로 된 앱이면 고칠 수 있다 — 그러면 이 워크스페이스의 판이 릴리스 원본을 덮고(데이터 표는 그대로), " +
    "원본으로 되돌리려면 app_revert(원본 판). 저장마다 판이 남는다(app_versions · note 에 요지 한 줄). " +
    "앱 화면은 샌드박스라 폼 제출이 막힌다 — 입력은 버튼 click · Enter keydown 으로. 칸 추가는 ADD COLUMN, 빠진 테이블은 비었으면 삭제·데이터 있으면 보관.",
  scope: null,
  input: {
    files: z.array(z.object({ path: z.string(), content: z.string(), encoding: z.enum(["utf8", "base64"]).optional() })),
    note: z.string().max(500).optional().describe("이 판의 요지 한 줄(판 이력에 남는다 — 예: «글 줄 칸을 아래로 · 보낸 줄 접힘»)"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/save"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return { files: b.files, note: b.note };
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    const source = parseAppSource({ kind: "inline", files: input.files });
    const staged = await stageAppSource(source);
    try {
      const loaded = await loadAppPackage(staged.dir);
      const bad = memberAppViolations(loaded.manifest);
      if (bad.length) {
        throw new HttpError(403, `이 앱은 화면·데이터 밖의 기능을 선언해서 app_save 로 저장할 수 없습니다: ${bad.join(" · ")} — 빼고 저장하거나 관리자 설치(org_app_install)를 부탁하세요`);
      }
      const id = loaded.manifest.id;
      const who = { userId: actorOf(user), scopes: user?.scopes };
      const note = input.note == null || String(input.note).trim() === "" ? null : String(input.note).trim();
      const { outcome, versionNo } = await store.withAppInstallLock(id, async () => {
        const existing = await store.getApp(id);
        if (existing) {
          const why = editDenial(existing, who, safeManifest(existing));
          if (why) throw new HttpError(403, why);
        }
        //  #4600 — 이력이 비어 있는 앱을 처음 고치면 **지금 상태를 먼저 판 1로** 떠 둔다. 빌트인이면 그것이 「원본 · 릴리스」 판(되돌리기의 목적지).
        if (existing && (await store.listAppVersions(id)).length === 0) {
          await snapshotCurrentVersion(existing, who.userId, originOfCurrent(existing.source) === "builtin" ? `원본 · 릴리스 ${existing.version}` : "저장 전 상태");
        }
        //  빌트인을 고치면 source 는 kind 'builtin' 을 유지한 채 overrides_builtin 이 붙는다(app-versions.ts 머리 — 데이터 표가 사는 스키마가 그 값으로 갈린다).
        //  그러면 부팅 시딩이 이 앱을 덮지 않는다(seed.ts seedShouldSkipOverride).
        const meta = existing && isBuiltinSource(existing.source) ? overrideSourceMeta(staged.meta, id) : staged.meta;
        //  판 행을 **설치 전에** 먼저 쓴다(격리 리뷰 7c) — 설치가 됐는데 판 기록이 없는 상태(되돌릴 곳 없음)를 만들지 않는다.
        //  설치가 실패하면 그 행을 거둔다(best-effort — 남아도 current_version_no 가 안 가리키므로 is_current 가 아니다).
        const versionNo = await store.insertAppVersion(id, {
          origin: "member", version: loaded.manifest.version, manifest: loaded.manifest, files: inputFilesForVersion(input.files),
          content_hash: loaded.contentHash, note, saved_by: who.userId,
        });
        let outcome;
        try {
          outcome = await installLoadedApp(loaded, meta, wctx(user, ctx));
        } catch (e) {
          await store.deleteAppVersions(id, [versionNo]).catch((err) => logger.warn({ err, id, versionNo }, "설치 실패 뒤 판 행 회수 실패(비치명)"));
          throw e;
        }
        await store.setAppCurrentVersion(id, versionNo);
        await pruneVersions(id).catch((err) => logger.warn({ err, id }, "판 보관 정리 실패(비치명 — 다음 저장이 다시 정리)"));
        return { outcome, versionNo };
      });
      //  세션 옆 앱 칸이 이 사건을 받아 그 앱 화면을 다시 띄운다(«N판 · 방금 고침 · 되돌리기»).
      publishAppEvent(who.userId, { kind: "updated", app_id: id, session: null, version_no: versionNo, note, source: ctx?.source });
      const app = await store.getApp(outcome.id);
      return { app, created: outcome.created, tables: outcome.tables ?? null, version_no: versionNo };
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
  input: { app_id: z.string() },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/apps/:id/pull"], parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id }) }],
  },
  handler: async (input: Record<string, unknown>) => {
    const id = appId(input.app_id);
    const app = await store.getApp(id);
    if (!app) throw new HttpError(404, `앱 없음: ${id}`);
    const { files, from } = await currentPackageFiles(app);
    const src = (app.source ?? {}) as { kind?: unknown };
    return {
      app_id: id, title: app.title, version: app.version, source_kind: String(src.kind ?? ""), overrides_builtin: isOverrideSource(app.source),
      builtin_version: app.builtin_version, current_version_no: app.current_version_no, from, files,
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
  handler: async (input: Record<string, unknown>) => {
    const id = appId(input.app_id);
    const app = await store.getApp(id);
    if (!app) throw new HttpError(404, `앱 없음: ${id}`);
    const versions = (await store.listAppVersions(id)).map((v) => ({ ...v, is_current: isCurrentVersion(app, v) }));
    return { app_id: id, current_version_no: app.current_version_no, builtin_version: app.builtin_version, overrides_builtin: isOverrideSource(app.source), versions };
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
    "되돌리기 직전 지금 상태를 먼저 판으로 떠 둔다. 권한은 app_save 와 같다(그 앱의 고치기 설정).",
  scope: null,
  input: { app_id: z.string(), version_no: z.number().int().positive() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/revert"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return { app_id: (req.params as Record<string, string>)?.id, version_no: Number(b.version_no) };
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    const id = appId(input.app_id);
    const target = Number(input.version_no);
    if (!Number.isInteger(target) || target < 1) throw new HttpError(400, "version_no 는 1 이상의 정수여야 합니다");
    const who = { userId: actorOf(user), scopes: user?.scopes };
    const result = await store.withAppInstallLock(id, async () => {
      const app = await store.getApp(id);
      if (!app) throw new HttpError(404, `앱 없음: ${id}`);
      const why = editDenial(app, who, safeManifest(app));
      if (why) throw new HttpError(403, why);
      const ver = await store.getAppVersion(id, target);
      if (!ver) throw new HttpError(404, `앱 '${id}' 에 ${target}판이 없습니다`);
      //  «이미 그 판» 은 내용(해시)으로 — 번호가 달라도 내용이 같으면 할 일이 없다(가리키는 번호만 맞춘다).
      if (isCurrentVersion(app, ver)) {
        if (app.current_version_no !== target) await store.setAppCurrentVersion(id, target);
        return { app, version_no: target, changed: false };
      }

      // 지금 상태가 어느 판 그대로가 아니면 먼저 떠 둔다.
      const cur = app.current_version_no == null ? null : await store.getAppVersion(id, app.current_version_no);
      if (!cur || !isCurrentVersion(app, cur)) await snapshotCurrentVersion(app, who.userId, "되돌리기 직전");

      const builtinLineage = isBuiltinSource(app.source);
      const dir = builtinAppDir(id);
      if (ver.origin === "builtin" && builtinLineage && (await hasPackageDir(dir))) {
        //  원본으로 — 폴더(지금 실린 릴리스)에서 빌트인으로 재설치. 덮어쓰기 표식이 걷힌다.
        const loaded = await loadAppPackage(dir);
        await installLoadedApp(loaded, { kind: "builtin" }, wctx(user, ctx));
        //  떠 둔 원본 판은 처음 고친 날의 릴리스다. 그 사이 릴리스가 올랐으면 방금 깐 것과 다르다 — 원본 판을 **지금 깐 것**으로 맞춘다
        //   (안 맞추면 판 이력에 «지금» 이 없고, 다음 되돌리기가 원본을 한 벌 더 떠 둔다). 실패해도 되돌리기 자체는 끝났다(로그만).
        const fresh = await store.getApp(id);
        if (fresh && !isCurrentVersion(fresh, ver)) {
          await currentPackageFiles(fresh)
            .then(({ files }) => store.refreshOriginVersion(id, target, {
              version: fresh.version, manifest: fresh.manifest, files, content_hash: fresh.content_hash, note: `원본 · 릴리스 ${fresh.version}`,
            }))
            .catch((err) => logger.warn({ err, id, target }, "원본 판을 지금 릴리스로 맞추지 못했다(비치명 — 되돌리기는 끝났다)"));
        }
      } else {
        const staged = await stageAppSource(parseAppSource({ kind: "inline", files: filesToInline(ver.files) }));
        try {
          const loaded = await loadAppPackage(staged.dir);
          if (loaded.manifest.id !== id) throw new HttpError(409, `${target}판의 매니페스트 id(${loaded.manifest.id})가 앱 id 와 다릅니다`);
          const bad = memberAppViolations(loaded.manifest);
          if (bad.length) throw new HttpError(403, `${target}판은 화면·데이터 밖의 기능을 선언해서 app_save 경로로 되돌릴 수 없습니다: ${bad.join(" · ")}`);
          await installLoadedApp(loaded, builtinLineage ? overrideSourceMeta(staged.meta, id) : staged.meta, wctx(user, ctx));
        } finally {
          await staged.cleanup();
        }
      }
      await store.setAppCurrentVersion(id, target).catch((err) => logger.warn({ err, id, target }, "되돌린 판 번호 기록 실패(비치명 — is_current 는 해시로 판정)"));
      await pruneVersions(id).catch((err) => logger.warn({ err, id }, "판 보관 정리 실패(비치명)"));
      return { app: await store.getApp(id), version_no: target, changed: true };
    });
    if (result.changed) publishAppEvent(who.userId, { kind: "updated", app_id: id, session: null, version_no: target, note: `되돌림 → ${target}판`, source: ctx?.source });
    return { ok: true, app_id: id, version_no: result.version_no, changed: result.changed, app: result.app };
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
    const app = await store.getApp(id);
    if (!app) throw new HttpError(404, `앱 없음: ${id}`);
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
  description: "앱과 그 전개물(하네스 자산·크론·툴·호스트)을 회수하고 레지스트리에서 삭제한다. builtin(코드 소유) 앱은 제거 대신 org_app_set_enabled 로 끈다(부팅 재시드). 관리자.",
  scope: "admin",
  input: { app_id: z.string() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/remove"], parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id }) }],
  },
  handler: async (input: Record<string, unknown>, user, ctx) => {
    const id = appId(input.app_id);
    return store.withAppInstallLock(id, async () => {
      const app = await store.getApp(id);
      if (!app) throw new HttpError(404, `앱 없음: ${id}`);
      const src = (app.source ?? {}) as { kind?: string };
      if (src.kind === "builtin") throw new HttpError(409, `builtin 앱 '${id}' 은 제거 대신 org_app_set_enabled 로 끄세요(부팅 시 재시드됩니다)`);
      //  지우는 순서(회수 → 데이터 떠 두기 → 테이블 → 인스턴스 → 앱 행)는 공용 코어에 있다 — 시더의 은퇴 앱 회수와 같은 길(#4554).
      return { ok: true, removed: id, ...(await removeInstalledApp(app, wctx(user, ctx))) };
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
  handler: async (input: Record<string, unknown>) => {
    const id = appId(input.app_id);
    const app = await store.getApp(id);
    if (!app) throw new HttpError(404, `앱 없음: ${id}`);
    if (app.status !== "active" || !app.enabled) throw new HttpError(409, `앱 '${id}' 이 활성 상태가 아닙니다`);
    const pages = await store.listUiAssets(id);
    if (pages.length === 0) throw new HttpError(404, `앱 '${id}' 에 UI 페이지가 없습니다`);
    const key = input.page ? String(input.page) : pages[0].page_key;
    const a = await store.getUiAsset(id, key);
    if (!a) throw new HttpError(404, `UI 페이지 없음: ${key}`);
    // csp = 매니페스트 선언(없으면 빈 객체 = 네트워크·프레임 0). 호스트(app-ui.ts)가 이걸로 srcdoc CSP 를 짓는다 —
    //  선언에 없는 것은 브라우저가 막는다(우리 코드가 아니라 브라우저가 집행하는 경계).
    const csp = ((app.manifest as { csp?: unknown } | null)?.csp ?? {}) as Record<string, unknown>;
    return { app_id: id, page_key: a.page_key, kind: a.kind, title: a.title, html: a.html, pages, csp };
  },
};

// ── 앱 데이터 떠 둔 것 보기·되돌리기(#4226, 관리자) ──
//  워크스페이스가 만든 앱의 데이터를 하루 한 번(+ 제거·되돌리기 직전) 떠 둔다(7일). AI 가 자유 SQL 로 행을 잘못 지웠을 때
//  한 워크스페이스·한 앱만 그 시점으로 되돌리는 길이다(RDS 백업은 DB 전체 단위라 이게 안 된다).
const appDataSnapshots: Capability = {
  name: "app_data_snapshots",
  title: "앱 데이터 떠 둔 것 목록",
  description: "워크스페이스가 만든 앱의 데이터를 떠 둔 목록(하루 한 번 + 앱 제거·되돌리기 직전, 7일 보관). app_id 를 주면 그 앱만. 항목 = 시각·까닭(daily·before-remove·before-restore)·테이블별 행 수. 관리자.",
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
    + "이 워크스페이스 행을 통째로 그 시점으로 바꾸고(원래 id 유지), 되돌리기 직전 지금 상태를 먼저 떠 둔다(before-restore — 되돌리기도 되돌릴 수 있다). 직전 상태를 못 떠 두면(너무 큰 앱) force 없이는 멈춘다. 관리자.",
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
      return { ok: true, app_id: id, restored: out.restored, before_restore: out.safety.taken_at };
    });
  },
};

export const appCapabilities: Capability[] = [appsIndex, appGet, appSetEnabled, appGrant, appRevoke, appInstall, appSave, appPull, appVersions, appRevert, appEditPolicySet, appRemove, appActivityCap, appUi, appDataSnapshots, appDataRestore];
