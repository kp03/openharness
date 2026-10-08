#include "asset_store.h"

#include <string.h>

static bool hex_hash(const char *text, uint8_t *bytes)
{
    if (!text || strlen(text) != 64) return false;
    for (int i = 0; i < 32; i++) {
        int parts[2];
        for (int j = 0; j < 2; j++) {
            char c = text[i * 2 + j];
            parts[j] = c >= '0' && c <= '9' ? c - '0' :
                c >= 'a' && c <= 'f' ? c - 'a' + 10 :
                c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
            if (parts[j] < 0) return false;
        }
        bytes[i] = (uint8_t)((parts[0] << 4) | parts[1]);
    }
    return true;
}

static bool printable(const char *name)
{
    for (const unsigned char *p = (const unsigned char *)name; *p; p++)
        if (*p < 32 || *p > 126) return false;
    return true;
}

static uint32_t slot_at(const asset_store_t *s, int slot) { return s->base + (uint32_t)slot * s->slot_bytes; }

uint32_t asset_store_max_bytes(const asset_store_t *s) { return s->slot_bytes - (uint32_t)sizeof(asset_header_t); }

static bool valid_slot(const asset_store_t *s, int slot, asset_header_t *header)
{
    uint32_t base = slot_at(s, slot);
    if (esp_partition_read(s->partition, base, header, sizeof *header) != ESP_OK ||
        header->magic != s->magic || header->format != s->format ||
        header->bytes > asset_store_max_bytes(s) ||
        !memchr(header->name, 0, sizeof header->name) || !printable(header->name)) return false;
    if (!header->bytes) return true; // a committed restore tombstone
    mbedtls_sha256_context hash;
    uint8_t digest[32], block[1024];
    mbedtls_sha256_init(&hash);
    mbedtls_sha256_starts(&hash, 0);
    for (uint32_t at = 0; at < header->bytes;) {
        size_t count = header->bytes - at;
        if (count > sizeof block) count = sizeof block;
        if (esp_partition_read(s->partition, base + sizeof *header + at, block, count) != ESP_OK) {
            mbedtls_sha256_free(&hash);
            return false;
        }
        mbedtls_sha256_update(&hash, block, count);
        at += count;
    }
    mbedtls_sha256_finish(&hash, digest);
    mbedtls_sha256_free(&hash);
    return memcmp(digest, header->hash, sizeof digest) == 0;
}

void asset_store_init(asset_store_t *s)
{
    s->slot = -1;
    s->upload = false;
    atomic_store(&s->busy, false);
    memset(&s->header, 0, sizeof s->header);
    s->partition = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, ASSET_PARTITION);
    if (!asset_store_supported(s)) return;
    asset_header_t a, b;
    bool va = valid_slot(s, 0, &a), vb = valid_slot(s, 1, &b);
    if (va && (!vb || (int32_t)(a.generation - b.generation) > 0)) { s->slot = 0; s->header = a; }
    else if (vb) { s->slot = 1; s->header = b; }
}

bool asset_store_supported(const asset_store_t *s)
{
    return s->partition && s->partition->size >= s->base + 2 * s->slot_bytes;
}

const char *asset_store_name(const asset_store_t *s)
{
    return s->slot >= 0 && s->header.bytes ? s->header.name : NULL;
}

uint32_t asset_store_bytes(const asset_store_t *s) { return asset_store_name(s) ? s->header.bytes : 0; }
uint32_t asset_store_written(const asset_store_t *s) { return s->written; }
bool asset_store_ready(const asset_store_t *s) { return s->upload && s->written == s->expected; }

bool asset_store_offer(asset_store_t *s, const char *name, uint32_t bytes, const char *sha256)
{
    if (s->upload || !asset_store_supported(s) || !name || !name[0] ||
        strlen(name) >= sizeof s->pending.name || !printable(name) || !bytes || bytes > asset_store_max_bytes(s))
        return false;
    memset(&s->pending, 0, sizeof s->pending);
    if (!hex_hash(sha256, s->pending.hash)) return false;
    if (atomic_exchange(&s->busy, true)) return false;
    s->target = s->slot == 0 ? 1 : 0;
    if (esp_partition_erase_range(s->partition, slot_at(s, s->target), s->slot_bytes) != ESP_OK) {
        atomic_store(&s->busy, false); return false;
    }
    s->pending.magic = s->magic;
    s->pending.format = s->format;
    s->pending.generation = s->slot < 0 ? 1 : s->header.generation + 1;
    s->pending.bytes = bytes;
    strcpy(s->pending.name, name);
    s->expected = bytes;
    s->written = 0;
    mbedtls_sha256_init(&s->hash);
    mbedtls_sha256_starts(&s->hash, 0);
    s->upload = true;
    return true;
}

bool asset_store_chunk(asset_store_t *s, const uint8_t *data, size_t size)
{
    if (!s->upload || !data || !size || size > 4096 || size > s->expected - s->written) return false;
    uint32_t at = slot_at(s, s->target) + sizeof(asset_header_t) + s->written;
    if (esp_partition_write(s->partition, at, data, size) != ESP_OK) return false;
    mbedtls_sha256_update(&s->hash, data, size);
    s->written += size;
    return true;
}

void asset_store_abort(asset_store_t *s)
{
    if (s->upload) {
        mbedtls_sha256_free(&s->hash);
        s->upload = false;
        atomic_store(&s->busy, false);
    }
}

bool asset_store_commit(asset_store_t *s)
{
    if (!s->upload || s->written != s->expected) return false;
    uint8_t actual[32];
    mbedtls_sha256_finish(&s->hash, actual);
    mbedtls_sha256_free(&s->hash);
    s->upload = false;
    asset_header_t checked;
    if (memcmp(actual, s->pending.hash, sizeof actual) != 0 ||
        esp_partition_write(s->partition, slot_at(s, s->target), &s->pending, sizeof s->pending) != ESP_OK ||
        !valid_slot(s, s->target, &checked)) {
        atomic_store(&s->busy, false); return false;
    }
    s->slot = s->target;
    s->header = checked;
    atomic_store(&s->busy, false);
    return true;
}

bool asset_store_restore(asset_store_t *s)
{
    if (s->upload || !asset_store_supported(s) || atomic_exchange(&s->busy, true)) return false;
    int target = s->slot == 0 ? 1 : 0;
    asset_header_t header = { .magic = s->magic, .format = s->format,
        .generation = s->slot < 0 ? 1 : s->header.generation + 1, .bytes = 0 };
    if (esp_partition_erase_range(s->partition, slot_at(s, target), s->slot_bytes) != ESP_OK ||
        esp_partition_write(s->partition, slot_at(s, target), &header, sizeof header) != ESP_OK) {
        atomic_store(&s->busy, false); return false;
    }
    s->slot = target;
    s->header = header;
    atomic_store(&s->busy, false);
    return true;
}

bool asset_store_read_begin(asset_store_t *s, int *slot, uint32_t *bytes)
{
    if (!asset_store_name(s) || atomic_exchange(&s->busy, true)) return false;
    *slot = s->slot;
    *bytes = s->header.bytes;
    return true;
}

bool asset_store_read(const asset_store_t *s, int slot, uint32_t offset, void *out, size_t size)
{
    uint32_t max = asset_store_max_bytes(s);
    return asset_store_supported(s) && slot >= 0 && slot < 2 && out && size <= max && offset <= max - size &&
        esp_partition_read(s->partition, slot_at(s, slot) + sizeof(asset_header_t) + offset, out, size) == ESP_OK;
}

void asset_store_read_end(asset_store_t *s) { atomic_store(&s->busy, false); }

bool asset_store_active_offset(const asset_store_t *s, uint32_t *offset)
{
    if (!asset_store_name(s)) return false;
    *offset = slot_at(s, s->slot) + sizeof(asset_header_t);
    return true;
}
