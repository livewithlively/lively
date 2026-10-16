// 대화 파일 파사드(transcript-fs.ts) — 멤버 중계 구현을 **가짜 중계**로 실측한다 (#1437 ②).
//  가짜 중계 = `<node> fake-relay.mjs <osUser> -- <argv...>`: 호출 argv 를 로그에 남기고 argv 를 그대로 실행한다(stdio 이음).
//  그래서 여기서 검증되는 것: 구간 읽기(tail|head)·stat·압축 전 탐색(node 한 줄)이 **중계 계약(argv 실행·stdio 이음·종료코드)**
//  위에서 로컬 직독과 같은 답을 내는가 + 실제로 중계가 불렸는가(배선). 실 브로커·컨테이너는 E2E(lvly-cloud run.sh)가 본다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installTenantSlugResolver } from "../catalog.js";
import { memberReadRange } from "../terminal-member-fs.js";
import { RELAY_UNAVAILABLE, localTranscriptFs, memberTranscriptFs, transcriptFsFor } from "./transcript-fs.js";
import { HttpError } from "../../http-error.js";
import { readAlignedWindow } from "./window.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tfs-"));
const relayLog = path.join(tmp, "relay.log");
const relay = path.join(tmp, "fake-relay.mjs");
fs.writeFileSync(relay, [
  "import { spawn } from 'node:child_process'; import fs from 'node:fs';",
  "const [osUser, dash, ...argv] = process.argv.slice(2);",
  `fs.appendFileSync(${JSON.stringify(relayLog)}, JSON.stringify({ osUser, dash, argv }) + '\\n');`,
  "if (dash !== '--') { process.stderr.write('bad relay argv'); process.exit(97); }",
  "const c = spawn(argv[0], argv.slice(1), { stdio: 'inherit' });",
  "c.on('exit', (code) => process.exit(code ?? 1));",
].join("\n"));
const relayCalls = (): Array<{ osUser: string; dash: string; argv: string[] }> =>
  fs.existsSync(relayLog) ? fs.readFileSync(relayLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

// 중계 설정 — 값은 호출 시점에 읽힌다(member-exec-seam.test 와 같은 전제).
process.env.LIVELY_MEMBER_EXEC = `${process.execPath} ${relay}`;
installTenantSlugResolver(() => "acme");
const OS = "box_yoon";
const hello = path.join(tmp, "hello.txt"); fs.writeFileSync(hello, "hello world\n");   // 12B

await t("[R1] memberReadRange — 요청 구간을 정확히(오프셋 0 포함) · 파일 끝 넘으면 짧게", async () => {
  assert.equal((await memberReadRange(OS, hello, 0, 5)).toString(), "hello");
  assert.equal((await memberReadRange(OS, hello, 5, 12)).toString(), " world\n");
  assert.equal((await memberReadRange(OS, hello, 10, 100)).toString(), "d\n");
});
await t("[R2] 경계 — 빈 구간·파일 끝·그 너머는 빈 버퍼, 빈 구간은 exec 0회", async () => {
  const before = relayCalls().length;
  assert.equal((await memberReadRange(OS, hello, 3, 3)).length, 0);
  assert.equal(relayCalls().length, before, "빈 구간은 중계를 부르지 않는다");
  assert.equal((await memberReadRange(OS, hello, 12, 12)).length, 0);
  assert.equal((await memberReadRange(OS, hello, 20, 30)).length, 0);
});
await t("[F1] memberTranscriptFs.stat — 파일=크기 · 디렉터리=null · 없음=null", async () => {
  const m = memberTranscriptFs(OS);
  assert.equal(await m.stat(hello), 12);
  assert.equal(await m.stat(tmp), null);
  assert.equal(await m.stat(path.join(tmp, "nope.jsonl")), null);
});
await t("[F2] memberTranscriptFs.read 의 창(from/to/bytes) == 로컬 파사드의 창 — 같은 파일·여러 창", async () => {
  const L = (n: number): string => JSON.stringify({ n, x: "z".repeat(n * 7) }) + "\n";
  const text = L(1) + L(2) + L(3) + L(4) + '{"n":5';
  const f = path.join(tmp, "conv.jsonl"); fs.writeFileSync(f, text);
  const size = Buffer.byteLength(text);
  const m = memberTranscriptFs(OS);
  for (const [s, e, ext] of [[0, size, false], [3, size, false], [10, 40, true], [size - 4, size, false], [0, 9, true]] as Array<[number, number, boolean]>) {
    const want = await localTranscriptFs.read(f, size, (r) => readAlignedWindow(r, size, s, e, ext));
    const got = await m.read(f, size, (r) => readAlignedWindow(r, size, s, e, ext));
    assert.deepEqual([got.from, got.to, got.data.toString()], [want.from, want.to, want.data.toString()], `창 [${s},${e}) ext=${ext}`);
  }
});
await t("[F3] prevTranscript — 압축 파일의 형제에서 부모 uuid 를 찾는다 · 일반 파일은 null · 2회째는 캐시(중계 0회)", async () => {
  const dir = path.join(tmp, "proj"); fs.mkdirSync(dir);
  const parent = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
  fs.writeFileSync(path.join(dir, `${parent}.jsonl`), JSON.stringify({ type: "user", uuid: parent, message: { role: "user", content: "hi" } }) + "\n");
  const cur = path.join(dir, "cur.jsonl");
  fs.writeFileSync(cur, JSON.stringify({ type: "system", subtype: "compact_boundary", logicalParentUuid: parent }) + "\n" + JSON.stringify({ type: "user", uuid: "x" }) + "\n");
  const plain = path.join(dir, "plain.jsonl"); fs.writeFileSync(plain, JSON.stringify({ type: "user", uuid: "y" }) + "\n");
  const m = memberTranscriptFs(OS);
  assert.equal(await m.prevTranscript(cur), parent);
  assert.equal(await m.prevTranscript(plain), null);
  assert.equal(await localTranscriptFs.prevTranscript(cur), parent, "로컬 구현과 같은 답");
  const before = relayCalls().length;
  assert.equal(await m.prevTranscript(cur), parent);
  assert.equal(relayCalls().length, before, "캐시 — 같은 파일은 다시 중계하지 않는다");
});
await t("[F4] listDir — 멤버 구현이 로컬과 같은 이름·순서무관 집합을 준다(#2154 에코의 폴백 훑기) · 폴더 없음/파일은 []", async () => {
  const dir = path.join(tmp, "grown"); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "a.jsonl"), "a\n");
  fs.writeFileSync(path.join(dir, "b.jsonl"), "bb\n");
  fs.mkdirSync(path.join(dir, "sub"));
  const m = memberTranscriptFs(OS);
  const names = (rows: Array<{ name: string }>): string[] => rows.map((r) => r.name).sort();
  assert.deepEqual(names(await m.listDir(dir)), ["a.jsonl", "b.jsonl"], "하위 폴더는 빠진다(파일만)");
  assert.deepEqual(names(await localTranscriptFs.listDir(dir)), ["a.jsonl", "b.jsonl"], "로컬 구현과 같은 답");
  // mtime 이 실제 값이어야 '보낸 뒤 자란 파일' 판정이 선다 — 0 이면 그 필터가 전부 통과해 버린다.
  const rows = await m.listDir(dir);
  const wantM = fs.statSync(path.join(dir, "a.jsonl")).mtimeMs;
  assert.ok(Math.abs(rows.find((r) => r.name === "a.jsonl")!.mtimeMs - wantM) <= 1000, "mtime 이 실측값");
  assert.deepEqual(await m.listDir(path.join(tmp, "no-such-dir")), [], "없는 폴더는 빈 배열(던지지 않는다)");
  assert.deepEqual(await localTranscriptFs.listDir(hello), [], "파일을 폴더로 물어도 빈 배열");
});
await t("[S1] transcriptFsFor — 중계 X 면 osUser 가 있어도 로컬 · 중계 O + osUser null 은 로컬 · 둘 다 있을 때만 멤버", () => {
  const saved = process.env.LIVELY_MEMBER_EXEC;
  delete process.env.LIVELY_MEMBER_EXEC;
  assert.equal(transcriptFsFor(OS), localTranscriptFs);
  process.env.LIVELY_MEMBER_EXEC = saved;
  assert.equal(transcriptFsFor(null), localTranscriptFs);
  assert.equal(transcriptFsFor(""), localTranscriptFs);
  assert.notEqual(transcriptFsFor(OS), localTranscriptFs);
});
await t("[W1] 배선 — 가짜 중계가 실제로 불렸다: <osUser> -- <argv> 꼴, argv 머리는 sh 또는 node", () => {
  const calls = relayCalls();
  assert.ok(calls.length >= 6, `중계 호출 ${calls.length}회`);
  for (const c of calls) {
    assert.equal(c.osUser, OS); assert.equal(c.dash, "--");
    assert.ok(["sh", "node"].includes(c.argv[0]), `argv[0]=${c.argv[0]}`);
  }
  // 구간 읽기는 값이 전부 argv 로 간다(스크립트에 경로·숫자를 끼워 넣지 않는다 — 인젝션 표면 0).
  const range = calls.find((c) => c.argv[0] === "sh" && c.argv.includes("lively-range"))!;
  assert.ok(range, "구간 읽기 호출이 있다");
  assert.equal(range.argv[range.argv.length - 1], hello);
  assert.ok(!range.argv[2].includes(hello), "경로가 스크립트 본문에 섞이지 않았다");
});

// ── 중계 실패는 «없음»이 아니다 (#2257 후속) ─────────────────────────────────
//  2026-08-30 나이틀리 e2e 는 `transcript HTTP 500: {"error":"internal_error"}` 로 죽었고, 08-28 은 **같은 자리**에서
//  `증분 폴링(from=워터마크) got '404'` 로 죽었다. 원인은 하나 — 허브 홉이 중계 상한(member-exec-relay `timeout: 20_000`)을
//  넘긴 것. 그런데 stat 은 그 실패를 삼켜 null(=없음 → 404), read 는 안 잡아 raw throw(=500) 로 흘려 **한 원인이 두 얼굴**이었다.
//  둘 다 «중계가 잠깐 안 됐다»는 말을 못 했다.
const badRelay = path.join(tmp, "bad-relay.mjs");
fs.writeFileSync(badRelay, "process.stderr.write('허브 응답 없음'); process.exit(1);\n");
const withBadRelay = async (fn: () => Promise<void>): Promise<void> => {
  const saved = process.env.LIVELY_MEMBER_EXEC;
  process.env.LIVELY_MEMBER_EXEC = `${process.execPath} ${badRelay}`;
  try { await fn(); } finally { process.env.LIVELY_MEMBER_EXEC = saved; }
};

await t("[E1] ★ 중계가 죽으면 stat 은 null 이 아니라 503 을 던진다 — «파일 없음»으로 둔갑하면 화면이 «기록 없음» 이라 거짓말한다", async () => {
  await withBadRelay(async () => {
    const e: unknown = await memberTranscriptFs(OS).stat(hello).then(() => null, (x: unknown) => x);
    assert.ok(e instanceof HttpError, `던진 것이 HttpError 가 아니다: ${String(e)}`);
    assert.equal(e.status, 503, "중계 실패는 404(없음)도 500(내부오류)도 아니다");
    assert.equal(e.message, RELAY_UNAVAILABLE);
    assert.ok((e as { cause?: unknown }).cause, "원인을 함께 실어야 wrap 이 로그에 남긴다(#1278)");
  });
});

await t("[E2] ★ 중계가 죽으면 read 도 **같은** 503 — 종전엔 catch 가 없어 internal_error(500) 로 나갔다", async () => {
  await withBadRelay(async () => {
    const e: unknown = await memberTranscriptFs(OS).read(hello, 12, (r) => r.read(0, 12)).then(() => null, (x: unknown) => x);
    assert.ok(e instanceof HttpError, `던진 것이 HttpError 가 아니다: ${String(e)}`);
    assert.equal(e.status, 503, "stat 과 read 가 같은 원인에 다른 답을 내면 안 된다");
    assert.equal(e.message, RELAY_UNAVAILABLE);
  });
});

await t("[E3] 정상 중계에서 **없는 파일**은 여전히 null — 이 구별이 이 변경의 전부다(없음 ≠ 못 읽음)", async () => {
  const m = memberTranscriptFs(OS);
  assert.equal(await m.stat(path.join(tmp, "no-such-file.jsonl")), null, "없는 파일은 던지지 않는다(진짜 404 다)");
  assert.equal(await m.stat(tmp), null, "폴더도 null(파일 아님)");
  assert.equal(await m.stat(hello), 12, "있는 파일은 크기 그대로");
});

// ── #4821 ① turnOpenerOrigin — 끝 창보다 긴 «이어 간 턴» 의 첫 줄(출처)을 거슬러 찾는다. 로컬 구현과 중계 구현(노드 쪽 node 한 줄)이 **같은 답**을
//  내야 한다(prevTranscript 와 같은 이유 — 둘이 갈리면 관리형에서만 대기를 놓친다). 사양 F5a~F5j: 작업 스크래치 spec-4821.md.
//   🔴 덩어리(1MB) 경계에 걸친 첫 줄을 못 이으면 — 그 자리에 떨어진 턴만 조용히 못 찾는다.
//   🔴 중계를 덩어리마다 부르면 — 128MB 를 거슬러 읽는 데 왕복 128번이다(한 번에 끝내야 한다).
//   🔴 중계 실패를 «못 찾음» 으로 뭉개면 — 읽는 쪽이 못 찾음을 기억해 그 턴의 다시 걸림을 영영 못 본다.
const PA = "a2f54353-020b-43b9-a5af-8fa53646c25e", PH = "e612e7e8-a25c-4a6c-ae5c-d12909d4e0cc", PT = "0d9c8b7a-6f5e-4d3c-9b2a-1f0e9d8c7b6a";
const PX = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a", PB = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const jl = (o: object): string => JSON.stringify(o) + "\n";
const opener = (pid: string, kind: string, pad = 0): string => jl({ type: "user", isMeta: kind !== "human", origin: { kind }, turnOrigin: kind.replace(/-/g, "_"),
  promptId: pid, message: { role: "user", content: "start" + "s".repeat(pad) } });
const toolLine = (pid: string, pad = 0): string => jl({ type: "user", promptId: pid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x".repeat(pad) }] } });
const asstLine = (pad = 0): string => jl({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "y".repeat(pad) }] } });
const both = async (file: string, pid: string, before: number, max: number): Promise<string | null> => {
  const want = await localTranscriptFs.turnOpenerOrigin(file, pid, before, max);
  assert.equal(await memberTranscriptFs(OS).turnOpenerOrigin(file, pid, before, max), want, `로컬과 중계가 갈렸다 — ${pid}@${before}/${max}`);
  return want;
};
const MB = 1024 * 1024;
const turns = path.join(tmp, "turns.jsonl");
let turnsBody = opener(PH, "human") + toolLine(PH) + toolLine(PH) + asstLine();
const PA_START = Buffer.byteLength(turnsBody);
turnsBody += opener(PA, "auto-continuation");
for (let i = 0; i < 1300; i++) turnsBody += toolLine(PA, 900) + asstLine(60);   // 이어 간 턴 ≈ 1.4MB — 덩어리 여럿을 건넌다
turnsBody += jl({ type: "user", turnOrigin: "auto_continuation", promptId: PT, message: { role: "user", content: "x" } }) + toolLine(PT);   // origin 없이 turnOrigin 만
turnsBody += `{"type":"user","promptId":"${PA}", 깨진 줄\n`;   // 찾는 문자열이 든 깨진 줄 — 건너뛴다
const BEFORE = Buffer.byteLength(turnsBody);
fs.writeFileSync(turns, turnsBody + toolLine(PA) + opener(PX, "auto-continuation") + toolLine(PX));   // before 뒤의 줄은 보지 않는다
const F5 = { before: BEFORE, paStart: PA_START };

await t("[F5a] 첫 줄(origin auto-continuation)을 같은 턴의 줄 1.4MB 너머까지 거슬러 찾는다 — 로컬 = 중계", async () => {
  assert.equal(await both(turns, PA, F5.before, 128 * MB), "auto-continuation");
});
await t("[F5b] 첫 줄 출처가 사람이면 «human»", async () => {
  assert.equal(await both(turns, PH, F5.before, 128 * MB), "human");
});
await t("[F5c] origin 없이 turnOrigin 만 있는 첫 줄 — «_» 를 «-» 로 맞춘다", async () => {
  assert.equal(await both(turns, PT, F5.before, 128 * MB), "auto-continuation");
});
await t("[F5d] 첫 줄이 before 뒤에만 있으면 못 찾음 · before 가 첫 줄 시작이면 그 줄은 안 본다", async () => {
  assert.equal(await both(turns, PX, F5.before, 128 * MB), null);
  assert.equal(await both(turns, PA, F5.paStart, 128 * MB), null);
  assert.equal(await both(turns, PA, F5.paStart + 1, 128 * MB), null, "첫 줄 중간에서 시작하면 그 반 줄도 안 본다");
});
await t("[F5e] 상한(maxBytes) 밖의 첫 줄은 못 찾음 — 상한에서 잘린 반 줄도 안 본다", async () => {
  assert.equal(await both(turns, PA, F5.before, 1 * MB), null);
  //  반 줄의 꼬리가 그 자체로 온전한 JSON 이어도 안 본다(격리 리뷰 — 잘린 반 줄이 우연히 JSON 이면 «온전한 줄» 검사 없이는 답이 된다)
  const half = path.join(tmp, "halfline.jsonl");
  const tailOpener = opener(PB, "auto-continuation");
  fs.writeFileSync(half, asstLine(5) + "ABC" + tailOpener + toolLine(PB) + toolLine(PB));
  const hb = fs.statSync(half).size;
  const tailStart = Buffer.byteLength(asstLine(5)) + 3;
  assert.equal(await both(half, PB, hb, hb - tailStart), null, "꼬리 JSON 에서 멈추면 못 찾음(앞 바이트가 개행이 아니다)");
  assert.equal(await both(half, PB, hb, hb - tailStart + 3), null, "줄 시작까지 닿아도 그 줄은 ABC{… 라 깨진 줄");
  assert.equal(await both(turns, PA, F5.before, F5.before - F5.paStart - 10), null, "첫 줄 끝 10바이트 앞에서 멈추면(반 줄) 못 찾음");
  assert.equal(await both(turns, PA, F5.before, F5.before - F5.paStart), "auto-continuation", "첫 줄 시작까지 닿으면 찾는다(경계값)");
});
await t("[F5f] 없는 promptId 는 못 찾음 — 찾는 문자열이 든 깨진 줄에서 죽지 않는다", async () => {
  assert.equal(await both(turns, "ffffffff-0000-4000-8000-000000000000", F5.before, 128 * MB), null);
});
await t("[F5g] 첫 줄이 1MB 덩어리 경계에 걸쳐도 이어 붙여 찾는다 — 파일 맨 앞 · 중간 둘 다", async () => {
  const fill = (n: number): string => { let out = ""; const base = Buffer.byteLength(toolLine(PB)); for (let i = 0; i < n; i++) out += toolLine(PB, 1000 - base); return out; };
  assert.equal(Buffer.byteLength(fill(1)), 1000, "채움 줄은 정확히 1000바이트(전제)");
  for (const prefix of ["", asstLine(40) + toolLine(PH) + asstLine(10)]) {
    const op = opener(PB, "auto-continuation", 700);
    const f = path.join(tmp, `boundary-${prefix ? "mid" : "head"}.jsonl`);
    fs.writeFileSync(f, prefix + op + fill(1048));
    const before = fs.statSync(f).size;
    const cut = before - MB;   // 첫 덩어리의 시작 — 첫 줄 안이어야 한다
    const opStart = Buffer.byteLength(prefix);
    assert.ok(cut > opStart && cut < opStart + Buffer.byteLength(op) - 1, `덩어리 경계(${cut})가 첫 줄(${opStart}~) 안이다(전제)`);
    assert.equal(await both(f, PB, before, 128 * MB), "auto-continuation", prefix ? "중간" : "맨 앞");
  }
});
await t("[F5h] 중계 구현은 한 번 찾는 데 중계를 **한 번**만 부른다(덩어리마다 왕복하지 않는다)", async () => {
  const before = relayCalls().length;
  assert.equal(await memberTranscriptFs(OS).turnOpenerOrigin(turns, PA, F5.before, 128 * MB), "auto-continuation");
  assert.equal(relayCalls().length - before, 1);
});
await t("[F5i] before 0 · 빈 파일 · 없는 파일은 못 찾음(던지지 않는다) · 이상한 promptId 는 중계 없이 못 찾음", async () => {
  const empty = path.join(tmp, "empty.jsonl"); fs.writeFileSync(empty, "");
  assert.equal(await both(turns, PA, 0, 128 * MB), null);
  assert.equal(await both(empty, PA, 0, 128 * MB), null);
  assert.equal(await both(path.join(tmp, "no-such.jsonl"), PA, 100, 128 * MB), null);
  const before = relayCalls().length;
  assert.equal(await both(turns, `${PA}","x":"`, F5.before, 128 * MB), null);
  assert.equal(relayCalls().length, before, "찾는 문자열을 만드는 값이 이상하면 중계를 부르지 않는다");
});
await t("[F5k] 사이드체인 줄은 첫 줄이 아니다 — 같은 promptId · 출처를 달고 있어도 건너뛴다(로컬·중계 둘 다)", async () => {
  const f = path.join(tmp, "sidechain.jsonl");
  const side = jl({ type: "user", isSidechain: true, origin: { kind: "auto-continuation" }, promptId: PB, message: { role: "user", content: "sub" } });
  fs.writeFileSync(f, opener(PB, "human") + toolLine(PB) + side + toolLine(PB));
  assert.equal(await both(f, PB, fs.statSync(f).size, 128 * MB), "human");
});
await t("[F5l] 맥락 압축 요약 줄(promptId·turnOrigin 만)이 턴 중간에 껴 있어도 그 턴의 출처를 준다 — 요약 줄의 turnOrigin 은 그 턴의 출처와 같다", async () => {
  const f = path.join(tmp, "compact.jsonl");
  const summary = jl({ type: "user", isCompactSummary: true, promptId: PB, turnOrigin: "auto_continuation", message: { role: "user", content: "요약…" } });
  fs.writeFileSync(f, opener(PB, "auto-continuation") + toolLine(PB, 2000) + summary + toolLine(PB, 2000));
  assert.equal(await both(f, PB, fs.statSync(f).size, 128 * MB), "auto-continuation");
});
await t("[F5m] ★ 중계가 실패를 삼켜 종료코드 0 · 빈 출력이면 던진다 — «못 찾음(null)» 으로 풀면 읽는 쪽이 그걸 영구히 기억한다(격리 리뷰)", async () => {
  const silent = path.join(tmp, "silent-relay.mjs");
  fs.writeFileSync(silent, "process.exit(0);\n");
  const saved = process.env.LIVELY_MEMBER_EXEC;
  process.env.LIVELY_MEMBER_EXEC = `${process.execPath} ${silent}`;
  try {
    const e: unknown = await memberTranscriptFs(OS).turnOpenerOrigin(turns, PA, F5.before, 128 * MB).then(() => null, (x: unknown) => x);
    assert.ok(e instanceof HttpError, `던진 것이 HttpError 가 아니다: ${String(e)}`);
    assert.equal(e.status, 503);
  } finally { process.env.LIVELY_MEMBER_EXEC = saved; }
});
await t("[F5n] 출처 모양이 아니면(거대한 값 · 공백) 첫 줄로 안 친다 — 멤버가 꾸민 값이 게이트웨이 기억에 오르지 않게(로컬·중계 둘 다)", async () => {
  const f = path.join(tmp, "bigkind.jsonl");
  const big = jl({ type: "user", origin: { kind: "x".repeat(100_000) }, promptId: PB, message: { role: "user", content: "x" } });
  const spaced = jl({ type: "user", origin: { kind: "auto continuation" }, promptId: PX, message: { role: "user", content: "x" } });
  fs.writeFileSync(f, big + toolLine(PB) + spaced + toolLine(PX));
  const size = fs.statSync(f).size;
  assert.equal(await both(f, PB, size, 128 * MB), null);
  assert.equal(await both(f, PX, size, 128 * MB), null);
});
await t("[F5j] ★ 중계가 죽으면 turnOpenerOrigin 도 503 을 던진다 — «못 찾음(null)» 으로 둔갑하면 읽는 쪽이 그걸 기억해 영영 다시 안 찾는다", async () => {
  await withBadRelay(async () => {
    const e: unknown = await memberTranscriptFs(OS).turnOpenerOrigin(turns, PA, F5.before, 128 * MB).then(() => null, (x: unknown) => x);
    assert.ok(e instanceof HttpError, `던진 것이 HttpError 가 아니다: ${String(e)}`);
    assert.equal(e.status, 503);
  });
});

installTenantSlugResolver(() => null);
delete process.env.LIVELY_MEMBER_EXEC;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`harness-io/transcript-fs: ${pass} passed`);
