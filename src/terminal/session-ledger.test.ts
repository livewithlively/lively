// #2544 — 장부 조립·접근 판정·라이브 id 읽기(가짜 tmux seam).
import { strict as assert } from "node:assert";
import test, { afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSessionLedger, ledgerAccess, ledgerAuthToken, LEDGER_AUTH_HEADER } from "./session-ledger.js";
import { listLiveSessionIds } from "./sessions.js";

const rows = [
  { id: "box-a-1111", superseded_by: null, node_id: null, exited_at: null },
  { id: "box-b-2222", superseded_by: "box-b-3333", node_id: null, exited_at: null },
  { id: "box-n-4444", superseded_by: null, node_id: "node-1", exited_at: null },
  //  #3822 — 사람이 /exit 로 끝낸 세션. 장부는 이 사실을 **그대로 실어 나른다**(판정은 소비자 몫).
  { id: "box-x-6666", superseded_by: null, node_id: null, exited_at: "2026-09-09T00:00:00.000Z" },
];

test("buildSessionLedger — desired 전 행(superseded 포함) + 상시세션 + 관측", async () => {
  const b = await buildSessionLedger({
    listRows: async () => rows,
    listManaged: async () => [{ session_id: "box-m-5555" }, { session_id: null }],
    listLive: async () => ["box-a-1111", "box-m-5555"],
  });
  assert.equal(b.authoritative, true);
  assert.equal(b.observed, true);
  assert.deepEqual(b.desired, rows, "superseded 행도 그대로 준다(은퇴 판정은 소비자 몫)");
  assert.equal(b.desired.find((r) => r.id === "box-x-6666")?.exited_at, "2026-09-09T00:00:00.000Z",
    "#3822 — 사용자 종료 표시가 장부에 실려야 브로커가 그 컨테이너를 걷는다");
  assert.deepEqual(b.managed, ["box-m-5555"], "session_id 없는 상시세션은 뺀다");
  assert.deepEqual(b.live, ["box-a-1111", "box-m-5555"]);
});

test("★ buildSessionLedger — tmux 를 못 봤으면 observed:false · live:null (빈 배열이 아니다)", async () => {
  const b = await buildSessionLedger({
    listRows: async () => rows, listManaged: async () => [],
    listLive: async () => { throw Object.assign(new Error("relay"), { stderr: "브로커 응답 없음" }); },
  });
  assert.equal(b.observed, false);
  assert.equal(b.live, null);
  assert.deepEqual(b.desired, rows, "desired 는 관측과 무관하게 나간다");
});

test("★ buildSessionLedger — desired(DB) 를 못 읽으면 던진다(빈 장부로 답하지 않는다)", async () => {
  await assert.rejects(buildSessionLedger({
    listRows: async () => { throw new Error("db down"); }, listManaged: async () => [], listLive: async () => [],
  }), /db down/);
});

const T = { "x-lvly-tenant-auth": "s3cret", "x-lvly-tenant": "acme", "x-lvly-tenant-id": "11111111-1111-1111-1111-111111111111" };
const H = { ...T, [LEDGER_AUTH_HEADER]: ledgerAuthToken("s3cret", "acme") };
const ENV = { LIVELY_TENANT_HEADER_SECRET: "s3cret" };

test("★ ledgerAccess — 비밀 미설정(셀프호스팅)=404 · 틀린 비밀=401 · 헤더+서명이 맞아야 200", () => {
  assert.equal(ledgerAccess(H, {}).status, 404, "비밀이 없는 배포엔 이 경로가 없다");
  assert.equal(ledgerAccess(H, { LIVELY_TENANT_HEADER_SECRET: "other" }).status, 401);
  assert.equal(ledgerAccess({}, ENV).status, 401, "헤더 없음");
  assert.equal(ledgerAccess({ ...H, "x-lvly-tenant-id": "" }, ENV).status, 401, "식별 정보 부족도 401(사유를 가르지 않는다)");
  assert.equal(ledgerAccess(H, ENV).status, 200);
});

test("★★ ledgerAccess — 라우터·MCP 프록시가 붙이는 테넌트 헤더만으로는 못 연다(서명 없음/남의 slug 서명=401)", () => {
  //  이 행이 지키는 것: 로그인 없는 인터넷 요청(라우터가 테넌트 헤더를 붙여 준다)이 장부를 못 읽는다.
  assert.equal(ledgerAccess(T, ENV).status, 401, "테넌트 헤더 셋만 — 라우터 경유 요청의 모양");
  assert.equal(ledgerAccess({ ...T, [LEDGER_AUTH_HEADER]: ledgerAuthToken("s3cret", "other") }, ENV).status, 401, "다른 slug 의 서명");
  assert.equal(ledgerAccess({ ...T, [LEDGER_AUTH_HEADER]: ledgerAuthToken("wrong", "acme") }, ENV).status, 401, "다른 비밀의 서명");
  assert.equal(ledgerAccess({ ...T, [LEDGER_AUTH_HEADER]: "" }, ENV).status, 401, "빈 서명");
  assert.notEqual(ledgerAuthToken("s3cret", "acme"), ledgerAuthToken("s3cret", "acmf"), "slug 가 서명에 묶인다");
});

// ── listLiveSessionIds — 가짜 tmux 를 seam 에 꽂아 «없다» 와 «못 봤다» 를 가른다 ───────────
afterEach(() => { delete process.env.LIVELY_TMUX_EXEC; });
function fakeTmux(script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-tmux-"));
  const bin = path.join(dir, "tmux.sh");
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return bin;
}

test("listLiveSessionIds — box-* 만, strict 라도 서버 부재는 빈 배열(확답)", async () => {
  process.env.LIVELY_TMUX_EXEC = fakeTmux('printf "box-a-1111\\nlvly-keeper\\nbox-b-2222\\n"');
  assert.deepEqual(await listLiveSessionIds({ strict: true }), ["box-a-1111", "box-b-2222"]);
  process.env.LIVELY_TMUX_EXEC = fakeTmux('echo "no server running on /tmp/tmux-1/lvly-acme" >&2; exit 1');
  assert.deepEqual(await listLiveSessionIds({ strict: true }), [], "서버 부재 = 세션 0 확답");
});

test("★ listLiveSessionIds — strict 는 «못 봤다» 를 던지고, 비strict 는 빈 배열로 접는다(종전 collectSessions 와 같은 규약)", async () => {
  process.env.LIVELY_TMUX_EXEC = fakeTmux('echo "lvly tmux-relay: 브로커 응답 없음" >&2; exit 1');
  await assert.rejects(listLiveSessionIds({ strict: true }));
  assert.deepEqual(await listLiveSessionIds(), []);
});

// ── #4939 재설계 v2 — 장부의 최종 판정(판정 한 곳) ────────────────────────────────────────────────

test("[#4939 G8] ★ 끝남 표식이 있어도 지금 어느 세션 호스트 목록에든 보이면 «끝남» 으로 내지 않는다(종전엔 브로커가 tmux 로 뒤집었다)", async () => {
  const b = await buildSessionLedger({
    listRows: async () => rows, listManaged: async () => [], listLive: async () => [],
    liveAnywhere: () => new Set(["box-x-6666"]),
  });
  const x = b.desired.find((r) => r.id === "box-x-6666");
  assert.equal(x?.exited_at, null, "살아 있는 세션의 끝남 표식을 내보냈다");
  assert.equal(b.desired.find((r) => r.id === "box-b-2222")?.superseded_by, "box-b-3333", "이어짐은 관측과 무관하게 그대로");
});

test("[#4939 G9] 관측이 없으면(목록에 안 보임 · 호스트가 목록을 안 쥔 배포) 끝남 표식을 그대로 낸다", async () => {
  for (const liveAnywhere of [() => new Set<string>(), () => null]) {
    const b = await buildSessionLedger({ listRows: async () => rows, listManaged: async () => [], listLive: async () => [], liveAnywhere });
    assert.equal(b.desired.find((r) => r.id === "box-x-6666")?.exited_at, "2026-09-09T00:00:00.000Z");
  }
});

test("[#4939 G12] ★ 도달 불가로 적힌 상시 세션은 상시 목록에서 빠지고 «끝남» 행으로 실린다(DB 행이 없는 것이 설계 — #1059 E)", async () => {
  const at = Date.parse("2026-10-22T09:00:00.000Z");
  const b = await buildSessionLedger({
    listRows: async () => rows, listLive: async () => [],
    listManaged: async () => [{ session_id: "box-m-5555" }, { session_id: "box-m-7777" }],
    unreachableManaged: () => new Map([["box-m-5555", at]]),
  });
  assert.deepEqual(b.managed, ["box-m-7777"]);
  const m = b.desired.find((r) => r.id === "box-m-5555");
  assert.deepEqual(m, { id: "box-m-5555", superseded_by: null, node_id: null, exited_at: new Date(at).toISOString(), exit_reason: "unreachable" });
  //  지금 다시 보이면 표식이 있어도 끝남으로 안 낸다(되살아남 — 정비가 표식을 지우기 전 창).
  const live = await buildSessionLedger({
    listRows: async () => rows, listLive: async () => [], listManaged: async () => [{ session_id: "box-m-5555" }],
    unreachableManaged: () => new Map([["box-m-5555", at]]), liveAnywhere: () => new Set(["box-m-5555"]),
  });
  assert.deepEqual(live.managed, ["box-m-5555"]);
  assert.equal(live.desired.find((r) => r.id === "box-m-5555"), undefined);
});

test("[#4939 WIRE] 라우트가 최종 판정 재료 둘을 잇는다 — 지금 보이는 세션(신선한 세션 호스트의 합) · 도달 불가로 적힌 상시 세션(메모리 표식)", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src", "terminal", "session-ledger.ts"), "utf8");
  const route = src.slice(src.indexOf("export function registerSessionLedgerRoute"));
  assert.match(route, /liveAnywhere: \(\) => sessionHostLiveUnion\(\)/, "🔴 G8 이 라우트에 안 이어졌다 — 살아 있는 세션의 끝남 표식이 그대로 나간다");
  assert.match(route, /unreachableManaged: \(\) => unreachableManagedMarks\(\)/, "🔴 H6 이 라우트에 안 이어졌다 — 상시 세션 판정이 브로커에 안 닿는다");
});
