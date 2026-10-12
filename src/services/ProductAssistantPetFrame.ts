/** Render only the existing pet artwork, never a page screenshot or user content. */
export async function renderAssistantPetFrame(element: HTMLElement): Promise<string> {
  const artwork = element.querySelector<HTMLImageElement>('img')
  const vector = element.querySelector<SVGElement>('.assistant-pet-orb')
  const copy = vector?.cloneNode(true) as SVGElement | undefined
  copy?.setAttribute('width', '176')
  copy?.setAttribute('height', '176')
  const source =
    artwork?.src ||
    (copy
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`
      : '')
  if (!source || (!source.startsWith('blob:') && !source.startsWith('data:image/svg+xml;')))
    return ''
  const image = new Image()
  image.src = source
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = 176
  canvas.height = 176
  const context = canvas.getContext('2d')
  if (!context) return ''
  context.drawImage(image, 0, 0, 176, 176)
  const data = canvas.toDataURL('image/png')
  return data.length <= 256 * 1024 ? data : ''
}
