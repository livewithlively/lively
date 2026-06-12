import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveUser, requireScope } from "../context.js";

export function registerCodeTools(server: McpServer): void {
  server.registerTool(
    "code_search",
    {
      title: "코드 검색",
      description: "사내 레포에서 코드/심볼을 검색합니다. 읽기 전용. 레포 권한 범위로 제한됩니다.",
      inputSchema: {
        query: z.string(),
        repo: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({ query, repo, limit }, extra) => {
      const user = resolveUser(extra);
      requireScope(user, "code");
      // TODO: 기존 인덱스 합성 — ripgrep 미러 / Sourcegraph / 공식 GitHub MCP.
      //       레포 ACL 로 스코프(여기 또는 백엔드에서).
      return {
        content: [{ type: "text", text: `TODO code_search: q="${query}" repo=${repo ?? "*"} limit=${limit} user=${user.userId}` }],
      };
    },
  );

  server.registerTool(
    "code_read",
    {
      title: "파일 읽기",
      description: "특정 레포의 파일 내용을 반환합니다. 읽기 전용.",
      inputSchema: {
        repo: z.string(),
        path: z.string(),
        ref: z.string().optional(),
      },
    },
    async ({ repo, path, ref }, extra) => {
      const user = resolveUser(extra);
      requireScope(user, "code");
      // TODO: 레포 ACL 확인 후 파일 반환.
      return { content: [{ type: "text", text: `TODO code_read: ${repo}:${path}@${ref ?? "HEAD"}` }] };
    },
  );
}
