# A Windows worker for rollforward (docs/system.md, Windows workers): it asks the server for the oldest queued job, runs its
# PowerShell command in a fresh folder holding the job's files, streams its output back, beats so a cancel reaches it, kills it at
# its timeout, sends back what it left in $env:RF_OUT, and ends it. Windows PowerShell 5.1 and .NET Framework 4.5 or later, as
# Windows has them: nothing to install. Run it in a signed-in desktop session, as Office's COM needs one (README.md).
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File worker.ps1 [-Config C:\rfworker\worker.json]
#
# worker.json: {"url": "https://10.0.0.5:8781", "key": "...", "fingerprint": "AB:CD:...", "workdir": "C:\\rfjobs",
#               "inventory": {"notes": "anything a run should know of this machine"}}
# fingerprint is the SHA-256 of the server's certificate, as `openssl x509 -noout -fingerprint -sha256 -in windows.crt` shows it.
param([string]$Config = (Join-Path $PSScriptRoot 'worker.json'))
$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public class RfWorker {
  const int LeaseWaitS = 25, PumpMs = 500, LogEveryMs = 2000, BeatEveryMs = 15000, HelloEveryMs = 300000, MaxBackoffMs = 30000;
  // A log chunk well under the server's 1 MiB body, in characters of at most 3 UTF-8 bytes each; and what output is held while
  // the server can't be reached, past which it's dropped and the log says so.
  const int ChunkChars = 160 * 1024, MaxHeldChars = 8 * 1024 * 1024;
  static readonly string[] Office = { "EXCEL", "WINWORD", "POWERPNT", "MSACCESS", "OUTLOOK", "VISIO", "MSPUB", "ONENOTE" };
  readonly string url, workdir;
  readonly HttpClient http;
  readonly object inventory;
  readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

  // The job is no longer this worker's: another's now, ended, or gone.
  class Abandoned : Exception { public Abandoned(string m) : base(m) {} }
  // The server refused this worker's key.
  class Refused : Exception { public Refused(string m) : base(m) {} }

  // What a job's pump, a thread of its own, and its runner share: its output held to send, and what the server said.
  class Lease {
    public string Id;
    public readonly StringBuilder Log = new StringBuilder();
    public bool Dropped;
    public volatile bool Running, Cancel, Stop;
    public volatile string Lost;
  }

  public RfWorker(string url, string key, string fingerprint, string workdir, object inventory) {
    this.url = url.TrimEnd('/');
    this.workdir = workdir;
    this.inventory = inventory;
    string pin = fingerprint.Replace(":", "").Replace(" ", "").ToUpperInvariant();
    ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
    WebRequestHandler handler = new WebRequestHandler();
    // The server's own certificate, by its fingerprint, whatever its name or issuer: no authority is trusted.
    handler.ServerCertificateValidationCallback = (sender, cert, chain, errors) => {
      if (cert == null) return false;
      using (SHA256 sha = SHA256.Create()) return Hex(sha.ComputeHash(cert.GetRawCertData())) == pin;
    };
    http = new HttpClient(handler);
    http.Timeout = TimeSpan.FromMinutes(30);
    http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", key);
  }

  static string Hex(byte[] b) { return BitConverter.ToString(b).Replace("-", ""); }
  static void Say(string s) { Console.WriteLine(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + s); }
  static string Segments(string path) { return string.Join("/", path.Split('/').Select(Uri.EscapeDataString)); }

  // A request, again after a network failure or a 5xx, backing off to 30 s, until the server answers; a 409 means the job is
  // no longer this worker's, a 401 that its key is not the server's.
  HttpResponseMessage Send(string method, string path, Func<HttpContent> body) {
    int wait = 1000;
    while (true) {
      try {
        HttpRequestMessage req = new HttpRequestMessage(new HttpMethod(method), url + path);
        if (body != null) req.Content = body();
        HttpResponseMessage res = http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead).Result;
        int code = (int)res.StatusCode;
        if (code == 401) { res.Dispose(); throw new Refused("the server refused this worker's key"); }
        if (code == 409) { string why = res.Content.ReadAsStringAsync().Result; res.Dispose(); throw new Abandoned(why); }
        if (code < 500) return res;
        Say(method + " " + path + ": " + code + ", trying again");
        res.Dispose();
      } catch (AggregateException e) {
        Say(method + " " + path + ": " + e.InnerException.Message + ", trying again");
      } catch (HttpRequestException e) {
        Say(method + " " + path + ": " + e.Message + ", trying again");
      }
      Thread.Sleep(wait);
      wait = Math.Min(wait * 2, MaxBackoffMs);
    }
  }
  static HttpResponseMessage Ok(HttpResponseMessage res, string what) {
    if (!res.IsSuccessStatusCode) {
      string why = res.Content.ReadAsStringAsync().Result;
      res.Dispose();
      throw new InvalidOperationException(what + ": " + (int)res.StatusCode + " " + why);
    }
    return res;
  }
  Func<HttpContent> Json(object o) { string s = json.Serialize(o); return () => new StringContent(s, Encoding.UTF8, "application/json"); }

  public void Run() {
    if (Process.GetCurrentProcess().SessionId == 0 || !Environment.UserInteractive)
      Say("warning: not in a signed-in desktop session, where Office's COM hangs or fails; see README.md");
    Directory.CreateDirectory(workdir);
    DateTime hello = DateTime.MinValue;
    while (true) {
      // A refusal of its key ends the worker; anything else the server says is said, and it asks again.
      try {
        if ((DateTime.Now - hello).TotalMilliseconds > HelloEveryMs) {
          Ok(Send("POST", "/worker/hello", Json(new Dictionary<string, object> { { "inventory", inventory } })), "hello").Dispose();
          hello = DateTime.Now;
        }
        using (HttpResponseMessage res = Send("POST", "/worker/lease?wait=" + LeaseWaitS, null)) {
          if ((int)res.StatusCode == 204) continue;
          Ok(res, "lease");
          Dictionary<string, object> job = json.Deserialize<Dictionary<string, object>>(res.Content.ReadAsStringAsync().Result);
          try { RunJob(job); } catch (Abandoned e) { Say("job " + job["id"] + " is no longer this worker's: " + e.Message); }
        }
      } catch (InvalidOperationException e) {
        Say(e.Message);
        Thread.Sleep(MaxBackoffMs);
      }
    }
  }

  void RunJob(Dictionary<string, object> job) {
    string id = (string)job["id"], command = (string)job["command"], dir = Path.Combine(workdir, id), outDir = Path.Combine(dir, "out");
    string script = Path.Combine(workdir, id + ".ps1");
    int timeout = Convert.ToInt32(job["timeout"]);
    Say("job " + id + ": " + (command.Length > 200 ? command.Substring(0, 200) + "..." : command));
    Lease lease = new Lease { Id = id };
    Thread pump = new Thread(() => Pump(lease)) { IsBackground = true };
    pump.Start();
    string state = "done", error = null;
    int? exit = null;
    try {
      try {
        Wipe(dir);
        Directory.CreateDirectory(outDir);
        Fetch(id, (IEnumerable)job["files"], dir, lease);
        // UTF-8 for its output, as the server keeps it; a BOM so Windows PowerShell reads the script as UTF-8.
        File.WriteAllText(script, "[Console]::OutputEncoding = [Text.Encoding]::UTF8\r\n$OutputEncoding = [Text.Encoding]::UTF8\r\n" + command + "\r\n", new UTF8Encoding(true));
        exit = Execute(script, dir, outDir, timeout, lease, ref state);
        error = Upload(id, outDir, lease);
        if (error != null) state = "failed";
      } catch (Abandoned) { throw; } catch (Refused) { throw; }
      // Whatever else went wrong is the job's failure, said to the server, never the worker's end.
      catch (Exception e) { state = "failed"; error = e.Message; }
      lease.Stop = true;
      pump.Join();
      if (lease.Lost != null) throw new Abandoned(lease.Lost);
      Flush(lease);
      Dictionary<string, object> end = new Dictionary<string, object> { { "state", state } };
      if (exit.HasValue) end["exit"] = exit.Value;
      if (error != null) end["error"] = error.Length > 2000 ? error.Substring(0, 2000) : error;
      Ok(Send("POST", "/worker/jobs/" + id + "/end", Json(end)), "end").Dispose();
      Say("job " + id + ": " + state + (exit.HasValue ? ", exit " + exit.Value : "") + (error != null ? ", " + error : ""));
    } finally {
      lease.Stop = true;
      TryDelete(script);
      Wipe(dir);
    }
  }

  // Beats and the log, on a thread of its own, so files coming or going, a slow server or one away, hold up neither the timeout
  // nor a cancel, which the job's runner sees in the lease.
  void Pump(Lease lease) {
    DateTime logged = DateTime.Now, beat = DateTime.MinValue;
    while (!lease.Stop) {
      try {
        if ((DateTime.Now - beat).TotalMilliseconds >= BeatEveryMs) {
          beat = DateTime.Now;
          using (HttpResponseMessage res = Ok(Send("POST", "/worker/jobs/" + lease.Id + "/beat" + (lease.Running ? "?running=1" : ""), null), "beat"))
            if (res.Content.ReadAsStringAsync().Result.Contains("\"cancel\":true")) lease.Cancel = true;
        }
        if ((DateTime.Now - logged).TotalMilliseconds >= LogEveryMs) { Flush(lease); logged = DateTime.Now; }
      } catch (Abandoned e) { lease.Lost = e.Message; return; }
      catch (Refused e) { lease.Lost = e.Message; return; }
      catch (InvalidOperationException e) { Say("job " + lease.Id + ": " + e.Message); }
      Thread.Sleep(PumpMs);
    }
  }

  void Fetch(string id, IEnumerable files, string dir, Lease lease) {
    foreach (object o in files) {
      Dictionary<string, object> f = (Dictionary<string, object>)o;
      string path = (string)f["path"], dest = Path.Combine(dir, path.Replace('/', '\\'));
      if (lease.Lost != null) throw new Abandoned(lease.Lost);
      Directory.CreateDirectory(Path.GetDirectoryName(dest));
      using (HttpResponseMessage res = Ok(Send("GET", "/worker/jobs/" + id + "/in/" + Segments(path), null), path))
      using (Stream from = res.Content.ReadAsStreamAsync().Result)
      using (FileStream to = File.Create(dest)) from.CopyTo(to);
      using (SHA256 sha = SHA256.Create()) using (FileStream s = File.OpenRead(dest))
        if (Hex(sha.ComputeHash(s)).ToLowerInvariant() != (string)f["sha256"]) throw new InvalidOperationException(path + ": its digest differs from the server's");
    }
  }

  // ---- Its processes, in a job object of their own, so all of them go when it ends, those its command left behind among them.
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  const int ExtendedLimitInformation = 9;
  const uint KillOnJobClose = 0x2000;
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

  static IntPtr NewJobObject() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new InvalidOperationException("CreateJobObject failed: " + Marshal.GetLastWin32Error());
    // Closing it, as when the worker itself is killed, kills what's in it.
    ExtendedLimits limits = new ExtendedLimits();
    limits.Basic.LimitFlags = KillOnJobClose;
    if (!SetInformationJobObject(job, ExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))))
      Say("warning: the job object won't kill its processes as the worker ends: " + Marshal.GetLastWin32Error());
    return job;
  }

  int Execute(string script, string dir, string outDir, int timeout, Lease lease, ref string state) {
    ProcessStartInfo psi = new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\"");
    psi.WorkingDirectory = dir;
    psi.UseShellExecute = false;
    psi.CreateNoWindow = true;
    psi.RedirectStandardOutput = true;
    psi.RedirectStandardError = true;
    psi.RedirectStandardInput = true;
    psi.StandardOutputEncoding = Encoding.UTF8;
    psi.StandardErrorEncoding = Encoding.UTF8;
    psi.EnvironmentVariables["RF_OUT"] = outDir;
    psi.EnvironmentVariables["RF_JOB"] = lease.Id;
    DataReceivedEventHandler take = (s, e) => {
      if (e.Data == null) return;
      lock (lease.Log) {
        if (lease.Log.Length + e.Data.Length < MaxHeldChars) lease.Log.Append(e.Data).Append('\n');
        else if (!lease.Dropped) { lease.Dropped = true; lease.Log.Append("[rfworker: output dropped while the server was not taking it]\n"); }
      }
    };
    IntPtr group = NewJobObject();
    DateTime start = DateTime.Now;
    try {
      using (Process p = new Process()) {
        p.StartInfo = psi;
        p.OutputDataReceived += take;
        p.ErrorDataReceived += take;
        p.Start();
        if (!AssignProcessToJobObject(group, p.Handle)) Say("warning: the command runs outside a job object: " + Marshal.GetLastWin32Error());
        lease.Running = true;
        p.StandardInput.Close();
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        try {
          while (!p.WaitForExit(PumpMs)) {
            if (lease.Lost != null) throw new Abandoned(lease.Lost);
            if ((DateTime.Now - start).TotalSeconds > timeout) { state = "timeout"; break; }
            if (lease.Cancel) { state = "canceled"; break; }
          }
        } finally {
          // Whatever ended the wait, nothing of the command runs on: its tree, what it left behind, and the Office it started.
          TerminateJobObject(group, 1);
          // Its output's end, once nothing holds its pipes; bounded, so one held elsewhere stops nothing.
          p.WaitForExit(30000);
          KillOffice(start);
        }
        return p.HasExited ? p.ExitCode : -1;
      }
    } finally { CloseHandle(group); }
  }

  void Flush(Lease lease) {
    while (true) {
      string text;
      lock (lease.Log) {
        int n = Math.Min(lease.Log.Length, ChunkChars);
        if (n < lease.Log.Length && char.IsHighSurrogate(lease.Log[n - 1])) n--;
        text = lease.Log.ToString(0, n);
        lease.Log.Remove(0, n);
      }
      if (text.Length == 0) return;
      byte[] bytes = Encoding.UTF8.GetBytes(text);
      Ok(Send("POST", "/worker/jobs/" + lease.Id + "/log", () => new ByteArrayContent(bytes)), "log").Dispose();
    }
  }

  // Office programs COM started for the job run apart from its processes: those of this session started since, as one job runs
  // at a time.
  static void KillOffice(DateTime since) {
    int session = Process.GetCurrentProcess().SessionId;
    foreach (string name in Office)
      foreach (Process p in Process.GetProcessesByName(name)) {
        try { if (p.SessionId == session && p.StartTime >= since.AddSeconds(-1)) { p.Kill(); p.WaitForExit(5000); } }
        catch (InvalidOperationException) {} catch (System.ComponentModel.Win32Exception) {}
        finally { p.Dispose(); }
      }
  }

  // Each output, and what the server refused of them, so one it won't take loses none of the rest.
  string Upload(string id, string outDir, Lease lease) {
    List<string> refused = new List<string>();
    foreach (string file in Directory.GetFiles(outDir, "*", SearchOption.AllDirectories)) {
      if (lease.Lost != null) throw new Abandoned(lease.Lost);
      string rel = file.Substring(outDir.Length + 1).Replace('\\', '/'), path = file;
      try { Ok(Send("PUT", "/worker/jobs/" + id + "/out/" + Segments(rel), () => new StreamContent(File.OpenRead(path))), rel).Dispose(); }
      catch (InvalidOperationException e) { refused.Add(e.Message); }
    }
    return refused.Count == 0 ? null : "outputs refused: " + string.Join("; ", refused);
  }

  static void TryDelete(string file) { try { if (File.Exists(file)) File.Delete(file); } catch (IOException) {} catch (UnauthorizedAccessException) {} }
  // A folder Office may still hold a moment after it's killed: a few tries.
  static void Wipe(string dir) {
    for (int i = 0; i < 5 && Directory.Exists(dir); i++) {
      try { Directory.Delete(dir, true); } catch (IOException) { Thread.Sleep(1000); } catch (UnauthorizedAccessException) { Thread.Sleep(1000); }
    }
  }
}
'@

# What this machine has, for runs to read at $RF_WINDOWS: Windows, PowerShell, .NET, Office's programs and Python, with the
# config's own notes.
function Get-Inventory($extra) {
  $apps = @{}
  foreach ($exe in 'excel.exe', 'winword.exe', 'powerpnt.exe', 'msaccess.exe', 'outlook.exe', 'visio.exe') {
    $key = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exe"
    $path = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).'(default)'
    if ($path -and (Test-Path $path)) { $apps[$exe] = [string](Get-Item $path).VersionInfo.ProductVersion }
  }
  # Not the Microsoft Store's stand-in, which only offers to install Python.
  $python = Get-Command python.exe, py.exe -ErrorAction SilentlyContinue | Where-Object { $_.Source -notlike '*\WindowsApps\*' } | Select-Object -First 1
  $os = Get-CimInstance Win32_OperatingSystem
  $inv = @{
    host = $env:COMPUTERNAME; user = "$env:USERDOMAIN\$env:USERNAME"; windows = "$($os.Caption) $($os.Version)"
    powershell = [string]$PSVersionTable.PSVersion; dotnet = [string](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -ErrorAction SilentlyContinue).Version
    office = $apps; python = if ($python) { [string]$python.Version } else { $null }
  }
  if ($extra) { foreach ($p in $extra.PSObject.Properties) { $inv[$p.Name] = [string]$p.Value } }
  return $inv
}

$cfg = Get-Content -Raw -Path $Config | ConvertFrom-Json
foreach ($field in 'url', 'key', 'fingerprint') { if (-not $cfg.$field) { throw "$Config needs $field" } }
$workdir = if ($cfg.workdir) { $cfg.workdir } else { 'C:\rfjobs' }
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Net.Http, System.Net.Http.WebRequest, System.Web.Extensions, System.Core
$worker = New-Object RfWorker($cfg.url, $cfg.key, $cfg.fingerprint, $workdir, (Get-Inventory $cfg.inventory))
$worker.Run()
