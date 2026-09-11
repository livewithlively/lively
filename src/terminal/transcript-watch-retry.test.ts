// #3889 — 대화 파일 감시자의 재시도를 **실제로 돌려서** 센다. 사양(스크래치패드 spec.md)의 엣지 표 E23~E29.
//
//  프로덕션 실측(2026-09-11): 컨테이너가 이미 없는 세션의 대화창이 열려 있으면 게이트웨이가 그 세션에 감시자
//   중계를 **3초마다 무한히** 되띄웠다(세션 하나에 35분 658회). 위치 찾기는 컨테이너 없이도 성공하는데 그 성공이
//   재시도 간격을 최소치로 되돌려, 사다리가 한 칸도 안 올랐다.
//  ⚠ 소스 모양 단언(transcript-stream.test.ts E14)은 그 루프를 초록으로 통과시켰다. 재시도는 «시간이 흐르며
//   몇 번 되거나» 가 본질이라 모양으로는 못 잰다 — 그래서 여기서는 **스폰 횟수와 간격**(부작용)으로만 단언한다.
//
//  장치: 가짜 중계를 `LIVELY_SESSION_EXEC` 로 건다. 스폰마다 시각을 세션별 파일에 한 줄 적고, 세션 id 접두로
//   행동을 고른다 — `proved-` 는 ready 를 보내고 곧바로 끝나고, 나머지는 운영의 «컨테이너 없음» 처럼 44 로 끝난다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireTranscriptWatch, resetTranscriptWatch, _setTranscriptWatchDepsForTest, RETRY_MIN_MS,
} from "./transcript-watch.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "lvly-3889-"));
const relay = path.join(dir, "relay.cjs");
writeFileSync(relay, [
  `const fs = require("fs"), p = require("path");`,
  `const sid = process.argv[2];`,
  `fs.appendFileSync(p.join(process.env.LVLY_3889_LOG, sid + ".log"), Date.now() + "\\n");`,
  //  macOS 에서 파이프 쓰기는 비동기다 — 쓰기가 끝난 뒤에 끝내야 ready 가 실제로 건너간다.
  `if (sid.startsWith("proved-")) process.stdout.write('{"ready":1}\\n', () => process.exit(0));`,
  `else process.exit(44);`,
].join("\n"));
process.env.LVLY_3889_LOG = dir;
process.env.LIVELY_SESSION_EXEC = `${process.execPath} ${relay}`;

/** 판정 스텁 — 세션마다 답을 고르고, 몇 번 물었는지 센다. */
const verdictOf = new Map<string, () => Promise<boolean>>();
const goneCalls = new Map<string, number>();
const restoreDeps = _setTranscriptWatchDepsForTest({
  resolveTranscript: async (id: string) => ({
    ok: true, uuid: `u-${id}`, mapped: `u-${id}`, io: {} as never, cwd: dir, tfs: {} as never,
    found: { file: path.join(dir, `${id}.jsonl`), size: 0, via: "convention" },
  }),
  sessionGone: async (id: string) => {
    goneCalls.set(id, (goneCalls.get(id) ?? 0) + 1);
    const v = verdictOf.get(id);
    return v ? v() : false;
  },
});
test.after(() => restoreDeps());

const spawns = (id: string): number[] => {
  const f = path.join(dir, `${id}.log`);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map(Number) : [];
};
const calls = (id: string): number => goneCalls.get(id) ?? 0;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(20); }
  return pred();
};
/** 부하 여유 — 스폰·위치찾기·판정 왕복이 붙어도 경계가 안 겹치게. */
const SLACK_MS = 1_500;

test("#3889 감시자 재시도 — 실제로 돌려서 센다", { concurrency: true }, async (t) => {
  await Promise.all([
    t.test("E23 — 증명 전에 끝났고 세션이 끝났다는 확답이면 되띄우지 않는다(운영의 3초 무한 루프)", async () => {
      const id = "gone-e23";
      verdictOf.set(id, async () => true);
      acquireTranscriptWatch(id);
      try {
        assert.ok(await until(() => spawns(id).length >= 1, 5_000), "배선 — 가짜 중계가 한 번도 안 불렸다(관측 장치가 죽었다)");
        await sleep(RETRY_MIN_MS + SLACK_MS);
        assert.equal(spawns(id).length, 1,
          `E23 — 끝난 세션에 감시자를 ${spawns(id).length}번 띄웠다: 대화창이 열려 있는 내내 되띄운다(운영 35분 658회)`);
        assert.equal(calls(id), 1, "E23 — 세션이 끝났는지 한 번만 물어야 한다(안 묻거나 되묻는다)");
      } finally { resetTranscriptWatch(id); }
    }),

    t.test("E24 — 세션이 살아 있으면 되걸되, 위치를 찾았다는 이유로 간격을 최소치로 되돌리지 않는다", async () => {
      const id = "alive-e24";
      verdictOf.set(id, async () => false);
      acquireTranscriptWatch(id);
      try {
        assert.ok(await until(() => spawns(id).length >= 2, RETRY_MIN_MS + 5_000), "E24 — 살아 있는 세션인데 되걸지 않는다");
        const [s0, s1] = spawns(id);
        assert.ok(s1 - s0 >= RETRY_MIN_MS - 100, `첫 재시도가 최소 간격(${RETRY_MIN_MS}ms)보다 이르다: ${s1 - s0}ms`);
        //  두 번째 재시도는 두 배 간격이어야 한다 — 최소 간격 + 여유가 지나도 세 번째가 없어야 한다.
        await sleep(Math.max(0, s1 + RETRY_MIN_MS + SLACK_MS + 500 - Date.now()));
        assert.equal(spawns(id).length, 2,
          "E24 — 사다리가 안 오른다: 세 번째 스폰이 최소 간격에 왔다(위치 찾기가 간격을 되돌렸다)");
        //  멈춘 것은 아니다 — 늘어난 간격에 결국 온다.
        assert.ok(await until(() => spawns(id).length >= 3, 2 * RETRY_MIN_MS + 4_000), "E24 — 살아 있는 세션인데 되걸기를 멈췄다");
        const [, t1, t2] = spawns(id);
        assert.ok(t2 - t1 >= 2 * RETRY_MIN_MS - 100, `E24 — 두 번째 간격이 두 배가 아니다: ${t2 - t1}ms`);
      } finally { resetTranscriptWatch(id); }
    }),

    t.test("E25 — 판정 호출이 실패하면 «끝났다» 로 읽지 않고 되건다", async () => {
      const id = "throw-e25";
      verdictOf.set(id, async () => { throw new Error("판정 불가(중계 불통)"); });
      acquireTranscriptWatch(id);
      try {
        assert.ok(await until(() => spawns(id).length >= 2, RETRY_MIN_MS + 5_000),
          "E25 — 판정이 실패했는데 되걸지 않는다: 모름을 죽음으로 읽었다");
      } finally { resetTranscriptWatch(id); }
    }),

    t.test("E26 — ready 를 보내고 곧바로 끝나도 증명으로 친다(최소 간격 · 판정 안 물음)", async () => {
      const id = "proved-e26";
      acquireTranscriptWatch(id);
      try {
        assert.ok(await until(() => spawns(id).length >= 3, 2 * RETRY_MIN_MS + 6_000), "E26 — 증명한 감시자가 죽은 뒤 되띄우지 않는다");
        const [s0, s1, s2] = spawns(id);
        for (const gap of [s1 - s0, s2 - s1]) {
          assert.ok(gap <= RETRY_MIN_MS + SLACK_MS,
            `E26 — 증명한 감시자의 재시도가 최소 간격보다 늦다(${gap}ms): ready 가 사다리를 되돌리지 않는다`);
        }
        assert.equal(calls(id), 0, "E26 — 증명한 감시자가 죽을 때마다 세션 판정을 묻는다(일시 끊김마다 왕복이 붙는다)");
      } finally { resetTranscriptWatch(id); }
    }),

    t.test("E27 — 끝났다는 확답으로 멈춘 뒤 새 구독이 오면 한 번 더 본다(영구 정지가 아니다)", async () => {
      const id = "gone-e27";
      verdictOf.set(id, async () => true);
      acquireTranscriptWatch(id);
      try {
        assert.ok(await until(() => spawns(id).length >= 1, 5_000), "배선 — 가짜 중계가 한 번도 안 불렸다");
        await sleep(500);
        acquireTranscriptWatch(id);                                  // 두 번째 화면(또는 재접속)
        assert.ok(await until(() => spawns(id).length >= 2, 5_000), "E27 — 새 구독이 왔는데 다시 보지 않는다");
        await sleep(2 * RETRY_MIN_MS + 1_000);
        assert.equal(spawns(id).length, 2, `E27 — 새 구독 뒤 한 번이 아니라 ${spawns(id).length - 1}번 더 띄웠다`);
      } finally { resetTranscriptWatch(id); }
    }),

    t.test("E28 — 판정을 기다리는 사이에 접히면 답이 «살아 있음» 이어도 되띄우지 않는다", async () => {
      const id = "fold-e28";
      let answer: (v: boolean) => void = () => {};
      verdictOf.set(id, () => new Promise<boolean>((r) => { answer = r; }));
      acquireTranscriptWatch(id);
      try {
        assert.ok(await until(() => calls(id) >= 1, 5_000), "판정을 묻는 자리에 닿지 않았다");
        resetTranscriptWatch(id);                                    // 마지막 화면이 떠나 접혔다
        answer(false);
        await sleep(RETRY_MIN_MS + SLACK_MS);
        assert.equal(spawns(id).length, 1, "E28 — 접힌 감시가 판정 뒤에 되살아났다(아무도 안 보는 세션에 감시자)");
      } finally { resetTranscriptWatch(id); }
    }),
  ]);
});

test("E29 — 운영 기본값은 실제 판정 둘이고, 감시자는 그 seam 만 거친다", () => {
  let d = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(d, "package.json"))) d = path.dirname(d);
  const src = readFileSync(path.join(d, "src/terminal/transcript-watch.ts"), "utf8");
  assert.match(src, /const deps = \{ resolveTranscript, sessionGone \};/, "E29 — seam 기본값이 실제 판정이 아니다");
  //  seam 을 우회하는 직접 호출이 남으면 시험은 스텁을 보고 운영은 다른 길을 탄다.
  assert.doesNotMatch(src, /(?<!deps\.)\bresolveTranscript\(id/, "E29 — 위치 찾기를 seam 밖에서 직접 부른다");
  assert.doesNotMatch(src, /(?<!deps\.)\bsessionGone\(id/, "E29 — 세션 판정을 seam 밖에서 직접 부른다");
});
