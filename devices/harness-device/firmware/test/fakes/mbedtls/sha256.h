#pragma once
#include <stddef.h>
#include <stdint.h>
typedef struct { uint8_t state[32]; uint32_t at; } mbedtls_sha256_context;
void mbedtls_sha256_init(mbedtls_sha256_context *ctx);
void mbedtls_sha256_free(mbedtls_sha256_context *ctx);
int mbedtls_sha256_starts(mbedtls_sha256_context *ctx, int is224);
int mbedtls_sha256_update(mbedtls_sha256_context *ctx, const unsigned char *data, size_t len);
int mbedtls_sha256_finish(mbedtls_sha256_context *ctx, unsigned char output[32]);
