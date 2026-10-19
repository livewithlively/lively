// 앱빌더의 순수 규칙(web/lib/builder-flow.ts) — 어떤 세션이 앱빌딩 세션이고, 어떤 프로젝트가 앱빌더 프로젝트이며, 주소를 어떻게 읽고 짓나(#4632).
//  컴파일된 모듈(public/app/lib/builder-flow.js)을 돌린다 — 빌드가 없으면 건너뛰고 그 사실을 적는다(CI 의 run-tests --build 가 돈다).
//  이게 틀리면: 사람이 지은 「앱 만들기」 프로젝트(#4632 가 그 이름)가 앱빌더로 접혀 숨거나, 앱빌딩 세션을 눌렀는데 세션 화면이 열리거나,
//   사본 주소가 고치기로 읽힌다. 사양 · 엣지 표: 세션 스크래치패드 spec.md(spec-failfirst).
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
//  BUILDER_FLOW_JS — 다른 빌드(fail-first · 옛 트리)를 물릴 때. 없으면 이 트리의 빌드.
const mod = process.env.BUILDER_FLOW_JS || join(root, "public/app/lib/builder-flow.js");
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

// ── 앱빌더 사이드바(#4632 원준 2026-10-17 «앱 빌더의 사이드바도 기획해줘») — 고른 카드도 주소에 · 켜진 줄 · 짧은 단계. 엣지 표: 스크래치패드 spec-side-owner.md C ──
check(JSON.stringify(F.parseBuilderRoute(["builder"], q({ sel: "memo" }))) === JSON.stringify({ view: "list", id: "memo", how: "edit" })
  && F.parseBuilderRoute(["builder"], q({ sel: "  memo " })).id === "memo" && F.parseBuilderRoute(["builder"], q({ sel: "" })).id === "", "R5 목록의 고른 카드는 ?sel= — 앞뒤 공백은 떼고 빈 값은 고른 것 없음");
check(F.parseBuilderRoute(["builder", "new"], q({ sel: "x" })).id === "" && F.parseBuilderRoute(["builder", "zzz"], q({ sel: "x" })).id === "", "R6 목록이 아닌 칸 · 모르는 칸에 붙은 sel 은 고른 것이 아니다");
{
  const back = (r) => { const [path, qs] = r.replace(/^#\//, "").split("?"); return F.parseBuilderRoute(path.split("/"), q(qs ? Object.fromEntries(new URLSearchParams(qs)) : {})); };
  check(F.builderRoute("list", "memo") === "#/builder?sel=memo" && back(F.builderRoute("list", "memo")).id === "memo" && back(F.builderRoute("list", "draft:box-1")).id === "draft:box-1"
    && F.builderRoute("list", "") === "#/builder", "R7 고른 카드 주소 짓기 ↔ 읽기 왕복(앱 · 만들던 앱 «draft:<세션>») · 빈 값은 맨 목록");
}
const K = (view, id = "", how = "edit") => F.builderSideKey({ view, id, how });
check(K("new") === "new" && K("resume", "box-1") === "draft:box-1" && K("app", "memo") === "app:memo" && K("app", "memo", "copy") === "app:memo", "R8 켜질 줄 — 새 앱 · 이어서 = 그 만들던 앱 · 고치기 · 사본 = 그 앱");
check(K("list") === "all" && K("list", "memo") === "app:memo" && K("list", "draft:box-1") === "draft:box-1", "R9 목록 — 고른 것 없으면 「모든 앱」 · 고른 앱 · 고른 만들던 앱");
const H = (h) => F.parseBuilderHash(h);
check(H("#/sources") === null && H("") === null && H(null) === null && H("#/") === null, "R10 앱빌더 주소가 아니면 null");
check(JSON.stringify(H("#/builder/s/box%201")) === JSON.stringify({ view: "resume", id: "box 1", how: "edit" }) && H("#builder").view === "list"
  && H("#/builder?sel=a").id === "a" && JSON.stringify(H("#/builder/app/m?how=copy")) === JSON.stringify({ view: "app", id: "m", how: "copy" }), "R11 주소 한 줄 읽기 — 이어서(디코드) · 슬래시 없는 꼴 · 고른 카드 · 사본");
check(F.draftStageShort("put", true, true) === "다 만듦" && F.draftStageShort("plan", false, false) === "② 기획" && F.draftStageShort("draft", false, false) === "③ 시안"
  && F.draftStageShort("fix", true, false) === "③ 시안" && F.draftStageShort("draft", true, false) === "③ 시안" && F.draftStageShort("check", true, false) === "④ 확인"
  && F.draftStageShort("put", true, false) === "⑤ 넣기" && F.draftStageShort("zzz", true, false) === "③ 시안", "R12 사이드바 줄의 짧은 단계 — 긴 글(draftStageText)과 같은 번호");
{
  let threw = null; let w1 = null, w2 = null;
  try { w1 = F.parseBuilderHash("#/builder/s/%"); w2 = F.parseBuilderHash("#/builder/app/%E0%A4%A"); } catch (e) { threw = String(e); }
  check(threw === null && w1 && w1.view === "resume" && w1.id === "%" && w2 && w2.view === "app" && w2.id === "%E0%A4%A", "R13 틀린 %-꼴에도 던지지 않고 그대로 읽는다(사이드바가 그리기마다 읽는다)", threw || [w1, w2]);
}

// ── 만들던 앱 상태 글 ──
//  다섯 단계(원준 2026-10-14 «생성된 시안과 고치기는 하나의 과정») — 속 단계 draft · fix 는 사람에게 같은 ③.
check(F.draftStageText("plan", false, false) === "② 세부 기획 정하기" && F.draftStageText("draft", false, false) === "③ 시안 만드는 중", "D1 앱이 아직 없으면 ②, 첫 판을 만드는 중이면 ③ 만드는 중");
check(F.draftStageText("draft", true, false) === "③ 시안 확인 · 수정" && F.draftStageText("fix", true, false) === "③ 시안 확인 · 수정" && F.draftStageText("check", true, false) === "④ 확인" && F.draftStageText("put", true, false) === "⑤ 넣기", "D2 앱이 있으면 그 단계 — draft 와 fix 는 같은 ③ · 확인 ④ · 넣기 ⑤");
check(F.draftStageText("put", true, true) === "다 만든 앱 · 이어서 고치기" && F.draftStageText("fix", false, true) === "다 만든 앱 · 이어서 고치기", "D3 다 만든 것은 단계와 무관");
check(F.draftStageText("zzz", true, false) === "③ 시안 확인 · 수정", "D4 모르는 단계(앱 있음)는 ③ 으로");
check(!/④ 고치기|⑥/.test([F.draftStageText("fix", true, false), F.draftStageText("put", true, false), F.draftStageText("zzz", true, false)].join(" ")), "D5 옛 여섯 단계 글(④ 고치기 · ⑥)은 어디에도 없다");

// ── 만드는 중인 앱(원준 2026-10-15 «끝까지 안 만들었는데 왜 먼저 앱으로 나와») — 앱 찾기와 앱빌더가 같은 자로 잰다 ──
//  building = 앱빌더가 새로 만드는 중(만들기 세션이 isBuildingSession 이거나 이 브라우저의 새 앱 기록) — 부르는 쪽이 잰다.
const ap = (o = {}) => ({ visibility: "me", empty: false, studio: { put: false }, ...o });
check(F.isAppInProgress(ap(), true) === true, "I1 나만 · 첫 판 있음 · 넣기 전 · 앱빌더가 새로 만드는 중 = 만드는 중(회의록 꼴)");
check(F.isAppInProgress(ap(), false) === false, "I2 앱빌더가 만드는 중이 아니면(보통 AI 세션이 저장한 나만 앱 · 고치는 중인 쓰던 앱) 다 만든 앱");
check(F.isAppInProgress(ap({ studio: { put: true } }), true) === false, "I4 ⑤ 넣기를 지났으면 만드는 중이 아니다");
check(F.isAppInProgress(ap({ visibility: "all" }), true) === false, "I5 공개한 앱은 고치는 중이어도 앱으로 선다");
check(F.isAppInProgress(ap({ empty: true }), true) === false, "I6 첫 판 없는 빈 예약은 여기서 다루지 않는다");
check(F.isAppInProgress(ap({ visibility: undefined }), true) === false && F.isAppInProgress(ap({ visibility: "zzz" }), true) === false, "I7 모르는 공개 범위는 'all' 로 읽는다");
check(F.isAppInProgress(ap({ studio: null }), true) === true && F.isAppInProgress(ap({ studio: { put: "yes" } }), true) === true, "I9 studio 칸이 없거나 put 이 참(true)이 아니면 넣기 전");

// ── 앱빌더가 새 앱을 만드는 세션인가 ──
check(F.isBuildingSession('"회의록" 앱 제작', "") && F.isBuildingSession("새 앱 제작", null) && F.isBuildingSession("앱 만들기 · 회의록 녹음본을", "앱 만들기"), "B1 «\"이름\" 앱 제작» · 「새 앱 제작」 · 옛 「앱 만들기 · 」 는 새 앱 세션");
check(!F.isBuildingSession('"메모" 앱 고치기', "앱빌더") && !F.isBuildingSession("앱 고치기 · 메모 · 원준", "앱빌더"), "B2 「… 앱 고치기」 는 앱빌더 프로젝트여도 아니다(쓰던 앱을 고치는 중)");
check(F.isBuildingSession("회의록 기획카드", "앱빌더") && F.isBuildingSession("회의록 기획카드", " 앱빌더 "), "B3 AI 가 이름을 덮은 옛 세션도 앱빌더 프로젝트면 새 앱 세션");
check(!F.isBuildingSession("회의록 기획카드", "회의록 정리") && !F.isBuildingSession("메모 앱 만들어 줘", null), "B4 앱빌더 밖 보통 AI 세션은 아니다(그 세션이 저장한 앱은 다 만든 앱)");
check(!F.isBuildingSession("", "") && !F.isBuildingSession(null, null) && !F.isBuildingSession('"" 앱 제작', ""), "B5 빈 이름 · 빈 따옴표는 아니다");

// ── 만들던 앱 카드 이름 — 사람이 정한 앱 이름이 먼저(원준 2026-10-15 «내가 이름 정해 주지 않았나? 그걸로») ──
check(F.draftTitle({ title: "회의록", cardName: "다른", label: '"x" 앱 제작', appTitle: "y", what: "z" }) === "회의록", "T1 ①에서 적은 이름이 먼저");
check(F.draftTitle({ title: "", cardName: "회의 안건", label: "앱 만들기 · 주간 회의 안건을 모으고 끝난 것 표", appTitle: "", what: "주간 회의…" }) === "회의 안건", "T2 이름이 없으면 기획 카드의 이름(옛 세션 이름의 설명보다 먼저)");
check(F.draftTitle({ title: "  ", cardName: "", label: '"회의록" 앱 제작', appTitle: "회의록v2", what: "" }) === "회의록", "T3 공백 이름은 없는 것 · 세션 이름 «\"이름\" 앱 제작» 의 이름이 앱 이름보다 먼저");
check(F.draftTitle({ label: "회의록 기획카드", appTitle: "회의록" }) === "회의록", "T4 AI 가 지은 세션 이름보다 첫 판의 앱 이름이 먼저");
check(F.draftTitle({ label: "앱 만들기 · 회의록 녹음본을 올리면 바로 사용자가" }) === "회의록 녹음본을 올리면 바로 사용자가", "T5 다른 것이 없으면 옛 세션 이름에서 머리말을 뗀 것");
check(F.draftTitle({ label: "새 앱 제작", what: "첫 줄\n둘째 줄" }) === "첫 줄", "T6 이름 없는 세션(「새 앱 제작」)이면 적은 설명의 첫 줄");
check(F.draftTitle({}) === "이름 없는 앱" && F.draftTitle({ title: null, cardName: null, label: null, appTitle: null, what: null }) === "이름 없는 앱", "T7 아무것도 없으면 「이름 없는 앱」");
check(F.builderSessionName('"회의록" 앱 제작') === "회의록" && F.builderSessionName('"메모 · 원준" 앱 고치기') === "메모 · 원준" && F.builderSessionName("새 앱 제작") === "" && F.builderSessionName("회의록 기획카드") === "" && F.builderSessionName(null) === "", "N1 세션 이름에 박힌 앱 이름 — 그 꼴이 아니면 빈 글");

// ══ G 시험 세션 «"이름" 앱 시험»(#4632 원준 2026-10-15 · 사양 표 G) — 앱빌딩 세션이 아니고 목록에 안 선다 ══
check(F.isTrySession('"회의록" 앱 시험') && F.isTrySession('  "회의록" 앱 시험  ') && !F.isTrySession('"회의록" 앱 제작') && !F.isTrySession("회의록 시험") && !F.isTrySession("") && !F.isTrySession(null), "G1 isTrySession — 그 꼴만");
check(!F.isBuilderSession('"회의록" 앱 시험', "앱빌더") && !F.isBuilderSession('"회의록" 앱 시험', "") && F.isBuilderSession('"회의록" 앱 제작', "앱빌더") && F.isBuilderSession("회의록 시험", "앱빌더"), "G2 isBuilderSession — 시험 세션은 앱빌더 소속이어도 아니다 · 나머지는 종전");
check(!F.isBuildingSession('"회의록" 앱 시험', "앱빌더") && F.isBuildingSession('"회의록" 앱 제작', "앱빌더") && F.isBuildingSession("회의록 시험", "앱빌더"), "G3 isBuildingSession — 시험 세션은 만드는 세션이 아니다 · 나머지는 종전");
check(F.trySessionLabel("회의록") === '"회의록" 앱 시험' && F.trySessionLabel("") === '"앱" 앱 시험' && F.trySessionLabel("   ") === '"앱" 앱 시험' && F.trySessionLabel(null) === '"앱" 앱 시험' && F.trySessionLabel('a"b\n') === '"a b" 앱 시험' && F.trySessionLabel("가".repeat(50)) === '"' + "가".repeat(40) + '" 앱 시험', "G4 trySessionLabel — 빈 이름은 「앱」 · 따옴표 · 줄바꿈은 빈칸 · 40자");
check(F.isTrySession(F.trySessionLabel("회의록")) && F.isTrySession(F.trySessionLabel("")), "G5 지은 이름은 늘 시험 세션으로 읽힌다(왕복)");

// G6 기록을 잃은 시험 세션을 이름으로 다시 찾는다(격리 리뷰 #1 — 숨긴 세션이라 사람은 못 찾는다)
{
  const L = '"회의록" 앱 시험';
  const rows = [null, { id: "box-a", label: '"회의록" 앱 제작', projectId: 4680 }, { id: "box-b", label: L, projectId: 999 }, { id: "", label: L, projectId: 4680 }, { id: "box-c", label: L, project_id: 4680 }, { id: "box-d", label: L, projectId: 4680 }];
  check(F.findTrySession(rows, L, 4680) === "box-c", "G6 같은 이름 · 같은 프로젝트의 첫 줄(다른 프로젝트 · 빈 id · 만드는 세션은 건너뛴다 · project_id 도 읽는다)");
  check(F.findTrySession([{ id: "box-e", label: L }], L, 4680) === "box-e" && F.findTrySession(rows, '"메모" 앱 시험', 4680) === "" && F.findTrySession(rows, '"회의록" 앱 제작', 4680) === "" && F.findTrySession([], L, 4680) === "", "G7 프로젝트를 모르는 줄은 이름만으로 · 없으면 빈 글 · 시험 세션 이름이 아니면 찾지 않는다");
}

// G8 기록만 남은 줄도 시험 세션으로 알아본다(격리 리뷰 재검토 — 기록 줄의 name 은 첫 말에서 지은 이름이지 사람이 지은 이름이 아니다)
{
  const brief = "이 세션은 「회의록」 앱(app_id meeting-notes)을 시험해 보는 세션이야. 이 세션 오른쪽에 그 앱이 붙어 있고, 사람이 앱을 써 보면서 너에게 말을 걸 거야 — 앱이 세션에 붙었을 때처럼 앱의 지침과…";
  const logRow = { session_id: "c2f1-uuid", name: "이 세션은 「회의록」 앱(app_id meetin…", title: brief, bytes: 900, project_id: 4680 };
  check(F.isTrySessionTitle(brief) && !F.isTrySessionTitle("이 세션은 회의록을 정리해") && !F.isTrySessionTitle("") && !F.isTrySessionTitle(null), "G8 isTrySessionTitle — 첫 지시 머리만");
  check(F.isTrySessionRow(logRow) && F.isTrySessionRow({ label: '"회의록" 앱 시험' }) && F.isTrySessionRow({ name: '"회의록" 앱 시험' }) && F.isTrySessionRow({ label: "x", logTitle: brief }) && F.isTrySessionRow({ label: "x", raw: { title: brief } }), "G9 isTrySessionRow — 박스 줄(label) · 기록 줄(name · title) · 접힌 줄(logTitle) · 날 줄(raw.title)");
  check(!F.isTrySessionRow({ label: '"회의록" 앱 제작', title: "회의록 앱을 만들고 싶어" }) && !F.isTrySessionRow(null) && !F.isTrySessionRow({}) && !F.isTrySessionRow({ label: 3, raw: null }), "G10 시험 세션이 아닌 줄 · 빈 값 · 이상한 값은 거르지 않는다");
  check(F.findTrySession([{ id: "box-x", label: '"회의록" 앱 시험', projectId: 4680, owned: false }, { id: "box-y", label: '"회의록" 앱 시험', projectId: 4680, trashedAt: "2026-10-15" }, { id: "box-z", label: '"회의록" 앱 시험', projectId: 4680 }], '"회의록" 앱 시험', 4680) === "box-z", "G11 남의 세션 · 치운 세션은 다시 쓰지 않는다");
}

// V ③ 실제 화면을 보는 중 — 주소에 적는다(#4632 원준 2026-10-19 «3단계에서 앱 전체화면 보면서 만들 때 … 앱 빌더의 사이드바가 등장하네. 안그렇게 해줘»)
//  사이드바 주인(lib/side-owner)이 이 표시로 앱빌더 사이드바를 접는다. 이게 틀리면 시험 세션 옆에 앱빌더 목록이 서거나, 허브로 돌아와도 사이드바가 안 돌아온다.
{
  const has = typeof F.builderSeeRoute === "function" && typeof F.builderSeeing === "function";
  check(has, "V0 builderSeeRoute · builderSeeing 이 있다");
  if (has) {
    const r = F.builderSeeRoute("box 1", "widget");
    check(r === "#/builder/s/box%201?see=widget" && F.builderSeeing(r) === "widget" && F.builderSeeing(F.builderSeeRoute("s2", "app")) === "app", "V1 짓기 ↔ 읽기 — 세션 id 를 싸서 · 꼴 둘(widget · app)");
    check(F.parseBuilderHash(r) && F.parseBuilderHash(r).view === "resume" && F.parseBuilderHash(r).id === "box 1", "V1 보는 중 주소도 그 세션을 이어 만드는 주소다(앱빌더가 같은 화면을 그린다)");
    const S = F.builderSeeing;
    check(S("#/builder/s/x?see=zzz") === "" && S("#/builder/s/x?see=") === "" && S("#/builder/s/x") === "" && S("#/builder?see=widget") === "" && S("#/builder/new?see=widget") === ""
      && S("#/builder/app/memo?see=app") === "" && S("#/s/box-1?see=widget") === "" && S("") === "" && S(null) === "" && S(undefined) === "" && S("#/builder/s/?see=widget") === "",
      "V2 그 밖은 '' — 모르는 값 · 빈 값 · 표시 없음 · 목록 · 새 앱 · 고치기 · 다른 화면 · 빈 주소 · 세션 없는 주소");
  }
}

console.log(`builder-flow: ${pass} 통과 · ${fail} 실패`);
if (fail) process.exit(1);
