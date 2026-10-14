/* global FileReader, ResizeObserver, IntersectionObserver, setTimeout, clearTimeout, NodeFilter */
export function mountChatReader(root, api) {
  const document = root.ownerDocument
  const window = document.defaultView
  const surface = root.querySelector('.chat-reader-surface') || root
  const lifecycle = new window.AbortController()
  let disposed = false
  const listen = (target, event, handler, options = {}) =>
    target.addEventListener(
      event,
      handler,
      typeof options === 'boolean'
        ? { capture: options, signal: lifecycle.signal }
        : { ...options, signal: lifecycle.signal },
    )
  const requestAnimationFrame = (callback) =>
    window.requestAnimationFrame(() => {
      if (!disposed) callback()
    })

  // This APP has no database or chat-file store. All originals and bindings are owned by SRL.
  const $ = (s) => root.querySelector(s)
  const $$ = (s) => [...root.querySelectorAll(s)]
  const esc = (t) =>
    String(t ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    )
  const paths = {
    back: 'M14 5l-7 7 7 7',
    next: 'M9 5l7 7-7 7',
    search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    more: 'M5 12h.01 M12 12h.01 M19 12h.01',
    book: 'M4 4h6l2 2 2-2h6v15h-6l-2 2-2-2H4z M12 6v15',
    bookmark: 'M6 3h12v18l-6-4-6 4z',
    sliders: 'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
    close: 'M6 6l12 12 M18 6L6 18',
    sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2',
    progress: 'M4 6h16 M4 12h16 M4 18h10 M17 16l3 3-3 3',
    full: 'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5',
    menu: 'M5 7h14 M5 12h14 M5 17h14',
    image: 'M4 4h16v16H4z M4 16l5-5 4 4 3-3 4 4 M15 8h.01',
  }
  const icon = (name) =>
    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.more}"/></svg>`
  const shadow = $('#readingFlow').attachShadow({ mode: 'open' })
  const readingBaseCss =
    ':host{display:block}p{margin:0 0 1em;text-align:justify;overflow-wrap:anywhere}img,video{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{display:block;max-width:100%;overflow:auto}.mes_text{overflow-wrap:anywhere}.floor{break-inside:auto}'
  let defaultContentStyles = ''
  function applyShellCss(css) {
    if (!runtime.builtinReader) return
    let style = $('#reader-shell-style')
    if (!style) {
      style = document.createElement('style')
      style.id = 'reader-shell-style'
      root.append(style)
    }
    style.textContent = (css || '').replace(/:root\b|\bbody\b/g, '.chat-reader-surface')
  }
  let prefs = {
    renderMode: 'simple',
    mode: 'scroll',
    progressMode: 'jump',
    blendPanels: true,
    panelAppearance: 'author',
    layout: 'novel',
    theme: 'paper',
    font: 18,
    leading: 1.85,
    width: 700,
    regex: true,
    remote: false,
    mask: false,
    maskMode: 'replace',
    words: '',
    replacement: '某某',
    hideUser: false,
    css: '',
    styleId: '',
    characterCover: false,
  }
  const appearanceKeys = [
    'theme',
    'font',
    'leading',
    'width',
    'layout',
    'css',
    'styleId',
    'panelAppearance',
    'blendPanels',
    'regex',
  ]
  let defaultPrefs = { ...prefs },
    roleAppearance = null
  let characters = [],
    charactersById = new Map(),
    chats = [],
    role = null,
    chat = null,
    state = {},
    pageData = null,
    page = 0,
    pages = 1,
    pageRanges = [{ start: 0, end: 0 }],
    prior = null,
    readVersion = 0,
    version = 0,
    searchVersion = 0,
    listLimit = 30
  let runtime = {},
    starting = true,
    chrome = false,
    saveTimer,
    toastTimer,
    holdTimer,
    suppress = false,
    bodyStyles = '',
    indexState = {},
    background = ''
  const avatarCache = new Map(),
    stateCache = new Map()
  let storageQueue = Promise.resolve()
  const run = (fn) =>
    Promise.resolve()
      .then(() => (disposed ? undefined : fn()))
      .catch((error) => notify(error instanceof Error ? error.message : String(error), true))
  // Event targets are retargeted to the host after dispatch across a ShadowRoot.
  // Capture the actual control before scheduling asynchronous work.
  const runEvent = (event, handler) => {
    const target = event.target
    return run(() => handler(target))
  }
  function notify(text, error = false) {
    if (disposed) return
    if ($('#sheet').open) {
      const feedback = $('#sheetFeedback')
      feedback.textContent = text
      feedback.hidden = false
      feedback.classList.toggle('error', error)
      feedback.setAttribute('role', error ? 'alert' : 'status')
      feedback.scrollIntoView({ block: 'nearest' })
      if (error) feedback.focus({ preventScroll: true })
      return
    }
    $('#toast').textContent = text
    $('#toast').hidden = false
    $('#toast').classList.toggle('error', error)
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => ($('#toast').hidden = true), 4000)
  }
  function store(key, value) {
    const snapshot = JSON.parse(JSON.stringify(value))
    const task = storageQueue.catch(() => {}).then(() => api.storage.set(key, snapshot))
    storageQueue = task
    return task
  }
  async function savePrefs() {
    const own = roleAppearance?.enabled === true
    for (const [key, value] of Object.entries(prefs)) {
      if (own && appearanceKeys.includes(key)) roleAppearance.values[key] = value
      else defaultPrefs[key] = value
    }
    if (own) await store('appearance:' + role, roleAppearance)
    await store('preferences-v1', defaultPrefs)
  }
  function resolveAppearance() {
    prefs = { ...defaultPrefs, ...(roleAppearance?.enabled ? roleAppearance.values : {}) }
    applyPrefs()
  }
  async function changeAppearanceMode(enabled, reset = false) {
    const pos = currentPosition()
    const next = reset
      ? { enabled: false }
      : {
          ...roleAppearance,
          enabled,
          values:
            roleAppearance?.values ||
            Object.fromEntries(appearanceKeys.map((key) => [key, prefs[key]])),
          rules:
            roleAppearance?.rules ||
            Object.fromEntries(
              (pageData?.regexRules || [])
                .filter((r) => r.signature)
                .map((r) => [r.signature, r.enabled]),
            ),
        }
    await store('appearance:' + role, next)
    roleAppearance = next
    background = ''
    $('#reader').style.backgroundImage = ''
    $('#reader').style.setProperty('--veil', 0)
    resolveAppearance()
    await read(pageData.messages[0]?.index || 0, pos)
    await panel('appearance')
  }
  async function getState(id) {
    if (!stateCache.has(id)) {
      const s = await api.storage.get('chat:' + id)
      stateCache.set(id, { note: '', title: '', pinned: false, marks: [], ...s })
    }
    return stateCache.get(id)
  }
  async function saveState() {
    if (!chat) return
    stateCache.set(chat.id, state)
    await store('chat:' + chat.id, state)
    indexState.lastChat = chat.id
    await store('reader-index-v1', indexState)
  }
  let sheetReturn = null
  function sheet(title, html, returnTo = null) {
    sheetReturn = returnTo
    $('#sheetFeedback').hidden = true
    $('#sheetFeedback').textContent = ''
    $('#sheetTitle').textContent = title
    $('#sheetBody').innerHTML = html
    if (!$('#sheet').open) $('#sheet').showModal()
  }
  function closeSheet() {
    if (sheetReturn) run(sheetReturn)
    else $('#sheet').close()
  }
  function loading(text) {
    $('#libraryContent').innerHTML = `<p class="loading">${esc(text)}</p>`
  }
  async function allResources(types, ids) {
    return api.resources.summaries(types, ids)
  }
  function boundRole(c) {
    const matches = c.relatedResourceIds
      .map((id) => charactersById.get(id))
      .filter((r) => r && !r.companion)
    return matches.length === 1
      ? matches[0]
      : matches.length === 0 && c.chatCharacter
        ? charactersById.get(c.chatCharacter.id)
        : null
  }
  function avatar(r) {
    const src = avatarCache.get(r.id)
    return src
      ? `<img class="avatar" src="${src}" alt="${esc(r.name)}">`
      : `<span class="avatar serif" data-avatar="${esc(r.id)}">${esc(r.name.slice(0, 1))}</span>`
  }
  function applyCharacterCover() {
    const button = $('#characterCover')
    const label = prefs.characterCover ? '关闭角色沉浸背景' : '开启角色沉浸背景'
    button.setAttribute('aria-pressed', String(prefs.characterCover))
    button.setAttribute('aria-label', label)
    button.title = label
    const image = role && prefs.characterCover ? avatarCache.get(role) : null
    $('#library').classList.toggle('character-cover', Boolean(image))
    if (image) $('#library').style.setProperty('--character-cover', `url("${image}")`)
    else $('#library').style.removeProperty('--character-cover')
  }
  async function loadAvatar(id) {
    if (avatarCache.has(id)) return
    avatarCache.set(id, null)
    const blob = await api.resources.thumbnail(
      characters.find((r) => r.id === id)?.thumbnailId || id,
    )
    if (!blob) return
    const src = await dataUrl(blob)
    avatarCache.set(id, src)
    applyCharacterCover()
    const current = $(`[data-avatar="${window.CSS.escape(id)}"]`)
    if (current) {
      const img = document.createElement('img')
      img.className = 'avatar'
      img.src = src
      img.alt = '角色头像'
      current.replaceWith(img)
    }
  }
  const avatarObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      avatarObserver.unobserve(entry.target)
      run(() => loadAvatar(entry.target.dataset.avatar))
    }
  })
  function observeAvatars() {
    avatarObserver.disconnect()
    $$('[data-avatar]')
      .slice(0, 30)
      .forEach((el) => avatarObserver.observe(el))
  }
  async function refresh(render = true) {
    loading('正在读取资源库…')
    const directory = await api.resources.directory()
    if (disposed) return
    chats = directory.chats
    characters = directory.characters
    characters.sort((a, b) => b.revision - a.revision || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    for (const c of chats) {
      if (c.chatCharacter && !characters.some((r) => r.id === c.chatCharacter.id))
        characters.push({ ...c.chatCharacter, thumbnailId: c.id, companion: true })
    }
    charactersById = new Map(characters.map((r) => [r.id, r]))
    if (render) await renderLibrary()
    $('#aboutBtn').hidden = false
  }
  async function renderLibrary() {
    const revision = ++version
    applyCharacterCover()
    const q = $('#librarySearch').value.trim().toLowerCase()
    $('#libraryTitle').textContent = role ? '聊天记录' : '读了么'
    $('#brand').hidden = !!role
    $('#libraryBack').hidden = !role
    await syncNavigation()
    $('#librarySearch').placeholder = role ? '搜索标题或已加载备注' : '搜索角色名称'
    let html = ''
    if (!role) {
      const roleCounts = new Map()
      const pending = []
      for (const c of chats) {
        const binding = boundRole(c)
        if (binding) roleCounts.set(binding.id, (roleCounts.get(binding.id) || 0) + 1)
        else pending.push(c)
      }
      const recent = chats.find((c) => c.id === indexState.lastChat)
      if (recent && boundRole(recent)) {
        html += `<button class="continue" data-chat="${esc(recent.id)}">${icon('bookmark')}<span><span class="small-label muted">继续阅读</span><strong>${esc(boundRole(recent).name)} · ${esc(recent.name)}</strong></span>${icon('next')}</button>`
      }
      html += `<div class="library-heading"><h2>我的角色</h2><span class="count">${characters.filter((r) => roleCounts.has(r.id)).length}</span><button class="right" data-action="refresh">刷新资源库</button></div>`
      const roles = characters.filter(
        (r) => r.name.toLowerCase().includes(q) && roleCounts.has(r.id),
      )
      html += roles
        .slice(0, listLimit)
        .map(
          (r) =>
            `<button class="role-row" data-role="${esc(r.id)}">${avatar(r)}<span class="role-info"><span class="role-name serif">${esc(r.name)}</span><span class="role-sub">${r.companion ? '聊天随附资料' : '已绑定角色卡'}</span></span><span class="role-count"><span><b>${roleCounts.get(r.id)}</b>份聊天</span>${icon('next')}</span></button>`,
        )
        .join('')
      if (roles.length > listLimit)
        html += '<button class="secondary" data-action="moreList">显示更多角色</button>'
      if (pending.length)
        html += `<button class="role-row" data-role="unbound"><span class="avatar serif">?</span><span class="role-info"><span class="role-name serif">待绑定</span><span class="role-sub">选择角色卡后即可阅读，不按同名猜测</span></span><span class="role-count"><b>${pending.length}</b>${icon('next')}</span></button>`
      if (!chats.length)
        html +=
          '<p class="empty">还没有聊天记录。<br>返回资源库，导入酒馆导出的 JSONL 文件，再来这里绑定角色。</p>'
      else if (!roles.length && !pending.length) html += '<p class="empty">没有找到角色</p>'
    } else {
      const r = characters.find((r) => r.id === role)
      html = `<div class="character-head">${r ? avatar(r) : '<span class="avatar">?</span>'}<h2 class="serif">${r ? esc(r.name) : '待绑定聊天'}</h2></div>`
      const group = chats.filter((c) =>
        role === 'unbound' ? !boundRole(c) : boundRole(c)?.id === role,
      )
      const shown = group.slice(0, listLimit)
      const missing = shown.filter((c) => !stateCache.has(c.id))
      if (missing.length) {
        const values = await api.storage.getMany(missing.map((c) => 'chat:' + c.id))
        if (disposed || revision !== version) return
        for (const c of missing)
          stateCache.set(c.id, {
            note: '',
            title: '',
            pinned: false,
            marks: [],
            ...values['chat:' + c.id],
          })
      }
      const list = shown
        .filter((c) =>
          (c.name + (stateCache.get(c.id)?.note || '') + (stateCache.get(c.id)?.title || ''))
            .toLowerCase()
            .includes(q),
        )
        .sort((a, b) => Number(stateCache.get(b.id)?.pinned) - Number(stateCache.get(a.id)?.pinned))
      html +=
        list
          .map((c) => {
            const s = stateCache.get(c.id)
            return `<div class="chat-row"><button class="chat-open" data-chat="${esc(c.id)}"><div class="chat-title serif">${s.pinned ? '◆ ' : ''}${esc(s.title || c.name)}</div><div class="chat-meta"><span>${c.messageCount} 楼</span><span>${s.position ? `读至 ${s.position.floor + 1} 楼` : '未开始'}</span>${!boundRole(c) ? '<span>点击绑定角色</span>' : ''}</div>${s.note ? `<p class="chat-note">${esc(s.note)}</p>` : ''}</button><button class="icon" data-note="${esc(c.id)}" aria-label="备注与整理">${icon('more')}</button></div>`
          })
          .join('') || '<p class="empty">没有找到聊天记录</p>'
      if (group.length > listLimit)
        html += '<button class="secondary" data-action="moreList">加载更多记录</button>'
    }
    if (revision !== version) return
    $('#libraryContent').innerHTML = html
    observeAvatars()
  }
  async function selectRole(id) {
    role = id
    listLimit = 30
    $('#librarySearch').value = ''
    $('#librarySearchWrap').hidden = true
    await renderLibrary()
    surface.scrollTo(0, 0)
  }
  async function bindPanel(c) {
    sheet('绑定角色卡', '<p class="hint">正在读取角色卡…</p>')
    const container = $('#sheetBody').firstElementChild
    const characters = await allResources(['characterCard'])
    if (!container.isConnected || !$('#sheet').open) return
    sheet(
      '绑定角色卡',
      `<p>${esc(c.name)}</p><p class="hint">角色名和文件名仅供参考。请选择这份聊天实际对应的角色卡。</p><label class="field-label" for="bindSelect">角色卡</label><select id="bindSelect"><option value="">请选择</option>${characters
        .filter((r) => !r.companion)
        .map((r) => `<option value="${esc(r.id)}">${esc(r.name)} · ${esc(r.id.slice(-6))}</option>`)
        .join(
          '',
        )}</select><div class="button-row"><button class="primary" id="bindConfirm">确认绑定</button></div>`,
    )
    $('#bindConfirm').onclick = () =>
      run(async () => {
        const id = $('#bindSelect').value
        if (!id) throw Error('请先选择角色卡')
        await api.resources.bindChat(c.id, id)
        $('#sheet').close()
        await refresh()
        notify('角色绑定已保存到资源库')
      })
  }
  async function notePanel(id) {
    const c = chats.find((c) => c.id === id),
      s = await getState(id)
    sheet(
      '备注与整理',
      `<p class="hint">原始名称：${esc(c.name)}</p><label class="field-label" for="displayName">显示名称</label><input class="searchbox" id="displayName" maxlength="160" value="${esc(s.title)}" placeholder="留空使用原名称"><label class="field-label" for="noteInput" style="margin-top:18px">备注</label><textarea id="noteInput" maxlength="500">${esc(s.note)}</textarea><div class="setting-row"><label for="pinned">置顶这份聊天</label><input id="pinned" type="checkbox" ${s.pinned ? 'checked' : ''}></div><div class="button-row"><button class="secondary" id="rebind">更换绑定角色</button><button class="primary" id="saveNote">保存</button></div>`,
    )
    $('#rebind').onclick = () => run(() => bindPanel(c))
    $('#saveNote').onclick = () =>
      run(async () => {
        const next = {
          ...s,
          title: $('#displayName').value.trim(),
          note: $('#noteInput').value.trim(),
          pinned: $('#pinned').checked,
        }
        await store('chat:' + id, next)
        stateCache.set(id, next)
        $('#sheet').close()
        await renderLibrary()
        notify('备注已保存')
      })
  }
  function applyPrefs() {
    const themes = {
      paper: ['#f6f3ec', '#fffcf6', '#303a32', '#85887c', '#dddfd3', '#586c4e', '#e8ebdf'],
      green: ['#e8eddf', '#f3f6ed', '#344134', '#7a8874', '#ccd5c3', '#506c48', '#dbe4d2'],
      night: ['#202622', '#2a322b', '#d0d3c6', '#909c8d', '#3c463d', '#9caf8a', '#313d32'],
    }
    const colors = themes[prefs.theme] || themes.paper
    ;['paper', 'surface', 'ink', 'muted', 'line', 'accent', 'soft'].forEach((k, i) =>
      surface.style.setProperty('--' + k, colors[i]),
    )
    for (const [k, v] of Object.entries({
      font: prefs.font + 'px',
      leading: prefs.leading,
      measure: prefs.width + 'px',
    }))
      surface.style.setProperty('--' + k, v)
    surface.style.colorScheme = prefs.theme === 'night' ? 'dark' : 'light'
    $('#reader').classList.toggle('page-mode', prefs.mode === 'page')
    $('#reader').classList.toggle('continuous-mode', prefs.mode === 'continuous')
    $('#prevPage').hidden = prefs.mode === 'continuous'
    $('#nextPage').hidden = prefs.mode === 'continuous'
    $('#prevPage').setAttribute('aria-label', prefs.mode === 'scroll' ? '上一楼' : '上一页')
    $('#nextPage').setAttribute('aria-label', prefs.mode === 'scroll' ? '下一楼' : '下一页')
    $('#readingFlow').classList.toggle(
      'tavern-layout',
      prefs.layout === 'tavern' && prefs.renderMode !== 'plain',
    )
    shadow.querySelector('#chat')?.classList.toggle('page-layout', prefs.mode === 'page')
    $('#readingFlow').style.transform = ''
    $('#readingFlow').style.setProperty('--column-width', $('#readingViewport').clientWidth + 'px')
    if (runtime.builtinReader && !starting) run(syncNavigation)
    for (const frame of panelFrames)
      if (frame.dataset.wholeFloor)
        frame.contentWindow?.postMessage(
          { type: 'srl:reader-appearance', font: prefs.font, leading: prefs.leading },
          '*',
        )
  }
  function readingMaskPattern() {
    const words = [...(pageData?.userNames || []), state.userName, ...prefs.words.split(/[,，\n]/)]
      .map((word) => String(word || '').trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
    const escaped = [...new Set(words)].map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    return new RegExp(
      escaped.concat('\\{\\{\\s*[uU][sS][eE][rR]\\s*\\}\\}', '<USER>').join('|'),
      'g',
    )
  }
  function masked(text, pattern) {
    if (!prefs.mask) return text
    pattern ||= readingMaskPattern()
    return text.replace(pattern, (word) =>
      prefs.maskMode === 'cover'
        ? '▇'.repeat(Math.min(12, Math.max(2, [...word].length)))
        : prefs.replacement || '某某',
    )
  }
  function maskNodes(root) {
    if (!prefs.mask) return
    const pattern = readingMaskPattern()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    for (const node of nodes) {
      if (!node.parentElement.closest('style,script'))
        node.textContent = masked(node.textContent, pattern)
    }
  }
  const panelFrames = new Set()
  const scriptControls = new Map()
  function updateScriptControlVisibility() {
    $('#readerScripts').hidden = !(state?.scripts === true && prefs.renderMode === 'full')
  }
  function scriptActionsPanel() {
    const floor = currentPosition().floor
    const sources = [...scriptControls].filter(
      ([frame]) => frame.isConnected && Number(frame.dataset.scriptFloor) === floor,
    )
    sheet('脚本快捷操作', '<div id="scriptQuickActions" class="script-quick-actions"></div>')
    const content = $('#scriptQuickActions')
    content.innerHTML = `<p class="hint">第 ${floor + 1} 楼 · 显隐保留脚本，停止返回正文。</p>${
      sources
        .flatMap(([_frame, scripts], frameIndex) =>
          scripts.map(
            (script) =>
              `<section class="script-action-group"><h3>${esc(script.name)}</h3><div class="script-action-buttons">${script.buttons
                .filter((button) => button.visible)
                .map(
                  (button) =>
                    `<button class="script-action-button" data-script-frame="${frameIndex}" data-script-id="${esc(script.id)}" data-script-action="${esc(button.name)}">${esc(button.name)}</button>`,
                )
                .join('')}</div></section>`,
          ),
        )
        .join('') || '<p class="hint">脚本尚未提供快捷按钮；仍可停止运行，返回正文。</p>'
    }<div class="script-action-footer"><button id="stopReadingScripts">停止脚本，返回正文</button></div>`
    content.querySelectorAll('[data-script-action]').forEach((button) => {
      button.onclick = () => {
        const frame = sources[Number(button.dataset.scriptFrame)]?.[0]
        if (!frame?.isConnected || !panelFrames.has(frame)) return
        $('#sheet').close()
        frame.contentWindow?.postMessage(
          {
            protocol: 'srl-render-compat-v1',
            type: 'SRL_SCRIPT_BUTTON_CLICK',
            scriptId: button.dataset.scriptId,
            name: button.dataset.scriptAction,
          },
          '*',
        )
      }
    })
    $('#stopReadingScripts').onclick = () =>
      run(async () => {
        const pos = currentPosition()
        state.scripts = false
        await saveState()
        $('#sheet').close()
        await read(pageData.messages[0]?.index || 0, pos)
      })
  }
  $('#readerScripts').onclick = () => scriptActionsPanel()
  const lazyPanels = new Map()
  const floorDocuments = new Map()
  let scriptSession = null
  let readerWindowLoading = null
  let readerWindowUnsupported = false
  const usesReaderWindow = () =>
    !readerWindowUnsupported &&
    prefs.mode !== 'page' &&
    state?.scripts === true &&
    prefs.renderMode === 'full' &&
    (scriptSession?.native || pageData?.messages.some((entry) => entry.scriptCount))
  function readerWindowKey() {
    return JSON.stringify([panelEpoch, pageData.messages.map((entry) => entry.index)])
  }
  async function prepareReaderWindow(epoch) {
    const entries = [...pageData.messages]
    const results = await Promise.all(
      entries.map(async (entry) => {
        if (!floorDocuments.has(entry.index))
          floorDocuments.set(
            entry.index,
            api.resources.readChat({
              ...readOptions(),
              offset: entry.index,
              limit: 1,
              interactive: true,
              panelInk: window.getComputedStyle($('#readingFlow')).color,
            }),
          )
        return floorDocuments.get(entry.index)
      }),
    )
    if (epoch !== panelEpoch) return null
    if (results[0]?.previewCapabilities?.archivedReaderWindow !== true) return { legacy: true }
    const scriptKey = JSON.stringify(
      results[0]?.scriptRules?.filter((rule) => rule.enabled).map((rule) => rule.key) || [],
    )
    if (scriptSession?.native && scriptSession.scriptKey !== scriptKey) {
      const position = currentPosition()
      pageData = { ...pageData, messages: results.flatMap((result) => result.messages) }
      clearPanelFrames()
      renderPage()
      restore(position)
      notify('脚本来源已变化，请重新确认选择')
      return null
    }
    const selected =
      results.find(
        (result) => result.messages[0]?.interactiveDocument && result.messages[0]?.scriptCount,
      ) || scriptSession?.baseResult
    if (!selected) throw Error('当前阅读窗口缺少已开启的角色脚本')
    const parsed = new window.DOMParser().parseFromString(
      selected.messages[0].interactiveDocument,
      'text/html',
    )
    const root = parsed.querySelector('#chat')
    root.replaceChildren()
    root.dataset.srlReaderWindow = 'true'
    root.style.opacity = '0'
    const snapshots = []
    const vendors = {}
    for (const [index, result] of results.entries()) {
      if (result.contentHash !== pageData.contentHash) throw Error('聊天原件已变化，请重新打开阅读')
      const message = result.messages[0]
      if (!message?.snapshot) throw Error('阅读窗口缺少已保存的楼层快照')
      snapshots.push(message.snapshot)
      const section = shadow.querySelector(`[data-floor="${entries[index].index}"]`).cloneNode(true)
      section.style.removeProperty('height')
      if (!section.getAttribute('style')) section.removeAttribute('style')
      const body = section.querySelector('.mes_text')
      body.removeAttribute('data-chat-frontend')
      body.removeAttribute('data-script-projection')
      body.style.removeProperty('height')
      if (!body.getAttribute('style')) body.removeAttribute('style')
      if (message.interactiveDocument) {
        const source = new window.DOMParser().parseFromString(
          message.interactiveDocument,
          'text/html',
        )
        const pool = source.getElementById('srl-preview-vendor-data')
        if (pool) Object.assign(vendors, JSON.parse(pool.textContent))
        body.replaceChildren(...source.querySelector('#chat .mes_text').childNodes)
      }
      maskNodes(section)
      root.append(section)
    }
    let history
    if (!scriptSession && results[0]?.previewCapabilities?.archivedReaderHistory === true) {
      history = []
      let offset = 0
      while (offset !== null) {
        if (epoch !== panelEpoch || state?.scripts !== true) return null
        const batch = await api.resources.readChat({
          ...readOptions(),
          offset,
          limit: 50,
          hideUser: false,
          interactive: false,
          remote: false,
          scripts: false,
          snapshotsOnly: true,
        })
        if (epoch !== panelEpoch || state?.scripts !== true) return null
        if (batch.contentHash !== pageData.contentHash)
          throw Error('聊天原件已变化，请重新打开阅读')
        for (const entry of batch.messages) {
          if (!entry.snapshot || entry.snapshot.message_id !== history.length)
            throw Error('完整聊天快照不连续，未启动脚本')
          history.push(entry.snapshot)
        }
        if (
          batch.nextOffset !== null &&
          (!Number.isSafeInteger(batch.nextOffset) || batch.nextOffset <= offset)
        )
          throw Error('聊天快照分页未前进')
        offset = batch.nextOffset
      }
      if (history.length !== pageData.total) throw Error('完整聊天快照数量不一致，未启动脚本')
    }
    const table = parsed.createElement('script')
    table.id = 'srl-archived-reader-window'
    table.type = 'application/json'
    const position = scriptSession?.pendingPosition || currentPosition()
    table.textContent = JSON.stringify({ snapshots, history, position, mode: prefs.mode }).replace(
      /</g,
      '\\u003c',
    )
    parsed.head.prepend(table)
    const pool = parsed.getElementById('srl-preview-vendor-data')
    if (pool) pool.textContent = JSON.stringify(vendors).replace(/</g, '\\u003c')
    const style = parsed.createElement('style')
    style.textContent =
      bodyStyles +
      '\n' +
      readingBaseCss +
      '\nhtml,body{height:100%;overflow:hidden}#chat[data-srl-reader-window]{height:100%;overflow:auto;overflow-anchor:auto;overscroll-behavior:contain}#chat .mes_text{font-size:var(--reader-font);line-height:var(--reader-leading)}'
    parsed.head.append(style)
    parsed.documentElement.style.setProperty('--reader-font', prefs.font + 'px')
    parsed.documentElement.style.setProperty('--reader-leading', prefs.leading)
    const appearance = window.getComputedStyle($('#readingFlow'))
    for (const name of [
      '--font',
      '--leading',
      '--ink',
      '--muted',
      '--line',
      '--paper',
      '--measure',
    ])
      parsed.documentElement.style.setProperty(name, appearance.getPropertyValue(name))
    return {
      selected,
      document: '<!doctype html>' + parsed.documentElement.outerHTML,
      html: root.outerHTML,
      snapshots,
      position,
      vendors,
      scriptKey,
    }
  }
  async function syncReaderWindow() {
    if (readerWindowLoading || scriptSession?.windowKey === readerWindowKey()) return
    const epoch = panelEpoch,
      key = readerWindowKey(),
      token = {}
    readerWindowLoading = token
    try {
      const prepared = await prepareReaderWindow(epoch)
      if (!prepared || epoch !== panelEpoch) return
      if (prepared.legacy) {
        readerWindowUnsupported = true
        syncScriptFloor()
        return
      }
      if (!scriptSession) {
        const frame = document.createElement('iframe')
        frame.dataset.wholeFloor = 'true'
        frame.dataset.readerWindow = 'true'
        frame.title = '聊天脚本阅读'
        frame.dataset.scriptFloor = String(prepared.position.floor)
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
        frame.src = prepared.selected.previewDocumentUrl
        frame.style.cssText = 'position:absolute;display:block;border:0;z-index:1;'
        frame.addEventListener(
          'load',
          () => {
            if (scriptSession?.frame === frame)
              frame.contentWindow.postMessage(
                { type: 'srl:preview-document', html: prepared.document },
                '*',
              )
          },
          { once: true },
        )
        scriptSession = {
          frame,
          native: true,
          position: prepared.position,
          mode: prefs.mode,
          settings: scriptSessionSettings(),
          windowKey: key,
          baseResult: prepared.selected,
          scriptKey: prepared.scriptKey,
        }
        panelFrames.add(frame)
        $('#reader').append(frame)
      } else {
        const update = {
          protocol: 'srl-render-compat-v1',
          type: 'SRL_ARCHIVED_READER_WINDOW',
          html: prepared.html,
          snapshots: prepared.snapshots,
          position: prepared.position,
          restore: !!scriptSession.pendingPosition,
          mode: prefs.mode,
          vendors: prepared.vendors,
          topHeight: virtualTopHeight,
          bottomHeight: virtualBottomHeight,
        }
        scriptSession.windowKey = key
        if (scriptSession.ready) scriptSession.frame.contentWindow.postMessage(update, '*')
        else scriptSession.pending = update
      }
      scriptSession.pendingPosition = null
      positionScriptSession()
    } finally {
      if (readerWindowLoading === token) readerWindowLoading = null
    }
  }
  let lastReaderScrollTop = 0
  function setReaderScrollTop(value) {
    const viewport = $('#readingViewport')
    viewport.scrollTop = value
    lastReaderScrollTop = viewport.scrollTop
  }
  function scriptSessionSettings() {
    return JSON.stringify([
      chat?.id,
      state?.scriptSources,
      state?.scriptOverrides,
      prefs.remote,
      prefs.css,
      prefs.styleId,
      prefs.mask,
      prefs.words,
      prefs.theme,
      prefs.mode === 'page' ? 'page' : 'native',
    ])
  }
  function positionScriptSession(panel) {
    if (!scriptSession) return
    if (scriptSession.native) {
      const viewport = $('#readingViewport').getBoundingClientRect(),
        reader = $('#reader').getBoundingClientRect()
      const frame = scriptSession.frame
      frame.style.top = viewport.top - reader.top + 'px'
      frame.style.left = viewport.left - reader.left + 'px'
      frame.style.width = Math.max(1, $('#readingViewport').clientWidth) + 'px'
      frame.style.height = Math.max(1, $('#readingViewport').clientHeight) + 'px'
      frame.hidden = false
      frame.contentWindow?.postMessage(
        { type: 'SRL_HOST_VIEWPORT_HEIGHT', height: $('#readingViewport').clientHeight },
        '*',
      )
      return
    }
    if (!panel?.isConnected) return
    const frame = scriptSession.frame
    frame.style.top =
      panel.getBoundingClientRect().top - $('#readingFlow').getBoundingClientRect().top + 'px'
    frame.hidden = false
  }
  function mapProjectionPosition(position, panel, oldHeight) {
    const floor = panel.closest('[data-floor]')
    if (prefs.mode === 'page' || Number(floor.dataset.floor) !== position.floor || !oldHeight)
      return position
    const height = floor.getBoundingClientRect().height
    // Static and executable layouts can have different heights. A pixel offset past
    // the new floor's end would select the next floor and bounce back repeatedly.
    return {
      ...position,
      offset: Math.min(Math.max(0, height - 6), (position.offset * height) / oldHeight),
    }
  }
  function syncScriptFloor() {
    if (!pageData || state?.scripts !== true || prefs.renderMode !== 'full') return
    if (usesReaderWindow()) {
      run(syncReaderWindow)
      return
    }
    const floor = currentPosition().floor
    const selected = [...lazyPanels].find(
      ([_panel, item]) => item.whole && item.entry.index === floor,
    )
    if (selected) run(() => mountPanel(...selected))
  }
  let panelEpoch = 0
  const panelObserver = new IntersectionObserver(
    (entries) => {
      for (const item of entries) {
        const state = lazyPanels.get(item.target)
        if (!state) continue
        state.visible = item.isIntersecting
        if (item.isIntersecting && !state.whole) run(() => mountPanel(item.target, state))
        // Keep mounted state within this bounded read batch (at most three floors).
        // Replacing an offscreen frame by its collapsed projection can resize pages,
        // re-enter visibility, and repeatedly recreate the same author's script.
      }
      syncScriptFloor()
    },
    { root: $('#readingViewport'), rootMargin: '100% 100%' },
  )
  async function mountPanel(panel, item) {
    if (
      item.loading ||
      (item.frame && (!item.whole || Number(item.frame.dataset.scriptFloor) === item.entry.index))
    )
      return
    item.loading = true
    const epoch = panelEpoch
    try {
      if (!floorDocuments.has(item.entry.index))
        floorDocuments.set(
          item.entry.index,
          api.resources.readChat({
            ...readOptions(),
            offset: item.entry.index,
            limit: 1,
            interactive: true,
            panelInk: window.getComputedStyle(panel.parentElement).color,
          }),
        )
      const result = await floorDocuments.get(item.entry.index)
      if (epoch !== panelEpoch || !panel.isConnected || (!item.whole && !item.visible)) return
      if (item.whole && item.entry.index !== currentPosition().floor) return
      if (result.contentHash !== pageData.contentHash) throw Error('聊天原件已变化，请重新打开阅读')
      let doc = item.whole
        ? result.messages[0]?.interactiveDocument
        : result.messages[0]?.interactiveFrontends?.[item.index]
      if (!doc) return
      if (item.whole) {
        const parsed = new window.DOMParser().parseFromString(doc, 'text/html')
        maskNodes(parsed.body)
        parsed.documentElement.style.setProperty('--reader-font', prefs.font + 'px')
        parsed.documentElement.style.setProperty('--reader-leading', prefs.leading)
        parsed.documentElement.style.setProperty(
          '--SmartThemeBodyColor',
          window.getComputedStyle(panel.parentElement).color,
        )
        doc = '<!doctype html>' + parsed.documentElement.outerHTML
      }
      const scriptKey = JSON.stringify(
        result.scriptRules?.filter((rule) => rule.enabled).map((rule) => rule.key) || [],
      )
      if (item.whole && scriptSession && scriptSession.scriptKey === scriptKey) {
        const frame = scriptSession.frame
        const position = currentPosition()
        const oldHeight = panel.closest('[data-floor]').getBoundingClientRect().height
        if (scriptSession.panel !== panel && scriptSession.panel?.isConnected) {
          scriptSession.panel.removeAttribute('data-script-projection')
          scriptSession.panel.style.removeProperty('height')
        }
        frame.dataset.scriptFloor = String(item.entry.index)
        frame.title = `第 ${item.entry.index + 1} 楼脚本阅读`
        item.frame = frame
        scriptSession.panel = panel
        panel.dataset.scriptProjection = 'true'
        if (scriptSession.height) panel.style.height = scriptSession.height
        restore(mapProjectionPosition(position, panel, oldHeight))
        positionScriptSession(panel)
        const update = {
          protocol: 'srl-render-compat-v1',
          type: 'SRL_ARCHIVED_FLOOR',
          snapshot: result.messages[0]?.snapshot,
          html: doc,
        }
        if (scriptSession.ready) frame.contentWindow?.postMessage(update, '*')
        else scriptSession.pending = update
        return
      }
      if (item.whole && scriptSession) {
        panelFrames.delete(scriptSession.frame)
        scriptControls.delete(scriptSession.frame)
        scriptSession.frame.remove()
        scriptSession = null
      }
      const frame = document.createElement('iframe')
      const bounds = panel.getBoundingClientRect()
      const viewport = $('#readingViewport').getBoundingClientRect()
      if (
        prefs.mode === 'page' &&
        bounds.left < viewport.right &&
        bounds.right > viewport.left &&
        bounds.top < viewport.bottom &&
        bounds.bottom > viewport.top
      )
        frame.dataset.followPage = String(page)
      frame.title = item.whole
        ? `第 ${item.entry.index + 1} 楼脚本阅读`
        : `第 ${item.entry.index + 1} 楼状态栏 ${item.index + 1}`
      if (item.whole) frame.dataset.wholeFloor = 'true'
      frame.className = 'panel-loading'
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
      frame.style.cssText = `display:block;width:100%;height:${panel.getBoundingClientRect().height || 1}px;border:0;`
      frame.src = result.previewDocumentUrl
      frame.addEventListener(
        'load',
        () => {
          if (
            frame.isConnected &&
            (item.whole ? scriptSession?.frame === frame : epoch === panelEpoch)
          )
            frame.contentWindow?.postMessage({ type: 'srl:preview-document', html: doc }, '*')
        },
        { once: true },
      )
      item.frame = frame
      if (item.whole) frame.dataset.scriptFloor = String(item.entry.index)
      panelFrames.add(frame)
      // Keep the already readable projection until the child reports real layout.
      if (item.whole) {
        scriptSession = { frame, panel, scriptKey, settings: scriptSessionSettings(), height: '' }
        frame.style.position = 'absolute'
        frame.style.left = '0'
        frame.style.zIndex = '1'
        shadow.append(frame)
        positionScriptSession(panel)
      } else panel.append(frame)
    } catch (error) {
      if (epoch === panelEpoch) {
        floorDocuments.delete(item.entry.index)
        throw error
      }
    } finally {
      item.loading = false
    }
  }
  let pagePosition = null
  let layoutFrame = 0
  let pendingLayout = null
  let lineMeasurements = new WeakMap()
  let virtualTopHeight = 0
  let virtualBottomHeight = 0
  let continuousLoading = false
  function clearPanelFrames(preserveSession = false) {
    window.cancelAnimationFrame(layoutFrame)
    layoutFrame = 0
    pendingLayout = null
    lineMeasurements = new WeakMap()
    panelEpoch++
    readerWindowLoading = null
    panelObserver.disconnect()
    lazyPanels.clear()
    floorDocuments.clear()
    const retained =
      preserveSession &&
      state?.scripts === true &&
      prefs.renderMode === 'full' &&
      scriptSession?.settings === scriptSessionSettings()
        ? scriptSession.frame
        : null
    const frames = [...panelFrames].filter((frame) => frame !== retained)
    panelFrames.clear()
    for (const frame of frames) scriptControls.delete(frame)
    if (retained) {
      panelFrames.add(retained)
      retained.hidden = true
      if (scriptSession.native) scriptSession.windowKey = ''
    } else scriptSession = null
    if (!scriptSession?.native) $('#readingFlow').style.visibility = ''
    updateScriptControlVisibility()
    pagePosition = null
    for (const frame of frames) frame.remove()
  }
  function renderMessage(entry, content) {
    const m = entry.message
    if (prefs.hideUser && m.is_user) return
    const section = document.createElement('section')
    section.setAttribute('is_user', String(m.is_user))
    section.setAttribute('mesid', String(entry.index))
    section.className = 'floor mes ' + (m.is_user ? 'user' : '')
    section.dataset.floor = entry.index
    section.classList.add(m.is_user ? 'user_mes' : 'bot_mes')
    section.setAttribute('ch_name', masked(m.name))
    const block = document.createElement('div')
    block.className = 'mes_block'
    if (prefs.renderMode !== 'plain' && !m.is_user && avatarCache.get(role)) {
      const portrait = document.createElement('div')
      portrait.className = 'mesAvatarWrapper'
      portrait.innerHTML = `<div class="avatar"><img src="${esc(avatarCache.get(role))}" alt="${esc(masked(m.name))}"></div>`
      section.append(portrait)
    }
    const speaker = document.createElement('div')
    speaker.className = 'speaker ch_name name_text'
    speaker.textContent =
      (m.is_user && prefs.mask ? '你' : masked(m.name)) +
      ' · ' +
      (entry.index + 1) +
      (state.marks.some((x) => x.floor === entry.index) ? ' ◆' : '')
    block.append(speaker)
    const body = document.createElement('div')
    body.className = 'mes_text'
    body.innerHTML =
      entry.html ||
      (prefs.regex && entry.displaySource?.trim() === '' && m.mes.trim()
        ? `<p class="muted">本楼内容已被显示正则隐藏。</p><button class="secondary" data-hidden-rules="${entry.index}">查看隐藏原因</button>`
        : prefs.renderMode === 'plain'
          ? '<p class="muted">本楼没有正文文字，可继续翻阅。</p>'
          : '')
    body.querySelectorAll('[data-chat-frontend]').forEach((panel) => {
      const index = Number(panel.dataset.chatFrontend)
      const staticHost = document.createElement('div')
      panel.append(staticHost)
      const root = staticHost.attachShadow({ mode: 'open' })
      root.addEventListener('load', mediaLayoutChanged, true)
      root.addEventListener('toggle', mediaLayoutChanged, true)
      root.innerHTML = entry.frontends?.[index] || ''
      maskNodes(root)
      if (prefs.renderMode === 'full' && !entry.scriptCount && !usesReaderWindow()) {
        lazyPanels.set(panel, {
          entry,
          index,
          visible: false,
          frame: null,
          loading: false,
        })
        panelObserver.observe(panel)
      } else if (prefs.renderMode !== 'full')
        panel.addEventListener('click', (event) => {
          event.stopPropagation()
          if (event.composedPath().some((node) => node?.matches?.('summary'))) return
          run(async () => enableInteractions())
        })
    })
    maskNodes(body)
    if (prefs.renderMode === 'full' && entry.scriptCount) {
      body.dataset.chatFrontend = '-1'
      lazyPanels.set(body, {
        entry,
        index: -1,
        whole: true,
        visible: false,
        frame: null,
        loading: false,
      })
      panelObserver.observe(body)
    }
    block.append(body)
    section.append(block)
    if (entry.errors?.length) {
      const warning = document.createElement('p')
      warning.className = 'error'
      warning.textContent = '部分正则未执行：' + entry.errors.join('；')
      section.append(warning)
    }
    if (entry.scriptErrors?.length) {
      const warning = document.createElement('p')
      warning.className = 'error'
      warning.textContent = '脚本未加载：' + entry.scriptErrors.join('；')
      section.append(warning)
    }
    content.append(section)
    return section
  }
  function virtualSpacer(id, height) {
    const spacer = document.createElement('div')
    spacer.id = id
    spacer.setAttribute('aria-hidden', 'true')
    spacer.style.cssText = `display:block!important;min-height:0!important;height:${Math.max(0, height)}px!important;max-height:none!important;padding:0!important;margin:0!important;border:0!important;visibility:hidden!important;pointer-events:none!important;`
    return spacer
  }
  function releaseFloor(section) {
    const floor = Number(section.dataset.floor)
    for (const [panel, item] of lazyPanels) {
      if (Number(item.entry.index) !== floor) continue
      panelObserver.unobserve(panel)
      lazyPanels.delete(panel)
    }
    for (const frame of section.querySelectorAll('iframe')) {
      panelFrames.delete(frame)
      scriptControls.delete(frame)
      frame.remove()
    }
    floorDocuments.delete(floor)
  }
  listen(window, 'message', (event) => {
    if (
      scriptSession?.native &&
      scriptSession.frame.contentWindow === event.source &&
      event.data?.protocol === 'srl-render-compat-v1'
    ) {
      if (event.data.type === 'SRL_ARCHIVED_READER_CHROME') {
        toggleChrome()
        return
      }
      if (event.data.type === 'SRL_ARCHIVED_READER_TURN') {
        if (prefs.mode === 'scroll' && [1, -1].includes(event.data.delta))
          run(() => turn(event.data.delta))
        return
      }
      if (event.data.type === 'SRL_ARCHIVED_READER_LAYOUT') {
        const data = event.data,
          pos = data.position
        if (
          !pos ||
          !pageData?.messages.some((entry) => entry.index === pos.floor) ||
          ![pos.offset, data.top, data.height, data.viewport, data.delta].every(Number.isFinite)
        )
          return
        scriptSession.position = pos
        scriptSession.pendingPosition = null
        scriptSession.frame.dataset.scriptFloor = String(pos.floor)
        for (const size of data.floors || []) {
          const floor = shadow.querySelector(`[data-floor="${size.index}"]`)
          if (floor && Number.isFinite(size.height) && size.height > 0)
            floor.style.height = size.height + 'px'
        }
        $('#readingFlow').style.visibility = 'hidden'
        setReaderScrollTop(data.top)
        positionLabel()
        processReadingScroll(data.top, data.height, data.viewport, data.delta)
        return
      }
    }
    if (
      event.data?.protocol === 'srl-render-compat-v1' &&
      event.data.type === 'SRL_ARCHIVED_SESSION_READY' &&
      scriptSession?.frame.contentWindow === event.source
    ) {
      scriptSession.ready = true
      if (scriptSession.pending) {
        scriptSession.frame.contentWindow.postMessage(scriptSession.pending, '*')
        scriptSession.pending = null
      }
      return
    }
    if (
      event.data?.protocol === 'srl-render-compat-v1' &&
      event.data.type === 'SRL_SCRIPT_BUTTONS'
    ) {
      const frame = [...panelFrames].find(
        (item) =>
          item.isConnected &&
          item.contentWindow === event.source &&
          item.dataset.wholeFloor === 'true',
      )
      if (
        !frame ||
        Number(frame.dataset.scriptFloor) !== event.data.floor ||
        !Array.isArray(event.data.scripts)
      )
        return
      const scripts = event.data.scripts.slice(0, 64).flatMap((script) =>
        typeof script?.id === 'string' &&
        typeof script.name === 'string' &&
        Array.isArray(script.buttons)
          ? [
              {
                id: script.id,
                name: script.name,
                buttons: script.buttons
                  .slice(0, 64)
                  .filter(
                    (button) =>
                      typeof button?.name === 'string' && typeof button.visible === 'boolean',
                  ),
              },
            ]
          : [],
      )
      scriptControls.set(frame, scripts)
      updateScriptControlVisibility()
      if ($('#scriptQuickActions') && $('#sheet').open) scriptActionsPanel()
      return
    }
    if (event.data?.type !== 'SRL_PREVIEW_HEIGHT') return
    const frame = [...panelFrames.keys()].find((item) => item.contentWindow === event.source)
    if (frame?.dataset.readerWindow === 'true') return
    const height = Number(event.data.height)
    if (!frame || !Number.isFinite(height) || height <= 0) return
    if (
      frame.dataset.wholeFloor === 'true' &&
      event.data.floor !== Number(frame.dataset.scriptFloor)
    )
      return
    const nextHeight = Math.min(100000, Math.ceil(height)) + 'px'
    const follow = frame.dataset.followPage === String(page)
    delete frame.dataset.followPage
    const loading = frame.classList.contains('panel-loading')
    if (!loading && frame.style.height === nextHeight) return
    let pos = prefs.mode === 'page' ? pagePosition || currentPosition() : currentPosition()
    const projectionHeight =
      loading && frame.dataset.wholeFloor === 'true'
        ? scriptSession?.panel.closest('[data-floor]').getBoundingClientRect().height
        : 0
    const active = shadow.activeElement === frame || follow
    const viewport = $('#readingViewport').getBoundingClientRect()
    const inView = (element) => {
      const rect = element.getBoundingClientRect()
      return (
        rect.right > viewport.left + 2 &&
        rect.left < viewport.right - 2 &&
        rect.bottom > viewport.top &&
        rect.top < viewport.bottom
      )
    }
    // Several short placeholders can share a column. A later one finishing must
    // not pull the reader to its new column after earlier panels have grown.
    const anchor =
      prefs.mode === 'page'
        ? active && !loading && inView(frame)
          ? frame.parentElement
          : [...shadow.querySelectorAll('[data-chat-frontend]')].find(inView)
        : null
    const top = anchor?.getBoundingClientRect().top
    if (loading) {
      const panel = frame.dataset.wholeFloor === 'true' ? scriptSession?.panel : frame.parentElement
      // Do not detach/reinsert the iframe: that restarts its document and scripts.
      if (frame.dataset.wholeFloor === 'true') panel.dataset.scriptProjection = 'true'
      else for (const child of [...panel.childNodes]) if (child !== frame) child.remove()
      frame.classList.remove('panel-loading')
    }
    frame.style.height = nextHeight
    if (frame.dataset.wholeFloor === 'true' && scriptSession) {
      scriptSession.height = nextHeight
      scriptSession.panel.style.height = nextHeight
      if (projectionHeight) pos = mapProjectionPosition(pos, scriptSession.panel, projectionHeight)
      positionScriptSession(scriptSession.panel)
    }
    scheduleLayout({ pos, anchor, top })
  })
  function enableInteractions(position = currentPosition()) {
    if (!runtime.network) throw Error('请在扩展管理中使用兼容模式打开，再启用交互状态栏')
    sheet(
      prefs.mask ? '完整预览与打码' : '启用完整阅读',
      '<p class="hint">状态栏会直接在正文中交互，可读取当前楼层的归档快照，不会修改聊天原件。远程资源仍由独立开关控制。开启后可直接在正文操作；可随时在阅读显示中关闭。</p><p class="hint">开启打码时，正文继续打码；交互状态栏保持原文，可能显示姓名。图片内文字不保证打码。</p><button class="primary" id="enableInteractions">启用完整模式</button>',
    )
    $('#enableInteractions').onclick = () =>
      run(async () => {
        prefs.renderMode = 'full'
        await savePrefs()
        $('#sheet').close()
        await read(pageData.messages[0]?.index || 0, position)
      })
  }
  let pendingStyleId = ''
  function defaultCssPanel() {
    const draft = $('#cssInput').value
    const draftStyleId = pendingStyleId
    const variables = [
      'paper',
      'surface',
      'ink',
      'muted',
      'line',
      'accent',
      'soft',
      'font',
      'leading',
      'measure',
    ]
      .map(
        (key) =>
          `  --${key}: ${window
            .getComputedStyle(surface)
            .getPropertyValue('--' + key)
            .trim()};`,
      )
      .join('\n')
    const css = `/* 读了么默认正文样式。#chat 是正文根节点，.mes_text 是每楼正文，.speaker 是发言者。\n字体与行距也可在阅读外观中调整；状态栏作者样式不包含在这里。 */\n#chat {\n${variables}\n}\n${defaultContentStyles}`
    sheet(
      '默认正文样式',
      `<p class="hint">这是当前版本的默认样式，不含已导入的美化。导出不会改动当前外观；编辑副本会替换尚未应用的 CSS 草稿。</p><textarea class="code" id="defaultCssSource" aria-label="默认正文 CSS" readonly>${esc(css)}</textarea><div class="button-row"><button class="secondary" id="backToCss">返回</button><button class="secondary" id="exportDefaultCss">导出 CSS</button><button class="primary" id="editDefaultCss">编辑副本</button></div>`,
    )
    const back = async (source, styleId) => {
      await panel('appearance')
      $('#cssInput').value = source
      $('#cssInput').closest('details').open = true
      pendingStyleId = styleId
    }
    $('#backToCss').onclick = () => run(() => back(draft, draftStyleId))
    $('#editDefaultCss').onclick = () => run(() => back(css, ''))
    $('#exportDefaultCss').onclick = () =>
      run(() => api.files.shareText('读了么-默认正文.css', css))
  }
  let fontKey = ''
  const readerFontStyle = document.createElement('style')
  // Font faces are registered on the document; the service returns only filtered @font-face rules.
  // Reader selectors stay in the ShadowRoot, and this style is removed on disposal.
  document.head.append(readerFontStyle)
  async function syncReaderFonts() {
    const key = (prefs.styleId || '') + ':' + prefs.remote
    if (key === fontKey) return
    fontKey = key
    readerFontStyle.textContent = ''
    if (!prefs.styleId) return
    const result = await api.resources.readerStyle(prefs.styleId, {
      fonts: true,
      remote: prefs.remote && runtime.network,
    })
    if (key !== fontKey) return
    readerFontStyle.textContent = result.fonts?.css || ''
    if (result.fonts?.errors?.length) notify(result.fonts.errors[0])
    await document.fonts.ready
    if (key === fontKey && pageData) mediaLayoutChanged()
  }
  function renderPage() {
    clearPanelFrames(true)
    for (const child of [...shadow.childNodes]) if (child !== scriptSession?.frame) child.remove()
    const style = document.createElement('style')
    style.textContent =
      bodyStyles +
      '\n' +
      readingBaseCss +
      (prefs.remote
        ? prefs.css
        : prefs.css.replace(/url\(\s*([^)]*)\)/gi, (match, url) =>
            /^['"]?data:/i.test(url.trim()) ? match : 'none',
          )) +
      '\n[data-script-projection]> *{visibility:hidden!important;pointer-events:none!important}#chat .mes_block{min-width:0;max-width:100%;box-sizing:border-box}#chat.page-layout .mes_block{transform:none!important}#chat:not(.tavern-layout) .mes_text,#chat:not(.tavern-layout) .mes_text :is(p,q,em,strong,a,span){font-size:var(--font)!important;line-height:var(--leading)!important}'
    shadow.append(style)
    if (prefs.mode === 'continuous')
      shadow.append(virtualSpacer('reader-virtual-top', virtualTopHeight))
    const content = document.createElement('div')
    content.id = 'chat'
    content.className =
      'reading-flow' +
      (prefs.layout === 'tavern' && prefs.renderMode !== 'plain' ? ' tavern-layout' : '')
    shadow.append(content)
    for (const entry of pageData.messages) renderMessage(entry, content)
    if (pageData.nextOffset === null) {
      const end = document.createElement('p')
      end.className = 'reading-end'
      end.textContent = pageData.messages.length ? '已阅读完全部内容' : '当前记录没有角色回复'
      ;(content.lastElementChild?.querySelector('.mes_block') || content).append(end)
    }
    if (prefs.mode === 'continuous')
      shadow.append(virtualSpacer('reader-virtual-bottom', virtualBottomHeight))
    applyPrefs()
    page = 0
    setReaderScrollTop(0)
    calculatePages()
    positionScriptSession(scriptSession?.panel)
  }
  function currentPosition() {
    if (scriptSession?.native && scriptSession.position)
      return {
        ...(scriptSession.pendingPosition || scriptSession.position),
        mode: prefs.mode,
        hash: pageData?.contentHash,
      }
    const rect = $('#readingViewport').getBoundingClientRect()
    const extended =
      prefs.mode === 'page' &&
      [...shadow.querySelectorAll('[data-chat-frontend],img,video,svg,table')].find((el) => {
        const r = el.getBoundingClientRect()
        return (
          r.right > rect.left + 5 &&
          r.left < rect.right - 5 &&
          r.bottom > rect.top + 5 &&
          r.top < rect.bottom
        )
      })
    let element =
      (extended && extended.closest('[data-floor]')) ||
      [...shadow.querySelectorAll('[data-floor]')].find((el) =>
        [...el.getClientRects()].some(
          (r) =>
            r.right > rect.left + 5 &&
            r.left < rect.right - 5 &&
            r.bottom > rect.top + 5 &&
            r.top < rect.bottom,
        ),
      )
    if (!element)
      element =
        [...shadow.querySelectorAll('[data-floor]')]
          .filter((el) => el.getBoundingClientRect().top < rect.bottom)
          .at(-1) || shadow.querySelector('[data-floor]')
    return {
      floor: Number(element?.dataset.floor || pageData?.messages[0]?.index || 0),
      mode: prefs.mode,
      pageScroll: prefs.mode === 'page' ? $('#readingViewport').scrollTop : 0,
      pageOffset:
        prefs.mode === 'page' && element ? Math.max(0, page - pageForElement(element)) : 0,
      offset:
        prefs.mode !== 'page'
          ? Math.max(0, rect.top - (element?.getBoundingClientRect().top || rect.top))
          : 0,
      hash: pageData?.contentHash,
    }
  }
  function pageForElement(element) {
    const y = element.getBoundingClientRect().top - $('#readingFlow').getBoundingClientRect().top
    const index = pageRanges.findIndex((range) => range.end > y + 1)
    return index < 0 ? Math.max(0, pageRanges.length - 1) : index
  }
  function calculatePages(measure = true) {
    if (!pageData) return
    const vp = $('#readingViewport'),
      flow = $('#readingFlow')
    if (measure) pageRanges = []
    if (measure && prefs.mode === 'page') {
      const top = flow.getBoundingClientRect().top
      const spans = []
      const include = (rects, media = false) => {
        for (const rect of rects)
          if (rect.width && rect.height)
            spans.push({ start: rect.top - top, end: rect.bottom - top, media })
      }
      for (const body of shadow.querySelectorAll('.mes_text,.speaker,.error,.reading-end')) {
        const box = body.getBoundingClientRect()
        const text = body.textContent
        let saved = lineMeasurements.get(body)
        if (
          !saved ||
          saved.width !== box.width ||
          saved.height !== box.height ||
          saved.text !== text
        ) {
          const rects = []
          const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
          const range = document.createRange()
          while (walker.nextNode())
            if (
              walker.currentNode.textContent.trim() &&
              !walker.currentNode.parentElement.closest('[data-chat-frontend],details,table,svg')
            ) {
              range.selectNodeContents(walker.currentNode)
              for (const rect of range.getClientRects())
                if (rect.width && rect.height)
                  rects.push({ start: rect.top - box.top, end: rect.bottom - box.top })
            }
          saved = { width: box.width, height: box.height, text, rects }
          lineMeasurements.set(body, saved)
        }
        for (const rect of saved.rects)
          spans.push({
            start: rect.start + box.top - top,
            end: rect.end + box.top - top,
            media: false,
          })
      }
      for (const media of shadow.querySelectorAll(
        '[data-chat-frontend],details,img,video,svg,table',
      )) {
        if (!media.parentElement.closest('[data-chat-frontend],details,table'))
          include(media.getClientRects(), true)
      }
      // Pagination follows natural vertical layout. HTML stays outside browser columns,
      // which WebKit fragments even when break-inside:avoid is set on a tall iframe.
      spans.sort((a, b) => a.start - b.start || b.end - a.end)
      const lines = []
      for (const span of spans) {
        const last = lines.at(-1)
        if (last && span.start < last.end - 0.5) {
          last.end = Math.max(last.end, span.end)
          last.media ||= span.media
        } else lines.push({ ...span })
      }
      let start = 0,
        end = 0,
        occupied = false
      for (const line of lines) {
        const fits = line.end <= start + vp.clientHeight + 0.5
        const extendsPanel = line.media && line.start < start + vp.clientHeight
        if (occupied && !fits && !extendsPanel) {
          pageRanges.push({
            start,
            end: Math.min(line.start, Math.max(end, start + vp.clientHeight)),
          })
          start = line.start
          occupied = false
        }
        if (!occupied && line.start >= start + vp.clientHeight) start = line.start
        end = Math.max(start, line.end)
        occupied = true
      }
      if (occupied) pageRanges.push({ start, end: end + 18 })
    }
    if (!pageRanges.length) pageRanges.push({ start: 0, end: vp.clientHeight })
    pages = pageRanges.length
    page = Math.min(Math.max(0, page), pages - 1)
    flow.style.transform = prefs.mode === 'page' ? `translateY(${-pageRanges[page].start}px)` : ''
    $('#readingPage').style.height =
      prefs.mode === 'page' ? Math.ceil(pageRanges[page].end - pageRanges[page].start) + 'px' : ''
    positionLabel()
  }
  function scheduleLayout(change) {
    pendingLayout ||= change
    if (layoutFrame) return
    layoutFrame = requestAnimationFrame(flushLayout)
  }
  function flushLayout() {
    if (!pendingLayout) return
    window.cancelAnimationFrame(layoutFrame)
    layoutFrame = 0
    const { pos, anchor, top } = pendingLayout
    pendingLayout = null
    if (!pageData || $('#reader').hidden) return
    if (scriptSession?.native) {
      positionScriptSession()
      return
    }
    if (anchor?.isConnected) {
      calculatePages()
      page = pageForElement(anchor)
      calculatePages(false)
      setReaderScrollTop($('#readingViewport').scrollTop + anchor.getBoundingClientRect().top - top)
      pagePosition = currentPosition()
    } else restore(pos)
    positionScriptSession(scriptSession?.panel)
  }
  function mediaLayoutChanged() {
    if (scriptSession?.native) return
    if (pageData && !$('#reader').hidden) {
      lineMeasurements = new WeakMap()
      scheduleLayout({ pos: pagePosition || currentPosition() })
    }
  }
  function positionLabel() {
    if (!pageData) return
    $('#readerPosition').textContent =
      `第 ${currentPosition().floor + 1} / ${pageData.total} 楼${prefs.mode === 'page' ? ` · 本段 ${page + 1}/${pages} 页` : ''}`
    $('#prevPage').disabled = page === 0 && previousOffset() === null
    $('#nextPage').disabled = page === pages - 1 && pageData.nextOffset === null
  }
  function restore(pos) {
    if (scriptSession?.native && pos) {
      scriptSession.pendingPosition = pos
      scriptSession.frame.contentWindow.postMessage(
        { protocol: 'srl-render-compat-v1', type: 'SRL_ARCHIVED_READER_RESTORE', position: pos },
        '*',
      )
      positionLabel()
      syncScriptFloor()
      return
    }
    pagePosition = prefs.mode === 'page' ? pos : null
    calculatePages()
    if (!pos) return
    let el = shadow.querySelector(`[data-floor="${pos.floor}"]`)
    if (!el && prefs.hideUser) {
      const floors = [...shadow.querySelectorAll('[data-floor]')]
      el = floors.find((item) => Number(item.dataset.floor) >= pos.floor) || floors.at(-1)
      pos = { floor: Number(el?.dataset.floor || 0), offset: 0 }
      pagePosition = prefs.mode === 'page' ? pos : null
    }
    if (!el) return
    const vp = $('#readingViewport')
    if (prefs.mode === 'page') {
      page = pageForElement(el) + (pos.mode === 'page' ? pos.pageOffset || 0 : 0)
      calculatePages(false)
      setReaderScrollTop(pos.mode === 'page' ? pos.pageScroll || 0 : 0)
    } else {
      setReaderScrollTop(
        vp.scrollTop +
          el.getBoundingClientRect().top -
          vp.getBoundingClientRect().top +
          (pos.offset || 0),
      )
    }
    positionLabel()
    syncScriptFloor()
  }
  function readOptions() {
    return {
      id: chat.id,
      regex: prefs.regex,
      regexSources: state.regexSources || {},
      ruleOverrides: roleAppearance?.enabled ? {} : state.ruleOverrides || {},
      profileRuleOverrides: roleAppearance?.enabled ? roleAppearance.rules || {} : {},
      replyOverrides: state.replyOverrides || {},
      scripts: state.scripts === true && prefs.renderMode === 'full',
      scriptSources: state.scriptSources || [],
      scriptOverrides: state.scriptOverrides || {},
      readerCss:
        state.scripts === true && prefs.renderMode === 'full'
          ? readingBaseCss + '\n' + prefs.css
          : undefined,
      blendPanels: prefs.blendPanels,
      panelAppearance: prefs.panelAppearance,
      theme: prefs.theme,
      remote: prefs.renderMode !== 'plain' && prefs.remote,
      textOnly: prefs.renderMode === 'plain',
      userName: state.userName,
    }
  }
  function previousOffset() {
    if (prefs.hideUser && pageData.previousOffset !== undefined) return pageData.previousOffset
    const first = pageData.messages[0]?.index || 0
    const step =
      prefs.mode === 'scroll'
        ? 1
        : prefs.mode === 'continuous'
          ? 3
          : prefs.progressMode === 'chapters'
            ? 1
            : 3
    return first > 0 ? Math.max(0, first - step) : null
  }
  function readStart(floor) {
    if (prefs.mode === 'scroll') return floor
    if (prefs.mode === 'continuous') return Math.max(0, floor - 2)
    return prefs.progressMode === 'chapters' ? floor : Math.floor(floor / 3) * 3
  }
  function pageReadRequest(id, offset, backward = false) {
    return {
      ...readOptions(),
      id,
      offset,
      limit:
        prefs.mode === 'continuous'
          ? 5
          : prefs.mode === 'scroll'
            ? 1
            : prefs.progressMode === 'chapters'
              ? 1
              : 3,
      hideUser: prefs.hideUser,
      backward,
      interactive: false,
      prefetch: true,
    }
  }
  async function read(offset = 0, pos = null, backward = false, loadedResult = null) {
    if (disposed) return
    const version = ++readVersion
    const initialFonts = starting ? syncReaderFonts() : Promise.resolve()
    if (!starting) run(syncReaderFonts)
    const activeId = chat.id
    $('#readerSubtitle').textContent = '正在读取…'
    const [result] = await Promise.all([
      loadedResult || api.resources.readChat(pageReadRequest(activeId, offset, backward)),
      initialFonts,
    ])
    if (disposed || chat?.id !== activeId || version !== readVersion) return
    // A large preceding floor may fill the bounded SDK page before the requested floor.
    if (pos && offset < pos.floor && result.nextOffset !== null && result.nextOffset <= pos.floor)
      return read(pos.floor, pos)
    pageData = result
    if (prefs.mode === 'continuous') {
      virtualTopHeight = 0
      virtualBottomHeight = 0
    }
    renderPage()
    if (pos?.hash && pos.hash !== result.contentHash) {
      notify('聊天原件已变化，请重新确认阅读位置')
      pos = null
    }
    if (starting) restore(pos)
    else
      await new Promise((resolve) =>
        window.requestAnimationFrame(() => {
          if (chat?.id === activeId && version === readVersion) restore(pos)
          resolve()
        }),
      )
    if (disposed || chat?.id !== activeId || version !== readVersion) return
    $('#readerSubtitle').textContent =
      prefs.mask && prefs.renderMode === 'full'
        ? '完整阅读 · 正文打码，状态栏未打码'
        : boundRole(chat).name +
          ' · ' +
          (prefs.mask
            ? '已开启文字打码'
            : prefs.renderMode === 'full'
              ? '完整阅读'
              : prefs.renderMode === 'plain'
                ? '纯净阅读'
                : '精简阅读')
    warnHiddenFloor()
  }
  async function openChat(id) {
    const c = chats.find((c) => c.id === id)
    if (!c) return
    if (!boundRole(c)) {
      await bindPanel(c)
      return
    }
    chat = c
    role = boundRole(c).id
    // Record the interrupted-reading session before resource reads finish. A host reload
    // while a large chat or its regexes are still loading must still resume this chat.
    indexState.lastChat = id
    indexState.resumeReading = true
    await store('reader-index-v1', indexState)
    state = await getState(id)
    roleAppearance = (await api.storage.get('appearance:' + role)) || null
    resolveAppearance()
    if (starting && prefs.renderMode !== 'plain')
      await loadAvatar(role).catch((error) => notify(error.message, true))
    background = ''
    $('#reader').style.backgroundImage = ''
    $('#reader').style.setProperty('--veil', 0)
    pageData = null
    shadow.innerHTML = '<p>正在读取聊天记录…</p>'
    $('#library').hidden = true
    $('#reader').hidden = false
    await syncNavigation()
    surface.style.overflow = 'hidden'
    $('#readerTitle').textContent = state.title || chat.name
    toggleChrome(false)
    clearTimeout(toastTimer)
    $('#toast').hidden = true
    try {
      const floor = state.position?.floor || 0
      await read(readStart(floor), state.position)
      indexState.lastChat = id
      indexState.resumeReading = true
      await store('reader-index-v1', indexState)
    } catch (e) {
      shadow.innerHTML = ''
      toggleChrome(true)
      // A failed restore is still an interrupted reading session. Only an explicit
      // return to the list clears resumeReading; keep the saved floor for recreation.
      throw e
    }
  }
  async function recordPosition() {
    if (!chat || !pageData || $('#reader').hidden) return
    state.position = currentPosition()
    pagePosition = prefs.mode === 'page' ? state.position : null
    await saveState()
  }
  async function leaveReader() {
    readVersion++
    clearTimeout(saveTimer)
    await recordPosition()
    indexState.resumeReading = false
    await store('reader-index-v1', indexState)
    clearPanelFrames()
    $('#reader').hidden = true
    $('#library').hidden = false
    surface.style.overflow = ''
    $('#sheet').close()
    roleAppearance = null
    resolveAppearance()
    await renderLibrary()
  }
  function toggleChrome(value = !chrome) {
    chrome = value
    $('#reader').classList.toggle('reader-show', chrome)
    $('#reader').classList.toggle('reader-hide', !chrome)
    measureChrome()
  }
  function measureChrome() {
    $('#reader').style.setProperty('--reader-header-height', $('#readerHeader').offsetHeight + 'px')
    $('#reader').style.setProperty(
      '--reader-toolbar-height',
      $('.reader-bottom').offsetHeight + 'px',
    )
  }
  async function syncNavigation() {
    if (!runtime.builtinReader) return
    // During restoration only the target reader layout is needed; publish the list once ready.
    if (starting && $('#reader').hidden) return
    await api.ui.setReaderNavigation({
      page: !$('#reader').hidden ? 'reader' : role ? 'chats' : 'roles',
      cover: prefs.characterCover === true,
      colors: Object.fromEntries(
        ['paper', 'ink', 'muted', 'line', 'accent', 'soft'].map((key) => [
          key,
          surface.style.getPropertyValue('--' + key).trim(),
        ]),
      ),
    })
  }
  async function navigateBack() {
    if ($('#sheet').open) {
      closeSheet()
    } else if (!$('#reader').hidden) {
      await leaveReader()
    } else if (role) {
      role = null
      listLimit = 30
      $('#librarySearch').value = ''
      await renderLibrary()
    } else {
      await api.ui.exitFullscreen()
    }
  }
  async function turn(delta) {
    if (prefs.mode === 'continuous') return
    if (prefs.mode === 'scroll') {
      if (delta > 0 && pageData.nextOffset !== null) {
        await read(pageData.nextOffset)
      } else if (delta < 0 && previousOffset() !== null) {
        await read(previousOffset(), null, true)
      }
      await recordPosition()
      warnHiddenFloor()
      return
    }
    flushLayout()
    setReaderScrollTop(0)
    if (delta > 0 && page === pages - 1 && pageData.nextOffset !== null) {
      await read(pageData.nextOffset)
    } else if (delta < 0 && page === 0 && previousOffset() !== null) {
      await read(previousOffset(), null, true)
      page = pages - 1
      calculatePages(false)
    } else {
      page = Math.min(pages - 1, Math.max(0, page + delta))
      calculatePages(false)
    }
    await recordPosition()
    warnHiddenFloor()
  }
  async function extendContinuous(direction) {
    if (prefs.mode !== 'continuous' || continuousLoading || !pageData) return
    const oldPage = pageData
    const offset = direction === 'next' ? oldPage.nextOffset : previousOffset()
    if (offset === null || offset === undefined) return
    continuousLoading = true
    const activeId = chat.id
    const viewport = $('#readingViewport')
    try {
      const result = await api.resources.readChat({
        ...readOptions(),
        id: activeId,
        offset,
        limit: 3,
        hideUser: prefs.hideUser,
        backward: direction === 'previous',
        interactive: false,
        prefetch: true,
      })
      if (
        chat?.id !== activeId ||
        pageData !== oldPage ||
        result.contentHash !== oldPage.contentHash
      )
        return
      const content = shadow.querySelector('#chat')
      if (!content) return
      content.querySelector('.reading-end')?.remove()
      const current = [...content.querySelectorAll('[data-floor]')]
      const currentFloors = new Set(current.map((item) => Number(item.dataset.floor)))
      const incoming = result.messages.filter((entry) => !currentFloors.has(entry.index))
      const fragment = document.createDocumentFragment()
      for (const entry of incoming) renderMessage(entry, fragment)
      const addedSections = [...fragment.children]
      if (direction === 'next') content.append(fragment)
      else content.insertBefore(fragment, current[0] || null)
      const addedHeight = addedSections.reduce(
        (total, section) => total + section.getBoundingClientRect().height,
        0,
      )

      const merged = [...oldPage.messages, ...incoming].sort((a, b) => a.index - b.index)
      let kept
      if (direction === 'next') {
        virtualBottomHeight = Math.max(0, virtualBottomHeight - addedHeight)
        kept = merged.slice(-5)
      } else {
        const previousTopHeight = virtualTopHeight
        virtualTopHeight = Math.max(0, virtualTopHeight - addedHeight)
        if (addedHeight > previousTopHeight)
          setReaderScrollTop(viewport.scrollTop + addedHeight - previousTopHeight)
        kept = merged.slice(0, 5)
      }
      const keepFloors = new Set(kept.map((entry) => entry.index))
      for (const section of [...content.querySelectorAll('[data-floor]')]) {
        if (keepFloors.has(Number(section.dataset.floor))) continue
        const height = section.getBoundingClientRect().height
        if (direction === 'next') virtualTopHeight += height
        else virtualBottomHeight += height
        releaseFloor(section)
        section.remove()
      }
      pageData = {
        ...oldPage,
        ...result,
        messages: kept,
        previousOffset: direction === 'previous' ? result.previousOffset : oldPage.previousOffset,
        nextOffset: direction === 'next' ? result.nextOffset : oldPage.nextOffset,
      }
      // Evicted floors remain reachable when the reader reverses direction.
      const removedBefore = merged.filter((entry) => entry.index < kept[0]?.index)
      const removedAfter = merged.filter((entry) => entry.index > kept.at(-1)?.index)
      if (removedBefore.length) pageData.previousOffset = removedBefore.at(-1).index
      if (removedAfter.length) pageData.nextOffset = removedAfter[0].index
      shadow
        .querySelector('#reader-virtual-top')
        ?.style.setProperty('height', `${virtualTopHeight}px`, 'important')
      shadow
        .querySelector('#reader-virtual-bottom')
        ?.style.setProperty('height', `${virtualBottomHeight}px`, 'important')
      if (pageData.nextOffset === null) {
        const end = document.createElement('p')
        end.className = 'reading-end'
        end.textContent = pageData.messages.length ? '已阅读完全部内容' : '当前记录没有角色回复'
        ;(content.lastElementChild?.querySelector('.mes_block') || content).append(end)
      }
      positionLabel()
      syncScriptFloor()
    } finally {
      continuousLoading = false
    }
  }
  async function jump(floor) {
    if (!Number.isInteger(floor) || floor < 0 || floor >= pageData.total)
      throw Error('楼层超出范围')
    prior = currentPosition()
    $('#sheet').close()
    const pos = { floor, offset: 0 }
    if (pageData.messages.some((e) => e.index === floor)) {
      restore(pos)
    } else await read(readStart(floor), pos)
    await recordPosition()
    warnHiddenFloor()
  }
  async function markFloor(floor, quote = '') {
    const entry = pageData.messages.find((e) => e.index === floor)
    if (!entry) return
    const item = {
      floor,
      replyId:
        Array.isArray(entry.message.swipes) && entry.message.swipes.length
          ? Number(entry.message.swipe_id) || 0
          : null,
      quote: masked(quote || entry.message.mes).slice(0, 240),
      hash: pageData.contentHash,
    }
    if (
      state.marks.some(
        (m) => m.floor === floor && m.replyId === item.replyId && m.quote === item.quote,
      )
    ) {
      notify('已经收藏过这里')
      return
    }
    const next = [...state.marks, item]
    if (next.length > 100) throw Error('单份聊天最多保留 100 条收藏，请先整理')
    const updated = { ...state, marks: next }
    await store('chat:' + chat.id, updated)
    Object.assign(state, updated)
    notify('已收藏第 ' + (floor + 1) + ' 楼')
  }
  async function variableReviewPanel(floor) {
    sheet(
      '变量变化回顾',
      '<div id="variableResults"><p class="hint">正在读取已保存的快照…</p></div>',
    )
    const target = $('#variableResults'),
      id = chat.id
    if (!api.resources.chatVariables) throw Error('请更新配套资源库后使用变量变化回顾')
    const result = await api.resources.chatVariables({
      id,
      floor,
      replyOverrides: state.replyOverrides || {},
    })
    if (!target.isConnected || !$('#sheet').open || chat?.id !== id) return
    if (result.contentHash !== pageData.contentHash) throw Error('聊天原件已变化，请重新打开阅读')
    const message =
      result.status === 'missing'
        ? '本楼当前回复没有保存变量快照，无法判断变化。'
        : result.status === 'initial'
          ? '这是此前首次保存的变量快照，没有更早的快照可供比较。'
          : result.status === 'incompatible'
            ? '前后快照类型不同，无法直接比较。'
            : result.truncated
              ? '快照较大，以下仅展示部分比较结果。'
              : result.changes.length
                ? '以下是已保存快照之间的差异。'
                : '两份已保存快照的变量没有变化。'
    target.innerHTML = `<p class="field-label">第 ${floor + 1} 楼 · 回复 ${result.replyId + 1}</p><p class="hint">${message}</p>${result.baseline && result.status !== 'missing' ? `<p class="hint">对比第 ${result.baseline.floor + 1} 楼 · 回复 ${result.baseline.replyId + 1}${result.missingFloors ? `；中间 ${result.missingFloors} 楼未保存快照，变化不能全部归因于本楼` : ''}。</p>` : ''}<div class="button-row"><button class="primary" data-variable-jump="${floor}">回到本楼原文</button>${result.baseline ? `<button class="secondary" data-variable-jump="${result.baseline.floor}">查看对比楼层</button>` : ''}</div><div class="button-row"><button class="secondary" data-variable-floor="${floor - 1}" ${floor === 0 ? 'disabled' : ''}>上一楼</button><button class="secondary" data-variable-floor="${floor + 1}" ${floor + 1 >= result.total ? 'disabled' : ''}>下一楼</button></div><div class="variable-changes">${result.changes.map((change) => `<article class="variable-change"><div class="variable-change-heading"><strong>${esc(masked(change.path))}</strong><span>${{ added: '新增', removed: '移除', changed: '修改' }[change.type]}${typeof change.delta === 'number' ? ` ${change.delta > 0 ? '+' : ''}${change.delta}` : ''}</span></div><div class="variable-value"><small>之前</small><span>${esc(masked(change.before))}</span></div><div class="variable-value"><small>现在</small><span>${esc(masked(change.after))}</span></div></article>`).join('')}</div>`
    $$('[data-variable-floor]').forEach(
      (button) =>
        (button.onclick = () =>
          run(() => variableReviewPanel(Number(button.dataset.variableFloor)))),
    )
    $$('[data-variable-jump]').forEach(
      (button) =>
        (button.onclick = () =>
          run(async () => {
            $('#sheet').close()
            await jump(Number(button.dataset.variableJump))
          })),
    )
  }
  function floorPanel(floor, quote = '') {
    const entry = pageData.messages.find((e) => e.index === floor)
    if (!entry) return
    sheet(
      `第 ${floor + 1} 楼`,
      `<div class="selected-text">${esc(masked(quote || entry.message.mes).slice(0, 800))}</div><div class="button-row"><button class="primary" id="markFloor">${quote ? '收藏选中文字' : '收藏整楼'}</button><button class="secondary" id="variableReview">变量变化回顾</button><button class="secondary" id="fullPreview">${prefs.renderMode === 'full' ? '切回精简阅读' : '原位完整阅读'}</button>${Array.isArray(entry.message.swipes) && entry.message.swipes.length > 1 ? '<button class="secondary" id="floorSwipes">切换回复（' + entry.message.swipes.length + '）</button>' : ''}</div>`,
    )
    $('#markFloor').onclick = () =>
      run(async () => {
        await markFloor(floor, quote)
        $('#sheet').close()
      })
    $('#variableReview').onclick = () => run(() => variableReviewPanel(floor))
    $('#fullPreview').onclick = () =>
      run(() =>
        setReadingMode(prefs.renderMode === 'full' ? 'simple' : 'full', { floor, offset: 0 }),
      )
    if ($('#floorSwipes')) $('#floorSwipes').onclick = () => swipePanel(entry)
  }
  function swipePanel(entry) {
    sheet(
      `第 ${entry.index + 1} 楼 · 切换回复`,
      `<button class="secondary" id="compareReplies">比较两条回复</button><p class="hint">在正文中阅读所选回复及其已保存变量，只改变读了么的阅读选择。</p>${entry.message.swipes.map((s, i) => `<button class="result" data-reply="${i}" data-reply-floor="${entry.index}"><small>回复 ${i + 1}${i === Number(entry.message.swipe_id || 0) ? ' · 正在阅读' : ''}${i === entry.archivedSwipeId ? ' · 归档选中' : ''}</small><span>${esc(masked(s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).slice(0, 100))}</span></button>`).join('')}`,
    )
    $('#compareReplies').onclick = () => comparePanel(entry)
  }
  function comparePanel(entry) {
    const options = entry.message.swipes
      .map((_, i) => `<option value="${i}">回复 ${i + 1}</option>`)
      .join('')
    sheet(
      '回复差异',
      `<div class="reply-compare-pickers"><label>原回复<select id="compareFrom">${options}</select></label><label>对比回复<select id="compareTo">${options}</select></label></div><button class="primary" id="runCompare">查看差异</button><p class="hint">按当前正则比较正文，＋为新增，−为删除；不运行状态栏。超长正文比较前 30000 字。</p><div id="replyDiff"></div>`,
    )
    $('#compareFrom').value = String(Number(entry.message.swipe_id) || 0)
    $('#compareTo').value = String(
      (Number(entry.message.swipe_id || 0) + 1) % entry.message.swipes.length,
    )
    $('#runCompare').onclick = () =>
      run(async () => {
        const target = $('#replyDiff')
        target.textContent = '正在比较…'
        const result = await api.resources.readChat({
          ...readOptions(),
          offset: entry.index,
          limit: 1,
          interactive: false,
          compareReplies: [Number($('#compareFrom').value), Number($('#compareTo').value)],
        })
        if (!target.isConnected) return
        const diff = result.replyDiff
        if (!diff) throw Error('请更新配套资源库后使用回复比较')
        target.innerHTML =
          diff.lines
            .map(
              (line) =>
                `<div class="reply-diff ${line.type}"><b>${line.type === 'added' ? '＋' : line.type === 'removed' ? '−' : '·'}</b><span>${esc(masked(line.text))}</span></div>`,
            )
            .join('') || '<p class="hint">这两条回复没有可比较的正文。</p>'
        if (diff.errors.length) notify('部分正则未执行：' + diff.errors.join('；'), true)
      })
  }
  async function setReadingMode(mode, pos = currentPosition()) {
    if (!['plain', 'simple', 'full'].includes(mode)) return
    if (mode === 'full') return enableInteractions(pos)
    prefs.renderMode = mode
    await savePrefs()
    $('#sheet').close()
    await read(pageData.messages[0]?.index || 0, pos)
  }
  function progressTabs() {
    return `<div class="segmented"><button data-progress-mode="jump" class="${prefs.progressMode === 'jump' ? 'active' : ''}">楼层跳转</button><button data-progress-mode="chapters" class="${prefs.progressMode === 'chapters' ? 'active' : ''}">章节目录</button></div>`
  }
  async function chapterPanel(offset = 0) {
    sheet('章节目录', progressTabs() + '<p class="hint">正在读取目录…</p>')
    const id = chat.id
    const result = await api.resources.chatChapters({ id, offset })
    if (!$('#sheet').open || chat?.id !== id || prefs.progressMode !== 'chapters') return
    sheet(
      '章节目录',
      progressTabs() +
        `<div class="results">${result.items.map((item) => `<button class="result" data-jump="${item.floor}"><small>第 ${item.floor + 1} 章 · ${esc(masked(item.name))}${item.replies > 1 ? ' · ' + item.replies + ' 个回复' : ''}</small><span>${esc(masked(item.text))}</span></button>`).join('')}</div><div class="button-row"><button class="secondary" data-chapter-page="${Math.max(0, offset - 50)}" ${offset === 0 ? 'disabled' : ''}>上一页</button><span class="muted">${Math.floor(offset / 50) + 1} / ${Math.max(1, Math.ceil(result.total / 50))}</span><button class="secondary" data-chapter-page="${result.nextOffset || 0}" ${result.nextOffset === null ? 'disabled' : ''}>下一页</button></div>`,
    )
  }
  async function libraryStylePanel(offset = 0) {
    sheet('选择资源库美化', '<p class="hint">正在读取…</p>')
    const result = await api.resources.list({ types: ['beautification'], offset, limit: 25 })
    if (!$('#sheet').open) return
    sheet(
      '选择资源库美化',
      `<div class="results">${result.items.map((item) => `<button class="result" data-library-style="${esc(item.id)}"><span>${esc(item.name)}</span><small>${esc(item.description || '')}</small></button>`).join('') || '<p class="hint">资源库中还没有美化，可先导入 CSS 或酒馆主题 JSON。</p>'}</div><div class="button-row"><button class="secondary" data-style-page="${Math.max(0, offset - 25)}" ${offset === 0 ? 'disabled' : ''}>上一页</button><button class="secondary" data-style-page="${result.nextOffset || 0}" ${result.nextOffset === null ? 'disabled' : ''}>下一页</button></div>`,
    )
  }

  const warnedHiddenRules = new Set()
  function warnHiddenFloor() {
    if ($('#sheet').open) return
    const entry = pageData?.messages.find((item) => item.index === currentPosition().floor)
    const causes = entry?.hiddenByRules || []
    if (!causes.length) return
    const key = chat.id + ':' + causes.map((cause) => cause.key).join(',')
    if (warnedHiddenRules.has(key)) return
    warnedHiddenRules.add(key)
    hiddenRulePanel(entry.index)
  }
  function hiddenRulePanel(floor) {
    const entry = pageData.messages.find((item) => item.index === floor)
    const rules = (pageData.regexRules || []).filter(
      (rule) => rule.enabled && entry?.hiddenByRules?.some((cause) => cause.key === rule.key),
    )
    if (!rules.length) return regexPanel()
    sheet(
      '这一楼被正则隐藏了',
      `<p class="hint">第 ${floor + 1} 楼执行以下规则后，内容变为空白。是否在读了么关闭它？聊天原件和酒馆开关不会改变。</p>${rules.map((rule) => `<div class="setting-row"><label for="hidden-${esc(rule.key)}">${esc(rule.name)}</label><input id="hidden-${esc(rule.key)}" type="checkbox" data-disable-rule="${esc(rule.key)}" checked></div>`).join('')}<div class="button-row"><button class="secondary" id="keepHidden">保持隐藏</button><button class="primary" id="disableHidden">关闭所选正则</button></div>`,
    )
    $('#keepHidden').onclick = () => $('#sheet').close()
    $('#disableHidden').onclick = () =>
      run(async () => {
        const overrides = Object.fromEntries(
          (pageData.regexRules || []).map((rule) => [rule.key, rule.enabled]),
        )
        for (const input of $$('[data-disable-rule]:checked'))
          overrides[input.dataset.disableRule] = false
        await applyRuleOverrides(overrides)
      })
  }
  async function applyRuleOverrides(overrides) {
    const rules = pageData?.regexRules || []
    const pos = currentPosition()
    if (roleAppearance?.enabled) {
      const saved = { ...roleAppearance.rules }
      for (const rule of rules)
        if (rule.signature) {
          if (typeof overrides[rule.key] === 'boolean') saved[rule.signature] = overrides[rule.key]
          else delete saved[rule.signature]
        }
      roleAppearance.rules = saved
      await store('appearance:' + role, roleAppearance)
    } else {
      state.ruleOverrides = overrides
      await saveState()
    }
    $('#sheet').close()
    await read(pageData.messages[0]?.index || 0, pos)
    notify(roleAppearance?.enabled ? '角色专属正则方案已更新' : '此聊天的显示正则已更新')
  }
  function ruleGroup(name, count, body) {
    return `<details class="reader-rule-group"><summary><span>${esc(name)}</span><small>${count} 项</small>${icon('next')}</summary><div class="reader-rule-group-body">${body}</div></details>`
  }
  function regexPanel() {
    const rules = pageData?.regexRules || []
    sheet(
      '显示正则',
      `<p class="hint">按全局 → 预设 → 角色卡顺序执行。默认沿用导出时的开关；${roleAppearance?.enabled ? '更改保存到角色专属方案，仅复用于内容一致的规则。' : '更改只影响这份聊天。'}只列出显示正则，不重跑写入正文或仅发送给模型的规则。</p>${pageData?.presetName ? `<p class="hint">导出时所选预设：${esc(pageData.presetName)}（不代表聊天当时的预设）</p>` : ''}${[
        'global',
        'preset',
        'character',
      ]
        .map((scope) =>
          ruleGroup(
            { global: '全局', preset: '预设', character: '角色卡' }[scope],
            rules.filter((r) => r.scope === scope).length,
            `<p class="hint">来源：${esc(pageData?.regexSources?.[scope]?.name || '聊天随附')}（只替换本组显示规则，不修改原件或角色绑定）</p><div class="button-row"><button class="secondary" data-regex-source="${scope}">从资源库替换</button>${state.regexSources?.[scope] ? `<button class="secondary" data-regex-restore="${scope}">恢复随附来源</button>` : ''}</div>${
              rules
                .filter((r) => r.scope === scope)
                .map(
                  (r) =>
                    `<div class="setting-row"><label for="rule-${esc(r.key)}">${esc(r.name)}</label><input id="rule-${esc(r.key)}" type="checkbox" data-rule="${esc(r.key)}" ${r.enabled ? 'checked' : ''}></div>`,
                )
                .join('') || '<p class="hint">未随附显示规则</p>'
            }`,
          ),
        )
        .join(
          '',
        )}<div class="button-row"><button class="secondary" id="resetRules">恢复导出时开关</button><button class="primary" id="applyRules">应用</button></div>`,
      () => panel('display'),
    )
    $('#applyRules').onclick = () =>
      run(() =>
        applyRuleOverrides(
          Object.fromEntries($$('[data-rule]').map((el) => [el.dataset.rule, el.checked])),
        ),
      )
    $('#resetRules').onclick = () => run(() => applyRuleOverrides({}))
  }
  async function regexSourcePanel(scope, offset = 0) {
    const label = { global: '全局', preset: '预设', character: '角色卡' }[scope]
    if (!label) return
    sheet('替换' + label + '正则', '<p class="hint">正在读取资源列表…</p>', regexPanel)
    const root = $('#sheetBody').firstElementChild
    const types =
      scope === 'global' ? ['regex'] : [scope === 'preset' ? 'preset' : 'characterCard', 'regex']
    const result = await api.resources.list({ types, offset, limit: 25 })
    if (!root?.isConnected || !$('#sheet').open) return
    sheet(
      '替换' + label + '正则',
      `<p class="hint">选取聊天当时使用的${label}或单独保存的正则。仅替换本组，保留所选规则的启停状态。</p><div class="results">${result.items.map((item) => `<button class="result" data-regex-pick="${esc(item.id)}" data-scope="${scope}"><span>${esc(item.name)}</span><small>${esc(item.description)}</small></button>`).join('') || '<p class="hint">暂无可选资源</p>'}</div><div class="button-row"><button class="secondary" data-regex-page="${Math.max(0, offset - 25)}" data-scope="${scope}" ${offset === 0 ? 'disabled' : ''}>上一页</button><button class="secondary" data-regex-page="${result.nextOffset || 0}" data-scope="${scope}" ${result.nextOffset === null ? 'disabled' : ''}>下一页</button><button class="secondary" id="backToRegex">返回正则设置</button></div>`,
      regexPanel,
    )
    $('#backToRegex').onclick = regexPanel
  }
  async function loadScriptSettings(container, loadedResult) {
    const activeId = chat?.id
    let result
    try {
      result =
        loadedResult ||
        (await api.resources.readChat({
          ...readOptions(),
          scripts: false,
          scriptList: true,
          scriptListOnly: true,
          offset: pageData?.messages[0]?.index || 0,
          limit: 1,
        }))
    } catch (error) {
      if (container.isConnected && chat?.id === activeId)
        container.querySelector('.script-settings-content').innerHTML =
          `<p class="error">${esc(error.message)}</p>${(state.scriptSources || []).map((id) => `<button class="secondary" data-script-remove="${esc(id)}">移除来源 ${esc(id)}</button>`).join('')}<button class="secondary" id="pickScripts">从资源库选择</button>`
      if ($('#pickScripts')) $('#pickScripts').onclick = () => run(() => scriptSourcePanel())
      return
    }
    if (!container.isConnected || chat?.id !== activeId || !$('#sheet').open) return
    const sources = [
      ...new Set(
        result.scriptRules.map((rule) => rule.sourceId).filter((id) => id !== 'character'),
      ),
    ]
    container.querySelector('.script-settings-content').innerHTML =
      `<p class="hint">只影响这份聊天，默认关闭。先选择完整模式，再启用所需脚本。脚本读取当前楼层、当前回复的已保存变量；不能补出缺失的历史状态。远程依赖仍由独立开关控制。</p>${(result.scriptErrors || []).map((error) => `<p class="error">${esc(error)}</p>`).join('')}<div class="setting-row"><label for="scriptsEnabled">运行所选脚本</label><input id="scriptsEnabled" type="checkbox" ${state.scripts ? 'checked' : ''}></div>${[
        'character',
        ...sources,
      ]
        .map((id) => {
          const rules = result.scriptRules.filter((rule) => rule.sourceId === id)
          return ruleGroup(
            id === 'character' ? '角色卡' : rules[0]?.sourceName || '资源库脚本',
            rules.length,
            `${rules.map((rule) => `<div class="setting-row"><label for="script-${esc(rule.key)}">${esc(rule.folder ? rule.folder + ' / ' + rule.name : rule.name)}</label><input id="script-${esc(rule.key)}" type="checkbox" data-script="${esc(rule.key)}" ${rule.enabled ? 'checked' : ''}></div>`).join('') || '<p class="hint">未附带可选脚本</p>'}${(state.scriptSources || []).includes(id) ? `<button class="text-button" data-script-remove="${esc(id)}">移除此来源</button>` : ''}`,
          )
        })
        .join(
          '',
        )}<button class="secondary" id="pickScripts">从资源库选择</button><div class="button-row"><button class="secondary" id="disableScripts">关闭全部</button><button class="primary" id="applyScripts">应用脚本</button></div>`
    $('#pickScripts').onclick = () => run(() => scriptSourcePanel())
    const applyButton = $('#applyScripts')
    const updateScriptAction = () => {
      applyButton.textContent = $('#scriptsEnabled').checked ? '启用并应用' : '保存选择（不运行）'
    }
    $('#scriptsEnabled').onchange = updateScriptAction
    updateScriptAction()
    $('#applyScripts').onclick = () =>
      run(async () => {
        const enabled = $('#scriptsEnabled').checked
        if (enabled && (prefs.renderMode !== 'full' || !runtime.network))
          throw Error('请先使用兼容模式打开，并选择完整阅读模式')
        const overrides = Object.fromEntries(
          $$('[data-script]').map((el) => [el.dataset.script, el.checked]),
        )
        if (enabled && !Object.values(overrides).some(Boolean)) throw Error('请至少选择一个脚本')
        const selectedKeys = (rules) =>
          Object.keys(rules || {})
            .filter((key) => rules[key])
            .sort()
            .join('\n')
        const reload =
          (state.scripts === true) !== enabled ||
          (enabled && selectedKeys(state.scriptOverrides) !== selectedKeys(overrides))
        const pos = currentPosition()
        applyButton.disabled = true
        $('#disableScripts').disabled = true
        try {
          state.scripts = enabled
          state.scriptOverrides = overrides
          await saveState()
          if (reload) await read(pageData.messages[0]?.index || 0, pos)
          notify(
            enabled
              ? reload
                ? '已开启所选脚本运行'
                : '脚本设置未变化，无需重新加载'
              : '选择已保存，脚本未运行；打开“运行所选脚本”后应用',
          )
        } finally {
          if (applyButton.isConnected) {
            applyButton.disabled = false
            $('#disableScripts').disabled = false
          }
        }
      })
    $('#disableScripts').onclick = () =>
      run(async () => {
        const wasRunning = state.scripts === true && prefs.renderMode === 'full'
        const pos = currentPosition()
        state.scripts = false
        state.scriptOverrides = {}
        await saveState()
        if (wasRunning) await read(pageData.messages[0]?.index || 0, pos)
        await loadScriptSettings(container, {
          ...result,
          scriptRules: result.scriptRules.map((rule) => ({ ...rule, enabled: false })),
        })
      })
  }
  async function scriptSourcePanel(offset = 0) {
    const activeId = chat?.id
    sheet('选择阅读脚本', '<p class="hint">正在读取资源列表…</p>', showScriptSettings)
    const root = $('#sheetBody').firstElementChild
    const result = await api.resources.list({ types: ['script'], offset, limit: 25 })
    if (!root?.isConnected || chat?.id !== activeId || !$('#sheet').open) return
    sheet(
      '选择阅读脚本',
      `<p class="hint">选择已导入的 JavaScript 或 TavernHelper 脚本，例如小手机脚本。APK、网页链接与 STscript 不用于这里。添加来源后仍需勾选并应用。</p><div class="results">${result.items.map((item) => `<button class="result" data-script-pick="${esc(item.id)}" ${(state.scriptSources || []).includes(item.id) ? 'disabled' : ''}><span>${esc(item.name)}</span><small>${esc(item.description)}</small></button>`).join('') || '<p class="hint">暂无脚本，请先导入资源库</p>'}</div><div class="button-row"><button class="secondary" data-script-page="${Math.max(0, offset - 25)}" ${offset === 0 ? 'disabled' : ''}>上一页</button><button class="secondary" data-script-page="${result.nextOffset || 0}" ${result.nextOffset === null ? 'disabled' : ''}>下一页</button><button class="secondary" id="backToScripts">返回脚本设置</button></div>`,
      showScriptSettings,
    )
    $('#backToScripts').onclick = () => run(showScriptSettings)
  }
  async function showScriptSettings(loadedResult) {
    sheet(
      '脚本管理',
      '<div id="scriptSettings"><div class="script-settings-content"><p class="hint">正在读取脚本…</p></div></div>',
      () => panel('display'),
    )
    await loadScriptSettings($('#scriptSettings'), loadedResult)
  }
  async function changeScriptSource(id, remove = false) {
    const activeId = chat.id
    const wasRunning = state.scripts === true && prefs.renderMode === 'full'
    const sources = remove
      ? (state.scriptSources || []).filter((item) => item !== id)
      : [...new Set([...(state.scriptSources || []), id])]
    let result
    try {
      result = await api.resources.readChat({
        ...readOptions(),
        scripts: false,
        scriptList: true,
        scriptSources: sources,
        scriptListOnly: true,
        offset: pageData.messages[0]?.index || 0,
        limit: 1,
      })
    } catch (error) {
      if (!remove) throw error
      // Removing a broken reference must remain possible even when another source is missing.
    }
    if (chat?.id !== activeId || !$('#sheet').open) return
    const pos = currentPosition()
    state.scriptSources = sources
    if (result)
      state.scriptOverrides = Object.fromEntries(
        result.scriptRules.map((rule) => [rule.key, rule.enabled]),
      )
    else state.scripts = false
    await saveState()
    if (wasRunning) await read(pageData.messages[0]?.index || 0, pos)
    await showScriptSettings(result)
  }
  async function replaceRegexSource(scope, id) {
    const activeChatId = chat.id
    const next = { ...state.regexSources }
    if (id) next[scope] = id
    else delete next[scope]
    const overrides = Object.fromEntries(
      Object.entries(state.ruleOverrides || {}).filter(([key]) => !key.startsWith(scope + ':')),
    )
    const offset = pageData?.messages[0]?.index || 0
    // Validate before saving: a missing/wrong resource must not strand this chat.
    const result = await api.resources.readChat({
      ...pageReadRequest(activeChatId, offset),
      regexSources: next,
      ruleOverrides: roleAppearance?.enabled ? {} : overrides,
    })
    if (chat?.id !== activeChatId || !$('#sheet').open) return
    state.regexSources = next
    state.ruleOverrides = overrides
    await saveState()
    const pos = currentPosition()
    await read(offset, pos, false, result)
    regexPanel()
    notify(id ? '正则来源已替换，仅对这份聊天生效' : '已恢复聊天随附正则')
  }
  async function panel(name) {
    if (!pageData && name !== 'display' && name !== 'appearance') return
    if (name === 'progress') {
      if (prefs.progressMode === 'chapters')
        return chapterPanel(Math.floor(currentPosition().floor / 50) * 50)
      sheet(
        '阅读进度',
        `${progressTabs()}<label class="field-label">共 ${pageData.total} 楼</label><input id="floorNumber" class="searchbox" type="number" min="1" max="${pageData.total}" value="${currentPosition().floor + 1}" aria-label="跳转楼层"><div class="button-row"><button class="secondary" id="top">回到开头</button><button class="primary" id="jump">跳转</button><button class="secondary" id="bottom">回到末楼</button></div>${prior ? '<button class="text-button" id="prior">返回刚才的位置</button>' : ''}`,
      )
      $('#jump').onclick = () => run(() => jump(Number($('#floorNumber').value) - 1))
      $('#top').onclick = () => run(() => jump(0))
      $('#bottom').onclick = () => run(() => jump(pageData.total - 1))
      if ($('#prior'))
        $('#prior').onclick = () =>
          run(async () => {
            const p = prior
            await jump(p.floor)
            restore(p)
          })
    } else if (name === 'bookmarks') {
      sheet(
        '收藏与摘录',
        `<button class="secondary" id="markCurrent">收藏当前楼层</button><div class="results">${state.marks.map((m, i) => `<div class="floor-picker"><button data-mark-jump="${i}"><span class="muted">第 ${m.floor + 1} 楼${Number.isInteger(m.replyId) ? ` · 回复 ${m.replyId + 1}` : m.replyId === null ? '' : ' · 旧收藏'}${m.hash !== pageData.contentHash ? ' · 原文已变化' : ''}</span><br>${esc(masked(m.quote))}</button><button class="icon" data-unmark="${i}" aria-label="取消收藏">${icon('close')}</button></div>`).join('') || '<p class="empty">长按正文，把想重读的那一楼留在这里。</p>'}</div>`,
      )
      $('#markCurrent').onclick = () =>
        run(async () => {
          await markFloor(currentPosition().floor)
          await panel('bookmarks')
        })
    } else if (name === 'search') {
      sheet(
        '查找正文',
        '<input id="textSearch" class="searchbox" placeholder="输入关键词" aria-label="搜索正文"><div class="button-row"><button id="runSearch" class="primary">搜索整份聊天</button></div><div id="searchResults" class="results"></div>',
      )
      $('#runSearch').onclick = () =>
        run(async () => {
          const q = $('#textSearch').value.trim()
          if (!q) return
          const token = ++searchVersion
          const id = chat.id
          $('#searchResults').textContent = '正在分段搜索…'
          const result = await api.resources.searchChat({ id, query: q })
          if (token !== searchVersion || !$('#sheet').open) return
          const results = result.results.map((r) => ({ ...r, text: masked(r.text) }))
          const offset = result.nextOffset
          $('#searchResults').innerHTML =
            results
              .map(
                (r) =>
                  `<button class="result" data-jump="${r.floor}"><small>第 ${r.floor + 1} 楼</small><span>${esc(r.text)}</span></button>`,
              )
              .join('') || '<p class="empty">未找到匹配内容</p>'
          if (offset !== null)
            $('#searchResults').insertAdjacentHTML(
              'beforeend',
              '<p class="hint">先显示前 100 个结果，请缩小关键词范围。</p>',
            )
        })
    } else if (name === 'display') {
      const segments = (key, items) =>
        `<div class="segmented">${items.map(([v, t]) => `<button data-setting="${key}" data-value="${v}" class="${prefs[key] === v ? 'active' : ''}">${t}</button>`).join('')}</div>`
      sheet(
        '阅读显示',
        `<label class="field-label">阅读方式</label><div class="segmented reading-modes"><button data-setting="mode" data-value="continuous" class="${prefs.mode === 'continuous' ? 'active' : ''}">上下滚动</button><button data-setting="mode" data-value="scroll" class="${prefs.mode === 'scroll' ? 'active' : ''}">上下左右</button><button data-setting="mode" data-value="page" class="${prefs.mode === 'page' ? 'active' : ''}">左右翻页</button></div><p class="hint mode-hint">上下滚动自动续读，只保留最近 5 楼；上下左右可纵向读完单楼，再横向切换楼层；左右翻页保留分页阅读。</p><label class="field-label">阅读效果</label><div class="segmented"><button data-reading-mode="plain" class="${prefs.renderMode === 'plain' ? 'active' : ''}">纯净</button><button data-reading-mode="simple" class="${prefs.renderMode === 'simple' ? 'active' : ''}">精简</button><button data-reading-mode="full" class="${prefs.renderMode === 'full' ? 'active' : ''}">完整</button></div><label class="field-label">排版</label>${segments(
          'layout',
          [
            ['novel', '小说排版'],
            ['tavern', '酒馆排版'],
          ],
        )}${[
          ['regex', '启用显示正则'],

          ['remote', '允许远程图片与媒体'],
          ['blendPanels', '状态栏背景融入阅读页'],
          ['hideUser', '只看角色回复'],
          ['mask', '用户名打码'],
        ]
          .map(
            ([k, t]) =>
              `<div class="setting-row"><label for="opt-${k}">${t}</label><input type="checkbox" id="opt-${k}" data-option="${k}" ${prefs[k] ? 'checked' : ''}></div>`,
          )
          .join(
            '',
          )}<p class="hint">纯净只读正文，不加载 HTML 状态栏与媒体；精简显示静态状态栏；完整支持展开和切换。显示正则包含角色卡规则及互传随附的全局规则。打码与完整模式可同时开启：正文继续打码，交互状态栏保持原文，可能显示姓名；图片内文字不保证打码。</p><div class="button-row reader-management-buttons"><button class="secondary" id="regexRules">管理显示正则</button><button class="secondary" id="manageScripts">管理脚本</button></div><details class="identity-settings"><summary>用户名称与打码</summary><div class="identity-form"><p class="hint">自动识别聊天中的用户名，也可补充别称。上方“用户名打码”可随时关闭，保留填写的配置。完整模式只对正文打码，交互状态栏保持原文。</p><label class="identity-field"><span>人设名称</span><input id="userName" class="searchbox" value="${esc(state.userName)}" placeholder="识别不准确时填写" aria-label="用户人设名称"></label><label class="identity-field"><span>额外打码词</span><textarea id="maskWords" rows="3" placeholder="每行一个名字或别称">${esc(prefs.words)}</textarea></label><label class="identity-field"><span>打码方式</span><select id="maskMode"><option value="replace">替换文字</option><option value="cover">遮住姓名</option></select></label><div class="identity-actions"><label class="identity-field" id="replacementField"><span>替换文字</span><input id="replacement" class="searchbox" value="${esc(prefs.replacement)}" placeholder="例如：某某" aria-label="打码替换词"></label><button class="primary" id="saveMask">应用打码</button></div></div></details>`,
      )
      $$('[data-option]').forEach(
        (el) =>
          (el.onchange = () =>
            run(async () => {
              const key = el.dataset.option
              if (key === 'remote' && el.checked && !runtime.network) {
                el.checked = false
                throw Error('请在扩展管理中使用兼容模式打开，以允许 HTTPS 图片和媒体')
              }
              prefs[key] = el.checked
              await savePrefs()
              const pos = pageData ? currentPosition() : state.position
              await read(pageData?.messages[0]?.index || 0, pos)
            })),
      )
      $('#regexRules').onclick = () => regexPanel()
      $('#manageScripts').onclick = () => run(showScriptSettings)
      $('#maskMode').value = prefs.maskMode || 'replace'
      const showReplacement = () => {
        $('#replacementField').hidden = $('#maskMode').value === 'cover'
      }
      $('#maskMode').onchange = showReplacement
      showReplacement()
      $('#saveMask').onclick = () =>
        run(async () => {
          state.userName = $('#userName').value.trim()
          await saveState()
          prefs.words = $('#maskWords').value
          prefs.maskMode = $('#maskMode').value
          prefs.replacement = $('#replacement').value || '某某'
          prefs.mask = true
          $('#opt-mask').checked = true
          await savePrefs()
          const pos = pageData ? currentPosition() : null
          await read(pageData?.messages[0]?.index || 0, pos)
          notify(
            prefs.maskMode === 'cover'
              ? '已开启文字遮挡；完整模式的交互状态栏和图片不在打码范围内'
              : '已更新打码文字；完整模式的交互状态栏和图片不在打码范围内',
          )
        })
    } else if (name === 'appearance') {
      pendingStyleId = prefs.styleId || ''
      sheet(
        '阅读外观',
        `<div class="setting-row"><label for="appearanceScope">外观配置</label><select id="appearanceScope"><option value="default">跟随默认外观</option><option value="character">角色专属外观</option></select></div><p class="hint">${roleAppearance?.enabled ? `正在调整「${esc(boundRole(chat).name)}」的外观与正则方案，同角色聊天共用。` : '正在调整默认外观，所有跟随默认的角色共用；正则开关仍按聊天保存。'}</p><div class="setting-row"><label for="panelAppearance">状态栏配色</label><select id="panelAppearance"><option value="author">保留作者配色</option><option value="reader">融入阅读主题</option></select></div><p class="hint">正文独立排版；融合模式统一文字与面板配色，简化背景和阴影；图片元素不改色。</p><div class="themes">${[
          ['paper', '纸', '#f6f3ec'],
          ['green', '绿', '#e8eddf'],
          ['night', '夜', '#202622'],
        ]
          .map(
            ([v, t, b]) =>
              `<button class="swatch ${prefs.theme === v ? 'active' : ''}" data-theme="${v}" style="background:${b};color:${v === 'night' ? '#d0d3c6' : '#303a32'}">${t}</button>`,
          )
          .join(
            '',
          )}</div><div class="setting-row"><span>文字大小</span><div class="stepper"><button id="fontMinus">−</button><span id="fontValue">${prefs.font}px</span><button id="fontPlus">＋</button></div></div><div class="setting-row"><label for="lineRange">行间距</label><input id="lineRange" type="range" min="1.5" max="2.5" step=".05" value="${prefs.leading}"></div><div class="button-row"><button class="secondary" id="pickBg">选择阅读背景</button><button class="secondary" id="clearBg">移除背景</button></div><p class="hint">图片背景仅本次有效。为保持文字可读，自动叠加纸色遮罩。</p><details><summary>自定义 CSS / 导入美化</summary><p class="hint">样式仅作用正文，不影响返回和设置。支持 CSS 与含 custom_css 的主题 JSON；酒馆整套界面选择器不保证直接兼容。</p><textarea class="code" id="cssInput" aria-label="正文 CSS">${esc(prefs.css)}</textarea><div class="button-row"><button class="secondary" id="libraryCss">资源库美化</button><button class="secondary" id="importCss">导入文件</button><button class="secondary" id="defaultCss">默认样式 / 导出</button><button class="primary" id="applyCss">应用 CSS</button></div></details><div class="appearance-reset"><button class="text-button" id="resetAppearance">${roleAppearance?.values ? '重置角色外观' : '恢复初始外观'}</button></div>`,
      )
      $('#appearanceScope').value = roleAppearance?.enabled ? 'character' : 'default'
      $('#appearanceScope').onchange = (event) =>
        runEvent(event, (target) => changeAppearanceMode(target.value === 'character'))
      $('#panelAppearance').value = prefs.panelAppearance || 'author'
      $('#panelAppearance').onchange = (event) =>
        runEvent(event, async (target) => {
          const pos = currentPosition()
          prefs.panelAppearance = target.value
          await savePrefs()
          await read(pageData.messages[0]?.index || 0, pos)
        })
      const update = async (change, rebuild = false) => {
        const pos = pageData ? currentPosition() : null
        change()
        applyPrefs()
        if (pageData) {
          if (rebuild) renderPage()
          restore(pos)
        }
        await savePrefs()
      }
      $('#fontMinus').onclick = () =>
        run(async () => {
          await update(() => (prefs.font = Math.max(14, prefs.font - 1)))
          $('#fontValue').textContent = prefs.font + 'px'
        })
      $('#fontPlus').onclick = () =>
        run(async () => {
          await update(() => (prefs.font = Math.min(30, prefs.font + 1)))
          $('#fontValue').textContent = prefs.font + 'px'
        })
      $('#lineRange').onchange = (e) =>
        runEvent(e, (target) => update(() => (prefs.leading = Number(target.value))))
      $('#pickBg').onclick = () => $('#backgroundFile').click()
      $('#clearBg').onclick = () => {
        background = ''
        $('#reader').style.backgroundImage = ''
        $('#reader').style.setProperty('--veil', 0)
      }
      $('#libraryCss').onclick = () => run(() => libraryStylePanel())
      $('#importCss').onclick = () => $('#cssFile').click()
      $('#defaultCss').onclick = () => defaultCssPanel()
      $('#applyCss').onclick = () =>
        run(async () => {
          const css = $('#cssInput').value
          if (css.length > 30000) throw Error('正文 CSS 请控制在 30000 字符以内')
          await update(() => {
            prefs.css = css
            prefs.styleId = pendingStyleId
          }, true)
          run(syncReaderFonts)
          notify('CSS 已应用')
        })
      $('#resetAppearance').onclick = () =>
        run(async () => {
          if (roleAppearance?.values) return changeAppearanceMode(false, true)
          await update(() =>
            Object.assign(prefs, {
              font: 18,
              leading: 1.85,
              theme: 'paper',
              css: '',
              styleId: '',
              panelAppearance: 'author',
            }),
          )
          if (pageData) await read(pageData.messages[0]?.index || 0, currentPosition())
          background = ''
          $('#reader').style.backgroundImage = ''
          $('#reader').style.setProperty('--veil', 0)
          await panel('appearance')
        })
    }
  }
  function dataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(Error('文件读取失败'))
      reader.readAsDataURL(blob)
    })
  }
  function longPress(target, selector, handler) {
    let start
    const cancel = () => clearTimeout(holdTimer)
    target.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      const node = e.target.closest(selector)
      if (
        !node ||
        e.composedPath().some((el) => el?.matches?.('a,input,textarea,summary,select')) ||
        (target === shadow && e.composedPath().some((el) => el?.matches?.('button')))
      )
        return
      start = { x: e.clientX, y: e.clientY }
      cancel()
      holdTimer = setTimeout(() => {
        suppress = true
        run(() => handler(node))
      }, 550)
    })
    target.addEventListener('pointermove', (e) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 9) cancel()
    })
    for (const name of ['pointerup', 'pointercancel', 'pointerleave'])
      target.addEventListener(name, cancel)
    target.addEventListener('contextmenu', (e) => {
      const node = e.target.closest(selector)
      if (node) {
        e.preventDefault()
        cancel()
        run(() => handler(node))
      }
    })
  }
  $('#brand').innerHTML = icon('book')
  for (const [id, name] of [
    ['libraryBack', 'back'],
    ['searchToggle', 'search'],
    ['characterCover', 'image'],
    ['sheetClose', 'close'],
    ['readerMenu', 'menu'],
    ['readerBack', 'back'],
    ['readerMore', 'more'],
    ['readerFullscreen', 'full'],
    ['prevPage', 'back'],
    ['nextPage', 'next'],
  ])
    $('#' + id).innerHTML = icon(name)
  for (const [name, ic, text] of [
    ['progress', 'progress', '进度'],
    ['search', 'search', '查找'],
    ['bookmarks', 'bookmark', '收藏'],
    ['display', 'sliders', '显示'],
    ['appearance', 'sun', '外观'],
  ])
    $(`[data-panel="${name}"]`).innerHTML = icon(ic) + text
  $('#libraryContent').onclick = (e) =>
    runEvent(e, async (target) => {
      if (suppress) {
        suppress = false
        return
      }
      const t = target.closest('button')
      if (!t) return
      if (t.dataset.chat) await openChat(t.dataset.chat)
      else if (t.dataset.role) await selectRole(t.dataset.role)
      else if (t.dataset.note) await notePanel(t.dataset.note)
      else if (t.dataset.action === 'refresh') await refresh()
      else if (t.dataset.action === 'moreList') {
        listLimit += 30
        await renderLibrary()
      }
    })
  $('#libraryBack').onclick = () => run(navigateBack)
  $('#librarySearch').oninput = () => run(renderLibrary)
  $('#searchToggle').onclick = () => {
    $('#librarySearchWrap').hidden = !$('#librarySearchWrap').hidden
    if (!$('#librarySearchWrap').hidden) $('#librarySearch').focus()
  }
  $('#characterCover').onclick = () =>
    run(async () => {
      prefs.characterCover = !prefs.characterCover
      applyCharacterCover()
      await syncNavigation()
      await savePrefs()
    })
  $('#aboutBtn').onclick = () =>
    sheet(
      '关于读了么',
      '<p>从资源库读取聊天记录，按明确绑定的角色卡整理。</p><p class="hint">导入入口在资源库。备份时选择“聊天记录”和“读了么阅读数据”，保留聊天、配套资源以及备注、收藏、进度和外观。卸载 APP 默认保留阅读数据。</p><p class="hint">支持 JSONL / 严格 JSON 聊天。纯净模式只读正文；精简模式显示静态状态栏；完整模式原位交互，只读取已保存变量，不补猜历史。</p><button class="secondary" id="refreshAbout">刷新资源库</button>',
    )
  $('#sheetClose').onclick = closeSheet
  $('#sheet').addEventListener('cancel', (e) => {
    if (sheetReturn) {
      e.preventDefault()
      closeSheet()
    }
  })
  // Only suppress the compatibility click belonging to the hold/swipe, never a new gesture.
  listen(
    root,
    'pointerdown',
    () => {
      suppress = false
    },
    true,
  )
  $('#sheet').addEventListener('close', () => {
    suppress = false
    searchVersion++
    sheetReturn = null
  })
  $('#sheet').addEventListener('click', (e) => {
    if (suppress) {
      suppress = false
      return
    }
    if (e.target === $('#sheet')) {
      const r = $('#sheet').getBoundingClientRect()
      if (e.clientY < r.top || e.clientX < r.left || e.clientX > r.right) closeSheet()
    }
  })
  $('#sheetBody').onclick = (e) =>
    runEvent(e, async (target) => {
      const t = target.closest('button')
      if (!t) return
      if (t.dataset.regexSource) await regexSourcePanel(t.dataset.regexSource)
      if (t.dataset.regexPage !== undefined)
        await regexSourcePanel(t.dataset.scope, Number(t.dataset.regexPage))
      if (t.dataset.regexPick) await replaceRegexSource(t.dataset.scope, t.dataset.regexPick)
      if (t.dataset.regexRestore) await replaceRegexSource(t.dataset.regexRestore, '')
      if (t.dataset.scriptPage !== undefined) await scriptSourcePanel(Number(t.dataset.scriptPage))
      if (t.dataset.scriptPick) await changeScriptSource(t.dataset.scriptPick)
      if (t.dataset.scriptRemove) await changeScriptSource(t.dataset.scriptRemove, true)
      if (t.dataset.readingMode) {
        if (t.dataset.readingMode !== prefs.renderMode) await setReadingMode(t.dataset.readingMode)
      }
      if (t.dataset.progressMode) {
        const controls = $('#sheetBody').firstElementChild
        const pos = currentPosition()
        prefs.progressMode = t.dataset.progressMode
        await savePrefs()
        await read(readStart(pos.floor), pos)
        if ($('#sheet').open && controls?.isConnected) await panel('progress')
      }
      if (t.dataset.chapterPage !== undefined) await chapterPanel(Number(t.dataset.chapterPage))
      if (t.dataset.stylePage !== undefined) await libraryStylePanel(Number(t.dataset.stylePage))
      if (t.dataset.libraryStyle) {
        const selected = await api.resources.readerStyle(t.dataset.libraryStyle)
        if (!selected.css.trim()) throw Error('这份美化没有可识别的聊天区域 CSS')
        await panel('appearance')
        pendingStyleId = t.dataset.libraryStyle
        $('#cssInput').value = selected.css
        $('#cssInput').closest('details').open = true
        notify('已提取“' + selected.name + '”的聊天样式，点击应用 CSS')
      }
      if (t.dataset.reply !== undefined) {
        const floor = Number(t.dataset.replyFloor)
        state.replyOverrides = { ...state.replyOverrides, [floor]: Number(t.dataset.reply) }
        await saveState()
        $('#sheet').close()
        await read(pageData.messages[0]?.index || 0, { floor, offset: 0 })
        notify('正在阅读回复 ' + (Number(t.dataset.reply) + 1))
      }
      if (t.id === 'refreshAbout') {
        $('#sheet').close()
        await refresh()
      }
      if (t.dataset.jump !== undefined) await jump(Number(t.dataset.jump))
      if (t.dataset.setting) {
        if (prefs[t.dataset.setting] === t.dataset.value) return
        const controls = $('#sheetBody').firstElementChild
        const pos = pageData ? currentPosition() : null
        prefs[t.dataset.setting] = t.dataset.value
        if (pageData) {
          if (t.dataset.setting === 'mode') await read(readStart(pos.floor), pos)
          else {
            renderPage()
            restore(pos)
          }
        }
        await savePrefs()
        if ($('#sheet').open && controls?.isConnected) await panel('display')
      }
      if (t.dataset.theme) {
        const controls = $('#sheetBody').firstElementChild
        const pos = pageData ? currentPosition() : null
        prefs.theme = t.dataset.theme
        applyPrefs()
        if (pageData) await read(pageData.messages[0]?.index || 0, pos)
        await savePrefs()
        if ($('#sheet').open && controls?.isConnected) await panel('appearance')
      }
      if (t.dataset.unmark !== undefined) {
        state.marks.splice(Number(t.dataset.unmark), 1)
        await saveState()
        await panel('bookmarks')
      }
      if (t.dataset.markJump !== undefined) {
        const m = state.marks[Number(t.dataset.markJump)]
        if (m.hash !== pageData.contentHash) {
          notify('原文已变化，保留摘录但不自动跳到可能错误的楼层')
          return
        }
        if (Number.isInteger(m.replyId)) {
          state.replyOverrides = { ...state.replyOverrides, [m.floor]: m.replyId }
          await saveState()
          $('#sheet').close()
          await read(readStart(m.floor), {
            floor: m.floor,
            offset: 0,
          })
        } else await jump(m.floor)
      }
    })
  $('#readerBack').onclick = () => run(leaveReader)
  $('#readerMenu').onclick = () => toggleChrome(true)
  $('#readerPosition').onclick = () => run(() => panel('progress'))
  $('#readerMore').onclick = () =>
    floorPanel(currentPosition().floor, window.getSelection()?.toString() || '')
  $('#readerFullscreen').onclick = () => run(() => api.ui.exitFullscreen())
  $$('[data-panel]').forEach((b) => (b.onclick = () => run(() => panel(b.dataset.panel))))
  $('#prevPage').onclick = () => run(() => turn(-1))
  $('#nextPage').onclick = () => run(() => turn(1))
  longPress($('#libraryContent'), '.chat-open', (el) => notePanel(el.dataset.chat))
  longPress(shadow, '[data-floor]', (el) =>
    floorPanel(Number(el.dataset.floor), window.getSelection()?.toString() || ''),
  )
  shadow.addEventListener('load', mediaLayoutChanged, true)
  shadow.addEventListener('toggle', mediaLayoutChanged, true)
  shadow.addEventListener('click', (e) => {
    const interactive = e
      .composedPath()
      .some((el) => el?.matches?.('a,summary,input,textarea,button,select'))
    runEvent(e, async (target) => {
      if (suppress) {
        suppress = false
        return
      }
      const t = target.closest('button')
      if (t?.dataset.hiddenRules !== undefined) hiddenRulePanel(Number(t.dataset.hiddenRules))
      else if (!interactive && !window.getSelection()?.toString()) toggleChrome()
    })
  })
  let down
  $('#readingViewport').addEventListener('pointerdown', (e) => {
    down = {
      x: e.clientX,
      y: e.clientY,
      blocked: e.composedPath().some((el) => el?.matches?.('button,a,input,summary,table')),
    }
  })
  $('#readingViewport').addEventListener('pointerup', (e) => {
    if (!down) return
    const d = down
    down = null
    const dx = e.clientX - d.x,
      dy = e.clientY - d.y
    if (!d.blocked && !window.getSelection()?.toString() && prefs.mode === 'continuous') {
      const viewport = $('#readingViewport')
      if (
        viewport.scrollHeight <= viewport.clientHeight + 2 &&
        Math.abs(dy) > 55 &&
        Math.abs(dy) > Math.abs(dx) * 1.4
      ) {
        suppress = true
        run(() => extendContinuous(dy < 0 ? 'next' : 'previous'))
        return
      }
    }
    if (
      !d.blocked &&
      prefs.mode !== 'continuous' &&
      Math.abs(dx) > 55 &&
      Math.abs(dx) > Math.abs(dy) * 1.4 &&
      !window.getSelection()?.toString()
    ) {
      suppress = true
      run(() => turn(dx < 0 ? 1 : -1))
    }
  })
  $('#readingViewport').addEventListener(
    'scroll',
    () => {
      if (scriptSession?.native) return
      const viewport = $('#readingViewport')
      const delta = viewport.scrollTop - lastReaderScrollTop
      lastReaderScrollTop = viewport.scrollTop
      positionLabel()
      syncScriptFloor()
      processReadingScroll(viewport.scrollTop, viewport.scrollHeight, viewport.clientHeight, delta)
    },
    { passive: true },
  )
  function processReadingScroll(top, height, viewportHeight, delta) {
    if (prefs.mode === 'continuous' && pageData && !continuousLoading) {
      const distanceToBottom = height - viewportHeight - top
      if (
        scriptSession?.native &&
        top + viewportHeight <= virtualTopHeight &&
        previousOffset() !== null
      )
        run(() => extendContinuous('previous'))
      else if (
        scriptSession?.native &&
        distanceToBottom + viewportHeight <= virtualBottomHeight &&
        pageData.nextOffset !== null
      )
        run(() => extendContinuous('next'))
      else if (
        delta > 0 &&
        distanceToBottom - virtualBottomHeight < 240 &&
        height > viewportHeight + 1 &&
        pageData.nextOffset !== null
      )
        run(() => extendContinuous('next'))
      else if (delta < 0 && top - virtualTopHeight < 240 && previousOffset() !== null)
        run(() => extendContinuous('previous'))
    }
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => run(recordPosition), 600)
  }
  $('#backgroundFile').onchange = (e) =>
    runEvent(e, async (target) => {
      const f = target.files[0]
      if (!f) return
      if (f.size > 2 * 1024 * 1024) throw Error('背景图片请控制在 2 MiB 以内')
      background = await dataUrl(f)
      $('#reader').style.backgroundImage = `url("${background}")`
      $('#reader').style.setProperty('--veil', 0.85)
      target.value = ''
    })
  $('#cssFile').onchange = (e) =>
    runEvent(e, async (target) => {
      const f = target.files[0]
      if (!f) return
      if (f.size > 50000) throw Error('美化文件过大')
      let source = await f.text()
      if (f.name.endsWith('.json')) {
        const obj = JSON.parse(source)
        if (typeof obj.custom_css !== 'string') throw Error('主题 JSON 缺少 custom_css')
        source = obj.custom_css
      }
      $('#cssInput').value = source
      pendingStyleId = ''
      target.value = ''
      notify('已载入，请点击应用 CSS')
    })
  listen(root, 'keydown', (e) => {
    if ($('#reader').hidden || $('#sheet').open || e.target.matches('input,textarea')) return
    if (e.key === 'ArrowLeft') run(() => turn(-1))
    if (e.key === 'ArrowRight') run(() => turn(1))
    if (e.key === 'Escape') toggleChrome(false)
  })
  listen(document, 'visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return
    clearTimeout(saveTimer)
    run(recordPosition)
  })
  let size = ''
  const readerSizeObserver = new ResizeObserver(() => {
    if (!pageData || $('#reader').hidden) return
    measureChrome()
    const vp = $('#readingViewport'),
      next = vp.clientWidth + 'x' + vp.clientHeight
    if (next === size) return
    size = next
    if (scriptSession?.native) {
      requestAnimationFrame(() => positionScriptSession())
      return
    }
    const pos = pagePosition || state.position
    requestAnimationFrame(() => (pos ? restore(pos) : calculatePages()))
  })
  for (const element of [$('#readingViewport'), $('#readerHeader'), $('.reader-bottom')])
    readerSizeObserver.observe(element)
  const ready = Promise.resolve()
    .then(async () => {
      const capabilities = await api.capabilities()
      if (disposed) return
      runtime = capabilities.runtime || {}
      surface.classList.toggle('builtin-shell', runtime.builtinReader === true)
      $('#readerFullscreen').hidden = runtime.builtinReader === true
      const savedData = await api.storage.getMany(['preferences-v1', 'reader-index-v1'])
      if (disposed) return
      const savedPrefs = savedData['preferences-v1'] || {}
      defaultPrefs = {
        ...defaultPrefs,
        ...savedPrefs,
        renderMode: ['plain', 'simple', 'full'].includes(savedPrefs.renderMode)
          ? savedPrefs.renderMode
          : savedPrefs.interactive
            ? 'full'
            : 'simple',
      }
      delete defaultPrefs.interactive
      prefs = { ...defaultPrefs }
      indexState = savedData['reader-index-v1'] || {}
      bodyStyles = [...root.querySelectorAll('style')].map((s) => s.textContent).join('\n')
      const contentRules = (rules) =>
        [...rules].flatMap((rule) => {
          if (
            rule.selectorText &&
            /\.reading-flow(?![-\w])|\.floor(?![-\w])|\.speaker(?![-\w])|\.mes_text(?![-\w])|\[data-chat-frontend\]/.test(
              rule.selectorText,
            )
          )
            return [rule.cssText]
          if (rule.cssRules) {
            const children = contentRules(rule.cssRules)
            return children.length
              ? [rule.cssText.slice(0, rule.cssText.indexOf('{') + 1) + children.join('\n') + '}']
              : []
          }
          return []
        })
      defaultContentStyles =
        [...root.querySelectorAll('style')]
          .map((style) => style.sheet)
          .filter(Boolean)
          .flatMap((sheet) => contentRules(sheet.cssRules))
          .join('\n') +
        '\n' +
        readingBaseCss
      applyShellCss(runtime.readerUiCss)
      applyPrefs()
      await refresh(false)
      if (disposed) return
      const resume = chats.find((item) => item.id === indexState.lastChat)
      if (indexState.resumeReading && resume && boundRole(resume)) await openChat(resume.id)
      else await renderLibrary()
    })
    .catch((error) => {
      if (disposed) return
      loading(error.message)
      notify(error.message, true)
    })
    .finally(async () => {
      if (disposed) return
      starting = false
      surface.removeAttribute('data-reader-starting')
      await syncNavigation()
      // Bridge connection alone does not mean the initial page and appearance are ready.
      await api?.ui?.setLoading?.('')
    })
  return {
    ready,
    appearance(css) {
      if (!disposed) applyShellCss(css)
    },
    action(action) {
      if (disposed) return
      if (action === 'back') run(navigateBack)
      if (action === 'search') $('#searchToggle').click()
      if (action === 'cover') $('#characterCover').click()
    },
    async dispose() {
      if (disposed) return
      disposed = true
      lifecycle.abort()
      api.dispose?.()
      version++
      readVersion++
      searchVersion++
      clearTimeout(saveTimer)
      clearTimeout(toastTimer)
      clearTimeout(holdTimer)
      readerSizeObserver.disconnect()
      avatarObserver.disconnect()
      const saved = recordPosition().catch(() => {})
      fontKey = ''
      clearPanelFrames()
      pageData = null
      chat = null
      if ($('#sheet').open) $('#sheet').close()
      readerFontStyle.remove()
      avatarCache.clear()
      stateCache.clear()
      await saved
    },
  }
}
