/** DOM controller for the isolated palette page; persistence/application/publication stay with their existing owners. */
import {
  color,
  readPaletteCss,
  inspectPaletteCss,
  defaults,
  specs,
  shapeSpecs,
  byId,
  names,
  impact,
  shapeDefaults,
  rgba,
  paint,
  mergePaletteCss,
  packPaletteDesign,
  unpackPaletteDesign,
  validateDesign,
  rgb,
  hexFromRgb,
  hexToHsv,
  hsvToHex,
} from '../core/AppearancePaletteModel.js'
const allSpecs = [...specs, ...shapeSpecs]
export function mountAppearancePalette(root, ports) {
  const document = root.ownerDocument,
    window = document.defaultView,
    structuredClone = globalThis.structuredClone,
    q = (id) => root.querySelector('#e-' + id)
  let state = {
      flow: 4,
      page: 'palette',
      stage: 'edit',
      theme: 'light',
      target: 'canvas',
      radius: 8,
      radii: { ...shapeDefaults },
      stop: 0,
      layer: 'base',
      channel: 'hex',
      values: structuredClone(defaults),
      dirty: false,
      scrollTop: 0,
      moreOpen: false,
    },
    history = [],
    pickerKey = '',
    targetGroup = '',
    pickerIdentity = '',
    lastPickerHex = '',
    hsv = { h: 0, s: 0, v: 1 },
    colorPointer = null,
    lastPresetName = '',
    restoring = false,
    pendingRemoval = null
  const isShape = () => !!byId[state.target].shape,
    current = () => state.values[state.theme][isShape() ? 'button' : state.target],
    flat = () => isShape() || byId[state.target].flat
  const radius = () =>
    state.target === 'shape' ? state.radius : (state.radii[state.target] ?? state.radius)
  function setRadius(value) {
    if (state.target === 'shape') {
      state.radius = value
      state.radii.iconShape = null
      state.radii.filterShape = null
    } else state.radii[state.target] = value
  }
  let sourceCss = ports.initialCss
  let baseline = readPaletteCss(sourceCss, ports.theme)
  const css = () => mergePaletteCss(sourceCss, state, baseline),
    packDesign = () => packPaletteDesign(state),
    unpackDesign = unpackPaletteDesign
  function makeIcon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.8')
    svg.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS(svg.namespaceURI, 'path')
    path.setAttribute('d', name === 'plus' ? 'M12 5v14M5 12h14' : 'M5 5l14 14M19 5 5 19')
    svg.append(path)
    return svg
  }
  function notice(message) {
    q('error').textContent = message
    q('error').hidden = false
    q('editor-scroll').scrollTop = 0
    ports.notice(message)
  }
  let lifetime = new window.AbortController()
  let disposed = false
  function capturePlace() {
    if (state.page !== 'palette') return
    state.scrollTop = q('editor-scroll').scrollTop
    state.moreOpen = q('more').open
    state.shapeOpen = q('shape-pane').querySelector('details').open
    state.scopeOpen = q('impact-detail').parentElement.open
    state.cssOpen = q('css-details').open
  }
  function persist() {
    if (restoring || disposed) return
    capturePlace()
    const { values, ...saved } = state
    try {
      ports.writeDraft({
        ...saved,
        sourceId: ports.sourceId,
        hue: hsv.h,
        compact: 1,
        design: packDesign(),
      })
    } catch {
      q('status').textContent = '草稿未能保存，请下载CSS备份'
      q('status').hidden = false
      notice('草稿未能保存，请检查本机空间。')
    }
  }
  function snapshot() {
    history.push(
      JSON.stringify({
        values: state.values,
        radius: state.radius,
        radii: state.radii,
        dirty: state.dirty,
        theme: state.theme,
        target: state.target,
        layer: state.layer,
        stop: state.stop,
      }),
    )
    if (history.length > 30) history.shift()
  }
  function changed(message = '预览已更新') {
    state.dirty = true
    q('status').textContent = message
    q('status').hidden = false
    render()
    persist()
  }
  function move(stage) {
    state.stage = stage
    q('status').hidden = true
    render()
    q('editor-scroll').scrollTop = 0
    persist()
  }
  const activeColor = () =>
    state.layer === 'glow' && current().type === 'mix'
      ? current().overlay[0]
      : current().stops[state.stop]
  function clearColorError() {
    q('color-error').hidden = true
    for (const id of ['hex', 'r', 'g', 'b']) q(id).removeAttribute('aria-invalid')
  }
  function colorError(input, message) {
    input.setAttribute('aria-invalid', 'true')
    q('color-error').textContent = message
    q('color-error').hidden = false
  }
  function writeColor(hex, commit = true) {
    activeColor().hex = hex
    lastPickerHex = hex
    clearColorError()
    if (commit) changed('颜色已更新，CSS 已同步生成')
    else render()
  }
  function syncColorEditor() {
    const c = activeColor(),
      identity = `${state.theme}:${state.target}:${state.layer}:${state.stop}`
    if (identity !== pickerIdentity || lastPickerHex !== c.hex) {
      hsv = hexToHsv(c.hex, hsv.h)
      pickerIdentity = identity
      lastPickerHex = c.hex
      clearColorError()
    }
    q('sv').style.setProperty('--e-hue', hsv.h)
    q('hue').style.setProperty('--e-hue', hsv.h)
    q('sv-marker').style.left = `clamp(7px,${hsv.s * 100}%,calc(100% - 7px))`
    q('sv-marker').style.top = `clamp(7px,${(1 - hsv.v) * 100}%,calc(100% - 7px))`
    q('hue').value = hsv.h
    q('saturation').value = Math.round(hsv.s * 100)
    q('brightness').value = Math.round(hsv.v * 100)
    q('saturation-value').textContent = Math.round(hsv.s * 100) + '%'
    q('brightness-value').textContent = Math.round(hsv.v * 100) + '%'
    q('format').value = state.channel
    q('hex-field').hidden = state.channel !== 'hex'
    q('rgb-fields').hidden = state.channel !== 'rgb'
    if (document.activeElement !== q('hex')) q('hex').value = c.hex.toUpperCase()
    rgb(c.hex).forEach((v, i) => {
      const input = q(['r', 'g', 'b'][i])
      if (document.activeElement !== input) input.value = v
    })
  }
  function makePicker(container, label, index, layer = 'base') {
    const button = document.createElement('button')
    button.className = 'e-color cursor-interaction'
    button.dataset.picker = layer === 'glow' ? 'glow' : 'color-' + index
    button.dataset.layer = layer
    button.dataset.index = index
    button.setAttribute('aria-label', '调整' + label)
    const title = document.createElement('span')
    title.textContent = label
    const box = document.createElement('span')
    box.className = 'e-color-box'
    box.append(document.createElement('span'))
    button.append(title, box)
    button.onclick = () => {
      state.layer = layer
      if (layer === 'base') state.stop = index
      render()
      persist()
    }
    container.append(button)
  }
  function chooseTarget(id) {
    state.target = id
    state.stop = 0
    state.layer = 'base'
    q('more').open = false
    move('edit')
    revealTarget()
  }
  function renderTargets() {
    const group = byId[state.target].group
    q('group').value = group
    if (targetGroup === group) return
    targetGroup = group
    q('targets').replaceChildren()
    for (const s of allSpecs.filter((s) => s.group === group)) {
      const b = document.createElement('button')
      b.className = 'cursor-interaction'
      b.dataset.target = s.id
      b.textContent = s.name
      b.onclick = () => chooseTarget(s.id)
      q('targets').append(b)
    }
  }
  function renderPreview() {
    const spec = byId[state.target],
      v = state.values[state.theme],
      scene = spec.scene
    for (const s of specs)
      q('preview').style.setProperty(
        '--p-' + s.id,
        s.flat ? rgba(v[s.id].stops[0]) : paint(v[s.id]),
      )
    const radii = {
      button: state.radius,
      icon: state.radii.iconShape ?? state.radius,
      filter: state.radii.filterShape ?? state.radius,
      control: state.radii.controlShape,
      card: state.radii.cardShape,
      dialog: state.radii.dialogShape,
    }
    for (const [key, value] of Object.entries(radii))
      q('preview').style.setProperty('--p-' + key + '-radius', value + 'px')
    for (const name of ['library', 'dialog', 'notice', 'viewer'])
      q(name + '-scene').hidden = name !== scene
    q('preview').style.background = scene === 'dialog' ? rgba(v.overlay.stops[0]) : paint(v.canvas)
    root.querySelectorAll('.e-selected').forEach((e) => e.classList.remove('e-selected'))
    if (state.stage === 'edit') q(spec.preview).classList.add('e-selected')
  }
  function render() {
    const f = current(),
      shape = isShape()
    root.querySelector('.e-window').dataset.theme = state.theme
    q('palette-page').hidden = state.page !== 'palette'
    q('theme').hidden = state.page !== 'palette'
    q('actions').hidden = state.stage !== 'edit'
    root
      .querySelectorAll('[data-theme-value]')
      .forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeValue === state.theme)))
    renderTargets()
    for (const stage of ['edit', 'finish']) q(stage).hidden = state.stage !== stage
    root
      .querySelectorAll('[data-target]')
      .forEach((b) => b.setAttribute('aria-pressed', String(state.target === b.dataset.target)))
    q('edit').setAttribute('aria-label', names[state.target])
    q('impact-detail').textContent = impact[state.target]
    q('color-pane').hidden = shape
    q('shape-pane').hidden = !shape
    q('effects').hidden = flat()
    root
      .querySelectorAll('[data-type]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === f.type)))
    q('gradient-options').hidden = flat() || f.type === 'solid'
    q('glow-options').hidden = flat() || f.type !== 'mix'
    q('remove').disabled = f.stops.length <= 1
    const count = flat() || f.type === 'solid' ? 1 : f.stops.length,
      key = `${state.theme}:${state.target}:${f.type}:${count}`
    if (pickerKey !== key) {
      pickerKey = key
      q('colors').replaceChildren()
      q('glow-picker').replaceChildren()
      for (let i = 0; i < count; i++) makePicker(q('colors'), '颜色 ' + (i + 1), i)
      if (!flat() && f.type !== 'solid') {
        const b = document.createElement('button')
        b.className = 'e-add cursor-interaction'
        b.setAttribute('aria-label', '添加颜色')
        const icon = makeIcon('plus')
        b.append(icon)
        b.id = 'e-add'
        b.disabled = count >= 6
        b.onclick = () => {
          if (current().stops.length >= 6) return
          snapshot()
          current().stops.push(color(current().stops.at(-1).hex, 100))
          current().stops.forEach(
            (c, i, list) => (c.pos = Math.round((i * 100) / (list.length - 1))),
          )
          state.stop = current().stops.length - 1
          state.layer = 'base'
          changed()
        }
        q('colors').append(b)
      }
      makePicker(q('glow-picker'), '柔光颜色', 0, 'glow')
    }
    state.stop = Math.min(state.stop, count - 1)
    if (f.type !== 'mix' || flat()) state.layer = 'base'
    q('colors').hidden = count === 1
    q('remove-row').hidden = flat() || f.type === 'solid' || state.layer !== 'base'
    q('remove-label').textContent = '删除颜色 ' + (state.stop + 1)
    q('remove').setAttribute('aria-label', '删除颜色 ' + (state.stop + 1))
    root.querySelectorAll('[data-picker]').forEach((button) => {
      const glow = button.dataset.layer === 'glow',
        c = glow ? f.overlay[0] : f.stops[+button.dataset.index]
      button.querySelector('.e-color-box>span').style.background = rgba(c)
      button.setAttribute(
        'aria-pressed',
        String(
          glow
            ? state.layer === 'glow'
            : state.layer === 'base' && state.stop === +button.dataset.index,
        ),
      )
    })
    syncColorEditor()
    q('alpha').value = 100 - activeColor().alpha
    q('alpha-value').textContent = 100 - activeColor().alpha + '%'
    q('angle').value = f.angle
    q('angle-value').textContent = f.angle + '°'
    q('strength').value = f.strength
    q('strength-value').textContent = f.strength + '%'
    root
      .querySelectorAll('[data-radius]')
      .forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.radius === radius())))
    q('radius').value = Math.min(32, radius())
    q('radius').disabled = radius() === 999
    q('radius-value').textContent = radius() === 999 ? '胶囊形' : radius() + 'px'
    q('undo').disabled = !history.length
    renderPreview()
    if (state.stage === 'finish') q('css').value = css()
    if (q('css-details').open) {
      q('css').style.height = 'auto'
      q('css').style.height = q('css').scrollHeight + 2 + 'px'
    }
  }
  function revealTarget() {
    const nav = q('targets'),
      active = nav.querySelector('[aria-pressed="true"]')
    if (!active) return
    const n = nav.getBoundingClientRect(),
      b = active.getBoundingClientRect()
    if (b.left < n.left + 3) nav.scrollLeft -= n.left + 3 - b.left
    else if (b.right > n.right - 3) nav.scrollLeft += b.right - n.right + 3
  }
  for (const group of [...new Set(allSpecs.map((s) => s.group))]) {
    const option = document.createElement('option')
    option.value = group
    option.textContent = group
    q('group').append(option)
  }
  q('group').onchange = (e) => chooseTarget(allSpecs.find((s) => s.group === e.target.value).id)
  q('targets').onkeydown = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const buttons = [...q('targets').querySelectorAll('button')],
      at = buttons.indexOf(document.activeElement)
    if (at < 0) return
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? buttons.length - 1
          : (at + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next].focus({ preventScroll: true })
    buttons[next].click()
  }
  q('continue').onclick = () => {
    state.stage = 'edit'
    render()
    q('editor-scroll').scrollTop = state.editScroll ?? 0
    persist()
  }
  q('done').onclick = () => {
    state.editScroll = q('editor-scroll').scrollTop
    move('finish')
  }
  async function back() {
    const signal = lifetime.signal
    if (
      state.dirty &&
      !(await ports.confirm(
        {
          title: '有未保存的修改',
          message: '保存草稿后退出？',
          confirmLabel: '保存草稿并退出',
          cancelLabel: '继续调整',
        },
        signal,
      ))
    )
      return
    if (disposed || signal.aborted) return
    capturePlace()
    state.dirty = false
    state.page = 'home'
    persist()
    ports.back()
  }
  root.querySelectorAll('[data-theme-value]').forEach(
    (b) =>
      (b.onclick = () => {
        state.theme = b.dataset.themeValue
        state.stop = 0
        render()
        persist()
      }),
  )
  root.querySelectorAll('[data-type]').forEach(
    (b) =>
      (b.onclick = () => {
        snapshot()
        const f = current()
        f.type = b.dataset.type
        if (f.stops.length < 2) f.stops.push(color(f.stops[0].hex, 100, f.stops[0].alpha))
        state.stop = 0
        changed()
      }),
  )
  for (const [id, apply] of [
    ['alpha', (v) => (activeColor().alpha = 100 - v)],
    ['angle', (v) => (current().angle = v)],
    ['strength', (v) => (current().strength = v)],
    ['radius', setRadius],
  ]) {
    const input = q(id)
    input.onpointerdown = snapshot
    input.onkeydown = (e) => {
      if (!e.repeat) snapshot()
    }
    input.oninput = (e) => {
      apply(+e.target.value)
      changed()
    }
  }
  q('format').onchange = (e) => {
    state.channel = e.target.value
    clearColorError()
    render()
    persist()
  }
  for (const id of ['hex', 'r', 'g', 'b']) {
    const input = q(id)
    input.onfocus = () => (input._colorSnapshot = false)
    input.oninput = () => {
      let hex
      if (id === 'hex') {
        const raw = input.value.trim().replace(/^#/, '')
        if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) return
        hex =
          '#' +
          (raw.length === 3
            ? raw
                .split('')
                .map((c) => c + c)
                .join('')
            : raw
          ).toLowerCase()
      } else {
        const values = ['r', 'g', 'b'].map((k) => q(k).value)
        if (values.some((v) => !/^\d{1,3}$/.test(v) || +v > 255)) return
        hex = hexFromRgb(values.map(Number))
      }
      if (hex !== activeColor().hex && !input._colorSnapshot) {
        snapshot()
        input._colorSnapshot = true
      }
      hsv = hexToHsv(hex, hsv.h)
      writeColor(hex)
    }
    input.onblur = () => {
      if (id === 'hex') {
        const raw = input.value.trim().replace(/^#/, '')
        if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw))
          colorError(input, '色号需为 3 位或 6 位，例如 #6A8CAF。')
        else input.value = activeColor().hex.toUpperCase()
      } else if (!/^\d{1,3}$/.test(input.value) || +input.value > 255)
        colorError(input, 'RGB 每一项请输入 0～255 的整数。')
    }
  }
  for (const [id, apply] of [
    ['hue', (v) => (hsv.h = v)],
    ['saturation', (v) => (hsv.s = v / 100)],
    ['brightness', (v) => (hsv.v = v / 100)],
  ]) {
    const input = q(id)
    input.onpointerdown = snapshot
    input.onkeydown = (e) => {
      if (!e.repeat) snapshot()
    }
    input.oninput = (e) => {
      apply(+e.target.value)
      writeColor(hsvToHex(hsv))
    }
  }
  function pickAt(e) {
    const rect = q('sv').getBoundingClientRect()
    hsv.s = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    hsv.v = 1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    writeColor(hsvToHex(hsv), false)
  }
  q('sv').onpointerdown = (e) => {
    if (colorPointer !== null || e.button !== 0) return
    e.preventDefault()
    if (root.contains(document.activeElement)) document.activeElement.blur()
    snapshot()
    colorPointer = e.pointerId
    q('sv').setPointerCapture(e.pointerId)
    pickAt(e)
  }
  q('sv').onpointermove = (e) => {
    if (e.pointerId === colorPointer) pickAt(e)
  }
  const finishColor = (e) => {
    if (e.pointerId !== colorPointer) return
    colorPointer = null
    if (q('sv').hasPointerCapture(e.pointerId)) q('sv').releasePointerCapture(e.pointerId)
    changed('颜色已更新，CSS 已同步生成')
  }
  q('sv').onpointerup = finishColor
  q('sv').onpointercancel = finishColor
  q('remove').onclick = async () => {
    const f = current()
    if (state.layer !== 'base' || flat() || f.type === 'solid' || f.stops.length <= 1) return
    pendingRemoval = {
      theme: state.theme,
      target: state.target,
      stop: state.stop,
      fill: JSON.stringify(f),
    }
    const pending = pendingRemoval
    const signal = lifetime.signal
    const confirmed = await ports.confirm(
      {
        title: '删除颜色 ' + (state.stop + 1) + '？',
        message: f.stops.length === 2 ? '剩余颜色将转为纯色，删除后可撤销。' : '删除后可撤销。',
        confirmLabel: '删除',
        danger: true,
      },
      signal,
    )
    pendingRemoval = null
    if (
      !confirmed ||
      disposed ||
      signal.aborted ||
      pending.theme !== state.theme ||
      pending.target !== state.target ||
      pending.stop !== state.stop ||
      state.layer !== 'base'
    )
      return
    const currentFill = current()
    if (JSON.stringify(currentFill) !== pending.fill) return
    snapshot()
    currentFill.stops.splice(state.stop, 1)
    currentFill.stops.forEach(
      (c, i, list) => (c.pos = list.length === 1 ? 0 : Math.round((i * 100) / (list.length - 1))),
    )
    if (currentFill.stops.length === 1) currentFill.type = 'solid'
    state.stop = Math.min(state.stop, currentFill.stops.length - 1)
    changed('选中颜色已删除')
  }
  root.querySelectorAll('[data-radius]').forEach(
    (b) =>
      (b.onclick = () => {
        snapshot()
        setRadius(+b.dataset.radius)
        changed()
      }),
  )
  q('reset').onclick = () => {
    snapshot()
    if (isShape()) {
      if (state.target === 'shape') setRadius(8)
      else state.radii[state.target] = shapeDefaults[state.target]
    } else
      state.values[state.theme][state.target] = structuredClone(defaults[state.theme][state.target])
    state.stop = 0
    state.layer = 'base'
    changed('这一项已还原')
  }
  q('undo').onclick = () => {
    if (!history.length) return
    Object.assign(state, JSON.parse(history.pop()))
    changed('已撤销上一步')
  }
  q('css-details').ontoggle = () => {
    render()
    persist()
  }
  q('more').ontoggle = persist
  q('shape-pane').querySelector('details').ontoggle = persist
  q('impact-detail').parentElement.ontoggle = persist
  q('editor-scroll').onscroll = persist
  q('draft-toggle').hidden = typeof ports.publish !== 'function'
  q('save-preset').onclick = () => {
    q('preset-name').value = lastPresetName || '我的配色'
    q('preset-dialog').showModal()
  }
  q('preset-cancel').onclick = () => q('preset-dialog').close()
  let saving = false
  async function savePreset() {
    if (saving) return
    const name = q('preset-name').value.trim()
    if (!name) {
      q('preset-name').setCustomValidity('请输入预设名称')
      q('preset-name').reportValidity()
      return
    }
    saving = true
    q('preset-commit').disabled = true
    try {
      q('preset-dialog').close()
      const result = await ports.savePreset(name, css())
      if (disposed) return
      if (!result) return
      lastPresetName = name
      state.dirty = false
      q('preset-dialog').close()
      q('result').textContent = '已保存：' + name
      q('result').hidden = false
      persist()
    } catch (error) {
      notice(error instanceof Error ? error.message : '预设保存失败')
    } finally {
      saving = false
      q('preset-commit').disabled = false
    }
  }
  q('preset-commit').onclick = savePreset
  q('preset-name').onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void savePreset()
    }
  }
  q('preset-name').oninput = () => q('preset-name').setCustomValidity('')
  q('import').onclick = () => q('import-file').click()
  q('import-file').onchange = async (event) => {
    const input = event.target,
      file = input.files?.[0],
      signal = lifetime.signal
    input.value = ''
    if (!file) return
    q('import').disabled = true
    try {
      if (!/\.css$/i.test(file.name)) throw new Error('请选择 CSS 文件')
      if (file.size > 2 * 1024 * 1024) throw new Error('CSS 文件超过 2 MB')
      const source = await file.text()
      const found = inspectPaletteCss(source, state.theme)
      if (signal.aborted || disposed) return
      if (
        state.dirty &&
        !(await ports.confirm(
          {
            title: '导入 CSS',
            message: '用导入的 CSS 替换当前调色草稿？已保存的预设会保留。',
            confirmLabel: '导入',
          },
          signal,
        ))
      )
        return
      if (signal.aborted || disposed) return
      const name = file.name.replace(/\.css$/i, '') || '导入配色'
      if (!(await ports.importCss(name, source)) || signal.aborted || disposed) return
      sourceCss = source
      baseline = found.design
      Object.assign(state, structuredClone(baseline), {
        stage: 'edit',
        stop: 0,
        layer: 'base',
        dirty: false,
      })
      history = []
      pickerKey = ''
      pickerIdentity = ''
      lastPresetName = name
      q('error').hidden = true
      render()
      q('status').textContent =
        `已识别 ${found.colors} 项配色、${found.shapes} 类圆角${found.unsupported.length ? '；复杂样式保留原 CSS' : ''}`
      q('status').hidden = false
      persist()
    } catch (error) {
      if (!signal.aborted && !disposed)
        notice(error instanceof Error ? error.message : 'CSS 导入失败，原草稿保留')
    } finally {
      q('import').disabled = false
    }
  }
  q('live-preview').onclick = async () => {
    const button = q('live-preview'),
      signal = lifetime.signal
    if (button.disabled) return
    button.disabled = true
    try {
      persist()
      await ports.preview(css(), signal)
    } catch (error) {
      if (!signal.aborted)
        notice(error instanceof Error ? error.message : '无法打开预览，草稿仍保留')
    } finally {
      button.disabled = false
    }
  }
  q('export').onclick = async () => {
    try {
      await ports.download(css(), lastPresetName || '我的配色')
      q('result').textContent = 'CSS已导出'
      q('result').hidden = false
    } catch (error) {
      notice(error instanceof Error ? error.message : '导出失败')
    }
  }
  function restore(saved) {
    if (
      !saved ||
      (saved.sourceId && saved.sourceId !== ports.sourceId) ||
      !['light', 'dark'].includes(saved.theme) ||
      !names[saved.target] ||
      (!saved.values && !saved.design)
    )
      return
    try {
      saved = structuredClone(saved)
      let design
      if (saved.compact) design = unpackDesign(saved.design)
      else {
        const values = structuredClone(defaults)
        for (const t of ['light', 'dark'])
          for (const s of specs)
            if (saved.values?.[t]?.[s.id]) values[t][s.id] = saved.values[t][s.id]
        design = { values, radius: saved.radius ?? 8, radii: { ...shapeDefaults } }
      }
      validateDesign(design)
      state = {
        ...state,
        ...design,
        flow: 4,
        page: saved.page === 'palette' ? 'palette' : 'home',
        stage: saved.stage === 'finish' ? 'finish' : 'edit',
        theme: saved.theme,
        target: saved.target,
        dirty: saved.dirty ?? true,
        stop: Number.isInteger(saved.stop) ? Math.max(0, Math.min(5, saved.stop)) : 0,
        layer: saved.layer === 'glow' ? 'glow' : 'base',
        channel: saved.channel === 'rgb' ? 'rgb' : 'hex',
        scrollTop: Number.isFinite(saved.scrollTop) ? Math.max(0, saved.scrollTop) : 0,
        editScroll: Number.isFinite(saved.editScroll) ? Math.max(0, saved.editScroll) : 0,
        moreOpen: !!saved.moreOpen,
        shapeOpen: !!saved.shapeOpen,
        scopeOpen: !!saved.scopeOpen,
        cssOpen: !!saved.cssOpen,
      }
      hsv.h = Number.isFinite(saved.hue) ? saved.hue : 0
      pickerKey = ''
      pickerIdentity = ''
    } catch {
      return
    }
  }
  function resume() {
    restoring = true
    render()
    q('more').open = state.moreOpen
    q('shape-pane').querySelector('details').open = !!state.shapeOpen
    q('impact-detail').parentElement.open = !!state.scopeOpen
    q('css-details').open = !!state.cssOpen
    q('editor-scroll').scrollTop = state.scrollTop
    revealTarget()
    restoring = false
  }
  state.theme = ports.theme
  Object.assign(state, structuredClone(baseline))
  restore(ports.readDraft())
  state.page = 'palette'
  resume()
  return {
    back,
    setActive(active) {
      if (active) lifetime = new window.AbortController()
      else {
        if (colorPointer !== null) state.dirty = true
        colorPointer = null
        persist()
        lifetime.abort()
      }
    },
    dispose() {
      persist()
      disposed = true
      lifetime.abort()
      for (const dialog of root.querySelectorAll('dialog[open]')) dialog.close()
      for (const node of root.querySelectorAll('*')) {
        for (const key of [
          'onclick',
          'oninput',
          'onchange',
          'onkeydown',
          'onfocus',
          'onblur',
          'ontoggle',
          'onscroll',
          'onpointerdown',
          'onpointermove',
          'onpointerup',
          'onpointercancel',
        ])
          node[key] = null
      }
    },
  }
}
