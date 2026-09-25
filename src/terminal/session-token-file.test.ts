// #4135 — **세션 토큰 파일(`session-token-file.ts`)** 의 사양 시험 — 사양 D(파일 쪽 1–3)만 보고 쓴 블라인드 시험.
//
// ── 무엇이 고장나 있었나 ─────────────────────────────────────────────────────
// C(사전 발급)는 새로 뜨는 세션에만 닿는다. 이미 떠 있는 노드 세션은 토큰 없이 돌고 있고 살아 있는 프로세스의 env 는
//  못 바꾼다. 그래서 훅·MCP 프록시가 매 호출 읽는 **파일** 하나를 두고, 게이트웨이가 살아 있는 세션을 보면 그 주인 앞으로
//  구워 노드에 심는다. 이 파일은 그 «심는 자리» 의 리프다.
//
// ── 여기서 지키는 것 ─────────────────────────────────────────────────────────
//  1. `sessionTokenFilePath(id, home)` — id 가 세션 id 형식(`^box-[a-z0-9-]+-[a-f0-9]{8}$`)이면
//     `<home>/.lively/session-tokens/<id>.json`, 아니면 null.
//  2. `writeSessionTokens(id, {hook, mcp}, home)` — 형식 위반 id 는 던진다. hook·mcp 중 하나라도 비어 있지 않은 문자열이면
//     파일을 만들고(폴더는 없으면 만든다 · 파일 0600 · 폴더 0700) 내용은 JSON `{ hook, mcp, at }`(빈/공백 값은 null) 그리고 true.
//     둘 다 비면 파일을 (있으면) 지우고 false. 같은 id 에 다시 쓰면 덮어쓴다. 폴더 안에 `.tmp` 임시 파일을 남기지 않는다.
//  3. `removeSessionTokens(id, home)` — 파일을 지운다. 없어도, 형식 위반 id 여도 던지지 않는다.
//  ⚠ 진짜 홈은 절대 건드리지 않는다 — 임시 dir 을 `home` 으로 **명시적으로** 넘기고, 그 안에서만 논다.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionTokenFilePath, writeSessionTokens, removeSessionTokens } from "./session-token-file.js";
import type { SessionTokens } from "./session-token-file.js";

// ── 재료 ────────────────────────────────────────────────────────────────────
const SESSION_ID_RE = /^box-[a-z0-9-]+-[a-f0-9]{8}$/;      // 사양 D1 의 세션 id 형식
const ID = "box-wonjoon-jang-0123abcd";
const ID2 = "box-sangmin-kim-cafebabe";
const BAD_IDS: [string, string][] = [
  ["빈 문자열", ""],
  ["접두어 없음", "0123abcd"],
  ["box- 만", "box-"],
  ["빈 slug", "box--0123abcd"],
  ["16진수 7자리", "box-wonjoon-jang-0123abc"],
  ["16진수 9자리", "box-wonjoon-jang-0123abcd9"],
  ["16진수 대문자", "box-wonjoon-jang-0123ABCD"],
  ["16진수 아닌 글자", "box-wonjoon-jang-0123abcg"],
  ["접두어 대문자", "BOX-wonjoon-jang-0123abcd"],
  ["slug 에 밑줄", "box-wonjoon_jang-0123abcd"],
  ["slug 에 점", "box-wonjoon.jang-0123abcd"],
  ["경로 탈출(..)", "../../etc/passwd"],
  ["경로 탈출(뒤에 경로)", "box-wonjoon-jang-0123abcd/../x"],
  ["앞 공백", " box-wonjoon-jang-0123abcd"],
  ["뒤 개행", "box-wonjoon-jang-0123abcd\n"],
  ["슬래시 포함", "box/wonjoon-jang-0123abcd"],
];

const roots: string[] = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

/** 임시 홈 — 안에 `.lively` 조차 없다(폴더를 만드는 것도 사양). */
function tmpHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lively-session-token-file-"));
  roots.push(root);
  return root;
}
const dirOf = (home: string) => path.join(home, ".lively", "session-tokens");
const fileOf = (home: string, id: string) => path.join(dirOf(home), `${id}.json`);
const readJson = (p: string): Record<string, unknown> => JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
const modeOf = (p: string) => fs.statSync(p).mode & 0o777;
const listing = (home: string): string[] => (fs.existsSync(dirOf(home)) ? fs.readdirSync(dirOf(home)).sort() : []);

// ═══ 1. sessionTokenFilePath — 순수 경로 판정 ═══════════════════════════════
test("D1-1 세션 id 형식이면 `<home>/.lively/session-tokens/<id>.json`", () => {
  const home = tmpHome();
  for (const id of [ID, ID2, "box-a-00000000", "box-a-b-c-d-ffffffff", "box-0-deadbeef"]) {
    assert.match(id, SESSION_ID_RE, `시험 재료 오류: ${id}`);
    assert.equal(sessionTokenFilePath(id, home), path.join(home, ".lively", "session-tokens", `${id}.json`), id);
  }
});

test("D1-2 형식 위반 id 는 null — 대문자·길이·이상한 글자·경로 탈출 전부, 던지지 않는다", () => {
  const home = tmpHome();
  for (const [label, id] of BAD_IDS) {
    let out: string | null | undefined;
    assert.doesNotThrow(() => { out = sessionTokenFilePath(id, home); }, `던졌다: ${label}`);
    assert.equal(out, null, `${label}: ${JSON.stringify(id)}`);
  }
});

test("D1-3 home 을 생략하면 어떤 홈 아래의 같은 꼴 — 절대 경로이고 `.lively/session-tokens/<id>.json` 으로 끝난다", () => {
  const p = sessionTokenFilePath(ID);
  assert.equal(typeof p, "string");
  assert.ok(path.isAbsolute(p!), `절대 경로가 아니다: ${p}`);
  assert.ok(p!.endsWith(path.sep + path.join(".lively", "session-tokens", `${ID}.json`)), p!);
  assert.equal(sessionTokenFilePath("not-a-session"), null);
});

// ═══ 2. writeSessionTokens — 심기 ═══════════════════════════════════════════
test("D2-1 둘 다 있으면 폴더(0700)·파일(0600)을 만들고 JSON { hook, mcp, at } 를 쓰고 true", async () => {
  const home = tmpHome();
  assert.ok(!fs.existsSync(path.join(home, ".lively")), "시험 재료 오류: .lively 가 이미 있다");
  const out = await writeSessionTokens(ID, { hook: "hook-tok", mcp: "mcp-tok" }, home);
  assert.equal(out, true);
  const p = fileOf(home, ID);
  assert.equal(p, sessionTokenFilePath(ID, home), "쓴 자리와 sessionTokenFilePath 가 다르다");
  assert.ok(fs.existsSync(p), `파일이 없다: ${p}`);
  assert.ok(fs.statSync(dirOf(home)).isDirectory());
  assert.equal(modeOf(dirOf(home)), 0o700, "폴더 권한");
  assert.equal(modeOf(p), 0o600, "파일 권한");
  const j = readJson(p);
  assert.deepEqual(Object.keys(j).sort(), ["at", "hook", "mcp"], `JSON 키: ${JSON.stringify(j)}`);
  assert.equal(j.hook, "hook-tok");
  assert.equal(j.mcp, "mcp-tok");
  assert.equal(typeof j.at, "number", `at 이 숫자가 아니다: ${JSON.stringify(j.at)}`);
  assert.ok(Number.isFinite(j.at as number) && (j.at as number) > 0, `at: ${String(j.at)}`);
});

test("D2-2 하나만 있어도 파일을 만든다 — 빈 문자열·공백·null 인 쪽은 null 로 적는다", async () => {
  const cases: [string, SessionTokens, { hook: string | null; mcp: string | null }][] = [
    ["hook 만(mcp 빈 문자열)", { hook: "h1", mcp: "" }, { hook: "h1", mcp: null }],
    ["hook 만(mcp 공백)", { hook: "h2", mcp: "   " }, { hook: "h2", mcp: null }],
    ["hook 만(mcp null)", { hook: "h3", mcp: null }, { hook: "h3", mcp: null }],
    ["mcp 만(hook 빈 문자열)", { hook: "", mcp: "m1" }, { hook: null, mcp: "m1" }],
    ["mcp 만(hook 공백·탭·개행)", { hook: " \t\n", mcp: "m2" }, { hook: null, mcp: "m2" }],
    ["mcp 만(hook null)", { hook: null, mcp: "m3" }, { hook: null, mcp: "m3" }],
  ];
  for (const [label, tokens, want] of cases) {
    const home = tmpHome();
    assert.equal(await writeSessionTokens(ID, tokens, home), true, label);
    const j = readJson(fileOf(home, ID));
    assert.equal(j.hook, want.hook, `${label}: hook`);
    assert.equal(j.mcp, want.mcp, `${label}: mcp`);
    assert.equal(typeof j.at, "number", `${label}: at`);
    assert.equal(modeOf(fileOf(home, ID)), 0o600, `${label}: 파일 권한`);
    assert.equal(modeOf(dirOf(home)), 0o700, `${label}: 폴더 권한`);
  }
});

test("D2-3 형식 위반 id 는 던진다 — 파일도 폴더도 만들지 않는다", async () => {
  const home = tmpHome();
  for (const [label, id] of BAD_IDS) {
    await assert.rejects(() => writeSessionTokens(id, { hook: "h", mcp: "m" }, home), `던지지 않았다: ${label} ${JSON.stringify(id)}`);
  }
  assert.ok(!fs.existsSync(dirOf(home)), "형식 위반 id 로 폴더가 생겼다");
  // 홈 밖으로 새어 나가지 않았다 — 홈 안엔 아무것도 없다
  assert.deepEqual(fs.readdirSync(home), [], "형식 위반 id 로 홈 안에 무언가 생겼다");
});

test("D2-4 둘 다 비면 false — 있던 파일은 지우고, 없으면 그냥 false, 던지지 않는다", async () => {
  const empties: [string, SessionTokens][] = [
    ["null·null", { hook: null, mcp: null }],
    ["빈 문자열·빈 문자열", { hook: "", mcp: "" }],
    ["공백·공백", { hook: "  ", mcp: "\n" }],
    ["null·공백", { hook: null, mcp: " " }],
  ];
  for (const [label, tokens] of empties) {
    const home = tmpHome();
    // 없을 때
    let out: boolean | undefined;
    await assert.doesNotReject(async () => { out = await writeSessionTokens(ID, tokens, home); }, label);
    assert.equal(out, false, `${label}: 없을 때`);
    assert.ok(!fs.existsSync(fileOf(home, ID)), `${label}: 빈 값으로 파일이 생겼다`);
    // 있을 때 — 지운다
    assert.equal(await writeSessionTokens(ID, { hook: "h", mcp: "m" }, home), true);
    assert.ok(fs.existsSync(fileOf(home, ID)));
    assert.equal(await writeSessionTokens(ID, tokens, home), false, `${label}: 있을 때`);
    assert.ok(!fs.existsSync(fileOf(home, ID)), `${label}: 빈 값을 썼는데 파일이 남았다`);
    assert.ok(!listing(home).some((f) => f.endsWith(".tmp")), `${label}: .tmp 가 남았다: ${listing(home).join(", ")}`);
  }
});

test("D2-5 같은 id 에 다시 쓰면 덮어쓴다 — 내용은 마지막 것, 권한은 그대로 0600, 다른 id 는 건드리지 않는다", async () => {
  const home = tmpHome();
  assert.equal(await writeSessionTokens(ID, { hook: "first-h", mcp: "first-m" }, home), true);
  const at1 = readJson(fileOf(home, ID)).at as number;
  assert.equal(await writeSessionTokens(ID2, { hook: "other-h", mcp: "other-m" }, home), true);
  assert.equal(await writeSessionTokens(ID, { hook: "second-h", mcp: null }, home), true);
  const j = readJson(fileOf(home, ID));
  assert.equal(j.hook, "second-h");
  assert.equal(j.mcp, null);
  assert.ok((j.at as number) >= at1, `덮어쓴 at 이 앞선다: ${String(j.at)} < ${at1}`);
  assert.equal(modeOf(fileOf(home, ID)), 0o600);
  const other = readJson(fileOf(home, ID2));
  assert.equal(other.hook, "other-h"); assert.equal(other.mcp, "other-m");
  // 세 번째 — 다시 둘 다 채운다
  assert.equal(await writeSessionTokens(ID, { hook: "third-h", mcp: "third-m" }, home), true);
  assert.deepEqual([readJson(fileOf(home, ID)).hook, readJson(fileOf(home, ID)).mcp], ["third-h", "third-m"]);
  assert.deepEqual(listing(home), [`${ID}.json`, `${ID2}.json`].sort(), "폴더에 두 파일만 있어야 한다");
});

test("D2-6 폴더 안에 `.tmp` 임시 파일을 남기지 않는다 — 여러 번 쓰고·지우고·덮어써도 목록은 `<id>.json` 뿐", async () => {
  const home = tmpHome();
  for (let i = 0; i < 5; i++) {
    assert.equal(await writeSessionTokens(ID, { hook: `h${i}`, mcp: `m${i}` }, home), true);
    assert.equal(await writeSessionTokens(ID2, { hook: `h${i}`, mcp: null }, home), true);
  }
  assert.deepEqual(listing(home), [`${ID}.json`, `${ID2}.json`].sort(), `임시 파일이 남았다: ${listing(home).join(", ")}`);
  assert.equal(await writeSessionTokens(ID2, { hook: null, mcp: null }, home), false);
  assert.deepEqual(listing(home), [`${ID}.json`], `임시 파일이 남았다: ${listing(home).join(", ")}`);
  await removeSessionTokens(ID, home);
  assert.deepEqual(listing(home), [], `임시 파일이 남았다: ${listing(home).join(", ")}`);
  // 동시에 여러 id 를 써도 마찬가지
  const ids = Array.from({ length: 8 }, (_, i) => `box-wonjoon-jang-0000000${i}`);
  await Promise.all(ids.map((id, i) => writeSessionTokens(id, { hook: `h${i}`, mcp: `m${i}` }, home)));
  assert.deepEqual(listing(home), ids.map((id) => `${id}.json`).sort(), `임시 파일이 남았다: ${listing(home).join(", ")}`);
  for (const id of ids) assert.equal(readJson(fileOf(home, id)).hook, `h${ids.indexOf(id)}`);
});

test("D2-7 폴더가 이미 있어도(먼저 만든 것) 쓴다 — 파일은 0600", async () => {
  const home = tmpHome();
  fs.mkdirSync(dirOf(home), { recursive: true, mode: 0o700 });
  assert.equal(await writeSessionTokens(ID, { hook: "h", mcp: "m" }, home), true);
  assert.equal(modeOf(fileOf(home, ID)), 0o600);
  assert.deepEqual(readJson(fileOf(home, ID)).hook, "h");
});

// ═══ 3. removeSessionTokens — 지우기 ════════════════════════════════════════
test("D3-1 있는 파일을 지운다 — 다른 id 의 파일은 그대로", async () => {
  const home = tmpHome();
  assert.equal(await writeSessionTokens(ID, { hook: "h", mcp: "m" }, home), true);
  assert.equal(await writeSessionTokens(ID2, { hook: "h", mcp: "m" }, home), true);
  await removeSessionTokens(ID, home);
  assert.ok(!fs.existsSync(fileOf(home, ID)), "지워지지 않았다");
  assert.ok(fs.existsSync(fileOf(home, ID2)), "다른 id 의 파일까지 지웠다");
  assert.ok(!listing(home).some((f) => f.endsWith(".tmp")), `.tmp 가 남았다: ${listing(home).join(", ")}`);
});

test("D3-2 없어도 던지지 않는다 — 파일만 없을 때·폴더째 없을 때·두 번 지울 때", async () => {
  const home = tmpHome();
  await assert.doesNotReject(() => removeSessionTokens(ID, home), "폴더째 없을 때");
  fs.mkdirSync(dirOf(home), { recursive: true });
  await assert.doesNotReject(() => removeSessionTokens(ID, home), "파일만 없을 때");
  assert.equal(await writeSessionTokens(ID, { hook: "h", mcp: "m" }, home), true);
  await removeSessionTokens(ID, home);
  await assert.doesNotReject(() => removeSessionTokens(ID, home), "두 번째 지우기");
  assert.ok(!fs.existsSync(fileOf(home, ID)));
});

test("D3-3 형식 위반 id 여도 던지지 않는다 — 홈 안의 다른 것도 건드리지 않는다", async () => {
  const home = tmpHome();
  assert.equal(await writeSessionTokens(ID, { hook: "h", mcp: "m" }, home), true);
  fs.writeFileSync(path.join(home, ".lively", "passwd"), "sentinel\n");   // 경로 탈출 id 가 노릴 만한 자리
  for (const [label, id] of BAD_IDS) {
    await assert.doesNotReject(() => removeSessionTokens(id, home), `던졌다: ${label} ${JSON.stringify(id)}`);
  }
  assert.ok(fs.existsSync(fileOf(home, ID)), "멀쩡한 파일이 사라졌다");
  assert.equal(fs.readFileSync(path.join(home, ".lively", "passwd"), "utf8"), "sentinel\n", "홈 안의 다른 파일이 건드려졌다");
});

test("D3-4 쓰고 → 지우고 → 다시 쓰면 다시 생긴다(지우기가 폴더까지 망가뜨리지 않는다)", async () => {
  const home = tmpHome();
  assert.equal(await writeSessionTokens(ID, { hook: "h", mcp: "m" }, home), true);
  await removeSessionTokens(ID, home);
  assert.equal(await writeSessionTokens(ID, { hook: "h2", mcp: "m2" }, home), true);
  assert.equal(readJson(fileOf(home, ID)).hook, "h2");
  assert.equal(modeOf(fileOf(home, ID)), 0o600);
  assert.equal(modeOf(dirOf(home)), 0o700);
});
