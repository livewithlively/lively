// AppInstance REST 이음매 — REST는 zod input을 자동으로 태우지 않으므로 parse 계약을 DB 없이 고정한다.
import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../http-error.js";
import { appInstanceCapabilities } from "./app-instances.js";

function cap(name: string) {
  const found = appInstanceCapabilities.find((item) => item.name === name);
  assert.ok(found, `${name} capability가 있어야 합니다`);
  return found;
}

function parse(name: string, req: Record<string, unknown>) {
  const rest = cap(name).expose.rest;
  assert.ok(rest && rest[0]);
  return rest[0].parse(req as never);
}

test("AppInstance 셸 배관은 REST-only다(앱이 MCP로 OS 창을 조작하지 않음)", () => {
  for (const item of appInstanceCapabilities) {
    assert.equal(item.expose.mcp, false, item.name);
    assert.ok(item.expose.rest && item.expose.rest.length > 0, item.name);
  }
});

test("목록 project_id 필터는 양의 정수|null만 parse에서 받는다", () => {
  assert.equal(parse("app_instance_list", { query: {} }).project_id, undefined);
  assert.equal(parse("app_instance_list", { query: { project_id: "null" } }).project_id, null);
  assert.equal(parse("app_instance_list", { query: { project_id: "1780" } }).project_id, 1780);
  for (const bad of ["0", "-1", "1.5", "abc"]) {
    assert.throws(() => parse("app_instance_list", { query: { project_id: bad } }), (e: unknown) => e instanceof HttpError && e.status === 400);
  }
});

test("인스턴스 생성 parse는 인증 주체를 body owner로 받지 않는다", () => {
  const parsed = parse("app_instance_open", { body: { app_id: "browser", owner: "other", project_id: null } });
  assert.equal(parsed.app_id, "browser");
  // parse는 body를 보존하지만 input 계약에는 owner가 없고 handler는 actorOf(user)만 사용한다.
  assert.ok(!("owner" in cap("app_instance_open").input));
});

test("인스턴스 생성은 worker 실행 위치를 명시적으로만 받는다", () => {
  assert.deepEqual(parse("app_instance_open", { body: { app_id: "worker-app", execution: { kind: "remote", node_id: "node-a" } } }).execution,
    { kind: "remote", node_id: "node-a" });
  const execution = cap("app_instance_open").input.execution;
  assert.ok(execution.safeParse({ kind: "remote", node_id: "node-a" }).success);
  assert.equal(execution.safeParse({ kind: "external" }).success, false);
});

test("인스턴스 id는 URL params가 항상 권위다", () => {
  const parsed = parse("app_instance_update", { params: { id: "from-route" }, body: { instance_id: "spoofed", title: "제목" } });
  assert.equal(parsed.instance_id, "from-route");
});

test("실패한 worker는 기존 AppInstance 정체성을 유지한 채 명시적으로 재시작한다", () => {
  const restart = cap("app_instance_restart");
  const rest = restart.expose.rest;
  assert.ok(Array.isArray(rest) && rest[0]);
  assert.deepEqual(rest[0].paths, ["/api/ui/app-instances/:id/restart"]);
  assert.equal(parse("app_instance_restart", { params: { id: "from-route" }, body: { instance_id: "spoofed" } }).instance_id, "from-route");
});
