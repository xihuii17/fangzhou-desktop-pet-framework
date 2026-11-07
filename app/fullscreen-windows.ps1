param([Parameter(Mandatory = $true)][int]$ParentProcessId)
$ErrorActionPreference = 'Stop'

# A single background process per pet, not a new PowerShell process per sample.
# Geometry only: no game handles, injection, keyboard hooks, or focus changes.
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class PetFullscreenProbe {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo {
        public int Size; public Rect Monitor, Work; public uint Flags;
    }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint id);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int count);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    const string Clear = "{\"state\":\"clear\"}";
    const string Unknown = "{\"state\":\"unknown\"}";

    static string Read(int parentId) {
        IntPtr oldDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (oldDpi == IntPtr.Zero) oldDpi = SetThreadDpiAwarenessContext(new IntPtr(-3));
        if (oldDpi == IntPtr.Zero) return Unknown;
        try {
            IntPtr window = GetForegroundWindow();
            if (window == IntPtr.Zero) return Unknown;
            if (window == GetShellWindow()) return Clear;
            if (!IsWindowVisible(window) || IsIconic(window)) return Unknown;
            uint owner;
            if (GetWindowThreadProcessId(window, out owner) == 0) return Unknown;
            if (owner == parentId) return Clear;
            StringBuilder name = new StringBuilder(256);
            if (GetClassName(window, name, name.Capacity) == 0) return Unknown;
            string className = name.ToString();
            if (className == "Progman" || className == "WorkerW" ||
                className == "Shell_TrayWnd" || className == "Shell_SecondaryTrayWnd") return Clear;

            Rect client;
            if (!GetClientRect(window, out client)) return Unknown;
            Point topLeft = new Point { X = client.Left, Y = client.Top };
            Point bottomRight = new Point { X = client.Right, Y = client.Bottom };
            if (!ClientToScreen(window, ref topLeft) || !ClientToScreen(window, ref bottomRight)) return Unknown;
            MonitorInfo info = new MonitorInfo();
            info.Size = Marshal.SizeOf(typeof(MonitorInfo));
            IntPtr monitor = MonitorFromWindow(window, 2);
            if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref info)) return Unknown;
            // Check the CLIENT area against the full monitor, not the work area.
            // A normal maximized window still has a title bar and must stay clear.
            const int tolerance = 2;
            Rect bounds = info.Monitor;
            bool fullscreen = topLeft.X <= bounds.Left + tolerance && topLeft.Y <= bounds.Top + tolerance &&
                bottomRight.X >= bounds.Right - tolerance && bottomRight.Y >= bounds.Bottom - tolerance;
            // Do not report a stale clear snapshot while foreground is changing.
            if (window != GetForegroundWindow()) return Unknown;
            if (!fullscreen) return Clear;
            return "{\"state\":\"fullscreen\",\"bounds\":{\"x\":" + topLeft.X +
                ",\"y\":" + topLeft.Y + ",\"width\":" + (bottomRight.X - topLeft.X) +
                ",\"height\":" + (bottomRight.Y - topLeft.Y) + "}}";
        } finally { SetThreadDpiAwarenessContext(oldDpi); }
    }

    public static void Run(int parentId) {
        using (Process parent = Process.GetProcessById(parentId)) {
            do {
                Console.Out.WriteLine(Read(parentId));
                Console.Out.Flush();
            } while (!parent.WaitForExit(100));
        }
    }
}
'@
[PetFullscreenProbe]::Run($ParentProcessId)
