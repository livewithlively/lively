// 소스 파일에 **코드 0 문자(NUL)를 날것으로 두지 않는다** (#1631, 2026-09-13).
//
//  welcome.ts 의 백오프 키 템플릿 문자열에 NUL 문자가 날것으로 박혀 있었다(도구 호출의 JSON 이스케이프가 글자로 풀려
//   파일에 들어간 것으로 보인다). 런타임 값은 멀쩡하지만 grep 은 그 파일을 «binary file» 로 건너뛰었다(실측: 코드
//   검색에 그 파일이 안 잡혔다) — 리뷰·검색에서 파일이 통째로 사라진다. 구분자가 필요하면 보이는 글자를 쓴다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const NUL = String.fromCharCode(0);
const FILES = [
  "src/capabilities/delivery/welcome.ts",
  "src/org/store/members.ts",
  "web/v2/onboarding.ts",
  "src/capabilities/delivery/workspace-registry.ts",
  "src/auth/sessions.ts",
  "src/auth/local-accounts.ts",
];

test("★ 처음 설정·합류 판정 소스에 날것의 NUL 문자가 없다 — 검색·리뷰에서 파일이 바이너리로 사라진다", () => {
  for (const f of FILES) {
    assert.ok(!readFileSync(f, "utf8").includes(NUL), `${f} 에 NUL 문자가 날것으로 있다 — 보이는 구분자를 써라`);
  }
});
