#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// The first region of the assets partition: two 256 KiB slots, about 16 s of 16 kHz mu-law each.
#define NOTIFICATION_SOUND_SLOT_BYTES 0x40000u
#define NOTIFICATION_SOUND_MAX_BYTES (NOTIFICATION_SOUND_SLOT_BYTES - 80u)

void notification_sound_init(void);
bool notification_sound_supported(void);
const char *notification_sound_name(void); // NULL means the built-in chime
bool notification_sound_offer(const char *name, uint32_t bytes, const char *sha256);
bool notification_sound_chunk(const uint8_t *data, size_t size);
bool notification_sound_commit(void);
void notification_sound_abort(void);
bool notification_sound_restore(void);
uint32_t notification_sound_written(void);
bool notification_sound_ready(void);
uint32_t notification_sound_bytes(void);
bool notification_sound_playback_begin(int *slot, uint32_t *bytes);
bool notification_sound_read(int slot, uint32_t offset, uint8_t *out, size_t size);
void notification_sound_playback_end(void);
int16_t notification_sound_decode(uint8_t value);
