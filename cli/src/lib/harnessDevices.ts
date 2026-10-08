import { z } from 'zod'
import { DEVICE_ASSETS, type DeviceAssetKind, type DeviceSettingsPatch, type DialStatus } from '../cable/cableSession.js'

export interface HarnessDevicesService {
  status(): DialStatus
  revision?(): number
  set(id: string, patch: DeviceSettingsPatch): Promise<{ ok: boolean; error?: string }>
  sound?(id: string, name: string, bytes: Uint8Array | null): Promise<{ ok: boolean; error?: string }>
  character?(id: string, name: string, bytes: Uint8Array | null): Promise<{ ok: boolean; error?: string }>
  test?(id: string, kind: DeviceAssetKind): Promise<{ ok: boolean; error?: string }>
}

export const deviceSettingsPatchSchema = z.object({
  brightness: z.number().int().min(0).max(100).optional(),
  muted: z.boolean().optional(),
  quiet: z.boolean().optional(),
  scrollReversed: z.boolean().optional(),
  voiceLang: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).optional(),
  character: z.number().int().min(0).max(255).optional(),
  straightTitle: z.boolean().optional(),
  focusFace: z.boolean().optional(),
  followCompanion: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0)
const change = z.object({ id: z.string().min(1).max(256), patch: deviceSettingsPatchSchema })

/** The authenticated connection selects the host; payloads only select its USB device. */
export async function harnessDevicesRequest(
  service: HarnessDevicesService | null, type: string, payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!service) return { error: 'UNSUPPORTED' }
  if (type === 'harness_devices_list') return { protocol: 1, revision: service.revision?.() ?? 0, status: service.status() }
  if (type === 'harness_device_test') return testAsset(service, payload)
  const asset = ASSET_REQUESTS[type]
  if (asset) return installAsset(service, asset, payload)
  const parsed = change.safeParse({ id: payload.id, patch: payload.patch })
  if (!parsed.success) return { error: 'BAD_DEVICE_SETTINGS' }
  const snapshot = service.status()
  const device = (snapshot.devices ?? [snapshot]).find(item => item.id === parsed.data.id)
  if (!device?.attached) return { error: 'DEVICE_OFFLINE' }
  if (device.updating) return { error: 'DEVICE_UPDATING' }
  if (!device.settings) return { error: 'DEVICE_NOT_READY' }
  const sent = await service.set(parsed.data.id, parsed.data.patch)
  if (!sent.ok) return { error: 'DEVICE_WRITE_FAILED' }
  // Acceptance is not firmware acknowledgment. The subsequent status event
  // reports what the device actually holds, including a refused setting.
  return { ok: true, revision: service.revision?.() ?? 0, status: service.status() }
}

/**
 * The test button: the device plays its sound, or shows its character, as installed. The device's own refusal
 * (muted, asleep, another face) comes back as `message` beside `ok: false`, to be shown as it is.
 */
async function testAsset(service: HarnessDevicesService, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { id, kind } = payload
  if (typeof id !== 'string' || !id || id.length > 256 || (kind !== 'sound' && kind !== 'character'))
    return { error: 'BAD_DEVICE_TEST' }
  const device = (service.status().devices ?? [service.status()]).find(item => item.id === id)
  if (!device?.attached) return { error: 'DEVICE_OFFLINE' }
  if (device.updating) return { error: 'DEVICE_UPDATING' }
  const reported = kind === 'sound' ? device.settings?.soundName : device.settings?.characterName
  if (reported === undefined || !service.test) return { error: 'UNSUPPORTED' }
  const result = await service.test(id, kind)
  return result.ok ? { ok: true } : { ok: false, message: result.error ?? `The device could not test its ${kind}.` }
}

/** The requests that install what the owner chose (or, with `data: null`, restore the device's default). */
const ASSET_REQUESTS: Record<string, { kind: DeviceAssetKind; bad: string }> = {
  harness_device_sound: { kind: 'sound', bad: 'BAD_DEVICE_SOUND' },
  harness_device_character: { kind: 'character', bad: 'BAD_DEVICE_CHARACTER' },
}

async function installAsset(
  service: HarnessDevicesService, { kind, bad }: { kind: DeviceAssetKind; bad: string }, payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = payload.id, name = payload.name, data = payload.data
  const maxBytes = DEVICE_ASSETS[kind].maxBytes
  if (typeof id !== 'string' || !id || id.length > 256 ||
      typeof name !== 'string' || name.length > 31 ||
      (data !== null && (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) ||
                         data.length > Math.ceil(maxBytes / 3) * 4)))
    return { error: bad }
  const bytes = data === null ? null : Buffer.from(data as string, 'base64')
  if ((bytes && (!bytes.length || bytes.length > maxBytes || bytes.toString('base64') !== data)) ||
      (bytes && (!name || !/^[\x20-\x7e]+$/.test(name)))) return { error: bad }
  const device = (service.status().devices ?? [service.status()]).find(item => item.id === id)
  if (!device?.attached) return { error: 'DEVICE_OFFLINE' }
  if (device.updating) return { error: 'DEVICE_UPDATING' }
  const reported = kind === 'sound' ? device.settings?.soundName : device.settings?.characterName
  const install = kind === 'sound' ? service.sound : service.character
  if (reported === undefined || !install) return { error: 'UNSUPPORTED' }
  const result = await install.call(service, id, name, bytes)
  return result.ok ? { ok: true, revision: service.revision?.() ?? 0, status: service.status() }
    : { error: result.error ?? 'DEVICE_WRITE_FAILED' }
}
