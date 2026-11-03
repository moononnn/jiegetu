// Offline OCR helper (Windows.Media.Ocr). Reads one bounded PNG from stdin, writes one JSON line to stdout.
// No files, no network, no clipboard, no screen capture, no input injection. Nothing but the fixed JSON leaves the process.
// args: (none)        recognise the PNG read from stdin
// args: --languages   list installed OCR languages + engine choice, no image needed
// args: --self-test   render a synthetic image in memory and recognise it; nothing is read from disk or the desktop
// stdin: raw PNG bytes (<= 8 MiB). stdout: {"ok":true,"text":..,"language":..,"width":..,"height":..}
//         or {"ok":false,"reason":"<fixed-code>"}. Failure codes stay ASCII so the host can map them to safe UI text.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text;
using System.Threading;
using Windows.Foundation;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;

// One fixed failure carrying a machine code only; the message never travels to the host.
class OcrFailure : Exception {
    public readonly string Reason;
    public OcrFailure(string reason) : base(reason) { Reason = reason; }
}

class OcrHelper {
    const int MaxInputBytes = 8 * 1024 * 1024;
    const int MaxDimension = 2048;
    const long MaxPixels = 4000000;
    const int MaxTextUnits = 2000;
    // Keeps the whole helper under the host's 6 s budget even if the engine stalls.
    const int EngineDeadlineMs = 5000;
    const int PollMs = 20;
    static readonly byte[] PngSignature = new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 };

    // WinRT 的 OCR 引擎在 MTA 下使用；显式声明线程单元，不让 CLR 启动器决定。
    [MTAThread]
    static int Main(string[] args) {
        try {
            Console.OutputEncoding = new UTF8Encoding(false);
        } catch (Exception) { }
        try {
            if (args != null && args.Length == 1 && args[0] == "--languages") { Emit(LanguagesJson()); return 0; }
            if (args != null && args.Length == 1 && args[0] == "--self-test") { Emit(SelfTestJson()); return 0; }
            if (args != null && args.Length != 0) { Emit(FailureJson("bad-arguments")); return 0; }
            Emit(RecognizeStdinJson());
            return 0;
        } catch (OcrFailure failure) {
            Emit(FailureJson(failure.Reason));
            return 0;
        } catch (Exception) {
            // Exception text, paths and pixels never reach stdout: only the fixed code.
            Emit(FailureJson("failed"));
            return 0;
        }
    }

    // ---- stdin ----

    // Reads at most MaxInputBytes; anything longer is rejected instead of being truncated or buffered further.
    static byte[] ReadStdin() {
        MemoryStream buffer = new MemoryStream();
        Stream input = Console.OpenStandardInput();
        byte[] chunk = new byte[81920];
        while (true) {
            int read = input.Read(chunk, 0, chunk.Length);
            if (read <= 0) break;
            if (buffer.Length + read > MaxInputBytes) throw new OcrFailure("too-large");
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
    }

    static string RecognizeStdinJson() {
        byte[] png = ReadStdin();
        // 独立 CLI 也不能依赖调用方先拦：先验签名与 IHDR 宽高上限，再交给解码器分配内存。
        CheckPngHeader(png);
        using (Bitmap source = DecodePng(png)) {
            return RecognizeBitmap(source);
        }
    }

    // 只读 IHDR 元数据，不分配像素：签名、块长、块类型、正整数边与像素总量都按同一套上限严判。
    static void CheckPngHeader(byte[] png) {
        if (png.Length == 0) throw new OcrFailure("empty-image");
        if (png.Length < 33) throw new OcrFailure("bad-image");
        for (int i = 0; i < PngSignature.Length; i++) if (png[i] != PngSignature[i]) throw new OcrFailure("bad-image");
        if (ReadUInt32BE(png, 8) != 13) throw new OcrFailure("bad-image");
        if (png[12] != 'I' || png[13] != 'H' || png[14] != 'D' || png[15] != 'R') throw new OcrFailure("bad-image");
        uint width = ReadUInt32BE(png, 16), height = ReadUInt32BE(png, 20);
        if (width < 1 || height < 1) throw new OcrFailure("bad-image");
        if (width > (uint)MaxDimension || height > (uint)MaxDimension || (long)width * height > MaxPixels) throw new OcrFailure("too-large");
    }

    static uint ReadUInt32BE(byte[] value, int offset) {
        return ((uint)value[offset] << 24) | ((uint)value[offset + 1] << 16) | ((uint)value[offset + 2] << 8) | value[offset + 3];
    }

    // GDI+ 的 Bitmap 会一直引用构造它的 stream，所以必须在 stream 还活着时克隆出独立位图，
    // 再让原 decode 与 stream 一起释放；否则后续访问会是未定义行为。
    static Bitmap DecodePng(byte[] png) {
        try {
            using (MemoryStream stream = new MemoryStream(png, false)) {
                using (Bitmap decoded = new Bitmap(stream)) {
                    return new Bitmap(decoded);
                }
            }
        } catch (OcrFailure) {
            throw;
        } catch (Exception) {
            throw new OcrFailure("bad-image");
        }
    }

    // ---- recognition ----

    static string RecognizeBitmap(Bitmap source) {
        int width = source.Width, height = source.Height;
        if (width < 1 || height < 1) throw new OcrFailure("bad-image");
        if (width > MaxDimension || height > MaxDimension || (long)width * height > MaxPixels) throw new OcrFailure("too-large");
        OcrEngine engine = CreateEngine();
        if (engine == null) throw new OcrFailure("no-language");
        int maxDimension = (int)OcrEngine.MaxImageDimension;
        if (maxDimension > 0 && (width > maxDimension || height > maxDimension)) throw new OcrFailure("too-large");
        string text;
        using (SoftwareBitmap bitmap = ToSoftwareBitmap(source)) {
            text = RunEngine(engine, bitmap);
        }
        if (CodePoints(text) > MaxTextUnits) throw new OcrFailure("text-too-long");
        StringBuilder json = new StringBuilder();
        json.Append("{\"ok\":true,\"text\":").Append(Quote(text));
        json.Append(",\"language\":").Append(Quote(engine.RecognizerLanguage != null ? engine.RecognizerLanguage.LanguageTag : ""));
        json.Append(",\"width\":").Append(width.ToString(CultureInfo.InvariantCulture));
        json.Append(",\"height\":").Append(height.ToString(CultureInfo.InvariantCulture));
        json.Append('}');
        return json.ToString();
    }

    // White base + forced opaque alpha: the engine gets a plain BGRA image, so transparency never reads as black.
    static SoftwareBitmap ToSoftwareBitmap(Bitmap source) {
        int width = source.Width, height = source.Height;
        using (Bitmap canvas = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
            using (Graphics graphics = Graphics.FromImage(canvas)) {
                graphics.CompositingMode = CompositingMode.SourceOver;
                graphics.Clear(Color.White);
                graphics.DrawImage(source, new Rectangle(0, 0, width, height));
            }
            BitmapData data = canvas.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try {
                byte[] pixels = new byte[width * height * 4];
                int stride = data.Stride;
                long origin = data.Scan0.ToInt64();
                int rowBytes = width * 4;
                for (int y = 0; y < height; y++) {
                    long row = stride >= 0 ? origin + (long)y * stride : origin + (long)(height - 1 - y) * (-stride);
                    Marshal.Copy(new IntPtr(row), pixels, y * rowBytes, rowBytes);
                }
                for (int i = 3; i < pixels.Length; i += 4) pixels[i] = 255;
                return SoftwareBitmap.CreateCopyFromBuffer(WindowsRuntimeBufferExtensions.AsBuffer(pixels),
                    BitmapPixelFormat.Bgra8, width, height, BitmapAlphaMode.Premultiplied);
            } finally {
                canvas.UnlockBits(data);
            }
        }
    }

    static string RunEngine(OcrEngine engine, SoftwareBitmap bitmap) {
        IAsyncOperation<OcrResult> operation;
        try {
            operation = engine.RecognizeAsync(bitmap);
        } catch (Exception) {
            throw new OcrFailure("failed");
        }
        if (operation == null) throw new OcrFailure("failed");
        int waited = 0;
        while (operation.Status == AsyncStatus.Started && waited < EngineDeadlineMs) {
            Thread.Sleep(PollMs);
            waited += PollMs;
        }
        if (operation.Status != AsyncStatus.Completed) {
            try { operation.Cancel(); } catch (Exception) { }
            throw new OcrFailure(operation.Status == AsyncStatus.Canceled ? "canceled" : "timeout");
        }
        OcrResult result = operation.GetResults();
        if (result == null) return "";
        return result.Text != null ? result.Text : "";
    }

    // User-profile engine first, then an installed Chinese recognizer, then any other installed language.
    static OcrEngine CreateEngine() {
        OcrEngine engine = OcrEngine.TryCreateFromUserProfileLanguages();
        if (engine != null) return engine;
        IReadOnlyList<Language> available;
        try { available = OcrEngine.AvailableRecognizerLanguages; } catch (Exception) { return null; }
        if (available == null) return null;
        for (int i = 0; i < available.Count; i++) {
            Language language = available[i];
            string tag = language != null ? language.LanguageTag : null;
            if (tag != null && tag.StartsWith("zh", StringComparison.OrdinalIgnoreCase)) {
                engine = OcrEngine.TryCreateFromLanguage(language);
                if (engine != null) return engine;
            }
        }
        for (int i = 0; i < available.Count; i++) {
            engine = OcrEngine.TryCreateFromLanguage(available[i]);
            if (engine != null) return engine;
        }
        return null;
    }

    // ---- diagnostics entries (no pixels, no personal images) ----

    static string LanguagesJson() {
        StringBuilder json = new StringBuilder();
        json.Append("{\"ok\":true,\"languages\":[");
        bool first = true;
        try {
            IReadOnlyList<Language> available = OcrEngine.AvailableRecognizerLanguages;
            if (available != null) {
                for (int i = 0; i < available.Count; i++) {
                    if (!first) json.Append(',');
                    json.Append(Quote(available[i] != null ? available[i].LanguageTag : ""));
                    first = false;
                }
            }
        } catch (Exception) { }
        json.Append("],\"engine\":");
        OcrEngine engine = null;
        try { engine = CreateEngine(); } catch (Exception) { }
        json.Append(Quote(engine != null && engine.RecognizerLanguage != null ? engine.RecognizerLanguage.LanguageTag : ""));
        json.Append(",\"maxDimension\":").Append(engine != null ? ((int)OcrEngine.MaxImageDimension).ToString(CultureInfo.InvariantCulture) : "0");
        json.Append('}');
        return json.ToString();
    }

    static string SelfTestJson() {
        string[] keywords = new string[] { "保存", "按钮", "1234", "ABC" };
        string matched = null, text = "", language = "";
        using (Bitmap synthetic = Synthesize()) {
            OcrEngine engine = CreateEngine();
            if (engine == null) throw new OcrFailure("no-language");
            try {
                using (SoftwareBitmap bitmap = ToSoftwareBitmap(synthetic)) {
                    text = RunEngine(engine, bitmap);
                }
                language = engine.RecognizerLanguage != null ? engine.RecognizerLanguage.LanguageTag : "";
            } catch (OcrFailure failure) {
                throw failure;
            }
        }
        string flattened = text.Replace("\r", "").Replace("\n", "").Replace(" ", "");
        for (int i = 0; i < keywords.Length; i++) if (flattened.Contains(keywords[i])) { matched = keywords[i]; break; }
        StringBuilder json = new StringBuilder();
        bool ok = matched != null;
        json.Append("{\"ok\":").Append(ok ? "true" : "false");
        json.Append(",\"text\":").Append(Quote(text));
        json.Append(",\"language\":").Append(Quote(language));
        json.Append(",\"matched\":").Append(matched != null ? Quote(matched) : "null");
        if (!ok) json.Append(",\"reason\":\"self-test-mismatch\"");
        json.Append('}');
        return json.ToString();
    }

    // Synthetic image only: white background, one Chinese phrase and one Latin/digit phrase drawn in memory.
    static Bitmap Synthesize() {
        const int width = 960, height = 320;
        Bitmap canvas = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        try {
            using (Graphics graphics = Graphics.FromImage(canvas)) {
                graphics.Clear(Color.White);
                graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using (Font chinese = PickFont(new string[] { "Microsoft YaHei", "SimHei", "SimSun" }, 72f))
                using (Font latin = PickFont(new string[] { "Segoe UI", "Arial" }, 64f))
                using (Brush ink = new SolidBrush(Color.Black)) {
                    graphics.DrawString("保存按钮", chinese, ink, 40f, 40f);
                    graphics.DrawString("1234 ABC", latin, ink, 40f, 180f);
                }
            }
            return canvas;
        } catch (Exception) {
            canvas.Dispose();
            throw new OcrFailure("self-test-render");
        }
    }

    static Font PickFont(string[] families, float size) {
        for (int i = 0; i < families.Length; i++) {
            try {
                Font font = new Font(families[i], size, FontStyle.Regular, GraphicsUnit.Pixel);
                if (font.Name != null && font.Name.Length > 0) return font;
                font.Dispose();
            } catch (Exception) { }
        }
        return new Font(FontFamily.GenericSansSerif, size, FontStyle.Regular, GraphicsUnit.Pixel);
    }

    // ---- JSON helpers: ASCII-only output, fixed escaping ----

    static int CodePoints(string value) {
        if (string.IsNullOrEmpty(value)) return 0;
        int count = 0;
        for (int i = 0; i < value.Length; i++) {
            if (char.IsHighSurrogate(value[i]) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1])) i++;
            count++;
        }
        return count;
    }

    static string Quote(string value) {
        StringBuilder json = new StringBuilder("\"");
        if (value != null) {
            for (int i = 0; i < value.Length; i++) {
                char c = value[i];
                switch (c) {
                    case '"': json.Append("\\\""); break;
                    case '\\': json.Append("\\\\"); break;
                    case '\n': json.Append("\\n"); break;
                    case '\r': json.Append("\\r"); break;
                    case '\t': json.Append("\\t"); break;
                    case '\b': json.Append("\\b"); break;
                    case '\f': json.Append("\\f"); break;
                    default:
                        if (c < 0x20 || c > 0x7e) json.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else json.Append(c);
                        break;
                }
            }
        }
        return json.Append('"').ToString();
    }

    static string FailureJson(string reason) {
        return "{\"ok\":false,\"reason\":" + Quote(reason) + "}";
    }

    static void Emit(string json) {
        try {
            using (Stream stdout = Console.OpenStandardOutput())
            using (StreamWriter writer = new StreamWriter(stdout, new UTF8Encoding(false))) {
                writer.Write(json);
                writer.Write('\n');
                writer.Flush();
            }
        } catch (Exception) { }
    }
}
