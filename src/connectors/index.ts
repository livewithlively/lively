// 커넥터 레지스트리 — 이름 → Connector. 새 소스 추가 시 여기만 등록.
import type { Connector } from "./types.js";
import { slackConnector } from "./slack.js";
import { discordConnector } from "./discord.js";
import { notionConnector } from "./notion.js";
import { clickupConnector } from "./clickup.js";
import { gmailConnector } from "./gmail.js";
import { gdriveConnector } from "./gdrive.js";
import { domainWikiConnector } from "./domain-wiki.js";
import { localConnector } from "./local.js";
import { figmaConnector } from "./figma.js";
import { githubConnector } from "./github.js";
import { gitlabConnector } from "./gitlab.js";

export const connectors: Record<string, Connector> = {
  slack: slackConnector,
  discord: discordConnector,
  notion: notionConnector,
  clickup: clickupConnector, // 캐노니컬 진입은 run-sync.js 전용 clickup 경로(프로젝트 싱크+declared) — SPI backfill 은 무손실 스트림
  gmail: gmailConnector,     // message → source (#541, OAuth2 refresh-token)
  gdrive: gdriveConnector,   // doc → knowledge (#541, OAuth2 refresh-token)
  "domain-wiki": domainWikiConnector, // 로컬 git md 미러 → knowledge, 링크 #/k/ 정규화 (#696)
  local: localConnector,     // 내 컴퓨터 업로드 → source (#1881) — 싱크 없음, fetchArtifact 만(업로드 라우트가 자료를 민다)
  figma: figmaConnector,     // 디자인 파일 코멘트 → source (#1881) — 범위 선언은 링크·팀 id(피그마엔 채널 열거가 없다)
  github: githubConnector,   // 이슈·PR 대화·릴리스 → source (#2247) — 범위는 저장소 목록([GitHub 연결]에서 고른 것이 기본)
  gitlab: gitlabConnector,   // 이슈·MR 대화·릴리스 → source (#2247) — 개인 토큰(read_api)만, 호스트 축(self-managed)
};
