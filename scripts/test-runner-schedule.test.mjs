#!/usr/bin/env node
// 시험 러너의 차례(#5029) — 혼자 도는 시험의 규칙(표식 · 머리 창 · 맨 뒤 · 띄우기)과, **실제 러너가 그 규칙대로 도는지**를 잰다.
//  규칙만 재면 러너가 그 규칙을 안 써도 초록이다 — 격리 리뷰가 펌프 조건을 옛 `live.size < jobs` 로 되돌려 봤더니 표·목록 단언은
//  전부 초록인 채 혼자 돌아야 할 두 파일이 6ms 차로 함께 떴다. 그래서 S5 가 진짜 러너를 버리는 트리에서 돌려 겹침을 직접 본다.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HEAD_BYTES, isSoloTest, mayStart, readHead, soloLast } from "./test-runner-schedule.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const MARK = "// @lively-" + "test exclusive";   // 쪼개 둔다 — 이 파일 자신이 표식 줄로 읽히면 S4 린트가 이 파일을 잡는다
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const box = mkdtempSync(join(tmpdir(), "runner-schedule-"));

try {
  // ── S1 표식 판정 — 줄 머리의 `//` 주석만 ──
  for (const [label, text, want] of [
    ["셔뱅 다음 줄", `#!/usr/bin/env node\n${MARK} — 이유\n`, true],
    ["첫 줄", MARK, true],
    ["들여쓰기 · 여러 칸", MARK.replace("// ", "  //   ").replace(" exclusive", "    exclusive"), true],
    ["단어 경계(exclusiveX 는 아니다)", `${MARK}X`, false],
    ["줄 머리가 아닌 자리(문자열 안)", `const s = "${MARK}";`, false],
    ["블록 주석은 아니다", `/*${MARK.slice(2)} */`, false],
    ["빈 글", "", false],
  ]) eq(`S1 isSoloTest ${label}`, isSoloTest(text), want);
  eq("S1 isSoloTest undefined", isSoloTest(undefined), false);

  // ── S2 머리 창 — 러너가 보는 것은 앞 HEAD_BYTES 바이트다(글자 수가 아니다) ──
  {
    const file = (name, text) => { const p = join(box, name); writeFileSync(p, text); return p; };
    const inside = file("in.test.mjs", `#!/usr/bin/env node\n${MARK}\n${"x".repeat(10_000)}`);
    const korean = file("ko.test.mjs", `${"가".repeat(1400)}\n${MARK}\n`);   // 1400자 = 4200바이트 — 글자로는 창 안, 바이트로는 밖
    const edge = file("edge.test.mjs", `${"x".repeat(HEAD_BYTES - MARK.length - 2)}\n${MARK}\n`);   // 표식 줄이 창의 마지막 바이트에서 끝난다
    eq("S2 창 안의 표식 → 혼자", isSoloTest(readHead(inside)), true);
    eq("S2 한글 머리로 4KB 를 넘긴 표식 → 혼자 아님(창은 바이트)", isSoloTest(readHead(korean)), false);
    eq("S2 경계 — 창의 끝에서 끝나는 표식 줄 → 혼자", isSoloTest(readHead(edge)), true);
    eq("S2 머리는 HEAD_BYTES 를 넘지 않는다", Buffer.byteLength(readHead(inside)) <= HEAD_BYTES, true);
  }

  // ── S3 순서 · 띄우기 ──
  eq("S3 soloLast 혼자 도는 것을 맨 뒤로 · 묶음 안 순서 유지", soloLast(["a", "S1", "b", "S2", "c"], new Set(["S1", "S2"])), ["a", "b", "c", "S1", "S2"]);
  eq("S3 soloLast 혼자 도는 것 없음 → 그대로", soloLast(["a", "b"], new Set()), ["a", "b"]);
  for (const [label, args, want] of [
    ["보통 · 0/2 → 띄운다", [false, 0, 2], true],
    ["보통 · 1/2 → 띄운다", [false, 1, 2], true],
    ["보통 · 2/2(경계) → 안 띄운다", [false, 2, 2], false],
    ["혼자 · 아무것도 안 돎 → 띄운다", [true, 0, 2], true],
    ["혼자 · 하나라도 돎 → 안 띄운다", [true, 1, 2], false],
    ["혼자 · 직렬(-j 1) · 0 → 띄운다", [true, 0, 1], true],
  ]) eq(`S3 mayStart ${label}`, mayStart(...args), want);

  // ── S4 린트 — 저장소의 시험 파일에서 표식 줄이 머리 창 밖에 있으면 안 된다(사람은 달았다고 믿는데 러너는 못 본다) ──
  {
    const tests = ["src", "kit", "scripts", "deploy", "desktop"].flatMap((d) => {
      try { return readdirSync(join(REPO, d), { recursive: true }).filter((p) => /\.test\.(mjs|ts)$/.test(p) && !p.includes("node_modules")).map((p) => join(d, p)); }
      catch { return []; }
    });
    const marked = tests.filter((f) => isSoloTest(readFileSync(join(REPO, f), "utf8")));
    const outside = marked.filter((f) => !isSoloTest(readHead(join(REPO, f))));
    tests.length > 0 && outside.length === 0
      ? ok(`S4 표식 단 시험 ${marked.length}개가 전부 머리 창 안(시험 ${tests.length}개 훑음)`)
      : bad("S4 머리 창 밖 표식", outside.join(", ") || "시험 파일을 하나도 못 찾았다(관측 장치 고장)");
  }

  // ── S5 실제 러너 — 혼자 도는 파일은 다른 어떤 파일과도 겹쳐 돌지 않고, 보통 파일이 다 끝난 뒤에 돈다 ──
  //  버리는 트리에 러너와 그 모듈을 그대로 옮기고, 시작·끝 시각을 적는 가짜 시험 여섯(보통 넷 · 혼자 둘)을 -j 4 로 돌린다.
  {
    const root = join(box, "tree");
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "kit", "testlib"), { recursive: true });
    for (const f of ["run-tests.mjs", "test-runner-env.mjs", "test-runner-schedule.mjs", "testguard-real-home.mjs"]) copyFileSync(join(HERE, f), join(root, "scripts", f));
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    writeFileSync(join(root, "kit", "testlib", "test-isolation-lint.test.mjs"), "process.exit(0);\n");   // preflight 자리 — 이 트리에선 할 일이 없다
    const log = join(box, "intervals.log");
    const fake = (name, solo) => writeFileSync(join(root, "kit", `${name}.test.mjs`), [
      solo ? `${MARK} — 시험용` : "// 보통",
      `import { appendFileSync } from "node:fs";`,
      `appendFileSync(${JSON.stringify(log)}, "s ${name} " + Date.now() + "\\n");`,
      "await new Promise((r) => setTimeout(r, 800));",
      `appendFileSync(${JSON.stringify(log)}, "e ${name} " + Date.now() + "\\n");`,
    ].join("\n") + "\n");
    for (const n of ["a1", "a2", "a3", "a4"]) fake(n, false);
    for (const n of ["s1", "s2"]) fake(n, true);
    const r = spawnSync(process.execPath, [join(root, "scripts", "run-tests.mjs"), "--scope=kit", "-j", "4"], { encoding: "utf8", timeout: 120_000 });
    const iv = {};
    let lines = [];
    try { lines = readFileSync(log, "utf8").trim().split("\n"); } catch { /* 하나도 안 돌았다 */ }
    for (const l of lines) { const [k, n, t] = l.split(" "); (iv[n] ||= {})[k] = Number(t); }
    const ran = Object.keys(iv).filter((n) => iv[n].s && iv[n].e).sort();
    const overlaps = [];
    for (const s of ["s1", "s2"]) for (const [n, v] of Object.entries(iv)) if (n !== s && iv[s] && v.s < iv[s].e && iv[s].s < v.e) overlaps.push(`${s}×${n}`);
    const lastNormalEnd = Math.max(...["a1", "a2", "a3", "a4"].map((n) => iv[n]?.e ?? Infinity));
    const soloAfter = ["s1", "s2"].every((s) => (iv[s]?.s ?? -Infinity) >= lastNormalEnd);
    const why = `exit=${r.status} 돈 파일=${ran.join(",")} · ${String(r.stdout || "").trim().split("\n").slice(-3).join(" | ")} ${String(r.stderr || "").slice(-300)}`;
    eq("S5 러너가 여섯 파일을 다 돌렸다(관측 장치)", [r.status, ran], [0, ["a1", "a2", "a3", "a4", "s1", "s2"]]);
    overlaps.length === 0 ? ok("S5 혼자 도는 파일은 어떤 파일과도 겹쳐 돌지 않는다") : bad("S5 겹침", `${overlaps.join(", ")} · ${why}`);
    soloAfter ? ok("S5 혼자 도는 파일은 보통 파일이 다 끝난 뒤에 시작한다") : bad("S5 순서", why);
    //  보통 파일은 여전히 함께 돈다 — 혼자 돌리기가 병렬 자체를 꺼 버리지 않았나. 넷이 다 겹치길 요구하면 느린 박스(기동이 수백 ms 씩
    //   벌어진다)에서 흔들리므로, 겹치는 짝이 하나라도 있는지만 본다(직렬이면 짝이 0 이다).
    const normals = ["a1", "a2", "a3", "a4"].map((n) => iv[n]).filter((v) => v?.s && v?.e);
    const pairs = normals.flatMap((a, i) => normals.slice(i + 1).filter((b) => a.s < b.e && b.s < a.e));
    pairs.length > 0 ? ok(`S5 보통 파일은 그대로 병렬로 돈다(겹친 짝 ${pairs.length})`) : bad("S5 병렬", why);
  }

  // ── S6 --list 는 다 쓰고 끝낸다 — 줄마다 찍고 곧바로 process.exit 하면 파이프로 받는 쪽이 늦을 때 꼬리가 버려진다 ──
  //  (리눅스 실측: 64KB 를 넘는 몫은 비동기로 남는데 exit 이 그것을 버린다. 파이프 총량이 사용자 한도를 넘은 기계에선 새 파이프가
  //   4KB 라 39KB 목록도 잘린다 — 맨 뒤의 혼자 도는 파일이 사라져 CI 에서 «표식 단 파일 0개» 로 빨갰다, PR #1537 첫 판.)
  {
    const src = readFileSync(join(HERE, "run-tests.mjs"), "utf8");
    const at = src.indexOf("if (opts.list)");
    const block = at < 0 ? "" : src.slice(at, src.indexOf("\n}\n", at));
    /process\.stdout\.write\(\w+,\s*\w+\)/.test(block) && !/console\.log/.test(block)
      ? ok("S6 --list 는 한 번에 쓰고 다 비운 뒤 끝낸다")
      : bad("S6 --list 쓰기", block.slice(0, 300) || "--list 갈래를 못 찾았다");
  }
} finally {
  rmSync(box, { recursive: true, force: true, maxRetries: 3 });
}

console.log(`\nrunner-schedule tests: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
if (fail) process.exit(1);
