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

/* remote co-op (site/coop.js): the views on the screen */
void web_custom_set_split_views(long views)
{
	__atomic_store_n(&web_shared_state()->split_views, (int32_t)views, __ATOMIC_RELAXED);
}

/* a line the page shows for a few seconds */
void web_custom_message(const char *text)
{
	web_js_post(1, text);
}

/* captures: --HALO_WEB_GAME_SPEED=0.25 runs games at a quarter of their
speed, for recordings on slow machines that are sped up afterwards
(thousandths; 0 when not set) */
long web_custom_game_speed(void)
{
	static long speed = -1;

	if (speed < 0)
		speed = getenv("HALO_WEB_GAME_SPEED") ? (long)(atof(getenv("HALO_WEB_GAME_SPEED")) * 1000.0) : 0;
	return speed;
}

/* tests and captures: --HALO_WEB_ALL_LEVELS=1 offers every campaign level */
long web_custom_all_levels(void)
{
	return getenv("HALO_WEB_ALL_LEVELS") != NULL;
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
