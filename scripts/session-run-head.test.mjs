// #2116 — "이 세션이 **어느 컴퓨터에서** 도는가"가 세션 머리줄에서 사라지지 않게 지킨다.
//
// 왜 소스 텍스트를 보나: 이 기능의 실패는 판정이 틀려서가 아니라 **그 칸이 통째로 안 그려져서** 났다.
//  #1870(2026-08-24)이 상단 선택기(하네스·모델·강도)를 넣으면서 읽기전용 알약을 `runEl.hidden = true; return;`
//  으로 통째로 껐는데, 그 알약이 **노드**도 싣고 있었다. 선택기는 노드를 말하지 않으므로 그날부터
//  "어느 컴퓨터에서 도는지"를 화면에서 아무도 말하지 않았다(원준 2026-08-27 신고).
//  web/ 은 테스트 러너가 안 훑는 층이라(src/** 와 kit|scripts|deploy/** 만 돈다) 배선 가드로 못 박는다 —
//  scripts/session-open-restore.test.mjs 와 같은 방식이다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };

const src = read("web/session-chat.ts");
const i = src.indexOf("function paintRunHead()");
assert.ok(i > 0, "paintRunHead 를 찾지 못했습니다 — 이 가드가 무엇을 지키는지 다시 보세요");
const raw = src.slice(i, src.indexOf("\n  }", i) + 4);
// ⚠ **주석을 걷어내고 코드만 잰다.** 안 그러면 "이렇게 쓰면 안 된다"고 적어 둔 설명문이 그대로 위반으로 잡힌다
//  (실제로 이 가드를 쓰다 걸렸다 — 회귀를 설명하는 주석에 그 회귀 코드가 인용돼 있었다).
const blk = raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

// ① 노드 칸이 있다.
ok(blk.includes("sc-run-node"), "① 머리줄이 노드 칸(sc-run-node)을 그린다");
ok(/target\.node\s*\?/.test(blk), "① 노드 값의 출처는 target.node 다");

// ② ★ 알약을 **통째로 끄고 나가는 이른 반환이 없다**. 그게 #1870 의 회귀 형태다.
//   selectorsUp 판정은 남아 있어야 한다(선택기가 말하는 것은 중복해 쓰지 않는다) — 없애는 게 아니라 **좁히는** 것이다.
ok(!/runEl\.hidden\s*=\s*true;\s*return;/.test(blk),
  "② 선택기가 서도 알약을 통째로 끄지 않는다(그러면 노드까지 사라진다)");
ok(blk.includes("selectorsUp"), "② 선택기 판정 자체는 남아 있다 — 중복 표시를 막는 원래 뜻");

// ③ ★ 노드 칸만은 selectorsUp 과 **무관하게** 실린다. 다른 셋은 selectorsUp 이면 비워야 한다.
{
  const lines = blk.split("\n");
  const nodeLine = lines.find((l) => l.includes("sc-run-node"));
  assert.ok(nodeLine, "노드 칸 줄을 찾지 못했습니다");
  ok(!nodeLine.includes("selectorsUp"),
    "③ 노드 칸은 selectorsUp 에 걸리지 않는다 — 선택기는 노드를 말하지 않으므로 늘 남아야 한다");
  const harnessLine = lines.find((l) => l.includes("target.raw?.harness"));
  assert.ok(harnessLine, "하네스 칸 줄을 찾지 못했습니다");
  ok(harnessLine.includes("selectorsUp"),
    "③ 하네스 칸은 selectorsUp 이면 비운다 — 선택기가 이미 말한다(중복 금지가 #1870 의 옳은 절반)");
}

// ④ 노드만 남았을 때 그 칸이 무엇인지 말해 준다 — 컴퓨터 이름만 덩그러니 있으면 못 읽는다.
ok(/selectorsUp[\s\S]{0,80}노드/.test(blk), "④ 선택기가 섰을 때의 툴팁이 '노드'라고 말한다");

console.log(`\nsession-run-head: ${pass} passed`);
