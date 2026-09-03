// 멤버 홈 키트 시딩 — **중계 배포(LIVELY_MEMBER_EXEC) 전용** 첫 세션 lazy 시딩. (#1437 §21-3)
//
//  ── 왜 ──
//  로컬 격리 박스에서는 provision-member.sh(sudo, useradd 경로)가 멤버 홈에 키트를 심는다:
//  `.lively/`(token·gateway-url·hooks·lib·context) + `~/.claude/settings.json`(훅) + lively MCP(멤버 토큰).
//  중계 배포에서는 그 경로가 **영영 안 불린다** — resolveMemberOsUser 가 즉시 osUser 를 돌려주므로
//  ensureMemberOsUser 의 lazy provision 분기(provisionMemberOs)에 들어가지 않고, 멤버 홈은 세션 스폰이
//  빈 채로 만든다(당시 매니지드 spawn 훅 container-spawn 의 mkdir — #2547 에서 삭제, 지금은 브로커의 세션 컨테이너 확보가 그 자리). 결과: 훅이 없어 work-flag 가 대화 uuid 를 보고하지 못하고
//  대화창이 404 로 남는다(설계문서 §21-3 실측 — 파일 중계(§21-2)가 있어도 매핑이 없으면 못 읽는다).
//
//  ── 어떻게 ──
//  provision-member.sh 의 멤버 부분과 같은 산출물을 **memberSpawn seam 위에서** 만든다 — 실행은 그 테넌트의
//  tmux 컨테이너(테넌트 이미지 = node·claude CLI·tar 있음, /home 마운트) 안, 멤버 uid 로:
//   ① 멤버 토큰 민팅(mintCentralBoxToken — 로컬 프로비저닝과 같은 발급·회수 규율) → `.lively/token`(600, stdin 전달)
//   ② `.lively/gateway-url` = http://localhost:8080 — 훅이 실제로 도는 곳은 **세션 컨테이너**이고 거기선
//      loopback 포워더(session-loopback.cjs)가 그 주소를 게이트웨이로 나른다(E2E 의 'localhost 도달' 단언 그 자리).
//   ③ /install 번들(buildInstallBundle — 다운로드가 아니라 **바이트로 직접** 전달: tmux 컨테이너는 게이트웨이에
//      닿는 네트워크 경로가 보장되지 않는다) → user-install.mjs --harness claude + register-clients.sh
//      (둘 다 로컬 파일 쓰기 — 네트워크 불요. STORE_URL 도 ②와 같은 이유로 localhost).
//   ④ 마커 `.lively/.kit-seeded` — 다음 세션부터는 stat 1회로 끝(멱등).
//
//  ── 경계 ──
//  · best-effort: 실패해도 세션 생성을 막지 않는다(git materialize 와 같은 규율) — 키트 없는 세션은 종전과
//    동일하게 뜨고, 다음 세션 생성이 재시도한다(마커는 성공 시에만).
//  · 시크릿(토큰)은 argv 가 아니라 **stdin** 으로만(terminal-member-fs 규율 — ps/argv 노출 없음).
//  · 재시딩(번들 갱신 추종)은 후속 — 마커가 있으면 건너뛴다. 훅 '내용'의 라이브 갱신은 세션 프리로드가
//    매 세션 게이트웨이에서 받아오므로(context fetch) 정체되는 건 배선(settings.json·hooks 파일)뿐이다.
import { Readable } from "node:stream";
import path from "node:path";
import { memberExecConfigured } from "./terminal-isolation.js";
import { memberSh, memberStat, memberWriteFrom } from "./terminal-member-fs.js";
import { mintCentralBoxToken, userSlug, ownerId } from "./profiles.js";
import { gatewayCapability } from "../sessions/gateway-capabilities.js";   // #2165 — DB·번들 생성은 게이트웨이 능력이다
import { MEMBER_HOME_BASE } from "./terminal-transcript.js";
import type { LivelyUser } from "../context.js";
import { logger } from "../log.js";

const MARKER = ".lively/.kit-seeded";
const BUNDLE_TMP = ".lively/kit-bundle.tgz";
const BUNDLE_MAX_BYTES = 64 * 1024 * 1024;
const SEED_TIMEOUT_MS = 90_000;

// 프로세스 내 1회 판정 — 같은 멤버의 동시 세션 생성이 시딩을 두 번 돌리지 않게(성공 여부와 무관하게
//  in-flight 는 공유, 성공만 seeded 에 남는다 — 실패는 다음 생성이 다시 시도).
const seeded = new Set<string>();
const inflight = new Map<string, Promise<void>>();

/** 홈 경로(실행 환경 기준) — provision-member 와 같은 규약(/home/box_<slug>). 베이스는 terminal-transcript 의
 *  MEMBER_HOME_BASE seam 을 공유(기본 /home · 테스트가 LIVELY_MEMBER_HOME_BASE 로 옮긴다). */
const homeOf = (osUser: string): string => path.posix.join(MEMBER_HOME_BASE, osUser);

/** 시딩에 필요한 바깥 의존(테스트 주입용) — 판정·순서는 이 모듈이, 데이터는 이들이. */
export interface KitSeedDeps {
  getMember: (id: string) => Promise<{ scopes?: string[] | null } | null>;
  mintToken: (memberId: string, scopes: string[], slug: string) => Promise<string>;
  buildBundle: () => Promise<Buffer>;
}
//  #2165 — `getMember`(DB)·`buildInstallBundle`(설치 번들 생성)은 **게이트웨이 능력**으로 받는다.
//   종전엔 여기서 정적 import 했는데, 이 모듈은 `terminal/sessions.ts` 를 통해 노드 에이전트 번들에 들어가므로
//   `org/store`·`org/delivery/*`·`v6/team-store` 가 통째로 멤버 PC 로 나갔다. 노드에선 어차피
//   `memberExecConfigured()` 가 false 라 시딩이 시작도 안 된다(= 죽은 코드가 무게만 실었다).
//   `mintCentralBoxToken` 은 terminal 로컬이라 그대로 둔다.
// #1884 — claude·codex 양쪽 배선(하네스 패리티 불변식 ②). 종전엔 claude 만 심어 매니지드 codex 세션은 MCP·훅·대화 uuid
//  매핑이 통째로 없었다(대화창 404). 발행은 다중 하네스 스펙("claude,codex")을 받는다(generator dispatchEmit).
function registryDeps(): KitSeedDeps | null {
  const d = gatewayCapability("kitSeedDeps");
  if (!d) return null;
  return {
    getMember: d.getMember,
    // #2174 — 종전엔 여기서 4번째 인자로 `false`(관리 권한 제외)를 **하드코딩**했다. 그래서 관리탭에서
    //  '관리 권한 포함'을 켜도 매니지드 박스의 멤버 홈에 심기는 토큰은 언제나 admin 이 빠진 것이었다
    //  (2026-08-28 실측: 체크하고 재프로비저닝해도 세션 whoami 의 scopes 에 admin 이 끝내 안 붙었다).
    //  이제 mintCentralBoxToken 이 멤버 추종으로 굽으므로 실을지 말지를 여기서 정하지 않는다 — 그 토큰의
    //  유효권한은 쓰는 시점의 멤버 scope 다.
    mintToken: (memberId, scopes, slug) => mintCentralBoxToken(memberId, scopes, slug),
    buildBundle: d.buildBundle,
  };
}
/** 멤버 홈에 배선할 하네스 — 테넌트 이미지가 싣는 바이너리와 같은 집합(lvly-cloud tenant-image/Dockerfile). 없는 하네스를
 *  적어도 설치기는 설정 파일만 쓰므로 해가 없지만(그 하네스를 띄우면 그때 catalog 의 미설치 안내), 있는 하네스를 빠뜨리면 조용히 반쪽이다. */
export const SEED_HARNESSES = "claude,codex";

// 설치 스크립트 — 고정 리터럴(값은 홈 경로뿐, osUser 는 slug 문자셋). tar·node·claude(·codex) 는 테넌트 이미지에 있다.
//  실패 시 어떤 단계였는지 stderr 로 남긴다(memberSh 가 에러 메시지로 전달).
export function installScript(home: string): string {
  return [
    `set -e`,
    `H="${home}"`,
    `export HOME="$H"`,
    `export LIVELY_TOKEN="$(cat "$H/.lively/token")"`,
    `K="$(mktemp -d)"`,
    `trap 'rm -rf "$K"' EXIT`,
    `tar -xzf "$H/${BUNDLE_TMP}" -C "$K"`,
    `[ -f "$K/setup/user-install.mjs" ] || { echo "번들에 user-install 없음" >&2; exit 1; }`,
    `node "$K/setup/user-install.mjs" --allow-host-effects --harness ${SEED_HARNESSES} >/dev/null`,
    `STORE_URL="http://localhost:8080/mcp" bash "$K/setup/register-clients.sh" >/dev/null`,
    `rm -f "$H/${BUNDLE_TMP}"`,
    // claude 첫 실행 안내를 미리 넘긴다 — **로그인과 별개의 화면**인데 사람에겐 «또 로그인하라» 로 보인다.
    //  실측 2026-08-28(매니지드, dabetai-68ca): 화면에서 인라인 로그인을 끝내(oauthAccount 바인딩 · 자격 유효)
    //  세션을 열었는데 Claude Code 가 첫 실행 순서(글자 스타일 → 로그인 방법 → 보안 안내)를 처음부터 보여 줬다.
    //  로그인을 터미널 밖으로 뺐으면 이 안내도 같이 치워야 «로그인이 끝났다» 가 사람 눈에도 사실이 된다.
    //  ⚠ 있는 값은 덮지 않는다(사람이 고른 테마·계정 정보를 건드리면 안 된다). 폴더 신뢰는 **손대지 않는다** —
    //   그건 사람이 할 보안 판단이라 첫 세션에서 한 번 묻는 게 맞다.
    `node -e 'const fs=require("fs"),p=process.env.HOME+"/.claude.json";let d={};try{d=JSON.parse(fs.readFileSync(p,"utf8"))}catch(_){};let ch=0;if(d.hasCompletedOnboarding===undefined){d.hasCompletedOnboarding=true;ch++}if(d.theme===undefined){d.theme="dark";ch++}if(ch)fs.writeFileSync(p,JSON.stringify(d))' || true`,
    `printf %s ok > "$H/${MARKER}"`,
  ].join("\n");
}

/**
 * 중계 배포에서 이 멤버의 홈 키트를 보장한다(멱등·best-effort). 로컬 격리/비격리 배포는 no-op —
 *  거긴 provision-member.sh 경로가 담당한다(이중 시딩 금지).
 */
export async function ensureMemberKitSeeded(user: LivelyUser, osUser: string, injected?: KitSeedDeps): Promise<void> {
  if (!memberExecConfigured() || !osUser) return;
  const deps = injected ?? registryDeps();
  if (!deps) return;   // 노드 — 게이트웨이 능력이 없다(여기까진 애초에 안 온다)
  const memberId = ownerId(user);
  if (!memberId || seeded.has(osUser)) return;
  let p = inflight.get(osUser);
  if (!p) {
    p = (async (): Promise<void> => {
      const home = homeOf(osUser);
      // 빠른 경로 — 이미 심겼다(재기동 후 첫 세션도 stat 1회로 끝).
      const mk = await memberStat(osUser, `${home}/${MARKER}`).catch(() => null);
      if (mk?.file) { seeded.add(osUser); return; }
      const member = await deps.getMember(memberId);
      if (!member) return; // 에이전트/비멤버 — 키트 대상 아님(로컬 lazy provision 과 같은 판정)
      logger.info({ osUser }, "멤버 홈 키트 시딩 시작(중계 배포 첫 세션)");
      // ① 토큰 — stdin 으로만. umask 077 → .lively 700 · token 600 (provision-member 와 동일 권한).
      const token = await deps.mintToken(memberId, member.scopes || [], userSlug(user));
      await memberSh(osUser, `umask 077; mkdir -p "${home}/.lively"; cat > "${home}/.lively/token"`, token);
      // ② gateway-url — 훅이 도는 세션 컨테이너의 loopback 포워더 주소(머리말 ②).
      await memberSh(osUser, `umask 077; printf %s "http://localhost:8080" > "${home}/.lively/gateway-url"`);
      // ③ 번들을 바이트로 밀어 넣고 멤버 uid 로 설치.
      const buffer = await deps.buildBundle();
      await memberWriteFrom(osUser, `${home}/${BUNDLE_TMP}`, Readable.from(buffer), BUNDLE_MAX_BYTES);
      await memberSh(osUser, installScript(home));
      seeded.add(osUser);
      logger.info({ osUser }, "멤버 홈 키트 시딩 완료(settings.json 훅 + lively MCP=멤버 토큰)");
    })();
    inflight.set(osUser, p);
    p.finally(() => inflight.delete(osUser)).catch(() => { /* 아래 caller catch 와 동일 — unhandled 방지 */ });
  }
  // 상한 — 시딩이 어떤 이유로든 매달리면 세션 생성까지 같이 매달린다. 상한 초과는 포기(best-effort)하되
  //  in-flight 는 계속 돌게 둔다(다음 세션은 마커/inflight 로 이어받는다).
  await Promise.race([
    p,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`키트 시딩 ${SEED_TIMEOUT_MS}ms 상한 초과`)), SEED_TIMEOUT_MS).unref()),
  ]);
}
