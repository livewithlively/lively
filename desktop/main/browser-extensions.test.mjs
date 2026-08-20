// 브라우저 서피스 확장(애드온) (#1829 · browser-extensions.mjs) — 판정 + **배선**.
//  실행: node desktop/main/browser-extensions.test.mjs (러너가 desktop/**/*.test.mjs 를 자동 수집한다)
//
// 사양·엣지 표는 스크래치패드 spec-ext.md — 이름의 A1·B4… 는 그 표의 행 번호다.
//
// ⚠ 이 파일이 지키는 것 둘:
//   ① **zip slip** — 남의 압축 안 경로가 설치 폴더 밖을 가리키면 사용자 홈에 파일이 써진다(B 표).
//   ② **정적 룰셋 활성화** — 안 켜면 "설치는 됐는데 아무것도 안 막는" 상태가 된다(E2). 순정 Electron 이
//      매니페스트의 `enabled: true` 를 반영하지 않는다는 실측이 이 기능의 존재 이유다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import {
  crxZipOffset, safeEntryPath, readZipEntries, readZipEntryData,
  manifestRulesets, manifestSummary, parseInstalled, serializeInstalled, safeExtensionId,
  RULESET_SHIM_PAGE, enableRulesetsScript,
} from "./browser-extensions.mjs";

let pass = 0;
const t = (n, fn) => { fn(); pass++; console.log(`ok  ${n}`); };
const MAIN = readFileSync(fileURLToPath(new URL("./main.mjs", import.meta.url)), "utf8");
const PRELOAD = readFileSync(fileURLToPath(new URL("../preload/web.cjs", import.meta.url)), "utf8");

// ── 도구: 진짜 zip 을 메모리에서 만든다(고정 바이트를 붙여넣지 않는다 — 그러면 무엇을 검증하는지 안 보인다) ──
function makeZip(files) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, content, store] of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.from(content, "utf8");
    const data = store ? raw : deflateRawSync(raw);
    const method = store ? 0 : 8;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(0, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(0, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const localBuf = Buffer.concat(locals), centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}
function wrapCrx3(zip, headerLen = 21) {
  const head = Buffer.alloc(12);
  head.write("Cr24", 0, "latin1"); head.writeUInt32LE(3, 4); head.writeUInt32LE(headerLen, 8);
  return Buffer.concat([head, Buffer.alloc(headerLen, 7), zip]);
}

// ── A. crx/zip 판별 ──────────────────────────────────────────────────────────
t("A1~A3 crx3·crx2 헤더를 정확히 걷고, 생 zip 은 그대로 둔다", () => {
  const zip = makeZip([["manifest.json", "{}", true]]);
  assert.equal(crxZipOffset(wrapCrx3(zip, 21)), 33, "A1 crx3 = 12 + headerLen");
  const c2 = Buffer.concat([
    (() => { const b = Buffer.alloc(16); b.write("Cr24", 0, "latin1"); b.writeUInt32LE(2, 4); b.writeUInt32LE(20, 8); b.writeUInt32LE(30, 12); return b; })(),
    Buffer.alloc(50, 1), zip,
  ]);
  assert.equal(crxZipOffset(c2), 66, "A2 crx2 = 16 + pub + sig");
  assert.equal(crxZipOffset(zip), 0, "A3 생 zip 은 오프셋 0");
});

t("A4~A6 ★ 알 수 없는 버전·범위 밖 헤더는 **던진다** — 조용히 0 을 주면 헤더가 데이터로 읽힌다", () => {
  const bad = Buffer.alloc(32); bad.write("Cr24", 0, "latin1"); bad.writeUInt32LE(9, 4);
  assert.throws(() => crxZipOffset(bad), /crx 버전/, "A4");
  const over = Buffer.alloc(40); over.write("Cr24", 0, "latin1"); over.writeUInt32LE(3, 4); over.writeUInt32LE(0xfffff, 8);
  assert.throws(() => crxZipOffset(over), /범위/, "A6 헤더 길이가 파일보다 크다");
  for (const short of [Buffer.alloc(0), Buffer.alloc(8), null, undefined])       // A5 부재·짧은 버퍼
    assert.equal(crxZipOffset(short), 0, "짧은 버퍼에서 죽으면 안 된다");
});

// ── B. zip slip ─────────────────────────────────────────────────────────────
t("B1~B9 ★ 압축 안 경로는 설치 폴더 밖을 절대 못 가리킨다", () => {
  assert.equal(safeEntryPath("manifest.json"), "manifest.json");                 // B1
  assert.equal(safeEntryPath("_locales/ko/messages.json"), "_locales/ko/messages.json"); // B2
  assert.equal(safeEntryPath("../../evil.js"), null);                            // B3
  assert.equal(safeEntryPath("a/../../evil.js"), null);                          // B4 중간 상위 참조
  assert.equal(safeEntryPath("a/b/../c.js"), null, "상위 참조는 어디에 있든 거부");
  for (const abs of ["/etc/passwd", "C:\\evil", "c:/evil", "\\\\srv\\share\\x"]) // B5 절대·UNC
    assert.equal(safeEntryPath(abs), null, abs);
  assert.equal(safeEntryPath("a\\b.js"), "a/b.js");                              // B6 윈도우 구분자
  for (const empty of ["", ".", "..", "./", null, undefined])                    // B7 부재
    assert.equal(safeEntryPath(empty), null, String(empty));
  assert.equal(safeEntryPath("a//b.js"), "a/b.js", "빈 조각은 접는다(무해)");
  assert.equal(safeEntryPath("ev\0il.js"), null);                                // B9 NUL 절단
});

// ── zip 읽기 ────────────────────────────────────────────────────────────────
t("Z1 zip 왕복 — store·deflate 둘 다 원본으로 돌아온다", () => {
  const zip = makeZip([["manifest.json", '{"name":"x"}', true], ["big.js", "console.log(1);".repeat(50), false]]);
  const { entries, dropped } = readZipEntries(zip);
  assert.equal(dropped, 0);
  assert.deepEqual(entries.map((e) => e.path).sort(), ["big.js", "manifest.json"]);
  const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
  assert.equal(readZipEntryData(zip, byPath["manifest.json"]).toString(), '{"name":"x"}', "store");
  assert.equal(readZipEntryData(zip, byPath["big.js"]).toString(), "console.log(1);".repeat(50), "deflate");
});

t("Z2 ★ 위험한 경로의 엔트리는 **목록에 아예 없다**(dropped 로 센다)", () => {
  const zip = makeZip([["manifest.json", "{}", true], ["../../evil.js", "pwn", true], ["/abs.js", "pwn", true]]);
  const { entries, dropped } = readZipEntries(zip);
  assert.deepEqual(entries.map((e) => e.path), ["manifest.json"], "위험 경로가 목록에 남아 있다");
  assert.equal(dropped, 2, "버린 개수를 안 센다 — 사람에게 알릴 수 없다");
});

t("Z3 zip 이 아니면 던진다(crx 헤더를 안 걷고 넘긴 경우를 잡는다)", () => {
  assert.throws(() => readZipEntries(Buffer.from("not a zip at all, really")), /압축 파일 형식/);
});

// ── C. 매니페스트 ───────────────────────────────────────────────────────────
t("C1~C6 켤 룰셋 — enabled:false 만 빼고, 키가 없으면 켠다(Chrome 기본)", () => {
  const mk = (rr) => ({ declarative_net_request: { rule_resources: rr } });
  assert.deepEqual(manifestRulesets(mk([{ id: "a", enabled: true }, { id: "b", enabled: true }, { id: "c", enabled: true }])), ["a", "b", "c"]); // C1
  assert.deepEqual(manifestRulesets(mk([{ id: "a", enabled: true }, { id: "b", enabled: false }])), ["a"]);   // C2 ★ 사람이 끈 걸 켜면 안 된다
  assert.deepEqual(manifestRulesets(mk([{ id: "a" }])), ["a"]);                                              // C3 ★ 키 부재 = 활성
  assert.deepEqual(manifestRulesets({}), []);                                                                // C4
  for (const broken of [mk("nope"), mk(null), mk(42), { declarative_net_request: 1 }])                        // C5 깨진 매니페스트
    assert.deepEqual(manifestRulesets(broken), [], "남의 파일이 깨졌다고 던지면 부팅이 죽는다");
  for (const none of [null, undefined, "x", 7]) assert.deepEqual(manifestRulesets(none), [], String(none));    // C6 부재
  assert.deepEqual(manifestRulesets(mk([{ id: "" }, { id: 5 }, null, "x"])), [], "id 가 문자열이 아닌 것을 넣는다");
});

t("C7 요약 — 이름이 없어도 무언가는 보여 준다", () => {
  assert.equal(manifestSummary({ name: " uBlock ", version: "1.2" }, "id1").name, "uBlock");
  assert.equal(manifestSummary({}, "id1").name, "id1", "이름이 없으면 id 로 부른다");
  assert.equal(manifestSummary(null, null).name, "이름 없는 확장");
  assert.equal(manifestSummary({ manifest_version: 3 }, "x").manifestVersion, 3);
});

// ── D. 설치 목록 ────────────────────────────────────────────────────────────
t("D1~D4 ★ 목록은 어떤 입력에도 던지지 않는다 — 이 파일이 깨졌다고 부팅이 막히면 브라우저를 통째로 못 쓴다", () => {
  const good = [{ id: "a", dir: "/x/a", name: "A", version: "1" }];
  assert.deepEqual(parseInstalled(JSON.stringify(good)), good);                  // D1
  for (const broken of ["{not json", "null", "{}", '"x"', "[]", null, undefined, 42])  // D2 부재·깨짐
    assert.deepEqual(parseInstalled(broken), [], String(broken));
  assert.deepEqual(parseInstalled('[{"id":"a"},{"dir":"/x"},null,"s"]'), [], "D3 id·dir 없는 항목은 뺀다");
  const dup = parseInstalled('[{"id":"a","dir":"/1"},{"id":"a","dir":"/2"}]');   // D4 중복
  assert.equal(dup.length, 1, "같은 확장을 두 번 걸면 Electron 이 던진다");
  assert.equal(dup[0].dir, "/2", "뒤엣것이 남아야 한다");
  assert.deepEqual(parseInstalled(serializeInstalled(good)), good, "직렬화 왕복");
  assert.deepEqual(parseInstalled(serializeInstalled("nope")), []);
});

t("D5 확장 id 는 파일 이름이 된다 — 경로 문자가 들어가면 안 된다", () => {
  assert.equal(safeExtensionId("abcdefghijklmnop"), "abcdefghijklmnop");
  assert.equal(safeExtensionId("ub-lock_1.2"), "ub-lock_1.2");
  for (const bad of ["../x", "a/b", "a\\b", ".", "..", "", null, "a".repeat(65), "a b", "a:b"])
    assert.equal(safeExtensionId(bad), null, String(bad));
});

// ── E. 배선 ─────────────────────────────────────────────────────────────────
t("E1 ★ 확장은 **서피스 세션에만** 건다 — 게이트웨이 UI 세션에 걸면 남의 코드가 우리 토큰 문맥에서 돈다", () => {
  const at = MAIN.indexOf("async function loadExtensionInto");
  assert.ok(at >= 0, "확장 로더가 없다");
  // 로더는 세션을 인자로 받고, 부르는 쪽은 전부 browserSurfaceSession() 이어야 한다.
  assert.match(MAIN.slice(at, at + 400), /sess\.loadExtension\(/, "인자로 받은 세션에 걸지 않는다");
  const callers = MAIN.match(/loadExtensionInto\(([^,]+),/g) || [];
  assert.ok(callers.length >= 1, "로더를 아무도 안 부른다");
  for (const c of callers) assert.match(c, /loadExtensionInto\(sess,/, "★ 서피스 세션이 아닌 것을 넘긴다: " + c);
  assert.ok(!/defaultSession\.loadExtension/.test(MAIN), "★ 기본 세션에 확장을 건다");
});

t("E2 ★ 로드 직후 정적 룰셋을 켠다 — 안 켜면 '설치됨' 인데 아무것도 안 막는다", () => {
  const at = MAIN.indexOf("async function loadExtensionInto");
  // ⚠ 구간을 **그 함수 본문까지만** 자른다 — 넉넉히 자르면 바로 뒤의 `async function enableRulesetsFor` **정의**가
  //  딸려 들어와, 호출을 통째로 지워도 이름이 보여 초록불이 된다(실제로 그랬다).
  const end = MAIN.indexOf("async function enableRulesetsFor", at);
  assert.ok(end > at, "활성화 함수가 로더 뒤에 없다 — 구간을 못 자른다");
  const seg = MAIN.slice(at, end);
  assert.match(seg, /manifestRulesets\(/, "매니페스트에서 켤 룰셋을 안 읽는다");
  assert.match(seg, /await enableRulesetsFor\(sess, ext, ids\)/, "★ 룰셋 활성화를 안 부른다");
  // 실패를 조용히 넘기면 사용자는 영영 모른다
  assert.match(seg, /send\(IPC\.LOG/, "★ 활성화 실패를 사람에게 안 알린다");
  // 활성화는 확장 오리진 페이지 경유여야 한다 — Electron 에 다른 통로가 없다(실측)
  const ea = MAIN.indexOf("async function enableRulesetsFor");
  assert.ok(ea >= 0, "활성화 함수가 없다");
  const eseg = MAIN.slice(ea, ea + 900);
  assert.match(eseg, /chrome-extension:\/\/\$\{ext\.id\}\/\$\{RULESET_SHIM_PAGE\}/, "확장 오리진 페이지를 안 띄운다");
  assert.match(eseg, /partition: BROWSER_SURFACE_PARTITION/, "★ 확장이 걸린 세션이 아닌 곳에서 부른다 — 아무 효과가 없다");
  assert.match(eseg, /w\.destroy\(\)/, "숨은 창을 안 닫는다 — 설치할수록 창이 쌓인다");
  assert.ok(!/startWorkerForScope|executeScriptInWorker/.test(MAIN), "★ 실재하지 않는 API 를 쓴다(실측: 그런 메서드는 없다)");
});

t("E3 부팅 때 저장된 목록을 다시 건다 — Electron 은 확장을 기억하지 않는다", () => {
  assert.match(MAIN, /void reloadInstalledExtensions\(s\)/, "서피스 세션 채비에서 재로드를 안 건다");
  const at = MAIN.indexOf("async function reloadInstalledExtensions");
  const seg = MAIN.slice(at, at + 700);
  assert.match(seg, /existsSync\(it\.dir\)/, "지워진 확장을 거르지 않는다 — 죽은 항목이 부팅을 막는다");
  assert.match(seg, /writeInstalledExtensions\(alive\)/, "사라진 항목을 목록에서 안 뺀다");
});

t("E4 ★ 설치는 페이지가 경로를 정하지 못한다 — 메인이 네이티브 선택창을 띄운다", () => {
  const at = MAIN.indexOf("async function installExtensionInteractive");
  assert.ok(at >= 0, "설치 함수가 없다");
  const seg = MAIN.slice(at, at + 1600);
  assert.match(seg, /dialog\.showOpenDialog/, "★ 파일 선택을 사람에게 안 맡긴다");
  assert.match(seg, /rmSync\(dir, \{ recursive: true, force: true \}\)/, "실패하면 반쯤 푼 폴더가 남는다");
  // IPC: 설치 채널이 인자를 안 받는다(경로가 페이지에서 오면 안 된다)
  assert.match(MAIN, /ipcMain\.handle\(IPC_WEB\.EXT_INSTALL, async \(e\) =>/, "★ 설치 핸들러가 인자를 받는다 — 경로가 페이지에서 올 수 있다");
  for (const ch of ["EXT_LIST", "EXT_INSTALL", "EXT_REMOVE"]) {
    const i = MAIN.indexOf(`ipcMain.handle(IPC_WEB.${ch}`);
    assert.ok(i >= 0, `${ch} 핸들러가 없다`);
    assert.match(MAIN.slice(i, i + 260), /fromGateway\(e\)/, `★ ${ch} 가 출처를 안 본다`);
  }
  assert.match(MAIN, /safeExtensionId\(id\)/, "★ 제거가 id 형태를 안 본다 — 임의 경로를 지울 수 있다");
  // preload: install 에 인자를 실어 보내지 않는다
  assert.match(PRELOAD, /install: \(\) => ipcRenderer\.invoke\("lively-web:ext-install"\)/, "★ preload 가 install 에 인자를 넘긴다");
  assert.match(PRELOAD, /browserExtensions: boot\.browserSurface \?/, "능력이 없을 때도 확장 다리를 노출한다");
});

t("E5 압축 해제는 safeEntryPath 를 통과한 경로만 쓴다", () => {
  const at = MAIN.indexOf("function unpackExtension");
  assert.ok(at >= 0, "해제 함수가 없다");
  const seg = MAIN.slice(at, at + 900);
  assert.match(seg, /readZipEntries\(zip\)/, "엔트리 목록을 안 쓴다");
  assert.match(seg, /join\(destDir, e\.path\)/, "★ 원본 이름으로 경로를 만든다 — safeEntryPath 를 우회한다");
  assert.ok(!/e\.name|entry\.name|rawName/.test(seg), "★ 걸러지지 않은 이름을 쓴다");
  assert.match(seg, /crxZipOffset\(buf\)/, "crx 헤더를 안 걷는다");
});

t("E6 룰셋 실행 스크립트는 켠 뒤 **켜진 목록을 돌려준다**(정말 켜졌는지 확인 가능해야)", () => {
  const js = enableRulesetsScript(["a", "b"]);
  assert.match(js, /updateEnabledRulesets/);
  assert.match(js, /\["a","b"\]/);
  assert.match(js, /getEnabledRulesets/, "★ 켰다고만 하고 확인을 안 한다");
  assert.match(RULESET_SHIM_PAGE, /^_lively-/, "심는 파일은 우리 것임이 이름으로 드러나야 한다(남의 파일과 안 섞이게)");
});

console.log(`\n${pass} passed`);
