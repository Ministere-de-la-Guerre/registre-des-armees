// Thin wrapper around 7za.exe used only at build time on Windows.
//
// electron-builder's app-builder extracts winCodeSign-2.6.0.7z, which contains two
// macOS symlinks (darwin/.../lib*.dylib). Creating symlinks on Windows needs a
// privilege the build account lacks, so 7za returns exit code 2 ("sub items errors")
// even though all 83 real files (including the Windows rcedit tools we actually use)
// extracted fine. app-builder treats exit 2 as fatal. This wrapper forwards every
// argument to the real 7za (renamed 7za-real.exe) and maps the benign exit 2 to 0.
using System;
using System.Diagnostics;
using System.IO;

class SevenZaWrapper
{
    static int Main()
    {
        string raw = Environment.CommandLine;
        // Strip this program's own path (first token, possibly quoted) to get the args.
        string rest;
        if (raw.Length > 0 && raw[0] == '"')
        {
            int end = raw.IndexOf('"', 1);
            rest = end >= 0 ? raw.Substring(end + 1) : "";
        }
        else
        {
            int sp = raw.IndexOf(' ');
            rest = sp < 0 ? "" : raw.Substring(sp);
        }

        string dir = AppDomain.CurrentDomain.BaseDirectory;
        var psi = new ProcessStartInfo(Path.Combine(dir, "7za-real.exe"), rest.Trim());
        psi.UseShellExecute = false;
        var proc = Process.Start(psi);
        proc.WaitForExit();
        // 2 = 7-Zip "non-fatal warnings" (here: only the unsupported macOS symlinks).
        return proc.ExitCode == 2 ? 0 : proc.ExitCode;
    }
}
