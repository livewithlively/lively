// 맥락 잡 샌드박스 판의 **자격** — 빌려 주기와 되받기 (#4012 T2 · codex 패리티).
//
// ── 왜 따로인가 ──────────────────────────────────────────────────────────────
// 원격 노드 리스 표(task-scheduler `LEASE_SECRET`)는 «env 로 넣으면 그 노드의 하네스가 그 자격으로 돈다» 는 약속의 표다.
//  claude 는 그렇다(CLAUDE_CODE_OAUTH_TOKEN). codex 는 **아니다** — env 가 아니라 `$CODEX_HOME/auth.json` 파일을 읽는다.
//  그 표에 codex 를 넣으면 공유 노드가 «리스가 있다» 며 codex 판을 받고, 실제로는 **그 노드 주인의 로그인**으로 돈다
//  (남의 계정 과금 · 남의 신원). 그래서 중앙 샌드박스 판의 자격은 이 표로 가른다 — 여기서는 op 가 파일로 넣어 준다.
//
// ── 되받기 ──────────────────────────────────────────────────────────────────
// codex 가 판 안에서 토큰을 갱신하면 auth.json 이 바뀐다. 판 스크립트가 그 파일을 반환 채널(out/ret)로 돌려주고,
//  여기서 **같은 계정 · 더 새것**일 때만 저장본을 바꾼다(codex-auth.codexReturnVerdict). 치우기 **전에** 불러야 한다
//  — 치우면 폴더가 사라진다.
import path from "node:path";
import { CODEX_AUTH_KIND, codexReturnVerdict } from "../org/credentials/codex-auth.js";
import { sandboxCoordsOfDir } from "./sandbox-task.js";

/** 샌드박스 판이 빌리는 자격 — 하네스 → (멤버 비밀 종류, 게이트웨이 안에서만 쓰는 env 이름). */
export const SANDBOX_CREDS: Readonly<Record<string, { kind: string; env: string }>> = Object.freeze({
  claude: Object.freeze({ kind: "claude_setup_token", env: "CLAUDE_CODE_OAUTH_TOKEN" }),
  codex: Object.freeze({ kind: CODEX_AUTH_KIND, env: "CODEX_AUTH_JSON" }),
});

type Lookup = (owner: string, kind: string, scope: string) => Promise<{ secret: string | null } | null>;
type StateOf = (memberId: string) => Promise<string | null>;

const memberOwnerOf = (id: string): string => `member:${id}`;

async function defaultLookup(owner: string, kind: string, scope: string): Promise<{ secret: string | null } | null> {
  const { getMemberSecret } = await import("../org/credentials/member-secret-store.js");
  return getMemberSecret(owner, kind, scope);
}
async function defaultStateOf(id: string): Promise<string | null> {
  const { getMember } = await import("../org/store/members.js");
  return (await getMember(id))?.state ?? null;
}

/**
 * 샌드박스 판에 빌려 줄 자격(env 모양). `leaseEnvFor` 와 같은 규율이다 —
 *  **활성 멤버일 때만**, 조회 실패·삭제·빈 값은 전부 «자격 없음»(undefined)으로 접는다(fail-closed).
 */
export async function sandboxLeaseFor(
  t: { requester: string; harness: string },
  lookup: Lookup = defaultLookup,
  stateOf: StateOf = defaultStateOf,
): Promise<Record<string, string> | undefined> {
  const spec = Object.hasOwn(SANDBOX_CREDS, t.harness) ? SANDBOX_CREDS[t.harness] : undefined;
  if (!spec) return undefined;
  const state = await stateOf(t.requester).catch(() => null);
  if (state !== "active") return undefined;
  const sec = await lookup(memberOwnerOf(t.requester), spec.kind, "").catch(() => null);
  const v = typeof sec?.secret === "string" ? sec.secret.trim() : "";
  return v ? { [spec.env]: v } : undefined;
}

export type HarvestOutcome = "stored" | "none" | "rejected" | "skipped" | "error";

export interface HarvestDeps {
  /** 반환 채널 파일 내용(없으면 null). */
  read(file: string): Promise<string | null>;
  /** 저장본(복호) — 없으면 null. */
  getStored(owner: string): Promise<string | null>;
  /** 저장본을 바꾼다 — label·meta 보존은 여기서 책임진다. */
  store(owner: string, secret: string, note: Record<string, unknown>): Promise<void>;
  warn(msg: string, detail: Record<string, unknown>): void;
}

async function defaultDeps(): Promise<HarvestDeps> {
  const store = await import("../org/credentials/member-secret-store.js");
  const { localTaskFs } = await import("./tasks.js");
  const { logger } = await import("../log.js");
  return {
    read: async (file) => {
      const got = await localTaskFs.readMany([{ key: "ret", path: file, max: 64 * 1024 }]);
      return got.ret ? got.ret.buf.toString("utf8") : null;
    },
    getStored: async (owner) => (await store.getMemberSecret(owner, CODEX_AUTH_KIND, ""))?.secret ?? null,
    store: async (owner, secret, note) => {
      //  label·meta 는 **보존**한다 — setMemberSecret 은 둘 다 통째로 바꾼다(사람이 붙인 이름이 사라지지 않게).
      const cur = (await store.listMemberSecretsPublic(owner)).find((c) => c.kind === CODEX_AUTH_KIND && c.scope_key === "");
      await store.setMemberSecret(owner, CODEX_AUTH_KIND, "", {
        secret, label: cur?.label ?? null, meta: { ...(cur?.meta ?? {}), ...note },
      }, "sandbox-refresh");
    },
    warn: (msg, detail) => logger.warn(detail, msg),
  };
}

/**
 * 끝난 판의 반환 채널을 거둔다. codex 판만 뜻이 있다. **던지지 않는다** — 수확 실패가 종결·치우기를 막으면 안 된다.
 */
export async function harvestSandboxReturn(
  t: { id: number; requester: string; harness: string; task_dir: string | null },
  inject: Partial<HarvestDeps> = {},
): Promise<HarvestOutcome> {
  if (t.harness !== "codex") return "skipped";
  if (!sandboxCoordsOfDir(t.task_dir)) return "skipped";
  const complete = inject.read && inject.getStored && inject.store && inject.warn;
  const d = { ...(complete ? {} : await defaultDeps()), ...inject } as HarvestDeps;
  try {
    const returned = await d.read(path.posix.join(String(t.task_dir), "ret"));
    if (!returned || !returned.trim()) return "none";
    const owner = memberOwnerOf(t.requester);
    const stored = await d.getStored(owner);
    const v = codexReturnVerdict(stored, returned);
    if (!v.accept) {
      d.warn("codex 판이 돌려준 자격을 받지 않았다", { task: t.id, requester: t.requester, why: v.why });
      return "rejected";
    }
    await d.store(owner, returned.trim(), { refreshed_from_task: t.id, refreshed_at: new Date().toISOString() });
    return "stored";
  } catch (e) {
    d.warn("codex 판 반환 수확 실패", { task: t.id, requester: t.requester, err: (e as Error)?.message ?? String(e) });
    return "error";
  }
}
