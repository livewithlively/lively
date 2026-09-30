// #3778 — 대화창 «위로 더» 자동 불러오기의 **요청 규칙**(web/lib/older-autoload.ts olderRequest·olderNext).
//
//  신고(원준 2026-09-19): 보관 중인 세션에서 위로 올리다 꼭대기의 불러오기 단추를 눌러야만 더 위가 보였다.
//   → 단추를 없애고 스크롤이 부르게 했다. 그런데 **자동으로 부르면** 종전엔 숨어 있던 고장이 폭주가 된다:
//   서버는 창을 줄 경계로 맞추는데(src/terminal/harness-io/window.ts), 청한 구간 전체가 한 줄(큰 도구 결과·이미지)의
//   꼬리 안이면 빈 창을 **loadedFrom 그대로** 돌려준다. 종전 단추는 거기서 눌러도 아무 일이 없었고(영영 못 올라감),
//   자동이면 같은 요청을 끝없이 되풀이한다.
//
//  그래서 이 파일은 흉내가 아니라 **서버의 진짜 창 함수**(readAlignedWindow · transcriptRange)에 합성 대화 파일을 물려
//   화면의 요청 규칙을 끝까지 돌린다. 판정: ①머리까지 간다 ②같은 요청을 두 번 연속 하지 않는다 ③빈틈·중복 없이 순서대로
//   ④빠지는 것은 서버가 원래 못 주는 줄(상한보다 긴 한 줄)뿐.
//
//  재현 게이트(G1): 옛 규칙(항상 [L-WINDOW, L))을 같은 파일에 돌리면 **같은 요청을 되풀이한다** — 하네스가 고장을 볼 줄 안다.
//  스크롤·관찰자 쪽(언제 부르나)은 scripts/older-autoload-runtime.test.mjs(헤드리스 크롬)가 잰다.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "older-autoload-"));
writeFileSync(path.join(out, "package.json"), '{"type":"module"}');
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/older-autoload.ts"), "--outDir", path.join(out, "web"),
   "--module", "esnext", "--target", "es2022", "--lib", "es2022,dom", "--skipLibCheck"],
  { stdio: "inherit" },
);
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "src/terminal/harness-io/window.ts"), path.join(root, "src/sessions/transcript-range.ts"),
   "--rootDir", path.join(root, "src"), "--outDir", path.join(out, "src"),
   "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--types", "node", "--skipLibCheck"],
  { stdio: "inherit" },
);
const { olderRequest, olderNext, OLDER_MAX_SPAN } = await import(path.join(out, "web/older-autoload.js"));
const { readAlignedWindow } = await import(path.join(out, "src/terminal/harness-io/window.js"));
const { transcriptRange, TRANSCRIPT_MAX_CHUNK } = await import(path.join(out, "src/sessions/transcript-range.js"));

let pass = 0, fail = 0;
const check = (cond, n, why = "기대와 다르다") => {
  if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — ${why}`); }
};

const WINDOW = 1_500_000;   // web/session-chat.ts 의 WINDOW — W0 가 소스와 같은지 잰다
const MB = 1024 * 1024;

// ── W) 배선 — 이 파일이 재는 규칙·숫자가 실제 화면 코드의 것인가 ──────────────────
const CHAT = readFileSync(path.join(root, "web/session-chat.ts"), "utf8");
check(/const WINDOW = 1_500_000;/.test(CHAT), "W0 화면의 창 크기가 이 시험의 값과 같다", "session-chat.ts WINDOW 가 바뀌었다 — 이 파일의 WINDOW 도 맞춘다");
check(OLDER_MAX_SPAN === TRANSCRIPT_MAX_CHUNK, "W1 화면이 아는 서버 상한 = 서버의 실제 상한",
  `화면 ${OLDER_MAX_SPAN} · 서버 ${TRANSCRIPT_MAX_CHUNK} — 어긋나면 넓힌 요청이 서버에서 잘려 이음새가 깨진다`);
check(/const r = olderRequest\(loadedFrom, olderStalls, WINDOW\)/.test(CHAT), "W2 화면의 요청이 olderRequest 에서 나온다");
check(/olderNext\(prevFrom, olderStalls, chunk\.from\)/.test(CHAT) && /if \(!intoPrev && !step\.moved\) \{ olderStalls = step\.stalls; return true; \}/.test(CHAT),
  "W3 화면이 «못 올라감» 을 olderNext 로 가르고, 같은 표지로 다시 부르게 성공(true)으로 돌려준다");
check(/olderLoader\(view\.list, \(\) => loadOlder\(\)\)/.test(CHAT) && /olderAuto\.watch\(bar\)/.test(CHAT) && /olderAuto\.watch\(null\)/.test(CHAT),
  "W4 화면이 맨 위 표지를 로더에 물리고, 더 없을 때는 놓는다");

// ── Q) olderRequest · olderNext 엣지 표 ───────────────────────────────────────
const eq = (a, b) => a.from === b.from && a.to === b.to;
const show = (r) => `[${r.from}, ${r.to})`;
const L = 20 * MB;
check(eq(olderRequest(L, 0, WINDOW), { from: L - WINDOW, to: L }), "Q1 평소 — 기본 창 [L-WINDOW, L)", show(olderRequest(L, 0, WINDOW)));
check(eq(olderRequest(1_000_000, 0, WINDOW), { from: 0, to: 1_000_000 }), "Q4a 머리 근처 — 0 아래로 안 내려간다");
check(eq(olderRequest(L, 1, WINDOW), { from: L - OLDER_MAX_SPAN, to: L }), "Q6a 한 번 막힘 — 서버 상한까지 넓힌다(끝은 그대로)", show(olderRequest(L, 1, WINDOW)));
check(eq(olderRequest(3 * MB, 1, WINDOW), { from: 0, to: 3 * MB }), "Q6b 한 번 막힘 + 머리 근처 — 0 에서 멈춘다");
check(eq(olderRequest(L, 2, WINDOW), { from: L - OLDER_MAX_SPAN - WINDOW, to: L - OLDER_MAX_SPAN }), "Q6c 두 번 막힘 — 끝을 상한만큼 당겨 그 줄을 건너뛴다", show(olderRequest(L, 2, WINDOW)));
check(eq(olderRequest(L, 3, WINDOW), { from: L - 2 * OLDER_MAX_SPAN - WINDOW, to: L - 2 * OLDER_MAX_SPAN }), "Q6d 세 번 막힘 — 상한 하나씩 더 당긴다");
check(eq(olderRequest(5 * MB, 3, WINDOW), { from: 0, to: 0 }), "Q6e 당기다 머리를 지나면 [0,0) — 음수가 없다", show(olderRequest(5 * MB, 3, WINDOW)));
check(eq(olderRequest(OLDER_MAX_SPAN, 1, WINDOW), { from: 0, to: OLDER_MAX_SPAN }), "Q4b 경계 — L 이 정확히 상한이면 한 번에 머리까지");
let spanOk = true, orderOk = true;
for (const l of [0, 1, 999, WINDOW, 3 * MB, OLDER_MAX_SPAN - 1, OLDER_MAX_SPAN, OLDER_MAX_SPAN + 1, 9 * MB, 31 * MB]) for (let s = 0; s < 6; s++) {
  const r = olderRequest(l, s, WINDOW);
  if (r.to - r.from > TRANSCRIPT_MAX_CHUNK) spanOk = false;
  if (!(r.from >= 0 && r.from <= r.to && r.to <= l)) orderOk = false;
}
check(spanOk, "Q4c 어떤 요청도 서버 상한보다 넓지 않다(넓으면 서버가 끝을 잘라 이음새가 깨진다)");
check(orderOk, "Q4d 0 ≤ from ≤ to ≤ loadedFrom — 이미 그린 곳을 다시 청하지 않는다");
{
  const a = olderNext(100, 3, 40), b = olderNext(100, 0, 100), c = olderNext(100, 1, 120);
  check(a.moved && a.loadedFrom === 40 && a.stalls === 0, "Q6f 올라갔다 — 그 자리로, 막힘 셈은 0");
  check(!b.moved && b.stalls === 1 && b.loadedFrom === 100, "Q6g 경계 — gotFrom == loadedFrom 은 «못 올라감»(막힘 +1, 자리 그대로)");
  check(!c.moved && c.stalls === 2 && c.loadedFrom === 100, "Q6h gotFrom > loadedFrom 도 «못 올라감» — 뒤로 가지 않는다");
}

// ── Q5) 서버의 진짜 창 함수로 끝까지 ─────────────────────────────────────────
//  줄 하나 = `{"i":<번호>,"p":"xxx…"}\n` — 번호로 순서·중복·누락을 잰다.
function makeFile(sizes) {
  return Buffer.concat(sizes.map((n, i) => {
    const head = `{"i":${i},"p":"`; const tail = `"}\n`;
    return Buffer.from(head + "x".repeat(Math.max(0, n - head.length - tail.length)) + tail);
  }));
}
const reader = (buf) => ({ read: async (s, e) => buf.subarray(Math.max(0, s), Math.min(e, buf.length)) });
const idsOf = (data) => data.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).i);

/** 화면이 하는 그대로 — 꼬리 창을 연 뒤 맨 위에 닿을 때마다 부른다. rule='new'(지금) · 'old'(단추 시절: 막혀도 같은 요청). */
async function drive(buf, rule) {
  const size = buf.length, rd = reader(buf);
  const first = transcriptRange(size, { tail: WINDOW });
  const w0 = await readAlignedWindow(rd, size, first.start, first.end, false);
  let loadedFrom = w0.from, stalls = 0, overlap = false;
  const shown = idsOf(w0.data);
  const reqs = [];
  let repeated = false;
  for (let guard = 0; loadedFrom > 0 && guard < 400; guard++) {
    const r = rule === "new" ? olderRequest(loadedFrom, stalls, WINDOW) : { from: Math.max(0, loadedFrom - WINDOW), to: loadedFrom };
    const key = `${r.from}-${r.to}`;
    if (reqs.length && reqs[reqs.length - 1] === key) { repeated = true; break; }
    reqs.push(key);
    const { start, end } = transcriptRange(size, { from: r.from, to: r.to });
    const w = await readAlignedWindow(rd, size, start, end, true);
    const step = olderNext(loadedFrom, stalls, w.from);
    if (!step.moved) { stalls = rule === "new" ? step.stalls : 0; continue; }
    if (w.to > loadedFrom) overlap = true;
    shown.unshift(...idsOf(w.data));
    loadedFrom = step.loadedFrom; stalls = 0;
  }
  return { shown, reqs, repeated, overlap, done: loadedFrom <= 0 };
}
const smalls = (n, seed) => Array.from({ length: n }, (_, k) => 300 + ((k * 7919 + seed) % 40_000));

const cases = [
  { id: "Q5a", desc: "작은 줄뿐인 약 12MB", sizes: smalls(600, 1) },
  { id: "Q2a", desc: "가운데 2.5MB 한 줄(창보다 길고 서버 상한 안)", sizes: [...smalls(200, 2), Math.floor(2.5 * MB), ...smalls(120, 3)] },
  { id: "Q2b", desc: "꼬리 창 바로 위 3.9MB 한 줄", sizes: [...smalls(150, 6), Math.floor(3.9 * MB), ...smalls(70, 7)] },
  { id: "Q3a", desc: "가운데 6MB 한 줄(서버 상한 밖)", sizes: [...smalls(200, 4), 6 * MB, ...smalls(120, 5)] },
  { id: "Q3b", desc: "파일 맨 앞 줄이 9MB", sizes: [9 * MB, ...smalls(200, 8)] },
  { id: "Q3c", desc: "큰 줄 둘이 붙어 있음(3MB·5MB)", sizes: [...smalls(100, 9), 3 * MB, 5 * MB, ...smalls(100, 10)] },
];
for (const c of cases) {
  const res = await drive(makeFile(c.sizes), "new");
  const dup = res.shown.length !== new Set(res.shown).size;
  const sorted = res.shown.every((v, k) => k === 0 || res.shown[k - 1] < v);
  const missing = c.sizes.map((_, i) => i).filter((i) => !res.shown.includes(i));
  check(res.done && !res.repeated, `${c.id} ${c.desc} — 머리까지 올라가고 같은 요청을 되풀이하지 않는다`,
    `done=${res.done} repeated=${res.repeated} 요청 ${res.reqs.length}번`);
  check(!dup && sorted && !res.overlap, `${c.id} 빈틈·중복 없이 순서대로(이미 그린 자리를 넘는 창 0)`, `dup=${dup} sorted=${sorted} overlap=${res.overlap}`);
  //  상한보다 긴 줄은 «빠질 수 있다» 이지 «반드시 빠진다» 가 아니다 — 끝이 그 줄 안에 떨어지면 서버의 끝 정렬이
  //   개행까지 늘려 통째로 주기도 한다(실측: 5MB 줄은 왔고 6MB 줄은 빠졌다 — 정렬 위치 차이). 그래서 부분집합으로 잰다.
  const unservable = new Set(c.sizes.map((n, i) => (n > OLDER_MAX_SPAN ? i : -1)).filter((i) => i >= 0));
  check(missing.every((i) => unservable.has(i)), `${c.id} 빠진 줄은 서버 상한보다 긴 줄뿐(상한 안의 줄은 전부 온다)`,
    `빠진 줄 ${JSON.stringify(missing.slice(0, 10))} · 상한 밖 줄 ${JSON.stringify([...unservable])}`);
}

// ── G) 재현 게이트 — 옛 규칙은 큰 줄에서 같은 요청을 되풀이한다 ────────────────────
{
  const res = await drive(makeFile(cases[1].sizes), "old");
  check(res.repeated && !res.done, "G1 [재현] 옛 규칙은 상한 안의 큰 줄 하나에서도 같은 요청을 되풀이한다(단추 시절: 눌러도 제자리)",
    `repeated=${res.repeated} done=${res.done}`);
}

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
