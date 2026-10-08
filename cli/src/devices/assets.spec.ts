import { createHash } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { assetName, buildCharacter, CHARACTER_MAGIC, decodePng, encodeMuLaw, pcmFromWav, sheetLayout, soundFromPcm, SOUND_MAX_SAMPLES, type Rgba } from './assets.js'

/** A PNG of `colour` type from raw scanline bytes, each row filtered with `filter`. */
function png(width: number, height: number, colour: number, channels: number, pixel: (x: number, y: number) => number[],
             extra: Array<[string, Buffer]> = [], filter = 0): Buffer {
  const chunk = (kind: string, body: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(body.length); head.write(kind, 4, 'latin1')
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(kind, 'latin1'), body])))
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = colour
  const rows: number[] = []
  for (let y = 0; y < height; y++) {
    const raw = Array.from({ length: width }, (_, x) => pixel(x, y)).flat()
    // Filter 1 (Sub) stores each byte less the one `channels` to its left.
    rows.push(filter, ...raw.map((value, i) => filter === 1 ? (value - (i >= channels ? raw[i - channels]! : 0)) & 255 : value))
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...extra.map(([k, b]) => chunk(k, b)),
    chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))])
}

/** A sheet of `rows` x `columns` square frames, each with a `size`-px block in a colour of its own, padded. */
function sheet(columns: number, rows: number, frame = 16, block = 6): Rgba {
  const width = columns * frame, height = rows * frame, data = new Uint8Array(width * height * 4)
  for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++)
    for (let y = 4; y < 4 + block; y++) for (let x = 5 + c % 2; x < 5 + c % 2 + block; x++)
      data.set([c * 20, r * 60, 200, 255], ((r * frame + y) * width + c * frame + x) * 4)
  return { width, height, data }
}

describe('device assets', () => {
  it('decodes 8-bit PNGs of every colour type, with filters, palettes and transparency', () => {
    const rgba = decodePng(png(3, 2, 6, 4, (x, y) => [x * 10, y * 20, 7, x === 2 ? 0 : 255], [], 1))
    expect([...rgba.data.subarray(4, 8)]).toEqual([10, 0, 7, 255])
    expect(rgba.data[(1 * 3 + 2) * 4 + 3]).toBe(0)
    expect([...decodePng(png(2, 1, 2, 3, x => [x, 2, 3])).data]).toEqual([0, 2, 3, 255, 1, 2, 3, 255])
    expect([...decodePng(png(1, 1, 0, 1, () => [9])).data]).toEqual([9, 9, 9, 255])
    expect([...decodePng(png(1, 1, 4, 2, () => [9, 50])).data]).toEqual([9, 9, 9, 50])
    const indexed = png(2, 1, 3, 1, x => [x], [['PLTE', Buffer.from([1, 2, 3, 4, 5, 6])], ['tRNS', Buffer.from([0])]])
    expect([...decodePng(indexed).data]).toEqual([1, 2, 3, 0, 4, 5, 6, 255])
    expect(() => decodePng(Buffer.from('not a png'))).toThrow('Not a PNG')
    const sixteen = png(1, 1, 6, 4, () => [0, 0, 0, 0]); sixteen[24] = 16
    expect(() => decodePng(sixteen)).toThrow('8-bit')
    expect(() => decodePng(png(2, 1, 3, 1, () => [5], [['PLTE', Buffer.from([1, 2, 3])]]))).toThrow('palette')
  })

  it('finds four direction rows or a strip, and takes the caller’s frame size instead', () => {
    expect(sheetLayout({ image: sheet(8, 4) })).toEqual({ frameWidth: 16, frameHeight: 16, columns: 8, rows: 4 })
    // A strip whose height divides by four is still a strip: the quarter lines cross its frames.
    expect(sheetLayout({ image: sheet(8, 1, 16, 10) })).toEqual({ frameWidth: 16, frameHeight: 16, columns: 8, rows: 1 })
    expect(sheetLayout({ image: sheet(8, 4), frameWidth: 32, frameHeight: 16 })).toMatchObject({ columns: 4, rows: 4 })
    expect(() => sheetLayout({ image: sheet(8, 4), frameWidth: 30 })).toThrow('does not divide')
  })

  it('builds the firmware’s bytes: one crop for every animation, its palette, frames at their offsets', () => {
    const built = buildCharacter({ thinking: { image: sheet(4, 4), row: 1 }, idle: { image: sheet(6, 4), row: 1, stepMs: 200 } })
    const view = new DataView(built.bytes.buffer)
    expect(view.getUint32(0, true)).toBe(CHARACTER_MAGIC)
    // Frames alternate a pixel left and right, so the shared crop is 7 wide and 6 tall, drawn as large as fits 256.
    expect(built.scale).toBe(16)
    expect(built.roles).toEqual({ thinking: { width: 112, height: 96, frames: 4, stepMs: 110 }, idle: { width: 112, height: 96, frames: 6, stepMs: 200 } })
    const entry = (role: number) => 4 + 512 + 12 * role
    expect([...built.bytes.subarray(entry(0), entry(0) + 4)]).toEqual([4, 7, 6, 16])
    expect(built.bytes[entry(1)]).toBe(0)   // the tool animation is absent
    expect(view.getUint32(entry(0) + 8, true)).toBe(4 + 512 + 36)
    expect(view.getUint32(entry(2) + 8, true)).toBe(4 + 512 + 36 + 4 * 42)
    expect(built.bytes.length).toBe(4 + 512 + 36 + 10 * 42)
    // Frame 0 of thinking: its block starts at the crop's left edge; frame 1's one pixel right of it.
    const first = 4 + 512 + 36
    expect(built.bytes[first]).not.toBe(0)
    expect(built.bytes[first + 42]).toBe(0)
    expect(built.bytes[first + 42 + 1]).not.toBe(0)
    const colour = view.getUint16(4 + 2 * built.bytes[first]!, true)
    expect(colour).toBe(0xf901)   // RGB(0, 60, 200) is 0x01f9 in RGB565, stored byte-swapped for the panel
  })

  it('builds the vector desktop pins too (character_pack_test.dart): the two converters agree byte for byte', () => {
    const built = buildCharacter({ thinking: { image: sheet(4, 4), row: 1 }, tool: { image: sheet(5, 4), row: 3, stepMs: 60 },
                                   idle: { image: sheet(6, 4), row: 2, stepMs: 200 } })
    expect(built.bytes.length).toBe(1182)
    expect(createHash('sha256').update(built.bytes).digest('hex')).toBe('129bedc61d670c2226b7732f5e18d0da534603600eec4c6865ebdc4fa0cdfff3')
  })

  it('refuses what the device cannot draw', () => {
    expect(() => buildCharacter({})).toThrow('at least one')
    expect(() => buildCharacter({ thinking: { image: sheet(4, 4) }, tool: { image: sheet(4, 1, 32, 6) } })).toThrow('same frame size')
    expect(() => buildCharacter({ idle: { image: sheet(33, 1) } })).toThrow('up to 32')
    expect(() => buildCharacter({ idle: { image: sheet(4, 4), row: 4 } })).toThrow('rows 0 to 3')
    expect(() => buildCharacter({ idle: { image: sheet(4, 4), stepMs: 5 } })).toThrow('20 to 5000')
    expect(() => buildCharacter({ idle: { image: { width: 16, height: 16, data: new Uint8Array(1024) } } })).toThrow('transparent')
  })

  it('reduces a sheet of more than 255 colours until it fits the palette', () => {
    const width = 32, height = 32, data = new Uint8Array(width * height * 4)
    for (let i = 0; i < width * height; i++) data.set([i & 255, (i >> 2) & 255, (i * 7) & 255, 255], i * 4)
    const built = buildCharacter({ idle: { image: { width, height, data } } })
    expect(built.colours).toBeLessThanOrEqual(255)
    expect(built.colours).toBeGreaterThan(64)
  })

  it('makes the sound clip: silence trimmed, sixteen seconds at most, no louder than the chime', () => {
    expect(encodeMuLaw(0)).toBe(0xff)
    expect(encodeMuLaw(-1)).toBe(0x7f)
    expect(encodeMuLaw(32767)).toBe(0x80)
    const pcm = new Int16Array(20 * 16_000)
    pcm.fill(12_000, 16_000)
    const clip = soundFromPcm(pcm)
    expect(clip.length).toBe(SOUND_MAX_SAMPLES)
    expect(clip[0]).toBe(encodeMuLaw(6000))   // trimmed to the first loud sample, scaled to the chime's peak
    expect(soundFromPcm(Int16Array.from([0, 5, 300, -400, 7, 0]))).toEqual(Uint8Array.from([300, -400].map(encodeMuLaw)))
    expect(() => soundFromPcm(new Int16Array(100))).toThrow('silent')
  })

  it('reads the converter’s WAV and names the asset from its file', () => {
    const wav = Buffer.alloc(44 + 4)
    wav.write('RIFF', 0, 'latin1'); wav.write('WAVE', 8, 'latin1'); wav.write('fmt ', 12, 'latin1'); wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16_000, 24); wav.writeUInt16LE(16, 34)
    wav.write('data', 36, 'latin1'); wav.writeUInt32LE(4, 40); wav.writeInt16LE(-5, 44); wav.writeInt16LE(9, 46)
    expect([...pcmFromWav(wav)]).toEqual([-5, 9])
    wav.writeUInt32LE(44_100, 24)
    expect(() => pcmFromWav(wav)).toThrow('wrong format')
    expect(() => pcmFromWav(Buffer.from('nope'))).toThrow('not WAV')
    expect(assetName('/a/finish-sound.mp3', 'x')).toBe('finish-sound')
    expect(assetName('/a/éé.png', 'Custom character')).toBe('Custom character')
    expect(assetName(`/a/${'k'.repeat(40)}.png`, 'x')).toHaveLength(31)
  })
})
