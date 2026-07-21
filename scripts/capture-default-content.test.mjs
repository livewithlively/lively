// capture-default-content 순수함수 검증(#988) — 시드 오염 방지의 핵심 로직:
//  diffRows(추가/변경/제거 판정) · mergeSelective(선택 id 만 반영·나머지 현행 보존) · parseCaptureArgs · lineDiff.
//  DB 불요(순수함수만 import — 모듈 하단 main 가드가 import 시 실행을 막는다).
//  실행: node scripts/capture-default-content.test.mjs
import { diffRows, mergeSelective, parseCaptureArgs, lineDiff, excludeInternalOnly, applySeedEnabledPolicy } from "./capture-default-content.mjs";

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
// excludeInternalOnly — frontmatter.internal_only=true 는 고객 시드에서 통째 제외(★ 내부 경로·포트·사내 히스토리 유출 차단)
{
  const rows = [
    { id: "public-skill", frontmatter: {} },
    { id: "internal-skill", frontmatter: { internal_only: true } },
    { id: "no-frontmatter" },
    { id: "falsy-flag", frontmatter: { internal_only: false } },
  ];
  const { kept, excluded } = excludeInternalOnly(rows);
  eq("internal_only=true 만 제외", excluded.map((r) => r.id), ["internal-skill"]);
  eq("나머지는 시드에 보존(플래그 없음·false 포함)", kept.map((r) => r.id), ["public-skill", "no-frontmatter", "falsy-flag"]);
}
// lineDiff — 공통 접두/접미 제외한 가운데만
eq("lineDiff 가운데 블록만", lineDiff("a\nb\nc", "a\nX\nc"), "      - b\n      + X");

// ── applySeedEnabledPolicy — 시드 기본값 고정(양방향) ────────────────────────
// 라이블리 DB 의 on/off 는 '우리 조직이 고른 값'이지 '신규 고객 기본값'이 아니다. 여기서 갈라놓지 않으면
//  전체 capture 가 고객 디폴트를 우리 취향으로 조용히 덮어쓴다. 옛 SEED_DISABLED(Set)는 false 강제만
//  표현할 수 있었고, 우리 DB=off / 고객 기본=on 인 항목이 생기면서 양방향이 필요해졌다(#1069).
//  사양의 엣지 표 8행을 그대로 옮긴다 — 행 수 = 시나리오 수.
{
  const P = new Map([["a", false], ["b", true]]);
  const run = (rows, policy = P) => { const f = applySeedEnabledPolicy(rows, policy); return { rows, f }; };

  // ① true → 정책 false : 뒤집히고 보고에 포함
  {
    const { rows, f } = run([{ id: "a", enabled: true }]);
    eq("정책① 우리 on → 고객 off 로 굳는다", rows[0].enabled, false);
    eq("정책① 뒤집힘이 보고된다(방향 포함)", f, [{ id: "a", from: true, to: false }]);
  }
  // ② false → 정책 true : 반대 방향도 된다(Set 으로는 불가능했던 케이스)
  {
    const { rows, f } = run([{ id: "b", enabled: false }]);
    eq("정책② 우리 off → 고객 on 으로 굳는다", rows[0].enabled, true);
    eq("정책② 반대 방향도 보고된다", f, [{ id: "b", from: false, to: true }]);
  }
  // ③ 이미 정책 값(true) : 그대로 + 보고 제외(잡음 금지)
  {
    const { rows, f } = run([{ id: "b", enabled: true }]);
    eq("정책③ 이미 맞으면 그대로", rows[0].enabled, true);
    eq("정책③ 이미 맞으면 보고 안 함", f, []);
  }
  // ④ 이미 정책 값(false) : 그대로 + 보고 제외
  {
    const { rows, f } = run([{ id: "a", enabled: false }]);
    eq("정책④ 이미 맞으면 그대로(false)", rows[0].enabled, false);
    eq("정책④ 이미 맞으면 보고 안 함(false)", f, []);
  }
  // ⑤ 정책에 없는 id : DB 값 그대로 (정책은 화이트리스트다)
  {
    const { rows, f } = run([{ id: "zzz", enabled: true }, { id: "yyy", enabled: false }]);
    eq("정책⑤ 미등재 id 는 DB 값 보존", [rows[0].enabled, rows[1].enabled], [true, false]);
    eq("정책⑤ 미등재 id 는 보고 제외", f, []);
  }
  // ⑥ 정책이 비었거나 없음 — 새로 도입한 인자가 빈 경우(호출부가 정책을 안 넘기는 실수)
  {
    const rows = [{ id: "a", enabled: true }, { id: "b", enabled: false }];
    eq("정책⑥ 빈 Map 이면 아무것도 안 바꾼다", applySeedEnabledPolicy(rows, new Map()), []);
    eq("정책⑥ 빈 Map 이면 값 보존", [rows[0].enabled, rows[1].enabled], [true, false]);
    eq("정책⑥ null 정책이면 조용히 무동작", applySeedEnabledPolicy(rows, null), []);
    eq("정책⑥ null 정책이어도 값 보존", [rows[0].enabled, rows[1].enabled], [true, false]);
  }
  // ⑦ 행 배열이 빔 / 없음 : 예외 없이 0건
  {
    eq("정책⑦ 빈 배열 → 0건", applySeedEnabledPolicy([], P), []);
    eq("정책⑦ 행 없음(undefined) → 예외 없이 0건", applySeedEnabledPolicy(undefined, P), []);
  }
  // ⑧ 경계 — enabled 가 boolean 이 아님(값 부재). 정책 값으로 '설정'되고 뒤집힘으로 보고돼야 한다.
  {
    const { rows, f } = run([{ id: "a" }]);
    eq("정책⑧ enabled 부재 → 정책 값으로 설정", rows[0].enabled, false);
    eq("정책⑧ enabled 부재도 뒤집힘으로 보고", f, [{ id: "a", from: undefined, to: false }]);
  }
  // 배선 — 이 테스트가 실제로 '고정' 대상을 보고 있나(관측 장치 생존 확인).
  {
    const rows = [{ id: "a", enabled: true }, { id: "zzz", enabled: true }];
    const f = applySeedEnabledPolicy(rows, P);
    eq("정책 배선 — 등재/미등재를 실제로 갈라낸다", [f.length, rows[1].enabled], [1, true]);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
