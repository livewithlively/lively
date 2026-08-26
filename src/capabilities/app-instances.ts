// AppInstance capability(#1780 v2.1) — 설치된 AppPackage와 탭에 열리는 실행 단위를 분리한다.
// 프로젝트 소속은 instance의 nullable 맥락이며 권한이 아니다: 연결·조회 때 프로젝트 존재와 가시성을 다시 확인한다.
import { z } from "zod";
import { itemsPool } from "../db/client.js";
import type { LivelyUser } from "../context.js";
import type { Capability, CapabilityCtx } from "./types.js";
import { HttpError } from "./rest-util.js";
import { canSeeProjectRow } from "../v6/visibility.js";
import { listSessions } from "../terminal/terminal-sessions.js";
import { getSessionState, getSessionStates } from "../sessions/session-state.js";
import { parseAppManifest, type LivelyAppManifest } from "../apps/manifest.js";
import { normalizeInstanceProject, normalizeInstanceState } from "../apps/instance-policy.js";
import * as apps from "../org/store/apps.js";
import * as instances from "../org/store/app-instances.js";
import { resolveWorkerPlacement, startWorkerForInstance, stopWorkerForInstance, workerRunForInstance } from "../apps/worker-service.js";
import { nodeOnline, nodeSessionsFor, nodeSupports } from "../node/registry.js";
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

async function assertRemoteExecution(nodeId: string, user: LivelyUser): Promise<void> {
  const node = await getNode(nodeId);
  if (!node || !node.enabled) throw new HttpError(409, "선택한 원격 노드가 비활성 상태입니다");
  if (!nodeOpenTo(node, actorOf(user))) throw new HttpError(403, "본인 노드 또는 관리자가 공유한 노드에서만 앱을 실행할 수 있습니다");
  if (!nodeOnline(nodeId) || !nodeSupports(nodeId, "startWorker") || !nodeSupports(nodeId, "stageWorkerChunk")) {
    throw new HttpError(409, !nodeOnline(nodeId) ? "선택한 원격 노드가 오프라인입니다" : "원격 노드가 worker 실행을 지원하지 않습니다");
  }
}

// ── 세션 인스턴스에 **지금의 정본**을 얹는다(#2022) ────────────────────────────────
//  화면이 세션 이름·소속을 아는 길은 세션 목록 응답 하나뿐이었다. 그래서 목록이 오기 전(부팅 첫 그림)과
//  목록에서 빠진 세션(회수·정리된 박스, 오프라인 노드)에서 이름이 `세션 <id꼬리>` 로, 소속이 '프로젝트 없음'
//  으로 떨어졌다 — 정작 그 값은 desired-state(DB)에 그대로 있는데도. 인스턴스 행이 이미 세션 id 를 subject 로
//  쥐고 있으므로 여기서 함께 실어 보낸다. 저장된 title 은 그 순간의 스냅샷이라 늙는다(실측: 'claude · resume',
//  '/status', box id 그대로) — 그래서 **덮지 않고 별도 필드**로 준다. 화면이 정본을 먼저 쓰고 title 은 폴백이다.
//   · subject_label      — 지금의 이름   · subject_project_id — 지금의 소속
//   · subject_state      — 'known'(어느 쪽으로든 아는 세션) | 'gone'(desired-state 도 노드 스냅샷도 없다 = 되살릴 수 없다)
//
//  ⚠ 여기서 **tmux 를 훑지 않는다.** 이 목록은 화면 폴링마다 불리는데(20초), 같은 폴링이 이미
//   /api/ui/terminal/sessions 로 tmux 를 한 번 훑는다 — 두 번째 스캔을 여기에 얹을 이유가 없다.
//   재료는 둘 다 싸다: desired-state 는 한 번의 ANY() 조회, 노드 세션은 게이트웨이 메모리 스냅샷.
//  ⚠ 건별 조회를 만들지 않는다 — 인스턴스 수만큼 왕복하면 목록 한 번이 수십 쿼리가 된다.
//  ⚠ 노출 범위는 세션 목록과 같다 — 내 세션이거나 프로젝트 세션(#452 로 로그인 전원 공개)일 때만 이름을 싣는다.
async function sessionSubjects(
  rows: instances.AppInstanceRow[],
  user: LivelyUser,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const sessionRows = rows.filter((r) => r.subject_kind === "session" && !!r.subject_ref);
  if (!sessionRows.length) return out;
  const owner = actorOf(user);
  const ids = sessionRows.map((r) => String(r.subject_ref));
  const states = await getSessionStates(ids).catch(() => new Map<string, Awaited<ReturnType<typeof getSessionState>>>());
  const nodeSeen = new Map(nodeSessionsFor(owner).map((s) => [s.id, s]));
  for (const r of sessionRows) {
    const id = String(r.subject_ref);
    const st = states.get(id);
    const nd = nodeSeen.get(id);
    if (!st && !nd) { out.set(r.id, { subject_state: "gone" }); continue; }
    const mine = !st || st.owner === owner || !!st.project_id;   // 세션 목록과 같은 노출 범위
    const label = mine ? String(st?.label || nd?.label || "").trim() : "";
    const projectId = mine ? (Number(st?.project_id || nd?.projectId || 0) || null) : null;
    out.set(r.id, {
      subject_state: "known",
      // id 를 그대로 쓴 이름은 이름이 아니다 — 화면이 그걸 '아는 이름'으로 오해하지 않게 비워 보낸다.
      subject_label: label && label !== id ? label : null,
      subject_project_id: projectId,
    });
  }
  return out;
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
    const subjects = await sessionSubjects(rows, user);
    const visible: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      // project_id 는 분류·provenance일 뿐 인스턴스 조회 권한이 아니다. 앱 자체가 비활성이면 목록에서만 제외한다.
      try { visible.push({ ...(await decorate(row)), ...(subjects.get(row.id) ?? {}) }); }
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
    if (manifest.runtime && !(await apps.getActiveGrant(app.id, actorOf(user)))) {
      throw new HttpError(403, `앱 '${app.id}' 사용 동의(grant)가 없습니다`);
    }
    let projectId = normalizeInstanceProject(manifest, input.project_id);
    const requested = requestedExecution(input.execution);
    let placement: ReturnType<typeof resolveWorkerPlacement>;
    try { placement = resolveWorkerPlacement(manifest, requested); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "worker placement 오류"); }
    if (placement?.kind === "remote") await assertRemoteExecution(placement.nodeId!, user);

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
const appInstanceRestart: Capability = {
  name: "app_instance_restart",
  title: "앱 worker 다시 실행",
  description: "기존 AppInstance 정체성과 실행 위치를 유지한 채 종료된 worker를 새 WorkerRun으로 다시 실행한다.",
  scope: null,
  input: closeInput,
  expose: { mcp: false, rest: [{ method: "POST", paths: ["/api/ui/app-instances/:id/restart"], parse: (req) => ({ instance_id: (req.params as Record<string, string>)?.id }) }] },
  handler: async (input: z.infer<z.ZodObject<typeof closeInput>>, user: LivelyUser) => {
    const id = instanceId(input.instance_id);
    const found = await instances.getAppInstance(id, actorOf(user));
    if (!found) throw new HttpError(404, "앱 인스턴스가 없습니다");
    if (found.status !== "active") throw new HttpError(409, "닫힌 앱 인스턴스는 다시 열어야 합니다");
    const { app, manifest } = await activeApp(found.app_id);
    if (!manifest.runtime) throw new HttpError(409, "이 앱에는 다시 실행할 worker가 없습니다");
    if (!(await apps.getActiveGrant(app.id, actorOf(user)))) throw new HttpError(403, `앱 '${app.id}' 사용 동의(grant)가 없습니다`);
    if (found.execution_host_kind === "remote") {
      if (!found.execution_host_id) throw new HttpError(409, "원격 실행 노드가 지정되지 않았습니다");
      await assertRemoteExecution(found.execution_host_id, user);
    }
    try { await startWorkerForInstance(app, manifest, found); }
    catch (error) { throw new HttpError(503, `worker 시작 실패: ${error instanceof Error ? error.message : String(error)}`); }
    return { instance: await decorate(found) };
  },
};

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
  appInstanceList, appInstanceOpen, appInstanceGet, appInstanceUpdate, appInstanceSetProject, appInstanceRestart, appInstanceClose,
];
