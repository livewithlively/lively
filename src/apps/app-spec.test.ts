import { strict as assert } from "node:assert";
import test from "node:test";
import { SPEC_RUNNING_STALE_MS, SPEC_WHERE_MAX, decideSpec, parseSpecOutput, specFacts, specInput, specKeyOf, specPrompt, type SpecRow } from "./app-spec.js";
import { makeSpecScheduler } from "./app-spec-run.js";

// ── 앱 「개발 정보」(#4632) — 사양 엣지 표의 순수 부분 ──────────────────────────────
//  이게 틀리면: 코드에서 읽은 사실이 코드와 어긋나거나(SSOT 위반) · 저장할 때마다 AI 설명을 여러 번 써 돈이 새거나 · 실패가 열 때마다 되풀이된다.

const MAN = {
  id: "app-x", title: "회의록",
  ui: { pages: [{ key: "main", entry: "ui/index.html", title: "회의록", display: ["inline", "fullscreen"] }] },
  data: { tables: [{ name: "meetings", columns: [{ name: "title", type: "text" }, { name: "run_id", type: "int" }] }, { name: "audio_chunks", columns: [{ name: "data" }] }] },
  permissions: { tools: ["store_query", "store_insert"], chat_send: true, ai_runs: true, project_files: ["html"] },
  agent: { instructions: "규칙" },
};
const f = (path: string, content: string, encoding?: "utf8" | "base64") => ({ path, content, ...(encoding ? { encoding } : {}) });

test("F1 표와 칸 · 화면 · 권한을 매니페스트 그대로 읽는다", () => {
  const x = specFacts(MAN, []);
  assert.deepEqual(x.tables, [
    { name: "meetings", columns: [{ name: "title", type: "text" }, { name: "run_id", type: "int" }] },
    { name: "audio_chunks", columns: [{ name: "data", type: "text" }] },
  ]);
  assert.deepEqual(x.pages, [{ key: "main", title: "회의록", entry: "ui/index.html", places: ["세션 옆", "앱 화면"] }]);
  assert.deepEqual(x.perms.map((p) => p.key), ["tool:store_query", "tool:store_insert", "chat_send", "ai_runs", "project_files"]);
  assert.match(x.perms.find((p) => p.key === "project_files")!.label, /html/);
  assert.equal(x.instructions, true);
});

test("F2 data · permissions 가 없거나 모양이 틀려도 던지지 않고 빈 목록", () => {
  for (const m of [{}, null, { data: "x", permissions: 3, ui: { pages: "y" } }, { data: { tables: [null, { columns: [] }] } }]) {
    const x = specFacts(m, []);
    assert.deepEqual([x.tables, x.perms, x.pages, x.calls, x.files], [[], [], [], [], []]);
    assert.equal(x.server, null);
    assert.equal(x.instructions, false);
  }
});

test("F3 /_lively/ai/runs 두 곳 → 한 줄 · 자리 둘(파일:줄)", () => {
  const js = "a\nfetch('/_lively/ai/runs', {method:'POST'})\nb\nfetch('/_lively/ai/runs/' + id)\n";
  const x = specFacts(MAN, [f("ui/index.html", js)]);
  const c = x.calls.filter((y) => y.kind === "lively");
  assert.equal(c.length, 1);
  assert.equal(c[0].name, "/_lively/ai/runs");
  assert.equal(c[0].count, 2);
  assert.deepEqual(c[0].where, [{ file: "ui/index.html", line: 2 }, { file: "ui/index.html", line: 4 }]);
});

test("F4 tools.call('app_notify') → 도구 · SDK 호출 · 모델 이름 · 바깥 주소", () => {
  const js = [
    "L.tools.call('app_notify', {member_id: m})",
    "L.store.query('meetings', {}); lively.store['delete']('x', {id})",
    "const MODEL = 'claude-sonnet-5-5'; // whisper-1 로 받아쓰기",
    "fetch('https://api.openai.com/v1/audio/transcriptions')",
  ].join("\n");
  const x = specFacts(MAN, [f("server/main.mjs", js)]);
  const names = x.calls.map((c) => c.kind + ":" + c.name);
  for (const n of ["tool:app_notify", "sdk:store.query", "sdk:store.delete", "model:claude-sonnet-5-5", "model:whisper-1", "host:api.openai.com"]) assert.ok(names.includes(n), n + " 없음: " + names.join(", "));
  assert.deepEqual(x.calls.find((c) => c.name === "api.openai.com")!.where, [{ file: "server/main.mjs", line: 4 }]);
});

test("F5 같은 호출 30곳 → count 30 · 자리는 상한까지", () => {
  const js = Array.from({ length: 30 }, () => "L.store.query('t')").join("\n");
  const c = specFacts(MAN, [f("ui/index.html", js)]).calls.find((y) => y.name === "store.query")!;
  assert.equal(c.count, 30);
  assert.equal(c.where.length, SPEC_WHERE_MAX);
});

test("F6 바이너리 · 매니페스트 파일은 훑지 않는다 · 파일 목록엔 있다", () => {
  const b64 = Buffer.from("fetch('/_lively/store')").toString("base64");
  const x = specFacts(MAN, [f("img/a.png", b64, "base64"), f("lively-app.json", JSON.stringify({ u: "https://api.x.com" })), f("ui/a.bin", "fetch('/_lively/me')")]);
  assert.deepEqual(x.calls, []);
  assert.deepEqual(x.files.map((y) => [y.path, y.text]), [["img/a.png", false], ["lively-app.json", true], ["ui/a.bin", false]]);
  assert.equal(x.files[0].size, Buffer.from(b64, "base64").length);
});

test("F7 표준 이름공간(svg xmlns) 은 바깥 주소가 아니다", () => {
  const x = specFacts(MAN, [f("ui/index.html", '<svg xmlns="http://www.w3.org/2000/svg"></svg> <a href="https://example.com">x</a>')]);
  assert.deepEqual(x.calls, []);
});

test("F8 서버 선언 · 기기 선언", () => {
  const x = specFacts({ ...MAN, web: { server: { start: "node main.mjs", dir: "server" }, devices: ["microphone"] } }, []);
  assert.deepEqual(x.server, { start: "node main.mjs", dir: "server" });
  assert.ok(x.perms.some((p) => p.key === "devices" && /microphone/.test(p.label)));
  assert.deepEqual(specFacts({ web: { server: true } }, []).server, { start: null, dir: null });
});

test("I1 AI 에 실을 코드 — 매니페스트 먼저 · studio/ 맨 뒤 · 바이너리는 이름만", () => {
  const r = specInput([f("studio/wireframe.html", "W"), f("ui/index.html", "U"), f("lively-app.json", "{}"), f("a.png", "AA", "base64")]);
  assert.deepEqual(r.included, ["lively-app.json", "ui/index.html", "studio/wireframe.html"]);
  assert.deepEqual(r.skipped, ["a.png"]);
  assert.ok(r.text.indexOf("lively-app.json") < r.text.indexOf("ui/index.html") && r.text.indexOf("ui/index.html") < r.text.indexOf("studio/wireframe.html"));
});

test("I2 상한을 넘으면 거기서 자르고 잘린 파일을 알린다", () => {
  const r = specInput([f("lively-app.json", "{}"), f("ui/index.html", "x".repeat(5000)), f("ui/b.js", "y".repeat(100))], 1000);
  assert.ok(r.text.length <= 1000 + 40);
  assert.deepEqual(r.truncated, ["ui/index.html"]);
  assert.ok(r.text.includes("y".repeat(100)) && r.text.includes("(여기서 잘림)"));
  assert.ok(!r.text.includes("x".repeat(1000)));
});

const DOC = { summary: "회의 음성을 받아써요.", screens: [{ name: "목록", where: "세션 옆", what: "회의" }], data: [], features: [], external: [{ what: "받아쓰기", how: "/_lively/ai/runs", data: "음성", code: "ui/index.html transcribe()" }], permissions: [], limits: [], changes: [] };

test("P1 앞뒤 말 + ```json 울타리를 견딘다", () => {
  const d = parseSpecOutput("여기 있어요\n```json\n" + JSON.stringify(DOC) + "\n```\n끝");
  assert.deepEqual(d, DOC);
  assert.deepEqual(parseSpecOutput("말 " + JSON.stringify(DOC) + " 말"), DOC);
});

test("P2 summary 가 없거나 JSON 이 아니면 null", () => {
  assert.equal(parseSpecOutput(JSON.stringify({ ...DOC, summary: "" })), null);
  assert.equal(parseSpecOutput("그냥 글"), null);
  assert.equal(parseSpecOutput("{ 깨진"), null);
  assert.equal(parseSpecOutput("[1,2]"), null);
});

test("P3 빠진 칸은 빈 목록 · 문자열 아닌 항목은 버림 · 긴 글은 자름", () => {
  const d = parseSpecOutput(JSON.stringify({ summary: "x".repeat(5000), limits: ["a", 3, null, { b: 1 }, ""], screens: [{ where: "이름 없음" }, "글"], features: [{ name: "f", steps: ["1", 2, null] }] }))!;
  assert.equal(d.summary.length, 800);
  assert.deepEqual(d.limits, ["a", "3"]);
  assert.deepEqual(d.screens, []);
  assert.deepEqual(d.features, [{ name: "f", steps: ["1", "2"], code: "" }]);
  assert.deepEqual([d.data, d.external, d.permissions, d.changes], [[], [], [], []]);
});

test("P4 직전 설명이 있으면 프롬프트에 싣고 달라진 점을 묻는다 · 없으면 싣지 않는다", () => {
  const base = { title: "회의록", appId: "app-x", versionNo: 3, facts: specFacts(MAN, []), input: specInput([f("lively-app.json", "{}")]) };
  const withPrev = specPrompt({ ...base, prev: { versionNo: 2, doc: DOC } });
  assert.ok(withPrev.includes("2버전 기준") && withPrev.includes(DOC.summary) && withPrev.includes("changes"));
  const none = specPrompt({ ...base, prev: null });
  assert.ok(!none.includes("직전 명세(") && !none.includes(DOC.summary));
});

test("K1 열쇠 — 지문이 있으면 지문, 없으면 판 번호", () => {
  assert.equal(specKeyOf("abc", 3), "abc");
  assert.equal(specKeyOf(null, 3), "v3");
  assert.equal(specKeyOf("  ", null), "v0");
});

const NOW = 10_000_000;
const row = (k: string, status: SpecRow["status"], o: Partial<SpecRow> = {}): SpecRow => ({ content_hash: k, version_no: 1, status, has_spec: status === "ok", error: null, started_at: NOW - 1000, made_at: status === "running" ? null : NOW - 500, model: null, ...o });
const ALL = new Set([1, 2, 3, 4, 5]);
const O = (o: Partial<{ available: boolean; visible: ReadonlySet<number>; budget: boolean }> = {}) => ({ now: NOW, available: true, visible: ALL, budget: true, ...o });

test("D1 보는 판 설명이 있으면 그것 · 새로 쓰지 않는다", () => {
  const d = decideSpec("h2", 2, [row("h2", "ok", { version_no: 2 }), row("h1", "ok")], O());
  assert.equal(d.show!.content_hash, "h2");
  assert.deepEqual([d.stale, d.kick, d.writing, d.failed, d.unavailable, d.limit], [false, false, false, null, false, false]);
});

test("D2 보는 판 설명이 없으면 가장 가까운 앞 판 설명(stale) + 새로 쓴다", () => {
  const d = decideSpec("h3", 3, [row("h1", "ok", { version_no: 1, made_at: NOW - 100 }), row("h2", "ok", { version_no: 2, made_at: NOW - 900 })], O());
  assert.equal(d.show!.content_hash, "h2");
  assert.deepEqual([d.stale, d.kick, d.writing], [true, true, true]);
});

test("D3 아무것도 없으면 보일 것 없음 + 새로 쓴다", () => {
  const d = decideSpec("h1", 1, [], O());
  assert.deepEqual([d.show, d.stale, d.kick, d.writing], [null, false, true, true]);
});

test("D4 쓰는 중(10분 안) 이면 다시 쓰지 않는다 · 10분 지나면 죽은 것으로 보고 다시", () => {
  const live = decideSpec("h1", 1, [row("h1", "running", { started_at: NOW - SPEC_RUNNING_STALE_MS + 1000 })], O());
  assert.deepEqual([live.kick, live.writing], [false, true]);
  const dead = decideSpec("h1", 1, [row("h1", "running", { started_at: NOW - SPEC_RUNNING_STALE_MS - 1 })], O());
  assert.deepEqual([dead.kick, dead.writing], [true, true]);
});

test("D5 실패는 저절로 다시 쓰지 않는다 · 앞 판 설명과 까닭을 보인다", () => {
  const d = decideSpec("h2", 2, [row("h2", "failed", { version_no: 2, error: "AI 답을 읽지 못했어요" }), row("h1", "ok")], O());
  assert.equal(d.kick, false);
  assert.equal(d.failed, "AI 답을 읽지 못했어요");
  assert.equal(d.show!.content_hash, "h1");
  assert.equal(d.writing, false);
});

test("D6 키가 없으면 쓰지 않는다 · 있는 앞 판 설명은 보인다", () => {
  const d = decideSpec("h2", 2, [row("h1", "ok")], O({ available: false }));
  assert.deepEqual([d.kick, d.unavailable, d.stale], [false, true, true]);
  assert.deepEqual(decideSpec("h1", 1, [], O({ available: false })).show, null);
});

test("D7 남의 공개 전 판(볼 수 없는 판)의 설명은 대신 보이지 않는다(격리 리뷰)", () => {
  //  공개 판 V3 · 그 뒤 다른 사람이 V4 · V5 를 저장(공개 전 · 이 사람에겐 안 보임) · 이 사람이 자기 초안 V6 을 본다 — 앞 판이어도 V4 · V5 설명은 안 된다
  const rows = [row("h5", "ok", { version_no: 5, made_at: NOW }), row("h4", "ok", { version_no: 4 }), row("h3", "ok", { version_no: 3, made_at: NOW - 900 })];
  const d = decideSpec("h6", 6, rows, O({ visible: new Set([1, 2, 3, 6]) }));
  assert.equal(d.show!.content_hash, "h3");
  //  볼 수 있는 앞 판 설명이 없으면 아무것도 대신 보이지 않는다
  assert.equal(decideSpec("h6", 6, [row("h5", "ok", { version_no: 5 })], O({ visible: new Set([6]) })).show, null);
});

test("D8 뒤 판(번호가 큰 판) 설명은 볼 수 있어도 대신 보이지 않는다 · 판 번호 없는 행도", () => {
  const d = decideSpec("h2", 2, [row("h5", "ok", { version_no: 5 }), row("hx", "ok", { version_no: null })], O());
  assert.equal(d.show, null);
});

test("D9 오늘 몫을 다 썼으면 새로 쓰지 않고 limit · 이미 있는 설명은 그대로", () => {
  const d = decideSpec("h2", 2, [row("h1", "ok")], O({ budget: false }));
  assert.deepEqual([d.kick, d.limit, d.writing, d.show && d.show.content_hash], [false, true, false, "h1"]);
  assert.equal(decideSpec("h2", 2, [row("h2", "ok", { version_no: 2 })], O({ budget: false })).limit, false);
  assert.equal(decideSpec("h2", 2, [row("h2", "running", { version_no: 2 })], O({ budget: false })).writing, true);
});

// ── 예약기 — 연달아 저장해도 한 번 ──
function fakeClock() {
  let t = 0; const q: Array<{ at: number; fn: () => void; id: number; dead?: boolean }> = []; let n = 0;
  return {
    setTimer: (fn: () => void, ms: number) => { const e = { at: t + ms, fn, id: ++n }; q.push(e); return e; },
    clearTimer: (e: unknown) => { (e as { dead?: boolean }).dead = true; },
    advance: async (ms: number) => { t += ms; for (const e of q.filter((x) => !x.dead && x.at <= t)) { e.dead = true; e.fn(); } await new Promise((r) => setImmediate(r)); },
  };
}

test("S1 같은 앱 세 번 연달아 저장 → 마지막 뒤 quiet 에 한 번 · 다른 앱은 따로", async () => {
  const c = fakeClock(); const ran: string[] = [];
  let tenant = "t1";
  const s = makeSpecScheduler({ quietMs: 30, run: async (a) => { ran.push(tenant + ":" + a); }, tenantKey: () => tenant, wrap: (fn) => { const t0 = tenant; return async () => { const keep = tenant; tenant = t0; try { await fn(); } finally { tenant = keep; } }; }, setTimer: c.setTimer, clearTimer: c.clearTimer });
  s.schedule("a"); await c.advance(10); s.schedule("a"); await c.advance(10); s.schedule("a"); s.schedule("b");
  await c.advance(29);
  assert.deepEqual(ran, []);
  await c.advance(1);
  assert.deepEqual(ran.sort(), ["t1:a", "t1:b"]);
  assert.equal(s.pending(), 0);
});

test("S2 워크스페이스가 다르면 같은 앱 id 도 따로 · 예약한 워크스페이스로 돈다", async () => {
  const c = fakeClock(); const ran: string[] = [];
  let tenant = "t1";
  const s = makeSpecScheduler({ quietMs: 30, run: async (a) => { ran.push(tenant + ":" + a); }, tenantKey: () => tenant, wrap: (fn) => { const t0 = tenant; return async () => { const keep = tenant; tenant = t0; try { await fn(); } finally { tenant = keep; } }; }, setTimer: c.setTimer, clearTimer: c.clearTimer });
  s.schedule("a"); tenant = "t2"; s.schedule("a"); tenant = "zz";
  await c.advance(30);
  assert.deepEqual(ran.sort(), ["t1:a", "t2:a"]);
});

test("S3 돌린 뒤 숫자를 돌려주면 그만큼 뒤 다시 돈다 · 그 사이 새 저장이 오면 그 예약으로 모인다", async () => {
  const c = fakeClock(); const ran: number[] = []; let n = 0;
  const s = makeSpecScheduler({ quietMs: 30, run: async () => { n++; ran.push(n); return n === 1 ? 100 : undefined; }, tenantKey: () => "", wrap: (fn) => fn, setTimer: c.setTimer, clearTimer: c.clearTimer });
  s.schedule("a");
  await c.advance(30);
  assert.deepEqual(ran, [1]);
  assert.equal(s.pending(), 1);
  await c.advance(99);
  assert.deepEqual(ran, [1]);
  await c.advance(1);
  assert.deepEqual(ran, [1, 2]);
  assert.equal(s.pending(), 0);
});
