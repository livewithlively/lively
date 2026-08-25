// #1780 — "최상위 화면은 대장에 등록되지 않으면 존재할 수 없다".
//
// ⚠ 왜 소스 텍스트까지 보나: 이 규칙이 지켜야 하는 건 **값이 아니라 습관**이다. 앱 계층(#1780)을 세워 두고도
//  화면은 계속 앱 밖에서 늘었다 — 라우터 if-else 에 `page === '새화면'` 한 줄이면 끝이라, 매니페스트·
//  AppInstance·권한·창 규칙을 아무도 안 거치고 생긴다. 그렇게 생긴 화면은 탭·인스턴스 정체성이 없어
//  프로젝트 귀속도, 권한 축소도, 재시작·복원도 못 받는다. 런타임 값으로는 이 누락이 영영 안 잡힌다
//  (화면은 잘 뜨니까). 그래서 '라우터가 무엇을 화면으로 인정하는가'를 대장과 대조한다.
//  (같은 규율: scripts/pane-session-scope.test.mjs · src/capabilities/surface-snapshot.test.ts)
//
// 실패하면 고르는 건 셋 중 하나다 — 앱(app) / OS 표면(os, 이유 필수) / 앱화 대상(todo, 계획 필수).
//  맥락 없는 세션이 와도 이 선택을 건너뛸 수 없게 하는 것이 이 가드의 목적이다.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
/** 윈도우에서 절대경로 import 는 ERR_UNSUPPORTED_ESM_URL_SCHEME 로 죽는다 — file:// URL 로 바꿔 넘긴다. */
const load = (p) => import(pathToFileURL(join(root, p)).href);

let pass = 0;
/** name 은 **지켜지는 규칙**을 적는다(통과 시 그대로 출력). 어겼을 때 무엇을 할지는 detail 로. */
const ok = (cond, name, detail) => { assert.ok(cond, detail ? `${name}\n${detail}` : name); pass++; console.log(`ok  ${name}`); };

const { SHELL_SURFACES, CLASSIC_BACKLOG } = await load("public/app/v2/shell-surfaces.js");

// apps.js 는 못 import 한다 — core.js 가 `location` 등 브라우저 전역을 즉시 읽어 Node 에서 죽는다.
//  그래서 main.ts 를 읽는 것과 같은 방식으로 표를 **소스에서** 읽는다(이 테스트의 일관된 규율).
const MAIN = read("web/v2/main.ts");
const APPS_SRC = read("web/v2/apps.ts");

/** 함수·표 하나만 잘라 본다 — 고정 길이로 자르면 그게 자랐을 때 단언이 구간 밖으로 밀려 거짓 실패한다. */
function slice(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `구간 시작을 못 찾았다: ${from}`);
  const b = src.indexOf(to, a + 1);
  assert.ok(b > a, `구간 끝을 못 찾았다: ${to}`);
  return src.slice(a, b);
}

const APPS_TABLE = slice(APPS_SRC, "export const APPS", "\n];");
const classicKeys = [...APPS_TABLE.matchAll(/^\s*\{\s*key:\s*(['"])([a-z0-9-]+)\1/gm)].map((m) => m[2]);

// ── 1. 파서가 살아 있나 (이게 죽으면 아래 전부가 조용히 무력해진다) ─────────────────
const RENDER = slice(MAIN, "async function renderRoute", "\nfunction markActive");
const routed = new Set([...RENDER.matchAll(/page === (['"])([a-z0-9-]*)\1/g)].map((m) => m[2]));

ok(routed.size >= 5, `라우터에서 최상위 화면 ${routed.size}개를 읽었다`,
  "  → renderRoute 의 모양이 바뀌어 파서가 못 읽으면 이 가드는 아무것도 안 지키게 된다. 파서를 고치세요.");
ok(classicKeys.length > 0, `클래식 표에서 화면 ${classicKeys.length}개를 읽었다`,
  "  → APPS 표 모양이 바뀌어 파서가 못 읽으면 백로그 감시가 무력화된다.");

// ── 2. 라우터 ↔ 대장 1:1 ────────────────────────────────────────────────────────
const declared = new Set(Object.keys(SHELL_SURFACES));
const undeclared = [...routed].filter((p) => !declared.has(p));

ok(undeclared.length === 0, "라우터의 모든 최상위 화면이 대장에 등록돼 있다",
  `  대장에 없는 화면: ${undeclared.map((p) => `'${p}'`).join(", ")}\n`
  + "  → web/v2/shell-surfaces.ts 의 SHELL_SURFACES 에 등록하고 셋 중 하나를 고르세요:\n"
  + "     · { kind: 'app', appId: '<앱 id>' }  — 앱으로 만든다(권장). 매니페스트·AppInstance·권한·창 규칙을 전부 받는다.\n"
  + "     · { kind: 'os', why: '<앱이 아니어야 하는 이유>' } — 셸 자체(인증·라우팅·런처)일 때만.\n"
  + "     · { kind: 'todo', plan: '<무엇으로 만들 것인가>' } — 지금은 못 옮기지만 앱화 대상일 때.\n"
  + "  설계: 지식 os-app-layer-design-v2-1-consolidated-1780 §6(OS 가 소유하는 것 / 앱이 소유하는 것).");

// 'i' 는 `page !== 'i'` 처럼 조합으로만 등장할 수 있어 위 정규식에 안 잡힌다 — 예외로 둔다.
const ROUTER_OTHER = new Set(["i"]);
const dead = [...declared].filter((p) => !routed.has(p) && !ROUTER_OTHER.has(p));

ok(dead.length === 0, "대장에 죽은 등록이 없다(대장 ⊆ 라우터)",
  `  라우터엔 없는데 대장에만 있는 화면: ${dead.map((p) => `'${p}'`).join(", ")}\n`
  + "  → 화면을 지웠으면 대장에서도 지우세요. 대장이 현실보다 크면 그때부터 아무도 안 믿습니다.");

// ── 3. os 는 이유가, todo 는 계획이, app 은 appId 가 반드시 있다 ──────────────────
const noWhy = Object.entries(SHELL_SURFACES).filter(([, v]) => v.kind === "os" && !String(v.why || "").trim());
ok(noWhy.length === 0, "OS 표면은 전부 '앱이 아니어야 하는 이유'를 갖고 있다",
  `  이유가 빈 화면: ${noWhy.map(([k]) => `'${k}'`).join(", ")}\n`
  + "  → 'os' 는 도피처가 아니다. 이유를 못 적겠으면 그건 대개 앱입니다.");

const noPlan = Object.entries(SHELL_SURFACES).filter(([, v]) => v.kind === "todo" && !String(v.plan || "").trim());
ok(noPlan.length === 0, "앱화 대상은 전부 '무엇으로 만들 것인가'를 갖고 있다",
  `  계획이 빈 화면: ${noPlan.map(([k]) => `'${k}'`).join(", ")}`);

const noAppId = Object.entries(SHELL_SURFACES).filter(([, v]) => v.kind === "app" && !String(v.appId || "").trim());
ok(noAppId.length === 0, "앱으로 적힌 화면은 전부 appId 를 갖고 있다",
  `  appId 가 빈 화면: ${noAppId.map(([k]) => `'${k}'`).join(", ")}`);

// ── 4. ★ 앱화 대상은 **줄어들기만 한다** ──────────────────────────────────────────
//  이 숫자를 올리는 변경은 곧 "이번에도 앱 밖에 화면을 하나 더 만든다"는 뜻이다. 그 결정은 사람이 해야 한다.
const TODO_CEILING = 5;   // 2026-08-25: inbox 를 앱으로 옮겨 6 → 5. 남은 것 — app · liv · archive · trash · connect
const todo = Object.entries(SHELL_SURFACES).filter(([, v]) => v.kind === "todo").map(([k]) => k);

ok(todo.length <= TODO_CEILING, `앱화 대상이 늘지 않았다(${todo.length} ≤ ${TODO_CEILING})`,
  `  지금 목록: ${todo.join(", ")}\n`
  + "  → 새 화면은 'todo' 로 넣지 말고 **앱으로 만드세요**. 이 목록은 줄어들기만 합니다.\n"
  + "  정말 늘려야 한다면 TODO_CEILING 을 올리기 전에 왜 앱으로 못 만드는지 커밋 메시지에 적으세요.");

// ── 5. 클래식 백로그(APPS 표) ↔ 대장 일치, 그리고 역시 줄어들기만 ───────────────────
const sortedKeys = [...classicKeys].sort();
const sortedBacklog = [...CLASSIC_BACKLOG].sort();

ok(JSON.stringify(sortedKeys) === JSON.stringify(sortedBacklog), "APPS 표와 CLASSIC_BACKLOG 가 같은 집합이다",
  `  APPS:    ${sortedKeys.join(", ")}\n  BACKLOG: ${sortedBacklog.join(", ")}\n`
  + "  → 화면을 앱으로 옮겼으면 **양쪽에서** 지우세요. 한쪽만 지우면 대장이 거짓말을 합니다.");

ok(classicKeys.length <= CLASSIC_BACKLOG.length, `클래식 화면이 늘지 않았다(${classicKeys.length} ≤ ${CLASSIC_BACKLOG.length})`,
  "  → APPS 표는 '아직 앱이 아닌 것' 목록입니다. 새 화면을 여기 더하지 말고 builtin AppPackage 로 만드세요.");

// ── 6. 진짜 앱은 builtin 패키지가 실재해야 한다 ──────────────────────────────────
//  대장에 'app' 이라고 적어 두고 패키지가 없으면, 그건 앱이 아니라 앱이라는 **주장**일 뿐이다.
const builtins = new Set(readdirSync(join(root, "apps/builtin")));
const missing = Object.entries(SHELL_SURFACES)
  .filter(([, v]) => v.kind === "app")
  .filter(([, v]) => !builtins.has(v.appId));

ok(missing.length === 0, "앱으로 적힌 화면은 전부 builtin 패키지가 실재한다",
  `  패키지가 없는 화면: ${missing.map(([k, v]) => `'${k}' → apps/builtin/${v.appId}`).join(", ")}`);

const kinds = Object.values(SHELL_SURFACES);
console.log(`\nshell-surface-registry: ${pass} passed`);
console.log(`  현황 — 앱 ${kinds.filter((v) => v.kind === "app").length}`
  + ` · OS 표면 ${kinds.filter((v) => v.kind === "os").length}`
  + ` · 앱화 대상 ${todo.length}(그중 클래식 화면 ${classicKeys.length})`);
