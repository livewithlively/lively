// 대화창의 «이미 기록에 있는 말» 판정 (#4819) — 값으로 고정한다(web/lib/outbox-echo.ts).
//
//  무엇이 문제였나(상민님 신고 2026-10-16): 답까지 끝난 말이 회수된 세션을 다시 열면 맨 아래에
//   «보냈지만 세션 기록에서 확인되지 않았어요 — 안 들어갔을 수 있어요» 로 또 그려졌다. 서버 큐의 «미확인» 은 친 뒤 15초 창의
//   판정일 뿐인데(Claude Code 는 UserPromptSubmit 훅이 끝난 뒤에야 그 말을 기록에 적는다), 화면은 그 행을 기록과 맞춰 보지 않았다.
//  사양·엣지 표: 스크래치패드 spec-4819.md 의 E 행 — 아래 이름의 번호가 그 행이다. 화면 장면(O 행)은 outbox-late-echo-runtime.test.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.SRC_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const ok = (cond, name, detail = "") => { assert.ok(cond, `${name}${detail ? " — " + detail : ""}`); pass++; console.log(`ok  ${name}`); };

const tmp = mkdtempSync(path.join(tmpdir(), "outbox-echo-"));
try {
  execFileSync(path.join(root, "node_modules/.bin/tsc"),
    [path.join(root, "web/lib/outbox-echo.ts"), "--outDir", tmp, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
    { stdio: "inherit" });
  const { unconfirmedRow, echoedInTurns, ECHO_SKEW_MS } = await import(path.join(tmp, "outbox-echo.js"));

  // 화면의 말 대조 규칙(session-chat.ts sameSaid)과 같은 모양 — 판정이 받은 규칙을 그대로 쓰는지 보려고 그대로 옮겨 둔다.
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const sameSaid = (a, b) => { const na = norm(a), nb = norm(b); if (!na || !nb) return false; if (na === nb) return true; return na.length >= 24 && nb.length >= 24 && na.slice(0, 64) === nb.slice(0, 64); };
  const QUEUED = "2026-10-16T07:58:32.321Z";
  const SAID = "자료 공개범위 설정 끈 곳에는 전체에게 보이게해. 단, 이거는 공개범위 설정여부와 무관하게 먼저 검토하면 되는 일이잖아.";
  const row = (o = {}) => ({ id: 131295, text: SAID, status: "sent", last_error: "echo-unconfirmed", created_at: QUEUED, ...o });
  const at = (ms) => new Date(Date.parse(QUEUED) + ms).toISOString();

  // ── E1 — «쳤는데 못 봤다» 둘만 ─────────────────────────────────────────────
  ok(unconfirmedRow(row()) === true, "E1a sent·echo-unconfirmed 는 기록이 사실을 말해 줄 수 있는 상태다");
  ok(unconfirmedRow(row({ status: "failed", last_error: "send: host-unknown" })) === true, "E1b failed·send: host-unknown(호스트가 쳤는지 모름)도 같다");
  for (const [st, err] of [["failed", "not-ready"], ["failed", "session-gone"], ["failed", "send: text"], ["queued", null], ["queued", "unreachable"], ["sending", null], ["sent", "echo-unreadable"], ["sent", "control-no-echo"]]) {
    ok(unconfirmedRow(row({ status: st, last_error: err })) === false, `E1c ${st}·${err} 는 아니다(치지도 않았거나 대기 중이거나 화면이 안 다루는 상태)`);
  }
  ok(unconfirmedRow({}) === false, "E1d 상태가 없는 행(부재 입력)은 아니다");

  // ── E2 — 기록의 사람 말 턴에 행보다 뒤에 적힌 같은 말 ──────────────────────────
  ok(echoedInTurns(row(), [{ text: SAID, ts: "2026-10-16T07:59:07.361Z" }], sameSaid) === true, "E2a 행보다 35초 뒤 적힌 같은 말(실측) → 기록에 있다");
  ok(echoedInTurns(row(), [{ text: SAID, ts: at(-ECHO_SKEW_MS) }], sameSaid) === true, "E2b 경계 — 정확히 큐−5초는 있다");
  ok(echoedInTurns(row(), [{ text: SAID, ts: at(-ECHO_SKEW_MS - 1) }], sameSaid) === false, "E2c 경계 — 그 1ms 앞은 없다(같은 지시를 두 번 보낸 앞 것)");
  ok(echoedInTurns(row(), [{ text: SAID, ts: "2026-10-16T07:41:00Z" }], sameSaid) === false, "E2d 행보다 한참 앞에 적힌 같은 말은 증거가 아니다");
  ok(echoedInTurns(row(), [{ text: SAID }], sameSaid) === false, "E2e 시각 없는 턴은 증거가 아니다");
  ok(echoedInTurns(row(), [{ text: "다른 말", ts: at(30_000) }, { text: null, ts: at(30_000) }, { text: "", ts: at(30_000) }], sameSaid) === false,
    "E2f 다른 말·글 없는 턴(AI 만 한 턴)은 증거가 아니다");
  ok(echoedInTurns(row({ text: "  " }), [{ text: "  ", ts: at(30_000) }], () => true) === false, "E2g 빈 글 행은 기록에 있다고 하지 않는다(대조 규칙이 뭐라 하든)");
  ok(echoedInTurns(row({ created_at: "어제" }), [{ text: SAID, ts: at(30_000) }], sameSaid) === false, "E2h 큐 시각이 깨진 행(부재 입력)은 판정하지 않는다");
  ok(echoedInTurns(row(), [], sameSaid) === false, "E2i 그린 턴이 없으면 없다");
  let calls = 0;
  ok(echoedInTurns(row(), [{ text: "머리만 같은 글", ts: at(30_000) }], (a, b) => { calls++; return a === "머리만 같은 글" && b === SAID; }) === true && calls === 1,
    "E2j 같은 말인지는 화면이 넘긴 규칙(sameSaid)으로 본다 — (턴 글, 행 글) 순서로 묻는다");
} finally { rmSync(tmp, { recursive: true, force: true }); }

console.log(`\n${pass} passed — 대화창 «이미 기록에 있는 말» 판정(#4819)`);
