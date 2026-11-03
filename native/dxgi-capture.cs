// DXGI Desktop Duplication capture candidate. Independent from the WGC helper; no WGC session.
// Protocol matches native/wgc-capture.cs: stdin 'N' requests one frame, 'Q'/EOF exits,
// stdout carries JGC2 frames (magic, width, height, sequence, flags) and RGBA bytes when flags=1.
//
// Pointer policy (official desktop-dup-api, "Updating the desktop pointer"):
// the desktop surface may already have the mouse pointer drawn into it, or the pointer may be a
// separate overlay. Visible=false does not prove absence. Only a known, separately overlaid
// pointer mode is accepted; unknown/embedded/hidden modes fail closed. Pointer metadata is
// updated only when LastMouseUpdateTime is nonzero. No pixel repair or unsafe override.
//
// COM slots used (IDXGIOutputDuplication base interface):
//   GetDesc 7, AcquireNextFrame 8, GetFrameDirtyRects 9, GetFrameMoveRects 10,
//   GetFramePointerShape 11, MapDesktopSurface 12, UnMapDesktopSurface 13, ReleaseFrame 14.
// IDXGIOutput5::DuplicateOutput1 is 26; explicitly requests BGRA8 conversion by DXGI.
// Several duplication sessions may exist for one output; DXGI allows a small default number of
// concurrent sessions, so a refused DuplicateOutput is reported as-is and never treated as
// "another process owns the output".
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

class DxgiCapture {
    const int MAX_PIXELS = 16000000;
    const uint FORMAT_B8G8R8A8_UNORM = 87;
    const int DXGI_ERROR_WAIT_TIMEOUT = unchecked((int)0x887A0027);
    const int DXGI_ERROR_ACCESS_LOST = unchecked((int)0x887A0006);
    const uint MODE_ROTATION_IDENTITY = 1;

    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct OutputDesc {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name;
        public Rect Desktop; public int Attached; public uint Rotation; public IntPtr Monitor;
    }
    [StructLayout(LayoutKind.Sequential)] struct TextureDesc {
        public uint Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CPUAccessFlags, MiscFlags;
    }
    [StructLayout(LayoutKind.Sequential)] struct Box { public uint Left, Top, Front, Right, Bottom, Back; }
    [StructLayout(LayoutKind.Sequential)] struct Mapped { public IntPtr Data; public uint RowPitch, DepthPitch; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct PointerPosition { public Point Position; public int Visible; }
    [StructLayout(LayoutKind.Sequential)] struct FrameInfo {
        public long LastPresentTime; public long LastMouseUpdateTime; public uint AccumulatedFrames;
        public int RectsCoalesced; public int ProtectedContentMaskedOut; public PointerPosition PointerPosition;
        public uint TotalMetadataBufferSize; public uint PointerShapeBufferSize;
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumAt(IntPtr self, uint index, out IntPtr item);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetOutputDesc(IntPtr self, out OutputDesc desc);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateTexture(IntPtr self, ref TextureDesc desc, IntPtr data, out IntPtr texture);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void CopyRegion(IntPtr self, IntPtr target, uint targetSubresource, uint x, uint y, uint z, IntPtr source, uint sourceSubresource, ref Box box);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int MapTexture(IntPtr self, IntPtr texture, uint subresource, uint type, uint flags, out Mapped mapped);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void UnmapTexture(IntPtr self, IntPtr texture, uint subresource);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int DeviceStatus(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int DuplicateOutput1(IntPtr self, IntPtr device, uint flags, uint count, IntPtr formats, out IntPtr duplication);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int AcquireNextFrame(IntPtr self, uint timeout, IntPtr frameInfo, out IntPtr resource);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ReleaseFrame(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void GetTextureDesc(IntPtr self, out TextureDesc desc);

    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder value, uint length, out uint needed);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromRect(ref Rect rect, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid iid, out IntPtr factory);
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, uint driverType, IntPtr software, uint flags, IntPtr featureLevels, uint count, uint sdkVersion, out IntPtr device, out uint featureLevel, out IntPtr context);

    static T Method<T>(IntPtr instance, int slot) where T : class {
        return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(instance), slot * IntPtr.Size), typeof(T));
    }
    static string DesktopName(IntPtr desktop) {
        var name = new StringBuilder(256); uint needed;
        if (desktop == IntPtr.Zero || !GetUserObjectInformation(desktop, 2, name, 512, out needed)) throw new Exception("input-desktop-unavailable");
        return name.ToString();
    }
    static void CheckInputDesktop(string expected) {
        IntPtr desktop = OpenInputDesktop(0, false, 1);
        try { if (!String.Equals(DesktopName(desktop), expected, StringComparison.Ordinal)) throw new Exception("input-desktop-changed"); }
        finally { if (desktop != IntPtr.Zero) CloseDesktop(desktop); }
    }
    static bool Same(Rect a, Rect b) { return a.Left == b.Left && a.Top == b.Top && a.Right == b.Right && a.Bottom == b.Bottom; }
    static void Release(ref IntPtr value) { if (value != IntPtr.Zero) { Marshal.Release(value); value = IntPtr.Zero; } }

    static void CheckOutput(IntPtr output, IntPtr monitor, MonitorInfo initial) {
        var current = new MonitorInfo { Size = initial.Size };
        OutputDesc desc;
        Marshal.ThrowExceptionForHR(Method<GetOutputDesc>(output, 7)(output, out desc));
        if (!GetMonitorInfo(monitor, ref current) || !Same(current.Monitor, initial.Monitor) ||
            desc.Attached == 0 || desc.Monitor != monitor || desc.Rotation != MODE_ROTATION_IDENTITY ||
            !Same(desc.Desktop, initial.Monitor)) throw new Exception("output-changed");
    }

    static void Write(Stream output, int width, int height, uint sequence, bool fresh, byte[] bytes) {
        byte[] header = new byte[20]; header[0] = 74; header[1] = 71; header[2] = 67; header[3] = 50;
        Buffer.BlockCopy(BitConverter.GetBytes(width), 0, header, 4, 4);
        Buffer.BlockCopy(BitConverter.GetBytes(height), 0, header, 8, 4);
        Buffer.BlockCopy(BitConverter.GetBytes(sequence), 0, header, 12, 4);
        Buffer.BlockCopy(BitConverter.GetBytes(fresh ? 1U : 0U), 0, header, 16, 4);
        output.Write(header, 0, 20);
        if (fresh && bytes != null) output.Write(bytes, 0, bytes.Length);
        output.Flush();
    }

    [MTAThread] static int Main(string[] args) {
        IntPtr factory = IntPtr.Zero, adapter = IntPtr.Zero, output = IntPtr.Zero, output1 = IntPtr.Zero;
        IntPtr duplication = IntPtr.Zero, device = IntPtr.Zero, context = IntPtr.Zero, staging = IntPtr.Zero, texture = IntPtr.Zero;
        try {
            var stdout = Console.OpenStandardOutput();
            var input = Console.OpenStandardInput();
            if (args.Length == 1 && args[0] == "--self-test") {
                Write(stdout, 2, 2, 1, true, new byte[] { 1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255 });
                return 0;
            }
            var numbers = new System.Collections.Generic.List<int>();
            foreach (var arg in args) {
                int parsed;
                if (!Int32.TryParse(arg, out parsed)) throw new Exception("invalid-arguments");
                numbers.Add(parsed);
            }
            if (numbers.Count != 4) throw new Exception("invalid-arguments");
            int x = numbers[0], y = numbers[1], width = numbers[2], height = numbers[3];
            if (Math.Abs((long)x) > 1000000 || Math.Abs((long)y) > 1000000 || width < 1 || height < 1 || (long)width * height > MAX_PIXELS) throw new Exception("invalid-region");
            if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) throw new Exception("dpi-context-failed");

            var roi = new Rect { Left = x, Top = y, Right = x + width, Bottom = y + height };
            IntPtr monitor = MonitorFromRect(ref roi, 0);
            var initial = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
            if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref initial) ||
                x < initial.Monitor.Left || y < initial.Monitor.Top || x + width > initial.Monitor.Right || y + height > initial.Monitor.Bottom) throw new Exception("region-outside-monitor");

            // Find the DXGI output that owns this monitor, on the adapter that drives it.
            bool found = false;
            OutputDesc desc = new OutputDesc();
            var factoryIid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
            Marshal.ThrowExceptionForHR(CreateDXGIFactory1(ref factoryIid, out factory));
            var enumAdapters = Method<EnumAt>(factory, 12); // IDXGIFactory1::EnumAdapters1
            for (uint a = 0; a < 32 && !found; a++) {
                int adapterHr = enumAdapters(factory, a, out adapter);
                if (adapterHr == unchecked((int)0x887A0002)) break;
                Marshal.ThrowExceptionForHR(adapterHr);
                var enumOutputs = Method<EnumAt>(adapter, 7); // IDXGIAdapter::EnumOutputs
                for (uint o = 0; o < 64; o++) {
                    int outputHr = enumOutputs(adapter, o, out output);
                    if (outputHr == unchecked((int)0x887A0002)) break;
                    Marshal.ThrowExceptionForHR(outputHr);
                    OutputDesc candidate;
                    Marshal.ThrowExceptionForHR(Method<GetOutputDesc>(output, 7)(output, out candidate)); // IDXGIOutput::GetDesc
                    if (candidate.Monitor == monitor) { desc = candidate; found = true; break; }
                    Release(ref output);
                }
                if (!found) Release(ref adapter);
            }
            if (!found) throw new Exception("monitor-adapter-not-found");
            if (desc.Attached == 0) throw new Exception("output-not-attached");
            // A rotated output needs its own rotation handling; refuse instead of guessing.
            if (desc.Rotation != MODE_ROTATION_IDENTITY) throw new Exception("unsupported-rotation");
            if (desc.Desktop.Left != initial.Monitor.Left || desc.Desktop.Top != initial.Monitor.Top) throw new Exception("output-origin-mismatch");

            uint featureLevel;
            Marshal.ThrowExceptionForHR(D3D11CreateDevice(adapter, 0, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out device, out featureLevel, out context));
            var output5Iid = new Guid("80a07424-ab52-42eb-833c-0c42fd282d98"); // IID_IDXGIOutput5
            Marshal.ThrowExceptionForHR(Marshal.QueryInterface(output, ref output5Iid, out output1));
            IntPtr formats = Marshal.AllocHGlobal(4);
            try {
                Marshal.WriteInt32(formats, (int)FORMAT_B8G8R8A8_UNORM);
                int duplicate = Method<DuplicateOutput1>(output1, 26)(output1, device, 0, 1, formats, out duplication);
                if (duplicate != 0 || duplication == IntPtr.Zero) throw new Exception("duplication-unavailable:0x" + duplicate.ToString("X8"));
            } finally { Marshal.FreeHGlobal(formats); }

            var stagingDesc = new TextureDesc { Width = (uint)width, Height = (uint)height, MipLevels = 1, ArraySize = 1,
                Format = FORMAT_B8G8R8A8_UNORM, SampleCount = 1, Usage = 3, CPUAccessFlags = 0x20000 };
            Marshal.ThrowExceptionForHR(Method<CreateTexture>(device, 5)(device, ref stagingDesc, IntPtr.Zero, out staging));
            var copy = Method<CopyRegion>(context, 46); var map = Method<MapTexture>(context, 14); var unmap = Method<UnmapTexture>(context, 15);
            var deviceStatus = Method<DeviceStatus>(device, 39);
            var acquire = Method<AcquireNextFrame>(duplication, 8); var releaseFrame = Method<ReleaseFrame>(duplication, 14);
            var textureIid = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c"); // IID_ID3D11Texture2D
            var box = new Box { Left = (uint)(x - desc.Desktop.Left), Top = (uint)(y - desc.Desktop.Top),
                Right = (uint)(x - desc.Desktop.Left + width), Bottom = (uint)(y - desc.Desktop.Top + height), Back = 1 };
            Console.Error.WriteLine("dxgi-capture ready region=" + width + "x" + height + " pointerPolicy=separate-only");

            string desktopName = DesktopName(GetThreadDesktop(GetCurrentThreadId()));
            IntPtr frameInfoBuffer = Marshal.AllocHGlobal(256);
            try {
                for (int i = 0; i < 256; i++) Marshal.WriteByte(frameInfoBuffer, i, 0);
                var rgba = new byte[checked(width * height * 4)];
                uint sequence = 0; bool haveFrame = false, pointerKnown = false, pointerSeparate = false;
                uint surfaceWidth = 0, surfaceHeight = 0;
                int command;
                while ((command = input.ReadByte()) >= 0 && command != 81) {
                    if (command != 78) throw new Exception("invalid-command");
                    CheckInputDesktop(desktopName);
                    Marshal.ThrowExceptionForHR(deviceStatus(device));
                    CheckOutput(output, monitor, initial);

                    IntPtr resource = IntPtr.Zero;
                    int acquireHr = acquire(duplication, haveFrame ? 50u : 250u, frameInfoBuffer, out resource);
                    if (acquireHr == DXGI_ERROR_WAIT_TIMEOUT) {
                        if (!haveFrame) {
                            // The first frame gets a bounded overall budget; never ship an empty frame.
                            var deadline = DateTime.UtcNow.AddSeconds(8);
                            while (DateTime.UtcNow < deadline) {
                                acquireHr = acquire(duplication, 250, frameInfoBuffer, out resource);
                                if (acquireHr != DXGI_ERROR_WAIT_TIMEOUT) break;
                            }
                            if (acquireHr == DXGI_ERROR_WAIT_TIMEOUT) throw new Exception("first-frame-timeout");
                        } else {
                            Console.Error.WriteLine("frame seq=" + sequence + " flags=0 reason=wait-timeout");
                            Write(stdout, width, height, sequence, false, null);
                            continue;
                        }
                    }
                    if (acquireHr == DXGI_ERROR_ACCESS_LOST) throw new Exception("capture-access-lost");
                    if (acquireHr != 0) throw new Exception("acquire-failed:0x" + acquireHr.ToString("X8"));

                    try {
                        var info = (FrameInfo)Marshal.PtrToStructure(frameInfoBuffer, typeof(FrameInfo));
                        if (info.ProtectedContentMaskedOut != 0) throw new Exception("protected-content-masked");
                        if (info.LastMouseUpdateTime != 0) { pointerKnown = true; pointerSeparate = info.PointerPosition.Visible != 0; }
                        if (!pointerKnown || !pointerSeparate) throw new Exception("pointer-not-verifiably-separate");
                        if (info.TotalMetadataBufferSize > 100000000u || info.PointerShapeBufferSize > 65536u) throw new Exception("frame-info-invalid");
                        Marshal.ThrowExceptionForHR(Marshal.QueryInterface(resource, ref textureIid, out texture));
                        TextureDesc surface;
                        Method<GetTextureDesc>(texture, 10)(texture, out surface); // void ID3D11Texture2D::GetDesc
                        if (surface.Format != FORMAT_B8G8R8A8_UNORM) throw new Exception("unsupported-format:" + surface.Format);
                        if (!haveFrame) { surfaceWidth = surface.Width; surfaceHeight = surface.Height; }
                        else if (surface.Width != surfaceWidth || surface.Height != surfaceHeight) throw new Exception("resolution-changed");
                        if (box.Right > surface.Width || box.Bottom > surface.Height) throw new Exception("region-outside-output");

                        copy(context, staging, 0, 0, 0, 0, texture, 0, ref box);
                        Mapped mapped; Marshal.ThrowExceptionForHR(map(context, staging, 0, 1, 0, out mapped));
                        try {
                            if (mapped.Data == IntPtr.Zero || mapped.RowPitch < (uint)width * 4 || mapped.RowPitch > int.MaxValue) throw new Exception("invalid-row-pitch");
                            for (int row = 0; row < height; row++) Marshal.Copy(IntPtr.Add(mapped.Data, checked(row * (int)mapped.RowPitch)), rgba, row * width * 4, width * 4);
                        } finally { unmap(context, staging, 0); }
                        for (int i = 0; i < rgba.Length; i += 4) { byte b = rgba[i]; rgba[i] = rgba[i + 2]; rgba[i + 2] = b; rgba[i + 3] = 255; }
                    } finally {
                        int released = releaseFrame(duplication);
                        Release(ref texture);
                        Release(ref resource);
                        Marshal.ThrowExceptionForHR(released);
                    }
                    CheckInputDesktop(desktopName); CheckOutput(output, monitor, initial);
                    Marshal.ThrowExceptionForHR(deviceStatus(device));
                    haveFrame = true; sequence = checked(sequence + 1);
                    Write(stdout, width, height, sequence, true, rgba);
                }
                return 0;
            } finally { if (frameInfoBuffer != IntPtr.Zero) Marshal.FreeHGlobal(frameInfoBuffer); }
        } catch (Exception error) {
            Console.Error.WriteLine("capture-helper:" + error.GetType().Name + ":" + error.Message);
            return 1;
        } finally {
            if (duplication != IntPtr.Zero) { Marshal.Release(duplication); duplication = IntPtr.Zero; }
            if (staging != IntPtr.Zero) { Marshal.Release(staging); staging = IntPtr.Zero; }
            if (output1 != IntPtr.Zero) { Marshal.Release(output1); output1 = IntPtr.Zero; }
            if (output != IntPtr.Zero) { Marshal.Release(output); output = IntPtr.Zero; }
            if (adapter != IntPtr.Zero) { Marshal.Release(adapter); adapter = IntPtr.Zero; }
            if (factory != IntPtr.Zero) { Marshal.Release(factory); factory = IntPtr.Zero; }
            if (context != IntPtr.Zero) { Marshal.Release(context); context = IntPtr.Zero; }
            if (device != IntPtr.Zero) { Marshal.Release(device); device = IntPtr.Zero; }
        }
    }
}
