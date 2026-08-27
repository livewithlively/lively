// 순수 단위 체크(node:assert) — 세션 주입 계획(#1664).
// 사양 7정책 · 엣지 16행(스크래치 spec.md)을 행마다 시나리오로 옮긴 것. 실행부(sendKeysToSession)는
//  프로세스를 띄우므로 여기서 안 잰다 — 계획을 순수하게 갈라 둔 이유가 **Windows 노드를 CI 에서 못 띄우기**
//  때문이다. 그 표면 규칙을 mac 에서도 표로 못박는다.
import assert from "node:assert/strict";
import { sendKeysPlan, injectFlushMs } from "./send-keys.js";

const TMUX = "/opt/homebrew/bin/tmux";
const PSMUX = "C:\\Users\\y\\.lively\\bin\\psmux\\psmux.exe";
const CHUNK = 512; // 사양의 '한 번에 보내는 토큰 상한'
const toks = (argv: string[]): string[] => argv.slice(3); // argv 머리 3개(send-keys/-t/id) 뒤가 키 토큰

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── 1. 일반 mux ──────────────────────────────────────────────────────────────
t("[1] tmux — 텍스트는 리터럴 1회, 제출은 Enter 키", () => {
  const p = sendKeysPlan("box-yoon-1", "안녕", TMUX);
  assert.deepEqual(p.keys, [["send-keys", "-t", "box-yoon-1", "-l", "안녕"]]);
  assert.deepEqual(p.enter, ["send-keys", "-t", "box-yoon-1", "Enter"]);
});

// ── 2~5. Windows mux 표면 ────────────────────────────────────────────────────
t("[2] psmux — 코드포인트 토큰 + 제출도 코드포인트(키 이름 Enter 아님)", () => {
  const p = sendKeysPlan("box-yoon-1", "ls", PSMUX);
  assert.deepEqual(p.keys, [["send-keys", "-t", "box-yoon-1", "0x6c", "0x73"]]);
  assert.deepEqual(p.enter, ["send-keys", "-t", "box-yoon-1", "0x0d"]);
  assert.ok(!p.enter.includes("Enter"), "psmux 에 키 이름 Enter 를 보내면 제출이 안 된다");
});

t("[3] psmux — 한글은 바이트가 아니라 코드포인트 1토큰", () => {
  // '한' = U+D55C. UTF-8 바이트(ed 95 9c) 3토큰으로 쪼개면 화면이 'íU\' 로 깨진다.
  assert.deepEqual(toks(sendKeysPlan("s", "한", PSMUX).keys[0]), ["0xd55c"]);
});

t("[4] psmux — BMP 밖 문자(이모지)도 1토큰 (서로게이트 쌍이 안 쪼개진다)", () => {
  assert.deepEqual(toks(sendKeysPlan("s", "🚀", PSMUX).keys[0]), ["0x1f680"]);
});

t("[5] psmux — 작은 제어문자도 토큰 폭 2자리 유지", () => {
  // ⚠ 제어문자를 양 끝에 두면 안 된다 — Tab(0x09)은 공백류라 정책 1(앞뒤 여백 버림)의 trim 에 먹힌다.
  //  여기서 재려는 건 폭이지 trim 이 아니므로 텍스트 **중간**에 둔다.
  const got = toks(sendKeysPlan("s", "a\x03\x09b", PSMUX).keys[0]);
  assert.deepEqual(got, ["0x61", "0x03", "0x09", "0x62"]);
  for (const tok of got) assert.ok(tok.length >= 4, `폭 부족(Ctrl-C·Tab 이 안 먹는다): ${tok}`);
});

// ── 6~7. 청크 (+ 경계값) ─────────────────────────────────────────────────────
t("[6] psmux — 상한 초과는 여러 묶음으로 갈리고 각 묶음이 자족적·순서 보존", () => {
  const text = Array.from({ length: CHUNK + 88 }, (_, i) => String.fromCodePoint(0x41 + (i % 26))).join("");
  const p = sendKeysPlan("s", text, PSMUX);
  assert.equal(p.keys.length, 2);
  assert.equal(toks(p.keys[0]).length, CHUNK);
  assert.equal(toks(p.keys[1]).length, 88);
  for (const argv of p.keys) assert.deepEqual(argv.slice(0, 3), ["send-keys", "-t", "s"], "묶음마다 대상 세션이 실려야 한다");
  // 순서 보존 — 이어붙이면 원문 그대로
  const flat = p.keys.flatMap(toks).map((h) => String.fromCodePoint(parseInt(h, 16))).join("");
  assert.equal(flat, text);
});

t("[7·경계] psmux — 정확히 상한이면 1묶음, +1이면 2묶음", () => {
  assert.equal(sendKeysPlan("s", "a".repeat(CHUNK), PSMUX).keys.length, 1);
  const over = sendKeysPlan("s", "a".repeat(CHUNK + 1), PSMUX);
  assert.equal(over.keys.length, 2);
  assert.equal(toks(over.keys[1]).length, 1);
});

// ── 8~10. 한 번만 제출 / 보낼 것 없음 ────────────────────────────────────────
t("[8] 개행은 공백으로 평탄화 — 안 하면 그 자리에서 조기 제출돼 프롬프트가 잘린다", () => {
  const p = sendKeysPlan("s", "첫 줄\n  둘째 줄\n\n셋째", TMUX);
  assert.equal(p.oneLine, "첫 줄 둘째 줄 셋째");
  assert.ok(!p.keys[0][4].includes("\n"), "실제로 보내는 인자에 개행이 남아 있다");
});

t("[9] 앞뒤 여백은 잘린다", () => {
  assert.equal(sendKeysPlan("s", "  일감  ", TMUX).oneLine, "일감");
});

t("[10] 빈 문자열·공백뿐이면 보낼 키가 없다 (양 mux)", () => {
  for (const bin of [TMUX, PSMUX]) {
    for (const raw of ["", "   ", "\n\n", " \t \n "]) {
      const p = sendKeysPlan("s", raw, bin);
      assert.equal(p.oneLine, "", `bin=${bin} raw=${JSON.stringify(raw)}`);
      assert.deepEqual(p.keys, [], `bin=${bin} raw=${JSON.stringify(raw)} — 빈 제출을 흘리면 안 된다`);
    }
  }
});

// ── 11. 인젝션 ───────────────────────────────────────────────────────────────
t("[11] mux 메타문자는 별도 명령이 되지 않는다", () => {
  const evil = "; kill-server ; new-session -d";
  const tm = sendKeysPlan("s", evil, TMUX);
  assert.equal(tm.keys.length, 1, "인자가 쪼개져 여러 명령이 됐다");
  assert.equal(tm.keys[0][4], evil, "리터럴 인자 하나로 머물러야 한다");
  for (const tok of toks(sendKeysPlan("s", evil, PSMUX).keys[0])) assert.match(tok, /^0x[0-9a-f]+$/);
});

// ── 12~14. 대기 시간 ─────────────────────────────────────────────────────────
t("[12] 대기 하한 — 짧아도 그릴 틈은 준다", () => {
  assert.equal(injectFlushMs(0), 500);
  assert.equal(injectFlushMs(100), 500);
});
t("[13] 대기 비례 구간", () => {
  assert.equal(injectFlushMs(1000), 600);
  assert.equal(injectFlushMs(2000), 1200);
});
t("[14] 대기 상한 — 크론 주입이 하염없이 느려지지 않게", () => {
  assert.equal(injectFlushMs(100000), 1500);
});

// ── 15. 세션 id 전파 ─────────────────────────────────────────────────────────
t("[15] 세션 id 는 텍스트·제출 모든 argv 에 실린다", () => {
  const id = "box-yoon-56c6ae98";
  for (const bin of [TMUX, PSMUX]) {
    const p = sendKeysPlan(id, "a".repeat(CHUNK + 5), bin); // 청크가 갈려도 전부
    for (const argv of [...p.keys, p.enter]) assert.equal(argv[2], id, `bin=${bin}`);
  }
});

// ── 16. 새 입력이 비었을 때 (정책 7) ─────────────────────────────────────────
t("[16] mux 경로를 모르면 일반 mux 취급 — Windows 전용 표면을 근거 없이 쓰지 않는다", () => {
  for (const bin of ["", "  ", "/usr/bin/tmux", "/opt/homebrew/bin/tmux-next"]) {
    const p = sendKeysPlan("s", "ls", bin);
    assert.deepEqual(p.keys, [["send-keys", "-t", "s", "-l", "ls"]], `bin=${JSON.stringify(bin)}`);
    assert.deepEqual(p.enter, ["send-keys", "-t", "s", "Enter"], `bin=${JSON.stringify(bin)}`);
  }
});

console.log(`\n${pass} passed`);

// ── #2154 '한 글자도 안 갔다' 를 호출자가 알 수 있어야 한다 ────────────────────────────────
//  이 파일은 원래 순수 계획만 잰다(머리말). 이 두 건만 실행부를 띄우는 이유: 고치는 대상이 **어느 단계에서
//  죽었나**라 계획으로는 표현되지 않는다. 대신 tmux 를 가짜 중계(node 한 줄)로 갈아 끼워 프로세스는 가볍게 둔다.
//  실측 2026-08-27: 아웃박스의 진짜 유실 5건 중 하나가 `send: … has-session … node channel unavailable`
//  이었다 — 노드 채널이 순간 빈 것뿐인데 사람의 지시가 통째로 버려졌다.
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { sendKeysToSession, SendKeysNotStarted } = await import("./send-keys.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sk-"));
  /** failOn 이 argv 에 있으면 그 단계에서 비-0 으로 죽는 가짜 tmux. */
  const fakeTmux = (name: string, failOn: string, stderr: string): string => {
    const f = path.join(tmp, `${name}.mjs`);
    fs.writeFileSync(f, [
      `if (process.argv.slice(2).includes(${JSON.stringify(failOn)})) {`,
      `  process.stderr.write(${JSON.stringify(stderr)}); process.exit(1);`,
      "}",
      "process.stdout.write('');",
    ].join("\n"));
    return `${process.execPath} ${f}`;
  };
  const saved = process.env.LIVELY_TMUX_EXEC;
  const at = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

  process.env.LIVELY_TMUX_EXEC = fakeTmux("nostart", "has-session", "lvly tmux-relay: node channel unavailable\n");
  await at("[#2154] 존재 확인에서 죽으면 SendKeysNotStarted — 한 글자도 안 갔으니 호출자가 되돌릴 수 있다", async () => {
    const e = await sendKeysToSession("box-yoon-1", "안녕").then(() => null, (x) => x);
    assert.ok(e instanceof SendKeysNotStarted, `받은 것: ${e && e.name}`);
    assert.match(String((e.cause as { stderr?: string })?.stderr ?? ""), /node channel unavailable/,
      "원래 tmux 오류를 그대로 들고 있어야 gone 확답 판정에 쓸 수 있다");
  });

  process.env.LIVELY_TMUX_EXEC = fakeTmux("midsend", "-l", "boom\n");
  await at("[#2154] 글자를 싣기 시작한 뒤 죽으면 **그냥 오류** — 입력칸에 반쪽이 남았을 수 있어 재전송 금지", async () => {
    const e = await sendKeysToSession("box-yoon-1", "안녕").then(() => null, (x) => x);
    assert.ok(e instanceof Error, "실패는 실패다");
    assert.ok(!(e instanceof SendKeysNotStarted), "여기서 '안 갔다'고 말하면 같은 지시가 두 번 간다");
  });

  if (saved === undefined) delete process.env.LIVELY_TMUX_EXEC; else process.env.LIVELY_TMUX_EXEC = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
}
