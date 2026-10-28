// 비밀을 받는 MCP 도구는 호출 기록(mcp_call_log.args)에 값을 남기지 않는다 — 레지스트리를 돌며 지킨다(#4970 격리 리뷰).
//  redactDeep 는 토큰 «모양»(sk- · ghp_ · xox · JWT · PEM)만 가린다. 모양 없는 client secret · 토큰은 도구가 SECRET_ARG_FIELDS 에
//   칸을 올려야 기록에서 빠진다. 새 도구가 비밀 칸을 받으면서 표에 안 오르면 여기서 깨진다(중앙 표가 정의에서 멀어 빠지는 것을 막는다).
//  실행: npm run build && node dist/capabilities/secret-args.test.js
import assert from "node:assert/strict";
import { registry } from "./index.js";
import { ORIGIN_ONLY_ARG_FIELDS, SECRET_ARG_FIELDS, argsForLog } from "../org/policies/tool-log.js";

/** 이름으로 보아 비밀 값을 받는 칸. */
const SECRETY = /(secret|password|passwd|private_?key|^token$|_token$|access_?token|refresh_?token|api_?key|dsn)/i;
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

{
  //  S3 #4993 — AI 브라우저는 사람 대신 남의 사이트에 글을 친다(인증 코드 · 개인정보) · 페이지에서 코드를 돌린다 · 주소 자체가 자격인 곳에 간다
  //   (매직 링크 · 비밀번호 재설정 · OAuth code). 칸 이름이 비밀처럼 생기지 않아 S1 이 못 잡는 자리라 값으로 못 박는다.
  const SECRET = "plain-shapeless-value-9f2c4e7a";
  const cases: Array<[string, Record<string, unknown>]> = [
    ["browser_act", { action: "type", text: SECRET }],
    ["browser_fill", { ref: "e1", value: SECRET }],
    ["browser_eval", { code: `return "${SECRET}"` }],
    ["browser_upload", { ref: "e1", urls: [`https://gw.example/api/files/s/${SECRET}`] }],
    ["browser_navigate", { url: `https://bank.example/reset/${SECRET}?code=${SECRET}#${SECRET}` }],
    ["browser_navigate", { url: `bank.example/reset?token=${SECRET}` }],
    ["browser_navigate", { url: `${SECRET} 검색어` }],
    ["browser_tabs", { action: "new", url: `https://bank.example/magic?t=${SECRET}` }],
  ];
  for (const [tool, args] of cases) {
    const logged = JSON.stringify(argsForLog(tool, args));
    assert.ok(!logged.includes(SECRET), `${tool}: 값이 기록에 남았다 — ${logged}`);
  }
  //  주소 칸은 «어느 사이트» 는 남는다(감사에 필요) — 스킴 없이 온 주소도.
  assert.ok(JSON.stringify(argsForLog("browser_navigate", { url: "https://bank.example/x?y=1" })).includes("https://bank.example"), "주소 칸에 출처가 안 남았다");
  assert.ok(JSON.stringify(argsForLog("browser_tabs", { action: "new", url: "bank.example/x" })).includes("https://bank.example"), "스킴 없는 주소의 출처가 안 남았다");
  //  배선 — 주소 표의 도구 · 칸이 실제로 있다(이름이 바뀌어 헛돌지 않게).
  for (const [tool, keys] of Object.entries(ORIGIN_ONLY_ARG_FIELDS)) {
    const cap = registry.get(tool);
    assert.ok(cap && cap.expose?.mcp, `주소 표의 도구가 없다: ${tool}`);
    for (const k of keys) assert.ok(k in (cap!.input ?? {}), `주소 표의 칸이 없다: ${tool}.${k}`);
  }
  ok(`S3 AI 브라우저 — 친 글 · 코드 · 올릴 파일 주소는 값이 빠지고, 주소는 사이트(출처)만 남는다(${cases.length}가지)`);
}

console.log(`\nsecret-args.test: ${pass} passed`);
