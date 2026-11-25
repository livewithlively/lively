// 서술 형식(writing_format) 저장 판정의 배선 PG 통합 테스트 — **실제 Postgres 필요**(.github/workflows/test.yml 의 pg 잡이 자동 수집).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/capabilities/writing-style.pg-test.mjs
//
// 왜 이 계층인가: 판정(checkWriting)과 사람 판정(isHumanWriter)은 유닛 시험이 있다. 그런데 저장 경로마다 그 함수에 무엇을 넘기는지
//  (기존 문서의 provenance · 폴더 · 이어쓰기 전 본문 · 요청의 인증 출처와 화면 표식)는 핸들러와 REST 어댑터를 지나야 보인다.
//  이름 해석(resolveKnowledgeName)의 SQL 후보도 진짜 PG 가 아니면 NUL 같은 입력의 실패를 못 본다.
//  그래서 진짜 Express(registerWebUi · 진짜 토큰 검증기 · 웹 로그인 세션)와 MCP 핸들러 직접 호출을 함께 쓰고, 판정은 응답과 DB 로 한다.
//  이 파일은 제 DB 를 만든다 — 조직 설정(writing_format)을 켜므로 다른 시험과 같은 DB 를 쓰지 않는다.
//
//  사양 엣지 표(행마다 단언):
//   W1  reject 규칙의 새 위반 · 에이전트(MCP) → 422 · 저장 안 됨
//   W2  같은 저장 · 토큰 스크립트(REST · 화면 표식 없음) → 422 · 저장 안 됨
//   W3  같은 저장 · 웹 로그인 세션(쿠키) → 200 · 응답 style 에 그 위반(reject 수준) · 저장됨
//   W4  같은 저장 · 토큰 + x-lively-client: web-ui(데스크톱 앱 · «토큰으로 로그인» 웹) → 200 · style · 저장됨
//   W5  MCP 호출은 화면 표식을 실어도 사람이 아니다 → 422
//   W6  이어쓰기(append) — 원래 있던 위반(legacy)은 거부 사유가 아니다 → 200 · style.legacy · 조각이 붙는다
//   W7  knowledge_set_title — 에이전트의 새 위반 → 422 · 제목 그대로 / 웹 화면 → 200 · style · 제목 바뀜 / 원래 있던 위반 → 200 · legacy
//   W8  provenance 는 저장된 값으로 본다 — 기존 authored 문서에 observed 를 실어도 · 신규에 observed 를 실어도 422 /
//       저장된 observed 문서는 판정하지 않는다(대조)
//   W9  is_folder:true — 본문이 있으면 판정한다(422) · 본문이 비면 건너뛴다(200)
//   W10 activity_log — 외부 좌표(system + id)가 있는 미러 기록은 판정하지 않는다(200) · system 만 실은 기록 · 좌표 없는 기록은 판정한다(422)
//   W11 이름 해석 — '-' 로 끝나는 실재 이름은 그 행을 고친다(꼬리를 뗀 새 행이 생기지 않는다)
//   W12 이름에 NUL 이 섞여도 저장된다(정규화한 이름으로)
//   W13 형식이 꺼진 조직의 저장 1건 — 이름 해석 조회는 정규형 이름이면 0번 · 아닌 이름이면 1번
//       (핸들러가 해석한 이름을 게이트 · 저장소가 다시 해석하지 않는다). 총 조회 수는 참고로 찍는다.
import pg from "pg";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_writing_style_1680";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
const dbc = new pg.Client({ connectionString: dsnFor(DB) }); await dbc.connect();
await dbc.query("CREATE EXTENSION IF NOT EXISTS vector"); await dbc.end();
process.env.ITEMS_DATABASE_URL = dsnFor(DB);
// 파일 자리는 임시 폴더로 — 저장 경로가 폴더를 만지지 않지만, 게이트웨이 라우트를 싣는 이상 실제 자리를 가리키게 두지 않는다.
const ROOT = mkdtempSync(path.join(os.tmpdir(), "lively-writing-style-pg-"));
process.env.TERMINAL_ROOT_SHARED = path.join(ROOT, "shared");
process.env.TERMINAL_ROOT_PERSONAL = path.join(ROOT, "box");
process.env.TERMINAL_ROOT_APPS = path.join(ROOT, "apps");
for (const d of ["shared", "box", "apps"]) mkdirSync(path.join(ROOT, d), { recursive: true });
delete process.env.EMBEDDINGS_PROVIDER;   // 신규 저장의 중복 탐지가 바깥 임베딩을 부르지 않게

const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const express = (await import("express")).default;
const { itemsPool } = await import(`${D}/db/client.js`);
const { registerWebUi } = await import(`${D}/web.js`);
const { BearerVerifier } = await import(`${D}/auth/bearer.js`);
const { upsertMember } = await import(`${D}/org/store/members.js`);
const { mintToken } = await import(`${D}/org/store/tokens.js`);
const { createSession } = await import(`${D}/auth/sessions.js`);
const { updateRuntimeConfig } = await import(`${D}/org/store/runtime-config.js`);
const { registry } = await import(`${D}/capabilities/index.js`);

let pass = 0, fail = 0;
/** 실패 사유는 짧게 — 응답 전문(본문 · 가이드)을 찍으면 무엇이 틀렸는지 묻힌다. 상태 · 에러 앞머리 · style 의 규칙만. */
const brief = (v) => {
  if (!v || typeof v !== "object") return v;
  const style = v.style ?? v.out?.style ?? v.json?.style;
  const knowledge = v.knowledge ?? v.out?.knowledge ?? v.json?.knowledge;
  return {
    ...("ok" in v ? { ok: v.ok } : {}), ...(v.status !== undefined ? { status: v.status } : {}),
    ...(v.msg || v.json?.error ? { error: String(v.msg ?? v.json?.error).split("\n")[0].slice(0, 120) } : {}),
    ...(v.json === null && v.text ? { text: v.text.slice(0, 120) } : {}),
    ...(style ? { rules: (style.findings ?? []).map((f) => `${f.rule}:${f.level}`), legacy: style.legacy, introduced: style.introduced } : {}),
    ...(knowledge ? { name: knowledge.name, title: knowledge.title, provenance: knowledge.provenance } : {}),
    ...(v.resolve !== undefined ? { resolve: v.resolve } : {}),
    ...(v.title !== undefined && !knowledge ? { title: v.title, provenance: v.provenance, body: String(v.body_md ?? "").slice(0, 40) } : {}),
  };
};
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${typeof why === "string" ? why : JSON.stringify(brief(why))}`); } };

const AGENT = "pgt-ws-agent", HUMAN = "pgt-ws-human";
const BAD_TITLE = "🔴 배포 규칙";              // title_leading_emoji — 아래 형식에서 reject
const CLEAN_TITLE = "배포 노트 범위";
const CLEAN_BODY = "배포 노트는 직전 배포 이후 커밋을 싣는다.";
const NEW = { category: "ws-cat", type: "reference" };

const agentUser = { userId: AGENT, email: "", scopes: ["memory"], projects: ["*"], tokenSource: "db" };
const mcpCtx = { source: "mcp", actor: AGENT, viewer: AGENT };
/** MCP 어댑터와 같은 모양으로 핸들러를 부른다 — 던지면 { ok:false, status, msg }. 입력은 부를 때마다 새 객체(핸들러가 name 을 고쳐 쓴다). */
const mcp = async (tool, input, ctx = mcpCtx) => {
  try { return { ok: true, out: await registry.get(tool).handler({ ...input }, agentUser, ctx) }; }
  catch (e) { return { ok: false, status: e?.status, msg: String(e?.message ?? e).slice(0, 200) }; }
};
const row = async (name) => (await itemsPool.query(
  `SELECT name, title, body_md, provenance, is_folder FROM knowledge WHERE name=$1`, [name])).rows[0];
const seed = (name, title, body, provenance = "authored") => itemsPool.query(
  `INSERT INTO knowledge(name, title, body_md, provenance, lifecycle, visibility) VALUES($1,$2,$3,$4,'active','open')`,
  [name, title, body, provenance]);
const hasRule = (style, rule, level) => (style?.findings ?? []).some((f) => f.rule === rule && (!level || f.level === level));

let server = null;
try {
  await upsertMember({ id: AGENT, display_name: "에이전트", state: "active", scopes: ["memory"] }, "pgt");
  await upsertMember({ id: HUMAN, display_name: "사람", state: "active", scopes: ["memory"] }, "pgt");
  //  사람의 토큰 — 데스크톱 앱이 웹 화면에 넣는 CLI 토큰 · «토큰으로 로그인(고급)» 의 그 토큰과 같은 종류(tokenSource 'db').
  //   같은 토큰을 화면 표식 없이 보내면 토큰 스크립트다(W2) — 둘을 가르는 것은 표식 하나뿐이다.
  const tok = (await mintToken({ userId: HUMAN, memberId: HUMAN, scopes: ["memory"] }, "pgt")).token;
  const { sessionId } = await createSession(HUMAN);
  await itemsPool.query(`INSERT INTO category(key, name) VALUES('ws-cat', 'ws-cat')`);
  //  설정은 관리 경로(updateRuntimeConfig)로 켠다 — 형식 조회에 캐시가 붙어도 저장이 무효화를 거치게.
  await updateRuntimeConfig({ writing_format: { enabled: true, rules: { title_leading_emoji: "reject" } } }, "pgt", "test");

  const gw = express();
  gw.use(express.json({ limit: "1mb" }));
  registerWebUi(gw, new BearerVerifier());
  server = http.createServer(gw);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const rest = async (p, body, headers) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* 본문이 JSON 아님 */ }
    return { status: r.status, json, text: text.slice(0, 200) };
  };
  const asToken = { authorization: `Bearer ${tok}` };
  const asWebUi = { authorization: `Bearer ${tok}`, "x-lively-client": "web-ui" };
  const asSession = { cookie: `lively_sess=${sessionId}` };
  const saveBody = (name) => ({ name, title: BAD_TITLE, body_md: CLEAN_BODY, ...NEW });

  // ── W1 · W2 · W3 · W4 · W5 — 같은 새 위반, 부르는 쪽만 다르다 ──
  {
    const r = await mcp("knowledge_save", saveBody("ws-w1"));
    chk("W1 에이전트(MCP)의 새 위반 → 422", !r.ok && r.status === 422, r);
    chk("W1 저장 안 됨", !(await row("ws-w1")), await row("ws-w1"));
  }
  {
    const r = await rest("/api/ui/knowledge", saveBody("ws-w2"), asToken);
    chk("W2 토큰 스크립트(REST · 표식 없음) → 422", r.status === 422 && hasRule(r.json?.style, "title_leading_emoji"), r);
    chk("W2 저장 안 됨", !(await row("ws-w2")), await row("ws-w2"));
  }
  {
    const r = await rest("/api/ui/knowledge", saveBody("ws-w3"), asSession);
    chk("W3 웹 로그인 세션 → 200 · style 에 reject 수준 위반이 실린다", r.status === 200 && hasRule(r.json?.style, "title_leading_emoji", "reject"), r);
    chk("W3 저장됨", (await row("ws-w3"))?.title === BAD_TITLE, await row("ws-w3"));
  }
  {
    const r = await rest("/api/ui/knowledge", saveBody("ws-w4"), asWebUi);
    chk("W4 토큰 + x-lively-client: web-ui(데스크톱 앱 · 토큰 로그인 웹) → 200 · style", r.status === 200 && hasRule(r.json?.style, "title_leading_emoji", "reject"), r);
    chk("W4 저장됨", (await row("ws-w4"))?.title === BAD_TITLE, await row("ws-w4"));
  }
  {
    const r = await mcp("knowledge_save", saveBody("ws-w5"), { ...mcpCtx, client: "web-ui" });
    chk("W5 MCP 는 화면 표식을 실어도 사람이 아니다 → 422", !r.ok && r.status === 422, r);
  }

  // ── W6 이어쓰기 — 원래 있던 위반은 거부 사유가 아니다 ──
  {
    await seed("ws-w6", "🔴 옛 규칙", "옛 본문이다.");
    const r = await mcp("knowledge_save", { name: "ws-w6", mode: "append", body_md: "덧붙인 문단이다." });
    chk("W6 원래 있던 위반이 남은 이어쓰기 → 200", r.ok, r);
    chk("W6 style.legacy 로 짚고 introduced 에는 없다",
      (r.out?.style?.legacy ?? []).includes("title_leading_emoji") && !(r.out?.style?.introduced ?? []).includes("title_leading_emoji"), r.out?.style);
    chk("W6 조각이 붙었다", ((await row("ws-w6"))?.body_md ?? "").endsWith("덧붙인 문단이다."), await row("ws-w6"));
  }

  // ── W7 knowledge_set_title ──
  {
    await seed("ws-w7", CLEAN_TITLE, CLEAN_BODY);
    const a = await mcp("knowledge_set_title", { name: "ws-w7", title: "🚫 배포 노트 범위" });
    chk("W7a 에이전트의 제목 새 위반 → 422", !a.ok && a.status === 422, a);
    chk("W7a 제목 그대로", (await row("ws-w7"))?.title === CLEAN_TITLE, await row("ws-w7"));
    const b = await rest("/api/ui/knowledge/ws-w7/title", { title: "🚫 배포 노트 범위" }, asWebUi);
    chk("W7b 웹 화면의 제목 변경 → 200 · style 이 실린다", b.status === 200 && hasRule(b.json?.style, "title_leading_emoji", "reject"), b);
    chk("W7b 제목 바뀜", (await row("ws-w7"))?.title === "🚫 배포 노트 범위", await row("ws-w7"));
    const c = await mcp("knowledge_set_title", { name: "ws-w7", title: "🚫 배포 노트 범위 정리" });
    chk("W7c 원래 있던 위반이 남은 제목 변경 → 200 · legacy", c.ok && (c.out?.style?.legacy ?? []).includes("title_leading_emoji"), c.ok ? c.out?.style : c);
  }

  // ── W8 provenance — 입력이 아니라 저장된 값 ──
  {
    await seed("ws-w8", CLEAN_TITLE, CLEAN_BODY);
    const a = await mcp("knowledge_save", { name: "ws-w8", provenance: "observed", title: BAD_TITLE, body_md: CLEAN_BODY });
    chk("W8a 기존 authored 문서에 observed 를 실어도 판정한다 → 422", !a.ok && a.status === 422, a);
    const after = await row("ws-w8");
    chk("W8a 제목 · provenance 그대로", after?.title === CLEAN_TITLE && after?.provenance === "authored", after);
    const b = await mcp("knowledge_save", { name: "ws-w8b", provenance: "observed", ...saveBody("ws-w8b") });
    chk("W8b 신규에 observed 를 실어도 판정한다 → 422", !b.ok && b.status === 422, b);
    chk("W8b 저장 안 됨", !(await row("ws-w8b")), await row("ws-w8b"));
    await seed("ws-w8c", CLEAN_TITLE, CLEAN_BODY, "observed");
    const c = await mcp("knowledge_save", { name: "ws-w8c", title: BAD_TITLE, body_md: CLEAN_BODY });
    chk("W8c 저장된 observed 문서는 판정하지 않는다(대조) → 200", c.ok && (await row("ws-w8c"))?.title === BAD_TITLE, c);
  }

  // ── W9 폴더 ──
  {
    const a = await mcp("knowledge_save", { name: "ws-w9", is_folder: true, title: BAD_TITLE, body_md: "폴더 설명 문단이다.", ...NEW });
    chk("W9a 본문이 있는 폴더는 판정한다 → 422", !a.ok && a.status === 422, a);
    chk("W9a 저장 안 됨", !(await row("ws-w9")), await row("ws-w9"));
    const b = await mcp("knowledge_save", { name: "ws-w9b", is_folder: true, title: BAD_TITLE, body_md: "", ...NEW });
    chk("W9b 본문이 빈 폴더는 건너뛴다 → 200", b.ok && (await row("ws-w9b"))?.is_folder === true, b);
  }

  // ── W10 작업기록의 외부 좌표 ──
  {
    const rec = { type: "docs", title: BAD_TITLE, body: "기록 본문이다." };
    const a = await mcp("activity_log", { ...rec, external_system: "clickup", external_id: "ws-c-1" });
    chk("W10a 외부 좌표(system + id)가 있는 미러 기록은 판정하지 않는다 → 200", a.ok, a);
    const b = await mcp("activity_log", { ...rec, external_system: "clickup" });
    chk("W10b system 만 실은 기록은 판정한다 → 422", !b.ok && b.status === 422, b);
    const c = await mcp("activity_log", rec);
    chk("W10c 좌표 없는 기록은 판정한다(대조) → 422", !c.ok && c.status === 422, c);
  }

  // ── W11 '-' 로 끝나는 실재 이름 ──
  {
    await seed("ws-trail-", CLEAN_TITLE, "옛 본문이다.");
    const r = await mcp("knowledge_save", { name: "ws-trail-", title: CLEAN_TITLE, body_md: "새 본문이다." });
    chk("W11 '-' 로 끝나는 실재 이름은 그 행을 고친다", r.ok && (await row("ws-trail-"))?.body_md === "새 본문이다.", r);
    chk("W11 꼬리를 뗀 새 행이 생기지 않는다", !(await row("ws-trail")), await row("ws-trail"));
  }

  // ── W12 NUL 이 섞인 이름 ──
  {
    const r = await mcp("knowledge_save", { name: "ws\u0000nul", title: CLEAN_TITLE, body_md: CLEAN_BODY, ...NEW });
    chk("W12 NUL 이 섞인 이름도 저장된다", r.ok, r);
    chk("W12 정규화한 이름(ws-nul)으로", !!(await row("ws-nul")), await row("ws-nul"));
  }

  // ── W13 형식이 꺼진 조직의 저장 1건 — 이름 해석 조회 수 ──
  {
    await updateRuntimeConfig({ writing_format: { enabled: false } }, "pgt", "test");
    await seed("ws-q1", CLEAN_TITLE, "옛 본문이다.");
    await seed("WS-Q2", CLEAN_TITLE, "옛 본문이다.");
    const realQuery = itemsPool.query;
    const RESOLVE_RE = /SELECT name FROM knowledge WHERE name = ANY\(\$1::text\[\]\)/;
    const count = async (name) => {
      const seen = [];
      itemsPool.query = (...args) => { seen.push(args); return realQuery(...args); };
      let r;
      try { r = await mcp("knowledge_save", { name, title: CLEAN_TITLE, body_md: "고친 본문이다." }); }
      finally { delete itemsPool.query; }
      const resolve = seen.filter(([sql, params]) => RESOLVE_RE.test(String(sql)) && Array.isArray(params?.[0]) && params[0].includes(name)).length;
      const format = seen.filter(([sql]) => /writing_format FROM org_runtime_config/.test(String(sql))).length;
      console.log(`info  W13 '${name}' 저장 1건의 조회 ${seen.length}번(이름 해석 ${resolve} · 서술 형식 ${format})`);
      return { ...r, resolve };
    };
    const q1 = await count("ws-q1");
    chk("W13a 정규형 이름 → 이름 해석 조회 0번", q1.ok && q1.resolve === 0, q1);
    const q2 = await count("WS-Q2");
    chk("W13b 정규형이 아닌 실재 이름 → 이름 해석 조회 1번", q2.ok && q2.resolve === 1, q2);
    chk("W13b 그 행을 고쳤다", (await row("WS-Q2"))?.body_md === "고친 본문이다." && !(await row("ws-q2")), await row("WS-Q2"));
  }
} catch (e) {
  fail++; console.error("FAIL (예외)", e);
} finally {
  if (server) server.close();
  await itemsPool.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end();
  rmSync(ROOT, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
