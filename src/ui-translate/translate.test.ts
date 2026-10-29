// 화면 글 영어 보기(#5141) — 서버 쪽 엣지 표 E1~E23. 가짜 모델로. 실행: npm run build && node dist/ui-translate/translate.test.js
//  이게 틀리면: 같은 글로 모델을 거듭 불러 키를 태우거나, 답 자리가 어긋나 엉뚱한 버튼에 엉뚱한 영어가 붙거나, 모델 실패가 화면 전체를 깬다.
import assert from "node:assert/strict";
import {
  MAX_TEXTS, MAX_TEXT_CHARS, MAX_TOTAL_CHARS, NoApiKeyError, SPLIT_CALLS_MAX, TranslateCache, needsTranslation, parseReply, systemPrompt,
  translateTexts, validateTexts, type TranslateDeps,
} from "./translate.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };

type Call = { prompt: string; maxTokens: number; thinking?: unknown };
type Reply = { ok: boolean; text: string; error: string | null; stopReason?: string | null };
function fakeDeps(reply: (texts: string[]) => Reply, key: string | null = "sk-test") {
  const calls: Call[] = [];
  const scope = { v: "t1" };
  const model = { v: "claude-haiku-5-5" };
  let keyLookups = 0;
  const d: TranslateDeps = {
    apiKey: async () => { keyLookups++; return key; },
    workspaceId: async () => null,
    call: async (_k, i) => { calls.push({ prompt: i.prompt, maxTokens: i.maxTokens, thinking: i.thinking }); return reply(JSON.parse(i.prompt) as string[]); },
    cache: new TranslateCache(),
    model: () => model.v,
    scope: () => scope.v,
  };
  return { d, calls, keyLookups: () => keyLookups, scope, model };
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

// E7 답 길이 불일치 — 쪼개 다시 물어도 계속 어긋나면 전부 null
{
  const f = fakeDeps((t) => ({ ok: true, text: JSON.stringify([...t, "extra"]), error: null }));
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

// E15 기억은 테넌트마다 따로 — 한쪽이 받은 번역을 다른 테넌트에 내주지 않는다
{
  const f = fakeDeps(echoEn);
  await translateTexts(["삭제"], "en", f.d);
  f.scope.v = "t2";
  const r = await translateTexts(["삭제"], "en", f.d);
  assert.equal(r.cached, 0, "다른 테넌트는 기억을 못 본다");
  assert.equal(f.calls.length, 2);
  f.scope.v = "t1";
  const r1 = await translateTexts(["삭제"], "en", f.d);
  assert.equal(r1.cached, 1, "같은 테넌트는 기억에서");
  ok("E15 번역 기억은 테넌트마다 따로");
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

// E16 모델이 「」 를 곧은 따옴표로 바꾸고 이스케이프를 빠뜨린 답 — 고쳐 읽는다(실측: 매니지드에서 긴 본문 묶음이 통째로 실패했다)
{
  assert.deepEqual(parseReply('["Hyperspell ("Your Company Brain", closed)", "B"]', 2), ['Hyperspell ("Your Company Brain", closed)', "B"]);
  assert.deepEqual(parseReply('[""What makes you different" is the core", "x"]', 2), ['"What makes you different" is the core', "x"]);
  assert.deepEqual(parseReply('["say "hi" now"]', 1), ['say "hi" now']);
  assert.deepEqual(parseReply('["line1\nline2"]', 1), ["line1\nline2"], "문자열 안 날 줄바꿈도 읽는다");
  ok("E16 이스케이프 빠진 따옴표 · 날 줄바꿈을 고쳐 읽는다");
}

// E17 멀쩡한 답은 고치지 않는다 — 이스케이프된 따옴표 · 역슬래시 그대로
{
  assert.deepEqual(parseReply(JSON.stringify(['a "b" c', "d\\e", "f]g"]), 3), ['a "b" c', "d\\e", "f]g"]);
  ok("E17 올바른 JSON 은 그대로 읽는다");
}

// E18 한 글이 묶음 답을 깨면 — 반씩 쪼개 다시 물어 나머지는 살린다
{
  const bad = "독";
  const f = fakeDeps((t) => (t.includes(bad) && t.length > 1 ? { ok: true, text: "[broken", error: null } : echoEn(t)));
  const r = await translateTexts(["가", "나", "독", "라"], "en", f.d);
  assert.deepEqual(r.translations, ["EN(가)", "EN(나)", "EN(독)", "EN(라)"]);
  assert.equal(r.failed, 0);
  assert.equal(r.error, undefined);
  assert.ok(f.calls.length <= SPLIT_CALLS_MAX);
  ok("E18 깨진 묶음은 반씩 쪼개 다시 묻는다");
}

// E19 답이 max_tokens 로 잘렸으면 — 읽혀도 믿지 않고 쪼갠다
{
  let first = true;
  const f = fakeDeps((t) => { if (first) { first = false; return { ok: true, text: JSON.stringify(t.map(() => "x")), error: null, stopReason: "max_tokens" }; } return echoEn(t); });
  const r = await translateTexts(["가", "나"], "en", f.d);
  assert.deepEqual(r.translations, ["EN(가)", "EN(나)"]);
  ok("E19 잘린 답은 버리고 쪼개 다시 묻는다");
}

// E20 늘 깨진 답 — 부르는 횟수는 상한까지만, 전부 null
{
  const f = fakeDeps(() => ({ ok: true, text: "nope", error: null }));
  const r = await translateTexts(Array.from({ length: 40 }, (_, i) => "가" + i), "en", f.d);
  assert.equal(f.calls.length, SPLIT_CALLS_MAX);
  assert.equal(r.failed, 40);
  assert.ok(r.error);
  ok("E20 쪼개기는 상한까지만 — 키를 태우지 않는다");
}

// E21 호출 자체가 실패(과부하 등) — 쪼개지 않는다(같은 오류를 여러 번 부를 뿐)
{
  const f = fakeDeps(() => ({ ok: false, text: "", error: "overloaded_error: busy" }));
  const r = await translateTexts(["가", "나", "다"], "en", f.d);
  assert.equal(f.calls.length, 1);
  assert.match(String(r.error), /overloaded/);
  assert.match(systemPrompt("en"), /straight double quote/, "지시가 곧은 따옴표를 막는다");
  ok("E21 호출 실패는 쪼개지 않는다");
}

// E22 실측 원답 그대로 — 닫는 곧은 따옴표 없이 “ ” 로 끝난 문자열(매니지드 · claude-haiku-5-5)
{
  const raw = '[": 「A system that pulls knowledge out of all these fragmented sources. It\'s a living map of how a company works」 → Nearly the same sentence as “context store + team AI setup.”]';
  assert.deepEqual(parseReply(raw, 1), [": 「A system that pulls knowledge out of all these fragmented sources. It's a living map of how a company works」 → Nearly the same sentence as “context store + team AI setup.”"]);
  ok("E22 닫는 따옴표가 빠진 마지막 글도 읽는다");
}

// E23 Haiku 는 생각을 끄고, 토큰 상한은 생각 몫까지 넉넉히(짧은 글에 512 를 줬더니 숨은 생각 823 토큰에 잘렸다)
{
  const f = fakeDeps(echoEn);
  await translateTexts(["가"], "en", f.d);
  assert.deepEqual(f.calls[0].thinking, { type: "disabled" });
  assert.ok(f.calls[0].maxTokens >= 2048, `짧은 글도 바닥 2048 — 받은 값 ${f.calls[0].maxTokens}`);
  f.model.v = "claude-opus-5-5";
  await translateTexts(["나"], "en", f.d);
  assert.equal(f.calls[1].thinking, undefined, "생각을 끌 수 없는 모델엔 보내지 않는다(400)");
  ok("E23 Haiku 는 생각 끔 · 토큰 바닥 2048");
}

console.log(`\n${pass} passed`);
