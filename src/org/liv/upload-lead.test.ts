// 남의 자료를 그 사람 것이라 부르지 않는다 (#1631)
//
//  실측 2026-08-31: 팀 워크스페이스에서 파일 5건을 올린 사람에게 리브가 «테스터님이 올려 주신 자료 2,274건»
//   이라고 했다. 자료에 사람 축이 없어서다(source 는 author='connector:local' 까지만 안다).
//   남이 모아 둔 것을 그 사람 것이라 부르는 셈이고, 제품이 첫 대면에서 사실이 아닌 말을 한다.
//
//  ★ 그 문장이 있던 자리(리브 챗 문답 b1)는 **2026-08-31 통째로 없어졌다**(원준님: 챗 제거).
//   그래서 이 검사는 이제 «그 문장이 이렇게 쓰였나» 가 아니라 **«그 문장이 조건 없이 돌아오지 않는가»** 를 지킨다.
//   지금은 아예 없으므로 통과다 — 누군가 다시 쓰면 그때 조건을 요구한다.
//   ⚠ 코드가 사라졌다고 검사를 지우면, 같은 실수를 할 때 아무도 안 막는다. 지키는 대상을 옮기는 것이 맞다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  new URL("../../../web/v2/onboarding.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const code = SRC.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("«올려 주신 자료 N건» 을 조건 없이 쓰지 않는다", () => {
  const hits = [...code.matchAll(/올려 주신 자료 <b>\$\{(\w+)\}건/g)].map((m) => m[1]);
  if (!hits.length) return;   // 그 문장이 없다 — 지금 상태. 위반할 것도 없다.
  //  있다면 **총계(total)** 를 그대로 그 사람 것이라 불러선 안 된다. 이 사람 몫의 수여야 한다.
  for (const v of hits) {
    assert.notEqual(v, "total",
      "총계를 그 사람이 «올려 주신» 것이라고 부른다 — 팀 워크스페이스에서 사실이 아니다");
  }
});

test("총계를 말할 땐 그것이 전체임을 밝힌다", () => {
  if (!/이 워크스페이스에 쌓여 있는 자료|올려 주신 자료/.test(code)) return;   // 둘 다 없으면 검사할 것이 없다
  assert.match(code, /이 워크스페이스에 쌓여 있는 자료/,
    "전체를 가리키는 정직한 표현이 없다 — 총계를 말하면서 그것이 전체라고 밝히지 않는다");
});
