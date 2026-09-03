#!/usr/bin/env node
// 통합(실 tmux) — 세션 호스트가 **진짜 attach** 를 소유한다 (#2600 T1).
//
// 왜 이 파일이 따로 있나: 단위 시험(`session-host.test.ts`)은 attach 본체를 갈아끼워 **살림만** 본다.
//  그건 «장부가 맞나» 를 재지 «실제로 붙나» 를 재지 않는다. 이 프로젝트가 손댄 것이 바로 그 경계라,
//  한 번은 **진짜 tmux 클라이언트 수**를 눈으로 봐야 한다(문구가 아니라 부작용으로 단언한다는 규율).
//
//  여기서 재는 부작용은 `tmux list-clients` 의 **줄 수**다 — attach 하나당 클라이언트 하나.
//  그게 이 변경의 핵심 불변식(#2148)을 그대로 드러낸다: 탭 둘이 붙었다가 하나가 닫혀도
//  **남은 클라이언트가 살아 있어야** 하고, 마지막이 닫힐 때만 유령 정리가 나간다.
//
// 실행: node --env-file-if-exists=.env scripts/session-host-attach.itest.mjs
//   (기본 `npm test` 는 *.itest.mjs 를 수집하지 않는다 — 실 자원을 쓰므로 수동 계층이다)
//   ⚠ dist/ 가 먼저 있어야 한다(`npx tsc -p tsconfig.json`).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { SessionHost } from "../dist/terminal/session-host.js";
import { attachRefCount } from "../dist/terminal/terminal-pty.js";

const TMUX = process.env.TMUX_BIN || "tmux";
// 사람의 진짜 세션과 절대 안 겹치게 — 이 이름만 만들고 이 이름만 지운다.
const SID = `box-t1itest-${Math.random().toString(16).slice(2, 10)}`;

const tmux = (...args) => execFileSync(TMUX, args, { encoding: "utf8", timeout: 10_000 });
const clientCount = () => {
  try { return tmux("list-clients", "-t", SID).trim().split("\n").filter(Boolean).length; }
  catch { return 0; }   // 세션이 없으면 0
};

/** attachSession 이 요구하는 최소 소켓 — 바이트는 버리고 close 만 흘린다. */
function sock() {
  const ls = new Map();
  const s = {
    sent: 0,
    send() { s.sent++; },
    close() { s.fire("close"); },
    on(ev, fn) { const a = ls.get(ev) ?? []; a.push(fn); ls.set(ev, a); },
    fire(ev) { for (const fn of ls.get(ev) ?? []) fn(); },
  };
  return s;
}

let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`ok  ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}\n     ${e.message}`); } };

try {
  tmux("new-session", "-d", "-s", SID);
  assert.equal(clientCount(), 0, "새 세션엔 클라이언트가 없어야 한다");

  const empties = [];
  const host = new SessionHost({ lifetime: "ephemeral", onSessionEmpty: (id) => empties.push(id) });

  // ── 탭 둘이 같은 판을 본다 ──
  const a = sock(), b = sock();
  host.attach(a, SID);
  host.attach(b, SID);
  await sleep(2500);   // tmux -CC 클라이언트가 실제로 붙을 시간

  check("① 소켓 2개 → 진짜 tmux 클라이언트 2개", () => {
    assert.equal(clientCount(), 2, `list-clients 가 ${clientCount()} 줄 — attach 가 실제로 안 붙었다`);
    assert.equal(host.socketsFor(SID), 2);
    assert.equal(attachRefCount(SID), 2, "코어 참조수(#2148)도 2 여야 한다");
    assert.ok(a.sent > 0 && b.sent > 0, "pty 출력이 소켓으로 흐르지 않았다 — 껍데기만 붙은 것이다");
  });

  // ── ★ 하나를 닫는다: 남은 화면이 끊기면 안 된다 ──
  a.fire("close");
  await sleep(1500);

  check("② 하나 닫힘 → 남은 클라이언트 1개 생존 · '비었다' 통지 없음", () => {
    assert.equal(clientCount(), 1, "★ 남아서 보고 있는 사람의 화면이 끊겼다(#2148 회귀)");
    assert.equal(host.socketsFor(SID), 1);
    assert.deepEqual(empties, [], "마지막이 아닌데 통지했다");
  });

  // ── 마지막을 닫는다: 통지 + 유령 정리 ──
  b.fire("close");
  await sleep(2000);

  check("③ 마지막 닫힘 → 통지 1회 · 클라이언트 0 · 참조수 0", () => {
    assert.deepEqual(empties, [SID]);
    assert.equal(clientCount(), 0, "유령 클라이언트가 남았다 — detach-client 가 안 나갔다");
    assert.equal(attachRefCount(SID), 0);
    assert.equal(host.sessionCount(), 0);
  });

  check("④ 세션 자체는 살아 있다 — attach 는 클라이언트일 뿐 세션을 안 죽인다", () => {
    const alive = tmux("list-sessions", "-F", "#{session_name}").split("\n").includes(SID);
    assert.ok(alive, "attach 를 끊었더니 세션이 죽었다 — 회수/복원 계약이 깨진다");
  });

  // ── 종료 회수(#687) ──
  const c = sock();
  host.attach(c, SID);
  await sleep(2000);
  const before = clientCount();
  host.shutdown();
  await sleep(1500);

  check("⑤ shutdown → 이 호스트가 띄운 attach PTY 가 전부 회수된다(#687 고아 방지)", () => {
    assert.equal(before, 1, "회수 시험 전에 클라이언트가 1개여야 한다");
    assert.equal(clientCount(), 0, "shutdown 뒤에도 attach 클라이언트가 남았다 — PTY 고아가 된다");
  });
} finally {
  try { tmux("kill-session", "-t", SID); } catch { /* 이미 없다 */ }
  console.log(`\n정리: ${SID} 제거`);
}

if (failed) { console.error(`\n✗ ${failed}건 실패`); process.exit(1); }
console.log("\n✓ 세션 호스트 실 tmux attach 왕복 통과(#2600 T1)");
