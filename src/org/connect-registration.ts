// 외부 앱 «앱 등록» 안내 — 한 벌(#4970). 회사가 앱을 쥐는 배포(셀프호스트)에서 B 길(라이블리 앱)의 «먼저 할 일».
//
//  왜 여기 한 곳인가: 같은 안내를 화면([외부 앱 연결] ▸ 그 앱 ▸ 앱 등록 칸)과 연결 스킬(liv-connect-<앱> 의 «앱 등록» 절)이 함께 쓴다.
//   두 벌로 두면 한쪽만 고쳐져 «화면은 A 를 누르라는데 AI 는 B 를 누르라» 가 된다. 스킬 본문은 조립할 때 이 데이터로 그린다
//   (connect-skills.ts), 화면은 org_connect_status 의 registration 칸으로 받는다.
//  비개발자가 혼자 끝까지 하는 것이 기준이다(상민님 2026-10-23) — 한 걸음에 한 가지, 누를 이름 그대로, 붙여 넣을 값은 미리 채워서.
//  값(비밀)은 늘 화면에 넣는다. 대화로 받는 것은 사람이 굳이 원할 때 경고 뒤에만(연결 스킬 공통 규칙 6).

/** 걸음 안의 자리표 — 화면은 실제 값(복사 단추)으로, 스킬은 «어느 칸의 값» 으로 바꿔 그린다. */
export type RegPlaceholder = "callback_url" | "gateway_url";

export interface RegStep {
  /** 사람 말 — 자리표는 {callback_url} · {gateway_url}. */
  text: string;
  /** 그 걸음에서 열 곳. kind=url 은 주소 그대로, slack_manifest 는 서버가 만든 «슬랙 앱 만들기» 링크(org_slack_app_manifest). */
  link?: { label: string; kind: "url"; url: string } | { label: string; kind: "slack_manifest" };
  /** 붙여 넣을 값 — 화면이 복사 단추로 보인다. */
  copy?: RegPlaceholder;
}

export interface RegField {
  key: "client_id" | "client_secret" | "app_id" | "app_slug" | "private_key";
  label: string;
  /** 비밀 — 저장 뒤 다시 보이지 않는다. */
  secret: boolean;
  /** 파일로 받는다(.pem). */
  file?: boolean;
  optional?: boolean;
  hint?: string;
}

export interface AppRegistration {
  app: string;
  /** 그 서비스에서 앱을 만들 수 있는 사람. */
  who: string;
  /** 대략 걸리는 시간(분). */
  minutes: number;
  /** 무엇을 만드는지 한 줄. */
  what: string;
  steps: RegStep[];
  fields: RegField[];
  /** 알아 둘 것 — 사람이 물을 만한 것 · 나중에 겪을 일. 화면은 걸음 아래 작은 글로, 스킬은 «물으면» 으로. */
  notes?: string[];
}

const ID_SECRET = (idLabel: string, secretLabel: string): RegField[] => [
  { key: "client_id", label: idLabel, secret: false },
  { key: "client_secret", label: secretLabel, secret: true },
];

export const APP_REGISTRATIONS: Readonly<Record<string, AppRegistration>> = Object.freeze({
  slack: {
    app: "slack", who: "슬랙 워크스페이스 관리자", minutes: 5, what: "이 회사의 슬랙 앱",
    steps: [
      { text: "아래 [슬랙 앱 만들기] 를 엽니다. 앱 이름·권한·돌아올 주소가 미리 채워져 있어요.", link: { label: "슬랙 앱 만들기", kind: "slack_manifest" } },
      { text: "회사 슬랙 워크스페이스를 고르고 [Next] → [Create] 를 누릅니다." },
      { text: "만들어진 앱 화면 왼쪽 «Basic Information» 의 «App Credentials» 에서 Client ID 를 복사하고, Client Secret 은 [Show] 를 누른 뒤 복사합니다." },
      { text: "두 값을 아래 칸에 넣고 [등록] 을 누릅니다. 등록한 분이 이어서 [연결] 을 누르면 라이블리 봇이 슬랙에 함께 설치돼요." },
    ],
    fields: ID_SECRET("Client ID", "Client Secret"),
    notes: [
      "봇은 초대받은 채널의 메시지·파일과 구성원 이름·이메일(사람을 맞추는 데)만 읽어요.",
      "사용자 권한은 각자 연결한 사람의 AI 가 그 사람 계정으로 슬랙을 찾거나 보낼 때 쓰고, 그 사람이 수집을 켜면 공개 채널 검색 수집에도 쓰여요.",
    ],
  },
  notion: {
    app: "notion", who: "노션 워크스페이스 관리자", minutes: 5, what: "이 회사의 노션 공개 통합",
    steps: [
      { text: "노션 통합 화면을 열고 [새 통합 만들기] 를 누릅니다.", link: { label: "노션 통합 화면", kind: "url", url: "https://www.notion.so/profile/integrations" } },
      { text: "유형은 «공개(Public)» 로 고르고, 회사 이름·웹사이트 같은 필수 칸을 채웁니다." },
      { text: "«리디렉션 URI» 칸에 아래 주소를 그대로 붙여 넣습니다.", copy: "callback_url" },
      { text: "«기능» 에서 «콘텐츠 읽기» 와 «댓글 읽기» 만 켭니다. 쓰기 기능은 켜지 않아요 — 라이블리는 읽기만 합니다." },
      { text: "저장한 뒤 «OAuth 클라이언트 ID» 와 «OAuth 클라이언트 시크릿» 을 복사합니다." },
      { text: "두 값을 아래 칸에 넣고 [등록] 을 누릅니다." },
    ],
    fields: ID_SECRET("OAuth 클라이언트 ID", "OAuth 클라이언트 시크릿"),
  },
  google: {
    app: "google", who: "회사 구글 클라우드 프로젝트 관리자", minutes: 15, what: "이 회사의 구글 OAuth 클라이언트",
    steps: [
      { text: "구글 클라우드 콘솔을 열고 회사 프로젝트를 고릅니다(없으면 [새 프로젝트]).", link: { label: "구글 클라우드 콘솔", kind: "url", url: "https://console.cloud.google.com" } },
      { text: "«API 및 서비스 ▸ 라이브러리» 에서 «Google Drive API» 와 «Gmail API» 를 찾아 각각 [사용] 을 누릅니다. AI 가 캘린더도 보게 하려면 «Google Calendar API» 도 켭니다." },
      { text: "«OAuth 동의 화면» 을 만듭니다. 회사 구글 계정만 연결한다면 사용자 유형을 «내부» 로 고르세요 — 구글 검증과 인원 제한이 없어요. «외부» 로 만들었다면 [앱 게시] 로 «프로덕션» 상태로 두세요(테스트 상태면 7일마다 연결이 끊깁니다)." },
      { text: "«사용자 인증 정보 ▸ 사용자 인증 정보 만들기 ▸ OAuth 클라이언트 ID» 를 누르고, 유형은 «웹 애플리케이션» 을 고릅니다." },
      { text: "«승인된 리디렉션 URI» 에 아래 주소를 그대로 붙여 넣고 [만들기] 를 누릅니다.", copy: "callback_url" },
      { text: "나온 «클라이언트 ID» 와 «클라이언트 보안 비밀번호» 를 복사해 아래 칸에 넣고 [등록] 을 누릅니다." },
    ],
    fields: ID_SECRET("클라이언트 ID", "클라이언트 보안 비밀번호"),
    notes: [
      "«외부» 로 만들고 구글 검증을 받기 전에는 연결할 때 «확인되지 않은 앱» 경고가 뜨고, 이 프로젝트로 연결할 수 있는 계정이 모두 합쳐 100개까지예요.",
      "나중에 클라이언트를 바꾸면 이미 연결한 사람은 모두 다시 연결해야 해요 — 구글은 발급한 클라이언트로만 연결을 이어 줍니다.",
    ],
  },
  linear: {
    app: "linear", who: "리니어 워크스페이스 관리자", minutes: 5, what: "이 회사의 리니어 OAuth 앱",
    steps: [
      { text: "리니어에서 «Settings ▸ API ▸ OAuth Applications» 를 열고 새 앱을 만듭니다.", link: { label: "리니어 OAuth 앱 화면", kind: "url", url: "https://linear.app/settings/api/applications/new" } },
      { text: "이름은 회사가 알아볼 이름(예: Lively)으로 넣고, «Callback URLs» 에 아래 주소를 그대로 붙여 넣습니다.", copy: "callback_url" },
      { text: "[Create] 를 누른 뒤 나온 Client ID 와 Client Secret 을 복사해 아래 칸에 넣고 [등록] 을 누릅니다." },
    ],
    fields: ID_SECRET("Client ID", "Client Secret"),
  },
  outlook: {
    app: "outlook", who: "회사 Microsoft 365 관리자(앱 등록 권한)", minutes: 10, what: "이 회사의 Microsoft Entra 앱",
    steps: [
      { text: "Microsoft Entra 관리 센터를 열고 «앱 등록 ▸ [새 등록]» 을 누릅니다.", link: { label: "Entra 관리 센터", kind: "url", url: "https://entra.microsoft.com" } },
      { text: "«지원되는 계정 유형» 은 «모든 조직 디렉터리의 계정 및 개인 Microsoft 계정» 을 고릅니다 — 다른 것을 고르면 연결이 실패해요." },
      { text: "«리디렉션 URI» 는 플랫폼 «웹» 을 고르고, 아래 주소를 그대로 붙여 넣은 뒤 [등록] 을 누릅니다.", copy: "callback_url" },
      { text: "«개요» 의 «애플리케이션(클라이언트) ID» 를 복사합니다." },
      { text: "«인증서 및 비밀 ▸ [새 클라이언트 암호]» 를 만들고, 나온 «값» 을 바로 복사합니다(ID 가 아니라 값이에요 — 화면을 떠나면 다시 안 보입니다)." },
      { text: "두 값을 아래 칸에 넣고 [등록] 을 누릅니다." },
    ],
    fields: ID_SECRET("애플리케이션(클라이언트) ID", "클라이언트 암호 값"),
  },
  github: {
    app: "github", who: "깃허브 조직 Owner", minutes: 10, what: "이 회사의 GitHub App",
    steps: [
      { text: "깃허브 조직 화면에서 «Settings ▸ Developer settings ▸ GitHub Apps ▸ [New GitHub App]» 을 엽니다. «OAuth Apps» 가 아니라 «GitHub Apps» 예요." },
      { text: "«GitHub App name» 에 회사가 알아볼 이름(예: Lively 회사명)을 넣습니다. 이미 있는 이름이면 뒤에 단어를 붙이세요." },
      { text: "«Homepage URL» 에 아래 주소를 넣습니다.", copy: "gateway_url" },
      { text: "«Callback URL» 에 아래 주소를 넣고, 바로 아래 «Request user authorization (OAuth) during installation» 을 체크합니다 — 빠뜨리면 연결 마지막에 오류가 나요.", copy: "callback_url" },
      { text: "«Webhook» 의 «Active» 체크를 끕니다." },
      { text: "«Repository permissions» 에서 Contents · Metadata · Issues · Pull requests 를 «Read-only» 로 바꿉니다." },
      { text: "«Where can this GitHub App be installed?» 는 «Only on this account» 를 고르고 [Create GitHub App] 을 누릅니다." },
      { text: "앱 화면에서 App ID 와 Client ID 를 복사하고, [Generate a new client secret] 으로 Client secret 을, [Generate a private key] 로 키 파일(.pem)을 받습니다. 앱 주소 github.com/apps/<이름> 의 <이름> 부분도 적어 둡니다." },
      { text: "다섯 가지를 아래 칸에 넣고(키는 파일 그대로 올립니다) [등록] 을 누릅니다." },
    ],
    fields: [
      { key: "app_id", label: "App ID", secret: false },
      { key: "client_id", label: "Client ID", secret: false },
      { key: "client_secret", label: "Client secret", secret: true },
      { key: "private_key", label: "Private key(.pem 파일)", secret: true, file: true },
      { key: "app_slug", label: "앱 주소 이름(github.com/apps/<이름>)", secret: false },
    ],
  },
});

/** 화면용 — 자리표를 실제 값으로 채우고, 채울 값이 없으면 «먼저 할 일» 을 알린다. */
export interface RegistrationView {
  who: string;
  minutes: number;
  what: string;
  /** 비어 있으면 바로 시작할 수 있다. callback_url = 이 워크스페이스의 공개 주소가 아직 없다. */
  missing: RegPlaceholder[];
  steps: Array<{ text: string; link?: RegStep["link"]; copy?: { what: RegPlaceholder; value: string | null } }>;
  fields: RegField[];
  notes: string[];
}

export function registrationView(app: string, ctx: { callbackUrl: string | null; gatewayUrl: string | null }): RegistrationView | null {
  const r = APP_REGISTRATIONS[app];
  if (!r) return null;
  const value = (p: RegPlaceholder): string | null => (p === "callback_url" ? ctx.callbackUrl : ctx.gatewayUrl);
  const missing = new Set<RegPlaceholder>();
  const steps = r.steps.map((s) => {
    if (s.copy && !value(s.copy)) missing.add(s.copy);
    //  슬랙 «앱 만들기» 링크도 돌아올 주소를 품는다 — 공개 주소가 없으면 서버가 링크를 못 만든다(org_slack_app_manifest 400).
    if (s.link?.kind === "slack_manifest" && !ctx.callbackUrl) missing.add("callback_url");
    return { text: s.text, ...(s.link ? { link: s.link } : {}), ...(s.copy ? { copy: { what: s.copy, value: value(s.copy) } } : {}) };
  });
  return { who: r.who, minutes: r.minutes, what: r.what, missing: [...missing], steps, fields: r.fields.map((f) => ({ ...f })), notes: [...(r.notes ?? [])] };
}

/** 스킬용 — 자리표를 «어느 칸의 값» 으로 바꾼다(AI 는 org_connect_status 를 보고 실제 값을 말한다). */
const SKILL_PLACEHOLDER: Record<RegPlaceholder, string> = {
  callback_url: "`prereq.callback_url` 값",
  gateway_url: "`gateway_url` 값",
};

/** 연결 스킬 «앱 등록» 절 — 조립 때 앱 스킬 본문의 `{{registration}}` 자리에 들어간다. */
export function registrationMarkdown(app: string): string {
  const r = APP_REGISTRATIONS[app];
  if (!r) throw new Error(`앱 등록 안내가 없다: ${app}`);
  const lines: string[] = [];
  lines.push(`### 앱 등록 (한 번만 · ${r.who} · 약 ${r.minutes}분)`);
  lines.push("");
  lines.push(`라이블리 앱 길이 \`register\` 일 때만 한다 — 만들 것은 «${r.what}» 이고, 만든 값을 라이블리에 등록한다. 한 번에 한 걸음씩 안내하고, 사람이 «했어요» 라고 하면 다음 걸음으로 간다.`);
  lines.push(`- \`prereq.callback_url\` 이 null 이면 먼저 입구 스킬(\`liv-connect\`)의 «공개 주소 넣기» 를 한다 — 돌아올 주소가 없으면 앱을 만들 수 없다.`);
  lines.push(`- 화면으로 하면 더 쉽다: \`connect_url\`(그 앱 화면)에 같은 안내와 붙여 넣을 값·입력칸이 있다. 사람이 화면으로 하겠다고 하면 그쪽으로 보내고, 끝나면 확인만 한다.`);
  lines.push("");
  r.steps.forEach((s, i) => {
    let text = s.text;
    if (s.copy) text += ` — 넣을 값: ${SKILL_PLACEHOLDER[s.copy]}`;
    if (s.link?.kind === "url") text += ` (${s.link.url})`;
    if (s.link?.kind === "slack_manifest") text += " — 링크는 `org_slack_app_manifest` 를 불러 받은 `create_url` 이다";
    lines.push(`${i + 1}. ${text}`);
  });
  if (r.notes?.length) {
    lines.push("");
    lines.push("사람이 물으면(먼저 늘어놓지 않는다):");
    for (const n of r.notes) lines.push(`- ${n}`);
  }
  lines.push("");
  lines.push("**값 넣기 — 늘 화면에서 하게 안내한다**(비밀 값이 대화를 지나지 않게): `connect_url`(그 앱 화면) ▸ «앱 등록» 칸에 넣고 [등록]. " +
    `넣을 값: ${r.fields.map((f) => `«${f.label}»${f.file ? "(파일)" : ""}`).join(" · ")}.`);
  lines.push(`- 사람이 굳이 대화로 하겠다고 하면 공통 규칙 6의 경고를 먼저 하고: \`org_connect_register { app:"${r.app}", values:{ ${r.fields.map((f) => f.key + ":…").join(", ")} } }\`. 받은 값은 다시 출력하지 않는다.`);
  lines.push(`- 끝나면 \`org_connect_status\` 를 다시 불러 \`${r.app}\` 의 라이블리 앱 길이 \`connect\` 가 됐는지 확인하고 «연결» 로 간다.`);
  //  (#4991) 등록한 뒤 — 바꾸기·지우기. 화면은 같은 칸(«연결하는 길» ▸ «앱 등록 보기 · 바꾸기 · 지우기»)이고, 끊기는 것은 서버가 말한다.
  lines.push("");
  lines.push("### 앱 등록 바꾸기 · 지우기 (등록한 뒤)");
  lines.push("");
  lines.push(`사람이 등록한 앱을 다른 앱으로 바꾸거나 지우려 할 때 — \`org_connect_status\` 의 \`${r.app}\` 줄 \`can_edit_registration\` 이 true 인 사람만 할 수 있다(셀프호스트 · 등록 권한).`);
  lines.push(`1. \`org_connect_registration { app:"${r.app}" }\` 로 지금 등록(\`current\`)과 끊기는 것(\`impact\`)을 본다.`);
  lines.push("2. 바꾸기 — 먼저 «같은 앱의 값만 새로 넣으면 이미 된 연결은 그대로예요» 라고 말하고, 다른 앱으로 바꿀 때 끊기는 것(`impact.replace`)을 그대로 말한다. 값은 위 «값 넣기» 와 같다 — 화면 `connect_url` ▸ «연결하는 길» ▸ «앱 등록 보기 · 바꾸기 · 지우기» ▸ [등록 값 바꾸기]. 등록 문(`org_connect_register`)이 덮어쓴다.");
  lines.push(`3. 지우기 — \`impact.remove\` 를 그대로 말하고, 사람이 확인하면 \`org_connect_unregister { app:"${r.app}" }\`. 이미 된 연결·모은 자료는 지우지 않는다. 응답 \`app_ready\` 가 false 면 등록 칸이 다시 열린 것이다(true 면 서버 설정의 앱이 남았다).`);
  return lines.join("\n");
}
