import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveUser, requireScope } from "../context.js";

export function registerMemoryTools(server: McpServer): void {
  server.registerTool(
    "memory_search",
    {
      title: "메모리 검색",
      description: "사용자/프로젝트/조직 범위의 저장된 메모리를 의미 기반으로 검색합니다.",
      inputSchema: {
        query: z.string(),
        scope: z.enum(["user", "project", "org"]).default("user"),
        project: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({ query, scope, project, limit }, extra) => {
      const user = resolveUser(extra);
      requireScope(user, "memory");
      // TODO: pgvector 검색. (scope, user.userId, project) 로 필터.
      return {
        content: [
          {
            type: "text",
            text: `TODO memory_search: q="${query}" scope=${scope} project=${project ?? "-"} limit=${limit} user=${user.userId}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "memory_write",
    {
      title: "메모리 저장",
      description: "새 메모리를 저장합니다. 기본 범위는 사용자 개인이며, org 범위 쓰기는 권한이 필요합니다.",
      inputSchema: {
        content: z.string(),
        scope: z.enum(["user", "project", "org"]).default("user"),
        project: z.string().optional(),
        tags: z.array(z.string()).default([]),
      },
    },
    async ({ content, scope, project, tags }, extra) => {
      const user = resolveUser(extra);
      requireScope(user, "memory");
      // TODO: embed + insert. org 범위 쓰기는 추가 권한 확인.
      return {
        content: [
          {
            type: "text",
            text: `TODO memory_write: len=${content.length} scope=${scope} project=${project ?? "-"} tags=[${tags.join(",")}] user=${user.userId}`,
          },
        ],
      };
    },
  );
}
