// 테스트 러너 전역 가드 — `npm test` 가 **실행한 사람의 진짜 설정**을 바꾸면 잡아내고 되돌린다.
//
// 왜 이게 필요한가 — 같은 사고가 세 번 났다. 매번 원인 경로는 달랐고, 매번 그 경로만 닫았다:
//   #1593(PR #80)  `lively.mjs` 가 claude 를 부를 때 HOME 을 안 넘김 → ~/.claude.json 의 MCP command 가
//                  삭제된 임시 HOME 을 가리켜 lively MCP 가 통째로 죽음. → lively.mjs 호출부에 HOME 주입.
//   #1786(PR #220) 테스트가 `CLAUDE_CONFIG_DIR` 를 상속시켜 설치기가 **실 프로필** settings.json 에
//                  임시 훅 경로 20개를 배선 → 윈도우 훅 전멸. → claudeConfigDir() 정본화.
//   2026-08-20     `user-uninstall.test.mjs` 가 `bash register-clients.sh` 를 HOME 만 바꿔 호출.
//                  claude CLI 는 윈도우에서 USERPROFILE 을 보므로 격리가 무효 → 실 ~/.claude.json 의
//                  lively 항목이 `localhost:8080` + `Bearer dummy`(테스트 픽스처)로 덮임.
//
// 세 사고 모두 앞선 지식이 근본 해법을 **"관례를 두는 것"** 이라 적고 관례로 남겼다. 관례는 새 테스트를
//  쓰는 사람이 안 지킨다(실측: `...process.env` 를 자식에 넘기는 테스트 38개 중 sandboxEnv 사용은 8개).
//  그래서 이 파일은 관례가 아니라 **강제**다 — 어느 경로로 오염되든(env 상속·PATH·직접 쓰기) 결과만 본다.
//
// ⚠ 파일 **전체**를 비교하면 안 된다(2026-08-20 실측으로 배웠다). `~/.claude.json` 은 **하네스 자신이
//  세션 중 수시로 갱신한다** — promptQueueUseCount·tipsHistory·cachedGrowthBookFeaturesAt·projects…
//  100초짜리 전체 테스트를 돌리면 그 갱신이 끼어들어 무고한 빨간불이 뜨고, 더 나쁘게는 **가드가 하네스의
//  정상 갱신을 되돌린다**. 그래서 JSON 설정은 **테스트가 건드릴 이유가 없는 키**(mcpServers·hooks…)만
//  보고, 그 키만 부분 원복한다. 사고 세 건의 표적이 정확히 그 키들이었다.
//
// 설계 원칙
//  · **경로가 아니라 결과를 본다.** 다음 사고는 또 다른 경로로 온다. 무엇이 건드렸는지는 몰라도
//    "이 키가 달라졌다"는 사실은 언제나 같다.
//  · **되돌린다.** 탐지만 하면 사람이 손으로 복구해야 한다(#1593·#1786 둘 다 그랬다).
//  · **자동 갱신되는 것은 건드리지 않는다.** 자격증명(.credentials.json)은 하네스가 토큰을 갱신하므로
//    원복하면 로그인을 깨뜨린다 — 감시 대상에서 뺀다(잃을 위험 > 얻을 보호).
//
// ⚠ 이건 개별 테스트의 격리(kit/testlib/os-sandbox.mjs 의 sandboxEnv)를 대체하지 않는다. 그건 첫 겹,
//  이건 마지막 겹이다. 첫 겹이 뚫렸을 때 사람의 환경이 깨진 채 남지 않게 하는 것이 이 파일의 몫이다.
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// 원복을 위해 내용을 들고 있는다. 설정 파일은 작다 — 이 상한을 넘으면 감시만 하고 원복은 못 한다.
const MAX_RESTORE_BYTES = 8 * 1024 * 1024;

/**
 * 감시 대상. `keys` 가 있으면 **그 최상위 키만** 보고 그 키만 부분 원복한다(나머지는 하네스 것).
 * 없으면 파일 전체를 본다 — 하네스가 스스로 갱신하지 않는 파일에만 쓴다.
 *
 * 경로 정본은 kit/hooks/harness-registry.mjs 의 HARNESS[*].home/configFile 이다(여기선 그 결과만 나열 —
 *  이 파일은 발행 번들 밖 러너 전용이라 정적 import 를 걸지 않는다. 레지스트리가 바뀌면 여기도 맞춘다).
 * ⚠ 사용자 env 로 위치가 바뀌는 하네스(claude=CLAUDE_CONFIG_DIR · opencode=XDG_CONFIG_HOME · grok=GROK_HOME)는
 *  **실행 환경의 그 값**도 함께 본다. 테스트가 그 변수를 상속시켜 뚫는 게 정확히 #1786 의 경로였다.
 */
export function watchedTargets(env = process.env, home = homedir()) {
  const xdg = String(env.XDG_CONFIG_HOME || "").trim() || join(home, ".config");
  const grok = String(env.GROK_HOME || "").trim() || join(home, ".grok");
  // claude 설정 JSON 이 표적으로 삼는 키 — 세 사고가 전부 이 둘이었다.
  //  mcpServers: MCP 등록(#1593·2026-08-20) · hooks: 훅 배선(#1786) · permissions: 자동승인 규칙.
  const CLAUDE_JSON_KEYS = ["mcpServers"];
  const CLAUDE_SETTINGS_KEYS = ["hooks", "permissions"];
  const t = [
    { path: join(home, ".claude.json"), keys: CLAUDE_JSON_KEYS },
    { path: join(home, ".claude", "settings.json"), keys: CLAUDE_SETTINGS_KEYS },
    { path: join(home, ".claude", "settings.local.json"), keys: CLAUDE_SETTINGS_KEYS },
    // 아래는 하네스가 스스로 갱신하지 않는 설정·배선 파일 — 전체 비교.
    { path: join(home, ".codex", "config.toml") },
    { path: join(home, ".codex", "AGENTS.md") },
    { path: join(xdg, "opencode", "opencode.json") },
    { path: join(home, ".gemini", "config", "hooks.json") },
    { path: join(home, ".gemini", "config", "plugins", "lively", "mcp_config.json") },
    { path: join(home, ".gemini", "antigravity-cli", "settings.json") },
    { path: join(grok, "config.toml") },
    { path: join(home, ".lively", "token") },
    { path: join(home, ".lively", "gateway-url") },
    { path: join(home, ".lively", "mcp-servers.json") },
    { path: join(home, ".lively", "hooks-config.json") },
    { path: join(home, ".lively", "kit-version") },
  ];
  const ccd = String(env.CLAUDE_CONFIG_DIR || "").trim();
  if (ccd) t.push(
    { path: join(ccd, ".claude.json"), keys: CLAUDE_JSON_KEYS },
    { path: join(ccd, "settings.json"), keys: CLAUDE_SETTINGS_KEYS },
  );
  // 같은 파일을 두 번 보지 않는다(CCD 가 ~/.claude 인 흔한 배치).
  const seen = new Set();
  return t.filter(({ path }) => !seen.has(path) && seen.add(path));
}

// 감시 대상의 상태. keys 가 있으면 그 키들만 뽑아 정규화한 문자열로 본다.
//  없으면 exists:false 로 **없다는 사실도 기록**한다(테스트가 없던 파일을 새로 만드는 것도 오염이다).
function readState({ path: p, keys }) {
  try {
    if (!existsSync(p)) return { exists: false };
    const size = statSync(p).size;
    if (size > MAX_RESTORE_BYTES) return { exists: true, size, big: true };
    const data = readFileSync(p);
    if (!keys) return { exists: true, size, data };
    // 부분 감시 — 파싱 실패(잘린 파일 등)면 전체 비교로 안전 폴백.
    try {
      const o = JSON.parse(data.toString("utf8"));
      const picked = {};
      for (const k of keys) if (Object.prototype.hasOwnProperty.call(o, k)) picked[k] = o[k];
      return { exists: true, size, keys, picked, view: JSON.stringify(picked) };
    } catch { return { exists: true, size, data }; }
  } catch (e) {
    // 읽기 실패(권한 등)는 감시 포기 — 가드가 테스트를 깨뜨리면 안 된다.
    return { unreadable: String(e?.message || e) };
  }
}

export function snapshotRealHome(env = process.env, home = homedir()) {
  const snap = new Map();
  for (const t of watchedTargets(env, home)) snap.set(t.path, { target: t, state: readState(t) });
  return snap;
}

const same = (a, b) => {
  if (a.unreadable || b.unreadable) return true;          // 감시 포기한 항목은 판정하지 않는다
  if (a.exists !== b.exists) return false;
  if (!a.exists) return true;
  if (a.big || b.big) return a.size === b.size;           // 큰 파일은 크기로만(원복 불가 — 아래서 표시)
  if (a.view !== undefined || b.view !== undefined) return a.view === b.view;
  if (!a.data || !b.data) return false;                   // 한쪽만 부분뷰 → 형태가 바뀐 것
  return Buffer.compare(a.data, b.data) === 0;
};

/**
 * 스냅샷 이후 바뀐 감시 대상을 찾아 **되돌린다**.
 * 부분 감시(keys)면 **그 키만** 되돌리고 나머지는 현재 파일 것을 그대로 둔다 — 하네스가 그 사이
 * 정상 갱신한 내용을 가드가 지우지 않게.
 * @returns {Array<{path:string, change:string, restored:boolean, why?:string, keys?:string[]}>}
 */
export function verifyRealHome(snap, { restore = true } = {}) {
  const changes = [];
  for (const [p, { target, state: before }] of snap) {
    const after = readState(target);
    if (same(before, after)) continue;

    const change = !before.exists ? "생성됨" : !after.exists ? "삭제됨" : "수정됨";
    const rec = { path: p, change, restored: false };
    if (target.keys) rec.keys = target.keys;

    if (!restore) { changes.push(rec); continue; }
    if (before.big || after.big) {
      rec.why = `${MAX_RESTORE_BYTES} 바이트 초과 — 내용을 들고 있지 않아 원복 불가`;
      changes.push(rec);
      continue;
    }
    if (!before.exists) {
      // 테스트가 새로 만든 파일 — 지우는 게 원상복구지만, 가드가 사람 파일을 지우지는 않는다
      //  (그 사이 사람이 만들었을 수도 있다). 알리기만 한다.
      rec.why = "스냅샷 시점엔 없던 파일 — 가드는 삭제하지 않는다(직접 확인 필요)";
      changes.push(rec);
      continue;
    }
    try {
      mkdirSync(dirname(p), { recursive: true });
      if (before.picked && after.exists && !after.data) {
        // 부분 원복 — 현재 파일을 읽어 감시 키만 스냅샷 값으로 되돌린다.
        const cur = JSON.parse(readFileSync(p, "utf8"));
        for (const k of target.keys) {
          if (Object.prototype.hasOwnProperty.call(before.picked, k)) cur[k] = before.picked[k];
          else delete cur[k];                              // 스냅샷 때 없던 키는 지운다(테스트가 만든 것)
        }
        writeFileSync(p, JSON.stringify(cur, null, 2) + "\n");
      } else if (before.data) {
        writeFileSync(p, before.data);
      } else {
        rec.why = "스냅샷에 원복할 내용이 없다";
        changes.push(rec);
        continue;
      }
      rec.restored = true;
    } catch (e) {
      rec.why = `원복 실패: ${String(e?.message || e)}`;
    }
    changes.push(rec);
  }
  return changes;
}

// 사람이 읽을 보고문 — 러너가 실패 보고에 그대로 싣는다.
export function formatChanges(changes) {
  const lines = [
    "",
    "✗ 테스트가 **실행한 사람의 실제 설정**을 건드렸습니다 (테스트 격리 실패).",
    "  테스트는 mkdtemp 샌드박스 안에서만 써야 합니다. 자식 프로세스를 띄울 때",
    "  kit/testlib/os-sandbox.mjs 의 sandboxEnv({home,tmp}) 로 HOME·USERPROFILE·TMPDIR 를 함께 돌리고,",
    "  CLAUDE_CONFIG_DIR 도 샌드박스 안 값으로 **명시**하세요(상속시키면 실 프로필이 이깁니다 — #1786).",
    "",
  ];
  for (const c of changes) {
    const scope = c.keys ? ` [${c.keys.join("·")}]` : "";
    lines.push(`  · ${c.path}${scope} — ${c.change}${c.restored ? " → 원복함" : ""}`);
    if (c.why) lines.push(`      ⚠ ${c.why}`);
  }
  lines.push("");
  return lines.join("\n");
}
