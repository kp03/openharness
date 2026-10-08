#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "esp_partition.h"
#include "mbedtls/sha256.h"
#include "notification_sound.h"

static uint8_t flash[0x80000];
static esp_partition_t partition = { .size = sizeof flash };
static bool fail_write;
static bool has_partition = true;

const esp_partition_t *esp_partition_find_first(int type, int subtype, const char *label)
{ (void)type; (void)subtype; return has_partition && strcmp(label, "assets") == 0 ? &partition : NULL; }
esp_err_t esp_partition_read(const esp_partition_t *part, uint32_t offset, void *out, size_t size)
{ (void)part; if ((uint64_t)offset + size > sizeof flash) return -1; memcpy(out, flash + offset, size); return ESP_OK; }
esp_err_t esp_partition_write(const esp_partition_t *part, uint32_t offset, const void *data, size_t size)
{
    (void)part;
    if (fail_write || (uint64_t)offset + size > sizeof flash) return -1;
    for (size_t i = 0; i < size; i++) {
        if ((flash[offset + i] & ((const uint8_t *)data)[i]) != ((const uint8_t *)data)[i]) return -1;
        flash[offset + i] &= ((const uint8_t *)data)[i];
    }
    return ESP_OK;
}
esp_err_t esp_partition_mmap(const esp_partition_t *part, size_t offset, size_t size, int memory,
                             const void **out_ptr, esp_partition_mmap_handle_t *out_handle)
{ (void)part; (void)memory; (void)out_handle; if ((uint64_t)offset + size > sizeof flash) return -1; *out_ptr = flash + offset; return ESP_OK; }
esp_err_t esp_partition_erase_range(const esp_partition_t *part, uint32_t offset, size_t size)
{ (void)part; if ((uint64_t)offset + size > sizeof flash) return -1; memset(flash + offset, 0xff, size); return ESP_OK; }

// Deterministic test hash: the production component is linked to mbedTLS's SHA-256.
void mbedtls_sha256_init(mbedtls_sha256_context *ctx) { memset(ctx, 0, sizeof *ctx); }
void mbedtls_sha256_free(mbedtls_sha256_context *ctx) { (void)ctx; }
int mbedtls_sha256_starts(mbedtls_sha256_context *ctx, int is224) { (void)is224; memset(ctx, 0, sizeof *ctx); return 0; }
int mbedtls_sha256_update(mbedtls_sha256_context *ctx, const unsigned char *data, size_t len)
{ for (size_t i=0; i<len; i++) { ctx->state[ctx->at % 32] ^= data[i]; ctx->at++; } return 0; }
int mbedtls_sha256_finish(mbedtls_sha256_context *ctx, unsigned char output[32])
{ memcpy(output, ctx->state, 32); return 0; }

static void hash_text(const uint8_t *data, size_t size, char out[65])
{
    mbedtls_sha256_context ctx;
    unsigned char digest[32];
    mbedtls_sha256_starts(&ctx, 0);
    mbedtls_sha256_update(&ctx, data, size);
    mbedtls_sha256_finish(&ctx, digest);
    for (int i=0; i<32; i++) sprintf(out + 2*i, "%02x", digest[i]);
}

static void upload(const char *name, const uint8_t *data, size_t size)
{
    char hash[65]; hash_text(data, size, hash);
    assert(notification_sound_offer(name, (uint32_t)size, hash));
    assert(notification_sound_chunk(data, size));
    assert(notification_sound_ready());
    assert(notification_sound_commit());
    assert(strcmp(notification_sound_name(), name) == 0);
}

int main(void)
{
    memset(flash, 0xff, sizeof flash);
    has_partition = false;
    notification_sound_init();
    assert(!notification_sound_supported());
    has_partition = true;
    partition.size = 0x40000;
    notification_sound_init();
    assert(!notification_sound_supported());
    partition.size = sizeof flash;
    notification_sound_init();
    assert(notification_sound_supported());
    assert(notification_sound_name() == NULL);
    const uint8_t first[] = { 0xff, 0x7f, 0x00, 0x80 };
    const uint8_t second[] = { 1, 2, 3, 4, 5 };
    upload("First", first, sizeof first);
    notification_sound_init();
    assert(strcmp(notification_sound_name(), "First") == 0);
    char hash[65]; hash_text(second, sizeof second, hash);
    assert(notification_sound_offer("Second", sizeof second, hash));
    assert(notification_sound_chunk(second, 2));
    notification_sound_abort(); // unplug mid-transfer leaves First
    notification_sound_init();
    assert(strcmp(notification_sound_name(), "First") == 0);
    assert(notification_sound_offer("Second", sizeof second, hash));
    assert(!notification_sound_chunk(second, 4097));
    notification_sound_abort();
    upload("Second", second, sizeof second);
    int slot; uint32_t bytes;
    assert(notification_sound_playback_begin(&slot, &bytes) && bytes == sizeof second);
    assert(!notification_sound_offer("Third", sizeof first, hash));
    uint8_t readback[sizeof second];
    assert(notification_sound_read(slot, 0, readback, bytes));
    assert(memcmp(readback, second, bytes) == 0);
    notification_sound_playback_end();
    assert(notification_sound_restore());
    notification_sound_init();
    assert(notification_sound_name() == NULL);
    assert(notification_sound_decode(0xff) == 0);
    assert(notification_sound_decode(0x7f) == 0);
    assert(notification_sound_decode(0x00) < 0);
    hash_text(first, sizeof first, hash);
    assert(notification_sound_offer("Fail", sizeof first, hash));
    fail_write = true;
    assert(!notification_sound_chunk(first, sizeof first));
    notification_sound_abort();
    fail_write = false;
    puts("notification sound: two slots, interrupted upload, restore, and playback passed");
    return 0;
}
