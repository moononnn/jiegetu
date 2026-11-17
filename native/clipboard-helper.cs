// Clipboard helper for 截个图: capture whitelisted clipboard formats, and publish prepared payloads.
// No polling of big images, no visible window, no network, no file deletion outside our own spool.
// --watch 常驻 STA 消息窗口，注册 AddClipboardFormatListener，按需暂停/恢复监听。
// --publish 单次模式：只发布，不注册监听（禁用记录后仍可从历史复制）。
// --self-test 只用内存 DataObject 与合成图，绝不访问系统剪贴板、绝不安装 hook。
using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class ClipboardHelper {
    const int ProtocolVersion = 1;
    const int MaxJsonBytes = 64 * 1024;
    const int MaxTextBytes = 16 * 1024 * 1024;
    const int MaxRawTotal = 256 * 1024 * 1024;
    const int MaxImageBytes = 148 * 1024 * 1024;
    const int MaxEdge = 30000;
    const long MaxPixels = 36000000;
    const int MaxFileItems = 1024;
    const int MaxFileChars = 262144;
    const int WM_CLIPBOARDUPDATE = 0x031D;
    const int WM_APP = 0x8000;

    // Win32 clipboard formats
    const uint CF_TEXT_ID = 1, CF_DIB_ID = 8, CF_UNICODETEXT_ID = 13, CF_HDROP_ID = 15, CF_DIBV5_ID = 17;
    static readonly object OutLock = new object();
    static string SpoolRoot;
    static bool Stopped;
    static MsgWindow Window;
    static bool Listening;
    // 来源排除：规范化后的进程名（小写、不带 .exe）。在写 spool 之前就挡掉。
    static readonly List<string> ExcludedApps = new List<string>();
    static string NormalizeProcessName(string value) {
        if (value == null) return "";
        string text = value.Trim().ToLowerInvariant();
        if (text.EndsWith(".exe")) text = text.Substring(0, text.Length - 4);
        return text;
    }
    static string ProcessNameOf(uint pid) {
        if (pid == 0) return "";
        IntPtr handle = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
        if (handle == IntPtr.Zero) return "";
        try {
            uint size = 1024;
            StringBuilder buffer = new StringBuilder(1024);
            if (!QueryFullProcessImageName(handle, 0, buffer, ref size)) return "";
            string full = buffer.ToString();
            int slash = full.LastIndexOf('\\');
            string name = slash >= 0 ? full.Substring(slash + 1) : full;
            int dot = name.LastIndexOf('.');
            if (dot > 0) name = name.Substring(0, dot);
            return NormalizeProcessName(name);
        } finally { CloseHandle(handle); }
    }
    static bool IsExcludedProcess(uint pid) {
        if (ExcludedApps.Count == 0 || pid == 0) return false;
        string name = ProcessNameOf(pid);
        if (name.Length == 0) return false;
        return ExcludedApps.Contains(name);
    }
    // 自身写入的抑制区间：发布前后各取一次序列号，区间内的事件不记。
    static uint OwnSeqStart = 0, OwnSeqEnd = 0;
    static uint OwnPid = 0;

    [StructLayout(LayoutKind.Sequential)] struct BITMAPINFOHEADER {
        public uint biSize; public int biWidth, biHeight; public ushort biPlanes, biBitCount;
        public uint biCompression, biSizeImage; public int biXPelsPerMeter, biYPelsPerMeter;
        public uint biClrUsed, biClrImportant;
    }

    [DllImport("user32.dll")] static extern IntPtr GetClipboardOwner();
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] static extern bool AddClipboardFormatListener(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool RemoveClipboardFormatListener(IntPtr hwnd);
    [DllImport("user32.dll")] static extern ushort RegisterClipboardFormat(string name);
    [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] static extern bool CloseClipboard();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr SetActiveWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    // 未公开但长期可用的前台切换；SetForegroundWindow 被系统拒绕时当兼底。
    [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr hwnd, bool altTab);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, int msg, IntPtr w, IntPtr l);
    // 来源排除：读 owner 进程的可执行名，在写 spool 之前就判断，不让被排除的内容落盘。
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClipboardFormatName(uint format, StringBuilder name, int max);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr handle);
    [DllImport("kernel32.dll")] static extern uint GlobalSize(IntPtr handle);
    [DllImport("shell32.dll")] static extern uint DragQueryFile(IntPtr hDrop, uint index, StringBuilder name, uint size);

    // —— 输出：窄 JSONL，单行，错误只回安全码 ——
    static void Emit(string json) {
        lock (OutLock) { Console.Out.WriteLine(json); Console.Out.Flush(); }
    }
    static string Esc(string text) {
        if (text == null) return "";
        StringBuilder builder = new StringBuilder(text.Length + 8);
        foreach (char c in text) {
            if (c == '"') builder.Append("\\\"");
            else if (c == '\\') builder.Append("\\\\");
            else if (c == '\n') builder.Append("\\n");
            else if (c == '\r') builder.Append("\\r");
            else if (c == '\t') builder.Append("\\t");
            else if (c < 32) builder.Append("\\u").Append(((int)c).ToString("x4"));
            else builder.Append(c);
        }
        return builder.ToString();
    }
    static void EmitError(int id, string code) {
        Emit("{\"v\":" + ProtocolVersion + ",\"id\":" + id + ",\"ok\":false,\"code\":\"" + Esc(code) + "\"}");
    }
    static void EmitOk(int id, string extra) {
        Emit("{\"v\":" + ProtocolVersion + ",\"id\":" + id + ",\"ok\":true" + (extra == null ? "" : "," + extra) + "}");
    }

    // —— spool：只认 main 提供的本次运行私有目录；文件名为随机 GUID ——
    static string SpoolPath(string name) {
        if (name == null || name.Length < 5 || name.Length > 80 || name.IndexOf('/') >= 0 || name.IndexOf('\\') >= 0) return null;
        string full = Path.GetFullPath(Path.Combine(SpoolRoot, name));
        if (!String.Equals(Path.GetDirectoryName(full), SpoolRoot, StringComparison.OrdinalIgnoreCase)) return null;
        return full;
    }
    static string WriteSpool(byte[] bytes, string extension) {
        string name = DateTime.UtcNow.Ticks.ToString("x") + "-" + Guid.NewGuid().ToString("N") + extension;
        string full = Path.Combine(SpoolRoot, name);
        FileStream stream = new FileStream(full, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        try { stream.Write(bytes, 0, bytes.Length); }
        finally { stream.Dispose(); }
        return name;
    }
    static void EnsureSpool(string root) {
        if (root == null || root.Length < 3) throw new InvalidDataException();
        string full = Path.GetFullPath(root);
        if (!Path.IsPathRooted(full)) throw new InvalidDataException();
        if ((File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException();
        SpoolRoot = full;
    }

    // —— 护栏 ——
    static void RequireImage(int width, int height) {
        if (width < 1 || height < 1 || width > MaxEdge || height > MaxEdge || (long)width * height > MaxPixels) throw new InvalidDataException();
    }
    static bool PngSize(byte[] bytes, out int width, out int height) {
        width = height = 0;
        if (bytes == null || bytes.Length < 33 || bytes[0] != 0x89 || bytes[1] != 0x50 || bytes[2] != 0x4E || bytes[3] != 0x47) return false;
        if (ReadUIntBE(bytes, 8) != 13 || Encoding.ASCII.GetString(bytes, 12, 4) != "IHDR") return false;
        width = (int)ReadUIntBE(bytes, 16); height = (int)ReadUIntBE(bytes, 20);
        try { RequireImage(width, height); } catch (InvalidDataException) { return false; }
        return true;
    }
    static uint ReadUIntBE(byte[] bytes, int offset) {
        return ((uint)bytes[offset] << 24) | ((uint)bytes[offset + 1] << 16) | ((uint)bytes[offset + 2] << 8) | (uint)bytes[offset + 3];
    }
    static uint ReadUIntLE(byte[] bytes, int offset) {
        return (uint)bytes[offset] | ((uint)bytes[offset + 1] << 8) | ((uint)bytes[offset + 2] << 16) | ((uint)bytes[offset + 3] << 24);
    }
    static void WriteUIntLE(byte[] bytes, int offset, uint value) {
        bytes[offset] = (byte)(value & 0xFF);
        bytes[offset + 1] = (byte)((value >> 8) & 0xFF);
        bytes[offset + 2] = (byte)((value >> 16) & 0xFF);
        bytes[offset + 3] = (byte)((value >> 24) & 0xFF);
    }
    // 只发 "PNG"/"image/png" 时，Chromium 系能贴，微信/画图/Office 这类读 CF_DIB 的程序贴不上。
    // 所以发布前额外转一份 24 位 DIB（白底、bottom-up、无调色板），让通用粘贴也能认。
    static byte[] PngToDib(byte[] png) {
        if (png == null || png.Length < 33) return null;
        try {
            using (MemoryStream input = new MemoryStream(png, false))
            using (Bitmap source = new Bitmap(input))
            using (Bitmap flat = new Bitmap(source.Width, source.Height, PixelFormat.Format24bppRgb)) {
                using (Graphics canvas = Graphics.FromImage(flat)) {
                    canvas.Clear(Color.White);
                    canvas.DrawImage(source, new Rectangle(0, 0, source.Width, source.Height));
                }
                int width = flat.Width;
                int height = flat.Height;
                int stride = ((width * 24 + 31) / 32) * 4;
                long required = 40L + (long)stride * height;
                if (width < 1 || height < 1 || required <= 40 || required > MaxImageBytes) return null;
                BitmapData bits = flat.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
                try {
                    byte[] dib = new byte[(int)required];
                    WriteUIntLE(dib, 0, 40);
                    WriteUIntLE(dib, 4, (uint)width);
                    WriteUIntLE(dib, 8, (uint)height);
                    dib[12] = 1; dib[13] = 0;
                    dib[14] = 24; dib[15] = 0;
                    WriteUIntLE(dib, 20, (uint)(stride * height));
                    int rowBytes = Math.Min(stride, bits.Stride);
                    for (int y = 0; y < height; y++) {
                        IntPtr row = new IntPtr(bits.Scan0.ToInt64() + (long)(height - 1 - y) * bits.Stride);
                        Marshal.Copy(row, dib, 40 + y * stride, rowBytes);
                    }
                    return dib;
                } finally {
                    flat.UnlockBits(bits);
                }
            }
        } catch (Exception) {
            return null;
        }
    }
    static bool DibSize(byte[] bytes, out int width, out int height) {
        width = height = 0;
        if (bytes == null || bytes.Length < 40) return false;
        BITMAPINFOHEADER header = ReadDibHeader(bytes);
        if (header.biSize < 40 || header.biSize > 124) return false;
        width = header.biWidth; height = header.biHeight < 0 ? -header.biHeight : header.biHeight;
        if (width < 1 || height < 1) return false;
        try { RequireImage(width, height); } catch (InvalidDataException) { return false; }
        // 64 位算所需字节：头 + 调色板 + stride*rows，溢出即拒。
        long bpp = header.biBitCount;
        if (bpp != 1 && bpp != 4 && bpp != 8 && bpp != 16 && bpp != 24 && bpp != 32) return false;
        long palette = header.biClrUsed != 0 ? (long)header.biClrUsed : (bpp <= 8 ? (1L << (int)bpp) : 0);
        long masks = header.biCompression == 3 ? 12 : 0;
        long stride = (((long)header.biWidth * bpp + 31) / 32) * 4;
        long required = (long)header.biSize + masks + palette * 4 + stride * height;
        return required <= bytes.Length && required > 0;
    }
    static BITMAPINFOHEADER ReadDibHeader(byte[] bytes) {
        BITMAPINFOHEADER header = new BITMAPINFOHEADER();
        header.biSize = ReadUIntLE(bytes, 0);
        header.biWidth = (int)ReadUIntLE(bytes, 4);
        header.biHeight = (int)ReadUIntLE(bytes, 8);
        header.biPlanes = (ushort)(bytes[12] | (bytes[13] << 8));
        header.biBitCount = (ushort)(bytes[14] | (bytes[15] << 8));
        header.biCompression = ReadUIntLE(bytes, 16);
        header.biSizeImage = ReadUIntLE(bytes, 20);
        header.biClrUsed = ReadUIntLE(bytes, 32);
        return header;
    }
    // DIB 包成 BMP 文件头再交给 GDI+，只为生成预览/工作台用的 PNG 副本；原件字节仍然原样保存。
    static Bitmap DibToBitmap(byte[] dib) {
        BITMAPINFOHEADER header = ReadDibHeader(dib);
        int masks = header.biCompression == 3 ? 12 : 0;
        int paletteEntries = header.biClrUsed != 0 ? (int)header.biClrUsed : (header.biBitCount <= 8 ? (1 << header.biBitCount) : 0);
        int offset = 14 + (int)header.biSize + masks + paletteEntries * 4;
        MemoryStream bmp = new MemoryStream();
        byte[] fileHeader = new byte[14];
        fileHeader[0] = (byte)'B'; fileHeader[1] = (byte)'M';
        WriteUInt(fileHeader, 2, (uint)(offset + (dib.Length - (int)header.biSize - masks - paletteEntries * 4)));
        WriteUInt(fileHeader, 10, (uint)offset);
        bmp.Write(fileHeader, 0, 14);
        bmp.Write(dib, 0, dib.Length);
        bmp.Position = 0;
        return new Bitmap(bmp);
    }
    static void WriteUInt(byte[] bytes, int offset, uint value) {
        bytes[offset] = (byte)(value & 255); bytes[offset + 1] = (byte)((value >> 8) & 255);
        bytes[offset + 2] = (byte)((value >> 16) & 255); bytes[offset + 3] = (byte)((value >> 24) & 255);
    }

    // —— 读剪贴板 ——
    static byte[] ReadHandleData(IntPtr handle) {
        if (handle == IntPtr.Zero) return null;
        uint size = GlobalSize(handle);
        if (size == 0 || size > MaxImageBytes) return null;
        IntPtr data = GlobalLock(handle);
        if (data == IntPtr.Zero) return null;
        try {
            byte[] bytes = new byte[(int)size];
            Marshal.Copy(data, bytes, 0, bytes.Length);
            return bytes;
        } finally { GlobalUnlock(handle); }
    }
    static string ReadUnicodeText(IntPtr handle) {
        if (handle == IntPtr.Zero) return null;
        uint size = GlobalSize(handle);
        if (size == 0 || size > MaxTextBytes) return null;
        IntPtr data = GlobalLock(handle);
        if (data == IntPtr.Zero) return null;
        try {
            // 末尾可能是 \0；只取到第一个 NUL 之前，剩下的字节不伪造。
            byte[] bytes = new byte[(int)size];
            Marshal.Copy(data, bytes, 0, bytes.Length);
            int end = 0;
            while (end + 1 < bytes.Length && !(bytes[end] == 0 && bytes[end + 1] == 0)) end += 2;
            return Encoding.Unicode.GetString(bytes, 0, end);
        } finally { GlobalUnlock(handle); }
    }
    static bool IsIgnoredBySystem() {
        // CanIncludeInClipboardHistory=0 与 ExcludeClipboardContentFromMonitorProcessing 都不记。
        ushort canInclude = RegisterClipboardFormat("CanIncludeInClipboardHistory");
        if (IsClipboardFormatAvailable(canInclude)) {
            byte[] bytes = ReadHandleData(GetClipboardData(canInclude));
            if (bytes != null && bytes.Length >= 4 && ReadUIntLE(bytes, 0) == 0) return true;
        }
        ushort exclude = RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing");
        if (IsClipboardFormatAvailable(exclude)) return true;
        ushort viewerIgnore = RegisterClipboardFormat("ClipboardViewerIgnore");
        if (IsClipboardFormatAvailable(viewerIgnore)) return true;
        return false;
    }

    // 打开剪贴板有界重试：锁被占用就等，序列变了就整个丢弃，不拼接两次快照。
    static bool OpenWithRetry(out uint sequence) {
        sequence = 0;
        for (int attempt = 0; attempt < 5; attempt++) {
            uint before = GetClipboardSequenceNumber();
            if (OpenClipboard(IntPtr.Zero)) {
                uint after = GetClipboardSequenceNumber();
                if (before != after) { CloseClipboard(); continue; }
                sequence = after;
                return true;
            }
            Thread.Sleep(100);
        }
        return false;
    }

    static void CaptureClipboard() {
        uint seq = 0;
        if (!OpenWithRetry(out seq)) return;
        bool ignored = false;
        IntPtr owner = IntPtr.Zero;
        List<string[]> parts = new List<string[]>();
        try {
            if (seq >= OwnSeqStart && seq <= OwnSeqEnd && OwnSeqStart != 0) return; // 自身写入，抑制
            owner = GetClipboardOwner();
            uint pid = 0;
            if (owner != IntPtr.Zero) GetWindowThreadProcessId(owner, out pid);
            if (pid != 0 && pid == OwnPid) return; // 自己就是 owner（发布时的兜底抑制）
            // 来源排除在写 spool 之前判：被排除的内容不落盘，也不发事件。
            if (pid != 0 && IsExcludedProcess(pid)) return;
            ignored = IsIgnoredBySystem();
            if (!ignored) {
                string text = null;
                ushort htmlFormat = RegisterClipboardFormat("HTML Format");
                ushort rtfFormat = RegisterClipboardFormat("Rich Text Format");
                ushort pngFormat = RegisterClipboardFormat("PNG");
                if (IsClipboardFormatAvailable(CF_UNICODETEXT_ID)) {
                    byte[] textBytes = ReadHandleData(GetClipboardData(CF_UNICODETEXT_ID));
                    if (textBytes != null && textBytes.Length > 0) {
                        // CF_UNICODETEXT 原样保存 UTF-16LE 字节，复制时能按原格式还原。
                        string name = WriteSpool(textBytes, ".txt");
                        parts.Add(new string[] { "text", name, textBytes.Length.ToString() });
                        text = ReadUnicodeText(GetClipboardData(CF_UNICODETEXT_ID));
                    }
                }
                if (IsClipboardFormatAvailable(htmlFormat)) {
                    byte[] htmlBytes = ReadHandleData(GetClipboardData(htmlFormat));
                    if (htmlBytes != null && htmlBytes.Length > 0 && htmlBytes.Length <= MaxTextBytes) {
                        string name = WriteSpool(htmlBytes, ".html");
                        parts.Add(new string[] { "html", name, htmlBytes.Length.ToString() });
                    }
                }
                if (IsClipboardFormatAvailable(rtfFormat)) {
                    byte[] rtfBytes = ReadHandleData(GetClipboardData(rtfFormat));
                    if (rtfBytes != null && rtfBytes.Length > 0 && rtfBytes.Length <= MaxTextBytes) {
                        string name = WriteSpool(rtfBytes, ".rtf");
                        parts.Add(new string[] { "rtf", name, rtfBytes.Length.ToString() });
                    }
                }
                bool hasImage = false;
                int width = 0, height = 0;
                if (IsClipboardFormatAvailable(pngFormat)) {
                    byte[] pngBytes = ReadHandleData(GetClipboardData(pngFormat));
                    if (pngBytes != null && pngBytes.Length > 0 && pngBytes.Length <= MaxImageBytes && PngSize(pngBytes, out width, out height)) {
                        string name = WriteSpool(pngBytes, ".png");
                        parts.Add(new string[] { "png", name, pngBytes.Length.ToString() });
                        hasImage = true;
                    }
                }
                if (!hasImage && (IsClipboardFormatAvailable(CF_DIB_ID) || IsClipboardFormatAvailable(CF_DIBV5_ID))) {
                    uint format = IsClipboardFormatAvailable(CF_DIB_ID) ? CF_DIB_ID : CF_DIBV5_ID;
                    byte[] dibBytes = ReadHandleData(GetClipboardData(format));
                    int dibWidth = 0, dibHeight = 0;
                    if (dibBytes != null && dibBytes.Length > 0 && dibBytes.Length <= MaxImageBytes && DibSize(dibBytes, out dibWidth, out dibHeight)) {
                        string name = WriteSpool(dibBytes, ".dib");
                        parts.Add(new string[] { "dib", name, dibBytes.Length.ToString() });
                        width = dibWidth; height = dibHeight;
                        hasImage = true;
                        // 预览/工作台用的 PNG 副本：转换失败就不给 png，明确不假装成功。
                        try {
                            using (Bitmap bitmap = DibToBitmap(dibBytes)) {
                                MemoryStream png = new MemoryStream();
                                bitmap.Save(png, ImageFormat.Png);
                                byte[] pngBytes = png.ToArray();
                                if (pngBytes.Length > 0 && pngBytes.Length <= MaxImageBytes) {
                                    string copy = WriteSpool(pngBytes, ".png");
                                    parts.Add(new string[] { "png", copy, pngBytes.Length.ToString() });
                                }
                            }
                        } catch (Exception) { /* PNG 副本失败：只保留 DIB 原件。 */ }
                    }
                }
                if (IsClipboardFormatAvailable(CF_HDROP_ID)) {
                    IntPtr drop = GetClipboardData(CF_HDROP_ID);
                    if (drop != IntPtr.Zero) {
                        uint count = DragQueryFile(drop, 0xFFFFFFFF, null, 0);
                        if (count > 0) {
                            if (count > MaxFileItems) ignored = true;
                            else {
                                List<string> paths = new List<string>();
                                int chars = 0;
                                for (uint index = 0; index < count; index++) {
                                    StringBuilder name = new StringBuilder(4096);
                                    if (DragQueryFile(drop, index, name, (uint)name.Capacity) == 0) break;
                                    paths.Add(name.ToString());
                                    chars += name.Length + 1;
                                    if (chars > MaxFileChars) break;
                                }
                                if (chars > MaxFileChars) ignored = true;
                                else {
                                    byte[] list = Encoding.UTF8.GetBytes(String.Join("\r\n", paths.ToArray()));
                                    string name = WriteSpool(list, ".files");
                                    parts.Add(new string[] { "files", name, list.Length.ToString() });
                                }
                            }
                        }
                    }
                }
                // 总量闸：所有已写 spool 的字节数不超过 256MiB，超了整条不收。
                long total = 0;
                foreach (string[] part in parts) total += long.Parse(part[2]);
                if (total > MaxRawTotal) { parts.Clear(); ignored = true; }
                if (parts.Count == 0 && text == null) ignored = true;
            }
        } finally { CloseClipboard(); }

        StringBuilder json = new StringBuilder();
        json.Append("{\"v\":").Append(ProtocolVersion).Append(",\"event\":\"clip\",\"seq\":").Append(seq);
        json.Append(",\"excluded\":").Append(ignored ? "true" : "false");
        json.Append(",\"source\":{");
        string processName = "";
        uint ownerPid = 0;
        if (owner != IntPtr.Zero) GetWindowThreadProcessId(owner, out ownerPid);
        if (ownerPid != 0) {
            try { processName = System.Diagnostics.Process.GetProcessById((int)ownerPid).ProcessName; } catch (Exception) { processName = ""; }
        }
        json.Append("\"name\":\"").Append(Esc(processName == null ? "" : processName)).Append("\",\"pid\":").Append(ownerPid).Append("}");
        json.Append(",\"formats\":[");
        for (int i = 0; i < parts.Count; i++) {
            if (i > 0) json.Append(',');
            // 事件只给 spool 文件名，不给绝对路径。
            json.Append("{\"format\":\"").Append(Esc(parts[i][0])).Append("\",\"file\":\"").Append(Esc(parts[i][1]))
                .Append("\",\"size\":").Append(parts[i][2]).Append("}");
        }
        json.Append("]}");
        Emit(json.ToString());
    }

    // —— 发布 ——
    // JavaScriptSerializer 反序列化 JSON 数组时给的是 ArrayList（既不是 List<object> 也不是 object[]）；
    // 常驻命令的 entries、文件列表的 paths 都走这里，避免 "as List<object>" 静默变成 null。
    static List<object> AsList(object raw) {
        List<object> list = raw as List<object>;
        if (list != null) return list;
        object[] array = raw as object[];
        if (array != null) return new List<object>(array);
        System.Collections.IEnumerable sequence = raw as System.Collections.IEnumerable;
        if (sequence != null && !(raw is string)) {
            List<object> converted = new List<object>();
            foreach (object item in sequence) converted.Add(item);
            return converted;
        }
        return null;
    }

    static bool Publish(List<Dictionary<string, object>> entries) {
        DataObject data = new DataObject();
        foreach (Dictionary<string, object> entry in entries) {
            string format = entry.ContainsKey("format") ? Convert.ToString(entry["format"]) : "";
            string file = entry.ContainsKey("file") ? Convert.ToString(entry["file"]) : null;
            if (format == "files") {
                object raw = entry.ContainsKey("paths") ? entry["paths"] : null;
                List<object> list = AsList(raw);
                if (list == null) return false;
                StringCollection collection = new StringCollection();
                foreach (object item in list) {
                    string path = Convert.ToString(item);
                    if (path == null || path.Length < 3 || path.Length > 4096) return false;
                    collection.Add(path);
                }
                if (collection.Count == 0 || collection.Count > MaxFileItems) return false;
                data.SetFileDropList(collection);
                data.SetData("Preferred DropEffect", false, new MemoryStream(new byte[] { 1, 0, 0, 0 }, false));
                continue;
            }
            string full = SpoolPath(file);
            if (full == null) return false;
            FileInfo info = new FileInfo(full);
            if (!info.Exists) return false;
            FileAttributes attributes = info.Attributes;
            if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) return false;
            if (info.Length < 1 || info.Length > MaxImageBytes) return false;
            byte[] bytes = new byte[(int)info.Length];
            using (FileStream stream = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                int offset = 0;
                while (offset < bytes.Length) {
                    int read = stream.Read(bytes, offset, bytes.Length - offset);
                    if (read == 0) return false;
                    offset += read;
                }
            }
            if (format == "text") {
                // 契约：text 负载是 CF_UNICODETEXT 原字节（UTF-16LE，尾部可有终止符）。
                // 发布时去掉终止符，避免把 \0 写进字符串；内容本身逐字保留。
                data.SetData(DataFormats.UnicodeText, false, Encoding.Unicode.GetString(bytes).TrimEnd(new char[] { '\0' }));
            } else if (format == "html") {
                data.SetData("HTML Format", false, new MemoryStream(bytes, false));
            } else if (format == "rtf") {
                data.SetData(DataFormats.Rtf, false, new MemoryStream(bytes, false));
            } else if (format == "png") {
                int width, height;
                if (!PngSize(bytes, out width, out height)) return false;
                data.SetData("PNG", false, new MemoryStream(bytes, false));
                data.SetData("image/png", false, new MemoryStream(bytes, false));
                // 补一份通用 DIB：很多程序粘贴图片只读 CF_DIB/CF_BITMAP，看不到 "PNG"。
                byte[] dib = PngToDib(bytes);
                if (dib != null) data.SetData(DataFormats.Dib, false, new MemoryStream(dib, false));
            } else if (format == "dib") {
                int width, height;
                if (!DibSize(bytes, out width, out height)) return false;
                data.SetData(DataFormats.Dib, false, new MemoryStream(bytes, false));
            } else if (format == "gif") {
                // 现有 GIF 复制的负载：原始文件格式，不拿首帧冒充动图。
                data.SetData("GIF", false, new MemoryStream(bytes, false));
                data.SetData("image/gif", false, new MemoryStream(bytes, false));
            } else return false;
        }
        if (data.GetFormats(false).Length == 0) return false;
        uint before = GetClipboardSequenceNumber();
        Clipboard.SetDataObject(data, true, 10, 100);
        uint after = GetClipboardSequenceNumber();
        OwnSeqStart = before; OwnSeqEnd = after;
        return true;
    }

    // 目标窗口失效/权限不允许时只回 false，不盲发 Ctrl+V。
    // 把目标窗口真拿到前台。后台进程单靠 SetForegroundWindow 常被前台锁拒绕，所以分三步：
    // 附到当前前台线程的输入队列 → 模拟一下 Alt 解除前台锁 → 置顶 + SwitchToThisWindow 兼底。
    static bool FocusWindow(IntPtr hwnd, out bool restored) {
        restored = false;
        if (!IsWindow(hwnd)) return false;
        if (IsIconic(hwnd)) ShowWindow(hwnd, 9 /* SW_RESTORE */);
        else if (!IsWindowVisible(hwnd)) ShowWindow(hwnd, 5 /* SW_SHOW */);
        if (GetForegroundWindow() == hwnd) return true;
        uint ignored;
        uint targetThread = GetWindowThreadProcessId(hwnd, out ignored);
        IntPtr foreground = GetForegroundWindow();
        uint foregroundThread = foreground == IntPtr.Zero ? 0u : GetWindowThreadProcessId(foreground, out ignored);
        bool attached = false;
        try {
            if (foregroundThread != 0 && targetThread != 0 && foregroundThread != targetThread) {
                attached = AttachThreadInput(foregroundThread, targetThread, true);
            }
            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);
            SetActiveWindow(hwnd);
        } finally {
            if (attached) AttachThreadInput(foregroundThread, targetThread, false);
        }
        if (GetForegroundWindow() == hwnd) return true;
        // 系统认为“不是用户在操作”时会锁前台；模拟一次 Alt 能把这个判断刷一下。
        keybd_event((byte)0x12, (byte)0, 0, UIntPtr.Zero);
        keybd_event((byte)0x12, (byte)0, 2, UIntPtr.Zero);
        Thread.Sleep(40);
        SetForegroundWindow(hwnd);
        if (GetForegroundWindow() == hwnd) return true;
        SetWindowPos(hwnd, IntPtr.Zero /* HWND_TOP */, 0, 0, 0, 0, 0x0001 | 0x0002 /* NOSIZE|NOMOVE */);
        SwitchToThisWindow(hwnd, true);
        Thread.Sleep(80);
        if (GetForegroundWindow() == hwnd) return true;
        // 最后一招：最小化再还原。窗口会闪一下，但能让系统重新把它当“刚被切的窗口”。
        restored = true;
        ShowWindow(hwnd, 6 /* SW_MINIMIZE */);
        Thread.Sleep(70);
        ShowWindow(hwnd, 9 /* SW_RESTORE */);
        Thread.Sleep(90);
        SetForegroundWindow(hwnd);
        return GetForegroundWindow() == hwnd;
    }

    // 定向粘贴：返回失败原因，好让上层区分“窗口没了”和“抢不到前台”。
    static string PasteTo(long hwndValue, long pidValue) {
        if (hwndValue <= 0 || pidValue <= 0) return "invalid";
        IntPtr hwnd = new IntPtr(hwndValue);
        if (!IsWindow(hwnd)) return "not-window";
        uint pid = 0;
        GetWindowThreadProcessId(hwnd, out pid);
        if (pid == 0 || pid != (uint)pidValue) return "pid-mismatch";
        if (pid == (uint)OwnPid) return "self";
        for (int attempt = 0; attempt < 3; attempt++) {
            bool restored = false;
            if (!FocusWindow(hwnd, out restored)) { Thread.Sleep(60); continue; }
            // 刚还原的窗口还需要一点时间把焦点落到子控件上，等短了就丢键（第一次就是这样丢的）。
            Thread.Sleep(restored ? 360 : 60);
            // 等修饰键释放后再发，不等就可能在历史窗里替用户按住 Ctrl。
            Thread.Sleep(60);
            keybd_event((byte)0x11, (byte)0, 0, UIntPtr.Zero);
            keybd_event((byte)0x56, (byte)0, 0, UIntPtr.Zero);
            keybd_event((byte)0x56, (byte)0, 2, UIntPtr.Zero);
            keybd_event((byte)0x11, (byte)0, 2, UIntPtr.Zero);
            return restored ? "ok-restored" : "ok";
        }
        return "no-foreground";
    }

    // —— 消息窗口 ——
    class MsgWindow : NativeWindow {
        public override void CreateHandle(CreateParams cp) {
            cp.Caption = "jiegechang-clipboard-helper";
            base.CreateHandle(cp);
        }
        protected override void WndProc(ref Message m) {
            if (m.Msg == WM_CLIPBOARDUPDATE) {
                if (Listening) CaptureClipboard();
                return;
            }
            if (m.Msg == WM_APP) { ProcessCommands(); return; }
            base.WndProc(ref m);
        }
    }

    static readonly Queue<string> Commands = new Queue<string>();
    static readonly object CommandLock = new object();

    static void ProcessCommands() {
        if (Stopped && Commands.Count == 0) { Application.ExitThread(); return; }
        while (true) {
            string line;
            lock (CommandLock) {
                if (Commands.Count == 0) return;
                line = Commands.Dequeue();
            }
            HandleCommand(line);
        }
    }

    static void HandleCommand(string line) {
        if (line == null) return;
        if (line.Length > MaxJsonBytes) { EmitError(0, "E_JSON_TOO_BIG"); return; }
        int id = 0;
        try {
            System.Web.Script.Serialization.JavaScriptSerializer serializer = new System.Web.Script.Serialization.JavaScriptSerializer();
            serializer.MaxJsonLength = MaxJsonBytes;
            Dictionary<string, object> command = serializer.Deserialize<Dictionary<string, object>>(line);
            if (command == null) { EmitError(0, "E_JSON"); return; }
            id = command.ContainsKey("id") ? Convert.ToInt32(command["id"]) : 0;
            string cmd = command.ContainsKey("cmd") ? Convert.ToString(command["cmd"]) : "";
            if (cmd == "watch") {
                if (!Listening) Listening = AddClipboardFormatListener(Window.Handle);
                EmitOk(id, "\"listening\":" + (Listening ? "true" : "false"));
            } else if (cmd == "pause") {
                if (Listening) RemoveClipboardFormatListener(Window.Handle);
                Listening = false;
                EmitOk(id, "\"listening\":false");
            } else if (cmd == "resume") {
                if (!Listening) Listening = AddClipboardFormatListener(Window.Handle);
                EmitOk(id, "\"listening\":" + (Listening ? "true" : "false"));
            } else if (cmd == "status") {
                EmitOk(id, "\"listening\":" + (Listening ? "true" : "false") + ",\"pid\":" + OwnPid);
            } else if (cmd == "publish") {
                object raw = command.ContainsKey("entries") ? command["entries"] : null;
                List<object> entries = AsList(raw);
                if (entries == null) { EmitError(id, "E_PUBLISH"); return; }
                List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
                foreach (object item in entries) {
                    Dictionary<string, object> entry = item as Dictionary<string, object>;
                    if (entry == null) { EmitError(id, "E_PUBLISH"); return; }
                    list.Add(entry);
                }
                if (list.Count == 0 || list.Count > 8) { EmitError(id, "E_PUBLISH"); return; }
                EmitOk(id, "\"published\":" + (Publish(list) ? "true" : "false"));
            } else if (cmd == "exclude") {
                // 来源排除列表：main 每次设置变更都会重推一份完整列表。
                ExcludedApps.Clear();
                object appsRaw = command.ContainsKey("apps") ? command["apps"] : null;
                List<object> apps = AsList(appsRaw);
                if (apps != null) {
                    foreach (object item in apps) {
                        string name = NormalizeProcessName(Convert.ToString(item));
                        if (name.Length > 0 && name.Length <= 120 && !ExcludedApps.Contains(name)) ExcludedApps.Add(name);
                    }
                }
                EmitOk(id, "\"apps\":" + ExcludedApps.Count);
            } else if (cmd == "paste") {
                // 定向粘贴：只接受 main 给的呼出前目标窗口，核 HWND/PID 仍有效且真的拿到前台才发键。
                long hwnd = command.ContainsKey("hwnd") ? Convert.ToInt64(command["hwnd"]) : 0;
                long pid = command.ContainsKey("pid") ? Convert.ToInt64(command["pid"]) : 0;
                string reason = PasteTo(hwnd, pid);
                EmitOk(id, "\"pasted\":" + (reason == "ok" || reason == "ok-restored" ? "true" : "false") + ",\"reason\":\"" + reason + "\""
                    + ",\"fgwnd\":" + GetForegroundWindow().ToInt64());
            } else if (cmd == "quit") {
                EmitOk(id, "\"stopped\":true");
                Stopped = true;
                PostMessage(Window.Handle, WM_APP, IntPtr.Zero, IntPtr.Zero);
            } else {
                EmitError(id, "E_UNKNOWN_CMD");
            }
        } catch (Exception) { EmitError(id, "E_COMMAND"); }
    }

    // —— 自测：只用内存 DataObject 与合成图，不碰系统剪贴板、不注册监听 ——
    static void SelfTest() {
        // 1) 合成 PNG：1×1 黑点，真签名真 IHDR。
        byte[] png = MakePng();
        int width, height;
        Require(PngSize(png, out width, out height) && width == 1 && height == 1, "png-size");
        // 2) 坏 PNG 头被拒。
        byte[] bad = (byte[])png.Clone(); bad[12] = (byte)'X';
        Require(!PngSize(bad, out width, out height), "png-header");
        // 3) 合成 DIB 读头与转 PNG（内存）。
        byte[] dib = MakeDib(4, 3);
        int dibWidth, dibHeight;
        Require(DibSize(dib, out dibWidth, out dibHeight) && dibWidth == 4 && dibHeight == 3, "dib-size");
        using (Bitmap bitmap = DibToBitmap(dib)) {
            Require(bitmap.Width == 4 && bitmap.Height == 3, "dib-bitmap");
            MemoryStream copy = new MemoryStream();
            bitmap.Save(copy, ImageFormat.Png);
            Require(PngSize(copy.ToArray(), out width, out height) && width == 4 && height == 3, "dib-png");
        }
        // 4) 内存 DataObject 的文本/RTF/文件列表映射正确，且不触碰系统剪贴板。
        DataObject data = new DataObject();
        data.SetData(DataFormats.UnicodeText, false, "中文自测");
        data.SetData(DataFormats.Rtf, false, new MemoryStream(Encoding.ASCII.GetBytes("{\\rtf1 自测}"), false));
        StringCollection files = new StringCollection(); files.Add("C:\\self-test\\a.txt");
        data.SetFileDropList(files);
        Require(data.GetDataPresent(DataFormats.UnicodeText, false), "data-text");
        Require(Convert.ToString(data.GetData(DataFormats.UnicodeText, false)) == "中文自测", "data-text-read");
        StringCollection readBack = data.GetFileDropList();
        Require(readBack.Count == 1 && readBack[0] == "C:\\self-test\\a.txt", "data-files");
        Require(DataFormats.GetFormat(DataFormats.FileDrop).Id == 15, "data-filedrop");
        // 6) 来源排除名单规范化：大小写与 .exe 后缀不能影响匹配（不查真实进程）。
        Require(NormalizeProcessName("Chrome.EXE") == "chrome", "exclude-normalize");
        Require(NormalizeProcessName("  WeChat ") == "wechat", "exclude-trim");
        Require(NormalizeProcessName("") == "", "exclude-empty");
        // 5) CF_HTML 头偏移：中文按 UTF-8 字节算。
        string fragment = "<p>中文\n第二行</p>";
        byte[] html = MakeCfHtml(fragment);
        Require(CheckCfHtml(html, fragment), "cf-html");
        // 7) 常驻命令的 entries / paths 解析：JavaScriptSerializer 给数组的是 object[]，
        //    曾经只用 "as List<object>" 判断，导致每条 publish 都回 E_PUBLISH（截图复制全失败）。
        System.Web.Script.Serialization.JavaScriptSerializer serializer = new System.Web.Script.Serialization.JavaScriptSerializer();
        Dictionary<string, object> command = serializer.Deserialize<Dictionary<string, object>>(
            "{\"id\":1,\"cmd\":\"publish\",\"entries\":[{\"format\":\"png\",\"file\":\"a.png\"},{\"format\":\"files\",\"paths\":[\"C:\\\\a.txt\"]}]}");
        Require(command != null, "cmd-json");
        Require(command["entries"] is System.Collections.IEnumerable && !(command["entries"] is string), "cmd-json-array");
        List<object> entries = AsList(command["entries"]);
        Require(entries != null && entries.Count == 2, "cmd-json-entries");
        Dictionary<string, object> first = entries[0] as Dictionary<string, object>;
        Require(first != null && Convert.ToString(first["format"]) == "png", "cmd-json-entry");
        Dictionary<string, object> second = entries[1] as Dictionary<string, object>;
        List<object> paths = second == null ? null : AsList(second["paths"]);
        Require(paths != null && paths.Count == 1 && Convert.ToString(paths[0]).EndsWith("a.txt"), "cmd-json-paths");
        Require(AsList(null) == null && AsList("x") == null, "cmd-json-reject");
        // 8) PNG 发布要额外给一份 CF_DIB：只发 "PNG" 时微信/画图/Office 粘贴读不到图。
        byte[] selfPng = MakePng();
        byte[] selfDib = PngToDib(selfPng);
        Require(selfDib != null, "png-dib");
        Require(ReadUIntLE(selfDib, 0) == 40 && selfDib[12] == 1 && selfDib[14] == 24, "png-dib-header");
        int selfDibWidth, selfDibHeight;
        Require(DibSize(selfDib, out selfDibWidth, out selfDibHeight) && selfDibWidth == 1 && selfDibHeight == 1, "png-dib-size");
    }
    static byte[] MakePng() {
        // 用 GDI+ 在内存里生成真 PNG，不手写字节、不依赖固定 CRC。
        using (Bitmap bitmap = new Bitmap(1, 1)) {
            bitmap.SetPixel(0, 0, Color.Black);
            MemoryStream stream = new MemoryStream();
            bitmap.Save(stream, ImageFormat.Png);
            return stream.ToArray();
        }
    }
    static byte[] MakeDib(int width, int height) {
        int stride = ((width * 24 + 31) / 32) * 4;
        byte[] bytes = new byte[40 + stride * height];
        WriteUInt(bytes, 0, 40);
        WriteUInt(bytes, 4, (uint)width);
        WriteUInt(bytes, 8, (uint)height);
        bytes[12] = 1; bytes[13] = 0;
        bytes[14] = 24; bytes[15] = 0;
        WriteUInt(bytes, 16, 0);
        WriteUInt(bytes, 20, (uint)(stride * height));
        for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
            int at = 40 + y * stride + x * 3;
            bytes[at] = 32; bytes[at + 1] = 64; bytes[at + 2] = 128;
        }
        return bytes;
    }
    static byte[] MakeCfHtml(string fragment) {
        string head = "Version:0.9\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n";
        string prefix = "<html><body>\r\n<!--StartFragment-->";
        string suffix = "<!--EndFragment-->\r\n</body></html>";
        int body = Encoding.UTF8.GetByteCount(prefix + fragment + suffix);
        int startHtml = Encoding.UTF8.GetByteCount(head);
        int startFragment = startHtml + Encoding.UTF8.GetByteCount(prefix);
        string text = "Version:0.9\r\n" +
            "StartHTML:" + Pad(startHtml) + "\r\n" +
            "EndHTML:" + Pad(startHtml + body) + "\r\n" +
            "StartFragment:" + Pad(startFragment) + "\r\n" +
            "EndFragment:" + Pad(startFragment + Encoding.UTF8.GetByteCount(fragment)) + "\r\n" +
            prefix + fragment + suffix;
        return Encoding.UTF8.GetBytes(text);
    }
    static string Pad(int value) { return value.ToString("D10"); }
    static bool CheckCfHtml(byte[] bytes, string fragment) {
        string text = Encoding.UTF8.GetString(bytes);
        int startFragment = 0, endFragment = 0;
        foreach (string line in text.Split('\n')) {
            string trimmed = line.Trim();
            if (trimmed.StartsWith("StartFragment:")) startFragment = Int32.Parse(trimmed.Substring(14).Trim());
            if (trimmed.StartsWith("EndFragment:")) endFragment = Int32.Parse(trimmed.Substring(12).Trim());
        }
        if (startFragment <= 0 || endFragment <= startFragment || endFragment > bytes.Length) return false;
        byte[] slice = new byte[endFragment - startFragment];
        Array.Copy(bytes, startFragment, slice, 0, slice.Length);
        return Encoding.UTF8.GetString(slice) == fragment;
    }
    static void Require(bool condition, string label) { if (!condition) throw new InvalidDataException(label); }

    // —— 命令行 ——
    static string ArgValue(string[] args, string name) {
        for (int i = 0; i < args.Length - 1; i++) if (args[i] == name) return args[i + 1];
        return null;
    }
    [STAThread]
    static int Main(string[] args) {
        try {
            if (args.Length == 1 && args[0] == "--self-test") {
                SelfTest();
                Console.Out.WriteLine("{\"v\":" + ProtocolVersion + ",\"ok\":true,\"selfTest\":true}");
                return 0;
            }
            if (args.Length >= 3 && args[0] == "--publish") {
                // 单次发布：不注册监听，读 argv 的 entries JSON 文件。
                EnsureSpool(ArgValue(args, "--spool"));
                string spec = args[1];
                if (spec.Length > MaxJsonBytes) throw new InvalidDataException();
                System.Web.Script.Serialization.JavaScriptSerializer serializer = new System.Web.Script.Serialization.JavaScriptSerializer();
                serializer.MaxJsonLength = MaxJsonBytes;
                string content = File.ReadAllText(spec, Encoding.UTF8);
                List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
                List<object> raw = serializer.Deserialize<List<object>>(content);
                foreach (object item in raw) {
                    Dictionary<string, object> entry = item as Dictionary<string, object>;
                    if (entry == null) throw new InvalidDataException();
                    list.Add(entry);
                }
                bool ok = Publish(list);
                Console.Out.WriteLine("{\"v\":" + ProtocolVersion + ",\"ok\":" + (ok ? "true" : "false") + "}");
                return ok ? 0 : 1;
            }
            if (args.Length >= 1 && args[0] == "--watch") {
                EnsureSpool(ArgValue(args, "--spool"));
                OwnPid = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
                Application.EnableVisualStyles();
                Window = new MsgWindow();
                CreateParams cp = new CreateParams();
                cp.ExStyle = 0x80; // WS_EX_TOOLWINDOW：不出现在任务栏
                Window.CreateHandle(cp);
                Emit("{\"v\":" + ProtocolVersion + ",\"event\":\"ready\",\"pid\":" + OwnPid + ",\"listening\":false}");
                Thread reader = new Thread(new ThreadStart(delegate {
                    while (true) {
                        string line = Console.In.ReadLine();
                        if (line == null) break;
                        lock (CommandLock) Commands.Enqueue(line);
                        PostMessage(Window.Handle, WM_APP, IntPtr.Zero, IntPtr.Zero);
                    }
                    Stopped = true;
                    PostMessage(Window.Handle, WM_APP, IntPtr.Zero, IntPtr.Zero);
                }));
                reader.IsBackground = true;
                reader.Start();
                Application.Run();
                return 0;
            }
            Console.Error.WriteLine("E_ARGS");
            return 2;
        } catch (Exception error) {
            if (args.Length == 1 && args[0] == "--self-test") Console.Error.WriteLine(error.ToString());
            else Console.Error.WriteLine("E_CLIPBOARD_HELPER");
            return 1;
        }
    }
}
