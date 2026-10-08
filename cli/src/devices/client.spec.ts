import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { devicesCommand, deviceRequest, type DevicesClientDeps } from './client.js'

const snapshot = (brightness = 80) => ({ status: { devices: [{ id: 'usb', attached: true, settings: { brightness } }] } })
function fixture() {
  const request = vi.fn(async (_id: string, _type: string, _payload?: Record<string, unknown>) => snapshot() as Record<string, unknown>)
  const deps: DevicesClientDeps = {
    port: 18473, machineId: async () => 'local', connect: () => { throw new Error('No real sockets') }, request,
    fetch: vi.fn(async () => new Response(JSON.stringify({ data: { machines: [
      { machineId: 'local', name: 'Studio', status: 'running' },
      { machineId: 'remote', name: 'Office', status: 'running' },
      { machineId: 'offline', name: 'Workshop', status: 'offline' },
      { machineId: 'shared', isShared: true, status: 'running' },
    ] } }))) as typeof fetch,
    delay: async () => {},
  }
  return { deps, request }
}

/** A four-row sheet of 16 px frames, each with a small opaque block: a minimal character to install. */
function sheetFile(dir: string, name: string, columns = 4): string {
  const width = columns * 16, height = 64, rows: number[] = []
  for (let y = 0; y < height; y++) {
    rows.push(0)
    for (let x = 0; x < width; x++) rows.push(...(y % 16 > 4 && y % 16 < 10 && x % 16 > 4 && x % 16 < 10 ? [200, 40, 10, 255] : [0, 0, 0, 0]))
  }
  const chunk = (kind: string, body: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(body.length); head.write(kind, 4, 'latin1')
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(kind, 'latin1'), body])))
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6
  const file = join(dir, name)
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]))
  return file
}

describe('Devices DSH commands', () => {
  it('lists owned hosts, keeps offline presence, and reports unreachable hosts without inventing devices', async () => {
    const { deps, request } = fixture()
    request.mockRejectedValueOnce(new Error('unavailable'))
    const result = await devicesCommand(['list', '--json'], deps)
    expect(result.hosts).toMatchObject([
      { machineId: 'local', available: false, error: 'unavailable' },
      { machineId: 'remote', available: true, status: { devices: [{ id: 'usb' }] } },
      { machineId: 'offline', online: false, available: false },
    ])
    expect(request.mock.calls.map(call => call[0])).toEqual(['local', 'remote'])
  })
  it('targets only the selected host and waits for firmware confirmation', async () => {
    const { deps, request } = fixture()
    request.mockResolvedValueOnce({ ok: true, ...snapshot() }).mockResolvedValueOnce(snapshot(35))
    expect(await devicesCommand(['set', '--machine', 'remote', '--device', 'usb', '--patch', '{"brightness":35}'], deps))
      .toMatchObject({ confirmed: true, machineId: 'remote', id: 'usb', settings: { brightness: 35 } })
    expect(request.mock.calls).toEqual([
      ['remote', 'harness_device_settings', { id: 'usb', patch: { brightness: 35 } }],
      ['remote', 'harness_devices_list'],
    ])
  })
  it('does not turn acceptance into confirmation and never writes offline or shared hosts', async () => {
    const { deps, request } = fixture()
    request.mockResolvedValueOnce({ ok: true, ...snapshot() })
    const args = ['set', '--machine', 'remote', '--device', 'usb', '--patch', '{"brightness":35}']
    expect(await devicesCommand(args, deps)).toMatchObject({ accepted: true, confirmed: false })
    request.mockClear()
    for (const id of ['offline', 'shared', 'unknown']) {
      await expect(devicesCommand([...args.slice(0, 2), id, ...args.slice(3)], deps)).rejects.toThrow()
    }
    await expect(devicesCommand(['set', '--machine', 'remote', '--device', 'usb', '--patch', '{"face":466}'], deps)).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
  it('installs a character on this computer’s only device and reports what the device then holds', async () => {
    const { deps, request } = fixture()
    const dir = mkdtempSync(join(tmpdir(), 'harness-character-'))
    const run = sheetFile(dir, 'Knight_Run.png'), idle = sheetFile(dir, 'Knight_Idle.png', 6)
    request.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce({ ok: true, status: { devices: [
      { id: 'usb', attached: true, settings: { characterName: 'Knight_Run', characterBytes: 1 } }] } })
    const result = await devicesCommand(['character', '--thinking', run, '--idle', idle, '--row', '2', '--idle-ms', '250'], deps)
    expect(result).toMatchObject({ ok: true, machineId: 'local', id: 'usb', installed: 'Knight_Run', colours: 1,
      roles: { thinking: { frames: 4, stepMs: 110 }, idle: { frames: 6, stepMs: 250 } } })
    expect(request.mock.calls[0]).toEqual(['local', 'harness_devices_list'])
    const [machine, type, payload] = request.mock.calls[1]!
    expect([machine, type, payload!.id, payload!.name]).toEqual(['local', 'harness_device_character', 'usb', 'Knight_Run'])
    expect(Buffer.from(payload!.data as string, 'base64').readUInt32LE(0)).toBe(0x31484348)
  })
  it('restores defaults on a named device, and refuses unclear or impossible requests before sending', async () => {
    const { deps, request } = fixture()
    request.mockResolvedValueOnce({ ok: true, ...snapshot() })
    expect(await devicesCommand(['sound', '--machine', 'remote', '--device', 'usb', '--restore'], deps)).toMatchObject({ ok: true, installed: 'default' })
    expect(request.mock.calls).toEqual([['remote', 'harness_device_sound', { id: 'usb', name: '', data: null }]])
    request.mockClear()
    const dir = mkdtempSync(join(tmpdir(), 'harness-character-'))
    const run = sheetFile(dir, 'Run.png')
    for (const args of [['sound'], ['sound', 'a.mp3', '--restore'], ['sound', 'a.mp3', 'b.mp3'], ['character'],
                        ['character', '--restore', '--idle', run], ['character', '--idle', run, '--frame', '16'],
                        ['character', '--idle', run, '--row', 'two'], ['character', '--idle', run, '--row', '9'],
                        ['character', '--idle', run, '--name', 'x'.repeat(32)], ['character', '--idle', run, '--machine', 'offline'],
                        ['character', '--idle', run, '--color', 'red']])
      await expect(devicesCommand(args, deps)).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
    request.mockResolvedValueOnce({ status: { devices: [{ id: 'a', attached: true }, { id: 'b', attached: true }] } })
    await expect(devicesCommand(['character', '--idle', run], deps)).rejects.toThrow('Several devices')
    request.mockResolvedValueOnce({ status: { devices: [{ id: 'a', attached: false }] } })
    await expect(devicesCommand(['character', '--idle', run], deps)).rejects.toThrow('No device')
    request.mockResolvedValueOnce({ error: 'UNSUPPORTED' })
    expect(await devicesCommand(['character', '--idle', run, '--device', 'usb'], deps)).toMatchObject({ error: 'UNSUPPORTED', installed: false })
  })
  it('waits for host selection, correlates the reply, and closes the tool socket', async () => {
    const socket = Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn() })
    const { deps } = fixture()
    deps.connect = () => socket
    const reply = deviceRequest(deps, 'remote', 'harness_devices_list')
    socket.emit('open')
    expect(JSON.parse(socket.send.mock.calls[0]![0])).toMatchObject({ type: 'machine_select', payload: { machineId: 'remote', tool: true, localProtocolVersion: 1 } })
    socket.emit('message', JSON.stringify({ type: 'connected' }))
    const call = JSON.parse(socket.send.mock.calls[1]![0])
    socket.emit('message', JSON.stringify({ type: 'harness_devices_list_result', payload: { requestId: 'wrong', status: 'bad' } }))
    expect(socket.close).not.toHaveBeenCalled()
    socket.emit('message', JSON.stringify({ type: 'harness_devices_list_result', payload: { requestId: call.payload.requestId, ...snapshot() } }))
    expect(await reply).toEqual(snapshot())
    expect(socket.close).toHaveBeenCalledOnce()
  })
})
