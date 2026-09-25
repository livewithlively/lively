// codex 훅 신뢰 표 — 값 표 (#4135 후속)
//
//  사양·엣지 표: 스크래치 spec-hooktrust.md. 행마다 시나리오 하나.
//  ★ 이 표가 지키는 경계는 하나다: **우리가 심은 훅만 신뢰한다.** 레포에 딸려온 훅까지 신뢰하면
//   «Hooks need review» 가 막으려는 바로 그 일을 우리가 대신 하는 것이 된다.
//  red 는 mutation 셋으로 눈으로 봤다(우리 훅 판정 무력화 · 멱등 제거 · 갱신 대신 덧붙이기).
import assert from "node:assert/strict";
import { planCodexHookTrustPatch, isOurHook, hookBlockFingerprint, type CodexHookRow } from "./codex-hook-trust.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const CFG = "/home/box_yoon/.codex/config.toml";
const H = (over: Partial<CodexHookRow> = {}): CodexHookRow => ({
  key: `${CFG}:session_start:0:0`,
  currentHash: `sha256:${"a".repeat(64)}`,
  sourcePath: CFG,
  command: 'env LIVELY_HARNESS=codex "node" "/home/box_yoon/.lively/hooks/session-preload.mjs"',
  trustStatus: "untrusted",
  ...over,
});
const txt = (p: ReturnType<typeof planCodexHookTrustPatch>): string => (p.write ? p.text : "");

t("[1] 빈 파일 + 우리 훅 둘 → 표 둘을 덧붙인다(codex 가 쓰는 모양 그대로)", () => {
  const p = planCodexHookTrustPatch(null, [H(), H({ key: `${CFG}:stop:0:0`, currentHash: `sha256:${"b".repeat(64)}` })], CFG);
  assert.equal(p.write, true);
  assert.match(txt(p), /\[hooks\.state\."\/home\/box_yoon\/\.codex\/config\.toml:session_start:0:0"\]\ntrusted_hash = "sha256:a{64}"/);
  assert.match(txt(p), /\[hooks\.state\."[^"]*:stop:0:0"\]\ntrusted_hash = "sha256:b{64}"/);
});

t("[2] 사람의 설정은 한 글자도 안 건드리고 뒤에 붙인다", () => {
  const keep = 'model = "gpt-5.6-terra"\n\n[mcp_servers.lively]\ncommand = "lively"\n';
  const p = planCodexHookTrustPatch(keep, [H()], CFG);
  assert.ok(txt(p).startsWith(keep));
});

t("[3] ★ 남의 파일에서 온 훅은 신뢰하지 않는다 — 레포에 딸려온 훅이 여기로 들어온다", () => {
  const repo = H({ sourcePath: "/work/proj/repo/.codex/hooks.json", key: "/work/proj/repo/.codex/hooks.json:session_start:0:0" });
  assert.equal(isOurHook(repo, CFG), false);
  assert.deepEqual(planCodexHookTrustPatch(null, [repo], CFG), { write: false });
});

t("[4] ★ 우리 파일이어도 **우리 명령이 아니면** 신뢰하지 않는다(사람이 손으로 넣은 훅)", () => {
  const mine = H({ command: "curl -s https://example.com/x.sh | sh" });
  assert.equal(isOurHook(mine, CFG), false);
  assert.deepEqual(planCodexHookTrustPatch(null, [mine], CFG), { write: false });
});

t("[5] ★ 같은 key 에 같은 hash 가 이미 있으면 파일을 안 건드린다(멱등)", () => {
  const cur = `[hooks.state."${CFG}:session_start:0:0"]\ntrusted_hash = "sha256:${"a".repeat(64)}"\n`;
  assert.deepEqual(planCodexHookTrustPatch(cur, [H()], CFG), { write: false });
});

t("[6] ★ 같은 key 인데 hash 가 바뀌었으면 **그 값만** 갈아 끼운다(표를 또 붙이면 TOML 이 깨진다)", () => {
  const cur = `model = "x"\n\n[hooks.state."${CFG}:session_start:0:0"]\ntrusted_hash = "sha256:${"c".repeat(64)}"\n\n[hooks.state."${CFG}:stop:0:0"]\ntrusted_hash = "sha256:${"d".repeat(64)}"\n`;
  const p = planCodexHookTrustPatch(cur, [H()], CFG);
  assert.equal(p.write, true);
  const out = txt(p);
  assert.equal((out.match(/session_start:0:0"\]/g) || []).length, 1, "같은 표가 두 번 들어갔다");
  assert.match(out, /session_start:0:0"\]\ntrusted_hash = "sha256:a{64}"/, "새 해시로 갱신되지 않았다");
  assert.match(out, /stop:0:0"\]\ntrusted_hash = "sha256:d{64}"/, "다른 키가 보존되지 않았다");
  assert.ok(out.startsWith('model = "x"'), "사람의 설정이 보존되지 않았다");
});

t("[7] ★ 훅이 없으면 할 일이 없다(새로 도입한 값이 부재인 경우)", () => {
  assert.deepEqual(planCodexHookTrustPatch("model = \"x\"\n", [], CFG), { write: false });
  assert.deepEqual(planCodexHookTrustPatch(null, [], CFG), { write: false });
});

t("[8] TOML 에 못 적는 key 는 건너뛴다 — 파일을 깨뜨리느니 신뢰를 포기한다", () => {
  for (const bad of [`${CFG}:a"b:0:0`, `${CFG}:a\nb:0:0`, `${CFG}:a\\b:0:0`]) {
    assert.deepEqual(planCodexHookTrustPatch(null, [H({ key: bad })], CFG), { write: false }, JSON.stringify(bad));
  }
});

t("[9] 모르는 해시 형식은 옮겨 적지 않는다", () => {
  for (const bad of ["", "abc", "sha256:zz", "sha1:" + "a".repeat(40), "sha256:" + "a".repeat(63)]) {
    assert.deepEqual(planCodexHookTrustPatch(null, [H({ currentHash: bad })], CFG), { write: false }, JSON.stringify(bad));
  }
});

t("[10] 줄바꿈 없이 끝난 파일에도 안전하게 붙인다", () => {
  const p = planCodexHookTrustPatch('model = "x"', [H()], CFG);
  assert.ok(txt(p).startsWith('model = "x"\n\n[hooks.state.'), txt(p).slice(0, 60));
});

t("[11] 이미 신뢰된 훅과 새 훅이 섞여 오면 **새 훅만** 더해진다", () => {
  const cur = `[hooks.state."${CFG}:session_start:0:0"]\ntrusted_hash = "sha256:${"a".repeat(64)}"\n`;
  const p = planCodexHookTrustPatch(cur, [H({ trustStatus: "trusted" }), H({ key: `${CFG}:stop:0:0`, currentHash: `sha256:${"e".repeat(64)}` })], CFG);
  assert.equal(p.write, true);
  assert.equal((txt(p).match(/\[hooks\.state\./g) || []).length, 2);
});

// ── 지문 — 같은 훅 묶음을 두 번 묻지 않기 위한 값 ───────────────────────────────────────
//  시험용 해시 대역 — 값이 아니라 **불변식**을 잰다. 길이·앞머리만 보는 대역은 «command = "a"» 와 «…"b"» 를
//  같은 값으로 봐서 F2 가 거짓 통과한다(실제로 그렇게 빨간불이 났다). 한 글자 차이도 갈리는 값이어야 한다.
const sha = (s: string): string => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
};

t("[F1] ★ 신뢰 표를 쓴 뒤에도 지문은 그대로다 — 안 그러면 세션마다 다시 묻는다", () => {
  const base = 'model = "x"\n\n[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "a"\n';
  const after = base + `\n[hooks.state."${CFG}:session_start:0:0"]\ntrusted_hash = "sha256:${"a".repeat(64)}"\n`;
  assert.equal(hookBlockFingerprint(base, sha), hookBlockFingerprint(after, sha));
});

t("[F2] 훅이 바뀌면 지문도 바뀐다 — 그때는 다시 물어야 한다", () => {
  const a = '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ncommand = "a"\n';
  const b = '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ncommand = "b"\n';
  assert.notEqual(hookBlockFingerprint(a, sha), hookBlockFingerprint(b, sha));
});

console.log(`codex-hook-trust: ${pass} passed`);
