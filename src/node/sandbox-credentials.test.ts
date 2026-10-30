// 맥락 잡 샌드박스 판의 자격 — 빌려 주기·되받기 (#4012 T2) — 사양 spec-codex-parity 의 L·H 행.
import { strict as assert } from "node:assert";
import { SANDBOX_CREDS, sandboxLeaseFor, harvestSandboxReturn, type HarvestDeps } from "./sandbox-credentials.js";
import { LEASE_SECRET } from "./task-scheduler.js";

// ── L: 빌려 주기 ────────────────────────────────────────────────────────────
{
  const calls: Array<[string, string, string]> = [];
  const lookup = (secret: string | null) => async (owner: string, kind: string, scope: string) => { calls.push([owner, kind, scope]); return { secret }; };
  const active = async () => "active";

  assert.deepEqual(await sandboxLeaseFor({ requester: "sm", harness: "claude" }, lookup("sk-ant"), active), { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant" }, "L1");
  assert.deepEqual(calls.at(-1), ["member:sm", "claude_setup_token", ""], "L1 조회 좌표");
  assert.deepEqual(await sandboxLeaseFor({ requester: "sm", harness: "codex" }, lookup(' {"tokens":1} '), active), { CODEX_AUTH_JSON: '{"tokens":1}' }, "L2");
  assert.deepEqual(calls.at(-1), ["member:sm", "codex_auth_json", ""], "L2 조회 좌표");

  const n = calls.length;
  assert.equal(await sandboxLeaseFor({ requester: "sm", harness: "grok" }, lookup("x"), active), undefined, "L3 표 밖 하네스");
  assert.equal(await sandboxLeaseFor({ requester: "sm", harness: "toString" }, lookup("x"), active), undefined, "L3 프로토타입 이름");
  assert.equal(calls.length, n, "L3 표 밖이면 조회도 안 한다");
  assert.equal(await sandboxLeaseFor({ requester: "sm", harness: "claude" }, lookup("x"), async () => "suspended"), undefined, "L3 비활성");
  assert.equal(await sandboxLeaseFor({ requester: "sm", harness: "claude" }, lookup("x"), async () => { throw new Error("db"); }), undefined, "L3 상태 조회 실패");
  assert.equal(await sandboxLeaseFor({ requester: "sm", harness: "claude" }, lookup(null), active), undefined, "L3 시크릿 없음");
  assert.equal(await sandboxLeaseFor({ requester: "sm", harness: "claude" }, lookup("   "), active), undefined, "L3 빈 값");
  assert.equal(await sandboxLeaseFor({ requester: "sm", harness: "claude" }, async () => { throw new Error("x"); }, active), undefined, "L3 조회 실패");
  assert.equal(await sandboxLeaseFor({ requester: "sm", harness: "claude" }, async () => null, active), undefined, "L3 행 없음");

  //  ★ L4 — 원격 노드 리스 표에는 codex 가 없다(공유 노드가 노드 주인 로그인으로 codex 판을 도는 구멍).
  assert.deepEqual(Object.keys(LEASE_SECRET), ["claude"], "L4 원격 리스 표는 claude 만");
  assert.deepEqual(Object.keys(SANDBOX_CREDS).sort(), ["claude", "codex"], "L4 샌드박스 표는 둘");
  assert.equal(SANDBOX_CREDS.claude!.kind, LEASE_SECRET.claude!.kind, "L4 claude 는 두 표가 같은 종류");
}

// ── H: 되받기 ───────────────────────────────────────────────────────────────
{
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = (acct: string): string => `${b64({})}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: acct } })}.s`;
  const file = (acct: string, at: string): string => JSON.stringify({ tokens: { id_token: jwt(acct), access_token: jwt(acct), refresh_token: at }, last_refresh: at });
  const STORED = file("acct-A", "2026-09-01T00:00:00Z");
  const NEWER = file("acct-A", "2026-09-10T00:00:00Z");
  const DIR = "/var/lib/lvly/tasks/acme/7-a1/out";

  interface Log { reads: string[]; stores: Array<[string, string, Record<string, unknown>]>; warns: string[] }
  const deps = (ret: string | null, stored: string | null = STORED, over: Partial<HarvestDeps> = {}): { d: HarvestDeps; log: Log } => {
    const log: Log = { reads: [], stores: [], warns: [] };
    return {
      log,
      d: {
        read: async (f) => { log.reads.push(f); return ret; },
        getStored: async () => stored,
        store: async (owner, secret, note) => { log.stores.push([owner, secret, note]); },
        warn: (msg) => { log.warns.push(msg); },
        ...over,
      },
    };
  };
  const task = (o: Partial<{ harness: string; task_dir: string | null }> = {}) => ({ id: 7, requester: "sm", harness: "codex", task_dir: DIR, ...o });

  const ok = deps("\n" + NEWER + "\n");
  assert.equal(await harvestSandboxReturn(task(), ok.d), "stored", "H1");
  assert.deepEqual(ok.log.reads, [`${DIR}/ret`], "H1 반환 채널 경로");
  assert.equal(ok.log.stores.length, 1, "H1 저장 1회");
  assert.equal(ok.log.stores[0]![0], "member:sm", "H1 실행 멤버 금고");
  assert.equal(ok.log.stores[0]![1], NEWER, "H1 내용 = 반환(앞뒤 공백 제거)");
  assert.equal(ok.log.stores[0]![2].refreshed_from_task, 7, "H1 갱신 흔적");

  for (const empty of [null, "", "   \n"]) {
    const e = deps(empty);
    assert.equal(await harvestSandboxReturn(task(), e.d), "none", `H2 ${JSON.stringify(empty)}`);
    assert.equal(e.log.stores.length, 0);
  }

  const evil = deps(file("acct-EVIL", "2026-09-10T00:00:00Z"));
  assert.equal(await harvestSandboxReturn(task(), evil.d), "rejected", "H3 다른 계정");
  assert.equal(evil.log.stores.length, 0, "H3 저장 0");
  assert.equal(evil.log.warns.length, 1, "H3 경고 1");
  const old = deps(file("acct-A", "2026-08-01T00:00:00Z"));
  assert.equal(await harvestSandboxReturn(task(), old.d), "rejected", "H3 옛것");
  const noBase = deps(NEWER, null);
  assert.equal(await harvestSandboxReturn(task(), noBase.d), "rejected", "H3 저장본 없음");
  assert.equal(noBase.log.stores.length, 0);

  const claude = deps(NEWER);
  assert.equal(await harvestSandboxReturn(task({ harness: "claude" }), claude.d), "skipped", "H4 claude");
  assert.equal(claude.log.reads.length, 0, "H4 읽지도 않는다");
  for (const dir of [null, "/work/shared/delegated/task-7/.lively-task/7", "/var/lib/lvly/tasks/acme/7-a1"]) {
    const x = deps(NEWER);
    assert.equal(await harvestSandboxReturn(task({ task_dir: dir }), x.d), "skipped", `H5 ${dir}`);
    assert.equal(x.log.reads.length, 0);
  }

  const boomRead = deps(NEWER, STORED, { read: async () => { throw new Error("EACCES"); } });
  assert.equal(await harvestSandboxReturn(task(), boomRead.d), "error", "H6 읽기 실패");
  assert.equal(boomRead.log.warns.length, 1);
  const boomStore = deps(NEWER, STORED, { store: async () => { throw new Error("db down"); } });
  assert.equal(await harvestSandboxReturn(task(), boomStore.d), "error", "H6 저장 실패도 던지지 않는다");
  const boomGet = deps(NEWER, STORED, { getStored: async () => { throw new Error("decrypt"); } });
  assert.equal(await harvestSandboxReturn(task(), boomGet.d), "error", "H6 조회 실패");
}

console.log("✓ sandbox-credentials — 샌드박스 자격 표·되받기 (L·H)");
process.exit(0);
