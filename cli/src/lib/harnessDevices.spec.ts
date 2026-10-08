import { describe, expect, it, vi } from 'vitest'
import { harnessDevicesRequest, type HarnessDevicesService } from './harnessDevices.js'
import type { DialStatus, DeviceSettings } from '../cable/cableSession.js'
import { encryptDownFrame, encryptRpcResult } from './e2ee/applicationFrames.js'
import { ENCRYPTED_UP_TYPES } from './e2ee/core.js'

const settings: DeviceSettings = { brightness: 80, muted: false, quiet: false, character: 2,
  face: 466, round: true, voiceLang: 'en', scrollReversed: false, straightTitle: true, focusFace: false }
describe('owner device management', () => {
  const fixture = () => {
    const devices: DialStatus[] = [
      { id: 'usb-a', attached: true, settings },
      { id: 'usb-b', attached: true, settings },
      { id: 'offline', attached: false, settings },
      { id: 'updating', attached: true, settings, updating: 'next' },
    ]
    const set = vi.fn(async () => ({ ok: true }))
    const service: HarnessDevicesService = { status: () => ({ attached: true, devices }), revision: () => 4, set }
    return { service, set }
  }
  it('reads the whole host and sends a sparse patch only to the named device', async () => {
    const { service, set } = fixture()
    expect(await harnessDevicesRequest(service, 'harness_devices_list', {})).toMatchObject({ protocol: 1, revision: 4, status: { devices: expect.any(Array) } })
    const reply = await harnessDevicesRequest(service, 'harness_device_settings', { id: 'usb-b', patch: { brightness: 35 } })
    expect(set).toHaveBeenCalledExactlyOnceWith('usb-b', { brightness: 35 })
    expect(reply).toMatchObject({ ok: true, status: { devices: [{ settings: { brightness: 80 } }, { settings: { brightness: 80 } }, {}, {}] } })
  })
  it('refuses missing, disconnected, updating and invalid targets without a write', async () => {
    const { service, set } = fixture()
    for (const id of ['missing', 'offline']) expect(await harnessDevicesRequest(service, 'harness_device_settings', { id, patch: { muted: true } })).toMatchObject({ error: 'DEVICE_OFFLINE' })
    expect(await harnessDevicesRequest(service, 'harness_device_settings', { id: 'updating', patch: { muted: true } })).toMatchObject({ error: 'DEVICE_UPDATING' })
    for (const patch of [{ brightness: 101 }, { id: 'usb-a' }, { face: 720 }, {}, { muted: 'true' }]) {
      expect(await harnessDevicesRequest(service, 'harness_device_settings', { id: 'usb-b', patch })).toMatchObject({ error: 'BAD_DEVICE_SETTINGS' })
    }
    expect(set).not.toHaveBeenCalled()
  })
  it('does not report a failed cable delivery as success', async () => {
    const { service, set } = fixture()
    set.mockResolvedValue({ ok: false })
    expect(await harnessDevicesRequest(service, 'harness_device_settings', { id: 'usb-a', patch: { muted: true } })).toMatchObject({ error: 'DEVICE_WRITE_FAILED' })
  })
  it('encrypts requests, replies and device snapshots over remote relays', () => {
    for (const type of ['harness_devices_list', 'harness_device_settings', 'harness_device_sound', 'harness_device_character', 'harness_device_test']) {
      expect(encryptDownFrame(type)).toBe(true)
      expect(encryptRpcResult(`${type}_result`)).toBe(true)
    }
    expect(ENCRYPTED_UP_TYPES.has('harness_devices_changed')).toBe(true)
  })
  it('installs a character only on firmware that reports one, within its slot', async () => {
    const { service } = fixture()
    const character = vi.fn(async () => ({ ok: true }))
    service.character = character
    service.status = () => ({ attached: true, devices: [
      { id: 'new', attached: true, settings: { ...settings, soundName: '', soundBytes: 0, characterName: '', characterBytes: 0 } },
      { id: 'sound-only', attached: true, settings: { ...settings, soundName: '', soundBytes: 0 } },
    ] })
    const data = Buffer.from([1, 2, 3]).toString('base64')
    expect(await harnessDevicesRequest(service, 'harness_device_character', { id: 'sound-only', name: 'Knight', data })).toMatchObject({ error: 'UNSUPPORTED' })
    expect(await harnessDevicesRequest(service, 'harness_device_character', { id: 'gone', name: 'Knight', data })).toMatchObject({ error: 'DEVICE_OFFLINE' })
    for (const invalid of ['', 'a', Buffer.alloc(0x80000 - 79).toString('base64')])
      expect(await harnessDevicesRequest(service, 'harness_device_character', { id: 'new', name: 'Knight', data: invalid })).toMatchObject({ error: 'BAD_DEVICE_CHARACTER' })
    expect(await harnessDevicesRequest(service, 'harness_device_character', { id: 'new', name: '\u00e9', data })).toMatchObject({ error: 'BAD_DEVICE_CHARACTER' })
    const largest = Buffer.alloc(0x80000 - 80, 9)
    expect(await harnessDevicesRequest(service, 'harness_device_character', { id: 'new', name: 'Knight', data: largest.toString('base64') })).toMatchObject({ ok: true })
    expect(character).toHaveBeenLastCalledWith('new', 'Knight', largest)
    expect(await harnessDevicesRequest(service, 'harness_device_character', { id: 'new', name: '', data: null })).toMatchObject({ ok: true })
    expect(character).toHaveBeenLastCalledWith('new', '', null)
  })

  it('accepts only bounded sound data for a capable, addressed device', async () => {
    const { service } = fixture()
    const sound = vi.fn(async () => ({ ok: true }))
    service.sound = sound
    service.status = () => ({ attached: true, devices: [
      { id: 'usb-a', attached: true, settings: { ...settings, soundName: '', soundBytes: 0 } },
      { id: 'usb-b', attached: true, settings },
      { id: 'updating', attached: true, updating: 'next', settings: { ...settings, soundName: '' } },
    ] })
    const data = Buffer.from([0, 127, 255]).toString('base64')
    expect(await harnessDevicesRequest(service, 'harness_device_sound', { id: 'usb-b', name: 'Bell', data })).toMatchObject({ error: 'UNSUPPORTED' })
    expect(await harnessDevicesRequest(service, 'harness_device_sound', { id: 'updating', name: 'Bell', data })).toMatchObject({ error: 'DEVICE_UPDATING' })
    for (const invalid of ['', '@@@=', Buffer.alloc(0x40000 - 79).toString('base64')])
      expect(await harnessDevicesRequest(service, 'harness_device_sound', { id: 'usb-a', name: 'Bell', data: invalid })).toMatchObject({ error: 'BAD_DEVICE_SOUND' })
    expect(await harnessDevicesRequest(service, 'harness_device_sound', { id: 'usb-a', name: 'Bell', data })).toMatchObject({ ok: true })
    expect(sound).toHaveBeenCalledWith('usb-a', 'Bell', Buffer.from([0, 127, 255]))
    expect(await harnessDevicesRequest(service, 'harness_device_sound', { id: 'usb-a', name: '', data: null })).toMatchObject({ ok: true })
    expect(sound).toHaveBeenLastCalledWith('usb-a', '', null)
  })

  it('tests only an addressed device that reports the asset, passing its refusal as a message', async () => {
    const { service } = fixture()
    const test = vi.fn(async (_id: string, kind: string) => kind === 'sound' ? { ok: true } : { ok: false, error: 'The device is muted.' })
    service.test = test
    service.status = () => ({ attached: true, devices: [
      { id: 'new', attached: true, settings: { ...settings, soundName: '', soundBytes: 0, characterName: '', characterBytes: 0 } },
      { id: 'old', attached: true, settings },
      { id: 'updating', attached: true, updating: 'next', settings: { ...settings, soundName: '' } },
    ] })
    expect(await harnessDevicesRequest(service, 'harness_device_test', { id: 'new', kind: 'sound' })).toEqual({ ok: true })
    expect(test).toHaveBeenLastCalledWith('new', 'sound')
    expect(await harnessDevicesRequest(service, 'harness_device_test', { id: 'new', kind: 'character' })).toEqual({ ok: false, message: 'The device is muted.' })
    expect(await harnessDevicesRequest(service, 'harness_device_test', { id: 'old', kind: 'sound' })).toMatchObject({ error: 'UNSUPPORTED' })
    expect(await harnessDevicesRequest(service, 'harness_device_test', { id: 'gone', kind: 'sound' })).toMatchObject({ error: 'DEVICE_OFFLINE' })
    expect(await harnessDevicesRequest(service, 'harness_device_test', { id: 'updating', kind: 'sound' })).toMatchObject({ error: 'DEVICE_UPDATING' })
    for (const bad of [{ id: 'new', kind: 'firmware' }, { id: '', kind: 'sound' }, { kind: 'sound' }])
      expect(await harnessDevicesRequest(service, 'harness_device_test', bad)).toMatchObject({ error: 'BAD_DEVICE_TEST' })
    expect(test).toHaveBeenCalledTimes(2)
  })
})
