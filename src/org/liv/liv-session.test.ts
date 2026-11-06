// #4032 — 리브 탭은 **진짜 세션**이다(상민님 결정 2026-09-16).
//
//  계기: 매니지드에서 리브 탭 [보내기](POST /api/ui/me/liv/turn)가 전부 500 이었다. 헤드리스 턴(spawnTaskSession)이 게이트웨이가 도는
//  기계의 tmux 를 직접 불러, 판이 sudo 에서 즉사하고 다음 `tmux set-option` 이 «no server running» 으로 던졌다(게이트웨이 로그 6건).
//  이제 리브는 그 사람의 리브 세션 하나다. (#4970 «리브 = 세션 하나») 레일 [리브] · [연결할게요] · [연결 도와줘]가 같은 세션으로 가고
//   그 세션은 보통 세션 화면(일반 세션 보기 · 물음 자리 · 곁칸 «리브»)에서 산다 — 리브 탭의 대화 칸(liv-chat.ts)은 걷었다.
//   (#4940) 보기는 대화 고정이 아니라 일반 세션이다 — 하네스가 뜨면 터미널로 넘어간다(상민님 2026-10-23).
//
//  사양·엣지 표: 표 A(지금의 리브 세션) · 표 B(좌표 읽기) · 표 C(첫 말 경계) · 표 D(한 줄로 선 확보) — 행마다 한 단언.
//   표 E(리브 폴더의 신뢰 대화상자)는 판정 행 E1~E9 가 terminal/session-create-guards.test 에, 배선 E10 이 여기 있다.
//  ① 순수 판정은 값으로 · ② 프로필 층은 순수 함수로 · ③ DB·tmux·DOM 에 걸린 배선은 소스 구조로 못박는다(레포 선례).
//  ⚠ 리브 세션을 실제로 여는 경로(ensureLivSession)는 여기서 부르지 않는다 — DB 가 없으면 곧장 세션 생성으로 흘러
//   이 기계에 폴더·tmux 를 만든다.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { LIV_PROMPT_MAX, LIV_SUBPATH, pickLivSession, pickLivSessionHarness, serialByKey, storedLivSession, type LivSessionFacts } from "./session.js";
import { BY_WORKSPACE, WORKSPACE_SCOPED_KEYS, mergeForWorkspace, viewForWorkspace } from "../store/members.js";
import { livChatCapabilities, livFirstWords } from "../../capabilities/delivery/liv-chat.js";
import { HttpError } from "../../http-error.js";
import { autoTrustWorkspace } from "../../terminal/session-create-guards.js";

const code = (s: string): string => s.replace(/^[ \t]*\/\/.*$/gm, "");
const ME = "me";
const facts = (f: Partial<LivSessionFacts>): LivSessionFacts =>
  ({ stored: "A", state: { owner: ME, superseded_by: null }, successor: null, trashed: false, me: ME, ...f });

// ── 표 A — 지금의 리브 세션 ─────────────────────────────────────────────────────────
test("★★ 표 A — 지금의 리브 세션(좌표·휴지통·소유자·이정표·사슬 끝)", () => {
  const rows: Array<[string, Partial<LivSessionFacts>, string | null]> = [
    ["A1 좌표 없음 → 없다(첫 말이 연다)", { stored: null }, null],
    ["A2 휴지통에 든 세션 → 없다(버린 세션에 붙이면 입력도 못 하는 기록에 갇힌다)", { trashed: true }, null],
    ["A3 남의 행 → 없다", { state: { owner: "other", superseded_by: null } }, null],
    ["A4 살아 있는 내 행 → 그 id(이어진 곳을 묻지 않는다)", { successor: "X" }, "A"],
    ["A5 소유자 모름(빈 값)인 살아 있는 행 → 그 id", { state: { owner: null, superseded_by: null } }, "A"],
    ["A6 이어진 행 + 사슬 끝 → 사슬 끝", { state: { owner: ME, superseded_by: "B" }, successor: "C" }, "C"],
    ["A7 이어진 행 + 사슬 끝 못 찾음 → 이정표", { state: { owner: ME, superseded_by: "B" }, successor: null }, "B"],
    ["A8 행 없음 + 대화로 찾은 세션 → 그 세션", { state: null, successor: "D" }, "D"],
    ["A9 행 없음 + 못 찾음 → 없다", { state: null, successor: null }, null],
  ];
  for (const [why, f, want] of rows) assert.equal(pickLivSession(facts(f)), want, why);
});

// ── 표 B — 좌표 읽기 ────────────────────────────────────────────────────────────────
test("★★ 표 B — 리브 탭 좌표가 먼저, 없거나 빈칸이면 킥오프 세션", () => {
  assert.equal(storedLivSession({ liv_session: { id: "L" }, welcome: { session_id: "K" } }), "L", "B1");
  assert.equal(storedLivSession({ liv_session: null, welcome: { session_id: "K" } }), "K", "B2 칸 없음");
  assert.equal(storedLivSession({ welcome: { session_id: "K" } }), "K", "B2 칸 자체가 없는 옛 프로필");
  assert.equal(storedLivSession({ liv_session: { id: "   " }, welcome: { session_id: "K" } }), "K", "B3 빈칸 좌표가 폴백을 가렸다");
  assert.equal(storedLivSession({ liv_session: { id: " L " } }), "L", "B4 다듬기");
  assert.equal(storedLivSession({ welcome: { session_id: null } }), null, "B5");
  assert.equal(storedLivSession(null), null, "B6");
  assert.equal(storedLivSession(undefined), null, "B6");
});

// ── 표 C — 첫 말 경계 ───────────────────────────────────────────────────────────────
test("★★ 표 C — 첫 말은 비면 400, 8000자까지 허용, 8001자부터 몇 자인지 말하는 400", () => {
  const status = (raw: unknown): number | "ok" => {
    try { livFirstWords(raw); return "ok"; } catch (e) { return e instanceof HttpError ? e.status : -1; }
  };
  for (const blank of ["", "   \n\t", undefined, null]) assert.equal(status(blank), 400, `C1 ${JSON.stringify(blank)}`);
  assert.equal(LIV_PROMPT_MAX, 8000);
  const at = "가".repeat(LIV_PROMPT_MAX);
  assert.equal(livFirstWords(at), at, "C2 정확히 상한은 통과해야 한다");
  assert.throws(() => livFirstWords(at + "나"), (e: unknown) => e instanceof HttpError && e.status === 400 && /8001 > 8000/.test(e.message), "C3");
  assert.equal(livFirstWords(`  ${at}  `), at, "C4 앞뒤 공백은 세지 않는다");
});

// ── 표 D — 리브 세션 확보를 한 줄로(두 탭에서 동시에 첫 말 → 세션 하나) ─────────────────────
test("★★ 표 D — 같은 열쇠는 한 줄로, 다른 열쇠는 따로, 앞이 실패해도 뒤는 돌고, 끝나면 열쇠가 남지 않는다", async () => {
  const q = serialByKey();
  const log: string[] = [];
  const gate = (): { p: Promise<void>; open: () => void } => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
  // D1 같은 열쇠 — 앞 일이 끝나기 전에 뒤 일이 시작하면 «세션이 없다» 를 둘 다 보고 둘 다 연다.
  const g1 = gate();
  const a = q.run("ws|me", async () => { log.push("a+"); await g1.p; log.push("a-"); return "A"; });
  const b = q.run("ws|me", async () => { log.push("b+"); return "B"; });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(log, ["a+"], "D1 ★ 앞 일이 도는 중에 뒤 일이 시작했다(세션이 둘 선다)");
  g1.open();
  assert.deepEqual(await Promise.all([a, b]), ["A", "B"]);
  assert.deepEqual(log, ["a+", "a-", "b+"], "D1 순서");
  // D2 다른 열쇠 — 다른 사람·다른 워크스페이스는 서로 기다리지 않는다.
  const g2 = gate();
  const seen: string[] = [];
  const c = q.run("ws|u1", async () => { seen.push("c+"); await g2.p; return "C"; });
  const d = q.run("ws|u2", async () => { seen.push("d+"); return "D"; });
  //  기다리면 영영 안 끝난다(앞 일은 아래에서야 풀린다) — 멈추지 않고 곧바로 빨간불이 되게 시한을 건다.
  const within = await Promise.race([d, new Promise((r) => setTimeout(() => r("기다렸다"), 200))]);
  assert.equal(within, "D", "D2 ★ 다른 열쇠가 앞 일을 기다렸다(한 사람이 여는 동안 모두가 멈춘다)");
  assert.deepEqual(seen, ["c+", "d+"]);
  g2.open();
  assert.equal(await c, "C");
  // D3 앞 일이 실패 — 그 실패는 그 호출자에게만 가고, 뒤 일은 돈다.
  const e = q.run("ws|me", async () => { throw new Error("세션을 못 열었다"); });
  const f = q.run("ws|me", async () => "F");
  await assert.rejects(e, /세션을 못 열었다/, "D3 앞 실패가 삼켜졌다");
  assert.equal(await f, "F", "D3 ★ 앞 실패가 뒤 일을 막았다(그 사람은 다시는 리브를 못 연다)");
  // D4 끝나면 열쇠가 남지 않는다.
  assert.equal(q.size(), 0, "D4 끝난 열쇠가 남았다(사람 수만큼 쌓인다)");
});

// ── 프로필 층 — 리브 세션은 워크스페이스마다 따로 ──────────────────────────────────────
test("★★ 리브 좌표는 워크스페이스 층이다 — 다른 워크스페이스로 새지 않고, 덮지 않고, 계정 층에 안 남는다", () => {
  assert.ok((WORKSPACE_SCOPED_KEYS as readonly string[]).includes("liv_session"), "★ liv_session 이 워크스페이스 층 키가 아니다");
  const a = mergeForWorkspace({}, { liv_session: { id: "box-a", at: "t" } }, "ws-A");
  assert.equal((a as Record<string, unknown>).liv_session, undefined, "최상위(계정 층)에 새어 나갔다");
  assert.deepEqual(viewForWorkspace(a, "ws-A").liv_session, { id: "box-a", at: "t" });
  assert.equal(viewForWorkspace(a, "ws-B").liv_session, undefined, "★ 다른 워크스페이스가 이 리브 세션을 본다");
  const b = mergeForWorkspace(a, { liv_session: { id: "box-b", at: "t2" } }, "ws-B");
  assert.deepEqual(viewForWorkspace(b, "ws-A").liv_session, { id: "box-a", at: "t" }, "뒤 워크스페이스가 앞 것을 덮었다");
  assert.deepEqual(viewForWorkspace(b, "ws-B").liv_session, { id: "box-b", at: "t2" });
  assert.ok((b as Record<string, Record<string, unknown>>)[BY_WORKSPACE]["ws-A"], "워크스페이스 칸이 없다");
});

// ── 창구 — 찾기·맡기기 두 문과 물음 접기, 전부 화면 전용 ─────────────────────────────────────
//  (#4970 «리브 = 세션 하나») 리브 탭의 «첫 말» 문(me_liv_session_open)은 «리브에게 일 맡기기»(me_liv_open) 하나로 합쳤다 —
//   레일 [리브] · [연결할게요] · [연결 도와줘] · 리브 칸이 같은 문을 탄다(행위 시험은 capabilities/delivery/liv-open.test).
test("★★ 창구 — 리브 세션 찾기(GET)·리브에게 일 맡기기(POST) 두 문과 물음 접기뿐, 전부 화면 전용(mcp:false)", () => {
  const byName = new Map(livChatCapabilities.map((c) => [c.name, c]));
  assert.deepEqual([...byName.keys()].sort(), ["me_liv_ask_dismiss", "me_liv_open", "me_liv_session"],
    "★ 헤드리스 턴 문(me_liv_turn·log·stop·chat·chat-reset)·옛 첫 말 문(me_liv_session_open)이 남아 있거나 문이 빠졌다");
  const rest = (n: string): string[] => (byName.get(n)?.expose.rest || []).flatMap((r) => r.paths.map((p) => `${r.method} ${p}`));
  assert.deepEqual(rest("me_liv_session"), ["GET /api/ui/me/liv/session"]);
  assert.deepEqual(rest("me_liv_open"), ["POST /api/ui/me/liv/open"]);
  for (const c of livChatCapabilities) assert.equal(c.expose.mcp, false, `${c.name} 이 MCP 로 열렸다(리브가 자기를 다시 부르면 세션이 겹친다)`);
});

test("★★ 창구 — 인증 없는 호출은 401, 빈 말·모르는 일은 세션을 열기 전에 400", async () => {
  const open = livChatCapabilities.find((c) => c.name === "me_liv_open")!;
  const find = livChatCapabilities.find((c) => c.name === "me_liv_session")!;
  const statusOf = async (p: Promise<unknown>): Promise<number | "ok"> => {
    try { await p; return "ok"; } catch (e) { return e instanceof HttpError ? e.status : -1; }
  };
  assert.equal(await statusOf(Promise.resolve().then(() => find.handler({}, {} as never))), 401);
  assert.equal(await statusOf(Promise.resolve().then(() => open.handler({ text: "안녕" }, {} as never))), 401);
  assert.equal(await statusOf(Promise.resolve().then(() => open.handler({ text: "  " }, { userId: ME } as never))), 400);
  assert.equal(await statusOf(Promise.resolve().then(() => open.handler({ job: "nope" }, { userId: ME } as never))), 400);
});

// ── 배선 — 헤드리스 리브 턴이 사라지고, 리브 탭이 세션 대화창을 붙인다 ────────────────────
const CAP = code(readFileSync("src/capabilities/delivery/liv-chat.ts", "utf8"));
const SESSION = code(readFileSync("src/org/liv/session.ts", "utf8"));
const MEMBERS = code(readFileSync("src/org/store/members.ts", "utf8"));
const WEB_LIV_PAGE = code(readFileSync("web/liv.ts", "utf8"));
const WEB_MAIN = code(readFileSync("web/v2/main.ts", "utf8"));
const WEB_CLASSIC = code(readFileSync("web/main.ts", "utf8"));
const WEB_CHAT = readFileSync("web/session-chat.ts", "utf8");   // 레이블 상수는 주석까지 본다
const BOOT_HOOK = readFileSync("kit/hooks/examples/liv-session-boot.org-hook.mjs", "utf8");
const SESSIONS_TS = code(readFileSync("src/terminal/sessions.ts", "utf8"));
const LAUNCH_TS = code(readFileSync("src/terminal/session-launch.ts", "utf8"));

test("★★ 헤드리스 리브 턴이 없다 — 모듈·프로필 필드·화면 배선 전부", () => {
  assert.equal(existsSync("src/org/liv/chat-turn.ts"), false, "★ 헤드리스 리브 턴 모듈(chat-turn.ts)이 남아 있다");
  assert.doesNotMatch(CAP, /spawnTaskSession|\/api\/ui\/me\/liv\/turn/, "★ 창구에 헤드리스 리브 턴이 남아 있다(매니지드 500)");
  assert.doesNotMatch(MEMBERS, /LivChat\b|LivTurnRef|appendLivTurn|setLivChat/, "프로필에 헤드리스 대화 기록 필드가 남아 있다");
  //  (#4970) 리브 탭의 대화 칸(web/liv-chat.ts)도 없다 — 대화는 리브 세션 화면(보통 세션 화면)이 한다.
  assert.equal(existsSync("web/liv-chat.ts"), false, "★ 리브 탭 대화 칸(liv-chat.ts)이 남아 있다 — 대화는 리브 세션 화면이 한다(#4970)");
  assert.doesNotMatch(WEB_LIV_PAGE, /\/api\/ui\/me\/liv\/turn|\/api\/ui\/me\/liv\/chat\b/, "★ 화면이 아직 헤드리스 턴을 부른다");
  assert.doesNotMatch(WEB_LIV_PAGE, /liv:auto|livAuto|AutoKind|mountLivChat|renderSession\(/, "리브 화면에 대화 칸·숨김 턴 배선이 남아 있다");
});

test("★★ 세션을 못 열면 원인을 말하는 503 — 500 «internal_error» 로 뭉개지지 않는다(#4032 의 본체)", () => {
  //  행위(일반 Error → 503 · HttpError 는 그대로)는 liv-open.test E14·E15 가 잰다. 여기는 실제 문이 그 판정을 탄다는 배선만.
  assert.match(CAP, /async \(input: Record<string, unknown>, user: LivelyUser\) => \{\s*const r = await openLiv\(user, input, realDeps\);/, "★ 맡기기 문이 판정(openLiv)을 안 탄다");
  assert.match(CAP, /ensure: \(user, text, harness\) => ensureLivSession\(user, text, \{ harness \}\),/, "맡기기 문이 리브 세션 확보(한 줄로 선)를 안 탄다");
  assert.match(CAP, /return \{ session_id: await currentLivSessionId\(userId, \{ heal: false \}\) \};/, "찾기가 복원 이정표를 따라간 id 를 안 준다");
});

test("★★ 리브 세션 = 보통 세션 — 생성 관문(launchSession) · task 종류 · liv 폴더 · 도구 제한 없음 · 좌표 기록 · 한 줄로 선 확보", () => {
  assert.match(SESSION, /const session = await launchSession\(user, \{\s*kind: "task",\s*label: o\.label,\s*rootKey: "personal", subpath: LIV_SUBPATH,\s*harness, flags: \{ \.\.\.sessionFlagDefaults\(harness\), \[AUTO_MODE_FLAG\]: "1" \}, autoApprove: false,\s*initialPrompt: prompt,\s*\}, \{ nodeId: "", invites: \[\] \}\);/,
    "★ 리브 세션이 생성 관문(launchSession)을 안 탄다");
  assert.doesNotMatch(SESSION, /disallowedTools|livTurnArgs|spawnTaskSession|bypassPermissions/, "리브 세션에 헤드리스 도구 제한이 남아 있다(결정: 두지 않는다)");
  assert.match(SESSION, /await setLivSession\(userId, \{ id: session\.id, at: new Date\(\)\.toISOString\(\) \}\)/, "연 세션을 리브 좌표로 안 적는다");
  assert.match(SESSION, /return await opening\.run\(`\$\{currentTenant\(\)\?\.id \?\? ""\}\|\$\{userId\}`, async \(\) => \{\s*const cur = await currentLivSessionId\(userId\);\s*if \(cur\) return \{ session_id: cur, created: false \};/,
    "★ 리브 세션 확보가 한 줄로 서지 않거나, 있는 세션을 두고 또 연다");
  //  복원 사슬은 행이 **살아 있지 않을 때만** 묻는다(표 A4 의 배선 쪽).
  assert.match(SESSION, /const alive = !!state && !state\.superseded_by;\s*const successor = alive \? null : await resolveSessionSuccessor\(stored\)/, "살아 있는 행에도 이어진 곳을 묻는다");
  //  리브 부팅 훅의 게이트가 이 폴더 이름을 본다 — 갈리면 리브 세션이 정체성·현황을 못 받는다.
  assert.equal(LIV_SUBPATH, "liv");
  assert.match(BOOT_HOOK, /if \(path\.basename\(cwd\) !== "liv"\) process\.exit\(0\);/, "리브 부팅 훅 게이트가 liv 폴더가 아니다");
  assert.doesNotMatch(BOOT_HOOK, /셸은 없다|Bash·파일 도구가 아예 없다/, "★ 리브 부팅 훅이 없는 제한(셸 없음)을 말한다");
});

//  표 E10 — 끝단 검증에서 잡혔다(2026-09-16 매니지드): 리브 세션이 신뢰 대화상자 앞에서 멈춰 첫 말이 영영 안 들어갔다.
test("★★ 표 E10 — 서버가 연 리브 세션은 신뢰 대화상자를 대신 수락한다(로컬·노드 두 호출부 모두)", () => {
  //  리브 세션 모듈이 여는 바로 그 좌표·종류(task · personal · LIV_SUBPATH)로 판정을 묻는다 — 폴더 이름이 갈리면 여기서 빨개진다.
  assert.equal(autoTrustWorkspace({ kind: "task", rootKey: "personal", subpath: LIV_SUBPATH }), true,
    "★ 리브 세션의 첫 말이 신뢰 대화상자 앞에서 멈춘다");
  assert.match(SESSION, /kind: "task",\s*label: o\.label,\s*rootKey: "personal", subpath: LIV_SUBPATH,/, "리브 세션이 task 종류로 개인 루트의 리브 폴더에서 안 열린다");
  //  판정은 루트 키와 종류를 받아야 한다 — 공유 루트의 liv, 사람이 고른 liv 와 가른다. 세션 생성의 두 호출부가 모두 넘겨야 한다.
  assert.match(SESSIONS_TS, /autoTrustWorkspace\(\{ projectId: input\.projectId, subpath: subpathUsed, rootKey: rootKeyUsed, kind: input\.kind \}\)/,
    "★ 로컬·매니지드 세션 생성이 신뢰 판정에 루트 키·종류를 안 넘긴다");
  assert.match(LAUNCH_TS, /firstPromptTrustOk: autoTrustWorkspace\(\{ projectId: input\.projectId, subpath: input\.subpath, rootKey: input\.rootKey, kind: input\.kind \}\)/,
    "노드 세션 생성이 신뢰 판정에 루트 키·종류를 안 넘긴다");
});

test("★★ 화면 — #/liv 는 리브 세션이 있으면 그 세션 화면으로 · 리브 세션은 이름이 아니라 좌표로 알아본다(#4970)", () => {
  //  레일 [리브] · 리브 알림이 #/liv 로 온다. 리브 세션이 있으면 보통 세션 화면(일반 세션 보기 · 물음 자리 · 곁칸 «리브»)으로 간다.
  assert.match(WEB_MAIN, /const livId = await livSessionId\(\{ fresh: true \}\);/, "리브 라우트가 지금의 리브 세션을 안 묻는다(기억한 값으로 옛 세션에 간다)");
  assert.match(WEB_MAIN, /if \(livRoute\(\{ board, sessionId: livId \}\) === 'session' && livId\) \{/, "★ 리브 세션이 있는데 그 세션 화면으로 안 간다");
  assert.match(WEB_MAIN, /const board = params\.get\('board'\) === '1';/, "로컬 AI 링크(?board=1)가 세션으로 넘겨진다");
  //  세션 화면 — 리브 세션은 물음 자리 · 곁칸 맨 앞 «리브». 보기는 일반 세션(#4940 상민님 2026-10-23 «그냥 터미널로 열면 되잖아»
  //   — 종전 «대화 보기가 본자리»(원준 2026-09-14)를 걷었다. 대화 고정이면 하네스가 첫 실행 화면에서 기다릴 때 «전달하는 중…» 에 갇힌다).
  assert.match(WEB_MAIN, /\.\.\.\(isLiv\(sid\) \? \{ livAsks: true \} : \{\}\),/, "★ 리브 세션이 물음 자리로 안 열린다");
  assert.doesNotMatch(WEB_MAIN, /chatHome: true/, "★ 셸이 리브 세션(또는 다른 세션)을 대화 고정으로 연다 — 하네스가 떠도 터미널로 안 넘어간다");
  assert.match(WEB_MAIN, /livSession: projectId === 0 && isLiv\(sessionId\),/, "곁칸 «리브» 칸이 리브 세션에 안 선다");
  assert.match(WEB_MAIN, /return isLivSessionId\(\[sid, s\?\.id, s\?\.logId, s\?\.raw\?\.claudeSessionId\], knownLivSessionId\(\) \|\| livId\);/, "리브 세션을 좌표로 안 알아본다");
  assert.match(WEB_CHAT, /chatHome\?: boolean;/, "세션 대화창에 대화 보기 본자리 옵션이 없다");
  assert.match(WEB_CHAT, /livAsks\?: boolean;/, "세션 대화창에 리브 물음 자리 옵션이 없다");
  assert.match(WEB_CHAT, /const chatHome = \(\): boolean => livKickoff\(\) \|\| !!opts\.chatHome/, "★ 옵션이 보기 판정에 안 들어간다(리브 세션에 터미널이 뜬다)");
  assert.doesNotMatch(WEB_CHAT, /LIV_CHAT_LABEL|livChat\(\)/, "★ 세션 화면이 아직 이름 글자로 리브 세션을 가른다 — 이름을 바꾸면 리브 세션이 터미널로 열린다");
  assert.match(WEB_CHAT, /const livDock = opts\.livAsks \? mountLivAskDock\(liveDock, \{/, "★ 리브 물음이 입력칸 바로 위(liveDock)에 안 뜬다");
  //  #4940 — 터미널을 볼 때도 물음이 보인다: 보기가 바뀔 때마다 자리를 옮긴다(대화 = 입력칸 위 · 터미널 = 머리줄 아래). 런타임은 term-warm-runtime W33.
  assert.match(WEB_CHAT, /livAskEl = livDock \? livDock\.el : null;/, "★ 리브 물음 자리를 보기에 맞춰 옮길 손잡이가 없다");
  assert.match(WEB_CHAT, /function setMode\(m: 'term' \| 'chat'\): void \{[\s\S]{0,2400}?\n    placeLivAsk\(\);\n/, "★ 보기가 바뀌어도 리브 물음 자리를 안 옮긴다");
  //  카드에 치는 중(비밀 값)이면 터미널로 넘겨도 초점을 빼앗지 않는다 — 넘기면 이어 치는 값이 하네스 입력칸으로 간다(격리 리뷰 실측). 런타임은 W34.
  assert.match(WEB_CHAT, /if \(a && livAskEl\?\.contains\(a\)\) return;\n    if \(!a \|\| a === document\.body \|\| wrap\.contains\(a\)\) termSend\('focus'\);/, "★ 리브 물음 카드에 치는 중인데 터미널로 초점을 옮긴다");
  assert.match(WEB_CHAT, /if \(mode === 'term'\) \{ if \(a\.parentElement !== wrap\) wrap\.insertBefore\(a, chatHost\); \}/, "★ 터미널을 볼 때 물음이 숨은 대화창 안에 남는다");
  assert.match(WEB_CHAT, /livDock\?\.destroy\(\);/, "세션 화면을 걷을 때 물음 자리를 안 걷는다(되묻기가 남는다)");
});

test("★★ 리브 화면(단독)엔 대화 칸이 없고, 떠나면 되묻기가 멈춘다 · 조회는 읽기만 한다", () => {
  assert.doesNotMatch(WEB_MAIN + WEB_CLASSIC, /liv-chat\.js|livChatCleanup/, "★ 셸이 아직 리브 탭 대화 칸을 부른다");
  //  되묻기는 보이는 동안만 · 화면에서 떨어지면 스스로 끊는다(라우터가 화면을 통째로 갈아 끼워 끊을 손잡이가 없다).
  assert.match(WEB_LIV_PAGE, /\}, \(\) => wrapEl\.isConnected && document\.body\.dataset\.route === 'liv', \(\) => wrapEl\.isConnected\);/, "★ 리브 화면을 떠나도 되묻기가 남는다");
  //  조회(GET)는 읽기만 — 읽기전용 판정은 메서드로 가르므로 GET 이 쓰면 그 판정을 몰래 넘는다.
  assert.match(CAP, /return \{ session_id: await currentLivSessionId\(userId, \{ heal: false \}\) \};/, "★ 조회 창구가 좌표를 고쳐 쓴다(GET 에 쓰기)");
  assert.match(SESSION, /if \(o\.heal !== false && id && id !== prof\?\.liv_session\?\.id\) \{/, "heal:false 가 쓰기를 막지 않는다");
});

test("★★ 옛 킥오프 첫 지시 숨김은 리브 2턴이 남아 있는 동안 그대로 — 리브 세션의 첫 말은 사람에게 보인다", () => {
  assert.match(WEB_CHAT, /if \(livKickoff\(\) && !kickoffOpened\) \{/, "킥오프 첫 지시 숨김이 사라졌다(진행 중인 2턴 재개 세션에 서버 지시문이 말풍선으로 뜬다)");
  assert.doesNotMatch(WEB_CHAT, /&& !kickoffOpened[^\n]*livChat|livChat\(\)[^\n]*&& !kickoffOpened/, "사람이 쓴 첫 말까지 숨긴다");
});

// ── 표 F — 리브 세션 하네스(원준님 2026-10-30 «코덱스만 연결했는데 첫 AI 세션이 클로드로 됨») ─────────────────────
//  2턴 스윕이 리브 세션을 새로 열 때 로그인을 못 재면 headless-harness 의 «모르면 claude» 로 접혔다 — 로그인 안 한 claude 는
//   로그인 화면에 멈춰 첫 지시가 안 들어간다. 이제 기억해 둔 AI(처음 설정 때 로그인돼 있던 것)로 열고, 그것도 없으면 열지 않는다.
test("★★ 표 F — 리브 세션 하네스: 지금 로그인한 것 > 기억해 둔 것, 모르면 claude 로 접지 않는다", () => {
  const L = ["claude", "codex", "antigravity", "grok", "shell"];
  const rows: Array<[string, { usable: string[]; remembered?: string[] | null }, string | null]> = [
    ["F1 코덱스만 로그인", { usable: ["codex"] }, "codex"],
    ["F2 ★로그인 못 잼 + 처음 설정 때 코덱스 → 코덱스(claude 아님)", { usable: [], remembered: ["codex"] }, "codex"],
    ["F3 ★로그인 못 잼 + 기억 없음 → 열지 않음(claude 아님)", { usable: [], remembered: null }, null],
    ["F4 둘 다 로그인 + 기억은 코덱스 → 코덱스", { usable: ["claude", "codex"], remembered: ["codex"] }, "codex"],
    ["F5 둘 다 로그인 + 기억 없음 → 로그인 순 첫째", { usable: ["claude", "codex"] }, "claude"],
    ["F6 기억한 것이 지금은 로그아웃 → 지금 로그인한 것", { usable: ["claude"], remembered: ["codex"] }, "claude"],
    ["F7 띄울 수 없는 하네스(셸·모르는 것)는 고르지 않는다", { usable: ["shell", "nope"], remembered: ["nope"] }, null],
  ];
  for (const [name, i, want] of rows) assert.equal(pickLivSessionHarness({ ...i, launchable: L }), want, name);
});

test("★★ 리브 세션 하네스 배선 — openLivSession 이 claude 기본(resolveHeadlessHarness)을 안 쓰고, 2턴 스윕이 기억해 둔 AI 를 넘기고, 처음 설정이 그것을 적는다", () => {
  const sess = code(readFileSync("src/org/liv/session.ts", "utf8"));
  assert.doesNotMatch(sess, /resolveHeadlessHarness/, "★ 리브 세션이 «모르면 claude» 로 접힌다");
  assert.match(sess, /await resolveLivHarness\(userId, o\.remembered\)/);
  const sweep = code(readFileSync("src/org/liv/second-turn-sweep.ts", "utf8"));
  assert.match(sweep, /remembered: c\.welcome\.harnesses \?\? null/, "★ 2턴 스윕이 기억해 둔 AI 를 안 넘긴다");
  const welcome = code(readFileSync("src/capabilities/delivery/welcome.ts", "utf8"));
  assert.match(welcome, /harnesses: loggedAi\.length \? loggedAi : \(priorWelcome\?\.harnesses \?\? null\)/, "처음 설정이 로그인한 AI 를 안 적는다");
});
