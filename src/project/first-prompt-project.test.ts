// 첫 지시로 프로젝트를 먼저 만들 자리인가(#1867) — 순수 판정만. 생성(createShellProject)은 DB·fs 라 여기서 안 잰다.
//  사양 엣지: ①어떤 지시가 프로젝트가 되나(길이·접두·여러 줄·상한) ②어떤 요청에서 선생성하나(이미 소속·폴더 선택·앱·로그인·읽기전용·인코그니토).
import assert from "node:assert/strict";
import test from "node:test";
import { AUTO_CREATED_MARK, firstPromptProjectPlan, shellProjectFromPrompt } from "./first-prompt-project.js";

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

test("프로젝트가 될 자격이 없는 지시 → null(빈 껍데기를 만들지 않는다)", () => {
  for (const bad of ["", "   ", "ㄱㄱ", "계속", "짧은지시", null, undefined]) {
    assert.equal(shellProjectFromPrompt(bad as string), null, `짧거나 없음: ${JSON.stringify(bad)}`);
  }
  assert.equal(shellProjectFromPrompt("/status 를 확인해줘"), null, "슬래시 커맨드는 사람의 실질 지시가 아니다");
  assert.equal(shellProjectFromPrompt("!ls -la /tmp/somewhere"), null, "뱅 커맨드");
  assert.equal(shellProjectFromPrompt("<system-reminder>주입물입니다</system-reminder>"), null, "하네스 주입물");
  // 경계: 정확히 12자는 통과, 11자는 아니다.
  assert.equal(shellProjectFromPrompt("가".repeat(11)), null);
  assert.ok(shellProjectFromPrompt("가".repeat(12)));
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

test("첫 지시가 없는 빈 세션 → 안 만든다(실측: 미소속 세션 60%가 빈 세션)", () => {
  assert.equal(firstPromptProjectPlan({}), null);
  assert.equal(firstPromptProjectPlan({ initialPrompt: "" }), null);
});
