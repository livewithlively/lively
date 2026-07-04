// Notion API 객체 타입(부분) — 우리가 읽는 필드만 좁게 선언, 나머지는 raw 로 보존(무손실 원장).
//  notion.ts(트래버설)·notion-md.ts(변환기) 공용. 순환 import 회피용 분리 모듈.

export interface NotionRichText {
  type?: string; // text | mention | equation (+미지 타입 관용)
  plain_text?: string;
  href?: string | null;
  annotations?: {
    bold?: boolean; italic?: boolean; strikethrough?: boolean;
    underline?: boolean; code?: boolean; color?: string;
  };
  text?: { content?: string; link?: { url?: string } | null };
  mention?: Record<string, unknown>;
  equation?: { expression?: string };
  [k: string]: unknown;
}

export interface NotionBlock {
  object: "block";
  id: string;
  type: string;
  has_children?: boolean;
  /** 트래버설이 부착하는 재귀 자식(API 원본에는 없음 — 원장에 가산 보존). */
  _children?: NotionBlock[];
  [k: string]: unknown;
}

export interface NotionPropertyValue {
  id?: string;
  type?: string;
  title?: NotionRichText[];
  has_more?: boolean;
  [k: string]: unknown;
}

export interface NotionPage {
  object: "page";
  id: string;
  created_time?: string;
  last_edited_time?: string;
  created_by?: { id?: string };
  last_edited_by?: { id?: string };
  url?: string;
  public_url?: string;
  icon?: Record<string, unknown> | null;
  cover?: Record<string, unknown> | null;
  parent?: {
    type?: string;
    page_id?: string;
    database_id?: string;
    data_source_id?: string;
    block_id?: string;
    workspace?: boolean;
  };
  properties?: Record<string, NotionPropertyValue>;
  archived?: boolean;
  in_trash?: boolean;
  [k: string]: unknown;
}

export interface NotionDatabase {
  object: "database";
  id: string;
  title?: NotionRichText[];
  description?: NotionRichText[];
  icon?: Record<string, unknown> | null;
  cover?: Record<string, unknown> | null;
  url?: string;
  is_inline?: boolean;
  created_time?: string;
  last_edited_time?: string;
  created_by?: { id?: string };
  parent?: NotionPage["parent"];
  archived?: boolean;
  in_trash?: boolean;
  /** 2025-09-03+: 속성 스키마는 database 가 아니라 data_source 에 있다. */
  data_sources?: Array<{ id: string; name?: string }>;
  /** 구버전(2022-06-28) 폴백 — 스키마가 database 에 직접 실려올 수 있음. */
  properties?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface NotionDataSource {
  object?: string; // "data_source"
  id: string;
  title?: NotionRichText[];
  name?: string;
  properties?: Record<string, unknown>;
  parent?: { type?: string; database_id?: string };
  database_parent?: { type?: string; database_id?: string };
  [k: string]: unknown;
}

export interface NotionUser {
  id: string;
  name?: string;
  type?: string;
  person?: { email?: string };
  bot?: unknown;
}

export interface NotionComment {
  id: string;
  discussion_id?: string;
  created_time?: string;
  created_by?: { id?: string };
  rich_text?: NotionRichText[];
  attachments?: unknown[];
  [k: string]: unknown;
}

export interface NotionListResponse<T = Record<string, unknown>> {
  results: T[];
  has_more?: boolean;
  next_cursor?: string | null;
}
