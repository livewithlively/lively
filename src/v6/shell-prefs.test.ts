// 새 셸 개인화(#2460) — 서버가 **무엇을 저장 스키마로 인정하나**, 그리고 그 표가 화면과 어긋나지 않나.
//
// 이 층이 지키는 것은 두 가지다.
//  ① **허용목록** — 값은 브라우저가 보낸다. 구버전 셸·손으로 만든 요청이 계정 행에 임의 키를 쌓지
//     못하게, 무엇이 저장 스키마인지는 서버가 정한다.
//  ② **뜻이 있는 빈 값** — 「고정 0개」는 안 담지만(§A5), 치움 기준값의 `''` 는 **담는다**(§A8).
//     그건 「점 없는 상태로 치웠다」라는 뜻이라(#2110), 버리면 그 행이 다른 기기에서 영영 안 치워진다.
//     이 둘은 서로 반대 방향이라, 한쪽 규칙으로 뭉뚱그리면 반드시 하나가 깨진다.
//
// 그리고 **seam** — 이 표는 web/v2/shell-prefs.ts 의 선언과 짝이다. 한쪽에만 있으면 조용히 실패한다:
//  서버에만 있으면 아무도 안 쓰는 죽은 칸이고, 클라이언트에만 있으면 사람이 정한 것이 **저장되는
//  줄 알았는데 매번 버려진다**(에러도 안 난다).
import { strict as assert } from "node:assert";
import test from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeShellPrefs, SHELL_PREF_STORES } from "./shell-pref-store.js";

function repoRoot(): string {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(d, "package.json"))) return d;
    d = path.dirname(d);
  }
  throw new Error("레포 뿌리를 찾지 못했다");
}
const ROOT = repoRoot();

// 표에서 각 모양의 대표 키 하나씩 — 키 이름이 바뀌어도 이 테스트가 따라오게 표에서 고른다.
const pick = (kind: string): string => {
  const k = Object.entries(SHELL_PREF_STORES).find(([, v]) => v === kind)?.[0];
  assert.ok(k, `허용목록에 ${kind} 모양의 저장소가 하나도 없다 — 표가 비었거나 모양 이름이 바뀌었다`);
  return k!;
};
const LIST = pick("list");
const MAP = pick("map");
const STR = pick("str");

// ── A. 정규화 — 사양 엣지 표 ────────────────────────────────────────────────
test("A1·A2·A17 허용목록 밖은 저장하지 않는다(무엇이 스키마인지는 서버가 정한다)", () => {
  assert.deepEqual(normalizeShellPrefs({ evil_store: ["x"] }), {},
    "A1 허용목록 밖 키가 저장됐다 — 브라우저가 보낸 아무 키나 계정 행에 쌓인다");
  assert.deepEqual(normalizeShellPrefs({ [LIST]: ["a"], evil_store: ["x"] }), { [LIST]: ["a"] },
    "A2 허용목록 키만 남아야 한다");
  for (const bad of [null, undefined, [], "str", 7]) {
    assert.deepEqual(normalizeShellPrefs(bad), {}, `A17 객체가 아닌 입력(${JSON.stringify(bad)})은 빈 결과여야 한다`);
  }
});

test("A3·A4·A5 목록은 사람이 고른 순서다 — 순서 보존 · 중복 한 번 · 쓰레기 제거", () => {
  assert.deepEqual(normalizeShellPrefs({ [LIST]: ["a", 3, "", null, "b", "  "] }), { [LIST]: ["a", "b"] },
    "A3 문자열이 아니거나 빈 원소가 남았다");
  assert.deepEqual(normalizeShellPrefs({ [LIST]: ["a", "b", "a"] }), { [LIST]: ["a", "b"] },
    "★A4 중복이 첫 자리로 접히지 않았다 — 같은 행이 목록에 두 줄로 선다");
  assert.deepEqual(normalizeShellPrefs({ [LIST]: ["z", "m", "a"] }), { [LIST]: ["z", "m", "a"] },
    "★A5 순서가 바뀌었다 — 레일은 사람이 **끌어서 정한 자리**라 정렬하면 그 결정이 사라진다");
});

test("A6·A10·A14 빈 값은 담지 않는다(쓰지도 않은 키가 계정마다 쌓이지 않게)", () => {
  assert.deepEqual(normalizeShellPrefs({ [LIST]: [] }), {}, "A6 빈 목록이 담겼다");
  assert.deepEqual(normalizeShellPrefs({ [MAP]: {} }), {}, "A10 빈 짝이 담겼다");
  assert.deepEqual(normalizeShellPrefs({ [STR]: "" }), {}, "A14 빈 문자열이 담겼다");
});

test("A7·A11·A13 모양이 선언과 다르면 그 키를 버린다", () => {
  assert.deepEqual(normalizeShellPrefs({ [LIST]: { a: "b" } }), {}, "A7 목록 자리에 객체가 왔는데 통과했다");
  assert.deepEqual(normalizeShellPrefs({ [MAP]: ["a"] }), {}, "A11 짝 자리에 배열이 왔는데 통과했다");
  assert.deepEqual(normalizeShellPrefs({ [STR]: ["a"] }), {}, "A13 문자열 자리에 배열이 왔는데 통과했다");
});

test("★A8 짝의 «빈 문자열 값»은 남긴다 — 그건 뜻이 있는 값이다(#2110 치움 기준)", () => {
  // 치움은 «치울 때의 상태»를 함께 적어 두고 그 상태가 바뀌면 다시 올린다. 점이 없는 상태(대기·오프라인)로
  //  치운 행의 기준값은 `''` 다 — 실측에서 내 세션 284건 중 271건(95%)이 그 부류였다.
  //  이걸 «빈 값이니 버린다»로 뭉뚱그리면 그 행들은 다른 기기에서 **영영 안 치워진다**.
  assert.deepEqual(normalizeShellPrefs({ [MAP]: { "sess:box-1": "" } }), { [MAP]: { "sess:box-1": "" } },
    "치움 기준값 ''(점 없는 상태로 치웠다)가 버려졌다 — 그 행은 다른 기기에서 영영 안 치워진다");
});

test("A9 짝의 값이 문자열이 아니면 **그 항목만** 버린다", () => {
  assert.deepEqual(normalizeShellPrefs({ [MAP]: { a: "waiting", b: 3, c: null, d: "done" } }),
    { [MAP]: { a: "waiting", d: "done" } },
    "성한 항목까지 함께 버려졌거나 깨진 항목이 살아남았다");
});

test("A12 문자열 저장소는 그대로 담긴다", () => {
  assert.deepEqual(normalizeShellPrefs({ [STR]: "proj" }), { [STR]: "proj" });
});

test("A15·A16 상한 — 원소 수와 길이를 자른다(화면 상태지 자료가 아니다)", () => {
  const many = Array.from({ length: 600 }, (_, i) => `k${i}`);
  const got = normalizeShellPrefs({ [LIST]: many })[LIST] as string[];
  assert.equal(got.length, 500, "A15 원소 수 상한(500)이 안 걸렸다 — 한 행이 무한정 커진다");
  assert.equal(got[0], "k0", "A15 자를 때 앞에서부터 남겨야 한다(사람이 고른 순서의 앞이 먼저다)");

  const long = "x".repeat(1000);
  const one = (normalizeShellPrefs({ [LIST]: [long] })[LIST] as string[])[0];
  assert.ok(one.length < long.length && one.length > 0, `A16 긴 원소가 안 잘렸다(${one.length}자)`);

  const mapVal = normalizeShellPrefs({ [MAP]: { a: long } })[MAP] as Record<string, string>;
  assert.ok(mapVal.a.length < long.length, "A16 짝의 긴 값이 안 잘렸다");
});

test("A18 왕복이 안정적이다(정규화 결과를 다시 정규화해도 같다)", () => {
  const once = normalizeShellPrefs({
    [LIST]: ["a", "b", "a", 3], [MAP]: { x: "", y: 1 }, [STR]: "proj", nope: ["q"],
  });
  assert.deepEqual(normalizeShellPrefs(once), once,
    "멱등이 아니다 — 조회 때 한 번 더 도는 정규화가 저장된 값을 바꾼다");
});

// ── C. seam — 서버 표 ↔ 화면 선언 ───────────────────────────────────────────
//  화면은 저장소를 두 가지로 선언한다: shellPrefStore(base, kind) = 서버가 정본 ·
//  deviceStore(base) = 이 기기가 정본. 앞의 것만 서버 표에 있어야 한다.
function scanWebDeclarations(): { synced: Map<string, string>; device: Set<string> } {
  const dir = path.join(ROOT, "web");
  const synced = new Map<string, string>();
  const device = new Set<string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, name.name);
      if (name.isDirectory()) { if (name.name !== "node_modules") walk(p); continue; }
      if (!name.name.endsWith(".ts")) continue;
      const src = readFileSync(p, "utf8");
      for (const m of src.matchAll(/\bshellPrefStore\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g)) synced.set(m[1], m[2]);
      for (const m of src.matchAll(/\bdeviceStore\(\s*'([^']+)'\s*\)/g)) device.add(m[1]);
    }
  };
  walk(dir);
  return { synced, device };
}

test("★C1·C2 화면이 «서버가 정본»이라 선언한 저장소와 서버 허용목록이 정확히 같다", () => {
  const { synced } = scanWebDeclarations();
  assert.ok(synced.size > 0, "화면에서 shellPrefStore 선언을 하나도 못 찾았다 — 스캐너가 죽었으면 이 테스트는 아무것도 안 본다");
  assert.deepEqual([...synced.keys()].sort(), Object.keys(SHELL_PREF_STORES).sort(),
    "★한쪽에만 있는 저장소가 있다 — 서버에만 있으면 죽은 칸이고, 화면에만 있으면 사람이 정한 것이 **저장되는 줄 알았는데 매번 버려진다**(에러도 안 난다)");
  const kindBad: string[] = [];
  for (const [k, kind] of synced) if (SHELL_PREF_STORES[k] !== kind) kindBad.push(`${k}: 화면 '${kind}' ≠ 서버 '${SHELL_PREF_STORES[k]}'`);
  assert.deepEqual(kindBad, [], "C2 모양이 어긋난다 — 서버가 그 값을 통째로 버린다");
});

test("C3 «이 기기가 정본»인 저장소는 서버 표에 없다", () => {
  const { device } = scanWebDeclarations();
  assert.ok(device.size > 0, "deviceStore 선언을 하나도 못 찾았다(스캐너 배선 확인)");
  const leaked = [...device].filter((k) => k in SHELL_PREF_STORES);
  assert.deepEqual(leaked, [], "기기의 것(열린 창·캐시)이 서버 표에 있다 — 다른 기기의 창이 이 화면에 되살아난다");
});
