// 세션 생성 가드 — 신뢰 대화상자 자동 수락 판정(autoTrustWorkspace). (노드+앱 400 가드는 #3626 에서 사라졌다 — 관문이 하나가 되며 거절 자리도 relay 계약 하나뿐.)
import { strict as assert } from "node:assert";
import test from "node:test";
import { autoTrustWorkspace } from "./session-create-guards.js";
import { sessionInputFromBody } from "./session-launch.js";

// ── #1867 회귀: 첫 지시가 신뢰 대화상자에 막히던 자리 ──────────────────────────
//  실측(2026-08-25, dev 라이브): 프로젝트 세션을 노드에서 열면 cwd 가 라이블리가 방금 만든 `project/<id>` 인데도
//  "Is this a project you trust?" 에서 멈춰 첫 지시가 안 들어갔다. 기준은 '세션 폴더인가'가 아니라 '우리가 만든 자리인가'.
test("subpath 없음 = 라이블리 루트 → 자동 수락", () => {
  assert.equal(autoTrustWorkspace({}), true);
  assert.equal(autoTrustWorkspace({ subpath: "" }), true);
  assert.equal(autoTrustWorkspace({ projectId: 12, subpath: null }), true);
});

test("프로젝트 세션의 canonical 폴더(+하위 워크트리) → 자동 수락", () => {
  assert.equal(autoTrustWorkspace({ projectId: 12, subpath: "project/12" }), true);
  assert.equal(autoTrustWorkspace({ projectId: 12, subpath: "project/12/lively" }), true, "provision 된 레포 워크트리도 그 폴더 안이다");
  assert.equal(autoTrustWorkspace({ projectId: 12, subpath: "legacy-project/12" }), true, "아카이브된 프로젝트 폴더도 우리 것");
  assert.equal(autoTrustWorkspace({ projectId: 12, subpath: "/project/12/" }), true, "앞뒤 슬래시 표기차");
  assert.equal(autoTrustWorkspace({ projectId: 12, subpath: "project\\12" }), true, "윈도우 구분자 표기차");
});

// ── #4032: 리브 세션 — 서버가 개인 루트의 liv 에 task 종류로 여는 세션(리브 탭·처음 설정 킥오프) ──────────
//  실측(2026-09-16, 매니지드): 리브 세션을 <개인 루트>/liv 로 옮기자 첫 말이 신뢰 대화상자 앞에서 멈췄다
//  (아웃박스 trust_ok=false · sending 고착 · 대화 기록 404). 그 자리는 라이블리가 정했다.
//  ⚠ 같은 좌표를 사람도 홈의 새 세션 폼에서 만들 수 있다 — 그래서 좌표만이 아니라 요청으로 못 만드는 종류(task)를 함께 본다.
test("리브 세션(task · 개인 루트의 liv) → 자동 수락 — 정확히 그 폴더, 개인 루트, 서버가 연 세션만", () => {
  const T = "task" as const;
  const rows: Array<[string, Parameters<typeof autoTrustWorkspace>[0], boolean]> = [
    ["E1 서버가 연 리브 세션", { kind: T, rootKey: "personal", subpath: "liv" }, true],
    ["E2 루트 키 없음 = 세션 생성 기본값(personal)", { kind: T, subpath: "liv" }, true],
    ["E2 루트 키 빈칸", { kind: T, rootKey: "", subpath: "liv" }, true],
    ["E2 루트 키 null", { kind: T, rootKey: null, subpath: "liv" }, true],
    ["E3 공유 루트의 liv 는 리브 자리가 아니다", { kind: T, rootKey: "shared", subpath: "liv" }, false],
    ["E4 liv 아래 폴더는 리브 자리가 아니다(부팅 훅 게이트도 basename 이 liv 인 곳뿐)", { kind: T, rootKey: "personal", subpath: "liv/notes" }, false],
    ["E5 앞뒤 슬래시", { kind: T, rootKey: "personal", subpath: "/liv/" }, true],
    ["E5 끝 슬래시", { kind: T, rootKey: "personal", subpath: "liv/" }, true],
    ["E5 윈도우 구분자", { kind: T, rootKey: "personal", subpath: "\\liv\\" }, true],
    ["E6 대소문자가 다른 폴더", { kind: T, rootKey: "personal", subpath: "Liv" }, false],
    ["E6 뒤에 글자가 붙은 폴더", { kind: T, rootKey: "personal", subpath: "livx" }, false],
    ["E6 앞에 글자가 붙은 폴더", { kind: T, rootKey: "personal", subpath: "xliv" }, false],
    ["E6 ./liv 표기(정규화하지 않는다 — 보수적)", { kind: T, rootKey: "personal", subpath: "./liv" }, false],
    ["E6 다른 폴더 아래의 liv", { kind: T, rootKey: "personal", subpath: "lib/liv" }, false],
    ["E7 프로젝트가 붙어 있어도 같은 폴더", { kind: T, rootKey: "personal", subpath: "liv", projectId: 12 }, true],
    ["E8 사람이 고른 폴더(무회귀)", { kind: "human", rootKey: "personal", subpath: "repos/x" }, false],
    ["E9 공유 루트 그 자체(무회귀)", { kind: "human", rootKey: "shared", subpath: "" }, true],
    ["E11 ★ 사람이 홈 폼에서 개인 폴더에 liv 를 만들어 연 세션 → 사람이 답한다", { kind: "human", rootKey: "personal", subpath: "liv" }, false],
    ["E12 종류를 모름(구 호출부) → 보수적으로 거절", { rootKey: "personal", subpath: "liv" }, false],
    ["E12 종류 null", { kind: null, rootKey: "personal", subpath: "liv" }, false],
    ["E13 앱 세션", { kind: "app", rootKey: "personal", subpath: "liv" }, false],
    ["E13 로그인 세션", { kind: "login", rootKey: "personal", subpath: "liv" }, false],
    ["E13 상시 세션", { kind: "managed", rootKey: "personal", subpath: "liv" }, false],
  ];
  for (const [why, input, want] of rows) assert.equal(autoTrustWorkspace(input), want, why);
});

//  E14 — 위 규칙의 전제: 세션 생성 요청(HTTP 본문)으로는 task 종류를 만들 수 없다. 이 전제가 깨지면 E11 이 뚫린다.
test("E14 요청 본문에 kind:task 를 실어도 사람 세션이다 — 리브 폴더 좌표를 골라도 자동 수락되지 않는다", () => {
  const input = sessionInputFromBody({}, { kind: "task", rootKey: "personal", subpath: "liv", harness: "claude" });
  assert.equal(input.kind, "human", "★ 요청이 세션 종류를 task 로 정한다(서버 내부 신호가 위조된다)");
  assert.equal(input.rootKey, "personal");
  assert.equal(input.subpath, "liv");
  assert.equal(autoTrustWorkspace(input), false, "★ 사람이 고른 liv 폴더를 대신 신뢰한다");
});

test("사람이 고른 폴더 → 자동 수락하지 않는다(사람이 답한다)", () => {
  assert.equal(autoTrustWorkspace({ subpath: "repos/someones-code" }), false, "프로젝트 세션이 아닌데 폴더를 골랐다");
  assert.equal(autoTrustWorkspace({ projectId: 12, subpath: "project/99" }), false, "다른 프로젝트 폴더");
  assert.equal(autoTrustWorkspace({ projectId: 12, subpath: "project/123" }), false, "경계: 접두만 같은 폴더(12 vs 123)");
  assert.equal(autoTrustWorkspace({ projectId: 12, subpath: "elsewhere/project/12" }), false, "첫 세그먼트가 프로젝트 베이스가 아니다");
  assert.equal(autoTrustWorkspace({ projectId: 0, subpath: "project/0" }), false, "프로젝트 id 가 아니면 판정 불가 → 보수적");
});
