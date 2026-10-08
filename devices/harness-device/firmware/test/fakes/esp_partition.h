#pragma once
#include <stdint.h>
#include <stddef.h>
#define ESP_OK 0
#define ESP_PARTITION_TYPE_DATA 1
#define ESP_PARTITION_SUBTYPE_ANY 0xff
typedef int esp_err_t;
typedef struct { uint32_t size; } esp_partition_t;
const esp_partition_t *esp_partition_find_first(int type, int subtype, const char *label);
esp_err_t esp_partition_read(const esp_partition_t *part, uint32_t offset, void *out, size_t size);
esp_err_t esp_partition_write(const esp_partition_t *part, uint32_t offset, const void *data, size_t size);
esp_err_t esp_partition_erase_range(const esp_partition_t *part, uint32_t offset, size_t size);
#define ESP_PARTITION_MMAP_DATA 0
typedef uint32_t esp_partition_mmap_handle_t;
esp_err_t esp_partition_mmap(const esp_partition_t *part, size_t offset, size_t size, int memory,
                             const void **out_ptr, esp_partition_mmap_handle_t *out_handle);
