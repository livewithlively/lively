// docker run 인자 검사기(#4487 앱 v2-8 · #5082 자체 호스팅 작업 실행면과 같이 쓴다) — 코어가 docker CLI 로 컨테이너를 띄우기 직전에 인자 목록을
//  허용 목록으로 거른다.
//
//  왜: docker 그룹은 사실상 root 다(데몬이 root 로 돈다 — 고위드 박스 실측 2026-10-28 · 레인 조율 4606). 인자 하나(--privileged · 호스트 PID/IPC ·
//   docker 소켓 마운트 · 박스 폴더 쓰기 마운트 · --cap-add)가 박스 전체를 내준다. 인자는 부르는 쪽이 정해진 꼴로 짓지만, 짓는 코드가 틀려도
//   (또는 사람 입력이 섞여도) 이 검사기를 지나야 띄운다.
//  규칙: 아는 깃발만 · 정해진 꼴만 · 꼭 있어야 하는 깃발(비-root 사용자 · cap 전부 빼기 · no-new-privileges · 메모리 = 메모리+스왑 · pids 상한 · 네트워크)이
//   있어야 한다. 모르는 깃발은 무엇이든 거절한다(막는 목록이 아니라 허용 목록 — 새 깃발이 생겨도 저절로 막힌다).
import fs from "node:fs";
import path from "node:path";

export interface DockerRunPolicy {
  /** 허용하는 --network 값(예 ["lvly-apps"] · 작업 컨테이너는 ["host"]). --network 가 없으면 거절한다. */
  networks: string[];
  /**
   * 바인드 마운트(-v 원본:자리[:opts] · --mount type=bind,src=,dst=[,readonly]) — 원본은 이 뿌리 아래만. rw:false 면 읽기 전용만 받는다 ·
   *  targets 를 주면 컨테이너 쪽 자리가 그 꼴이어야 한다 · source 를 주면 원본이 정확히 그 경로여야 한다(뿌리 안의 다른 자리를 붙이지 않게 — #5082).
   */
  binds: Array<{ root: string; rw: boolean; targets?: RegExp; source?: string }>;
  /** --user 로 받는 «uid:gid»(정확히 이 목록) — 없으면 비-root 숫자 꼴만 본다(#5082 작업 컨테이너는 그 박스의 정해진 계정만). */
  users?: string[];
  /** --tmpfs 를 둘 수 있는 컨테이너 자리. */
  tmpfs?: string[];
  /** tmpfs 에 exec 를 줄 수 있는 자리(없으면 exec 를 받지 않는다 — 도커 기본 noexec 그대로 · #5082 작업 컨테이너는 /tmp · HOME). */
  tmpfsExec?: string[];
  /** 이름 없는 볼륨(--mount type=volume,dst=…)을 둘 수 있는 자리 — 컨테이너를 지우면 함께 사라지는 쓰기 자리(빌드의 /tmp). */
  volumes?: string[];
  /** 띄울 수 있는 이미지(정확히 같은 글). */
  images: string[];
  /** --read-only(루트 파일 시스템 읽기 전용)가 꼭 있어야 하나. */
  readOnly: boolean;
  /** -p 를 받나 — 받으면 박스의 127.0.0.1 에만 묶는 꼴만. */
  publish?: boolean;
  /** --env-file 을 둘 수 있는 뿌리. */
  envFiles?: string[];
  /** -e KEY=VALUE 의 KEY 꼴(없으면 -e 를 받지 않는다). 값 없이 -e KEY(부르는 쪽 env 를 넘김)는 늘 거절한다. */
  envKeys?: RegExp;
  /** --add-host 로 받는 값(정확히 같은 글). */
  addHosts?: string[];
  /** --group-add 로 받는 숫자 gid(정확히 이 목록 · 0 · 이름은 늘 거절) — --user uid:gid 로 띄우면 박스 계정의 보조 그룹이 따라오지 않아 공유 폴더(setgid)에 못 쓴다(#5082). */
  groupAdds?: number[];
}

export class DockerRunRejected extends Error {
  constructor(readonly reason: string) { super(`컨테이너 인자를 거절했습니다 — ${reason}`); this.name = "DockerRunRejected"; }
}

const NO_VALUE = new Set(["-d", "--detach", "-i", "--interactive", "--rm", "--read-only", "--init"]);
const WITH_VALUE = new Set([
  "--name", "--label", "-l", "--network", "--net", "-p", "--publish", "--tmpfs", "--memory", "-m", "--memory-swap", "--cpus", "--pids-limit",
  "--cap-drop", "--security-opt", "--user", "-u", "--restart", "-v", "--volume", "--mount", "--env-file", "-e", "--env", "--add-host",
  "--log-driver", "--log-opt", "-w", "--workdir", "--stop-timeout", "--group-add", "--oom-score-adj",
]);
/** 사람이 읽을 까닭을 붙여 따로 막는 깃발 — 허용 목록 밖이라 어차피 막히지만, 무엇이 왜 막혔는지 글로 남긴다. */
const DANGEROUS: Record<string, string> = {
  "--privileged": "모든 장치 · 권한을 준다", "--pid": "박스 프로세스를 보게 한다", "--ipc": "박스 공유 메모리를 보게 한다", "--uts": "박스 이름 공간",
  "--userns": "사용자 이름 공간을 끈다", "--cgroupns": "박스 cgroup", "--cap-add": "권한을 더한다", "--device": "장치를 넘긴다", "--volumes-from": "남의 마운트를 가져온다",
  "--sysctl": "커널 값을 바꾼다", "--gpus": "장치를 넘긴다", "--entrypoint": "시작 명령을 바꾼다", "--network-alias": "네트워크 이름",
};

const canon = (flag: string): string => ({ "-l": "--label", "--net": "--network", "-p": "--publish", "-m": "--memory", "-u": "--user", "-v": "--volume", "-e": "--env", "-w": "--workdir" } as Record<string, string>)[flag] ?? flag;
const MEM_RE = /^[1-9]\d{0,6}[mg]$/;
const CLEAN_RE = /^[^\0\r\n]*$/;

/** 절대 경로를 다듬는다 — 빈 칸 · . · .. 마디가 있으면 null(글로 뿌리 밖을 가리키지 않게). 끝의 / 하나는 뗀다. */
function cleanAbs(p: string): string | null {
  if (!p.startsWith("/")) return null;
  const segs = p.split("/").slice(1);
  if (segs.length && segs[segs.length - 1] === "") segs.pop();
  if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
  return "/" + segs.join("/");
}
const inside = (a: string, r: string): boolean => a === r || a.startsWith(r === "/" ? "/" : r + "/");

/** 바인드의 원본 · 자리 · 쓰기가 정책 안인가 — -v 와 --mount type=bind 가 같은 판정을 쓴다(정책의 source 가 있으면 원본이 정확히 그 경로). */
function bindOk(policy: DockerRunPolicy, src: string, dst: string, ro: boolean): boolean {
  return policy.binds.some((b) => underRoot(src, b.root) && (b.rw || ro) && (!b.targets || b.targets.test(dst))
    && (b.source === undefined || (cleanAbs(src) !== null && cleanAbs(src) === cleanAbs(b.source))));
}

/**
 * 원본 경로가 뿌리 안인가 — 다듬은 글로 보고, 실제 경로(심링크를 푼 것)로도 본다(뿌리 안의 링크가 밖을 가리키지 않게).
 *  아직 없는 자리면 가장 가까운 있는 윗폴더의 실제 경로로 본다(docker 가 그 자리를 만들 때 밖으로 새지 않게).
 */
function underRoot(p: string, root: string): boolean {
  const n = cleanAbs(p), r = cleanAbs(root);
  if (!n || !r || !inside(n, r)) return false;
  let realRoot: string;
  try { realRoot = fs.realpathSync(r); } catch { return false; }
  let cur = n;
  while (!fs.existsSync(cur)) { const up = path.dirname(cur); if (up === cur) return false; cur = up; }
  let real: string;
  try { real = fs.realpathSync(cur); } catch { return false; }
  return inside(real, realRoot);
}

/**
 * 인자 목록(docker CLI 에 넘길 것 — 맨 앞은 "run")을 검사한다. 어긋나면 DockerRunRejected. 돌려주는 것은 이미지 이름과 그 뒤의 명령(부르는 쪽 확인용).
 *  ⚠ 이미지 뒤의 글은 컨테이너 안 명령이라 거르지 않는다(컨테이너 밖에 닿지 않는다).
 */
export function assertSafeDockerRun(args: readonly string[], policy: DockerRunPolicy): { image: string; command: string[] } {
  const no = (why: string): never => { throw new DockerRunRejected(why); };
  if (args[0] !== "run") no("docker run 만 검사합니다");
  const seen = new Map<string, string[]>();
  const tmpfsOwners: Array<{ key: "uid" | "gid"; value: string }> = [];
  let i = 1;
  for (; i < args.length; i++) {
    const tok = args[i]!;
    if (!tok.startsWith("-")) break;
    if (!CLEAN_RE.test(tok)) no("인자에 줄바꿈 · NUL 이 있습니다");
    const eq = tok.startsWith("--") ? tok.indexOf("=") : -1;
    const raw = eq > 0 ? tok.slice(0, eq) : tok;
    if (DANGEROUS[raw]) no(`${raw} 는 받지 않습니다(${DANGEROUS[raw]})`);
    const flag = canon(raw);
    if (NO_VALUE.has(raw)) { if (eq > 0) no(`${raw} 는 값을 받지 않습니다`); seen.set(flag, [...(seen.get(flag) ?? []), ""]); continue; }
    if (!WITH_VALUE.has(raw)) no(`모르는 깃발입니다: ${raw.slice(0, 40)}`);
    let value: string;
    if (eq > 0) value = tok.slice(eq + 1);
    else { i++; if (i >= args.length) no(`${raw} 뒤에 값이 없습니다`); value = args[i]!; }
    if (!CLEAN_RE.test(value)) no(`${raw} 값에 줄바꿈 · NUL 이 있습니다`);
    seen.set(flag, [...(seen.get(flag) ?? []), value]);
    switch (flag) {
      case "--network":
        if (!policy.networks.includes(value)) no(`네트워크 ${value.slice(0, 40)} 는 받지 않습니다(${policy.networks.join(" · ")} 만)`);
        break;
      case "--publish":
        if (!policy.publish) no("포트를 내지 않습니다(-p)");
        if (!/^127\.0\.0\.1:(\d{1,5})?:\d{1,5}(\/tcp)?$/.test(value)) no(`포트는 박스의 127.0.0.1 에만 묶습니다: ${value.slice(0, 40)}`);
        break;
      case "--tmpfs": {
        const c = value.indexOf(":");
        const at = c < 0 ? value : value.slice(0, c), opts = c < 0 ? "" : value.slice(c + 1);
        if (!(policy.tmpfs ?? []).includes(at)) no(`tmpfs 자리 ${at.slice(0, 40)} 는 받지 않습니다`);
        for (const o of opts ? opts.split(",") : []) {
          if (!/^(rw|nosuid|nodev|noexec|exec|size=\d+[kmg]?|mode=[0-7]{3,4}|uid=\d{1,10}|gid=\d{1,10})$/.test(o)) no(`tmpfs 선택 ${o.slice(0, 30)} 는 받지 않습니다`);
          if (o === "exec" && !(policy.tmpfsExec ?? []).includes(at)) no(`tmpfs ${at.slice(0, 40)} 에는 exec 를 주지 않습니다(정책에 적은 자리만)`);
          //  임자(uid · gid)는 컨테이너 사용자(--user)와 같을 때만 — 끝에서 맞춰 본다(남의 · root 소유 자리를 만들지 않게).
          const own = /^(uid|gid)=(\d+)$/.exec(o);
          if (own) tmpfsOwners.push({ key: own[1] as "uid" | "gid", value: own[2]! });
        }
        break;
      }
      case "--memory": case "--memory-swap":
        if (!MEM_RE.test(value)) no(`${flag} 꼴이 틀렸습니다(예 512m): ${value.slice(0, 20)}`);
        break;
      case "--cpus":
        if (!/^\d{1,3}(\.\d{1,3})?$/.test(value) || Number(value) <= 0) no(`--cpus 꼴이 틀렸습니다: ${value.slice(0, 20)}`);
        break;
      case "--pids-limit":
        if (!/^[1-9]\d{0,6}$/.test(value)) no(`--pids-limit 은 1 이상 정수입니다: ${value.slice(0, 20)}`);
        break;
      case "--cap-drop":
        if (value !== "ALL") no("--cap-drop 은 ALL 만 받습니다");
        break;
      case "--security-opt":
        if (value !== "no-new-privileges" && value !== "no-new-privileges:true") no(`--security-opt ${value.slice(0, 40)} 는 받지 않습니다(no-new-privileges 만)`);
        break;
      case "--user": {
        const m = /^(\d{1,10}):(\d{1,10})$/.exec(value);
        if (!m) no("--user 는 숫자 uid:gid 입니다");
        if (Number(m![1]) === 0) no("컨테이너 안은 root 가 아닌 사용자로 돕니다(uid 0 거절)");
        if (policy.users && !policy.users.includes(value)) no(`--user ${value.slice(0, 24)} 는 이 컨테이너가 돌 수 있는 계정이 아닙니다`);
        break;
      }
      case "--restart":
        if (value !== "no") no("--restart 는 no 만 받습니다");
        break;
      case "--group-add":
        if (!/^[1-9]\d{0,9}$/.test(value) || !(policy.groupAdds ?? []).includes(Number(value))) no(`--group-add ${value.slice(0, 20)} 는 받지 않습니다(그룹을 더한다 — 정책에 적은 숫자 gid 만)`);
        break;
      case "--oom-score-adj":
        //  0~1000 — 메모리가 모자랄 때 먼저 죽는 쪽으로만(음수는 박스의 게이트웨이 · DB 보다 오래 살게 한다).
        if (!/^\d{1,4}$/.test(value) || Number(value) > 1000) no(`--oom-score-adj 는 0~1000 입니다: ${value.slice(0, 20)}`);
        break;
      case "--volume": {
        const parts = value.split(":");
        if (parts.length < 2 || parts.length > 3) no(`-v 꼴이 틀렸습니다: ${value.slice(0, 80)}`);
        const [src, dst, opts = ""] = parts as [string, string, string?];
        if (/docker\.sock/.test(src) || /docker\.sock/.test(dst)) no("docker 소켓은 마운트하지 않습니다");
        if (cleanAbs(dst) !== dst || dst === "/") no(`마운트 자리가 틀렸습니다: ${dst.slice(0, 80)}`);
        const optSet = new Set(opts ? opts.split(",") : []);
        for (const o of optSet) if (!["ro", "rw", "z", "Z"].includes(o)) no(`-v 선택 ${o.slice(0, 20)} 는 받지 않습니다`);
        const ro = optSet.has("ro");
        if (!bindOk(policy, src, dst, ro)) no(`마운트 원본 ${src.slice(0, 120)} → ${dst.slice(0, 60)}${ro ? "(읽기 전용)" : "(쓰기)"} 는 받지 않습니다`);
        break;
      }
      case "--mount": {
        const pairs = value.split(",").map((p): [string, string] => { const k = p.indexOf("="); return k < 0 ? [p, ""] : [p.slice(0, k), p.slice(k + 1)]; });
        if (new Set(pairs.map(([k]) => k)).size !== pairs.length) no(`--mount 에 같은 선택이 두 번 있습니다: ${value.slice(0, 80)}`);
        const kv = new Map(pairs);
        //  같은 뜻의 이름(dst · destination · target / src · source)을 둘 적으면 이 검사기와 도커가 다른 값을 읽을 수 있다 — 하나만 받는다.
        const pick = (names: string[]): string => {
          const have = names.filter((n) => kv.has(n));
          if (have.length !== 1) no(`--mount 에는 ${names.join(" · ")} 중 하나만 적습니다: ${value.slice(0, 80)}`);
          return kv.get(have[0]!)!;
        };
        const dst = pick(["dst", "destination", "target"]);
        if (kv.get("type") === "bind") {
          //  #5082 — 원본이 없으면 도커가 만들지 않고 실패하는 바인드(-v 는 없는 원본을 root 소유 폴더로 만들어 그 자리 주인의 폴더를 망가뜨린다).
          const src = pick(["src", "source"]);
          const extra = [...kv.keys()].filter((k) => !["type", "src", "source", "dst", "destination", "target", "readonly"].includes(k));
          if (extra.length) no(`--mount bind 선택 ${extra[0]!.slice(0, 20)} 는 받지 않습니다`);
          const roRaw = kv.get("readonly");
          if (roRaw !== undefined && roRaw !== "" && roRaw !== "true") no("--mount bind 의 readonly 는 값 없이(또는 true)만 받습니다");
          const ro = roRaw !== undefined;
          if (/docker\.sock/.test(src) || /docker\.sock/.test(dst)) no("docker 소켓은 마운트하지 않습니다");
          if (cleanAbs(dst) !== dst || dst === "/") no(`마운트 자리가 틀렸습니다: ${dst.slice(0, 80)}`);
          if (!bindOk(policy, src, dst, ro)) no(`마운트 원본 ${src.slice(0, 120)} → ${dst.slice(0, 60)}${ro ? "(읽기 전용)" : "(쓰기)"} 는 받지 않습니다`);
          break;
        }
        const keys = [...kv.keys()].filter((k) => !["type", "dst", "destination", "target"].includes(k));
        if (kv.get("type") !== "volume" || keys.length || !(policy.volumes ?? []).includes(dst)) no(`--mount 는 이름 없는 볼륨만(${(policy.volumes ?? []).join(" · ") || "없음"}): ${value.slice(0, 80)}`);
        break;
      }
      case "--env-file":
        if (!(policy.envFiles ?? []).some((r) => underRoot(value, r))) no(`env 파일 ${value.slice(0, 120)} 는 받지 않습니다`);
        break;
      case "--env": {
        const k = value.indexOf("=");
        if (k <= 0) no("값 없는 -e(부르는 쪽 env 넘기기)는 받지 않습니다");
        if (!policy.envKeys || !policy.envKeys.test(value.slice(0, k))) no(`env ${value.slice(0, Math.min(k, 40))} 는 받지 않습니다`);
        break;
      }
      case "--add-host":
        if (!(policy.addHosts ?? []).includes(value)) no(`--add-host ${value.slice(0, 60)} 는 받지 않습니다`);
        break;
      case "--log-driver":
        if (value !== "json-file" && value !== "local") no(`--log-driver ${value.slice(0, 20)} 는 받지 않습니다`);
        break;
      case "--log-opt":
        if (!/^(max-size=\d+[kmg]|max-file=\d{1,2})$/.test(value)) no(`--log-opt ${value.slice(0, 30)} 는 받지 않습니다`);
        break;
      case "--workdir":
        if (cleanAbs(value) !== value) no(`작업 폴더가 틀렸습니다: ${value.slice(0, 60)}`);
        break;
      case "--stop-timeout":
        if (!/^\d{1,3}$/.test(value)) no("--stop-timeout 은 초(정수)입니다");
        break;
      case "--name":
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) no(`이름 꼴이 틀렸습니다: ${value.slice(0, 40)}`);
        break;
      case "--label":
        if (!/^[a-z0-9][a-z0-9._-]{0,63}=[^\s]{0,200}$/.test(value)) no(`라벨 꼴이 틀렸습니다: ${value.slice(0, 40)}`);
        break;
    }
  }
  const image = args[i];
  if (!image) no("이미지가 없습니다");
  if (!policy.images.includes(image!)) no(`이미지 ${image!.slice(0, 80)} 는 받지 않습니다`);
  //  꼭 있어야 하는 것 — 하나라도 없으면 거절.
  const one = (f: string): string | null => { const v = seen.get(f); if (v && v.length > 1 && f !== "--label" && f !== "--volume" && f !== "--tmpfs" && f !== "--log-opt" && f !== "--env" && f !== "--mount" && f !== "--group-add") no(`${f} 가 두 번 있습니다`); return v?.[0] ?? null; };
  for (const f of ["--network", "--publish", "--memory", "--memory-swap", "--cpus", "--pids-limit", "--cap-drop", "--security-opt", "--user", "--restart", "--env-file", "--workdir", "--name", "--log-driver", "--oom-score-adj"]) one(f);
  const user = one("--user");
  if (!user) no("--user(비-root uid:gid)가 없습니다");
  const [uid, gid] = user!.split(":");
  for (const o of tmpfsOwners) if (o.value !== (o.key === "uid" ? uid : gid)) no(`tmpfs ${o.key}=${o.value} 는 컨테이너 사용자(${user})와 다릅니다`);
  if (!one("--cap-drop")) no("--cap-drop ALL 이 없습니다");
  if (!one("--security-opt")) no("--security-opt no-new-privileges 가 없습니다");
  if (!one("--network")) no("--network 가 없습니다(기본 브리지에 붙지 않게 늘 정한다)");
  if (!one("--pids-limit")) no("--pids-limit 이 없습니다");
  const mem = one("--memory"), swap = one("--memory-swap");
  if (!mem) no("--memory 가 없습니다");
  if (swap !== mem) no("--memory-swap 은 --memory 와 같아야 합니다(스왑 없음)");
  if (policy.readOnly && !seen.has("--read-only")) no("--read-only 가 없습니다");
  return { image: image!, command: args.slice(i + 1) as string[] };
}
