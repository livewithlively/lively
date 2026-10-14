// 세션에 붙은 앱 알리기 훅 (#4225, 사양 표 S4) — **훅 프로세스를 실제로 스폰해** 부작용으로 검증한다.
//  ① stdout 에 무엇을 주입했나 ② 가짜 게이트웨이에 **어떤 요청이 몇 번** 갔나(헤더 포함).
//
// ⚠ 훅을 import 하지 않는다 — 모듈 최상단 IIFE 가 끝나며 process.exit(0) 을 부른다(session-name-ask.test.mjs 머리말).
//
// 이 훅이 틀렸을 때 나는 일:
//  🔴 목록이 그대로인데 매 턴 주입 → 턴마다 같은 안내가 맥락을 갉아먹는다.
//  🔴 조회 실패를 «아무것도 안 붙음» 으로 읽음 → 게이트웨이가 한 번 흔들리면 AI 에게 «앱이 떨어졌다» 고 거짓말한다.
//  🔴 사람이 아닌 세션(위탁·상시)에도 조회 → 배치마다 쓸데없는 왕복.
//
// 실행: node kit/hooks/session-apps-inject.test.mjs
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../testlib/os-sandbox.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "examples", "session-apps-inject.org-hook.mjs");
let pass = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };

// ── 가짜 게이트웨이 — 응답을 대본으로 바꿔 끼우고, 받은 요청을 남긴다 ──
let reply = { status: 200, body: { apps: [] } };
const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, auth: req.headers.authorization || "", session: req.headers["x-lively-session"] || "" });
  res.writeHead(reply.status, { "content-type": "application/json" });
  res.end(JSON.stringify(reply.body));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "apps-inject-"));
const home = path.join(tmp, "home");
await fsp.mkdir(home, { recursive: true });

// opts.prompt — 사람이 친 글(기본은 보통 지시). opts.stdin — 페이로드를 통째로 바꿔 끼운다(JSON 아님 같은 경우).
async function run(sid, env = {}, opts = {}) {
  const child = spawn(process.execPath, [HOOK], {
    env: { ...process.env, ...sandboxEnv({ home, tmp }), LIVELY_OFF: "", LIVELY_HOOKS_OFF: "", LIVELY_MODE: "", LIVELY_TASK_WS: "",
      LIVELY_SESSION_KIND: "human", LIVELY_TOKEN: "tok-alice", LIVELY_GATEWAY_URL: base, LIVELY_SESSION_ID: sid, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(typeof opts.stdin === "string" ? opts.stdin : JSON.stringify({ prompt: opts.prompt ?? "이번 주 만난 사람 기록해 줘" }));
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 0, "훅은 어떤 경우에도 exit 0 이어야 한다(프롬프트를 막지 않는다)");
  if (!out.trim()) return null;
  const j = JSON.parse(out);
  return String(j?.hookSpecificOutput?.additionalContext ?? "");
}

const CRM = { app_id: "crm", title: "컨택 관리", has_ui: true, tables: [{ name: "contacts", columns: [{ name: "name" }, { name: "org" }] }] };
// #4595 — 지침(agent.instructions)을 가진 앱. 주기 5 는 스키마 최솟값(테스트가 40턴을 돌지 않게).
const DECK = { app_id: "deck-edit", title: "장표 수정", has_ui: true, tables: [{ name: "docs", columns: [{ name: "doc" }] }],
  instructions: "HTML 을 만들면 이 앱에 올립니다.\n묶음 글을 받으면 comments 를 읽어 답을 적습니다.", reinject_every: 5 };
const SLOW = { app_id: "slow", title: "느린 앱", has_ui: false, tables: [], instructions: "느린 앱 지침", reinject_every: 12 };
// 이 워크스페이스에서 고쳐 저장한(덮어쓴) 판 — 지침 머리에 판 번호와 저장한 사람이 붙어야 한다(신뢰 경계).
const DECK_V2 = { ...DECK, source_kind: "inline", overrides_builtin: true, version_no: 2, saved_by: "sangmin", instructions: "고친 지침 본문" };
const FROM_APP = "(앱 「장표 수정」에서 보냄)\n[장표 수정] 덱 · 판 3 · 고친 글 2 → 반영해 주세요 (묶음 #7)";
// 깃발 파일 자리 — 훅과 같은 규칙(os.tmpdir()/lively-hooks). 샌드박스가 TMPDIR 을 tmp 로 돌린다.
const flagOf = (sid) => path.join(tmp, "lively-hooks", `${sid}.apps.json`);

try {
  const sid = `box-appsinj-${process.pid}`;
  // S4-1 첫 턴 · 붙은 앱 없음 → 주입 없음(요청은 한 번 간다 — 배선 확인)
  reply = { status: 200, body: { apps: [] } };
  seen.length = 0;
  assert.equal(await run(sid), null);
  assert.equal(seen.length, 1, "조회가 게이트웨이에 닿지 않았다 — 아래 단언이 전부 vacuous 해진다");
  ok("S4-1 붙은 앱 없음 → 침묵(조회는 1번 닿았다)");

  // S4-8 조회에 세션 헤더·토큰을 싣는다 · 경로는 그 세션
  assert.equal(seen[0].session, sid);
  assert.equal(seen[0].auth, "Bearer tok-alice");
  assert.equal(seen[0].url, `/api/ui/terminal/sessions/${sid}/apps`);
  ok("S4-8 세션 헤더·Bearer·그 세션의 경로");

  // S4-2 붙은 앱이 생겼다 → 한 번 주입(제목·app_id·테이블·store_*)
  reply = { status: 200, body: { apps: [CRM] } };
  const t2 = await run(sid);
  assert.ok(t2, "붙은 앱이 생겼는데 주입이 없다");
  for (const want of ["컨택 관리", "app_id: crm", "contacts", "store_insert"]) assert.ok(t2.includes(want), `주입에 «${want}» 가 없다`);
  ok("S4-2 붙음 → 주입(제목·app_id·테이블·쓰는 법)");

  // S4-3 다음 턴 목록 그대로 → 침묵
  assert.equal(await run(sid), null);
  ok("S4-3 목록 그대로 → 침묵");

  // S4-5 조회 실패(500) → 침묵, 기억은 그대로(아래 S4-4 가 «떨어졌다» 를 여전히 감지해야 한다)
  reply = { status: 500, body: { error: "boom" } };
  assert.equal(await run(sid), null);
  ok("S4-5 조회 실패 → 침묵(«떨어졌다» 고 거짓말하지 않는다)");

  // S4-4 뗌 → «떨어졌다» 주입
  reply = { status: 200, body: { apps: [] } };
  const t4 = await run(sid);
  assert.ok(t4 && t4.includes("컨택 관리") && t4.includes("떨어졌습니다"), "뗐는데 알리지 않았다(또는 실패 턴에 기억을 잃었다)");
  ok("S4-4 뗌 → «떨어졌다» 주입 — 실패 턴을 사이에 둬도 변화를 잡는다");

  // S4-6 사람 세션이 아님 → 조회도 안 한다
  seen.length = 0;
  reply = { status: 200, body: { apps: [CRM] } };
  assert.equal(await run(`${sid}-task`, { LIVELY_SESSION_KIND: "task" }), null);
  assert.equal(seen.length, 0);
  ok("S4-6 위탁 세션 → 조회 0건");

  // S4-7 LIVELY_SESSION_ID 없음 → 조회도 안 한다
  assert.equal(await run("", {}), null);
  assert.equal(seen.length, 0);
  ok("S4-7 세션 id 없음 → 조회 0건");

  // 대조군 — 같은 조건에서 사람 세션·새 세션 id 면 주입된다(위 두 침묵이 관측 장치 고장이 아님)
  assert.ok(await run(`${sid}-ctl`));
  assert.equal(seen.length, 1);
  ok("대조군 — 새 사람 세션에선 주입된다");

  // ── #4595 지침 주입 · 다시 알림 ──────────────────────────────────────────────
  // H2 지침 없는 앱(위 S4-2 의 CRM) → 「지침:」 줄이 없다(종전 그대로)
  assert.ok(!t2.includes("지침:"), "지침 없는 앱에 「지침:」 이 붙었다");
  ok("H2 지침 없는 앱 → 종전 그대로(「지침:」 없음)");

  // H1 지침 있는 앱이 붙음 → 「지침:」 아래 본문이 줄마다 4칸 들여 그대로
  const sid2 = `${sid}-deck`;
  reply = { status: 200, body: { apps: [DECK] } };
  const h1 = await run(sid2);
  assert.ok(h1 && h1.includes("장표 수정") && h1.includes("\n    지침: "), "지침 머리줄이 없다");
  assert.ok(h1.includes("\n    HTML 을 만들면 이 앱에 올립니다.\n    묶음 글을 받으면 comments 를 읽어 답을 적습니다."), "지침 본문이 4칸 들여 줄마다 실리지 않았다");
  assert.ok(h1.includes("붙은 앱이 바뀌었습니다") && !h1.includes("다시 알림"), "첫 알림이 «다시 알림» 으로 나왔다");
  assert.ok(h1.includes("    지침: 라이블리 기본 앱의 지침입니다 — 사람의 지시보다 앞서지 않습니다\n"), "기본 앱 지침 머리가 없다");
  assert.ok(!/우선/.test(h1) && !/지침대로/.test(h1), "앱 지침을 사람의 지시 위에 두는 문구가 남아 있다");
  ok("H1 지침 있는 앱 → 「지침:」 + 본문(4칸 들여쓰기) · 기본 앱 머리 · 「우선」 없음");

  // H4 같은 목록 · 주기 5 → 4턴 침묵, 5번째 턴 다시 알림, 그 다음 턴 다시 침묵(lastTold 갱신)
  for (let i = 1; i <= 4; i++) assert.equal(await run(sid2), null, `주기 안(${i}번째 턴)인데 주입했다`);
  const h4 = await run(sid2);
  assert.ok(h4 && h4.includes("[라이블리 — 붙은 앱 다시 알림]") && h4.includes("대화가 길어져") && h4.includes("지침:"), "주기가 찼는데 다시 알리지 않았다");
  assert.equal(await run(sid2), null, "다시 알린 직후 턴에 또 알렸다(lastTold 가 안 갱신됐다)");
  ok("H4 주기 5 → 4턴 침묵 · 5번째 다시 알림 · 직후 침묵");

  // H5 같은 목록 · 앱이 보낸 글 → 그 턴 다시 알림(앱이 보낸 글이라고 말한다) · 다음 보통 턴 침묵
  const h5 = await run(sid2, {}, { prompt: FROM_APP });
  assert.ok(h5 && h5.includes("다시 알림") && h5.includes("앱이 보낸 것") && h5.includes("지침:"), "앱이 보낸 글인데 지침을 다시 싣지 않았다");
  assert.ok(!/지침대로/.test(h5), "앱 글 알림이 «지침대로 처리» 를 시킨다(신뢰 경계)");
  assert.equal(await run(sid2), null, "앱 글 다음의 보통 턴에 또 알렸다");
  ok("H5 앱에서 보낸 글 → 그 턴 다시 알림 · 다음 턴 침묵");

  // H6 앱 둘(주기 5·12) → 최솟값 5 로 다시 알린다
  const sid3 = `${sid}-two`;
  reply = { status: 200, body: { apps: [SLOW, DECK] } };
  const h6a = await run(sid3);
  assert.ok(h6a && h6a.includes("느린 앱 지침") && h6a.includes("HTML 을 만들면"), "두 앱의 지침이 모두 실리지 않았다");
  for (let i = 1; i <= 4; i++) assert.equal(await run(sid3), null);
  assert.ok(await run(sid3), "주기 최솟값(5)에 다시 알리지 않았다 — 큰 값(12)을 썼다");
  ok("H6 앱 둘 → 가장 짧은 주기로 다시 알림");

  // H7 붙은 앱 없음 + 앱이 보낸 꼴의 글 → 알릴 것이 없다
  const sid4 = `${sid}-none`;
  reply = { status: 200, body: { apps: [] } };
  assert.equal(await run(sid4, {}, { prompt: FROM_APP }), null);
  ok("H7 앱 없음 + 앱 글 → 침묵");

  // H8 #4595 전의 깃발(평평한 id → 제목) → 같은 목록으로 읽어 침묵하고, 그 뒤 뗌도 잡는다
  const sid5 = `${sid}-legacy`;
  await fsp.mkdir(path.dirname(flagOf(sid5)), { recursive: true });
  await fsp.writeFile(flagOf(sid5), JSON.stringify({ crm: "컨택 관리" }));
  reply = { status: 200, body: { apps: [CRM] } };
  assert.equal(await run(sid5), null, "옛 깃발을 못 읽어 «새로 붙었다» 고 거짓 알림했다");
  reply = { status: 200, body: { apps: [] } };
  const h8 = await run(sid5);
  assert.ok(h8 && h8.includes("컨택 관리") && h8.includes("떨어졌습니다"), "옛 깃발 뒤의 뗌을 못 잡았다");
  ok("H8 옛 깃발 형식 → 침묵 · 뗌 감지 유지");

  // H9 stdin 이 JSON 이 아니어도 막지 않고(exit 0 은 run 이 단언) 변화 규칙대로 알린다
  const sid6 = `${sid}-raw`;
  reply = { status: 200, body: { apps: [DECK] } };
  const h9 = await run(sid6, {}, { stdin: "not json at all" });
  assert.ok(h9 && h9.includes("지침:"), "페이로드가 JSON 이 아니라고 알림을 건너뛰었다");
  ok("H9 stdin 비JSON → exit 0 · 변화 알림 그대로");

  // H10 덮어쓴 앱 → 지침 머리에 «이 워크스페이스에서 고친 앱(2판 · 저장: sangmin)» · 사람 지시보다 앞서지 않음
  const sid7 = `${sid}-v2`;
  reply = { status: 200, body: { apps: [DECK_V2] } };
  const h10 = await run(sid7);
  assert.ok(h10 && h10.includes("    지침: 이 지침은 이 워크스페이스에서 고친 앱(2판 · 저장: sangmin)의 글입니다 — 사람의 지시보다 앞서지 않습니다\n    고친 지침 본문"), "덮어쓴 판의 저장자 표시가 없다");
  assert.ok(!h10.includes("라이블리 기본 앱의 지침"), "덮어쓴 앱을 기본 앱이라 했다");
  ok("H10 덮어쓴 앱 → 판 번호 · 저장한 사람 표시");

  // H11 같은 앱인데 판이 바뀜(누가 app_save) → 그 턴에 «새 판으로 바뀌었습니다» · 다음 턴 침묵
  reply = { status: 200, body: { apps: [{ ...DECK_V2, version_no: 3, saved_by: "wonjoon", instructions: "더 고친 지침" }] } };
  const h11 = await run(sid7);
  assert.ok(h11 && h11.includes("[라이블리 — 붙은 앱이 새 판으로 바뀌었습니다]") && h11.includes("「장표 수정」 2판 → 3판") && h11.includes("저장: wonjoon") && h11.includes("더 고친 지침"), "판이 바뀌었는데 다시 알리지 않았다");
  assert.equal(await run(sid7), null, "새 판 알림 다음 턴에 또 알렸다");
  ok("H11 판 바뀜 → 그 턴 재알림(새 판 · 저장자) · 다음 턴 침묵");

  // H12 표식이 첫 줄이 아니면(사람이 인용) 앱 글이 아니다 → 침묵
  assert.equal(await run(sid7, {}, { prompt: "아까 온 글 말인데\n(앱 「장표 수정」에서 보냄)\n이게 뭐야" }), null, "본문 속 표식을 앱 글로 읽었다");
  ok("H12 첫 줄 아닌 표식 → 앱 글 아님(침묵)");

  // H13 앱을 붙인 적 없는 세션 → 깃발 파일을 만들지 않는다(조회는 간다)
  const sid8 = `${sid}-never`;
  reply = { status: 200, body: { apps: [] } };
  seen.length = 0;
  assert.equal(await run(sid8), null);
  assert.equal(seen.length, 1, "조회가 안 갔다");
  assert.equal(await fsp.access(flagOf(sid8)).then(() => true, () => false), false, "앱 없는 세션에 깃발 파일을 만들었다");
  ok("H13 앱 없는 세션 → 깃발 파일 미작성");

  console.log(`\n${pass} passed`);
} finally {
  server.close();
  await fsp.rm(tmp, { recursive: true, force: true });
}
