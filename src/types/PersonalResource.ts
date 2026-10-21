import { RESOURCE_TYPE } from './Resource'
import { isRecord } from '../utils/UnknownValue'
import { isValidFolderCoverImage } from '../utils/FolderCover'

export type PhoneIconSource = 'website' | 'source' | 'apk' | 'image' | 'url'
export interface PhoneIcon {
  source: PhoneIconSource
  dataUrl: string
  origin: string
}

export type PersonalResourceKind = 'extraStory' | 'pocketPhone' | 'secret'
export interface SecretField {
  id: string
  label: string
  value: string
  private: boolean
}
export interface SecretEnvelope {
  salt: string
  iterations: number
  iv: string
  data: string
}
export interface PersonalResourceDocument {
  format: 'srl-personal-resource'
  version: 1
  kind: PersonalResourceKind
  name: string
  text: string
  url: string
  attachments: Array<{ path: string; name: string; kind: 'apk' | 'source'; size: number }>
  fields: SecretField[]
  /** Explicit user choice; absent on legacy/encrypted cards. */
  protection?: 'none'
  protected?: SecretEnvelope
  icons?: PhoneIcon[]
  iconSource?: PhoneIconSource
}

export function isPersonalResourceType(type: string): type is PersonalResourceKind {
  return [RESOURCE_TYPE.EXTRA_STORY, RESOURCE_TYPE.POCKET_PHONE, RESOURCE_TYPE.SECRET].some(
    (item) => item === type,
  )
}

export function parsePersonalResource(value: unknown): PersonalResourceDocument {
  if (
    !isRecord(value) ||
    value.format !== 'srl-personal-resource' ||
    value.version !== 1 ||
    typeof value.kind !== 'string' ||
    !isPersonalResourceType(value.kind) ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 160 ||
    typeof value.text !== 'string' ||
    value.text.length > 1_000_000 ||
    typeof value.url !== 'string' ||
    !Array.isArray(value.attachments) ||
    value.attachments.length > 10000 ||
    !Array.isArray(value.fields) ||
    value.fields.length > 100
  )
    throw new Error('个人资源格式无效')
  if (value.url) {
    const url = new URL(value.url)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new Error('小手机链接只支持不含账号密码的 HTTP/HTTPS 地址')
  }
  const paths = new Set<string>()
  if (value.icons !== undefined) {
    if (value.kind !== 'pocketPhone' || !Array.isArray(value.icons) || value.icons.length > 5)
      throw new Error('小手机图标格式无效')
    const sources = new Set<string>()
    for (const icon of value.icons) {
      if (
        !isRecord(icon) ||
        typeof icon.source !== 'string' ||
        !['website', 'source', 'apk', 'image', 'url'].includes(icon.source) ||
        sources.has(icon.source) ||
        typeof icon.dataUrl !== 'string' ||
        !isValidFolderCoverImage(icon.dataUrl) ||
        typeof icon.origin !== 'string' ||
        icon.origin.length > 2048
      )
        throw new Error('小手机图标格式无效')
      sources.add(icon.source)
    }
    if (value.iconSource !== undefined && !sources.has(String(value.iconSource)))
      throw new Error('选中的小手机图标不存在')
  } else if (value.iconSource !== undefined) throw new Error('选中的小手机图标不存在')
  for (const item of value.attachments) {
    if (
      !isRecord(item) ||
      typeof item.path !== 'string' ||
      !/^attachments\/[a-z0-9/-]+$/i.test(item.path) ||
      paths.has(item.path) ||
      typeof item.name !== 'string' ||
      !item.name ||
      item.name.split(/[\\/]/).some((part) => part === '..') ||
      !['apk', 'source'].includes(String(item.kind)) ||
      !Number.isSafeInteger(item.size) ||
      Number(item.size) < 0
    )
      throw new Error('附件清单无效')
    paths.add(item.path)
  }
  const ids = new Set<string>()
  for (const field of value.fields) {
    if (
      !isRecord(field) ||
      typeof field.id !== 'string' ||
      ids.has(field.id) ||
      typeof field.label !== 'string' ||
      typeof field.value !== 'string' ||
      field.value.length > 100000 ||
      typeof field.private !== 'boolean'
    )
      throw new Error('密钥字段格式无效')
    ids.add(field.id)
  }
  if (
    value.protection !== undefined &&
    (value.protection !== 'none' || value.kind !== 'secret' || value.protected)
  )
    throw new Error('密钥保护方式无效')
  if (
    value.protected &&
    (!isRecord(value.protected) ||
      value.protected.iterations !== 310_000 ||
      !['salt', 'iv', 'data'].every(
        (key) =>
          typeof value.protected === 'object' &&
          typeof (value.protected as Record<string, unknown>)[key] === 'string',
      ))
  )
    throw new Error('密钥加密格式无效')
  if (value.kind !== 'secret' && (value.protected || value.fields.length))
    throw new Error('私密字段只能保存在密钥资源中')
  if (value.kind !== 'pocketPhone' && value.attachments.length)
    throw new Error('仅小手机资源支持附件')
  return value as unknown as PersonalResourceDocument
}
