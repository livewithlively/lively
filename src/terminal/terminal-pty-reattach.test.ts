// 끊긴 중계 흡수(#3905) — 중계(tmux-relay)를 거치는 control attach 가 브로커 재기동으로 끊기면 소켓을 닫지 않고
//  같은 채널에 tmux 를 다시 붙인다. 판정표(relayLossDecision · relayLossIsNew) · 스트림 관찰(ControlStreamWatch) ·
//  배선(attachSession)을 **가짜 term · 가짜 소켓**으로 친다(실 PTY · 실 tmux 없음).
//
// 시험 이름의 E번호는 사양 엣지 표의 행이다(표: 이 태스크의 사양 — 행 수 = 최소 시나리오 수).
//  ① 끊김(스트림이 `%exit` 없이 끝남)이면 **소켓을 안 닫고** 같은 argv 로 다시 붙는다.
//  ② 브라우저 계약 — 다시 붙은 스트림의 도입자·그 앞 문구는 안 보내고, 줄을 닫고 잇고, 크기→미룬 입력→상태 순(백필 없음).
//  ③ **종전 동작을 지킨다** — `%exit` · 중계 아님 · control 스트림을 연 적 없음 · 세션 없음 · 예산 초과 · 종료는 닫는다.
//  ④ 게이트(lvly-cloud attach-cut-probe.sh)가 세는 메시지가 글자 그대로다.
// ⚠ 실시간 타이머를 쓴다 — «기다렸다 본다» 는 고정 대기가 아니라 **조건이 설 때까지**(until) 기다린다. 부하 걸린 CI 에서
//  고정 대기는 흔들린다. «안 일어나야 한다» 를 볼 때만 고정 대기를 쓴다(그땐 대기가 길수록 엄격하다).
// 실행: npm run build && node dist/terminal/terminal-pty-reattach.test.js
import assert from "node:assert/strict";
import {
  attachSession, attachRefCount, ControlStreamWatch, relayLossDecision, relayLossIsNew, stateCmd, killAttachedPtys,
  ATTACH_ABSORBED_MSG, ATTACH_ABSORB_GAVE_UP_MSG, RELAY_REATTACH_DELAYS_MS, RELAY_REATTACH_MAX, RELAY_REATTACH_BUDGET_MS,
} from "./terminal-pty.js";
import type { AttachSocket, AttachTerm, RelayLossInput } from "./terminal-pty.js";
import { logger } from "../log.js";

const INTRO = "\x1bP1000p";
const tests: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>): void => { tests.push([name, fn]); };
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** 조건이 설 때까지 기다린다 — 상한을 넘기면 **무엇을 기다렸는지** 말하며 실패한다(undefined 접근으로 죽지 않게). */
async function until(what: string, cond: () => boolean, ms = 3_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`${ms}ms 안에 안 섰다: ${what}`);
    await tick(2);
  }
}

// ── 로그를 붙잡는다 — 게이트가 세는 메시지만 본다(출력은 삼킨다) ──
type Log = { level: string; obj: Record<string, unknown>; msg: string };
const logs: Log[] = [];
for (const level of ["info", "warn"] as const) {
  (logger as unknown as Record<string, unknown>)[level] = (obj: unknown, msg?: unknown): void => {
    logs.push({ level, obj: (obj ?? {}) as Record<string, unknown>, msg: String(msg ?? "") });
  };
}
const logsFor = (id: string, msg: string): Log[] => logs.filter((l) => l.obj.id === id && l.msg === msg);

class FakeTerm implements AttachTerm {
  readonly writes: string[] = [];
  readonly killed: string[] = [];
  private readonly dataCbs: Array<(d: Buffer) => void> = [];
  private readonly exitCbs: Array<() => void> = [];
  private exited = false;
  constructor(readonly bin: string, readonly args: string[]) {}
  onData(cb: (d: Buffer) => void): void { this.dataCbs.push(cb); }
  onExit(cb: () => void): void { this.exitCbs.push(cb); }
  write(s: string): void { this.writes.push(s); }
  resize(): void { /* control mode 는 refresh-client 로 통지한다 */ }
  kill(sig?: string): void { this.killed.push(sig ?? ""); }
  /** latin1 — 도입자 같은 제어 바이트를 그대로 싣는다. */
  emit(s: string): void { const b = Buffer.from(s, "latin1"); for (const cb of this.dataCbs) cb(b); }
  emitUtf8(s: string): void { const b = Buffer.from(s, "utf8"); for (const cb of this.dataCbs) cb(b); }
  exit(): void { if (this.exited) return; this.exited = true; for (const cb of this.exitCbs) cb(); }
}

/** 노드 에이전트의 ChanSocket 처럼 close() 가 'close' 를 **동기로** 쏜다. */
class FakeSock implements AttachSocket {
  readonly sent: Buffer[] = [];
  closes = 0;
  private readonly ls = new Map<string, Array<(...a: any[]) => void>>();
  send(d: Buffer | string): void { this.sent.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))); }
  close(): void { this.closes++; this.emit("close"); }
  on(ev: string, fn: (...a: any[]) => void): void { const a = this.ls.get(ev) ?? []; a.push(fn); this.ls.set(ev, a); }
  emit(ev: string, ...a: unknown[]): void { for (const fn of this.ls.get(ev) ?? []) fn(...a); }
  text(): string { return Buffer.concat(this.sent).toString("latin1"); }
  msg(m: object): void { this.emit("message", JSON.stringify(m)); }
}

let seq = 0;
/**
 * 중계 attach 하나를 가짜로 띄운다.
 *  · `onSpawn(term, n)` — n 번째 스폰(0 = 첫 attach)의 대본. 스폰 직후 다음 틱에 돈다(배선이 콜백을 건 뒤).
 *  · `throwOn(n)` — n 번째 스폰에서 예외를 던진다(스폰 자체의 실패).
 */
async function start(o: {
  relay?: string[]; delays?: number[]; budgetMs?: number; stableMs?: number;
  onSpawn?: (term: FakeTerm, n: number) => void; throwOn?: (n: number) => boolean;
} = {}): Promise<{ sock: FakeSock; terms: FakeTerm[]; id: string; spawns: () => number }> {
  const terms: FakeTerm[] = [];
  let spawnCalls = 0;
  const sock = new FakeSock();
  const id = `box-reattach-${(++seq).toString(16).padStart(8, "0")}`;
  attachSession(sock, id, {
    // ⚠ 유령 정리(detach-client)가 이 argv 로 **실제 실행**된다 — 무해한 `true` 로 둔다.
    relayArgv: () => o.relay ?? ["true", "lively-test"],
    spawn: (bin, args) => {
      const n = spawnCalls++;
      if (o.throwOn?.(n)) throw new Error("posix_spawnp failed: EMFILE (Too many open files)");
      const ft = new FakeTerm(bin, args);
      terms.push(ft);
      if (o.onSpawn) setTimeout(() => o.onSpawn!(ft, n), 0);
      return ft;
    },
    reattachDelaysMs: o.delays ?? [5],
    reattachBudgetMs: o.budgetMs ?? 5_000,
    stableMs: o.stableMs ?? 10_000,
  });
  await until("첫 attach 스폰(attachSession 은 Promise 한 틱 뒤에 띄운다)", () => spawnCalls >= 1);
  return { sock, terms, id, spawns: () => spawnCalls };
}

/** 첫 attach 를 control 스트림으로 열고(도입자) 끊는다 — 흡수의 출발점. */
function establishThenCut(terms: FakeTerm[], body = "%begin 1 1 0\n"): void {
  terms[0]!.emit(INTRO + body);
  terms[0]!.exit();
}

// ── 판정표 (순수) ────────────────────────────────────────────────────────────
const base: RelayLossInput = { absorb: true, socketOpen: true, established: true, sawExit: false, failureText: "", attempts: 0, sinceLossMs: 0 };

t("E1(판정) 끊긴 중계(%exit 없음·소켓 열림·스트림 연 적 있음)는 다시 붙는다 — 첫 대기는 표의 첫 칸", () => {
  assert.deepEqual(relayLossDecision(base), { action: "reattach", delayMs: RELAY_REATTACH_DELAYS_MS[0] });
});

t("E10·E11·E12·S6(판정) 종전처럼 닫는 갈래 — 중계 아님 · 종료 중 · 소켓 닫힘 · 스트림 연 적 없음 · %exit", () => {
  assert.deepEqual(relayLossDecision({ ...base, absorb: false }), { action: "close", reason: "not-relay" });
  assert.deepEqual(relayLossDecision({ ...base, shuttingDown: true }), { action: "close", reason: "shutting-down" });
  assert.deepEqual(relayLossDecision({ ...base, socketOpen: false }), { action: "close", reason: "socket-closed" });
  assert.deepEqual(relayLossDecision({ ...base, established: false }), { action: "close", reason: "never-established" });
  assert.deepEqual(relayLossDecision({ ...base, sawExit: true }), { action: "close", reason: "tmux-exit" });
});

t("E18(경계) 시도 = 상한-1 은 다시 붙고 상한이면 닫는다 · 경과 = 예산-1 은 다시 붙고 예산이면 닫는다", () => {
  assert.equal(relayLossDecision({ ...base, attempts: RELAY_REATTACH_MAX - 1 }).action, "reattach");
  assert.deepEqual(relayLossDecision({ ...base, attempts: RELAY_REATTACH_MAX }), { action: "close", reason: "budget" });
  assert.equal(relayLossDecision({ ...base, sinceLossMs: RELAY_REATTACH_BUDGET_MS - 1 }).action, "reattach");
  assert.deepEqual(relayLossDecision({ ...base, sinceLossMs: RELAY_REATTACH_BUDGET_MS }), { action: "close", reason: "budget" });
  assert.equal(relayLossDecision({ ...base, sinceLossMs: 99, budgetMs: 100 }).action, "reattach");
  assert.deepEqual(relayLossDecision({ ...base, sinceLossMs: 100, budgetMs: 100 }), { action: "close", reason: "budget" });
});

t("E19 대기는 시도 횟수로 표를 따라가다 표 끝에 붙는다 · 대기표가 비었으면 기본 표", () => {
  const delays = [10, 20, 40];
  assert.deepEqual(relayLossDecision({ ...base, attempts: 1, delaysMs: delays }), { action: "reattach", delayMs: 20 });
  assert.deepEqual(relayLossDecision({ ...base, attempts: 7, delaysMs: delays }), { action: "reattach", delayMs: 40 });
  assert.deepEqual(relayLossDecision({ ...base, attempts: 0, delaysMs: [] }), { action: "reattach", delayMs: RELAY_REATTACH_DELAYS_MS[0] });
});

t("E25 «세션 없음» 확답 6종은 기다리지 않고 닫는다 · 브로커가 아직 안 선 창의 일시 문구 4종은 다시 붙는다", () => {
  for (const text of [
    "can't find session: box-a-12345678\r\n",
    "no server running on /tmp/tmux-200069/lvly-lively-46e3\r\n",
    "error connecting to /tmp/tmux-200069/lvly-lively-46e3 (No such file or directory)\r\n",
    'lvly tmux-relay: attach 실패: 404: {"message":"no such container"}\n',
    "lvly tmux-relay: attach 실패: 409: container is not running\n",
    "lvly tmux-relay: exec start 가 업그레이드되지 않음(403): scope\n",
  ]) assert.deepEqual(relayLossDecision({ ...base, attempts: 1, failureText: text }), { action: "close", reason: "session-gone" }, text);
  for (const text of [
    "lvly tmux-relay: attach 실패: connect ENOENT /run/lvly-t/lively-46e3/sock/session.sock\n",
    "lvly tmux-relay: attach 실패: connect ECONNREFUSED /run/lvly-t/lively-46e3/sock/session.sock\n",
    "lvly tmux-relay: attach 실패: 503: node channel unavailable\n",
    "lvly tmux-relay: exec start 실패: socket hang up\n",
  ]) assert.equal(relayLossDecision({ ...base, attempts: 1, failureText: text }).action, "reattach", text);
});

t("E22(경계) 새 끊김 판정 — 버틴 시간 = 안정-1 이면 같은 끊김 · = 안정이면 새 끊김 · 끊긴 적 없으면 새 · 못 붙은 세대는 같은 끊김", () => {
  const s = { lossAt: 1_000, sawIntroThisGen: true, establishedAt: 5_000, stableMs: 10_000 };
  assert.equal(relayLossIsNew({ ...s, now: 14_999 }), false);
  assert.equal(relayLossIsNew({ ...s, now: 15_000 }), true);
  assert.equal(relayLossIsNew({ ...s, lossAt: 0, now: 5_001 }), true);
  assert.equal(relayLossIsNew({ ...s, sawIntroThisGen: false, now: 99_999 }), false);
});

// ── 스트림 관찰 (순수) ───────────────────────────────────────────────────────
t("E26 도입자가 경계 1~6 어디서 쪼개져도 알아본다 — strip 이면 도입자 뒤만 · strip 이 아니면 바이트 그대로", () => {
  for (let p = 1; p < INTRO.length; p++) {
    const a = Buffer.from(INTRO.slice(0, p), "latin1");
    const b = Buffer.from(INTRO.slice(p) + "%begin 2 2 0\n", "latin1");
    const s = new ControlStreamWatch(true);
    assert.equal(s.feed(a).length, 0, `strip p=${p} 앞 조각`);
    assert.equal(s.feed(b).toString("latin1"), "%begin 2 2 0\n", `strip p=${p}`);
    assert.equal(s.sawIntro, true);
    const k = new ControlStreamWatch(false);
    assert.equal(k.feed(a), a, `keep p=${p} 앞 조각`);
    assert.equal(k.feed(b), b, `keep p=${p}`);
    assert.equal(k.sawIntro, true);
  }
});

t("E2(관찰) strip 이면 도입자 전 문구는 한 바이트도 안 내고 실패 사유로 쥔다(utf8 되읽기)", () => {
  const w = new ControlStreamWatch(true);
  assert.equal(w.feed(Buffer.from("lvly tmux-relay: attach 실패: connect ENOENT\n", "utf8")).length, 0);
  assert.equal(w.sawIntro, false);
  assert.match(w.failureText(), /attach 실패: connect ENOENT/);
});

t("E2b(관찰) 도입자가 조각 경계에 걸쳐도 실패 사유에 도입자 조각이 섞이지 않는다", () => {
  const w = new ControlStreamWatch(true);
  w.feed(Buffer.from("warming\n\x1bP10", "latin1"));
  w.feed(Buffer.from("00p%begin 2 2 0\n", "latin1"));
  assert.equal(w.sawIntro, true);
  assert.equal(w.failureText(), "warming\n");
});

t("E27 `%exit` 는 줄 머리에서만 — 값 안의 글자·%exited 는 끝이 아니다 · CR 둘·조각 경계·첫 줄·끝 줄바꿈 없음은 끝이다", () => {
  const judge = (strip: boolean, ...chunks: string[]): boolean => {
    const w = new ControlStreamWatch(strip);
    for (const c of chunks) w.feed(Buffer.from(c, "latin1"));
    return w.endedWithExit();
  };
  assert.equal(judge(false, INTRO + "%output %1 echo %exit"), false, "값 안의 글자");
  assert.equal(judge(false, INTRO + "%output %1 a\n%exited\n"), false, "%exited");
  assert.equal(judge(false, INTRO + "%output %1 bye\r\r\n%ex", "it\r\r\n\x1b\\"), true, "CR 둘 · 조각 경계");
  assert.equal(judge(true, INTRO + "%exit server exited\n"), true, "첫 줄");
  assert.equal(judge(false, INTRO + "%output %1 a\n%exit"), true, "끝 줄바꿈 없음");
});

t("E28 긴 마지막 조각(>64B)의 끝에 온 `%exit` 도 끝이다", () => {
  const w = new ControlStreamWatch(false);
  w.feed(Buffer.from(INTRO, "latin1"));
  w.feed(Buffer.from("%output %1 " + "x".repeat(300) + "\n%exit\n\x1b\\", "latin1"));
  assert.equal(w.endedWithExit(), true);
});

// ── 배선 (가짜 term · 가짜 소켓) ─────────────────────────────────────────────
t("E30 배선 — 스폰 주입이 실제로 불리고 중계 argv 가 주입값이며, 소켓으로 바이트가 나간다", async () => {
  const { sock, terms } = await start();
  assert.equal(terms.length, 1, "스폰 주입이 안 불렸다 — 아래 시험들이 아무것도 안 본다");
  assert.equal(terms[0]!.bin, "true");
  assert.deepEqual(terms[0]!.args.slice(0, 1), ["lively-test"]);
  terms[0]!.emit(INTRO + "%begin 1 1 0\n");
  assert.ok(sock.sent.length >= 1, "소켓으로 아무것도 안 나갔다");
  sock.close();
});

t("E1·E2·E3·E4·E5 ★ 끊긴 중계 — 소켓 유지 · 같은 argv · 도입자 전 문구 안 샘 · 도입자 한 번 · 줄 닫고 잇기 · 크기→입력→상태", async () => {
  const { sock, terms, id } = await start();
  terms[0]!.emit(INTRO + "%begin 1 1 0\n%end 1 1 0\n%output %1 hello");   // 줄 중간에서 멎는다
  sock.msg({ t: "r", c: 120, r: 40 });
  assert.deepEqual(terms[0]!.writes, ["refresh-client -C 120x40\n"]);
  terms[0]!.exit();                                                        // %exit 없이 끝났다
  sock.msg({ t: "i", d: "ls\r" });
  assert.equal(sock.closes, 0, "E1 끊김에서 소켓을 닫았다");
  await until("E1 다시 붙기 스폰", () => terms.length >= 2);
  assert.equal(terms.length, 2);
  assert.equal(terms[1]!.bin, terms[0]!.bin);
  assert.deepEqual(terms[1]!.args, terms[0]!.args);
  terms[1]!.emit("lvly tmux-relay: 준비 중\n");
  assert.equal(sock.text().includes("준비"), false, "E2 도입자 전 문구가 샜다");
  terms[1]!.emit(INTRO + "%begin 2 2 0\n");
  assert.equal(sock.text().split(INTRO).length - 1, 1, "E3 도입자가 두 번 갔다");
  assert.equal(sock.text(), INTRO + "%begin 1 1 0\n%end 1 1 0\n%output %1 hello" + "\n" + "%begin 2 2 0\n", "E4 줄을 닫고 잇지 않았다");
  assert.deepEqual(terms[1]!.writes, ["refresh-client -C 120x40\n", "send-keys -H 6c 73 0d\n", stateCmd(false) + "\n"], "E5 복구 순서");
  assert.equal(logsFor(id, ATTACH_ABSORBED_MSG).length, 1);
  assert.equal(logsFor(id, ATTACH_ABSORBED_MSG)[0]!.obj.attempts, 1);
  sock.close();
  assert.deepEqual(terms[1]!.killed, ["SIGTERM"]);
  assert.equal(attachRefCount(id), 0);
});

t("E4b 줄 끝에서 끊긴 스트림엔 줄바꿈을 더하지 않는다", async () => {
  const { sock, terms } = await start();
  establishThenCut(terms, "%output %1 done\n");
  await until("다시 붙기 스폰", () => terms.length >= 2);
  terms[1]!.emit(INTRO + "%begin 2 2 0\n");
  assert.equal(sock.text(), INTRO + "%output %1 done\n" + "%begin 2 2 0\n");
  sock.close();
});

t("E6 크기를 받은 적 없으면 크기 줄 없이 [입력, 상태]", async () => {
  const { sock, terms } = await start();
  establishThenCut(terms);
  sock.msg({ t: "i", d: "q" });
  await until("다시 붙기 스폰", () => terms.length >= 2);
  terms[1]!.emit(INTRO);
  assert.deepEqual(terms[1]!.writes, ["send-keys -H 71\n", stateCmd(false) + "\n"]);
  sock.close();
});

t("E7 끊긴 사이 입력이 없으면 [크기, 상태]", async () => {
  const { sock, terms } = await start();
  terms[0]!.emit(INTRO + "%begin 1 1 0\n");
  sock.msg({ t: "r", c: 90, r: 30 });
  terms[0]!.exit();
  await until("다시 붙기 스폰", () => terms.length >= 2);
  terms[1]!.emit(INTRO);
  assert.deepEqual(terms[1]!.writes, ["refresh-client -C 90x30\n", stateCmd(false) + "\n"]);
  sock.close();
});

t("E8 끊긴 사이 크기가 바뀌면 새 클라이언트의 첫 쓰기가 최신 크기다", async () => {
  const { sock, terms } = await start();
  terms[0]!.emit(INTRO + "%begin 1 1 0\n");
  sock.msg({ t: "r", c: 120, r: 40 });
  terms[0]!.exit();
  sock.msg({ t: "r", c: 100, r: 30 });
  await until("다시 붙기 스폰", () => terms.length >= 2);
  terms[1]!.emit(INTRO);
  assert.equal(terms[1]!.writes[0], "refresh-client -C 100x30\n");
  sock.close();
});

t("E9(경계) 끊긴 사이 입력 1001개 — 1000개만 가고 1001번째는 버린다", async () => {
  const { sock, terms } = await start({ delays: [30] });
  establishThenCut(terms);
  for (let k = 0; k < 1000; k++) sock.msg({ t: "i", d: "a" });
  sock.msg({ t: "i", d: "b" });
  await until("다시 붙기 스폰", () => terms.length >= 2);
  terms[1]!.emit(INTRO);
  assert.equal(terms[1]!.writes.length, 1001, "입력 1000 + 상태 1");
  assert.equal(terms[1]!.writes.filter((w) => w === "send-keys -H 61\n").length, 1000);
  assert.equal(terms[1]!.writes.some((w) => w.includes("62")), false, "1001번째가 갔다");
  sock.close();
});

t("E10 tmux 가 `%exit` 로 끝냈으면 곧바로 닫고 다시 안 연다(의도해서 뗀 클라이언트를 몰래 되붙이지 않는다)", async () => {
  const { sock, terms, spawns } = await start();
  terms[0]!.emit(INTRO + "%output %1 x\n%exit detached\n\x1b\\");
  terms[0]!.exit();
  assert.equal(sock.closes, 1);
  await tick(40);
  assert.equal(spawns(), 1);
});

t("E11 중계가 아니면(로컬 tmux) 끊겨도 곧바로 닫는다", async () => {
  const { sock, terms, spawns } = await start({ relay: [] });
  establishThenCut(terms);
  assert.equal(sock.closes, 1);
  await tick(40);
  assert.equal(spawns(), 1);
});

t("E12 첫 attach 가 control 스트림을 한 번도 못 열었으면 곧바로 닫는다", async () => {
  const { sock, terms, spawns } = await start();
  terms[0]!.emit("sh: 1: tmux: not found\n");
  terms[0]!.exit();
  assert.equal(sock.closes, 1);
  await tick(40);
  assert.equal(spawns(), 1);
});

t("E13 다시 붙기가 «세션 없음» 을 받으면 더 기다리지 않고 닫는다 · 흡수 포기(세션 없음) · 문구는 안 샌다", async () => {
  const { sock, terms, id, spawns } = await start({
    onSpawn: (ft, n) => { if (n === 1) { ft.emit("can't find session: box-x\r\n"); ft.exit(); } },
  });
  establishThenCut(terms);
  await until("세션 없음으로 닫힘", () => sock.closes === 1);
  await tick(40);
  assert.equal(spawns(), 2, "세션 없음 뒤에 또 띄웠다");
  assert.equal(logsFor(id, ATTACH_ABSORB_GAVE_UP_MSG).map((l) => l.obj.reason).join(","), "session-gone");
  assert.equal(sock.text().includes("can't find"), false);
});

t("E14 브로커가 아직 안 선 동안(일시 실패 ×2)은 기다렸다 다시 붙고, 선 순간 흡수한다 · 실패 문구는 안 샌다", async () => {
  const { sock, terms, id } = await start({
    delays: [5],
    onSpawn: (ft, n) => {
      if (n === 1 || n === 2) { ft.emitUtf8("lvly tmux-relay: attach 실패: connect ENOENT /run/lvly-t/x/sock/session.sock\n"); ft.exit(); }
      if (n === 3) ft.emit(INTRO + "%begin 3 3 0\n");
    },
  });
  establishThenCut(terms);
  await until("흡수 기록", () => logsFor(id, ATTACH_ABSORBED_MSG).length === 1);
  assert.equal(terms.length, 4);
  assert.equal(sock.closes, 0);
  assert.deepEqual(logsFor(id, ATTACH_ABSORBED_MSG).map((l) => l.obj.attempts), [3]);
  assert.equal(sock.text().includes("ENOENT"), false);
  sock.close();
});

t("E15 다시 붙기가 아무 문구 없이 끝나도 일시로 보고 다시 시도한다", async () => {
  const { sock, terms, id } = await start({
    delays: [5],
    onSpawn: (ft, n) => { if (n === 1) ft.exit(); if (n === 2) ft.emit(INTRO); },
  });
  establishThenCut(terms);
  await until("흡수 기록", () => logsFor(id, ATTACH_ABSORBED_MSG).length === 1);
  assert.equal(terms.length, 3);
  assert.equal(sock.closes, 0);
  assert.deepEqual(logsFor(id, ATTACH_ABSORBED_MSG).map((l) => l.obj.attempts), [2]);
  sock.close();
});

t("E16 다시 띄우기 자체가 예외를 던져도 일시로 보고 다시 시도한다", async () => {
  const { sock, terms, id, spawns } = await start({
    delays: [5],
    throwOn: (n) => n === 1,
    onSpawn: (ft, n) => { if (n === 2) ft.emit(INTRO); },
  });
  establishThenCut(terms);
  await until("흡수 기록", () => logsFor(id, ATTACH_ABSORBED_MSG).length === 1);
  assert.equal(spawns(), 3, "예외 1 + 성공 1 이어야 한다");
  assert.equal(sock.closes, 0);
  assert.deepEqual(logsFor(id, ATTACH_ABSORBED_MSG).map((l) => l.obj.attempts), [2]);
  sock.close();
});

t("E17 예산을 넘기면 종전처럼 닫는다 · 흡수 포기(예산) · 닫은 뒤엔 더 안 띄운다", async () => {
  const { sock, terms, id, spawns } = await start({
    delays: [10], budgetMs: 35,
    onSpawn: (ft, n) => { if (n > 0) { ft.emitUtf8("lvly tmux-relay: attach 실패: 503: node channel unavailable\n"); ft.exit(); } },
  });
  establishThenCut(terms);
  await until("예산 초과로 닫힘", () => sock.closes === 1);
  assert.equal(logsFor(id, ATTACH_ABSORB_GAVE_UP_MSG).map((l) => l.obj.reason).join(","), "budget");
  const n = spawns();
  await tick(60);
  assert.equal(spawns(), n, "닫은 뒤에도 띄웠다");
});

t("E20 기다리는 사이 소켓이 닫히면 다시 안 띄운다 — 종료 기록 1 · 참조 0", async () => {
  const { sock, terms, id, spawns } = await start({ delays: [20] });
  establishThenCut(terms);
  sock.close();
  await tick(60);
  assert.equal(spawns(), 1);
  assert.equal(attachRefCount(id), 0);
  assert.equal(logsFor(id, "ws attach 종료").length, 1);
});

t("E20b 소켓이 닫힌 뒤 늦게 온 출력 조각은 브라우저로 안 보낸다", async () => {
  const { sock, terms } = await start();
  establishThenCut(terms);
  await until("다시 붙기 스폰", () => terms.length >= 2);
  terms[1]!.emit(INTRO + "%begin 2 2 0\n");
  sock.close();
  const before = sock.sent.length;
  terms[1]!.emit("%output %1 late\n");
  assert.equal(sock.sent.length, before);
});

//  E20 과 모양이 다르다 — E20 은 «대기 타이머가 걸린 채» 닫히고(타이머 걷기·재띄우기의 closed 확인 두 겹이 지킨다),
//   E20c 는 «다시 붙는 시도가 **도는 중**에» 닫힌다(그 시도의 뒤늦은 exit 를 끊김으로 안 읽게 하는 closed 표지가 지킨다).
t("E20c 다시 붙는 시도가 도는 중(도입자 전)에 소켓이 닫히면, 그 시도의 끝을 끊김으로 읽지 않는다 — 더 안 띄운다", async () => {
  const { sock, terms, spawns } = await start({ delays: [5] });
  establishThenCut(terms);
  await until("다시 붙기 시도 스폰", () => spawns() >= 2);
  sock.close();                                                   // 사람이 탭을 닫았다
  assert.deepEqual(terms[1]!.killed, ["SIGTERM"]);
  terms[1]!.exit();                                               // 회수(SIGTERM)의 결과로 그 시도가 끝난다
  await tick(40);
  assert.equal(spawns(), 2, "닫힌 소켓에 다시 붙기를 또 띄웠다");
});

t("E21 요동 — 다시 붙자마자 또 끊기면 같은 끊김으로 누적해 상한에서 닫는다(스폰 = 1 + 상한)", async () => {
  const { sock, terms, id, spawns } = await start({
    delays: [1], budgetMs: 60_000, stableMs: 60_000,
    onSpawn: (ft, n) => { if (n > 0) { ft.emit(INTRO + "%begin 9 9 0\n"); ft.exit(); } },
  });
  establishThenCut(terms);
  await until("상한에서 닫힘", () => sock.closes === 1, 5_000);
  assert.equal(spawns(), 1 + RELAY_REATTACH_MAX);
  assert.equal(logsFor(id, ATTACH_ABSORB_GAVE_UP_MSG).map((l) => l.obj.reason).join(","), "budget");
});

t("E22b 안정 시간을 넘겨 버틴 뒤의 끊김은 새 끊김이다 — 시도를 1부터 다시 센다", async () => {
  const { sock, terms, id } = await start({ delays: [5], stableMs: 50 });
  establishThenCut(terms);
  await until("첫 다시 붙기 스폰", () => terms.length >= 2);
  terms[1]!.emit(INTRO + "%begin 2 2 0\n");
  await tick(150);                                  // 안정 시간(50ms)을 넉넉히 넘겨 버텼다
  terms[1]!.exit();
  await until("두 번째 다시 붙기 스폰", () => terms.length >= 3);
  terms[2]!.emit(INTRO + "%begin 3 3 0\n");
  assert.deepEqual(logsFor(id, ATTACH_ABSORBED_MSG).map((l) => l.obj.attempts), [1, 1]);
  assert.equal(sock.closes, 0);
  sock.close();
});

t("E23 흡수 뒤 곧 tmux 가 `%exit` 로 끝내면 닫되, 그건 흡수 포기가 아니다", async () => {
  const { sock, terms, id } = await start();
  establishThenCut(terms);
  await until("다시 붙기 스폰", () => terms.length >= 2);
  terms[1]!.emit(INTRO + "%begin 2 2 0\n");
  terms[1]!.emit("%exit\n\x1b\\");
  terms[1]!.exit();
  assert.equal(sock.closes, 1);
  assert.equal(logsFor(id, ATTACH_ABSORB_GAVE_UP_MSG).length, 0);
});

// ── 게이트와의 계약 ─────────────────────────────────────────────────────────
t("E29 게이트 계약 — 흡수 두 메시지는 글자 그대로 · 흡수 관련 메시지 어디에도 «종료» 가 없다", () => {
  assert.equal(ATTACH_ABSORBED_MSG, "ws attach 흡수");
  assert.equal(ATTACH_ABSORB_GAVE_UP_MSG, "ws attach 흡수 포기");
  const absorbLogs = logs.filter((l) => /흡수|중계 끊김/.test(l.msg)).map((l) => l.msg);
  assert.ok(absorbLogs.length > 0, "흡수 관련 로그를 하나도 못 봤다 — 이 단언이 아무것도 안 본다");
  for (const m of new Set(absorbLogs)) assert.equal(m.includes("종료"), false, m);
});

// ⚠ 맨 끝 — killAttachedPtys 는 프로세스 전역 «종료 중» 표지를 세운다(되돌리는 길이 없다).
//  방어가 두 겹이라(대기 타이머를 걷는다 · «종료 중» 표지) **두 모양을 함께** 친다 — 한 모양만 치면 한 겹이 죽어도 초록이다.
t("E24 프로세스 종료(일괄 회수) 뒤에는 다시 붙지 않고 소켓을 남기지 않는다 — ① 이미 걸린 대기 ② 회수한 attach 의 뒤늦은 exit", async () => {
  const waiting = await start({ delays: [20] });
  establishThenCut(waiting.terms);                           // ① 다시 붙기 대기가 걸린 채로 종료가 온다
  const alive = await start({ delays: [20] });
  alive.terms[0]!.emit(INTRO + "%begin 1 1 0\n");          // ② 살아 있던 attach — 회수(SIGKILL) 뒤에 exit 가 온다
  killAttachedPtys();
  assert.deepEqual(alive.terms[0]!.killed, ["SIGKILL"]);
  alive.terms[0]!.exit();
  await tick(60);
  assert.equal(waiting.spawns(), 1, "① 종료 뒤에 대기가 attach 를 띄웠다");
  assert.equal(waiting.sock.closes, 1, "① 종료가 다시 붙기를 기다리던 소켓을 안 닫았다(흡수 전엔 닫혔다)");
  assert.equal(alive.spawns(), 1, "② 회수한 attach 의 exit 를 끊김으로 읽고 다시 띄웠다");
  assert.equal(alive.sock.closes, 1, "② 회수한 attach 의 소켓이 안 닫혔다");
});

let pass = 0;
const failed: string[] = [];
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log(`ok  ${name}`); }
  catch (err) { failed.push(name); console.log(`FAIL ${name}\n     ${(err as Error)?.message ?? String(err)}`); }
}
console.log(`\n${pass} 통과 / ${failed.length} 실패`);
process.exit(failed.length ? 1 : 0);
