# 常驻检测：每 500ms 向 stdout 输出一行两个数字，例如 "0 1"。
#   第一位：前台窗口是不是「盖满整块显示器」的全屏窗口（看片 / 演示 / 游戏）
#   第二位：便签所在的那块区域，有没有被别的窗口压住（哪怕是普通窗口）
# 由主进程通过环境变量 SIDENOTE_DOCK_RECT="x,y,w,h" 告诉它便签的位置。
# 只用 user32 / dwmapi，CPU 占用可忽略。

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Fsd {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT pvAttribute, int cbAttribute);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] public static extern int DwmGetWindowAttributeInt(IntPtr hwnd, int attr, out int pvAttribute, int cbAttribute);
}
'@

$selfId = $PID
# 父进程（Electron 主进程）的 pid：既是「自己人」，也是防止应用被强杀后留下孤儿进程的锚点
$parentId = 0
try { $parentId = (Get-CimInstance Win32_Process -Filter "ProcessId=$selfId" -ErrorAction Stop).ParentProcessId } catch { $parentId = 0 }

# 桌面、开始菜单、搜索、输入法这些「长得像全屏 / 盖住一切」的 shell 窗口要排除
$skip = @('explorer', 'ShellExperienceHost', 'StartMenuExperienceHost', 'SearchHost',
          'SearchApp', 'LockApp', 'TextInputHost', 'ApplicationFrameHost', 'SystemSettings',
          'electron', 'SideNote')

# 便签收起时露在桌面上的那块矩形（屏幕坐标）
$dock = $null
if ($env:SIDENOTE_DOCK_RECT) {
  $q = $env:SIDENOTE_DOCK_RECT.Split(',')
  if ($q.Count -eq 4) {
    $dock = New-Object Fsd+RECT
    $dock.Left = [int]$q[0]
    $dock.Top = [int]$q[1]
    $dock.Right = [int]$q[0] + [int]$q[2]
    $dock.Bottom = [int]$q[1] + [int]$q[3]
  }
}

# pid → 进程名，缓存一下：每 500ms 对几十个窗口各查一次进程太浪费
$nameCache = @{}
function Get-PName([int]$procId) {
  if ($nameCache.ContainsKey($procId)) { return $nameCache[$procId] }
  $pn = ''
  try { $pn = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { $pn = '' }
  $nameCache[$procId] = $pn
  return $pn
}

# 前台窗口是否铺满整块显示器
function Get-FsState {
  $h = [Fsd]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { return 0 }
  $opid = 0
  [void][Fsd]::GetWindowThreadProcessId($h, [ref]$opid)
  if ($opid -eq 0 -or $opid -eq $selfId -or $opid -eq $parentId) { return 0 }
  $pn = Get-PName $opid
  if ($pn -eq '' -or $skip -contains $pn) { return 0 }

  # 优先用 DWM 的真实边界：普通 GetWindowRect 会把不可见的阴影边框算进去
  $r = New-Object Fsd+RECT
  $ok = ([Fsd]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) -eq 0)
  if (-not $ok) { $ok = [Fsd]::GetWindowRect($h, [ref]$r) }
  if (-not $ok) { return 0 }

  $mi = New-Object Fsd+MONITORINFO
  $mi.cbSize = 40
  $mon = [Fsd]::MonitorFromWindow($h, 2)
  if (-not [Fsd]::GetMonitorInfo($mon, [ref]$mi)) { return 0 }

  $mw = $mi.rcMonitor.Right - $mi.rcMonitor.Left
  $mh = $mi.rcMonitor.Bottom - $mi.rcMonitor.Top
  $ww = $r.Right - $r.Left
  $wh = $r.Bottom - $r.Top
  if ($ww -ge ($mw - 2) -and $wh -ge ($mh - 2) -and
      $r.Left -le ($mi.rcMonitor.Left + 2) -and $r.Top -le ($mi.rcMonitor.Top + 2)) { return 1 }
  return 0
}

# 便签那块区域是否被别的窗口压住
# 按 Z 序从上往下扫：第一个「不是自己、不是系统外壳」且压住目标区域的窗口，就算遮挡
function Get-OccState {
  if ($dock -eq $null) { return 0 }
  $dw = $dock.Right - $dock.Left
  $dh = $dock.Bottom - $dock.Top
  if ($dw -le 0 -or $dh -le 0) { return 0 }
  $need = [int]($dw * $dh * 0.3)          # 压住 30% 以上才算，避免边缘擦到就躲

  $h = [Fsd]::GetTopWindow([IntPtr]::Zero)
  $guard = 0
  while ($h -ne [IntPtr]::Zero -and $guard -lt 250) {
    $guard++
    $nextH = [Fsd]::GetWindow($h, 2)      # GW_HWNDNEXT
    if ([Fsd]::IsWindowVisible($h) -and -not [Fsd]::IsIconic($h)) {
      $opid = 0
      [void][Fsd]::GetWindowThreadProcessId($h, [ref]$opid)
      if ($opid -ne 0 -and $opid -ne $selfId -and $opid -ne $parentId) {
        $pn = Get-PName $opid
        if ($pn -ne '' -and $skip -notcontains $pn) {
          # UWP 应用会留一堆「可见但被遮蔽」的后台窗口，它们铺满全屏，必须排除
          $cl = 0
          $cloaked = ([Fsd]::DwmGetWindowAttributeInt($h, 14, [ref]$cl, 4) -eq 0 -and $cl -ne 0)
          if (-not $cloaked) {
            $r = New-Object Fsd+RECT
            $ok = ([Fsd]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) -eq 0)
            if (-not $ok) { $ok = [Fsd]::GetWindowRect($h, [ref]$r) }
            if ($ok) {
              $ix = [Math]::Min($r.Right, $dock.Right) - [Math]::Max($r.Left, $dock.Left)
              $iy = [Math]::Min($r.Bottom, $dock.Bottom) - [Math]::Max($r.Top, $dock.Top)
              if ($ix -gt 0 -and $iy -gt 0 -and ($ix * $iy) -ge $need) { return 1 }
            }
          }
        }
      }
    }
    $h = $nextH
  }
  return 0
}

$n = 0
while ($true) {
  $fsv = 0
  $occv = 0
  try { $fsv = Get-FsState } catch { $fsv = 0 }
  try { $occv = Get-OccState } catch { $occv = 0 }

  [Console]::Out.WriteLine("$fsv $occv")
  [Console]::Out.Flush()

  $n++
  # 每 10 秒确认一次父进程还在
  if ($parentId -ne 0 -and ($n % 20 -eq 0)) {
    if (-not (Get-Process -Id $parentId -ErrorAction SilentlyContinue)) { break }
  }
  Start-Sleep -Milliseconds 500
}
