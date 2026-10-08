#include "notification_sound.h"

#include "asset_store.h"

#define MAGIC 0x484E5344u // HNSD
#define FORMAT 1u // 16 kHz, mono, G.711 mu-law

_Static_assert(sizeof(asset_header_t) == 80, "asset header layout");

static asset_store_t s_store = { .base = 0, .slot_bytes = NOTIFICATION_SOUND_SLOT_BYTES, .magic = MAGIC, .format = FORMAT };

void notification_sound_init(void) { asset_store_init(&s_store); }
bool notification_sound_supported(void) { return asset_store_supported(&s_store); }
const char *notification_sound_name(void) { return asset_store_name(&s_store); }
uint32_t notification_sound_bytes(void) { return asset_store_bytes(&s_store); }
uint32_t notification_sound_written(void) { return asset_store_written(&s_store); }
bool notification_sound_ready(void) { return asset_store_ready(&s_store); }
bool notification_sound_offer(const char *name, uint32_t bytes, const char *sha256)
{ return asset_store_offer(&s_store, name, bytes, sha256); }
bool notification_sound_chunk(const uint8_t *data, size_t size) { return asset_store_chunk(&s_store, data, size); }
void notification_sound_abort(void) { asset_store_abort(&s_store); }
bool notification_sound_commit(void) { return asset_store_commit(&s_store); }
bool notification_sound_restore(void) { return asset_store_restore(&s_store); }
bool notification_sound_playback_begin(int *slot, uint32_t *bytes) { return asset_store_read_begin(&s_store, slot, bytes); }
bool notification_sound_read(int slot, uint32_t offset, uint8_t *out, size_t size)
{ return asset_store_read(&s_store, slot, offset, out, size); }
void notification_sound_playback_end(void) { asset_store_read_end(&s_store); }

int16_t notification_sound_decode(uint8_t value)
{
    uint8_t u = (uint8_t)~value;
    int magnitude = (((u & 15) << 3) + 132) << ((u >> 4) & 7);
    magnitude -= 132;
    if (magnitude > 32767) magnitude = 32767;
    return u & 0x80 ? (int16_t)-magnitude : (int16_t)magnitude;
}
