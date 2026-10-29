// 화면 글 영어 보기(#5141) — 서버 쪽 엣지 표 E1~E14. 가짜 모델로. 실행: npm run build && node dist/ui-translate/translate.test.js
//  이게 틀리면: 같은 글로 모델을 거듭 불러 키를 태우거나, 답 자리가 어긋나 엉뚱한 버튼에 엉뚱한 영어가 붙거나, 모델 실패가 화면 전체를 깬다.
import assert from "node:assert/strict";
import {
  MAX_TEXTS, MAX_TEXT_CHARS, MAX_TOTAL_CHARS, NoApiKeyError, TranslateCache, needsTranslation, parseReply, systemPrompt,
  translateTexts, validateTexts, type TranslateDeps,
} from "./translate.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };

type Call = { prompt: string };
function fakeDeps(reply: (texts: string[]) => { ok: boolean; text: string; error: string | null }, key: string | null = "sk-test") {
  const calls: Call[] = [];
  let keyLookups = 0;
  const d: TranslateDeps = {
    apiKey: async () => { keyLookups++; return key; },
    workspaceId: async () => null,
    call: async (_k, i) => { calls.push({ prompt: i.prompt }); return reply(JSON.parse(i.prompt) as string[]); },
    cache: new TranslateCache(),
    model: () => "m",
  };
  return { d, calls, keyLookups: () => keyLookups };
}
const echoEn = (texts: string[]) => ({ ok: true, text: JSON.stringify(texts.map((t) => `EN(${t})`)), error: null });
const sent = (c: Call[], i: number) => JSON.parse(c[i].prompt) as string[];

// E1 빈 배열 — 모델·키 0회
{
  const f = fakeDeps(echoEn);
  const r = await translateTexts([], "en", f.d);
  assert.deepEqual(r.translations, []);
  assert.equal(f.calls.length, 0);
  assert.equal(f.keyLookups(), 0);
  ok("E1 빈 입력은 아무것도 안 부른다");
}

// E2 한글 없는 글만 — 그대로, 키도 안 찾는다 (E9 의 짝)
{
  const f = fakeDeps(echoEn, null);
  const r = await translateTexts(["Home", "12", "⌘K"], "en", f.d);
  assert.deepEqual(r.translations, ["Home", "12", "⌘K"]);
  assert.equal(f.keyLookups(), 0);
  assert.equal(f.calls.length, 0);
  assert.equal(needsTranslation("ㄱ"), true, "자모만 있어도 한글");
  ok("E2 한글 없는 글은 그대로 · 키 없이도 된다");
}

// E3 섞임 — 영어 자리는 그대로, 한글만 한 번에
{
  const f = fakeDeps(echoEn);
  const r = await translateTexts(["Home", "세션", "12", "위키"], "en", f.d);
  assert.deepEqual(r.translations, ["Home", "EN(세션)", "12", "EN(위키)"]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(sent(f.calls, 0), ["세션", "위키"]);
  ok("E3 한글 글만 한 묶음으로 · 자리는 입력 차례 그대로");
}

// E4 같은 글 여러 자리 — 모델엔 한 번, 모든 자리 채움
{
  const f = fakeDeps(echoEn);
  const r = await translateTexts(["열기", "닫기", "열기", "열기"], "en", f.d);
  assert.deepEqual(r.translations, ["EN(열기)", "EN(닫기)", "EN(열기)", "EN(열기)"]);
  assert.deepEqual(sent(f.calls, 0), ["열기", "닫기"]);
  ok("E4 같은 글은 한 번만 보내고 모든 자리에 채운다");
}

// E5 두 번째 요청 — 기억에서
{
  const f = fakeDeps(echoEn);
  await translateTexts(["열기", "닫기"], "en", f.d);
  const r2 = await translateTexts(["닫기", "열기"], "en", f.d);
  assert.deepEqual(r2.translations, ["EN(닫기)", "EN(열기)"]);
  assert.equal(f.calls.length, 1);
  assert.equal(r2.cached, 2);
  ok("E5 두 번째 화면은 모델을 안 부른다");
}

// E6 모델 실패 — null + 까닭, 실패는 기억하지 않는다
{
  let fail = true;
  const f = fakeDeps((t) => (fail ? { ok: false, text: "", error: "overloaded_error: busy" } : echoEn(t)));
  const r = await translateTexts(["홈", "Home", "홈"], "en", f.d);
  assert.deepEqual(r.translations, [null, "Home", null]);
  assert.equal(r.failed, 1);
  assert.match(String(r.error), /overloaded/);
  fail = false;
  const r2 = await translateTexts(["홈"], "en", f.d);
  assert.deepEqual(r2.translations, ["EN(홈)"]);
  assert.equal(f.calls.length, 2, "실패 뒤에는 다시 부른다");
  ok("E6 모델 실패는 그 자리 null · 다음에 다시 시도");
}

// E7 답 길이 불일치 — 전부 null
{
  const f = fakeDeps(() => ({ ok: true, text: '["Only one"]', error: null }));
  const r = await translateTexts(["가", "나"], "en", f.d);
  assert.deepEqual(r.translations, [null, null]);
  assert.ok(r.error);
  assert.equal(parseReply('["A"]', 2), null);
  ok("E7 답이 입력과 길이가 다르면 어느 자리에도 안 붙인다");
}

// E8 답 한 자리만 빈 글 — 그 자리만 null
{
  const f = fakeDeps(() => ({ ok: true, text: '["Alpha", ""]', error: null }));
  const r = await translateTexts(["가", "나"], "en", f.d);
  assert.deepEqual(r.translations, ["Alpha", null]);
  assert.equal(r.translated, 1);
  assert.equal(r.failed, 1);
  ok("E8 빈 답 자리만 null");
}

// E9 키 없음 + 한글 — NoApiKeyError
{
  const f = fakeDeps(echoEn, null);
  await assert.rejects(() => translateTexts(["홈"], "en", f.d), NoApiKeyError);
  assert.equal(f.calls.length, 0);
  ok("E9 번역할 글이 있는데 키가 없으면 사람이 읽을 오류");
}

// E10~E12 입력 경계
{
  assert.ok("texts" in validateTexts(new Array(MAX_TEXTS).fill("가")), "120개 정확히 = 허용");
  assert.ok("error" in validateTexts(new Array(MAX_TEXTS + 1).fill("가")), "121개 = 거절");
  assert.ok("texts" in validateTexts(["가".repeat(MAX_TEXT_CHARS)]), "2000자 정확히 = 허용");
  assert.ok("error" in validateTexts(["가".repeat(MAX_TEXT_CHARS + 1)]), "2001자 = 거절");
  const n = 12, per = MAX_TOTAL_CHARS / n;   // 2000 × 12 = 24000
  assert.ok("texts" in validateTexts(new Array(n).fill("가".repeat(per))), "합 24000 정확히 = 허용");
  assert.ok("error" in validateTexts([...new Array(n).fill("가".repeat(per)), "가"]), "합 24001 = 거절");
  assert.ok("error" in validateTexts("x"), "배열이 아니면 거절");
  assert.deepEqual(validateTexts(["가", 3]), { texts: ["가", ""] }, "글이 아닌 자리는 빈 글");
  ok("E10~E12 개수 · 글 길이 · 합 — 경계값은 허용, 하나 넘으면 거절");
}

// E13 기억 상한 — 오래 안 쓴 것부터
{
  const c = new TranslateCache(2);
  c.set("en", "a", "A"); c.set("en", "b", "B"); c.get("en", "a"); c.set("en", "c", "C");
  assert.equal(c.size, 2);
  assert.equal(c.get("en", "b"), undefined);
  assert.equal(c.get("en", "a"), "A");
  assert.equal(c.get("en", "c"), "C");
  ok("E13 기억은 상한에서 오래 안 쓴 것부터 버린다");
}

// E14 답 모양 — 코드 울타리 · 앞뒤 말 · 깨진 JSON
{
  assert.deepEqual(parseReply('```json\n["Home","Wiki"]\n```', 2), ["Home", "Wiki"]);
  assert.deepEqual(parseReply('Here: ["A"] done', 1), ["A"]);
  assert.equal(parseReply("no json", 1), null);
  assert.equal(parseReply("[1,2", 2), null);
  assert.match(systemPrompt("en"), /지식=knowledge/, "용어표가 지시에 들어간다");
  ok("E14 답 앞뒤에 말이 붙어도 배열을 읽는다");
}

console.log(`\n${pass} passed`);
