// 첫 지시로 프로젝트를 먼저 만들 자리인가(#1867) — 순수 판정만. 생성(createShellProject)은 DB·fs 라 여기서 안 잰다.
//  사양 엣지: ①어떤 지시가 프로젝트가 되나(길이·접두·여러 줄·상한) ②어떤 요청에서 선생성하나(이미 소속·폴더 선택·앱·로그인·읽기전용·인코그니토).
import assert from "node:assert/strict";
import test from "node:test";
import { AUTO_CREATED_MARK, UNNAMED_PROJECT, firstPromptProjectPlan, shellProjectFromPrompt, shouldRenameShellProject } from "./first-prompt-project.js";

// 28자를 넘지 않는 지시 — 이름이 그대로 이름이 되는(자르지 않는) 경로를 재려면 상한 안쪽이어야 한다(#2031).
const PROMPT = "홈 세션 cwd 를 프로젝트 폴더로";
// 상한을 넘는 지시 — 자르는 경로. 이번 신고("이름이 내가 시킨 말 그대로")의 그 모양이다.
const LONG_PROMPT = "세션 귀속 v2 후속으로 홈 세션 cwd 를 프로젝트 폴더로 옮기자";

test("지시 → 껍데기 프로젝트 이름·본문(훅과 같은 형식)", () => {
  const out = shellProjectFromPrompt(PROMPT);
  assert.equal(out?.name, PROMPT);
  assert.match(String(out?.description), /첫 지시\(원문\)/);
  assert.ok(String(out?.description).includes(PROMPT), "본문에 원문이 그대로 남아야 정련·이관 때 근거가 된다");
  assert.ok(String(out?.description).includes(AUTO_CREATED_MARK), "정련 훅이 껍데기를 판별하는 표식");
});

// #2031 — 상한이 70자였을 때 이 자리가 곧 신고 내용이었다: 보드·사이드바에 지시문 한 문장이 그대로 걸렸다
//  (2026-08-26 실측 자동생성 63건 중 49건이 그 상태, 이름 평균 46자). 규칙 본체는 v6/project-name.ts 가 재고,
//  여기서는 **껍데기 생성이 그 규칙을 실제로 통과시키는지**(원문은 본문에 보존하는지)를 잰다.
test("이름은 첫 비어있지 않은 줄 · 공백 정규화 · 28자 상한", () => {
  assert.equal(shellProjectFromPrompt("\n\n  첫 줄이   여기다  \n둘째 줄은 제목이 아니다")?.name, "첫 줄이 여기다");
  const long = "가".repeat(200);
  const name = String(shellProjectFromPrompt(long)?.name);
  assert.equal(name.length, 28);
  assert.ok(name.endsWith("…"), "잘랐으면 잘렸다고 보여야 한다");
  // 긴 지시라도 **원문은 본문에 그대로** 남는다 — 이름이 짧아진 대가로 잃는 정보가 없어야 한다.
  const out = shellProjectFromPrompt(LONG_PROMPT);
  assert.ok(String(out?.name).length <= 28 && String(out?.name).endsWith("…"), "상한을 넘는 지시는 잘린 이름을 받는다");
  assert.ok(String(out?.description).includes(LONG_PROMPT), "그래도 본문엔 원문 전체가 남는다");
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
  const empty = firstPromptProjectPlan({ kind: "human" });
  assert.equal(empty?.name, UNNAMED_PROJECT);
  assert.ok(String(empty?.description).includes(AUTO_CREATED_MARK), "정련이 껍데기를 알아보는 표식");
  assert.equal(firstPromptProjectPlan({ kind: "human", initialPrompt: "   " })?.name, UNNAMED_PROJECT, "공백뿐인 지시도 같은 자리");
  // 제목 재료가 못 되는 지시(슬래시 등)도 **만들기는 한다** — 이름만 임시.
  assert.equal(firstPromptProjectPlan({ kind: "human", initialPrompt: "/status" })?.name, UNNAMED_PROJECT);
});

// ⚠ 실측(2026-08-25, dev): 상민님이 "안뇽 너느누구"(7자)로 새 세션을 열었더니 개인 루트에서 떴다.
//  훅의 12자 게이트는 '제목이 될 만한가'인데 그걸 **작업 폴더 결정**에 쓰면, 짧게 말을 건 세션의 산출물이
//  프로젝트 밖에 쌓인다. 여기는 '새 세션의 첫 지시'가 확정된 자리라 길이로 거르지 않는다.
test("짧은 첫 지시도 프로젝트를 만든다 — 제목 품질과 작업면은 다른 축", () => {
  assert.equal(shellProjectFromPrompt("안뇽 너느누구")?.name, "안뇽 너느누구");
  assert.ok(shellProjectFromPrompt("ㄱㄱ"), "두 글자라도 새 세션의 첫 지시다(제목은 정련이 고친다)");
  assert.ok(firstPromptProjectPlan({ kind: "human", initialPrompt: "안뇽 너느누구" }), "홈 컴포저의 짧은 인사도 프로젝트 폴더에서 연다");
});

test("홈 컴포저(첫 지시 있음·폴더 안 고름) → 선생성", () => {
  assert.ok(firstPromptProjectPlan({ kind: "human", initialPrompt: PROMPT }));
  assert.ok(firstPromptProjectPlan({ kind: "human", initialPrompt: PROMPT, rootKey: "personal" }), "개인 루트 명시도 같은 자리");
});

test("이미 프로젝트가 정해졌거나 사람이 폴더를 골랐으면 → 안 만든다", () => {
  assert.equal(firstPromptProjectPlan({ kind: "human", initialPrompt: PROMPT, projectId: 12 }), null, "그 프로젝트 폴더에서 연다");
  assert.equal(firstPromptProjectPlan({ kind: "human", initialPrompt: PROMPT, subpath: "repos/mycode" }), null, "고른 자리에서 열겠다는 뜻");
  assert.equal(firstPromptProjectPlan({ kind: "human", initialPrompt: PROMPT, rootKey: "shared" }), null, "개인 루트가 아닌 root 도 사람의 선택");
});

// #2162 — 판정 축이 `appId`·`loginFor` 개별 필드에서 **kind 하나**로 옮겨졌다.
//  종전엔 종류가 늘 때마다 여기 조건을 더해야 했고, 잊어도 아무 신호가 없었다 — 실제로 **위탁 워커가
//  그 틈으로 샜다**(#1979 항목4: 10분 주기 증류 크론만으로 하루 100건대). 이제 사람 작업 세션만 통과한다.
//  (요청→kind 매핑은 sessionKindFromRequest 가 담당하고 session-kind.test.ts 가 표로 잠근다.)
test("사람의 작업 세션이 아니면 → 안 만든다 (kind 축)", () => {
  for (const kind of ["app", "login", "task", "managed"]) {
    assert.equal(firstPromptProjectPlan({ kind, initialPrompt: PROMPT }), null, `kind=${kind}`);
  }
  // 대조군 — 같은 지시라도 human 이면 만든다(위 단언이 vacuous 하지 않다).
  assert.ok(firstPromptProjectPlan({ kind: "human", initialPrompt: PROMPT }), "대조군: 사람 세션은 만든다");
});

// 실행 모드는 kind 와 **직교**다 — 사람이 연 읽기전용 세션이 있다. kind 로 흡수하지 않는 이유.
test("조직에 안 남기는 실행 모드 → 안 만든다 (kind 와 직교)", () => {
  assert.equal(firstPromptProjectPlan({ kind: "human", initialPrompt: PROMPT, readOnly: true }), null, "읽기전용은 쓰기 금지");
  assert.equal(firstPromptProjectPlan({ kind: "human", initialPrompt: PROMPT, incognito: true }), null, "인코그니토는 아무것도 안 남긴다");
});



// ★ 상민님 제안(2026-08-25): "llm이 세션명 지을때 플젝명도 그거랑 똑같게 업뎃하는게 좋지않을까 기계적으로 만들어진세션이었다면"
//  기계 제목("PROJECT AUTO BIND 에서 하는일이 정확히…")이 그대로 프로젝트명으로 남는 게 나쁘다는 지적에서 나왔다.
test("세션 이름 승계 — 자동 생성 껍데기만, 사람이 손댔으면 물러난다", () => {
  const shell = { name: "안뇽 너느누구", description: `첫 지시\n${AUTO_CREATED_MARK}` };
  assert.equal(shouldRenameShellProject(shell, "세션 귀속 v2"), true);
  assert.equal(shouldRenameShellProject(shell, "안뇽 너느누구"), false, "같은 이름이면 쓰지 않는다");
  assert.equal(shouldRenameShellProject(shell, "   "), false, "빈 이름으로 덮지 않는다");
  // 사람이 정련한 프로젝트(표식 없음) — 절대 안 건드린다.
  assert.equal(shouldRenameShellProject({ name: "결제 백오프", description: "사람이 쓴 본문" }, "세션 이름"), false);
  // expectName — 그 사이 누가 제목을 고쳤으면 물러난다.
  assert.equal(shouldRenameShellProject(shell, "새 이름", { expectName: "안뇽 너느누구" }), true);
  assert.equal(shouldRenameShellProject(shell, "새 이름", { expectName: UNNAMED_PROJECT }), false, "임시값이 아니면 승계 대상이 아니다");
  assert.equal(shouldRenameShellProject(null, "이름"), false);
});

// 호출부(relabelSession)는 expectName 을 주지 않는다 — 상민님이 나쁘다고 한 이름이 바로 **첫 지시를 자른 제목**이라,
//  임시값("새 작업")일 때만 바꾸면 정작 그 경우가 안 고쳐진다. 껍데기인가(표식)만 보고 승계한다.
test("expectName 없이 부르면 기계로 자른 첫 지시 제목도 승계 대상이다", () => {
  const sliced = { name: "PROJECT AUTO BIND 에서 하는일이 정확히 뭐야? 플젝 정련하라는 훅이랑 다른…", description: AUTO_CREATED_MARK };
  assert.equal(shouldRenameShellProject(sliced, "훅 동작 확인"), true);
  const placeholder = { name: UNNAMED_PROJECT, description: AUTO_CREATED_MARK };
  assert.equal(shouldRenameShellProject(placeholder, "훅 동작 확인"), true, "임시값도 같은 자리");
});
