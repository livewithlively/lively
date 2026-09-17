// 라이블리 Windows 설치 도우미 (#4066)
//
// ── 왜 따로 있나 ──────────────────────────────────────────────────────────────────────────────────
//  브라우저로 받은 exe 를 실행하면 Microsoft Defender SmartScreen 이 그 파일의 평판을 본다. 평판은 **파일마다** 쌓인다.
//  우리 설치 파일(Lively-Setup-<버전>.exe)은 앱 전체를 담고 있고 자동 업데이트 파일도 겸해서 릴리스마다 바뀐다.
//  그래서 평판이 쌓일 틈이 없어 첫 설치마다 «Windows의 PC 보호» 가 떴다. 서명은 정상이었다
//  (지식 windows-smartscreen-signed-still-warns-4066).
//  이 도우미는 **내용이 바뀌지 않는** 첫 설치용 파일이다. 브라우저로 받는 파일을 이것 하나로 고정해 평판을 한 파일에 모은다.
//  도우미는 최신 설치 파일을 직접 받는다. 브라우저를 거치지 않으니 «인터넷에서 받음» 표시(Zone.Identifier)가 붙지 않고,
//  CreateProcess 로 실행하니 SmartScreen 확인도 거치지 않는다. 그 대신 아래 두 가지를 도우미가 직접 확인한다.
//
// ── 한 번 빌드해서 계속 쓴다 ──────────────────────────────────────────────────────────────────────
//  다시 빌드·서명하면 바이트가 달라져 쌓은 평판이 0 으로 돌아간다. 그래서 이 파일에는 **버전별 값이 없다** —
//  최신 버전은 실행할 때 GitHub 에서 알아낸다. 고칠 일이 생기면 .github/workflows/desktop-installer-helper.yml 을
//  replace 로 다시 돌리고, 새 파일을 Microsoft 검토에 다시 넣는다.
//
// ── 확인하는 것 (설치된 앱의 자동 업데이트와 같은 기준) ─────────────────────────────────────────────
//  ① 받은 파일의 sha512 가 latest.yml 의 값과 같다 — electron-updater 가 업데이트 파일에 하는 검사와 같다.
//  ② Authenticode 서명이 유효하고(WinVerifyTrust), 서명자가 Config.Publisher 와 맞는다. 맞는지 보는 규칙은
//     electron-updater 6.8.9 windowsExecutableCodeSignatureVerifier 와 같다(적힌 DN 키가 모두 같아야 한다).
//     Config.Publisher 는 release-desktop.yml 의 WIN_SIGN_PUBLISHER 와 같아야 한다 — desktop-core.test.mjs Z8 이 못박는다.
//
// 실행 인자
//   (없음)        화면을 띄우고 받기 → 확인 → 설치 파일 실행
//   --no-install  화면 모드로 받고 확인까지만 한다(설치하지 않고 닫는다 — 실기·CI 화면 점검용)
//   --dry-run     화면 없이 받고 확인만 한다(종료 코드 0 = 통과)
//   --self-test   판정 규칙을 selftest-cases.tsv 로 점검한다(종료 코드 0 = 통과)
//   --log <파일>  기록 파일(기본 %TEMP%\lively-setup.log)
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

// P/Invoke 는 System32 에서만 찾는다 — 도우미는 «내려받기» 폴더에서 실행되므로 옆에 놓인 같은 이름의 DLL 을 싣지 않게 한다.
[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

namespace Lively.Setup
{
    /// <summary>고정값 — 도우미에는 버전별 값이 없다.</summary>
    internal static class Config
    {
        public const string Owner = "livewithlively";
        public const string Repo = "lively";
        /// <summary>release-desktop.yml 의 WIN_SIGN_PUBLISHER 와 같은 값 — 설치된 앱이 업데이트 파일을 받아들이는 기준과 같다.</summary>
        public const string Publisher = "CN=라이블리, O=라이블리";
        public const string RepoUrl = "https://github.com/" + Owner + "/" + Repo;
        /// <summary>최신 릴리스. Accept: application/json 이면 {"tag_name": …} 을 준다(electron-updater GitHubProvider.getLatestTagName 과 같은 길).</summary>
        public const string LatestUrl = RepoUrl + "/releases/latest";
        public const string UserAgent = "Lively-Setup/1.0";
        public const int MaxTextBytes = 1 << 20;                 // latest.yml · 릴리스 JSON 상한
        public const long MaxInstallerBytes = 1L << 31;          // 설치 파일 상한(2GB) — 넘으면 무언가 잘못됐다
        public static readonly TimeSpan TextTimeout = TimeSpan.FromSeconds(30);
        public static readonly TimeSpan StallTimeout = TimeSpan.FromSeconds(60);   // 받는 중 이만큼 아무것도 안 오면 멈춘다

        public static string AssetUrl(string tag, string name) =>
            RepoUrl + "/releases/download/" + Uri.EscapeDataString(tag) + "/" + Uri.EscapeDataString(name);
    }

    internal sealed class Manifest
    {
        public string Version = "";
        public string Path = "";
        public string Sha512 = "";
        public long Size = -1;
    }

    /// <summary>판정 규칙 — 네트워크·파일과 무관한 순수 함수. --self-test 가 selftest-cases.tsv 로 점검한다.</summary>
    internal static class Rules
    {
        const RegexOptions Opts = RegexOptions.CultureInvariant;
        static readonly Regex TagRe = new Regex(@"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$", Opts);
        static readonly Regex FileRe = new Regex(@"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.exe$", Opts | RegexOptions.IgnoreCase);
        static readonly Regex Sha512Re = new Regex(@"^[A-Za-z0-9+/]{86}==$", Opts);
        static readonly Regex TagJsonRe = new Regex("\"tag_name\"\\s*:\\s*\"([^\"\\\\]*)\"", Opts);
        static readonly Regex TagUrlRe = new Regex(@"/releases/tag/([^/?#]+)$", Opts);
        static readonly Regex TopKeyRe = new Regex(@"^([A-Za-z0-9_]+):[ \t]*(.*)$", Opts);
        static readonly Regex ItemStartRe = new Regex(@"^[ \t]*-[ \t]+([A-Za-z0-9_]+):[ \t]*(.*)$", Opts);
        static readonly Regex ItemKeyRe = new Regex(@"^[ \t]+([A-Za-z0-9_]+):[ \t]*(.*)$", Opts);

        /// <summary>최신 릴리스 응답 → 태그. JSON 의 tag_name 을 먼저 믿고, 없으면 리다이렉트된 최종 주소(/releases/tag/…)에서 읽는다.</summary>
        public static string TagFromRelease(string body, string finalUrl)
        {
            string tag = null;
            var m = TagJsonRe.Match(body ?? "");
            if (m.Success) tag = m.Groups[1].Value;
            else if (finalUrl != null)
            {
                var u = TagUrlRe.Match(finalUrl);
                if (u.Success) tag = Uri.UnescapeDataString(u.Groups[1].Value);
            }
            if (tag == null || !TagRe.IsMatch(tag)) throw new FormatException("최신 릴리스의 태그를 읽지 못했다: " + (tag ?? "(없음)"));
            return tag;
        }

        static string Unquote(string v)
        {
            v = (v ?? "").Trim();
            if (v.Length >= 2 && v[0] == '\'' && v[v.Length - 1] == '\'') return v.Substring(1, v.Length - 2).Replace("''", "'");
            if (v.Length >= 2 && v[0] == '"' && v[v.Length - 1] == '"') return v.Substring(1, v.Length - 2);
            return v;
        }

        /// <summary>
        /// electron-builder 가 쓰는 latest.yml → 설치 파일 이름·sha512·크기. YAML 전체가 아니라 그 파일의 모양만 읽는다.
        /// electron-updater 처럼 files 목록의 첫 .exe 를 고르고, 목록이 없으면 최상위 path·sha512 를 쓴다.
        /// 이름은 경로가 섞이지 않은 .exe 여야 한다 — 받은 이름으로 로컬 파일을 만들기 때문이다.
        /// </summary>
        public static Manifest ParseManifest(string yml)
        {
            var top = new Dictionary<string, string>(StringComparer.Ordinal);
            var items = new List<Dictionary<string, string>>();
            Dictionary<string, string> item = null;
            bool inFiles = false;
            foreach (var raw in (yml ?? "").Replace("\r\n", "\n").Split('\n'))
            {
                var line = raw.TrimEnd();
                if (line.Length == 0 || line.TrimStart().StartsWith("#", StringComparison.Ordinal)) continue;
                var tm = TopKeyRe.Match(line);
                if (tm.Success)
                {
                    var key = tm.Groups[1].Value;
                    inFiles = key == "files" && tm.Groups[2].Value.Trim().Length == 0;
                    item = null;
                    if (!top.ContainsKey(key)) top[key] = Unquote(tm.Groups[2].Value);
                    continue;
                }
                if (!inFiles) continue;
                var sm = ItemStartRe.Match(line);
                if (sm.Success)
                {
                    item = new Dictionary<string, string>(StringComparer.Ordinal) { { sm.Groups[1].Value, Unquote(sm.Groups[2].Value) } };
                    items.Add(item);
                    continue;
                }
                var km = ItemKeyRe.Match(line);
                if (km.Success && item != null && !item.ContainsKey(km.Groups[1].Value)) item[km.Groups[1].Value] = Unquote(km.Groups[2].Value);
            }

            string path = null, sha = null, size = null;
            foreach (var it in items)
            {
                if (!it.TryGetValue("url", out var url) || !url.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) continue;
                path = url;
                it.TryGetValue("sha512", out sha);
                it.TryGetValue("size", out size);
                break;
            }
            if (path == null)
            {
                top.TryGetValue("path", out path);
                top.TryGetValue("sha512", out sha);
            }
            if (string.IsNullOrEmpty(path) || !FileRe.IsMatch(path)) throw new FormatException("latest.yml 의 설치 파일 이름이 올바르지 않다: " + (path ?? "(없음)"));
            if (string.IsNullOrEmpty(sha) || !Sha512Re.IsMatch(sha)) throw new FormatException("latest.yml 의 sha512 가 올바르지 않다: " + (sha ?? "(없음)"));
            long n = -1;
            if (!string.IsNullOrEmpty(size) && !long.TryParse(size, NumberStyles.None, CultureInfo.InvariantCulture, out n)) throw new FormatException("latest.yml 의 size 가 숫자가 아니다: " + size);
            top.TryGetValue("version", out var version);
            return new Manifest { Version = version ?? "", Path = path, Sha512 = sha, Size = n };
        }

        /// <summary>
        /// 인증서 주체 DN → 키·값. builder-util-runtime 9.7.0 rfc2253Parser.parseDn 을 옮겼다 — 설치된 앱의 electron-updater 가
        /// 서명자를 이 파서로 읽으므로 같은 파서여야 판정이 어긋나지 않는다(desktop/win-signing.mjs 의 parseDn 과 같은 코드).
        /// </summary>
        public static Dictionary<string, string> ParseDn(string seq)
        {
            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            seq = (seq ?? "").Trim();
            bool quoted = false;
            string key = null;
            var token = new StringBuilder();
            int nextNonSpace = 0;
            for (int i = 0; i <= seq.Length; i++)
            {
                if (i == seq.Length)
                {
                    if (key != null) result[key] = token.ToString();
                    break;
                }
                char ch = seq[i];
                if (quoted)
                {
                    if (ch == '"') { quoted = false; continue; }
                }
                else
                {
                    if (ch == '"') { quoted = true; continue; }
                    if (ch == '\\')
                    {
                        i++;
                        int ord = HexPrefix(seq, i);
                        if (ord < 0) { if (i < seq.Length) token.Append(seq[i]); }
                        else { i++; token.Append((char)ord); }
                        continue;
                    }
                    if (key == null && ch == '=') { key = token.ToString(); token.Clear(); continue; }
                    if (ch == ',' || ch == ';' || ch == '+')
                    {
                        if (key != null) result[key] = token.ToString();
                        key = null;
                        token.Clear();
                        continue;
                    }
                }
                if (ch == ' ' && !quoted)
                {
                    if (token.Length == 0) continue;
                    if (i > nextNonSpace)
                    {
                        int j = i;
                        while (j < seq.Length && seq[j] == ' ') j++;
                        nextNonSpace = j;
                    }
                    if (nextNonSpace >= seq.Length
                        || seq[nextNonSpace] == ',' || seq[nextNonSpace] == ';'
                        || (key == null && seq[nextNonSpace] == '=')
                        || (key != null && seq[nextNonSpace] == '+'))
                    {
                        i = nextNonSpace - 1;
                        continue;
                    }
                }
                token.Append(ch);
            }
            return result;
        }

        /// <summary>JS parseInt(seq.slice(i, i + 2), 16) 과 같게 — 앞에서부터 읽히는 16진수(최대 2자리), 없으면 -1.</summary>
        static int HexPrefix(string s, int i)
        {
            int value = -1;
            for (int k = i; k < Math.Min(i + 2, s.Length); k++)
            {
                int d = Uri.IsHexDigit(s[k]) ? Uri.FromHex(s[k]) : -1;
                if (d < 0) break;
                value = value < 0 ? d : value * 16 + d;
            }
            return value;
        }

        /// <summary>서명자 주체가 게시자 이름과 맞는가 — electron-updater 와 같은 규칙. DN 이면 적힌 키가 모두 같아야 하고, 아니면 CN 과 대조한다.</summary>
        public static bool SubjectMatches(string subject, string publisher)
        {
            if (string.IsNullOrWhiteSpace(subject) || string.IsNullOrWhiteSpace(publisher)) return false;
            var got = ParseDn(subject);
            var want = ParseDn(publisher);
            if (want.Count > 0)
            {
                foreach (var kv in want)
                    if (!got.TryGetValue(kv.Key, out var v) || v != kv.Value) return false;
                return true;
            }
            return got.TryGetValue("CN", out var cn) && cn == publisher;
        }
    }

    /// <summary>기록 — 파일(UTF-8)과 표준 출력에 같이 쓴다. 기록 실패가 설치를 막지 않는다.</summary>
    internal sealed class Log : IDisposable
    {
        readonly StreamWriter file;
        public string FilePath { get; }

        public Log(string path)
        {
            FilePath = path;
            try
            {
                var dir = Path.GetDirectoryName(Path.GetFullPath(path));
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                file = new StreamWriter(path, true, new UTF8Encoding(false)) { AutoFlush = true };
            }
            catch (Exception) { file = null; }
        }

        public void Write(string message)
        {
            var line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) + " " + message;
            try { file?.WriteLine(line); } catch (Exception) { }
            try { Console.Out.WriteLine(line); } catch (Exception) { }
        }

        public void Dispose()
        {
            try { file?.Dispose(); } catch (Exception) { }
        }
    }

    internal sealed class HttpStatusException : Exception
    {
        public int Status { get; }
        public HttpStatusException(string url, int status) : base("서버가 " + status + " 로 답했다: " + url) { Status = status; }
    }

    internal sealed class SignatureException : Exception
    {
        public SignatureException(string message) : base(message) { }
    }

    internal sealed class MismatchException : Exception
    {
        public MismatchException(string message) : base(message) { }
    }

    /// <summary>받기 — 시스템 프록시를 따른다. 받는 중 멈추면(StallTimeout) 끊는다.</summary>
    internal sealed class Fetcher : IDisposable
    {
        readonly HttpClient http;

        public Fetcher()
        {
            // .NET Framework 4.8 을 대상으로 한 앱은 운영체제 기본 TLS(SystemDefault)를 쓴다. 누군가 그 값을 바꿔 둔 환경이면 1.2 를 더한다.
            if (ServicePointManager.SecurityProtocol != SecurityProtocolType.SystemDefault)
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            var handler = new HttpClientHandler
            {
                AllowAutoRedirect = true,
                MaxAutomaticRedirections = 10,
                UseProxy = true,
                DefaultProxyCredentials = CredentialCache.DefaultCredentials,
            };
            http = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
            http.DefaultRequestHeaders.UserAgent.ParseAdd(Config.UserAgent);
        }

        /// <summary>작은 문서(릴리스 JSON·latest.yml) — 본문과 리다이렉트 뒤 최종 주소.</summary>
        public async Task<(string Body, string FinalUrl)> GetTextAsync(string url, string accept, CancellationToken ct)
        {
            using (var cts = CancellationTokenSource.CreateLinkedTokenSource(ct))
            using (var req = new HttpRequestMessage(HttpMethod.Get, url))
            {
                cts.CancelAfter(Config.TextTimeout);
                if (accept != null) req.Headers.Accept.ParseAdd(accept);
                using (var res = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token).ConfigureAwait(false))
                using (cts.Token.Register(() => res.Dispose()))
                {
                    if (!res.IsSuccessStatusCode) throw new HttpStatusException(url, (int)res.StatusCode);
                    if (res.Content.Headers.ContentLength > Config.MaxTextBytes) throw new FormatException("응답이 너무 크다: " + url);
                    var buffer = new MemoryStream();
                    using (var input = await res.Content.ReadAsStreamAsync().ConfigureAwait(false))
                    {
                        var chunk = new byte[8192];
                        int n;
                        while ((n = await ReadAsync(input, chunk, cts, ct).ConfigureAwait(false)) > 0)
                        {
                            buffer.Write(chunk, 0, n);
                            if (buffer.Length > Config.MaxTextBytes) throw new FormatException("응답이 너무 크다: " + url);
                        }
                    }
                    var finalUrl = res.RequestMessage?.RequestUri?.AbsoluteUri ?? url;
                    return (new UTF8Encoding(false).GetString(buffer.ToArray()), finalUrl);
                }
            }
        }

        /// <summary>설치 파일 받기 — 받으면서 sha512 를 계산해 돌려준다(Base64).</summary>
        public async Task<string> DownloadAsync(string url, string dest, long expectedSize, IProgress<(long Done, long Total)> progress, CancellationToken ct)
        {
            using (var stall = CancellationTokenSource.CreateLinkedTokenSource(ct))
            using (var req = new HttpRequestMessage(HttpMethod.Get, url))
            {
                stall.CancelAfter(Config.StallTimeout);
                using (var res = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, stall.Token).ConfigureAwait(false))
                using (stall.Token.Register(() => res.Dispose()))
                {
                    if (!res.IsSuccessStatusCode) throw new HttpStatusException(url, (int)res.StatusCode);
                    long total = res.Content.Headers.ContentLength ?? expectedSize;
                    if (total > Config.MaxInstallerBytes) throw new MismatchException("설치 파일이 너무 크다: " + total + " 바이트");
                    using (var sha = SHA512.Create())
                    using (var input = await res.Content.ReadAsStreamAsync().ConfigureAwait(false))
                    using (var output = new FileStream(dest, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1 << 16, true))
                    {
                        var chunk = new byte[1 << 16];
                        long done = 0;
                        var lastReport = Stopwatch.StartNew();
                        int n;
                        while ((n = await ReadAsync(input, chunk, stall, ct).ConfigureAwait(false)) > 0)
                        {
                            stall.CancelAfter(Config.StallTimeout);
                            sha.TransformBlock(chunk, 0, n, null, 0);
                            await output.WriteAsync(chunk, 0, n, ct).ConfigureAwait(false);
                            done += n;
                            if (done > Config.MaxInstallerBytes) throw new MismatchException("설치 파일이 너무 크다");
                            if (progress != null && lastReport.ElapsedMilliseconds >= 100)
                            {
                                progress.Report((done, total));
                                lastReport.Restart();
                            }
                        }
                        progress?.Report((done, total));
                        sha.TransformFinalBlock(new byte[0], 0, 0);
                        if (expectedSize >= 0 && done != expectedSize)
                            throw new MismatchException("받은 크기(" + done + ")가 latest.yml 의 크기(" + expectedSize + ")와 다르다");
                        return Convert.ToBase64String(sha.Hash);
                    }
                }
            }
        }

        /// <summary>
        /// 읽기 한 번. 멈춤 감시(stall)가 응답을 끊어 생긴 오류는 시간 초과로, 망 오류는 HttpRequestException 으로 바꾼다
        /// (디스크 오류 IOException 과 섞이지 않게 — 화면 문구가 다르다).
        /// </summary>
        static async Task<int> ReadAsync(Stream input, byte[] chunk, CancellationTokenSource stall, CancellationToken user)
        {
            try
            {
                return await input.ReadAsync(chunk, 0, chunk.Length, stall.Token).ConfigureAwait(false);
            }
            catch (Exception e) when (e is IOException || e is ObjectDisposedException || e is WebException || e is OperationCanceledException)
            {
                user.ThrowIfCancellationRequested();
                if (stall.IsCancellationRequested) throw new TimeoutException("응답이 멈췄다", e);
                throw new HttpRequestException("받는 중 연결이 끊겼다: " + e.Message, e);
            }
        }

        public void Dispose() => http.Dispose();
    }

    /// <summary>Authenticode 확인 — WinVerifyTrust(서명·체인·타임스탬프) + 서명자 주체 대조.</summary>
    internal static class Authenticode
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct WINTRUST_FILE_INFO
        {
            public uint cbStruct;
            [MarshalAs(UnmanagedType.LPWStr)] public string pcwszFilePath;
            public IntPtr hFile;
            public IntPtr pgKnownSubject;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct WINTRUST_DATA
        {
            public uint cbStruct;
            public IntPtr pPolicyCallbackData;
            public IntPtr pSIPClientData;
            public uint dwUIChoice;
            public uint fdwRevocationChecks;
            public uint dwUnionChoice;
            public IntPtr pFile;
            public uint dwStateAction;
            public IntPtr hWVTStateData;
            public IntPtr pwszURLReference;
            public uint dwProvFlags;
            public uint dwUIContext;
            public IntPtr pSignatureSettings;
        }

        [DllImport("wintrust.dll", ExactSpelling = true, SetLastError = false)]
        static extern int WinVerifyTrust(IntPtr hwnd, [MarshalAs(UnmanagedType.LPStruct)] Guid pgActionID, IntPtr pWVTData);

        static readonly Guid GenericVerifyV2 = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        const uint WTD_UI_NONE = 2;
        const uint WTD_REVOKE_NONE = 0;
        const uint WTD_CHOICE_FILE = 1;
        const uint WTD_STATEACTION_VERIFY = 1;
        const uint WTD_STATEACTION_CLOSE = 2;
        // 폐기 목록은 조회하지 않는다 — 망이 막힌 곳에서 확인 자체가 실패하지 않게. 파일은 HTTPS 로 받고 sha512 까지 대조한 뒤다.
        const uint WTD_REVOCATION_CHECK_NONE = 0x10;

        /// <summary>0 이면 유효. 아니면 WinVerifyTrust 의 HRESULT.</summary>
        public static int Verify(string path)
        {
            var fileInfo = new WINTRUST_FILE_INFO { cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)), pcwszFilePath = path };
            IntPtr pFile = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)));
            IntPtr pData = IntPtr.Zero;
            try
            {
                Marshal.StructureToPtr(fileInfo, pFile, false);
                var data = new WINTRUST_DATA
                {
                    cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_DATA)),
                    dwUIChoice = WTD_UI_NONE,
                    fdwRevocationChecks = WTD_REVOKE_NONE,
                    dwUnionChoice = WTD_CHOICE_FILE,
                    pFile = pFile,
                    dwStateAction = WTD_STATEACTION_VERIFY,
                    dwProvFlags = WTD_REVOCATION_CHECK_NONE,
                };
                pData = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WINTRUST_DATA)));
                Marshal.StructureToPtr(data, pData, false);
                int result = WinVerifyTrust(IntPtr.Zero, GenericVerifyV2, pData);
                data = (WINTRUST_DATA)Marshal.PtrToStructure(pData, typeof(WINTRUST_DATA));
                data.dwStateAction = WTD_STATEACTION_CLOSE;
                Marshal.StructureToPtr(data, pData, false);
                WinVerifyTrust(IntPtr.Zero, GenericVerifyV2, pData);
                return result;
            }
            finally
            {
                if (pData != IntPtr.Zero) Marshal.FreeHGlobal(pData);
                Marshal.DestroyStructure(pFile, typeof(WINTRUST_FILE_INFO));
                Marshal.FreeHGlobal(pFile);
            }
        }

        public static string Describe(int hr)
        {
            switch ((uint)hr)
            {
                case 0x800B0100: return "서명이 없다";
                case 0x80096010: return "서명한 뒤에 파일이 바뀌었다";
                case 0x800B0109: return "믿을 수 있는 인증 기관으로 이어지지 않는다";
                case 0x800B0101: return "인증서가 만료됐고 타임스탬프가 없다";
                case 0x800B010C: return "인증서가 폐기됐다";
                case 0x800B0111: return "이 컴퓨터에서 이 서명을 믿지 않도록 설정돼 있다";
                case 0x800B0004: return "이 서명자는 이 컴퓨터에서 믿지 않는다";
                default: return "WinVerifyTrust 0x" + ((uint)hr).ToString("X8", CultureInfo.InvariantCulture);
            }
        }

        /// <summary>유효하지 않거나 서명자가 다르면 SignatureException. 통과하면 서명자 주체를 돌려준다.</summary>
        public static string Check(string path, string publisher)
        {
            int hr = Verify(path);
            if (hr != 0) throw new SignatureException("서명 확인 실패 — " + Describe(hr));
            string subject;
            try
            {
                using (var signer = X509Certificate.CreateFromSignedFile(path))
                using (var cert = new X509Certificate2(signer))
                    subject = cert.Subject;
            }
            catch (CryptographicException e)
            {
                throw new SignatureException("서명자를 읽지 못했다 — " + e.Message);
            }
            if (!Rules.SubjectMatches(subject, publisher)) throw new SignatureException("서명자가 " + publisher + " 가 아니다: " + subject);
            return subject;
        }
    }

    internal enum Stage { Resolve, Download, Verify }

    internal sealed class Prepared
    {
        public string Tag;
        public Manifest Manifest;
        public string File;
        public string Subject;
    }

    /// <summary>받기 → 확인. 화면 모드와 --dry-run 이 같은 길을 쓴다.</summary>
    internal static class Pipeline
    {
        public static async Task<Prepared> PrepareAsync(Fetcher fetcher, string workDir, Log log, Action<Stage, Manifest> stage, IProgress<(long Done, long Total)> progress, CancellationToken ct)
        {
            stage?.Invoke(Stage.Resolve, null);
            var release = await fetcher.GetTextAsync(Config.LatestUrl, "application/json", ct).ConfigureAwait(false);
            var tag = Rules.TagFromRelease(release.Body, release.FinalUrl);
            log.Write("최신 릴리스 태그 " + tag);
            var yml = await fetcher.GetTextAsync(Config.AssetUrl(tag, "latest.yml"), null, ct).ConfigureAwait(false);
            var manifest = Rules.ParseManifest(yml.Body);
            log.Write("latest.yml — 버전 " + manifest.Version + " · " + manifest.Path + " · 크기 " + manifest.Size + " · sha512 " + manifest.Sha512);

            stage?.Invoke(Stage.Download, manifest);
            var file = Path.Combine(workDir, manifest.Path);
            var url = Config.AssetUrl(tag, manifest.Path);
            log.Write("받기 시작 " + url);
            var sha = await fetcher.DownloadAsync(url, file, manifest.Size, progress, ct).ConfigureAwait(false);
            log.Write("받기 끝 — " + new FileInfo(file).Length + " 바이트 · sha512 " + sha);

            stage?.Invoke(Stage.Verify, manifest);
            if (!string.Equals(sha, manifest.Sha512, StringComparison.Ordinal))
                throw new MismatchException("받은 파일의 sha512 가 latest.yml 과 다르다");
            var subject = await Task.Run(() => Authenticode.Check(file, Config.Publisher), ct).ConfigureAwait(false);
            log.Write("서명 확인 — 유효 · 서명자 " + subject);
            return new Prepared { Tag = tag, Manifest = manifest, File = file, Subject = subject };
        }

        public static string NewWorkDir()
        {
            var dir = Path.Combine(Path.GetTempPath(), "lively-setup-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            return dir;
        }

        /// <summary>임시 폴더 지우기 — 설치 파일이 막 끝나 잠깐 잡혀 있을 수 있어 몇 번 다시 해 본다.</summary>
        public static void TryDelete(string dir, Log log)
        {
            if (string.IsNullOrEmpty(dir)) return;
            for (int i = 0; i < 6; i++)
            {
                try
                {
                    if (Directory.Exists(dir)) Directory.Delete(dir, true);
                    return;
                }
                catch (Exception e) when (e is IOException || e is UnauthorizedAccessException)
                {
                    Thread.Sleep(500);
                }
            }
            log.Write("임시 폴더를 지우지 못했다: " + dir);
        }
    }

    /// <summary>사람에게 보일 문장 — 예외 종류로 고른다. 자세한 내용은 기록 파일에 남긴다.</summary>
    internal static class Messages
    {
        public static string Explain(Exception e)
        {
            switch (e)
            {
                case SignatureException _:
                    return "받은 파일의 서명을 확인하지 못해 설치를 멈췄어요. «직접 받기» 로 받아 주세요.";
                case MismatchException _:
                    return "받은 파일이 올라온 파일과 달라서 설치를 멈췄어요. 다시 시도해 주세요.";
                case FormatException _:
                    return "최신 버전 정보를 읽지 못했어요. 잠시 뒤 다시 시도하거나 «직접 받기» 로 받아 주세요.";
                case HttpStatusException _:
                    return "설치 파일을 내려주는 곳이 제대로 응답하지 않아요. 잠시 뒤 다시 시도해 주세요.";
                case TimeoutException _:
                case OperationCanceledException _:
                    return "응답이 너무 오래 없어서 받기를 멈췄어요. 잠시 뒤 다시 시도해 주세요.";
                case HttpRequestException _:
                case WebException _:
                    return "인터넷에 연결하지 못해 설치 파일을 받지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.";
                case IOException _:
                case UnauthorizedAccessException _:
                    return "임시 폴더에 파일을 저장하지 못했어요. 디스크 공간을 확인한 뒤 다시 시도해 주세요.";
                case System.ComponentModel.Win32Exception _:
                    return "설치 파일을 실행하지 못했어요. 다시 시도해 주세요.";
                default:
                    return "설치를 준비하다가 문제가 생겼어요. 다시 시도해 주세요.";
            }
        }

        public static string Megabytes(long bytes) => (bytes / 1048576.0).ToString("0", CultureInfo.InvariantCulture) + "MB";
    }

    /// <summary>화면 — 받기·확인 진행을 보여 주고, 확인이 끝나면 설치 파일을 실행한 뒤 창을 숨긴다.</summary>
    internal sealed class SetupForm : Form
    {
        readonly Log log;
        readonly bool noInstall;
        readonly Label heading = new Label { AutoSize = true, Margin = new Padding(0, 0, 0, 8) };
        readonly Label status = new Label { AutoSize = true, MaximumSize = new Size(380, 0), Margin = new Padding(0, 0, 0, 12) };
        readonly ProgressBar bar = new ProgressBar { Size = new Size(380, 16), Margin = new Padding(0, 0, 0, 16), MarqueeAnimationSpeed = 30 };
        readonly Button retry = new Button { Text = "다시 시도", AutoSize = true, MinimumSize = new Size(88, 28), Visible = false };
        readonly Button manual = new Button { Text = "직접 받기", AutoSize = true, MinimumSize = new Size(88, 28), Visible = false };
        readonly Button close = new Button { Text = "취소", AutoSize = true, MinimumSize = new Size(88, 28) };
        CancellationTokenSource cts;
        string workDir;
        bool running;

        public int ExitCode { get; private set; } = 1;

        public SetupForm(Log log, bool noInstall)
        {
            this.log = log;
            this.noInstall = noInstall;
            SuspendLayout();
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            Font = SystemFonts.MessageBoxFont;
            Text = "라이블리 설치";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            Padding = new Padding(16);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }

            heading.Font = new Font(Font.FontFamily, Font.SizeInPoints * 1.2f, FontStyle.Bold);
            heading.Text = "라이블리를 설치하고 있어요";
            var buttons = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.RightToLeft,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Dock = DockStyle.Fill,
                WrapContents = false,
                Margin = Padding.Empty,
            };
            buttons.Controls.AddRange(new Control[] { close, manual, retry });
            var table = new TableLayoutPanel
            {
                ColumnCount = 1,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Location = new Point(Padding.Left, Padding.Top),
                Margin = Padding.Empty,
            };
            table.Controls.Add(heading);
            table.Controls.Add(status);
            table.Controls.Add(bar);
            table.Controls.Add(buttons);
            Controls.Add(table);
            CancelButton = close;

            close.Click += (s, e) => { if (running) cts?.Cancel(); else Close(); };
            retry.Click += (s, e) => Start();
            manual.Click += (s, e) => OpenReleasesPage();
            ResumeLayout(false);
            PerformLayout();
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            Start();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (running) cts?.Cancel();
            base.OnFormClosing(e);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            var dir = workDir;
            workDir = null;
            if (dir != null) Pipeline.TryDelete(dir, log);
            base.OnFormClosed(e);
        }

        void SetStatus(string text) => status.Text = text;

        void OnStage(Stage stage, Manifest manifest)
        {
            switch (stage)
            {
                case Stage.Resolve:
                    SetStatus("최신 버전을 확인하고 있어요.");
                    break;
                case Stage.Download:
                    SetStatus("최신 버전(" + manifest.Version + ") 설치 파일을 받고 있어요.");
                    break;
                case Stage.Verify:
                    bar.Style = ProgressBarStyle.Marquee;
                    SetStatus("받은 파일이 라이블리가 만든 것인지 확인하고 있어요.");
                    break;
            }
        }

        void OnProgress((long Done, long Total) p, string version)
        {
            if (p.Total <= 0)
            {
                SetStatus("최신 버전(" + version + ") 설치 파일을 받고 있어요. " + Messages.Megabytes(p.Done) + " 받았어요.");
                return;
            }
            int pct = (int)Math.Max(0, Math.Min(100, p.Done * 100 / p.Total));
            if (bar.Style != ProgressBarStyle.Continuous) bar.Style = ProgressBarStyle.Continuous;
            bar.Value = pct;
            SetStatus("최신 버전(" + version + ") 설치 파일을 받고 있어요. " + pct + "% (" + Messages.Megabytes(p.Done) + " / " + Messages.Megabytes(p.Total) + ")");
        }

        async void Start()
        {
            if (running) return;
            running = true;
            retry.Visible = false;
            manual.Visible = false;
            close.Text = "취소";
            heading.Text = "라이블리를 설치하고 있어요";
            bar.Style = ProgressBarStyle.Marquee;
            cts?.Dispose();
            cts = new CancellationTokenSource();
            var token = cts.Token;
            string version = "";
            try
            {
                if (workDir != null) Pipeline.TryDelete(workDir, log);
                workDir = Pipeline.NewWorkDir();
                Prepared prepared;
                using (var fetcher = new Fetcher())
                {
                    var progress = new Progress<(long Done, long Total)>(p => OnProgress(p, version));
                    prepared = await Pipeline.PrepareAsync(fetcher, workDir, log, (stage, m) =>
                    {
                        if (m != null) version = m.Version;
                        BeginInvoke(new Action(() => OnStage(stage, m)));
                    }, progress, token);
                }
                if (noInstall)
                {
                    bar.Style = ProgressBarStyle.Continuous;
                    bar.Value = 100;
                    heading.Text = "확인이 끝났어요";
                    SetStatus("최신 버전(" + version + ") 설치 파일을 받아 확인했어요. 점검 모드라서 설치하지 않고 닫습니다.");
                    log.Write("점검 모드 — 설치하지 않고 닫는다");
                    ExitCode = 0;
                    running = false;
                    await Task.Delay(1500);
                    Close();
                    return;
                }

                SetStatus("설치를 시작했어요. 설치가 끝나면 라이블리가 열립니다.");
                var process = Process.Start(new ProcessStartInfo(prepared.File)
                {
                    UseShellExecute = false,
                    WorkingDirectory = Path.GetDirectoryName(prepared.File),
                });
                log.Write("설치 파일 실행 — pid " + process.Id);
                Hide();
                await Task.Run(() => process.WaitForExit());
                int code = process.ExitCode;
                log.Write("설치 파일 종료 코드 " + code);
                running = false;
                if (code != 0)
                {
                    Show();
                    ShowError("설치가 끝까지 진행되지 않았어요. 다시 시도해 주세요.");
                    return;
                }
                ExitCode = 0;
                Close();
            }
            catch (Exception ex) when (token.IsCancellationRequested)
            {
                log.Write("취소 — " + ex.GetType().Name);
                running = false;
                if (!IsDisposed) Close();
            }
            catch (Exception ex)
            {
                log.Write("실패 — " + ex);
                running = false;
                if (!Visible) Show();
                ShowError(Messages.Explain(ex));
            }
        }

        void ShowError(string message)
        {
            heading.Text = "설치하지 못했어요";
            bar.Style = ProgressBarStyle.Continuous;
            bar.Value = 0;
            SetStatus(message + "\n\n기록 파일: " + log.FilePath);
            retry.Visible = true;
            manual.Visible = true;
            close.Text = "닫기";
            if (workDir != null) { Pipeline.TryDelete(workDir, log); workDir = null; }
        }

        void OpenReleasesPage()
        {
            try { Process.Start(new ProcessStartInfo(Config.LatestUrl) { UseShellExecute = true }); }
            catch (Exception e) { log.Write("받는 곳을 열지 못했다 — " + e.Message); }
        }
    }

    /// <summary>--self-test — selftest-cases.tsv 의 사례를 Rules 로 돌린다.</summary>
    internal static class SelfTest
    {
        public static int Run(Log log)
        {
            string text;
            using (var s = typeof(SelfTest).Assembly.GetManifestResourceStream("selftest-cases.tsv"))
            {
                if (s == null) { log.Write("자가 점검 — 사례 표가 들어 있지 않다"); return 1; }
                using (var r = new StreamReader(s, new UTF8Encoding(false))) text = r.ReadToEnd();
            }
            int pass = 0, fail = 0;
            foreach (var raw in text.Replace("\r\n", "\n").Split('\n'))
            {
                if (raw.Length == 0 || raw[0] == '#') continue;
                var f = Array.ConvertAll(raw.Split('\t'), Unescape);
                string want, got;
                switch (f[0])
                {
                    case "dn":
                        want = f[3];
                        got = Rules.SubjectMatches(f[1], f[2]) ? "true" : "false";
                        break;
                    case "manifest":
                        want = f[2] == "ok" ? "ok|" + f[3] + "|" + f[4] + "|" + (f[5].Length == 0 ? "-1" : f[5]) : "error";
                        got = Try(() => { var m = Rules.ParseManifest(f[1]); return "ok|" + m.Path + "|" + m.Sha512 + "|" + m.Size.ToString(CultureInfo.InvariantCulture); });
                        break;
                    case "tag":
                        want = f[3] == "ok" ? "ok|" + f[4] : "error";
                        got = Try(() => "ok|" + Rules.TagFromRelease(f[1], f[2]));
                        break;
                    default:
                        want = "알 수 없는 종류";
                        got = f[0];
                        break;
                }
                if (got == want) pass++;
                else { fail++; log.Write("✗ " + f[0] + " — " + f[f.Length - 1] + " · 기대 " + want + " · 실제 " + got); }
            }
            log.Write("자가 점검 — 통과 " + pass + " · 실패 " + fail);
            return fail == 0 && pass > 0 ? 0 : 1;
        }

        static string Try(Func<string> fn)
        {
            try { return fn(); }
            catch (FormatException) { return "error"; }
        }

        static string Unescape(string s)
        {
            var sb = new StringBuilder(s.Length);
            for (int i = 0; i < s.Length; i++)
            {
                if (s[i] == '\\' && i + 1 < s.Length)
                {
                    char c = s[++i];
                    sb.Append(c == 'n' ? '\n' : c == 't' ? '\t' : c);
                }
                else sb.Append(s[i]);
            }
            return sb.ToString();
        }
    }

    internal static class Program
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetDefaultDllDirectories(uint directoryFlags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool SetDllDirectory(string lpPathName);

        const uint LOAD_LIBRARY_SEARCH_SYSTEM32 = 0x00000800;

        [STAThread]
        static int Main(string[] args)
        {
            // 내려받기 폴더에서 실행되므로, 뒤이어 싣는 DLL 을 System32 에서만 찾게 한다(설치 프로그램의 DLL 바꿔치기 대비 — NSIS 도 같은 일을 한다).
            try { SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32); SetDllDirectory(""); } catch (Exception) { }

            bool dryRun = false, selfTest = false, noInstall = false;
            string logPath = null;
            for (int i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--dry-run": dryRun = true; break;
                    case "--self-test": selfTest = true; break;
                    case "--no-install": noInstall = true; break;
                    case "--log": if (i + 1 < args.Length) logPath = args[++i]; break;
                }
            }
            if (string.IsNullOrEmpty(logPath)) logPath = Path.Combine(Path.GetTempPath(), "lively-setup.log");

            using (var log = new Log(logPath))
            {
                log.Write("라이블리 설치 도우미 " + typeof(Program).Assembly.GetName().Version + " — 인자 [" + string.Join(" ", args) + "]");
                try
                {
                    if (selfTest) return SelfTest.Run(log);
                    if (dryRun) return DryRun(log);
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    using (var form = new SetupForm(log, noInstall))
                    {
                        Application.Run(form);
                        log.Write("끝 — 종료 코드 " + form.ExitCode);
                        return form.ExitCode;
                    }
                }
                catch (Exception e)
                {
                    log.Write("멈춤 — " + e);
                    return 1;
                }
            }
        }

        static int DryRun(Log log)
        {
            var dir = Pipeline.NewWorkDir();
            try
            {
                using (var fetcher = new Fetcher())
                {
                    var p = Pipeline.PrepareAsync(fetcher, dir, log, (stage, m) => log.Write("단계 " + stage), null, CancellationToken.None).GetAwaiter().GetResult();
                    log.Write("통과 — 태그 " + p.Tag + " · 버전 " + p.Manifest.Version + " · " + p.Manifest.Path + " · sha512 일치 · 서명 유효 · 서명자 일치");
                    return 0;
                }
            }
            catch (Exception e)
            {
                log.Write("실패 — " + Messages.Explain(e) + " / " + e);
                return 1;
            }
            finally
            {
                Pipeline.TryDelete(dir, log);
            }
        }
    }
}
