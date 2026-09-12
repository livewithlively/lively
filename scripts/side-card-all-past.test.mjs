// #3778 4판 — 카드 안 「지난 세션」이 **시간이 지나도 안 줄어드는가**.
//
//  신고(원준 2026-09-12): "자잘한 UI 수정에 내가 쓰다가 사라진 세션이 엄청 많은데 지난 세션이 1개밖에
//  없다. 아무리 시간이 지나더라도 지난 세션(숫자)에서 사라지면 안 되지. 기준 없이 사라지는 느낌이다."
//
//  그 전까지 카드가 담던 것은 «오늘 것 + 내가 안 닫은 것» 뿐이었다. 이 파일은 그 반대를 못박는다 —
//  **날짜는 이 판정에 아예 안 들어온다.**
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "card-past-"));
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/sess-fold.ts"), "--outDir", out,
   "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" },
);
const { projectPastRows } = await import(path.join(out, "sess-fold.js"));

let pass = 0, fail = 0;
const ok  = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "기대와 다르다") => (cond ? ok(n) : bad(n, why));
const ids = (r) => r.rows.map((x) => x.id).join(",");
const lay = (got, wantIds, wantTotal, n) => {
  const w = wantIds.join(",");
  check(ids(got) === w && got.total === wantTotal, n,
    `줄: 기대 [${w}] · 실제 [${ids(got)}] / 총계: 기대 ${wantTotal} · 실제 ${got.total}`);
};

const DAY = 86_400_000, NOW = Date.UTC(2026, 8, 12, 3, 0, 0);
/** 끝난 세션(박스 없음). */
const done = (id, pid, ago) => ({ id, projectId: pid, live: false, alive: false, lastSeen: NOW - ago });
/** 도는 세션. */
const run  = (id, pid, ago) => ({ id, projectId: pid, live: true, alive: true, lastSeen: NOW - ago });
const NONE = new Set();

// ───────────────────────── A. ★ 날짜는 판정에 안 들어온다 (신고의 본체)

lay(projectPastRows([done("어제", 1, DAY), done("사흘전", 1, 3 * DAY), done("한달전", 1, 30 * DAY)], 1, NONE, 12),
  ["어제", "사흘전", "한달전"], 3,
  "A1 ★ 한 달 전 세션도 그대로 담긴다 — 날짜로 자르지 않는다(이 함수의 존재 이유)");

{ // 같은 입력을 «오늘» 을 옮겨 가며 두 번 — 답이 같아야 시간이 지나도 안 줄어든다
  const rows = [done("a", 1, 2 * DAY), done("b", 1, 40 * DAY)];
  const t1 = projectPastRows(rows, 1, NONE, 12);
  const t2 = projectPastRows(rows.map((r) => ({ ...r, lastSeen: r.lastSeen - 90 * DAY })), 1, NONE, 12);
  check(t1.total === 2 && t2.total === 2,
    "A2 ★ 90일을 더 흘려보내도 숫자가 그대로다 — 판정에 «지금» 이 없다",
    `앞 ${t1.total} · 뒤 ${t2.total}`);
}

// ───────────────────────── B. 무엇이 들어가고 무엇이 빠지나

lay(projectPastRows([done("끝남", 1, DAY), run("도는중", 1, 0)], 1, NONE, 12),
  ["끝남"], 1,
  "B1 도는 세션은 접힘이 아니라 앞면이라 여기 안 들어온다");

//  ★ 5판에서 칸 이름을 고쳤다: `trashed` 는 **Sess 에 없는 칸**이라 이 판정이 실제 자료에서 한 번도 안 걸렸다
//   (views.ts `isTrashedSess = !!s.trashedAt`). 4판의 이 줄은 손으로 지은 `{trashed:true}` 객체만 걸러서
//   «휴지통을 뺀다» 를 통과시켰지만, 화면에서는 휴지통 세션이 카드 접힘에 그대로 서 있었다.
//   **테스트가 자료형과 다른 모양을 지어 넣으면 그 테스트는 통과하면서 아무것도 안 본다.**
lay(projectPastRows([done("내것", 1, DAY), { ...done("버린것", 1, DAY), trashedAt: "2026-09-01T00:00:00Z" }], 1, NONE, 12),
  ["내것"], 1,
  "B2 휴지통 세션은 뺀다 — 되돌리기 전에 열리면 안 된다(#1851). ★ 판정 칸은 실제 자료와 같은 `trashedAt` 이다");

lay(projectPastRows([{ ...done("옛칸", 1, DAY), trashed: true }], 1, NONE, 12),
  ["옛칸"], 1,
  "B2′ ★ 옛 칸 이름(`trashed`)은 **안 본다** — 그 칸은 Sess 에 없으므로 그걸 보는 판정은 아무도 못 거른다");

lay(projectPastRows([done("우리", 1, DAY), done("남의프로젝트", 2, DAY)], 1, NONE, 12),
  ["우리"], 1,
  "B3 다른 프로젝트 세션은 안 들어온다");

lay(projectPastRows([done("소속없음", null, DAY), done("우리", 1, DAY)], 1, NONE, 12),
  ["우리"], 1,
  "B4 프로젝트 없는 세션은 안 들어온다");

//  ★ 5판에서 이 계약이 **뒤집혔다.** 4판은 id 0 을 «묻지 마라» 로 읽고 빈 결과를 돌려줬는데, 그 바람에
//   프로젝트에 안 붙은 세션이 접힘에도 못 들어가 **어디에도 없었다**(실측: 신고자 계정에서 47개).
//   0 은 빈 값이 아니라 **「프로젝트 없음」 묶음**이다 — 사이드바 트리가 이미 쓰는 자리이고 「외 n개」도
//   갈 곳이 있다(#/p/0 = 프로젝트 없는 세션들의 작업대).
lay(projectPastRows([{ ...done("소속없음", null, DAY) }, done("남의프로젝트", 1, DAY)], 0, NONE, 12),
  ["소속없음"], 1,
  "B5 ★ 프로젝트 id 0 은 「프로젝트 없음」 묶음이다 — 프로젝트 안 붙은 세션끼리만 모인다");

// ───────────────────────── C. 이미 서 있는 줄은 두 번 안 그린다

lay(projectPastRows([done("이미섬", 1, DAY), done("접힘", 1, 2 * DAY)], 1, new Set(["이미섬"]), 12),
  ["접힘"], 1,
  "C1 카드에 이미 서 있는 세션은 접힘에서 뺀다(같은 줄이 두 번 서지 않는다)");

lay(projectPastRows([{ ...done("박스새id", 1, DAY), logId: "대화uuid" }], 1, new Set(["대화uuid"]), 12),
  [], 0,
  "C2 ★ 대화 uuid 로 서 있어도 같은 세션으로 본다 — 한 세션이 여러 이름으로 불린다");

lay(projectPastRows([{ ...done("지금id", 1, DAY), altIds: ["되살리기전id"] }], 1, new Set(["되살리기전id"]), 12),
  [], 0,
  "C3 ★ 되살리기 전 옛 박스 id 로 서 있어도 같은 세션으로 본다");

// ───────────────────────── D. 순서와 상한

lay(projectPastRows([done("오래된", 1, 9 * DAY), done("최근", 1, DAY), done("중간", 1, 4 * DAY)], 1, NONE, 12),
  ["최근", "중간", "오래된"], 3,
  "D1 최근에 쓴 것부터 선다");

{
  const many = Array.from({ length: 20 }, (_, i) => done(`s${i}`, 1, (i + 1) * DAY));
  const r = projectPastRows(many, 1, NONE, 12);
  check(r.rows.length === 12 && r.total === 20 && r.rows[0].id === "s0",
    "D2 상한을 넘으면 줄은 12개까지만, **총계는 20 그대로** — 「외 8개」로 안내할 수 있어야 한다",
    `줄 ${r.rows.length} · 총계 ${r.total} · 첫 줄 ${r.rows[0]?.id}`);
}

{
  const r = projectPastRows([done("a", 1, DAY), done("b", 1, 2 * DAY)], 1, NONE, 0);
  check(r.rows.length === 2 && r.total === 2,
    "D3 상한 0 은 «제한 없음» 이다(전량을 돌려준다)", `줄 ${r.rows.length}`);
}

// ───────────────────────── E. 빈 값·망가진 입력에도 안 죽는다

for (const [v, n] of [[null, "null"], [undefined, "undefined"], [[], "빈 배열"]]) {
  const r = projectPastRows(v, 1, NONE, 12);
  check(r.rows.length === 0 && r.total === 0, `E1 세션 목록이 ${n} 이어도 빈 결과를 돌려준다`);
}

{
  const r = projectPastRows([null, undefined, done("살아남", 1, DAY)], 1, NONE, 12);
  check(ids(r) === "살아남", "E2 목록 안에 빈 항목이 섞여도 나머지를 그대로 담는다", `실제 [${ids(r)}]`);
}

console.log(`\nside-card-all-past: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
