// #4135 — **노드 세션의 훅·MCP 신원(`node-session-preissue.ts` + `session-id.ts`)** 의 사양 시험 — 사양 C 만 보고 쓴 블라인드 시험.
//
// ── 무엇이 고장나 있었나 ─────────────────────────────────────────────────────
// 노드(멤버 PC)에서 뜨는 세션은 세션 생성 코드가 노드에서 돌아 DB 를 못 쓰므로 세션 전용 훅·MCP 토큰을 굽지 못했다.
//  그래서 훅이 «키트를 깐 사람» 의 공유 토큰으로 나갔고, 게이트웨이는 그 세션을 남의 것으로 보아 프로젝트 문맥·업싱크·
//  이름짓기를 거절했다. 고침: 게이트웨이가 relay 전에 세션 id 를 **미리 정하고** 그 id 로 토큰을 구워 input 에 실어 보낸다.
//
// ── 여기서 지키는 것(C1·C2 — 순수 리프 + 게이트웨이 단위) ────────────────────
//  1. `acceptPreissuedId(user, id)` — 문자열이고 세션 id 형식(`^box-[a-z0-9-]+-[a-f0-9]{8}$`)에 맞고 **그 사용자의**
//     접두어(`sessionPrefix(user)`)로 시작하면 그 id 를 그대로, 아니면 null. undefined·null·빈 문자열·문자열 아님·
//     다른 사람 접두어·대문자·이상한 글자·16진수 길이 위반·16진수 없음 → null. 던지지 않는다.
//  2. `preissueNodeSession(user, input, deps)` — id = `sessionPrefix(user)` + 소문자 16진수 8자리 · 그 id 로
//     `deps.mintHook(memberId, id)`·`deps.mintMcp(memberId, id)` 를 **각각 한 번**(memberId = user 의 id) ·
//     돌려주는 값은 `{ ...input, preissued: { id, hookToken, mcpToken } }`(input 의 다른 필드는 그대로) ·
//     민팅이 던지거나 null 이면 그 토큰만 null(다른 토큰·id 는 그대로) · 두 번 부르면 id 가 다르다 ·
//     돌려준 id 는 같은 사용자의 `acceptPreissuedId` 가 받아 주고 다른 사용자는 거절한다.
//  3. `withPreissuedIdentity(user, input, relay, deps)` — 2 를 거친 input 으로 `relay(created)` 를 **한 번** 부른다.
//     성공 + 응답 id 가 `created.preissued.id` 와 같으면 회수 없이 그 세션 그대로 · relay 가 던지면 `deps.revoke(그 id)` 뒤
//     **같은 오류**를 다시 던진다 · 성공인데 id 가 다르면(노드가 id 를 안 받음) `deps.revoke(구운 id)` 뒤 응답 세션 그대로 ·
//     `deps.revoke` 가 던지거나 거부해도 결과는 바뀌지 않는다(비치명).
//  ⚠ 기본 deps 는 DB 를 만진다 — 언제나 호출을 기록하는 가짜 deps 를 넘긴다. (C3·C4 — createSession·relay 배선은 통합 시험 몫.)
import test from "node:test";
import assert from "node:assert/strict";
import { sessionPrefix, acceptPreissuedId } from "./session-id.js";
import { preissueNodeSession, withPreissuedIdentity, type PreissueDeps } from "./node-session-preissue.js";
import type { LivelyUser } from "../context.js";
import type { CreateInput, SessionInfo } from "./catalog.js";

// ── 재료 ────────────────────────────────────────────────────────────────────
const SESSION_ID_RE = /^box-[a-z0-9-]+-[a-f0-9]{8}$/;      // 사양 C1 의 세션 id 형식
const PREFIX_RE = /^box-[a-z0-9-]+-$/;                      // `box-<slug>-`
const HEX8_RE = /^[a-f0-9]{8}$/;

const wonjoon = { userId: "wonjoon-jang" } as LivelyUser;
const sangmin = { userId: "sangmin-kim" } as LivelyUser;

const minimalInput = (): CreateInput =>
  ({ kind: "human", label: "t", rootKey: "personal", subpath: "", harness: "claude", flags: {}, autoApprove: false } as unknown as CreateInput);

type MintMode = "ok" | "null" | "reject" | "throwSync";
type RevokeMode = "ok" | "reject" | "throwSync";
interface MintCall { which: "hook" | "mcp"; memberId: string; boxId: string }

/** 가짜 민터·회수기 — 호출을 전부 기록하고, 모드에 따라 토큰(`<which>:<boxId>`)·null·거부·동기 예외를 낸다. */
function fakeDeps(modes: { hook?: MintMode; mcp?: MintMode; revoke?: RevokeMode } = {}) {
  const calls: MintCall[] = [];
  const revokeCalls: string[] = [];
  const mint = (which: "hook" | "mcp", mode: MintMode) => (memberId: string, boxId: string): Promise<string | null> => {
    calls.push({ which, memberId, boxId });
    if (mode === "throwSync") throw new Error(`${which} 민터 동기 예외`);
    if (mode === "reject") return Promise.reject(new Error(`${which} 민터 실패`));
    if (mode === "null") return Promise.resolve(null);
    return Promise.resolve(`${which}:${boxId}`);
  };
  const revokeMode: RevokeMode = modes.revoke ?? "ok";
  const deps: PreissueDeps = {
    mintHook: mint("hook", modes.hook ?? "ok"),
    mintMcp: mint("mcp", modes.mcp ?? "ok"),
    revoke: (sessionId: string): Promise<unknown> => {
      revokeCalls.push(sessionId);
      if (revokeMode === "throwSync") throw new Error("회수기 동기 예외");
      if (revokeMode === "reject") return Promise.reject(new Error("회수기 실패"));
      return Promise.resolve({ revoked: sessionId });
    },
  };
  const hookCalls = () => calls.filter((c) => c.which === "hook");
  const mcpCalls = () => calls.filter((c) => c.which === "mcp");
  return { deps, calls, revokeCalls, hookCalls, mcpCalls };
}

/** 가짜 노드 응답 — 사양 C5 가 말하는 필드는 id 뿐 */
const sessionOf = (id: string): SessionInfo => ({ id, label: "t", harness: "claude" } as unknown as SessionInfo);

/** relay 호출을 기록하는 가짜 — 모드에 따라 «받은 preissued.id 그대로» · «다른 id» · «던짐» */
function fakeRelay(mode: { returns?: "same" | "other"; throws?: Error }) {
  const calls: CreateInput[] = [];
  const returned: SessionInfo[] = [];
  const relay = async (created: CreateInput): Promise<SessionInfo> => {
    calls.push(created);
    if (mode.throws) throw mode.throws;
    const id = mode.returns === "other" ? "box-node-made-its-own-cafebabe" : preissuedOf(created).id;
    const s = sessionOf(id);
    returned.push(s);
    return s;
  };
  return { relay, calls, returned };
}

/** preissued 가 실린 결과에서 id·토큰을 꺼낸다 — 없으면 시험이 여기서 명확히 죽는다. */
function preissuedOf(out: CreateInput): { id: string; hookToken: string | null; mcpToken: string | null } {
  const p = (out as { preissued?: unknown }).preissued;
  assert.ok(p && typeof p === "object", `preissued 가 없다: ${JSON.stringify(out)}`);
  return p as { id: string; hookToken: string | null; mcpToken: string | null };
}

/** preissued 를 뺀 나머지 필드 — «input 의 다른 필드는 그대로» 비교용 */
function withoutPreissued(o: CreateInput): Record<string, unknown> {
  const { preissued: _p, ...rest } = o as unknown as Record<string, unknown>;
  return rest;
}

// ═══ 1. sessionPrefix · acceptPreissuedId — 순수 판정 ═══════════════════════
test("C1-0 sessionPrefix — `box-<slug>-` 꼴(소문자·숫자·하이픈, slug 최대 24자) · 같은 사용자면 같고 다른 사용자면 다르다", () => {
  const p = sessionPrefix(wonjoon);
  assert.equal(typeof p, "string");
  assert.match(p, PREFIX_RE, p);
  const slug = p.slice("box-".length, -1);
  assert.ok(slug.length >= 1 && slug.length <= 24, `slug 길이: ${slug.length} (${slug})`);
  assert.equal(sessionPrefix(wonjoon), p, "같은 사용자인데 접두어가 달라졌다");
  assert.notEqual(sessionPrefix(sangmin), p, "다른 사용자인데 접두어가 같다");
  assert.match(sessionPrefix(sangmin), PREFIX_RE);
  // 이상한 글자·긴 id 의 사용자라도 접두어 꼴은 지킨다
  const odd = { userId: "Wonjoon.Jang_X@Example.COM-with-a-very-long-tail-indeed" } as LivelyUser;
  const po = sessionPrefix(odd);
  assert.match(po, PREFIX_RE, po);
  assert.ok(po.slice("box-".length, -1).length <= 24, `slug 가 24자를 넘는다: ${po}`);
});

test("C1-1 형식에 맞고 내 접두어로 시작하는 id 는 그대로(같은 문자열) 돌려준다", () => {
  const prefix = sessionPrefix(wonjoon);
  for (const hex of ["deadbeef", "01234567", "00000000", "ffffffff", "a1b2c3d4"]) {
    const id = prefix + hex;
    assert.match(id, SESSION_ID_RE, id);
    assert.equal(acceptPreissuedId(wonjoon, id), id, id);
  }
});

test("C1-2 undefined·null·빈 문자열·문자열 아님 → null, 던지지 않는다", () => {
  const bad: unknown[] = [undefined, null, "", 0, 1, 12345678, true, false, {}, [], { id: sessionPrefix(wonjoon) + "deadbeef" },
    [sessionPrefix(wonjoon) + "deadbeef"], () => sessionPrefix(wonjoon) + "deadbeef", Symbol("id"), 10n];
  for (const v of bad) {
    let out: string | null | undefined;
    assert.doesNotThrow(() => { out = acceptPreissuedId(wonjoon, v); }, `던졌다: ${String(typeof v === "symbol" ? "symbol" : v)}`);
    assert.equal(out, null, `null 이어야 한다: ${typeof v} ${String(typeof v === "symbol" ? "symbol" : v)}`);
  }
});

test("C1-3 다른 사람의 접두어로 시작하면 — 형식이 완벽해도 null", () => {
  const theirs = sessionPrefix(sangmin) + "deadbeef";
  assert.match(theirs, SESSION_ID_RE);
  assert.equal(acceptPreissuedId(sangmin, theirs), theirs, "본인은 받아야 한다");
  assert.equal(acceptPreissuedId(wonjoon, theirs), null, "남의 id 를 받아 줬다");
  // 접두어만 슬쩍 닮은 것 — `box-` 만 같고 slug 가 다른 것들
  assert.equal(acceptPreissuedId(wonjoon, "box-someone-else-deadbeef"), null);
  assert.equal(acceptPreissuedId(wonjoon, "box-x-deadbeef"), null);
});

test("C1-4 형식 위반 — 대문자·이상한 글자·16진수 길이 위반·16진수 없음·접두어 없음 → null", () => {
  const prefix = sessionPrefix(wonjoon);
  const bad: [string, string][] = [
    ["16진수 7자리", prefix + "deadbee"],
    ["16진수 9자리", prefix + "deadbeef0"],
    ["16진수 16자리", prefix + "deadbeefdeadbeef"],
    ["16진수 없음(접두어만)", prefix],
    ["접두어에서 끝 하이픈까지 뗀 것", prefix.slice(0, -1)],
    ["16진수 대문자", prefix + "DEADBEEF"],
    ["16진수에 섞인 대문자", prefix + "deadBeef"],
    ["16진수 아닌 글자(g)", prefix + "deadbeeg"],
    ["16진수 아닌 글자(z)", prefix + "zzzzzzzz"],
    ["16진수 자리에 하이픈", prefix + "dead-eef"],
    ["16진수 자리에 밑줄", prefix + "dead_eef"],
    ["접두어 대문자", prefix.toUpperCase() + "deadbeef"],
    ["접두어 첫 글자만 대문자", "B" + prefix.slice(1) + "deadbeef"],
    ["slug 에 밑줄", "box-" + prefix.slice(4, -1) + "_x-deadbeef"],
    ["slug 에 점", "box-" + prefix.slice(4, -1) + ".x-deadbeef"],
    ["slug 에 공백", "box-" + prefix.slice(4, -1) + " x-deadbeef"],
    ["앞 공백", " " + prefix + "deadbeef"],
    ["뒤 공백", prefix + "deadbeef "],
    ["뒤 개행", prefix + "deadbeef\n"],
    ["앞에 다른 것", "x" + prefix + "deadbeef"],
    ["뒤에 경로", prefix + "deadbeef/../x"],
    ["16진수 뒤에 하이픈", prefix + "deadbeef-"],
    ["box- 없이 slug 부터", prefix.slice(4) + "deadbeef"],
    ["다른 접두어 단어", "session-" + prefix.slice(4) + "deadbeef"],
    ["빈 slug", "box--deadbeef"],
    ["box- 만", "box-"],
    ["16진수만", "deadbeef"],
    ["빈 문자열", ""],
  ];
  for (const [label, id] of bad) {
    let out: string | null | undefined;
    assert.doesNotThrow(() => { out = acceptPreissuedId(wonjoon, id); }, `던졌다: ${label}`);
    assert.equal(out, null, `${label}: ${JSON.stringify(id)}`);
  }
});

// ═══ 2. preissueNodeSession — 게이트웨이의 사전 발급 ═════════════════════════
test("C2-1 돌려주는 값은 { ...input, preissued: { id, hookToken, mcpToken } } — input 의 다른 필드는 그대로", async () => {
  const k = fakeDeps();
  const input = minimalInput();
  const snapshot = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  const out = await preissueNodeSession(wonjoon, input, k.deps);
  assert.ok(out && typeof out === "object", "객체가 아니다");
  assert.deepEqual(withoutPreissued(out), snapshot, "input 의 다른 필드가 바뀌었다");
  const p = preissuedOf(out);
  assert.deepEqual(Object.keys(p).sort(), ["hookToken", "id", "mcpToken"], "preissued 의 키");
  assert.equal(typeof p.id, "string");
  assert.equal(p.hookToken, `hook:${p.id}`, "hookToken 이 민터가 준 값이 아니다");
  assert.equal(p.mcpToken, `mcp:${p.id}`, "mcpToken 이 민터가 준 값이 아니다");
  // `{ ...input, ... }` — 넘긴 input 자체는 그대로다
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshot, "넘긴 input 이 변형됐다");
  assert.ok(!("preissued" in (input as object)), "넘긴 input 에 preissued 가 박혔다");
});

test("C2-2 id = sessionPrefix(user) + 소문자 16진수 8자리 — 세션 id 형식에 맞는다", async () => {
  const k = fakeDeps();
  const { id } = preissuedOf(await preissueNodeSession(wonjoon, minimalInput(), k.deps));
  const prefix = sessionPrefix(wonjoon);
  assert.ok(id.startsWith(prefix), `접두어가 아니다: ${id} (기대 접두어 ${prefix})`);
  const hex = id.slice(prefix.length);
  assert.equal(hex.length, 8, `16진수 길이: ${hex}`);
  assert.match(hex, HEX8_RE, hex);
  assert.match(id, SESSION_ID_RE, id);
});

test("C2-3 mintHook·mintMcp 를 각각 정확히 한 번 — (memberId = user 의 id, 돌려준 그 id) 로 부른다", async () => {
  for (const user of [wonjoon, sangmin]) {
    const k = fakeDeps();
    const { id } = preissuedOf(await preissueNodeSession(user, minimalInput(), k.deps));
    assert.equal(k.hookCalls().length, 1, `${user.userId}: mintHook 호출 횟수`);
    assert.equal(k.mcpCalls().length, 1, `${user.userId}: mintMcp 호출 횟수`);
    assert.equal(k.calls.length, 2, `${user.userId}: 총 호출 횟수`);
    assert.deepEqual(k.hookCalls()[0], { which: "hook", memberId: user.userId, boxId: id }, `${user.userId}: mintHook 인자`);
    assert.deepEqual(k.mcpCalls()[0], { which: "mcp", memberId: user.userId, boxId: id }, `${user.userId}: mintMcp 인자`);
    assert.ok(id.startsWith(sessionPrefix(user)), `${user.userId}: 접두어`);
  }
});

test("C2-4 민터가 거부하면 그 토큰만 null — 다른 토큰·id 는 그대로, 전체는 거부되지 않는다", async () => {
  // mintHook 만 실패
  {
    const k = fakeDeps({ hook: "reject" });
    let out: CreateInput | undefined;
    await assert.doesNotReject(async () => { out = await preissueNodeSession(wonjoon, minimalInput(), k.deps); });
    const p = preissuedOf(out!);
    assert.equal(p.hookToken, null, "거부된 hook 토큰이 null 이 아니다");
    assert.equal(p.mcpToken, `mcp:${p.id}`, "멀쩡한 mcp 토큰이 사라졌다");
    assert.match(p.id, SESSION_ID_RE, p.id);
    assert.ok(p.id.startsWith(sessionPrefix(wonjoon)));
    assert.equal(k.hookCalls().length, 1); assert.equal(k.mcpCalls().length, 1);
    assert.equal(k.mcpCalls()[0]!.boxId, p.id, "실패와 무관하게 같은 id 로 구웠어야 한다");
  }
  // mintMcp 만 실패
  {
    const k = fakeDeps({ mcp: "reject" });
    let out: CreateInput | undefined;
    await assert.doesNotReject(async () => { out = await preissueNodeSession(wonjoon, minimalInput(), k.deps); });
    const p = preissuedOf(out!);
    assert.equal(p.mcpToken, null, "거부된 mcp 토큰이 null 이 아니다");
    assert.equal(p.hookToken, `hook:${p.id}`, "멀쩡한 hook 토큰이 사라졌다");
    assert.match(p.id, SESSION_ID_RE, p.id);
    assert.equal(k.hookCalls()[0]!.boxId, p.id);
  }
  // 둘 다 실패 — id 는 그래도 정해진다, 다른 필드도 그대로
  {
    const k = fakeDeps({ hook: "reject", mcp: "reject" });
    const input = minimalInput();
    let out: CreateInput | undefined;
    await assert.doesNotReject(async () => { out = await preissueNodeSession(wonjoon, input, k.deps); });
    const p = preissuedOf(out!);
    assert.equal(p.hookToken, null); assert.equal(p.mcpToken, null);
    assert.match(p.id, SESSION_ID_RE, p.id);
    assert.ok(p.id.startsWith(sessionPrefix(wonjoon)));
    assert.deepEqual(withoutPreissued(out!), JSON.parse(JSON.stringify(input)));
  }
});

test("C2-4b 민터가 동기적으로 던져도(프로미스 밖) 같다 — 그 토큰만 null, 전체는 던지지 않는다", async () => {
  const k = fakeDeps({ hook: "throwSync" });
  let out: CreateInput | undefined;
  await assert.doesNotReject(async () => { out = await preissueNodeSession(wonjoon, minimalInput(), k.deps); });
  const p = preissuedOf(out!);
  assert.equal(p.hookToken, null);
  assert.equal(p.mcpToken, `mcp:${p.id}`, "hook 이 동기 예외를 냈다고 mcp 까지 사라졌다");
  assert.match(p.id, SESSION_ID_RE, p.id);
  assert.equal(k.mcpCalls().length, 1, "hook 이 동기 예외를 냈다고 mcp 민터를 안 불렀다");
});

test("C2-5 민터가 null 을 주면 그 토큰은 null — 다른 토큰·id 는 그대로", async () => {
  {
    const k = fakeDeps({ hook: "null" });
    const p = preissuedOf(await preissueNodeSession(wonjoon, minimalInput(), k.deps));
    assert.equal(p.hookToken, null);
    assert.equal(p.mcpToken, `mcp:${p.id}`);
    assert.match(p.id, SESSION_ID_RE, p.id);
  }
  {
    const k = fakeDeps({ mcp: "null" });
    const p = preissuedOf(await preissueNodeSession(wonjoon, minimalInput(), k.deps));
    assert.equal(p.mcpToken, null);
    assert.equal(p.hookToken, `hook:${p.id}`);
    assert.match(p.id, SESSION_ID_RE, p.id);
  }
  {
    const k = fakeDeps({ hook: "null", mcp: "null" });
    const p = preissuedOf(await preissueNodeSession(wonjoon, minimalInput(), k.deps));
    assert.equal(p.hookToken, null); assert.equal(p.mcpToken, null);
    assert.match(p.id, SESSION_ID_RE, p.id);
    assert.equal(k.calls.length, 2);
  }
});

test("C2-6 두 번 부르면 id 가 다르다 — 같은 사용자·같은 input 이라도 · 연달아 여러 번도 전부 다르다", async () => {
  const k = fakeDeps();
  const input = minimalInput();
  const a = preissuedOf(await preissueNodeSession(wonjoon, input, k.deps));
  const b = preissuedOf(await preissueNodeSession(wonjoon, input, k.deps));
  assert.notEqual(a.id, b.id, `id 가 같다: ${a.id}`);
  assert.equal(a.id.slice(0, sessionPrefix(wonjoon).length), b.id.slice(0, sessionPrefix(wonjoon).length), "접두어는 같아야 한다");
  assert.notEqual(a.hookToken, b.hookToken, "id 가 다르니 굽힌 토큰도 달라야 한다(민터가 id 를 받았다)");
  // 동시에 여러 번 — 겹치지 않는다
  const outs = await Promise.all(Array.from({ length: 20 }, () => preissueNodeSession(wonjoon, input, k.deps)));
  const ids = outs.map((o) => preissuedOf(o).id);
  assert.equal(new Set(ids).size, ids.length, `겹치는 id 가 있다: ${ids.join(", ")}`);
  for (const id of ids) assert.match(id, SESSION_ID_RE, id);
  assert.equal(k.hookCalls().length, 22); assert.equal(k.mcpCalls().length, 22);
});

test("C2-7 돌려준 id 는 같은 사용자의 acceptPreissuedId 가 그대로 받아 주고, 다른 사용자는 거절한다", async () => {
  const k = fakeDeps();
  const { id } = preissuedOf(await preissueNodeSession(wonjoon, minimalInput(), k.deps));
  assert.equal(acceptPreissuedId(wonjoon, id), id, "본인이 만든 id 를 본인이 거절했다");
  assert.equal(acceptPreissuedId(sangmin, id), null, "남이 만든 id 를 받아 줬다");
  // 반대 방향도
  const { id: theirs } = preissuedOf(await preissueNodeSession(sangmin, minimalInput(), fakeDeps().deps));
  assert.equal(acceptPreissuedId(sangmin, theirs), theirs);
  assert.equal(acceptPreissuedId(wonjoon, theirs), null);
  assert.notEqual(id, theirs);
  // 민팅이 실패해도 id 자체는 여전히 본인 것으로 받아진다(C3 의 «받아 주는 경우에 한해» 가 살아 있어야 토큰 없는 세션도 제 id 로 뜬다)
  const { id: idNoTok } = preissuedOf(await preissueNodeSession(wonjoon, minimalInput(), fakeDeps({ hook: "reject", mcp: "null" }).deps));
  assert.equal(acceptPreissuedId(wonjoon, idNoTok), idNoTok);
});

// ═══ 5. withPreissuedIdentity — relay 를 감싸 실패·불일치 때 토큰을 회수한다 ═══════
test("C5-1 relay 를 정확히 한 번, 2 를 거친 input(preissued 실림)으로 부른다 — 민터가 준 id·토큰 그대로, 다른 필드 그대로", async () => {
  const k = fakeDeps();
  const r = fakeRelay({ returns: "same" });
  const input = minimalInput();
  const snapshot = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  await withPreissuedIdentity(wonjoon, input, r.relay, k.deps);
  assert.equal(r.calls.length, 1, "relay 호출 횟수");
  const created = r.calls[0]!;
  const p = preissuedOf(created);
  assert.match(p.id, SESSION_ID_RE, p.id);
  assert.ok(p.id.startsWith(sessionPrefix(wonjoon)), `접두어: ${p.id}`);
  assert.equal(p.hookToken, `hook:${p.id}`);
  assert.equal(p.mcpToken, `mcp:${p.id}`);
  assert.deepEqual(withoutPreissued(created), snapshot, "input 의 다른 필드가 바뀌었다");
  assert.equal(k.hookCalls().length, 1); assert.equal(k.mcpCalls().length, 1);
  assert.equal(k.hookCalls()[0]!.boxId, p.id, "민터에 준 id 와 relay 에 실은 id 가 다르다");
  assert.equal(k.mcpCalls()[0]!.boxId, p.id);
  assert.equal(k.hookCalls()[0]!.memberId, wonjoon.userId);
});

test("C5-2 relay 성공 + 응답 id 가 preissued.id 와 같으면 — 그 세션을 그대로 돌려주고 revoke 는 부르지 않는다", async () => {
  const k = fakeDeps();
  const r = fakeRelay({ returns: "same" });
  const out = await withPreissuedIdentity(wonjoon, minimalInput(), r.relay, k.deps);
  assert.equal(r.returned.length, 1);
  assert.equal(out, r.returned[0], "relay 가 준 세션 객체 그대로가 아니다");
  assert.equal(out.id, preissuedOf(r.calls[0]!).id);
  assert.deepEqual(k.revokeCalls, [], "일치하는데 revoke 를 불렀다");
});

test("C5-3 relay 가 던지면 — revoke(구운 id) 를 정확히 한 번 부른 뒤 같은 오류를 다시 던진다", async () => {
  const k = fakeDeps();
  const boom = new Error("노드가 create 를 거절했다");
  const r = fakeRelay({ throws: boom });
  await assert.rejects(withPreissuedIdentity(wonjoon, minimalInput(), r.relay, k.deps), (e: unknown) => e === boom);
  assert.equal(r.calls.length, 1, "relay 호출 횟수");
  const id = preissuedOf(r.calls[0]!).id;
  assert.deepEqual(k.revokeCalls, [id], "revoke 가 구운 id 로 정확히 한 번 불려야 한다");
  assert.equal(k.hookCalls().length, 1); assert.equal(k.mcpCalls().length, 1);
});

test("C5-4 relay 성공인데 응답 id 가 다르면 — revoke(구운 id, 응답 id 아님) 를 한 번 부르고 응답 세션은 그대로 돌려준다", async () => {
  const k = fakeDeps();
  const r = fakeRelay({ returns: "other" });
  const out = await withPreissuedIdentity(wonjoon, minimalInput(), r.relay, k.deps);
  assert.equal(r.calls.length, 1);
  const minted = preissuedOf(r.calls[0]!).id;
  assert.equal(r.returned.length, 1);
  const nodeSession = r.returned[0]!;
  assert.notEqual(nodeSession.id, minted, "시험 재료 오류 — 응답 id 가 달라야 한다");
  assert.equal(out, nodeSession, "응답 세션 객체 그대로가 아니다");
  assert.equal(out.id, nodeSession.id, "응답 id 를 바꿨다");
  assert.deepEqual(k.revokeCalls, [minted], "구운 id 로 정확히 한 번 회수해야 한다(응답 id 가 아니라)");
});

test("C5-5 revoke 가 거부해도 결과는 바뀌지 않는다 — 불일치면 응답 세션 그대로, relay 가 던지면 같은 오류 그대로", async () => {
  // 불일치 경로
  {
    const k = fakeDeps({ revoke: "reject" });
    const r = fakeRelay({ returns: "other" });
    let out: SessionInfo | undefined;
    await assert.doesNotReject(async () => { out = await withPreissuedIdentity(wonjoon, minimalInput(), r.relay, k.deps); });
    assert.equal(out, r.returned[0], "revoke 실패가 결과를 바꿨다");
    assert.deepEqual(k.revokeCalls, [preissuedOf(r.calls[0]!).id]);
  }
  // relay 가 던지는 경로 — revoke 의 오류가 아니라 relay 의 오류가 나와야 한다
  {
    const k = fakeDeps({ revoke: "reject" });
    const boom = new Error("노드 relay 실패");
    const r = fakeRelay({ throws: boom });
    await assert.rejects(withPreissuedIdentity(wonjoon, minimalInput(), r.relay, k.deps), (e: unknown) => e === boom);
    assert.deepEqual(k.revokeCalls, [preissuedOf(r.calls[0]!).id]);
  }
  // 일치 경로 — 애초에 revoke 를 부르지 않으니 모드와 무관
  {
    const k = fakeDeps({ revoke: "reject" });
    const r = fakeRelay({ returns: "same" });
    const out = await withPreissuedIdentity(wonjoon, minimalInput(), r.relay, k.deps);
    assert.equal(out, r.returned[0]);
    assert.deepEqual(k.revokeCalls, []);
  }
});

test("C5-5b revoke 가 동기적으로 던져도(프로미스 밖) 같다 — 비치명", async () => {
  {
    const k = fakeDeps({ revoke: "throwSync" });
    const r = fakeRelay({ returns: "other" });
    let out: SessionInfo | undefined;
    await assert.doesNotReject(async () => { out = await withPreissuedIdentity(wonjoon, minimalInput(), r.relay, k.deps); });
    assert.equal(out, r.returned[0]);
    assert.equal(k.revokeCalls.length, 1);
  }
  {
    const k = fakeDeps({ revoke: "throwSync" });
    const boom = new Error("노드 relay 실패");
    const r = fakeRelay({ throws: boom });
    await assert.rejects(withPreissuedIdentity(wonjoon, minimalInput(), r.relay, k.deps), (e: unknown) => e === boom);
    assert.equal(k.revokeCalls.length, 1);
  }
});

test("C5-6 민팅이 실패해도(null·거부) relay 는 그 id 로 한 번 불린다 — 토큰만 null · 일치하면 revoke 없음 · 던지면 revoke 는 그래도 한 번", async () => {
  {
    const k = fakeDeps({ hook: "reject", mcp: "null" });
    const r = fakeRelay({ returns: "same" });
    const out = await withPreissuedIdentity(wonjoon, minimalInput(), r.relay, k.deps);
    assert.equal(r.calls.length, 1);
    const p = preissuedOf(r.calls[0]!);
    assert.match(p.id, SESSION_ID_RE, p.id);
    assert.equal(p.hookToken, null); assert.equal(p.mcpToken, null);
    assert.equal(out, r.returned[0]);
    assert.deepEqual(k.revokeCalls, []);
  }
  {
    const k = fakeDeps({ hook: "reject", mcp: "reject" });
    const boom = new Error("relay 실패");
    const r = fakeRelay({ throws: boom });
    await assert.rejects(withPreissuedIdentity(wonjoon, minimalInput(), r.relay, k.deps), (e: unknown) => e === boom);
    assert.deepEqual(k.revokeCalls, [preissuedOf(r.calls[0]!).id]);
  }
});

test("C5-7 두 번 감싸면 relay 에 실리는 id 가 다르다 — 각각 제 id 로 회수·판정된다", async () => {
  const k = fakeDeps();
  const r = fakeRelay({ returns: "other" });
  await withPreissuedIdentity(wonjoon, minimalInput(), r.relay, k.deps);
  await withPreissuedIdentity(wonjoon, minimalInput(), r.relay, k.deps);
  assert.equal(r.calls.length, 2);
  const a = preissuedOf(r.calls[0]!).id, b = preissuedOf(r.calls[1]!).id;
  assert.notEqual(a, b);
  assert.deepEqual(k.revokeCalls, [a, b], "각 호출이 제 id 로 회수해야 한다");
});
