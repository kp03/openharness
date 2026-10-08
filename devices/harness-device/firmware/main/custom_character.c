#include "custom_character.h"

#include <string.h>

#include "asset_store.h"

#define FORMAT 1u
#define REGION 0x80000u   // after the notification sound's two slots
#define HEADER_BYTES (4u + 512u + CUSTOM_ROLES * 12u)

static asset_store_t s_store = { .base = REGION, .slot_bytes = CUSTOM_CHARACTER_SLOT_BYTES,
                                 .magic = 0x48434852u /* HCHR */, .format = FORMAT };
static const uint8_t *s_mapped;   // both slots, mapped once
static esp_partition_mmap_handle_t s_map;
// Two parsed copies: the face reads `s_active` while a reload fills the other.
static custom_character_t s_parsed[2];
static custom_character_t *s_active;

static uint16_t u16_at(const uint8_t *p) { return (uint16_t)(p[0] | p[1] << 8); }
static uint32_t u32_at(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }

bool custom_character_parse(const uint8_t *blob, size_t size, custom_character_t *out)
{
    if (!blob || size < HEADER_BYTES || u32_at(blob) != CUSTOM_CHARACTER_MAGIC) return false;
    custom_character_t c;
    memset(&c, 0, sizeof c);
    for (int i = 0; i < 256; i++) c.palette[i] = u16_at(blob + 4 + 2 * i);
    bool any = false;
    for (int r = 0; r < CUSTOM_ROLES; r++) {
        const uint8_t *a = blob + 4 + 512 + 12 * r;
        unsigned frames = a[0], cols = a[1], rows = a[2], cell = a[3], step_ms = u16_at(a + 4);
        uint32_t offset = u32_at(a + 8);
        if (!frames) continue;
        // Within the round glass at its drawn size, a sane pace, and every frame inside the blob.
        if (frames > CUSTOM_CHARACTER_MAX_FRAMES || !cols || !rows || !cell || cell > 16 ||
            cols * cell > 466 || rows * cell > 466 || step_ms < 20 || step_ms > 5000) return false;
        uint32_t each = (uint32_t)cols * rows;
        if (offset < HEADER_BYTES || offset > size || (size - offset) / each < frames) return false;
        for (unsigned f = 0; f < frames; f++) {
            c.frames[r][f] = (ht_cell_frame_t){ (uint8_t)cols, (uint8_t)rows, (uint8_t)cell, NULL,
                                                blob + offset + f * each, NULL };
            c.loop[r][f] = (uint8_t)f;
        }
        c.scenes[r] = (ht_pet_scene_t){ .w = (uint16_t)(cols * cell), .h = (uint16_t)(rows * cell),
                                        .frames = c.frames[r], .loop = c.loop[r], .steps = (uint8_t)frames,
                                        .step_ms = (uint16_t)step_ms };
        c.present[r] = any = true;
    }
    if (!any) return false;
    *out = c;
    // The frames name the palette by address: point them at the copy they now live beside.
    for (int r = 0; r < CUSTOM_ROLES; r++) {
        for (int f = 0; f < CUSTOM_CHARACTER_MAX_FRAMES; f++) out->frames[r][f].palette = out->palette;
        out->scenes[r].frames = out->frames[r];
        out->scenes[r].loop = out->loop[r];
    }
    return true;
}

void custom_character_reload(void)
{
    uint32_t offset;
    custom_character_t *next = s_active == &s_parsed[0] ? &s_parsed[1] : &s_parsed[0];
    if (s_mapped && asset_store_active_offset(&s_store, &offset) &&
        custom_character_parse(s_mapped + (offset - REGION), asset_store_bytes(&s_store), next))
        s_active = next;
    else
        s_active = NULL;
}

void custom_character_init(void)
{
    asset_store_init(&s_store);
    if (asset_store_supported(&s_store) && !s_mapped) {
        const void *p;
        if (esp_partition_mmap(s_store.partition, REGION, 2 * CUSTOM_CHARACTER_SLOT_BYTES,
                               ESP_PARTITION_MMAP_DATA, &p, &s_map) == ESP_OK)
            s_mapped = p;
    }
    custom_character_reload();
}

bool custom_character_supported(void) { return asset_store_supported(&s_store) && s_mapped; }
const char *custom_character_name(void) { return s_active ? asset_store_name(&s_store) : NULL; }
uint32_t custom_character_bytes(void) { return s_active ? asset_store_bytes(&s_store) : 0; }
bool custom_character_offer(const char *name, uint32_t bytes, const char *sha256)
{ return custom_character_supported() && asset_store_offer(&s_store, name, bytes, sha256); }
bool custom_character_chunk(const uint8_t *data, size_t size) { return asset_store_chunk(&s_store, data, size); }
bool custom_character_ready(void) { return asset_store_ready(&s_store); }
uint32_t custom_character_written(void) { return asset_store_written(&s_store); }
void custom_character_abort(void) { asset_store_abort(&s_store); }
bool custom_character_restore(void) { return custom_character_supported() && asset_store_restore(&s_store); }

bool custom_character_commit(void)
{
    // A blob the face could not draw is refused before it replaces the one that works.
    uint32_t bytes = s_store.expected;
    int target = s_store.target;
    if (!asset_store_ready(&s_store)) return false;
    static custom_character_t probe;
    if (!custom_character_parse(s_mapped + (REGION + (uint32_t)target * CUSTOM_CHARACTER_SLOT_BYTES +
                                            sizeof(asset_header_t) - REGION), bytes, &probe)) {
        asset_store_abort(&s_store);
        return false;
    }
    return asset_store_commit(&s_store);
}

const ht_pet_scene_t *custom_character_scene(custom_role_t role)
{
    custom_character_t *c = s_active;
    if (!c || role >= CUSTOM_ROLES) return NULL;
    if (c->present[role]) return &c->scenes[role];
    if (role == CUSTOM_ROLE_THINKING && c->present[CUSTOM_ROLE_TOOL]) return &c->scenes[CUSTOM_ROLE_TOOL];
    if (role == CUSTOM_ROLE_TOOL && c->present[CUSTOM_ROLE_THINKING]) return &c->scenes[CUSTOM_ROLE_THINKING];
    return NULL;
}

bool custom_character_owns(const ht_pet_scene_t *scene)
{
    custom_character_t *c = s_active;
    return c && scene >= &c->scenes[0] && scene < &c->scenes[CUSTOM_ROLES];
}
