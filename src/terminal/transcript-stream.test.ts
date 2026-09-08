// #3699 — 대화창 폴링을 스트리밍으로. 사양(스크래치패드 spec.md)의 엣지 표를 행마다 잠근다.
//
//  실측 배경(#3668 §9, 노드 저널): 활성 대화창 하나가 `-fs` 컨테이너에 초당 3.5회 runsc exec 을 걸었다.
//   폴 1회 = stat + 구간읽기(멤버 중계 exec 2~3회)이고 도는 중 주기는 0.7초다. 1000 테넌트·동시 관람
//   100명이면 초당 200~430 op — op 당 프로세스 스폰(gVisor 안 node 한 줄 실측 70ms)으로는 구조가 안 선다.
//
//  ⚠ 이 프로젝트가 만들 수 있는 **최악의 회귀**는 «통보는 안 오는데 폴은 30초로 늦춘» 상태다 —
//   자원을 아끼려다 대화를 멈춘다. 그래서 E1~E5(통보가 실제로 오나)와 E6~E8(못 오면 안 늦추나)을
//   따로 잠근다. 둘 중 하나만 성립하면 화면이 죽는다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WATCH_JS, COALESCE_MS, LINGER_MS, MAX_ACC_BYTES, takeWatchLines } from "./transcript-watch.js";

function repoRoot(): string {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) { if (existsSync(path.join(d, "package.json"))) return d; d = path.dirname(d); }
  throw new Error("레포 뿌리를 찾지 못했다");
}
const read = (rel: string): string => readFileSync(path.join(repoRoot(), rel), "utf8");

const until = async (pred: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return pred();
};

/** 감시자 원문을 이 자리에서 그대로 돌린다(세션 컨테이너에서 도는 것과 같은 node 한 줄). */
function runWatcher(file: string): { child: ChildProcess; msgs: Array<Record<string, unknown>>; raw: () => string } {
  const child = spawn(process.execPath, ["-e", WATCH_JS, file], { stdio: ["ignore", "pipe", "pipe"] });
  const msgs: Array<Record<string, unknown>> = [];
  let all = "";
  let acc = "";
  child.stdout!.on("data", (c: Buffer) => {
    all += c.toString("utf8");
    const cut = takeWatchLines(acc + c.toString("utf8"));
    acc = cut.rest;
    for (const m of cut.msgs) msgs.push(m as Record<string, unknown>);
  });
  return { child, msgs, raw: () => all };
}
const tmpFile = (name = "conv.jsonl"): string => path.join(mkdtempSync(path.join(os.tmpdir(), "lvly-3699-")), name);

// ── E1·E2·E3·E16 — 감시자가 **실제로** 통보한다 ─────────────────────────────────
//  이 한 묶음이 나머지 구조의 전제다. 원문이 안 뱉으면 통보는 영영 안 오고, 그런데 화면은 폴을
//  30초로 늦춘 채로 남는다. 유일하게 «되나» 를 실행으로 답할 수 있는 자리라 행동으로 잰다.
test("E1·E2·E16 — 떴다(ready) → 기준선 → 자란 크기 순으로 통보한다", async () => {
  const file = tmpFile();
  writeFileSync(file, "a\n");                                      // 2바이트
  const { child, msgs } = runWatcher(file);
  try {
    assert.ok(await until(() => msgs.some((m) => m.ready === 1), 5_000),
      "E2 — ready 가 없다: 게이트웨이가 «감시 살아 있음» 을 켤 근거가 사라진다(화면이 영영 안 늦춘다)");
    assert.ok(await until(() => msgs.some((m) => m.size === 2), 5_000), "E16 — 붙은 순간의 크기를 안 알린다");
    //  E16 — 그 첫 관측치는 게이트웨이가 **기준선**으로만 쓴다(아래 서버 쪽 잠금과 짝).
    appendFileSync(file, "bbbbbbbb\n");                            // +9 = 11
    assert.ok(await until(() => msgs.some((m) => m.size === 11), 5_000),
      "E1 — 파일이 자랐는데 통보가 없다: 폴을 늦춘 화면에서 대화가 멎는다");
  } finally { child.kill("SIGKILL"); }
});

test("E3 — 파일이 안 자라면 같은 크기를 되풀이하지 않는다", async () => {
  const file = tmpFile();
  writeFileSync(file, "hello\n");                                  // 6바이트
  const { child, msgs } = runWatcher(file);
  try {
    assert.ok(await until(() => msgs.some((m) => m.size === 6), 5_000), "기준선을 못 받았다");
    //  이벤트를 일부러 흔든다 — 같은 폴더에 파일을 만들어 inotify 를 여러 번 깨운다.
    for (let i = 0; i < 5; i++) writeFileSync(path.join(path.dirname(file), `noise-${i}`), "x");
    await new Promise((r) => setTimeout(r, 800));
    const sizes = msgs.filter((m) => typeof m.size === "number");
    assert.equal(sizes.length, 1, `E3 — 크기가 안 변했는데 ${sizes.length}번 통보했다(화면이 그만큼 되읽는다)`);
  } finally { child.kill("SIGKILL"); }
});

test("E4 — 받는 쪽이 사라지면 감시자가 **깨끗이** 끝난다(컨테이너에 유령이 안 남는다)", async () => {
  const file = tmpFile();
  writeFileSync(file, "a\n");
  const { child, msgs } = runWatcher(file);
  let code: number | null = null;
  let stderr = "";
  child.stderr!.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
  child.on("exit", (c) => { code = c; });
  assert.ok(await until(() => msgs.some((m) => m.ready === 1), 5_000), "감시자가 안 떴다");
  child.stdout!.destroy();                                          // 파이프의 읽는 쪽이 사라졌다
  appendFileSync(file, "next\n");                                   // 다음 쓰기 시도가 EPIPE 를 만든다
  const ok = await until(() => code !== null, 6_000);
  if (!ok) child.kill("SIGKILL");
  assert.ok(ok, "E4 — 파이프가 끊겼는데 안 죽는다: 세션 컨테이너에 감시자가 쌓인다(#2625 유령 exec)");
  //  ⚠ **끝났다는 것만으로는 부족하다**(mutation 으로 확인: 오류 처리를 통째로 빼도 «끝나긴» 한다 —
  //   처리 안 된 EPIPE 가 예외로 터져 죽는 것이라, 노드 저널에 스택이 매 세션 쌓인다).
  //   설계한 결말은 «알아채고 조용히 끝낸다» 다 — 종료코드와 조용한 stderr 로 그걸 가른다.
  assert.equal(code, 0, `E4 — 끊긴 파이프를 예외로 터뜨리며 죽는다(종료코드 ${String(code)}): 알아채고 끝내야 한다`);
  assert.doesNotMatch(stderr, /Error|EPIPE/, `E4 — 죽으면서 오류를 뱉는다: ${stderr.slice(0, 200)}`);
});

test("E5 — inotify 에만 기대지 않는다(이벤트가 안 오는 배포에서도 따라잡는다)", () => {
  //  분산 FUSE 는 다른 클라이언트의 쓰기를 inotify 로 안 옮긴다(#3668 §10-3). gVisor 안에서 오는지는
  //  아직 실측 안 했다 — 그래서 이벤트 없이도 종전 체감(0.7초 폴)에서 크게 안 밀리는 상한을 잠근다.
  const m = /setInterval\(look,\s*(\d+)\)/.exec(WATCH_JS);
  assert.ok(m, "E5 — 주기 안전망이 없다: 이벤트가 안 오는 배포에서 대화가 통째로 멎는다");
  assert.ok(Number(m![1]) <= 3000,
    `E5 — 주기 안전망이 ${m![1]}ms 다: inotify 가 안 오면 그만큼 밀린다(종전 폴은 700ms 였다)`);
  assert.match(WATCH_JS, /fs\.watch\(/, "이벤트 감시가 아예 없다 — 15초 지연이 기본이 된다");
});

test("보안 — 감시자 원문은 고정 리터럴이고 경로는 argv 로만 들어온다", () => {
  //  `terminal-member-fs.ts` LS_JS·STAT_JS 와 같은 계약. 치환이 들어오면 그 순간 인젝션 통로가 된다.
  assert.doesNotMatch(WATCH_JS, /\$\{/, "원문에 템플릿 치환이 있다 — 경로가 코드로 섞인다");
  assert.match(WATCH_JS, /process\.argv\[1\]/, "대상 경로를 argv 로 받지 않는다");
});

// ── E17·E18·E19 — 자식 stdout 자르기(조용히 틀리는 자리) ────────────────────────
test("E17 — 청크가 줄 한가운데서 끊겨도 이어 붙여 온전한 줄만 해석한다", () => {
  const a = takeWatchLines('{"ready":1}\n{"si');
  assert.deepEqual(a.msgs, [{ ready: 1 }]);
  assert.equal(a.rest, '{"si', "꼬리를 안 남긴다 — 다음 청크와 못 잇는다");
  const b = takeWatchLines(a.rest + 'ze":42}\n');
  assert.deepEqual(b.msgs, [{ size: 42 }], "E17 — 이어 붙인 줄을 못 읽는다(통보가 조용히 빠진다)");
  assert.equal(b.rest, "");
});

test("E19 — 깨진 줄 한 장은 그 줄만 버리고 나머지는 계속 해석한다", () => {
  const r = takeWatchLines('{"size":1}\nnot json\n{"size":2}\n');
  assert.deepEqual(r.msgs, [{ size: 1 }, { size: 2 }], "E19 — 깨진 한 줄이 뒤의 통보까지 삼킨다");
});

test("E18 — 줄바꿈 없는 쓰레기에 버퍼를 내주지 않는다", () => {
  const r = takeWatchLines("x".repeat(MAX_ACC_BYTES + 1));
  assert.equal(r.rest, "", "E18 — 경계 없는 입력에 버퍼가 무한히 자란다");
  assert.deepEqual(r.msgs, []);
  //  상한 **안**이면 버린다 — 정상적인 «아직 안 끝난 줄» 을 버리면 통보가 빠진다.
  const keep = takeWatchLines('{"size":7');
  assert.equal(keep.rest, '{"size":7', "상한 안의 꼬리까지 버린다 — 다음 청크와 못 잇는다");
});

test("빈 줄·앞뒤 공백은 통보가 아니다", () => {
  assert.deepEqual(takeWatchLines('\n\n  {"size":3}  \n').msgs, [{ size: 3 }]);
});

// ── E15 — 경계값: 서버 뭉치기 창 vs 화면 poke 창 ─────────────────────────────────
test("E15 — 서버 뭉치기 창이 화면 poke 창(120ms)보다 **넓다**", () => {
  const chat = read("web/session-chat.ts");
  const m = /pollTimer = window\.setTimeout\(\(\) => \{ poking = false; void poll\(\); \}, (\d+)\);/.exec(chat);
  assert.ok(m, "화면의 poke 창을 못 찾았다");
  const pokeMs = Number(m![1]);
  assert.ok(COALESCE_MS > pokeMs,
    `E15 — 서버 뭉치기(${COALESCE_MS}ms)가 화면 poke 창(${pokeMs}ms)보다 좁다: 왕복만 늘고, 밀어내기 방식이면 굶는다`);
  assert.ok(LINGER_MS >= 10_000, "E12 — 새로고침 유예가 너무 짧다(새로고침마다 감시자를 다시 띄운다)");
});

// ── E6·E7·E8 — 화면은 «밀어 주고 있을 때만» 늦춘다 ───────────────────────────────
//  브라우저 전용(DOM·fetch)이라 여기서 실행할 수 없다 — 이 레포의 선례대로 그 **모양**을 못 박는다
//  (`session-chat-poll.test.ts` 가 같은 방식으로 #1631 을 잠갔다).
test("E6 — 감시가 살아 있을 때만 안전망 주기로 늦춘다(기본값은 «안 늦춤»)", () => {
  const src = read("web/session-chat.ts");
  assert.match(src, /let watchLive = false;/,
    "E6 — 기본값이 거짓이 아니다: 못 미는 배포(노드 세션·못 읽는 하네스·중계 실패)에서 대화가 30초씩 밀린다");
  assert.match(src, /if \(watchLive && src\.kind === 'box'\) ms = Math\.max\(ms, POLL_SAFETY_MS\);/,
    "E6 — 안전망 주기가 watchLive 를 조건으로 안 쓴다");
  assert.match(src, /if \(e\?\.t === 'transcript\.grew'\) \{ pokePoll\(\); return; \}/,
    "통보를 받고도 안 읽는다 — 늦추기만 한 것이 된다");
});

test("E7 — 감시가 꺼지면 즉시 촘촘한 주기로 돌아간다(30초를 기다리지 않는다)", () => {
  const src = read("web/session-chat.ts");
  assert.match(src, /if \(next\) pokePoll\(\); else schedule\(\);/, "E7 — 거짓 전이에 주기를 다시 걸지 않는다");
  assert.match(src, /watchLive = next;/, "전이를 상태에 반영하지 않는다");
});

test("E8 — pokePoll 은 합치되 **미루지 않는다**(통보가 몰아쳐도 반드시 읽는다)", () => {
  const src = read("web/session-chat.ts");
  assert.match(src, /if \(poking\) return;\s*\n\s*poking = true;/,
    "E8 — 부를 때마다 타이머를 새로 건다: 창보다 촘촘한 통보에 읽는 시각이 영영 뒤로 밀린다");
  assert.match(src, /poking = false; void poll\(\);/, "폴이 돈 뒤 «깨워 둠» 이 안 풀린다");
});

test("종전 불변식은 그대로다 — 죽은 세션(#1631)·가려진 대화창(#3656)", () => {
  const src = read("web/session-chat.ts");
  const line = src.split("\n").find((l) => l.includes("POLL_RUN_MS") && l.includes("POLL_IDLE_MS"));
  assert.ok(line, "주기를 고르는 줄을 못 찾았다");
  assert.match(line!, /running && !dead\(\)\s*\)?\s*\?\s*POLL_RUN_MS/, "죽은 세션에 촘촘한 주기가 돌아왔다(#1631)");
  assert.match(src, /if \(mode === 'term' && src\.kind === 'box'\) ms = Math\.max\(ms, POLL_IDLE_MS\);/,
    "가려진 대화창 완화가 사라졌다(#3656)");
});

// ── E9·E10·E11·E14 — 감시자가 헛돌지 않는다 ──────────────────────────────────────
test("E9 — 노드(멤버 PC) 세션은 아예 안 지켜본다", () => {
  const w = read("src/terminal/transcript-watch.ts");
  //  ⚠ 판정 기준은 배달과 **같아야** 한다 — «등록됐나» 로 가르면 게이트웨이가 노드로도 등록된 배포에서
  //   이 박스의 로컬 세션까지 접힌다(#2055 실측 함정, chat-routes gateRead 가 같은 이유로 sessionGone 을 쓴다).
  assert.match(w, /nodeOfSession\(id\)/, "노드 판정이 없다 — 파일이 저쪽에 있는 세션에 헛 재시도가 돈다");
  assert.match(w, /sessionGone\(id\)/, "E9 — 노드 등록 여부만으로 가른다(로컬 세션까지 접힌다)");
});

test("E10·E11 — 못 읽는 하네스엔 안 되걸고, «아직 없음» 에는 되건다", () => {
  const w = read("src/terminal/transcript-watch.ts");
  assert.match(w, /if \(target\.why !== "unreadable"\) scheduleRetry/,
    "E10 — 실패 종류를 안 가르고 되건다: 생길 리 없는 파일을 영원히 되묻는다");
  assert.match(w, /RETRY_MAX_MS = 30_000/, "E11 — 되걸기 상한이 없다");
});

test("E14 — 감시자가 죽어도 보는 사람이 있으면 다시 띄운다", () => {
  const w = read("src/terminal/transcript-watch.ts");
  const at = w.indexOf('child.on("close"');
  assert.ok(at > 0, "자식의 죽음을 안 본다");
  assert.match(w.slice(at, at + 400), /scheduleRetry\(id, w\)/, "E14 — 죽은 뒤 다시 안 띄운다(통보가 조용히 멎는다)");
});

test("E16 — 첫 관측치는 기준선일 뿐이다(붙자마자 전체를 되읽게 하지 않는다)", () => {
  const w = read("src/terminal/transcript-watch.ts");
  assert.match(w, /if \(w\.sent < target\.found\.size\) w\.sent = target\.found\.size;/,
    "E16 — 붙은 순간의 크기를 «자랐다» 로 흘린다");
});

// ── E12·E13 — 연결·감시자는 세션당 하나, 아무도 안 보면 접는다 ────────────────────
test("E13 — /events 연결은 세션당 한 벌이다(표면마다 각자 열지 않는다)", () => {
  const tasks = read("web/session-tasks.ts");
  const chat = read("web/session-chat.ts");
  assert.match(tasks, /onSessionEvents\(o\.sessionId, handle\)/, "작업 도크가 공용 연결을 안 쓴다");
  assert.doesNotMatch(tasks, /sessions\/\$\{encodeURIComponent\(o\.sessionId\)\}\/events`\), \{\s*\n?\s*headers: authHeaders\(\{\}\)/,
    "E13 — 작업 도크가 자기 SSE 를 따로 연다(같은 세션에 소켓 둘)");
  assert.match(chat, /onSessionEvents\(target\.id,/, "대화창이 상태 통로를 안 연다");
  //  ★ 하네스·모드를 **안 가리고** 연다 — 폴링이 노드를 갉는 주범이 터미널 모드 박스 세션이고,
  //   그 세션엔 작업 도크(runtimeMode === 'chat' 게이트)가 애초에 안 붙는다. 여기서 가르면 이 프로젝트가 무의미해진다.
  //   «조건 없이 돈다» 를 재는 방법: 마운트 본문 **바로 그 자리**(들여쓰기 2칸)에 있어야 한다 —
  //   조건부 헬퍼(ensureTasksDock 처럼) 안으로 들어가면 들여쓰기가 깊어진다.
  assert.match(chat, /^ {2}const offEvents = onSessionEvents\(target\.id,/m,
    "E13 — 대화 파일 통보 구독이 마운트 본문에 조건 없이 있지 않다: 줄이려던 세션(터미널 모드)이 통보를 못 받는다");
});

test("E20 — 붙을 수 없는 세션(404)에는 촘촘히 되묻지 않는다(영구 정지도 아니다)", () => {
  //  이 통로는 이제 **모든 세션 화면**이 연다 — 죽은 세션의 화면도 기록을 보려고 열려 있고 거기선 404 다.
  //  평범한 백오프(≤15초)로 두면 그 화면이 열려 있는 내내 15초마다 되묻는다: 줄이려던 낭비의 재현이다.
  const bus = read("web/session-events.ts");
  const m = /const GONE_RETRY_MS = ([0-9_]+);/.exec(bus);
  assert.ok(m, "E20 — 404 전용 간격이 없다: 죽은 세션 화면이 15초마다 되묻는다");
  assert.ok(Number(m![1].replace(/_/g, "")) >= 60_000, `E20 — 404 재시도 간격이 ${m![1]} 로 너무 촘촘하다`);
  assert.match(bus, /if \(res\.status === 404\) \{ gone = true;/, "404 를 따로 안 가른다");
  assert.match(bus, /setTimeout\(r, gone \? GONE_RETRY_MS : wait\)/, "가르기만 하고 간격에 안 쓴다");
  //  ⚠ 영구 정지는 아니다 — «죽었다» 판정은 틀릴 수 있다(#2108). 루프를 빠져나가면 안 된다.
  assert.doesNotMatch(bus, /if \(res\.status === 404\) \{ [^}]*\bbreak\b/,
    "E20 — 404 에서 루프를 끝낸다: 되살아난 세션의 화면이 영영 통보를 못 받는다");
});

test("E12 — 구독을 놓으면 서버의 감시 참조도 함께 풀린다", () => {
  const chat = read("web/session-chat.ts");
  const events = read("web/session-events.ts");
  const routes = read("src/terminal/routes.ts");
  assert.match(chat, /destroy\(\) \{[^}]*offEvents\(\);/, "대화창이 구독을 안 놓는다");
  assert.match(events, /if \(cur\.subs\.size\) return;\s*\n\s*cur\.closed = true;/,
    "E12 — 마지막 구독이 떠나도 연결을 안 닫는다(서버의 감시 참조가 영영 안 풀린다)");
  assert.match(routes, /const release = acquireTranscriptWatch\(req\.params\.id\);/, "SSE 가 감시 참조를 안 쥔다");
  assert.match(routes, /req\.on\("close", \(\) => \{ off\(\); release\(\); clearInterval\(beat\); \}\);/,
    "E12 — SSE 가 닫힐 때 참조를 안 놓는다: 아무도 안 보는 세션에 감시자가 남는다");
  assert.match(routes, /send\(\{ t: "transcript\.watch", live: transcriptWatchLive\(req\.params\.id\) \}\);/,
    "붙은 화면에 감시 상태를 안 알려 준다 — 첫 화면이 주기를 못 정한다");
});

// ── 판정이 두 벌이 되지 않는다 ────────────────────────────────────────────────────
test("«어느 파일인가» 는 라우트와 감시자가 같은 함수로 답한다", () => {
  const routes = read("src/terminal/chat-routes.ts");
  const watch = read("src/terminal/transcript-watch.ts");
  assert.match(routes, /resolveTranscript\(id, want\)/, "라우트가 공용 판정을 안 쓴다");
  assert.match(watch, /resolveTranscript\(id\)/, "감시자가 공용 판정을 안 쓴다");
  //  두 벌이 되면 «화면이 읽는 파일» 과 «감시자가 지켜보는 파일» 이 조용히 갈린다(통보는 오는데 안 자란다).
  assert.doesNotMatch(routes, /locateTranscript\(/, "라우트가 파일 찾기를 직접 조립한다 — 판정이 두 벌이 됐다");
  assert.doesNotMatch(routes, /transcriptFsFor\(/, "라우트가 파일 파사드를 직접 고른다 — 판정이 두 벌이 됐다");
});
