// 앱 v2 #121 — 구성원 도구 cron_set 은 app_server_job 잡을 만들지 · 바꾸지 못한다(격리 리뷰 2026-11-22 막을 것).
//  그 도구는 scope memory(일반 구성원)라, 받으면 남의 이름(run_as · 앱 책임자)으로 앱 서버 라우트를 부르는 잡을 만들 수 있다. DB 를 읽기 전에 거절한다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { cronCapabilities } from "./cron.js";

test("cron_set — action app_server_job 은 새로 만들 때도 · 고칠 때도 400(DB 를 읽기 전)", async () => {
  const cap = cronCapabilities.find((c) => c.name === "cron_set");
  assert.ok(cap);
  const user = { userId: "member-a", email: "", scopes: ["memory"], projects: ["*"] };
  for (const input of [
    { id: "x", action: "app_server_job", params: { app_id: "card-policy", route: "/any", run_as: "admin" }, cron_expr: "* * * * *" },
    { id: "existing-job", action: "app_server_job" },
  ]) {
    await assert.rejects(() => cap.handler(input, user, {}), (e: unknown) => (e as { status?: number }).status === 400 && /app_server_job/.test(String((e as Error).message)));
  }
});
