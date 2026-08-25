// 로컬(내 컴퓨터) 커넥터 (#1881 L2) — 싱크가 없다. 자료는 업로드 라우트가 밀어 넣고(ingest/local-file.ts), 여기는
//  공용 `source_artifact` 도구가 [BINARY] 자료의 원본을 on-demand 로 받을 때 쓰는 fetchArtifact 만 실제다.
//  ⚠ 무거운 모듈(프로젝트 스토어·터미널 프로필)은 호출 시점에 동적 import — 커넥터 레지스트리(index.ts)가 부팅 초기에
//   로드되므로 정적 import 로 끌면 순환 로드(TDZ)가 생길 수 있다.
import type { Readable } from "node:stream";
import type { Connector, RawItem } from "./types.js";

export const localConnector: Connector = {
  name: "local",
  async *backfill(): AsyncIterable<RawItem> { /* 로컬은 끌어올 곳이 없다 — 사람이 올리는 순간이 수집이다 */ },
  async fetchArtifact(externalId: string): Promise<{ stream: Readable | Buffer; mime: string; filename?: string; size?: number } | null> {
    const { openLocalArtifact } = await import("../ingest/local-file.js");
    return openLocalArtifact(externalId);
  },
};
