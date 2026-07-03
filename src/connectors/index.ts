// 커넥터 레지스트리 — 이름 → Connector. 새 소스 추가 시 여기만 등록.
import type { Connector } from "./types.js";
import { slackConnector } from "./slack.js";
import { discordConnector } from "./discord.js";
import { notionConnector } from "./notion.js";
import { clickupConnector } from "./clickup.js";
import { gmailConnector } from "./gmail.js";
import { gdriveConnector } from "./gdrive.js";

export const connectors: Record<string, Connector> = {
  slack: slackConnector,
  discord: discordConnector,
  notion: notionConnector,
  clickup: clickupConnector, // 캐노니컬 진입은 run-sync.js(프로젝트 싱크+declared) — backfill 은 태스크만
  gmail: gmailConnector,     // message → source (#541, OAuth2 refresh-token)
  gdrive: gdriveConnector,   // doc → knowledge (#541, OAuth2 refresh-token)
};
