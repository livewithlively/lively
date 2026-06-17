// 임베딩 provider 추상화 — pgvector 시맨틱 검색을 위한 벡터 생성기. **기본 OFF**(EMBEDDINGS_ENABLED 미설정 시
// 휴면). 신규 npm 의존 0 — node 내장 fetch 만 사용한다(pgvector npm 클라이언트도 불필요: pg 가 vector 를
// 텍스트 '[...]' 로 처리). 인증은 시크릿 값이 아니라 환경변수 '이름'(EMBEDDINGS_PROVIDER_AUTH_ENV)으로만 받고
// 런타임에 process.env 에서 해소한다(org_mcp_server.auth_env / dynamic-tools.ts http_proxy 와 동일 관례 —
// 시크릿을 코드/DB 에 굳히지 않음).
import { logger } from "../log.js";

export interface EmbeddingProvider {
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

// HTTP 임베딩 provider 팩토리 — URL 과 DIM 이 모두 있을 때만 인스턴스를 만든다(둘 중 하나라도 없으면 null →
//  호출자가 휴면 처리). 셀프호스트 경량 추론기를 가정: POST {input:[...텍스트]} → {data:[{embedding:[...]}]}
//  (OpenAI 호환) 또는 {embeddings:[[...]]} 둘 다 수용한다. 응답 차원이 선언 DIM 과 다르면 거부한다(컬럼 vector(DIM)
//  과 불일치 시 INSERT 가 깨지므로 사전 차단).
export function makeHttpEmbeddingProvider(): EmbeddingProvider | null {
  const url = process.env.EMBEDDINGS_PROVIDER_URL;
  const dim = Number(process.env.EMBEDDINGS_DIM);
  if (!url || !Number.isInteger(dim) || dim <= 0) return null;

  // auth_env 는 환경변수 '이름'만(시크릿 값 아님) — 런타임에 process.env 에서 해소. 이름 형식 검증(주입 차단).
  const authEnvName = process.env.EMBEDDINGS_PROVIDER_AUTH_ENV;
  if (authEnvName && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(authEnvName)) {
    logger.warn({ authEnvName }, "EMBEDDINGS_PROVIDER_AUTH_ENV 가 환경변수 이름 형식이 아님 — 인증 없이 진행");
  }

  return {
    dim,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "lively-context-embeddings",
      };
      // 인증: auth_env 이름이 유효하면 그 환경변수 값을 Bearer 로(값은 로그/DB 에 절대 남기지 않음).
      if (authEnvName && /^[A-Za-z_][A-Za-z0-9_]*$/.test(authEnvName)) {
        const val = process.env[authEnvName];
        if (val) headers.Authorization = `Bearer ${val}`;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ input: texts }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error(`embedding provider HTTP ${res.status}`);
      const json = (await res.json()) as unknown;
      const vecs = extractVectors(json);
      if (vecs.length !== texts.length) {
        throw new Error(`embedding provider 응답 개수 불일치(요청 ${texts.length} / 응답 ${vecs.length})`);
      }
      for (const v of vecs) {
        if (!Array.isArray(v) || v.length !== dim || !v.every((n) => typeof n === "number" && Number.isFinite(n))) {
          throw new Error(`embedding provider 차원 불일치(선언 ${dim}) 또는 비수치 값`);
        }
      }
      return vecs;
    },
  };
}

// 응답 형태 정규화 — OpenAI 호환 {data:[{embedding}]} 와 단순 {embeddings:[[...]]} / 최상위 배열을 모두 수용.
function extractVectors(json: unknown): number[][] {
  if (Array.isArray(json)) return json as number[][];
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    if (Array.isArray(obj.embeddings)) return obj.embeddings as number[][];
    if (Array.isArray(obj.data)) {
      return (obj.data as Array<Record<string, unknown>>).map((d) => d.embedding as number[]);
    }
  }
  throw new Error("embedding provider 응답 형식 미인식(data[].embedding | embeddings[] | 배열)");
}
