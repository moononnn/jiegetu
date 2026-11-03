using System;
using System.IO;
using System.Text;
using System.Collections.Specialized;
using System.Windows.Forms;

internal static class GifClipboard {
    const int MaxBytes = 48 * 1024 * 1024;
    static void Validate(byte[] bytes) {
        if (bytes.Length < 13 || bytes.Length > MaxBytes) throw new InvalidDataException();
        string header = Encoding.ASCII.GetString(bytes, 0, 6);
        int width = bytes[6] | (bytes[7] << 8), height = bytes[8] | (bytes[9] << 8);
        if ((header != "GIF87a" && header != "GIF89a") || width < 1 || height < 1 ||
            width > 4096 || height > 4096 || (long)width * height > 4000000) throw new InvalidDataException();
    }
    static byte[] Read(string file) {
        if (!Path.IsPathRooted(file) || !String.Equals(Path.GetFullPath(file), file, StringComparison.OrdinalIgnoreCase) ||
            !String.Equals(Path.GetExtension(file), ".gif", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException();
        FileAttributes attributes = File.GetAttributes(file);
        if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) throw new InvalidDataException();
        using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            if (stream.Length < 13 || stream.Length > MaxBytes) throw new InvalidDataException();
            byte[] bytes = new byte[(int)stream.Length];
            int offset = 0;
            while (offset < bytes.Length) {
                int n = stream.Read(bytes, offset, bytes.Length - offset);
                if (n == 0) throw new EndOfStreamException();
                offset += n;
            }
            Validate(bytes);
            return bytes;
        }
    }
    static DataObject Create(string file, byte[] bytes) {
        DataObject data = new DataObject();
        StringCollection files = new StringCollection(); files.Add(file);
        // WinForms maps FileDrop to the predefined CF_HDROP (15), not a custom format named CF_HDROP.
        data.SetFileDropList(files);
        data.SetData("GIF", false, new MemoryStream(bytes, false));
        data.SetData("image/gif", false, new MemoryStream(bytes, false));
        data.SetData("Preferred DropEffect", false, new MemoryStream(new byte[] { 1, 0, 0, 0 }, false));
        return data;
    }
    static void Require(bool condition) { if (!condition) throw new InvalidDataException(); }
    static void EqualStream(DataObject data, string format, byte[] expected) {
        Require(data.GetDataPresent(format, false));
        MemoryStream stream = data.GetData(format, false) as MemoryStream;
        Require(stream != null);
        byte[] actual = stream.ToArray();
        Require(actual.Length == expected.Length);
        for (int i = 0; i < actual.Length; i++) Require(actual[i] == expected[i]);
    }
    // Pure managed DataObject construction/readback. No call to any system Clipboard API.
    static void SelfTest() {
        byte[] bytes = new byte[] { 71,73,70,56,57,97,1,0,1,0,128,0,0,0,0,0,255,255,255,
            33,249,4,4,10,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59 };
        Validate(bytes);
        string file = Path.Combine(Path.GetTempPath(), "GIF-self-test-中文.gif");
        DataObject data = Create(file, bytes);
        Require(DataFormats.GetFormat(DataFormats.FileDrop).Id == 15);
        Require(data.GetDataPresent(DataFormats.FileDrop, false));
        StringCollection files = data.GetFileDropList();
        Require(files.Count == 1 && files[0] == file);
        EqualStream(data, "GIF", bytes);
        EqualStream(data, "image/gif", bytes);
        EqualStream(data, "Preferred DropEffect", new byte[] { 1, 0, 0, 0 });
        Require(!data.GetDataPresent(DataFormats.Bitmap, false));
        Require(!data.GetDataPresent("PNG", false));
        byte[] bad = (byte[])bytes.Clone(); bad[0] = 0;
        bool rejected = false; try { Validate(bad); } catch (InvalidDataException) { rejected = true; }
        Require(rejected);
    }
    [STAThread]
    static int Main(string[] args) {
        try {
            if (args.Length == 1 && args[0] == "--self-test") {
                SelfTest();
            } else if (args.Length == 2 && (args[0] == "--publish" || args[0] == "--inspect")) {
                byte[] bytes = Read(args[1]);
                if (args[0] == "--publish") {
                    DataObject data = Create(args[1], bytes);
                    Clipboard.SetDataObject(data, true, 5, 100);
                }
            } else {
                Console.Error.WriteLine("E_ARGS"); return 2;
            }
            Console.Out.WriteLine("{\"ok\":true}"); return 0;
        } catch (Exception) {
            Console.Error.WriteLine("E_GIF_CLIPBOARD"); return 1;
        }
    }
}
