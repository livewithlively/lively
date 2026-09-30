import { strict as assert } from "node:assert";
import test from "node:test";
import { appStoreCapabilities } from "./app-store.js";
import type { LivelyUser } from "../context.js";

// ── store_* 진입 — 어느 앱의 데이터로 들어가나 (#4225, 사양 표 S2) ─────────────────
//  DB 에 닿기 **전에** 끝나는 판정만 본다(앞 관문이 DB 를 안 읽고 거절하는 것 자체가 단언이다 — 이 테스트 계층엔 DB 가 없다).
//  붙은 세션 갈래의 판정 표는 apps/session-apps.test.ts(S1).
//  이게 틀리면: 앱 화면·앱 세션이 app_id 를 바꿔 **남의 앱 테이블**에 들어간다(S2-2) · 세션 밖의 일반 토큰이 앱 판정 없이
//   흘러 들어간다(S2-3).

const TOOLS = ["store_insert", "store_query", "store_update", "store_delete", "store_tables"] as const;
const cap = (n: string) => {
  const c = appStoreCapabilities.find((x) => x.name === n);
  assert.ok(c, n + " 이 등록돼 있다");
  return c!;
};
const user = (over: Partial<LivelyUser> = {}): LivelyUser => ({ userId: "alice", email: "a@x", scopes: ["items"], projects: ["*"], ...over });
const args = (n: string, extra: Record<string, unknown>): Record<string, unknown> => {
  const base: Record<string, Record<string, unknown>> = {
    store_insert: { table: "t", row: { a: 1 } },
    store_query: { table: "t" },
    store_update: { table: "t", match: { id: 1 }, set: { a: 2 } },
    store_delete: { table: "t", match: { id: 1 } },
    store_tables: {},
  };
  return { ...base[n], ...extra };
};
const status = async (p: Promise<unknown>): Promise<number | "ok" | string> => {
  try { await p; return "ok"; } catch (e) { const s = (e as { status?: number }).status; return s ?? String((e as Error)?.message ?? e); }
};

test("S2-2 앱 화면·앱 세션이 다른 앱의 app_id 를 주면 403 — 다섯 도구 전부", async () => {
  for (const n of TOOLS) {
    assert.equal(await status(cap(n).handler(args(n, { app_id: "other" }), user({ appId: "crm" }), { source: "mcp" })), 403, n);
  }
});

test("S2-3 앱 principal 도 세션도 없는 호출 → 400 — 다섯 도구 전부", async () => {
  for (const n of TOOLS) {
    assert.equal(await status(cap(n).handler(args(n, {}), user(), { source: "web" })), 400, n);
    assert.equal(await status(cap(n).handler(args(n, { app_id: "crm" }), user(), { source: "web" })), 400, n + " (app_id 만으로는 못 들어간다)");
  }
});

test("S2 입력 계약 — app_id 는 다섯 도구 모두의 선택 입력이다(MCP 표면에 실린다)", () => {
  for (const n of TOOLS) assert.ok("app_id" in cap(n).input, n);
});
