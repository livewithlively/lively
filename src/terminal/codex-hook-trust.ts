// codex 훅 신뢰를 **미리 적어 둔다** (#4135 후속) — 우리가 심은 훅만.
//
//  ── 무엇이 막고 있었나 ──
//  codex 는 훅을 돌리기 전에 «Hooks need review — 21 hooks are new or changed» 대화상자로 신뢰를 받는다.
//  우리 킷이 심은 훅이 매번 그 목록에 올라, 새 세션마다 그 창이 뜨고 **첫 지시가 그 뒤에서 멈춘다**
//  (실측 2026-09-25 원준님). 그 상태에서는 상태 보고·대화 id 매핑·이름짓기 훅도 전부 안 돈다.
//
//  ── 어떻게 (실측 2026-09-25, codex 0.157.0) ──
//  app-server 의 `hooks/list` 가 훅마다 `key` · `currentHash` · `sourcePath` · `command` · `trustStatus` 를 준다.
//  그 값을 `config.toml` 의 `[hooks.state."<key>"] trusted_hash = "<hash>"` 로 적으면 그 훅은 신뢰된 것으로 뜬다
//  (TUI 가 «Trust all» 에서 쓰는 자리와 같은 표 — 그 파일에 찍힌 모양을 그대로 읽어 확인했다).
//  해시를 우리가 계산하지 않는다 — **codex 가 알려 준 값**을 옮겨 적을 뿐이다(규격은 비공개다).
//
//  ── 경계 ──
//  ⚠ **우리가 심은 훅만** 신뢰한다(isOurHook — 자리와 명령 둘 다 맞아야 한다). 레포에 딸려온 훅
//   (`<repo>/.codex/hooks.json`)·플러그인 훅·사람이 손으로 넣은 훅은 손대지 않는다: 그 대화상자가 막으려는
//   것이 바로 그것이고, 한 번 «전부 신뢰» 를 눌러 주는 것은 그 경계를 우리가 대신 허무는 일이다.
//  ⚠ 순수 모듈이다 — 파일도 프로세스도 안 건드린다(호출자가 읽고 쓴다, harness-trust.ts 와 같은 규약).
import type { TrustPatch } from "./harness-trust.js";

/** `hooks/list` 한 줄 — 우리가 쓰는 필드만(나머지는 무시한다). */
export interface CodexHookRow {
  key: string;
  currentHash: string;
  sourcePath: string;
  command: string;
  trustStatus?: string;
}

/** 우리 킷이 심은 훅의 명령에 반드시 들어가는 표식 — 설치기가 짓는 모양이다(kit/setup/user-install.mjs). */
const OUR_COMMAND_RE = /[/\\]\.lively[/\\]hooks[/\\]|LIVELY_HARNESS=codex/;
/** codex 가 주는 해시 모양. 이 자를 통과한 값만 파일에 적는다(모르는 형식을 옮겨 적지 않는다). */
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
/** key 는 TOML 기본 문자열 안에 들어간다 — 따옴표·역슬래시·제어문자가 있으면 적지 않는다(파일이 깨진다). */
// eslint-disable-next-line no-control-regex -- 제어문자를 **거르려고** 쓴다
const KEY_BAD_RE = /["\\\u0000-\u001f\u007f]/;

/**
 * 이 훅이 **우리가 심은 것**인가 — 자리와 명령이 둘 다 맞아야 한다.
 *  자리만 보면(우리 config.toml) 사람이 그 파일에 손으로 넣은 훅까지 신뢰하게 되고,
 *  명령만 보면 남의 파일에서 온 같은 이름의 훅을 신뢰하게 된다.
 */
export function isOurHook(h: CodexHookRow, configFile: string): boolean {
  if (!h || String(h.sourcePath || "") !== String(configFile || "")) return false;
  return OUR_COMMAND_RE.test(String(h.command || ""));
}

/** `[hooks.state."<key>"]` 테이블이 이미 있나 — 있으면 그 자리의 trusted_hash 를 본다. */
function existingHash(toml: string, key: string): string | null {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^\\[hooks\\.state\\."${esc}"\\]\\s*\\n(?:[ \\t]*\\n)*trusted_hash = "([^"]*)"`, "m").exec(toml);
  return m ? m[1] : null;
}

/**
 * 신뢰 표를 반영한 새 config.toml (**순수**). 할 일이 없으면 `{write:false}`.
 *
 *  · 새 key → 파일 끝에 테이블을 덧붙인다(codex 자신이 쓰는 모양 그대로).
 *  · 있던 key 인데 hash 가 다르다 → **그 값만** 갈아 끼운다. 테이블을 또 붙이면 TOML 이 중복 키로 깨진다.
 *  · 값이 같으면 건드리지 않는다 — 세션을 열 때마다 파일 mtime 이 바뀌면 안 된다.
 */
export function planCodexHookTrustPatch(current: string | null, hooks: CodexHookRow[], configFile: string): TrustPatch {
  let text = current ?? "";
  let changed = false;
  for (const h of Array.isArray(hooks) ? hooks : []) {
    if (!isOurHook(h, configFile)) continue;
    const key = String(h.key || "");
    const hash = String(h.currentHash || "");
    if (!key || KEY_BAD_RE.test(key) || !HASH_RE.test(hash)) continue;   // 모르는 모양은 옮겨 적지 않는다
    const had = existingHash(text, key);
    if (had === hash) continue;                                          // 멱등 — 같은 값이면 그대로
    if (had !== null) {
      const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      text = text.replace(new RegExp(`(^\\[hooks\\.state\\."${esc}"\\]\\s*\\n(?:[ \\t]*\\n)*trusted_hash = ")[^"]*(")`, "m"), `$1${hash}$2`);
    } else {
      const head = text && !text.endsWith("\n") ? `${text}\n` : text;
      text = `${head}${head ? "\n" : ""}[hooks.state."${key}"]\ntrusted_hash = "${hash}"\n`;
    }
    changed = true;
  }
  return changed ? { write: true, text } : { write: false };
}

/**
 * 이 설정의 **훅 묶음 지문** — 같은 묶음을 두 번 묻지 않으려고 쓴다(순수).
 *  관리 블록이 그대로면 훅도 그대로이므로, app-server 를 띄워 물어볼 이유가 없다.
 *  ⚠ 신뢰 표(`[hooks.state…]`)는 지문에서 뺀다 — 그걸 넣으면 우리가 쓴 뒤 지문이 바뀌어 매번 다시 묻게 된다.
 */
export function hookBlockFingerprint(toml: string, sha256: (s: string) => string): string {
  //  줄 단위로 훑는다 — 정규식으로 «표 하나» 를 자르려다 `$`(멀티라인)에 걸려 첫 줄에서 끊겼다(이 시험이 빨간불이었다).
  //  규칙: `[[hooks.…]]` 로 시작하는 표만 모은다. 다른 표 머리(`[`)를 만나면 거기서 멈춘다.
  const out: string[] = [];
  let inHooks = false;
  for (const raw of String(toml || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) inHooks = line.startsWith("[[hooks.");
    if (inHooks && line) out.push(line);
  }
  return sha256(out.join("\n"));
}
