// 대화창의 «이미 기록에 있는 말» 판정 (#4819) — 값으로 고정한다(web/lib/outbox-echo.ts).
//
//  무엇이 문제였나(상민님 신고 2026-10-16): 답까지 끝난 말이 회수된 세션을 다시 열면 맨 아래에
//   «보냈지만 세션 기록에서 확인되지 않았어요 — 안 들어갔을 수 있어요» 로 또 그려졌다. 서버 큐의 «미확인» 은 친 뒤 15초 창의
//   판정일 뿐인데(Claude Code 는 UserPromptSubmit 훅이 끝난 뒤에야 그 말을 기록에 적는다), 화면은 그 행을 기록과 맞춰 보지 않았다.
//  사양·엣지 표: 지식 outbox-late-echo-false-unconfirmed-4819 §사양 의 E 행 — 아래 이름의 번호가 그 행이다. 화면 장면(O 행)은
//   outbox-late-echo-runtime.test. E3 은 화면 판정과 서버 판정(src/sessions/outbox-late-echo.ts — dist 를 읽는다)이 같은 규칙인지
//   같은 표로 맞춘다 — 화면이 더 느슨하면 서버가 «미확인» 이라 한 말을 화면만 지운다(격리 리뷰 재현).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.SRC_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const ok = (cond, name, detail = "") => { assert.ok(cond, `${name}${detail ? " — " + detail : ""}`); pass++; console.log(`ok  ${name}`); };

const tmp = mkdtempSync(path.join(tmpdir(), "outbox-echo-"));
try {
  execFileSync(path.join(distRoot, "node_modules/.bin/tsc"),
    [path.join(root, "web/lib/outbox-echo.ts"), "--outDir", tmp, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
    { stdio: "inherit" });
  const { unconfirmedRow, echoedInTurns, samePrompt, exactPrompt, sameSaid, echoComparable, ECHO_SKEW_MS, PROMPT_HEAD } = await import(path.join(tmp, "outbox-echo.js"));

  const QUEUED = "2026-10-16T07:58:32.321Z";
  const MARKED = "2026-10-16T07:59:29.849Z";                // 서버가 «미확인» 으로 마감한 때(행의 updated_at)
  const SAID = "자료 공개범위 설정 끈 곳에는 전체에게 보이게해. 단, 이거는 공개범위 설정여부와 무관하게 먼저 검토하면 되는 일이잖아.";
  const row = (o = {}) => ({ id: 131295, text: SAID, status: "sent", last_error: "echo-unconfirmed", created_at: QUEUED, updated_at: MARKED, ...o });
  const at = (base, ms) => new Date(Date.parse(base) + ms).toISOString();

  // ── E1 — «쳤는데 못 봤다» 둘만 ─────────────────────────────────────────────
  ok(unconfirmedRow(row()) === true, "E1a sent·echo-unconfirmed 는 기록이 사실을 말해 줄 수 있는 상태다");
  ok(unconfirmedRow(row({ status: "failed", last_error: "send: host-unknown" })) === true, "E1b failed·send: host-unknown(호스트가 쳤는지 모름)도 같다");
  for (const [st, err] of [["failed", "not-ready"], ["failed", "session-gone"], ["failed", "send: text"], ["queued", null], ["queued", "unreachable"], ["sending", null], ["sent", "echo-unreadable"], ["sent", "control-no-echo"]]) {
    ok(unconfirmedRow(row({ status: st, last_error: err })) === false, `E1c ${st}·${err} 는 아니다(치지도 않았거나 대기 중이거나 화면이 안 다루는 상태)`);
  }
  ok(unconfirmedRow({}) === false, "E1d 상태가 없는 행(부재 입력)은 아니다");

  // ── E2 — 증거 창 안에 적힌 같은 말인 사람 말 턴 ──────────────────────────────
  ok(echoedInTurns(row(), [{ text: SAID, ts: "2026-10-16T07:59:07.361Z" }]) === true, "E2a 행이 생긴 뒤·마감 전 제출된 같은 말(실측 07:59:07) → 기록에 있다");
  ok(echoedInTurns(row(), [{ text: SAID, ts: at(QUEUED, -ECHO_SKEW_MS) }]) === true, "E2b 하한 경계 — 정확히 큐−5초는 있다");
  ok(echoedInTurns(row(), [{ text: SAID, ts: at(QUEUED, -ECHO_SKEW_MS - 1) }]) === false, "E2c 하한 경계 — 그 1ms 앞은 없다(같은 지시를 두 번 보낸 앞 것)");
  const LONG = "긴 지시 — " + "자료 공개범위를 단위마다 정하게 하고 ".repeat(8) + "꼬리 원문";
  const LONG_OTHER = LONG.slice(0, PROMPT_HEAD) + " — 꼬리가 전혀 다른 다른 지시";
  const longRow = (o = {}) => row({ text: LONG, ...o });
  ok(echoedInTurns(longRow(), [{ text: LONG_OTHER, ts: at(MARKED, ECHO_SKEW_MS) }]) === true, "E2d 제때 끝 경계 — 정확히 마감+5초엔 머리 160자만 같아도 있다(긴 글 꼬리 뒤섞임)");
  ok(echoedInTurns(longRow(), [{ text: LONG_OTHER, ts: at(MARKED, ECHO_SKEW_MS + 1) }]) === false, "E2e 그 1ms 뒤엔 머리만 같은 말은 없다(꼬리가 다른 다른 지시)");
  ok(echoedInTurns(longRow(), [{ text: LONG, ts: at(MARKED, ECHO_SKEW_MS + 1) }]) === true, "E2e' 그 1ms 뒤라도 글이 통째로 같으면 있다");
  ok(echoedInTurns(row(), [{ text: SAID, ts: "2026-10-16T10:30:00Z" }]) === true, "E2e'' 입력칸에 남은 글을 두 시간 뒤 Enter 로 보냈다 — 있다");
  ok(echoedInTurns(row(), [{ text: SAID }]) === false, "E2f 시각 없는 턴은 증거가 아니다");
  ok(echoedInTurns(row(), [{ text: "다른 말", ts: at(QUEUED, 30_000) }, { text: null, ts: at(QUEUED, 30_000) }, { text: "", ts: at(QUEUED, 30_000) }]) === false,
    "E2g 다른 말·글 없는 턴(AI 만 한 턴)은 증거가 아니다");
  ok(echoedInTurns(row({ text: "  " }), [{ text: "  ", ts: at(QUEUED, 30_000) }]) === false, "E2h 빈 글 행은 기록에 있다고 하지 않는다");
  ok(echoedInTurns(row({ created_at: "어제" }), [{ text: SAID, ts: at(QUEUED, 30_000) }]) === false, "E2i 큐 시각이 깨진 행(부재 입력)은 판정하지 않는다");
  ok(echoedInTurns(row({ updated_at: "" }), [{ text: SAID, ts: at(QUEUED, 30_000) }]) === false, "E2j 마감 시각이 깨진 행(부재 입력)은 판정하지 않는다");
  ok(echoedInTurns(row(), []) === false, "E2k 그린 턴이 없으면 없다");
  const head64 = SAID.slice(0, 64) + " 그런데 뒤는 전혀 다른 말이다.";
  ok(echoedInTurns(row(), [{ text: head64, ts: at(QUEUED, 30_000) }]) === false, "E2l 앞 64자만 같은 다른 말은 증거가 아니다(화면의 말풍선 잇기 규칙보다 엄격)");

  // ── E3 — 계약: 화면 판정 ≡ 서버 판정 ─────────────────────────────────────────
  const serverJs = path.join(distRoot, "dist/sessions/outbox-late-echo.js");
  ok(existsSync(serverJs), "E3 전제 — 서버 판정 모듈이 빌드돼 있다(npm run build)", serverJs);
  const server = await import(pathToFileURL(serverJs).href);
  ok(PROMPT_HEAD === server.LATE_ECHO_HEAD && ECHO_SKEW_MS === server.LATE_ECHO_SKEW_MS, "E3a 머리 길이·시계 차 상수가 서버와 같다",
    JSON.stringify({ PROMPT_HEAD, head: server.LATE_ECHO_HEAD, ECHO_SKEW_MS, skew: server.LATE_ECHO_SKEW_MS }));
  const h = "가".repeat(PROMPT_HEAD);
  const pairs = [
    [SAID, SAID], [SAID, SAID + " "], ["첫 줄\n둘째  줄", "첫 줄 둘째 줄"], ["진행해", "진행해줘"], ["진행해줘", "진행해"],
    [SAID, head64], [h, h + " 덧붙임"], [h + "나", h + "다 덧붙임"], ["나" + h, "다" + h], ["", ""], [" ", "  "], ["a", "a"],
    ["/exit", "<command-name>/exit</command-name>"],
  ];
  //  #4852 — Claude Code 가 지워 적는 글자(보이지 않는 글자·제어 글자·ANSI 색 코드)가 한쪽에만 있다. 기대값까지 잰다(같은 규칙인 것만으론
  //   «둘 다 틀림» 을 못 잡는다). 지워지는 글자를 빼도 다른 말은 다른 말이다.
  const unseenPairs = [
    ["복사해 온\u200b글\u200b입니다", "복사해 온글입니다", true], ["\ufeff진행해", "진행해", true], ["로그: \x1b[31mERROR\x1b[0m 끝 \x07벨", "로그: ERROR 끝 벨", true],
    ["가족 👨\u200d👩\u200d👧 사진", "가족 👨👩👧 사진", true], ["하트 ❤\ufe0f", "하트 ❤", true], ["a\tb", "a    b", true], ["방향\u200f표시", "방향표시", true],
    ["복사해 온\u200b글", "복사해 온 다른 글", false], ["\x1b[31mERROR\x1b[0m", "WARN", false], ["진행\u200b해", "진행해줘", false],
    //  격리 리뷰 — Claude Code 가 지우는데 우리가 안 지우던 것(한글 채움 문자 · CGJ · 문자집합 고르기 · 8비트 CSI · ESC+글자 · VT/FF/NEL)
    ["안녕\u{3164}하세요", "안녕하세요", true], ["a\u{34F}b \u{FFA0}끝", "ab 끝", true], ["ok \x1b(B\x1b[m done", "ok done", true],
    ["a\u{9B}31mERR b", "aERR b", true], ["저장\x1b7 끝", "저장 끝", true], ["세로\x0b탭 \u{85}끝", "세로\n탭 \n끝", true], ["세로\x0b탭", "세로탭", false],
  ];
  for (const [a, b, want] of unseenPairs) {
    ok(samePrompt(a, b) === want && server.samePrompt(a, b) === want && exactPrompt(a, b) === want && server.exactPrompt(a, b) === want,
      `E3e 지워 적히는 글자 — ${JSON.stringify(a).slice(0, 28)} vs ${JSON.stringify(b).slice(0, 24)} → ${want}`,
      `화면 ${samePrompt(a, b)}/${exactPrompt(a, b)} · 서버 ${server.samePrompt(a, b)}/${server.exactPrompt(a, b)}`);
    pairs.push([a, b]);
  }
  for (const [a, b] of pairs) {
    ok(samePrompt(a, b) === server.samePrompt(a, b), `E3b 같은 말 판정이 서버와 같다 — ${JSON.stringify(a).slice(0, 24)} vs ${JSON.stringify(b).slice(0, 24)}`,
      `화면 ${samePrompt(a, b)} · 서버 ${server.samePrompt(a, b)}`);
  }
  const win = server.echoWindowOf({ created_at: QUEUED, updated_at: MARKED });
  for (const ms of [win.notBefore - 1, win.notBefore, Date.parse(QUEUED) + 30_000, win.userNotAfter, win.userNotAfter + 1, win.userNotAfter + 3_600_000]) {
    const ts = new Date(ms).toISOString();
    for (const [said, line] of [[SAID, SAID], [LONG, LONG], [LONG, LONG_OTHER]]) {
      const srv = server.scanLinesForPrompt([{ type: "user", timestamp: ts, message: { role: "user", content: line } }], said, win).found;
      const cli = echoedInTurns(row({ text: said }), [{ text: line, ts }]);
      ok(cli === srv, `E3c 사람 말 줄의 증거 판정이 서버와 같다 — ${ts} · ${said === line ? "같은 글" : "머리만 같음"}`, `화면 ${cli} · 서버 ${srv}`);
    }
  }
  for (const [a, b] of pairs) ok(exactPrompt(a, b) === server.exactPrompt(a, b), `E3d 통째로 같은 글 판정이 서버와 같다 — ${JSON.stringify(a).slice(0, 24)} vs ${JSON.stringify(b).slice(0, 24)}`);

  // ── E3f — 펴기 사본: 화면 번들의 사본(web/lib/outbox-echo echoComparable) ≡ 서버 정본(outbox-echo-scan echoComparable — submit-check 의 집합) ──
  //  모든 코드 포인트와 제어열 표로 잰다(#4852 — 사본을 손으로 맞추니 한 글자만 갈려도 «미확인»·두 번 보임이 화면에서만 난다).
  const outboxJs = path.join(distRoot, "dist/sessions/outbox-echo-scan.js");   // 판정 한 벌(#4851) — 친 직후·늦은 에코가 함께 쓴다
  ok(existsSync(outboxJs), "E3f 전제 — 서버 판정 모듈이 빌드돼 있다", outboxJs);
  const outbox = await import(pathToFileURL(outboxJs).href);
  ok(typeof echoComparable === "function" && typeof outbox.echoComparable === "function", "E3f 두 펴기가 있다(화면 사본 · 서버 정본)");
  let differ = 0; const firstDiffs = [];
  for (let c = 0; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    const x = "a" + String.fromCodePoint(c) + " b";
    if (echoComparable(x) !== outbox.echoComparable(x)) { differ++; if (firstDiffs.length < 5) firstDiffs.push("U+" + c.toString(16)); }
  }
  ok(differ === 0, "E3f 모든 코드 포인트에서 화면 사본 = 서버 정본", `${differ}개 · ${firstDiffs.join(" ")}`);
  for (const raw of ["a\x1b[31mb\x1b[0m", "a\u{9B}1;2mb", "a\x1b]0;t\x07b", "a\x1b]8;;u\x1b\\b", "a\x1b]0;t", "a\x1bP1$r\x1b\\b", "a\x1b(Bb", "a\x1b7b", "a\x1b", "a\x1b[200~b"]) {
    ok(echoComparable(raw) === outbox.echoComparable(raw), `E3f 제어열 ${JSON.stringify(raw)} — 화면 사본 = 서버 정본`, `${JSON.stringify(echoComparable(raw))} · ${JSON.stringify(outbox.echoComparable(raw))}`);
  }

  // ── E5 — 낙관 말풍선 ↔ 기록의 사람 말 잇기(sameSaid — web/session-chat 이 부른다) ──
  //  #4852 격리 리뷰 재현: 공백만 접던 때는 보이지 않는 글자·색 코드가 든 말이 기록과 안 이어져 같은 말이 **두 번** 보였다.
  ok(typeof sameSaid === "function", "E5 전제 — sameSaid 가 화면 판정 모듈에 있다");
  const SAY = [
    ["진행\u200b해", "진행해", true, "짧은 말(24자 미만) · ZWSP"],
    ["복사해 온\u200b글 — 앞 64자 안에 보이지 않는 글자가 있는 긴 지시입니다. 이어서 다른 내용이 한참 붙습니다.", "복사해 온글 — 앞 64자 안에 보이지 않는 글자가 있는 긴 지시입니다. 이어서 다른 내용이 한참 붙습니다.", true, "머리 64자 안의 ZWSP"],
    ["\x1b[31mERROR\x1b[0m 디스크 가득", "ERROR 디스크 가득", true, "맨 앞 색 코드"],
    ["안녕\u{3164}하세요", "안녕하세요", true, "한글 채움 문자"],
    ["진행해", "진행해줘", false, "다른 말"],
    ["가".repeat(70) + " 꼬리 A", "가".repeat(70) + " 꼬리가 섞임", true, "24자 이상 · 머리 64자가 같다(종전 규칙 그대로 — 긴 글의 꼬리 뒤섞임)"],
    ["가".repeat(30) + " 꼬리 A", "가".repeat(30) + " 꼬리가 섞임", false, "64자가 안 되는 글은 통째로 같아야"],
    ["가".repeat(10) + " A", "가".repeat(10) + " B", false, "24자 미만은 통째로 같아야"],
    ["", "", false, "빈 말"],
  ];
  for (const [a, b, want, why] of SAY) ok(sameSaid(a, b) === want, `E5 ${why} → ${want}`, String(sameSaid(a, b)));
} finally { rmSync(tmp, { recursive: true, force: true }); }

console.log(`\n${pass} passed — 대화창 «이미 기록에 있는 말» 판정(#4819)`);
