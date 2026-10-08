/**
 * What `harness hardware sound|character` installs: the owner's own audio file or sprite sheets, converted here
 * into the bytes the device stores. Desktop's device settings build the same bytes (character_pack.dart,
 * notification_sound_import.dart); test vectors keep the two in step.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'
import { inflateSync } from 'node:zlib'
import { DEVICE_ASSETS } from '../cable/cableSession.js'

const run = promisify(execFile)

/** A name the device stores: printable ASCII, at most 31 characters. */
export function assetName(file: string, fallback: string): string {
  const title = basename(file, extname(file)).replace(/[^\x20-\x7e]/g, '').trim().slice(0, 31).trim()
  return title || fallback
}

// ── sound ────────────────────────────────────────────────────────────────────────────────────────────

export const SOUND_RATE = 16_000
/** Sixteen seconds of 16 kHz mu-law: what one of the device's sound slots holds. */
export const SOUND_MAX_SAMPLES = Math.min(16 * SOUND_RATE, DEVICE_ASSETS.sound.maxBytes)
/** The generated chime peaks here on the same codec path; a louder file is scaled down to it. */
const SOUND_PEAK = 6000
/** Below this at both ends is silence the device need not play. */
const SILENCE = 200

export function encodeMuLaw(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0
  const magnitude = Math.min(Math.abs(sample), 32635) + 132
  let exponent = 7
  for (let mask = 0x4000; exponent > 0 && !(magnitude & mask); mask >>= 1) exponent--
  const mantissa = (magnitude >> (exponent + 3)) & 15
  return ~(sign | (exponent << 4) | mantissa) & 255
}

/** 16 kHz mono 16-bit PCM → the device's clip: ends' silence trimmed, at most 16 s, no louder than the chime. */
export function soundFromPcm(samples: Int16Array): Uint8Array {
  let first = 0, last = samples.length - 1
  while (first <= last && Math.abs(samples[first]!) <= SILENCE) first++
  while (last >= first && Math.abs(samples[last]!) <= SILENCE) last--
  if (first > last) throw new Error('The audio file is silent.')
  const clip = samples.subarray(first, Math.min(last + 1, first + SOUND_MAX_SAMPLES))
  let peak = 0
  for (const sample of clip) peak = Math.max(peak, Math.abs(sample))
  const gain = peak > SOUND_PEAK ? SOUND_PEAK / peak : 1
  return Uint8Array.from(clip, sample => encodeMuLaw(Math.round(sample * gain)))
}

export function pcmFromWav(wav: Buffer): Int16Array {
  if (wav.length < 44 || wav.toString('latin1', 0, 4) !== 'RIFF' || wav.toString('latin1', 8, 12) !== 'WAVE')
    throw new Error('The converted audio is not WAV.')
  let format = false
  for (let at = 12; at + 8 <= wav.length;) {
    const chunk = wav.toString('latin1', at, at + 4), length = wav.readUInt32LE(at + 4)
    if (length > wav.length - at - 8) throw new Error('The converted audio is truncated.')
    if (chunk === 'fmt ' && length >= 16)
      format = wav.readUInt16LE(at + 8) === 1 && wav.readUInt16LE(at + 10) === 1 &&
               wav.readUInt32LE(at + 12) === SOUND_RATE && wav.readUInt16LE(at + 22) === 16
    if (chunk === 'data') {
      if (!format) break
      const out = new Int16Array(length >> 1)
      for (let i = 0; i < out.length; i++) out[i] = wav.readInt16LE(at + 8 + i * 2)
      return out
    }
    at += 8 + length + (length & 1)
  }
  throw new Error('The converted audio has the wrong format.')
}

/** Any file the computer can decode (afconvert on macOS, ffmpeg elsewhere) → the device's clip. */
export async function prepareSound(file: string): Promise<{ name: string; bytes: Uint8Array }> {
  if ((await stat(file)).size > 20 * 1024 * 1024) throw new Error('Choose an audio file smaller than 20 MB.')
  const folder = await mkdtemp(join(tmpdir(), 'harness-sound-'))
  try {
    const out = join(folder, 'sound.wav')
    const [tool, args] = process.platform === 'darwin'
      ? ['afconvert', [file, out, '-f', 'WAVE', '-d', `LEI16@${SOUND_RATE}`, '-c', '1']]
      : ['ffmpeg', ['-nostdin', '-y', '-i', file, '-t', '30', '-f', 'wav', '-acodec', 'pcm_s16le', '-ac', '1',
                    '-ar', String(SOUND_RATE), out]]
    try { await run(tool, args, { timeout: 30_000 }) } catch (error) {
      throw new Error((error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'Audio conversion is unavailable. Install ffmpeg to import sounds.' : 'This audio file could not be decoded.')
    }
    return { name: assetName(file, 'Custom sound'), bytes: soundFromPcm(pcmFromWav(await readFile(out))) }
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

// ── character ────────────────────────────────────────────────────────────────────────────────────────

export interface Rgba { width: number; height: number; data: Uint8Array }

/** A non-interlaced 8-bit PNG (greyscale, RGB, palette, grey+alpha or RGBA) as RGBA. */
export function decodePng(png: Buffer): Rgba {
  if (png.length < 8 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error('Not a PNG file.')
  let width = 0, height = 0, colour = -1, palette: Buffer | null = null, alpha: Buffer | null = null
  const idat: Buffer[] = []
  for (let at = 8; at + 12 <= png.length;) {
    const length = png.readUInt32BE(at), kind = png.toString('latin1', at + 4, at + 8)
    const body = png.subarray(at + 8, at + 8 + length)
    if (body.length !== length) throw new Error('The PNG is truncated.')
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); colour = body[9]!
      if (body[8] !== 8 || body[12] !== 0 || ![0, 2, 3, 4, 6].includes(colour))
        throw new Error('Use an 8-bit, non-interlaced PNG.')
    } else if (kind === 'PLTE') palette = body
    else if (kind === 'tRNS') alpha = body
    else if (kind === 'IDAT') idat.push(body)
    else if (kind === 'IEND') break
    at += 12 + length
  }
  if (!width || !height || width * height > 16_000_000) throw new Error('The PNG has no usable image.')
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colour]!
  const stride = width * channels, raw = inflateSync(Buffer.concat(idat))
  if (raw.length < height * (stride + 1)) throw new Error('The PNG is truncated.')
  const data = new Uint8Array(width * height * 4)
  let previous = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!, row = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? row[i - channels]! : 0, up = previous[i]!, corner = i >= channels ? previous[i - channels]! : 0
      const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner)
      const predictor = [0, left, up, (left + up) >> 1, pa <= pb && pa <= pc ? left : pb <= pc ? up : corner][filter]
      if (predictor === undefined) throw new Error('The PNG is damaged.')
      row[i] = (row[i]! + predictor) & 255
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, s = x * channels
      if (colour === 6) data.set(row.subarray(s, s + 4), o)
      else if (colour === 2) data.set([row[s]!, row[s + 1]!, row[s + 2]!, 255], o)
      else if (colour === 0) data.set([row[s]!, row[s]!, row[s]!, 255], o)
      else if (colour === 4) data.set([row[s]!, row[s]!, row[s]!, row[s + 1]!], o)
      else {
        const index = row[s]!
        if (!palette || index * 3 + 2 >= palette.length) throw new Error('The PNG palette is damaged.')
        data.set([palette[index * 3]!, palette[index * 3 + 1]!, palette[index * 3 + 2]!, alpha?.[index] ?? 255], o)
      }
    }
    previous = row
  }
  return { width, height, data }
}

export const CHARACTER_ROLES = ['thinking', 'tool', 'idle'] as const
export type CharacterRole = typeof CHARACTER_ROLES[number]
export const CHARACTER_MAGIC = 0x31484348   // "HCH1", custom_character.h
const MAX_FRAMES = 32
const ALPHA_MIN = 64
/** The tallest a character is drawn (cells x scale): the working slot is a 466 px circle with a name above. */
const MAX_DRAWN = 256
const DEFAULT_STEP_MS: Record<CharacterRole, number> = { thinking: 110, tool: 90, idle: 140 }

export interface SheetChoice {
  image: Rgba
  /** Frame size in px. Default: square frames as tall as one row, the sheet's height split into `rows`. */
  frameWidth?: number
  frameHeight?: number
  /** Which row of frames plays (0 = top). */
  row?: number
  /** First frame and how many play; default all in the row. */
  first?: number
  frames?: number
  stepMs?: number
}

export interface CharacterLayout { frameWidth: number; frameHeight: number; columns: number; rows: number }

/**
 * Where a sheet's frames are, when the caller does not say: square frames, in the two layouts sheets come
 * in — four rows, one per direction (CraftPix and most RPG packs), or one strip. It is four rows when the
 * lines either side of each row boundary are empty; a cut through a strip crosses the character instead.
 */
export function sheetLayout(sheet: SheetChoice): CharacterLayout {
  const { width, height, data } = sheet.image
  let frameWidth = sheet.frameWidth, frameHeight = sheet.frameHeight
  if (!frameHeight) {
    if (frameWidth) frameHeight = frameWidth
    else {
      const clear = (y: number) => { for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3]! >= ALPHA_MIN) return false; return true }
      const quarter = height / 4
      const rows = height % 4 === 0 && width % quarter === 0 &&
        [1, 2, 3].every(k => clear(k * quarter - 1) && clear(k * quarter))
      frameHeight = rows ? quarter : height
    }
  }
  frameWidth ??= frameHeight
  if (!Number.isInteger(frameWidth) || !Number.isInteger(frameHeight) || frameWidth < 1 || frameHeight < 1 ||
      width % frameWidth || height % frameHeight)
    throw new Error(`A ${width} x ${height} sheet does not divide into ${frameWidth} x ${frameHeight} frames.`)
  return { frameWidth, frameHeight, columns: width / frameWidth, rows: height / frameHeight }
}

interface Cut { role: CharacterRole; frames: Uint8Array[]; frameWidth: number; frameHeight: number; stepMs: number }

function cut(role: CharacterRole, sheet: SheetChoice): Cut {
  const layout = sheetLayout(sheet)
  const row = sheet.row ?? 0, first = sheet.first ?? 0
  if (!Number.isInteger(row) || row < 0 || row >= layout.rows) throw new Error(`The ${role} sheet has rows 0 to ${layout.rows - 1}.`)
  const count = sheet.frames ?? layout.columns - first
  if (!Number.isInteger(first) || first < 0 || !Number.isInteger(count) || count < 1 || first + count > layout.columns)
    throw new Error(`The ${role} sheet has frames 0 to ${layout.columns - 1}.`)
  if (count > MAX_FRAMES) throw new Error(`The ${role} animation has ${count} frames; the device plays up to ${MAX_FRAMES}.`)
  const stepMs = sheet.stepMs ?? DEFAULT_STEP_MS[role]
  if (!Number.isInteger(stepMs) || stepMs < 20 || stepMs > 5000) throw new Error('Frame time must be 20 to 5000 ms.')
  const frames: Uint8Array[] = []
  for (let f = first; f < first + count; f++) {
    const pixels = new Uint8Array(layout.frameWidth * layout.frameHeight * 4)
    for (let y = 0; y < layout.frameHeight; y++) {
      const from = ((row * layout.frameHeight + y) * sheet.image.width + f * layout.frameWidth) * 4
      pixels.set(sheet.image.data.subarray(from, from + layout.frameWidth * 4), y * layout.frameWidth * 4)
    }
    frames.push(pixels)
  }
  return { role, frames, frameWidth: layout.frameWidth, frameHeight: layout.frameHeight, stepMs }
}

/** RGB565 in the panel's byte order, as the firmware's palettes hold it. */
function rgb565(r: number, g: number, b: number): number {
  const value = ((r & 248) << 8) | ((g & 252) << 3) | (b >> 3)
  return ((value << 8) | (value >> 8)) & 0xffff
}

export interface BuiltCharacter {
  bytes: Uint8Array
  /** Per role present: drawn size in px, frame count, frame time. */
  roles: Partial<Record<CharacterRole, { width: number; height: number; frames: number; stepMs: number }>>
  colours: number
  scale: number
}

/**
 * The device's character from up to three animations. Every frame of every animation shares one crop, the
 * union of what any of them draws, so the character stands still when it changes animation. Colours past
 * the 255 a palette holds are reduced a bit of precision at a time until they fit.
 */
export function buildCharacter(sheets: Partial<Record<CharacterRole, SheetChoice>>): BuiltCharacter {
  const cuts = CHARACTER_ROLES.filter(role => sheets[role]).map(role => cut(role, sheets[role]!))
  if (!cuts.length) throw new Error('Choose at least one animation.')
  if (cuts.some(c => c.frameWidth !== cuts[0]!.frameWidth || c.frameHeight !== cuts[0]!.frameHeight))
    throw new Error('Every animation needs the same frame size, so the character keeps its place.')
  const { frameWidth, frameHeight } = cuts[0]!
  let left = frameWidth, right = -1, top = frameHeight, bottom = -1
  for (const c of cuts) for (const frame of c.frames) for (let y = 0; y < frameHeight; y++) for (let x = 0; x < frameWidth; x++)
    if (frame[(y * frameWidth + x) * 4 + 3]! >= ALPHA_MIN) {
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y)
    }
  if (right < 0) throw new Error('The sheets are fully transparent.')
  const cols = right - left + 1, rows = bottom - top + 1
  if (cols > 255 || rows > 255) throw new Error('Frames can be at most 255 px after cropping.')
  const scale = Math.max(1, Math.min(16, Math.floor(MAX_DRAWN / rows), Math.floor(466 / cols)))
  if (cols * scale > 466 || rows * scale > 466) throw new Error('Frames are too large for the screen.')

  // Fewer bits per channel until every colour fits the palette.
  let drop = 0, colours = new Map<number, number>()
  for (; drop <= 5; drop++) {
    colours = new Map()
    for (const c of cuts) for (const frame of c.frames) for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
      const o = (y * frameWidth + x) * 4
      if (frame[o + 3]! < ALPHA_MIN) continue
      const key = rgb565(frame[o]! >> drop << drop, frame[o + 1]! >> drop << drop, frame[o + 2]! >> drop << drop)
      if (!colours.has(key)) colours.set(key, colours.size + 1)
    }
    if (colours.size <= 255) break
  }
  if (colours.size > 255) throw new Error('The sheets use too many colours.')

  const header = 4 + 512 + 12 * CHARACTER_ROLES.length
  const total = header + cuts.reduce((sum, c) => sum + c.frames.length * cols * rows, 0)
  if (total > DEVICE_ASSETS.character.maxBytes) throw new Error('The character is too large for the device. Use fewer frames.')
  const bytes = new Uint8Array(total), view = new DataView(bytes.buffer)
  view.setUint32(0, CHARACTER_MAGIC, true)
  for (const [value, index] of colours) view.setUint16(4 + 2 * index, value, true)
  let at = header
  const roles: BuiltCharacter['roles'] = {}
  for (const c of cuts) {
    const entry = 4 + 512 + 12 * CHARACTER_ROLES.indexOf(c.role)
    bytes.set([c.frames.length, cols, rows, scale], entry)
    view.setUint16(entry + 4, c.stepMs, true)
    view.setUint32(entry + 8, at, true)
    for (const frame of c.frames) for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
      const o = (y * frameWidth + x) * 4
      bytes[at++] = frame[o + 3]! < ALPHA_MIN ? 0
        : colours.get(rgb565(frame[o]! >> drop << drop, frame[o + 1]! >> drop << drop, frame[o + 2]! >> drop << drop))!
    }
    roles[c.role] = { width: cols * scale, height: rows * scale, frames: c.frames.length, stepMs: c.stepMs }
  }
  return { bytes, roles, colours: colours.size, scale }
}
