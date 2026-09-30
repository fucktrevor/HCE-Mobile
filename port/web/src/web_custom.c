/*
WEB_CUSTOM.C

The page's custom content choices, for the game (port/linux/game/
custom_content.c): the game rules and the character to play as, which the
page writes into the shared state (web_shared.h), and the game's answers.
*/

#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>

#include "web_shared.h"

/* web_library.js */
void web_js_post(int kind, const char *text);

long web_custom_rules(void)
{
	return __atomic_load_n(&web_shared_state()->custom_rules, __ATOMIC_RELAXED);
}

long web_custom_character(void)
{
	return __atomic_load_n(&web_shared_state()->custom_character, __ATOMIC_RELAXED);
}

void web_custom_set_character_status(long status)
{
	__atomic_store_n(&web_shared_state()->custom_character_status, (int32_t)status, __ATOMIC_RELAXED);
}

/* a line the page shows for a few seconds */
void web_custom_message(const char *text)
{
	web_js_post(1, text);
}

/* tests: --HALO_CUSTOM_DEBUG=1 logs what the rules do; 2 also lets a
character be played in a (split screen) multiplayer game */
long web_custom_debug(void)
{
	static int debug = -1;

	if (debug < 0)
		debug = getenv("HALO_CUSTOM_DEBUG") ? atoi(getenv("HALO_CUSTOM_DEBUG")) : 0;
	return debug;
}
