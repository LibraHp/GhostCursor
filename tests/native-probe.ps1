param([switch]$Hotkey, [switch]$Focus)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class GhostProbe {
  public delegate bool Callback(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback c, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a,uint b,bool attach);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
  public static string Title(IntPtr h) { var s=new StringBuilder(512); GetWindowText(h,s,512); return s.ToString(); }
  public static int Markers() { int count=0; EnumWindows((h,p)=> { if(IsWindowVisible(h)&&Title(h)=="GhostCursor Overlay")count++; return true; },IntPtr.Zero); return count; }
  public static int[] Cursor() { Point p;GetCursorPos(out p);return new[]{p.X,p.Y}; }
  public static void FocusTarget() {
    IntPtr target=IntPtr.Zero;EnumWindows((h,p)=>{if(Title(h)=="GhostCursor Test Window"){target=h;return false;}return true;},IntPtr.Zero);
    if(target==IntPtr.Zero)throw new Exception("Test target not found");
    uint pid;uint foreground=GetWindowThreadProcessId(GetForegroundWindow(),out pid), own=GetCurrentThreadId(), dest=GetWindowThreadProcessId(target,out pid);
    bool a=own!=foreground&&AttachThreadInput(own,foreground,true),b=own!=dest&&AttachThreadInput(own,dest,true);
    try{BringWindowToTop(target);SetForegroundWindow(target);}finally{if(b)AttachThreadInput(own,dest,false);if(a)AttachThreadInput(own,foreground,false);}
    if(GetForegroundWindow()!=target)throw new Exception("Unable to bring test target to foreground");
  }
  public static void Toggle() { if(Title(GetForegroundWindow())!="GhostCursor Test Window")throw new Exception("Refusing to send hotkey outside the test target"); keybd_event(0x11,0,0,UIntPtr.Zero);keybd_event(0x12,0,0,UIntPtr.Zero);keybd_event(0x77,0,0,UIntPtr.Zero);keybd_event(0x77,0,2,UIntPtr.Zero);keybd_event(0x12,0,2,UIntPtr.Zero);keybd_event(0x11,0,2,UIntPtr.Zero); }
}
'@
if ($Focus) { [GhostProbe]::FocusTarget() }
if ($Hotkey) { [GhostProbe]::Toggle() }
@{ foreground = [GhostProbe]::Title([GhostProbe]::GetForegroundWindow()); markers = [GhostProbe]::Markers(); cursor = [GhostProbe]::Cursor(); leftDown = ([GhostProbe]::GetAsyncKeyState(1) -band 0x8000) -ne 0 } | ConvertTo-Json -Compress
