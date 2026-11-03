// GDI ROI snapshots, without a WGC session or explicit cursor drawing.
// JGC2 protocol: N=snapshot, Q/EOF=stop. No input injection or pixel repair.
// Hardware cursor is not drawn. Software cursors already in desktop pixels cannot be removed.
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
class GdiCapture {
 [StructLayout(LayoutKind.Sequential)] struct Rect {public int Left,Top,Right,Bottom;}
 [StructLayout(LayoutKind.Sequential)] struct MonitorInfo {public int Size;public Rect Monitor,Work;public uint Flags;}
 [StructLayout(LayoutKind.Sequential)] struct BitmapInfo {public uint Size;public int Width,Height;public ushort Planes,BitCount;public uint Compression,SizeImage;public int XPels,YPels;public uint Used,Important;}
 [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
 static volatile bool stopWatching;
 static int WatchCancel() {
  // Observe only the right button while this capture session exists; never inject or suppress input.
  var input = new System.Threading.Thread(() => { try { Console.OpenStandardInput().ReadByte(); } catch {} stopWatching = true; });
  input.IsBackground = true; input.Start();
  bool previous = (GetAsyncKeyState(2) & 0x8000) != 0;
  while (!stopWatching) {
   bool down = (GetAsyncKeyState(2) & 0x8000) != 0;
   if (down && !previous) { Console.Out.Write("R"); Console.Out.Flush(); return 0; }
   previous = down; System.Threading.Thread.Sleep(8);
  }
  return 0;
 }
 // Separate opt-in wheel bridge. JGC2 capture and the cancel observer do not inject input.
 [StructLayout(LayoutKind.Sequential)] struct WheelPoint {public int X,Y;}
 [StructLayout(LayoutKind.Sequential)] struct WheelMouseInput {public int Dx,Dy;public uint MouseData,Flags,Time;public UIntPtr ExtraInfo;}
 // Win64 INPUT: DWORD type + 4-byte alignment padding + 32-byte union.
 [StructLayout(LayoutKind.Explicit,Size=40)] struct WheelInput {
  [FieldOffset(0)] public uint Type;
  [FieldOffset(8)] public WheelMouseInput Mouse;
 }
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flags);
 [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
 [DllImport("user32.dll")] static extern bool GetPhysicalCursorPos(out WheelPoint point);
 [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(WheelPoint point);
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,[In] WheelInput[] inputs,int size);
 [StructLayout(LayoutKind.Sequential)] struct WheelKey {public uint Key,ScanCode,Flags,Time;public UIntPtr ExtraInfo;}
 [StructLayout(LayoutKind.Sequential)] struct WheelMessage {public IntPtr Window;public uint Message;public UIntPtr WParam;public IntPtr LParam;public uint Time;public WheelPoint Point;public uint Private;}
 [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr WheelHookProc(int code,IntPtr message,IntPtr data);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr SetWindowsHookEx(int type,WheelHookProc callback,IntPtr module,uint thread);
 [DllImport("user32.dll",SetLastError=true)] static extern bool UnhookWindowsHookEx(IntPtr hook);
 [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr message,IntPtr data);
 [DllImport("user32.dll",SetLastError=true)] static extern int GetMessage(out WheelMessage message,IntPtr window,uint first,uint last);
 [DllImport("user32.dll")] static extern bool PeekMessage(out WheelMessage message,IntPtr window,uint first,uint last,uint remove);
 [DllImport("user32.dll")] static extern bool TranslateMessage(ref WheelMessage message);
 [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref WheelMessage message);
 [DllImport("user32.dll",SetLastError=true)] static extern bool PostThreadMessage(uint thread,uint message,UIntPtr wParam,IntPtr lParam);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window,int command);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint processId);
 [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from,uint to,bool attach);
 static bool WheelAllowed(Rect roi,string desktop) {
  IntPtr input=IntPtr.Zero;
  try {
   input=OpenInputDesktop(0,false,1);
   if(DesktopName(input)!=desktop||DesktopName(GetThreadDesktop(GetCurrentThreadId()))!=desktop)return false;
   // Re-read the live foreground on every key: the user may have switched to the page
   // after the selection window hid, and the bridge must not stay pinned to a stale window.
   IntPtr foreground=GetForegroundWindow();
   if(foreground==IntPtr.Zero||!IsWindow(foreground))return false;
   // Any held modifier disables the bridge; do not emit Ctrl-wheel zoom or other shortcuts.
   foreach(int key in new int[]{0x10,0x11,0x12,0x5B,0x5C})if((GetAsyncKeyState(key)&0x8000)!=0)return false;
   WheelPoint point;if(!GetPhysicalCursorPos(out point)||point.X<roi.Left||point.X>=roi.Right||point.Y<roi.Top||point.Y>=roi.Bottom)return false;
   IntPtr under=WindowFromPoint(point);
   if(under==IntPtr.Zero)return false;
   // Only scroll while the pointer sits on the same top-level window that currently owns input.
   return GetAncestor(under,2)==GetAncestor(foreground,2);
  }catch{return false;}
  finally{if(input!=IntPtr.Zero)CloseDesktop(input);}
 }
 static void Activate(IntPtr target) {
  // Best effort only: a failed hand-back leaves the previous behaviour untouched.
  if(target==IntPtr.Zero||!IsWindow(target)||GetForegroundWindow()==target)return;
  uint process;
  uint owner=GetWindowThreadProcessId(target,out process),current=GetCurrentThreadId();
  bool attached=false;
  try {
   if(IsIconic(target))ShowWindow(target,9);
   if(owner!=0&&owner!=current&&AttachThreadInput(current,owner,true))attached=true;
   SetForegroundWindow(target);
  }catch{/* Focus hand-back is optional. */}
  finally{if(attached){try{AttachThreadInput(current,owner,false);}catch{}}}
 }
 static int ScrollWheel(string[] args) {
  int x=int.Parse(args[1]),y=int.Parse(args[2]),w=int.Parse(args[3]),h=int.Parse(args[4]);
  if(Math.Abs((long)x)>1000000||Math.Abs((long)y)>1000000||w<1||h<1||(long)w*h>16000000)throw new Exception("invalid-region");
  if(IntPtr.Size!=8||Marshal.SizeOf(typeof(WheelInput))!=40||Marshal.SizeOf(typeof(WheelMouseInput))!=32||Marshal.OffsetOf(typeof(WheelInput),"Mouse").ToInt32()!=8)throw new Exception("scroll-wheel-requires-win64-input");
  if(SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero)throw new Exception("dpi-context-failed");
  IntPtr initialDesktop=OpenInputDesktop(0,false,1),hook=IntPtr.Zero;
  WheelHookProc callback=null;int quitRequested=0;
  try {
   string desktop=DesktopName(initialDesktop);
   if(DesktopName(GetThreadDesktop(GetCurrentThreadId()))!=desktop)throw new Exception("input-desktop-changed");
   // The selection window just hid; hand input back to the window the user was on.
   Activate(new IntPtr(long.Parse(args[5])));
   IntPtr foreground=GetForegroundWindow();
   if(foreground==IntPtr.Zero||!IsWindow(foreground))throw new Exception("scroll-wheel-target-unavailable");
   var roi=new Rect{Left=x,Top=y,Right=checked(x+w),Bottom=checked(y+h)};
   WheelPoint initialPoint;
   if(!GetPhysicalCursorPos(out initialPoint)||initialPoint.X<roi.Left||initialPoint.X>=roi.Right||initialPoint.Y<roi.Top||initialPoint.Y>=roi.Bottom)
    initialPoint=new WheelPoint{X=x+w/2,Y=y+h/2};
   IntPtr initialUnder=WindowFromPoint(initialPoint);
   if(initialUnder==IntPtr.Zero)throw new Exception("scroll-wheel-target-mismatch");
   uint ownerThread=GetCurrentThreadId();WheelMessage message;
   PeekMessage(out message,IntPtr.Zero,0,0,0); // Create the queue before stdin can post WM_QUIT.
   bool[] swallowed=new bool[2];long[] lastWheel=new long[2];
   var clock=System.Diagnostics.Stopwatch.StartNew();Exception failure=null;
   callback=delegate(int code,IntPtr kind,IntPtr data) {
    if(code!=0||System.Threading.Interlocked.CompareExchange(ref quitRequested,0,0)!=0)return CallNextHookEx(hook,code,kind,data);
    try {
     WheelKey key=(WheelKey)Marshal.PtrToStructure(data,typeof(WheelKey));
     // Ignore injected events, system/Alt events, and every key except ordinary Up/Down.
     if((key.Flags&0x12)!=0||(key.Key!=0x26&&key.Key!=0x28))return CallNextHookEx(hook,code,kind,data);
     int index=key.Key==0x26?0:1;long action=kind.ToInt64();
     if(action!=0x100&&action!=0x101){swallowed[index]=false;return CallNextHookEx(hook,code,kind,data);}
     bool allowed=WheelAllowed(roi,desktop);
     if(action==0x101) {
      bool paired=swallowed[index];swallowed[index]=false;
      return paired&&allowed?new IntPtr(1):CallNextHookEx(hook,code,kind,data);
     }
     if(!allowed){swallowed[index]=false;return CallNextHookEx(hook,code,kind,data);}
     long now=clock.ElapsedMilliseconds;
     // Only repeats of an already swallowed down can be swallowed without another wheel.
     if(swallowed[index]&&now-lastWheel[index]<80)return new IntPtr(1);
     var packet=new WheelInput{Type=0,Mouse=new WheelMouseInput{MouseData=unchecked((uint)(key.Key==0x26?120:-120)),Flags=0x0800}};
     if(SendInput(1,new WheelInput[]{packet},40)!=1)throw new Exception("scroll-wheel-injection-failed");
     swallowed[index]=true;lastWheel[index]=now;
     return new IntPtr(1);
    }catch(Exception error) {
     // UIPI/error: uninstall, quit and pass THIS key through instead of losing it.
     failure=error;System.Threading.Interlocked.Exchange(ref quitRequested,1);
     if(hook!=IntPtr.Zero&&UnhookWindowsHookEx(hook))hook=IntPtr.Zero;
     PostThreadMessage(ownerThread,0x0012,UIntPtr.Zero,IntPtr.Zero);
     return CallNextHookEx(hook,code,kind,data);
    }
   };
   hook=SetWindowsHookEx(13,callback,GetModuleHandle(null),0); // WH_KEYBOARD_LL
   if(hook==IntPtr.Zero)throw new Exception("scroll-wheel-hook-failed");
   var inputThread=new System.Threading.Thread(() => {
    try {Stream input=Console.OpenStandardInput();int command;while((command=input.ReadByte())>=0&&command!=81){} }
    catch { /* A broken stdin is also shutdown, never a wheel command. */ }
    finally {
     System.Threading.Interlocked.Exchange(ref quitRequested,1);
     PostThreadMessage(ownerThread,0x0012,UIntPtr.Zero,IntPtr.Zero);
    }
   });
   inputThread.IsBackground=true;inputThread.Start();
   int result;
   while((result=GetMessage(out message,IntPtr.Zero,0,0))>0){TranslateMessage(ref message);DispatchMessage(ref message);}
   if(failure!=null)throw failure;
   if(result<0)throw new Exception("scroll-wheel-message-loop-failed");
   return 0;
  }finally {
   System.Threading.Interlocked.Exchange(ref quitRequested,1);
   if(hook!=IntPtr.Zero)UnhookWindowsHookEx(hook);
   GC.KeepAlive(callback);
   if(initialDesktop!=IntPtr.Zero)CloseDesktop(initialDesktop);
  }
 }
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
 [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
 [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj,int index,StringBuilder value,uint length,out uint needed);
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] static extern IntPtr MonitorFromRect(ref Rect rect,uint flags);
 [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor,ref MonitorInfo info);
 [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
 [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window,IntPtr dc);
 [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
 [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc,ref BitmapInfo info,uint usage,out IntPtr bits,IntPtr section,uint offset);
 [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc,IntPtr obj);
 [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
 [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
 [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr target,int x,int y,int width,int height,IntPtr source,int sx,int sy,uint op);
 [DllImport("gdi32.dll")] static extern bool GdiFlush();
 static string DesktopName(IntPtr desktop) {var s=new StringBuilder(256);uint n;if(desktop==IntPtr.Zero||!GetUserObjectInformation(desktop,2,s,512,out n))throw new Exception("input-desktop-unavailable");return s.ToString();}
 static void Check(IntPtr monitor,MonitorInfo initial,string desktop) {
  IntPtr input=OpenInputDesktop(0,false,1);try{if(DesktopName(input)!=desktop)throw new Exception("input-desktop-changed");}finally{if(input!=IntPtr.Zero)CloseDesktop(input);}
  var now=new MonitorInfo{Size=initial.Size};if(!GetMonitorInfo(monitor,ref now)||now.Monitor.Left!=initial.Monitor.Left||now.Monitor.Top!=initial.Monitor.Top||now.Monitor.Right!=initial.Monitor.Right||now.Monitor.Bottom!=initial.Monitor.Bottom)throw new Exception("monitor-changed");
 }
 static void Write(Stream stream,int width,int height,uint sequence,byte[] rgba) {
  var h=new byte[20];h[0]=74;h[1]=71;h[2]=67;h[3]=50;Buffer.BlockCopy(BitConverter.GetBytes(width),0,h,4,4);Buffer.BlockCopy(BitConverter.GetBytes(height),0,h,8,4);Buffer.BlockCopy(BitConverter.GetBytes(sequence),0,h,12,4);h[16]=1;stream.Write(h,0,20);stream.Write(rgba,0,rgba.Length);stream.Flush();
 }
 static int Main(string[] args) {
  IntPtr screen=IntPtr.Zero,memory=IntPtr.Zero,bitmap=IntPtr.Zero,previous=IntPtr.Zero;
  try {
   if(args.Length>0&&args[0]=="--scroll-wheel") {
    if(args.Length!=6)throw new Exception("invalid-arguments");
    return ScrollWheel(args);
   }
   if(args.Length==1&&args[0]=="--fg") {
    // Foreground HWND plus its process id: the caller drops its own window from the hand-back hint.
    IntPtr owner=GetForegroundWindow();uint process;
    GetWindowThreadProcessId(owner,out process);
    Console.Out.Write(owner.ToInt64().ToString()+" "+process.ToString());
    Console.Out.Flush();
    return 0;
   }
   if(args.Length==1&&args[0]=="--watch-cancel")return WatchCancel();
   Stream output=Console.OpenStandardOutput();
   if(args.Length==1&&args[0]=="--self-test"){Write(output,2,2,1,new byte[]{1,2,3,255,4,5,6,255,7,8,9,255,10,11,12,255});return 0;}
   if(args.Length!=4)throw new Exception("invalid-arguments");int x=int.Parse(args[0]),y=int.Parse(args[1]),w=int.Parse(args[2]),h=int.Parse(args[3]);
   if(Math.Abs((long)x)>1000000||Math.Abs((long)y)>1000000||w<1||h<1||(long)w*h>16000000)throw new Exception("invalid-region");
   if(SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero)throw new Exception("dpi-context-failed");
   var roi=new Rect{Left=x,Top=y,Right=x+w,Bottom=y+h};IntPtr monitor=MonitorFromRect(ref roi,0);var initial=new MonitorInfo{Size=Marshal.SizeOf(typeof(MonitorInfo))};
   if(monitor==IntPtr.Zero||!GetMonitorInfo(monitor,ref initial)||x<initial.Monitor.Left||y<initial.Monitor.Top||x+w>initial.Monitor.Right||y+h>initial.Monitor.Bottom)throw new Exception("region-outside-monitor");
   string desktop=DesktopName(GetThreadDesktop(GetCurrentThreadId()));Check(monitor,initial,desktop);
   screen=GetDC(IntPtr.Zero);if(screen==IntPtr.Zero)throw new Exception("screen-dc-failed");memory=CreateCompatibleDC(screen);if(memory==IntPtr.Zero)throw new Exception("memory-dc-failed");
   var info=new BitmapInfo{Size=40,Width=w,Height=-h,Planes=1,BitCount=32,SizeImage=checked((uint)(w*h*4))};IntPtr bits;
   bitmap=CreateDIBSection(screen,ref info,0,out bits,IntPtr.Zero,0);if(bitmap==IntPtr.Zero||bits==IntPtr.Zero)throw new Exception("dib-failed");
   previous=SelectObject(memory,bitmap);if(previous==IntPtr.Zero||previous==new IntPtr(-1))throw new Exception("select-bitmap-failed");
   var rgba=new byte[checked(w*h*4)];uint sequence=0;Stream input=Console.OpenStandardInput();int command;
   while((command=input.ReadByte())>=0&&command!=81){
    if(command!=78)throw new Exception("invalid-command");Check(monitor,initial,desktop);
    if(!BitBlt(memory,0,0,w,h,screen,x,y,0x40CC0020)||!GdiFlush())throw new Exception("snapshot-failed");
    Marshal.Copy(bits,rgba,0,rgba.Length);Check(monitor,initial,desktop);
    for(int i=0;i<rgba.Length;i+=4){byte b=rgba[i];rgba[i]=rgba[i+2];rgba[i+2]=b;rgba[i+3]=255;}
    Write(output,w,h,checked(++sequence),rgba);
   }return 0;
  }catch(Exception e){Console.Error.WriteLine("gdi-capture:"+e.Message);return 1;}
  finally{if(memory!=IntPtr.Zero&&previous!=IntPtr.Zero&&previous!=new IntPtr(-1))SelectObject(memory,previous);if(bitmap!=IntPtr.Zero)DeleteObject(bitmap);if(memory!=IntPtr.Zero)DeleteDC(memory);if(screen!=IntPtr.Zero)ReleaseDC(IntPtr.Zero,screen);}
 }
}
