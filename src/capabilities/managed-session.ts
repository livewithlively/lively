// 상시 세션 capability — org_managed_session CRUD + ensure(즉시 띄우기/재생성). admin scope, REST+MCP.
//  상시 세션 = 에이전트를 위한 '프로젝트' — 격리 워크스페이스 + keep-alive + 계정 바인딩. 크론(map_unmapped)이 타깃.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import { listManagedSessions, getManagedSession, upsertManagedSession, deleteManagedSession, ensureManagedSession } from "../sessions/managed-sessions.js";

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function pid(v: unknown): string {
  const id = String(v ?? "").trim().toLowerCase();
  if (!ID_RE.test(id)) throw new HttpError(400, "id 는 소문자 슬러그(a-z0-9_-, 64자 이내)여야 합니다");
  return id;
}

const list: Capability = {
  name: "managed_session_list",
  title: "상시 세션 목록",
  description: "상시 에이전트 세션(org_managed_session) 목록 — 계정·격리워크스페이스·하네스·enabled·현재 tmux 세션 id.",
  scope: "admin",
  input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/managed-sessions"], parse: () => ({}) }] },
  handler: async () => {
    const sessions = await listManagedSessions();
    // #1675 ⑥ — 각 상시세션의 워크스페이스에 실제로 몇 개가 떠 있는지. 레지스트리는 1건인데 tmux 에 30개가
    //  떠 있던 실측이 있었고(claude 프로세스 29개 = 5.7GB), 그 사실이 **어느 화면에도 보이지 않았다**.
    //  keepalive 가 자동으로 정리하지만, 정리가 도는지·무엇을 걷었는지는 사람이 볼 수 있어야 한다.
    //  ⚠ tmux 를 못 보면(조회 실패) 0 이 아니라 **null**(모름)이다 — '없음'으로 단정하면 안 되는 자리다.
    try {
      const { listSessionsRaw } = await import("../terminal/terminal-sessions.js");
      const { classifyManagedLive, managedSubpath } = await import("../sessions/managed-sessions.js");
      const live = await listSessionsRaw();
      return {
        sessions: sessions.map((m) => ({
          ...m,
          orphan_count: classifyManagedLive({
            live, subpath: managedSubpath(m), registered: m.session_id,
          }).orphans.length,
        })),
      };
    } catch {
      return { sessions: sessions.map((m) => ({ ...m, orphan_count: null })) };
    }
  },
};

const set: Capability = {
  name: "managed_session_set",
  title: "상시 세션 생성/수정",
  description:
    "상시 세션을 upsert(id 기준). account=라이블리 계정/프로필(클로드 로그인), workspace_subpath=격리 워크스페이스(공유폴더 하위, 비우면 managed/<id>), " +
    "harness(claude 등)·auto_approve·enabled. enabled 면 keep-alive 가 tmux 세션을 보장한다.",
  scope: "admin",
  input: {
    id: z.string(),
    label: z.string().max(200).optional(),
    account: z.string().max(120).optional(),
    workspace_subpath: z.string().max(200).optional(),
    harness: z.string().max(40).optional(),
    flags: z.record(z.string()).optional(), // 하네스 플래그(예: {"--model":"opus","--effort":"high"}) — createSession 이 화이트리스트 검증 후 argv 적용.
    auto_approve: z.boolean().optional(),
    enabled: z.boolean().optional(),
    note: z.string().max(2000).optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/managed-sessions"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return {
        id: b.id, label: b.label, account: b.account, workspace_subpath: b.workspace_subpath, harness: b.harness, note: b.note,
        flags: (b.flags && typeof b.flags === "object" && !Array.isArray(b.flags)) ? b.flags : undefined,
        auto_approve: typeof b.auto_approve === "boolean" ? b.auto_approve : undefined,
        enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
      };
    } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const actor = ctx?.actor ?? user?.userId ?? null;
    return { session: await upsertManagedSession({ ...input, id: pid(input.id) }, actor) };
  },
};

const del: Capability = {
  name: "managed_session_delete",
  title: "상시 세션 삭제",
  description: "상시 세션 등록을 삭제(레지스트리에서 제거). 살아있는 tmux 세션 자체는 별도 — 터미널에서 종료.",
  scope: "admin",
  input: { id: z.string() },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/managed-sessions/:id/delete"], parse: (req) => ({ id: req.params?.id }) }] },
  handler: async (input: any) => deleteManagedSession(pid(input.id)),
};

const ensure: Capability = {
  name: "managed_session_ensure",
  title: "상시 세션 띄우기/재생성",
  description: "상시 세션의 tmux 세션을 지금 보장 — 살아있으면 no-op, 없으면 격리 워크스페이스에 재생성. 반환 {action, session_id}.",
  scope: "admin",
  input: { id: z.string() },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/managed-sessions/:id/ensure"], parse: (req) => ({ id: req.params?.id }) }] },
  handler: async (input: any) => {
    const m = await getManagedSession(pid(input.id));
    if (!m) throw new HttpError(404, "no such managed session: " + input.id);
    return ensureManagedSession(m);
  },
};

export const managedSessionCapabilities: Capability[] = [list, set, del, ensure];
