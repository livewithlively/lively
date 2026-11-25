// 조직 서술 형식(writing_format) PG 통합 시험 — **실제 Postgres 필요**(기본 npm test 체인 밖 · node scripts/run-tests.mjs --pg).
//    npm run build && ITEMS_DATABASE_URL=… node src/org/store/runtime-config-writing-format.pg-test.mjs
//
// 왜 이 계층인가(2026-10-14 리뷰 I · F · G · H): 세션 주입(previewMemberContext)은 섹션 · 위키 핀 · 카테고리 지도를 DB 에서 조립한다.
//  «형식을 켜지 않은 조직의 주입이 바이트 그대로인가» 는 그 조립 전체를 실제로 돌려야 잴 수 있다 — publish.ts 의 `if (writingBlock)` 를
//  지우면 꺼진 조직의 주입 끝에 빈 블록이 붙는데, 종전 시험은 그래도 통과했다. REST 저장 → DB 원본 → 캐시 무효화도 진짜 행으로 read-back 한다.
//
//  엣지 표(입력 조합 × 기대):
//   W1 | 꺼짐(기본) 주입                                  | 끝에 빈 블록이 없다 · 켠 주입에서 형식 블록 하나를 뺀 것과 바이트 동일(가드를 지우면 깨진다)
//   W2 | 켬 · apply_to=[]                                 | 꺼진 주입과 바이트 동일(G — 판정하지 않는 저장의 «거부» 를 예고하지 않는다)
//   W3 | 켬 · apply_to=[activity]                         | 블록이 실린다(세션은 작업기록도 쓴다)
//   W4 | REST apply_to:"knowledge" · forbid_terms:"X"     | 400 · DB 원본 그대로(F — 종전엔 200 으로 [] 가 저장됐다)
//   W5 | 캐시가 찬 뒤 REST 로 저장                          | 다음 getWritingFormat 이 곧바로 새 형식(H — TTL 동안 옛 값을 쥐지 않는다)
//   W6 | null 로 되돌림                                    | DB 원본 {} · 꺼짐
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const rc = await import(`${DIST}/org/store/runtime-config.js`);
const { previewMemberContext } = await import(`${DIST}/org/delivery/publish.js`);
const { buildWritingGuideBlock } = await import(`${DIST}/org/policies/writing-format.js`);
const { runtimeConfigCapabilities } = await import(`${DIST}/capabilities/delivery/runtime-config.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
const J = JSON.stringify;
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };

const ACTOR = "__wf_pg_actor";
const admin = { userId: ACTOR, email: "", scopes: ["admin"], projects: ["*"], tokenSource: "session" };
const upd = runtimeConfigCapabilities.find((c) => c.name === "org_runtime_update");
const save = (wf) => upd.handler({ writing_format: wf }, admin, { source: "web", actor: ACTOR });
const rawOf = async () => (await itemsPool.query(`SELECT writing_format FROM org_runtime_config WHERE id=1`)).rows[0]?.writing_format ?? null;
//  캐시가 없는 판(수정 전 코드)에서도 이 파일이 돈다 — 그 판엔 비울 캐시가 없다.
const forget = () => rc.invalidateWritingFormatCache?.();
//  끝에 반드시 되돌린다 — 같은 DB 를 다른 pg-test 와 나눠 쓴다.
const ORIGINAL = await rawOf();
const tail = (s) => J(s.slice(-60));

try {
  // W1 — 꺼진 주입의 바이트 동일성. 기준은 «켠 주입에서 형식 블록 하나를 뺀 것» 이다: 꺼진 조직에 빈 블록이 붙으면 두 쪽이 갈린다.
  await save(null);
  const off = await previewMemberContext("PG");
  chk("W1 꺼진 주입 끝에 빈 블록이 없다", !off.endsWith("\n\n"), tail(off));
  const GUIDE = "## 시험 가이드\n- 첫 줄에 결론을 쓴다.";
  await save({ enabled: true, apply_to: ["knowledge"], guide_md: GUIDE, rules: { local_path: "reject" } });
  const fmt = await rc.getWritingFormat();
  const block = buildWritingGuideBlock(fmt);
  chk("W1 전제: 켠 형식의 블록이 있다", fmt.enabled === true && block.startsWith("## 시험 가이드"), J(fmt));
  const on = await previewMemberContext("PG");
  chk("W1 켠 주입 = 꺼진 주입 + 형식 블록 하나(나머지는 바이트 동일)", on === `${off.slice(0, -1)}\n\n${block}\n`, `off…${tail(off)} on…${tail(on)}`);

  // W2 — 표면을 전부 끈 조직은 꺼진 조직과 같은 주입.
  await save({ apply_to: [] });
  const empty = await previewMemberContext("PG");
  chk("W2 켬 · apply_to=[] 주입은 꺼진 주입과 바이트 동일", empty === off, `off…${tail(off)} empty…${tail(empty)}`);

  // W3 — 작업기록만 켠 조직: 세션은 작업기록도 쓰므로 블록이 실린다.
  await save({ apply_to: ["activity"] });
  const act = await previewMemberContext("PG");
  chk("W3 켬 · apply_to=[activity] 주입엔 블록이 실린다", act.includes("## 시험 가이드") && act !== off, tail(act));

  // W4 — REST 입력 검사. 거절된 저장은 원본을 바꾸지 않는다.
  const before4 = await rawOf();
  for (const [label, wf] of [["apply_to 문자열", { apply_to: "knowledge" }], ["forbid_terms 문자열", { forbid_terms: "X" }]]) {
    const e = await errOf(save(wf));
    chk(`W4 ${label} → 400`, e?.status === 400, e ? `${e.status} ${e.message}` : `200 · 원본 ${J(await rawOf())}`);
  }
  chk("W4 거절된 저장은 DB 원본을 바꾸지 않는다", J(await rawOf()) === J(before4), `${J(before4)} → ${J(await rawOf())}`);

  // W5 — 캐시를 채운 뒤 저장하면 다음 조회가 곧바로 새 형식.
  await save({ enabled: false, apply_to: ["knowledge", "activity", "project"] });
  forget();
  const warm = await rc.getWritingFormat();
  chk("W5 전제: 꺼진 형식이 캐시에 들어 있다", warm.enabled === false, J(warm));
  await save({ enabled: true, rules: { local_path: "reject" } });
  const fresh = await rc.getWritingFormat();
  chk("W5 저장 직후 getWritingFormat 이 새 형식(TTL 을 기다리지 않는다)", fresh.enabled === true && fresh.rules.local_path === "reject", J(fresh));

  // W6 — null 은 원본을 비운다.
  await save(null);
  chk("W6 null 저장 → DB 원본 {}", J(await rawOf()) === "{}", J(await rawOf()));
  chk("W6 null 저장 → 꺼짐", (await rc.getWritingFormat()).enabled === false);
} catch (e) {
  bad("예외", e && e.stack ? e.stack : String(e));
} finally {
  try {
    await itemsPool.query(`UPDATE org_runtime_config SET writing_format=$1::jsonb WHERE id=1`, [J(ORIGINAL ?? {})]);
    await itemsPool.query(`DELETE FROM org_content_audit WHERE actor=$1`, [ACTOR]);
    forget();
  } catch (e) { bad("정리", String(e)); }
  await itemsPool.end().catch(() => undefined);
}
console.log(`runtime-config-writing-format(pg): ${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
