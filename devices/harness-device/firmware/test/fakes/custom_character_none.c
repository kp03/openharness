// The UI tests' installed character: none, so the face draws the engine pets.
#include "../../main/custom_character.h"

const ht_pet_scene_t *custom_character_scene(custom_role_t role) { (void)role; return NULL; }
bool custom_character_owns(const ht_pet_scene_t *scene) { (void)scene; return false; }
void custom_character_reload(void) {}
