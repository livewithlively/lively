// 위탁 작업 진행 로그 tail 이 UTF-8 문자 중간에서 자르지 않는다는 사양의 시험.
//
// 왜: tailTask 는 stream.jsonl 을 바이트 오프셋으로 최대 256KiB 씩 끊어 주는데, 그 경계가 한글(3바이트)·이모지(4바이트)
//  중간에 떨어지면 양쪽 조각에 U+FFFD 가 들어가 이어 붙여도 원문이 복원되지 않았다. 이 시험은 ① 여러 쪽 이어 받기 복원
//  ② 경계가 문자 중간에 정확히 떨어지는 파일 ③ 쓰기 진행 중 / 종료 후 파일 끝의 깨진 문자 ④ utf8CompleteLength 엣지
//  ⑤ 스트림을 읽은 직후 판이 끝나는 경합(exit 를 먼저 읽어야 한다)을 잠근다.
import { strict as assert } from "node:assert";
import test, { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tailTask, utf8CompleteLength, localTaskFs, type TaskRead } from "./tasks.js";

const PAGE = 262144;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "co-tailutf8-"));
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

let seq = 0;
const mkTask = (content: string | Buffer, exit?: number): string => {
  const dir = path.join(TMP, `t${seq++}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "stream.jsonl"), content);
  if (exit !== undefined) fs.writeFileSync(path.join(dir, "exit"), `${exit}\n`);
  return dir;
};

const drain = async (dir: string) => {
  const chunks: string[] = [];
  let from = 0;
  for (let i = 0; i < 100; i++) {
    const r = await tailTask(dir, from, null);
    if (r.chunk === "") break;
    assert.equal(r.next - from, Buffer.byteLength(r.chunk, "utf8"), "next 는 chunk 의 UTF-8 바이트 길이만큼만 전진");
    chunks.push(r.chunk);
    from = r.next;
  }
  return { chunks, from };
};

const mixed = (bytes: number): string => {
  const unit = ["가나다라마바사", "😀🎉🚀", "abcdefg", "é", "한글 로그 ✓\n"];
  // 바이트 길이를 매 글자마다 다시 세면 O(n²) 라 CI 파일 예산(45s)을 넘는다 — 단위 묶음을 한 번에 반복한다.
  const block = unit.join("");
  return block.repeat(Math.ceil(bytes / Buffer.byteLength(block, "utf8")));
};

for (const withExit of [false, true]) {
  test(`600KiB+ 한글·이모지·ASCII 혼합 파일을 여러 쪽으로 이어 받으면 원문 복원 (exit 파일 ${withExit ? "있음" : "없음"})`, async () => {
    const text = mixed(600 * 1024 + 7);
    const dir = mkTask(text, withExit ? 0 : undefined);
    const { chunks, from } = await drain(dir);
    assert.ok(chunks.length >= 3, "256KiB 상한이라 최소 3쪽");
    assert.equal(chunks.join(""), text);
    for (const c of chunks) assert.ok(!c.includes("�"), "어느 chunk 에도 U+FFFD 없음");
    assert.equal(from, Buffer.byteLength(text, "utf8"));
  });
}

test("262144번째 바이트 경계가 3바이트 한글 중간(1/3 뒤)에 떨어지면 그 문자는 다음 쪽으로 넘어간다", async () => {
  const text = "a".repeat(PAGE - 1) + "한" + "b".repeat(10);
  const dir = mkTask(text, 0);
  const r1 = await tailTask(dir, 0, null);
  assert.equal(r1.chunk, "a".repeat(PAGE - 1));
  assert.equal(r1.next, PAGE - 1);
  const { chunks, from } = await drain(dir);
  assert.equal(chunks.join(""), text);
  assert.equal(from, Buffer.byteLength(text, "utf8"));
});

test("262144번째 바이트 경계가 3바이트 한글 중간(2/3 뒤)에 떨어져도 문자는 온전히 다음 쪽", async () => {
  const text = "a".repeat(PAGE - 2) + "한" + "b".repeat(10);
  const dir = mkTask(text, 0);
  const r1 = await tailTask(dir, 0, null);
  assert.equal(r1.chunk, "a".repeat(PAGE - 2));
  assert.equal(r1.next, PAGE - 2);
  const r2 = await tailTask(dir, r1.next, null);
  assert.ok(r2.chunk.startsWith("한b"));
  assert.ok(!r2.chunk.includes("�"));
});

for (const k of [1, 2, 3]) {
  test(`262144번째 바이트 경계가 4바이트 이모지의 ${k}/4 뒤에 떨어지면 이모지는 다음 쪽`, async () => {
    const text = "a".repeat(PAGE - k) + "😀" + "b".repeat(10);
    const dir = mkTask(text, 0);
    const r1 = await tailTask(dir, 0, null);
    assert.equal(r1.chunk, "a".repeat(PAGE - k));
    assert.equal(r1.next, PAGE - k);
    const { chunks, from } = await drain(dir);
    assert.equal(chunks.join(""), text);
    assert.equal(from, Buffer.byteLength(text, "utf8"));
  });
}

test("경계가 문자 사이에 정확히 떨어지면 256KiB 를 그대로 내준다", async () => {
  const text = "a".repeat(PAGE - 3) + "한" + "b".repeat(10);
  const dir = mkTask(text);
  const r1 = await tailTask(dir, 0, null);
  assert.equal(r1.next, PAGE);
  assert.equal(Buffer.byteLength(r1.chunk, "utf8"), PAGE);
  assert.ok(r1.chunk.endsWith("한"));
});

test("쓰기 진행 중(exit 없음)에 파일 끝이 한글 앞 2바이트면 그 바이트는 빠지고 next 는 문자 시작", async () => {
  const han = Buffer.from("한", "utf8");
  const dir = mkTask(Buffer.concat([Buffer.from("ab"), han.subarray(0, 2)]));
  const r = await tailTask(dir, 0, null);
  assert.equal(r.chunk, "ab");
  assert.equal(r.next, 2);
  assert.equal(r.done, false);
});

test("쓰기 진행 중에 파일 끝이 한글 앞 1바이트여도 마찬가지", async () => {
  const han = Buffer.from("한", "utf8");
  const dir = mkTask(Buffer.concat([Buffer.from("ab"), han.subarray(0, 1)]));
  const r = await tailTask(dir, 0, null);
  assert.equal(r.chunk, "ab");
  assert.equal(r.next, 2);
  assert.equal(r.done, false);
});

test("쓰기 진행 중 잘려 있던 문자가 나머지 바이트로 완성되면 다음 호출이 그 문자를 내준다", async () => {
  const han = Buffer.from("한", "utf8");
  const dir = mkTask(Buffer.concat([Buffer.from("ab"), han.subarray(0, 2)]));
  const r1 = await tailTask(dir, 0, null);
  fs.appendFileSync(path.join(dir, "stream.jsonl"), han.subarray(2));
  const r2 = await tailTask(dir, r1.next, null);
  assert.equal(r2.chunk, "한");
  assert.equal(r2.next, 5);
});

test("작업 종료(exit 있음) 후 파일 끝이 깨진 문자여도 남은 바이트를 모두 소비한다", async () => {
  const han = Buffer.from("한", "utf8");
  const buf = Buffer.concat([Buffer.from("ab"), han.subarray(0, 2)]);
  const dir = mkTask(buf, 7);
  const r = await tailTask(dir, 0, null);
  assert.equal(r.next, buf.length);
  assert.equal(r.done, true);
  assert.equal(r.exit, 7);
});

test("종료 후 파일 끝이 깨진 이모지(앞 3바이트)여도 next 는 파일 바이트 길이", async () => {
  const buf = Buffer.concat([Buffer.from("x"), Buffer.from("😀", "utf8").subarray(0, 3)]);
  const dir = mkTask(buf, 0);
  const r = await tailTask(dir, 0, null);
  assert.equal(r.next, buf.length);
  assert.equal(r.done, true);
  assert.equal(r.exit, 0);
});

test("종료 후 이어 받기가 파일 끝에 닿으면 마지막 next 는 파일 바이트 길이 (깨진 끝 포함)", async () => {
  const buf = Buffer.concat([Buffer.from("a".repeat(PAGE + 10)), Buffer.from("한", "utf8").subarray(0, 1)]);
  const dir = mkTask(buf, 1);
  let from = 0;
  for (let i = 0; i < 10; i++) {
    const r = await tailTask(dir, from, null);
    if (r.chunk === "") break;
    from = r.next;
  }
  assert.equal(from, buf.length);
});

// 경합 — 스트림을 읽은 직후·exit 를 보기 전에 판이 남은 바이트를 쓰고 끝나는 경우. «종료 + 파일 끝» 판정(atFinalEof)은
//  exit 를 먼저 봤을 때만 최종본에 대한 판정이다. 거꾸로 읽으면 낡은 size 로 잘린 문자를 내줘 양쪽 조각이 U+FFFD 가 된다.
test("스트림을 읽은 직후 판이 끝나도(그 사이 exit 생김) 잘린 문자를 내주지 않는다", async () => {
  const han = Buffer.from("한", "utf8");
  const dir = mkTask(Buffer.concat([Buffer.from("ab"), han.subarray(0, 2)]));
  const orig = localTaskFs.readMany;
  let armed = true;
  localTaskFs.readMany = async (reqs) => {
    const out: Record<string, TaskRead | null> = {};
    for (const r of reqs) {   // 실제 구현처럼 차례로 읽되, 스트림을 읽은 바로 뒤에 판이 끝나게 끼워 넣는다
      Object.assign(out, await orig.call(localTaskFs, [r]));
      if (armed && r.key === "stream") {
        armed = false;
        fs.appendFileSync(path.join(dir, "stream.jsonl"), han.subarray(2));
        fs.writeFileSync(path.join(dir, "exit"), "0\n");
      }
    }
    return out;
  };
  try {
    const { chunks, from } = await drain(dir);
    assert.equal(chunks.join(""), "ab한");
    assert.equal(from, 5);
  } finally { localTaskFs.readMany = orig; }
});

for (const [name, s] of [["ASCII", "hello\n"], ["2바이트 문자", "ab é"], ["3바이트 문자", "ab 한"], ["4바이트 문자", "ab 😀"]] as const) {
  test(`쓰기 진행 중이어도 파일 끝이 온전한 ${name}면 읽은 만큼 그대로 내준다`, async () => {
    const dir = mkTask(s);
    const r = await tailTask(dir, 0, null);
    assert.equal(r.chunk, s);
    assert.equal(r.next, Buffer.byteLength(s, "utf8"));
    assert.equal(r.done, false);
  });
}

test("from 이 파일 끝이면 빈 chunk 에 next=from", async () => {
  const s = "한글";
  const dir = mkTask(s);
  const len = Buffer.byteLength(s, "utf8");
  const r = await tailTask(dir, len, null);
  assert.equal(r.chunk, "");
  assert.equal(r.next, len);
});

test("stream.jsonl 이 없으면 빈 chunk 에 next=from", async () => {
  const dir = path.join(TMP, `t${seq++}`);
  fs.mkdirSync(dir);
  const r = await tailTask(dir, 5, null);
  assert.equal(r.chunk, "");
  assert.equal(r.next, 5);
});

test("utf8CompleteLength: 빈 버퍼는 0", () => {
  assert.equal(utf8CompleteLength(new Uint8Array(0)), 0);
});

test("utf8CompleteLength: ASCII 끝은 길이 그대로", () => {
  assert.equal(utf8CompleteLength(Buffer.from("abc")), 3);
});

test("utf8CompleteLength: 2바이트 문자 선두만 있으면 그 문자를 뺀다", () => {
  assert.equal(utf8CompleteLength(Buffer.from("ab\xc3", "latin1")), 2);
});

test("utf8CompleteLength: 2바이트 문자 완결은 그대로", () => {
  const b = Buffer.from("abé", "utf8");
  assert.equal(utf8CompleteLength(b), b.length);
});

for (const k of [1, 2]) {
  test(`utf8CompleteLength: 3바이트 문자 ${k}/3 은 뺀다`, () => {
    const b = Buffer.concat([Buffer.from("ab"), Buffer.from("한", "utf8").subarray(0, k)]);
    assert.equal(utf8CompleteLength(b), 2);
  });
}

test("utf8CompleteLength: 3바이트 문자 완결은 그대로", () => {
  const b = Buffer.from("ab한", "utf8");
  assert.equal(utf8CompleteLength(b), b.length);
});

for (const k of [1, 2, 3]) {
  test(`utf8CompleteLength: 4바이트 문자 ${k}/4 는 뺀다`, () => {
    const b = Buffer.concat([Buffer.from("ab"), Buffer.from("😀", "utf8").subarray(0, k)]);
    assert.equal(utf8CompleteLength(b), 2);
  });
}

test("utf8CompleteLength: 4바이트 문자 완결은 그대로", () => {
  const b = Buffer.from("ab😀", "utf8");
  assert.equal(utf8CompleteLength(b), b.length);
});

test("utf8CompleteLength: 문자 하나가 통째로 잘린 버퍼는 0", () => {
  assert.equal(utf8CompleteLength(Buffer.from("한", "utf8").subarray(0, 2)), 0);
});

// 깨진 입력은 잘라 내지 않는다 — 끝 ≤3바이트만 보류해야 tail 이 next==from 에 묶이지 않는다.
test("utf8CompleteLength: 깨진 입력 — 고립 이어지는 바이트는 그대로 둔다", () => {
  assert.equal(utf8CompleteLength(Buffer.from([0x61, 0x62, 0x80])), 3);
});
test("utf8CompleteLength: 깨진 입력 — 이어지는 바이트 3개 연속은 그대로 둔다", () => {
  assert.equal(utf8CompleteLength(Buffer.from([0x61, 0x80, 0x80, 0x80])), 4);
});
test("utf8CompleteLength: 깨진 입력 — 선두 뒤에 ASCII 가 오면 그대로 둔다", () => {
  assert.equal(utf8CompleteLength(Buffer.from([0xe0, 0x61])), 2);
});
test("utf8CompleteLength: 깨진 입력 — 0xF8 선두는 최대 3바이트만 보류한다", () => {
  assert.equal(utf8CompleteLength(Buffer.from([0x61, 0xf8])), 1);
});
