// 서술 재작성 배치(style-rewrite-batch.mjs) 오케스트레이션 시험 — 실제 LLM·게이트웨이 없이 배치 전체를 돌린다.
//  게이트웨이는 배치 프로세스 안의 fetch 대역(--import 로 먼저 싣는 모듈)이 흉내 내고, LLM 은 가짜 명령(--llm-cmd)이 답한다.
//  대역은 서버의 저장 규칙 중 이 배치가 기대는 것만 옮겼다(src/capabilities/knowledge/authoring.ts · src/v6/knowledge-store.ts):
//   안 보낸 supersedes 는 null 로 덮인다 · edit 는 지금 본문에서 old 를 정확일치로 찾고(못 찾으면 400) 검토 대기 제안이 있으면 409 ·
//   제목 경로(/title)는 제목만 바꾼다 · 저장마다 판이 하나 오른다 · 보관·주입 전환과 검토 대기 제안은 판을 올리지 않는다.
// 실행: node scripts/style-rewrite-batch.test.mjs (빌드 산출물 dist/ 필요 — 배치가 판정 모듈을 거기서 읽는다)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandboxEnv } from "../kit/testlib/os-sandbox.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BATCH = join(ROOT, "scripts", "style-rewrite-batch.mjs");
if (process.platform === "win32") { console.log("skip  가짜 LLM 명령이 shebang 실행 파일이라 윈도우에선 건너뛴다"); process.exit(0); }
if (!existsSync(join(ROOT, "dist", "v6", "writing-rewrite-gate.js"))) { console.error("FAIL  dist 가 없다 — npm run build 먼저"); process.exit(1); }

/** 배치 프로세스 안에서 도는 게이트웨이 대역 — 상태는 파일(STYLE_BATCH_STUB)에서 읽고, 끝날 때 문서·요청 기록을 되쓴다. */
function stubMain(readFileSync, writeFileSync) {
  const file = process.env.STYLE_BATCH_STUB;
  const st = JSON.parse(readFileSync(file, "utf8"));
  st.log = st.log ?? [];
  st.hooks = st.hooks ?? {};
  process.on("exit", () => writeFileSync(file, JSON.stringify(st)));
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fail = (status, error) => reply(status, { error });
  // 검토 대기 제안은 knowledge 옆 키로 온다(목록에는 없다).
  const pub = (d) => { const { pending_revision: _p, ...k } = d; return k; };
  const staged = (d) => d.pending_revision?.mode === "staged";
  // applyKnowledgeEdits 와 같은 규칙 — replace_all 이 아니면 String.replace 라 new 의 `$&` 를 치환 패턴으로 읽는 것까지 같다.
  const applyEdits = (base, edits) => {
    if (!Array.isArray(edits) || !edits.length) throw new Error("edits 가 비었습니다");
    let out = String(base ?? "");
    edits.forEach((e, i) => {
      const o = String(e?.old ?? ""), n = String(e?.new ?? "");
      if (!o) throw new Error(`edits[${i}].old 가 비었습니다`);
      if (o === n) throw new Error(`edits[${i}]: old 와 new 가 같습니다`);
      let count = 0;
      for (let p = out.indexOf(o); p !== -1; p = out.indexOf(o, p + o.length)) count++;
      if (!count) throw new Error(`edits[${i}]: 본문에서 찾지 못했습니다`);
      if (count > 1 && e?.replace_all !== true) throw new Error(`edits[${i}]: 본문에 ${count}곳 있어 어디를 바꿀지 모호합니다`);
      out = e?.replace_all === true ? out.split(o).join(n) : out.replace(o, n);
    });
    return out;
  };
  // 배치의 재조회와 저장 사이에 끼어드는 사람 저장 — 그 문서의 첫 저장 요청을 받는 순간 먼저 반영한다.
  const humanSaveFirst = (name, d) => {
    const h = st.hooks[name]?.beforeSave;
    if (!h) return;
    delete st.hooks[name].beforeSave;
    Object.assign(d, h);
    d.version += 1;
    st.log.push({ human: name });
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = String(init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const path = decodeURIComponent(url.pathname);
    st.log.push({ method, host: url.host, path, body });
    if (method === "GET" && path === "/api/ui/org/runtime-config") return reply(200, { config: st.config ?? null });
    if (method === "GET" && path === "/api/ui/knowledge") {
      const q = url.searchParams;
      const all = Object.values(st.docs).filter((d) => (!q.get("provenance") || d.provenance === q.get("provenance"))
        && (!q.get("lifecycle") || d.lifecycle === q.get("lifecycle")));
      const limit = Number(q.get("limit") ?? 200), offset = Number(q.get("offset") ?? 0);
      return reply(200, { entries: all.slice(offset, offset + limit).map(pub), total: all.length, has_more: offset + limit < all.length });
    }
    let m = path.match(/^\/api\/ui\/knowledge\/([^/]+)$/);
    if (method === "GET" && m) {
      const d = st.docs[m[1]];
      if (!d) return fail(404, `지식 '${m[1]}' 없음`);
      return reply(200, { knowledge: pub(d), ...(d.pending_revision ? { pending_revision: d.pending_revision } : {}) });
    }
    m = path.match(/^\/api\/ui\/knowledge\/([^/]+)\/title$/);
    if (method === "POST" && m) {
      const d = st.docs[m[1]];
      if (!d) return fail(404, `지식 '${m[1]}' 없음`);
      humanSaveFirst(m[1], d);
      if (staged(d)) return fail(409, `이 지식엔 검토 대기 중인 수정 제안(#${d.pending_revision.id})이 있어 제목 갱신이 허용되지 않습니다`);
      const title = String(body?.title ?? "").trim();
      if (!title) return fail(400, "title 이(가) 필요합니다");
      d.title = title;
      d.version += 1;
      return reply(200, { knowledge: pub(d) });
    }
    if (method === "POST" && path === "/api/ui/knowledge") {
      const d = st.docs[body?.name];
      if (!d) return fail(404, `지식 '${body?.name}' 없음`);
      humanSaveFirst(body.name, d);
      const mode = body.mode ?? "replace";
      let next;
      if (mode === "edit") {
        if (staged(d)) return fail(409, `이 지식엔 검토 대기 중인 수정 제안(#${d.pending_revision.id})이 있어 edit 가 허용되지 않습니다`);
        try { next = applyEdits(d.body_md, body.edits); } catch (e) { return fail(400, e.message); }
      } else if (mode === "replace") {
        next = String(body.body_md ?? "").trim();
        if (!next) return fail(400, "body_md(또는 note)가 필요합니다");
      } else return fail(400, `대역이 모르는 mode: ${mode}`);
      d.body_md = next;
      if (body.title) d.title = String(body.title);
      d.supersedes = body.supersedes ? String(body.supersedes) : null;
      d.version += 1;
      if (mode === "edit") { const { body_md: _b, ...rest } = pub(d); return reply(200, { knowledge: rest, appended: { version: d.version } }); }
      return reply(200, { knowledge: pub(d) });
    }
    return fail(404, `대역에 없는 경로: ${method} ${path}`);
  };
}

/** 가짜 LLM — 배치가 띄우는 명령. 프롬프트를 stdin 으로 받아 결정적으로 답하고, 받은 env·argv·가드 여부를 기록한다. */
async function fakeLlmMain(appendFileSync, logFile) {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) input += c;
  const lines = input.split("\n");
  const after = (marker) => { const i = lines.indexOf(marker); return i < 0 ? null : JSON.parse(lines[i + 1]); };
  const a = after("A(JSON):"), src = after("원문(JSON):");
  appendFileSync(logFile, `${JSON.stringify({
    purpose: a ? "judge" : src ? "rewrite" : "unknown",
    title: (a ?? src)?.title ?? null,
    livelyEnv: Object.keys(process.env).filter((k) => /^LIVELY_/i.test(k)).sort(),
    livelyOff: process.env.LIVELY_OFF ?? null,
    argv: process.argv.slice(2),
    guard: src ? /지시.*따르지\s*말/.test(input.slice(0, input.indexOf("원문(JSON):"))) : null,
  })}\n`);
  if (a) {
    // «판정불가» 문서는 판정 답이 JSON 이 아니다 — 판정 JSON 실패가 의미 탈락 상한에 세지는지 본다.
    process.stdout.write(String(a.title).includes("판정불가") ? "판정을 내릴 수 없다" : JSON.stringify({ items: [] }));
    return;
  }
  if (!src) { process.stderr.write("모르는 프롬프트"); process.exit(3); }
  // 제목 앞 그림 문자를 지우고, 헤딩으로 시작하는 본문엔 첫 문단을 결론 줄로 앞에 붙인다(값은 그대로라 게이트를 통과한다).
  const title = String(src.title).replace(/^\p{Extended_Pictographic}️?\s*/u, "");
  let body = String(src.body_md);
  if (/^#{1,6} /.test(body)) {
    const lead = body.split("\n\n").find((p) => p.trim() && !/^#{1,6} /.test(p));
    if (lead) body = `${lead}\n\n${body}`;
  }
  process.stdout.write(JSON.stringify({ title, body_md: body }));
}

const DAY = 86_400_000;
const doc = (name, title, body_md, extra = {}) => ({
  name, title, body_md, provenance: "authored", lifecycle: "active", injection: "recalled", is_folder: false,
  supersedes: null, version: 3, updated_at: new Date(Date.now() - 3 * DAY).toISOString(), ...extra,
});
// 헤딩으로 시작하는 본문 — lead_missing 으로 적격이 되고, 가짜 LLM 이 첫 문단을 결론 줄로 붙인다.
const lead = (s1, s2) => `## 배경\n\n${s1}\n\n${s2}`;
const rewritten = (body) => `${body.split("\n\n")[1]}\n\n${body}`;

/** 시험 하나의 작업 자리 — 대역 상태·가짜 LLM·샌드박스 홈을 mkdtemp 아래에 둔다. */
function workspace(docs, { hooks = {}, config = { writing_format: { enabled: true } } } = {}) {
  const T = mkdtempSync(join(tmpdir(), "style-batch-"));
  for (const d of ["home", "tmp", "bin"]) mkdirSync(join(T, d));
  // 진짜 `claude` 를 가로막는 자리 — run() 이 늘 가짜 명령을 넘기지만, 빠뜨려도 실제 LLM 이 뜨지 않게 PATH 맨 앞에 둔다.
  const realClaudeHit = join(T, "real-claude-called");
  writeFileSync(join(T, "bin", "claude"), `#!/bin/sh\necho called >> ${JSON.stringify(realClaudeHit)}\nexit 97\n`);
  chmodSync(join(T, "bin", "claude"), 0o755);
  const stub = join(T, "stub.mjs");
  writeFileSync(stub, `import { readFileSync, writeFileSync } from "node:fs";\n(${stubMain.toString()})(readFileSync, writeFileSync);\n`);
  const llm = join(T, "fake-llm.mjs");
  const llmLog = join(T, "llm-calls.jsonl");
  writeFileSync(llm, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nawait (${fakeLlmMain.toString()})(appendFileSync, ${JSON.stringify(llmLog)});\n`);
  chmodSync(llm, 0o755);
  const stateFile = join(T, "state.json");
  writeFileSync(stateFile, JSON.stringify({ docs: Object.fromEntries(docs.map((d) => [d.name, d])), hooks, config, log: [] }));
  const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
  const patch = (fn) => { const s = state(); fn(s); s.log = []; writeFileSync(stateFile, JSON.stringify(s)); };
  const llmCalls = () => (existsSync(llmLog) ? readFileSync(llmLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const rows = (f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const byName = (f) => Object.fromEntries(rows(f).map((r) => [r.name, r]));
  const names = (list) => { const f = join(T, `names-${list.length}-${Date.now()}.txt`); writeFileSync(f, `${list.join("\n")}\n`); return f; };
  async function run(args, env = {}) {
    // LLM 명령은 늘 가짜다 — 시험이 따로 주는 경우(못 띄우는 명령)만 그것을 쓴다.
    const llmArgs = args.includes("--llm-cmd") ? [] : ["--llm-cmd", llm];
    const r = await new Promise((resolve) => {
      const p = spawn(process.execPath, ["--import", pathToFileURL(stub).href, BATCH, ...args, ...llmArgs], {
        cwd: T,
        env: {
          ...process.env, ...sandboxEnv({ home: join(T, "home"), tmp: join(T, "tmp") }),
          PATH: `${join(T, "bin")}${delimiter}${process.env.PATH ?? ""}`,
          STYLE_BATCH_STUB: stateFile,
          LIVELY_URL: "http://gw.stub.invalid", LIVELY_TOKEN: "stub-token",
          // 신원 값 — LLM 자식 env 에서 빠지는지 본다.
          LIVELY_SESSION_ID: "stub-session",
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      p.stdout.on("data", (d) => { stdout += d; });
      p.stderr.on("data", (d) => { stderr += d; });
      const timer = setTimeout(() => p.kill("SIGKILL"), 60_000);
      p.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    assert.equal(existsSync(realClaudeHit), false, "시험이 진짜 claude 를 부르면 안 된다");
    return r;
  }
  return { T, llm, run, state, patch, llmCalls, rows, byName, names, report: (n) => join(T, n), done: () => rmSync(T, { recursive: true, force: true }) };
}

const saves = (log) => log.filter((e) => e.method === "POST");

test("dry-run → --apply-from → 다시 돌리기", async (t) => {
  const docs = [
    doc("retry-policy", "결제 재시도 정책", lead("결제 재시도는 세 번까지만 허용한다.", "실패하면 사용자에게 안내 메시지를 보낸다."), { supersedes: "retry-policy-old" }),
    doc("deploy-steps", "🧭 배포 절차", "배포는 승인을 받은 뒤에만 한다.\n\n승인은 운영 담당자가 한다."),
    doc("shell-vars", "셸 변수 안내", lead("셸에서는 $& 와 $1 같은 표기를 쓴다.", "변수는 따옴표로 감싼다.")),
    doc("pending-doc", "환불 처리 기준", lead("환불은 결제 수단으로만 돌려준다.", "현금 환불은 하지 않는다."), { pending_revision: { id: 41, mode: "staged" } }),
    doc("org-rules", "조직 규칙", lead("규칙은 모든 세션에 실린다.", "규칙은 관리자만 고친다."), { injection: "always" }),
    doc("race-body", "장애 대응 순서", lead("장애가 나면 먼저 공지한다.", "원인 분석은 복구 뒤에 한다.")),
    doc("race-append", "릴리스 점검", lead("릴리스 전에는 점검표를 확인한다.", "점검표는 팀이 함께 고친다.")),
    doc("race-title", "🧭 휴가 신청", "휴가는 사흘 전에 신청한다.\n\n신청은 팀장이 승인한다."),
    doc("archived-later", "로그 보관 기간", lead("로그는 정해진 기간만 보관한다.", "기간이 지나면 지운다.")),
    doc("always-later", "보안 안내", lead("비밀번호는 공유하지 않는다.", "공유하면 바로 바꾼다.")),
    doc("pending-later", "회의록 작성법", lead("회의록은 회의 당일에 올린다.", "결정 사항을 맨 위에 쓴다.")),
  ];
  const src = Object.fromEntries(docs.map((d) => [d.name, d]));
  const hooks = {
    // 본문 가운데를 고친 사람 저장 — 배치가 읽은 본문이 더는 없다.
    "race-body": { beforeSave: { body_md: src["race-body"].body_md.replace("먼저 공지한다", "먼저 담당자를 부르고 공지한다") } },
    // 끝에 문단을 덧붙인 사람 저장 — 읽은 본문은 그대로 남아 있다.
    "race-append": { beforeSave: { body_md: `${src["race-append"].body_md}\n\n사람이 덧붙인 문단이다.` } },
    // 제목만 고치는 문서에 끼어든 본문 편집.
    "race-title": { beforeSave: { body_md: `${src["race-title"].body_md}\n\n사람이 고친 문장이다.` } },
  };
  const w = workspace(docs, { hooks });
  t.after(() => w.done());

  // ── dry-run ──
  const dryFile = w.report("dry.jsonl");
  const dry = await w.run(["--report", dryFile, "--all"]);
  assert.equal(dry.code, 0, dry.stderr);
  const d = w.byName(dryFile);
  for (const n of ["retry-policy", "deploy-steps", "shell-vars", "race-body", "race-append", "race-title", "archived-later", "always-later", "pending-later"]) {
    assert.equal(d[n]?.status, "passed_dry", `${n}: ${JSON.stringify(d[n])}`);
  }
  assert.equal(saves(w.state().log).length, 0, "dry-run 은 저장하지 않는다");
  const calls = w.llmCalls();
  assert.ok(calls.length > 0);

  await t.test("시작할 때 대상 게이트웨이를 알린다", () => assert.match(dry.stderr, /http:\/\/gw\.stub\.invalid/));
  await t.test("항상 주입 섹션은 후보 목록에서 빠진다", () => assert.equal(d["org-rules"], undefined, JSON.stringify(d["org-rules"])));
  await t.test("검토 대기 제안이 있는 문서는 건너뛰고 LLM 을 쓰지 않는다", () => {
    assert.equal(d["pending-doc"]?.status, "skipped", JSON.stringify(d["pending-doc"]));
    assert.equal(d["pending-doc"]?.reason, "pending_revision");
    assert.ok(!calls.some((c) => c.title === "환불 처리 기준"));
  });
  await t.test("LLM 자식은 라이블리 신원·게이트웨이 env 없이, 라이블리 훅과 도구를 끈 채 뜬다", () => {
    for (const c of calls) {
      assert.deepEqual(c.livelyEnv, ["LIVELY_OFF"]);
      assert.equal(c.livelyOff, "1");
      const i = c.argv.indexOf("--tools");
      assert.ok(i >= 0 && c.argv[i + 1] === "", JSON.stringify(c.argv));
    }
  });
  await t.test("재작성 프롬프트도 문서 안의 지시를 따르지 말라고 한다", () =>
    assert.ok(calls.filter((c) => c.purpose === "rewrite").every((c) => c.guard)));

  // ── dry-run 과 반영 사이 — 판을 올리지 않는 변경들 ──
  w.patch((s) => {
    s.docs["archived-later"].lifecycle = "archived";
    s.docs["always-later"].injection = "always";
    s.docs["pending-later"].pending_revision = { id: 52, mode: "staged" };
  });

  // ── --apply-from ──
  const appFile = w.report("apply.jsonl");
  const app = await w.run(["--report", appFile, "--apply-from", dryFile]);
  assert.equal(app.code, 0, app.stderr);
  const a = w.byName(appFile);
  const st = w.state();
  const row = (n) => JSON.stringify(a[n]);

  await t.test("supersedes 를 지우지 않고 재작성 본문을 그대로 저장한다", () => {
    assert.equal(a["retry-policy"]?.status, "applied", row("retry-policy"));
    assert.equal(st.docs["retry-policy"].supersedes, "retry-policy-old");
    assert.equal(st.docs["retry-policy"].body_md, rewritten(src["retry-policy"].body_md));
  });
  await t.test("제목만 고친 문서는 본문을 건드리지 않는다", () => {
    assert.equal(a["deploy-steps"]?.status, "applied", row("deploy-steps"));
    assert.equal(st.docs["deploy-steps"].title, "배포 절차");
    assert.equal(st.docs["deploy-steps"].body_md, src["deploy-steps"].body_md);
  });
  await t.test("재작성본의 `$&`·`$1` 을 치환 패턴으로 읽히게 보내지 않는다", () => {
    assert.equal(a["shell-vars"]?.status, "applied", row("shell-vars"));
    assert.equal(st.docs["shell-vars"].body_md, rewritten(src["shell-vars"].body_md));
  });
  await t.test("재조회 뒤 본문을 고친 사람 저장은 덮지 않는다(changed_meanwhile)", () => {
    assert.match(st.docs["race-body"].body_md, /담당자를 부르고/);
    assert.equal(st.docs["race-body"].version, 4, "사람 저장 하나만 반영됐다");
    assert.equal(a["race-body"]?.status, "skipped", row("race-body"));
    assert.equal(a["race-body"]?.reason, "changed_meanwhile");
  });
  await t.test("끝에 덧붙인 사람 편집은 남고, 끼어든 저장을 applied_over_concurrent_edit 로 알린다", () => {
    assert.match(st.docs["race-append"].body_md, /사람이 덧붙인 문단이다\.$/);
    assert.ok(st.docs["race-append"].body_md.startsWith("릴리스 전에는 점검표를 확인한다.\n\n## 배경"), "재작성은 읽은 본문 자리에만 들어간다");
    assert.equal(a["race-append"]?.status, "applied_over_concurrent_edit", row("race-append"));
  });
  await t.test("제목만 고치는 사이 끼어든 본문 편집도 남고 applied_over_concurrent_edit 로 알린다", () => {
    assert.match(st.docs["race-title"].body_md, /사람이 고친 문장이다\./);
    assert.equal(st.docs["race-title"].title, "휴가 신청");
    assert.equal(a["race-title"]?.status, "applied_over_concurrent_edit", row("race-title"));
  });
  await t.test("dry-run 뒤 보관·항상 주입·검토 대기로 바뀐 문서는 저장 직전에 다시 보고 건너뛴다", () => {
    for (const [n, reason] of [["archived-later", "lifecycle"], ["always-later", "always_injected"], ["pending-later", "pending_revision"]]) {
      assert.equal(st.docs[n].version, 3, `${n} 은 저장하지 않는다`);
      assert.equal(st.docs[n].body_md, src[n].body_md);
      assert.equal(a[n]?.status, "skipped", row(n));
      assert.equal(a[n]?.reason, reason, row(n));
    }
  });
  await t.test("배치 저장마다 배치가 고쳤다는 변경 요약(change_note)을 보낸다", () => {
    const posted = saves(st.log);
    assert.ok(posted.length >= 5, JSON.stringify(posted.map((p) => p.path)));
    for (const p of posted) assert.match(String(p.body?.change_note ?? ""), /style-rewrite-batch/, `${p.path} ${JSON.stringify(p.body)}`);
  });

  // ── 같은 리포트로 다시 반영 ──
  w.patch(() => {});
  const againFile = w.report("apply-again.jsonl");
  const again = await w.run(["--report", againFile, "--apply-from", dryFile]);
  assert.equal(again.code, 0, again.stderr);
  await t.test("같은 리포트로 다시 반영하면 바뀐 문서를 건너뛰고 아무것도 저장하지 않는다", () => {
    assert.equal(saves(w.state().log).length, 0);
    const g = w.byName(againFile);
    for (const n of ["retry-policy", "deploy-steps", "shell-vars", "race-body", "race-append", "race-title"]) {
      assert.equal(g[n]?.reason, "changed_since_dry_run", `${n}: ${JSON.stringify(g[n])}`);
    }
  });
});

test("판정 JSON 실패도 의미 탈락 상한(2회)에 센다", async () => {
  const w = workspace([doc("unjudgeable", "판정불가 안내", lead("이 문서는 판정이 어렵다.", "판정은 사람이 한다."))]);
  try {
    const f = w.report("dry.jsonl");
    const r = await w.run(["--report", f, "--names", w.names(["unjudgeable"]), "--attempts", "3"]);
    assert.equal(r.code, 0, r.stderr);
    const row = w.byName(f).unjudgeable;
    assert.equal(row?.status, "rejected", JSON.stringify(row));
    assert.equal(w.llmCalls().filter((c) => c.purpose === "judge").length, 2, "판정에 후보를 내는 횟수는 두 번까지다");
  } finally { w.done(); }
});

test("LLM 명령을 못 띄우면(llm_spawn) 전 문서를 실패로 태우지 않고 멈춘다", async () => {
  const list = ["s1", "s2", "s3", "s4", "s5"];
  const w = workspace(list.map((n) => doc(n, `문서 ${n}`, lead(`${n} 문서는 이렇게 쓴다.`, "둘째 문장은 덧붙임이다."))));
  try {
    const f = w.report("dry.jsonl");
    const r = await w.run(["--report", f, "--names", w.names(list), "--llm-cmd", join(w.T, "no-such-llm")]);
    assert.equal(r.code, 0, r.stderr);
    const rows = w.rows(f);
    assert.equal(rows.length, 3, JSON.stringify(rows.map((x) => x.reason)));
    assert.ok(rows.every((x) => /^llm_spawn/.test(x.reason)));
    assert.match(r.stderr, /멈춘다/);
  } finally { w.done(); }
});

test("게이트웨이 주소는 LIVELY_URL·LIVELY_GATEWAY_URL 둘 다 받고, 둘이 다르면 시작하지 않는다", async () => {
  const w = workspace([doc("one", "결제 재시도 정책", lead("결제 재시도는 세 번까지만 허용한다.", "실패하면 사용자에게 안내 메시지를 보낸다."))]);
  try {
    const only = await w.run(["--report", w.report("a.jsonl"), "--names", w.names(["one"])], { LIVELY_URL: undefined, LIVELY_GATEWAY_URL: "http://gw-b.stub.invalid" });
    assert.equal(only.code, 0, only.stderr);
    assert.match(only.stderr, /http:\/\/gw-b\.stub\.invalid/);
    const hosts = new Set(w.state().log.filter((e) => e.host).map((e) => e.host));
    assert.deepEqual([...hosts], ["gw-b.stub.invalid"]);

    w.patch(() => {});
    const both = await w.run(["--report", w.report("b.jsonl"), "--names", w.names(["one"])], { LIVELY_URL: "http://gw-a.stub.invalid", LIVELY_GATEWAY_URL: "http://gw-b.stub.invalid" });
    assert.equal(both.code, 2, both.stderr);
    assert.match(both.stderr, /LIVELY_GATEWAY_URL/);
    assert.equal(w.state().log.length, 0, "어느 쪽에도 요청하지 않는다");
  } finally { w.done(); }
});

test("--apply-from 은 반쯤 쓰인 리포트 줄을 건너뛰고 나머지를 반영한다", async () => {
  const body = lead("결제 재시도는 세 번까지만 허용한다.", "실패하면 사용자에게 안내 메시지를 보낸다.");
  const w = workspace([doc("one", "결제 재시도 정책", body)]);
  try {
    const dry = w.report("dry.jsonl");
    const row = { name: "one", version: 3, status: "passed_dry", rules: ["lead_missing"], after_title: "결제 재시도 정책", after_body: rewritten(body) };
    writeFileSync(dry, `${JSON.stringify(row)}\n{"name":"two","status":"passed_dr`);
    const f = w.report("apply.jsonl");
    const r = await w.run(["--report", f, "--apply-from", dry]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(w.byName(f).one?.status, "applied");
    assert.equal(w.state().docs.one.body_md, rewritten(body));
  } finally { w.done(); }
});
