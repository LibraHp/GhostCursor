using System.Runtime.InteropServices;

namespace GhostCursor.Native;

// Scope ShowCursor to the target input queue; never replace the Windows cursor scheme.
// Every decrement has a matching increment before detaching the queues.
internal sealed class CursorVisibility : IDisposable
{
    private uint attachedThread;
    private int decrements;
    public bool Hidden => decrements > 0;
    public bool Hide(IntPtr target)
    {
        var thread = Win.GetWindowThreadProcessId(target, out _);
        if (attachedThread != 0 && attachedThread != thread) Restore();
        if (attachedThread == 0)
        {
            if (!AttachThreadInput(GetCurrentThreadId(), thread, true)) return false;
            attachedThread = thread;
        }
        if (decrements == 0)
        {
            int count;
            do { count = ShowCursor(false); decrements++; } while (count >= 0 && decrements < 32);
            if (count >= 0) { Restore(); return false; }
        }
        return true;
    }
    public void Restore()
    {
        for (var i = 0; i < decrements; i++) ShowCursor(true);
        decrements = 0;
        if (attachedThread != 0) AttachThreadInput(GetCurrentThreadId(), attachedThread, false);
        attachedThread = 0;
    }
    public void Dispose() => Restore();
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint source, uint target, bool attach);
    [DllImport("user32.dll")] private static extern int ShowCursor(bool show);
}
