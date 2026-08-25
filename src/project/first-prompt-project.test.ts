// 첫 지시로 프로젝트를 먼저 만들 자리인가(#1867) — 순수 판정만. 생성(createShellProject)은 DB·fs 라 여기서 안 잰다.
//  사양 엣지: ①어떤 지시가 프로젝트가 되나(길이·접두·여러 줄·상한) ②어떤 요청에서 선생성하나(이미 소속·폴더 선택·앱·로그인·읽기전용·인코그니토).
import assert from "node:assert/strict";
import test from "node:test";
import { AUTO_CREATED_MARK, UNNAMED_PROJECT, firstPromptProjectPlan, shellProjectFromPrompt } from "./first-prompt-project.js";

const PROMPT = "세션 귀속 v2 후속으로 홈 세션 cwd 를 프로젝트 폴더로 옮기자";

test("지시 → 껍데기 프로젝트 이름·본문(훅과 같은 형식)", () => {
  const out = shellProjectFromPrompt(PROMPT);
  assert.equal(out?.name, PROMPT);
  assert.match(String(out?.description), /첫 지시\(원문\)/);
  assert.ok(String(out?.description).includes(PROMPT), "본문에 원문이 그대로 남아야 정련·이관 때 근거가 된다");
  assert.ok(String(out?.description).includes(AUTO_CREATED_MARK), "정련 훅이 껍데기를 판별하는 표식");
});

test("이름은 첫 비어있지 않은 줄 · 공백 정규화 · 70자 상한", () => {
  assert.equal(shellProjectFromPrompt("\n\n  첫 줄이   여기다  \n둘째 줄은 제목이 아니다")?.name, "첫 줄이 여기다");
  const long = "가".repeat(200);
  const name = String(shellProjectFromPrompt(long)?.name);
  assert.equal(name.length, 70);
  assert.ok(name.endsWith("…"), "잘랐으면 잘렸다고 보여야 한다");
});

test("제목 재료가 못 되는 지시 → 제목은 안 뽑는다(만들기는 별개 — firstPromptProjectPlan)", () => {
  for (const bad of ["", "   ", null, undefined]) {
    assert.equal(shellProjectFromPrompt(bad as string), null, `빈 지시: ${JSON.stringify(bad)}`);
  }
  assert.equal(shellProjectFromPrompt("/status 를 확인해줘"), null, "슬래시 커맨드는 사람의 실질 지시가 아니다");
  assert.equal(shellProjectFromPrompt("!ls -la /tmp/somewhere"), null, "뱅 커맨드");
  assert.equal(shellProjectFromPrompt("<system-reminder>주입물입니다</system-reminder>"), null, "하네스 주입물");
});

// ★ 상민님 결정(2026-08-25): "빈 세션도 플젝 만들어야지 · 그냥 항상 만들어 · 껍데기 신경쓰지 말고".
//  근거의 비대칭 — 빈 껍데기는 사람이 지우면 되는 되돌릴 수 있는 비용이고, 잘못 고른 cwd 는 그 세션 내내 못 되돌린다.
test("첫 지시가 없어도 미소속 세션이면 프로젝트를 만든다(임시 이름)", () => {
  const empty = firstPromptProjectPlan({});
  assert.equal(empty?.name, UNNAMED_PROJECT);
  assert.ok(String(empty?.description).includes(AUTO_CREATED_MARK), "정련이 껍데기를 알아보는 표식");
  assert.equal(firstPromptProjectPlan({ initialPrompt: "   " })?.name, UNNAMED_PROJECT, "공백뿐인 지시도 같은 자리");
  // 제목 재료가 못 되는 지시(슬래시 등)도 **만들기는 한다** — 이름만 임시.
  assert.equal(firstPromptProjectPlan({ initialPrompt: "/status" })?.name, UNNAMED_PROJECT);
});

// ⚠ 실측(2026-08-25, dev): 상민님이 "안뇽 너느누구"(7자)로 새 세션을 열었더니 개인 루트에서 떴다.
//  훅의 12자 게이트는 '제목이 될 만한가'인데 그걸 **작업 폴더 결정**에 쓰면, 짧게 말을 건 세션의 산출물이
//  프로젝트 밖에 쌓인다. 여기는 '새 세션의 첫 지시'가 확정된 자리라 길이로 거르지 않는다.
test("짧은 첫 지시도 프로젝트를 만든다 — 제목 품질과 작업면은 다른 축", () => {
  assert.equal(shellProjectFromPrompt("안뇽 너느누구")?.name, "안뇽 너느누구");
  assert.ok(shellProjectFromPrompt("ㄱㄱ"), "두 글자라도 새 세션의 첫 지시다(제목은 정련이 고친다)");
  assert.ok(firstPromptProjectPlan({ initialPrompt: "안뇽 너느누구" }), "홈 컴포저의 짧은 인사도 프로젝트 폴더에서 연다");
});

test("홈 컴포저(첫 지시 있음·폴더 안 고름) → 선생성", () => {
  assert.ok(firstPromptProjectPlan({ initialPrompt: PROMPT }));
  assert.ok(firstPromptProjectPlan({ initialPrompt: PROMPT, rootKey: "personal" }), "개인 루트 명시도 같은 자리");
});

test("이미 프로젝트가 정해졌거나 사람이 폴더를 골랐으면 → 안 만든다", () => {
  assert.equal(firstPromptProjectPlan({ initialPrompt: PROMPT, projectId: 12 }), null, "그 프로젝트 폴더에서 연다");
  assert.equal(firstPromptProjectPlan({ initialPrompt: PROMPT, subpath: "repos/mycode" }), null, "고른 자리에서 열겠다는 뜻");
  assert.equal(firstPromptProjectPlan({ initialPrompt: PROMPT, rootKey: "shared" }), null, "개인 루트가 아닌 root 도 사람의 선택");
});

test("작업 세션이 아니거나 조직에 안 남기는 세션 → 안 만든다", () => {
  assert.equal(firstPromptProjectPlan({ initialPrompt: PROMPT, appId: "hello" }), null, "앱 세션");
  assert.equal(firstPromptProjectPlan({ initialPrompt: PROMPT, loginFor: "claude" }), null, "로그인 세션");
  assert.equal(firstPromptProjectPlan({ initialPrompt: PROMPT, readOnly: true }), null, "읽기전용은 쓰기 금지");
  assert.equal(firstPromptProjectPlan({ initialPrompt: PROMPT, incognito: true }), null, "인코그니토는 아무것도 안 남긴다");
});


