// 리브에게 일 맡기기(#4970 «리브 = 세션 하나») — me_liv_open 의 판정(openLiv). 입구는 하나, 일감만 다르다.
//  사양·엣지 표: <스크래치패드>/spec-liv-session.md 표 S(E1~E17). 의존을 주입해 **부작용(호출 기록)** 으로 잰다 — 무엇이 실제로 불렸나.
//  실행: npm run build && node dist/capabilities/delivery/liv-open.test.js
//  red 입증: 신규 판정이라 mutation(머리말 아래 기록) — 확보 전에 말 검사 · 세션 있으면 로그인 확인 안 함 · 넣기 실패 삼키기 · 우대 없음.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HttpError } from "../../http-error.js";
import { LIV_JOBS, livInstruction, livSessionHref, openLiv, pickLivHarness, type LivOpenDeps } from "./liv-chat.js";
import { WORKSPACE_SCOPED_KEYS } from "../../org/store/members.js";

let pass = 0, fail = 0;
const t = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); pass++; console.log(`ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
};

const user = { userId: "u1", email: "u1@example.invalid", scopes: ["memory"], projects: ["*"] } as never;
/** 호출 기록이 남는 가짜 의존. current = 이미 있는 리브 세션 id(없으면 null). */
function fake(o: {
  current?: string | null; usable?: string[] | Error; launchable?: string[]; launchId?: string;
  deliverFails?: boolean; ensureThrows?: Error;
} = {}) {
  const log = { ensure: [] as string[], usable: 0, open: [] as Array<{ harness: string | null; text: string }>, deliver: [] as Array<{ sid: string; text: string }> };
  const deps: LivOpenDeps = {
    //  실제 확보(ensureLivSession)의 계약 그대로 — 있으면 그 id(하네스 물음 없음), 없으면 하네스를 묻고 null 이면 안 연다.
    ensure: async (_u, text, harness) => {
      log.ensure.push(text);
      if (o.ensureThrows) throw o.ensureThrows;
      if (o.current) return { session_id: o.current, created: false };
      const h = await harness();
      if (h === null) return null;
      log.open.push({ harness: h, text });
      return { session_id: o.launchId ?? "box-u1-new", created: true, session: { id: o.launchId ?? "box-u1-new" } as never, harness: h };
    },
    usable: async () => { log.usable++; if (o.usable instanceof Error) throw o.usable; return o.usable ?? []; },
    launchable: async () => o.launchable ?? ["claude", "codex", "opencode", "antigravity", "grok"],
    deliver: async (sid, _uid, text) => { log.deliver.push({ sid, text }); if (o.deliverFails) throw new Error("box gone"); return { ok: true }; },
  };
  return { deps, log };
}
const status = async (p: Promise<unknown>): Promise<number | "ok"> => {
  try { await p; return "ok"; } catch (e) { return e instanceof HttpError ? e.status : -1; }
};

await t("E1 인증 없음 → 401 · 확보·로그인·넣기 0회", async () => {
  const { deps, log } = fake({ current: "box-u1-old", usable: ["claude"] });
  assert.equal(await status(openLiv({ userId: "" } as never, { job: "connect" }, deps)), 401);
  assert.equal(log.ensure.length + log.usable + log.deliver.length, 0, "인증 없이 무언가를 불렀다");
});

await t("E2 빈 말(공백) → 400 · 확보 0회", async () => {
  const { deps, log } = fake({ current: "box-u1-old" });
  assert.equal(await status(openLiv(user, { text: "   " }, deps)), 400);
  assert.equal(log.ensure.length, 0, "★ 말 검사 전에 세션을 확보했다(빈 말로 세션이 열린다)");
});

await t("E3 경계 — 정확히 8000자는 통과하고 그 글을 넣는다", async () => {
  const at = "가".repeat(8000);
  const { deps, log } = fake({ current: "box-u1-old" });
  const r = await openLiv(user, { text: ` ${at} ` }, deps);
  assert.equal(r.ai, true);
  assert.deepEqual(log.deliver, [{ sid: "box-u1-old", text: at }], "상한 글을 다듬어 그대로 넣지 않았다");
});

await t("E4 경계+1 — 8001자는 몇 자인지 말하는 400 · 확보 0회", async () => {
  const { deps, log } = fake({ current: "box-u1-old" });
  await assert.rejects(openLiv(user, { text: "가".repeat(8001) }, deps), (e: unknown) => e instanceof HttpError && e.status === 400 && /8001 > 8000/.test(e.message));
  assert.equal(log.ensure.length, 0);
});

await t("E5 일 없음·빈 값 → liv(점검) 말로 연다", async () => {
  for (const input of [{}, { job: "" }, { job: null }, null, undefined]) {
    const { deps, log } = fake({ usable: ["claude"] });
    const r = await openLiv(user, input as never, deps);
    assert.equal(r.ai, true, JSON.stringify(input));
    assert.deepEqual(log.open, [{ harness: "claude", text: LIV_JOBS.liv }], `${JSON.stringify(input)} 이 점검 말로 안 열렸다`);
  }
  assert.match(LIV_JOBS.liv, /\bliv 스킬/, "점검 말이 liv 스킬 이름을 말하지 않는다");
});

await t("E6 일 connect → 연결 말로 연다 · 연결 스킬 이름을 말한다", async () => {
  const { deps, log } = fake({ usable: ["claude"] });
  const r = await openLiv(user, { job: "connect" }, deps);
  assert.equal(r.ai, true);
  assert.deepEqual(log.open.map((x) => x.text), [LIV_JOBS.connect]);
  assert.match(LIV_JOBS.connect, /liv-connect 스킬/, "연결 말이 입구 스킬(liv-connect) 이름을 말하지 않는다");
});

await t("E7 모르는 일 → 400 · 확보 0회", async () => {
  const { deps, log } = fake({ usable: ["claude"] });
  assert.equal(await status(openLiv(user, { job: "nope" }, deps)), 400);
  assert.equal(log.ensure.length, 0);
});

await t("E8 리브 세션이 있으면 — 로그인 확인 0 · 열기 0 · 그 말을 넣는다 · delivered:true", async () => {
  const { deps, log } = fake({ current: "box-u1-old", usable: ["claude"] });
  const r = await openLiv(user, { job: "connect" }, deps);
  assert.deepEqual(r, { ai: true, session_id: "box-u1-old", href: "#/s/box-u1-old", created: false, delivered: true, text: LIV_JOBS.connect });
  assert.equal(log.usable, 0, "★ 세션이 있는데 비싼 로그인 확인을 했다");
  assert.equal(log.open.length, 0, "★ 세션이 있는데 또 열었다");
  assert.deepEqual(log.deliver, [{ sid: "box-u1-old", text: LIV_JOBS.connect }], "★ 있는 세션에 말을 안 넣었다(누른 일이 사라진다)");
});

await t("E9 넣기가 던지면 delivered:false — 호출은 성공으로 끝난다(화면이 입력칸에 돌려 둔다)", async () => {
  const { deps } = fake({ current: "box-u1-old", deliverFails: true });
  const r = await openLiv(user, { text: "노션 연결해 줘" }, deps);
  assert.deepEqual(r, { ai: true, session_id: "box-u1-old", href: "#/s/box-u1-old", created: false, delivered: false, text: "노션 연결해 줘" });
});

await t("E10 세션 없음 · 로그인 없음 → ai:false · 열기 0 · 넣기 0", async () => {
  const { deps, log } = fake({ usable: [] });
  assert.deepEqual(await openLiv(user, { job: "connect" }, deps), { ai: false, reason: "ai-not-connected" });
  assert.equal(log.usable, 1, "로그인을 안 물었다(배선)");
  assert.equal(log.open.length + log.deliver.length, 0);
});

await t("E11 세션 없음 · 로그인 확인이 던지면 ai:false", async () => {
  const { deps, log } = fake({ usable: new Error("probe") });
  assert.deepEqual(await openLiv(user, { job: "liv" }, deps), { ai: false, reason: "ai-not-connected" });
  assert.equal(log.open.length, 0);
});

await t("E12 우대 없음 — 로그인한 것 가운데 첫 번째(codex)로 연다 · 넣기 0 · 첫 지시 = 그 말", async () => {
  const { deps, log } = fake({ usable: ["codex", "claude"], launchId: "box-u1-x" });
  const r = await openLiv(user, { job: "connect" }, deps);
  assert.deepEqual(log.open, [{ harness: "codex", text: LIV_JOBS.connect }], "★ claude 를 우대했다 — 설계는 우대 없음");
  assert.equal(log.deliver.length, 0, "새로 연 세션에 말을 또 넣었다(첫 지시가 두 번 들어간다)");
  assert.equal(r.ai && r.created ? r.initialPrompt : null, LIV_JOBS.connect);
  assert.equal(r.ai ? r.href : null, "#/s/box-u1-x");
});

await t("E13 띄울 수 없는 것(셸·카탈로그 밖)은 건너뛰고 다음(opencode)", async () => {
  const { deps, log } = fake({ usable: ["shell", "cursor", "opencode"], launchable: ["claude", "opencode"] });
  await openLiv(user, { job: "liv" }, deps);
  assert.deepEqual(log.open.map((x) => x.harness), ["opencode"]);
  assert.equal(pickLivHarness(["cursor"], ["claude"]), null, "카탈로그 밖만 있으면 없다");
  assert.equal(pickLivHarness([], ["claude"]), null, "빈 로그인 목록");
});

await t("E14 확보가 일반 Error 로 던지면 원인을 말하는 503", async () => {
  const { deps } = fake({ ensureThrows: new Error("tmux 를 못 띄웠다") });
  await assert.rejects(openLiv(user, { job: "liv" }, deps), (e: unknown) => e instanceof HttpError && e.status === 503 && /리브를 열지 못했습니다 — tmux 를 못 띄웠다/.test(e.message));
});

await t("E15 확보가 HttpError 로 던지면 그대로(409)", async () => {
  const { deps } = fake({ ensureThrows: new HttpError(409, "겹침") });
  assert.equal(await status(openLiv(user, { job: "liv" }, deps)), 409);
});

await t("E16 화면이 갈 곳 — id 인코딩", async () => {
  assert.equal(livSessionHref("box-a 1"), "#/s/box-a%201");
  const { deps } = fake({ current: "box-a 1" });
  const r = await openLiv(user, { job: "liv" }, deps);
  assert.equal(r.ai ? r.href : null, "#/s/box-a%201");
});

await t("E17 (새로 도입한 칸) text 가 null 이면 글 없음과 같다 — 일의 말로", async () => {
  assert.equal(livInstruction({ text: null, job: "connect" }), LIV_JOBS.connect);
  assert.equal(livInstruction({ text: undefined }), LIV_JOBS.liv);
  assert.equal(livInstruction({ text: "  하이  ", job: "connect" }), "하이", "글이 있으면 일보다 글이 먼저");
});

// ── 배선 — 실제 문이 이 판정과 리브 세션 모듈을 탄다 · 따로 열던 연결 세션 좌표는 없다 ──
const code = (s: string): string => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const src = (rel: string): string => code(readFileSync(new URL(rel, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8"));

await t("W-S1 실제 문 = openLiv(realDeps) · 넣기는 사람이 보낸 것과 같은 통로(deliverPromptForMember) · 확보는 리브 세션 모듈", () => {
  const CAP = src("./liv-chat.ts");
  assert.match(CAP, /async \(input: Record<string, unknown>, user: LivelyUser\) => openLiv\(user, input, realDeps\),/);
  assert.match(CAP, /deliverPromptForMember\(sessionId, userId, text\)/, "★ 있는 세션에 넣는 통로가 사람의 보내기와 다르다(접근 판정을 건너뛴다)");
  assert.match(CAP, /ensure: \(user, text, harness\) => ensureLivSession\(user, text, \{ harness \}\),/);
  const SESSION = src("../../org/liv/session.ts");
  assert.match(SESSION, /if \(harness === null\) return null;/, "★ 로그인한 AI 가 없는데 기본 하네스로 연다");
  assert.match(SESSION, /const made = await openLivSession\(user, \{ prompt: text, label: LIV_CHAT_LABEL, harness \}\);/, "고른 하네스로 리브 세션을 안 연다");
  //  고른 하네스는 헤드리스(위탁) 지원표로 다시 거르지 않는다 — 그 표에 없는 opencode 로만 로그인한 사람에게 리브가 안 열리던 자리(503).
  assert.match(SESSION, /const harness = String\(o\.harness \?\? ""\)\.trim\(\) \|\| await resolveHeadlessHarness\(userId, null\);/,
    "★ 고른 하네스가 위탁 지원표(resolveHeadlessHarness explicit)로 걸러진다 — opencode 만 이은 사람에게 리브가 안 열린다");
});

await t("W-S2 PR2 의 따로 열던 연결 세션(좌표 connect_session · 문 me_connect_session_open)이 없다 — 연결도 리브 세션으로", () => {
  assert.ok(!(WORKSPACE_SCOPED_KEYS as readonly string[]).includes("connect_session"), "워크스페이스 층 키에 connect_session 이 남아 있다");
  const MEMBERS = src("../../org/store/members.ts");
  assert.doesNotMatch(MEMBERS, /connect_session|setConnectSession/, "★ 따로 여는 연결 세션 좌표가 남아 있다 — 리브와 연결이 두 세션으로 갈린다");
  const REG = src("../delivery.ts");
  assert.doesNotMatch(REG, /connect-session|connectSessionCapabilities/, "옛 연결 세션 문이 등록돼 있다");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
