/**
 * dsh-custom-profile — 浏览器半边。
 *
 * 让左下角那块「头像 + 昵称」换成用户自定义的内容，并支持头像构图调整
 * （缩放 / 左右上下拖动）。
 *
 * 定位不依赖文字内容：在左下角区域里找「一段文字 + 紧挨在它左边 140px 内的
 * 16–96px 方形图标」的组合，昵称或遮罩手机号都能认；手机号特征作为兜底。
 * 类名是 CSS Modules 哈希，不能写死，所以只认几何与容器语义（footArea）。
 *
 * 头像用绝对定位的 <img> 盖在圆块里：object-fit: contain 保留整张原图不裁切，
 * transform 的 translate/scale 负责拖动与缩放。
 * 「尺寸」改左下角容器的宽高，「缩放」只缩放图片本身，两者互不叠加。
 */
window.__ModuleLoader__.load({
  id: 'dsh-custom-profile',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    const STORAGE_KEY = 'dsh-custom-profile'
    const AVATAR_MAX_BYTES = 1.5 * 1024 * 1024
    const MASK_RE = /^\d{3}\*{6,}\d{2}$/

    const DEFAULT_CFG = { name: '', avatar: '', zoom: 1, offsetX: 0, offsetY: 0, boxScale: 1 }

    /* ---------------- 配置 ---------------- */

    function num(v, def) {
      const n = Number(v)
      return Number.isFinite(n) ? n : def
    }

    function loadConfig() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (!raw) return Object.assign({}, DEFAULT_CFG)
        const obj = JSON.parse(raw)
        return {
          name: String(obj.name || ''),
          avatar: String(obj.avatar || ''),
          zoom: Math.min(4, Math.max(1, num(obj.zoom, 1))),
          offsetX: Math.min(80, Math.max(-80, num(obj.offsetX, 0))),
          offsetY: Math.min(80, Math.max(-80, num(obj.offsetY, 0))),
          boxScale: Math.min(2, Math.max(0.7, num(obj.boxScale, 1))),
        }
      } catch { return Object.assign({}, DEFAULT_CFG) }
    }

    function saveConfig(cfg) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
          name: cfg.name || '',
          avatar: cfg.avatar || '',
          zoom: num(cfg.zoom, 1),
          offsetX: num(cfg.offsetX, 0),
          offsetY: num(cfg.offsetY, 0),
          boxScale: num(cfg.boxScale, 1),
        }))
        return true
      } catch { return false }
    }

    /* ---------------- DOM 状态 ---------------- */

    const tracked = new Set()
    const pairBox = new Map()
    /** 只换头像、不改文字的圆块（账号设置页里那个大头像）。 */
    const extraAvatarBoxes = []
    /** 账号卡里要被隐藏的小头像（只留一个大头像）。 */
    const accountHideBoxes = []
    /** 被我们套上定位样式的圆块 → 原始 position/overflow，用于恢复。 */
    const styledBoxes = new Map()
    /** 被藏起来的原图标。 */
    const hiddenIcons = new Set()

    function maskNodesNow() {
      const out = []
      const doc = document
      if (!doc || !doc.body) return out
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
      let n
      while ((n = walker.nextNode())) {
        if (MASK_RE.test(String(n.nodeValue || '').trim())) out.push(n)
      }
      return out
    }

    function regionRoot() {
      try {
        const el = document.querySelector('[class*="footArea"]')
        if (el) return el
      } catch { /* ignore */ }
      return document.body
    }

    function nameRect(node) {
      try {
        const r = document.createRange()
        r.selectNodeContents(node)
        return r.getBoundingClientRect()
      } catch { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 } }
    }

    /**
     * 扫「文字 + 左边紧挨着一个 16–96px 方形图标」的组合。
     * 不依赖文字内容：昵称或遮罩手机号都能认。
     * 先走精确路径：宿主给账号按钮标了 aria-label="账号菜单"，里面的
     * `[class*="_avatar"]` / `[class*="_label"]` 是 CSS Modules 的稳定后缀
     * （哈希会变、后缀不变），命中就不必再按几何猜。
     */
    function scanChipPairs() {
      const pairs = []
      try {
        const trigger = document.querySelector('[aria-label="账号菜单"]')
        if (trigger) {
          const avatar = trigger.querySelector('[class*="_avatar"]')
          const label = trigger.querySelector('[class*="_label"]')
          if (avatar && label) {
            let tn = null
            const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT)
            while (walker.nextNode()) {
              const t = String(walker.currentNode.nodeValue || '').trim()
              if (t) { tn = walker.currentNode; break }
            }
            if (tn) pairs.push({ node: tn, box: avatar })
          }
        }
      } catch { /* ignore */ }
      if (pairs.length) return pairs

      const root = regionRoot()
      if (!root || !root.querySelectorAll) return []
      const regionTop = window.innerHeight - 260
      const boxes = []
      for (const el of Array.from(root.querySelectorAll('*'))) {
        let r
        try { r = el.getBoundingClientRect() } catch { continue }
        if (!r || r.width < 16 || r.height < 16) continue
        if (r.width > 96 || r.height > 96) continue
        if (r.left > 420 || r.bottom < regionTop) continue
        const ratio = r.width / r.height
        if (ratio < 0.7 || ratio > 1.4) continue
        if (!el.querySelector('svg, img')) continue
        if (isButtonItself(el)) continue
        boxes.push({ el, r })
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let n
      while ((n = walker.nextNode())) {
        const t = String(n.nodeValue || '').trim()
        if (!t || t.length < 2 || t.length > 40) continue
        const r = nameRect(n)
        if (!r || r.width < 8 || r.left > 420 || r.top < regionTop) continue
        const midY = (r.top + r.bottom) / 2
        const box = boxes.find((b) => Math.abs((b.r.top + b.r.bottom) / 2 - midY) < 18
          && b.r.right <= r.left + 8 && b.r.right >= r.left - 140)
        if (box) pairs.push({ node: n, box: box.el })
      }
      return pairs
    }


    /**
     * 账号设置页里的头像：不再依赖「已登录」文字或卡片尺寸，直接在整个设置弹窗里
     * 找最大的方形头像块当大头像，再以它为中心找出同一个容器里的其它头像块隐藏掉。
     * 这些节点**只换头像、不改文字**，所以不放进 tracked。
     */
    function scanAccountAvatars() {
      const res = { paint: [], hide: [] }
      const scopes = Array.from(document.querySelectorAll('[role="dialog"]'))
      if (!scopes.length) return res
      for (const root of scopes) {
        // 只认账号卡里的 `_avatar` 容器。取消了几何兜底 —— 那种「在弹窗里挑最大的方框」
        // 会误伤快捷键页的字母键（带底色 + 文字的小方块），把头像涂上去。
        const boxes = []
        for (const el of Array.from(root.querySelectorAll('[class*="_card"] [class*="_avatar"]'))) {
          if (isButtonItself(el)) continue
          let r
          try { r = el.getBoundingClientRect() } catch { continue }
          if (!r || r.width < 8 || r.height < 8) continue
          boxes.push({ el, r })
        }
        if (!boxes.length) continue
        boxes.sort((a, b) => b.r.width - a.r.width)
        const big = boxes[0]
        res.paint.push(big.el)

        // 账号卡专用：卡里所有 12–44px、接近正方形、本身是图片（<img> 或背景图）的
        // 元素都当成小头像隐藏。只认图片，不认 svg 图标 —— 「更多账号信息」那个箭头
        // 是 svg，不能被误伤。我们的头像（带 data 属性，或包着它的容器）一律跳过。
        for (const card of Array.from(root.querySelectorAll('[class*="_card"]'))) {
          for (const el of Array.from(card.querySelectorAll('img, div, span'))) {
            if (!el || el.nodeType !== 1) continue
            if (el.hasAttribute && el.hasAttribute('data-dsh-profile-avatar')) continue
            if (el.querySelector && el.querySelector('img[data-dsh-profile-avatar]')) continue
            // 这里只排除「元素本身是按钮」（右上角 ×），不排除包在按钮里的头像 ——
            // 账号卡整体可点，用 isButtonLike 会把里面的小头像一起放过。
            if (isButtonItself(el)) continue
            let r
            try { r = el.getBoundingClientRect() } catch { continue }
            if (!r || r.width < 12 || r.width > 44) continue
            if (Math.abs(r.width - r.height) > 8) continue
            let looks = el.tagName === 'IMG'
            if (!looks) {
              try {
                const bg = getComputedStyle(el).backgroundImage
                looks = !!bg && bg !== 'none'
              } catch { looks = false }
            }
            if (!looks) continue
            res.hide.push(el)
          }
        }

        // 以大头像为基准，往上找「同时包含大小两个头像」的那层容器（有多块时才有效）。
        let host = big.el.parentElement
        for (let i = 0; i < 8 && host; i += 1) {
          let count = 0
          for (const b of boxes) {
            if (host.contains(b.el)) count += 1
          }
          if (count >= 2) break
          host = host.parentElement
        }
        if (!host) continue
        // 这个容器里除大头像以外的头像块全部隐藏；**按钮一律不动** ——
        // 右上角的 × 就是按钮，之前被这条规则误伤了（反复消失又出现）。
        for (const b of boxes) {
          if (b.el === big.el) continue
          if (!host.contains(b.el)) continue
          if (isButtonLike(b.el)) continue
          res.hide.push(b.el)
        }
      }
      // 兜底一：所有弹窗里「我们自己贴的头像」如果不止一个，只留最大的那个，
      // 其余小的连同容器一起隐藏。跨弹窗统计 —— 之前每个弹窗各算各的，
      // 两个头像分属不同层时永远凑不够 2 个，规则就不生效。
      const mine = []
      for (const sc of scopes) {
        for (const img of Array.from(sc.querySelectorAll('img[data-dsh-profile-avatar]'))) {
          let ir
          try { ir = img.getBoundingClientRect() } catch { continue }
          if (!ir || ir.width < 4) continue
          mine.push({ img, w: ir.width })
        }
      }
      if (mine.length > 1) {
        mine.sort((a, b) => b.w - a.w)
        const max = mine[0].w
        for (let i = 1; i < mine.length; i += 1) {
          if (mine[i].w < max * 0.75 || mine[i].w < 40) {
            res.hide.push(mine[i].img.parentElement || mine[i].img)
          }
        }
      }

      // 兜底二：弹窗里任何 12–44px、不在链接里的独立图片，只要不是我们的，就当小头像隐藏。
      for (const img of Array.from(root.querySelectorAll('img'))) {
        if (img.hasAttribute && img.hasAttribute('data-dsh-profile-avatar')) continue
        if (img.closest && img.closest('a')) continue
        if (isButtonLike(img)) continue
        let ir
        try { ir = img.getBoundingClientRect() } catch { continue }
        if (!ir || ir.width < 12 || ir.width > 44) continue
        if (Math.abs(ir.width - ir.height) > 10) continue
        res.hide.push(img)
      }
      return res
    }

    /** 按钮类元素（× / 关闭 / 图标按钮）不参与隐藏，避免误伤。 */
    function isButtonLike(el) {
      try {
        if (!el || el.nodeType !== 1) return false
        if (el.tagName === 'BUTTON' || el.tagName === 'A') return true
        if (el.getAttribute && (el.getAttribute('role') === 'button' || el.getAttribute('aria-label'))) return true
        if (el.closest && el.closest('button, [role="button"]')) return true
      } catch { /* ignore */ }
      return false
    }

    /** 更严格的判断：只排除「元素本身就是按钮」，不牵连它的子元素。 */
    function isButtonItself(el) {
      try {
        if (!el || el.nodeType !== 1) return false
        if (el.tagName === 'BUTTON' || el.tagName === 'A') return true
        if (el.getAttribute && (el.getAttribute('role') === 'button' || el.getAttribute('aria-label'))) return true
      } catch { /* ignore */ }
      return false
    }

    function collectNodes() {
      for (const n of maskNodesNow()) {
        if (n.__dshOrig === undefined) n.__dshOrig = n.nodeValue
        tracked.add(n)
      }
      for (const p of scanChipPairs()) {
        if (p.node.__dshOrig === undefined) p.node.__dshOrig = p.node.nodeValue
        tracked.add(p.node)
        pairBox.set(p.node, p.box)
      }
      extraAvatarBoxes.length = 0
      accountHideBoxes.length = 0
      const acc = scanAccountAvatars()
      for (const box of acc.paint) extraAvatarBoxes.push(box)
      for (const box of acc.hide) accountHideBoxes.push(box)
      for (const n of Array.from(tracked)) {
        if (!n.isConnected) { tracked.delete(n); pairBox.delete(n) }
      }
      return Array.from(tracked)
    }

    /** 被我们隐藏起来的账号卡小头像。 */
    const hiddenAccountBoxes = new Set()

    /** 被我们清掉背景图的元素（退出/清空时还原）。 */
    const clearedBgs = new Set()

    /**
     * 账号卡身份区里的小头像如果是「背景图」画出来的（不是 <img>），JS 的图片规则碰不到，
     * 这里把小尺寸元素上的 background-image 清掉。
     */
    function clearIdentityBackgrounds() {
      for (const idEl of Array.from(document.querySelectorAll('[class*="_identity"]'))) {
        const list = [idEl].concat(Array.from(idEl.querySelectorAll('*')))
        for (const el of list) {
          let b
          try { b = el.getBoundingClientRect() } catch { continue }
          if (!b || b.width < 8 || b.width > 60) continue
          if (b.height < 8 || b.height > 60) continue
          let bg = ''
          try { bg = getComputedStyle(el).backgroundImage || '' } catch { continue }
          if (!bg || bg === 'none' || bg.indexOf('url(') < 0) continue
          if (el.querySelector && el.querySelector('img[data-dsh-profile-avatar]')) continue
          try {
            if (!el.dataset.dshBgSaved) {
              el.dataset.dshBgSaved = bg
              el.style.setProperty('background-image', 'none', 'important')
              clearedBgs.add(el)
            }
          } catch { /* ignore */ }
        }
      }
      for (const el of Array.from(clearedBgs)) {
        if (!el.isConnected) clearedBgs.delete(el)
      }
    }

    function restoreBoxStyles() {
      for (const [el, prev] of styledBoxes) {
        try {
          el.style.removeProperty('position')
          el.style.removeProperty('overflow')
          for (const k of ['width', 'height', 'min-width', 'min-height', 'flex']) {
            el.style.removeProperty(k)
          }
          if (prev.position) el.style.position = prev.position
          if (prev.overflow) el.style.overflow = prev.overflow
        } catch { /* ignore */ }
      }
      styledBoxes.clear()
    }

    function clearAvatarArtifacts() {
      for (const img of Array.from(document.querySelectorAll('img[data-dsh-profile-avatar]'))) {
        try { img.remove() } catch { /* ignore */ }
      }
      for (const icon of hiddenIcons) {
        try { icon.style.removeProperty('display') } catch { /* ignore */ }
      }
      hiddenIcons.clear()
      for (const el of hiddenAccountBoxes) {
        try { el.style.removeProperty('display') } catch { /* ignore */ }
      }
      hiddenAccountBoxes.clear()
      for (const el of clearedBgs) {
        try {
          el.style.removeProperty('background-image')
          delete el.dataset.dshBgSaved
        } catch { /* ignore */ }
      }
      clearedBgs.clear()
      restoreBoxStyles()
    }

    /* ---------------- 应用 ---------------- */

    function applyName(nodes, name) {
      if (!name) {
        for (const n of nodes) {
          try { if (n.__dshOrig !== undefined) n.nodeValue = n.__dshOrig } catch { /* ignore */ }
        }
        return
      }
      for (const n of nodes) {
        if (String(n.nodeValue || '').trim() !== name) n.nodeValue = name
      }
    }

    function transformCss(cfg) {
      // 「缩放」只缩放图片本身；「尺寸」改的是左下角容器的大小，两者互不叠加。
      return 'translate(' + num(cfg.offsetX, 0) + '%, ' + num(cfg.offsetY, 0) + '%) scale(' + num(cfg.zoom, 1) + ')'
    }

    /**
     * 任意常见图片格式统一处理：读进 <img> → 画到 canvas → 缩到 512px 以内 → data URL。
     * 这样 PNG / JPG / WebP / GIF / BMP / AVIF / SVG 都能用，也顺手把体积压下来
     * （localStorage 只有几 MB，原图直接存很容易撑爆）。
     */
    function normalizeImageFile(file, cb) {
      let url = ''
      try { url = URL.createObjectURL(file) } catch { cb(''); return }
      const img = new Image()
      img.onload = () => {
        try {
          const nw = img.naturalWidth || img.width || 1
          const nh = img.naturalHeight || img.height || 1
          const scale = Math.min(1, 512 / Math.max(nw, nh))
          const w = Math.max(1, Math.round(nw * scale))
          const h = Math.max(1, Math.round(nh * scale))
          const canvas = document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          const ctx = canvas.getContext('2d')
          if (!ctx) { URL.revokeObjectURL(url); cb(''); return }
          ctx.drawImage(img, 0, 0, w, h)
          let out = ''
          try { out = canvas.toDataURL('image/webp', 0.92) } catch { out = '' }
          if (!out || out.indexOf('data:image') !== 0) {
            try { out = canvas.toDataURL('image/png') } catch { out = '' }
          }
          URL.revokeObjectURL(url)
          cb(out || '')
        } catch {
          try { URL.revokeObjectURL(url) } catch { /* ignore */ }
          cb('')
        }
      }
      img.onerror = () => {
        try { URL.revokeObjectURL(url) } catch { /* ignore */ }
        cb('')
      }
      img.src = url
    }

    function avatarImgIn(box) {
      return box ? box.querySelector('img[data-dsh-profile-avatar]') : null
    }

    function applyAvatarToBox(box, url, cfg) {
      if (!box) return false
      // 幂等：同一个图 + 同一组构图参数已经应用过，就直接返回，避免每 1.5 秒重写样式
      const sig = url + '|' + num(cfg.zoom, 1) + '|' + num(cfg.offsetX, 0) + '|'
        + num(cfg.offsetY, 0) + '|' + num(cfg.boxScale, 1)
      if (box.__dshProfileSig === sig && avatarImgIn(box)) return true
      box.__dshProfileSig = sig
      if (!styledBoxes.has(box)) {
        let r = { width: 0, height: 0 }
        try { r = box.getBoundingClientRect() } catch { /* ignore */ }
        styledBoxes.set(box, {
          position: box.style.position || '',
          overflow: box.style.overflow || '',
          width: Math.round(r.width || 0),
          height: Math.round(r.height || 0),
        })
        try {
          box.style.setProperty('position', 'relative', 'important')
          box.style.setProperty('overflow', 'hidden', 'important')
        } catch { /* ignore */ }
      }
      // 「尺寸」只作用于左下角那个账号头像（改容器宽高），账号卡里的头像不动。
      // 「缩放」只作用于图片本身（transform）。
      const isSidebarChip = !!(box.closest && box.closest('[aria-label="账号菜单"]'))
      const prev = styledBoxes.get(box)
      const scale = num(cfg.boxScale, 1)
      if (isSidebarChip && prev && prev.width > 0 && scale !== 1) {
        const w = Math.round(prev.width * scale)
        const h = Math.round((prev.height || prev.width) * scale)
        try {
          box.style.setProperty('width', w + 'px', 'important')
          box.style.setProperty('height', h + 'px', 'important')
          box.style.setProperty('min-width', w + 'px', 'important')
          box.style.setProperty('min-height', h + 'px', 'important')
          box.style.setProperty('flex', '0 0 auto', 'important')
        } catch { /* ignore */ }
      } else {
        try {
          for (const k of ['width', 'height', 'min-width', 'min-height', 'flex']) box.style.removeProperty(k)
        } catch { /* ignore */ }
      }
      let img = avatarImgIn(box)
      if (!img) {
        img = document.createElement('img')
        img.setAttribute('data-dsh-profile-avatar', '1')
        img.setAttribute('alt', '')
        img.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain;'
          + 'pointer-events:none;user-select:none;border-radius:50%;'
        try { box.appendChild(img) } catch { return false }
      }
      if (img.getAttribute('src') !== url) img.setAttribute('src', url)
      img.style.transform = transformCss(cfg)
      img.style.transformOrigin = '50% 50%'
      // 藏掉圆块里原有的图标（蓝色小人 / 内层 svg）
      for (const child of Array.from(box.querySelectorAll('svg'))) {
        if (child.style.display === 'none') continue
        child.style.display = 'none'
        hiddenIcons.add(child)
      }
      return true
    }

    function applyAvatar(nodes, cfg) {
      // 只有「头像被清空」才整体还原；平时不再每轮先恢复再重画 ——
      // 那样会和观察器形成 显示↔隐藏 的来回抖动（小头像一闪一闪就是这么来的）。
      if (!cfg.avatar) { clearAvatarArtifacts(); return }
      for (const node of nodes) {
        let box = pairBox.get(node) || null
        if (box && !box.isConnected) box = null
        if (box) {
          applyAvatarToBox(box, cfg.avatar, cfg)
          continue
        }
        // 以前这里还有一条兜底：名字左边直接插一张方形小图。
        // 那条会把账号卡里的昵称也当成锚点，塞出一个 20px 的「小头像」——
        // 我们后面又写规则去隐藏它，等于自己跟自己打架。源码确认账号卡本来
        // 就只有一个头像（span.avatar > img），所以这里直接不做兜底。
      }
      // 直接命中左下角那个账号头像：不依赖文字锚点是否被跟踪到，
      // 只要 `[aria-label="账号菜单"]` 里的 `_avatar` 在，就一定会应用。
      try {
        const trig = document.querySelector('[aria-label="账号菜单"]')
        const av = trig && trig.querySelector('[class*="_avatar"]')
        if (av) applyAvatarToBox(av, cfg.avatar, cfg)
      } catch { /* ignore */ }
      // 账号设置页里那个头像（只换图，不动文字）。
      for (const box of extraAvatarBoxes) {
        if (box && box.isConnected) applyAvatarToBox(box, cfg.avatar, cfg)
      }
      // 名字旁的小头像藏掉 —— 账号卡里只留一个大头像。已经隐藏的不再重复写样式。
      for (const box of accountHideBoxes) {
        if (!box || !box.isConnected) continue
        if (box.style.display === 'none') { hiddenAccountBoxes.add(box); continue }
        try {
          box.style.setProperty('display', 'none', 'important')
          hiddenAccountBoxes.add(box)
        } catch { /* ignore */ }
      }
      // 清掉已经脱离文档的记录
      for (const el of Array.from(hiddenAccountBoxes)) {
        if (!el.isConnected) hiddenAccountBoxes.delete(el)
      }
      try { clearIdentityBackgrounds() } catch { /* ignore */ }
    }

    /** 正在应用样式时置位：期间自己造成的 DOM 变化不再触发重绘。 */
    let applying = false
    /** 上一次应用完成的时间：之后一小段窗口内的变化一律忽略，彻底断开自激循环。 */
    let lastApplyAt = 0

    function applyAll() {
      if (applying) return
      applying = true
      try {
        // 只用「已保存」的配置去改真实界面（左下角、账号卡）。
        // 设置页里没点保存的改动只留在面板预览里，不外溢。
        const cfg = loadConfig()
        // 有头像才挂隐藏规则；没头像就撤掉，避免把宿主的账号信息藏成空白。
        if (cfg.avatar) ensureHideCss()
        else dropHideCss()
        let nodes = []
        try { nodes = collectNodes() } catch (e) { nodes = [] }
        try { applyName(nodes, cfg.name) } catch { /* ignore */ }
        try { applyAvatar(nodes, cfg) } catch (e) { /* 出问题就算了，别把宿主弄坏 */ }
        // 标记账号卡的身份区「已处理」：CSS 里未标记的先隐藏，处理完才显示，
        // 这样就不会先看到默认头像/昵称再跳到自定义。只加属性、不撤销，不会自激。
        try {
          for (const el of Array.from(document.querySelectorAll('[class*="_identity"]'))) {
            el.setAttribute('data-dsh-ready', '1')
          }
        } catch { /* ignore */ }
      } finally {
        lastApplyAt = Date.now()
        setTimeout(() => { applying = false }, 80)
      }
    }


    /* ---------------- 设置面板 ---------------- */

    function Field(props) {
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 } },
        React.createElement('div', { style: { fontSize: 13, fontWeight: 600 } }, props.label),
        props.hint ? React.createElement('div', { style: { fontSize: 12, opacity: 0.65, lineHeight: 1.5 } }, props.hint) : null)
    }

    function Preview(props) {
      const { cfg } = props
      const boxRef = React.useRef(null)
      const dragRef = React.useRef(null)

      const onPointerDown = (e) => {
        if (!cfg.avatar) return
        dragRef.current = { x: e.clientX, y: e.clientY, ox: cfg.offsetX, oy: cfg.offsetY }
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ignore */ }
      }
      const onPointerMove = (e) => {
        const d = dragRef.current
        if (!d || !boxRef.current) return
        const r = boxRef.current.getBoundingClientRect()
        const dx = (e.clientX - d.x) / Math.max(1, r.width) * 100 / Math.max(1, cfg.zoom)
        const dy = (e.clientY - d.y) / Math.max(1, r.height) * 100 / Math.max(1, cfg.zoom)
        props.onChange({
          offsetX: Math.min(80, Math.max(-80, Math.round(d.ox + dx))),
          offsetY: Math.min(80, Math.max(-80, Math.round(d.oy + dy))),
        })
      }
      const onPointerUp = () => { dragRef.current = null }
      const onWheel = (e) => {
        if (!cfg.avatar) return
        try { e.preventDefault() } catch { /* ignore */ }
        const next = Math.min(4, Math.max(1, Math.round((cfg.zoom + (e.deltaY < 0 ? 0.1 : -0.1)) * 100) / 100))
        props.onChange({ zoom: next })
      }

      return React.createElement('div', {
        ref: boxRef,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: onPointerUp,
        onWheel,
        title: '拖动调整位置，滚轮缩放',
        style: {
          width: 96, height: 96, borderRadius: '50%', overflow: 'hidden', position: 'relative',
          background: 'var(--dsw-alias-bg-layer-2, #262626)',
          border: '1px solid var(--dsw-alias-border-l1, #3a3a3a)',
          cursor: cfg.avatar ? 'grab' : 'default', touchAction: 'none',
        },
      }, cfg.avatar
        ? React.createElement('img', {
          src: cfg.avatar, alt: '', draggable: false,
          style: {
            position: 'absolute', left: 0, top: 0, width: '100%', height: '100%',
            objectFit: 'contain', pointerEvents: 'none',
            transform: transformCss(cfg), transformOrigin: '50% 50%',
          },
        })
        : React.createElement('div', {
          style: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 11, opacity: 0.55 },
        }, '未设置头像'))
    }

    function slider(label, value, min, max, onChange) {
      return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 } },
        React.createElement('div', { style: { width: 64, fontSize: 12, opacity: 0.75 } }, label),
        React.createElement('input', {
          type: 'range', min, max, step: 1, value,
          style: { flex: 1 },
          onChange: (e) => onChange(Number(e.target.value)),
        }),
        React.createElement('div', { style: { width: 44, fontSize: 12, textAlign: 'right', opacity: 0.75 } },
          String(Math.round(value)) + (label === '缩放' ? '%' : '')))
    }

    function ProfilePanel() {
      const [cfg, setCfg] = React.useState(loadConfig())
      const [note, setNote] = React.useState('')

      // 改动只进草稿，**只影响本面板里的预览**；真实界面（左下角 / 账号卡）保持不变，
      // 直到点「保存」把它写进 localStorage 才会一次生效。
      const update = (patch) => {
        const next = Object.assign({}, cfg, patch)
        setCfg(next)
        setNote('未保存（点「保存」后才会应用到左下角和账号页）')
      }

      const saveAll = () => {
        const ok = saveConfig(cfg)
        if (ok) setNote('已保存')
        else setNote('保存失败：存储空间不足，换一张小一点的图')
        applyAll()
      }

      const onPickFile = (e) => {
        const file = e.target.files && e.target.files[0]
        if (!file) return
        if (!/^image\//.test(file.type)) { setNote('请选图片文件'); return }
        if (file.size > 20 * 1024 * 1024) { setNote('文件超过 20MB，换小一点的'); return }
        setNote('正在处理图片…')
        normalizeImageFile(file, (dataUrl) => {
          if (!dataUrl) { setNote('这张图读不出来，换一张试试（SVG 带外链时可能失败）'); return }
          update({ avatar: dataUrl, zoom: 1, offsetX: 0, offsetY: 0 })
        })
      }

      const inputStyle = {
        width: '100%', boxSizing: 'border-box', padding: '8px 10px',
        borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1, #3a3a3a)',
        background: 'var(--dsw-alias-bg-layer-1, #1e1e1e)',
        color: 'var(--dsw-alias-label-primary, #eee)', fontSize: 13, outline: 'none',
      }

      const btnStyle = {
        padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
        border: '1px solid var(--dsw-alias-border-l1, #3a3a3a)',
        background: 'var(--dsw-alias-bg-layer-2, #262626)', color: 'inherit',
      }

      // 当前草稿与已保存的配置是否一致：一致时「保存头像」才高亮成蓝色。
      const persisted = loadConfig()
      const saved = num(cfg.zoom, 1) === num(persisted.zoom, 1)
        && num(cfg.offsetX, 0) === num(persisted.offsetX, 0)
        && num(cfg.offsetY, 0) === num(persisted.offsetY, 0)
        && num(cfg.boxScale, 1) === num(persisted.boxScale, 1)
        && String(cfg.avatar || '') === String(persisted.avatar || '')
        && String(cfg.name || '') === String(persisted.name || '')

      return React.createElement('div', { style: { padding: '4px 0', maxWidth: 620 } },
        React.createElement('div', { style: { fontSize: 13, lineHeight: 1.7, opacity: 0.8, marginBottom: 16 } },
          '把左下角那块的昵称和头像换成你自己的。只影响本机浏览器显示，不改账号资料。改完记得点「保存」。'),

        React.createElement(Field, { label: '昵称', hint: '留空恢复成默认显示。' }),
        React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          React.createElement('input', {
            style: inputStyle,
            value: cfg.name,
            placeholder: '比如：大肥鱼的主人',
            onChange: (e) => update({ name: e.target.value }),
          }),
          React.createElement('button', {
            style: Object.assign({}, btnStyle, { flex: 'none', whiteSpace: 'nowrap' }),
            // 和「重置头像」保持一致：立刻落盘并生效，不用再点保存。
            onClick: () => {
              const next = Object.assign({}, loadConfig(), { name: '' })
              setCfg(next)
              saveConfig(next)
              applyAll()
              setNote('已重置昵称')
            },
          }, '重置昵称'),
        ),

        React.createElement('div', { style: { height: 16 } }),

        React.createElement(Field, {
          label: '头像',
          hint: '上传图片（PNG / JPG / WebP / GIF / BMP / AVIF / SVG 都行），会自动缩到 512px 内；也可以填图片 URL。下面的预览可以拖动、滚轮缩放。',
        }),

        React.createElement('div', { style: { display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' } },
          React.createElement(Preview, { cfg, onChange: (patch) => update(patch) }),
          React.createElement('div', { style: { flex: '1 1 260px', minWidth: 240 } },
            React.createElement('input', {
              style: inputStyle,
              value: cfg.avatar.startsWith('data:') ? '' : cfg.avatar,
              placeholder: cfg.avatar.startsWith('data:') ? '当前：已上传的本地图片' : 'https://… 或点下面的上传按钮',
              onChange: (e) => update({ avatar: e.target.value }),
            }),
            slider('缩放', Math.round(num(cfg.zoom, 1) * 100), 100, 400, (v) => update({ zoom: v / 100 })),
            slider('左右', num(cfg.offsetX, 0), -80, 80, (v) => update({ offsetX: v })),
            slider('上下', num(cfg.offsetY, 0), -80, 80, (v) => update({ offsetY: v })),
            slider('尺寸', Math.round(num(cfg.boxScale, 1) * 100), 70, 200, (v) => update({ boxScale: v / 100 })),
            React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' } },
              React.createElement('label', { style: btnStyle }, '上传图片',
                React.createElement('input', {
                  type: 'file',
                  accept: 'image/*',
                  style: { display: 'none' },
                  onChange: onPickFile,
                })),
              React.createElement('button', {
                style: Object.assign({}, btnStyle, { background: 'transparent' }),
                onClick: () => update({ zoom: 1, offsetX: 0, offsetY: 0 }),
              }, '重置构图'),
              // 头像的保存与重置都放在头像这一块下面；昵称的重置在上面的输入框旁边。
              React.createElement('button', {
                style: saved
                  ? Object.assign({}, btnStyle, { background: 'var(--dsw-alias-brand-primary, #3b82f6)', color: '#fff', border: '0' })
                  : Object.assign({}, btnStyle, { background: 'transparent' }),
                onClick: saveAll,
              }, saved ? '已保存' : '保存'),
              React.createElement('button', {
                style: Object.assign({}, btnStyle, { background: 'transparent' }),
                onClick: () => {
                  const next = Object.assign({}, cfg, { avatar: '', zoom: 1, offsetX: 0, offsetY: 0, boxScale: 1 })
                  setCfg(next)
                  saveConfig(next)
                  applyAll()
                  setNote('已重置头像')
                },
              }, '重置头像'),
            ),
          ),
        ),

        note ? React.createElement('div', { style: { marginTop: 12, fontSize: 12, opacity: 0.7 } }, note) : null,
      )
    }

    /* ---------------- 挂载 ---------------- */

    /* ---------------- 隐藏用的 CSS（按配置动态挂载） ---------------- */

    /**
     * 只有**确实配置了头像**时才注入这两条规则，否则不注入：
     * 1) 身份区里不是我们插入的图（宿主自己的头像）不渲染；
     * 2) 还没被 JS 处理过的身份区先隐藏，处理完打上 data-dsh-ready 再显示。
     *
     * 做成动态的，是为了避免「没设头像」或「插件出毛病」时把宿主自己的
     * 账号信息藏成一片空白 —— 那种失效比不生效更让人难受。
     */
    let cssEl = null
    const HIDE_CSS = [
      '[class*="_identity"] img:not([data-dsh-profile-avatar]){display:none!important}',
      '[class*="_identity"]:not([data-dsh-ready]){visibility:hidden!important}',
    ].join('\n')

    function ensureHideCss() {
      if (cssEl && cssEl.isConnected) return
      try {
        cssEl = document.createElement('style')
        cssEl.setAttribute('data-plugin', 'dsh-custom-profile')
        cssEl.textContent = HIDE_CSS
        document.head.appendChild(cssEl)
      } catch { cssEl = null }
    }

    function dropHideCss() {
      try { if (cssEl) cssEl.remove() } catch { /* ignore */ }
      cssEl = null
    }

    function apply(ctx) {
      const doc = document
      if (!doc || !doc.body) return

      try {
        for (const img of doc.querySelectorAll('img[data-dsh-profile-avatar]')) img.remove()
      } catch { /* ignore */ }

      applyAll()

      let timer = 0
      const schedule = () => {
        if (timer) return
        timer = setTimeout(() => {
          timer = 0
          // 刚应用完的 350ms 内不再重跑：这段时间里的变化基本都是自己造成的。
          if (Date.now() - lastApplyAt < 350) { schedule(); return }
          applyAll()
        }, 250)
      }

      /** 新插入的子树里是否带着我们要处理的东西（账号按钮 / 账号卡 / 头像容器）。 */
      const hitAnchor = (node) => {
        if (!node || node.nodeType !== 1) return false
        try {
          if (node.matches && (node.matches('[aria-label="账号菜单"]')
            || node.matches('[class*="_card"]')
            || node.matches('[class*="_avatar"]'))) return true
          if (node.querySelector && (node.querySelector('[aria-label="账号菜单"]')
            || node.querySelector('[class*="_card"]')
            || node.querySelector('[class*="_avatar"]'))) return true
        } catch { /* ignore */ }
        return false
      }

      /** 变化是否发生在「账号按钮」或「设置弹窗」内部。 */
      const insideAnchor = (rec) => {
        const t = rec.target
        const el = t && t.nodeType === 1 ? t : (t && t.parentElement)
        if (!el || !el.closest) return false
        if (el.closest('[aria-label="账号菜单"]')) return true
        if (el.closest('[role="dialog"]')) return true
        return false
      }

      /** 兜底：万一应用没跑到，也要把身份区放出来，绝不能让它一直空白。 */
      const releaseSoon = () => {
        setTimeout(() => {
          try {
            const list = Array.from(document.querySelectorAll('[class*="_identity"]'))
            if (!list.length) return
            for (const el of list) el.setAttribute('data-dsh-ready', '1')
          } catch { /* ignore */ }
        }, 600)
      }

      let observer = null
      try {
        observer = new MutationObserver((records) => {
          let relevant = false
          let urgent = false
          for (const rec of records) {
            if (insideAnchor(rec)) { relevant = true; }
            for (const n of Array.from(rec.addedNodes || [])) {
              if (hitAnchor(n)) { relevant = true; urgent = true; break }
            }
            if (urgent) break
          }
          if (!relevant) return
          // 账号按钮 / 账号卡刚被插入：观察器回调发生在「绘制前」，
          // 这里立刻同步应用一次，用户既看不到默认值、也看不到空白。
          // 这一路**不能被 350ms 冷却挡住** —— 挡住的后果就是先空/先默认再变正常。
          if (urgent) {
            if (applying) {
              // 正处在自己那一轮应用里：等它结束再来一次，同时上兜底。
              releaseSoon()
              schedule()
              return
            }
            try { applyAll() } catch { /* ignore */ }
            schedule()
            return
          }
          // 非插入类变化（比如同一区域内改属性）：按冷却窗口节流。
          if (Date.now() - lastApplyAt < 350) { schedule(); return }
          schedule()
        })
        // 不监听 characterData：打字时的文本变化不该惊动这个插件。
        observer.observe(doc.body, { childList: true, subtree: true })
      } catch { observer = null }

      // 有界的补扫：账号按钮 / 设置面板常常比插件晚挂载，开头补两次就够，
      // 不做事后常驻轮询（那正是上一版把输入拖死的原因）。
      const retry1 = setTimeout(() => { try { applyAll() } catch { /* ignore */ } }, 700)
      const retry2 = setTimeout(() => { try { applyAll() } catch { /* ignore */ } }, 1800)

      const dispose = () => {
        if (observer) { try { observer.disconnect() } catch { /* ignore */ } }
        if (timer) { clearTimeout(timer); timer = 0 }
        try { clearTimeout(retry1) } catch { /* ignore */ }
        try { clearTimeout(retry2) } catch { /* ignore */ }
        try { clearAvatarArtifacts() } catch { /* ignore */ }
        try { dropHideCss() } catch { /* ignore */ }
      }
      if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
      else return dispose

      const slots = typeof ctx.get === 'function' ? ctx.get('slots') : undefined
      if (!slots) return
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'custom-profile', order: 26, label: '个人资料' },
        () => React.createElement(ProfilePanel),
      ))
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.__test = { loadConfig, saveConfig, applyAll, collectNodes, scanChipPairs }
    return module.exports
  },
})
