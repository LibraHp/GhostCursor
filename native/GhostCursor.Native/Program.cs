using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace GhostCursor.Native;

internal static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        if (args.Length != 1 || !args[0].StartsWith("ghostcursor-")) return;
        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        var engine = new Engine(app);
        app.Startup += async (_, _) => await engine.Connect(args[0]);
        app.Exit += (_, _) => engine.Dispose();
        app.Run();
    }
}

internal sealed class Engine(Application app) : IDisposable
{
    private NamedPipeClientStream? pipe;
    private StreamWriter? writer;
    private readonly Dictionary<string, Marker> markers = [];
    private readonly HashSet<int> buttons = [];
    private readonly CursorVisibility cursorVisibility = new();
    private CursorAppearance appearance = new();
    private readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromMilliseconds(33) };
    private IntPtr target;
    private uint targetPid;
    private int frameWidth, frameHeight;
    private bool enabled;
    private string controller = "";
    private long epoch;
    private long lastControllerInput;
    private string lastStatus = "";
    private string inputFailure = "";

    public async Task Connect(string name)
    {
        try
        {
            pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
            await pipe.ConnectAsync(10000);
            writer = new StreamWriter(pipe, new UTF8Encoding(false)) { AutoFlush = true };
            var reader = new StreamReader(pipe, Encoding.UTF8);
            timer.Tick += (_, _) => Tick(); timer.Start();
            while (pipe.IsConnected)
            {
                var line = await reader.ReadLineAsync();
                if (line is null) break;
                if (line.Length > 65536) break;
                try
                {
                    using var document = JsonDocument.Parse(line);
                    var data = document.RootElement;
                    var id = data.TryGetProperty("id", out var idProp) ? idProp.GetInt32() : 0;
                    if (Str(data, "type") == "windows")
                    {
                        Reply(new { id, ok = true, windows = ListWindows((uint)Num(data, "excludePid")) });
                        continue;
                    }
                    if (Str(data, "type") == "snapshot")
                    {
                        var available = Available(out _, out var reason);
                        Reply(new { id, ok = true, processId = Environment.ProcessId, successfulInputs = Win.SuccessfulInputs, visibleMarkers = markers.Values.Count(m => m.Window.IsVisible), available, reason, enabled, epoch, frameWidth, frameHeight, cursorHidden = cursorVisibility.Hidden, cursorShape = appearance.Shape, cursorSize = appearance.Size, cursorColor = appearance.Color,
                            markers = markers.Select(m => new { id = m.Key, age = Now - m.Value.LastSeen, visible = m.Value.Window.IsVisible, x = m.Value.X, y = m.Value.Y }).ToArray() });
                        continue;
                    }
                    try
                    {
                        if (Str(data, "type") == "activate") await Activate(); else Handle(data);
                        if (id > 0) Reply(new { id, ok = true, enabled, epoch });
                    }
                    catch (Exception e) { Fault(e.Message); if (id > 0) Reply(new { id, ok = false, error = e.Message }); }
                }
                catch (JsonException) { Revoke(); }
            }
        }
        catch { /* Parent observes the pipe closing and stops sharing. */ }
        finally { Dispose(); app.Shutdown(); }
    }

    private void Reply(object value)
    {
        try { writer?.WriteLine(JsonSerializer.Serialize(value)); }
        catch { Revoke(); app.Shutdown(); }
    }

    private static string Str(JsonElement e, string key) => e.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
    private static bool Bool(JsonElement e, string key) => e.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.True;
    private static double Num(JsonElement e, string key) => e.TryGetProperty(key, out var v) && v.TryGetDouble(out var d) ? d : 0;
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static object[] ListWindows(uint excludePid)
    {
        var windows = new List<object>();
        Win.EnumWindows((hwnd, _) =>
        {
            if (windows.Count >= 256) return false;
            if (hwnd == Win.GetShellWindow() || !Win.IsWindowVisible(hwnd) || Win.Cloaked(hwnd)) return true;
            Win.GetWindowThreadProcessId(hwnd, out var pid);
            if (pid == Environment.ProcessId || pid == excludePid) return true;
            // Skip tool windows. Reading foreign titles uses the OS caption cache,
            // without asking unresponsive applications to render thumbnails.
            if ((Win.GetWindowLongPtr(hwnd, -20).ToInt64() & 0x80) != 0) return true;
            var title = new StringBuilder(512);
            Win.GetWindowText(hwnd, title, title.Capacity);
            var name = title.ToString().Trim();
            if (name.Length > 0) windows.Add(new { id = $"window:{hwnd.ToInt64()}:0", name, thumbnail = "" });
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }

    private void Handle(JsonElement data)
    {
        switch (Str(data, "type"))
        {
            case "target":
                Clear();
                if (!long.TryParse(Str(data, "hwnd"), out var handle)) throw new Exception("窗口句柄无效");
                target = new IntPtr(handle);
                Win.GetWindowThreadProcessId(target, out targetPid);
                if (!Win.IsWindow(target) || targetPid == Environment.ProcessId || !Win.IsWindowVisible(target)) { Clear(); throw new Exception("目标窗口已关闭或不可见"); }
                lastStatus = ""; Tick(); break;
            case "frame":
                frameWidth = (int)Num(data, "width"); frameHeight = (int)Num(data, "height"); Tick(); break;
            case "appearance":
                var shape = Str(data, "shape"); var size = (int)Num(data, "size"); var color = Str(data, "color");
                if (shape is not ("arrow" or "ring" or "crosshair") || size is not (24 or 32 or 44) || (color.Length > 0 && !System.Text.RegularExpressions.Regex.IsMatch(color, "^#[0-9a-fA-F]{6}$"))) throw new Exception("无效鼠标样式");
                appearance = new CursorAppearance(shape, size, color.Length > 0 ? color : null);
                foreach (var item in markers.Values) item.Style(appearance);
                Tick(); break;
            case "grant":
                Revoke(); epoch = (long)Num(data, "epoch"); controller = Str(data, "controller");
                if (Bool(data, "enabled"))
                {
                    inputFailure = "";
                    if (controller.Length == 0) throw new Exception("请先选择控制者");
                    if (!Available(out _, out var reason)) throw new Exception(reason);
                    enabled = true;
                }
                lastControllerInput = Now;
                Tick(); break;
            case "pointer": Pointer(data); break;
            case "remove":
                var id = Str(data, "visitor");
                if (markers.Remove(id, out var marker)) marker.Window.Close();
                if (controller == id) Revoke(); break;
            case "clear": Clear(); break;
            case "shutdown": Clear(); app.Shutdown(); break;
        }
    }

    private async Task Activate()
    {
        if (!Win.IsWindow(target) || target == IntPtr.Zero) throw new Exception("共享窗口已关闭");
        // User-initiated host button/global shortcut; never triggered by visitors.
        if (Win.IsIconic(target)) Win.ShowWindow(target, 9);
        Win.SetForegroundWindow(target);
        for (var i = 0; i < 12 && Win.GetAncestor(Win.GetForegroundWindow(), 2) != target; i++) await Task.Delay(40);
        if (Win.GetAncestor(Win.GetForegroundWindow(), 2) != target) throw new Exception("Windows 未允许切换窗口。请手动切回共享窗口，再按控制快捷键");
        inputFailure = "";
        // Allow a restored/resized capture to report its new frame dimensions.
        await Task.Delay(100);
    }

    private bool Available(out Win.Rect rect, out string reason)
    {
        rect = default; reason = "";
        if (inputFailure.Length > 0) { reason = inputFailure; return false; }
        if (target == IntPtr.Zero) { reason = "尚未选择共享窗口"; return false; }
        Win.GetWindowThreadProcessId(target, out var pid);
        if (!Win.IsWindow(target) || pid != targetPid) { reason = "共享窗口已关闭"; return false; }
        if (!Win.IsWindowVisible(target) || Win.IsIconic(target) || Win.Cloaked(target)) { reason = "共享窗口已隐藏或最小化"; return false; }
        if (Win.GetAncestor(Win.GetForegroundWindow(), 2) != target) { reason = "请将共享窗口切到前台；访客位置仅在该窗口前台时显示"; return false; }
        if (Win.DwmGetWindowAttribute(target, 9, out rect, Marshal.SizeOf<Win.Rect>()) != 0) Win.GetWindowRect(target, out rect);
        if (rect.Width <= 0 || rect.Height <= 0 || frameWidth <= 0 || frameHeight <= 0) { reason = "等待共享画面就绪"; return false; }
        // Capture backends differ in whether non-client borders are included.
        // Compare only actual OS window rectangles, never arbitrary desktop bounds.
        var candidates = new List<Win.Rect> { rect };
        if (Win.GetWindowRect(target, out var outer) && outer.Width > 0 && outer.Height > 0) candidates.Add(outer);
        if (Win.GetClientRect(target, out var client))
        {
            var origin = new Win.Point(0, 0);
            if (Win.ClientToScreen(target, ref origin) && client.Width > 0 && client.Height > 0)
                candidates.Add(new Win.Rect { Left = origin.X, Top = origin.Y, Right = origin.X + client.Width, Bottom = origin.Y + client.Height });
        }
        double Difference(Win.Rect r) => Math.Abs((double)frameWidth / frameHeight / ((double)r.Width / r.Height) - 1);
        rect = candidates.OrderBy(Difference).First();
        var ratioError = Difference(rect);
        if (ratioError > 0.025) { reason = "画面尺寸与窗口不匹配，已暂停标记和控制；请恢复窗口或重新共享"; return false; }
        return true;
    }

    private bool PointVisible(Win.Point point)
    {
        // Enumerate in Z order and ignore our click-through marker windows.
        // Conservatively reject any unrelated visible window covering this point.
        IntPtr hit = IntPtr.Zero;
        Win.EnumWindows((hwnd, _) =>
        {
            if (!Win.IsWindowVisible(hwnd) || Win.IsIconic(hwnd) || Win.Cloaked(hwnd)) return true;
            Win.GetWindowThreadProcessId(hwnd, out var pid);
            if (pid == Environment.ProcessId) return true;
            if ((Win.GetWindowLongPtr(hwnd, -20).ToInt64() & 0x20) != 0) return true;
            if (!Win.GetWindowRect(hwnd, out var r) || !r.Contains(point.X, point.Y)) return true;
            hit = hwnd; return false;
        }, IntPtr.Zero);
        return hit == target;
    }

    private void Pointer(JsonElement data)
    {
        var visitor = Str(data, "visitor"); var action = Str(data, "action");
        if (visitor.Length == 0 || target == IntPtr.Zero) return;
        var touch = Str(data, "pointerType") is "touch" or "pen";
        var inject = action is not ("touch-start" or "touch-end") && Bool(data, "inject") && enabled && controller == visitor && epoch == (long)Num(data, "epoch");
        if (action is "leave" or "release")
        {
            if (markers.TryGetValue(visitor, out var old)) { old.LastSeen = 0; old.Window.Hide(); }
            if (inject) ReleaseButtons(); return;
        }
        // Discard queued inputs rather than replaying old clicks after a UI stall.
        if (Math.Abs(Now - (long)Num(data, "sentAt")) > 250) { if (inject) ReleaseButtons(); return; }
        var x = Num(data, "x"); var y = Num(data, "y");
        if (!double.IsFinite(x) || !double.IsFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return;
        if (!markers.TryGetValue(visitor, out var marker))
        {
            if (markers.Count >= 8) return;
            marker = new Marker(Str(data, "name"), Str(data, "color"), target); markers.Add(visitor, marker);
        }
        marker.Style(appearance); marker.SetTouch(touch);
        marker.X = x; marker.Y = y; marker.LastSeen = Now;
        if (action == "touch-end") { marker.LastSeen = 0; marker.Window.Hide(); return; }
        if (!Available(out var rect, out _)) { Revoke(); marker.Window.Hide(); return; }
        var point = new Win.Point(rect.Left + (int)Math.Round(x * (rect.Width - 1)), rect.Top + (int)Math.Round(y * (rect.Height - 1)));
        if (!PointVisible(point)) { if (inject) Fault("操作位置被其他窗口遮挡，已收回控制；请关闭遮挡窗口后重新授权"); marker.Window.Hide(); return; }
        if (!enabled || visitor == controller) marker.Place(point, rect); else marker.Window.Hide();
        if (!inject) return;
        lastControllerInput = Now;
        if (action == "up")
        {
            var button = (int)Num(data, "button");
            if (buttons.Remove(button)) { Move(point); if (!SendButton(button, false)) Fault(InputError); }
            return;
        }
        if (!Move(point)) { Fault(InputError); return; }
        if (action == "down")
        {
            var button = (int)Num(data, "button");
            if (button is >= 0 and <= 2 && buttons.Add(button) && !SendButton(button, true)) Fault(InputError);
        }
        else if (action == "wheel")
        {
            var delta = Math.Clamp((int)Num(data, "delta"), -1200, 1200);
            // DOM positive wheel delta scrolls down; Windows uses negative units.
            if (!Win.SendMouse(0, 0, unchecked((uint)-delta), 0x0800)) Fault(InputError);
        }
    }

    private static bool Move(Win.Point p)
    {
        var left = Win.GetSystemMetrics(76); var top = Win.GetSystemMetrics(77);
        var width = Win.GetSystemMetrics(78); var height = Win.GetSystemMetrics(79);
        if (width <= 1 || height <= 1) return false;
        var x = (int)Math.Round((p.X - left) * 65535.0 / (width - 1));
        var y = (int)Math.Round((p.Y - top) * 65535.0 / (height - 1));
        return Win.SendMouse(x, y, 0, 0x0001 | 0x8000 | 0x4000);
    }
    private static bool SendButton(int button, bool down) => Win.SendMouse(0, 0, 0, button switch { 0 => down ? 0x0002u : 0x0004u, 1 => down ? 0x0020u : 0x0040u, 2 => down ? 0x0008u : 0x0010u, _ => 0 });
    private void ReleaseButtons() { foreach (var button in buttons) SendButton(button, false); buttons.Clear(); }
    private void Revoke() { enabled = false; ReleaseButtons(); cursorVisibility.Restore(); }
    private const string InputError = "Windows 拒绝鼠标输入。若目标应用以管理员身份运行，请改用普通权限运行目标应用，或手动以相同权限重新启动 GhostCursor";
    private void Fault(string reason)
    {
        inputFailure = reason; Revoke(); lastStatus = "";
        Reply(new { type = "status", available = false, enabled, epoch, reason });
    }

    private void Tick()
    {
        if (target == IntPtr.Zero) return;
        var available = Available(out var rect, out var reason);
        if (!available) Revoke();
        // A lost release event must not leave a system button held indefinitely.
        if (buttons.Count > 0 && Now - lastControllerInput > 1500) ReleaseButtons();
        var showingController = false;
        foreach (var entry in markers)
        {
            var marker = entry.Value;
            var p = new Win.Point(rect.Left + (int)(marker.X * Math.Max(0, rect.Width - 1)), rect.Top + (int)(marker.Y * Math.Max(0, rect.Height - 1)));
            if (enabled && entry.Key == controller && Win.GetCursorPos(out var actual) && rect.Contains(actual.X, actual.Y)) p = actual;
            if (!available || (enabled && entry.Key != controller) || Now - marker.LastSeen > 1800 || !PointVisible(p)) marker.Window.Hide();
            else { marker.Place(p, rect); if (enabled && entry.Key == controller) showingController = true; }
        }
        if (enabled && showingController && Win.GetCursorPos(out var current) && rect.Contains(current.X, current.Y) && PointVisible(current))
        {
            if (!cursorVisibility.Hide(target)) Fault("无法接管共享窗口的鼠标显示，已收回控制");
        }
        else cursorVisibility.Restore();
        var status = $"{available}:{reason}:{enabled}:{epoch}";
        if (status != lastStatus)
        {
            lastStatus = status;
            Reply(new { type = "status", available, enabled, epoch, reason, closed = reason == "共享窗口已关闭" });
        }
    }

    private void Clear()
    {
        Revoke(); target = IntPtr.Zero; targetPid = 0; controller = ""; frameWidth = frameHeight = 0;
        foreach (var marker in markers.Values) marker.Window.Close();
        markers.Clear(); lastStatus = ""; inputFailure = "";
    }
    public void Dispose() { timer.Stop(); Clear(); pipe?.Dispose(); pipe = null; }
}

internal sealed record CursorAppearance(string Shape = "arrow", int Size = 32, string? Color = null);

internal sealed class Marker
{
    public Window Window { get; }
    private readonly IntPtr handle;
    private readonly Canvas canvas;
    private readonly System.Windows.Shapes.Path cursor;
    private readonly Ellipse touchRing;
    private readonly Ellipse touchDot;
    private readonly System.Windows.Shapes.Path crosshair;
    private readonly Border label;
    private readonly string visitorColor;
    private bool touch;
    private CursorAppearance appearance = new();
    public double X, Y;
    public long LastSeen;
    public Marker(string name, string color, IntPtr owner)
    {
        visitorColor = color;
        var brush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(color));
        canvas = new Canvas { Width = 150, Height = 66, IsHitTestVisible = false };
        cursor = new System.Windows.Shapes.Path { Data = Geometry.Parse("M 2,2 L 3,26 L 9,20 L 14,31 L 19,28 L 14,18 L 23,17 Z"), Fill = brush, Stroke = Brushes.White, StrokeThickness = 1.5 };
        canvas.Children.Add(cursor);
        touchRing = new Ellipse { Width = 28, Height = 28, Stroke = brush, StrokeThickness = 2, Fill = new SolidColorBrush(Color.FromArgb(45, brush.Color.R, brush.Color.G, brush.Color.B)), Visibility = Visibility.Collapsed };
        touchDot = new Ellipse { Width = 6, Height = 6, Fill = brush, Stroke = Brushes.White, StrokeThickness = 1, Visibility = Visibility.Collapsed };
        Canvas.SetLeft(touchRing, -12); Canvas.SetTop(touchRing, -12);
        Canvas.SetLeft(touchDot, -1); Canvas.SetTop(touchDot, -1);
        canvas.Children.Add(touchRing); canvas.Children.Add(touchDot);
        crosshair = new System.Windows.Shapes.Path { Data = Geometry.Parse("M2,-13 L2,-3 M2,7 L2,17 M-13,2 L-3,2 M7,2 L17,2"), Stroke = brush, StrokeThickness = 2, Visibility = Visibility.Collapsed };
        canvas.Children.Add(crosshair);
        label = new Border { Background = brush, CornerRadius = new CornerRadius(5), Padding = new Thickness(7, 3, 7, 3), MaxWidth = 142,
            Child = new TextBlock { Text = name, Foreground = Brushes.White, FontSize = 11, TextTrimming = TextTrimming.CharacterEllipsis } };
        Canvas.SetLeft(label, 5); Canvas.SetTop(label, 33); canvas.Children.Add(label);
        Window = new Window { Title = "GhostCursor Overlay", Width = 190, Height = 116, WindowStyle = WindowStyle.None, ResizeMode = ResizeMode.NoResize,
            AllowsTransparency = true, Background = Brushes.Transparent, ShowInTaskbar = false, ShowActivated = false, Focusable = false, IsHitTestVisible = false, Content = new Canvas { Children = { canvas } } };
        handle = new WindowInteropHelper(Window).EnsureHandle();
        Win.SetWindowLongPtr(handle, -20, new IntPtr(Win.GetWindowLongPtr(handle, -20).ToInt64() | 0x20 | 0x80 | 0x08000000));
        Win.SetWindowLongPtr(handle, -8, owner);
        HwndSource.FromHwnd(handle)?.AddHook((IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled) =>
        {
            if (msg == 0x0084) { handled = true; return new IntPtr(-1); }
            if (msg == 0x0021) { handled = true; return new IntPtr(3); }
            return IntPtr.Zero;
        });
        // Avoid duplicate cursor markers in the outgoing capture when supported.
        Win.SetWindowDisplayAffinity(handle, 0x11);
    }
    public void SetTouch(bool touch)
    {
        this.touch = touch;
        Refresh();
    }
    public void Style(CursorAppearance value) { if (appearance == value) return; appearance = value; Refresh(); }
    private void Refresh()
    {
        var brush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(appearance.Color ?? visitorColor));
        var shape = touch ? "ring" : appearance.Shape;
        cursor.Fill = touchDot.Fill = label.Background = brush; touchRing.Stroke = crosshair.Stroke = brush;
        touchRing.Fill = new SolidColorBrush(Color.FromArgb(45, brush.Color.R, brush.Color.G, brush.Color.B));
        cursor.Visibility = shape == "arrow" ? Visibility.Visible : Visibility.Collapsed;
        touchRing.Visibility = shape == "ring" ? Visibility.Visible : Visibility.Collapsed;
        touchDot.Visibility = shape != "arrow" ? Visibility.Visible : Visibility.Collapsed;
        crosshair.Visibility = shape == "crosshair" ? Visibility.Visible : Visibility.Collapsed;
        var scale = appearance.Size / 32.0;
        foreach (var element in new UIElement[] { cursor, touchRing, touchDot, crosshair }) element.RenderTransform = new ScaleTransform(scale, scale, 2, 2);
        Canvas.SetTop(label, shape == "arrow" ? appearance.Size + 4 : appearance.Size / 2.0 + 10);
    }
    public void Place(Win.Point point, Win.Rect bounds)
    {
        if (!Window.IsVisible) Window.Show();
        // Clip the drawing at the selected window boundary, including labels at edges.
        var dpi = VisualTreeHelper.GetDpi(Window);
        const double anchor = 28;
        Canvas.SetLeft(canvas, anchor - 2); Canvas.SetTop(canvas, anchor - 2);
        var left = point.X - (int)Math.Round(anchor * dpi.DpiScaleX);
        var top = point.Y - (int)Math.Round(anchor * dpi.DpiScaleY);
        Win.SetWindowPos(handle, IntPtr.Zero, left, top, 0, 0, 0x0010 | 0x0001 | 0x0004);
        var clipLeft = Math.Max(0, (bounds.Left - left) / dpi.DpiScaleX);
        var clipTop = Math.Max(0, (bounds.Top - top) / dpi.DpiScaleY);
        var right = Math.Max(clipLeft, Math.Min(190, (bounds.Right - left) / dpi.DpiScaleX));
        var bottom = Math.Max(clipTop, Math.Min(116, (bounds.Bottom - top) / dpi.DpiScaleY));
        Window.Clip = new RectangleGeometry(new Rect(clipLeft, clipTop, right - clipLeft, bottom - clipTop));
    }
}

internal static class Win
{
    internal static int SuccessfulInputs;
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { public int Left, Top, Right, Bottom; public readonly int Width => Right - Left; public readonly int Height => Bottom - Top; public readonly bool Contains(int x, int y) => x >= Left && x < Right && y >= Top && y < Bottom; }
    [StructLayout(LayoutKind.Sequential)] internal struct Point(int x, int y) { public int X = x, Y = y; }
    [StructLayout(LayoutKind.Sequential)] private struct MouseInput { public int dx, dy; public uint data, flags, time; public UIntPtr extraInfo; }
    // INPUT union is 32 bytes on x64; MOUSEINPUT is its largest member.
    [StructLayout(LayoutKind.Sequential)] private struct Input { public uint type; public MouseInput mouse; }
    internal delegate bool EnumProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] internal static extern bool EnumWindows(EnumProc callback, IntPtr param);
    [DllImport("user32.dll")] internal static extern IntPtr GetShellWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] internal static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] internal static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] internal static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] internal static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] internal static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] internal static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] internal static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] internal static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
    [DllImport("user32.dll")] internal static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] internal static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
    [DllImport("user32.dll")] internal static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] input, int size);
    [DllImport("dwmapi.dll")] internal static extern int DwmGetWindowAttribute(IntPtr hwnd, uint attribute, out Rect value, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] private static extern int DwmGetInt(IntPtr hwnd, uint attribute, out int value, int size);
    internal static bool Cloaked(IntPtr hwnd) => DwmGetInt(hwnd, 14, out var value, 4) == 0 && value != 0;
    internal static bool SendMouse(int x, int y, uint data, uint flags)
    {
        var ok = flags != 0 && SendInput(1, [new Input { type = 0, mouse = new MouseInput { dx = x, dy = y, data = data, flags = flags } }], Marshal.SizeOf<Input>()) == 1;
        if (ok) SuccessfulInputs++;
        return ok;
    }
}
