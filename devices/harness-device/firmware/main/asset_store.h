#pragma once

#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_partition.h"
#include "mbedtls/sha256.h"

/*
 * ONE INSTALLED ASSET (the notification sound, the character) in its own region of the `assets` partition:
 * two slots, each a header then the bytes. A new upload erases and fills the slot that is not active and
 * commits by writing its header last, after the length and SHA-256 check; an interrupted upload leaves the
 * active slot as it was. On boot the newest valid slot wins. A header with zero bytes is a restore: the
 * built-in default is active again.
 */
#define ASSET_PARTITION "assets"
#define ASSET_NAME_BYTES 32

typedef struct {
    uint32_t magic, format, generation, bytes;
    uint8_t hash[32];
    char name[ASSET_NAME_BYTES];
} asset_header_t;

typedef struct {
    // Set once, before asset_store_init.
    uint32_t base, slot_bytes, magic, format;
    // State.
    const esp_partition_t *partition;
    asset_header_t header, pending;
    int slot, target;
    atomic_bool busy;   // one read, upload or restore at a time
    bool upload;
    uint32_t written, expected;
    mbedtls_sha256_context hash;
} asset_store_t;

void asset_store_init(asset_store_t *s);
bool asset_store_supported(const asset_store_t *s);
uint32_t asset_store_max_bytes(const asset_store_t *s);
const char *asset_store_name(const asset_store_t *s);   // NULL: the built-in default
uint32_t asset_store_bytes(const asset_store_t *s);
uint32_t asset_store_written(const asset_store_t *s);
bool asset_store_ready(const asset_store_t *s);
bool asset_store_offer(asset_store_t *s, const char *name, uint32_t bytes, const char *sha256);
bool asset_store_chunk(asset_store_t *s, const uint8_t *data, size_t size);
bool asset_store_commit(asset_store_t *s);
void asset_store_abort(asset_store_t *s);
bool asset_store_restore(asset_store_t *s);
// A reader holds the store busy so no upload or restore erases what it reads.
bool asset_store_read_begin(asset_store_t *s, int *slot, uint32_t *bytes);
bool asset_store_read(const asset_store_t *s, int slot, uint32_t offset, void *out, size_t size);
void asset_store_read_end(asset_store_t *s);
// The partition offset of the active slot's bytes, for mapping them; false with none installed.
bool asset_store_active_offset(const asset_store_t *s, uint32_t *offset);
