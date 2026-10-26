// Postgres 가 못 받는 글자(NUL · 외톨이 서로게이트) 걷기 — 자료·지식 미러 (#5040, 셀프호스트 실측 2026-10-27)
//
//  신고: 슬랙 공개채널 첫 수집 4.5만 건 중 한 건의 본문에 NUL(U+0000)이 있었다. source 적재가 «invalid byte sequence
//   for encoding "UTF8": 0x00» 으로 실패 → mirrorFailures 1 → 커서 미전진 → 다음 run 도 전량을 다시 읽고 같은 자리에서
//   실패 → 다섯 번이면 서킷 브레이커가 수집기를 끈다. 글자 하나 때문에 수집 전체가 멈춘다.
//  사양:
//   P1 NUL 은 지운다 · P2 문제없는 글은 그대로 · P3·P4 짝 없는 서로게이트(앞·뒤)는 U+FFFD · P5 짝 맞는 이모지는 그대로 ·
//   P6 객체·배열 안 모든 글과 키 · 수·불·null 은 그대로 · P7 빈 글.
//   W1 자료 미러가 실제로 DB 에 보내는 값(제목·본문·raw·fields)에 NUL·외톨이 서로게이트가 없다(가짜 클라이언트로 관측).
//  실행: npm run build && node dist/v6/mirror/pg-text.test.js  (DB 불요)
import test from "node:test";
import assert from "node:assert/strict";
import { pgDeep, pgText } from "./mirror-common.js";
import { mirrorSourceV6 } from "./mirror-source.js";

const LONE_HIGH = "\uD83D";
const LONE_LOW = "\uDE00";
const PAIR = "😀"; // 😀

test("P1·P2·P7 NUL 은 지우고 멀쩡한 글은 그대로", () => {
  assert.equal(pgText("배포\u0000 원인"), "배포 원인");
  assert.equal(pgText("\u0000\u0000"), "");
  assert.equal(pgText("그대로 둔다 — abc 123"), "그대로 둔다 — abc 123");
  assert.equal(pgText(""), "");
});

test("P3·P4·P5 짝 없는 서로게이트만 U+FFFD — 짝 맞는 이모지는 그대로", () => {
  assert.equal(pgText(`끝${LONE_HIGH}`), "끝�");
  assert.equal(pgText(`${LONE_LOW}앞`), "�앞");
  assert.equal(pgText(`웃음 ${PAIR} 끝`), `웃음 ${PAIR} 끝`);
  assert.equal(pgText(`${PAIR}${LONE_HIGH}`), `${PAIR}�`);
});

test("P6 객체·배열 안의 글과 키까지 · 다른 값은 그대로", () => {
  const got = pgDeep({ "k\u0000": "v\u0000", n: 3, b: true, z: null, arr: ["a\u0000", { deep: `x${LONE_LOW}` }] });
  assert.deepEqual(got, { k: "v", n: 3, b: true, z: null, arr: ["a", { deep: "x�" }] });
  assert.ok(!JSON.stringify(got).includes("\\u0000"), "jsonb 가 거부하는 이스케이프가 남았다");
});

test("W1 자료 미러가 DB 로 보내는 값에 NUL·외톨이 서로게이트가 없다", async () => {
  const sent: unknown[][] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (params) sent.push(params);
      return /RETURNING id/.test(sql) ? { rows: [{ id: 1 }] } : { rows: [] };
    },
  };
  const ok = await mirrorSourceV6(client as never, {
    type: "message",
    provenance: { category: "messenger", system: "slack", instance: "T1", external_id: "C1:1.0" },
    title: `제목\u0000${LONE_HIGH}`,
    body: "본문\u0000에 NUL",
    container_name: "1_공지\u0000",
    actor: { external_id: "U1", display_name: "앨리스\u0000" },
    fields: { note: `메모${LONE_LOW}`, "키\u0000": 1 },
    raw: { text: "원문\u0000", blocks: [{ t: `조각${LONE_HIGH}` }] },
  } as never, "slack", "C1:1.0");
  assert.equal(ok, true);
  const insert = sent.find((p) => p.length >= 12);
  assert.ok(insert, `배선: INSERT 파라미터를 못 봤다(${sent.length}회 호출)`);
  const flat = JSON.stringify(insert);
  assert.ok(flat.includes("본문에 NUL") && flat.includes("1_공지"), `배선: 본문·채널이 실렸다 — ${flat.slice(0, 200)}`);
  assert.ok(!flat.includes("\\u0000"), `NUL 이 DB 로 갔다: ${flat}`);
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const p of insert!) {
    if (typeof p !== "string") continue;
    assert.ok(!p.includes("\u0000"), `NUL 이 DB 로 갔다: ${p.slice(0, 120)}`);
    assert.ok(!LONE.test(p), `외톨이 서로게이트가 text 칸으로 갔다: ${p.slice(0, 120)}`);
    //  jsonb 칸(raw·fields)은 JSON 글 — 외톨이는 «\ud83d» 같은 이스케이프로 실려 jsonb 가 거부한다.
    if (p.startsWith("{") || p.startsWith("[")) {
      assert.ok(!/\\ud[89a-f][0-9a-f]{2}/i.test(p), `jsonb 가 거부하는 외톨이 이스케이프: ${p.slice(0, 160)}`);
      JSON.parse(p);
    }
  }
});
