import { strict as assert } from "node:assert";
import test from "node:test";
import { deployKindHandled, makeDeployDeps } from "./deploy.js";
import type { DeployItem } from "./install.js";
import type { AppComponentRef } from "./install-plan.js";
import { HttpError } from "../http-error.js";

// 순수 디스패치 표만 검증한다 — 실전개(DB) 배선은 itest(scripts/apps-install.itest.mjs)의 몫이라 여기서 안 만진다.
//  여기서 다루는 건 "이 kind 를 전개기가 아는가" + "모르는 kind 는 500 으로 거부하나" + "저널만(no-op) kind 는 DB 없이 통과하나".

const DEPLOY_KINDS = ["harness_asset", "host", "cron", "mcp_server", "tool", "runtime_worker"] as const;
const NOOP_KINDS = ["ui_page", "ui_widget", "section", "data_table"] as const;

test("deployKindHandled: 실전개 kind 는 전부 true", () => {
  for (const k of DEPLOY_KINDS) assert.equal(deployKindHandled(k), true, `${k} 는 다뤄져야 한다`);
});

test("deployKindHandled: 저널만(no-op) kind 도 전부 true", () => {
  for (const k of NOOP_KINDS) assert.equal(deployKindHandled(k), true, `${k} 는 다뤄져야 한다`);
});

test("deployKindHandled: 알 수 없는 kind 는 false", () => {
  for (const k of ["", "bogus", "app", "grant", "toString", "constructor", "__proto__"]) {
    assert.equal(deployKindHandled(k), false, `${k} 는 미지원이어야 한다`);
  }
});

function item(kind: string, ref: string, payload: unknown = null): DeployItem {
  return { comp: { kind, ref }, payload };
}
function comp(kind: string, ref: string): AppComponentRef {
  return { kind, ref };
}

test("deploy: 알 수 없는 kind 는 HttpError(500) 로 거부(DB 접근 전에)", async () => {
  const deps = makeDeployDeps("app1", { actor: "system", source: "migration" });
  await assert.rejects(
    () => deps.deploy(item("bogus", "x")),
    (err: unknown) => err instanceof HttpError && err.status === 500 && /미지원 전개 kind: bogus/.test(err.message),
  );
});

// #1780 v2 §7-1(사양 H7) — 회수는 미지 kind 에 관대하다: 실전개를 모르니 손대지 않고(경고) 조인 제거만 남긴다.
//  v2 코어가 심은 kind(예: worker) 를 이 코어가 만나도 앱 삭제·재설치가 500 으로 막히면 안 된다(롤백 안전).
//  DB 배선 없이 resolve 해야 한다 = 실전개 스토어를 부르지 않았다는 증거.
test("reclaim: 알 수 없는 kind 는 예외 없이 통과(조인 제거만 — 롤백 안전)", async () => {
  const deps = makeDeployDeps("app1", { actor: "system", source: "migration" });
  await assert.doesNotReject(() => deps.reclaim(comp("worker", "x")));
});

// no-op kind 는 실전개가 없으므로 DB 배선 없이도 resolve 해야 한다(이 테스트가 DB 를 안 띄우고도 통과 = 증거).
test("deploy/reclaim: 저널만 kind 는 DB 없이 통과(no-op)", async () => {
  const deps = makeDeployDeps("app1", { actor: "system", source: "migration" });
  for (const k of NOOP_KINDS) {
    await deps.deploy(item(k, `ref-${k}`));
    await deps.reclaim(comp(k, `ref-${k}`));
  }
  assert.ok(true, "no-op kind 는 DB 접근 없이 완료");
});
