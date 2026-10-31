// 자동 소환 훅 잡음 제거 (#5197, 사양 표) — **훅 프로세스를 실제로 스폰해** 부작용으로 검증한다.
//  ① 가짜 게이트웨이에 소환 요청이 몇 번 갔나 ② stdout 에 어떤 지식이 들어갔나 ③ 기록 폴더에 무엇이 남았나.
//
// ⚠ 훅을 import 하지 않는다 — 모듈 최상단 IIFE 가 끝나며 process.exit(0) 을 부른다(session-name-ask.test.mjs 머리말).
//
// 이 훅이 틀렸을 때 나는 일:
//  🔴 알림·메시지에도 소환 → 주입 턴의 86%가 아무도 안 읽는 블록이 되고, 프롬프트마다 임베딩 서버를 탄다.
//  🔴 재주입 → 세션 하나에 같은 블록이 수십 번 쌓인다.
//  🔴 기록을 안 비움 → 압축으로 사라진 지식이 그 대화에 다시는 안 온다(조용히 소환이 줄어든다).
//  🔴 기록 실패가 소환을 막음 → tmp 하나 못 쓰는 기계에서 소환 전체가 죽는다.
//
// 실행: node kit/hooks/knowledge-recall.test.mjs [훅 파일]   (훅 파일을 주면 그 판으로 돈다 — 변경 전 판으로 빨간불을 먼저 볼 때)
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../testlib/os-sandbox.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(process.argv[2] || path.join(here, "examples", "knowledge-recall.org-hook.mjs"));
const RUNNER = path.join(here, "run-custom.mjs");

let pass = 0, fail = 0;
const check = async (name, optsOrFn, maybeFn) => {
  const fn = maybeFn ?? optsOrFn;
  if (maybeFn && optsOrFn.skip) { console.log(`skip ${name}`); return; }
  try { await fn(); pass++; console.log(`ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL ${name} — ${String(e?.message || e).split("\n")[0]}`); }
};

// ── 가짜 게이트웨이 — 소환 응답을 대본으로 바꿔 끼우고, 받은 요청을 남긴다 ──
const K = (name) => ({ name, title: `제목 ${name}`, similarity: 0.7, snippet: `요약 ${name}` });
const FOUR = ["a", "b", "c", "d"];
let reply = { status: 200, names: FOUR };
let hooksFor = () => [];
let runtime = null;
const hits = [];
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || "/", "http://test");
  const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (u.pathname === "/api/ui/org/runner/hooks") {
    json(200, { hooks: hooksFor(u.searchParams.get("event")), relay_decisions: ["deny", "ask", "defer"], concurrent: false, runtime });
    return;
  }
  if (u.pathname !== "/api/ui/knowledge/recall" || req.method !== "POST") { json(404, {}); return; }
  let raw = "";
  for await (const c of req) raw += c;
  hits.push({ ...JSON.parse(raw || "{}"), auth: req.headers.authorization || "" });
  if (reply.status !== 200) { json(reply.status, {}); return; }
  json(200, { entries: reply.names.map(reply.at ?? K) });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "knowledge-recall-"));
const home = path.join(root, "home");
await fsp.mkdir(home, { recursive: true });
const tmp = path.join(root, "tmp");
await fsp.mkdir(tmp, { recursive: true });
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map(String).sort() : []);

function spawnNode(args, payload, env) {
  const child = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(payload === undefined ? "" : JSON.stringify(payload));
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => { out += c; });
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, out })));
}

// 훅 한 번 — 사람 프롬프트 기본. 훅은 어떤 경우에도 exit 0 이어야 한다(프롬프트를 막지 않는다).
async function hook(payload, { tmpDir = tmp, env = {} } = {}) {
  const r = await spawnNode([HOOK], payload, {
    ...process.env, ...sandboxEnv({ home, tmp: tmpDir }), LIVELY_OFF: "", LIVELY_HOOKS_OFF: "",
    LIVELY_TOKEN: "tok-a", LIVELY_GATEWAY_URL: base, ...env,
  });
  assert.equal(r.code, 0, "훅은 항상 exit 0");
  return r.out;
}
const ask = (sid, prompt = "이번 주 배포 절차를 정리해 줘", opts) =>
  hook({ ...(sid === undefined ? {} : { session_id: sid }), hook_event_name: "UserPromptSubmit", prompt }, opts);
const compact = (sid, opts) => hook({ session_id: sid, hook_event_name: "PreCompact", trigger: "auto" }, opts);
const injected = (out, names = FOUR) => names.filter((n) => out.includes(`(${n})`));

// 각 시험은 깨끗한 대본에서 시작하고, 그 시험이 일으킨 소환 호출 수만 본다.
const scene = () => { reply = { status: 200, names: FOUR }; hits.length = 0; };
let sidNo = 0;
const newSid = () => `sess-${++sidNo}`;

// ── 사람 프롬프트 ─────────────────────────────────────────────────────────────
await check("#1 사람 프롬프트 → 소환 1회 · 상위 4건 주입 · 기록이 남는다", async () => {
  scene();
  const before = walk(tmp).length;
  const out = await ask(newSid());
  assert.deepEqual(injected(out), FOUR);
  assert.equal(hits.length, 1);
  // 배선 — 게이트웨이가 정말 그 프롬프트로 불렸나.
  assert.equal(hits[0].text, "이번 주 배포 절차를 정리해 줘");
  assert.equal(hits[0].auth, "Bearer tok-a");
  assert.ok(walk(tmp).length > before, "기록 폴더에 아무것도 안 남았다");
});

// ── 사람이 쓰지 않은 입력 ──────────────────────────────────────────────────────
const NOT_HUMAN = [
  ["#2 작업 완료 알림", "<task-notification>\n<task-id>b3yf</task-id>\n<status>completed</status>\n<summary>배포 스크립트 실행 완료</summary>\n</task-notification>"],
  ["#3 서브에이전트 보고", '<agent-message from="af0e2b9c">\n[Subagent hand-back] The text below is the final report of a subagent\n</agent-message>'],
  ["#4 세션 간 메시지", '<cross-session-message from="uds:/tmp/cc-socks/95679.sock" from-name="probe-b" from-mode="prompting">\n배포 절차를 정리했습니다\n</cross-session-message>'],
  ["#5 기록에 저장되는 머리말 꼴", 'Another Claude session sent a message:\n<agent-message from="a122">\n[Subagent hand-back] 보고\n</agent-message>'],
  ["#6 앞에 공백·개행이 붙은 알림", "\n   <task-notification>\n<task-id>x</task-id>\n</task-notification>"],
];
for (const [name, prompt] of NOT_HUMAN) {
  await check(`${name} → 소환 0회 · 주입 없음`, async () => {
    scene();
    const out = await ask(newSid(), prompt);
    assert.equal(hits.length, 0, "게이트웨이에 물었다");
    assert.equal(out, "");
  });
}

await check("#7 사람이 문장 중간에 알림 태그를 인용 → 사람 글이다", async () => {
  scene();
  const out = await ask(newSid(), "훅이 <task-notification> 글머리를 왜 거르는지 설명해 줘");
  assert.equal(hits.length, 1);
  assert.deepEqual(injected(out), FOUR);
});

await check("#8 글머리와 닮은 말로 시작 → 사람 글이다", async () => {
  scene();
  const a = await ask(newSid(), "<agent-messages 라는 태그를 새로 만들까 고민 중입니다");
  const b = await ask(newSid(), "<task-notifications> 묶음 형식을 설계해 줘");
  assert.equal(hits.length, 2);
  assert.deepEqual([injected(a), injected(b)], [FOUR, FOUR]);
});

// ── 세션 내 중복 제거 ──────────────────────────────────────────────────────────
await check("#9 같은 세션 · 같은 결과 두 번째 → 소환은 하되 주입 없음", async () => {
  scene();
  const sid = newSid();
  await ask(sid);
  const out = await ask(sid);
  assert.equal(hits.length, 2);
  assert.equal(out, "");
});

await check("#10 일부만 새 지식 → 새 지식만, 순위 순서대로", async () => {
  scene();
  const sid = newSid();
  await ask(sid);
  reply = { status: 200, names: ["a", "x", "b", "y"] };
  const out = await ask(sid);
  assert.deepEqual(injected(out, ["a", "b", "x", "y"]), ["x", "y"]);
  assert.ok(out.indexOf("(x)") < out.indexOf("(y)"), "순위 순서가 바뀌었다");
  assert.equal(out.split("[관련 팀 지식").length, 2, "머리글은 한 번");
  // 기록은 쌓인다 — 마지막 주입분만 기억하면 a·b 가 다시 들어온다.
  reply = { status: 200, names: ["a", "b", "x", "y"] };
  assert.equal(await ask(sid), "");
});

await check("#11 이미 넣은 지식이 있어도 요청은 그대로다(빈자리를 안 채운다 · 기준선과 건수는 서버가 정한다)", async () => {
  scene();
  const sid = newSid();
  await ask(sid);
  await ask(sid);
  assert.equal(hits.length, 2);
  assert.ok(hits.every((h) => h.limit === undefined && h.min_score === undefined && h.exclude === undefined), JSON.stringify(hits));
});

await check("#12 다른 session_id → 다시 주입", async () => {
  scene();
  await ask(newSid());
  assert.deepEqual(injected(await ask(newSid())), FOUR);
});

// ── 압축 · /clear ──────────────────────────────────────────────────────────────
await check("#13 넣은 뒤 PreCompact → 같은 세션에 다시 주입", async () => {
  scene();
  const sid = newSid();
  await ask(sid);
  assert.equal(await ask(sid), "", "전제: 압축 전에는 재주입이 없다");
  await compact(sid);
  assert.deepEqual(injected(await ask(sid)), FOUR);
});

await check("#14 세션 A 의 압축은 세션 B 의 기록을 안 지운다", async () => {
  scene();
  const a = newSid(), b = newSid();
  await ask(a); await ask(b);
  await compact(a);
  assert.equal(await ask(b), "");
});

await check("#15 기록 없는 세션의 PreCompact → 소환 0회 · 출력 없음 · exit 0", async () => {
  scene();
  // prompt 칸이 있어도 압축 판은 소환하지 않는다.
  assert.equal(await hook({ session_id: newSid(), hook_event_name: "PreCompact", prompt: "이번 주 배포 절차를 정리해 줘" }), "");
  assert.equal(hits.length, 0);
});

await check("#16 /clear — session_id 만 바뀌고 pane id 는 같음 → 다시 주입", async () => {
  scene();
  const env = { LIVELY_SESSION_ID: "box-pane-1" };
  await ask(newSid(), undefined, { env });
  assert.deepEqual(injected(await ask(newSid(), undefined, { env })), FOUR);
});

// ── 새로 도입한 기록의 부재·경계 ────────────────────────────────────────────────
await check("#17 session_id 없음 → 매번 주입 · 기록 파일 없음", async () => {
  scene();
  const before = walk(tmp);
  assert.deepEqual(injected(await ask(undefined)), FOUR);
  assert.deepEqual(injected(await ask(undefined)), FOUR);
  assert.deepEqual(walk(tmp), before);
});

await check("#18 session_id 에 경로 문자 → 주입은 되고 어디에도 파일이 안 생긴다", async () => {
  scene();
  const before = walk(root);
  assert.deepEqual(injected(await ask("../escape")), FOUR);
  assert.deepEqual(walk(root), before);
});

await check("#19 session_id 경계 — 64자는 기록되고 65자는 기록되지 않는다", async () => {
  scene();
  const s64 = "a".repeat(64), s65 = "b".repeat(65);
  await ask(s64);
  assert.equal(await ask(s64), "", "64자가 기록되지 않았다");
  await ask(s65);
  assert.deepEqual(injected(await ask(s65)), FOUR, "65자가 기록됐다");
});

await check("#20 기록 자리를 못 씀(폴더 자리에 파일) → 소환은 그대로 · exit 0", async () => {
  scene();
  const blocked = path.join(root, "tmp-blocked");
  await fsp.mkdir(blocked);
  await fsp.writeFile(path.join(blocked, "lively-hooks"), "not a dir");
  const sid = newSid();
  assert.deepEqual(injected(await ask(sid, undefined, { tmpDir: blocked })), FOUR);
  assert.deepEqual(injected(await ask(sid, undefined, { tmpDir: blocked })), FOUR);
  await compact(sid, { tmpDir: blocked });
});

await check("#21 기록 파일이 빈 파일 → 주입", async () => {
  scene();
  const own = path.join(root, "tmp-empty");
  await fsp.mkdir(own);
  const sid = newSid();
  await ask(sid, undefined, { tmpDir: own });
  const dir = path.join(own, "lively-hooks");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".recall-seen"));
  assert.equal(files.length, 1, "전제: 기록 파일 하나");
  await fsp.writeFile(path.join(dir, files[0]), "");
  assert.deepEqual(injected(await ask(sid, undefined, { tmpDir: own })), FOUR);
});

await check("#22 게이트웨이 500 → 주입 없고 기록도 안 남아 복구 뒤 주입된다", async () => {
  scene();
  const sid = newSid();
  reply = { status: 500 };
  assert.equal(await ask(sid), "");
  reply = { status: 200, names: FOUR };
  assert.deepEqual(injected(await ask(sid)), FOUR);
  assert.equal(hits.length, 2);
});

await check("#23 게이트웨이 빈 결과 → 주입 없음", async () => {
  scene();
  reply = { status: 200, names: [] };
  assert.equal(await ask(newSid()), "");
  assert.equal(hits.length, 1);
});

// ── 종전 거름 무회귀 ───────────────────────────────────────────────────────────
await check("#24 경계 — 사람 글 11자는 건너뛰고 12자는 소환한다", async () => {
  scene();
  assert.equal(await ask(newSid(), "가".repeat(11)), "");
  assert.equal(hits.length, 0);
  assert.deepEqual(injected(await ask(newSid(), "가".repeat(12))), FOUR);
  assert.equal(hits.length, 1);
});

await check("#25 슬래시·뱅 명령 → 소환 0회", async () => {
  scene();
  assert.equal(await ask(newSid(), "/review 이 변경을 살펴봐 주세요"), "");
  assert.equal(await ask(newSid(), "!ls -la 프로젝트 폴더를 보여 줘"), "");
  assert.equal(hits.length, 0);
});

await check("#28 stdout 이 닫혀 있음 → exit 0 · 못 나간 지식은 기록되지 않는다", async () => {
  scene();
  const sid = newSid();
  const child = spawn(process.execPath, [HOOK], {
    env: { ...process.env, ...sandboxEnv({ home, tmp }), LIVELY_OFF: "", LIVELY_HOOKS_OFF: "", LIVELY_TOKEN: "tok-a", LIVELY_GATEWAY_URL: base },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.destroy();
  child.stdin.end(JSON.stringify({ session_id: sid, hook_event_name: "UserPromptSubmit", prompt: "이번 주 배포 절차를 정리해 줘" }));
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, "훅은 항상 exit 0");
  assert.equal(hits.length, 1, "전제: 소환까지는 갔다");
  assert.deepEqual(injected(await ask(sid)), FOUR);
});

// ── 서브에이전트 — 부모 session_id 에 agent_id 가 붙어 온다 ─────────────────────────
await check("#29 서브에이전트 호출은 부모 기록을 읽지도 쓰지도 않는다", async () => {
  scene();
  const sid = newSid();
  const child = (extra) => hook({ session_id: sid, agent_id: "c1", hook_event_name: "UserPromptSubmit", prompt: "이번 주 배포 절차를 정리해 줘", ...extra });
  // 자식이 먼저 받아도 부모의 첫 주입은 그대로다.
  assert.deepEqual(injected(await child()), FOUR);
  assert.deepEqual(injected(await ask(sid)), FOUR, "자식 호출이 부모 기록에 남았다");
  // 부모가 받은 뒤에도 새 컨텍스트로 시작하는 자식은 받는다.
  assert.deepEqual(injected(await child({ agent_id: "c2" })), FOUR, "자식이 부모 기록에 막혔다");
  // 자식의 압축은 부모 기록을 지우지 않는다.
  await hook({ session_id: sid, agent_id: "c1", hook_event_name: "PreCompact", trigger: "auto" });
  assert.equal(await ask(sid), "", "자식의 압축이 부모 기록을 지웠다");
});

// ── 맞은 절의 자리(#5204) ──────────────────────────────────────────────────────────
await check("#31 조각으로 찾으면 줄 · 절 경로가 실리고 유사도는 안 실린다", async () => {
  scene();
  reply = { status: 200, names: ["a"], at: (n) => ({ ...K(n), line: 12, section: "배포 › 순서", snippet: "맞은 절의 글" }) };
  const out = await ask(newSid());
  assert.ok(out.includes("- 제목 a (a) · L12 «배포 › 순서»\n  맞은 절의 글"), out);
  assert.ok(!out.includes("유사도"), out);
});

await check("#32 경로가 없는 절은 줄만 싣는다", async () => {
  scene();
  reply = { status: 200, names: ["a"], at: (n) => ({ ...K(n), line: 1, section: "" }) };
  assert.ok((await ask(newSid())).includes("(a) · L1\n"));
});

await check("#33 문서 벡터로 찾으면(줄이 없으면) 유사도를 싣는다", async () => {
  scene();
  reply = { status: 200, names: ["a"] };
  assert.ok((await ask(newSid())).includes("(a) · 유사도 70%"));
});

// ── 앞 턴 사람 말(#5204) ───────────────────────────────────────────────────────────
await check("#34 둘째 턴에 앞 턴 사람 말을 실어 보낸다 · 첫 턴은 없다", async () => {
  scene();
  const sid = newSid();
  await ask(sid, "첫째 턴의 사람 말입니다");
  await ask(sid, "둘째 턴의 사람 말입니다");
  assert.deepEqual(hits.map((h) => [h.text, h.prev]), [["첫째 턴의 사람 말입니다", undefined], ["둘째 턴의 사람 말입니다", "첫째 턴의 사람 말입니다"]]);
});

await check("#35 짧아서 건너뛴 턴도 다음 턴에는 앞 턴이다", async () => {
  scene();
  const sid = newSid();
  await ask(sid, "응 해줘");
  await ask(sid, "그럼 다음 단계로 가자");
  assert.deepEqual(hits.map((h) => h.prev), ["응 해줘"]);
});

await check("#36 알림 · 슬래시 명령은 앞 턴을 바꾸지 않는다", async () => {
  scene();
  const sid = newSid();
  await ask(sid, "사람이 친 앞 턴의 말입니다");
  await ask(sid, "<task-notification>\n<status>completed</status>\n</task-notification>");
  await ask(sid, "/review 이 변경을 살펴봐 주세요");
  await ask(sid, "이제 다음 프롬프트입니다");
  assert.deepEqual(hits.map((h) => h.prev), [undefined, "사람이 친 앞 턴의 말입니다"]);
});

await check("#37 앞 턴은 300자만 · 세션마다 따로 · 서브에이전트는 읽지도 쓰지도 않는다", async () => {
  scene();
  const a = newSid(), b = newSid();
  await ask(a, "가".repeat(500));
  await ask(b, "다른 세션의 첫 턴입니다");
  await hook({ session_id: a, agent_id: "c1", hook_event_name: "UserPromptSubmit", prompt: "서브에이전트의 프롬프트입니다" });
  await ask(a, "같은 세션의 둘째 턴입니다");
  assert.deepEqual(hits.map((h) => h.prev), [undefined, undefined, undefined, "가".repeat(300)]);
});

await check("#38 앞 턴 기록을 못 씀 · 깨진 기록 → 소환은 그대로 · exit 0", async () => {
  scene();
  const blocked = path.join(root, "tmp-blocked-prev");
  await fsp.mkdir(blocked);
  await fsp.writeFile(path.join(blocked, "lively-hooks"), "not a dir");
  const sid = newSid();
  await ask(sid, undefined, { tmpDir: blocked });
  assert.deepEqual(injected(await ask(sid, undefined, { tmpDir: blocked })), FOUR);
  assert.ok(hits.every((h) => h.prev === undefined));
});

await check("#40 남도 쓸 수 있는 폴더면 앞 턴을 읽지도 쓰지도 않는다 · 소환은 그대로", { skip: process.platform === "win32" }, async () => {
  scene();
  const own = path.join(root, "tmp-open");
  const dir = path.join(own, "lively-hooks");
  await fsp.mkdir(dir, { recursive: true });
  await fsp.chmod(dir, 0o777);
  const sid = newSid();
  await fsp.writeFile(path.join(dir, `${sid}.recall-prev`), "남이 심어 둔 글");
  assert.deepEqual(injected(await ask(sid, undefined, { tmpDir: own })), FOUR);
  assert.equal(hits[0].prev, undefined, "심어 둔 글을 게이트웨이로 보냈다");
  assert.equal(fs.readFileSync(path.join(dir, `${sid}.recall-prev`), "utf8"), "남이 심어 둔 글", "남의 폴더에 프롬프트를 적었다");
});

await check("#41 새 세션의 첫 프롬프트가 하루 지난 앞 턴 기록을 지운다 · 최근 것은 둔다", { skip: process.platform === "win32" }, async () => {
  scene();
  const own = path.join(root, "tmp-stale");
  const dir = path.join(own, "lively-hooks");
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const oldF = path.join(dir, "old.recall-prev"), newF = path.join(dir, "recent.recall-prev"), seenF = path.join(dir, "old.recall-seen");
  for (const f of [oldF, newF, seenF]) await fsp.writeFile(f, "x");
  const past = new Date(Date.now() - 25 * 60 * 60_000);
  await fsp.utimes(oldF, past, past);
  await fsp.utimes(seenF, past, past);
  await ask(newSid(), undefined, { tmpDir: own });
  assert.deepEqual([fs.existsSync(oldF), fs.existsSync(newF), fs.existsSync(seenF)], [false, true, true]);
});

await check("#42 프롬프트 · 앞 턴을 자를 때 서로게이트 쌍을 가르지 않는다", async () => {
  scene();
  const sid = newSid();
  await ask(sid, `${"가".repeat(299)}😀 뒤`);
  await ask(sid, `${"가".repeat(1999)}😀 뒤`);
  const isWell = (s) => !/[\ud800-\udbff](?![\udc00-\udfff])/.test(s);
  assert.equal(hits[1].prev, "가".repeat(299));
  assert.equal(hits[1].text, "가".repeat(1999));
  assert.ok(isWell(hits[0].text) && isWell(hits[1].text));
});

await check("#39 기록 파일은 나만 읽는다", { skip: process.platform === "win32" }, async () => {
  scene();
  const own = path.join(root, "tmp-mode");
  await fsp.mkdir(own);
  await ask(newSid(), undefined, { tmpDir: own });
  const dir = path.join(own, "lively-hooks");
  const f = fs.readdirSync(dir).find((x) => x.endsWith(".recall-prev"));
  assert.ok(f, "앞 턴 기록이 없다");
  assert.equal(fs.statSync(path.join(dir, f)).mode & 0o077, 0);
});

// ── 실제 러너 경유 — 게이트웨이가 내려 준 훅을 러너가 돌리는 그 길 ─────────────────
//  프로세스 시작에 실행 방식을 표식 파일에 남기는 한 줄을 얹는다 — 얹어도 같은 정적 판정(runtimeOf)을 탄다.
const MARK = path.join(root, "runtime-mark");
const source = `const __wt = await import("node:worker_threads"); (await import("node:fs")).appendFileSync(process.env.RECALL_TEST_MARK, (__wt.isMainThread ? "process" : "worker") + "\\n");\n`
  + fs.readFileSync(HOOK, "utf8");
const seedRow = (id, event, src = source) => ({ id, event, matcher: null, source_code: src, content_hash: crypto.createHash("sha256").update(src).digest("hex"), timeout_sec: 5, sort: 10, seed: true });
hooksFor = (event) => (event === "UserPromptSubmit" ? [seedRow("knowledge-recall", event)] : event === "PreCompact" ? [seedRow("knowledge-recall-compact", event)] : []);

async function runner(event, payload, harnessArgs = []) {
  const r = await spawnNode([RUNNER, event, ...harnessArgs], payload, {
    ...process.env, ...sandboxEnv({ home, tmp }), LIVELY_OFF: "", LIVELY_HOOKS_OFF: "", LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox",
    LIVELY_TOKEN: "tok-a", LIVELY_GATEWAY_URL: base, LIVELY_HARNESS: "", LIVELY_HOOK_LIST_TTL_MS: "0", LIVELY_HOOK_EVENT_BUDGET_MS: "", LIVELY_HOOK_RUNTIME: "",
    RECALL_TEST_MARK: MARK,
  });
  assert.equal(r.code, 0, "러너는 항상 exit 0");
  return r.out;
}
const turn = (sid, args) => runner("UserPromptSubmit", { session_id: sid, hook_event_name: "UserPromptSubmit", prompt: "이번 주 배포 절차를 정리해 줘" }, args);
const preCompact = (sid, args) => runner("PreCompact", { session_id: sid, hook_event_name: "PreCompact", trigger: "manual" }, args);

for (const mode of ["worker", "process"]) {
  await check(`#26 러너(${mode}) — 주입 → 재주입 없음 → 압축 → 다시 주입`, async () => {
    scene();
    runtime = mode;
    await fsp.rm(MARK, { force: true });
    const sid = newSid();
    const first = await turn(sid);
    const again = await turn(sid);
    await preCompact(sid);
    const after = await turn(sid);
    assert.deepEqual([injected(first), injected(again), injected(after)], [FOUR, [], FOUR]);
    assert.equal(hits.length, 3);
    // 배선 — 네 번 모두 그 방식으로 돌았나(압축 판 포함). 다른 길로 샜으면 이 시험은 아무것도 안 본 것이다.
    assert.deepEqual(fs.readFileSync(MARK, "utf8").trim().split("\n"), Array(4).fill(mode));
  });
}

await check("#27 러너 코덱스 봉투 — 첫 턴만 JSON 봉투로 주입", async () => {
  scene();
  runtime = "worker";
  const sid = newSid();
  const first = await turn(sid, ["--harness", "codex"]);
  const again = await turn(sid, ["--harness", "codex"]);
  assert.deepEqual(injected(JSON.parse(first).hookSpecificOutput.additionalContext), FOUR);
  assert.equal(again, "");
});

await check("#30 러너 — 같은 묶음의 긴 프로젝트 규칙보다 소환 블록이 앞에 나온다", async () => {
  scene();
  runtime = "worker";
  const LONG = "rule-".repeat(4800);   // project-agents-inject 가 자르는 상한과 같은 24KB — 하네스가 앞부분만 보여 주는 크기다
  const agents = seedRow("project-agents-inject", "UserPromptSubmit", `process.stdout.write(${JSON.stringify(LONG)});\n`);
  // 서버와 같은 순서(sort, id)로 내려 준다 — 하네스는 합친 출력의 앞부분만 보여 준다.
  hooksFor = (event) => (event === "UserPromptSubmit" ? [seedRow("knowledge-recall", event), agents] : []);
  const out = await turn(newSid());
  assert.deepEqual(injected(out), FOUR);
  assert.ok(out.includes(LONG), "전제: 프로젝트 규칙도 나왔다");
  assert.ok(out.indexOf("(d)") < out.indexOf(LONG), "소환 블록이 프로젝트 규칙 뒤에 묻혔다");
});

server.close();
await fsp.rm(root, { recursive: true, force: true });
console.log(`knowledge-recall tests: ${pass} passed${fail ? `, ${fail} failed` : ""}`);
process.exit(fail ? 1 : 0);
