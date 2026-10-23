// 비밀을 받는 MCP 도구는 호출 기록(mcp_call_log.args)에 값을 남기지 않는다 — 레지스트리를 돌며 지킨다(#4970 격리 리뷰).
//  redactDeep 는 토큰 «모양»(sk- · ghp_ · xox · JWT · PEM)만 가린다. 모양 없는 client secret · 토큰은 도구가 SECRET_ARG_FIELDS 에
//   칸을 올려야 기록에서 빠진다. 새 도구가 비밀 칸을 받으면서 표에 안 오르면 여기서 깨진다(중앙 표가 정의에서 멀어 빠지는 것을 막는다).
//  실행: npm run build && node dist/capabilities/secret-args.test.js
import assert from "node:assert/strict";
import { registry } from "./index.js";
import { SECRET_ARG_FIELDS, argsForLog } from "../org/policies/tool-log.js";

/** 이름으로 보아 비밀 값을 받는 칸. */
const SECRETY = /(secret|password|passwd|private_?key|^token$|_token$|access_?token|refresh_?token|api_?key)/i;
/** 이름은 비밀 같지만 값은 비밀이 아닌 칸 — 까닭을 단다. */
const NOT_SECRET: Readonly<Record<string, Record<string, string>>> = {
  org_runtime_update: { allowed_db_secret_refs: "비밀의 이름(참조) 목록이다 — 값이 아니다" },
};

let pass = 0;
const ok = (name: string) => { pass++; console.log(`ok  ${name}`); };

{
  let seen = 0;
  const missing: string[] = [];
  for (const cap of registry.values()) {
    if (!cap.expose?.mcp) continue;
    for (const key of Object.keys(cap.input ?? {})) {
      if (!SECRETY.test(key)) continue;
      seen++;
      if ((SECRET_ARG_FIELDS[cap.name] ?? []).includes(key)) continue;
      if (NOT_SECRET[cap.name]?.[key]) continue;
      missing.push(`${cap.name}.${key}`);
    }
  }
  assert.ok(seen >= 8, `비밀처럼 생긴 칸을 충분히 찾았다(배선) — ${seen}개`);
  assert.deepEqual(missing, [], `★ 비밀 칸을 받는 MCP 도구가 SECRET_ARG_FIELDS 에 없다(호출 기록에 평문으로 남는다): ${missing.join(", ")}`);
  ok(`S1 MCP 도구의 비밀처럼 생긴 칸 ${seen}개 — 전부 기록 제외 표에 있거나 까닭이 있다`);
}

{
  //  표의 도구는 실제로 있고 MCP 로 열려 있다(이름이 바뀌어 표가 헛도는 것을 막는다) · 표의 칸은 그 도구의 입력에 있다.
  const stale: string[] = [];
  for (const [tool, keys] of Object.entries(SECRET_ARG_FIELDS)) {
    const cap = registry.get(tool);
    if (!cap || !cap.expose?.mcp) { stale.push(tool); continue; }
    for (const k of keys) if (!(k in (cap.input ?? {}))) stale.push(`${tool}.${k}`);
  }
  assert.deepEqual(stale, [], `기록 제외 표가 없는 도구·칸을 가리킨다: ${stale.join(", ")}`);
  //  그리고 정말로 값이 빠진다(모양 없는 값으로).
  for (const [tool, keys] of Object.entries(SECRET_ARG_FIELDS)) {
    const args = Object.fromEntries(keys.map((k) => [k, "plain-shapeless-value-9f2c4e7a"]));
    assert.ok(!JSON.stringify(argsForLog(tool, args)).includes("plain-shapeless-value-9f2c4e7a"), `${tool}: 값이 기록에 남았다`);
  }
  ok(`S2 기록 제외 표 ${Object.keys(SECRET_ARG_FIELDS).length}개 도구 — 실제로 있고, 값이 기록에서 빠진다`);
}

console.log(`\nsecret-args.test: ${pass} passed`);
