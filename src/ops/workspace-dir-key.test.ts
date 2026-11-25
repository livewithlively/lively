// 워크스페이스별 자리의 폴더 조각(ops/workspace-dir-key.ts) — 순수 판정. 실행: npm run build && node dist/ops/workspace-dir-key.test.js
//
// ── 입력 × 기대 ──────────────────────────────────────────────────────────────
//  K1 | 해석기를 꽂지 않음                    | 열쇠 null · 조각 []            (단일 워크스페이스 · 노드 — 종전 자리)
//  K2 | 해석기가 null · ""                    | 열쇠 null · 조각 []            (컨텍스트 없음 · primary)
//  K3 | 해석기가 UUID                         | ["@ws", "<소문자 UUID>"]
//  K4 | 해석기가 대문자 UUID                  | 소문자로 접는다(같은 워크스페이스가 두 자리를 갖지 않게)
//  K5 | UUID 꼴이 아닌 값(../ · 이름 · 짧은 값) | 던진다 — 종전(공용) 자리로 떨어지지 않는다
//  K6 | 표지 폴더                             | 레포 이름 꼴([A-Za-z0-9._-])에 들지 않는다
import assert from "node:assert/strict";
import { installWorkspaceDirKeyResolver, workspaceDirKey, workspaceDirSegments, WORKSPACE_DIR_MARK } from "./workspace-dir-key.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const A = "aaaaaaaa-1111-2222-3333-444444444444";

t("K1 해석기를 꽂지 않으면 열쇠가 없다(종전 자리)", () => {
  assert.equal(workspaceDirKey(), null);
  assert.deepEqual(workspaceDirSegments(), []);
});
t("K2 해석기가 null · 빈 글이면 열쇠가 없다", () => {
  for (const v of [null, ""]) {
    installWorkspaceDirKeyResolver(() => v);
    assert.equal(workspaceDirKey(), null);
    assert.deepEqual(workspaceDirSegments(), []);
  }
});
t("K3 UUID 면 @ws/<id> 조각", () => {
  installWorkspaceDirKeyResolver(() => A);
  assert.equal(workspaceDirKey(), A);
  assert.deepEqual(workspaceDirSegments(), ["@ws", A]);
});
t("K4 대문자 UUID 는 소문자로 접는다", () => {
  installWorkspaceDirKeyResolver(() => A.toUpperCase());
  assert.deepEqual(workspaceDirSegments(), ["@ws", A]);
});
t("K5 UUID 꼴이 아니면 던진다(공용 자리로 떨어지지 않는다)", () => {
  for (const bad of ["../../etc", "primary", "acme", A.slice(0, -1), `${A}/x`, `${A}0`, " ", "0"]) {
    installWorkspaceDirKeyResolver(() => bad);
    assert.throws(() => workspaceDirKey(), /UUID 꼴이 아닙니다/, `허용되면 안 됨: ${JSON.stringify(bad)}`);
    assert.throws(() => workspaceDirSegments(), /UUID 꼴이 아닙니다/);
  }
});
t("K6 표지 폴더는 레포 이름이 될 수 없는 글자로 시작한다", () => {
  assert.equal(WORKSPACE_DIR_MARK, "@ws");
  assert.equal(/^(?!\.+$)[A-Za-z0-9._-]{1,100}$/.test(WORKSPACE_DIR_MARK), false);
});

installWorkspaceDirKeyResolver(() => null);
console.log(`\n${pass} passed`);
