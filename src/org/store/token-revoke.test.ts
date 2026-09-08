// 토큰 회수 핸들 분류(#2646) — 순수 판정 표 고정. **DB 를 안 본다.**
//
// 왜 이 단언들이 중요한가(2026-09-04 실측 사고):
//  관리자가 발급 응답의 `tokenHash` 를 회수 창구에 그대로 넣었고, 창구는 `{ok:true}` 를 돌려줬다.
//  **그런데 그 토큰은 살아 있었다** — 같은 토큰으로 API 가 200 을 냈고, 목록의 회수 시각은 비어 있었다.
//  자격증명 회수는 **틀렸을 때 알아차릴 계기가 없는 동작**이다(확인차 한 번 더 찔러보지 않으면 영영 모른다).
//  그래서 회수 경로의 첫 관문인 이 분류 함수는 **무엇이 들어와도 그 자체로 「회수했다」가 되지 않게** 갈라야 한다:
//   · 그대로 쓸 수 있는 전체 핸들(exact)  ↔  앞자리 조회로만 쓸 수 있는 값(prefix)  ↔  아예 받지 않는 값(invalid)
//  그리고 거절 사유 4개(empty·not-hex·too-short·too-long)를 **한 값으로 뭉개면 안 된다** — 사람이 할 다음 행동이
//  각각 다르기 때문이다(오타 고치기 / 전체 값 다시 복사 / 잘린 값 다시 받기).
//  사양·엣지 표: 6~12행(전체 길이 / 정규화 / 12자 / 11자 / 65자 / 빈 값 / 비-16진수).
//  실행: npm run build && node dist/org/store/token-revoke.test.js
import assert from "node:assert/strict";
import { classifyTokenHandle, TOKEN_HASH_LEN, MIN_HANDLE_LEN, type TokenHandle } from "./tokens.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// 64자 정상 핸들 — 16진수만 쓴다.
const H64 = "0123456789abcdef".repeat(4);

// 판정 갈래별 추출기. 갈래가 틀리면 여기서 먼저 죽어 '무엇으로 갈렸는지'를 메시지에 싣는다.
const exactOf = (h: TokenHandle, why: string): string => {
  assert.equal(h.kind, "exact", `${why} — exact 가 아니다: ${JSON.stringify(h)}`);
  return h.kind === "exact" ? h.tokenHash : "";
};
const prefixOf = (h: TokenHandle, why: string): string => {
  assert.equal(h.kind, "prefix", `${why} — prefix 가 아니다: ${JSON.stringify(h)}`);
  return h.kind === "prefix" ? h.prefix : "";
};
const reasonOf = (h: TokenHandle, why: string): string => {
  assert.equal(h.kind, "invalid", `${why} — 거절되지 않았다(회수 경로로 통과했다): ${JSON.stringify(h)}`);
  return h.kind === "invalid" ? h.reason : "";
};

// ── 상수 — 사양이 못박은 값. 조용히 바뀌면 사양이 깨진다. ─────────────────────────
t("A 상수 — 전체 핸들 64자·최소 앞자리 12자 (사양 C)", () => {
  assert.equal(TOKEN_HASH_LEN, 64, "전체 핸들 길이가 sha256 hex(64)가 아니다");
  assert.equal(MIN_HANDLE_LEN, 12, "최소 앞자리가 12자가 아니다 — 짧을수록 남의 토큰을 긁는다");
  assert.ok(MIN_HANDLE_LEN < TOKEN_HASH_LEN, "최소 앞자리가 전체 길이 이상이면 prefix 갈래가 사라진다");
});

// ── 엣지 6~12 — 행마다 하나 ────────────────────────────────────────────────────

t("6 전체 길이(64자) 핸들 → 그대로 쓴다(exact)", () => {
  assert.equal(exactOf(classifyTokenHandle(H64), "64자"), H64);
  // 길이가 TOKEN_HASH_LEN 일 때만 exact 다 — 63자는 아직 앞자리다(경계).
  assert.equal(prefixOf(classifyTokenHandle(H64.slice(0, TOKEN_HASH_LEN - 1)), "63자"), H64.slice(0, TOKEN_HASH_LEN - 1));
});

t("7 ★ 앞뒤 공백·대문자가 섞인 전체 길이 핸들 → 거절이 아니라 정규화해 받는다(화면에서 복사·붙여넣기)", () => {
  // 사람이 붙여넣는 값이다 — 공백과 대문자로 회수가 실패하면 사고 대응 중에 손이 묶인다.
  assert.equal(exactOf(classifyTokenHandle(`  ${H64.toUpperCase()}  `), "공백+대문자 64자"), H64);
  assert.equal(exactOf(classifyTokenHandle(`\t\n${H64}\n`), "탭·개행 감싼 64자"), H64);
  assert.equal(exactOf(classifyTokenHandle("0123456789ABCDEF".repeat(3) + "0123456789abcdef"), "대소문자 혼합 64자"), H64);
  // 정규화는 앞자리에도 똑같이 적용된다(같은 핸들이니 같은 규율).
  assert.equal(prefixOf(classifyTokenHandle(" 0123456789AB "), "공백+대문자 12자"), "0123456789ab");
});

t("8 12자 앞자리 → 앞자리 조회로 취급(prefix) — 최소 길이 경계 아래쪽", () => {
  const p12 = H64.slice(0, MIN_HANDLE_LEN);
  assert.equal(p12.length, 12);
  assert.equal(prefixOf(classifyTokenHandle(p12), "12자"), p12);
  // 12자와 64자 사이는 전부 prefix 다.
  assert.equal(prefixOf(classifyTokenHandle(H64.slice(0, 13)), "13자"), H64.slice(0, 13));
  assert.equal(prefixOf(classifyTokenHandle(H64.slice(0, 32)), "32자"), H64.slice(0, 32));
});

t("9 ★ 11자 앞자리 → 거절(too-short) — 한 자 모자라면 받지 않는다(오프바이원)", () => {
  const p11 = H64.slice(0, MIN_HANDLE_LEN - 1);
  assert.equal(p11.length, 11);
  assert.equal(reasonOf(classifyTokenHandle(p11), "11자"), "too-short");
  // 공백으로 길이를 채워 통과시킬 수 없다 — 정규화(trim)가 먼저고 판정이 나중이다.
  assert.equal(reasonOf(classifyTokenHandle(`  ${p11}  `), "공백 채운 11자"), "too-short");
  assert.equal(reasonOf(classifyTokenHandle("a"), "1자"), "too-short");
});

t("10 ★ 65자 → 거절(too-long) — 한 자 넘치면 받지 않는다(오프바이원)", () => {
  assert.equal(reasonOf(classifyTokenHandle(H64 + "a"), "65자"), "too-long");
  assert.equal(reasonOf(classifyTokenHandle(H64 + H64), "128자"), "too-long");
  // 넘치는 값은 잘라서 쓰지 않는다 — 자르면 남의 토큰에 걸릴 수 있다.
  assert.notEqual(reasonOf(classifyTokenHandle(H64 + "a"), "65자"), "not-hex");
});

t("11 빈 문자열·공백만 → 거절(empty)", () => {
  assert.equal(reasonOf(classifyTokenHandle(""), "빈 문자열"), "empty");
  assert.equal(reasonOf(classifyTokenHandle("   "), "공백만"), "empty");
  assert.equal(reasonOf(classifyTokenHandle("\t\n "), "탭·개행만"), "empty");
});

t("12 ★ 16진수가 아닌 값 → 거절(not-hex) — 평문 토큰을 회수 핸들 자리에 넣는 게 가장 흔한 오용", () => {
  // 평문 접속 토큰(lvk_…)을 그대로 넣는 경우. 이게 통과하면 '회수했다'는 거짓말이 시작된다.
  assert.equal(reasonOf(classifyTokenHandle("lvk_zZyYxXwW0123456789abcdef0123456789ab"), "lvk_ 평문 토큰"), "not-hex");
  // 길이는 정상 범위인데 문자가 16진수가 아닌 값들(길이 갈래와 섞이지 않게 12~64자로만 고른다).
  assert.equal(reasonOf(classifyTokenHandle("0123456789ab%cdef"), "% 포함"), "not-hex");
  assert.equal(reasonOf(classifyTokenHandle("0123456789ab_cdef"), "_ 포함"), "not-hex");
  assert.equal(reasonOf(classifyTokenHandle("g".repeat(TOKEN_HASH_LEN)), "64자 전부 비-16진수"), "not-hex");
  assert.equal(reasonOf(classifyTokenHandle("0x" + H64.slice(2)), "0x 접두 64자"), "not-hex");
  // 내부 공백은 trim 대상이 아니다 — 가운데가 끊긴 값은 붙여넣기 사고지 정상 핸들이 아니다.
  assert.equal(reasonOf(classifyTokenHandle(`${H64.slice(0, 32)} ${H64.slice(33)}`), "가운데 공백 64자"), "not-hex");
});

// ── 뭉개짐 방지 — 거절 사유 4개가 실제로 서로 다른 값으로 나온다 ─────────────────
// 전부 "invalid" 하나로 접히면 사람은 무엇을 고쳐야 하는지 모른 채 같은 값을 다시 넣는다.
t("Z 거절 사유 4개가 서로 다른 값으로 갈린다(사유를 한 값으로 뭉개면 안 된다)", () => {
  const seen = new Set([
    reasonOf(classifyTokenHandle(""), "empty 표본"),
    reasonOf(classifyTokenHandle("zzzzzzzzzzzzzz"), "not-hex 표본"),
    reasonOf(classifyTokenHandle("abc"), "too-short 표본"),
    reasonOf(classifyTokenHandle(H64 + "0"), "too-long 표본"),
  ]);
  assert.equal(seen.size, 4, `사유가 뭉개졌다: ${JSON.stringify([...seen])}`);
  // 정상 값은 어느 사유로도 새지 않는다(무회귀 기준선).
  assert.equal(classifyTokenHandle(H64).kind, "exact");
  assert.equal(classifyTokenHandle(H64.slice(0, MIN_HANDLE_LEN)).kind, "prefix");
});

console.log(`\n${pass} passed`);
