import { localCredentialStore, type LocalCredentialRepository } from './LocalCredentialStore'
import {
  isNativeSecurityAvailable,
  saveNativeSecretRecovery,
  recoverNativeSecretPassword,
} from '../core/NativeSecurity'
import type {
  PersonalResourceDocument,
  SecretEnvelope,
  SecretField,
} from '../types/PersonalResource'

const ITERATIONS = 310_000
const CONFIG_ID = 'personal-resources.password'
const VERIFIER = 'srl-personal-resources-v1'
const encoder = new TextEncoder()
export interface SecretBrowserTransfer {
  key: string
  iv: string
  data: string
}
function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
}
async function importKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** Password-protected portable payload; no plaintext private values in Resource metadata or indexes. */
export class SecretResourceService {
  private readonly credentials: LocalCredentialRepository
  private sessionPassword = ''
  private readonly rememberedPasswords = new Map<string, string>()
  private sessionGeneration = 0
  constructor(credentials: LocalCredentialRepository = localCredentialStore) {
    this.credentials = credentials
  }

  private async derive(password: string, salt: string): Promise<Uint8Array<ArrayBuffer>> {
    const material = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveBits'],
    )
    return new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: bytes(salt), iterations: ITERATIONS },
        material,
        256,
      ),
    )
  }

  private async seal(
    text: string,
    raw: Uint8Array<ArrayBuffer>,
    salt: string,
  ): Promise<SecretEnvelope> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(VERIFIER) },
      await importKey(raw),
      encoder.encode(text),
    )
    return { salt, iterations: ITERATIONS, iv: base64(iv), data: base64(new Uint8Array(data)) }
  }

  private async open(value: SecretEnvelope, raw: Uint8Array<ArrayBuffer>): Promise<string> {
    if (
      value.iterations !== ITERATIONS ||
      bytes(value.salt).length !== 16 ||
      bytes(value.iv).length !== 12
    )
      throw new Error('密钥加密格式无效')
    try {
      return new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: bytes(value.iv), additionalData: encoder.encode(VERIFIER) },
          await importKey(raw),
          bytes(value.data),
        ),
      )
    } catch {
      throw new Error('密码不正确或加密内容已损坏')
    }
  }

  async hasPassword(): Promise<boolean> {
    return Boolean(await this.credentials.read(CONFIG_ID))
  }

  isUnlocked(): boolean {
    return Boolean(this.sessionPassword)
  }
  hasRememberedPassword(document: PersonalResourceDocument): boolean {
    return Boolean(document.protected && this.rememberedPasswords.has(document.protected.salt))
  }
  /** Consume the verified local password without exposing it through UI state. */
  async withUnlockedPassword<T>(consume: (password: string) => Promise<T>): Promise<T> {
    if (!this.sessionPassword) throw new Error('请先解锁统一密码')
    return consume(this.sessionPassword)
  }
  private checkSession(generation: number): void {
    if (generation !== this.sessionGeneration) throw new Error('统一密码已锁定，请重新解锁')
  }
  /** One local encrypted transfer. Only the consumer sees plaintext; never return it to tools. */
  async receiveBrowserSecret(
    capture: (publicKey: string) => Promise<SecretBrowserTransfer>,
    consume: (secret: string) => Promise<void>,
  ): Promise<void> {
    if (!this.isUnlocked()) throw new Error('请先解锁统一密码')
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      false,
      ['encrypt', 'decrypt'],
    )
    const publicKey = base64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)))
    const transfer = await capture(publicKey)
    if (!this.isUnlocked()) throw new Error('统一密码已锁定，密钥未保存')
    if (
      [transfer.key, transfer.iv, transfer.data].some(
        (value) => typeof value !== 'string' || value.length > 4096,
      )
    )
      throw new Error('本机密钥转填格式无效')
    let raw: Uint8Array<ArrayBuffer> | undefined
    let plain: Uint8Array<ArrayBuffer> | undefined
    try {
      raw = new Uint8Array(
        await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, pair.privateKey, bytes(transfer.key)),
      )
      if (raw.length !== 32 || bytes(transfer.iv).length !== 12)
        throw new Error('本机密钥转填格式无效')
      plain = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: bytes(transfer.iv),
            additionalData: encoder.encode('srl-discord-bot-transfer-v1'),
          },
          await importKey(raw),
          bytes(transfer.data),
        ),
      )
      await consume(new TextDecoder().decode(plain))
    } finally {
      raw?.fill(0)
      plain?.fill(0)
    }
  }
  lock(): void {
    this.sessionGeneration++
    this.sessionPassword = ''
    this.rememberedPasswords.clear()
  }

  /** Only the general settings screen establishes the shared password. Never replace a verifier. */
  async setPassword(password: string): Promise<void> {
    const generation = this.sessionGeneration
    if (await this.hasPassword()) throw new Error('已设置统一密码，请使用原密码解锁')
    if (password.length < 8) throw new Error('统一密码至少需要 8 个字符')
    const salt = base64(crypto.getRandomValues(new Uint8Array(16)))
    const raw = await this.derive(password, salt)
    try {
      const verifier = JSON.stringify(await this.seal(VERIFIER, raw, salt))
      await this.credentials.save(CONFIG_ID, verifier)
      if ((await this.credentials.read(CONFIG_ID)) !== verifier)
        throw new Error('统一密码保存后未能读回确认，请重新打开密码设置核对；原有密钥内容未修改')
      this.checkSession(generation)
      this.sessionPassword = password
    } finally {
      raw.fill(0)
    }
  }

  async unlock(password: string): Promise<void> {
    const generation = this.sessionGeneration
    const saved = await this.credentials.read(CONFIG_ID)
    if (!saved) throw new Error('请先在总设置中设置密钥统一密码')
    const config: SecretEnvelope = JSON.parse(saved)
    const raw = await this.derive(password, config.salt)
    try {
      if ((await this.open(config, raw)) !== VERIFIER) throw new Error('统一密码不正确')
      this.checkSession(generation)
      this.sessionPassword = password
    } finally {
      raw.fill(0)
    }
  }

  async enableRecovery(password: string): Promise<void> {
    if (!isNativeSecurityAvailable()) throw new Error('指纹找回仅支持安卓 APK')
    await this.unlock(password)
    await saveNativeSecretRecovery(password)
  }

  async recoverPassword(): Promise<string> {
    if (!isNativeSecurityAvailable()) throw new Error('指纹找回仅支持安卓 APK')
    const password = await recoverNativeSecretPassword()
    await this.unlock(password)
    return password
  }

  async protect(
    document: PersonalResourceDocument,
    password = this.sessionPassword,
  ): Promise<PersonalResourceDocument> {
    const generation = this.sessionGeneration
    const privateFields = document.fields.filter((field) => field.private)
    if (!privateFields.length) return { ...document, protected: undefined }
    const saved = await this.credentials.read(CONFIG_ID)
    if (!saved) throw new Error('请先在总设置中设置密钥统一密码')
    if (!password) throw new Error('请先输入统一密码解锁')
    const config: SecretEnvelope = JSON.parse(saved)
    const salt = config.salt
    const raw = await this.derive(password, salt)
    try {
      if ((await this.open(config, raw)) !== VERIFIER) throw new Error('统一密码不正确')
      const protectedValue = await this.seal(JSON.stringify(privateFields), raw, salt)
      this.checkSession(generation)
      this.sessionPassword = password
      return {
        ...document,
        protection: undefined,
        fields: document.fields.map((field) => (field.private ? { ...field, value: '' } : field)),
        protected: protectedValue,
      }
    } finally {
      raw.fill(0)
    }
  }

  private revealed(document: PersonalResourceDocument, text: string): SecretField[] {
    const values: unknown = JSON.parse(text)
    if (!Array.isArray(values)) throw new Error('密钥内容无效')
    return document.fields.map((field) => {
      if (!field.private) return field
      const stored = values.find((item) => item && item.id === field.id)
      if (!stored || typeof stored.value !== 'string') throw new Error('密钥字段不完整')
      return { ...field, value: stored.value }
    })
  }

  async reveal(document: PersonalResourceDocument, password?: string): Promise<SecretField[]> {
    if (!document.protected) return document.fields.map((field) => ({ ...field }))
    const generation = this.sessionGeneration
    const salt = document.protected.salt
    const resolved = password ?? this.rememberedPasswords.get(salt) ?? this.sessionPassword
    const raw = await this.derive(resolved, salt)
    try {
      const fields = this.revealed(document, await this.open(document.protected, raw))
      // Foreign backups may use another password; do not replace the local shared session.
      this.checkSession(generation)
      if (resolved !== this.sessionPassword && !this.rememberedPasswords.has(salt))
        await this.unlock(resolved).catch(() => undefined)
      this.checkSession(generation)
      this.rememberedPasswords.delete(salt)
      this.rememberedPasswords.set(salt, resolved)
      if (this.rememberedPasswords.size > 16)
        this.rememberedPasswords.delete(this.rememberedPasswords.keys().next().value!)
      return fields
    } finally {
      raw.fill(0)
    }
  }

  async revealBiometric(document: PersonalResourceDocument): Promise<SecretField[]> {
    return this.reveal(document, await this.recoverPassword())
  }
}

export const secretResourceService = new SecretResourceService()
