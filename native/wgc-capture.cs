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
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;

class WgcCapture {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
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
    [MTAThread] static int Main(string[] args) {
        IntPtr adapter=IntPtr.Zero, device=IntPtr.Zero, context=IntPtr.Zero, dxgi=IntPtr.Zero, inspectable=IntPtr.Zero, itemPtr=IntPtr.Zero, staging=IntPtr.Zero;
        Direct3D11CaptureFramePool pool=null; GraphicsCaptureSession session=null; IDirect3DDevice projectedDevice=null;
        AutoResetEvent arrived=new AutoResetEvent(false);
        try {
            var input=Console.OpenStandardInput(); var output=Console.OpenStandardOutput();
            if (args.Length==1 && args[0]=="--self-test") { Write(output,2,2,1,true,new byte[] {1,2,3,255,4,5,6,255,7,8,9,255,10,11,12,255}); return 0; }
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
            // Fit one of our own hidden selection windows to the real monitor rectangle in physical pixels.
            // Every identity check (handle, owner pid, nonce title, hidden, monitor) runs before SetWindowPos;
            // nothing is shown, activated, captured or reparented, and a visible/recycled handle is untouched.
            if (args.Length==8 && (args[0]=="--fit-selection-window" || args[0]=="--fit-hidden-window")) {
                // Whole-monitor fit for selection/mask windows, or a sub-rect fit for our own hidden bar.
                bool exactMonitor=args[0]=="--fit-selection-window";
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
                if (IsWindowVisible(window)) throw new Exception("window-visible");
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
                if (!SetWindowPos(window,IntPtr.Zero,fitX,fitY,fitWidth,fitHeight,0x0010|0x0004|0x0200|0x0400)) throw new Exception("window-move-failed");
                Rect actual; if (!GetWindowRect(window,out actual) || !Same(actual,target)) throw new Exception("window-rect-mismatch");
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
