// 앱 판 묶음 상한(#4481) — 사양 표 A(P1~P8). 실행: npm run build && node dist/apps/app-bundle-policy.test.js
//  이게 틀리면: 관리자가 고친 상한이 안 먹거나(설정 순서), 오타 하나로 천장을 넘는 값이 들어가 공용 게이트웨이 메모리를 넘기거나,
//   정확히 상한인 판을 막거나(경계), 같은 파일만 다시 가리키는 저장까지 «공간 부족» 으로 막는다.
import assert from "node:assert/strict";
import {
  APP_BUNDLE_POLICY_DEFAULT, APP_BUNDLE_POLICY_MAX, MIB, bundleLimitDenial, envAppBundlePolicy, normalizeAppBundlePolicy, resolveAppBundlePolicy, workspaceLimitDenial,
} from "./app-bundle-policy.js";

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };

{
  assert.deepEqual(resolveAppBundlePolicy(null, {}), { version_max_mb: 250, file_max_mb: 50, files_max: 5000, workspace_max_mb: 10240 });
  assert.deepEqual(APP_BUNDLE_POLICY_DEFAULT, { version_max_mb: 250, file_max_mb: 50, files_max: 5000, workspace_max_mb: 10240 });
  ok("P1 설정이 없으면 코드 기본값(판 250MB · 파일 50MB · 5,000개 · 10GB)");
}
{
  const env = { LIVELY_APP_BUNDLE_POLICY: JSON.stringify({ version_max_mb: 100 }) } as NodeJS.ProcessEnv;
  assert.deepEqual(resolveAppBundlePolicy({ file_max_mb: 10 }, env), { version_max_mb: 100, file_max_mb: 10, files_max: 5000, workspace_max_mb: 10240 });
  assert.deepEqual(resolveAppBundlePolicy({ version_max_mb: 300 }, env).version_max_mb, 300, "워크스페이스 값이 플랫폼 값을 이긴다");
  ok("P2 워크스페이스(DB) → 플랫폼(env) → 코드 기본값 순");
}
{
  const p = normalizeAppBundlePolicy({ version_max_mb: 999999, files_max: -3, file_max_mb: "x", workspace_max_mb: 12.9, x: 1 });
  assert.equal(p.version_max_mb, APP_BUNDLE_POLICY_MAX.version_max_mb, "천장");
  assert.equal(p.files_max, APP_BUNDLE_POLICY_DEFAULT.files_max, "음수는 바닥값");
  assert.equal(p.file_max_mb, APP_BUNDLE_POLICY_DEFAULT.file_max_mb, "숫자 아님은 바닥값");
  assert.equal(p.workspace_max_mb, 12, "소수는 버림");
  assert.ok(!("x" in p), "모르는 키는 버린다");
  assert.equal(normalizeAppBundlePolicy({ file_max_mb: 0 }).file_max_mb, APP_BUNDLE_POLICY_DEFAULT.file_max_mb, "0 = 무제한은 없다(바닥값)");
  ok("P3 천장 · 잡값 · 0 · 모르는 키");
}
{
  assert.deepEqual(envAppBundlePolicy({ LIVELY_APP_BUNDLE_POLICY: "{broken" } as NodeJS.ProcessEnv), APP_BUNDLE_POLICY_DEFAULT);
  ok("P4 깨진 env JSON 은 코드 기본값(부팅을 막지 않는다)");
}
const pol = { version_max_mb: 2, file_max_mb: 1, files_max: 3, workspace_max_mb: 4 };
const f = (n: number, size = 1) => Array.from({ length: n }, (_, i) => ({ path: `f${i}`, size }));
{
  assert.equal(bundleLimitDenial(pol, f(3)), null, "정확히 상한 개수는 허용");
  assert.match(String(bundleLimitDenial(pol, f(4))), /파일이 너무 많습니다/);
  ok("P5 파일 수 경계(= 허용 · +1 거부)");
}
{
  assert.equal(bundleLimitDenial(pol, [{ path: "a", size: MIB }]), null, "정확히 1MiB 허용");
  assert.match(String(bundleLimitDenial(pol, [{ path: "big.bin", size: MIB + 1 }])), /big\.bin/);
  ok("P6 파일 하나 경계");
}
{
  assert.equal(bundleLimitDenial(pol, [{ path: "a", size: MIB }, { path: "b", size: MIB }]), null, "합 = 상한 허용");
  assert.match(String(bundleLimitDenial(pol, [{ path: "a", size: MIB }, { path: "b", size: MIB }, { path: "c", size: 1 }])), /판 하나가 너무 큽니다/);
  ok("P7 판 합 경계");
}
{
  assert.equal(workspaceLimitDenial(pol, 3 * MIB, MIB), null, "used + adding = 상한 허용");
  assert.match(String(workspaceLimitDenial(pol, 3 * MIB, MIB + 1)), /저장 공간이 모자랍니다/);
  assert.equal(workspaceLimitDenial(pol, 9 * MIB, 0), null, "새로 쓰는 것이 없으면 이미 넘쳐 있어도 허용");
  ok("P8 워크스페이스 경계 · 새 바이트 0");
}
console.log(`\n${pass} passed`);
