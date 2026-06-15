using System.Runtime.InteropServices;

namespace FlaUiSidecar;

/// <summary>Minimal Win32 interop for reliably foregrounding a window (beats the SetForegroundWindow
/// foreground-lock via the AttachThreadInput trick). Used so real SendInput lands on the session window.</summary>
internal static class Win32
{
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] private static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT rect);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT pt);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X, Y; }

    private const int SW_RESTORE = 9;
    private const int SW_MINIMIZE = 6;
    private static readonly IntPtr HWND_TOPMOST = new(-1);
    private static readonly IntPtr HWND_NOTOPMOST = new(-2);
    private const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40;

    public static bool IsForeground(IntPtr hwnd) => GetForegroundWindow() == hwnd;

    /// <summary>Current mouse cursor position in screen coordinates (P2-7a: the documented fallback for a
    /// click/hover with no element and no explicit x/y). Returns (0,0) if the call fails.</summary>
    public static System.Drawing.Point CursorPos() =>
        GetCursorPos(out var p) ? new System.Drawing.Point(p.X, p.Y) : System.Drawing.Point.Empty;

    /// <summary>The current foreground window's HWND (Zero if none). Used to prefer the foreground match when
    /// resolving an appName window-title attach.</summary>
    public static IntPtr GetForeground() => GetForegroundWindow();

    /// <summary>Basic activation: restore + AttachThreadInput trick + SetForegroundWindow. Used by the
    /// `click` bring-on-top — a light activation, no always-on-top games.</summary>
    public static void ForceForeground(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return;
        ShowWindow(hwnd, SW_RESTORE);
        var fg = GetForegroundWindow();
        var fgThread = GetWindowThreadProcessId(fg, out _);
        var thisThread = GetCurrentThreadId();
        var attached = fgThread != thisThread && AttachThreadInput(fgThread, thisThread, true);
        try
        {
            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);
        }
        finally
        {
            if (attached) AttachThreadInput(fgThread, thisThread, false);
        }
    }

    /// <summary>Strong, escalating foreground for `windows: setWindowForeground`: basic activation, then —
    /// if the window still isn't foreground — a HWND_TOPMOST→HWND_NOTOPMOST toggle to jump it above, then a
    /// minimize→restore as a last resort. Each step re-checks so we stop as soon as it's on top.</summary>
    public static void ForceForegroundStrong(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return;
        ForceForeground(hwnd);
        if (IsForeground(hwnd)) return;
        // Escalate 1: bounce through always-on-top so the window is raised above the current foreground.
        SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        ForceForeground(hwnd);
        if (IsForeground(hwnd)) return;
        // Escalate 2: a minimize/restore cycle forces the shell to reactivate the window.
        if (!IsIconic(hwnd)) { ShowWindow(hwnd, SW_MINIMIZE); ShowWindow(hwnd, SW_RESTORE); ForceForeground(hwnd); }
    }

    /// <summary>Win32 fallback move/resize for windows without a usable UIA TransformPattern (F16).
    /// Any of x/y/width/height may be null → keep the window's current value for that field.</summary>
    public static bool MoveResize(IntPtr hwnd, int? x, int? y, int? width, int? height)
    {
        if (hwnd == IntPtr.Zero) return false;
        if (!GetWindowRect(hwnd, out var r)) return false;
        var nx = x ?? r.Left;
        var ny = y ?? r.Top;
        var nw = width ?? (r.Right - r.Left);
        var nh = height ?? (r.Bottom - r.Top);
        return MoveWindow(hwnd, nx, ny, nw, nh, true);
    }
}
