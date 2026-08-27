// 순수 단위 체크(node:assert) — 세션의 **두 이름**을 재는 규칙(#2151). 사양·엣지 표대로 한 행에 하나씩.
//  사양: ① 어떤 이름으로 들어오든 알려진 이름을 다 모은다(대표 = 박스 id · 빈값/공백/중복 제거)
//        ② "지금 돌고 있나"는 **어느 이름이라도** 라이브 집합에 있으면 참.
//  왜(실측 2026-08-26): 라이브 집합엔 박스 id 만 들어 있다. 대화 uuid 하나만 대어 보면 돌고 있는 세션이
//   늘 '안 돌고 있음'으로 읽혀, 멈춤도 경고도 없이 휴지통에 들어간다 — 대화 9a0f069a 가 쓰레기 프로젝트
//   #1946 묶음에 쓸려 들어간 뒤 30분 넘게 계속 일했고, 표식이 대화 uuid 한쪽에만 붙어 그 대화를 이어받은
//   세션이 그 뒤로 몇 번을 새로 띄워도 사이드바에서 사라졌다.
//  배선: 규칙이 옳아도 호출자가 이름 하나만 대면 버그는 그대로다 → [A11] 이 그 자리를 소스로 못박는다.
// 실행: npm run build && node dist/sessions/session-names.test.js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { sessionNames, isLiveByAnyName } from "./session-names.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const BOX = "box-yoon-4ecf8613";
const UUID = "9a0f069a-1b9a-464a-a5b0-e8b0cbf91620";
const OTHER = "box-yoon-0000dead";

// ── A. 이름 모으기 ─────────────────────────────────────────────────────────────
t("[A1] 박스 id 로 들어와도 대화 uuid 까지 모은다", () => {
  assert.deepEqual(sessionNames(BOX, BOX, UUID), [BOX, UUID]);
});

t("[A2] 대화 uuid 로 들어와도 박스 id 까지 모은다 — 대표(첫 값)는 박스 id", () => {
  assert.deepEqual(sessionNames(UUID, BOX, UUID), [BOX, UUID]);
});

t("[A3] 매핑을 모르면(박스 미상) 손에 든 이름 하나뿐 — 없는 이름을 지어내지 않는다", () => {
  assert.deepEqual(sessionNames(UUID, null, null), [UUID]);
  assert.deepEqual(sessionNames(UUID, undefined, undefined), [UUID]);
});

t("[A4] 빈값·공백·중복은 이름이 아니다", () => {
  assert.deepEqual(sessionNames(BOX, "", null), [BOX]);
  assert.deepEqual(sessionNames(BOX, "   ", undefined), [BOX]);
  assert.deepEqual(sessionNames(BOX, BOX, BOX), [BOX]);
});

// ── B. 라이브 판정 ─────────────────────────────────────────────────────────────
t("[A5] 이름 하나(대화 uuid)만 대면 못 잡는다 — 고치기 전 동작을 표로 남긴다", () => {
  assert.equal(isLiveByAnyName([UUID], new Set([BOX])), false);
});

t("[A6] 🔴 회귀락 — 같은 세션을 **모든 이름**으로 재면 돌고 있는 게 보인다", () => {
  assert.equal(isLiveByAnyName(sessionNames(UUID, BOX, UUID), new Set([BOX])), true);
});

t("[A7] 박스 id 로 들어온 경우는 종전과 같다(무회귀)", () => {
  assert.equal(isLiveByAnyName(sessionNames(BOX, BOX, UUID), new Set([BOX])), true);
});

t("[A8] 남의 세션만 돌고 있으면 거짓 — 이름이 섞이지 않는다", () => {
  assert.equal(isLiveByAnyName(sessionNames(UUID, BOX, UUID), new Set([OTHER])), false);
});

t("[A9] 경계 — 이름이 하나도 없으면 거짓", () => {
  assert.equal(isLiveByAnyName([], new Set([BOX])), false);
});

t("[A10] 경계 — 라이브 집합이 비면 거짓", () => {
  assert.equal(isLiveByAnyName(sessionNames(UUID, BOX, UUID), new Set<string>()), false);
});

// ── C. 배선 — 호출자가 이름 하나만 대는 자리로 되돌아가지 못하게 ────────────────────
//  순수 규칙이 옳아도 호출자가 `liveIds.has(id)` 로 되돌아가면 그 순간 같은 버그다(이게 원래 버그였다).
//  소스로 못박는다: 휴지통 조작 모듈은 라이브 집합을 **직접** 조회하지 않고 규칙을 통해서만 잰다.
t("[A11] 배선 — session-trash-ops 는 라이브 집합을 직접 조회하지 않고 규칙으로만 잰다", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  //  dist 로 빌드돼 돌므로 소스를 되짚는다(src ↔ dist 는 같은 상대 위치).
  const src = path.resolve(here, "../../src/sessions/session-trash-ops.ts");
  const code = readFileSync(src, "utf8");
  assert.ok(code.includes("isLiveByAnyName("), "라이브 판정이 규칙(isLiveByAnyName)을 안 쓴다");
  assert.equal(
    /\bliveIds\.has\s*\(/.test(code), false,
    "라이브 집합을 직접 조회하고 있다 — 이름 하나만 대는 자리로 되돌아갔다(#2151 회귀)",
  );
});

console.log(`\n${pass}개 통과 — 세션 두 이름 규칙(#2151)`);
