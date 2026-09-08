// #2544 — 장부 조립·접근 판정·라이브 id 읽기(가짜 tmux seam).
import { strict as assert } from "node:assert";
import test, { afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSessionLedger, ledgerAccess, ledgerAuthToken, LEDGER_AUTH_HEADER } from "./session-ledger.js";
import { listLiveSessionIds } from "./sessions.js";

const rows = [
  { id: "box-a-1111", superseded_by: null, node_id: null },
  { id: "box-b-2222", superseded_by: "box-b-3333", node_id: null },
  { id: "box-n-4444", superseded_by: null, node_id: "node-1" },
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
