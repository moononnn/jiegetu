// Windows Graphics Capture, cursor excluded at the capture source.
// No input injection, cursor hiding, pixel repair, files or network.
// args: x y width height            one long-image sample, up to 16,000,000 pixels
// args: x y width height --snapshot one plain full-screen snapshot, up to 36,000,000 pixels
// args: x y width height --snapshot-lazy same snapshot budget, but defer frame pool/session/staging/pixels
//        and StartCapture until the first N command; monitor/D3D device/item are prepared upfront.
//        Older helpers reject this unknown fifth flag before any capture starts.
// args: --monitor-info x y width height  read-only monitor rectangle query; exits before WGC/D3D/pixels
// args: --workarea-info x y width height  read-only work-area rectangle query for the same monitor; no pixels
// args: --fit-selection-window HWND ownerPID nonce x y width height  fit our own hidden window to a monitor; no pixels
// args: --fit-hidden-window HWND ownerPID nonce x y width height  fit our own hidden sub-rect (bar) inside one monitor
// args: --fit-desktop-window HWND ownerPID nonce x y width height  fit our own hidden window to the whole desktop union
// args: --check-desktop-window HWND ownerPID nonce x y width height  read-only: that hidden window still equals the union
// stdin: N=request ROI snapshot, Q/EOF=exit. stdout: JGC2 + uint32 width,height,sequence,flags.
// flags=1: one fresh WGC frame followed by RGBA; flags=0: no new frame, header only.
using System;
using System.Collections.Generic;
using System.IO;
using System.Diagnostics;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading;
using System.Windows.Automation;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;

// Screen rectangle shared by the capture path and the window-region helpers.
// Kept at namespace level so the pure geometry helpers never depend on the capture class.
[StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
[StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }

class WgcCapture {
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct OutputDesc {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string Name;
        public Rect Desktop; public int Attached; public uint Rotation; public IntPtr Monitor;
    }
    [StructLayout(LayoutKind.Sequential)] struct TextureDesc {
        public uint Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CPUAccessFlags, MiscFlags;
    }
    [StructLayout(LayoutKind.Sequential)] struct Box { public uint Left, Top, Front, Right, Bottom, Back; }
    [StructLayout(LayoutKind.Sequential)] struct Mapped { public IntPtr Data; public uint RowPitch, DepthPitch; }
    [ComImport, Guid("3628e81b-3cac-4c60-b7f4-23ce0e0c3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface CaptureInterop {
        void CreateForWindow(IntPtr window, ref Guid iid, out IntPtr item);
        void CreateForMonitor(IntPtr monitor, ref Guid iid, out IntPtr item);
    }
    [ComImport, Guid("a9b3d012-3df2-4ee3-b8d1-8695f457d3c1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface SurfaceInterop { void GetInterface(ref Guid iid, out IntPtr result); }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumAt(IntPtr self, uint index, out IntPtr item);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetOutputDesc(IntPtr self, out OutputDesc desc);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateTexture(IntPtr self, ref TextureDesc desc, IntPtr data, out IntPtr texture);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void CopyRegion(IntPtr self, IntPtr target, uint targetSubresource, uint x, uint y, uint z, IntPtr source, uint sourceSubresource, ref Box box);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int MapTexture(IntPtr self, IntPtr texture, uint subresource, uint type, uint flags, out Mapped mapped);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void UnmapTexture(IntPtr self, IntPtr texture, uint subresource);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int DeviceStatus(IntPtr self);
    delegate bool MonitorEnum(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder value, uint length, out uint needed);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromRect(ref Rect rect, uint flags);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnum callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern IntPtr GetTopWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumChildProc callback, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    delegate bool EnumChildProc(IntPtr child, IntPtr data);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    [DllImport("dwmapi.dll", EntryPoint="DwmGetWindowAttribute")] static extern int DwmRect(IntPtr window, int attribute, out Rect rect, int size);
    [DllImport("dwmapi.dll", EntryPoint="DwmGetWindowAttribute")] static extern int DwmInt(IntPtr window, int attribute, out int value, int size);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int maxCount);
    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid iid, out IntPtr factory);
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, uint driverType, IntPtr software, uint flags, IntPtr featureLevels, uint count, uint sdkVersion, out IntPtr device, out uint featureLevel, out IntPtr context);
    [DllImport("d3d11.dll")] static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr device, out IntPtr result);
    static T Method<T>(IntPtr instance, int slot) where T : class {
        return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(instance), slot * IntPtr.Size), typeof(T));
    }
    static string DesktopName(IntPtr desktop) {
        var name=new StringBuilder(256); uint needed;
        if (desktop==IntPtr.Zero || !GetUserObjectInformation(desktop,2,name,512,out needed)) throw new Exception("input-desktop-unavailable");
        return name.ToString();
    }
    static void CheckInputDesktop(string expected) {
        IntPtr desktop=OpenInputDesktop(0,false,1);
        try { if (!String.Equals(DesktopName(desktop),expected,StringComparison.Ordinal)) throw new Exception("input-desktop-changed"); }
        finally { if (desktop!=IntPtr.Zero) CloseDesktop(desktop); }
    }
    static bool Same(Rect a, Rect b) { return a.Left==b.Left && a.Top==b.Top && a.Right==b.Right && a.Bottom==b.Bottom; }
    // Session flags shared by the eager and lazy setup paths; cursor/border behaviour must stay identical.
    static void ConfigureSession(GraphicsCaptureSession session, bool recording) {
#if INCLUDE_CURSOR_TEST
        // Separate test executable only: proves that the same capture source can see the real pointer.
        session.IsCursorCaptureEnabled=true;
        if (!session.IsCursorCaptureEnabled) throw new Exception("test-cursor-unavailable");
#else
        session.IsCursorCaptureEnabled=recording;
        if (session.IsCursorCaptureEnabled!=recording) throw new Exception(recording ? "cursor-inclusion-unavailable" : "cursor-exclusion-unavailable");
#endif
        // No permission prompts or global OS changes. A system capture border may remain if borderless access is unavailable.
        try { session.IsBorderRequired=false; } catch (Exception) { }
    }
    static void Release(ref IntPtr value) { if (value != IntPtr.Zero) { Marshal.Release(value); value=IntPtr.Zero; } }
    static IntPtr AdapterFor(IntPtr monitor) {
        IntPtr factory=IntPtr.Zero, adapter=IntPtr.Zero, output=IntPtr.Zero;
        try {
            var iid=new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
            Marshal.ThrowExceptionForHR(CreateDXGIFactory1(ref iid, out factory));
            var adapters=Method<EnumAt>(factory, 12); // IDXGIFactory1::EnumAdapters1
            for (uint a=0; a<32; a++) {
                int hr=adapters(factory, a, out adapter);
                if (hr==unchecked((int)0x887A0002)) break;
                Marshal.ThrowExceptionForHR(hr);
                var outputs=Method<EnumAt>(adapter, 7); // IDXGIAdapter::EnumOutputs
                for (uint o=0; o<64; o++) {
                    hr=outputs(adapter, o, out output);
                    if (hr==unchecked((int)0x887A0002)) break;
                    Marshal.ThrowExceptionForHR(hr);
                    OutputDesc desc; Marshal.ThrowExceptionForHR(Method<GetOutputDesc>(output, 7)(output, out desc));
                    Release(ref output);
                    if (desc.Monitor==monitor) { IntPtr found=adapter; adapter=IntPtr.Zero; return found; }
                }
                Release(ref adapter);
            }
            throw new Exception("monitor-adapter-not-found");
        } finally { Release(ref output); Release(ref adapter); Release(ref factory); }
    }
    // Union of every real monitor rectangle. Monitors are enumerated under PMv2 so the values are physical
    // pixels, and a layout with a hole keeps that hole inside the union (the hole is the canvas, not a monitor).
    static Rect DesktopUnion() {
        var monitors=new List<Rect>();
        bool enumerated=EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,delegate(IntPtr monitor,IntPtr hdc,IntPtr rect,IntPtr data) {
            var info=new MonitorInfo {Size=Marshal.SizeOf(typeof(MonitorInfo))};
            if (!GetMonitorInfo(monitor,ref info)) return false;
            monitors.Add(info.Monitor); return true;
        },IntPtr.Zero);
        if (!enumerated || monitors.Count==0) throw new Exception("monitor-enumeration-failed");
        int left=Int32.MaxValue, top=Int32.MaxValue, right=Int32.MinValue, bottom=Int32.MinValue;
        foreach (var monitor in monitors) {
            if (monitor.Left<left) left=monitor.Left;
            if (monitor.Top<top) top=monitor.Top;
            if (monitor.Right>right) right=monitor.Right;
            if (monitor.Bottom>bottom) bottom=monitor.Bottom;
        }
        if (right<=left || bottom<=top) throw new Exception("desktop-union-empty");
        return new Rect {Left=left,Top=top,Right=right,Bottom=bottom};
    }
    // Metadata only: the hint rectangle picks the monitor, nothing is captured or allocated.
    static void WriteMonitorInfo(Stream output, Rect monitor) {
        byte[] json=Encoding.UTF8.GetBytes("{\"x\":"+monitor.Left+",\"y\":"+monitor.Top+",\"width\":"+(monitor.Right-monitor.Left)+",\"height\":"+(monitor.Bottom-monitor.Top)+"}");
        output.Write(json,0,json.Length); output.Flush();
    }
    static void Write(Stream output, int width, int height, uint sequence, bool fresh, byte[] bytes) {
        byte[] header=new byte[20]; header[0]=74; header[1]=71; header[2]=67; header[3]=50;
        Buffer.BlockCopy(BitConverter.GetBytes(width),0,header,4,4); Buffer.BlockCopy(BitConverter.GetBytes(height),0,header,8,4);
        Buffer.BlockCopy(BitConverter.GetBytes(sequence),0,header,12,4); Buffer.BlockCopy(BitConverter.GetBytes(fresh ? 1U : 0U),0,header,16,4);
        output.Write(header,0,20); if (fresh) output.Write(bytes,0,bytes.Length); output.Flush();
    }
    static bool ValidWindowRect(Rect r) {
        return Math.Abs((long)r.Left)<=1000000 && Math.Abs((long)r.Top)<=1000000 &&
            (long)r.Right-r.Left>0 && (long)r.Bottom-r.Top>0 && (long)r.Right-r.Left<=4000000 && (long)r.Bottom-r.Top<=4000000;
    }
    static void WriteWindowRegions(Stream output, uint ownPid) {
        var collection=CollectWindowRegions(ownPid,null,false);
        WindowRegionGeometry.ApplyGlobalCap(collection.Rows);
        string json=WindowRegionGeometry.SerializeSnapshot(collection.Rows);
        byte[] bytes=Encoding.UTF8.GetBytes(json);
        output.Write(bytes,0,bytes.Length); output.Flush();
    }
    // One base pass preserves top-level Z order and child-HWND fallback. UIA is only run by the
    // opt-in counter report; production detail is a separate, later MSAA query by opaque root keys.
    class WindowRegionCollection {
        public List<WindowRegionGeometry.Row> Rows=new List<WindowRegionGeometry.Row>();
        public List<IntPtr> Handles=new List<IntPtr>();
        public List<int> ChildValid=new List<int>();
        public List<KeyValuePair<int, IRegionSource>> Sources=new List<KeyValuePair<int, IRegionSource>>();
        public long ElapsedMs;
    }
    static WindowRegionCollection CollectWindowRegions(uint ownPid, List<int> probeOrdinals, bool includeUia) {
        var startedAt=DateTime.UtcNow;
        var collection=new WindowRegionCollection();
        if (SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero) throw new Exception("dpi-context-failed");
        // Capture the foreground identity before the selection window can be shown. An own/hidden
        // foreground row is blocked and therefore never becomes a detail target.
        IntPtr foreground=GetForegroundWindow();
        IntPtr foregroundRoot=foreground==IntPtr.Zero?IntPtr.Zero:GetAncestor(foreground,2);
        var seen=new HashSet<IntPtr>();
        // Explicit top-to-bottom Z order, bounded even if windows disappear or handles are recycled.
        IntPtr window=GetTopWindow(IntPtr.Zero);
        for (int visited=0; window!=IntPtr.Zero && visited<4096 && collection.Rows.Count<WindowRegionGeometry.MaxRows; visited++) {
            if (!seen.Add(window)) break;
            IntPtr next=GetWindow(window,2);
            uint pid, threadId; int cloaked; Rect bounds;
            var name=new StringBuilder(256);
            if (IsWindow(window) && IsWindowVisible(window) && !IsIconic(window) &&
                (threadId=GetWindowThreadProcessId(window,out pid))!=0 &&
                DwmInt(window,14,out cloaked,4)==0 && cloaked==0 && GetClassName(window,name,name.Capacity)>0 &&
                name.ToString()!="Progman" && name.ToString()!="WorkerW") {
                if (DwmRect(window,9,out bounds,Marshal.SizeOf(typeof(Rect)))!=0) {
                    if (!GetWindowRect(window,out bounds)) { window=next; continue; }
                }
                if (ValidWindowRect(bounds)) {
                    var row=new WindowRegionGeometry.Row(); row.Bounds=bounds;
                    if (pid==ownPid) {
                        // Our own top-level windows keep their Z position (they occlude what is behind them)
                        // but are never selectable, so no client rectangle and no element regions are queried.
                        row.Blocked=true;
                    } else {
                        Rect client;
                        if (GetClientRect(window,out client)) {
                            var a=new Point {X=client.Left,Y=client.Top}; var b=new Point {X=client.Right,Y=client.Bottom};
                            if (ClientToScreen(window,ref a) && ClientToScreen(window,ref b)) {
                                var c=new Rect {Left=Math.Max(bounds.Left,a.X),Top=Math.Max(bounds.Top,a.Y),Right=Math.Min(bounds.Right,b.X),Bottom=Math.Min(bounds.Bottom,b.Y)};
                                if (ValidWindowRect(c)) { row.HasClient=true; row.Client=c; }
                            }
                        }
                        row.NativeKey=WindowRegionGeometry.MakeNativeKey(pid,threadId,window);
                    }
                    collection.Rows.Add(row); collection.Handles.Add(window);
                    collection.ChildValid.Add(0);
                }
            }
            window=next;
        }
        // Visible child HWND rectangles, bounded by a global visit and region budget.
        var scan=new ChildScan();
        for (int i=0;i<collection.Rows.Count && scan.Visits<ChildScan.MaxVisits && scan.Collected<ChildScan.MaxRegions;i++) {
            if (collection.Rows[i].Blocked) continue;
            var container=collection.Rows[i].HasClient?collection.Rows[i].Client:collection.Rows[i].Bounds;
            var raw=new List<Rect>();
            int before=scan.Collected;
            CollectChildRegions(collection.Handles[i],container,scan,raw);
            collection.ChildValid[i]=scan.Collected-before;
            var normalized=new List<Rect>();
            foreach (var rect in raw) { Rect ok; if (WindowRegionGeometry.TryNormalize(rect,container,out ok)) normalized.Add(ok); }
            WindowRegionGeometry.Merge(normalized,container,collection.Rows[i].Regions);
        }
        // Select at most two unblocked, client-bearing roots. Foreground wins, then client area;
        // the flag is private metadata for the later MSAA process and does not change the row order.
        int foregroundIndex=-1;
        if (foregroundRoot!=IntPtr.Zero) {
            for (int i=0;i<collection.Rows.Count;i++) if (collection.Handles[i]==foregroundRoot) { foregroundIndex=i; break; }
        }
        foreach (var index in WindowRegionPublisher.SelectProbeRoots(collection.Rows,foregroundIndex,probeOrdinals)) {
            if (index<0 || index>=collection.Rows.Count || collection.Handles[index]==IntPtr.Zero) continue;
            collection.Rows[index].DetailRoot=true;
            if (includeUia) {
                try { collection.Sources.Add(new KeyValuePair<int, IRegionSource>(index,UiaRegionProbe.Create(collection.Handles[index]))); }
                catch { /* the explicit diagnostic report records a missing probe */ }
            }
        }
        collection.ElapsedMs=(long)(DateTime.UtcNow-startedAt).TotalMilliseconds;
        return collection;
    }
    // Diagnostic report: counters, stages and error identity only. No coordinate, handle, pid,
    // title, class name, text or pixel ever reaches this output.
    static void WriteWindowRegionsReport(Stream output, uint ownPid, List<int> probeOrdinals) {
        var startedAt=DateTime.UtcNow;
        var collection=CollectWindowRegions(ownPid,probeOrdinals,true);
        WindowRegionPublisher.Publish(collection.Rows,collection.Sources,WindowRegionPublisher.BudgetMs);
        var roots=new List<WindowRegionRootView>();
        for (int i=0;i<collection.Rows.Count;i++) {
            var view=new WindowRegionRootView {Ordinal=i,Blocked=collection.Rows[i].Blocked,HasClient=collection.Rows[i].HasClient,
                ChildValid=collection.ChildValid[i],Uia=new RegionStatsView {Stage="not-probed"}};
            foreach (var pair in collection.Sources) if (pair.Key==i) view.Uia=pair.Value.Stats.View();
            roots.Add(view);
        }
        string json=WindowRegionReport.Build(roots,collection.Sources.Count,collection.ElapsedMs,
            (long)(DateTime.UtcNow-startedAt).TotalMilliseconds);
        byte[] bytes=Encoding.UTF8.GetBytes(json);
        output.Write(bytes,0,bytes.Length); output.Flush();
    }
    // Bounded child HWND scan: one global visit budget and one global valid-region budget.
    class ChildScan {
        public const int MaxVisits=1024;
        public const int MaxRegions=128;
        public int Visits;
        public int Collected;
    }
    static void CollectChildRegions(IntPtr parent, Rect container, ChildScan scan, List<Rect> output) {
        EnumChildProc callback = delegate(IntPtr child, IntPtr data) {
            var state = (ChildScan)GCHandle.FromIntPtr(data).Target;
            state.Visits++;
            if (state.Visits>ChildScan.MaxVisits || state.Collected>=ChildScan.MaxRegions) return false;
            Rect rect;
            if (IsWindow(child) && IsWindowVisible(child) && !IsIconic(child) && GetWindowRect(child,out rect) && ValidWindowRect(rect)) {
                state.Collected++; output.Add(rect);
            }
            return true;
        };
        var handle = GCHandle.Alloc(scan);
        try { EnumChildWindows(parent, callback, GCHandle.ToIntPtr(handle)); }
        catch { /* a failed child scan only costs regions */ }
        finally { handle.Free(); GC.KeepAlive(callback); }
    }
    // Count-only diagnostic on the production path: the same base collection and the same MSAA
    // probe as the live query, but only stage/status tokens and counters are printed.
    // With explicit target arguments it probes exactly those roots; without them it selects the
    // roots with the production rule and probes those.
    public static void WriteMsaaReport(Stream output,uint ownPid,string[] args) {
        if (args.Length==2) {
            var collection=CollectWindowRegions(ownPid,null,false);
            // The same roots the live snapshot marked as detail roots: no second selection rule.
            var targets=new List<MsaaWindowRegionQuery.Target>();
            foreach (var row in collection.Rows) {
                if (!row.DetailRoot || String.IsNullOrEmpty(row.NativeKey)) continue;
                MsaaWindowRegionQuery.Target target;
                if (!MsaaWindowRegionQuery.TryBuildTarget(row.NativeKey,row.Bounds,row.HasClient?row.Client:row.Bounds,out target)) continue;
                targets.Add(target);
            }
            MsaaWindowRegionQuery.WriteReport(output,targets,collection.Rows.Count,targets.Count);
            return;
        }
        var parsed=MsaaWindowRegionQuery.ParseTargets(ownPid,args,"--window-regions-msaa-report",MsaaWindowRegionQuery.ReportMaxRoots);
        MsaaWindowRegionQuery.WriteReport(output,parsed,0,parsed.Count);
    }
    // Experimental only (not wired into the live query): probe one base row with the geometry-only
    // UIA path under a fixed budget and report counts only.
    public static void WriteUiaPanelProbe(Stream output,uint ownPid,string[] args) {
        if (args==null || args.Length<3 || args.Length>4) throw new Exception("invalid-arguments");
        int ordinal,budgetMs=2000;
        if (!int.TryParse(args[2],System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out ordinal) || ordinal<0) throw new Exception("invalid-arguments");
        if (args.Length==4 && (!int.TryParse(args[3],System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out budgetMs) || budgetMs<100 || budgetMs>20000)) throw new Exception("invalid-arguments");
        var collection=CollectWindowRegions(ownPid,null,false);
        if (ordinal>=collection.Rows.Count) throw new Exception("invalid-arguments");
        var row=collection.Rows[ordinal];
        if (row.Blocked || collection.Handles[ordinal]==IntPtr.Zero) throw new Exception("invalid-arguments");
        long elapsed;
        string json=UiaPanelProbe.Build(collection.Handles[ordinal],row.HasClient?row.Client:row.Bounds,budgetMs,out elapsed);
        byte[] bytes=Encoding.UTF8.GetBytes(json);
        output.Write(bytes,0,bytes.Length); output.Flush();
    }
    [MTAThread] static int Main(string[] args) {
        IntPtr adapter=IntPtr.Zero, device=IntPtr.Zero, context=IntPtr.Zero, dxgi=IntPtr.Zero, inspectable=IntPtr.Zero, itemPtr=IntPtr.Zero, staging=IntPtr.Zero;
        Direct3D11CaptureFramePool pool=null; GraphicsCaptureSession session=null; IDirect3DDevice projectedDevice=null;
        AutoResetEvent arrived=new AutoResetEvent(false);
        try {
            var input=Console.OpenStandardInput(); var output=Console.OpenStandardOutput();
            if (args.Length==1 && args[0]=="--self-test") { Write(output,2,2,1,true,new byte[] {1,2,3,255,4,5,6,255,7,8,9,255,10,11,12,255}); return 0; }
            if (args.Length==1 && args[0]=="--window-regions-self-test") {
                // Same limited exit as the live metadata query: the in-memory self-test leaves a
                // deliberately stuck background thread behind, and the process must not wait for it.
                int selfTestCode=WindowRegionSelfTest.Run(output);
                Environment.Exit(selfTestCode);
            }
            if (args.Length>0 && args[0]=="--window-regions-report") {
                uint ownPid;
                if (args.Length<2 || !uint.TryParse(args[1],System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out ownPid) || ownPid==0) throw new Exception("invalid-arguments");
                var ordinals=new List<int>();
                for (int i=2;i<args.Length;i++) {
                    int ordinal;
                    if (!int.TryParse(args[i],out ordinal) || ordinal<0) throw new Exception("invalid-arguments");
                    ordinals.Add(ordinal);
                }
                WriteWindowRegionsReport(output,ownPid,ordinals);
                Environment.Exit(0);
                return 0;
            }
            if (args.Length>0 && args[0]=="--window-regions-uia-probe") {
                uint ownPid;
                if (args.Length<3 || !uint.TryParse(args[1],System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out ownPid) || ownPid==0) throw new Exception("invalid-arguments");
                WriteUiaPanelProbe(output,ownPid,args);
                Environment.Exit(0);
                return 0;
            }
            if (args.Length>0 && args[0]=="--window-regions-msaa-report") {
                uint ownPid;
                if (args.Length<2 || !uint.TryParse(args[1],System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out ownPid) || ownPid==0) throw new Exception("invalid-arguments");
                WriteMsaaReport(output,ownPid,args);
                // The report is flushed before the exit: a provider may still hold a background STA.
                Environment.Exit(0);
                return 0;
            }
            if (args.Length>0 && args[0]=="--window-regions-msaa") {
                uint ownPid;
                if (args.Length<2 || !uint.TryParse(args[1],System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out ownPid) || ownPid==0) throw new Exception("invalid-arguments");
                MsaaWindowRegionQuery.Write(output,ownPid,args);
                // A provider may be stuck on a background STA; after the bounded payload is flushed,
                // exit rather than waiting for that COM call to return.
                Environment.Exit(0);
                return 0;
            }
            if (args.Length>0 && args[0]=="--window-regions") {
                uint ownPid;
                if (args.Length!=2 || !uint.TryParse(args[1],System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out ownPid) || ownPid==0) throw new Exception("invalid-arguments");
                WriteWindowRegions(output,ownPid);
                // Fast metadata-only branch: no accessibility provider work can delay this payload.
                Environment.Exit(0);
                return 0;
            }
            // Read-only monitor rectangle query: must stay before GraphicsCaptureSession/D3D/pixel buffers.
            // The hint only selects the monitor (MonitorFromRect) and is never used as a capture region.
            if (args.Length==5 && (args[0]=="--monitor-info" || args[0]=="--workarea-info")) {
                bool wantWork=args[0]=="--workarea-info";
                int hintX, hintY, hintWidth, hintHeight;
                if (!int.TryParse(args[1],out hintX) || !int.TryParse(args[2],out hintY) || !int.TryParse(args[3],out hintWidth) || !int.TryParse(args[4],out hintHeight)) throw new Exception("invalid-arguments");
                if (Math.Abs((long)hintX)>1000000L || Math.Abs((long)hintY)>1000000L || hintWidth<1 || hintHeight<1 ||
                    hintWidth>4000000 || hintHeight>4000000 || (long)hintWidth*hintHeight>10000000000000L) throw new Exception("invalid-region");
                if (SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero) throw new Exception("dpi-context-failed");
                var hint=new Rect {Left=hintX,Top=hintY,Right=hintX+hintWidth,Bottom=hintY+hintHeight};
                IntPtr hintMonitor=MonitorFromRect(ref hint,0);
                var hintInfo=new MonitorInfo {Size=Marshal.SizeOf(typeof(MonitorInfo))};
                if (hintMonitor==IntPtr.Zero || !GetMonitorInfo(hintMonitor,ref hintInfo)) throw new Exception("monitor-not-found");
                // Work is reported by the same monitor record; never moved or adjusted here.
                WriteMonitorInfo(output,wantWork ? hintInfo.Work : hintInfo.Monitor);
                return 0;
            }
            // Fit our own nonce-identified windows to physical monitor geometry. Hidden fits remain
            // hidden-only; the separate mask recovery requires a visible window. All modes check
            // PID, nonce and monitor before any move; no activation, z-order change or capture.
            if (args.Length==8 && (args[0]=="--fit-selection-window" || args[0]=="--fit-hidden-window" || args[0]=="--check-selection-window" || args[0]=="--fit-visible-mask-window")) {
                // Visible recovery is a separate, monitor-only mode; the original fit remains hidden-only.
                bool checkOnly=args[0]=="--check-selection-window";
                bool visibleMask=args[0]=="--fit-visible-mask-window";
                bool exactMonitor=args[0]=="--fit-selection-window" || checkOnly || visibleMask;
                ulong rawHandle; uint ownerPid;
                int fitX, fitY, fitWidth, fitHeight;
                if (!ulong.TryParse(args[1],out rawHandle) || rawHandle==0) throw new Exception("invalid-window");
                if (!uint.TryParse(args[2],out ownerPid) || ownerPid==0) throw new Exception("invalid-owner");
                string nonce=args[3];
                if (nonce.Length!=32) throw new Exception("invalid-nonce");
                for (int i=0;i<nonce.Length;i++) if (!((nonce[i]>='0'&&nonce[i]<='9')||(nonce[i]>='a'&&nonce[i]<='f'))) throw new Exception("invalid-nonce");
                if (!int.TryParse(args[4],out fitX) || !int.TryParse(args[5],out fitY) || !int.TryParse(args[6],out fitWidth) || !int.TryParse(args[7],out fitHeight)) throw new Exception("invalid-arguments");
                if (Math.Abs((long)fitX)>1000000L || Math.Abs((long)fitY)>1000000L || fitWidth<1 || fitHeight<1 ||
                    fitWidth>4000000 || fitHeight>4000000 || (long)fitWidth*fitHeight>36000000L) throw new Exception("invalid-region");
                if (SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero) throw new Exception("dpi-context-failed");
                IntPtr window=unchecked((IntPtr)(long)rawHandle);
                if (!IsWindow(window)) throw new Exception("window-not-found");
                uint windowPid; GetWindowThreadProcessId(window,out windowPid);
                if (windowPid!=ownerPid) throw new Exception("owner-mismatch");
                if (visibleMask && !IsWindowVisible(window)) throw new Exception("window-not-visible");
                if (!checkOnly && !visibleMask && IsWindowVisible(window)) throw new Exception("window-visible");
                // A recycled HWND of the same process must not be resized: the title must carry our one-shot nonce.
                var title=new StringBuilder(64); int titleLength=GetWindowText(window,title,64);
                if (titleLength!=nonce.Length || !String.Equals(title.ToString(),nonce,StringComparison.Ordinal)) throw new Exception("window-identity-mismatch");
                var target=new Rect {Left=fitX,Top=fitY,Right=fitX+fitWidth,Bottom=fitY+fitHeight};
                IntPtr windowMonitor=MonitorFromWindow(window,0);
                var windowInfo=new MonitorInfo {Size=Marshal.SizeOf(typeof(MonitorInfo))};
                if (windowMonitor==IntPtr.Zero || !GetMonitorInfo(windowMonitor,ref windowInfo)) throw new Exception("monitor-mismatch");
                // Selection/mask must cover the monitor exactly; a bar sub-rect must stay fully inside it.
                if (exactMonitor) {
                    if (!Same(windowInfo.Monitor,target)) throw new Exception("monitor-mismatch");
                } else if (fitX<windowInfo.Monitor.Left || fitY<windowInfo.Monitor.Top ||
                           fitX+fitWidth>windowInfo.Monitor.Right || fitY+fitHeight>windowInfo.Monitor.Bottom) throw new Exception("region-outside-monitor");
                // SWP_NOSENDCHANGING must stay: a non-resizable Electron window clamps WM_WINDOWPOSCHANGING
                // and silently keeps its old size, so a plain SetWindowPos reports success but changes nothing.
                if (!checkOnly && !SetWindowPos(window,IntPtr.Zero,fitX,fitY,fitWidth,fitHeight,0x0010|0x0004|0x0200|0x0400)) throw new Exception("window-move-failed");
                Rect actual; if (!GetWindowRect(window,out actual) || !Same(actual,target)) throw new Exception("window-rect-mismatch");
                if (checkOnly || visibleMask) {
                    // The page's viewport is mapped over the client, not the outer frame.
                    Rect client; if (!GetClientRect(window,out client)) throw new Exception("client-rect-unavailable");
                    var a=new Point {X=client.Left,Y=client.Top}; var b=new Point {X=client.Right,Y=client.Bottom};
                    if (!ClientToScreen(window,ref a) || !ClientToScreen(window,ref b) ||
                        !Same(new Rect {Left=a.X,Top=a.Y,Right=b.X,Bottom=b.Y},target)) throw new Exception("client-rect-mismatch");
                }
                WriteMonitorInfo(output,actual);
                return 0;
            }
            // Cross-monitor single window: one hidden window covering every monitor. The target must be the
            // whole desktop union computed from the real monitor rectangles under PMv2 — never an arbitrary
            // enclosing rectangle and never a tolerance. --check-desktop-window only reads the window back,
            // so a Chromium-side resize after load is detectable instead of being silently re-applied.
            if (args.Length==8 && (args[0]=="--fit-desktop-window" || args[0]=="--check-desktop-window")) {
                bool move=args[0]=="--fit-desktop-window";
                ulong rawHandle; uint ownerPid;
                int fitX, fitY, fitWidth, fitHeight;
                if (!ulong.TryParse(args[1],out rawHandle) || rawHandle==0) throw new Exception("invalid-window");
                if (!uint.TryParse(args[2],out ownerPid) || ownerPid==0) throw new Exception("invalid-owner");
                string nonce=args[3];
                if (nonce.Length!=32) throw new Exception("invalid-nonce");
                for (int i=0;i<nonce.Length;i++) if (!((nonce[i]>='0'&&nonce[i]<='9')||(nonce[i]>='a'&&nonce[i]<='f'))) throw new Exception("invalid-nonce");
                if (!int.TryParse(args[4],out fitX) || !int.TryParse(args[5],out fitY) || !int.TryParse(args[6],out fitWidth) || !int.TryParse(args[7],out fitHeight)) throw new Exception("invalid-arguments");
                if (Math.Abs((long)fitX)>1000000L || Math.Abs((long)fitY)>1000000L || fitWidth<1 || fitHeight<1 ||
                    fitWidth>1000000 || fitHeight>1000000 || (long)fitWidth*fitHeight>36000000L) throw new Exception("invalid-region");
                if (SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero) throw new Exception("dpi-context-failed");
                IntPtr window=unchecked((IntPtr)(long)rawHandle);
                if (!IsWindow(window)) throw new Exception("window-not-found");
                uint windowPid; GetWindowThreadProcessId(window,out windowPid);
                if (windowPid!=ownerPid) throw new Exception("owner-mismatch");
                if (IsWindowVisible(window)) throw new Exception("window-visible");
                var title=new StringBuilder(64); int titleLength=GetWindowText(window,title,64);
                if (titleLength!=nonce.Length || !String.Equals(title.ToString(),nonce,StringComparison.Ordinal)) throw new Exception("window-identity-mismatch");
                var target=new Rect {Left=fitX,Top=fitY,Right=fitX+fitWidth,Bottom=fitY+fitHeight};
                if (!Same(DesktopUnion(),target)) throw new Exception("target-not-desktop-union");
                if (move && !SetWindowPos(window,IntPtr.Zero,fitX,fitY,fitWidth,fitHeight,0x0010|0x0004|0x0200|0x0400)) throw new Exception("window-move-failed");
                Rect actual; if (!GetWindowRect(window,out actual) || !Same(actual,target)) throw new Exception("window-rect-mismatch");
                WriteMonitorInfo(output,actual);
                return 0;
            }
            // Explicit purposes only; recording includes the pointer but has the smaller 4M frame budget.
            bool lazy=args.Length==5 && args[4]=="--snapshot-lazy";
            bool snapshot=args.Length==5 && (args[4]=="--snapshot" || lazy);
            bool recording=args.Length==5 && args[4]=="--record";
            if (args.Length!=4 && !snapshot && !recording) throw new Exception("invalid-arguments");
            int x, y, width, height;
            if (!int.TryParse(args[0],out x) || !int.TryParse(args[1],out y) || !int.TryParse(args[2],out width) || !int.TryParse(args[3],out height)) throw new Exception("invalid-arguments");
            long limit=recording ? 4000000L : snapshot ? 36000000L : 16000000L;
            if (Math.Abs((long)x)>1000000 || Math.Abs((long)y)>1000000 || width<1 || height<1 || (long)width*height>limit ||
                (recording && (width>4096 || height>4096))) throw new Exception("invalid-region");
            if (SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero) throw new Exception("dpi-context-failed");
            if (!GraphicsCaptureSession.IsSupported()) throw new Exception("wgc-not-supported");
            var roi=new Rect {Left=x,Top=y,Right=x+width,Bottom=y+height};
            IntPtr monitor=MonitorFromRect(ref roi,0);
            var initial=new MonitorInfo {Size=Marshal.SizeOf(typeof(MonitorInfo))};
            if (monitor==IntPtr.Zero || !GetMonitorInfo(monitor,ref initial) || x<initial.Monitor.Left || y<initial.Monitor.Top || x+width>initial.Monitor.Right || y+height>initial.Monitor.Bottom) throw new Exception("region-outside-monitor");
            adapter=AdapterFor(monitor); uint featureLevel;
            Marshal.ThrowExceptionForHR(D3D11CreateDevice(adapter,0,IntPtr.Zero,0x20,IntPtr.Zero,0,7,out device,out featureLevel,out context));
            var dxgiIid=new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
            Marshal.ThrowExceptionForHR(Marshal.QueryInterface(device,ref dxgiIid,out dxgi));
            Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi,out inspectable));
            projectedDevice=(IDirect3DDevice)Marshal.GetObjectForIUnknown(inspectable);
            var factory=(CaptureInterop)WindowsRuntimeMarshal.GetActivationFactory(typeof(GraphicsCaptureItem));
            var itemIid=new Guid("79c3f95b-31f7-4ec2-a464-632ef5d30760");
            factory.CreateForMonitor(monitor,ref itemIid,out itemPtr);
            var item=(GraphicsCaptureItem)Marshal.GetObjectForIUnknown(itemPtr);
            int frameWidth=initial.Monitor.Right-initial.Monitor.Left, frameHeight=initial.Monitor.Bottom-initial.Monitor.Top;
            if (item.Size.Width!=frameWidth || item.Size.Height!=frameHeight) throw new Exception("capture-size-mismatch");
            // Hoisted so the lazy path can fill them on the first N instead of at spawn time.
            int captureClosed=0;
            item.Closed+=(sender,eventArgs)=>Interlocked.Exchange(ref captureClosed,1);
            bool captureStarted=false;
            CopyRegion copy=null; MapTexture map=null; UnmapTexture unmap=null;
            Box box=default(Box);
            Guid textureIid=new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");
            byte[] rgba=null; bool haveFrame=false; uint sequence=0;
            string desktopName=DesktopName(GetThreadDesktop(GetCurrentThreadId()));
            DeviceStatus deviceStatus=null;
            if (!lazy) {
                pool=Direct3D11CaptureFramePool.CreateFreeThreaded(projectedDevice,DirectXPixelFormat.B8G8R8A8UIntNormalized,2,item.Size);
                pool.FrameArrived+=(sender,eventArgs)=> { try { arrived.Set(); } catch (ObjectDisposedException) { } };
                session=pool.CreateCaptureSession(item);
                ConfigureSession(session, recording);
                var desc=new TextureDesc {Width=(uint)width,Height=(uint)height,MipLevels=1,ArraySize=1,Format=87,SampleCount=1,Usage=3,CPUAccessFlags=0x20000};
                Marshal.ThrowExceptionForHR(Method<CreateTexture>(device,5)(device,ref desc,IntPtr.Zero,out staging));
                copy=Method<CopyRegion>(context,46); map=Method<MapTexture>(context,14); unmap=Method<UnmapTexture>(context,15);
                box=new Box {Left=(uint)(x-initial.Monitor.Left),Top=(uint)(y-initial.Monitor.Top),Right=(uint)(x-initial.Monitor.Left+width),Bottom=(uint)(y-initial.Monitor.Top+height),Back=1};
                rgba=new byte[checked(width*height*4)];
                deviceStatus=Method<DeviceStatus>(device,39);
                session.StartCapture();
                captureStarted=true;
            }
            int command;
            while ((command=input.ReadByte())>=0 && command!=81) {
                if (command!=78) throw new Exception("invalid-command");
                // Lazy snapshot: nothing above this point created a frame pool/session/staging buffer or started capture.
                if (!captureStarted) {
                    if (Interlocked.CompareExchange(ref captureClosed,0,0)!=0) throw new Exception("capture-item-closed");
                    pool=Direct3D11CaptureFramePool.CreateFreeThreaded(projectedDevice,DirectXPixelFormat.B8G8R8A8UIntNormalized,2,item.Size);
                    pool.FrameArrived+=(sender,eventArgs)=> { try { arrived.Set(); } catch (ObjectDisposedException) { } };
                    session=pool.CreateCaptureSession(item);
                    ConfigureSession(session, recording);
                    var lazyDesc=new TextureDesc {Width=(uint)width,Height=(uint)height,MipLevels=1,ArraySize=1,Format=87,SampleCount=1,Usage=3,CPUAccessFlags=0x20000};
                    Marshal.ThrowExceptionForHR(Method<CreateTexture>(device,5)(device,ref lazyDesc,IntPtr.Zero,out staging));
                    copy=Method<CopyRegion>(context,46); map=Method<MapTexture>(context,14); unmap=Method<UnmapTexture>(context,15);
                    box=new Box {Left=(uint)(x-initial.Monitor.Left),Top=(uint)(y-initial.Monitor.Top),Right=(uint)(x-initial.Monitor.Left+width),Bottom=(uint)(y-initial.Monitor.Top+height),Back=1};
                    rgba=new byte[checked(width*height*4)];
                    deviceStatus=Method<DeviceStatus>(device,39);
                    session.StartCapture();
                    captureStarted=true;
                }
                CheckInputDesktop(desktopName);
                if (Interlocked.CompareExchange(ref captureClosed,0,0)!=0) throw new Exception("capture-item-closed");
                Marshal.ThrowExceptionForHR(deviceStatus(device));
                var current=new MonitorInfo {Size=initial.Size};
                if (!GetMonitorInfo(monitor,ref current) || !Same(current.Monitor,initial.Monitor)) throw new Exception("monitor-changed");
                Direct3D11CaptureFrame frame=pool.TryGetNextFrame();
                if (!haveFrame) {
                    var deadline=Stopwatch.StartNew();
                    while (frame==null && deadline.ElapsedMilliseconds<8000) { arrived.WaitOne(100); frame=pool.TryGetNextFrame(); }
                    if (frame==null) throw new Exception("first-frame-timeout");
                }
                // Drain at most the bounded pool, retaining the newest available complete frame.
                for (int i=0;i<3;i++) { var next=pool.TryGetNextFrame(); if (next==null) break; if (frame!=null) frame.Dispose(); frame=next; }
                if (frame!=null) using (frame) {
                    if (frame.ContentSize.Width!=frameWidth || frame.ContentSize.Height!=frameHeight) throw new Exception("capture-size-changed");
                    IntPtr texture=IntPtr.Zero;
                    try {
                        ((SurfaceInterop)frame.Surface).GetInterface(ref textureIid,out texture);
                        copy(context,staging,0,0,0,0,texture,0,ref box);
                        Mapped mapped; Marshal.ThrowExceptionForHR(map(context,staging,0,1,0,out mapped));
                        try {
                            if (mapped.Data==IntPtr.Zero || mapped.RowPitch<(uint)width*4 || mapped.RowPitch>int.MaxValue) throw new Exception("invalid-row-pitch");
                            for (int row=0;row<height;row++) Marshal.Copy(IntPtr.Add(mapped.Data,checked(row*(int)mapped.RowPitch)),rgba,row*width*4,width*4);
                        } finally { unmap(context,staging,0); }
                        for (int i=0;i<rgba.Length;i+=4) { byte b=rgba[i]; rgba[i]=rgba[i+2]; rgba[i+2]=b; rgba[i+3]=255; }
                        Marshal.ThrowExceptionForHR(deviceStatus(device));
                        haveFrame=true; sequence=checked(sequence+1);
                    } finally { Release(ref texture); }
                }
                CheckInputDesktop(desktopName);
                // Unchanged/temporarily quiet WGC: explicitly report no frame, never send a cached image as a new capture.
                Write(output,width,height,sequence,frame!=null,rgba);
            }
            return 0;
        } catch (Exception error) { Console.Error.WriteLine("capture-helper:"+error.GetType().Name+":"+error.Message); return 1; }
        finally {
            if (session!=null) session.Dispose(); if (pool!=null) pool.Dispose();
            // Dispose the frame pool before releasing the D3D resources backing it.
            if (projectedDevice!=null) projectedDevice.Dispose();
            Release(ref staging); Release(ref itemPtr); Release(ref inspectable); Release(ref dxgi); Release(ref context); Release(ref device); Release(ref adapter);
            arrived.Dispose();
        }
    }
}

// Pure geometry/serialization helpers for the bounded base and detail queries. No window or
// desktop access happens here; the in-memory self-test shares this exact clipping and cap logic.
class WindowRegionGeometry {
    public const int MinSize = 8;
    public const int MaxRegionsPerRow = 128;
    public const int MaxRegionsTotal = 256;
    public const int MaxRows = 128;
    public const int MaxPayloadBytes = 65536;

    public class Row {
        public Rect Bounds;
        public bool HasClient;
        public Rect Client;
        public bool Blocked;
        public string NativeKey="";
        public bool DetailRoot;
        public List<Rect> Regions = new List<Rect>();
        public Rect Container { get { return HasClient ? Client : Bounds; } }
    }

    public static string RectJson(Rect r) {
        return "{\"x\":"+r.Left+",\"y\":"+r.Top+",\"width\":"+(r.Right-r.Left)+",\"height\":"+(r.Bottom-r.Top)+"}";
    }
    public static string MakeNativeKey(uint pid, uint tid, IntPtr hwnd) {
        return pid.ToString("x8",System.Globalization.CultureInfo.InvariantCulture)+":"+
            tid.ToString("x8",System.Globalization.CultureInfo.InvariantCulture)+":"+
            unchecked((ulong)hwnd.ToInt64()).ToString("x16",System.Globalization.CultureInfo.InvariantCulture);
    }
    // Clip into the container and drop anything smaller than the minimum element size.
    // All arithmetic is done in 64 bits: raw coordinates may be int.MinValue/int.MaxValue.
    public static bool TryNormalize(Rect raw, Rect container, out Rect result) {
        long left=Math.Max((long)raw.Left,(long)container.Left), top=Math.Max((long)raw.Top,(long)container.Top);
        long right=Math.Min((long)raw.Right,(long)container.Right), bottom=Math.Min((long)raw.Bottom,(long)container.Bottom);
        if (right-left<MinSize || bottom-top<MinSize) { result=raw; return false; }
        result=new Rect {Left=(int)left,Top=(int)top,Right=(int)right,Bottom=(int)bottom};
        return true;
    }
    // Drop duplicates and rectangles identical to their container; keep the first ones in order.
    public static void Merge(List<Rect> raw, Rect container, List<Rect> output) {
        foreach (var rect in raw) {
            if (output.Count>=MaxRegionsPerRow) break;
            if (rect.Left==container.Left && rect.Top==container.Top && rect.Right==container.Right && rect.Bottom==container.Bottom) continue;
            bool duplicate=false;
            foreach (var existing in output) {
                if (existing.Left==rect.Left && existing.Top==rect.Top && existing.Right==rect.Right && existing.Bottom==rect.Bottom) { duplicate=true; break; }
            }
            if (duplicate) continue;
            output.Add(rect);
        }
    }
    // Keep the total number of element rectangles within the global budget, highest rows first.
    public static void ApplyGlobalCap(List<Row> rows) {
        int total=0;
        for (int i=0;i<rows.Count;i++) {
            var regions=rows[i].Regions;
            int room=MaxRegionsTotal-total;
            if (room<=0) { regions.Clear(); continue; }
            if (regions.Count>room) regions.RemoveRange(room,regions.Count-room);
            total+=regions.Count;
        }
    }
    public static string RowJson(Row row, bool includeRegions) {
        string client=row.HasClient?RectJson(row.Client):"null";
        // Our own windows are never selectable and never carry element regions.
        if (row.Blocked) return "{\"blocked\":true,\"bounds\":"+RectJson(row.Bounds)+",\"client\":null}";
        if (!includeRegions || row.Regions.Count==0) return "{\"bounds\":"+RectJson(row.Bounds)+",\"client\":"+client+"}";
        var parts=new List<string>();
        foreach (var rect in row.Regions) parts.Add(RectJson(rect));
        return "{\"bounds\":"+RectJson(row.Bounds)+",\"client\":"+client+",\"regions\":["+String.Join(",",parts.ToArray())+"]}";
    }
    static string SnapshotRowJson(Row row, bool includeRegions) {
        string json=RowJson(row,includeRegions);
        if (row.Blocked || String.IsNullOrEmpty(row.NativeKey)) return json;
        int end=json.Length-1;
        return json.Substring(0,end)+",\"nativeKey\":\""+row.NativeKey+"\""+
            (row.DetailRoot?",\"detailRoot\":true":"")+"}";
    }
    static string BuildJson(List<Row> rows, bool includeRegions, bool includeIdentity) {
        var parts=new List<string>();
        for (int i=0;i<rows.Count && i<MaxRows;i++) parts.Add(includeIdentity?SnapshotRowJson(rows[i],includeRegions):RowJson(rows[i],includeRegions));
        return "["+String.Join(",",parts.ToArray())+"]";
    }
    // Regions are expendable: drop them before ever dropping a usable top-level geometry.
    static string SerializeCore(List<Row> rows, bool includeIdentity) {
        string json=BuildJson(rows,true,includeIdentity);
        if (Encoding.UTF8.GetByteCount(json)<=MaxPayloadBytes) return json;
        for (int i=rows.Count-1;i>=0;i--) {
            if (rows[i].Regions.Count==0) continue;
            rows[i].Regions.Clear();
            json=BuildJson(rows,true,includeIdentity);
            if (Encoding.UTF8.GetByteCount(json)<=MaxPayloadBytes) return json;
        }
        json=BuildJson(rows,false,includeIdentity);
        if (Encoding.UTF8.GetByteCount(json)<=MaxPayloadBytes) return json;
        while (rows.Count>1 && Encoding.UTF8.GetByteCount(BuildJson(rows,false,includeIdentity))>MaxPayloadBytes) rows.RemoveAt(rows.Count-1);
        return BuildJson(rows,false,includeIdentity);
    }
    public static string Serialize(List<Row> rows) { return SerializeCore(rows,false); }
    public static string SerializeSnapshot(List<Row> rows) { return SerializeCore(rows,true); }
}

// A separate bounded detail process probes only the 1–2 exact roots selected by the base
// snapshot. Each root gets a dedicated COM STA/PMv2 worker; no names, values or actions are read.
class MsaaWindowRegionQuery {
    public const int BudgetMs=350;
    public const int MaxRoots=2;
    // The count-only diagnostic may look at more roots than the live query probes.
    public const int ReportMaxRoots=16;
    public const int MaxVisits=512;
    public const int MaxDepth=32;
    public const int BatchSize=32;
    const int StateInvisible=0x00008000;
    const int StateOffscreen=0x00010000;
    const int RoleWindow=0x09;
    const int RoleClient=0x0A;
    const int RoleDocument=0x0F;
    const int RolePane=0x10;
    const int RoleGrouping=0x14;
    const int RoleStaticText=0x29;
    const int RoleText=0x2A;
    const uint ObjIdClient=0xFFFFFFFC;
    const uint GaRoot=2;

    [StructLayout(LayoutKind.Sequential)] struct NativePoint { public int X,Y; }
    [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr reserved,uint flags);
    [DllImport("ole32.dll")] static extern void CoUninitialize();
    [DllImport("oleacc.dll",PreserveSig=true)] static extern int AccessibleObjectFromWindow(IntPtr hwnd,uint objectId,ref Guid interfaceId,[MarshalAs(UnmanagedType.Interface)] out Accessibility.IAccessible accessible);
    [DllImport("oleacc.dll",PreserveSig=true)] static extern int AccessibleChildren([MarshalAs(UnmanagedType.Interface)] Accessibility.IAccessible container,int childStart,int childCount,[Out,MarshalAs(UnmanagedType.LPArray,ArraySubType=UnmanagedType.Struct,SizeParamIndex=2)] object[] children,out int obtained);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd,ref NativePoint point);
    [DllImport("dwmapi.dll",EntryPoint="DwmGetWindowAttribute")] static extern int DwmRect(IntPtr hwnd,int attribute,out Rect rect,int size);
    [DllImport("dwmapi.dll",EntryPoint="DwmGetWindowAttribute")] static extern int DwmInt(IntPtr hwnd,int attribute,out int value,int size);

    // Count-only diagnostics for one probe target: stage and status tokens plus counters.
    // Never a coordinate, a handle, a pid, a title or any text.
    public sealed class ProbeCounters {
        readonly object gate=new object();
        string stage="queued", status="";
        bool sealedStage;
        int comInitHr, objectHr, childCount, children, visited, visible, filtered, geometryOk, geometryFailed;
        int roleStateFailed, invisible, roleRejected, levels;
        readonly Dictionary<int,int> roleCounts=new Dictionary<int,int>();
        readonly Dictionary<int,int> roleLocated=new Dictionary<int,int>();
        readonly Dictionary<int,int> roleSmaller=new Dictionary<int,int>();
        public void SetStage(string nextStage,string nextStatus) { lock (gate) { if (sealedStage) return; stage=nextStage; status=nextStatus; } }
        // A budget miss is final: the worker may still be inside a provider call.
        public void SealStage(string nextStage,string nextStatus) { lock (gate) { sealedStage=true; stage=nextStage; status=nextStatus; } }
        public void SetComInitHr(int value) { lock (gate) comInitHr=value; }
        public void SetObjectHr(int value) { lock (gate) objectHr=value; }
        public void SetChildCount(int value) { lock (gate) childCount=value; }
        public void SetLevels(int value) { lock (gate) { if (value>levels) levels=value; } }
        public int ChildCountValue() { lock (gate) return childCount; }
        public void AddChildren(int value) { lock (gate) children+=value; }
        public void AddVisited() { lock (gate) visited++; }
        public void AddVisible() { lock (gate) visible++; }
        public void AddFiltered() { lock (gate) filtered++; }
        public void AddRoleStateFailed() { lock (gate) roleStateFailed++; }
        public void AddInvisible() { lock (gate) invisible++; }
        public void AddRoleRejected() { lock (gate) roleRejected++; }
        // Role numbers are standard MSAA constants: a histogram carries no window identity.
        public void AddRole(int role) {
            lock (gate) {
                int current;
                roleCounts.TryGetValue(role,out current);
                roleCounts[role]=current+1;
            }
        }
        // Diagnostic only: how many children of a role have a usable rectangle, and how many of
        // those are strictly smaller than the client area (a real sub-element).
        public void AddLocated(int role,bool smaller) {
            lock (gate) {
                int current;
                roleLocated.TryGetValue(role,out current);
                roleLocated[role]=current+1;
                if (smaller) {
                    int smallerCurrent;
                    roleSmaller.TryGetValue(role,out smallerCurrent);
                    roleSmaller[role]=smallerCurrent+1;
                }
            }
        }
        public void AddGeometry(bool ok) { lock (gate) { if (ok) geometryOk++; else geometryFailed++; } }
        public string Describe(bool finalized) {
            lock (gate) {
                var roles=new List<string>();
                var keys=new List<int>(roleCounts.Keys); keys.Sort();
                foreach (var key in keys) {
                    int located; roleLocated.TryGetValue(key,out located);
                    int smaller; roleSmaller.TryGetValue(key,out smaller);
                    roles.Add("\""+key.ToString(System.Globalization.CultureInfo.InvariantCulture)+"\":{\"count\":"+roleCounts[key]+
                        ",\"located\":"+located+",\"smaller\":"+smaller+"}");
                }
                return "{\"stage\":\""+stage+"\",\"status\":\""+status+"\",\"comInitHr\":"+comInitHr+
                    ",\"objectHr\":"+objectHr+",\"childCount\":"+childCount+",\"children\":"+children+
                    ",\"visited\":"+visited+",\"visible\":"+visible+",\"filtered\":"+filtered+
                    ",\"roleStateFailed\":"+roleStateFailed+",\"invisible\":"+invisible+",\"roleRejected\":"+roleRejected+
                    ",\"geometry\":"+geometryOk+",\"geometryFailed\":"+geometryFailed+",\"levels\":"+levels+
                    ",\"roles\":{"+String.Join(",",roles.ToArray())+"}"+
                    ",\"finalized\":"+(finalized?"true":"false")+"}";
            }
        }
    }
    public sealed class Target {
        public string NativeKey="";
        public uint Pid,Tid;
        public ulong RawHwnd;
        public IntPtr Hwnd;
        public Rect Bounds,Client;
        public List<Rect> Regions=new List<Rect>();
        public ProbeCounters Counters=new ProbeCounters();
        public bool Finalized;
    }
    sealed class ProbeJob {
        public Target Target;
        public Thread Worker;
        public bool Started;
        public ProbeJob(Target target) { Target=target; }
    }

    public static bool IsVisibleState(int state) { return (state&(StateInvisible|StateOffscreen))==0; }
    // Roles that are never selectable, whatever rectangle they carry.
    public static bool IsBlockedRole(int role) {
        return role==RoleWindow || role==RoleClient || role==RoleDocument || role==RoleStaticText;
    }
    // Container roles may only become a candidate when their normalized rectangle is a strictly
    // proper subrectangle of the client area: a container that covers the whole client is just
    // the fallback rectangle, not a selectable element.
    public static bool IsContainerRole(int role) { return role==RolePane || role==RoleGrouping; }
    public static bool IsCandidateRole(int role) {
        if (role<=0) return false;
        if (IsBlockedRole(role) || IsContainerRole(role)) return false;
        return true;
    }
    // Strictly inside the container: not identical to it.
    public static bool IsStrictSubrectangle(Rect rect,Rect container) {
        return rect.Left>container.Left || rect.Top>container.Top || rect.Right<container.Right || rect.Bottom<container.Bottom;
    }
    static bool ValidRect(Rect rect) {
        return Math.Abs((long)rect.Left)<=1000000 && Math.Abs((long)rect.Top)<=1000000 &&
            (long)rect.Right-rect.Left>0 && (long)rect.Bottom-rect.Top>0 &&
            (long)rect.Right-rect.Left<=4000000 && (long)rect.Bottom-rect.Top<=4000000;
    }
    static bool Same(Rect a,Rect b) {
        return a.Left==b.Left && a.Top==b.Top && a.Right==b.Right && a.Bottom==b.Bottom;
    }
    static bool TryParseKey(string value,out uint pid,out uint tid,out ulong hwnd) {
        pid=0; tid=0; hwnd=0;
        if (value==null || value.Length!=34 || value[8]!=':' || value[17]!=':') return false;
        for (int i=0;i<value.Length;i++) {
            if (i==8 || i==17) continue;
            char c=value[i]; if (!((c>='0'&&c<='9')||(c>='a'&&c<='f'))) return false;
        }
        return UInt32.TryParse(value.Substring(0,8),System.Globalization.NumberStyles.AllowHexSpecifier,System.Globalization.CultureInfo.InvariantCulture,out pid) && pid!=0 &&
            UInt32.TryParse(value.Substring(9,8),System.Globalization.NumberStyles.AllowHexSpecifier,System.Globalization.CultureInfo.InvariantCulture,out tid) && tid!=0 &&
            UInt64.TryParse(value.Substring(18,16),System.Globalization.NumberStyles.AllowHexSpecifier,System.Globalization.CultureInfo.InvariantCulture,out hwnd) && hwnd!=0;
    }
    static bool TryParseRect(string[] args,int offset,out Rect rect) {
        rect=new Rect(); int x,y,width,height;
        if (!Int32.TryParse(args[offset],System.Globalization.NumberStyles.AllowLeadingSign,System.Globalization.CultureInfo.InvariantCulture,out x) ||
            !Int32.TryParse(args[offset+1],System.Globalization.NumberStyles.AllowLeadingSign,System.Globalization.CultureInfo.InvariantCulture,out y) ||
            !Int32.TryParse(args[offset+2],System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out width) ||
            !Int32.TryParse(args[offset+3],System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out height)) return false;
        long right=(long)x+width,bottom=(long)y+height;
        if (Math.Abs((long)x)>1000000 || Math.Abs((long)y)>1000000 || width<1 || height<1 || width>4000000 || height>4000000 ||
            right>Int32.MaxValue || right<Int32.MinValue || bottom>Int32.MaxValue || bottom<Int32.MinValue) return false;
        rect=new Rect {Left=x,Top=y,Right=(int)right,Bottom=(int)bottom};
        return ValidRect(rect);
    }
    static bool Inside(Rect rect,Rect container) {
        return rect.Left>=container.Left && rect.Top>=container.Top && rect.Right<=container.Right && rect.Bottom<=container.Bottom;
    }
    public static List<Target> ParseTargets(uint ownPid,string[] args,string mode,int maxRoots) {
        if (args==null || args.Length<11 || args.Length>2+maxRoots*9 || (args.Length-2)%9!=0 || args[0]!=mode) throw new Exception("invalid-arguments");
        uint parsedOwn;
        if (!UInt32.TryParse(args[1],System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out parsedOwn) || parsedOwn==0 || parsedOwn!=ownPid) throw new Exception("invalid-arguments");
        int count=(args.Length-2)/9; if (count<1 || count>maxRoots) throw new Exception("invalid-arguments");
        var targets=new List<Target>(); var keys=new HashSet<string>(); var handles=new HashSet<ulong>();
        for (int i=0;i<count;i++) {
            int start=2+i*9; uint pid,tid; ulong hwnd;
            if (!TryParseKey(args[start],out pid,out tid,out hwnd) || pid==ownPid || !keys.Add(args[start]) || !handles.Add(hwnd)) throw new Exception("invalid-arguments");
            Rect bounds,client;
            if (!TryParseRect(args,start+1,out bounds) || !TryParseRect(args,start+5,out client) || !Inside(client,bounds)) throw new Exception("invalid-arguments");
            var target=new Target {NativeKey=args[start],Pid=pid,Tid=tid,RawHwnd=hwnd,Hwnd=unchecked((IntPtr)(long)hwnd),Bounds=bounds,Client=client};
            targets.Add(target);
        }
        return targets;
    }
    // Rebuild a probe target from a base snapshot row: the private key carries the identity and
    // the geometry is the one the snapshot already published.
    public static bool TryBuildTarget(string nativeKey,Rect bounds,Rect client,out Target target) {
        target=null;
        uint pid,tid; ulong hwnd;
        if (!TryParseKey(nativeKey,out pid,out tid,out hwnd)) return false;
        if (!ValidRect(bounds) || !ValidRect(client) || !Inside(client,bounds)) return false;
        target=new Target {NativeKey=nativeKey,Pid=pid,Tid=tid,RawHwnd=hwnd,Hwnd=unchecked((IntPtr)(long)hwnd),Bounds=bounds,Client=client};
        return true;
    }
    // Root validation with a specific reason: the stage tells which check stopped the probe.
    public static bool ValidateRoot(Target target,out string status) {
        status="ok";
        if (!IsWindow(target.Hwnd)) { status="invalid-window"; return false; }
        if (!IsWindowVisible(target.Hwnd)) { status="not-visible"; return false; }
        if (IsIconic(target.Hwnd)) { status="minimized"; return false; }
        if (GetAncestor(target.Hwnd,GaRoot)!=target.Hwnd) { status="not-root"; return false; }
        uint pid; uint tid=GetWindowThreadProcessId(target.Hwnd,out pid);
        if (tid==0) { status="no-thread"; return false; }
        if (pid!=target.Pid) { status="pid-mismatch"; return false; }
        if (tid!=target.Tid) { status="tid-mismatch"; return false; }
        int cloaked;
        if (DwmInt(target.Hwnd,14,out cloaked,4)!=0 || cloaked!=0) { status="cloaked"; return false; }
        Rect bounds;
        if (DwmRect(target.Hwnd,9,out bounds,Marshal.SizeOf(typeof(Rect)))!=0 && !GetWindowRect(target.Hwnd,out bounds)) { status="bounds-unavailable"; return false; }
        if (!ValidRect(bounds)) { status="bounds-invalid"; return false; }
        Rect localClient; if (!GetClientRect(target.Hwnd,out localClient)) { status="client-unavailable"; return false; }
        var a=new NativePoint {X=localClient.Left,Y=localClient.Top}; var b=new NativePoint {X=localClient.Right,Y=localClient.Bottom};
        if (!ClientToScreen(target.Hwnd,ref a) || !ClientToScreen(target.Hwnd,ref b)) { status="client-unavailable"; return false; }
        var client=new Rect {Left=Math.Max(bounds.Left,a.X),Top=Math.Max(bounds.Top,a.Y),Right=Math.Min(bounds.Right,b.X),Bottom=Math.Min(bounds.Bottom,b.Y)};
        if (!ValidRect(client)) { status="client-invalid"; return false; }
        if (!Same(bounds,target.Bounds)) { status="bounds-changed"; return false; }
        if (!Same(client,target.Client)) { status="client-changed"; return false; }
        return true;
    }
    static bool CurrentRootMatches(Target target) {
        string status;
        return ValidateRoot(target,out status);
    }
    static bool TryRoleState(Accessibility.IAccessible accessible,object child,out int role,out int state) {
        role=0; state=0;
        try {
            object roleValue=accessible.get_accRole(child), stateValue=accessible.get_accState(child);
            if (!(roleValue is int) || !(stateValue is int)) return false;
            role=(int)roleValue; state=(int)stateValue; return true;
        } catch { return false; }
    }
    static bool TryLocation(Accessibility.IAccessible accessible,object child,Rect container,out Rect result) {
        result=new Rect();
        try {
            int left,top,width,height; accessible.accLocation(out left,out top,out width,out height,child);
            long right=(long)left+width,bottom=(long)top+height;
            if (Math.Abs((long)left)>1000000 || Math.Abs((long)top)>1000000 || width<1 || height<1 || width>4000000 || height>4000000 ||
                right>Int32.MaxValue || right<Int32.MinValue || bottom>Int32.MaxValue || bottom<Int32.MinValue) return false;
            var raw=new Rect {Left=left,Top=top,Right=(int)right,Bottom=(int)bottom};
            return WindowRegionGeometry.TryNormalize(raw,container,out result);
        } catch { return false; }
    }
    // Diagnostic only: the raw rectangle of a child, without clipping or the minimum size rule.
    static bool TryRawLocation(Accessibility.IAccessible accessible,object child,out Rect result) {
        result=new Rect();
        try {
            int left,top,width,height; accessible.accLocation(out left,out top,out width,out height,child);
            long right=(long)left+width,bottom=(long)top+height;
            if (width<1 || height<1 || Math.Abs((long)left)>1000000 || Math.Abs((long)top)>1000000 ||
                right>Int32.MaxValue || right<Int32.MinValue || bottom>Int32.MaxValue || bottom<Int32.MinValue) return false;
            result=new Rect {Left=left,Top=top,Right=(int)right,Bottom=(int)bottom};
            return true;
        } catch { return false; }
    }
    // Returns -1 when the enumeration failed, 0 when the provider exposes no children,
    // 1 when children were seen but produced no usable rectangle and 2 when regions exist.
    static int Walk(Accessibility.IAccessible parent,Rect container,int depth,int[] visits,List<Rect> output,ProbeCounters counters,bool diagnose) {
        if (depth>=MaxDepth || visits[0]>=MaxVisits || output.Count>=WindowRegionGeometry.MaxRegionsPerRow) return 1;
        int childCount;
        try { childCount=parent.accChildCount; } catch { return -1; }
        if (depth==0) counters.SetChildCount(childCount);
        counters.SetLevels(depth);
        if (childCount<=0) return 0;
        for (int start=0;start<childCount && visits[0]<MaxVisits && output.Count<WindowRegionGeometry.MaxRegionsPerRow;) {
            int request=Math.Min(BatchSize,Math.Min(childCount-start,MaxVisits-visits[0]));
            if (request<=0) break;
            var children=new object[request]; int obtained=0; int hr;
            try { hr=AccessibleChildren(parent,start,request,children,out obtained); } catch { return -1; }
            if (hr<0 || obtained<=0 || obtained>request) {
                for (int i=0;i<Math.Min(Math.Max(obtained,0),children.Length);i++) ReleaseVariant(children[i]);
                if (hr<0) return -1;
                break;
            }
            counters.AddChildren(obtained);
            for (int i=0;i<obtained;i++) {
                object value=children[i];
                // A visit/output cap may stop the traversal mid batch: the remaining populated
                // VARIANTs are still released below, so no child outlives this STA apartment.
                if (visits[0]<MaxVisits && output.Count<WindowRegionGeometry.MaxRegionsPerRow) {
                    visits[0]++;
                    counters.AddVisited();
                    Accessibility.IAccessible childAccessible=value as Accessibility.IAccessible;
                    object childId;
                    if (value is int) childId=value;
                    else if (childAccessible!=null) childId=0;
                    else childId=null;
                    if (childId!=null) {
                        int role,state;
                        if (TryRoleState(childAccessible??parent,childId,out role,out state)) {
                            counters.AddRole(role);
                            if (IsVisibleState(state)) {
                                counters.AddVisible();
                                if (diagnose) {
                                    Rect raw;
                                    if (TryRawLocation(childAccessible??parent,childId,out raw)) {
                                        bool smaller=IsStrictSubrectangle(raw,container);
                                        counters.AddLocated(role,smaller);
                                    }
                                }
                                Rect rect=new Rect();
                                // Blocked roles never get a location call; container roles need one
                                // to tell a proper subrectangle from the whole client.
                                bool located=!IsBlockedRole(role) && TryLocation(childAccessible??parent,childId,container,out rect);
                                if (IsBlockedRole(role)) { counters.AddRoleRejected(); counters.AddFiltered(); }
                                else if (IsContainerRole(role)) {
                                    if (located && IsStrictSubrectangle(rect,container)) { output.Add(rect); counters.AddGeometry(true); }
                                    else { counters.AddRoleRejected(); counters.AddFiltered(); if (located) counters.AddGeometry(false); }
                                } else {
                                    if (located) { output.Add(rect); counters.AddGeometry(true); }
                                    else counters.AddGeometry(false);
                                }
                                if (childAccessible!=null && depth+1<MaxDepth) Walk(childAccessible,container,depth+1,visits,output,counters,diagnose);
                            } else { counters.AddInvisible(); counters.AddFiltered(); }
                        } else { counters.AddRoleStateFailed(); counters.AddFiltered(); }
                    }
                }
                ReleaseVariant(value);
            }
            start+=obtained;
            if (obtained<request) break;
        }
        return output.Count>0 ? 2 : 1;
    }
    static void ReleaseVariant(object value) {
        try { if (value!=null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); } catch { }
    }
    // The staged probe: the stage token names the last check that ran, the status token says
    // why it stopped. Both are stable strings, so a report never carries identifying data.
    static void Probe(Target target,bool diagnose) {
        ProbeCounters counters=target.Counters;
        string status;
        // The base snapshot was taken in a per-monitor-v2 thread, so the validation must compare
        // physical coordinates: the awareness context has to be set before the first window call.
        // A fresh thread otherwise inherits the process default and reads virtualized client
        // rectangles, which never match the snapshot.
        IntPtr previous=SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous==IntPtr.Zero) { counters.SetStage("dpi-context","failed"); return; }
        int initialized=CoInitializeEx(IntPtr.Zero,2);
        counters.SetComInitHr(initialized);
        if (initialized<0) { counters.SetStage("com-init","failed"); SetThreadDpiAwarenessContext(previous); return; }
        counters.SetStage("com-init","ok");
        Accessibility.IAccessible root=null;
        try {
            if (!ValidateRoot(target,out status)) { counters.SetStage("validate",status); return; }
            counters.SetStage("validate","ok");
            Guid iid=new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
            int objectHr=AccessibleObjectFromWindow(target.Hwnd,ObjIdClient,ref iid,out root);
            counters.SetObjectHr(objectHr);
            if (objectHr<0 || root==null) { counters.SetStage("object","failed"); return; }
            counters.SetStage("object","ok");
            int walk=Walk(root,target.Client,0,new int[1],target.Regions,counters,diagnose);
            if (walk<0) { counters.SetStage("children","failed"); return; }
            if (counters.ChildCountValue()==0) { counters.SetStage("children","empty"); return; }
            counters.SetStage("geometry",walk>=2?"ok":"empty");
            if (!ValidateRoot(target,out status)) { target.Regions.Clear(); counters.SetStage("post-validate","changed"); return; }
            counters.SetStage("done",target.Regions.Count>0?"regions":"empty");
        } catch { counters.SetStage("provider","exception"); }
        finally {
            ReleaseVariant(root);
            SetThreadDpiAwarenessContext(previous);
            CoUninitialize();
        }
    }
    // Only finalized targets are serialized: a worker that ran out of budget may still be inside
    // a provider call, so its region list must never be read or written out.
    public static string BuildJson(List<Target> targets) {
        var rows=new List<string>();
        foreach (var target in targets) {
            if (!target.Finalized) continue;
            if (target.Regions.Count==0) continue;
            var regions=new List<string>(); foreach (var rect in target.Regions) regions.Add(WindowRegionGeometry.RectJson(rect));
            rows.Add("{\"nativeKey\":\""+target.NativeKey+"\",\"bounds\":"+WindowRegionGeometry.RectJson(target.Bounds)+
                ",\"client\":"+WindowRegionGeometry.RectJson(target.Client)+",\"regions\":["+String.Join(",",regions.ToArray())+"]}");
        }
        return "["+String.Join(",",rows.ToArray())+"]";
    }
    // Runs the production probe jobs under the same total budget and returns the finalized roots.
    public static List<Target> RunJobs(List<Target> targets,bool diagnose) {
        var jobs=new List<ProbeJob>();
        foreach (var target in targets) {
            var job=new ProbeJob(target);
            job.Worker=new Thread(delegate() { try { Probe(target,diagnose); } catch { } });
            job.Worker.IsBackground=true; job.Worker.Name="window-region-msaa-sta";
            try { job.Worker.SetApartmentState(ApartmentState.STA); job.Worker.Start(); job.Started=true; } catch { }
            jobs.Add(job);
        }
        var timer=Stopwatch.StartNew();
        var finalized=new List<Target>();
        foreach (var job in jobs) {
            if (!job.Started) { job.Target.Counters.SealStage("queued","not-started"); continue; }
            int remaining=BudgetMs-(int)timer.ElapsedMilliseconds;
            bool finished=remaining>0?job.Worker.Join(remaining):!job.Worker.IsAlive;
            if (!finished) {
                // The worker may still be inside a provider call: seal the stage and leave its
                // region list alone.
                job.Target.Counters.SealStage("deadline","budget");
                continue;
            }
            var rawRegions=new List<Rect>(job.Target.Regions);
            job.Target.Regions.Clear();
            var normalized=new List<Rect>();
            foreach (var raw in rawRegions) { Rect rect; if (WindowRegionGeometry.TryNormalize(raw,job.Target.Client,out rect)) normalized.Add(rect); }
            WindowRegionGeometry.Merge(normalized,job.Target.Client,job.Target.Regions);
            job.Target.Finalized=true;
            finalized.Add(job.Target);
        }
        return finalized;
    }
    public static void Write(Stream output,uint ownPid,string[] args) {
        var targets=ParseTargets(ownPid,args,"--window-regions-msaa",MaxRoots);
        RunJobs(targets,false);
        string json=BuildJson(targets);
        byte[] bytes=Encoding.UTF8.GetBytes(json);
        if (bytes.Length>WindowRegionGeometry.MaxPayloadBytes) bytes=Encoding.UTF8.GetBytes("[]");
        output.Write(bytes,0,bytes.Length); output.Flush();
    }
    // Count-only diagnostic: stage and status tokens plus counters for every probed root.
    // No coordinate, handle, pid, key or text ever reaches this output.
    public static string DescribeReport(List<Target> targets,int rowCount,int rootCount) {
        var rows=new List<string>();
        foreach (var target in targets) rows.Add(target.Counters.Describe(target.Finalized));
        return "{\"mode\":\"msaa-report\",\"rows\":"+rowCount+",\"roots\":"+rootCount+
            ",\"targets\":["+String.Join(",",rows.ToArray())+"]}";
    }
    public static void WriteReport(Stream output,List<Target> targets,int rowCount,int rootCount) {
        RunJobs(targets,true);
        string json=DescribeReport(targets,rowCount,rootCount);
        byte[] bytes=Encoding.UTF8.GetBytes(json);
        if (bytes.Length>WindowRegionGeometry.MaxPayloadBytes) bytes=Encoding.UTF8.GetBytes("{\"mode\":\"msaa-report\",\"truncated\":true}");
        output.Write(bytes,0,bytes.Length); output.Flush();
    }
}

// Counters of one region probe. Only counts, stages and error identity: never a coordinate,
// a handle, a title or any text. The probe thread updates it under a short lock that is never
// held across a UI Automation call.
class RegionStats {
    readonly object gate=new object();
    int visited, candidates; bool finished; string stage="running"; string errorType=""; int hresult;
    public void Visited() { Interlocked.Increment(ref visited); }
    public void Candidate() { Interlocked.Increment(ref candidates); }
    // The first stage that is not "running" wins, so the deepest leaf does not overwrite the real reason.
    public void Stage(string value) { lock (gate) { if (stage=="running") stage=value; } }
    public void Fail(string value, Exception error) {
        lock (gate) {
            if (errorType=="") {
                errorType=error.GetType().Name;
                try { hresult=Marshal.GetHRForException(error); } catch { hresult=0; }
            }
            if (stage=="running") stage=value;
        }
    }
    public void Finished() { lock (gate) { finished=true; } }
    public void Budget() { lock (gate) { if (!finished) stage="budget"; } }
    public RegionStatsView View() {
        lock (gate) { return new RegionStatsView {Visited=visited,Candidates=candidates,Finished=finished,Stage=stage,ErrorType=errorType,HResult=hresult}; }
    }
}
class RegionStatsView {
    public int Visited, Candidates, HResult;
    public bool Finished;
    public string Stage="", ErrorType="";
}

// Per-root view of one collection pass. Counts, stages and error identity only.
class WindowRegionRootView {
    public int Ordinal, ChildValid;
    public bool Blocked, HasClient;
    public RegionStatsView Uia=new RegionStatsView();
}
// Pure report serialiser: counters only. It can never emit a coordinate, a handle, a pid,
// a title, a class name, text or pixels, because it only has counters to emit.
class WindowRegionReport {
    public static string Build(List<WindowRegionRootView> roots, int probedRoots, long collectMs, long elapsedMs) {
        var parts=new List<string>();
        int childTotal=0, visitedTotal=0, candidateTotal=0;
        foreach (var root in roots) {
            childTotal+=root.ChildValid; visitedTotal+=root.Uia.Visited; candidateTotal+=root.Uia.Candidates;
            parts.Add("{\"ordinal\":"+root.Ordinal
                +",\"blocked\":"+(root.Blocked?"true":"false")
                +",\"hasClient\":"+(root.HasClient?"true":"false")
                +",\"childValid\":"+root.ChildValid
                +",\"uiaVisited\":"+root.Uia.Visited+",\"uiaCandidates\":"+root.Uia.Candidates
                +",\"uiaFinished\":"+(root.Uia.Finished?"true":"false")
                +",\"uiaStage\":\""+root.Uia.Stage+"\""
                +",\"uiaErrorType\":\""+root.Uia.ErrorType+"\""
                +",\"uiaHResult\":"+root.Uia.HResult+"}");
        }
        return "{\"elapsedMs\":"+elapsedMs
            +",\"collectMs\":"+collectMs
            +",\"windows\":"+roots.Count
            +",\"probedRoots\":"+probedRoots
            +",\"childValidTotal\":"+childTotal
            +",\"uiaVisitedTotal\":"+visitedTotal
            +",\"uiaCandidatesTotal\":"+candidateTotal
            +",\"roots\":["+String.Join(",",parts.ToArray())+"]}";
    }
}

// A bounded background source of element rectangles. The publisher never calls into it.
interface IRegionSource {
    void Start();
    bool TryComplete(int timeoutMs, out List<Rect> rects);
    RegionStats Stats { get; }
}

// Rectangles collected by a worker thread, published under a short lock.
class RectBuffer {
    readonly object gate=new object();
    readonly List<Rect> rects=new List<Rect>();
    public void Add(Rect rect) { lock (gate) { rects.Add(rect); } }
    public List<Rect> Snapshot() { lock (gate) { return new List<Rect>(rects); } }
}

// Runs one probe on a background thread. The thread is a background thread, every failure is
// swallowed and the publisher only ever reads the buffer after a bounded wait.
class WorkerRegionSource : IRegionSource {
    readonly Thread worker; readonly RectBuffer buffer; readonly RegionStats stats;
    public WorkerRegionSource(Action<RectBuffer, RegionStats> body) {
        buffer=new RectBuffer(); stats=new RegionStats();
        worker=new Thread(delegate() { try { body(buffer,stats); } catch (Exception error) { stats.Fail("probe-error",error); } });
        worker.IsBackground=true;
        worker.Name="window-region-probe";
    }
    public RegionStats Stats { get { return stats; } }
    public void Start() { worker.Start(); }
    public bool TryComplete(int timeoutMs, out List<Rect> rects) {
        bool finished=false;
        try { finished=worker.Join(timeoutMs); } catch { finished=false; }
        rects=buffer.Snapshot();
        if (finished) stats.Finished(); else stats.Budget();
        return finished;
    }
}

// Publishes whatever the probes produced into the rows, inside a hard total budget.
class WindowRegionPublisher {
    public const int MaxProbes = 2;
    public const int BudgetMs = 350;
    // Which eligible roots receive detail work. The foreground root comes first; the rest are
    // filled by largest client area (ties keep the Z order). This only selects roots: row order
    // and occlusion semantics never change, and an explicit list replaces the choice entirely.
    public static List<int> SelectProbeRoots(List<WindowRegionGeometry.Row> rows, int foregroundIndex, List<int> explicitIndices) {
        var result=new List<int>();
        if (rows==null) return result;
        if (explicitIndices!=null && explicitIndices.Count>0) {
            foreach (var index in explicitIndices) {
                if (!Eligible(rows,index) || result.Contains(index)) continue;
                result.Add(index);
                if (result.Count>=MaxProbes) break;
            }
            return result;
        }
        if (Eligible(rows,foregroundIndex)) result.Add(foregroundIndex);
        var remaining=new List<int>();
        for (int i=0;i<rows.Count;i++) if (Eligible(rows,i) && !result.Contains(i)) remaining.Add(i);
        remaining.Sort(delegate(int a,int b) {
            long areaA=ClientArea(rows[a]), areaB=ClientArea(rows[b]);
            if (areaA!=areaB) return areaB.CompareTo(areaA);
            return a.CompareTo(b);
        });
        foreach (var index in remaining) {
            if (result.Count>=MaxProbes) break;
            result.Add(index);
        }
        return result;
    }
    static bool Eligible(List<WindowRegionGeometry.Row> rows, int index) {
        return index>=0 && index<rows.Count && !rows[index].Blocked && rows[index].HasClient;
    }
    static long ClientArea(WindowRegionGeometry.Row row) {
        if (!row.HasClient) return 0;
        long width=(long)row.Client.Right-row.Client.Left, height=(long)row.Client.Bottom-row.Client.Top;
        if (width<=0 || height<=0) return 0;
        return width*height;
    }
    public static void Publish(List<WindowRegionGeometry.Row> rows, List<KeyValuePair<int, IRegionSource>> sources, int budgetMs) {
        if (sources==null || sources.Count==0) return;
        foreach (var pair in sources) { try { pair.Value.Start(); } catch { /* ignore a probe that cannot start */ } }
        int slice=Math.Max(1,budgetMs/sources.Count);
        foreach (var pair in sources) {
            if (pair.Key<0 || pair.Key>=rows.Count) continue;
            List<Rect> rects;
            try { pair.Value.TryComplete(slice,out rects); } catch { rects=new List<Rect>(); }
            if (rects==null || rects.Count==0) continue;
            var row=rows[pair.Key];
            var container=row.Container;
            var normalized=new List<Rect>();
            foreach (var raw in rects) { Rect ok; if (WindowRegionGeometry.TryNormalize(raw,container,out ok)) normalized.Add(ok); }
            WindowRegionGeometry.Merge(normalized,container,row.Regions);
        }
    }
}

// In-memory self-test for the window-region path: synthetic data only, no desktop reads,
// no window enumeration and no UI Automation calls.
class WindowRegionSelfTest {
    public static int Run(Stream output) {
        var startedAt=DateTime.UtcNow;
        var failures=new List<string>(); int checks=0;
        Action<string,bool> check=delegate(string name,bool ok) { checks++; if (!ok) failures.Add(name); };
        var container=new Rect {Left=0,Top=0,Right=100,Bottom=100};
        Rect clipped;
        check("clip", WindowRegionGeometry.TryNormalize(new Rect{Left=-20,Top=10,Right=40,Bottom=60},container,out clipped)
            && clipped.Left==0 && clipped.Top==10 && clipped.Right==40 && clipped.Bottom==60);
        Rect tiny;
        check("min-size", !WindowRegionGeometry.TryNormalize(new Rect{Left=0,Top=0,Right=7,Bottom=7},container,out tiny)
            && WindowRegionGeometry.TryNormalize(new Rect{Left=0,Top=0,Right=8,Bottom=8},container,out tiny));
        // Extreme and reversed coordinates must not overflow into a bogus rectangle.
        var wide=new Rect{Left=-10000,Top=0,Right=10000,Bottom=100};
        Rect extreme;
        check("overflow-rejected", !WindowRegionGeometry.TryNormalize(new Rect{Left=int.MinValue,Top=0,Right=int.MinValue+100,Bottom=100},wide,out extreme));
        check("extreme-clipped", WindowRegionGeometry.TryNormalize(new Rect{Left=int.MinValue,Top=int.MinValue,Right=int.MaxValue,Bottom=int.MaxValue},wide,out extreme)
            && extreme.Left==-10000 && extreme.Top==0 && extreme.Right==10000 && extreme.Bottom==100);
        check("reversed-rejected", !WindowRegionGeometry.TryNormalize(new Rect{Left=80,Top=80,Right=20,Bottom=20},container,out extreme));
        var merged=new List<Rect>();
        WindowRegionGeometry.Merge(new List<Rect>{
            new Rect{Left=0,Top=0,Right=100,Bottom=100},
            new Rect{Left=10,Top=10,Right=50,Bottom=50},
            new Rect{Left=10,Top=10,Right=50,Bottom=50}},container,merged);
        check("dedupe", merged.Count==1);
        var many=new List<Rect>();
        for (int i=0;i<200;i++) many.Add(new Rect{Left=i,Top=0,Right=i+4,Bottom=4});
        var capped=new List<Rect>();
        WindowRegionGeometry.Merge(many,container,capped);
        check("per-row-cap", capped.Count==WindowRegionGeometry.MaxRegionsPerRow);
        var rows=new List<WindowRegionGeometry.Row>();
        for (int r=0;r<3;r++) {
            var row=new WindowRegionGeometry.Row(); row.Bounds=container; row.HasClient=true; row.Client=container;
            for (int i=0;i<WindowRegionGeometry.MaxRegionsPerRow;i++) row.Regions.Add(new Rect{Left=0,Top=0,Right=8+i,Bottom=8});
            rows.Add(row);
        }
        WindowRegionGeometry.ApplyGlobalCap(rows);
        int total=0; foreach (var row in rows) total+=row.Regions.Count;
        check("global-cap", total<=WindowRegionGeometry.MaxRegionsTotal);
        var blocked=new WindowRegionGeometry.Row(); blocked.Bounds=container; blocked.Blocked=true;
        blocked.NativeKey="0000007b:00000001:000000000000002a"; blocked.DetailRoot=true;
        blocked.Regions.Add(new Rect{Left=1,Top=1,Right=20,Bottom=20});
        check("blocked-no-regions", !WindowRegionGeometry.RowJson(blocked,true).Contains("regions"));
        check("blocked-no-private-key", !WindowRegionGeometry.SerializeSnapshot(new List<WindowRegionGeometry.Row>{blocked}).Contains("nativeKey"));
        var keyed=new WindowRegionGeometry.Row {Bounds=container,HasClient=true,Client=container,
            NativeKey="0000007b:00000001:000000000000002a",DetailRoot=true};
        string keyedJson=WindowRegionGeometry.SerializeSnapshot(new List<WindowRegionGeometry.Row>{keyed});
        check("snapshot-private-root-key", keyedJson.Contains("\"nativeKey\":\"0000007b:00000001:000000000000002a\"") && keyedJson.Contains("\"detailRoot\":true"));
        check("msaa-state-visible", MsaaWindowRegionQuery.IsVisibleState(0));
        check("msaa-state-invisible", !MsaaWindowRegionQuery.IsVisibleState(0x00008000));
        check("msaa-state-offscreen", !MsaaWindowRegionQuery.IsVisibleState(0x00010000));
        check("msaa-control-role", MsaaWindowRegionQuery.IsCandidateRole(0x2B));
        check("msaa-text-control-role", MsaaWindowRegionQuery.IsCandidateRole(0x2A));
        check("msaa-static-text-label", !MsaaWindowRegionQuery.IsCandidateRole(0x29));
        // Role policy: window/client/document/static text are never selectable; pane and grouping
        // only count when their rectangle is a proper subrectangle of the client area.
        check("msaa-blocked-roles", MsaaWindowRegionQuery.IsBlockedRole(0x09) && MsaaWindowRegionQuery.IsBlockedRole(0x0A) &&
            MsaaWindowRegionQuery.IsBlockedRole(0x0F) && MsaaWindowRegionQuery.IsBlockedRole(0x29));
        check("msaa-container-roles", MsaaWindowRegionQuery.IsContainerRole(0x10) && MsaaWindowRegionQuery.IsContainerRole(0x14) &&
            !MsaaWindowRegionQuery.IsCandidateRole(0x10) && !MsaaWindowRegionQuery.IsCandidateRole(0x14));
        check("msaa-strict-subrectangle", MsaaWindowRegionQuery.IsStrictSubrectangle(new Rect{Left=10,Top=10,Right=40,Bottom=40},container) &&
            !MsaaWindowRegionQuery.IsStrictSubrectangle(container,container) &&
            !MsaaWindowRegionQuery.IsStrictSubrectangle(new Rect{Left=0,Top=0,Right=120,Bottom=120},container) &&
            MsaaWindowRegionQuery.IsStrictSubrectangle(new Rect{Left=0,Top=0,Right=100,Bottom=50},container));
        // The merge drops a rectangle that is exactly the container: a full-client container is
        // the fallback, not a candidate.
        var exactClient=new List<Rect>();
        WindowRegionGeometry.Merge(new List<Rect>{container},container,exactClient);
        check("merge-rejects-exact-client", exactClient.Count==0);
        var properChild=new List<Rect>();
        WindowRegionGeometry.Merge(new List<Rect>{new Rect{Left=10,Top=10,Right=40,Bottom=40}},container,properChild);
        check("merge-keeps-proper-child", properChild.Count==1);
        // Finalized-only serialization: an unfinished root must never reach the output.
        var finalTarget=new MsaaWindowRegionQuery.Target {NativeKey="0000007b:00000001:000000000000002a",Bounds=container,Client=container,Finalized=true};
        finalTarget.Regions.Add(new Rect{Left=0,Top=0,Right=20,Bottom=20});
        var pendingTarget=new MsaaWindowRegionQuery.Target {NativeKey="0000007b:00000002:000000000000002b",Bounds=container,Client=container};
        pendingTarget.Regions.Add(new Rect{Left=0,Top=0,Right=30,Bottom=30});
        string finalJson=MsaaWindowRegionQuery.BuildJson(new List<MsaaWindowRegionQuery.Target>{finalTarget,pendingTarget});
        check("finalized-only-serialization", finalJson.Contains("000000000000002a") && !finalJson.Contains("000000000000002b"));
        string msaaReportJson=MsaaWindowRegionQuery.DescribeReport(new List<MsaaWindowRegionQuery.Target>{finalTarget,pendingTarget},5,2);
        check("report-no-identifying-data", !msaaReportJson.Contains("nativeKey") && !msaaReportJson.Contains("bounds") &&
            !msaaReportJson.Contains("client") && !msaaReportJson.Contains("0000007b"));
        check("report-counts-only", msaaReportJson.Contains("\"rows\":5") && msaaReportJson.Contains("\"roots\":2") &&
            msaaReportJson.Contains("\"stage\":\"queued\"") && msaaReportJson.Contains("\"finalized\":true") &&
            msaaReportJson.Contains("\"finalized\":false"));
        string bogusStatus;
        var bogusTarget=new MsaaWindowRegionQuery.Target {NativeKey="0000007b:00000001:000000000000002a",Pid=123,Tid=1,
            RawHwnd=42,Hwnd=new IntPtr(42),Bounds=container,Client=container};
        check("validate-invalid-window", !MsaaWindowRegionQuery.ValidateRoot(bogusTarget,out bogusStatus) && bogusStatus=="invalid-window");
        // The experimental UIA panel probe counts useful interior pieces without leaking geometry.
        int probeNormalized,probeDropped,probeDistinct,probeUseful,probeNearFull,probeTiny,probeSmall,probePanel;
        UiaPanelProbe.Classify(new List<Rect>{
            container,                                                  // the whole client: not useful
            new Rect{Left=0,Top=0,Right=50,Bottom=50},                  // a quarter of the client: a panel
            new Rect{Left=0,Top=0,Right=50,Bottom=50},                  // a duplicate of the same piece
            new Rect{Left=0,Top=0,Right=1,Bottom=1},                    // too small to survive normalization
        },container,out probeNormalized,out probeDropped,out probeDistinct,out probeUseful,out probeNearFull,
        out probeTiny,out probeSmall,out probePanel);
        check("uia-probe-classifies", probeDistinct==2 && probeUseful==1 && probeNearFull==1 && probePanel==1);
        check("uia-probe-drops-tiny", probeDropped>=1);
        var heavy=new List<WindowRegionGeometry.Row>();
        for (int r=0;r<60;r++) {
            var row=new WindowRegionGeometry.Row(); row.Bounds=container; row.HasClient=true; row.Client=container;
            for (int i=0;i<WindowRegionGeometry.MaxRegionsPerRow;i++) row.Regions.Add(new Rect{Left=0,Top=0,Right=8,Bottom=8});
            heavy.Add(row);
        }
        string payload=WindowRegionGeometry.Serialize(heavy);
        check("payload-budget", Encoding.UTF8.GetByteCount(payload)<=WindowRegionGeometry.MaxPayloadBytes);
        check("payload-keeps-geometry", payload.Contains("\"bounds\"") && payload.Contains("\"client\""));
        // A probe that never finishes may cost regions, never the geometry, and never the budget.
        var stalledRows=new List<WindowRegionGeometry.Row>();
        var stalled=new WindowRegionGeometry.Row(); stalled.Bounds=container; stalled.HasClient=true; stalled.Client=container;
        stalledRows.Add(stalled);
        var sources=new List<KeyValuePair<int, IRegionSource>>();
        sources.Add(new KeyValuePair<int, IRegionSource>(0,new WorkerRegionSource(delegate(RectBuffer buffer, RegionStats stats) { Thread.Sleep(Timeout.Infinite); })));
        var started=DateTime.UtcNow;
        WindowRegionPublisher.Publish(stalledRows,sources,WindowRegionPublisher.BudgetMs);
        double elapsed=(DateTime.UtcNow-started).TotalMilliseconds;
        check("stalled-source", elapsed<2000 && stalledRows[0].Regions.Count==0 && stalledRows[0].HasClient);
        // Root selection for the UI Automation probes: foreground first, then the largest client
        // area, with an explicit list replacing the choice.
        var pick=new List<WindowRegionGeometry.Row>();
        Action<int,int,int> makeRow=delegate(int index,int width,int height) {
            var row=new WindowRegionGeometry.Row();
            row.Bounds=new Rect {Left=0,Top=0,Right=width,Bottom=height};
            row.HasClient=true; row.Client=row.Bounds;
            while (pick.Count<=index) pick.Add(new WindowRegionGeometry.Row {Bounds=row.Bounds});
            pick[index]=row;
        };
        makeRow(0,100,100); makeRow(1,200,200); makeRow(2,300,300);
        var selection=WindowRegionPublisher.SelectProbeRoots(pick,2,null);
        check("select-foreground-first", selection.Count==2 && selection[0]==2 && selection[1]==1);
        pick[1].Blocked=true;
        selection=WindowRegionPublisher.SelectProbeRoots(pick,1,null);
        check("select-blocked-foreground", selection.Count==2 && selection[0]==2 && selection[1]==0);
        selection=WindowRegionPublisher.SelectProbeRoots(pick,-1,null);
        check("select-no-foreground", selection.Count==2 && selection[0]==2 && selection[1]==0);
        selection=WindowRegionPublisher.SelectProbeRoots(pick,2,new List<int> {0});
        check("select-explicit", selection.Count==1 && selection[0]==0);
        selection=WindowRegionPublisher.SelectProbeRoots(pick,2,new List<int> {1});
        check("select-explicit-ineligible", selection.Count==0);
        selection=WindowRegionPublisher.SelectProbeRoots(pick,2,new List<int> {0,2,0});
        check("select-explicit-unique", selection.Count==2 && selection[0]==0 && selection[1]==2);
        check("select-max-probes", WindowRegionPublisher.SelectProbeRoots(pick,-1,null).Count<=WindowRegionPublisher.MaxProbes);
        // The diagnostic report must stay counters only: no coordinate, handle, pid, title or text.
        var views=new List<WindowRegionRootView>();
        for (int i=0;i<3;i++) {
            var view=new WindowRegionRootView {Ordinal=i,Blocked=(i==0),HasClient=(i>0),ChildValid=i*2,
                Uia=new RegionStatsView {Visited=10+i,Candidates=i,Finished=(i==1),Stage=i==1?"ok":"not-probed",
                    ErrorType=i==2?"UnauthorizedAccessException":"",HResult=i==2?unchecked((int)0x80070005):0}};
            views.Add(view);
        }
        string reportJson=WindowRegionReport.Build(views,2,11,22);
        foreach (var forbidden in new string[] {"bounds","client","regions","x","y","width","height","left","top","right","bottom",
            "name","title","text","pid","hwnd","handle","class","value","label","pixel"}) {
            check("report-no-"+forbidden, !reportJson.Contains("\""+forbidden+"\""));
        }
        check("report-has-counters", reportJson.Contains("\"uiaVisited\":10") && reportJson.Contains("\"uiaHResult\":-2147024891")
            && reportJson.Contains("\"uiaStage\":\"ok\""));
        if (failures.Count>0) { Console.Error.WriteLine("window-regions-self-test: "+String.Join(",",failures.ToArray())); return 1; }
        byte[] report=Encoding.UTF8.GetBytes("{\"ok\":true,\"checks\":"+checks+",\"stalledMs\":"+((long)elapsed)
            +",\"totalMs\":"+((long)(DateTime.UtcNow-startedAt).TotalMilliseconds)+"}");
        output.Write(report,0,report.Length); output.Flush();
        return 0;
    }
}

// UI Automation geometry probe. It lives in its own class so no UIA type appears in the WGC
// capture class, and it is only reached inside the window-region branch (JIT on demand).
// Experimental only (not wired into the live query): one UIA geometry probe on a single base
// row, counted only. It reuses the same geometry-only UIA walk and the same normalization as
// the production helpers, and it reports how many DISTINCT normalized rectangles are actually
// useful interior pieces (at most half the client area) instead of near-full containers.
class UiaPanelProbe {
    // Size buckets relative to the client area: counts only, no geometry leaves this helper.
    public const int TinyPercent=1, SmallPercent=10, UsefulPercent=50;
    public static void Classify(List<Rect> raw,Rect container,out int normalized,out int dropped,
        out int distinct,out int useful,out int nearFull,out int tiny,out int small,out int panel) {
        var seen=new Dictionary<string,Rect>();
        normalized=0; dropped=0;
        foreach (var rect in raw) {
            Rect box;
            if (!WindowRegionGeometry.TryNormalize(rect,container,out box)) { dropped++; continue; }
            normalized++;
            string key=box.Left+","+box.Top+","+(box.Right-box.Left)+","+(box.Bottom-box.Top);
            if (!seen.ContainsKey(key)) seen[key]=box;
        }
        distinct=seen.Count; useful=0; nearFull=0; tiny=0; small=0; panel=0;
        long clientArea=(long)(container.Right-container.Left)*(container.Bottom-container.Top);
        if (clientArea<=0) return;
        foreach (var box in seen.Values) {
            long area=(long)(box.Right-box.Left)*(box.Bottom-box.Top);
            if (area*2>clientArea) { nearFull++; continue; }
            useful++;
            if (area*100<=clientArea*TinyPercent) tiny++;
            else if (area*100<=clientArea*SmallPercent) small++;
            else panel++;
        }
    }
    public static string Build(IntPtr hwnd,Rect container,int budgetMs,out long elapsedMs) {
        var timer=Stopwatch.StartNew();
        var source=UiaRegionProbe.Create(hwnd);
        source.Start();
        List<Rect> raw;
        // The existing timeout semantics: a bounded wait, then whatever the worker produced.
        // A false result means a partial snapshot, not a finished traversal.
        bool finished=source.TryComplete(budgetMs,out raw);
        elapsedMs=(long)timer.ElapsedMilliseconds;
        var stats=source.Stats.View();
        int normalized,dropped,distinct,useful,nearFull,tiny,small,panel;
        Classify(raw,container,out normalized,out dropped,out distinct,out useful,out nearFull,out tiny,out small,out panel);
        return "{\"mode\":\"uia-panel-probe\",\"finished\":"+(finished?"true":"false")
            +",\"stage\":\""+stats.Stage+"\""
            +",\"errorType\":\""+stats.ErrorType+"\""
            +",\"hResult\":"+stats.HResult
            +",\"visited\":"+stats.Visited
            +",\"candidatesRaw\":"+stats.Candidates
            +",\"rawRects\":"+raw.Count
            +",\"normalized\":"+normalized
            +",\"dropped\":"+dropped
            +",\"distinctNormalized\":"+distinct
            +",\"usefulInterior\":"+useful
            +",\"nearFull\":"+nearFull
            +",\"tiny\":"+tiny
            +",\"small\":"+small
            +",\"panel\":"+panel
            +",\"budgetMs\":"+budgetMs
            +",\"elapsedMs\":"+elapsedMs+"}";
    }
}
class UiaRegionProbe {
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    public const int MaxVisits = 512;
    public const int MaxDepth = 32;
    public static IRegionSource Create(IntPtr hwnd) {
        return new WorkerRegionSource(delegate(RectBuffer buffer, RegionStats stats) { Walk(hwnd,buffer,stats); });
    }
    static void Walk(IntPtr hwnd, RectBuffer buffer, RegionStats stats) {
        IntPtr previous=SetThreadDpiAwarenessContext(new IntPtr(-4));
        try {
            var request=new CacheRequest();
            request.Add(AutomationElement.BoundingRectangleProperty);
            request.Add(AutomationElement.IsOffscreenProperty);
            request.Add(AutomationElement.ControlTypeProperty);
            request.TreeScope=TreeScope.Element;
            AutomationElement root;
            try { root=AutomationElement.FromHandle(hwnd); }
            catch (Exception error) { stats.Fail("root-failed",error); return; }
            if (root==null) { stats.Stage("no-root"); return; }
            var walker=TreeWalker.ControlViewWalker;
            var visits=new int[1];
            WalkChildren(walker,root,request,buffer,stats,0,visits);
            if (visits[0]==0) stats.Stage("no-children");
            else if (stats.View().Stage=="running") stats.Stage("ok");
        } catch (Exception error) { stats.Fail("walk-failed",error); }
        finally { SetThreadDpiAwarenessContext(previous); }
    }
    static void WalkChildren(TreeWalker walker, AutomationElement parent, CacheRequest request, RectBuffer buffer, RegionStats stats, int depth, int[] visits) {
        if (depth>MaxDepth) { stats.Stage("depth-limit"); return; }
        if (visits[0]>=MaxVisits) { stats.Stage("visit-limit"); return; }
        AutomationElement child;
        try { child=walker.GetFirstChild(parent); } catch (Exception error) { stats.Fail("child-failed",error); return; }
        while (child!=null) {
            if (visits[0]>=MaxVisits) { stats.Stage("visit-limit"); return; }
            visits[0]++; stats.Visited();
            AutomationElement cached=null;
            try { cached=child.GetUpdatedCache(request); } catch (Exception error) { stats.Fail("cache-failed",error); }
            if (cached!=null) ReadCached(cached,buffer,stats);
            WalkChildren(walker,child,request,buffer,stats,depth+1,visits);
            AutomationElement sibling;
            try { sibling=walker.GetNextSibling(child); } catch (Exception error) { stats.Fail("sibling-failed",error); return; }
            child=sibling;
        }
    }
    // Each cached property is read on its own: one unsupported property must not drop the element.
    static void ReadCached(AutomationElement cached, RectBuffer buffer, RegionStats stats) {
        bool offscreen=false, haveOffscreen=false;
        try { offscreen=cached.Cached.IsOffscreen; haveOffscreen=true; } catch (Exception error) { stats.Fail("cache-property-failed",error); }
        ControlType type=ControlType.Custom; bool haveType=false;
        try { type=cached.Cached.ControlType; haveType=true; } catch (Exception error) { stats.Fail("cache-property-failed",error); }
        System.Windows.Rect box=default(System.Windows.Rect); bool haveBox=false;
        try { box=cached.Cached.BoundingRectangle; haveBox=true; } catch (Exception error) { stats.Fail("cache-property-failed",error); }
        if (!haveBox) { stats.Stage("cache-unavailable"); return; }
        if (haveOffscreen && offscreen) return;
        if (haveType && type==ControlType.Text) return;
        double left=box.Left, top=box.Top, right=box.Right, bottom=box.Bottom;
        if (double.IsNaN(left) || double.IsNaN(top) || double.IsNaN(right) || double.IsNaN(bottom) ||
            double.IsInfinity(left) || double.IsInfinity(top) || double.IsInfinity(right) || double.IsInfinity(bottom)) {
            stats.Stage("bad-geometry"); return;
        }
        try {
            // checked conversions reject a bad value instead of poisoning the whole payload.
            int il=checked((int)Math.Floor(left)), it=checked((int)Math.Floor(top));
            int ir=checked((int)Math.Ceiling(right)), ib=checked((int)Math.Ceiling(bottom));
            if (ir-il>=WindowRegionGeometry.MinSize && ib-it>=WindowRegionGeometry.MinSize) {
                buffer.Add(new Rect {Left=il,Top=it,Right=ir,Bottom=ib});
                stats.Candidate();
            }
        } catch (Exception error) { stats.Fail("geometry-failed",error); }
    }
}
