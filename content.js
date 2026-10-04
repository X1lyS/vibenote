/**
 * 悬浮便签 · 内容脚本（Chrome MV3）
 *
 * 用途：在任意页面上随手记录 bug / 想法 / 优化点，记录会自动带上「当时的页面路径」，
 * 点一下「复制全部」就能把整份清单粘给 AI 去改代码——不用开第二个窗口、不用分屏。
 *
 * 设计要点：
 *  1) Shadow DOM 隔离：便签的样式与宿主页面互不影响（不污染页面，也不被页面污染）。
 *  2) 按站点（origin）分组存：localhost:8080 的笔记不会和别的站点混在一起。
 *  3) 默认自持久化（chrome.storage.local）；脱离扩展环境（直接当脚本跑）时回退 localStorage，
 *     这样在本地测试页里也能直接验证。
 *  4) 键盘事件在便签内 stopPropagation：在被测应用有全局快捷键时，打字不会误触页面功能。
 *  5) 收起态的小胶囊同样能拖；点到面板外任意位置、或按 Esc 就自动收起（钉住时例外）。
 *  6) 拖动过程只改 transform（rAF 节流，不触发重排），松手才落 left/top 并贴近边缘吸附。
 *  7) 草稿跨渲染保留、焦点自动复位；忽略自己写入触发的 storage 回显，
 *     避免打字时被自己的存档回调重建 DOM 打断输入。
 */
(function () {
  'use strict'

  const HOST_ID = 'sticky-note-host'
  if (document.getElementById(HOST_ID)) return // 幂等：只注入一次

  const PANEL_W = 320
  const PANEL_H = 400
  const MARGIN = 12
  const TAB_H = 30
  const TAB_W = 92 // 收起态胶囊宽度：渲染后按实测值覆盖
  const SNAP = 14 // 松手时距边缘多少像素内算「贴边」
  const CLICK_SLOP = 4 // 位移小于这个数算点击，不算拖动

  // ---------- 存储层（扩展环境用 chrome.storage.local，否则回退 localStorage） ----------
  const STORE_KEY = 'sticky_notes_v1'
  /** 本标签页的身份标记：写库时捎上，用来忽略「自己写、自己收」的回显。 */
  const TAB_ID = Math.random().toString(36).slice(2, 10)
  /**
   * 扩展上下文是否还活着。
   *
   * 这里不能像原来那样在加载时算一个 hasExt 快照：MV3 下扩展一旦被重载 / 自动更新 / 停用，
   * 已经注入到页面里的内容脚本**不会**跟着消失，但此时再调 chrome.* 会同步抛
   * "Extension context invalidated"。调用点在 Promise 执行器里、外层又是 await，
   * 抛出来就成了一条 unhandled rejection，直接落到宿主页面的控制台里——
   * 我们是在别人的产品页面上跑，最不该干的就是这个。
   * 所以每次调用前先探一下，并把调用本身也包住，兜掉「探测与调用之间正好失效」的竞态。
   */
  function extAlive() {
    try {
      return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id)
    } catch {
      return false
    }
  }
  const readLocal = () => {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || '{}')
    } catch {
      return {}
    }
  }
  const writeLocal = (all) => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(all))
    } catch {
      /* 隐私模式等场景忽略 */
    }
  }

  const store = {
    // 没有扩展环境（本地直接跑 content.js 调试）和扩展已失效，都走同一个 localStorage 兜底；
    // 区别只在于后者要额外 degrade() 告诉用户「别再指望持久化了」。
    read() {
      if (!extAlive()) return Promise.resolve(readLocal())
      return new Promise((resolve) => {
        try {
          chrome.storage.local.get(STORE_KEY, (r) => resolve(r[STORE_KEY] || {}))
        } catch {
          degrade()
          resolve(readLocal()) // 刚好卡在失效那一刻
        }
      })
    },
    write(all) {
      if (!extAlive()) {
        writeLocal(all)
        return Promise.resolve()
      }
      return new Promise((resolve) => {
        try {
          chrome.storage.local.set({ [STORE_KEY]: all }, resolve)
        } catch {
          degrade()
          writeLocal(all)
          resolve()
        }
      })
    },
  }

  const originKey = location.origin
  /** 本页站点的一份状态：位置 / 收起 / 锁定 / 记录列表。 */
  let state = { x: null, y: null, collapsed: false, locked: false, items: [] }
  let allSites = {}
  let saveTimer = 0
  let tabW = TAB_W // 收起态胶囊实测宽度
  let draft = '' // 未提交的输入草稿：render() 会重建 DOM，靠它把内容留住
  let degraded = false // 扩展上下文中途失效：退回 localStorage 兜着，并如实告诉用户别指望持久化

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

  /**
   * 当前拖动动作的收尾函数，拖完置空。
   *
   * 为什么需要它：拖动期间靠 setPointerCapture 把事件锁在 handle 上，但如果捕获没生效、
   * 或者松手落在浏览器窗口外，pointerup 就回不到 handle，拖到一半会「卡住」——
   * transform 停在半路、.dragging 也摘不掉。这里在 window 上补一层兜底。
   * 注意只在模块作用域挂这一次：挂进 render() 里的话，每渲染一次就多两个永不回收的监听器。
   */
  let activeDragEnd = null
  window.addEventListener('pointerup', () => activeDragEnd?.())
  window.addEventListener('pointercancel', () => activeDragEnd?.())

  function saveSoon() {
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      allSites[originKey] = state
      allSites._src = TAB_ID // 标记写入者，其他标签页照常同步，自己忽略
      void store.write(allSites).catch(() => {}) // write 现在不会 reject，这层只是兜底，绝不留 unhandled rejection
    }, 250)
  }

  // ---------- Shadow DOM 骨架 ----------
  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0;'
  document.documentElement.appendChild(host)
  const shadow = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap {
      position: fixed; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: 13px; line-height: 1.5; color: var(--fg);
      --fg: #17181a; --fg-inv: #ffffff; --sub: #757982;
      --bd: rgba(9, 9, 11, 0.10); --hover: rgba(9, 9, 11, 0.06);
      --panel: rgba(255, 255, 255, 0.72);
    }
    @media (prefers-color-scheme: dark) {
      .wrap {
        --fg: #e9eaec; --fg-inv: #17181a; --sub: #9298a2;
        --bd: rgba(255, 255, 255, 0.12); --hover: rgba(255, 255, 255, 0.08);
        --panel: rgba(24, 25, 28, 0.66);
      }
    }
    /* 磨砂玻璃面板：半透明底 + 背景模糊，浮在任何页面上都不突兀 */
    .panel, .tab, .toast {
      background: var(--panel);
      -webkit-backdrop-filter: blur(24px) saturate(1.6);
      backdrop-filter: blur(24px) saturate(1.6);
    }
    /* 位置变化（吸附 / 窗口缩放收敛）走一个小缓动；拖动时靠 .dragging 关掉，免得打架 */
    .panel, .tab {
      transition: left .18s cubic-bezier(.2, .8, .2, 1), top .18s cubic-bezier(.2, .8, .2, 1),
                  transform .18s cubic-bezier(.2, .8, .2, 1), opacity .14s;
    }
    .panel.dragging, .tab.dragging { transition: none; will-change: transform; }
    .panel {
      position: fixed; display: flex; flex-direction: column; width: ${PANEL_W}px; height: ${PANEL_H}px;
      border: 1px solid var(--bd); border-radius: 14px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, .16), 0 1px 3px rgba(0, 0, 0, .08);
      overflow: hidden;
    }
    .head {
      display: flex; align-items: center; gap: 4px; padding: 7px 8px 7px 12px;
      border-bottom: 1px solid var(--bd); cursor: grab; user-select: none; flex-shrink: 0;
      touch-action: none;
    }
    .head.locked { cursor: default; }
    .head:active { cursor: grabbing; }
    .title { font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px; color: var(--fg); }
    .title svg { color: var(--sub); }
    .count { color: var(--sub); font-size: 11px; font-variant-numeric: tabular-nums; }
    .icon-btn {
      border: 0; background: transparent; color: var(--sub); cursor: pointer;
      padding: 5px; border-radius: 7px; line-height: 0; display: inline-flex;
    }
    .icon-btn:hover { background: var(--hover); color: var(--fg); }
    .icon-btn:focus-visible, .tab:focus-visible, .btn:focus-visible { outline: 1.5px solid var(--sub); outline-offset: 1px; }
    .icon-btn.on { color: var(--fg); background: var(--hover); }
    .body { flex: 1; display: flex; flex-direction: column; min-height: 0; }
    .editor { padding: 8px 10px; flex-shrink: 0; }
    textarea {
      width: 100%; height: 62px; resize: none; border: 1px solid var(--bd); border-radius: 9px;
      background: transparent; color: inherit; padding: 6px 9px; font: inherit; outline: none;
    }
    textarea:focus { border-color: var(--sub); }
    textarea::placeholder { color: var(--sub); opacity: .8; }
    .hint { color: var(--sub); font-size: 11px; margin-top: 4px; }
    .hint.warn { color: var(--fg); }
    .list { flex: 1; overflow-y: auto; padding: 0 6px 6px; min-height: 0; }
    .item { display: flex; gap: 6px; padding: 6px; border-radius: 8px; align-items: flex-start; }
    .item:hover { background: var(--hover); }
    .item input[type=checkbox] { margin: 3px 0 0; accent-color: var(--fg); flex-shrink: 0; }
    .text { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; }
    .item.done .text { text-decoration: line-through; color: var(--sub); }
    .meta { color: var(--sub); font-size: 10.5px; margin-top: 2px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .ops { display: flex; gap: 1px; opacity: 0; transition: opacity .12s; flex-shrink: 0; }
    .item:hover .ops, .item:focus-within .ops { opacity: 1; }
    .empty { color: var(--sub); text-align: center; padding: 24px 12px; font-size: 12px; }
    .foot { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-top: 1px solid var(--bd); flex-shrink: 0; }
    .btn {
      border: 1px solid var(--bd); background: transparent; color: inherit; font: inherit; cursor: pointer;
      padding: 5px 11px; border-radius: 8px;
    }
    .btn:hover { border-color: var(--sub); }
    .btn.primary { background: var(--fg); border-color: transparent; color: var(--fg-inv); font-weight: 500; }
    .btn.primary:hover { opacity: .85; }
    .btn:disabled { opacity: .4; cursor: default; }
    .tab {
      position: fixed; display: flex; align-items: center; gap: 6px; height: ${TAB_H}px; padding: 0 12px;
      border: 1px solid var(--bd); border-radius: 15px; color: var(--fg);
      box-shadow: 0 4px 16px rgba(0, 0, 0, .14); cursor: grab; user-select: none;
      font-weight: 500; touch-action: none;
    }
    .tab:hover { border-color: var(--sub); }
    .tab:active { cursor: grabbing; }
    .tab.locked { cursor: pointer; }
    .tab .count {
      font-weight: 600; color: var(--fg); min-width: 16px; text-align: center;
      background: var(--hover); border-radius: 8px; padding: 0 5px; font-variant-numeric: tabular-nums;
    }
    .tab svg { color: var(--sub); }
    .toast {
      position: fixed; padding: 6px 12px; border-radius: 8px; background: rgba(20, 20, 22, .8);
      color: #fff; font-size: 12px; pointer-events: none; opacity: 0; transition: opacity .18s;
      transform: translateX(-50%); white-space: nowrap;
    }
    .toast.show { opacity: 1; }
    @media (prefers-reduced-motion: reduce) {
      .panel, .tab, .toast, .ops { transition: none; }
    }
  `
  shadow.appendChild(style)

  const wrap = document.createElement('div')
  wrap.className = 'wrap'
  shadow.appendChild(wrap)

  // ---------- 图标（lucide 风格的 SVG 线条图标：黑白灰，不用 emoji） ----------
  const ICON_PATHS = {
    sticky:
      '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11l5-5V5a2 2 0 0 0-2-2Z"/><path d="M15 21v-5h5"/>',
    pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    trash:
      '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    pencil:
      '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  }
  /** 内联 SVG 图标（stroke=currentColor，跟随文字颜色）。 */
  function icon(name, size = 14) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`
  }

  // ---------- 位置 ----------

  /**
   * 当前形态占的可视盒。锚点（state.x/state.y）永远是**面板左上角**；
   * 收起态的胶囊挂在锚点的右上角，所以相对锚点有个 offX 偏移。
   * 用「盒」算边界、再换算回锚点，两种形态的界限才不会打架。
   */
  function box() {
    return state.collapsed
      ? { w: tabW, h: TAB_H, offX: PANEL_W - tabW, offY: 0 }
      : { w: PANEL_W, h: PANEL_H, offX: 0, offY: 0 }
  }

  /** 把锚点收进可视区；snap=true 时再进一步吸到边缘（松手/缩放收敛用）。 */
  function resolve(x, y, b = box(), snap = false) {
    const maxBoxX = Math.max(MARGIN, window.innerWidth - b.w - MARGIN)
    const maxBoxY = Math.max(MARGIN, window.innerHeight - b.h - MARGIN)
    let bx = Math.min(Math.max(MARGIN, x + b.offX), maxBoxX)
    let by = Math.min(Math.max(MARGIN, y + b.offY), maxBoxY)
    if (snap) {
      if (bx - MARGIN <= SNAP) bx = MARGIN
      else if (maxBoxX - bx <= SNAP) bx = maxBoxX
      if (by - MARGIN <= SNAP) by = MARGIN
      else if (maxBoxY - by <= SNAP) by = maxBoxY
    }
    return { x: bx - b.offX, y: by - b.offY }
  }

  /** 首次出现时给个右下角的默认位（面板 / 胶囊共用同一个锚点，切换时不跳）。 */
  function normalize() {
    if (state.x === null || state.y === null) {
      const d = resolve(window.innerWidth - PANEL_W - 20, window.innerHeight - PANEL_H - 20)
      state.x = d.x
      state.y = d.y
      return
    }
    const c = resolve(state.x, state.y)
    state.x = c.x
    state.y = c.y
  }

  function pos() {
    normalize()
    return { x: state.x, y: state.y }
  }

  const pendingCount = () => state.items.filter((i) => !i.done).length

  /**
   * 飘一条轻提示。
   *
   * 挂在 shadow root 上而不是 wrap 里：wrap 会被 render() 整个重建，
   * 挂进去的话「刚弹出来就被下一次重渲染抹掉」（切标签页同步、缩放、随手点一下都会触发），
   * 提示还没来得及看清就没了。放外面就只受 1.4s 自己的寿命管。
   */
  function toast(msg) {
    for (const old of shadow.querySelectorAll('.toast')) old.remove() // 只留最新一条，不叠罗汉
    const el = document.createElement('div')
    el.className = 'toast'
    const p = pos()
    // 水平对齐当前形态的中心：展开时居中于面板，收起时居中于胶囊
    el.style.left = `${state.collapsed ? p.x + PANEL_W - tabW / 2 : p.x + PANEL_W / 2}px`
    // 收起态挂在胶囊下方；展开态贴在面板顶部内侧——落到底部时也不会飘出屏幕
    el.style.top = `${p.y + (state.collapsed ? TAB_H + 8 : 8)}px`
    el.textContent = msg
    shadow.appendChild(el)
    requestAnimationFrame(() => el.classList.add('show'))
    window.setTimeout(() => el.remove(), 1400)
  }

  /**
   * 扩展上下文中途失效（重载 / 自动更新 / 停用）。
   *
   * 注入进页面的脚本还在跑，但已经写不进 chrome.storage 了。这时候最忌讳装作没事：
   * 用户以为记的东西存住了，其实没有。所以一边退回 localStorage 保住当前会话
   * （「复制全部」这条主链路还能用），一边把话说清楚，并给出唯一的解法——刷新页面。
   */
  function degrade() {
    if (degraded) return
    degraded = true
    toast('扩展已更新：本页便签不再保存，先「复制全部」留底')
    render() // 面板里的提示行同步切到告警文案
  }

  // ---------- 渲染 ----------
  function render() {
    // 重建 DOM 会丢焦点/草稿：先把「刚才是不是在打字」记下来，重建完再还回去
    const wasTyping = !state.collapsed && shadow.activeElement?.tagName === 'TEXTAREA'
    normalize()
    const p = { x: state.x, y: state.y }
    wrap.textContent = ''

    if (state.collapsed) renderTab(p)
    else renderPanel(p)

    if (wasTyping) {
      const ta = wrap.querySelector('textarea')
      if (ta) {
        ta.focus()
        ta.setSelectionRange(ta.value.length, ta.value.length) // 光标落到末尾，接着打
      }
    }
  }

  /** 收起态：一枚能拖、能点开的小胶囊。 */
  function renderTab(p) {
    const n = pendingCount()
    const tab = document.createElement('div')
    tab.className = 'tab' + (state.locked ? ' locked' : '')
    tab.setAttribute('role', 'button')
    tab.tabIndex = 0
    // 钉住时拖不动，提示语得跟着变，不然说的和做的不一致
    tab.title = `${n ? `待办 ${n} 条 · ` : ''}${state.locked ? '已钉住（拖不动）' : '拖动可移动'} · 点一下展开`
    tab.setAttribute('aria-label', `展开便签${n ? `，${n} 条待办` : ''}${state.locked ? '，已钉住' : ''}`)

    const tIcon = document.createElement('span')
    tIcon.style.display = 'inline-flex'
    tIcon.innerHTML = icon('sticky', 13)
    const tLabel = document.createElement('span')
    tLabel.textContent = '便签'
    tab.append(tIcon, tLabel)
    if (n) {
      const tCount = document.createElement('span')
      tCount.className = 'count'
      tCount.textContent = String(n)
      tab.append(tCount)
    }

    tab.style.top = `${p.y}px`
    wrap.appendChild(tab)
    // 宽度得等挂上去才量得准；量完再按实测宽度把锚点收敛一次，右缘才对得齐
    tabW = tab.offsetWidth || TAB_W
    const c = resolve(state.x, state.y)
    state.x = c.x
    state.y = c.y
    const place = (q) => {
      tab.style.left = `${q.x + PANEL_W - tabW}px`
      tab.style.top = `${q.y}px`
    }
    place(c)

    attachDrag(tab, tab, {
      movable: () => !state.locked,
      place,
      onClick: () => setCollapsed(false),
    })
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        setCollapsed(false)
      }
    })
  }

  /** 展开态：完整面板。 */
  function renderPanel(p) {
    const panel = document.createElement('div')
    panel.className = 'panel'
    panel.style.left = `${p.x}px`
    panel.style.top = `${p.y}px`

    // 头部：拖动 / 钉住 / 收起
    const head = document.createElement('div')
    head.className = 'head' + (state.locked ? ' locked' : '')
    const hTitle = document.createElement('span')
    hTitle.className = 'title'
    hTitle.innerHTML = `${icon('sticky', 13)}<span>记录</span>`
    const hCount = document.createElement('span')
    hCount.className = 'count'
    hCount.textContent = String(pendingCount())
    head.append(hTitle, hCount)
    const mkIconBtn = (iconName, title, cls = '') => {
      const b = document.createElement('button')
      b.className = `icon-btn ${cls}`
      b.title = title
      b.setAttribute('aria-label', title)
      b.innerHTML = icon(iconName)
      head.appendChild(b)
      return b
    }
    const lockBtn = mkIconBtn('pin', state.locked ? '已钉住（点一下解除）' : '钉住：不自动收起，也不怕误拖', state.locked ? 'on' : '')
    lockBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      state.locked = !state.locked
      saveSoon()
      render()
      toast(state.locked ? '已钉住，点别处不收起' : '已解除钉住')
    })
    const collapseBtn = mkIconBtn('chevronDown', '收起（Esc）')
    collapseBtn.addEventListener('click', () => setCollapsed(true))
    const clearBtn = mkIconBtn('trash', '清空本站记录')
    clearBtn.addEventListener('click', () => {
      if (!state.items.length) return
      if (!window.confirm(`清空本站（${originKey}）的 ${state.items.length} 条记录？`)) return
      state.items = []
      saveSoon()
      render()
    })
    panel.appendChild(head)

    // 主体：输入 + 列表
    const body = document.createElement('div')
    body.className = 'body'

    const editor = document.createElement('div')
    editor.className = 'editor'
    const ta = document.createElement('textarea')
    ta.placeholder = '记一条：bug / 想法 / 优化点…'
    ta.value = draft // 草稿续上：勾选/删除等任何重渲染都不会吃掉还没提交的输入
    ta.addEventListener('input', () => {
      draft = ta.value
    })
    const hint = document.createElement('div')
    hint.className = 'hint' + (degraded ? ' warn' : '')
    hint.textContent = degraded
      ? '扩展已更新，本页便签不再保存 — 先「复制全部」留底，或刷新页面'
      : 'Enter 添加 · Shift+Enter 换行 · 记录会带上当前页面路径'
    editor.append(ta, hint)
    body.appendChild(editor)

    const list = document.createElement('div')
    list.className = 'list'
    if (!state.items.length) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = '还没有记录。\n在页面里翻到哪记到哪，最后「复制全部」发给 AI。'
      empty.style.whiteSpace = 'pre-line'
      list.appendChild(empty)
    } else {
      state.items.forEach((it) => list.appendChild(renderItem(it, ta)))
    }
    body.appendChild(list)
    panel.appendChild(body)

    // 底部：复制全部
    const foot = document.createElement('div')
    foot.className = 'foot'
    const copyAll = document.createElement('button')
    copyAll.className = 'btn primary'
    copyAll.textContent = `复制全部（${pendingCount()}）`
    copyAll.disabled = pendingCount() === 0
    copyAll.addEventListener('click', async () => {
      const ok = await copyText(buildText())
      copyAll.textContent = ok ? '已复制' : '复制失败'
      toast(ok ? '已复制，去粘给 AI 吧' : '复制失败，请手动选择')
      window.setTimeout(() => {
        copyAll.textContent = `复制全部（${pendingCount()}）`
      }, 1200)
    })
    const doneBtn = document.createElement('button')
    doneBtn.className = 'btn'
    doneBtn.textContent = '清理已完成'
    doneBtn.disabled = state.items.every((i) => !i.done)
    doneBtn.addEventListener('click', () => {
      state.items = state.items.filter((i) => !i.done)
      saveSoon()
      render()
    })
    foot.append(copyAll, doneBtn)
    panel.appendChild(foot)

    wrap.appendChild(panel)

    // 输入：Enter 添加；阻止冒泡，避免误触被测应用的全局快捷键。
    //
    // 两层拦截（缺一不可）：
    //  · keydown 拦普通键盘路径；
    //  · beforeinput 兑底拦 IME 路径——中文输入法下按 Enter，keydown 常带
    //    isComposing=true，此时 preventDefault 对浏览器无效，换行仍会插入；
    //    beforeinput 是标准输入管线，preventDefault 拦得住。
    // 输入法组合中的 Enter（选词/上屏）不处理，交给输入法；选完再按一次 Enter 即提交。
    let lastAddAt = 0
    let shiftHeld = false // beforeinput 没有 shiftKey，从最近一次 keydown 读取
    const tryAdd = () => {
      if (Date.now() - lastAddAt < 80) return // keydown 与 beforeinput 双路径去重
      lastAddAt = Date.now()
      addItem(ta.value)
    }
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation()
      shiftHeld = e.shiftKey
      if (e.key !== 'Enter') return
      if (e.isComposing || e.keyCode === 229) return // 输入法组合中：交给输入法选词
      if (e.shiftKey) return // Shift+Enter = 换行
      e.preventDefault()
      tryAdd()
    })
    ta.addEventListener('beforeinput', (e) => {
      if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') return
      if (shiftHeld) return // Shift+Enter 的换行放行
      // 走到这里说明 keydown 的拦截被 IME 绕过（isComposing 刚结束的 Enter 等）
      e.preventDefault()
      tryAdd()
    })
    ta.addEventListener('keyup', (e) => e.stopPropagation())

    attachDrag(head, panel, {
      movable: () => !state.locked,
      place: (q) => {
        panel.style.left = `${q.x}px`
        panel.style.top = `${q.y}px`
      },
    })
  }

  function renderItem(it, ta) {
    const row = document.createElement('div')
    row.className = 'item' + (it.done ? ' done' : '')

    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = !!it.done
    cb.addEventListener('change', () => {
      it.done = cb.checked
      saveSoon()
      render()
    })

    const main = document.createElement('div')
    main.className = 'text'
    main.textContent = it.text
    const meta = document.createElement('div')
    meta.className = 'meta'
    meta.textContent = `${it.path || '/'} · ${new Date(it.createdAt).toLocaleTimeString()}`
    main.appendChild(meta)

    const ops = document.createElement('div')
    ops.className = 'ops'
    const copy = document.createElement('button')
    copy.className = 'icon-btn'
    copy.title = '复制这条'
    copy.innerHTML = icon('copy', 12)
    copy.addEventListener('click', async () => {
      const ok = await copyText(`${it.text}\n（${location.origin}${it.path || '/'}）`)
      toast(ok ? '已复制本条' : '复制失败')
    })
    const edit = document.createElement('button')
    edit.className = 'icon-btn'
    edit.title = '编辑（回到输入框接着改）'
    edit.innerHTML = icon('pencil', 12)
    edit.addEventListener('click', () => {
      draft = it.text
      state.items = state.items.filter((x) => x.id !== it.id)
      saveSoon()
      render()
      wrap.querySelector('textarea')?.focus()
    })
    const del = document.createElement('button')
    del.className = 'icon-btn'
    del.title = '删除'
    del.innerHTML = icon('x', 12)
    del.addEventListener('click', () => {
      state.items = state.items.filter((x) => x.id !== it.id)
      saveSoon()
      render()
    })
    ops.append(copy, edit, del)

    row.append(cb, main, ops)
    return row
  }

  // ---------- 行为 ----------
  function addItem(raw) {
    const text = (raw || '').trim()
    if (!text) return
    draft = '' // 内容已经转成记录，草稿清掉，免得 re-render 又把它填回去
    state.items.unshift({
      id: uid(),
      text,
      path: location.pathname + location.search,
      url: location.href,
      createdAt: Date.now(),
      done: false,
    })
    saveSoon()
    render()
    wrap.querySelector('textarea')?.focus()
  }

  /** 设备去重 + 兜底：整份清单（给 AI 的格式）。 */
  function buildText() {
    const pending = state.items.filter((i) => !i.done)
    const head = [
      `# ${document.title || '页面'} · 待处理清单`,
      `站点：${originKey} · 共 ${pending.length} 条 · ${new Date().toLocaleString()}`,
      '',
    ]
    const lines = pending.map((it, i) => {
      const where = it.path && it.path !== '/' ? `（${it.path}）` : ''
      return `${i + 1}. ${it.text}${where}`
    })
    return head.concat(lines).join('\n')
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      try {
        const tmp = document.createElement('textarea')
        tmp.value = text
        tmp.style.cssText = 'position:fixed;top:-1000px;'
        document.body.appendChild(tmp)
        tmp.select()
        const ok = document.execCommand('copy')
        tmp.remove()
        return ok
      } catch {
        return false
      }
    }
  }

  /**
   * 通用拖动：把指针位移映射到锚点 (state.x, state.y)。
   *
   * - 拖动期间只改 transform（走合成层，不触发重排），松手才落 left/top 并持久化；
   * - rAF 节流：pointermove 再密也只按帧移位，长页面里拖起来不掉帧；
   * - 位移小于 CLICK_SLOP 视作「点击」交给 onClick —— 收起态胶囊靠这个保留「点一下展开」；
   * - 松手贴边（<SNAP）时吸附到边距，收拾得干净点。
   *
   * @param handle 按住哪个元素开始拖
   * @param target 实际被移动的元素（面板 / 胶囊）
   * @param opts.movable 当前是否允许拖（钉住时 false，但点击仍然有效）
   * @param opts.place   按锚点摆放 target 的函数
   * @param opts.onClick 判定为点击时的回调
   */
  function attachDrag(handle, target, { movable = () => true, place, onClick } = {}) {
    let start = null
    let dx = 0
    let dy = 0
    let raf = 0
    let moved = false

    const paint = () => {
      raf = 0
      target.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
    }

    const onDown = (e) => {
      if (e.button !== 0) return
      if (e.target.closest?.('.icon-btn')) return // 头部的小按钮不参与拖动
      start = { mx: e.clientX, my: e.clientY, x: state.x, y: state.y, can: movable() }
      dx = dy = 0
      moved = false
      activeDragEnd = onUp // 交给 window 兜底（handle 先收到就是空转，见 onUp 开头的判空）
      target.classList.add('dragging')
      void target.offsetWidth // 强制刷一次样式：让「拖动期无过渡」在松手前就生效。
      // 否则快速甩动（按下与松手落在同一帧）时 .dragging 从未被渲染过，
      // 松手那一刻 left/top 的变化会被过渡接管，元素会从原位滑过去而不是原地落下。
      try {
        handle.setPointerCapture?.(e.pointerId) // 指针已失效等边缘情况：捕获失败也不影响拖
      } catch {
        /* ignore */
      }
      e.preventDefault()
    }

    const onMove = (e) => {
      if (!start || !start.can) return
      dx = e.clientX - start.mx
      dy = e.clientY - start.my
      if (!moved && Math.abs(dx) + Math.abs(dy) > CLICK_SLOP) moved = true
      if (!moved) return
      // 边拖边收敛：拖不出可视区，手感是「撞到边界停住」而不是拖飞了再弹回来
      const t = resolve(start.x + dx, start.y + dy, box(), false)
      dx = t.x - start.x
      dy = t.y - start.y
      if (!raf) raf = requestAnimationFrame(paint)
    }

    const onUp = () => {
      if (!start) return // handle 与 window 兜底都会走到这里，靠这个判空去重
      activeDragEnd = null
      const raw = resolve(start.x + dx, start.y + dy, box(), false)
      const end = resolve(raw.x, raw.y, box(), true) // 松手吸附
      start = null
      if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
      if (!moved) {
        target.classList.remove('dragging')
        target.style.transform = ''
        if (onClick) onClick()
        return
      }
      // 先把 transform 的位移等价落到 left/top（视觉不动，且此刻还没有过渡），
      // 下一帧再放开过渡去吸附——这样吸附才有那一下顺滑的收势。
      target.style.transform = ''
      place(raw)
      state.x = raw.x
      state.y = raw.y
      saveSoon()
      requestAnimationFrame(() => {
        target.classList.remove('dragging')
        if (end.x === raw.x && end.y === raw.y) return
        place(end)
        state.x = end.x
        state.y = end.y
        saveSoon()
      })
    }

    handle.addEventListener('pointerdown', onDown)
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }

  function setCollapsed(v) {
    if (state.collapsed === v) return
    state.collapsed = v
    saveSoon()
    render()
  }

  function toggle() {
    setCollapsed(!state.collapsed)
  }

  function openAndFocus() {
    state.collapsed = false
    saveSoon()
    render()
    window.setTimeout(() => wrap.querySelector('textarea')?.focus(), 30)
  }

  // ---------- 初始化 ----------
  void (async () => {
    allSites = (await store.read()) || {}
    const saved = allSites[originKey]
    if (saved) {
      state = {
        x: typeof saved.x === 'number' ? saved.x : null,
        y: typeof saved.y === 'number' ? saved.y : null,
        collapsed: !!saved.collapsed,
        locked: !!saved.locked,
        items: Array.isArray(saved.items) ? saved.items : [],
      }
    }
    render() // normalize() 在 render 里收边，位置越界也会被拽回可视区

    // 点到面板外面 → 自动收起成胶囊（钉住时不动）。
    // 用捕获阶段挂在 window 上：一是比页面自己的监听先跑，二是点的若是页面里的
    // 交互元素，收起不会影响它；三是先于 mousedown 默认的「转移焦点」生效。
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (state.collapsed || state.locked) return
        if (e.composedPath().includes(host)) return // 点在便签自己身上
        setCollapsed(true)
      },
      true
    )

    // Esc 收起（在输入框里按也算，顺手把事件吃掉，别让页面的 Esc 也跟着响应）
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || state.collapsed) return
        setCollapsed(true)
        if (e.composedPath().includes(host)) e.stopPropagation()
      },
      true
    )

    // 窗口尺寸变化：rAF 合并，拖动窗口边缘时不会一帧渲染好几次
    let resizeRaf = 0
    window.addEventListener('resize', () => {
      if (resizeRaf) return
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0
        render()
      })
    })

    // 跨标签页同步（同一站点多个标签时保持一致）；自己写的那次忽略，
    // 否则打字间隙的自动存档会把输入框重建掉，光标位置全丢。
    if (extAlive() && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[STORE_KEY]) return
        const next = changes[STORE_KEY].newValue || {}
        if (next._src === TAB_ID) return
        allSites = next
        const s = allSites[originKey]
        if (!s) return
        state = {
          x: typeof s.x === 'number' ? s.x : null,
          y: typeof s.y === 'number' ? s.y : null,
          collapsed: !!s.collapsed,
          locked: !!s.locked,
          items: Array.isArray(s.items) ? s.items : [],
        }
        render()
      })
    }

    // 来自工具栏/快捷键的消息
    if (extAlive() && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type === 'toggle') toggle()
        if (msg?.type === 'quick-add') openAndFocus()
      })
    }

    // 面板内的键盘事件不外泄到页面（被测应用常有全局快捷键）。
    //
    // 必须在**冒泡阶段**拦：真实键盘事件（composed）的捕获路径会先经过 host，
    // 若在 host 捕获阶段 stopPropagation，事件到不了 textarea，自己的
    // Enter 处理器也一起被废掉（线上 bug：Enter 只能换行不能提交）。
    // 冒泡阶段在 wrap 拦：textarea 的处理器先执行完，事件出不了面板。
    for (const type of ['keydown', 'keypress', 'keyup']) {
      wrap.addEventListener(type, (e) => e.stopPropagation())
    }
  })().catch((err) => {
    // 兜住初始化里的任何意外：内容脚本跑在别人的页面里，自己的异常不该漏进宿主的控制台
    console.warn('[悬浮便签] 初始化失败：', err)
  })

  // 本地直跑（非扩展环境）时的调试入口
  window.__stickyNote = { toggle, openAndFocus, buildText, get state() { return state } }
})()
