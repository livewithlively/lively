// ─────────────────────────────────────────────────────────────────────────────
// 세션 env 허용목록 — **단일 출처** (#2599 T1)
//
// ── 무엇을 소유하나 ──────────────────────────────────────────────────────────
//  «게이트웨이가 세션 프로세스에 실어 보내는 env 중, sudo 경계(격리 분기)를 **넘어가야 하는 것**은
//   무엇인가». 그 목록 하나와, 그 목록으로부터 `deploy/linux/sudoers-lively` 의 `env_keep` 두 줄을
//   **생성**하는 렌더러다.
//
// ── 왜 생겼나 (2026-09-03 실측) ──────────────────────────────────────────────
//  코어는 tmux `-e` 로 pane env 를 싣고, 셀프호스트 리눅스 격리에서는 그 pane 이 곧
//   `sudo -n -u box_<slug> -- box-spawn …` 이다. sudo 는 기본 `env_reset` 이라 sudoers 가 **명시
//   보존**하지 않은 변수는 그 자리에서 사라진다 — 오류 없이, 로그도 없이.
//  종전엔 「코어가 무엇을 싣나」와 「sudoers 가 무엇을 통과시키나」를 **사람이 손으로 대조**했고,
//   그 대조를 강제하는 장치가 없었다. T0 조사(exec-topology-branch-map-2601 §4)가 그 대가를 셌다 —
//   조용히 사라지던 변수가 **6부류**였다:
//     ① LIVELY_SESSION_KIND — #2162 가 «훅이 읽는 유일한 종류 신호» 라고 못박은 값. 격리 세션에선
//        훅이 다시 LIVELY_TASK_WS 스니핑으로 되돌아간다.
//     ② COLORFGBG·LIVELY_THEME·OPENCODE_CONFIG_CONTENT — 격리 세션에서 테마(#1683)가 안 걸린다.
//     ③ LVLY_TENANT_SLUG — pane 안의 훅이 워크스페이스 소속을 잃고 **primary 로 폴백**한다(#1437).
//     ④ 공유 빌드 캐시 11+2종 — #813 T3 이 «격리로 갈린 홈들의 캐시 중복을 접는다» 고 한 바로 그
//        표면에서만 안 걸렸다. 값이 경로(`/` 포함)라 sudo 의 env_check 로는 절대 안 넘어온다.
//     ⑤ LIVELY_TASK_WS·LIVELY_TASK_ID — 위탁 배치(node/tasks.ts)도 중앙 박스에선 wrapAsMember 를
//        탄다. T0 표엔 없던 자리다(이 모듈을 세우다 드러났다).
//     ⑥ 하네스 자격 리스(task-scheduler LEASE_SECRET) — 지금은 claude 하나뿐이라 우연히 맞지만,
//        표에 하네스를 더하면 그 env 는 아무도 안 보는 채로 격리에서만 죽는다.
//  전부 «무증상» 이다. 세션은 그대로 뜨고 기능만 조용히 하나씩 빠진다.
//
// ── 왜 «생성물» 인가 (kit/setup/kit-manifest.mjs #2153 의 선례) ──────────────
//  목록이 두 벌이면 대조는 규율이 되고, 규율은 사람이 지키다 만다. 목록을 여기 한 곳에 두고
//   sudoers 의 env_keep 줄은 **여기서 렌더한 생성물**로 만든다 → 두 목록의 diff 가 정의상 0 이다.
//  ⚠ 생성 시점은 «설치» 가 아니라 «커밋» 이다. 설치기(install-isolation.sh)는 node 로 목록을 물어보지
//   않고 체크인된 파일을 그대로 깐다 — ⓐ `visudo -cf` 로 검증할 실체 파일이 리뷰에 보이고 ⓑ 설치
//   경로에 새 실패 모드(빌드 산출물 의존)를 만들지 않는다. 대신 `session-env-contract.test.ts` 가
//   「체크인된 파일 == 지금 렌더한 값」을 시험으로 강제한다. 재생성은 `npm run gen:sudoers`.
//
// ── 여기 없는 것 ─────────────────────────────────────────────────────────────
//  · env 의 **값**과 PATH 조립 — 그건 `deploy/linux/session-env.sh`(#2258 이동 2)가 정본이다.
//    이 모듈은 «어느 이름이 sudo 를 넘는가» 만 소유한다. 두 파일은 층이 다르다(통과 vs 조립).
//  · 매니지드·비격리 표면 — 둘 다 sudo 를 안 탄다(매니지드 판 명령은 box-spawn 직행,
//    session-tmux.ts sessionPaneArgv). 그래서 이 목록은 그 표면들의 동작을 **바꾸지 않는다**.
//  · provision-member Cmnd 의 env_keep — 세션이 아니라 프로비저닝 인자다(LIVELY_TOKEN·MEMBER_*).
//    같은 파일에 있지만 다른 계약이라 손대지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

/** 이 이름이 sudo 경계에서 어떻게 다뤄지는가. */
export type KeepPolicy =
  /** sudoers env_keep 에 **반드시** 있어야 한다(코어가 싣고, 격리 세션이 받아야 하는 값). */
  | "keep"
  /** sudo 자신의 기본 처리(env_check)가 보존한다 — 우리가 env_keep 에 **일부러 안 넣는다**. */
  | "sudo-default"
  /** env_keep 에 **있으면 안 된다**(비격리 전용 값이거나, 보존이 곧 경계 침식인 제어 변수). */
  | "never";

export interface SessionEnvGroup {
  /** 사람이 읽는 축 이름(생성 주석의 소제목). */
  title: string;
  names: readonly string[];
  keep: KeepPolicy;
  /** 왜 이 정책인가 — 생성되는 sudoers 주석의 본문. 한 줄로 끝내지 말고 근거(이슈·증상)를 적는다. */
  why: string;
  /** 값이 비밀인가. keep 인 비밀은 `secretWhy` 로 근거를 남겨야 한다(시험이 강제). */
  secret?: boolean;
  secretWhy?: string;
}

/** 이 허용목록이 걸리는 sudoers Cmnd — 세션 spawn 경로 둘. 목록은 **항상 동일**해야 한다:
 *  캡 세션은 box-cgspawn 을 경유하고 비캡 세션은 box-spawn 직행이라, 한쪽에만 있으면 두 세션의 env 가 갈린다.
 *  (box-cgspawn 이 먼저 받은 env 를 systemd-run --scope 가 상속해 box-spawn 까지 흘린다 — box-cgspawn 헤더 참조.) */
export const KEEP_CMNDS = [
  "/opt/lively/libexec/box-spawn",
  "/opt/lively/libexec/box-cgspawn",
] as const;

// ── 목록 본체 ────────────────────────────────────────────────────────────────
//  선언 순서가 곧 렌더 순서다(집합이 같아도 diff 가 튀지 않게 결정적으로).
export const SESSION_ENV_GROUPS: readonly SessionEnvGroup[] = [
  {
    title: "로케일",
    names: ["LANG", "LC_ALL", "LC_CTYPE"],
    keep: "sudo-default",
    why:
      "sudo 가 자기 기본 env_check 로 보존한다(값에 '/'·'%' 가 없을 때). env_keep 에 넣으면 그 검사를 " +
      "**우회**하게 되는데 얻는 게 없다 — 못 넘어와도 session-env.sh ③ 이 C.UTF-8 을 깔아 준다(이중 안전망). " +
      "값의 출처는 catalog.ts PANE_LOCALE(#633).",
  },
  {
    title: "조직 시간대",
    names: ["TZ"],
    keep: "keep",
    why:
      "#778 — pane(셸·하네스)이 조직 시간대의 로컬 시각을 보게 한다. 박스 OS TZ 는 대개 UTC 라 " +
      "미보존이면 크레딧 리셋 안내 등이 UTC 로 뜬다. 비밀 아님·권한확대 아님.",
  },
  {
    title: "세션 신원",
    names: ["LIVELY_SESSION_ID"],
    keep: "keep",
    why:
      "#852 — 이 pane 이 어느 터미널 세션인지. 하네스가 MCP 헤더 x-lively-session 으로 되보내 게이트웨이가 " +
      "작업의 세션을 자동 기록한다. 세션 id 는 게이트웨이가 만든 공개 식별자라 비밀 아님 — 입장 권한은 따로 본다.",
  },
  {
    title: "세션 종류",
    names: ["LIVELY_SESSION_KIND"],
    keep: "keep",
    why:
      "#2162 — **훅이 읽는 유일한 종류 신호**(chat|task|managed|app). 미보존이면 격리 세션에서만 훅이 " +
      "LIVELY_TASK_WS(제 뜻이 따로 있는 값) 스니핑으로 되돌아간다. 라벨일 뿐이라 비밀·권한과 무관.",
  },
  {
    title: "워크스페이스 소속",
    names: ["LVLY_TENANT_SLUG"],
    keep: "keep",
    why:
      "#1437 v1 5단계 — pane 안의 훅이 x-lively-workspace 헤더로 되보내는 소속. 미보존이면 헤더가 빈 값으로 " +
      "확장돼 **primary 로 폴백**한다(남의 워크스페이스에 쓰는 게 아니라, 자기 워크스페이스를 잃는다). " +
      "슬러그는 공개 식별자라 비밀 아님. 단일 테넌트 배포에서는 코어가 아예 안 싣는다(무회귀).",
  },
  {
    title: "실행 모드",
    names: ["LIVELY_MODE", "LIVELY_READONLY", "LIVELY_INCOGNITO", "LIVELY_OFF"],
    keep: "keep",
    why:
      "#1007+ — 이 세션의 실행 모드. 하네스가 MCP 헤더 x-lively-mode 로 되보내 게이트웨이가 쓰기 툴 소거" +
      "(readonly)·전체 차단(incognito)을 강제한다. **권한을 넓히는 게 아니라 좁히는** 플래그라 보존이 안전하고, " +
      "오히려 미보존이 fail-open 이다. LIVELY_READONLY/INCOGNITO 는 전이기 dual-env(#1021 에서 함께 제거), " +
      "LIVELY_OFF 는 incognito 가 훅까지 끄는 플래그.",
  },
  {
    title: "앱 세션",
    names: ["LIVELY_HOME", "LIVELY_APP_ID"],
    keep: "keep",
    why:
      "#1780 D3 — LIVELY_HOME 은 프록시가 앱 토큰 파일을 찾는 뿌리, LIVELY_APP_ID 는 귀속(x-lively-app → " +
      "mcp_call_log.app). 경로와 식별자라 비밀 아님(토큰 자체는 그 홈의 파일에 있고 uid 로 격리된다).",
  },
  {
    title: "공유 빌드 캐시",
    names: [
      "npm_config_cache",
      "npm_config_store_dir",
      "YARN_CACHE_FOLDER",
      "PIP_CACHE_DIR",
      "UV_CACHE_DIR",
      "GOMODCACHE",
      "GOCACHE",
      "COMPOSER_CACHE_DIR",
      "NUGET_PACKAGES",
      "MAVEN_ARGS",
    ],
    keep: "keep",
    why:
      "#813 T3 — 생태계별 캐시를 박스 전역 한 곳(공유 워크스페이스 .cache)으로. **격리로 갈린 멤버 홈들의 " +
      "캐시 중복을 접는 것이 목적의 절반**인데 정작 격리 표면에서만 안 걸렸다. 값이 경로라 '/' 를 포함 → " +
      "sudo 의 env_check 로는 절대 안 넘어오고 env_keep 이 유일한 통로다. 값은 게이트웨이가 정한 " +
      "공유 캐시 루트 하위이고(ops/build-cache.ts safeCacheEnv), 관리탭에서 끄면 코어가 아예 안 싣는다.",
  },
  {
    title: "공유 빌드 캐시(홈 이전, opt-in)",
    names: ["GRADLE_USER_HOME", "CARGO_HOME"],
    keep: "keep",
    why:
      "#813 T3 opt-in(기본 꺼짐) — 캐시뿐 아니라 설정·자격증명 자리까지 옮기는 두 변수라 관리탭 토글로만 켜진다" +
      "(ops/build-cache.ts homeRelocateEnv). 켜 놓고 격리에서만 안 걸리면 «켰는데 그 표면만 다르게 도는» " +
      "가장 나쁜 모양이 되므로 목록에 함께 둔다. 꺼져 있으면 코어가 안 싣는다(보존해도 존재하지 않는 값).",
  },
  {
    title: "위탁 배치 좌표",
    names: ["LIVELY_TASK_WS", "LIVELY_TASK_ID"],
    keep: "keep",
    why:
      "위탁 배치(node/tasks.ts)는 createSession 을 안 타는 두 번째 문인데, 중앙 박스에서는 그 판도 " +
      "wrapAsMember(sudo → box-spawn)를 탄다. 작업 폴더 경로와 태스크 번호라 비밀 아님. " +
      "미보존이면 격리 중앙 박스의 위탁 세션만 자기 좌표를 잃는다.",
  },
  {
    title: "브로커 설정",
    names: [
      "LIVELY_BROKER_SOCKET",
      "LIVELY_BROKER_MEMBER",
      "LIVELY_BROKER_WORKROOT",
      "LIVELY_BROKER_ALLOWED_TOOLS",
      "LIVELY_BROKER_INTERNAL_HOSTS",
      "LIVELY_BROKER_ENTRY",
    ],
    keep: "keep",
    why:
      "#746 T4 — 브로커도 같은 box-spawn Cmnd 로 broker_<slug> 에서 뜬다(broker/route.ts defaultBrokerSpawner). " +
      "소켓 경로·멤버·workroot·허용 도구·내부 host·진입 js. 전부 설정값이라 비밀 아님(무엇을 실행할지는 " +
      "env 가 아니라 argv 가 정한다 — brokerSpawnArgv).",
  },
  {
    title: "브로커 인증 토큰",
    names: ["LIVELY_BROKER_AUTH"],
    keep: "keep",
    why:
      "#746 T4 — per-broker HMAC. 브로커가 요청을 검증해 **크로스-멤버 호출을 막는** 값이다(broker/route.ts). " +
      "미보존이면 브로커가 토큰 없이 떠 검증이 사라진다 = fail-open.",
    secret: true,
    secretWhy:
      "값은 그 멤버 전용이고 강하 대상 uid 도 그 멤버라 /proc/<pid>/environ 은 그 uid·root 만 읽는다. " +
      "provision-member Cmnd 의 LIVELY_TOKEN 과 같은 선례이며, 이 Cmnd 에만 걸린 보존이다.",
  },
  {
    title: "자격 리스",
    names: ["CLAUDE_CODE_OAUTH_TOKEN"],
    keep: "keep",
    why:
      "#1289 — 위탁 태스크의 자격 리스. 보존하지 않으면 sudo env_reset 이 지워 하네스가 디스크 로그인 자격으로 " +
      "**조용히 폴백**한다 → 등록한 계정이 아니라 박스에 /login 된 계정의 크레딧이 소모된다(무증상. 고객사 A 실측). " +
      "⚠ 하네스별 리스 표(node/task-scheduler.ts LEASE_SECRET)에 항목을 더하면 그 env 이름을 여기 함께 더해야 " +
      "한다 — 시험이 그 누락을 잡는다.",
    secret: true,
    secretWhy:
      "권한확대 아님: 값은 **의뢰자 본인의** 자격이고 강하 대상 uid 도 의뢰자 본인 박스유저다 " +
      "(/proc/<pid>/environ 은 그 uid·root 만 읽는다). 이 Cmnd 에만 걸린 보존이다.",
  },
  {
    title: "화면 테마",
    names: ["COLORFGBG", "LIVELY_THEME", "OPENCODE_CONFIG_CONTENT"],
    keep: "keep",
    why:
      "#1683 — 터미널이 앱에게 배경색을 알려주는 표준 통로(COLORFGBG)와 우리 훅·스킬이 읽는 명시 값(LIVELY_THEME), " +
      "그리고 실행 시점 테마 주입 수단이 env 뿐인 하네스(opencode 의 OPENCODE_CONFIG_CONTENT — 값은 " +
      "`{\"theme\":\"dark|light\"}` JSON). 미보존이면 격리 세션에서만 테마가 안 걸린다. " +
      "⚠ 하네스 테마 표(catalog.ts HARNESS_THEME)에 env 방식 하네스를 더하면 여기 함께 더한다(시험이 강제).",
  },
  {
    title: "비격리 전용 — 보존 금지",
    names: ["CLAUDE_CONFIG_DIR", "LIVELY_TOKEN", "LIVELY_MCP_TOKEN"],
    keep: "never",
    why:
      "셋 다 코어가 **비격리 분기에서만** 싣는다(sessions.ts else). 격리 세션은 uid 로 홈이 갈려 이 값들이 " +
      "필요 없다 — CLAUDE_CONFIG_DIR 은 멤버 자기 $HOME/.claude 로 네이티브 격리(#346 흡수), LIVELY_TOKEN 은 " +
      "멤버 홈의 ~/.lively/token 을 session-env.sh ⑥ 이 읽는다. " +
      "LIVELY_MCP_TOKEN(#2234)은 **결함이 아니라 설계 차이**다(T0 판정): 격리 세션의 MCP 는 그 멤버 홈의 공유 " +
      "토큰으로 나가므로 «남의 신원» 사고는 구조적으로 안 나고(그 홈이 이미 그 멤버 것), 잃는 것은 세션 바인딩된 " +
      "최소권한 토큰뿐이며 세션 귀속은 LIVELY_SESSION_ID 헤더가 따로 살아 있다. " +
      "⚠ 여기 있는 이름을 env_keep 으로 옮기지 마라 — 옮기면 비격리용 값이 격리 세션의 멤버 홈 자격과 겹쳐 " +
      "«어느 신원으로 나갔나» 가 다시 두 갈래가 된다.",
  },
  {
    title: "래퍼 제어 변수 — 보존 금지(경계)",
    names: ["LVLY_SESSION_ENV_LIB", "LIVELY_BOX_SPAWN", "LIVELY_SESSIONS_SLICE"],
    keep: "never",
    why:
      "⚠ 이 셋은 래퍼 **자신이 읽는** 값이다: box-spawn 이 source 할 계약 파일(LVLY_SESSION_ENV_LIB), " +
      "box-cgspawn 이 exec 을 허용할 고정 경로(LIVELY_BOX_SPAWN), 그 scope 의 슬라이스(LIVELY_SESSIONS_SLICE). " +
      "env_keep 에 넣으면 sudo 경계 **너머로 실행 대상을 갈아끼울 수 있다** — 로컬 시험용 노브가 권한 경계의 " +
      "구멍이 된다. 지금 목록에 없고, 앞으로도 없어야 한다(시험이 못박는다).",
  },
];

// ── 조회 ─────────────────────────────────────────────────────────────────────

/** env_keep 에 실릴 이름들 — 선언 순서 그대로(렌더 결정성). */
export function sudoersEnvKeep(): string[] {
  return SESSION_ENV_GROUPS.filter((g) => g.keep === "keep").flatMap((g) => [...g.names]);
}

/** 이 이름의 정책. 계약에 없으면 undefined — 시험은 그걸 «선언되지 않은 주입» 으로 본다. */
export function envKeepPolicy(name: string): KeepPolicy | undefined {
  return SESSION_ENV_GROUPS.find((g) => g.names.includes(name))?.keep;
}

/** 계약이 아는 모든 이름. */
export function declaredEnvNames(): string[] {
  return SESSION_ENV_GROUPS.flatMap((g) => [...g.names]);
}

// ── 렌더 ─────────────────────────────────────────────────────────────────────

export const SUDOERS_BEGIN = "# >>> GENERATED: 세션 env 허용목록 — 손으로 고치지 마라";
export const SUDOERS_END = "# <<< GENERATED";

/** 본문을 고정 들여쓰기로 접는다(생성물이 읽히게 — 제목 길이에 따라 우측이 밀리지 않도록 매달린 들여쓰기를 안 쓴다). */
function wrapComment(text: string, indent = "#      ", width = 116): string[] {
  const out: string[] = [];
  let line = indent;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line.length > indent.length && line.length + 1 + word.length > width) {
      out.push(line);
      line = `${indent}${word}`;
    } else {
      line = line.length > indent.length ? `${line} ${word}` : `${line}${word}`;
    }
  }
  out.push(line);
  return out;
}

/** sudoers 의 생성 구역 — 마커 두 줄 사이의 전부. */
export function renderSudoersEnvKeepBlock(): string {
  const keep = sudoersEnvKeep();
  const lines: string[] = [SUDOERS_BEGIN];
  lines.push(
    "#  출처: src/terminal/session-env-contract.ts · 재생성: npm run gen:sudoers",
    "#  이 구역은 코어가 세션 pane 에 싣는 목록에서 **생성**된다 — 그래서 「주입목록 ⊆ 허용목록」 diff 가 정의상 0 이다.",
    "#  종전엔 두 목록을 사람이 손으로 대조했고, 그 대조가 빠진 자리에서 변수 6부류가 무증상으로 사라지고 있었다",
    "#  (#2599 T0 조사). 항목을 더하거나 뺄 땐 그 모듈을 고치고 재생성하라 — 이 줄을 직접 고치면 시험이 막는다.",
    "#  두 Cmnd 의 목록은 **항상 동일**하다(캡 세션은 box-cgspawn 경유, 비캡은 box-spawn 직행 — 갈리면 두 세션의 env 가 갈린다).",
    "#",
  );
  for (const g of SESSION_ENV_GROUPS) {
    lines.push(`#  ${g.keep === "keep" ? "▸" : "✖"} ${g.title}${g.keep === "keep" ? "" : `  [${g.keep}]`}`);
    lines.push(...wrapComment(g.names.join(" ")));
    lines.push(...wrapComment(g.why));
    if (g.secret) lines.push(...wrapComment(`⚠ 비밀값 — ${g.secretWhy ?? ""}`));
    lines.push("#");
  }
  for (const cmnd of KEEP_CMNDS) lines.push(`Defaults!${cmnd} env_keep += "${keep.join(" ")}"`);
  lines.push(SUDOERS_END);
  return lines.join("\n");
}

/** 체크인된 sudoers 텍스트의 생성 구역을 지금 렌더한 값으로 갈아끼운다.
 *  마커가 없으면 던진다 — 조용히 «아무것도 안 함» 으로 끝나면 검사도 생성도 무음이 된다(kit-manifest §isDirectRun 의 교훈). */
export function spliceSudoers(text: string, block: string = renderSudoersEnvKeepBlock()): string {
  const lines = text.split("\n");
  const from = lines.indexOf(SUDOERS_BEGIN);
  const to = lines.indexOf(SUDOERS_END);
  if (from < 0 || to < 0 || to < from) {
    throw new Error(
      `sudoers 에서 생성 구역 마커를 못 찾았다(begin=${from} end=${to}) — 마커를 지우면 허용목록이 생성물이 아니게 된다`,
    );
  }
  //  ⚠ 구역이 둘이면 **여기서 죽는다.** indexOf 는 첫 짝만 찾으므로, 잘못된 병합으로 블록이 두 벌 남으면
  //   앞의 것만 갱신하고 뒤의 것은 옛 목록인 채로 남는다 — 그리고 sudoers 는 나중 줄이 이기므로
  //   «재생성했는데 옛 허용목록이 실효» 가 된다. 이 모듈의 원칙(조용히 통과하지 않는다)을 호출자 전부가
  //   받게 하려고 시험이 아니라 여기에 둔다.
  if (lines.indexOf(SUDOERS_BEGIN) !== lines.lastIndexOf(SUDOERS_BEGIN)
    || lines.indexOf(SUDOERS_END) !== lines.lastIndexOf(SUDOERS_END)) {
    throw new Error("sudoers 에 생성 구역이 둘 이상이다 — 병합 사고다. 하나만 남기고 다시 생성하라");
  }
  return [...lines.slice(0, from), ...block.split("\n"), ...lines.slice(to + 1)].join("\n");
}
