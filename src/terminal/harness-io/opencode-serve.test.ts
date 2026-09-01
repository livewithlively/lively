// opencode 서버 기동 계약 (#2439) — 실측(1.18.25 OpenAPI)에 근거한 주소·기동 규약.
import assert from "node:assert/strict";
import {
  ensureOpencodeServe, opencodeNewSession, opencodePost, opencodeReplyPermission,
  opencodeServeArgv, opencodeServePort, opencodeUrls,
} from "./opencode-serve.js";

let pass = 0;
const t = (name: string, fn: () => Promise<void> | void): Promise<void> =>
  Promise.resolve(fn()).then(() => { pass++; console.log(`ok  ${name}`); });

await t("[1] 포트는 세션에서 **결정론적**으로 나온다 — stdout 파싱은 형식 변화에 부서진다", () => {
  const a = opencodeServePort("s1"), b = opencodeServePort("s1"), c = opencodeServePort("s2");
  assert.equal(a, b, "같은 세션은 늘 같은 포트(재접속이 쉽다)");
  assert.notEqual(a, c, "다른 세션은 다른 포트");
  assert.ok(a > 1024 && a < 65536, "쓸 수 있는 범위");
});

await t("[2] ★ codex 와 포트 슬롯이 겹치지 않는다 — 전환 직후 죽어가는 서버에 붙지 않게", async () => {
  const { sessionPort } = await import("./codex-app-server-daemon.js");
  assert.notEqual(opencodeServePort("s1"), sessionPort("s1", 0));
});

await t("[3] ★ hostname 을 명시한다 — 기본값에 기대지 않는다(테넌트 밖으로 포트를 열면 남이 조종한다)", () => {
  const argv = opencodeServeArgv(4321);
  assert.deepEqual(argv, ["opencode", "serve", "--port", "4321", "--hostname", "127.0.0.1"]);
});

await t("[4] 읽기와 쓰기의 주소가 다르다(SSE 는 읽기 전용)", () => {
  const u = opencodeUrls(4321);
  assert.equal(u.base, "http://127.0.0.1:4321");
  assert.equal(u.event, "http://127.0.0.1:4321/event");
});

await t("[5] 이미 살아 있으면 **다시 띄우지 않는다** — 두 서버가 같은 포트를 다투면 둘 다 못 쓴다", async () => {
  let spawned = 0;
  const r = await ensureOpencodeServe({
    sessionId: "s1", cwd: "/tmp", osUser: null,
    spawnFn: () => { spawned++; return {}; },
    waitPortFn: async () => true,          // 이미 열려 있다
  });
  assert.deepEqual(r, { port: opencodeServePort("s1"), started: false });
  assert.equal(spawned, 0);
});

await t("[6] 없으면 띄우고 포트를 기다린다", async () => {
  let spawned = 0, waits = 0;
  const r = await ensureOpencodeServe({
    sessionId: "s2", cwd: "/tmp", osUser: null,
    spawnFn: () => { spawned++; return {}; },
    waitPortFn: async () => { waits++; return waits > 1; },   // 1회차(살아있나) 실패 → 띄운 뒤 성공
  });
  assert.equal(spawned, 1);
  assert.equal(r?.started, true);
});

await t("[7] ★ 포트가 안 열리면 null — 실패를 «떴다» 로 접지 않는다(던지지도 않는다)", async () => {
  const r = await ensureOpencodeServe({
    sessionId: "s3", cwd: "/tmp", osUser: null,
    spawnFn: () => ({}), waitPortFn: async () => false, waitMs: 10,
  });
  assert.equal(r, null, "호출자가 폴백을 정한다 — 여기서 던지면 그 세션은 어느 화면도 못 쓴다");
});

await t("[8] 실측 엔드포인트로 보낸다 — POST /session/{id}/prompt_async", async () => {
  let url = "", body: any = null;
  const ok = await opencodePost({
    base: "http://x", opencodeSessionId: "oc1", text: "안녕",
    fetchFn: (async (u: string, init: any) => { url = u; body = JSON.parse(init.body); return { ok: true }; }) as any,
  });
  assert.equal(ok, true);
  assert.equal(url, "http://x/session/oc1/prompt_async");
  assert.deepEqual(body.parts, [{ type: "text", text: "안녕" }]);
});

await t("[9] 승인은 REST 한 번 — ★«항상 허용» 은 별개 축이다(섞으면 의도보다 넓게 열린다)", async () => {
  const seen: any[] = [];
  const f = (async (u: string, init: any) => { seen.push([u, JSON.parse(init.body)]); return { ok: true }; }) as any;
  await opencodeReplyPermission({ base: "http://x", requestId: "p1", allow: true, fetchFn: f });
  await opencodeReplyPermission({ base: "http://x", requestId: "p1", allow: true, always: true, fetchFn: f });
  await opencodeReplyPermission({ base: "http://x", requestId: "p1", allow: false, fetchFn: f });
  assert.equal(seen[0][0], "http://x/permission/p1/reply");
  assert.equal(seen[0][1].response, "once");
  assert.equal(seen[1][1].response, "always");
  assert.equal(seen[2][1].response, "reject");
});

await t("[10] 네트워크가 죽어도 던지지 않는다 — false 로 사실을 말한다", async () => {
  const boom = (async () => { throw new Error("ECONNREFUSED"); }) as any;
  assert.equal(await opencodePost({ base: "http://x", opencodeSessionId: "o", text: "t", fetchFn: boom }), false);
  assert.equal(await opencodeReplyPermission({ base: "http://x", requestId: "p", allow: true, fetchFn: boom }), false);
});

await t("[11] ★ 세션 생성은 **인증 없이 된다**(실측 2026-09-01) — opencode 만의 성질이다", async () => {
  //  실물 응답: {"id":"ses_fa798f19…","slug":"swift-panda","projectID":"global","directory":…}
  const id = await opencodeNewSession({
    base: "http://x", cwd: "/w",
    fetchFn: (async (_u: string, init: any) => {
      assert.deepEqual(JSON.parse(init.body), { directory: "/w" });
      return { ok: true, json: async () => ({ id: "ses_1", slug: "swift-panda" }) };
    }) as any,
  });
  assert.equal(id, "ses_1");
  //  실패는 null — 던지지 않는다(호출자가 폴백을 정한다).
  assert.equal(await opencodeNewSession({ base: "http://x", fetchFn: (async () => ({ ok: false })) as any }), null);
  assert.equal(await opencodeNewSession({ base: "http://x", fetchFn: (async () => ({ ok: true, json: async () => ({}) })) as any }), null,
    "id 가 없으면 «만들었다» 고 하지 않는다");
});

console.log(`\n${pass}건 통과`);
