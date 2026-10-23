// 외부 앱 연결 스킬 — **라이블리가 배포하고 조직이 고치지 못하는 스킬**(#4970).
//
//  왜 따로 있나: 외부 앱 연결은 리브의 핵심 기능이고, 연결법은 앱마다 다르고 앱마다 따로 바뀐다(슬랙 매니페스트 앱,
//   깃허브 GitHub App, 아웃룩 회사 계정의 관리자 허용, 클릭업·피그마·깃랩 개인 토큰 …). 한 스킬에 다 담으면 앱 하나가
//   바뀌어도 큰 본문을 고쳐야 하고, AI 는 연결할 때마다 전부를 읽는다. 그래서 두 층으로 나눈다.
//   · `liv-connect`          — 입구. 앱을 정하지 않은 «외부 앱 연결 도와줘». 앱별 상태를 한 번에 보여 주고 고른 앱으로 넘긴다.
//   · `liv-connect-<앱>`     — 앱마다 하나. 그 앱에만 해당하는 것(준비 확인·연결·모을 범위·함정)만 담는다.
//   공통 규칙(한 걸음씩·숫자는 도구 값만·시크릿 경고·연결 뒤 보고)은 `_common` 한 곳에만 두고 **내려보낼 때 합친다** —
//   앱 스킬마다 복사해 두면 공통 하나를 바꿀 때 전부를 고쳐야 해서, 앱별로 떼어 놓은 목적과 반대가 된다.
//
//  매니지드 / 셀프호스트 — 스킬은 배포 방식으로 갈리지 않는다(#4970, 상민님 2026-10-23 «그 분기 조건은 없는게좋으니까»).
//   종전엔 판마다 `<키>.managed.md`/`<키>.selfhost.md` 를 따로 두고 서버가 자기 판만 내려줬다. 이제 앱마다 원본 하나이고,
//   갈림은 **길의 상태**다: org_connect_status 가 앱마다 길(라이블리 앱 · Claude 커넥터 · 개인 토큰)과 상태를 주고
//   (org/connect-routes.ts), 스킬은 그 상태에 맞는 절을 따른다. 배포 차이는 «라이블리 앱을 누가 쥐나» 하나로 서버에서만
//   길 상태에 들어간다(매니지드 미준비 = 준비 중 · 셀프호스트 미준비 = 앱 등록·관리자에게 요청). 셀프호스트의 앱 등록
//   안내는 org/connect-registration.ts 한 벌을 조립 때 `{{registration}}` 자리에 끼워 넣는다 — 화면의 앱 등록 칸과 같은 글이다.
//
//  잠금(시드 훅 #1836·세션 주입 섹션 #1245 와 같은 처방): 본문은 코드가 유일한 출처다. 조직은 고치지도·끄지도·지우지도
//   못한다 — 업데이트는 릴리스로만 온다. 기본 스킬의 «손 안 댄 행만 갱신»(seed-content.ts)은 한 번 고친 워크스페이스를
//   영원히 옛 절차에 묶는데, 연결 절차가 낡으면 사람은 없는 메뉴·막힌 길로 안내받는다. 끄기도 막는 이유: 연결 스킬이 없으면
//   «슬랙 연결해줘»에 AI 가 절차 없이 즉석으로 답한다. 연결 자체는 이미 권한(관리자·본인 동의)이 막고 있어 스킬을 끌 이유가 없다.
//
//  원본: src/org/delivery/connect-skills/*.md → `node scripts/sync-connect-skills.mjs` 가 connect-skills.sources.ts 로 굳힌다
//   (connect-skills.test.ts 가 둘의 일치를 강제한다 — sources.ts 를 손으로 고치지 말 것).
import { CONNECT_SKILL_SOURCES } from "./connect-skills.sources.js";
import { APP_REGISTRATIONS, registrationMarkdown } from "../connect-registration.js";
import { managedMode } from "../tenancy/state.js";
import { assetContentHash } from "../store/harness-assets.js";

export type ConnectVariant = "managed" | "selfhost";

/** 스킬 하나의 정의 — 본문은 원본 파일(`source` 키)에서, 나머지는 여기서. */
export interface ConnectSkillSpec {
  id: string;
  /** 원본 파일 키 — `connect-skills/<source>.md`. */
  source: string;
  label: string;
  /** 사람 화면에 보이는 쉬운 한 줄. */
  summary: string;
  /** AI 가 언제 이 스킬을 쓸지 고르는 문장 — 모든 세션에 늘 깔리므로 짧게 쓴다(테스트가 길이를 잰다). */
  description: string;
}

// 순서 = 화면·목록 순서(sort). 앱을 더할 때: 여기 한 줄 + connect-skills/<키>.md + sync (+ 라이블리 앱 길이 있으면 connect-registration.ts).
export const CONNECT_SKILL_SPECS: readonly ConnectSkillSpec[] = [
  {
    id: "liv-connect", source: "_router", label: "외부 앱 연결",
    summary: "외부 앱의 연결 상태를 한 번에 보여 주고, 고른 앱을 연결합니다.",
    description: "외부 앱 연결의 입구 — 앱을 정하지 않고 «외부 앱 연결 도와줘»·«무슨 앱을 연결할 수 있어»·«연결 상태 봐줘» 라고 할 때 쓴다. "
      + "앱마다 준비·연결·수집 상태를 한 번에 보여 주고(org_connect_status) 고른 앱의 liv-connect-<앱> 스킬로 넘긴다. 처음 설정의 외부 앱 연결도 여기서 시작한다.",
  },
  {
    id: "liv-connect-slack", source: "slack", label: "슬랙 연결",
    summary: "슬랙을 라이블리에 연결하고 모을 채널을 정합니다.",
    description: "슬랙을 라이블리에 연결한다 — 앱 준비 확인, 연결, 모을 채널 정하기, 첫 수집. 트리거 «슬랙 연결» / «Slack 연결» / «슬랙 대화 모아 줘».",
  },
  {
    id: "liv-connect-notion", source: "notion", label: "노션 연결",
    summary: "노션을 라이블리에 연결하고 모을 페이지를 정합니다.",
    description: "노션을 라이블리에 연결한다 — 앱 준비 확인, 연결(모을 페이지 고르기), 첫 수집. 트리거 «노션 연결» / «Notion 연결» / «노션 문서 모아 줘».",
  },
  {
    id: "liv-connect-linear", source: "linear", label: "리니어 연결",
    summary: "리니어를 라이블리에 연결하고 모을 팀을 정합니다.",
    description: "리니어를 라이블리에 연결한다 — 앱 준비 확인, 연결, 모을 팀 정하기, 첫 수집. 트리거 «리니어 연결» / «Linear 연결».",
  },
  {
    id: "liv-connect-github", source: "github", label: "깃허브 연결",
    summary: "깃허브를 라이블리에 연결하고 모을 저장소를 정합니다.",
    description: "깃허브를 라이블리에 연결한다 — 앱 준비 확인, 연결(읽힐 저장소 고르기), 모을 저장소 정하기, 첫 수집. 트리거 «깃허브 연결» / «GitHub 연결».",
  },
  {
    id: "liv-connect-gitlab", source: "gitlab", label: "깃랩 연결",
    summary: "깃랩 개인 토큰을 저장하고 모을 프로젝트를 정합니다.",
    description: "깃랩을 라이블리에 연결한다 — 개인 토큰 발급·저장, 모을 프로젝트 정하기, 첫 수집. 트리거 «깃랩 연결» / «GitLab 연결».",
  },
  {
    id: "liv-connect-google", source: "google", label: "구글 연결",
    summary: "구글 계정(드라이브·지메일·캘린더)을 라이블리에 연결합니다.",
    description: "구글(드라이브·지메일·캘린더)을 라이블리에 연결한다 — 앱 준비 확인, 계정 연결, 모을 범위, 첫 수집. 트리거 «구글 연결» / «지메일 연결» / «구글 드라이브 연결».",
  },
  {
    id: "liv-connect-outlook", source: "outlook", label: "아웃룩 연결",
    summary: "아웃룩 메일(Microsoft 365·outlook.com)을 라이블리에 연결합니다.",
    description: "아웃룩(Microsoft 365·outlook.com)을 라이블리에 연결한다 — 앱 준비 확인, 계정 연결(회사 계정은 관리자 허용), 첫 수집. 트리거 «아웃룩 연결» / «Outlook 연결» / «회사 메일 연결».",
  },
  {
    id: "liv-connect-clickup", source: "clickup", label: "클릭업 연결",
    summary: "클릭업 API 토큰을 저장하고 가져올 리스트를 정합니다.",
    description: "클릭업을 라이블리에 연결한다 — 개인 API 토큰 저장, 가져올 리스트 정하기, 첫 가져오기. 트리거 «클릭업 연결» / «ClickUp 연결».",
  },
  {
    id: "liv-connect-figma", source: "figma", label: "피그마 연결",
    summary: "피그마 토큰을 저장하고 코멘트를 모을 파일을 정합니다.",
    description: "피그마를 라이블리에 연결한다 — 개인 액세스 토큰 저장, 코멘트를 모을 파일 정하기, 첫 수집. 트리거 «피그마 연결» / «Figma 연결».",
  },
  // 앱이 아니라 «길» — 구성원 Claude 커넥터로 슬랙·지메일·노션을 모은다(기본 길은 위 앱 스킬). 원본 파일 이름을 claude.md 로
  //  두지 않는다: 대소문자를 가리지 않는 파일시스템(macOS)에서 CLAUDE.md 로 읽혀 이 폴더를 만지는 AI 세션에 지시문으로 주입된다.
  {
    id: "liv-connect-claude", source: "claude-connector", label: "Claude 커넥터로 모으기",
    summary: "Claude 에 연결해 둔 슬랙·지메일·노션으로 자료를 모읍니다.",
    description: "구성원이 Claude 에 이미 연결해 둔 앱(슬랙·지메일·노션)으로 자료를 모은다 — 사람이 그 길을 골랐거나 라이블리 수집기가 없는 앱일 때. 트리거 «Claude 커넥터로 모아 줘» / «Claude 에 연결된 앱으로 모아 줘».",
  },
];

/** 모든 연결 스킬 끝에 붙는 공통 부분의 원본 키. */
export const CONNECT_COMMON_SOURCE = "_common";

/** 이 게이트웨이가 내려줄 판 — 매니지드면 managed. 술어는 tenancy/state.ts 한 곳에만 둔다(#3564 교훈). */
export function connectVariant(env: NodeJS.ProcessEnv = process.env): ConnectVariant {
  return managedMode(env) ? "managed" : "selfhost";
}

/** 앱 등록 안내가 들어갈 자리 — 앱 스킬 원본에 한 번. */
export const REGISTRATION_SLOT = "{{registration}}";

/** 한 키의 원본. 없으면 배포 사고라 던진다(테스트가 미리 잡는다). */
export function connectSource(key: string, sources: Record<string, string> = CONNECT_SKILL_SOURCES): string {
  const s = sources[key];
  if (s === undefined) throw new Error(`연결 스킬 원본 '${key}' 이(가) 없다 — connect-skills/${key}.md`);
  return s;
}

/** 내려보낼 본문 — 그 스킬 원본(앱 등록 자리를 안내로 채워) + 공통 규칙. 자리가 있는데 안내가 없거나, 안내가 있는데 자리가 없으면 던진다. */
export function assembleConnectBody(spec: ConnectSkillSpec, sources: Record<string, string> = CONNECT_SKILL_SOURCES): string {
  let own = connectSource(spec.source, sources);
  const hasSlot = own.includes(REGISTRATION_SLOT);
  const hasReg = !!APP_REGISTRATIONS[spec.source];
  if (hasSlot !== hasReg) throw new Error(`연결 스킬 '${spec.id}' 의 앱 등록 자리(${REGISTRATION_SLOT})와 안내(connect-registration.ts)가 맞지 않는다`);
  if (hasSlot) own = own.replace(REGISTRATION_SLOT, registrationMarkdown(spec.source));
  return [own, connectSource(CONNECT_COMMON_SOURCE, sources)].map((p) => p.trim()).join("\n\n") + "\n";
}

/** 잠긴 스킬 한 건 — org_harness_asset 행과 같은 모양(시딩·배포·화면이 그대로 쓴다). */
export interface LockedSkill {
  id: string; kind: "skill"; label: string; harness: "all"; description: string; summary: string;
  body: string; frontmatter: Record<string, unknown>; paired_hook_id: null; enabled: true; target_members: null;
  sort: number; content_hash: string;
}

export function connectSkills(sources: Record<string, string> = CONNECT_SKILL_SOURCES): LockedSkill[] {
  return CONNECT_SKILL_SPECS.map((spec, i) => {
    const body = assembleConnectBody(spec, sources);
    const frontmatter = {};
    return {
      id: spec.id, kind: "skill", label: spec.label, harness: "all", description: spec.description, summary: spec.summary,
      body, frontmatter, paired_hook_id: null, enabled: true, target_members: null, sort: i,
      content_hash: assetContentHash({ kind: "skill", harness: "all", description: spec.description, body, frontmatter }),
    };
  });
}

// 본문은 프로세스 수명 동안 바뀌지 않는다(원본이 코드에 굳어 있다). 테스트는 connectSkills 를 직접 부른다.
let cached: LockedSkill[] | null = null;
/** 지금 이 게이트웨이가 내려주는 잠긴 스킬들. */
export function lockedSkillsNow(): LockedSkill[] {
  if (!cached) cached = connectSkills();
  return cached;
}

const LOCKED_IDS = new Set(CONNECT_SKILL_SPECS.map((s) => s.id));

export function isLockedSkill(id: string | null | undefined): boolean {
  return !!id && LOCKED_IDS.has(id);
}

export function lockedSkillIds(): string[] {
  return [...LOCKED_IDS];
}

/** 잠긴 스킬을 바꾸려 할 때의 사유 — 거부 메시지·감사에 그대로 쓴다. */
export function lockedSkillMessage(id: string): string {
  return `'${id}' 는 라이블리가 배포하는 외부 앱 연결 스킬이라 조직에서 고치거나 끄거나 지울 수 없습니다 `
    + `— 본문은 제품 코드가 단일 출처이고, 연결법이 바뀌면 업데이트로 함께 바뀝니다. `
    + `조직만의 절차를 더하고 싶으면 **새 id 로 스킬**을 만드세요(이 스킬과 함께 배포됩니다).`;
}

type AssetLike = { id: string; body: string; description: string; content_hash?: string | null };

/** 화면·목록에 보일 '유효 행' — 잠긴 스킬이면 DB 행이 무엇이든 코드 본문으로 덮는다(effectiveHook 동형).
 *  enabled·target_members 도 코드 값으로 보인다 — 잠긴 스킬은 조직의 결정이 없다. 비파괴(DB 행은 시딩이 맞춘다). */
export function effectiveAsset<T extends AssetLike>(row: T): T {
  if (!isLockedSkill(row.id)) return row;
  const s = lockedSkillsNow().find((x) => x.id === row.id);
  if (!s) return row;
  return { ...row, label: s.label, kind: s.kind, harness: s.harness, description: s.description, summary: s.summary,
    body: s.body, frontmatter: s.frontmatter, enabled: true, target_members: null, paired_hook_id: null, content_hash: s.content_hash };
}

export function effectiveAssets<T extends AssetLike>(rows: T[]): T[] {
  return rows.map(effectiveAsset);
}

/** materializer 가 받을 목록 — DB 의 잠긴 행은 빼고 코드 판을 **항상** 넣는다(시딩이 실패했거나, 행이 꺼졌거나,
 *  누가 SQL 로 대상 구성원을 좁혀도 연결 스킬은 모든 구성원에게 간다). harness·kind 필터는 DB 쿼리와 같은 뜻으로 건다. */
export function withLockedAssets<T extends { id: string }>(rows: T[], filter: { harness?: string; kind?: string } = {}): Array<T | LockedSkill> {
  const kept: Array<T | LockedSkill> = rows.filter((r) => !isLockedSkill(r.id));
  for (const s of lockedSkillsNow()) {
    if (filter.kind && filter.kind !== s.kind) continue;
    if (filter.harness && filter.harness !== s.harness && s.harness !== "all") continue;
    kept.push(s);
  }
  return kept;
}
