// Reads, never types: which PATH keys a running agent process got from the launch hook. Windows only.
// Finds processes whose command line holds the given text (a coordinator's launch marker), reads each
// one's environment block, and prints the PATH-like key names, whether each value starts with the
// plugin's bin folder, and which CB_ variables are set. Values are never printed.
// Usage: node scripts/probe-path.mjs --match <text in the command line> [--bin <plugin bin folder>]
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const match = arg("--match");
const bin = arg("--bin") ?? join(dirname(dirname(fileURLToPath(import.meta.url))), "bin");
if (!match || process.platform !== "win32") {
  console.error("usage (Windows): node scripts/probe-path.mjs --match <text in the command line> [--bin <folder>]");
  process.exit(1);
}

const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EnvBlock {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, byte[] info, int len, out int ret);
  static byte[] Read(IntPtr h, IntPtr addr, int n) { var b = new byte[n]; IntPtr r; if (!ReadProcessMemory(h, addr, b, (IntPtr)n, out r)) throw new Exception("read failed"); return b; }
  public static string Get(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) throw new Exception("open failed");
    try {
      var pbi = new byte[48]; int ret;
      if (NtQueryInformationProcess(h, 0, pbi, pbi.Length, out ret) != 0) throw new Exception("query failed");
      IntPtr peb = (IntPtr)BitConverter.ToInt64(pbi, 8);
      IntPtr parameters = (IntPtr)BitConverter.ToInt64(Read(h, peb + 0x20, 8), 0);
      IntPtr env = (IntPtr)BitConverter.ToInt64(Read(h, parameters + 0x80, 8), 0);
      long size = BitConverter.ToInt64(Read(h, parameters + 0x3F0, 8), 0);
      return System.Text.Encoding.Unicode.GetString(Read(h, env, (int)Math.Min(size, 1 << 20)));
    } finally { CloseHandle(h); }
  }
}
'@
$bin = $env:PROBE_BIN.ToLowerInvariant().TrimEnd('\')
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:PROBE_MATCH) -and $_.ProcessId -ne $PID } | ForEach-Object {
  $proc = $_
  try {
    $vars = [EnvBlock]::Get([int]$proc.ProcessId).Split([char]0) | Where-Object { $_ -match '^[^=]+=' }
    $paths = $vars | Where-Object { $_ -match '^path=' -or $_ -match '^PATH=' } | ForEach-Object {
      $name, $value = $_ -split '=', 2
      [pscustomobject]@{ key = $name; startsWithBin = $value.ToLowerInvariant().StartsWith($bin); containsBin = $value.ToLowerInvariant().Contains($bin) }
    }
    $cb = $vars | Where-Object { $_ -like 'CB_*' } | ForEach-Object { ($_ -split '=', 2)[0] }
    [pscustomobject]@{ name = $proc.Name; pathKeys = @($paths); cbVariables = @($cb) } | ConvertTo-Json -Depth 4 -Compress
  } catch { [pscustomobject]@{ name = $proc.Name; error = $_.Exception.Message } | ConvertTo-Json -Compress }
}
`;
const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
  encoding: "utf8", env: { ...process.env, PROBE_MATCH: match, PROBE_BIN: bin }, windowsHide: true,
});
console.log(out.trim() || "no process has that text in its command line");
