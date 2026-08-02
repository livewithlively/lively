// delivery ▸ embeddings — 임베딩(벡터검색 #172) 상태 + 지식·프로젝트 백필 실행/일시중지.
import type { Capability, CapabilityCtx } from "../types.js";
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { getRuntimeConfig, updateRuntimeConfig, getEmbeddingConfigSource } from "../../org/store.js";
// 임베딩(벡터검색 #172) — 런타임 토글(embedding_config)은 updateRuntimeConfig 로, 기존 지식 백필은 공유 코어로.
import {
  startBackfillJob, getBackfillJob, countEmbeddingBacklog, runAutoBackfillSweep, setBackfillPausedCache, PROJECT_TARGET,
  type BackfillMode
} from "../../v6/embedding-backfill.js";
import { actorOf, restOnly } from "./shared.js";

export const embeddingsCapabilities: Capability[] = [
  // ── 임베딩(벡터검색 #172) 상태 + 기존 지식 백필 ──
  restOnly("org_embeddings_status", "임베딩(벡터검색) 상태",
    "임베딩 설정(embedding_config) + 기존 지식 백로그(미임베딩 수) + 진행 중 백필 잡 상태. admin 전용.",
    [{ method: "GET", paths: ["/api/ui/org/embeddings"], parse: () => ({}) }],
    async () => {
      const cfg = await getRuntimeConfig();
      const backlog = await countEmbeddingBacklog();
      // config_source(#688): db(관리탭)·db-off(명시적 끄기)·env(.env 시드)·off — UI 가 설정 출처를 안내.
      // backfill_paused(#1060): 자동 백필 일시중지 여부(knowledge·project 공통 스위치) — UI 가 배너·백필버튼 게이트에 쓴다.
      return { config: cfg.embedding_config, config_source: await getEmbeddingConfigSource(), backlog, job: getBackfillJob(), backfill_paused: cfg.embedding_backfill_paused };
    }),
  restOnly("org_embeddings_backfill", "기존 지식 임베딩(백필) 실행",
    "이미 저장된 지식을 배치로 임베딩(뒤늦게 켠 경우). mode=pending(기본)|model-changed|all. 인프로세스 잡 — 진행은 GET /api/ui/org/embeddings 폴링. 이미 실행 중이면 409.",
    [{ method: "POST", paths: ["/api/ui/org/embeddings/backfill"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>) => {
      const mode = String(input.mode ?? "pending");
      if (mode !== "pending" && mode !== "model-changed" && mode !== "all") throw new HttpError(400, "mode 는 pending|model-changed|all 만 허용됩니다");
      // provider off 면 백필 무의미 — 조기 400(코어도 off 면 no-op 이지만 잡을 만들지 않아 UX 명확).
      const cfg = await getRuntimeConfig();
      if (cfg.embedding_config.provider === "off") throw new HttpError(400, "임베딩이 꺼져 있습니다 — 먼저 provider 를 http 로 저장한 뒤 백필하세요.");
      // #1060 — 자동 백필을 일시중지한 상태에서는 수동 백필도 시작하지 않는다(마스터 스위치). 재개 후 실행하세요.
      if (cfg.embedding_backfill_paused) throw new HttpError(409, "임베딩 백필이 일시중지되었습니다 — 관리탭에서 재개한 뒤 실행하세요.");
      const { started, job } = startBackfillJob(mode as BackfillMode);
      if (!started) throw new HttpError(409, "이미 백필이 실행 중입니다.");
      return { started, job };
    }, {
      mode: z.enum(["pending", "model-changed", "all"]).optional().describe("pending(기본)=미임베딩만 · model-changed=모델 바뀐 것 · all=전체 재임베딩"),
    }),

  // ── 프로젝트 임베딩(검색 #631) 상태 + 백필 — knowledge 엔드포인트와 동형(타깃=project). embedding_config 는 공유. ──
  restOnly("org_project_embeddings_status", "프로젝트 임베딩 상태",
    "임베딩 설정(embedding_config, knowledge 와 공유) + 프로젝트(project·task·subtask) 백로그(미임베딩 수) + 진행 중 프로젝트 백필 잡 상태. admin 전용.",
    [{ method: "GET", paths: ["/api/ui/org/project-embeddings"], parse: () => ({}) }],
    async () => {
      const cfg = await getRuntimeConfig();
      const backlog = await countEmbeddingBacklog(PROJECT_TARGET);
      return { config: cfg.embedding_config, config_source: await getEmbeddingConfigSource(), backlog, job: getBackfillJob(PROJECT_TARGET), backfill_paused: cfg.embedding_backfill_paused };
    }),
  restOnly("org_project_embeddings_backfill", "프로젝트 임베딩(백필) 실행",
    "프로젝트·태스크·서브태스크를 배치로 임베딩(검색 #631). mode=pending(기본)|model-changed|all. 인프로세스 잡 — 진행은 GET /api/ui/org/project-embeddings 폴링. 이미 실행 중이면 409. knowledge 백필과 독립(동시 실행 가능).",
    [{ method: "POST", paths: ["/api/ui/org/project-embeddings/backfill"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>) => {
      const mode = String(input.mode ?? "pending");
      if (mode !== "pending" && mode !== "model-changed" && mode !== "all") throw new HttpError(400, "mode 는 pending|model-changed|all 만 허용됩니다");
      // provider off 면 백필 무의미 — 조기 400(코어도 off 면 no-op 이지만 잡을 만들지 않아 UX 명확).
      const cfg = await getRuntimeConfig();
      if (cfg.embedding_config.provider === "off") throw new HttpError(400, "임베딩이 꺼져 있습니다 — 먼저 provider 를 http 로 저장한 뒤 백필하세요.");
      // #1060 — 자동 백필 일시중지 상태면 수동 프로젝트 백필도 거부(knowledge 와 공통 스위치). 재개 후 실행하세요.
      if (cfg.embedding_backfill_paused) throw new HttpError(409, "임베딩 백필이 일시중지되었습니다 — 관리탭에서 재개한 뒤 실행하세요.");
      const { started, job } = startBackfillJob(mode as BackfillMode, PROJECT_TARGET);
      if (!started) throw new HttpError(409, "이미 프로젝트 백필이 실행 중입니다.");
      return { started, job };
    }, {
      mode: z.enum(["pending", "model-changed", "all"]).optional().describe("pending(기본)=미임베딩만 · model-changed=모델 바뀐 것 · all=전체 재임베딩. knowledge 백필과 독립(동시 실행 가능)"),
    }),

  // ── 자동 임베딩 백필 일시중지/재개(#1060) — 성능 이슈로 사람이 자동 백필을 멈추고 재개하는 마스터 스위치. ──
  //  자동 백필 트리거(부팅 30초·10분 주기·connector_sync 완료 후·쓰기 nudge)는 전부 runAutoBackfillSweep 로 수렴하는데,
  //  느린/CPU 임베딩 백엔드에서 그 스윕이 게이트웨이 성능을 갉아먹어도 종전엔 멈출 창구가 없었다. 이 토글이 그 창구다.
  //  DB 영속(재시작에도 유지 — 부팅 스윕이 존중) + 인메모리 캐시(실행 중 잡을 다음 배치에서 협조적 중단). knowledge·project 공통.
  restOnly("org_embeddings_backfill_pause", "임베딩 백필 일시중지/재개",
    "자동 임베딩 백필 스윕(부팅·10분 주기·connector_sync 완료 후·쓰기 nudge)을 사람이 멈추고 재개한다. paused=true 면 스윕이 no-op 이 되고 실행 중이던 백필 잡도 현재 배치를 끝내고 중단된다(재진입 안전 — 채운 만큼 커밋). DB 영속이라 재시작에도 유지된다. 재개(paused=false) 시 그동안 쌓인 미임베딩을 즉시 한 번 스윕한다. knowledge·project 공통 스위치. admin 전용.",
    [{ method: "POST", paths: ["/api/ui/org/embeddings/backfill/pause"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      if (typeof input.paused !== "boolean") throw new HttpError(400, "paused 는 boolean 이어야 합니다");
      const paused = input.paused;
      // DB 영속 — updateRuntimeConfig 가 before/after 감사를 남긴다(누가 언제 멈췄나).
      await updateRuntimeConfig({ embedding_backfill_paused: paused }, actorOf(user), ctx?.source ?? "web",
        { tokenHashPrefix: ctx?.tokenHashPrefix ?? null, ip: ctx?.ip ?? null });
      // 라이브 신호 — 실행 중 잡의 (동기) shouldStop 이 즉시 이 값을 읽어 다음 배치 경계에서 멈춘다.
      setBackfillPausedCache(paused);
      // 재개면 10분 주기를 안 기다리고 즉시 1회 드레인(provider off/pending 0/일시중지 재확인은 스윕이 자체 게이트).
      if (!paused) void runAutoBackfillSweep().catch(() => { /* best-effort */ });
      return { paused, job: getBackfillJob(), project_job: getBackfillJob(PROJECT_TARGET) };
    }, {
      paused: z.boolean().describe("true=자동 백필 일시중지(실행 중 잡도 다음 배치에서 중단) · false=재개(즉시 1회 드레인). DB 영속(#1060)"),
    }),
];
