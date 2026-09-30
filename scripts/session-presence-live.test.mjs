// #3870 — 세션 머리줄의 얼굴 줄(누가 지금 보고 있나)이 **실시간**으로 따라오는가 (원준 2026-09-30:
//  «초대받은 사람의 아바타 아이콘도 실시간으로 세션 위에 뱃지처럼 보이는 거 잘 안 되는 것 같다»).
//
// 종전: 얼굴 줄은 각자 15초마다 찍는 열람 도장(/seen)의 **응답**으로만 바뀌었다 — 남이 들어온 걸 ≤16초,
//  나간 걸 ≤60초(TTL 45초 + 다음 도장) 뒤에야 봤다. 고친 뒤: 서버가 줄이 바뀐 순간 그 세션을 보는 사람들에게
//  실시간 스트림(notify/stream)으로 `presence` 사건을 민다(src/terminal/session-presence.ts pushViewers).
//
// 이 파일은 화면 쪽 두 가지를 **실행으로** 잰다(컴파일된 public/app 모듈 + 가짜 fetch/document):
//  ① 스트림의 presence 사건 → 그 세션의 얼굴 줄이 바뀐다(presence.viewersOf) · 사이드바 다시 읽기(onChange)는 안 부른다
//  ② 다른 사건(session)은 종전대로 다시 읽기를 부른다 — presence 분기가 기존 길을 삼키지 않는다
// 그리고 떠남 배선(main.ts)은 실제 호출 줄만 인정해 본다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const ok = (cond, name, detail) => { assert.ok(cond, detail ? `${name}\n${detail}` : name); pass++; console.log(`ok  ${name}`); };
const eq = (got, want, name) => { assert.deepEqual(got, want, `${name}: ${JSON.stringify(want)} 여야 하는데 ${JSON.stringify(got)}`); pass++; console.log(`ok  ${name}`); };

// ── 가짜 브라우저 ──────────────────────────────────────────────────────────
const store = new Map([["lively_token", "t"], ["lv:token", "t"]]);
globalThis.localStorage = { getItem: (k) => store.get(k) ?? "t", setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const docListeners = {};
globalThis.document = { hidden: false, addEventListener: (t, fn) => { (docListeners[t] ||= []).push(fn); } };
globalThis.window = globalThis;
globalThis.location = { origin: "http://x", pathname: "/ui/", search: "", hash: "" };

// 스트림으로 보낼 프레임 — 테스트가 밀어 넣는다.
let push = null;
globalThis.fetch = async () => {
  const body = new ReadableStream({ start(c) { push = (text) => c.enqueue(new TextEncoder().encode(text)); } });
  return { ok: true, status: 200, body };
};
const frame = (ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
const tick = () => new Promise((r) => setTimeout(r, 10));

const live = await import(pathToFileURL(join(root, "public/app/v2/live-sync.js")).href);
const presence = await import(pathToFileURL(join(root, "public/app/v2/presence.js")).href);

let changes = 0;
const painted = [];
presence.onViewers((sid) => painted.push(sid));
live.startLiveSync(() => { changes++; });
for (let i = 0; i < 20 && !push; i++) await tick();
ok(!!push, "스트림이 붙었다(가짜 fetch)");

// ① presence 사건 → 얼굴 줄이 바뀐다, 다시 읽기는 없다
push(frame({ type: "presence", session: "box-a", viewers: [{ id: "yoon", name: "윤상민" }, { id: "jang", name: "장원준" }], key: "p:box-a:1", ts: 1 }));
await tick();
eq(presence.viewersOf("box-a").map((v) => v.id), ["yoon", "jang"],
  "①★스트림의 presence 사건이 그 세션의 얼굴 줄을 바꾼다 — 다음 도장(≤16초)을 기다리지 않는다");
eq(painted, ["box-a"], "①얼굴 줄 구독자(세션 머리줄)가 그 세션으로 불린다");
eq(changes, 0, "①presence 는 사이드바를 다시 읽지 않는다 — 누가 볼 때마다 목록 전체를 다시 읽을 까닭이 없다");

// 떠남 — 줄이 줄어든다
push(frame({ type: "presence", session: "box-a", viewers: [{ id: "yoon", name: "윤상민" }], key: "p:box-a:2", ts: 2 }));
await tick();
eq(presence.viewersOf("box-a").map((v) => v.id), ["yoon"], "①떠난 사람의 얼굴이 곧바로 걷힌다");

// ② session 사건은 종전대로 다시 읽기
push(frame({ type: "session", id: "box-a", name: "x", prev: "run", phase: "idle", key: "s:1", ts: 3 }));
await tick();
eq(changes, 1, "②세션 사건은 종전대로 사이드바를 다시 읽는다 — presence 분기가 기존 길을 삼키지 않았다");

// ── 떠남 배선(main.ts) ─────────────────────────────────────────────────────
//  ⚠ 주석이 아닌 실제 줄만 본다(주석 속 이름으로 통과하는 가드를 #1842 에서 잡았다).
const MAIN = readFileSync(join(root, "web/v2/main.ts"), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
ok(/sessions\/\$\{encodeURIComponent\(sid\)\}\/leave`/.test(MAIN), "셸이 떠남(/leave)을 보낸다",
  "  → 없으면 다른 화면으로 옮겨도 남의 화면에서 내 얼굴이 TTL(45초) 동안 남는다.");
ok(/if \(viewingSid && viewingSid !== sid\) leaveViewed\(viewingSid\)/.test(MAIN), "보던 세션과 다른 화면이 되면 떠난다");
ok(/addEventListener\('pagehide'[^\n]*leaveViewed\(viewingSid, true\)/.test(MAIN), "창을 닫으면 keepalive 로 떠남을 끝까지 보낸다");
ok(/addEventListener\('hashchange', \(\) => \{ setTimeout\(markViewedSessionSeen, 0\)/.test(MAIN), "화면을 옮기는 순간 도장·떠남을 맞춘다(8초 틱을 기다리지 않는다)");
const fnBody = MAIN.slice(MAIN.indexOf("function markViewedSessionSeen"), MAIN.indexOf("function markViewedSessionSeen") + 400);
ok(/if \(document\.hidden\) return;/.test(fnBody.split("viewedSessionId()")[0]), "★창이 숨은 것은 떠남이 아니다 — 숨었을 땐 떠남을 보내지 않는다",
  "  → 다른 앱을 잠깐 볼 때마다 얼굴이 사라졌다 나타나면 «나갔다» 로 읽힌다(session-presence 머리말: 늦게 사라지는 쪽으로 실패).");

console.log(`\n${pass} passed`);
process.exit(0);
