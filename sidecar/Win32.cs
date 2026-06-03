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

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    private const int SW_RESTORE = 9;

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
