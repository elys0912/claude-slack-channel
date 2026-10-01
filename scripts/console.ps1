# claude-slack-channel: 自分が属するコンソールの画面を読む・選択キーを送る
#
# ブリッジ（node）が子プロセスとして起動する。ブリッジは Claude Code と同じコンソールを継承しているので、
# このスクリプトも同じコンソールの CONOUT$ / CONIN$ をそのまま開ける（AttachConsole は使わない）。
# 結果は標準出力（パイプ）にだけ書き、コンソールには何も書かない（Claude Code の画面を崩さないため）。
#
# 使い方:
#   console.ps1 -Mode read                     表示中の範囲の文字を UTF-8 で標準出力に書く
#   console.ps1 -Mode keys -Keys Down,Enter    キーを順に送る（Up / Down / Enter のみ）

param(
    [Parameter(Mandatory)][ValidateSet('read', 'keys')][string]$Mode,
    [ValidateSet('Up', 'Down', 'Enter')][string[]]$Keys = @()
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# 仮想キーコード（VK_UP / VK_DOWN / VK_RETURN）と、Enter の文字
$VK_UP = 0x26
$VK_DOWN = 0x28
$VK_RETURN = 0x0D
$CHAR_NONE = [char]0
$CHAR_CR = [char]13
# TUI が 1 キーずつ描き直す間を空ける
$KEY_INTERVAL_MS = 80

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class SlackChannelConsole {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    [StructLayout(LayoutKind.Sequential)] struct COORD { public short X; public short Y; }
    [StructLayout(LayoutKind.Sequential)] struct SMALL_RECT { public short Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct CSBI {
        public COORD Size; public COORD Cursor; public ushort Attr; public SMALL_RECT Window; public COORD Max;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI info);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ReadConsoleOutputCharacter(IntPtr h, StringBuilder buf, uint len, COORD at, out uint read);

    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)] struct KEY_EVENT_RECORD {
        [FieldOffset(0)] public int bKeyDown; [FieldOffset(4)] public ushort wRepeatCount;
        [FieldOffset(6)] public ushort wVirtualKeyCode; [FieldOffset(8)] public ushort wVirtualScanCode;
        [FieldOffset(10)] public char UnicodeChar; [FieldOffset(12)] public uint dwControlKeyState;
    }
    [StructLayout(LayoutKind.Explicit)] struct INPUT_RECORD {
        [FieldOffset(0)] public ushort EventType; [FieldOffset(4)] public KEY_EVENT_RECORD Key;
    }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool WriteConsoleInput(IntPtr h, INPUT_RECORD[] recs, uint n, out uint written);

    const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000, SHARE_RW = 3, OPEN_EXISTING = 3;
    static readonly IntPtr INVALID = new IntPtr(-1);

    static IntPtr Open(string name) {
        IntPtr h = CreateFile(name, GENERIC_READ | GENERIC_WRITE, SHARE_RW, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (h == INVALID) throw new InvalidOperationException(name + " を開けない（コンソールが無い） error=" + Marshal.GetLastWin32Error());
        return h;
    }

    // 表示中のウィンドウ範囲の文字を読む
    public static string ReadScreen() {
        IntPtr h = Open("CONOUT$");
        try {
            CSBI info;
            if (!GetConsoleScreenBufferInfo(h, out info)) throw new InvalidOperationException("画面の情報を取れない");
            int width = info.Size.X;
            var sb = new StringBuilder();
            for (int y = info.Window.Top; y <= info.Window.Bottom; y++) {
                var line = new StringBuilder(width);
                uint read;
                ReadConsoleOutputCharacter(h, line, (uint)width, new COORD { X = 0, Y = (short)y }, out read);
                sb.Append(line.ToString(0, (int)Math.Min(read, (uint)line.Length)).TrimEnd());
                sb.Append('\n');
            }
            return sb.ToString();
        } finally { CloseHandle(h); }
    }

    // キーを 1 つ送る（押して離す）
    public static void SendKey(char c, ushort vk) {
        IntPtr h = Open("CONIN$");
        try {
            var recs = new INPUT_RECORD[2];
            for (int i = 0; i < 2; i++) {
                recs[i].EventType = 1; // KEY_EVENT
                recs[i].Key.bKeyDown = i == 0 ? 1 : 0;
                recs[i].Key.wRepeatCount = 1;
                recs[i].Key.wVirtualKeyCode = vk;
                recs[i].Key.UnicodeChar = c;
            }
            uint written;
            if (!WriteConsoleInput(h, recs, 2, out written) || written != 2) throw new InvalidOperationException("キーを送れない");
        } finally { CloseHandle(h); }
    }
}
'@

if ($Mode -eq 'read') {
    [Console]::Out.Write([SlackChannelConsole]::ReadScreen())
    exit 0
}

foreach ($key in $Keys) {
    switch ($key) {
        'Up' { [SlackChannelConsole]::SendKey($CHAR_NONE, $VK_UP) }
        'Down' { [SlackChannelConsole]::SendKey($CHAR_NONE, $VK_DOWN) }
        'Enter' { [SlackChannelConsole]::SendKey($CHAR_CR, $VK_RETURN) }
    }
    Start-Sleep -Milliseconds $KEY_INTERVAL_MS
}
exit 0
