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
import { localTranscriptFs, memberTranscriptFs, transcriptFsFor } from "./transcript-fs.js";
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

installTenantSlugResolver(() => null);
delete process.env.LIVELY_MEMBER_EXEC;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`harness-io/transcript-fs: ${pass} passed`);
