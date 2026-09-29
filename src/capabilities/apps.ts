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
import { makeDeployDeps } from "../apps/deploy.js";
import { dropAppTables, appSchemaFor } from "../apps/store-schema.js";
import { isBuiltinSource } from "../apps/store-ddl.js";
import { pruneAppInstances } from "../org/store/app-instances.js";
import { pruneSessionApps } from "../apps/session-apps.js";
import { restartWorkersForApp, stopWorkersForApp, stopWorkersForMemberApp } from "../apps/worker-service.js";
import { editDenial, memberAppViolations } from "../apps/member-app.js";
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
    "있는 앱은 그 앱의 고치기 설정(기본 전원 · 관리자가 지정한 사람만으로 좁힐 수 있음)을 따른다. 기본 앱(빌트인)은 고칠 수 없다. " +
    "앱 화면은 샌드박스라 폼 제출이 막힌다 — 입력은 버튼 click · Enter keydown 으로. 칸 추가는 ADD COLUMN, 빠진 테이블은 비었으면 삭제·데이터 있으면 보관.",
  scope: null,
  input: { files: z.array(z.object({ path: z.string(), content: z.string(), encoding: z.enum(["utf8", "base64"]).optional() })) },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/save"], parse: (req) => ({ files: (req.body as Record<string, unknown>)?.files }) }],
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
      const who = { userId: actorOf(user), scopes: user?.scopes };
      const outcome = await store.withAppInstallLock(loaded.manifest.id, async () => {
        const existing = await store.getApp(loaded.manifest.id);
        if (existing) {
          const why = editDenial(existing, who, safeManifest(existing));
          if (why) throw new HttpError(403, why);
        }
        return installLoadedApp(loaded, staged.meta, wctx(user, ctx));
      });
      const app = await store.getApp(outcome.id);
      return { app, created: outcome.created, tables: outcome.tables ?? null };
    } finally {
      await staged.cleanup();
    }
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
    if (isBuiltinSource(app.source)) throw new HttpError(400, "기본 앱(빌트인)은 여기서 고칠 수 없어 고치기 설정이 없습니다");
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
      await stopWorkersForApp(id, "app_removed");
      const deps = makeDeployDeps(id, wctx(user, ctx));
      const comps = await store.listComponents(id);
      for (const c of comps) {
        try { await deps.reclaim({ kind: c.kind, ref: c.ref, orig_name: c.orig_name ?? undefined }); }
        catch { /* best-effort — 조인은 아래 delete 로 CASCADE, 저널 삭제로 스위퍼도 무관 */ }
      }
      await store.pruneUiAssets(id, []);   // UI 자산은 FK CASCADE 대상이 아니므로(스키마 주석) 명시 삭제.
      // 앱 데이터 테이블(app 스키마)도 명시 DROP(소유자) — 매니페스트 선언분. best-effort.
      const dataTables = ((app.manifest as { data?: { tables?: Array<{ name?: string }> } })?.data?.tables ?? []).map((t) => String(t.name));
      //  스키마는 설치 때와 같은 규칙(#4223) — 워크스페이스가 설치한 앱이면 그 워크스페이스 스키마의 테이블만 지운다.
      try { await dropAppTables(id, dataTables, appSchemaFor(isBuiltinSource(app.source))); } catch { /* best-effort */ }
      await pruneAppInstances(id);             // FK 없는 v2.1 신규 표 — 앱 제거 전에 명시 회수.
      await pruneSessionApps(id);              // #4225 세션에 붙어 있던 기록도 — 같은 규칙(FK 없음).
      await store.deleteApp(id, wctx(user, ctx));
      return { ok: true, removed: id, components: comps.length };
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

export const appCapabilities: Capability[] = [appsIndex, appGet, appSetEnabled, appGrant, appRevoke, appInstall, appSave, appEditPolicySet, appRemove, appActivityCap, appUi];
