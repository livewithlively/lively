// #4032 — 리브 탭은 **진짜 세션**이다(상민님 결정 2026-09-16).
//
//  계기: 매니지드에서 리브 탭 [보내기](POST /api/ui/me/liv/turn)가 전부 500 이었다. 헤드리스 턴(spawnTaskSession)이 게이트웨이가 도는
//  기계의 tmux 를 직접 불러, 판이 sudo 에서 즉사하고 다음 `tmux set-option` 이 «no server running» 으로 던졌다(게이트웨이 로그 6건).
//  이제 리브 탭은 그 사람의 리브 세션 하나를 찾아(없으면 첫 말로 연다) 세션 대화창을 붙인다.
//
//  사양·엣지 표: 표 A(지금의 리브 세션) · 표 B(좌표 읽기) · 표 C(첫 말 경계) — 행마다 한 단언.
//  ① 순수 판정은 값으로 · ② 프로필 층은 순수 함수로 · ③ DB·tmux·DOM 에 걸린 배선은 소스 구조로 못박는다(레포 선례).
//  ⚠ 리브 세션을 실제로 여는 경로(ensureLivSession)는 여기서 부르지 않는다 — DB 가 없으면 곧장 세션 생성으로 흘러
//   이 기계에 폴더·tmux 를 만든다.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { LIV_CHAT_LABEL, LIV_PROMPT_MAX, LIV_SUBPATH, pickLivSession, serialByKey, storedLivSession, type LivSessionFacts } from "./session.js";
import { BY_WORKSPACE, WORKSPACE_SCOPED_KEYS, mergeForWorkspace, viewForWorkspace } from "../store/members.js";
import { livChatCapabilities, livFirstWords } from "../../capabilities/delivery/liv-chat.js";
import { HttpError } from "../../http-error.js";

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

// ── 창구 — 두 문만, 둘 다 화면 전용 ─────────────────────────────────────────────────────
test("★★ 창구 — 리브 세션 찾기(GET)·첫 말(POST) 두 문과 물음 접기뿐, 전부 화면 전용(mcp:false)", () => {
  const byName = new Map(livChatCapabilities.map((c) => [c.name, c]));
  assert.deepEqual([...byName.keys()].sort(), ["me_liv_ask_dismiss", "me_liv_session", "me_liv_session_open"],
    "★ 헤드리스 턴 문(me_liv_turn·log·stop·chat·chat-reset)이 남아 있거나 문이 빠졌다");
  const rest = (n: string): string[] => (byName.get(n)?.expose.rest || []).flatMap((r) => r.paths.map((p) => `${r.method} ${p}`));
  assert.deepEqual(rest("me_liv_session"), ["GET /api/ui/me/liv/session"]);
  assert.deepEqual(rest("me_liv_session_open"), ["POST /api/ui/me/liv/session"]);
  for (const c of livChatCapabilities) assert.equal(c.expose.mcp, false, `${c.name} 이 MCP 로 열렸다(리브가 자기를 다시 부르면 세션이 겹친다)`);
});

test("★★ 창구 — 인증 없는 호출은 401, 빈 첫 말은 세션을 열기 전에 400", async () => {
  const open = livChatCapabilities.find((c) => c.name === "me_liv_session_open")!;
  const find = livChatCapabilities.find((c) => c.name === "me_liv_session")!;
  const statusOf = async (p: Promise<unknown>): Promise<number | "ok"> => {
    try { await p; return "ok"; } catch (e) { return e instanceof HttpError ? e.status : -1; }
  };
  assert.equal(await statusOf(Promise.resolve().then(() => find.handler({}, {} as never))), 401);
  assert.equal(await statusOf(Promise.resolve().then(() => open.handler({ text: "안녕" }, {} as never))), 401);
  assert.equal(await statusOf(Promise.resolve().then(() => open.handler({ text: "  " }, { userId: ME } as never))), 400);
});

// ── 배선 — 헤드리스 리브 턴이 사라지고, 리브 탭이 세션 대화창을 붙인다 ────────────────────
const CAP = code(readFileSync("src/capabilities/delivery/liv-chat.ts", "utf8"));
const SESSION = code(readFileSync("src/org/liv/session.ts", "utf8"));
const MEMBERS = code(readFileSync("src/org/store/members.ts", "utf8"));
const WEB_LIV = code(readFileSync("web/liv-chat.ts", "utf8"));
const WEB_LIV_PAGE = code(readFileSync("web/liv.ts", "utf8"));
const WEB_MAIN = code(readFileSync("web/v2/main.ts", "utf8"));
const WEB_CLASSIC = code(readFileSync("web/main.ts", "utf8"));
const WEB_CHAT = readFileSync("web/session-chat.ts", "utf8");   // 레이블 상수는 주석까지 본다
const BOOT_HOOK = readFileSync("kit/hooks/examples/liv-session-boot.org-hook.mjs", "utf8");

test("★★ 헤드리스 리브 턴이 없다 — 모듈·프로필 필드·화면 배선 전부", () => {
  assert.equal(existsSync("src/org/liv/chat-turn.ts"), false, "★ 헤드리스 리브 턴 모듈(chat-turn.ts)이 남아 있다");
  assert.doesNotMatch(CAP, /spawnTaskSession|\/api\/ui\/me\/liv\/turn/, "★ 창구에 헤드리스 리브 턴이 남아 있다(매니지드 500)");
  assert.doesNotMatch(MEMBERS, /LivChat\b|LivTurnRef|appendLivTurn|setLivChat/, "프로필에 헤드리스 대화 기록 필드가 남아 있다");
  assert.doesNotMatch(WEB_LIV, /\/api\/ui\/me\/liv\/turn|\/api\/ui\/me\/liv\/chat\b/, "★ 화면이 아직 헤드리스 턴을 부른다");
  assert.doesNotMatch(WEB_LIV_PAGE, /liv:auto|livAuto|AutoKind/, "숨김 턴(헤드리스 킥오프) 화면 배선이 남아 있다");
});

test("★★ 세션을 못 열면 원인을 말하는 503 — 500 «internal_error» 로 뭉개지지 않는다(#4032 의 본체)", () => {
  assert.match(CAP, /try \{\s*return await ensureLivSession\(user, text\);\s*\} catch \(e\) \{\s*if \(e instanceof HttpError\) throw e;[\s\S]*?throw new HttpError\(503, `리브를 열지 못했습니다 — \$\{\(e as Error\)\?\.message \?\? e\}`, \{ cause: e \}\);/,
    "★ 세션을 못 연 이유가 500 으로 뭉개진다");
  assert.match(CAP, /return \{ session_id: await currentLivSessionId\(userId, \{ heal: false \}\) \};/, "찾기가 복원 이정표를 따라간 id 를 안 준다");
});

test("★★ 리브 세션 = 보통 세션 — 생성 관문(launchSession) · task 종류 · liv 폴더 · 도구 제한 없음 · 좌표 기록 · 한 줄로 선 확보", () => {
  assert.match(SESSION, /const session = await launchSession\(user, \{\s*kind: "task",\s*label: o\.label,\s*rootKey: "personal", subpath: LIV_SUBPATH,\s*harness, flags: \{\}, autoApprove: false,\s*initialPrompt: prompt,\s*\}, \{ nodeId: "", invites: \[\] \}\);/,
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

test("★★ 화면 — 리브 탭은 리브 세션 대화창을 대화 보기로 붙이고, 복원되면 그 칸만 갈아 붙인다", () => {
  assert.match(WEB_LIV, /await api\('\/api\/ui\/me\/liv\/session'\)/, "리브 탭이 리브 세션을 안 찾는다");
  assert.match(WEB_LIV, /await api\('\/api\/ui\/me\/liv\/session', \{ method: 'POST', body: JSON\.stringify\(\{ text \}\) \}\)/, "첫 말이 리브 세션을 안 연다");
  assert.match(WEB_LIV, /h = await mount\(host, id, \{ onResumed: \(nid\) => \{ void show\(nid\); \}, isVisible \}\);/, "★ 복원되면 리브 칸이 새 세션으로 안 옮겨 간다(전역 주소가 끌려간다)");
  assert.match(WEB_LIV, /chatHome: true, isVisible: o\.isVisible, onResumed: o\.onResumed,/, "클래식 셸 경로가 대화 보기를 본자리로 안 연다");
  assert.match(WEB_MAIN, /mountSession: async \(h, sid, o\) => \{[\s\S]*?const handle = renderSession\(h, data, sid, \{\s*chatHome: true,/, "★ v2 셸이 리브 세션 대화창을 대화 보기로 안 붙인다");
  assert.match(WEB_MAIN, /const livTab = routeKey\(t\.route\) === 'liv';/, "20초 갱신이 리브 탭의 대화창에 상태를 안 흘린다");
  assert.match(WEB_CHAT, /chatHome\?: boolean;/, "세션 대화창에 대화 보기 본자리 옵션이 없다");
  assert.match(WEB_CHAT, /const chatHome = \(\): boolean => [^\n]*!!opts\.chatHome/, "★ 옵션이 보기 판정에 안 들어간다(리브 탭에 터미널이 뜬다)");
  //  카드의 문은 리브 칸 안의 입력칸만 만진다 — 셸이 탭 DOM 을 살려 두므로 문서 전체를 뒤지면 다른 탭 세션에 말이 간다.
  assert.doesNotMatch(WEB_LIV, /document\.querySelector\('\.livc-(input|compose)'\)/, "★ 카드가 문서 전체에서 입력칸을 찾는다");
});

test("★★ 리브 칸의 수명 — 떠나면 걷고, 못 붙이면 첫 말을 잃지 않고, 조회는 읽기만 한다(격리 리뷰 반영)", () => {
  //  세션 대화창의 폴링·message 리스너는 **부숴야만** 멈춘다 — 클래식 셸은 라우트 이동마다 걷는다(안 걷으면 드나들 때마다 쌓인다).
  assert.match(WEB_LIV, /export function livChatCleanup\(\): void \{/, "리브 칸을 걷는 문이 없다");
  assert.match(WEB_LIV, /export function mountLivChat\([^)]*\): void \{\s*livChatCleanup\(\);/, "다시 붙일 때 앞 칸을 안 걷는다");
  assert.match(WEB_LIV, /current = \{\s*destroy: \(\) => \{\s*\+\+gen;[^\n]*\s*if \(ownsHandle\) handle\?\.destroy\(\);\s*handle = null;\s*emptyView\?\.destroy\(\);/, "★ 걷기가 대화창·빈 대화·진행 중인 붙이기를 다 멈추지 않는다");
  const route = WEB_CLASSIC.slice(WEB_CLASSIC.indexOf("async function route()"));
  assert.ok(route.indexOf("livChatCleanup();") > 0 && route.indexOf("livChatCleanup();") < route.indexOf("await renderLiv(view);"),
    "★ 클래식 라우터가 이동마다 리브 칸을 안 걷는다(폴링·리스너 누수)");
  assert.match(WEB_MAIN, /if \(routeKey\(cur\.route\) === 'liv'\) livChatCleanup\(\);/, "v2 셸이 리브 탭을 떠날 때 안 걷는다");
  assert.match(WEB_MAIN, /if \(routeKey\(tab\.route\) === 'liv'\) livChatCleanup\(\);/, "v2 셸이 리브 탭을 닫을 때 안 걷는다");
  //  이미 세션이 있던 첫 말 — 대화창을 못 붙이면 그 말을 입력칸으로 돌려준다(보낸 척하지 않는다). 새로 연 경우엔 이미 갔다고 말한다.
  assert.match(WEB_LIV, /await show\(r\.session_id, \{ sent: true \}\);/, "새로 연 세션의 첫 말이 «갔다» 로 표시되지 않는다");
  assert.match(WEB_LIV, /await show\(r\.session_id, \{ draft: text \}\);/, "★ 이미 있던 세션의 첫 말이 못 붙으면 사라진다");
  assert.match(WEB_LIV, /else if \(o\.draft\) paintEmpty\([^\n]*, o\.draft\);/, "못 간 말을 빈 대화에 안 돌려준다");
  assert.match(WEB_LIV, /if \(draft\) \{ view\.input\.value = draft;/, "빈 대화가 돌려받은 말을 입력칸에 안 넣는다");
  //  조회(GET)는 읽기만 — 읽기전용 판정은 메서드로 가르므로 GET 이 쓰면 그 판정을 몰래 넘는다.
  assert.match(CAP, /return \{ session_id: await currentLivSessionId\(userId, \{ heal: false \}\) \};/, "★ 조회 창구가 좌표를 고쳐 쓴다(GET 에 쓰기)");
  assert.match(SESSION, /if \(o\.heal !== false && id && id !== prof\?\.liv_session\?\.id\) \{/, "heal:false 가 쓰기를 막지 않는다");
});

test("★★ 리브 탭에서 연 세션 이름이 서버·화면에서 같다 — 갈리면 사이드바로 연 리브 세션이 터미널로 열린다", () => {
  const web = WEB_CHAT.match(/const LIV_CHAT_LABEL = '([^']+)';/);
  assert.ok(web, "세션 화면에 리브 대화 세션 이름이 없다");
  assert.equal(web![1], LIV_CHAT_LABEL);
  assert.match(WEB_CHAT, /const chatHome = \(\): boolean => [^\n]*livChat\(\)/, "보기 판정이 리브 대화 세션을 모른다");
  //  첫 말 숨김은 킥오프에만 — 리브 탭의 첫 말은 사람이 쓴 것이다.
  assert.match(WEB_CHAT, /if \(livKickoff\(\) && !kickoffOpened\) \{/, "킥오프 첫 지시 숨김이 사라졌다");
  assert.doesNotMatch(WEB_CHAT, /livChat\(\)[^\n]*&& !kickoffOpened/, "사람이 쓴 첫 말까지 숨긴다");
});
