// #3870 — 레일 최근 칸은 **누른다고 섞이지 않는다** · 누르는 동안엔 레일을 다시 그리지 않는다.
//
//  원준 2026-09-28 신고: "좌측 레일에서 누르는 버튼으로 제대로 이동을 안해. 로직이 미친거같아.
//   이거 최신순으로 아이콘 정렬되느라고 이상한건가?"
//  ① 최근 칸이 연 순서대로 섰다 — 누른 앱이 맨 위로 올라가고 나머지가 밀려, 방금 누른 자리에 딴 앱이 섰다
//     (매니지드 실측: 40번 누름 중 26번 순서가 바뀜).
//  ② 폴링·실시간 스트림이 레일을 통째 갈아 끼우는데, 누르는 사이에 갈아 끼우면 click 이 아무 데도 안 간다
//     (같은 실측 40번 중 1번 — 눌렀는데 이동 없음).
//  시나리오 번호(R1~R8)는 사양의 엣지 표 행이다.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "rail-recent-"));
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/rail-lit.ts"), "--rootDir", path.join(root, "web"),
   "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" },
);
const { railRecentKeys } = await import(path.join(out, "lib/rail-lit.js"));

let pass = 0, fail = 0;
const ok  = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "기대와 다르다") => (cond ? ok(n) : bad(n, why));
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ───────────────────────── A. 최근 칸 — 누가 서고 어디 서나
const TABLE = ["dashboard", "sources", "taxonomy", "context", "sessions", "learn"];   // 앱 표 순서(설 수 있는 것만)
const use = (hist, k) => [k, ...hist.filter((x) => x !== k)];   // apps.ts noteAppUse 와 같은 기록 규칙
const pick = (hist, n = 4, table = TABLE) => railRecentKeys(hist, table, n);

{
  const h0 = ["learn", "taxonomy", "sessions", "context"];
  const s0 = pick(h0);
  let same = true; let h = h0; const seen = [];
  for (const k of ["context", "sessions", "taxonomy", "learn", "context", "taxonomy"]) { h = use(h, k); const s = pick(h); seen.push(s.join(",")); if (!eq(s, s0)) same = false; }
  check(same, "R1 ★★ 이미 칸에 선 앱을 몇 번을 눌러도 칸 순서가 그대로다", seen.join(" | "));
}
check(eq(pick(["learn", "taxonomy", "sessions", "context"]), ["taxonomy", "context", "sessions", "learn"]),
  "R2 ★ 칸 순서는 연 순서가 아니라 앱 표 순서다", pick(["learn", "taxonomy", "sessions", "context"]).join(","));
{
  const h = use(["learn", "taxonomy", "sessions", "context"], "sources");   // 칸에 없던 자료를 런치패드로 열었다
  const s = pick(h);
  check(eq(s, ["sources", "taxonomy", "sessions", "learn"]),
    "R3 ★ 칸에 없던 앱을 열면 가장 오래 안 연 하나(context)만 빠지고 그 앱이 들어온다", s.join(","));
}
check(eq(pick(["learn"]), ["dashboard", "sources", "taxonomy", "learn"]),
  "R4 기록이 모자라면 표 순서로 채운다(빈 칸 없음)", pick(["learn"]).join(","));
check(eq(pick(["system", "terminal", "learn"], 2), ["dashboard", "learn"]),
  "R5 설 수 없는 키(숨긴 앱·구역과 같은 문·고정한 앱)는 기록에 있어도 건너뛴다", pick(["system", "terminal", "learn"], 2).join(","));
check(eq(pick(["learn", "learn", "context"], 2), ["context", "learn"]),
  "R6 기록에 같은 키가 겹쳐도 한 칸", pick(["learn", "learn", "context"], 2).join(","));
check(eq(pick(["learn"], 0), []), "R7 칸 수 0 이면 빈 줄");
check(eq(pick(["learn", "x"], 4, ["learn", "context"]), ["learn", "context"]),
  "R8 설 수 있는 앱이 칸 수보다 적으면 있는 만큼", pick(["learn", "x"], 4, ["learn", "context"]).join(","));

// ───────────────────────── B. 배선 — 레일이 이 잣대를 쓰고, 누르는 동안엔 다시 그리지 않는다
const rail = code(readFileSync(path.join(root, "web/v2/rail.ts"), "utf8"));
const fnBody = (name) => { const i = rail.indexOf(`function ${name}(`); return i < 0 ? "" : rail.slice(i, rail.indexOf("\n}\n", i)); };
check(/railRecentKeys\(/.test(fnBody("recentForRail")),
  "W1 ★ 레일 최근 칸(recentForRail)이 lib/rail-lit 의 railRecentKeys 로 칸을 정한다");
const draw = fnBody("drawRail");
check(/if \(pressing\)\s*\{\s*drawOwed = true;\s*return;/.test(draw),
  "W2 ★★ 누르는 중에 온 그리기는 미룬다(drawRail 이 pressing 이면 갈아 끼우지 않는다)");
const rel = fnBody("releasePress");
check(/setTimeout\(drawRail,\s*0\)/.test(rel) && !/[^.]drawRail\(\)/.test(rel),
  "W3 ★★ 미룬 그리기는 뗀 **다음 틱**에 — pointerup 안에서 바로 그리면 click 이 똑같이 사라진다");
const mount = fnBody("mountRail");
check(/addEventListener\('pointerdown', onHostPress, true\)/.test(mount)
    && /addEventListener\('pointerup', releasePress, true\)/.test(mount)
    && /addEventListener\('pointercancel', releasePress, true\)/.test(mount),
  "W4 누름은 레일 전체(발치·워크스페이스 타일 포함)에서 잡고, 떼기·취소는 창에서 받는다");
check(/setTimeout\(releasePress,/.test(fnBody("onHostPress")),
  "W5 떼는 신호를 놓쳐도 레일이 멈춰 서지 않는다(안전 시한)");

// ───────────────────────── C. 자료 화면이 늦게 온 목록으로 **떠난 뒤의** 주소를 덮어쓰지 않는다
//  자료(#/sources) → 곧바로 사용 가이드를 누르면, 목록이 늦게 와서 첫 줄을 열며 주소를 #/sources/<id> 로 바꿔 썼다 —
//  화면은 사용 가이드인데 주소는 자료라 새로고침·뒤로가기가 자료로 떨어졌다.
{
  const src = code(readFileSync(path.join(root, "web/v2/sources.ts"), "utf8"));
  const i = src.indexOf("function autoSelect(");
  const body = i < 0 ? "" : src.slice(i, src.indexOf("\n}\n", i));
  const guard = body.indexOf("if (parseHash(location.hash))");
  const rewrite = body.indexOf("history.replaceState(");
  check(guard >= 0 && rewrite > guard && /if \(parseHash\(location\.hash\)\)\s*\{[^}]*history\.replaceState\(/.test(body),
    "S1 ★★ 자료 화면의 자동 첫 줄은 **아직 자료 주소일 때만** 주소를 바꿔 쓴다");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
