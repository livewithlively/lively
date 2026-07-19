// capture-default-content 순수함수 검증(#988) — 시드 오염 방지의 핵심 로직:
//  diffRows(추가/변경/제거 판정) · mergeSelective(선택 id 만 반영·나머지 현행 보존) · parseCaptureArgs · lineDiff.
//  DB 불요(순수함수만 import — 모듈 하단 main 가드가 import 시 실행을 막는다).
//  실행: node scripts/capture-default-content.test.mjs
import { diffRows, mergeSelective, parseCaptureArgs, lineDiff } from "./capture-default-content.mjs";

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, w) => { fail++; console.error(`FAIL ${n} — ${w}`); };
const eq = (n, a, b) => JSON.stringify(a) === JSON.stringify(b) ? ok(n) : bad(n, `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

// diffRows — id 기준 추가/변경/제거
{
  const cur = [{ id: "a", v: 1 }, { id: "b", v: 1 }, { id: "c", v: 1 }];
  const nxt = [{ id: "a", v: 1 }, { id: "b", v: 2 }, { id: "d", v: 1 }];
  const d = diffRows(cur, nxt);
  eq("diffRows 추가", d.added, ["d"]);
  eq("diffRows 변경(JSON 동등성)", d.changed, ["b"]);
  eq("diffRows 제거", d.removed, ["c"]);
}
// mergeSelective — only 없으면 next 전체(종전 동작)
eq("merge only=null → next 전체", mergeSelective([{ id: "a", v: 1 }], [{ id: "a", v: 2 }, { id: "b", v: 1 }], null), [{ id: "a", v: 2 }, { id: "b", v: 1 }]);
// mergeSelective — 선택만 반영, 비선택은 현행 보존(★ 시드 오염 방지의 핵심)
{
  const cur = [{ id: "a", v: 1 }, { id: "keep", v: 1 }];
  const nxt = [{ id: "a", v: 2 }, { id: "keep", v: 99 }, { id: "new", v: 1 }];
  const m = Object.fromEntries(mergeSelective(cur, nxt, new Set(["a", "new"])).map((r) => [r.id, r.v]));
  eq("merge 선택 a → next(2)", m.a, 2);
  eq("merge 선택 new → 추가", m.new, 1);
  eq("merge 비선택 keep → 현행 보존(99 아님)", m.keep, 1);
}
// mergeSelective — 선택 id 가 next 에 없으면 제거
eq("merge 선택된 id 가 next 에 없으면 제거", mergeSelective([{ id: "a", v: 1 }, { id: "gone", v: 1 }], [{ id: "a", v: 1 }], new Set(["gone"])).map((r) => r.id).sort(), ["a"]);
// mergeSelective — 비선택인데 next 에 없는 id 는 보존(안 지움)
eq("merge 비선택 미존재 id 보존", mergeSelective([{ id: "a", v: 1 }, { id: "keepgone", v: 1 }], [{ id: "a", v: 1 }], new Set(["a"])).map((r) => r.id).sort(), ["a", "keepgone"]);
// parseCaptureArgs
eq("args --dry-run", parseCaptureArgs(["--dry-run"]).dryRun, true);
eq("args -n 별칭", parseCaptureArgs(["-n"]).dryRun, true);
eq("args --diff", parseCaptureArgs(["--diff"]).diff, true);
eq("args --only csv → Set", [...parseCaptureArgs(["--only", "x,y"]).only].sort(), ["x", "y"]);
eq("args --only= csv", [...parseCaptureArgs(["--only=p,q"]).only].sort(), ["p", "q"]);
eq("args 기본 only=null(전체)", parseCaptureArgs([]).only, null);
// lineDiff — 공통 접두/접미 제외한 가운데만
eq("lineDiff 가운데 블록만", lineDiff("a\nb\nc", "a\nX\nc"), "      - b\n      + X");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
