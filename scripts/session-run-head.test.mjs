// 세션 머리줄 실행 알약의 배선 가드 — #2116 에서 «노드가 머리줄에서 사라지지 않게» 로 시작했고,
//  #5577(2026-11-17)에서 방향이 바뀌었다: 노드는 머리줄에 없고 설정 창 «돌아가는 컴퓨터» 줄이 모든 세션에 선다.
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

// ① ★ 노드는 머리줄에 **없다**(#5577, 원준 2026-11-17 «화면에 칩을 띄우지 마. 그거는 들어가서 보면 돼 · 기존 칩도 다 없애»).
//   종전(#2116)엔 이 가드가 거꾸로 «노드 칸이 있다» 를 지켰다. 멤버 PC 세션에만 칩이 서고 중앙 컴퓨터 세션엔 안 서서(#4904),
//   칩이 없는 것이 «중앙이라서» 인지 «칸이 좁아서» 인지 화면에서 갈리지 않았다. 그 사실은 설정 창 «돌아가는 컴퓨터» 줄이 말한다(⑤).
ok(!blk.includes("sc-run-node"), "① 머리줄이 노드 칸(sc-run-node)을 그리지 않는다");
ok(!/remoteNode\(\)/.test(blk), "① 머리줄 알약은 노드 좌표(remoteNode)를 읽지 않는다");

// ② ★ 알약을 **통째로 끄고 나가는 이른 반환이 없다**. 그게 #1870 의 회귀 형태다.
//   '윗줄이 이미 말한 축은 되풀이하지 않는다' 판정은 남아 있어야 한다 — 없애는 게 아니라 **좁히는** 것이다.
//   (#2061 이 그 판정을 selectorsUp 에서 said(칩·선택기)로 넓혔다 — 읽기전용 칩이 서는 남의·멈춘 세션도
//    같은 규칙을 타야 알약이 같은 사실을 두 벌로 쓰거나, 좁은 화면에서 20px 원으로 눌려 칩 위에 겹치지 않는다.)
ok(!/runEl\.hidden\s*=\s*true;\s*return;/.test(blk),
  "② 선택기가 서도 알약을 통째로 끄지 않는다");
ok(blk.includes("said("), "② 중복 억제 판정(said — 윗줄 칩·선택기가 말한 축)이 남아 있다");

// ③ 하네스 칸은 윗줄이 말하면 비운다 — 중복 금지가 #1870 의 옳은 절반.
{
  const harnessLine = blk.split("\n").find((l) => l.includes("target.raw?.harness"));
  assert.ok(harnessLine, "하네스 칸 줄을 찾지 못했습니다");
  ok(harnessLine.includes("said("), "③ 하네스 칸은 윗줄이 말하면 비운다");
}

// ⑤ 대신 설정 창(openMore)의 «돌아가는 컴퓨터» 줄은 **모든 세션에** 선다 — 멤버 PC 면 그 이름, 아니면 «중앙 컴퓨터».
//   종전엔 `remoteNode() ? 줄 : null` 이라 중앙 컴퓨터 세션엔 줄이 없었다(«줄이 없으면 중앙» 이라고 사람이 추론해야 했다).
{
  const j = src.indexOf("text: '돌아가는 컴퓨터'");
  assert.ok(j > 0, "설정 창의 «돌아가는 컴퓨터» 줄을 찾지 못했습니다");
  const around = src.slice(Math.max(0, j - 400), j + 300).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  ok(/remoteNode\(\)\s*\?\?\s*'중앙 컴퓨터'/.test(around), "⑤ 설정 창 «돌아가는 컴퓨터» 의 값은 remoteNode() ?? '중앙 컴퓨터' 다");
  ok(!/remoteNode\(\)\s*\?\s*el\(/.test(around), "⑤ 그 줄을 remoteNode() 가 있을 때만 세우지 않는다(중앙 컴퓨터 세션에도 선다)");
}

console.log(`\nsession-run-head: ${pass} passed`);
