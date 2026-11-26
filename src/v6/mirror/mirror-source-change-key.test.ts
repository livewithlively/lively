// 자료 미러의 «내용 변경» 판정 — 슬랙 메시지의 표기 차이만 있는 재수집은 변경으로 세지 않는다.
//  updated_at 은 증류 재판정 신호라, 수집 API 마다 다른 멘션·이스케이프 표기가 '변경'으로 세지면 이미 처리한 자료가 다시 처리된다.
//  관측: 가짜 client 로 upsert SQL(RETURNING id)의 13번째 파라미터(인덱스 12)를 읽는다.
//  실행: npm run build && node dist/v6/mirror/mirror-source-change-key.test.js  (DB 불요)
import test from "node:test";
import assert from "node:assert/strict";
import { mirrorSourceV6 } from "./mirror-source.js";

type Row = { title: string; body: string };

async function changedFlag(system: string, existing: Row | null, next: Row, type = "message"): Promise<boolean> {
  let flag: unknown;
  let upserts = 0;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (/RETURNING id/.test(sql)) {
        upserts++;
        flag = params?.[12];
        return { rows: [{ id: 7 }] };
      }
      if (/SELECT\s+id,\s*title,\s*body_md\s+FROM\s+source/i.test(sql)) {
        return { rows: existing ? [{ id: 7, title: existing.title, body_md: existing.body }] : [] };
      }
      return { rows: [] };
    },
  };
  await mirrorSourceV6(client as never, {
    type,
    provenance: { category: "messenger", system, instance: "T1", external_id: "C1:1.0" },
    title: next.title,
    body: next.body,
  } as never, system, "C1:1.0");
  assert.equal(upserts, 1, "배선: upsert 가 한 번 나가야 한다");
  assert.equal(typeof flag, "boolean", `배선: 13번째 파라미터가 불리언이어야 한다 — ${String(flag)}`);
  return flag as boolean;
}

const BASE: Row = { title: "배포 공지", body: "오늘 배포합니다" };

test("S1 slack 표기 차이만 있으면 변경 아님 — 멘션·그룹·채널·이스케이프, 양방향", async () => {
  const pairs: Array<[string, string]> = [
    ["<@U123|alice> 확인 부탁", "<@U123> 확인 부탁"],
    ["<!subteam^S1|@dev> 공유", "<!subteam^S1> 공유"],
    ["<#C9|general> 에 올림", "<#C9> 에 올림"],
    ["A & B 비교 <b>", "A &amp; B 비교 &lt;b&gt;"],
    ["<https://example.com/?a=1&b=2|링크>", "<https://example.com/?a=1&amp;b=2|링크>"],
  ];
  for (const [a, b] of pairs) {
    for (const [oldText, newText] of [[a, b], [b, a]]) {
      assert.equal(
        await changedFlag("slack", { title: BASE.title, body: oldText }, { title: BASE.title, body: newText }),
        false,
        `본문 표기 차이가 변경으로 셈: ${oldText} → ${newText}`,
      );
    }
  }
});

test("S1 동일 글자 재수집은 변경 아님", async () => {
  assert.equal(await changedFlag("slack", BASE, { ...BASE }), false);
});

test("S2 slack 이어도 실제 글자가 바뀌면 변경 — 본문 단어·숫자·멘션 곁 문장", async () => {
  assert.equal(await changedFlag("slack", BASE, { title: BASE.title, body: "내일 배포합니다" }), true, "본문 단어");
  assert.equal(
    await changedFlag("slack", { title: BASE.title, body: "총 3건 처리" }, { title: BASE.title, body: "총 4건 처리" }),
    true,
    "숫자",
  );
  assert.equal(
    await changedFlag("slack", { title: BASE.title, body: "<@U123|alice> 확인 부탁" }, { title: BASE.title, body: "<@U123> 확인 완료" }),
    true,
    "멘션 표기 차이가 있어도 문장이 바뀜",
  );
});

test("S3 slack 링크 표시 문자열이 바뀌면 변경 — 링크 라벨은 접지 않는다", async () => {
  assert.equal(
    await changedFlag(
      "slack",
      { title: BASE.title, body: "<https://example.com/a|이전 문서>" },
      { title: BASE.title, body: "<https://example.com/a|새 문서>" },
    ),
    true,
  );
});

test("S4 slack 이 아닌 출처는 글자 그대로 비교 — & 대 &amp; 도 변경", async () => {
  assert.equal(
    await changedFlag("gmail", { title: BASE.title, body: "A & B" }, { title: BASE.title, body: "A &amp; B" }),
    true,
    "본문",
  );
  assert.equal(
    await changedFlag("gmail", { title: "A & B", body: BASE.body }, { title: "A &amp; B", body: BASE.body }),
    true,
    "제목",
  );
  assert.equal(
    await changedFlag("gmail", { title: BASE.title, body: "<@U123|alice> 안녕" }, { title: BASE.title, body: "<@U123> 안녕" }),
    true,
    "멘션 꼴도 접지 않음",
  );
  assert.equal(await changedFlag("gmail", BASE, { ...BASE }), false, "같은 글자는 변경 아님");
});

test("S5 기존 행이 없으면 새 자료라 변경", async () => {
  assert.equal(await changedFlag("slack", null, BASE), true);
  assert.equal(await changedFlag("gmail", null, BASE), true);
});

test("S6 표기 차이와 실제 문장 변경이 함께 있으면 변경", async () => {
  assert.equal(
    await changedFlag(
      "slack",
      { title: BASE.title, body: "<@U123|alice> A & B 는 오늘" },
      { title: BASE.title, body: "<@U123> A &amp; B 는 내일" },
    ),
    true,
  );
});

test("S7 slack 메시지 제목은 본문에서 잘라 만든 값이라 자른 자리만 다르면 변경 아님 — 첫 줄이 바뀌면 변경", async () => {
  // 슬랙 메시지 제목은 본문 첫 줄을 80자에서 자른 값(79자 + …)이다. 표기가 길면 같은 메시지가 더 앞에서 잘리거나 혼자만 잘린다.
  const derive = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s);
  const pair = (oldBody: string, newBody: string) =>
    changedFlag("slack", { title: derive(oldBody), body: oldBody }, { title: derive(newBody), body: newBody });
  const tail = (n: number) => "가".repeat(n);
  assert.equal(await pair(`<@U123|alice-in-wonderland> ${tail(100)}`, `<@U123> ${tail(100)}`), false, "둘 다 잘림");
  assert.equal(await pair(`<@U123|alice-in-wonderland> ${tail(65)}`, `<@U123> ${tail(65)}`), false, "한쪽만 잘림");
  assert.equal(await pair(`${tail(70)} <@U123|alice> 확인`, `${tail(70)} <@U123> 확인`), false, "멘션 라벨 안에서 잘림");
  assert.equal(await pair(`${tail(74)} A &amp; B`, `${tail(74)} A & B`), false, "이스케이프 안에서 잘림");
  assert.equal(await pair(`<@U123> 가${tail(99)}`, `<@U123> 나${tail(99)}`), true, "첫 줄 앞부분이 실제로 바뀜");
});

test("S8 접지 않는 특수 토큰 — 채널 전체 알림과 메일 링크의 라벨", async () => {
  assert.equal(
    await changedFlag("slack", { title: BASE.title, body: "<!here> 공지" }, { title: BASE.title, body: "<!channel> 공지" }),
    true,
    "알림 대상이 바뀜",
  );
  assert.equal(
    await changedFlag(
      "slack",
      { title: BASE.title, body: "<mailto:a@example.com|담당 A>" },
      { title: BASE.title, body: "<mailto:a@example.com|담당 B>" },
    ),
    true,
    "메일 링크 라벨이 바뀜",
  );
});

test("S9 제목이 따로 있는 slack 파일(note)은 글자 그대로 비교 — 제목만·이스케이프도 변경", async () => {
  assert.equal(
    await changedFlag("slack", { title: "보고서…", body: "[BINARY] a.pdf" }, { title: "보고서 최종…", body: "[BINARY] a.pdf" }, "note"),
    true,
    "제목만",
  );
  assert.equal(
    await changedFlag("slack", { title: "a.txt", body: "A &amp; B" }, { title: "a.txt", body: "A & B" }, "note"),
    true,
    "본문 이스케이프",
  );
  assert.equal(
    await changedFlag("slack", { title: "a.txt", body: "<@U123|alice> 안녕" }, { title: "a.txt", body: "<@U123> 안녕" }, "note"),
    true,
    "멘션 꼴",
  );
});
