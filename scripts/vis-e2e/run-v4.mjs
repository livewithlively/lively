// #1291 v4 e2e — 커넥터별 자료 공개범위 정책 + 증류 지식의 상속.
//
//  자료의 생산자는 사람이 아니라 커넥터라 개별 잠금이 현실적이지 않다(슬랙만 1만건 규모) → 생산 지점에 정책을
//  걸고, 그 자료에서 증류된 지식은 원본의 공개범위를 물려받는다.
//
//  여기서 보는 것: ①대상 없는 잠금은 거절 ②채널 규칙이 커넥터 규칙을 이긴다 ③백필이 과거분을 실제로 맞춘다
//                ④증류 지식이 원본 대상을 물려받는다 ⑤cites 는 안 물려받는다 ⑥비-admin 은 정책을 못 만진다
const BASE = process.env.BASE || "http://127.0.0.1:8099";
const SEED = JSON.parse(process.env.SEED || "{}");
const TOK = SEED.tokens || {};
let pass = 0, fail = 0;
const chk = (n, c, why) => c ? (pass++, console.log(`ok   ${n}`)) : (fail++, console.log(`FAIL ${n} — ${why ?? ""}`));

async function rest(who, path, init = {}) {
  const r = await fetch(`${BASE}${path}`, { ...init,
    headers: { authorization: `Bearer ${TOK[who]}`, "content-type": "application/json", ...(init.headers || {}) } });
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
}
async function mcp(who, tool, args = {}) {
  const r = await fetch(`${BASE}/mcp`, { method: "POST",
    headers: { authorization: `Bearer ${TOK[who]}`, "content-type": "application/json",
      accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) });
  const t = await r.text();
  const line = t.startsWith("event:") || t.startsWith("data:")
    ? t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("") : t;
  let d = null; try { d = JSON.parse(line); } catch { return { isError: true, raw: t.slice(0, 200) }; }
  const c = d?.result?.content?.[0]?.text;
  let payload = null; try { payload = c ? JSON.parse(c) : null; } catch { payload = c; }
  return { isError: !!d?.result?.isError, payload };
}
const setRule = (b) => rest("admin", "/api/ui/source-vis-policy", { method: "POST", body: JSON.stringify(b) });
const backfill = (b) => rest("admin", "/api/ui/source-vis-policy/backfill", { method: "POST", body: JSON.stringify(b || {}) });
/** 이 사람에게 그 자료가 보이나. */
const seesSrc = async (who, id) => { const r = await mcp(who, "source_get", { id }); return !r.isError && !!r.payload; };
/** 이 사람에게 그 지식이 보이나. */
const seesKn = async (who, name) => !(await mcp(who, "knowledge_get", { name })).isError;

(async () => {
  const engId = SEED.v4SrcEngId, genId = SEED.v4SrcGenId;

  // ── 배선: 이게 없으면 아래 "안 보인다" 단언이 전부 공허하게 통과한다(v1·v3 에서 실제로 그랬다) ──
  const me = await rest("in", "/api/ui/me");
  chk("[배선] 토큰 유효", me.status === 200 && !!me.body?.userId, `status=${me.status}`);
  chk("[배선] 자료 축이 켜져 있다", me.body?.vis_axes?.source === true, JSON.stringify(me.body?.vis_axes));
  chk("[배선] 시드 자료가 있다", !!engId && !!genId, `eng=${engId} gen=${genId}`);
  chk("[배선] 잠그기 전엔 둘 다 누구에게나 보인다",
    (await seesSrc("out", engId)) && (await seesSrc("out", genId)));

  // ── ① 대상 없이 잠그면 거절 — 아무도 못 보는 자료를 실수로 만들지 않게 ──
  const noAud = await setRule({ match_system: "slack", visibility: "members", members: [] });
  chk("★ 대상 없이 잠그는 규칙은 거절", noAud.status === 400, `status=${noAud.status}`);

  // ── ② 커넥터 전체 규칙 + 채널 오버라이드(좁은 것이 이긴다) ──
  const r1 = await setRule({ match_system: "slack", visibility: "members", members: [{ member_id: "vis_in" }] });
  chk("커넥터 전체 규칙 저장", r1.status === 200 && !!r1.body?.id, `status=${r1.status} ${JSON.stringify(r1.body)?.slice(0, 120)}`);
  const r2 = await setRule({ match_system: "slack", match_channel: "eng-only", visibility: "members",
    members: [{ member_id: "vis_out" }], priority: 10 });
  chk("채널 규칙 저장", r2.status === 200 && !!r2.body?.id, `status=${r2.status}`);

  // ── ③ 백필: 기본은 미리보기, 실제 적용은 명시적으로만 ──
  const dry = await backfill({});
  chk("★ 백필 기본은 미리보기(dry_run)", dry.status === 200 && dry.body?.dry_run === true,
    `status=${dry.status} ${JSON.stringify(dry.body)?.slice(0, 140)}`);
  chk("  미리보기는 실제로 안 잠근다", await seesSrc("out", genId), "미리보기인데 이미 잠겼다");
  chk("  무엇이 몇 건 바뀔지 알려준다", (dry.body?.locked ?? 0) >= 2, JSON.stringify(dry.body)?.slice(0, 160));

  const real = await backfill({ dry_run: false });
  chk("★ 실제 적용", real.status === 200 && real.body?.dry_run === false && (real.body?.locked ?? 0) >= 2,
    JSON.stringify(real.body)?.slice(0, 160));

  // ── ②-검증: 채널 규칙이 이겼는지 = eng 는 vis_out 만, gen 은 vis_in 만 ──
  const engOut = await seesSrc("out", engId), engIn = await seesSrc("in", engId);
  chk("★ 채널 규칙이 커넥터 규칙을 이긴다(eng → vis_out 만)", engOut && !engIn, `out=${engOut} in=${engIn}`);
  const genIn = await seesSrc("in", genId), genOut = await seesSrc("out", genId);
  chk("★ 채널 규칙 없는 자료는 커넥터 규칙을 따른다(gen → vis_in 만)", genIn && !genOut, `in=${genIn} out=${genOut}`);

  // ── ④ 증류 상속: 잠긴 자료에서 나온 지식은 그 대상만 본다 ──
  const kName = "v4-derived-src";
  const kn = await mcp("admin", "knowledge_save", {
    name: kName, title: "V4 증류물", body_md: "eng 채널 원문에서 증류",
    category: "canonical-context-store", type: "reference" });
  chk("[준비] 지식 생성", !kn.isError, JSON.stringify(kn.payload)?.slice(0, 160));
  chk("  증류 전엔 누구에게나 보인다", await seesKn("in", kName));

  const link = await mcp("admin", "source_link_knowledge", { name: kName, source_id: engId, relation: "derived_from" });
  chk("[준비] derived_from 링크", !link.isError, JSON.stringify(link.payload)?.slice(0, 160));

  const kOut = await seesKn("out", kName), kIn = await seesKn("in", kName);
  chk("★ 증류 지식이 원본 대상을 물려받는다(eng 대상인 vis_out 만 본다)", kOut && !kIn, `out=${kOut} in=${kIn}`);

  // ── ⑤ cites 는 안 물려받는다 — 인용했다는 이유로 공개 지식이 잠기면 사고다 ──
  const kName2 = "v4-cited-src";
  await mcp("admin", "knowledge_save", { name: kName2, title: "V4 인용물", body_md: "참조만",
    category: "canonical-context-store", type: "reference" });
  await mcp("admin", "source_link_knowledge", { name: kName2, source_id: engId, relation: "cites" });
  chk("★ cites 는 상속하지 않는다(공개 지식이 링크 하나로 잠기지 않게)", await seesKn("in", kName2));

  // ── ⑥ 권한 ──
  const notAdmin = await rest("out", "/api/ui/source-vis-policy", { method: "POST",
    body: JSON.stringify({ match_system: "slack", visibility: "open" }) });
  chk("★ 비-admin 은 정책을 못 만진다", notAdmin.status === 403 || notAdmin.status === 401, `status=${notAdmin.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("e2e 예외:", e?.stack || e); process.exit(1); });
