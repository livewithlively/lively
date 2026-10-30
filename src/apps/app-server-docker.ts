// 자가호스팅 앱 서버의 컨테이너 겉면(#4487 앱 v2-8 · 결정 #5052 ③ Docker) — 앱 서버 판 하나 = 컨테이너 하나 · 빌드 한 번 = 버리는 컨테이너 하나.
//
//  운영 구현은 docker CLI 를 셸 없이(execFile · spawn) 부른다(DockerDriver). 시험은 같은 겉면(ContainerDriver)을 다른 구현으로 갈아 끼운다.
//  ★ 띄우는 인자는 이 파일이 짓는 두 꼴(appRunArgs · buildRunArgs)뿐이고, 띄우기 직전 검사기(ops/docker-run-guard)가 정책으로 한 번 더 거른다 —
//   docker 그룹은 사실상 root 라서 잘못된 인자 하나가 박스 전체를 내준다(레인 조율 4606 · 2026-10-28).
//  앱 서버 컨테이너(appRunArgs):
//   · 루트 읽기 전용 · /tmp 만 tmpfs(web.server.tmp_mb) · 메모리 = 메모리+스왑(스왑 없음) · CPU · pids 상한 · cap 전부 빼기 · no-new-privileges ·
//     게이트웨이 계정 uid:gid(비-root) · --init(신호 · 좀비 정리) · 다시 띄우지 않음(재우기 · 깨우기는 게이트웨이가 한다).
//   · 마운트는 판 코드(/var/task · 읽기 전용)와 레이어(/opt/<이름> · 읽기 전용 — 검사 층)뿐 · env 는 파일로(토큰이 프로세스 목록에 안 보이게).
//   · 네트워크는 컨테이너 사이 통신을 끈 전용 브리지(lvly-apps · enable_icc=false) — 앱끼리 서로 못 부른다. 바깥 나가기는 된다(게이트웨이 API · 외부 API).
//   · 검사 층 포트(:8099)만 박스의 127.0.0.1 무작위 포트로 낸다. ⚠ 리눅스 박스에서는 박스 위 다른 프로세스가 컨테이너 IP 의 앱 포트(:8080)에 바로
//     닿는다 — 검사 층 열쇠(x-lively-guard-key)를 SDK livelyMember 가 확인해 그 요청을 «사람 없음» 으로 만든다. 네트워크로 막는 것은 #5108.
//  빌드 컨테이너(buildRunArgs): 같은 이미지 · 자격 없음(env 는 정해진 몇 개뿐) · 루트 읽기 전용 · /tmp 는 이름 없는 볼륨(지우면 함께 사라진다 —
//   node_modules 를 박스 폴더 마운트로 쓰면 맥(virtiofs)에서 몇 배 느리다) · 결과 zip 만 /out(그 빌드 전용 빈 폴더)으로 · 같은 네트워크(바깥 나가기 —
//   npm 레지스트리 · 자격이 없어 빼앗길 것이 없고, 실행 컨테이너도 바깥에 나가므로 빌드만 막아도 얻는 것이 없다 · #4487 결정 ⑤ 기록).
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { assertSafeDockerRun, type DockerRunPolicy } from "../ops/docker-run-guard.js";

const execFileP = promisify(execFile);

/** 앱 서버 컨테이너 하나. */
export interface AppRunSpec {
  name: string;
  image: string;
  labels: Record<string, string>;
  network: string;
  memoryMb: number;
  tmpMb: number;
  cpus: number;
  pids: number;
  /** "uid:gid" — 게이트웨이 계정. */
  user: string;
  /** 읽기 전용 마운트(판 코드 /var/task · 레이어 /opt/<이름>). */
  ro: Array<{ host: string; target: string }>;
  envFile: string;
  /** 컨테이너 안 검사 층 포트(박스 쪽은 127.0.0.1 무작위). */
  guardPort: number;
  /** host.docker.internal 을 박스로(게이트웨이 주소가 그 이름일 때). */
  hostGateway: boolean;
  command: string[];
}

/** 빌드 컨테이너 하나 — stdin 으로 판을 받고 stdout 에 결과 줄 · stderr 에 기록. */
export interface BuildRunSpec {
  name: string;
  image: string;
  labels: Record<string, string>;
  network: string;
  memoryMb: number;
  cpus: number;
  pids: number;
  user: string;
  /** 결과 zip 을 쓸 박스 폴더(그 빌드 전용 · 빈 폴더) — 컨테이너 안 /out. */
  outDir: string;
  env: Record<string, string>;
  hostGateway: boolean;
  command: string[];
}

export const GUARD_IN_CONTAINER = 8099;
export const BUILD_OUT_IN_CONTAINER = "/out";
/** 빌드 컨테이너에 넣는 env 이름 — 이 밖은 검사기가 거절한다(자격이 새지 않게). */
export const BUILD_ENV_KEYS = /^(HOME|NODE_OPTIONS|npm_config_[a-z_]+|NO_COLOR|FORCE_COLOR|CI)$/;
const LOG_OPTS = ["--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=2"];
const HOST_GATEWAY = "host.docker.internal:host-gateway";

/** 앱 서버 컨테이너 인자(docker run …) — 정해진 꼴 하나. */
export function appRunArgs(s: AppRunSpec): string[] {
  return [
    "run", "-d", "--name", s.name,
    ...Object.entries(s.labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
    "--network", s.network,
    "--publish", `127.0.0.1::${s.guardPort}`,
    "--read-only", "--tmpfs", `/tmp:rw,nosuid,nodev,size=${s.tmpMb}m,mode=1777`,
    "--memory", `${s.memoryMb}m`, "--memory-swap", `${s.memoryMb}m`, "--cpus", String(s.cpus), "--pids-limit", String(s.pids),
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", s.user, "--init", "--restart", "no",
    ...s.ro.flatMap((m) => ["--volume", `${m.host}:${m.target}:ro`]),
    "--env-file", s.envFile,
    ...(s.hostGateway ? ["--add-host", HOST_GATEWAY] : []),
    "--workdir", "/var/task", "--stop-timeout", "5",
    ...LOG_OPTS,
    s.image, ...s.command,
  ];
}

/** 빌드 컨테이너 인자(docker run --rm -i …) — 정해진 꼴 하나. */
export function buildRunArgs(s: BuildRunSpec): string[] {
  return [
    "run", "--rm", "-i", "--name", s.name,
    ...Object.entries(s.labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
    "--network", s.network,
    "--read-only", "--mount", "type=volume,dst=/tmp",
    "--memory", `${s.memoryMb}m`, "--memory-swap", `${s.memoryMb}m`, "--cpus", String(s.cpus), "--pids-limit", String(s.pids),
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", s.user, "--init", "--restart", "no",
    "--volume", `${s.outDir}:${BUILD_OUT_IN_CONTAINER}`,
    ...Object.entries(s.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    ...(s.hostGateway ? ["--add-host", HOST_GATEWAY] : []),
    "--workdir", "/tmp",
    ...LOG_OPTS,
    s.image, ...s.command,
  ];
}

/** 앱 서버 컨테이너의 검사 정책 — 판 코드 · 레이어는 뿌리 아래 읽기 전용 · env 파일은 뿌리 아래 · tmpfs 는 /tmp 만. */
export function appRunPolicy(root: string, image: string, network: string): DockerRunPolicy {
  return {
    networks: [network], images: [image], readOnly: true, publish: true, tmpfs: ["/tmp"], addHosts: [HOST_GATEWAY],
    binds: [{ root, rw: false, targets: /^\/(var\/task|opt\/[A-Za-z0-9_-]{1,64})$/ }],
    envFiles: [root],
  };
}
/** 빌드 컨테이너의 검사 정책 — 쓰기 마운트는 그 빌드의 /out 하나 · /tmp 는 이름 없는 볼륨 · env 는 정해진 이름만. */
export function buildRunPolicy(buildRoot: string, image: string, network: string): DockerRunPolicy {
  return {
    networks: [network], images: [image], readOnly: true, publish: false, volumes: ["/tmp"], addHosts: [HOST_GATEWAY],
    binds: [{ root: buildRoot, rw: true, targets: /^\/out$/ }],
    envKeys: BUILD_ENV_KEYS,
  };
}

export interface ContainerState { running: boolean; exitCode: number | null; oomKilled: boolean; startedAt: string | null }
export interface ListedContainer { name: string; labels: Record<string, string>; running: boolean; port: number | null }

/** 컨테이너 겉면 — 운영 = DockerDriver · 시험 = 같은 꼴의 다른 구현. */
export interface ContainerDriver {
  /** 박스(Docker) 메모리(MB) · CPU 수. */
  info(): Promise<{ memMb: number; cpus: number }>;
  ensureImage(image: string): Promise<void>;
  /** 컨테이너 사이 통신을 끈 브리지 — 없으면 만들고, 있는데 통신이 켜져 있으면 거절한다. */
  ensureNetwork(name: string): Promise<void>;
  /** 앱 서버 컨테이너를 띄운다 — 박스 쪽 검사 층 포트(127.0.0.1 · 포트를 읽기 전에 앱이 끝났으면 0). 같은 이름이 있으면 실패한다(부르는 쪽이 먼저 지운다). */
  runApp(spec: AppRunSpec, policy: DockerRunPolicy): Promise<{ port: number }>;
  state(name: string): Promise<ContainerState | null>;
  logs(name: string, tail: number): Promise<string>;
  /** 없으면 그냥 지나간다. */
  remove(name: string, opts?: { graceSec?: number }): Promise<void>;
  list(label: string): Promise<ListedContainer[]>;
  spawnBuild(spec: BuildRunSpec, policy: DockerRunPolicy): ChildProcess;
  /** 빌드 컨테이너 안의 /out 이 가리키는 박스 폴더 — 운영은 spec.outDir 그대로(컨테이너 안 /out). */
  buildOutInContainer(spec: BuildRunSpec): string;
}

export class DockerError extends Error {
  constructor(message: string, readonly stderr: string = "") { super(message); this.name = "DockerError"; }
}

/** docker CLI 운영 구현 — 실행 파일은 env LIVELY_DOCKER_BIN(기본 docker · PATH). */
export class DockerDriver implements ContainerDriver {
  constructor(private readonly bin: string = process.env.LIVELY_DOCKER_BIN?.trim() || "docker") {}

  private async run(args: string[], timeoutMs = 60_000): Promise<string> {
    try {
      const { stdout } = await execFileP(this.bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
      return stdout;
    } catch (e) {
      const err = e as { code?: unknown; stderr?: string; message?: string };
      if (err.code === "ENOENT") throw new DockerError(`docker 를 찾지 못했습니다(${this.bin}) — 박스에 Docker 를 깔고 게이트웨이 계정을 docker 그룹에 넣으세요`);
      const stderr = String(err.stderr ?? "").trim();
      throw new DockerError(`docker ${args[0]} 실패: ${(stderr || err.message || String(e)).slice(0, 500)}`, stderr);
    }
  }

  async info(): Promise<{ memMb: number; cpus: number }> {
    const out = await this.run(["info", "--format", "{{.MemTotal}} {{.NCPU}}"], 20_000);
    const [mem, cpus] = out.trim().split(/\s+/).map(Number);
    return { memMb: Math.floor((mem ?? 0) / 1048576), cpus: cpus || 1 };
  }

  async ensureImage(image: string): Promise<void> {
    try { await this.run(["image", "inspect", "--format", "{{.Id}}", image], 20_000); return; } catch (e) {
      if (!(e instanceof DockerError) || !/No such image|not found/i.test(e.stderr || e.message)) throw e;
    }
    await this.run(["pull", "--quiet", image], 10 * 60_000);
  }

  async ensureNetwork(name: string): Promise<void> {
    let out: string;
    try { out = await this.run(["network", "inspect", "--format", "{{json .Options}}", name], 20_000); } catch (e) {
      if (!(e instanceof DockerError) || !/No such network|not found/i.test(e.stderr || e.message)) throw e;
      await this.run(["network", "create", "--driver", "bridge", "--opt", "com.docker.network.bridge.enable_icc=false", "--label", "lvly.app-server=1", name], 30_000)
        .catch(async (err) => { if (!/already exists/i.test(String((err as Error).message))) throw err; });
      out = await this.run(["network", "inspect", "--format", "{{json .Options}}", name], 20_000);
    }
    let opts: Record<string, string> = {};
    try { opts = JSON.parse(out.trim() || "{}") ?? {}; } catch { /* 아래에서 거절 */ }
    if (opts["com.docker.network.bridge.enable_icc"] !== "false") {
      throw new DockerError(`네트워크 ${name} 가 컨테이너 사이 통신을 켠 채입니다 — 앱 서버끼리 서로 부를 수 있어 쓰지 않습니다. 그 네트워크를 지우면(docker network rm ${name}) 게이트웨이가 다시 만듭니다`);
    }
  }

  async runApp(spec: AppRunSpec, policy: DockerRunPolicy): Promise<{ port: number }> {
    const args = appRunArgs(spec);
    assertSafeDockerRun(args, policy);
    await this.run(args, 60_000);
    for (let n = 0; n < 20; n++) {
      const out = await this.run(["port", spec.name, `${spec.guardPort}/tcp`], 10_000).catch(() => "");
      const m = /127\.0\.0\.1:(\d+)/.exec(out);
      if (m) return { port: Number(m[1]) };
      //  앱이 띄우자마자 끝났다(메모리 상한 · 시작 오류 — 끝난 컨테이너는 포트가 없다) — Docker 탓이 아니다. 0 을 돌려 부르는 쪽이 기록 · 까닭을 읽게 한다.
      if ((await this.state(spec.name).catch(() => null))?.running === false) return { port: 0 };
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new DockerError(`컨테이너 ${spec.name} 의 포트를 읽지 못했습니다`);
  }

  async state(name: string): Promise<ContainerState | null> {
    try {
      const out = await this.run(["inspect", "--format", "{{json .State}}", name], 10_000);
      const s = JSON.parse(out.trim()) as { Running?: boolean; ExitCode?: number; OOMKilled?: boolean; StartedAt?: string };
      return { running: !!s.Running, exitCode: s.Running ? null : (s.ExitCode ?? null), oomKilled: !!s.OOMKilled, startedAt: s.StartedAt ?? null };
    } catch (e) {
      if (e instanceof DockerError && /No such (object|container)/i.test(e.stderr || e.message)) return null;
      throw e;
    }
  }

  async logs(name: string, tail: number): Promise<string> {
    try {
      const { stdout, stderr } = await execFileP(this.bin, ["logs", "--tail", String(tail), name], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
      return `${stdout}${stderr}`;
    } catch { return ""; }
  }

  async remove(name: string, opts: { graceSec?: number } = {}): Promise<void> {
    if (opts.graceSec) await this.run(["stop", "--time", String(opts.graceSec), name], (opts.graceSec + 15) * 1000).catch(() => { /* 없거나 이미 멈춤 */ });
    await this.run(["rm", "-f", name], 30_000).catch((e) => {
      if (e instanceof DockerError && /No such container/i.test(e.stderr || e.message)) return;
      throw e;
    });
  }

  async list(label: string): Promise<ListedContainer[]> {
    const out = await this.run(["ps", "-a", "--filter", `label=${label}`, "--format", "{{json .}}"], 20_000);
    const rows: ListedContainer[] = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      let o: { Names?: string; Labels?: string; State?: string; Ports?: string };
      try { o = JSON.parse(line); } catch { continue; }
      const labels: Record<string, string> = {};
      for (const kv of String(o.Labels ?? "").split(",")) { const i = kv.indexOf("="); if (i > 0) labels[kv.slice(0, i)] = kv.slice(i + 1); }
      const m = /127\.0\.0\.1:(\d+)->/.exec(String(o.Ports ?? ""));
      rows.push({ name: String(o.Names ?? ""), labels, running: o.State === "running", port: m ? Number(m[1]) : null });
    }
    return rows;
  }

  spawnBuild(spec: BuildRunSpec, policy: DockerRunPolicy): ChildProcess {
    const args = buildRunArgs(spec);
    assertSafeDockerRun(args, policy);
    return spawn(this.bin, args, { stdio: ["pipe", "pipe", "pipe"] });
  }

  buildOutInContainer(): string { return BUILD_OUT_IN_CONTAINER; }
}
