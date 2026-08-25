// AppInstance capability(#1780 v2.1) — 설치된 AppPackage와 탭에 열리는 실행 단위를 분리한다.
// 프로젝트 소속은 instance의 nullable 맥락이며 권한이 아니다: 연결·조회 때 프로젝트 존재와 가시성을 다시 확인한다.
import { z } from "zod";
import { itemsPool } from "../db/client.js";
import type { LivelyUser } from "../context.js";
import type { Capability, CapabilityCtx } from "./types.js";
import { HttpError } from "./rest-util.js";
import { canSeeProjectRow } from "../v6/visibility.js";
import { listSessions } from "../terminal/terminal-sessions.js";
import { getSessionState } from "../sessions/session-state.js";
import { parseAppManifest, type LivelyAppManifest } from "../apps/manifest.js";
import { normalizeInstanceProject, normalizeInstanceState } from "../apps/instance-policy.js";
import * as apps from "../org/store/apps.js";
import * as instances from "../org/store/app-instances.js";
import { resolveWorkerPlacement, startWorkerForInstance, stopWorkerForInstance, workerRunForInstance } from "../apps/worker-service.js";
import { nodeOnline, nodeSupports } from "../node/registry.js";
import { getNode } from "../node/store.js";
import { nodeOpenTo } from "../node/node-access.js";

const INSTANCE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT_RE = /^[A-Za-z0-9._:-]{1,160}$/;
const actorOf = (user: LivelyUser): string => user?.userId || user?.email || "unknown";

function instanceId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!INSTANCE_ID_RE.test(id)) throw new HttpError(400, "instance_id 형식 오류");
  return id;
}

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) throw new HttpError(400, `문자열은 ${max}자 이하여야 합니다`);
  return text;
}

function projectFilter(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "null" || value === "") return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "project_id 는 양의 정수 또는 null 이어야 합니다");
  return id;
}

async function activeApp(appId: unknown): Promise<{ app: apps.OrgApp; manifest: LivelyAppManifest }> {
  const id = String(appId ?? "").trim();
  if (!id) throw new HttpError(400, "app_id 가 필요합니다");
  const app = await apps.getApp(id);
  if (!app) throw new HttpError(404, `앱 없음: ${id}`);
  if (app.status !== "active" || !app.enabled) throw new HttpError(409, `앱 '${id}' 이 활성 상태가 아닙니다`);
  return { app, manifest: parseAppManifest(app.manifest) };
}

async function assertProject(projectId: number | null, ctx?: CapabilityCtx): Promise<void> {
  if (projectId === null) return;
  const exists = (await itemsPool.query("SELECT 1 FROM project WHERE id=$1 AND level='project'", [projectId])).rows.length > 0;
  if (!exists || !(await canSeeProjectRow(projectId, ctx?.viewer ?? null))) {
    throw new HttpError(404, `프로젝트 #${projectId} 없음`);
  }
}

async function visibleSessionMeta(sessionId: string, user: LivelyUser): Promise<{ projectId: number | null; appId: string }> {
  const owner = actorOf(user);
  const desired = await getSessionState(sessionId);
  if (desired?.owner === owner) return { projectId: desired.project_id ?? null, appId: desired.app_id || "ai-session" };
  const live = (await listSessions(user)).find((s) => s.id === sessionId);
  if (!live) throw new HttpError(404, `세션 없음: ${sessionId}`);
  return {
    projectId: live.projectId && live.projectId > 0 ? Number(live.projectId) : null,
    appId: live.appId || "ai-session",
  };
}

function publicAppMeta(app: apps.OrgApp, manifest: LivelyAppManifest): Record<string, unknown> {
  const source = (app.source ?? {}) as { kind?: unknown };
  const builtin = source.kind === "builtin";
  return {
    id: app.id,
    title: app.title,
    source: { kind: builtin ? "builtin" : "installed" },
    instances: manifest.instances,
    system: builtin ? (manifest.system ?? null) : null,
    runtime: manifest.runtime ? { kind: "worker", placement: manifest.runtime.placement,
      idle_timeout_sec: manifest.runtime.idle_timeout_sec, memory_mb: manifest.runtime.memory_mb } : null,
    ui: { pages: manifest.ui.pages.map((p) => ({ key: p.key, title: p.title, display: p.display })) },
  };
}

async function decorate(instance: instances.AppInstanceRow): Promise<Record<string, unknown>> {
  const { app, manifest } = await activeApp(instance.app_id);
  return { ...instance, app: publicAppMeta(app, manifest), worker: await workerRunForInstance(instance.id) };
}

function requestedExecution(value: unknown): { kind: "central" | "remote"; node_id?: string } | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "execution 은 객체여야 합니다");
  const x = value as Record<string, unknown>;
  if (x.kind !== "central" && x.kind !== "remote") throw new HttpError(400, "execution.kind 는 central 또는 remote 여야 합니다");
  const nodeId = x.node_id == null ? undefined : String(x.node_id).trim();
  return { kind: x.kind, ...(nodeId ? { node_id: nodeId } : {}) };
}

const listInput = {
  app_id: z.string().optional(),
  project_id: z.number().int().positive().nullable().optional(),
  include_closed: z.boolean().optional(),
};
const appInstanceList: Capability = {
  name: "app_instance_list",
  title: "내 앱 인스턴스 목록",
  description: "현재 사용자의 앱 실행 인스턴스를 조회한다. project_id=null 필터는 프로젝트 비소속 인스턴스만 뜻한다.",
  scope: null,
  input: listInput,
  expose: { mcp: false, rest: [{ method: "GET", paths: ["/api/ui/app-instances"], parse: (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    return {
      app_id: q.app_id ? String(q.app_id) : undefined,
      project_id: projectFilter(q.project_id),
      include_closed: q.include_closed === "true",
    };
  } }] },
  handler: async (input: z.infer<z.ZodObject<typeof listInput>>, user: LivelyUser, ctx?: CapabilityCtx) => {
    const rows = await instances.listAppInstances(actorOf(user), {
      appId: input.app_id,
      projectId: input.project_id,
      includeClosed: input.include_closed,
    });
    const visible: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      // project_id 는 분류·provenance일 뿐 인스턴스 조회 권한이 아니다. 앱 자체가 비활성이면 목록에서만 제외한다.
      try { visible.push(await decorate(row)); }
      catch (error) { if (!(error instanceof HttpError && (error.status === 404 || error.status === 409))) throw error; }
    }
    return { instances: visible };
  },
};

const createInput = {
  app_id: z.string(),
  project_id: z.number().int().positive().nullable().optional(),
  subject_kind: z.enum(["session"]).optional(),
  subject_ref: z.string().optional(),
  page_key: z.string().optional(),
  title: z.string().optional(),
  state: z.record(z.unknown()).optional(),
  execution: z.object({ kind: z.enum(["central", "remote"]), node_id: z.string().optional() }).optional(),
};
const appInstanceOpen: Capability = {
  name: "app_instance_open",
  title: "앱 인스턴스 열기",
  description: "앱 실행 인스턴스를 만든다. AI 세션 앱은 본인 세션을 subject로 주면 같은 인스턴스를 멱등 확보한다.",
  scope: null,
  input: createInput,
  expose: { mcp: false, rest: [{ method: "POST", paths: ["/api/ui/app-instances"], parse: (req) => ({ ...((req.body ?? {}) as Record<string, unknown>) }) }] },
  handler: async (input: z.infer<z.ZodObject<typeof createInput>>, user: LivelyUser, ctx?: CapabilityCtx) => {
    const { app, manifest } = await activeApp(input.app_id);
    let projectId = normalizeInstanceProject(manifest, input.project_id);
    const requested = requestedExecution(input.execution);
    let placement: ReturnType<typeof resolveWorkerPlacement>;
    try { placement = resolveWorkerPlacement(manifest, requested); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "worker placement 오류"); }
    if (placement?.kind === "remote") {
      const node = await getNode(placement.nodeId!);
      if (!node || !node.enabled) throw new HttpError(409, "선택한 원격 노드가 비활성 상태입니다");
      if (!nodeOpenTo(node, actorOf(user))) throw new HttpError(403, "본인 노드 또는 관리자가 공유한 노드에서만 앱을 실행할 수 있습니다");
      if (!nodeOnline(placement.nodeId!) || !nodeSupports(placement.nodeId!, "startWorker") || !nodeSupports(placement.nodeId!, "stageWorkerChunk")) {
        throw new HttpError(409, !nodeOnline(placement.nodeId!) ? "선택한 원격 노드가 오프라인입니다" : "원격 노드가 worker 실행을 지원하지 않습니다");
      }
    }

    let subjectKind: string | null = input.subject_kind ?? null;
    let subjectRef = input.subject_ref ? String(input.subject_ref).trim() : null;
    if ((subjectKind === null) !== (subjectRef === null)) throw new HttpError(400, "subject_kind 와 subject_ref 는 함께 지정해야 합니다");
    if (subjectRef && !SUBJECT_RE.test(subjectRef)) throw new HttpError(400, "subject_ref 형식 오류");
    if (subjectKind === "session") {
      const session = await visibleSessionMeta(subjectRef!, user);
      // 일반 세션은 ai-session builtin, 앱이 띄운 세션은 그 AppPackage가 실행 정체성이다.
      if (app.id !== session.appId) throw new HttpError(409, `이 세션의 앱은 '${session.appId}' 입니다`);
      // 세션의 실제 귀속이 권위다. 클라이언트가 다른 visible 프로젝트를 넣어 화면만 잘못 소속시키는 길을 닫는다.
      projectId = normalizeInstanceProject(manifest, session.projectId);
    }
    if (manifest.instances.multiplicity === "single") {
      subjectKind = "singleton";
      subjectRef = app.id;
    }
    await assertProject(projectId, ctx);

    const result = await instances.createAppInstance({
      appId: app.id,
      owner: actorOf(user),
      projectId,
      subjectKind,
      subjectRef,
      pageKey: optionalText(input.page_key, 64),
      title: optionalText(input.title, 200),
      state: normalizeInstanceState(input.state),
      executionHostKind: placement?.kind ?? null,
      executionHostId: placement?.nodeId ?? null,
      // subject 기반 재-open에서 위치를 생략했다면 기존 위치를 유지한다. 새 인스턴스 INSERT에는 위 기본 위치가 들어간다.
      preserveExecutionOnConflict: requested === null,
    });
    try { await startWorkerForInstance(app, manifest, result.instance); }
    catch (error) {
      await instances.closeAppInstance(result.instance.id, actorOf(user)).catch(() => { /* 실패 인스턴스 고아 방지 best-effort */ });
      throw new HttpError(503, `worker 시작 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { instance: await decorate(result.instance), created: result.created };
  },
};

const getInput = { instance_id: z.string() };
const appInstanceGet: Capability = {
  name: "app_instance_get",
  title: "앱 인스턴스 조회",
  description: "현재 사용자가 소유한 앱 인스턴스와 신뢰 가능한 셸 메타데이터를 조회한다.",
  scope: null,
  input: getInput,
  expose: { mcp: false, rest: [{ method: "GET", paths: ["/api/ui/app-instances/:id"], parse: (req) => ({ instance_id: (req.params as Record<string, string>)?.id }) }] },
  handler: async (input: z.infer<z.ZodObject<typeof getInput>>, user: LivelyUser, ctx?: CapabilityCtx) => {
    const found = await instances.getAppInstance(instanceId(input.instance_id), actorOf(user));
    if (!found) throw new HttpError(404, "앱 인스턴스가 없습니다");
    return { instance: await decorate(found) };
  },
};

const updateInput = {
  instance_id: z.string(),
  title: z.string().nullable().optional(),
  page_key: z.string().nullable().optional(),
  state: z.record(z.unknown()).optional(),
};
const appInstanceUpdate: Capability = {
  name: "app_instance_update",
  title: "앱 인스턴스 상태 수정",
  description: "현재 사용자가 소유한 앱 인스턴스의 표시 제목·페이지·복원 상태를 부분 수정한다.",
  scope: null,
  input: updateInput,
  expose: { mcp: false, rest: [{ method: "POST", paths: ["/api/ui/app-instances/:id/update"], parse: (req) => ({
    ...((req.body ?? {}) as Record<string, unknown>), instance_id: (req.params as Record<string, string>)?.id,
  }) }] },
  handler: async (input: z.infer<z.ZodObject<typeof updateInput>>, user: LivelyUser, ctx?: CapabilityCtx) => {
    const id = instanceId(input.instance_id);
    const before = await instances.getAppInstance(id, actorOf(user));
    if (!before) throw new HttpError(404, "앱 인스턴스가 없습니다");
    const updated = await instances.patchAppInstance(id, actorOf(user), {
      title: optionalText(input.title, 200),
      pageKey: optionalText(input.page_key, 64),
      state: normalizeInstanceState(input.state),
    });
    if (!updated) throw new HttpError(400, "병합된 state 는 128KiB 이하여야 합니다");
    return { instance: await decorate(updated!) };
  },
};

const projectInput = { instance_id: z.string(), project_id: z.number().int().positive().nullable() };
const appInstanceSetProject: Capability = {
  name: "app_instance_set_project",
  title: "앱 인스턴스 프로젝트 소속 변경",
  description: "앱 인스턴스를 프로젝트에 소속시키거나(project_id), 비소속으로 되돌린다(null). 앱 정책과 프로젝트 가시성을 집행한다.",
  scope: null,
  input: projectInput,
  expose: { mcp: false, rest: [{ method: "POST", paths: ["/api/ui/app-instances/:id/project"], parse: (req) => ({
    instance_id: (req.params as Record<string, string>)?.id,
    project_id: (req.body as Record<string, unknown>)?.project_id ?? null,
  }) }] },
  handler: async (input: z.infer<z.ZodObject<typeof projectInput>>, user: LivelyUser, ctx?: CapabilityCtx) => {
    const id = instanceId(input.instance_id);
    const before = await instances.getAppInstance(id, actorOf(user));
    if (!before) throw new HttpError(404, "앱 인스턴스가 없습니다");
    if (before.subject_kind === "session") {
      throw new HttpError(409, "세션형 앱의 프로젝트는 세션 소속에서 바꾸세요");
    }
    const { manifest } = await activeApp(before.app_id);
    const projectId = normalizeInstanceProject(manifest, input.project_id);
    await assertProject(projectId, ctx);
    const updated = await instances.setAppInstanceProject(id, actorOf(user), projectId);
    return { instance: await decorate(updated!) };
  },
};

const closeInput = { instance_id: z.string() };
const appInstanceClose: Capability = {
  name: "app_instance_close",
  title: "앱 인스턴스 닫기",
  description: "현재 사용자가 소유한 앱 인스턴스를 닫힌 상태로 바꾼다. subject가 있는 인스턴스는 다시 열면 같은 정체성으로 복원된다.",
  scope: null,
  input: closeInput,
  expose: { mcp: false, rest: [{ method: "POST", paths: ["/api/ui/app-instances/:id/close"], parse: (req) => ({ instance_id: (req.params as Record<string, string>)?.id }) }] },
  handler: async (input: z.infer<z.ZodObject<typeof closeInput>>, user: LivelyUser) => {
    const id = instanceId(input.instance_id);
    const before = await instances.getAppInstance(id, actorOf(user));
    if (!before) throw new HttpError(404, "앱 인스턴스가 없습니다");
    try { await stopWorkerForInstance(id, "instance_closed"); }
    catch (error) { throw new HttpError(503, `worker 종료 실패: ${error instanceof Error ? error.message : String(error)}`); }
    if (!(await instances.closeAppInstance(id, actorOf(user)))) throw new HttpError(404, "앱 인스턴스가 없습니다");
    return { ok: true, instance_id: id };
  },
};

export const appInstanceCapabilities: Capability[] = [
  appInstanceList, appInstanceOpen, appInstanceGet, appInstanceUpdate, appInstanceSetProject, appInstanceClose,
];
