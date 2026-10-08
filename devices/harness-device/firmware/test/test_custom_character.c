#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "custom_character.h"
#include "esp_partition.h"
#include "mbedtls/sha256.h"

// The assets partition at its real size: the sound's region, then the character's two slots.
static uint8_t flash[0x1E0000];
static esp_partition_t partition = { .size = sizeof flash };

const esp_partition_t *esp_partition_find_first(int type, int subtype, const char *label)
{ (void)type; (void)subtype; return strcmp(label, "assets") == 0 ? &partition : NULL; }
esp_err_t esp_partition_read(const esp_partition_t *part, uint32_t offset, void *out, size_t size)
{ (void)part; if ((uint64_t)offset + size > sizeof flash) return -1; memcpy(out, flash + offset, size); return ESP_OK; }
esp_err_t esp_partition_write(const esp_partition_t *part, uint32_t offset, const void *data, size_t size)
{
    (void)part;
    if ((uint64_t)offset + size > sizeof flash) return -1;
    for (size_t i = 0; i < size; i++) flash[offset + i] &= ((const uint8_t *)data)[i];
    return ESP_OK;
}
esp_err_t esp_partition_erase_range(const esp_partition_t *part, uint32_t offset, size_t size)
{ (void)part; if ((uint64_t)offset + size > sizeof flash) return -1; memset(flash + offset, 0xff, size); return ESP_OK; }
esp_err_t esp_partition_mmap(const esp_partition_t *part, size_t offset, size_t size, int memory,
                             const void **out_ptr, esp_partition_mmap_handle_t *out_handle)
{ (void)part; (void)memory; (void)out_handle; if ((uint64_t)offset + size > sizeof flash) return -1; *out_ptr = flash + offset; return ESP_OK; }

void mbedtls_sha256_init(mbedtls_sha256_context *ctx) { memset(ctx, 0, sizeof *ctx); }
void mbedtls_sha256_free(mbedtls_sha256_context *ctx) { (void)ctx; }
int mbedtls_sha256_starts(mbedtls_sha256_context *ctx, int is224) { (void)is224; memset(ctx, 0, sizeof *ctx); return 0; }
int mbedtls_sha256_update(mbedtls_sha256_context *ctx, const unsigned char *data, size_t len)
{ for (size_t i=0; i<len; i++) { ctx->state[ctx->at % 32] ^= data[i]; ctx->at++; } return 0; }
int mbedtls_sha256_finish(mbedtls_sha256_context *ctx, unsigned char output[32])
{ memcpy(output, ctx->state, 32); return 0; }

static void put16(uint8_t *p, unsigned v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }
static void put32(uint8_t *p, uint32_t v) { for (int i = 0; i < 4; i++) p[i] = (uint8_t)(v >> (8 * i)); }

// A character with `frames[r]` frames of cols x rows for each role (0 = absent).
static size_t build(uint8_t *out, const unsigned frames[3], unsigned cols, unsigned rows)
{
    size_t at = 4 + 512 + 36;
    memset(out, 0, at);
    put32(out, CUSTOM_CHARACTER_MAGIC);
    for (int i = 1; i < 256; i++) put16(out + 4 + 2 * i, (unsigned)(i * 257));
    for (int r = 0; r < 3; r++) {
        uint8_t *a = out + 4 + 512 + 12 * r;
        a[0] = (uint8_t)frames[r]; a[1] = (uint8_t)cols; a[2] = (uint8_t)rows; a[3] = 8;
        put16(a + 4, 100);
        put32(a + 8, (uint32_t)at);
        for (unsigned f = 0; f < frames[r] * cols * rows; f++) out[at + f] = (uint8_t)(f * 7 + r);
        at += frames[r] * cols * rows;
    }
    return at;
}

static void hash_text(const uint8_t *data, size_t size, char out[65])
{
    mbedtls_sha256_context ctx;
    unsigned char digest[32];
    mbedtls_sha256_starts(&ctx, 0);
    mbedtls_sha256_update(&ctx, data, size);
    mbedtls_sha256_finish(&ctx, digest);
    for (int i = 0; i < 32; i++) snprintf(out + 2 * i, 3, "%02x", digest[i]);
}

static bool install(const char *name, const uint8_t *blob, size_t size)
{
    char hash[65];
    hash_text(blob, size, hash);
    if (!custom_character_offer(name, (uint32_t)size, hash)) return false;
    for (size_t at = 0; at < size; at += 4096)
        if (!custom_character_chunk(blob + at, size - at < 4096 ? size - at : 4096)) { custom_character_abort(); return false; }
    assert(custom_character_ready());
    bool ok = custom_character_commit();
    custom_character_reload();
    return ok;
}

int main(void)
{
    static uint8_t blob[CUSTOM_CHARACTER_MAX_BYTES];
    static custom_character_t parsed;
    memset(flash, 0xff, sizeof flash);

    // Parsing: all three roles, the palette and frames in place, and every malformed shape refused.
    size_t size = build(blob, (unsigned[]){8, 8, 12}, 30, 32);
    assert(custom_character_parse(blob, size, &parsed));
    assert(parsed.scenes[CUSTOM_ROLE_IDLE].steps == 12 && parsed.scenes[CUSTOM_ROLE_IDLE].w == 240);
    assert(parsed.frames[1][3].palette == parsed.palette && parsed.palette[2] == 514);
    assert(parsed.frames[1][3].cells == blob + 4 + 512 + 36 + 8 * 960 + 3 * 960);
    assert(!custom_character_parse(blob, size - 1, &parsed));          // last frame cut short
    assert(!custom_character_parse(blob, 100, &parsed));               // shorter than the header
    blob[0] ^= 1; assert(!custom_character_parse(blob, size, &parsed)); blob[0] ^= 1;
    blob[4 + 512 + 3] = 17; assert(!custom_character_parse(blob, size, &parsed)); blob[4 + 512 + 3] = 8;   // cell
    blob[4 + 512 + 1] = 60; assert(!custom_character_parse(blob, size, &parsed)); blob[4 + 512 + 1] = 30;  // 480 px wide
    blob[4 + 512] = 33; assert(!custom_character_parse(blob, size, &parsed)); blob[4 + 512] = 8;           // frames
    put16(blob + 4 + 512 + 4, 5); assert(!custom_character_parse(blob, size, &parsed)); put16(blob + 4 + 512 + 4, 100);
    put32(blob + 4 + 512 + 8, 3); assert(!custom_character_parse(blob, size, &parsed));                   // into header
    put32(blob + 4 + 512 + 8, 0xFFFFFFF0u); assert(!custom_character_parse(blob, size, &parsed));
    put32(blob + 4 + 512 + 8, 4 + 512 + 36);
    assert(custom_character_parse(blob, size, &parsed));
    size_t none = build(blob, (unsigned[]){0, 0, 0}, 4, 4);
    assert(!custom_character_parse(blob, none, &parsed));

    // Nothing installed: the pets.
    custom_character_init();
    assert(custom_character_supported());
    assert(!custom_character_name() && !custom_character_scene(CUSTOM_ROLE_THINKING));

    // Install, survive a reboot, and borrow a missing working role from the other.
    size = build(blob, (unsigned[]){0, 8, 12}, 30, 32);
    assert(install("Swordsman", blob, size));
    assert(!strcmp(custom_character_name(), "Swordsman"));
    const ht_pet_scene_t *tool = custom_character_scene(CUSTOM_ROLE_TOOL);
    assert(tool && tool->steps == 8 && custom_character_scene(CUSTOM_ROLE_THINKING) == tool);
    assert(custom_character_owns(tool) && custom_character_scene(CUSTOM_ROLE_IDLE)->steps == 12);
    custom_character_init();
    assert(!strcmp(custom_character_name(), "Swordsman") && custom_character_scene(CUSTOM_ROLE_IDLE)->steps == 12);

    // An idle-only character keeps the pets' working scenes.
    size = build(blob, (unsigned[]){0, 0, 6}, 10, 10);
    assert(install("Rest", blob, size));
    assert(!custom_character_scene(CUSTOM_ROLE_THINKING) && custom_character_scene(CUSTOM_ROLE_IDLE)->steps == 6);

    // A blob that verifies but cannot be drawn is refused, and the installed one stays.
    size = build(blob, (unsigned[]){4, 4, 4}, 10, 10);
    blob[4 + 512 + 3] = 0;
    assert(!install("Broken", blob, size));
    assert(!strcmp(custom_character_name(), "Rest"));
    custom_character_init();
    assert(!strcmp(custom_character_name(), "Rest"));

    // An interrupted upload leaves the installed one too.
    size = build(blob, (unsigned[]){4, 4, 4}, 10, 10);
    char hash[65];
    hash_text(blob, size, hash);
    assert(custom_character_offer("Half", (uint32_t)size, hash));
    assert(custom_character_chunk(blob, size / 2));
    custom_character_abort();
    custom_character_init();
    assert(!strcmp(custom_character_name(), "Rest"));

    // The largest blob fits its slot; one byte more is refused at the offer.
    hash_text(blob, size, hash);
    assert(!custom_character_offer("Big", CUSTOM_CHARACTER_MAX_BYTES + 1, hash));

    // Restore: the pets again, after a reboot too.
    assert(custom_character_restore());
    custom_character_reload();
    assert(!custom_character_name() && !custom_character_scene(CUSTOM_ROLE_IDLE));
    custom_character_init();
    assert(!custom_character_name());

    puts("custom character: parse bounds, role fallback, install, refusal, interruption, reboot and restore passed");
    return 0;
}
