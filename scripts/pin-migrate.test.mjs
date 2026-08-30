// 복원으로 세션 id 가 바뀌어도 **핀은 따라간다** (#2402).
//
// 신고(장원준 2026-08-28): "핀 해 둔 것도 다시 사라졌다. 반복된다."
//  핀은 서버에 없고 이 브라우저의 localStorage 에만 있는데, 키가 **박스 id**(`sess:<id>`)다. 그런데 박스 id 는
//  복원 한 번에 바뀐다(옛 행은 superseded_by 이정표가 되고 목록에서 빠진다, #2231). 그래서 핀은 지워진 적이
//  없는데도 가리킬 행이 사라져 사람 눈엔 풀린 것으로 보였다.
//
// 이 파일이 지키는 것 둘:
//  ① 옮기는 규칙(migratePinKeys) — **핀은 영속 저장소**라 여기서 실수하면 화면 한 판이 아니라 그 사람의
//     핀 목록이 영구히 망가진다. 그래서 '못 옮기는 경우'를 엣지마다 값으로 잠근다.
//  ② 배선의 성질 — 복원 핸드오프가 실제로 그걸 부르는가 · 이미 끊긴 핀을 되찾는 길이 있는가 ·
//     그리고 **치움(dismissed)은 안 옮기는가**(복원은 새 상태라 다시 보여야 맞다).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name, detail) => { assert.ok(cond, detail ? `${name}\n${detail}` : name); pass++; console.log(`ok  ${name}`); };
const eq = (got, want, name) => { assert.deepEqual(got, want, `${name}: ${JSON.stringify(want)} 여야 하는데 ${JSON.stringify(got)}`); pass++; console.log(`ok  ${name}`); };

const { migratePinKeys, sessPinKey } = await import(join(root, "public/app/v2/pin-migrate.js"));

// ── ① 옮기는 규칙 — 엣지 표(입력 [핀 집합, 옛 id, 새 id] × 기대) ─────────────────
const PINNED = ["sess:box-a-1", "p:77", "sess:box-b-9"];

eq(migratePinKeys(PINNED, "box-a-1", "box-a-2"),
  { keys: ["sess:box-a-2", "p:77", "sess:box-b-9"], moved: true },
  "E1 핀된 세션이 복원됐다 — 새 id 로 따라가고 **자리는 그대로**(사람이 고른 순서를 흔들지 않는다)");

eq(migratePinKeys(PINNED, "box-zz-0", "box-zz-1"), { keys: PINNED, moved: false },
  "E2 핀 안 걸린 세션 — 아무것도 안 바뀐다(moved=false 라 저장도 안 나간다)");

eq(migratePinKeys(PINNED, "box-a-1", "box-a-1"), { keys: PINNED, moved: false },
  "★E3 같은 id — 그대로. 지우고 다시 넣는 순서로 짜면 여기서 핀이 **증발한다**");

eq(migratePinKeys(PINNED, "", "box-a-2"), { keys: PINNED, moved: false },
  "★E4 옛 id 가 비었다 — 그대로(빈 키 `sess:` 가 저장소에 눌러앉지 않게)");
eq(migratePinKeys(PINNED, "box-a-1", "   "), { keys: PINNED, moved: false },
  "★E5 새 id 가 공백뿐 — 그대로(핀을 흘리지 않는다)");

eq(migratePinKeys(["sess:box-a-1", "sess:box-a-2"], "box-a-1", "box-a-2"),
  { keys: ["sess:box-a-2"], moved: true },
  "★E6 새 id 가 이미 핀돼 있다 — 옛 키만 걷어낸다(같은 세션이 두 줄로 서지 않게)");

eq(migratePinKeys([], "box-a-1", "box-a-2"), { keys: [], moved: false },
  "E7 빈 핀 집합 — 아무 일도 없다");

eq(sessPinKey(" box-a-1 "), "sess:box-a-1", "E8 키 규약은 사이드바와 같다(`sess:<박스 id>`, 공백 정리)");

// ── ② 배선 ────────────────────────────────────────────────────────────────
const side = read("web/v2/side.ts");
const main = read("web/v2/main.ts");

ok(/migratePinKeys\(appPinned/.test(side),
  "E9 핀 저장소가 그 규칙을 쓴다 — 사본 규칙을 따로 들고 있지 않다");

ok(/adoptSessionLocalState\(prevSessionIdOf\(tab\), sid\)/.test(main),
  "★E10 복원 핸드오프가 **옛 id 를 잡아** 로컬 상태를 넘긴다 — 없으면 새 박스에 핀이 안 붙는다");

ok(/function adoptSessionLocalState[\s\S]{0,600}?movePinnedSession\(/.test(main),
  "★E11 넘기는 것에 핀이 들어 있다");
ok(/function adoptSessionLocalState[\s\S]{0,600}?rememberSessName\(/.test(main),
  "E12 이름 기억도 함께 넘긴다 — 새 박스도 같은 세션이다");
ok(!/function adoptSessionLocalState[\s\S]{0,600}?dismissed\[/.test(main),
  "★E13 치움(dismissed)은 **안** 넘긴다 — 복원은 새 상태라 다시 보여야 맞다");

ok(/repairPinnedSuccessors\(\)/.test(main),
  "★E14 이미 끊긴 핀을 되찾는 길이 있다(이 고침 이전에 복원된 것·다른 탭에서 복원된 것)");
ok(/pinRepairAsked/.test(main) && /!findSess\(id\)/.test(main),
  "E15 **필요할 때만·한 번만** 묻는다 — 해소된 핀은 안 묻고, 물어본 id 는 다시 안 묻는다");
ok(/movedTo/.test(main),
  "E16 서버가 이미 아는 답(movedTo)을 쓴다 — 새 API 를 만들지 않는다");

console.log(`\npin-migrate tests: ${pass} passed`);
