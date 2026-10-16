// 시험의 앱 폴더 자리(apps — #4673 · #4778)를 임시 폴더로 고정한다 — 불러오기만 하면 된다(`import "<경로>/scripts/test-apps-root.mjs"`).
//
//  왜: 앱을 지우면 그 앱 폴더를 보관으로 옮기고, 새로 만들 때 같은 id 의 남은 폴더를 먼저 옮긴다(src/apps/app-folder-archive.ts).
//   자리는 부를 때마다 env 에서 읽는다(terminal/catalog roots() — 기본 ~/apps · 격리 박스는 LIVELY_APPS_DIR /srv/lively/apps).
//   그래서 앱을 만들고 지우는 통합 시험이 이 자리를 고정하지 않으면 시험을 돌린 컴퓨터의 실제 폴더를 옮긴다.
//  앱을 만들고 지우는 시험(*.pg-test.mjs · *.itest.mjs)은 이 모듈을 불러오거나 TERMINAL_ROOT_APPS 를 직접 고정한다 — 시험이 잰다
//   (src/apps/app-folder-archive.test.ts L4).
//  ⚠ 미리 정해 둔 값(.env · 셸 export)이 있어도 **늘 새 임시 폴더로 덮는다** — 그 값이 바로 지켜야 할 실제 자리일 수 있다. 끝나면 지운다.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEST_APPS_ROOT = mkdtempSync(path.join(os.tmpdir(), "lively-test-apps-"));
process.env.TERMINAL_ROOT_APPS = TEST_APPS_ROOT;
process.env.LIVELY_APPS_DIR = TEST_APPS_ROOT;   // 격리 박스(box-spawn 이 깔린 리눅스)에서 돌려도 /srv/lively/apps 를 안 건드리게
process.on("exit", () => { try { rmSync(TEST_APPS_ROOT, { recursive: true, force: true }); } catch { /* 지우지 못해도 시험 결과와 무관 */ } });
