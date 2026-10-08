/** Devices DSH tools use the same owned-machine bridge as Desktop. No serial or credential access. */
import { randomUUID } from 'node:crypto'
import type { ClientSocket } from '../lib/clientSocket.js'
import { readFile } from 'node:fs/promises'
import { deviceSettingsPatchSchema } from '../lib/harnessDevices.js'
import { LONG_ANSWERS } from '../core/api.js'
import { assetName, buildCharacter, CHARACTER_ROLES, decodePng, prepareSound, type CharacterRole, type SheetChoice } from './assets.js'

export interface DevicesClientDeps {
  port: number
  machineId(): Promise<string | null>
  connect(url: string): ClientSocket
  fetch?: typeof fetch
  request?: (machineId: string, type: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>
  delay?: (ms: number) => Promise<void>
}

export function deviceRequest(deps: DevicesClientDeps, machineId: string, type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const wait = 12_000 + (LONG_ANSWERS.devices?.[type] ?? 0)
  return new Promise((resolve, reject) => {
    const socket = deps.connect(`ws://127.0.0.1:${deps.port}/api/local-ws`)
    const requestId = randomUUID()
    let settled = false, sent = false
    const finish = (error: Error | null, reply?: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* already closed */ }
      if (error) reject(error); else resolve(reply!)
    }
    const timer = setTimeout(() => finish(new Error('This computer did not answer in time.')), wait)
    socket.on('open', () => socket.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1, tool: true } })))
    socket.on('error', error => finish(error))
    socket.on('close', code => finish(new Error(code === 4404 ? 'Link this computer in Machines first.' : 'The computer disconnected.')))
    socket.on('message', data => {
      let frame: { type?: string; payload?: Record<string, unknown> }
      try { frame = JSON.parse(data.toString()) } catch { return }
      if (frame.type === 'connected' && !sent) {
        sent = true
        socket.send(JSON.stringify({ type, payload: { ...payload, requestId } }))
      }
      if (frame.type === `${type}_result` && frame.payload?.requestId === requestId) {
        const { requestId: _id, ...reply } = frame.payload
        finish(null, reply)
      }
    })
  })
}

export const DEVICES_USAGE = `harness hardware — your Harness hardware across computers
  list [--json]                                      read owned computers and devices
  set --machine ID --device ID --patch JSON [--json]  change only the supplied settings
  sound [--machine ID] [--device ID] (FILE | --restore)
                                                     install any audio file as the finished-task sound
  character [--machine ID] [--device ID] (--thinking PNG --tool PNG --idle PNG | --restore)
            [--name NAME] [--row N] [--frame WxH] [--ms N]
                                                     install sprite sheets as the device's character;
                                                     --thinking-row, --tool-ms ... set one animation
--machine defaults to this computer and --device to its only plugged-in device.
Offline computers never receive queued changes. A write is complete only when confirmed.`

interface Host { machineId: string; name: string; online: boolean }
async function ownedHosts(deps: DevicesClientDeps): Promise<Host[]> {
  const localId = await deps.machineId()
  if (!localId) throw new Error('Start Harness on this computer first.')
  const response = await (deps.fetch ?? fetch)(`http://127.0.0.1:${deps.port}/api/machines`, {
    headers: { 'x-adapter-local': '1' }, signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error('Could not read the account’s computers. Sign in and try again.')
  const body = await response.json() as { data?: { machines?: Record<string, unknown>[] }; machines?: Record<string, unknown>[] }
  const rows = body.data?.machines ?? body.machines
  if (!Array.isArray(rows)) throw new Error('Harness returned an invalid computer list.')
  const hosts = rows.filter(row => typeof row.machineId === 'string' && !row.isShared).map(row => ({
    machineId: row.machineId as string,
    name: String(row.name || row.hostname || row.machineId),
    online: row.machineId === localId || row.status === 'running',
  }))
  if (!hosts.some(host => host.machineId === localId)) hosts.unshift({ machineId: localId, name: 'This computer', online: true })
  return hosts
}

function observed(reply: Record<string, unknown>, id: string): Record<string, unknown> | undefined {
  const status = reply.status as { devices?: Record<string, unknown>[]; id?: string } | undefined
  return (status?.devices ?? (status ? [status] : [])).find(device => device.id === id)
}

/** Separate from printing so the exact routing and confirmation path is testable. */
export async function devicesCommand(argv: string[], deps: DevicesClientDeps): Promise<Record<string, unknown>> {
  const words = argv.filter(word => word !== '--json')
  const command = words.shift() ?? 'list'
  if (command === 'help' || command === '--help') return { help: DEVICES_USAGE }
  if (command === 'sound' || command === 'character') return assetCommand(command, words, deps)
  if (command !== 'list' && command !== 'set') throw new Error(DEVICES_USAGE)
  const options: Record<string, string> = {}
  if (command === 'list' && words.length) throw new Error(DEVICES_USAGE)
  for (let i = 0; i < words.length; i += 2) {
    const key = words[i]!
    if (!['--machine', '--device', '--patch'].includes(key) || !words[i + 1] || key in options) throw new Error(DEVICES_USAGE)
    options[key] = words[i + 1]!
  }
  let patch: Record<string, unknown> | undefined
  if (command === 'set') {
    if (!options['--machine'] || !options['--device'] || !options['--patch']) throw new Error(DEVICES_USAGE)
    patch = deviceSettingsPatchSchema.parse(JSON.parse(options['--patch']))
  }
  const hosts = await ownedHosts(deps)
  const request = deps.request ?? ((id, type, payload) => deviceRequest(deps, id, type, payload))
  if (command === 'list') {
    return { hosts: await Promise.all(hosts.map(async host => {
      if (!host.online) return { ...host, available: false }
      try {
        const reply = await request(host.machineId, 'harness_devices_list')
        return { ...host, available: !reply.error, ...reply }
      } catch (error) { return { ...host, available: false, error: error instanceof Error ? error.message : 'Unavailable' } }
    })) }
  }
  const host = hosts.find(host => host.machineId === options['--machine'])
  if (!host) throw new Error('That computer is not owned by this account.')
  if (!host.online) throw new Error('That computer is offline. No change was sent.')
  const id = options['--device']!
  let reply = await request(host.machineId, 'harness_device_settings', { id, patch })
  if (reply.error || reply.ok !== true) return { ...reply, confirmed: false }
  const delay = deps.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  for (let attempt = 0; attempt < 13; attempt++) {
    const device = observed(reply, id)
    const values = device?.settings as Record<string, unknown> | undefined
    if (device?.attached === true && !device.updating && values && Object.entries(patch!).every(([key, value]) => values[key] === value)) {
      return { ok: true, confirmed: true, machineId: host.machineId, id, settings: values }
    }
    if (reply.error || device?.attached === false || device?.updating || attempt === 12) break
    await delay(500)
    reply = await request(host.machineId, 'harness_devices_list')
  }
  return { ok: false, accepted: true, confirmed: false, machineId: host.machineId, id,
    error: 'The device has not confirmed the change. Refresh Devices before trying again.' }
}

export async function runDevicesCommand(argv: string[], deps: DevicesClientDeps): Promise<number> {
  try {
    const result = await devicesCommand(argv, deps)
    console.log(result.help ?? JSON.stringify(result, null, argv.includes('--json') ? undefined : 2))
    return result.error ? 1 : 0
  } catch (error) {
    console.log(JSON.stringify({ error: error instanceof Error ? error.message : 'Device request failed.', confirmed: false }))
    return 1
  }
}

/** `sound` and `character`: convert here, send to the owning computer, and report what the device then holds. */
async function assetCommand(kind: 'sound' | 'character', words: string[], deps: DevicesClientDeps): Promise<Record<string, unknown>> {
  const options: Record<string, string> = {}
  const files: string[] = []
  let restore = false
  const valued = ['--machine', '--device', '--name', '--row', '--frame', '--ms',
    ...CHARACTER_ROLES.flatMap(role => [`--${role}`, `--${role}-row`, `--${role}-frame`, `--${role}-ms`])]
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (word === '--restore') restore = true
    else if (valued.includes(word) && words[i + 1] && !(word in options)) options[word] = words[++i]!
    else if (!word.startsWith('--') && kind === 'sound') files.push(word)
    else throw new Error(DEVICES_USAGE)
  }
  const roles = CHARACTER_ROLES.filter(role => options[`--${role}`])
  if (kind === 'sound' ? restore === (files.length === 1) || files.length > 1 : restore === roles.length > 0)
    throw new Error(DEVICES_USAGE)

  let name = '', data: string | null = null, summary: Record<string, unknown> = {}
  if (kind === 'sound' && !restore) {
    const sound = await prepareSound(files[0]!)
    name = options['--name'] ?? sound.name
    data = Buffer.from(sound.bytes).toString('base64')
    summary = { seconds: Math.round(sound.bytes.length / 160) / 100 }
  } else if (kind === 'character' && !restore) {
    const number = (text: string | undefined, what: string) => {
      if (text === undefined) return undefined
      if (!/^\d+$/.test(text)) throw new Error(`${what} must be a whole number.`)
      return Number(text)
    }
    const sheets: Partial<Record<CharacterRole, SheetChoice>> = {}
    for (const role of roles) {
      const frame = options[`--${role}-frame`] ?? options['--frame']
      const size = frame?.match(/^(\d+)x(\d+)$/)
      if (frame && !size) throw new Error('--frame is WIDTHxHEIGHT in pixels, for example 64x64.')
      sheets[role] = {
        image: decodePng(await readFile(options[`--${role}`]!)),
        row: number(options[`--${role}-row`] ?? options['--row'], '--row'),
        stepMs: number(options[`--${role}-ms`] ?? options['--ms'], '--ms'),
        ...(size ? { frameWidth: Number(size[1]), frameHeight: Number(size[2]) } : {}),
      }
    }
    const built = buildCharacter(sheets)
    name = options['--name'] ?? assetName(options[`--${roles[0]}`]!, 'Custom character')
    data = Buffer.from(built.bytes).toString('base64')
    summary = { roles: built.roles, colours: built.colours, bytes: built.bytes.length }
  }
  if (name.length > 31 || !/^[\x20-\x7e]*$/.test(name)) throw new Error('--name is at most 31 plain characters.')

  const hosts = await ownedHosts(deps)
  const request = deps.request ?? ((id, type, payload) => deviceRequest(deps, id, type, payload))
  const machineId = options['--machine'] ?? await deps.machineId()
  const host = hosts.find(item => item.machineId === machineId)
  if (!host) throw new Error('That computer is not owned by this account.')
  if (!host.online) throw new Error('That computer is offline. Nothing was sent.')
  let id = options['--device']
  if (!id) {
    const listed = await request(host.machineId, 'harness_devices_list')
    const status = listed.status as Record<string, unknown> & { devices?: Record<string, unknown>[] } | undefined
    const attached = (status?.devices ?? (status ? [status] : [])).filter(device => device.attached === true)
    if (attached.length !== 1)
      throw new Error(attached.length ? 'Several devices are plugged in. Choose one with --device.' : 'No device is plugged into that computer.')
    id = String(attached[0]!.id)
  }
  const reply = await request(host.machineId, `harness_device_${kind}`, { id, name, data })
  if (reply.error || reply.ok !== true) return { ...reply, ...summary, installed: false }
  const settings = observed(reply, id)?.settings as Record<string, unknown> | undefined
  return { ok: true, machineId: host.machineId, id, ...summary,
    installed: restore ? 'default' : settings?.[`${kind}Name`] ?? name }
}
