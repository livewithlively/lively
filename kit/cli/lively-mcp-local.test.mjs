#!/usr/bin/env node
// lively-mcp-local(#899) 유닛 — MCP stdio 프로토콜 + 레지스트리 확장점을 스트림으로 검증한다.
//  실행: node kit/cli/lively-mcp-local.test.mjs   (npm test 체인에 포함)
//  실제 ~/.lively·네트워크 무접촉 — serveMcpLocal 을 인메모리 PassThrough 로 구동한다.
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = join(fileURLToPath(import.meta.url), "..");
const { serveMcpLocal, TOOLS, registerTool, handleCall, toolSpec } = await import(join(HERE, "lively-mcp-local.mjs"));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.error(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n, cond, why) => (cond ? ok(n) : bad(n, why || "조건 불만족"));

// ── 서버를 인메모리 스트림으로 구동, 요청/응답을 라인 단위로 짝짓는 헬퍼 ──
function makeServer() {
  const input = new PassThrough(), output = new PassThrough();
  const queue = [], waiters = [];
  let buf = "";
  output.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (waiters.length) waiters.shift()(msg); else queue.push(msg);
    }
  });
  const done = serveMcpLocal({ input, output });
  const next = () => new Promise((res) => (queue.length ? res(queue.shift()) : waiters.push(res)));
  const send = (obj) => input.write(JSON.stringify(obj) + "\n");
  const rpc = (method, params, id = 1) => { send({ jsonrpc: "2.0", id, method, params }); return next(); };
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
  return { rpc, notify, send, close: () => input.end(), done };
}

const S = makeServer();

// id 를 케이스마다 증가시켜(응답 짝짓기 안전) rpc 를 감싼다.
let _id = 0;
const rpc1 = (s, method, params) => s.rpc(method, params, ++_id);

(async () => {
  // 1) initialize
  const init = await rpc1(S, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  check("initialize: serverInfo.name", init.result?.serverInfo?.name === "lively-local", JSON.stringify(init.result?.serverInfo));
  check("initialize: 버전협상 echo", init.result?.protocolVersion === "2025-06-18", init.result?.protocolVersion);
  check("initialize: tools capability", !!init.result?.capabilities?.tools, "no tools cap");

  // 2) 알림은 응답이 없어야(notifications/initialized)
  S.notify("notifications/initialized", {});

  // 3) 빌트인 레포 툴(#900) — repo_list·repo_worktree·repo_worktree_remove 3종이 기본 등록됨
  const builtin = await rpc1(S, "tools/list", {});
  const builtinNames = (builtin.result?.tools || []).map((t) => t.name);
  const BASELINE = builtinNames.length;
  check("tools/list: 빌트인 레포 툴 3종", ["lively_local_repo_list", "lively_local_repo_worktree", "lively_local_repo_worktree_remove"].every((n) => builtinNames.includes(n)), builtinNames.join(","));
  check("tools/list: repo_worktree 스키마 repo required", (() => { const t = builtin.result.tools.find((x) => x.name === "lively_local_repo_worktree"); return !!(t && t.inputSchema?.required?.includes("repo")); })(), "no repo required");

  // 4) ★확장점★ — 배열에 항목 하나 추가하면 그게 곧 list/call 에 반영된다
  registerTool({
    name: "lively_local_echo",
    title: "에코",
    description: "테스트용 에코",
    inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"], additionalProperties: false },
    handler: (args, ctx) => ctx.text("echo:" + args.msg),
  });
  registerTool({
    name: "lively_local_nodever",
    description: "로컬 프로세스에서 node -v 를 실행(로컬 실행 검증)",
    inputSchema: { type: "object", properties: {} },
    handler: (_a, ctx) => ctx.text(ctx.sh(process.execPath, ["-v"]).stdout.trim()),
  });
  registerTool({
    name: "lively_local_boom",
    description: "테스트용 throw",
    inputSchema: { type: "object", properties: {} },
    handler: () => { throw new Error("의도된 실패"); },
  });

  const list = await rpc1(S, "tools/list", {});
  const names = (list.result?.tools || []).map((t) => t.name);
  check("tools/list: 추가한 툴 3개 노출(빌트인 위에 누적)", names.length === BASELINE + 3 && names.includes("lively_local_echo"), names.join(","));
  const echoSpec = list.result.tools.find((t) => t.name === "lively_local_echo");
  check("tools/list: spec 에 description·inputSchema", !!echoSpec.description && echoSpec.inputSchema?.type === "object", JSON.stringify(echoSpec));
  check("tools/list: title 투영", echoSpec.title === "에코", echoSpec.title);

  // 5) tools/call 정상
  const call = await rpc1(S, "tools/call", { name: "lively_local_echo", arguments: { msg: "hi" } });
  check("tools/call: 정상 결과", call.result?.content?.[0]?.text === "echo:hi", JSON.stringify(call.result));
  check("tools/call: isError 없음", !call.result?.isError, "isError set");

  // 6) 로컬 실행(sh) — node -v 가 실제로 돈다
  const nv = await rpc1(S, "tools/call", { name: "lively_local_nodever", arguments: {} });
  check("tools/call: 로컬 sh 실행", /^v\d+\./.test(nv.result?.content?.[0]?.text || ""), nv.result?.content?.[0]?.text);

  // 7) 필수 인자 누락 → tool-error(isError), 프로토콜 error 아님
  const miss = await rpc1(S, "tools/call", { name: "lively_local_echo", arguments: {} });
  check("tools/call: 필수인자 누락 isError", miss.result?.isError === true && /필수 인자/.test(miss.result.content[0].text), JSON.stringify(miss.result));

  // 7-b) 빌트인 repo_worktree 도 repo 누락 시 isError(스키마 검증이 빌트인에도 적용 — 네트워크/git 무접촉)
  const wtMiss = await rpc1(S, "tools/call", { name: "lively_local_repo_worktree", arguments: {} });
  check("repo_worktree: repo 누락 isError", wtMiss.result?.isError === true && /필수 인자/.test(wtMiss.result.content[0].text), JSON.stringify(wtMiss.result));

  // 8) 알 수 없는 툴 → isError
  const unk = await rpc1(S, "tools/call", { name: "nope", arguments: {} });
  check("tools/call: 미지의 툴 isError", unk.result?.isError === true, JSON.stringify(unk.result));

  // 9) handler throw → isError, 서버는 살아있음
  const boom = await rpc1(S, "tools/call", { name: "lively_local_boom", arguments: {} });
  check("tools/call: handler throw 격리", boom.result?.isError === true && /의도된 실패/.test(boom.result.content[0].text), JSON.stringify(boom.result));
  const after = await rpc1(S, "tools/list", {});
  check("서버 생존: throw 후에도 응답", Array.isArray(after.result?.tools), "dead");

  // 10) ping
  const ping = await rpc1(S, "ping", {});
  check("ping: 빈 result", ping.result && Object.keys(ping.result).length === 0, JSON.stringify(ping.result));

  // 11) 미지의 메서드(id 있음) → JSON-RPC error -32601
  const badm = await rpc1(S, "no/such", {});
  check("미지 메서드 → -32601", badm.error?.code === -32601, JSON.stringify(badm));

  // 12) 잘못된 JSON 라인은 무시(크래시 없음)
  S.send("this is not json");
  const stillAlive = await rpc1(S, "ping", {});
  check("깨진 라인 내성", !!stillAlive.result, "crashed on bad json");

  // 13) handleCall 반환값 정규화 — 단위
  registerTool({ name: "lively_local_str", description: "s", inputSchema: { type: "object" }, handler: () => "plain" });
  registerTool({ name: "lively_local_obj", description: "o", inputSchema: { type: "object" }, handler: () => ({ a: 1 }) });
  registerTool({ name: "lively_local_null", description: "n", inputSchema: { type: "object" }, handler: () => null });
  const r1 = await handleCall("lively_local_str", {});
  const r2 = await handleCall("lively_local_obj", {});
  const r3 = await handleCall("lively_local_null", {});
  check("정규화: string → text", r1.content[0].text === "plain", JSON.stringify(r1));
  check("정규화: object → JSON text", JSON.parse(r2.content[0].text).a === 1, JSON.stringify(r2));
  check("정규화: null → (완료)", r3.content[0].text === "(완료)", JSON.stringify(r3));

  // 14) toolSpec 은 handler 를 노출하지 않는다(직렬화 누수 방지)
  const spec = toolSpec({ name: "x", description: "d", inputSchema: { type: "object" }, handler: () => {} });
  check("toolSpec: handler 미노출", spec.handler === undefined && spec.name === "x", JSON.stringify(Object.keys(spec)));

  S.close();
  await S.done;
  console.error(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("테스트 하네스 오류:", e); process.exit(1); });
