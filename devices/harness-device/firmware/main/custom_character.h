#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "ui/habitat/pets.h"

/*
 * THE OWNER'S CHARACTER, installed from the app into the second region of the assets partition and drawn by the
 * Focus face in place of the engine pets: one animation while the agent thinks, one while a tool runs, one when the
 * turn is finished or resting. Without one installed every accessor answers NULL and the face keeps its pets.
 *
 * The installed bytes (little endian), checked whole before anything draws from them:
 *   u32 magic "HCH1" | u16 palette[256], RGB565 in panel order, entry 0 unused (transparent) |
 *   3 x { u8 frames, cols, rows, cell; u16 step_ms, reserved; u32 offset }  in role order |
 *   then each animation's frames, cols x rows palette indices each, at its offset.
 * An animation with zero frames is absent; at least one must be present.
 */
#define CUSTOM_CHARACTER_SLOT_BYTES 0x80000u
#define CUSTOM_CHARACTER_MAX_BYTES (CUSTOM_CHARACTER_SLOT_BYTES - 80u)
#define CUSTOM_CHARACTER_MAGIC 0x31484348u   // "HCH1"
#define CUSTOM_CHARACTER_MAX_FRAMES 32

typedef enum { CUSTOM_ROLE_THINKING, CUSTOM_ROLE_TOOL, CUSTOM_ROLE_IDLE, CUSTOM_ROLES } custom_role_t;

typedef struct {
    uint16_t palette[256];
    ht_cell_frame_t frames[CUSTOM_ROLES][CUSTOM_CHARACTER_MAX_FRAMES];
    uint8_t loop[CUSTOM_ROLES][CUSTOM_CHARACTER_MAX_FRAMES];
    ht_pet_scene_t scenes[CUSTOM_ROLES];
    bool present[CUSTOM_ROLES];
} custom_character_t;

// Parses `blob` into `out`, whose frames point into `blob`; false (and `out` untouched in meaning) when invalid.
bool custom_character_parse(const uint8_t *blob, size_t size, custom_character_t *out);

void custom_character_init(void);
bool custom_character_supported(void);
const char *custom_character_name(void);   // NULL: the engine pets
uint32_t custom_character_bytes(void);
bool custom_character_offer(const char *name, uint32_t bytes, const char *sha256);
bool custom_character_chunk(const uint8_t *data, size_t size);
bool custom_character_ready(void);
uint32_t custom_character_written(void);
// Commit and restore switch the active slot; the face keeps drawing the previous character (whose slot only a
// later offer erases) until custom_character_reload, which the caller runs with the display locked.
bool custom_character_commit(void);
bool custom_character_restore(void);
void custom_character_abort(void);
void custom_character_reload(void);

// The scene for a role: its own, else a missing working role borrows the other; NULL without a character.
const ht_pet_scene_t *custom_character_scene(custom_role_t role);
bool custom_character_owns(const ht_pet_scene_t *scene);
