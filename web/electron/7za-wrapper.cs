// Thin wrapper around 7za.exe used only at build time on Windows.
//
// electron-builder's app-builder extracts winCodeSign-2.6.0.7z, which contains two
// macOS symlinks (darwin/.../lib*.dylib). Creating symlinks on Windows needs a
// privilege the build account lacks, so 7za returns exit code 2 ("sub items errors")
// even though all 83 real files (including the Windows rcedit tools we actually use)
// extracted fine. app-builder treats exit 2 as fatal. This wrapper forwards every
// argument to the real 7za (renamed 7za-real.exe) and maps THAT benign exit 2 to 0.
//
// Exit 2 is 7-Zip's generic "fatal error" code, and the wrapper replaces 7za.exe
// for EVERY call app-builder makes (packing the app archive and the installer
// too), so a blanket 2 -> 0 would also hide a genuinely failed build (disk full,
// unreadable input). The mapping is therefore narrowed to the symlink case: stderr
// is watched (and still passed through), and exit 2 only becomes 0 when every
// "ERROR:" line 7-Zip printed is a symbolic-link failure — or, should this 7-Zip
// build print its errors to stdout instead, when the call is the winCodeSign
// extraction this wrapper exists for. Compiles with the .NET Framework 4 csc
// (C# 5: no string interpolation or ?.).
using System;
using System.Collections.Generic;
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
        psi.RedirectStandardError = true;

        var errorLines = new List<string>();
        var proc = new Process();
        proc.StartInfo = psi;
        proc.ErrorDataReceived += (sender, e) =>
        {
            if (e.Data == null) return;
            Console.Error.WriteLine(e.Data); // pass through unchanged
            if (e.Data.TrimStart().StartsWith("ERROR:", StringComparison.OrdinalIgnoreCase))
            {
                lock (errorLines) errorLines.Add(e.Data);
            }
        };
        proc.Start();
        proc.BeginErrorReadLine();
        proc.WaitForExit(); // the no-timeout overload also drains the redirected stream

        // Anything but 2 (0 ok, 1 warnings, 7/8/255 ...) passes through untouched.
        if (proc.ExitCode != 2) return proc.ExitCode;

        bool sawSymlinkError = false;
        lock (errorLines)
        {
            foreach (string line in errorLines)
            {
                if (line.IndexOf("symbolic link", StringComparison.OrdinalIgnoreCase) < 0)
                    return 2; // a real failure is in there — don't mask it
                sawSymlinkError = true;
            }
        }
        bool winCodeSign = rest.IndexOf("winCodeSign", StringComparison.OrdinalIgnoreCase) >= 0;
        return sawSymlinkError || winCodeSign ? 0 : 2;
    }
}
