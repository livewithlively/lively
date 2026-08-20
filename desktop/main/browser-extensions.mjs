// 브라우저 서피스 확장(애드온) — 설치 판정·해제·목록 (#1829 슬라이스 2). 순수 모듈: Electron 없음.
//
// 왜 shim 이 필요한가 — Electron 순정 `session.loadExtension` 은 **문서가 말하는 것보다 훨씬 많이 된다**.
//  실측(43.4.1 / Chromium 150): MV3 unpacked 로드 · content script 실행 · service worker 구동 ·
//  `declarativeNetRequest` **실제 차단**까지 된다. 그래서 GPL 라이브러리(electron-chrome-extensions)도
//  MV3 upstream 대기도 불필요하다. 순정이 **안 해 주는 셋**만 우리가 메운다:
//
//   ① **정적 룰셋이 자동으로 안 켜진다** — 매니페스트에 `"enabled": true` 라고 적혀 있어도 로드 직후
//      `getEnabledRulesets()` 가 `[]` 다. `updateEnabledRulesets` 를 우리가 불러야 차단이 시작된다.
//      (광고차단 확장이 "설치는 됐는데 아무것도 안 막는" 정확한 이유 — 나도 첫 측정에서 "DNR 이 안 된다"고 오판했다.)
//   ② **`.crx` 를 못 읽는다** — unpacked 디렉터리만 받는다(공식 문서 명시). 웹스토어에서 받은 건 우리가 푼다.
//   ③ **재시작하면 잊는다** — "Loaded extensions will not be automatically remembered across exits".
//      설치 목록을 우리가 갖고 부팅 때 다시 건다.
//
// ⚠ 여기서 다루는 건 **남이 만든 코드 묶음**이다. 형식이 깨져 있거나 악의적일 수 있다는 전제로 쓴다 —
//  깨진 매니페스트에 예외를 던져 앱을 죽이지 않고, 압축 안의 경로가 설치 폴더 밖을 가리키면 거부한다(zip slip).

import { inflateRawSync } from "node:zlib";

/** 확장을 거는 곳은 **서피스 세션뿐**이다 — 게이트웨이 UI 세션(우리 토큰이 있는 곳)에는 절대 걸지 않는다. */
export const EXTENSIONS_DIRNAME = "browser-extensions";
export const INSTALLED_FILE = "installed.json";

/**
 * 정적 룰셋을 켜려면 `chrome.declarativeNetRequest` 를 **확장 문맥에서** 불러야 하는데,
 *  Electron 에는 그럴 통로가 없다 — 실측(43.4.1): `session.serviceWorkers` 에는 실행 API 가 없고
 *  `ServiceWorkerMain` 도 `send`/`ipc`/`startTask` 뿐이라 **남의 확장 워커에 코드를 넣을 수 없다**.
 *  통하는 길은 하나 — `chrome-extension://<id>/<페이지>` 를 창에 띄워 거기서 부르는 것.
 *  그런데 임의 확장이 우리가 쓸 페이지를 갖고 있다는 보장이 없다(popup·options 는 선택이고, MV3 엔 배경 페이지도 없다).
 *  → **우리가 푼 디렉터리에 얇은 페이지 하나를 심는다.** 매니페스트는 건드리지 않는다.
 *  실측 확인: web_accessible_resources 도, 확장이 제공하는 페이지도 없는 확장에서 이 방법으로 룰셋이 켜지고
 *  **실제 차단까지** 됐다.
 */
export const RULESET_SHIM_PAGE = "_lively-rulesets.html";
export const RULESET_SHIM_HTML = "<!doctype html><meta charset=\"utf-8\"><title>lively</title>";

/** 그 페이지에서 실행할 코드 — 켜고, 켜진 목록을 돌려준다(호출부가 실제로 켜졌는지 확인할 수 있게). */
export function enableRulesetsScript(ids) {
  return "chrome.declarativeNetRequest.updateEnabledRulesets({enableRulesetIds:" + JSON.stringify(ids) + "})"
    + ".then(function(){return chrome.declarativeNetRequest.getEnabledRulesets()})";
}

// ── 1. 압축 형식 ────────────────────────────────────────────────────────────
// crx = 헤더 + **그 뒤는 순수 zip**. 헤더 길이만 정확히 걷으면 그다음은 평범한 zip 파서로 읽힌다.
//  crx3: 'Cr24' | ver(4) | headerLen(4) | header | zip
//  crx2: 'Cr24' | ver(4) | pubKeyLen(4) | sigLen(4) | pubKey | sig | zip

const CRX_MAGIC = "Cr24";
const ZIP_LOCAL = 0x04034b50;   // PK\x03\x04

/**
 * zip 바이트가 시작하는 오프셋. crx 가 아니면 0(이미 zip).
 * @throws 알 수 없는 crx 버전이거나, 헤더 길이가 버퍼를 넘을 때
 *   — 조용히 0 을 돌려주면 zip 파서가 crx 헤더를 데이터로 읽어 **엉뚱한 파일을 만들어 낸다**.
 */
export function crxZipOffset(buf) {
  if (!buf || buf.length < 16 || buf.toString("latin1", 0, 4) !== CRX_MAGIC) return 0;
  const version = buf.readUInt32LE(4);
  let offset;
  if (version === 3) offset = 12 + buf.readUInt32LE(8);
  else if (version === 2) offset = 16 + buf.readUInt32LE(8) + buf.readUInt32LE(12);
  else throw new Error(`알 수 없는 crx 버전입니다: ${version}`);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= buf.length) {
    throw new Error("crx 헤더 길이가 파일 범위를 벗어납니다 — 손상되었거나 조작된 파일입니다.");
  }
  return offset;
}

// ── 2. 경로 안전 (zip slip) ─────────────────────────────────────────────────
/**
 * 압축 안의 엔트리 이름 → 설치 폴더 **기준 상대 경로**. 밖을 가리키면 null(= 그 엔트리를 버린다).
 *  이게 이 파일에서 가장 중요한 함수다 — 여기가 뚫리면 남의 zip 하나가 사용자 홈에 파일을 쓴다.
 *  판정은 문자열로 끝낸다(`path.resolve` 로 합친 뒤 startsWith 로 보는 방식은 심링크·대소문자에서 미끄러진다).
 */
export function safeEntryPath(name) {
  const raw = String(name == null ? "" : name);
  if (!raw || raw.includes("\0")) return null;              // NUL = 경로 절단 공격
  const unified = raw.replace(/\\/g, "/");                   // 윈도우에서 만든 zip
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) return null;   // 절대경로·드라이브
  const parts = [];
  for (const seg of unified.split("/")) {
    if (seg === "" || seg === ".") continue;                 // `a//b`·`./a` 는 무해 — 접는다
    if (seg === "..") return null;                           // ★ 상위 참조는 어디에 있든 거부
    parts.push(seg);
  }
  return parts.length ? parts.join("/") : null;
}

// ── 3. zip 읽기 (의존성 없이) ───────────────────────────────────────────────
// 중앙 디렉터리(EOCD → CD)를 걸어 엔트리를 읽는다. 압축은 store(0)·deflate(8) 만 —
//  확장 패키지는 이 둘뿐이고, 모르는 방식을 억지로 풀기보다 그 엔트리를 건너뛰는 편이 안전하다.
const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

/** EOCD 를 뒤에서 찾는다(주석이 붙을 수 있어 고정 위치가 아니다). 못 찾으면 null. */
function findEocd(buf) {
  const max = Math.min(buf.length, 0xffff + 22);
  for (let i = buf.length - 22; i >= buf.length - max && i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return null;
}

/**
 * zip 엔트리 목록 — `{ path, dir, method, offset, compressedSize, size }`.
 *  `path` 는 이미 safeEntryPath 를 통과한 값이고, 통과 못 한 엔트리는 **목록에 없다**(dropped 로 센다).
 * @returns {{entries: Array, dropped: number}}
 */
export function readZipEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd == null) throw new Error("압축 파일 형식이 아닙니다(중앙 디렉터리를 찾지 못했습니다).");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let dropped = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const rawName = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    const isDir = rawName.endsWith("/") || rawName.endsWith("\\");
    const safe = safeEntryPath(rawName);
    if (!safe) { dropped++; continue; }
    entries.push({ path: safe, dir: isDir, method, offset: localOffset, compressedSize, size });
  }
  return { entries, dropped };
}

/** 엔트리 하나의 실제 바이트. 로컬 헤더를 다시 읽어 이름·extra 길이를 건너뛴다(중앙 디렉터리와 다를 수 있다). */
export function readZipEntryData(buf, entry) {
  const p = entry.offset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== ZIP_LOCAL) {
    throw new Error(`엔트리를 읽지 못했습니다: ${entry.path}`);
  }
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) throw new Error(`엔트리가 파일 범위를 벗어납니다: ${entry.path}`);
  const raw = buf.subarray(start, end);
  if (entry.method === 0) return raw;             // store
  if (entry.method === 8) return inflateRawSync(raw);  // deflate
  return null;                                     // 모르는 압축 — 건너뛴다(억지로 풀지 않는다)
}

// ── 4. 매니페스트 판정 ──────────────────────────────────────────────────────
/**
 * 켜야 할 **정적 룰셋 id** 목록. Electron 이 매니페스트의 `enabled` 를 반영하지 않으므로 우리가 읽어 건다.
 *  ⚠ `enabled` 가 **없으면 켠다**(Chrome 기본이 활성). `false` 로 적힌 것만 뺀다 — 사람이 끈 걸 우리가 켜면 안 된다.
 *  남의 파일이라 어떤 형태로든 깨져 있을 수 있다 → **예외를 던지지 않는다**(부팅이 죽으면 브라우저를 못 쓴다).
 */
export function manifestRulesets(manifest) {
  const res = manifest && typeof manifest === "object"
    ? manifest.declarative_net_request && manifest.declarative_net_request.rule_resources
    : null;
  if (!Array.isArray(res)) return [];
  const ids = [];
  for (const r of res) {
    if (!r || typeof r !== "object") continue;
    if (r.enabled === false) continue;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (id) ids.push(id);
  }
  return ids;
}

/** 사람에게 보여 줄 요약. 깨진 매니페스트여도 무언가는 보여 준다(이름이 없으면 id 로 부른다). */
export function manifestSummary(manifest, fallbackId) {
  const m = manifest && typeof manifest === "object" ? manifest : {};
  return {
    name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : String(fallbackId || "이름 없는 확장"),
    version: typeof m.version === "string" ? m.version : "",
    manifestVersion: Number(m.manifest_version) || 0,
    rulesets: manifestRulesets(m),
  };
}

// ── 5. 설치 목록 ────────────────────────────────────────────────────────────
/**
 * 저장된 목록 → 배열. **어떤 입력에도 예외를 던지지 않는다** — 이 파일이 깨졌다고 부팅이 막히면
 *  사용자는 브라우저를 통째로 못 쓴다(고칠 방법도 화면에 없다). 못 읽으면 빈 목록에서 다시 시작한다.
 *  같은 id 가 둘이면 뒤엣것만 남긴다 — Electron 은 같은 확장을 두 번 걸면 던진다.
 */
export function parseInstalled(json) {
  let raw;
  try { raw = typeof json === "string" ? JSON.parse(json) : json; } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const byId = new Map();
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const id = typeof it.id === "string" ? it.id.trim() : "";
    const dir = typeof it.dir === "string" ? it.dir.trim() : "";
    if (!id || !dir) continue;
    byId.set(id, { id, dir, name: typeof it.name === "string" ? it.name : id, version: typeof it.version === "string" ? it.version : "" });
  }
  return [...byId.values()];
}

export function serializeInstalled(list) {
  return JSON.stringify(parseInstalled(Array.isArray(list) ? list : []), null, 2);
}

/**
 * 확장 폴더 이름으로 쓸 수 있는 id 인가 — 파일 이름이 되므로 경로 문자가 들어가면 안 된다.
 *  Chrome 확장 id 는 a~p 32자지만, 우리가 직접 푼 것엔 폴더명을 쓸 수도 있어 **형태만** 좁게 강제한다.
 */
export function safeExtensionId(id) {
  const s = String(id == null ? "" : id).trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(s) && s !== "." && s !== ".." ? s : null;
}
