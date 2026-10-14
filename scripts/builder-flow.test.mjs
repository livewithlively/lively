// 앱빌더의 순수 규칙(web/lib/builder-flow.ts) — 어떤 세션이 앱빌딩 세션이고, 어떤 프로젝트가 앱빌더 프로젝트이며, 주소를 어떻게 읽고 짓나(#4632).
//  컴파일된 모듈(public/app/lib/builder-flow.js)을 돌린다 — 빌드가 없으면 건너뛰고 그 사실을 적는다(CI 의 run-tests --build 가 돈다).
//  이게 틀리면: 사람이 지은 「앱 만들기」 프로젝트(#4632 가 그 이름)가 앱빌더로 접혀 숨거나, 앱빌딩 세션을 눌렀는데 세션 화면이 열리거나,
//   사본 주소가 고치기로 읽힌다. 사양 · 엣지 표: 세션 스크래치패드 spec.md(spec-failfirst).
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = join(root, "public/app/lib/builder-flow.js");
if (!existsSync(mod)) { console.log("builder-flow: 빌드 없음(public/app/lib/builder-flow.js) — 건너뜀"); process.exit(0); }
const F = await import(mod);

let pass = 0, fail = 0;
const check = (ok, name) => { if (ok) { pass++; console.log("ok  " + name); } else { fail++; console.error("FAIL  " + name); } };

// ── 프로젝트 · 세션 판정 ──
check(F.isBuilderProjectName("앱빌더") && F.isBuilderProjectName(" 앱빌더 "), "P1 「앱빌더」 만 앱빌더 프로젝트(앞뒤 공백 무시)");
check(!F.isBuilderProjectName("앱 만들기") && !F.isBuilderProjectName("앱빌더 2") && !F.isBuilderProjectName("") && !F.isBuilderProjectName(null), "P2 사람이 지은 「앱 만들기」 · 비슷한 이름 · 빈 값은 아니다");
check(F.isBuilderSessionLabel("앱 만들기 · 회의 안건") && F.isBuilderSessionLabel("앱 고치기 · 메모 · 장원준"), "S1 옛 꼴 두 가지도 앱빌딩 세션");
check(F.isBuilderSessionLabel('"회의록" 앱 제작') && F.isBuilderSessionLabel('"메모 · 장원준" 앱 고치기') && F.isBuilderSessionLabel("새 앱 제작") && F.isBuilderSessionLabel(' "회의록" 앱 제작 '), "S1b 새 꼴 — «\"이름\" 앱 제작» · «\"이름\" 앱 고치기» · «새 앱 제작»(앞뒤 공백 무시)");
check(!F.isBuilderSessionLabel("앱 만들기") && !F.isBuilderSessionLabel("회의 안건 앱 만들기") && !F.isBuilderSessionLabel(null) && !F.isBuilderSessionLabel("회의록 앱 제작") && !F.isBuilderSessionLabel('"" 앱 제작'), "S2 머리말만 · 뒤에 붙은 것 · 빈 값 · 따옴표 없는 «앱 제작» · 빈 따옴표는 아니다");
check(F.isBuilderSession("결제 백오프", "앱빌더") && F.isBuilderSession("앱 만들기 · x", "결제") && !F.isBuilderSession("결제 백오프", "결제") && !F.isBuilderSession(null, null), "S3 이름 꼴이거나 앱빌더 프로젝트면 앱빌딩 세션 · 둘 다 아니면 아니다");
check(F.builderSessionWhat("앱 만들기 · 회의 안건") === "회의 안건" && F.builderSessionWhat("앱 고치기 · 메모") === "메모" && F.builderSessionWhat("한글 자모분리") === "한글 자모분리" && F.builderSessionWhat(null) === "", "S4 옛 꼴의 머리말을 뗀 「무엇을」 · 없으면 그대로");
check(F.builderSessionWhat('"회의록" 앱 제작') === "회의록" && F.builderSessionWhat('"메모 · 장원준" 앱 고치기') === "메모 · 장원준" && F.builderSessionWhat("새 앱 제작") === "", "S5 새 꼴에서 따옴표 안이 「무엇을」 · 이름 없는 것은 빈 글");
check(F.builderSessionLabel("회의록") === '"회의록" 앱 제작' && F.builderSessionLabel("") === "새 앱 제작" && F.builderSessionLabel(" 메모\n", "edit") === '"메모" 앱 고치기' && F.builderSessionLabel("a\"b", "copy") === '"a b" 앱 고치기' && F.builderSessionLabel("x".repeat(50)).length === '"" 앱 제작'.length + 40, "S6 이름 짓기 — 새/고치기 · 빈 이름 · 줄바꿈·따옴표는 공백 · 40자 상한 · 짓고 다시 읽으면 같다");
check(F.builderSessionWhat(F.builderSessionLabel("회의 안건")) === "회의 안건", "S7 짓기 → 읽기 왕복");

// ── 주소 ──
const q = (m) => ({ get: (k) => (k in m ? m[k] : null) });
assert.deepEqual(F.parseBuilderRoute(["builder"]), { view: "list", id: "", how: "edit" });
assert.deepEqual(F.parseBuilderRoute(["builder", "new"]), { view: "new", id: "", how: "edit" });
assert.deepEqual(F.parseBuilderRoute(["builder", "s", "box-a%20b"]), { view: "resume", id: "box-a b", how: "edit" });
assert.deepEqual(F.parseBuilderRoute(["builder", "app", "memo"], q({ how: "copy" })), { view: "app", id: "memo", how: "copy" });
assert.deepEqual(F.parseBuilderRoute(["builder", "app", "memo"], q({})), { view: "app", id: "memo", how: "edit" });
assert.deepEqual(F.parseBuilderRoute(["builder", "app", "memo"], null), { view: "app", id: "memo", how: "edit" });
assert.deepEqual(F.parseBuilderRoute(["builder", "zzz"]), { view: "list", id: "", how: "edit" });
assert.deepEqual(F.parseBuilderRoute(["builder", "s"]), { view: "list", id: "", how: "edit" });
check(true, "R1 주소 읽기 — 목록 · 새 앱 · 이어서(디코드) · 고치기/사본(how 없음 · params 없음 = 고치기) · 모르는 꼴 · id 없는 이어서는 목록");
check(F.builderRoute("list") === "#/builder" && F.builderRoute("new") === "#/builder/new" && F.builderRoute("resume", "a b") === "#/builder/s/a%20b"
  && F.builderRoute("app", "memo", "copy") === "#/builder/app/memo?how=copy" && F.builderRoute("app", "memo") === "#/builder/app/memo", "R2 주소 짓기 — 다섯 꼴");
for (const w of [{ view: "resume", id: "a b", how: "edit" }, { view: "app", id: "m", how: "copy" }, { view: "app", id: "m", how: "edit" }, { view: "new", id: "", how: "edit" }, { view: "list", id: "", how: "edit" }]) {
  const r = F.builderRoute(w.view, w.id, w.how);
  const [path, qs] = r.replace(/^#\//, "").split("?");
  assert.deepEqual(F.parseBuilderRoute(path.split("/"), q(qs ? Object.fromEntries(new URLSearchParams(qs)) : {})), w);
}
check(true, "R3 짓고 다시 읽으면 같다(왕복)");
const T = (view, how = "edit") => F.builderTabTitle({ view, id: "m", how });
check(T("list") === "앱빌더" && T("new") === "앱빌더 · 새 앱" && T("resume") === "앱빌더 · 이어서" && T("app") === "앱빌더 · 고치기" && T("app", "copy") === "앱빌더 · 사본", "R4 탭 이름 다섯");

// ── 만들던 앱 상태 글 ──
//  다섯 단계(원준 2026-10-14 «생성된 시안과 고치기는 하나의 과정») — 속 단계 draft · fix 는 사람에게 같은 ③.
check(F.draftStageText("plan", false, false) === "② 세부 기획 정하기" && F.draftStageText("draft", false, false) === "③ 시안 만드는 중", "D1 앱이 아직 없으면 ②, 첫 판을 만드는 중이면 ③ 만드는 중");
check(F.draftStageText("draft", true, false) === "③ 시안 확인 · 고치기" && F.draftStageText("fix", true, false) === "③ 시안 확인 · 고치기" && F.draftStageText("check", true, false) === "④ 확인" && F.draftStageText("put", true, false) === "⑤ 넣기", "D2 앱이 있으면 그 단계 — draft 와 fix 는 같은 ③ · 확인 ④ · 넣기 ⑤");
check(F.draftStageText("put", true, true) === "다 만든 앱 · 이어서 고치기" && F.draftStageText("fix", false, true) === "다 만든 앱 · 이어서 고치기", "D3 다 만든 것은 단계와 무관");
check(F.draftStageText("zzz", true, false) === "③ 시안 확인 · 고치기", "D4 모르는 단계(앱 있음)는 ③ 으로");
check(!/④ 고치기|⑥/.test([F.draftStageText("fix", true, false), F.draftStageText("put", true, false), F.draftStageText("zzz", true, false)].join(" ")), "D5 옛 여섯 단계 글(④ 고치기 · ⑥)은 어디에도 없다");

console.log(`builder-flow: ${pass} 통과 · ${fail} 실패`);
if (fail) process.exit(1);
