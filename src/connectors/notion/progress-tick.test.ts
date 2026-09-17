// 노션 백필 진행 티커 판정(#4059 후속 사고) — 무엇이든 움직였으면 한 줄, 아무것도 안 움직였으면 침묵.
//  실행: npm run build && node dist/connectors/notion/progress-tick.test.js
//
//  왜: 추적기는 15분 무출력이면 run 을 정체로 끊는다. 종전 티커는 요청 수만 움직임으로 쳐서,
//   요청 없이 큰 첨부만 받는 구간이 조용해졌다(멀쩡히 받는 run 이 끊길 수 있다).
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { downloadAsset } from "./assets.js";
import { progressTick } from "./state.js";
import type { ProgressSnapshot, Traversal } from "./state.js";
import { startProgressTicker } from "./ticker.js";

const snap = (over: Partial<ProgressSnapshot> = {}): ProgressSnapshot => ({
  requests: 100, pages: 50, dbs: 3, assets: 10, assetJobs: 40, assetFailures: 0, bytes: 5 * 1048576, ...over,
});

const first = progressTick(null, snap());
assert.ok(first.line, "E12 첫 호출은 한 줄을 찍어야 한다");
assert.match(first.line!, /요청 100/);
assert.match(first.line!, /첨부 10\/40/);
assert.match(first.line!, /5\.0MB/, "E12 받은 용량(MB)이 보여야 한다");
console.log("ok  E12 첫 호출 → 한 줄(요청·첨부·MB)");

const same = progressTick(first.sig, snap());
assert.equal(same.line, null, "E9 아무것도 안 움직였는데 찍었다 — 진짜 행을 살아 있는 척 가린다");
assert.equal(same.sig, first.sig);
console.log("ok  E9 모두 같음 → 침묵");

const onlyBytes = progressTick(first.sig, snap({ bytes: 6 * 1048576 }));
assert.ok(onlyBytes.line, "E10 받은 바이트만 늘었는데 침묵했다 — 큰 첨부를 받는 run 이 정체로 끊긴다");
assert.match(onlyBytes.line!, /6\.0MB/);
console.log("ok  E10 받은 바이트만 바뀜 → 한 줄");

const onlyReq = progressTick(first.sig, snap({ requests: 101 }));
assert.ok(onlyReq.line, "E11 요청 수가 늘었는데 침묵했다");
console.log("ok  E11 요청 수만 바뀜 → 한 줄");

const onlyAsset = progressTick(first.sig, snap({ assets: 11 }));
const onlyFail = progressTick(first.sig, snap({ assetFailures: 1 }));
assert.ok(onlyAsset.line && onlyFail.line, "첨부 완료·실패 수만 바뀌어도 움직임이다");
console.log("ok  첨부 완료·실패 수만 바뀜 → 한 줄");

// ── 배선: 백필이 켜는 티커가 «받은 바이트» 를 실제로 읽는가 — 노션 요청 없이 파일만 받아도 한 줄이 더 찍혀야 한다.
const server = http.createServer((_req, res) => { res.writeHead(200); res.end("hello"); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/a.bin`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notion-ticker-test-"));
const t = {
  cfg: { token: "x", version: "2025-09-03" }, pages: new Map(), dbs: new Map(), assetJobs: new Map(),
  stats: { assets: 0, assetFailures: 0, assetBytes: 0 },
} as unknown as Traversal;
const lines: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ticker = startProgressTicker(t, 20, (l) => lines.push(l));
try {
  await sleep(150);
  assert.equal(lines.length, 1, `처음 한 줄 뒤엔 움직임이 없으니 침묵해야 한다: ${lines.length}줄`);
  await downloadAsset(t, { url, file: "a.bin" }, dir);
  assert.equal(fs.readFileSync(path.join(dir, "a.bin"), "utf8"), "hello", "배선 시험의 다운로드가 실제로 일어나지 않았다");
  await sleep(150);
  assert.equal(lines.length, 2, `요청 없이 받은 바이트만 늘었는데 티커가 알리지 않았다: ${lines.length}줄`);
} finally {
  clearInterval(ticker);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("ok  배선 — 티커가 받은 바이트를 읽는다(요청 없이 다운로드만 → 한 줄 더)");

console.log("\n6 passed");
