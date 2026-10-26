const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ICON = path.join(__dirname, 'assets', 'icon.png');
const IS_TEST = process.env.SIDENOTE_TEST === '1';

let win = null;
let tray = null;
let st = null;                                  // 渲染进程上报的尺寸/停靠信息
let prefs = { openDelay: 400, closeDelay: 130, pinned: false };
let isOpen = false;
let dragging = false;
let dragCooldownUntil = 0;
let selfMoveUntil = 0;                          // 自己 setBounds 引起的 move 事件，忽略
let lastApplied = null;                         // 上一次自己设定的位置，用来识别「不是用户拖的」
let lastMoveAt = 0;
let openTimer = null;
let closeTimer = null;
let outsideSince = 0;                           // 光标开始在窗口外的时间戳（兜底用）
let holdUntil = 0;                              // 提醒期间强制展开，不因鼠标离开而收起
let testCursor = null;                          // 仅在 SIDENOTE_TEST=1 时用于自动化测试
let manualHidden = false;                        // 用户自己从托盘/按钮藏的，别自动冒回来

const ui = { alwaysOnTop: true, autoStart: false, hideOnFullscreen: true, hideOnOcclude: true };

/* Windows 通知需要这个 ID，否则可能不显示 */
try { app.setAppUserModelId('com.sidenote.dock'); } catch (e) { }

/* 测试时指定独立数据目录，不碰用户真实数据 */
if (process.env.SIDENOTE_DATA) {
  try { app.setPath('userData', process.env.SIDENOTE_DATA); } catch (e) { }
}

/* ---------------- 窗口 ---------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 152, height: 276, x: 0, y: 200,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  if (typeof win.setVisibleOnAllWorkspaces === 'function') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  win.on('moved', onMoved);                       // macOS 只在完全停下时发一次
  win.on('move', () => {                          // Windows/Linux 靠这个，内部有 280ms 防抖
    if (Date.now() < selfMoveUntil) return;       // 自己改尺寸引起的移动，不算用户拖动
    lastMoveAt = Date.now();
    onMoved();
  });
  win.on('blur', () => sendToRenderer('win:blur'));
  win.on('closed', () => {
    win = null;
    clearTimers();
    // 这个窗口没有关闭按钮，但 Alt+F4 / 系统原因仍可能关掉它。
    // 不重建的话托盘还在、窗口没了，点托盘什么也不发生，只能退出重开。
    if (!app.isQuitting) setTimeout(() => { if (!win && !app.isQuitting) createWindow(); }, 300);
  });
}

function sendToRenderer(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

/* ---------------- 窗口边界 ---------------- */
/* 只算不设 —— 收起状态下这块就是露在桌面上的标签栏，遮挡检测要用它 */
function computeBounds(open) {
  if (!win || win.isDestroyed() || !st) return null;
  // 用窗口当前所在的显示器，而不是主显示器 —— 否则拖到副屏会被拽回主屏。
  // 自由摆放时以记住的坐标为锚点判断屏幕，避免启动时（窗口还在默认位置）被拉回主屏。
  const cur = win.getBounds();
  const probe = (st.pos === 'free' && st.freeX != null && st.freeY != null)
    ? { x: st.freeX, y: st.freeY, width: 1, height: 1 }
    : cur;
  const wa = screen.getDisplayMatching(probe).workArea;
  const s = st.scale || 1;
  let w, h;

  if (st.orient === 'h') {
    w = open ? Math.max(st.railW, st.panelW) : st.railW;
    h = open ? st.railH + 10 * s + st.panelH : st.railH;
  } else {
    w = open ? st.railW + 12 * s + st.panelW : st.railW;
    h = open ? Math.max(st.railH, st.panelH) : st.railH;
  }
  w = Math.round(Math.min(w, wa.width));
  h = Math.round(Math.min(h, wa.height));

  const cx = wa.x + wa.width / 2;
  const cy = wa.y + wa.height / 2;
  let x, y;

  switch (st.pos) {
    case 'right': x = wa.x + wa.width - w; y = Math.round(cy - h / 2); break;
    case 'top': x = Math.round(cx - w / 2); y = wa.y; break;
    case 'bottom': x = Math.round(cx - w / 2); y = wa.y + wa.height - h; break;
    case 'free':
      x = Math.round(st.freeX != null ? st.freeX : 80);
      y = Math.round(st.freeY != null ? st.freeY : 200);
      break;
    default: x = wa.x; y = Math.round(cy - h / 2);
  }

  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - w));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - h));

  return { x, y, width: w, height: h };
}

function applyBounds(open) {
  if (!win || win.isDestroyed() || !st) return;
  const b = computeBounds(open);
  if (!b) return;
  selfMoveUntil = Date.now() + 260;
  lastApplied = b;
  win.setBounds(b);
  syncOccRect();                                  // 停靠 / 缩放 / 换屏后，检测区域要跟着挪
}

/* ---------------- 开合状态（唯一真相在主进程） ---------------- */
function clearTimers() {
  if (openTimer) { clearTimeout(openTimer); openTimer = null; }
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
}

function setOpen(v) {
  if (!win || win.isDestroyed()) return;
  if (v === isOpen) {
    sendToRenderer('dock:visual', { open: isOpen });
    return;
  }
  isOpen = v;
  applyBounds(v);
  sendToRenderer('dock:visual', { open: v });
}

/* 光标位置：测试时用注入值，正常时读系统光标（不依赖任何鼠标事件） */
function curPos() {
  return (IS_TEST && testCursor) ? testCursor : screen.getCursorScreenPoint();
}

/* 光标是否落在窗口矩形内 */
function cursorInside() {
  if (!win || win.isDestroyed()) return false;
  const b = win.getBounds();
  const p = curPos();
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
}

/* 每 60ms 检查一次光标位置 —— 鼠标甩得再快也不会漏 */
function hoverTick() {
  if (!win || win.isDestroyed() || !st) return;
  if (dragging || Date.now() < dragCooldownUntil) return;
  if (Date.now() - lastMoveAt < 350) return;   // 正在被用户拖动窗口

  /* 被别的窗口压住时：整个藏起来，只留一条贴边的“招呼区”，
     光标贴到屏幕边缘停一下才重新露出来 —— 这样它永远不会压住你在看的东西。 */
  if (occActive()) {
    if (!occReveal()) {
      if (isOpen && !prefs.pinned && !closeTimer) {
        closeTimer = setTimeout(() => { closeTimer = null; setOpen(false); }, prefs.closeDelay);
      }
      if (!isOpen && win.isVisible()) {
        clearTimers(); holdUntil = 0;
        Occ.hidden = true;
        win.hide();
      }
      return;
    }
    if (!win.isVisible()) {
      Occ.hidden = false;
      win.showInactive();
      sendToRenderer('dock:visual', { open: isOpen });
    }
  }

  if (!win.isVisible()) { clearTimers(); return; }

  if (cursorInside()) {
    outsideSince = 0;
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    if (!isOpen && !openTimer) {
      openTimer = setTimeout(() => { openTimer = null; setOpen(true); }, prefs.openDelay);
    }
  } else {
    if (!outsideSince) outsideSince = Date.now();
    if (openTimer) { clearTimeout(openTimer); openTimer = null; }
    // 提醒展示期间保持展开（15 秒），别刚弹出来就被收起
    if (holdUntil) {
      if (Date.now() < holdUntil) { outsideSince = 0; return; }
      holdUntil = 0;
      outsideSince = Date.now();   // 锁刚放开，从这一刻起重新算离开时长
    }
    if (isOpen && !prefs.pinned && !closeTimer) {
      closeTimer = setTimeout(() => { closeTimer = null; setOpen(false); }, prefs.closeDelay);
    }
    // 兜底：无论什么时序问题，离开超过 1.5 秒一定收起，杜绝「一直显示」
    if (isOpen && !prefs.pinned && Date.now() - outsideSince > 1500) {
      clearTimers();
      setOpen(false);
    }
  }
}

/* ---------------- 全屏让位 ----------------
   有别的窗口全屏（看视频、演示、游戏）时，便签藏在屏幕边缘仍然会露出来，
   一直压在画面边上很碍事。这里让主进程持续判断「当前是不是有全屏窗口」，
   有就整个收起来，退出全屏再还原。
   检测放在常驻 PowerShell 子进程里（见 assets/fullscreen-watch.ps1）：
   Node 自身拿不到前台窗口信息，装原生模块又要编译环境，这条最稳。 */
const Fs = {
  proc: null,
  isFs: false,
  hidden: false,          // 这次隐藏是不是全屏导致的（手动隐藏不算，退出全屏不该冒出来）
  unavailable: false,     // 检测起不来就永久降级：当作没有全屏，功能失效但不报错
  locked: false,          // 测试注入后不再听真实检测，避免两边打架
  stopped: false,         // 用户关掉这个功能时置 true，不再自动重启检测进程
  restarts: 0,
  lastBeat: 0,
  startedAt: 0,
  restartDelay: 3000,
  buf: ''
};

function startFsWatcher() {
  if (Fs.proc || Fs.unavailable || Fs.stopped) return;
  if (process.platform !== 'win32') { Fs.unavailable = true; return; }
  if (!watcherNeeded()) return;

  let code;
  try {
    // 打包后脚本在 asar 里，Electron 的 fs 补丁可以直接读；BOM 会干扰命令行，去掉
    code = fs.readFileSync(path.join(__dirname, 'assets', 'fullscreen-watch.ps1'), 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    Fs.unavailable = true;
    return;
  }

  // -EncodedCommand 用 UTF-16LE base64，彻底绕开引号与中文编码问题
  const b64 = Buffer.from(code, 'utf16le').toString('base64');
  try {
    Fs.proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      // 便签现在的位置通过环境变量传进去，脚本才知道该盯着哪块区域
      env: Object.assign({}, process.env, { SIDENOTE_DOCK_RECT: Occ.rectKey || '' })
    });
  } catch (e) {
    Fs.unavailable = true;
    return;
  }

  const p = Fs.proc;
  Fs.lastBeat = Date.now();
  Fs.startedAt = Date.now();
  Fs.restartDelay = 3000;

  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (chunk) => {
    Fs.lastBeat = Date.now();
    Fs.buf += chunk;
    const lines = Fs.buf.split(/\r?\n/);
    Fs.buf = lines.pop() || '';                       // 最后一段可能是半行，留着
    for (const ln of lines) {
      const t = ln.trim();
      if (!t) continue;
      const parts = t.split(/\s+/);
      if (!Fs.locked && (parts[0] === '0' || parts[0] === '1')) setFullscreen(parts[0] === '1');
      if (!Occ.locked && (parts[1] === '0' || parts[1] === '1')) setOccluded(parts[1] === '1');
    }
  });

  p.on('error', () => { Fs.unavailable = true; Fs.proc = null; });
  p.on('exit', () => {
    Fs.proc = null;
    if (Fs.stopped || Fs.unavailable || app.isQuitting) return;
    // 刚起来就死 = 真的有问题，累计 5 次就降级；活过一会儿再死 = 正常重启，从头计数
    if (Date.now() - Fs.startedAt > 2000) Fs.restarts = 0;
    else Fs.restarts++;
    if (Fs.restarts >= 5) { Fs.unavailable = true; return; }
    const delay = Fs.restartDelay;
    setTimeout(() => { if (!Fs.stopped && watcherNeeded()) startFsWatcher(); }, delay);
  });
}

function stopFsWatcher() {
  Fs.stopped = true;
  if (Fs.proc) {
    try { Fs.proc.kill(); } catch (e) { }
    Fs.proc = null;
  }
  clearTimeout(Occ.restartTimer);
  Fs.isFs = false;
  if (Occ.occluded) { Occ.occluded = false; }
  applyFsPolicy();
  if (Occ.hidden) {                                 // 关掉功能就别再藏着了
    Occ.hidden = false;
    if (!manualHidden && win && !win.isDestroyed() && !win.isVisible()) win.showInactive();
  }
}

function setFullscreen(v) {
  if (v === Fs.isFs) return;
  Fs.isFs = v;
  applyFsPolicy();
}

function applyFsPolicy() {
  if (!win || win.isDestroyed()) return;
  const wantHide = Fs.isFs && ui.hideOnFullscreen !== false;

  if (wantHide) {
    if (!win.isVisible()) return;                     // 用户自己已经隐藏了，别动
    Fs.hidden = true;
    clearTimers();
    holdUntil = 0;
    setOpen(false);                                   // 先收回标签栏再藏，下次露出来是收起的
    win.hide();
    return;
  }

  if (Fs.hidden) {
    Fs.hidden = false;
    if (manualHidden) return;
    if (pendingReminders.length) { flushPendingReminders(); return; }   // 补弹本身会把它叫出来
    if (occActive()) { Occ.hidden = true; return; }                     // 出来也是压着别人，交给遮挡逻辑
    win.showInactive();
    sendToRenderer('dock:visual', { open: isOpen });
  }
}

/* 全屏期间到点的提醒先存着，退出全屏再一起弹，免得盖在游戏/视频上 */
let pendingReminders = [];
function flushPendingReminders() {
  if (!pendingReminders.length || Fs.isFs) return;
  const list = pendingReminders;
  pendingReminders = [];
  list.forEach((d) => showReminder(d));
}

/* 心跳：8 秒没吐数据说明子进程卡住了，杀掉让 exit 回调重启 */
setInterval(() => {
  if (!Fs.proc) return;
  if (Date.now() - Fs.lastBeat > 8000) {
    try { Fs.proc.kill(); } catch (e) { }
  }
}, 4000);

/* ---------------- 被窗口压住就自动让位 ----------------
   全屏只是一个特例。更常见的是：浏览器最大化、编辑器开着，便签仍然浮在最上面，
   正好压住人家的一行字。这里让主进程知道「便签那块地方是不是被窗口盖住了」，
   盖住了就整个收起来，别挡着；光标贴到屏幕边缘停一下，它再滑出来。
   检测同样交给上面那个常驻脚本（第二个数字）。 */
const Occ = {
  occluded: false,
  hidden: false,          // 这次隐藏是遮挡导致的（用户自己藏的不算）
  rect: null,             // 收起时的矩形，= 遮挡检测范围
  rectKey: '',
  revealSince: 0,         // 光标在贴边区域停留的起点
  restartTimer: null,
  locked: IS_TEST         // 测试模式默认不听真实检测，免得跑测试时被别的窗口干扰
};

function watcherNeeded() {
  return ui.hideOnFullscreen !== false || ui.hideOnOcclude !== false;
}

/* 遮挡检测范围变了（换边、缩放、拖到别处）→ 让子进程按新范围重来 */
function syncOccRect() {
  if (!st || !win || win.isDestroyed()) return;
  const r = computeBounds(false);
  if (!r) return;
  const key = r.x + ',' + r.y + ',' + r.width + ',' + r.height;
  if (key === Occ.rectKey) return;
  Occ.rectKey = key;
  Occ.rect = r;
  if (!Fs.proc) { startFsWatcher(); return; }    // 还没起来就用新范围起
  clearTimeout(Occ.restartTimer);
  Occ.restartTimer = setTimeout(() => {
    if (!Fs.proc || Fs.stopped || Fs.unavailable) return;
    Fs.restartDelay = 600;                        // 换范围属于正常重启，快点回来
    try { Fs.proc.kill(); } catch (e) { }
  }, 700);
}

function occActive() {
  if (!Occ.occluded || ui.hideOnOcclude === false) return false;
  if (Fs.isFs && ui.hideOnFullscreen !== false) return false;   // 全屏已经整个藏了
  return true;
}

/* 贴边“招呼区”：沿着便签停靠的那条屏幕边，放宽 4px；自由摆放时用它自己的矩形 */
function edgeBandHit() {
  const r = Occ.rect;
  if (!r || !st) return false;
  const p = curPos();
  const b = 6, slack = 60;
  switch (st.pos) {
    case 'left':
      return p.x < r.x + b && p.x >= r.x - 40 &&
        p.y >= r.y - slack && p.y <= r.y + r.height + slack;
    case 'right':
      return p.x > r.x + r.width - b && p.x <= r.x + r.width + 40 &&
        p.y >= r.y - slack && p.y <= r.y + r.height + slack;
    case 'top':
      return p.y < r.y + b && p.y >= r.y - 40 &&
        p.x >= r.x - slack && p.x <= r.x + r.width + slack;
    case 'bottom':
      return p.y > r.y + r.height - b && p.y <= r.y + r.height + 40 &&
        p.x >= r.x - slack && p.x <= r.x + r.width + slack;
    default:
      return p.x >= r.x - 8 && p.x <= r.x + r.width + 8 &&
        p.y >= r.y - 8 && p.y <= r.y + r.height + 8;
  }
}

function occReveal() {
  if (manualHidden) return false;                 // 你自己藏的，别自动冒出来
  if (prefs.pinned) return true;                  // 钉住了就是要一直看得见
  if (holdUntil && Date.now() < holdUntil) return true;   // 刚弹了提醒
  if (win && win.isVisible() && cursorInside()) return true;   // 正在用它
  if (!edgeBandHit()) { Occ.revealSince = 0; return false; }
  if (!Occ.revealSince) Occ.revealSince = Date.now();
  return Date.now() - Occ.revealSince >= 160;     // 停一下才出来，路过不惊动
}

function setOccluded(v) {
  if (v === Occ.occluded) return;
  Occ.occluded = v;
  if (!v) {                                       // 挡它的窗口走了，把便签放回来
    Occ.revealSince = 0;
    if (Occ.hidden) {
      Occ.hidden = false;
      if (!manualHidden && !Fs.hidden && win && !win.isDestroyed() && !win.isVisible()) {
        win.showInactive();
        sendToRenderer('dock:visual', { open: isOpen });
      }
    }
  }
}

/* ---------------- 拖动结束：吸附或记住位置 ---------------- */
let moveTimer = null;
function onMoved() {
  if (!st || !win) return;
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    // 位置就是自己刚设的 → 不是用户拖的，别重复吸附
    if (lastApplied && b.x === lastApplied.x && b.y === lastApplied.y &&
      b.width === lastApplied.width && b.height === lastApplied.height) return;
    const wa = screen.getDisplayMatching(b).workArea;   // 按窗口所在的那块屏判断吸附
    const S = 30;
    let pos = 'free';
    if (b.x - wa.x <= S) pos = 'left';
    else if (wa.x + wa.width - (b.x + b.width) <= S) pos = 'right';
    else if (b.y - wa.y <= S) pos = 'top';
    else if (wa.y + wa.height - (b.y + b.height) <= S) pos = 'bottom';

    st.pos = pos;
    st.freeX = b.x;
    st.freeY = b.y;
    // 这里不立刻 applyBounds：横/竖排布变了，railW/railH 得等页面重新排版后才知道。
    // 马上设会先按旧方向算一次尺寸，肉眼能看到「闪一下」。页面收到 win:moved 后会
    // 重排并回报 win:state，那时再按新方向设，只跳一次。
    sendToRenderer('win:moved', { pos, freeX: b.x, freeY: b.y });
  }, 280);
}

/* ---------------- 托盘 ---------------- */
function buildTray() {
  const img = nativeImage.createFromPath(ICON);
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
  tray.setToolTip('侧边便签');
  tray.on('click', toggleWindow);
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: toggleWindow },
    { type: 'separator' },
    {
      label: '置顶显示', type: 'checkbox', checked: ui.alwaysOnTop,
      click: (item) => {
        ui.alwaysOnTop = item.checked;
        if (win) win.setAlwaysOnTop(item.checked, 'screen-saver');
        sendToRenderer('tray:action', { type: 'alwaysOnTop', value: item.checked });
        refreshTray();
      }
    },
    {
      label: '全屏时让位', type: 'checkbox', checked: ui.hideOnFullscreen !== false,
      click: (item) => {
        ui.hideOnFullscreen = item.checked;
        onWatcherToggle();
        sendToRenderer('tray:action', { type: 'hideOnFullscreen', value: item.checked });
      }
    },
    {
      label: '被窗口挡住时让位', type: 'checkbox', checked: ui.hideOnOcclude !== false,
      click: (item) => {
        ui.hideOnOcclude = item.checked;
        onWatcherToggle();
        sendToRenderer('tray:action', { type: 'hideOnOcclude', value: item.checked });
      }
    },
    {
      label: '开机自启', type: 'checkbox', checked: ui.autoStart,
      click: (item) => {
        setAutoStart(item.checked);
        sendToRenderer('tray:action', { type: 'autoStart', value: item.checked });
        refreshTray();
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) {
    setOpen(false); win.hide(); clearTimers(); holdUntil = 0;
    Fs.hidden = false;                 // 用户自己藏的，全屏结束后不该自己冒出来
    Occ.hidden = false;
    manualHidden = true;
  } else {
    holdUntil = 0; Fs.hidden = false; Occ.hidden = false; manualHidden = false;
    win.showInactive();
  }
}

function setAutoStart(v) {
  ui.autoStart = !!v;
  try { app.setLoginItemSettings({ openAtLogin: !!v, path: process.execPath, args: [] }); } catch (e) { }
}

/* ---------------- IPC ---------------- */
ipcMain.on('win:state', (_e, payload) => {
  st = payload;
  // 置顶以设置里的开关为准，避免托盘勾选状态和开关说的不是一回事
  if (typeof payload.top === 'boolean' && payload.top !== ui.alwaysOnTop) {
    ui.alwaysOnTop = payload.top;
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(payload.top, 'screen-saver');
    refreshTray();
  }
  applyBounds(isOpen);
  // 全屏 / 遮挡让位期间不能顺手把它 show 回来，否则渲染层一重排就又冒出来了
  if (win && !win.isVisible() && !Fs.hidden && !Occ.hidden && !manualHidden) win.showInactive();
  // 渲染进程重载/崩溃恢复后，把主进程的真实开合状态重新同步下去，
  // 否则会出现「窗口已经是展开尺寸、页面却还是收起」的透明大窗口
  sendToRenderer('dock:visual', { open: isOpen });
});

/* 两个“让位”开关共用同一个检测进程：只要还有一个开着就得跑 */
function onWatcherToggle() {
  if (watcherNeeded()) {
    Fs.stopped = false;
    Fs.unavailable = false;
    Fs.restarts = 0;
    startFsWatcher();
  } else {
    pendingReminders = [];
    stopFsWatcher();
  }
  if (ui.hideOnFullscreen === false && Fs.isFs) { Fs.isFs = false; applyFsPolicy(); }
  if (ui.hideOnOcclude === false && Occ.occluded) {
    Occ.occluded = false;
    if (Occ.hidden) {
      Occ.hidden = false;
      if (!manualHidden && win && !win.isDestroyed() && !win.isVisible()) win.showInactive();
    }
  }
  refreshTray();
}

ipcMain.on('app:prefs', (_e, p) => {
  if (!p) return;
  if (typeof p.openDelay === 'number') prefs.openDelay = Math.max(80, Math.min(3000, p.openDelay));
  if (typeof p.closeDelay === 'number') prefs.closeDelay = Math.max(0, Math.min(2000, p.closeDelay));
  if (typeof p.pinned === 'boolean') prefs.pinned = p.pinned;
  let changed = false;
  if (typeof p.hideOnFullscreen === 'boolean' && p.hideOnFullscreen !== ui.hideOnFullscreen) {
    ui.hideOnFullscreen = p.hideOnFullscreen; changed = true;
  }
  if (typeof p.hideOnOcclude === 'boolean' && p.hideOnOcclude !== ui.hideOnOcclude) {
    ui.hideOnOcclude = p.hideOnOcclude; changed = true;
  }
  if (changed) onWatcherToggle();
});

ipcMain.on('dock:want-open', () => { clearTimers(); setOpen(true); });
ipcMain.on('dock:want-close', (_e, force) => {
  // 钉住就不收。以前这里无条件收起，而 Esc 取消钉住时没同步给主进程，
  // 于是主进程一直以为「还钉着」，鼠标离开也不收 —— 表现就是「一直显示」。
  // force：用户明确要求关（Esc / 点图钉取消），此时不再看 pinned。
  if (prefs.pinned && !force) return;
  clearTimers(); holdUntil = 0; setOpen(false);
});

ipcMain.on('drag:start', () => { dragging = true; });
ipcMain.on('drag:end', () => { dragging = false; dragCooldownUntil = Date.now() + 600; });

ipcMain.on('win:top', (_e, v) => {
  ui.alwaysOnTop = !!v;
  if (win) win.setAlwaysOnTop(!!v, 'screen-saver');
  refreshTray();
});

ipcMain.on('app:autostart', (_e, v) => { setAutoStart(!!v); refreshTray(); });
ipcMain.on('app:quit', () => { app.isQuitting = true; app.quit(); });
ipcMain.on('win:hide', () => {
  if (win) {
    setOpen(false); win.hide(); clearTimers(); holdUntil = 0;
    Fs.hidden = false; Occ.hidden = false; manualHidden = true;
  }
});

/* ---------------- 到点提醒 ---------------- */
let remindLog = [];                             // 测试时用来核对「真的发过提醒」

function showReminder(d) {
  if (!d) return;
  remindLog.push({ id: d.id, title: d.title, due: d.due, at: Date.now() });
  if (remindLog.length > 50) remindLog.shift();

  // 全屏中先压着，退出全屏再弹 —— 一条待办不值得打断你看片/开会
  if (Fs.isFs && ui.hideOnFullscreen !== false) {
    if (pendingReminders.length < 5) pendingReminders.push(d);
    return;
  }

  if (!win || win.isDestroyed()) return;

  // 桌面通知在免安装的 exe 上经常不弹（Windows 要求注册 Start Menu 快捷方式），
  // 所以直接让便签自己滑出来 —— 这个一定看得见。
  manualHidden = false;
  Occ.hidden = false;                             // 提醒优先，被挡也要冒出来
  if (!win.isVisible()) win.showInactive();
  setOpen(true);
  holdUntil = Date.now() + 15000;
  outsideSince = 0;
  sendToRenderer('app:remind-display', { id: d.id, title: d.title, due: d.due });
}

ipcMain.on('app:remind', (_e, d) => showReminder(d));
ipcMain.on('hold:release', () => { holdUntil = 0; });
ipcMain.handle('test:remind-log', () => remindLog);
ipcMain.handle('test:top', () => (win && !win.isDestroyed() ? win.isAlwaysOnTop() : null));

ipcMain.handle('win:bounds', () => (win && !win.isDestroyed() ? win.getBounds() : null));
ipcMain.handle('test:visible', () => (win && !win.isDestroyed() ? win.isVisible() : false));
ipcMain.handle('test:fs', () => ({
  detected: Fs.isFs,
  hidden: Fs.hidden,
  occOccluded: Occ.occluded,
  occHidden: Occ.hidden,
  manualHidden,
  running: !!Fs.proc,
  unavailable: Fs.unavailable,
  rect: Occ.rectKey,
  pending: pendingReminders.length
}));
ipcMain.on('test:cursor', (_e, pt) => { if (IS_TEST) testCursor = pt; });
ipcMain.on('test:fullscreen', (_e, v) => {           // 测试里直接注入全屏状态
  if (!IS_TEST) return;
  Fs.locked = true;
  Fs.isFs = !!v;
  applyFsPolicy();
});
ipcMain.on('test:occluded', (_e, v) => {             // 测试里直接注入「被窗口压住」
  if (!IS_TEST) return;
  Occ.locked = true;
  setOccluded(!!v);
});
ipcMain.on('test:occRect', (_e, r) => {              // 测试里直接指定检测区域
  if (!IS_TEST) return;
  Occ.locked = true;
  Occ.rect = r;
  Occ.rectKey = r ? [r.x, r.y, r.width, r.height].join(',') : '';
});
ipcMain.on('test:show', () => {                      // 测试里恢复可见（清掉「用户自己藏的」标记）
  if (!IS_TEST) return;
  manualHidden = false; Occ.hidden = false; Fs.hidden = false;
  if (win && !win.isDestroyed()) win.showInactive();
});
ipcMain.on('test:focus', (_e, d) => { if (IS_TEST) sendToRenderer('app:focus-task', d); });   // 模拟点通知

/* ---------------- 生命周期 ---------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.isQuitting = false;
  app.on('before-quit', () => { app.isQuitting = true; });
  app.on('second-instance', () => {
    if (win) {
      manualHidden = false; Occ.hidden = false;
      win.showInactive();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    buildTray();

    ui.autoStart = app.getLoginItemSettings().openAtLogin;
    refreshTray();

    setInterval(hoverTick, 60);
    startFsWatcher();

    globalShortcut.register('Control+Alt+N', () => {
      if (!win) return;
      // 被窗口挡住 / 全屏时也能用快捷键叫出来，留 20 秒让你把字打完
      manualHidden = false;
      Occ.hidden = false;
      holdUntil = Date.now() + 20000;
      win.showInactive();
      setOpen(true);
      sendToRenderer('app:quickadd');
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    Fs.stopped = true;
    if (Fs.proc) { try { Fs.proc.kill(); } catch (e) { } Fs.proc = null; }
  });
  app.on('window-all-closed', () => { if (app.isQuitting) app.quit(); });
}
