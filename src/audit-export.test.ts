// 감사로그 CSV 내보내기 테스트 (#1309). 사양·엣지 표 = 스크래치패드 spec.md 「입력 조합 × 기대」 24행.
//
//  회귀 대상 ①: **조건의 $n 과 실제 채우는 값의 개수가 어긋나는 것**(표 10·11). 어긋나면 postgres 가 던지는 곳은
//   "관리자가 감사 자료를 뽑으려고 버튼을 누른 순간"이다 — 그때까지 아무도 모른다. 감사 3종 모두 고정한다.
//  회귀 대상 ②: **감사 자료를 여는 행위가 코드 실행이 되는 것**(표 14). 셀에는 사람·에이전트가 넣은 문자열이
//   그대로 들어간다(도구 인자·실행 SQL·에러). 반대로 **숫자에 방어를 걸면 값이 손상된다**(-3 → '-3, 표 15) — 둘 다 단언한다.
//  회귀 대상 ③: **날짜를 골랐는데 상대 기간이 남아 빈 결과가 나오는 것**(표 2). 두 기간이 AND 로 겹치면
//   "6월 3일"을 지정했는데 최근 7일과 교집합이 되어 아무것도 안 나온다.
//  회귀 대상 ④: **분할 경계**(표 22·23). 딱 떨어질 때 빈 파일이 하나 더 생기거나, 1행 넘겼는데 파일이 안 늘면
//   "다 받았다"는 화면 문구가 거짓이 된다.
import assert from "node:assert/strict";
import { buildSpec, csvCell, csvLine, planParts, PART_ROWS } from "./audit-export-routes.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};

// 조건절이 참조하는 최대 $n. 채우는 값 개수와 같아야 한다(모자라면 "there is no parameter $n").
function maxPlaceholder(sql: string): number {
  let max = 0;
  for (const m of sql.matchAll(/\$(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max;
}
const KINDS = ["tools", "org", "db"];
const JUNE3 = "2026-06-03T00:00:00.000Z";
const JUNE3_END = "2026-06-03T23:59:59.999Z";

// ── 기간 해석 (표 1~7) ──
t("표1 상대 기간만 주면 그 기간이 걸린다", () => {
  assert.equal(buildSpec({ kind: "tools", window: "30d" }).params[0], "30 days");
});
t("표2 지정 날짜가 상대 기간을 이긴다 — 겹치면 빈 결과가 된다", () => {
  const spec = buildSpec({ kind: "tools", window: "7d", since: JUNE3 });
  assert.equal(spec.params[0], null, "상대 기간이 남아 있으면 지정 날짜와 AND 로 겹친다");
});
t("표3 시작일만 = 그날부터 지금까지", () => {
  const spec = buildSpec({ kind: "tools", since: JUNE3 });
  assert.deepEqual([spec.params[3], spec.params[4]], [JUNE3, null]);
});
t("표4 종료일만 = 처음부터 그날까지", () => {
  const spec = buildSpec({ kind: "tools", until: JUNE3_END });
  assert.deepEqual([spec.params[3], spec.params[4]], [null, JUNE3_END]);
  assert.equal(spec.params[0], null, "종료일만 줘도 상대 기간은 꺼진다");
});
t("표5 시작=종료 = 그 하루", () => {
  const spec = buildSpec({ kind: "tools", since: JUNE3, until: JUNE3_END });
  assert.deepEqual([spec.params[3], spec.params[4]], [JUNE3, JUNE3_END]);
});
t("표6 해석 못 하는 날짜는 거절한다 — 무시하면 필터 없는 전량이 나간다", () => {
  assert.throws(() => buildSpec({ kind: "tools", since: "어제" }), /ISO8601/);
  assert.throws(() => buildSpec({ kind: "db", until: "2026-13-99" }), /ISO8601/);
});
t("표7 모르는 상대 기간은 기본값으로 접는다(거절하면 화면이 멈춘다)", () => {
  assert.equal(buildSpec({ kind: "tools", window: "99y" }).params[0], "7 days");
});
// 날짜 필터는 감사 3종 모두에 걸려야 한다 — 한 탭만 되면 "기간 필터가 있다"는 말이 거짓이 된다.
for (const kind of KINDS) {
  t(`표3~5 ${kind}: 지정한 날짜가 실제로 조건에 실린다`, () => {
    const spec = buildSpec({ kind, since: JUNE3, until: JUNE3_END });
    assert.ok(spec.params.includes(JUNE3), `${kind}: 시작일이 조건에 없다`);
    assert.ok(spec.params.includes(JUNE3_END), `${kind}: 종료일이 조건에 없다`);
  });
}

// ── 대상·조건 (표 8~12) ──
t("표8 대상을 안 주면 화면 기본 탭과 같은 대상", () => {
  assert.equal(buildSpec({}).from, "mcp_call_log");
});
t("표9 모르는 대상은 거절한다 — 자료를 잘못 뽑는 것보다 낫다", () => {
  assert.throws(() => buildSpec({ kind: "secrets" }), /kind/);
  assert.throws(() => buildSpec({ kind: "db", op: "delete" }), /query\|schema/);
});
for (const kind of KINDS) {
  t(`표10 ${kind}: 조건의 $n 개수 = 채우는 값 개수`, () => {
    const spec = buildSpec({ kind });
    assert.equal(maxPlaceholder(spec.where), spec.params.length,
      `${kind}: $${maxPlaceholder(spec.where)} 까지 쓰는데 값은 ${spec.params.length}개`);
  });
  t(`표11 ${kind}: 모든 필터를 채워도 개수가 유지된다`, () => {
    const spec = buildSpec({
      kind, window: "30d", harness: "claude-code", tool: "knowledge_get", errors: "1",
      entity: "org_member", scope: "all", entity_key: "yoon", actor: "yoon", actor_kind: "human",
      channel: "web", op: "query", user: "yoon", source: "self", table: "Knowledge",
      since: JUNE3, until: JUNE3_END,
    });
    assert.equal(maxPlaceholder(spec.where), spec.params.length);
  });
  t(`표12 ${kind}: 내보낼 항목 수 = CSV 열 수`, () => {
    const spec = buildSpec({ kind });
    assert.equal(spec.select.split(",").length, spec.columns.length, `${kind}: 열이 밀린다`);
  });
}

// ── 셀 표현 (표 13~19) ──
t("표13 콤마·따옴표·줄바꿈은 한 칸으로 유지된다", () => {
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('he said "hi"'), '"he said ""hi"""');
  assert.equal(csvCell("두\n줄"), '"두\n줄"');
  assert.equal(csvCell("보통값"), "보통값");
});
t("표14 수식으로 읽힐 셀은 고정한다 — 파일을 여는 게 코드 실행이 되면 안 된다", () => {
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvCell("+7"), "'+7");
  assert.equal(csvCell("-2+3"), "'-2+3");
  assert.equal(csvCell("\tx"), "'\tx");
  assert.equal(csvCell("=CMD|'calc'!A,1"), `"'=CMD|'calc'!A,1"`, "고정한 뒤에도 CSV 규칙은 그대로 적용된다");
});
t("표15 숫자·참거짓은 원래 값 그대로 — 방어가 값을 바꾸면 자료 훼손", () => {
  assert.equal(csvCell(-3), "-3");
  assert.equal(csvCell(0), "0");
  assert.equal(csvCell(false), "false");
  assert.equal(csvCell(true), "true");
});
t("표16 값이 없으면 빈 칸", () => {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
});
t("표17 객체는 JSON, 시각은 ISO", () => {
  assert.equal(csvCell({ a: 1 }), '"{""a"":1}"'); // JSON 은 따옴표를 품으므로 CSV 규칙대로 감싸진다
  assert.equal(csvCell(["x", "y"]), '"[""x"",""y""]"');
  assert.equal(csvCell(new Date("2026-06-03T01:02:03.000Z")), "2026-06-03T01:02:03.000Z");
});
t("표18 빈 문자열은 빈 칸 그대로(고정 표시가 붙지 않는다)", () => {
  assert.equal(csvCell(""), "");
});
t("표19 행은 열 순서대로만 나가고 없는 값은 빈 칸", () => {
  assert.equal(csvLine({ b: 2, a: 1 }, ["a", "b", "c"]), "1,2,\r\n");
});

// ── 분할 경계 (표 20~23) ──
t("표20 0행이면 파일이 없다", () => assert.equal(planParts(0), 0));
t("표21 1행이면 파일 1개", () => assert.equal(planParts(1), 1));
t("표22 정확히 한 파일 한도면 빈 파일을 덧붙이지 않는다", () => assert.equal(planParts(PART_ROWS), 1));
t("표23 한도를 1행이라도 넘으면 파일이 하나 늘어난다", () => assert.equal(planParts(PART_ROWS + 1), 2));

// ── 이름 (표 24) ──
t("표24 파일 이름에 뽑은 기간이 남는다", () => {
  assert.match(buildSpec({ kind: "tools", since: "2026-06-01T00:00:00.000Z", until: "2026-06-30T23:59:59.999Z" }).baseName,
    /2026-06-01_2026-06-30/);
  assert.match(buildSpec({ kind: "tools", window: "30d" }).baseName, /30d/);
});
t("표25 파일 이름의 날짜는 보는 사람 기준 — UTC 로 자르면 하루 어긋난다", () => {
  // 화면에서 KST 로 "7월 30일 하루"를 고르면 서버엔 UTC 7/29 15:00 ~ 7/30 14:59 로 온다.
  const spec = buildSpec({ kind: "tools", since: "2026-07-29T15:00:00.000Z", until: "2026-07-30T14:59:59.999Z" }, "Asia/Seoul");
  assert.match(spec.baseName, /2026-07-30_2026-07-30/, `고른 날짜와 다른 이름: ${spec.baseName}`);
  // 3종 모두 같은 규칙
  assert.match(buildSpec({ kind: "org", since: "2026-07-29T15:00:00.000Z" }, "Asia/Seoul").baseName, /2026-07-30/);
  assert.match(buildSpec({ kind: "db", since: "2026-07-29T15:00:00.000Z" }, "Asia/Seoul").baseName, /2026-07-30/);
});
t("모르는 시간대라도 내보내기가 죽지 않는다(라벨은 폴백)", () => {
  assert.ok(buildSpec({ kind: "tools", since: "2026-07-30T00:00:00.000Z" }, "Mars/Olympus").baseName.length > 0);
});

console.log(`\n${pass} passed`);
