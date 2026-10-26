// 把网页原型（prototype/index.html）注入「桌面应用层」，输出到 src/index.html
// 原型和桌面版共用一个源；改完原型重跑本脚本即可
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'prototype', 'index.html');
const OUT_DIR = path.join(__dirname, '..', 'src');
const OUT = path.join(OUT_DIR, 'index.html');

const APP_LAYER = `
<script>
/* ===================== APP LAYER（Electron 专用，网页原型里不会执行） ===================== */
if (window.native) {
  document.body.classList.add('app');

  const st = document.createElement('style');
  st.textContent = \`
    body.app { background: transparent !important; }
    body.app .desktop, body.app .fab { display: none !important; }
    body.app #dock { left:0 !important; top:0 !important; right:auto !important; bottom:auto !important; transform:none !important; align-items:center; }
    body.app #dock[data-orient="h"] { width:100% !important; }
    body.app .panel { height: var(--panel-h, 600px) !important; }
    body.app .toast-layer { top: 54px !important; right: 14px !important; }
    body.app .toast { width: 300px !important; }
    body.app .rail-grip { -webkit-app-region: drag; }
    body.app .tab, body.app .rail-add, body.app .rail-gear, body.app .panel,
    body.app .pin, body.app input { -webkit-app-region: no-drag; }
  \`;
  document.head.appendChild(st);

  /* ---------- 尺寸上报 ---------- */
  function pushNativeState() {
    try {
      const s = settings.scale || 1;
      const isH = dock.dataset.orient === 'h';
      const avail = (window.screen && window.screen.availHeight) || 900;
      const panelH = Math.round(Math.min(600 * s, avail - (isH ? 130 : 60)));
      const panelW = Math.round((isH ? 302 : 282) * s);
      dock.style.setProperty('--panel-h', panelH + 'px');

      const r = rail.getBoundingClientRect();
      window.native.setState({
        railW: Math.ceil(r.width), railH: Math.ceil(r.height),
        panelW, panelH,
        scale: s, pos: settings.pos, orient: dock.dataset.orient,
        freeX: settings.freeX, freeY: settings.freeY,
        top: settings.alwaysOnTop !== false
      });
    } catch (e) { }
  }

  /* ---------- 开合：判断权在主进程，这里只负责视觉 ---------- */
  function applyOpenVisual() {
    if (isOpen) return;
    isOpen = true;
    dock.classList.add('is-open');
  }
  function applyCloseVisual() {
    if (!isOpen) return;
    isOpen = false;
    dock.classList.remove('is-open');
    const tl = document.getElementById('toastLayer');
    if (tl) tl.innerHTML = '';                  // 窗口缩回标签栏后卡片会被裁掉，直接清掉
    if (screen === 'settings') { screen = 'list'; render(); }
  }

  /* ---------- 提醒：主进程会把便签滑出来，这里只负责画卡片 ---------- */
  fireToast = function (task) {
    window.native.remind({ id: task.id, title: task.title, due: task.due || '' });
  };
  window.native.onRemindDisplay((d) => {
    const t = tasks.find(x => String(x.id) === String(d.id)) || d;
    showToast(t);
  });

  armOpen = function () { };
  scheduleClose = function () { };
  openPanel = function () { applyOpenVisual(); window.native.requestOpen(); };
  closePanel = function () { applyCloseVisual(); window.native.requestClose(true); };

  window.native.onVisual(({ open }) => { if (open) applyOpenVisual(); else applyCloseVisual(); });

  /* ---------- 每次重渲染后同步尺寸 ---------- */
  const _render = render;
  render = function () { _render(); pushNativeState(); };

  /* ---------- 拖动交给系统窗口拖动 ---------- */
  startDrag = function () { return; };
  renderRail();

  /* ---------- 设置项联动 ---------- */
  document.getElementById('swTop').addEventListener('click', () => window.native.setTop(!!settings.alwaysOnTop));
  document.getElementById('swStart').addEventListener('click', () => window.native.setAutoStart(!!settings.autoStart));
  document.getElementById('scaleRange').addEventListener('input', () => pushNativeState());
  document.getElementById('posGroup').addEventListener('click', () => setTimeout(pushNativeState, 0));

  /* ---------- 悬停参数与固定状态同步给主进程 ---------- */
  function syncPrefs() {
    window.native.setPrefs({
      openDelay: settings.openDelay,
      pinned: !!pinned,
      hideOnFullscreen: settings.hideOnFullscreen !== false,
      hideOnOcclude: settings.hideOnOcclude !== false
    });
  }
  document.getElementById('delayRange').addEventListener('input', syncPrefs);
  document.getElementById('swFull').addEventListener('click', () => setTimeout(syncPrefs, 0));
  document.getElementById('swOcc').addEventListener('click', () => setTimeout(syncPrefs, 0));
  pinBtn.addEventListener('click', () => setTimeout(syncPrefs, 0));

  /* ---------- 系统拖动结束后：吸附 / 记忆位置 ---------- */
  window.native.onMoved(({ pos, freeX, freeY }) => {
    settings.pos = pos;
    settings.orient = (pos === 'top' || pos === 'bottom') ? 'h' : (pos === 'free' ? settings.orient : 'v');
    if (pos === 'free') { settings.freeX = freeX; settings.freeY = freeY; }
    save();
    applyPos();
    render();
  });

  /* ---------- 托盘菜单操作 ---------- */
  window.native.onAction(({ type, value }) => {
    if (type === 'alwaysOnTop') settings.alwaysOnTop = !!value;
    if (type === 'autoStart') settings.autoStart = !!value;
    if (type === 'hideOnFullscreen') settings.hideOnFullscreen = !!value;
    if (type === 'hideOnOcclude') settings.hideOnOcclude = !!value;
    save();
    renderSettings();
  });

  /* ---------- 全局快捷键 Ctrl+Alt+N ---------- */
  window.native.onQuickAdd(() => {
    openPanel();
    setTimeout(() => document.getElementById('addInput').focus(), 320);
  });

  /* ---------- 窗口失焦 ---------- */
  window.native.onBlur(() => window.native.requestClose());

  /* ---------- 点系统通知 → 展开并定位到那条待办 ---------- */
  window.native.onFocusTask((d) => {
    if (!d) return;
    const t = tasks.find(x => String(x.id) === String(d.id));
    if (t) {
      currentTagId = t.done ? (tags.find(x => x.system) || tags[0]).id : (t.tagId || tags[0].id);
      screen = 'list';
      render();
    }
    openPanel();
    setTimeout(() => {
      const el = document.querySelector('.item[data-id="' + d.id + '"]');
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      el.style.background = '#fff7e6';
      setTimeout(() => { el.style.background = ''; }, 1800);
    }, 300);
  });

  /* ---------- 测试钩子 ---------- */
  if (window.native.isTest) {
    window.__test = {
      checkDue: checkDue,
      tick: checkDue,
      open: () => isOpen,
      pinned: () => pinned,
      toasts: () => document.querySelectorAll('.toast').length,
      tasks: () => tasks.map(t => ({
        id: t.id, title: t.title, due: t.due, dueAt: t.dueAt,
        reminded: t.reminded, done: t.done
      })),
      add: (t) => { tasks.unshift(t); save(); render(); }
    };
  }

  pushNativeState();
  syncPrefs();
  setTimeout(pushNativeState, 200);
  checkDue();                                   // 启动即补一次（此时已接上系统通知）
}
</script>
`;

if (!fs.existsSync(SRC)) {
  console.error('找不到原型文件:', SRC);
  process.exit(1);
}
const html = fs.readFileSync(SRC, 'utf8');
if (!html.includes('</body>')) {
  console.error('原型文件结构异常');
  process.exit(1);
}
const out = html.replace('</body>', APP_LAYER + '\n</body>');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, out);
console.log('已生成', OUT, (out.length / 1024).toFixed(1) + 'KB');
