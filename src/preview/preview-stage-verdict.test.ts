// stage 합성 머지 실패의 **사유 판정**(#3778, 2026-09-09) — 엣지 표 6행 각각에 시나리오 하나.
//
// 왜 이 테스트가 있나: 종전 코드는 `git merge` 의 비-0 종료를 전부 «conflict» 로 적었다. 그래서
//  «커밋을 못 만들었다»(신원 부재)가 화면엔 «서로 충돌» 로 나왔고, 사람은 있지도 않은 코드 충돌을
//  찾으러 갔다 — 2026-09-09 에 세션 둘이 같은 함정에 걸렸고 한 세션은 «원인 미상» 으로 닫았다.
//  «모르면 충돌이라고 말한다» 가 정확히 이 기능이 하면 안 되는 일이다.
//
// 판정 근거는 **인덱스에 남은 unmerged 항목**이다(`git ls-files -u`) — stderr 문구는 로케일을 타서 안 본다.
// 그래서 이 테스트도 문구가 아니라 **판정 결과**로 단언한다.
import test from "node:test";
import assert from "node:assert/strict";
import { mergeVerdict } from "./preview-stage.js";

// 진짜 충돌일 때 `git ls-files -u` 가 뱉는 모양(스테이지 1·2·3).
const UNMERGED = [
  "100644 8f3a1c2b1d0e4f5a6b7c8d9e0f1a2b3c4d5e6f70 1\tweb/v2/panes.ts",
  "100644 9a4b2d3c2e1f5a6b7c8d9e0f1a2b3c4d5e6f7081 2\tweb/v2/panes.ts",
  "100644 ab5c3e4d3f2a6b7c8d9e0f1a2b3c4d5e6f708192 3\tweb/v2/panes.ts",
].join("\n");

// 1행 — 인덱스에 unmerged 가 남았다 = 진짜 충돌.
test("V1 unmerged 가 있으면 conflict, 사유는 비운다(코드를 보라는 뜻이라 문장이 필요 없다)", () => {
  const v = mergeVerdict(UNMERGED, "CONFLICT (content): Merge conflict in web/v2/panes.ts");
  assert.equal(v.status, "conflict");
  assert.equal(v.detail, "");
});

// 2행 — 이 세션이 실제로 밟은 실패. 인덱스는 깨끗한데 커밋을 못 만든다.
test("V2 인덱스가 깨끗하면 conflict 가 아니다 — 사유를 실어 보낸다", () => {
  const err = "*** Please tell me who you are.\nfatal: unable to auto-detect email address (got 'root@box.(none)')";
  const v = mergeVerdict("", err);
  assert.equal(v.status, "failed", "신원 부재를 «충돌» 이라고 말하면 안 된다");
  assert.match(v.detail, /unable to auto-detect email address/);
});

// 3행 — git 은 결론을 끝에 적는다. 앞줄 warning 을 사유로 내밀면 사람이 엉뚱한 걸 쫓는다.
test("V3 사유는 마지막 비지 않은 줄이다", () => {
  const v = mergeVerdict("", "warning: 무시해도 되는 앞줄\nfatal: 진짜 사유\n");
  assert.equal(v.detail, "fatal: 진짜 사유");
});

// 4행 — 모르면 모른다고 말한다. 빈 문자열은 화면에서 «사유 없음» 이 아니라 «아무 일 없음» 으로 읽힌다.
test("V4 stderr 가 비어도 사유 자리를 비우지 않는다", () => {
  const v = mergeVerdict("", "   \n  \n");
  assert.equal(v.status, "failed");
  assert.equal(v.detail, "알 수 없는 오류");
});

// 5행 — 새로 도입한 판정 입력이 «비었을 때» 의 변형. 빈 문자열만 보면 공백 출력을 충돌로 오판한다.
test("V5 unmerged 가 공백뿐이면 충돌이 아니다", () => {
  const v = mergeVerdict("\n  \n", "fatal: 뭔가 잘못됐다");
  assert.equal(v.status, "failed", "공백 출력을 «스테이지 있음» 으로 세면 안 된다");
  assert.equal(v.detail, "fatal: 뭔가 잘못됐다");
});

// 6행 — 경계값. last_error 한 줄이 화면을 밀어내지 않아야 한다.
test("V6 사유는 300자에서 자른다", () => {
  const v = mergeVerdict("", "fatal: " + "가".repeat(500));
  assert.equal(v.detail.length, 300);
});
