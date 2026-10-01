/*
CUSTOM_CONTENT.C

The web port's custom content (port/web/README.md): game rules the page
turns on and off while the game runs (infinite ammo, low gravity, big
heads, ...), a third-person camera, and, in the campaign, playing as
another character of the level (a Grunt, an Elite, a Hunter, ...).

The page writes its choices into the shared state (web_shared.h), through
web_custom.c; each frame cheats_update() calls custom_content_update(),
which applies them. Online, every player's page applies the room host's
rules, so the host's game and the players' agree on them.

Playing as another character swaps the player's unit for a new one of that
character where the player stands, armed as the level arms that character
(its actor variant's weapon and grenades). A character the level has no
tags for cannot be played: the player stays the Master Chief and the page
says so. The swap waits until the player is on foot, alive and not in a
cutscene, and it is made again after a checkpoint brings back the Master
Chief.
*/

#ifdef HALO_WEB

#include "cseries.h"
#include "ai/actor_definitions.h"
#include "cache/cache_files.h"
#include "cutscene/cinematics.h"
#include "camera/observer.h"
#include "camera/director.h"
#include "game/cheats.h"
#include "game/game.h"
#include "game/game_engine.h"
#include "game/game_globals.h"
#include "game/player_control.h"
#include "game/players.h"
#include "interface/ui_widget.h"
#include "items/weapons.h"
#include "items/weapon_definitions.h"
#include "models/model_definitions.h"
#include "objects/object_definitions.h"
#include "objects/object_types.h"
#include "objects/objects.h"
#include "physics/physics.h"
#include "scenario/scenario.h"
#include "tag_files/tag_files.h"
#include "units/biped_definitions.h"
#include "units/bipeds.h"
#include "units/units.h"
#include "network_distributed.h"

#include <stdlib.h>

/* ---------- the page's side (port/web/src/web_custom.c) */

long web_custom_rules(void);
long web_custom_character(void);
void web_custom_set_character_status(long status);
void web_custom_message(char const *text);
void web_custom_set_split_views(long views);
long web_custom_debug(void);
long web_custom_game_speed(void);
void platform_log(char const *format, ...);

/* the bits and characters of web_shared.h */
enum
{
	_custom_infinite_ammo = 1 << 0,
	_custom_low_gravity = 1 << 1,
	_custom_speed_boost = 1 << 2,
	_custom_super_jump = 1 << 3,
	_custom_big_heads = 1 << 4,
	_custom_one_shot_kills = 1 << 5,
	_custom_invincible = 1 << 6,
	_custom_third_person = 1 << 7,
	/* (the room host's) everyone is the Master Chief in multiplayer */
	_custom_master_chief_only = 1 << 8,
};

enum
{
	_character_default,
	_character_master_chief,
	_character_marine,
	_character_grunt,
	_character_jackal,
	_character_elite,
	_character_hunter,
	_character_flood_human,
	_character_flood_elite,
	_character_infection_form,
	_character_sentinel,
	_character_monitor,
	_character_keyes,
	NUMBER_OF_CHARACTERS
};

enum
{
	_character_status_none,
	_character_status_playing,
	_character_status_not_here,
};

/* ---------- constants */

#define LOW_GRAVITY_SCALE 0.35f
#define SPEED_BOOST_SCALE 1.6f
#define BIG_HEAD_SCALE 2.5f
#define MAXIMUM_HEAD_NODES 32

/* the characters' biped tags, by the end of their names (the level's own
tags: each campaign level loads the characters it has) */
static struct
{
	char const *name;
	char const *tags[3];
} const characters[NUMBER_OF_CHARACTERS] =
{
	{ NULL, { NULL } },
	{ "Master Chief", { NULL } },
	{ "Marine", { "\\marine\\marine", "\\marine_armored\\marine_armored", NULL } },
	{ "Grunt", { "\\grunt\\grunt", NULL } },
	{ "Jackal", { "\\jackal\\jackal", NULL } },
	{ "Elite", { "\\elite\\elite", NULL } },
	{ "Hunter", { "\\hunter\\hunter", NULL } },
	{ "Flood combat form", { "\\floodcombat_human\\floodcombat_human", NULL } },
	{ "Flood Elite", { "\\floodcombat elite\\floodcombat elite", "\\floodcombat_elite\\floodcombat_elite", NULL } },
	{ "Infection form", { "\\flood_infection\\flood_infection", NULL } },
	{ "Sentinel", { "\\sentinel\\sentinel", NULL } },
	{ "343 Guilty Spark", { "\\monitor\\monitor", NULL } },
	{ "Captain Keyes", { "\\captain\\captain", NULL } },
};

/* ---------- globals */

static struct
{
	long applied_rules;
	boolean applied_invincible;
	real base_gravity;
	boolean base_gravity_known;
	/* this map's biped for the character asked for, looked up once */
	long looked_up_character;
	long character_definition_index;
	long reported_character;
	long status;
	/* the player plays another character on this map (so that choosing the
	level's own again brings the Master Chief back) */
	boolean swapped;
} custom_globals = { 0, FALSE, 0.f, FALSE, NONE, NONE, NONE, _character_status_none, FALSE };

/* ---------- private code */

static boolean string_ends_with(
	char const *string,
	char const *end)
{
	size_t string_length = strlen(string);
	size_t end_length = strlen(end);

	return string_length >= end_length && !_stricmp(string + string_length - end_length, end);
}

static long character_biped_definition(
	long character)
{
	if (character != custom_globals.looked_up_character)
	{
		long definition_index = NONE;

		if (character == _character_master_chief)
		{
			struct game_globals_player_information *player_information = TAG_BLOCK_GET_ELEMENT(
				&scenario_get_game_globals()->player_information,
				0,
				struct game_globals_player_information);

			definition_index = player_information->player_unit.index;
		}
		else if (character > _character_master_chief && character < NUMBER_OF_CHARACTERS)
		{
			short tag_index;

			for (tag_index = 0; definition_index == NONE && characters[character].tags[tag_index]; tag_index++)
			{
				struct tag_iterator iterator;
				long biped_definition_index;

				tag_iterator_new(&iterator, BIPED_DEFINITION_TAG);
				while ((biped_definition_index = tag_iterator_next(&iterator)) != NONE)
				{
					if (string_ends_with(tag_get_name(biped_definition_index), characters[character].tags[tag_index]))
					{
						definition_index = biped_definition_index;
						break;
					}
				}
			}
		}

		custom_globals.looked_up_character = character;
		custom_globals.character_definition_index = definition_index;
	}

	return custom_globals.character_definition_index;
}

/* the actor variant of the level that uses a biped, for its weapon */
static struct actor_variant_definition *biped_actor_variant(
	long biped_definition_index)
{
	struct tag_iterator iterator;
	long variant_index;
	struct actor_variant_definition *unarmed = NULL;

	tag_iterator_new(&iterator, ACTOR_VARIANT_DEFINITION_TAG);
	while ((variant_index = tag_iterator_next(&iterator)) != NONE)
	{
		struct actor_variant_definition *variant = actor_variant_definition_get(variant_index);

		if (variant->unit_reference.index == biped_definition_index)
		{
			if (variant->ranged_combat.reference.index != NONE)
				return variant;
			if (!unarmed)
				unarmed = variant;
		}
	}

	return unarmed;
}

static void arm_unit(
	long unit_index,
	long biped_definition_index,
	boolean master_chief)
{
	if (master_chief)
	{
		if (*(long *)((byte *)global_scenario_get() + 0x348) != 0)
			player_add_equipment(unit_index, 0, TRUE);
	}
	else
	{
		struct actor_variant_definition *variant = biped_actor_variant(biped_definition_index);

		if (variant && variant->ranged_combat.reference.index != NONE)
		{
			struct object_placement_data placement_data;
			long weapon_index;

			object_placement_data_new(&placement_data, variant->ranged_combat.reference.index, unit_index);
			weapon_index = object_new(&placement_data);
			if (weapon_index != NONE &&
				!unit_add_weapon_to_inventory(unit_index, weapon_index, _unit_add_weapon_replace))
			{
				object_delete(weapon_index);
			}
		}
		if (variant && variant->grenade_combat.grenade_type != NONE)
			unit_add_grenade_type_to_inventory(unit_index, variant->grenade_combat.grenade_type, 2);
	}

	return;
}

/* the player's unit becomes a new one of another biped, where it stands */
static void swap_player_unit(
	short local_player_index,
	long old_unit_index,
	long biped_definition_index,
	boolean master_chief)
{
	struct unit_datum *old_unit = unit_get(old_unit_index);
	long player_index = local_player_get_player_index(local_player_index);
	struct player_datum *player = player_get(player_index);
	struct object_placement_data placement_data;
	long unit_index;

	object_placement_data_new(&placement_data, biped_definition_index, NONE);
	placement_data.position = old_unit->object.position;
	placement_data.forward = old_unit->object.forward;
	placement_data.up = *global_up3d;
	placement_data.forward.k = 0.f;
	if (normalize3d(&placement_data.forward) == 0.f)
		placement_data.forward = *global_forward3d;
	unit_index = object_new(&placement_data);
	if (unit_index == NONE)
		return;

	{
		struct unit_datum *unit = unit_get(unit_index);

		unit->object.owner_player_index = player_index;
		unit->object.owner_team_index = (short)player->team_index;
	}
	unit_delete_all_weapons(old_unit_index);
	players_set_local_player_unit(local_player_index, unit_index);
	object_delete(old_unit_index);
	arm_unit(unit_index, biped_definition_index, master_chief);

	return;
}

static void report_character(
	long character,
	long status)
{
	if (status != custom_globals.status || character != custom_globals.reported_character)
	{
		custom_globals.status = status;
		custom_globals.reported_character = character;
		web_custom_set_character_status(status);
		if (status == _character_status_not_here)
		{
			char text[128];

			csprintf(text, "This level has no %s: you're the Master Chief here.",
				characters[character].name);
			web_custom_message(text);
		}
	}

	return;
}

static void update_character(
	void)
{
	long character = web_custom_character();
	boolean back_to_master_chief = FALSE;
	short local_player_index;

	if (character <= _character_default && custom_globals.swapped)
	{
		character = _character_master_chief;
		back_to_master_chief = TRUE;
	}
	if (character <= _character_default || character >= NUMBER_OF_CHARACTERS ||
		(web_custom_debug() < 2 && (game_engine_running() || game_connection() != _game_connection_local)))
	{
		report_character(character, _character_status_none);
		return;
	}

	for (local_player_index = local_player_get_next(NONE);
		local_player_index != NONE;
		local_player_index = local_player_get_next(local_player_index))
	{
		long unit_index = player_control_get_unit_index(local_player_index);
		long definition_index;
		struct unit_datum *unit;

		if (unit_index == NONE)
			continue;
		definition_index = character_biped_definition(character);
		if (definition_index == NONE)
		{
			report_character(character, _character_status_not_here);
			continue;
		}
		unit = unit_get(unit_index);
		if (unit->definition_index == definition_index)
		{
			if (character == _character_master_chief)
				custom_globals.swapped = FALSE;
			report_character(back_to_master_chief ? _character_default : character,
				back_to_master_chief ? _character_status_none : _character_status_playing);
			continue;
		}
		/* on foot, alive, and not in a cutscene or the level's opening */
		if (unit->object.type != _object_type_biped ||
			unit->object.parent_object_index != NONE ||
			TEST_FLAG(unit->object.damage_flags, _object_dead_bit) ||
			cinematic_in_progress())
		{
			continue;
		}
		swap_player_unit(local_player_index, unit_index, definition_index, character == _character_master_chief);
		if (character != _character_master_chief)
			custom_globals.swapped = TRUE;
	}

	return;
}

static void scale_head(
	long unit_index,
	real_matrix4x3 *node_matrices)
{
	struct unit_datum *unit = unit_get(unit_index);
	struct object_definition *object_definition;
	struct biped_definition *definition;
	struct model *model;
	short stack[MAXIMUM_HEAD_NODES];
	short stack_count = 0;
	short head_node_index;
	real_point3d center;

	if (unit->object.type != _object_type_biped)
		return;
	definition = biped_definition_get(unit->definition_index);
	head_node_index = definition->biped.runtime_head_node_index;
	object_definition = object_definition_get(unit->definition_index);
	if (head_node_index == NONE || object_definition->object.model.index == NONE)
		return;
	model = model_definition_get(object_definition->object.model.index);
	if (head_node_index >= model->nodes.count)
		return;

	/* the head and everything below it grow about the head's node */
	center = node_matrices[head_node_index].position;
	stack[stack_count++] = head_node_index;
	while (stack_count > 0)
	{
		short node_index = stack[--stack_count];
		struct model_node *node = TAG_BLOCK_GET_ELEMENT(&model->nodes, node_index, struct model_node);
		real_matrix4x3 *matrix = &node_matrices[node_index];
		short child_index;

		matrix->scale *= BIG_HEAD_SCALE;
		matrix->position.x = center.x + (matrix->position.x - center.x) * BIG_HEAD_SCALE;
		matrix->position.y = center.y + (matrix->position.y - center.y) * BIG_HEAD_SCALE;
		matrix->position.z = center.z + (matrix->position.z - center.z) * BIG_HEAD_SCALE;
		for (child_index = node->first_child_node_index;
			child_index != NONE && child_index < model->nodes.count && stack_count < MAXIMUM_HEAD_NODES;
			child_index = TAG_BLOCK_GET_ELEMENT(&model->nodes, child_index, struct model_node)->next_sibling_node_index)
		{
			stack[stack_count++] = child_index;
		}
	}

	return;
}

/* ---------- public code */

/* ---------- characters in multiplayer (custom_characters.c brings them in) */

boolean custom_characters_available(void);
/* players.c's */
void placement_data_set_change_color(struct object_placement_data *placement_data, real_rgb_color const *change_color);
void network_player_attach_unit(long player_index, long unit_index);
void network_player_detach_unit(long player_index);
unsigned long custom_characters_checksum(void);
long custom_characters_biped(long character);
boolean custom_characters_arena(void);

enum
{
	/* how often a client tells the host its players' characters (ticks),
	and how long the host trusts what it was told */
	CHARACTER_REPORT_TICKS = 15,
	CHARACTER_REPORT_LIFETIME_TICKS = 150,
	/* how long after spawning a player may still become its character */
	SPAWN_SWAP_TICKS = 90,
};

/* a client's players' characters, for the host (network_distributed.c) */
struct distributed_character
{
	byte player_index;
	byte character;
	/* the client has the characters, from the level of the checksum */
	byte available;
	byte pad;
	unsigned long checksum;
};

static struct
{
	/* the host: what each client's player asked for */
	struct
	{
		long time;
		byte character;
		byte available;
		unsigned long checksum;
	} reported[MAXIMUM_TRACKED_PLAYERS];
	/* each player's unit whose weapons were made the character's */
	long armed_unit[MAXIMUM_TRACKED_PLAYERS];
	/* each player's latest unit, and when it was first seen */
	long seen_unit[MAXIMUM_TRACKED_PLAYERS];
	long seen_time[MAXIMUM_TRACKED_PLAYERS];
	boolean told_unavailable;
} multiplayer_characters;

static long multiplayer_unit_definition(
	void)
{
	struct game_globals_multiplayer_information *information = TAG_BLOCK_GET_ELEMENT(
		&scenario_get_game_globals()->multiplayer_information,
		0,
		struct game_globals_multiplayer_information);

	return information->unit.index;
}

/* (network_distributed.c, the host) a client's players' characters */
void custom_content_handle_characters(
	long machine_index,
	void const *entries,
	short count)
{
	struct distributed_character const *characters = entries;
	short index;

	for (index = 0; index < count; index++)
	{
		long player_index = distributed_player_from_byte(characters[index].player_index);
		short absolute_index = (short)DATUM_INDEX_TO_ABSOLUTE_INDEX(player_index);

		if (player_index == NONE || absolute_index < 0 || absolute_index >= MAXIMUM_TRACKED_PLAYERS ||
			!distributed_machine_has_player(machine_index, absolute_index))
		{
			continue;
		}
		multiplayer_characters.reported[absolute_index].time = game_time_get();
		multiplayer_characters.reported[absolute_index].character = characters[index].character;
		multiplayer_characters.reported[absolute_index].available = characters[index].available;
		multiplayer_characters.reported[absolute_index].checksum = characters[index].checksum;
	}

	return;
}

int custom_content_character_entry_size(
	void)
{
	return sizeof(struct distributed_character);
}

/* a client: its players' characters, to the host */
static void send_characters(
	void)
{
	struct
	{
		struct distributed_message_header header;
		struct distributed_character characters[MAXIMUM_LOCAL_PLAYERS];
	} message;
	short count = 0;
	short local_player_index;

	if (game_time_get() % CHARACTER_REPORT_TICKS)
		return;
	for (local_player_index = local_player_get_next(NONE);
		local_player_index != NONE;
		local_player_index = local_player_get_next(local_player_index))
	{
		struct distributed_character *character = &message.characters[count];

		csmemset(character, 0, sizeof(*character));
		character->player_index = distributed_player_to_byte(local_player_get_player_index(local_player_index));
		character->character = (byte)web_custom_character();
		character->available = (byte)custom_characters_available();
		character->checksum = custom_characters_checksum();
		count++;
	}
	if (count)
	{
		distributed_send(&message, _distributed_message_characters, count,
			(word)(sizeof(message.header) + count * sizeof(struct distributed_character)), _distributed_to_host);
	}

	return;
}

/* the host (or a game on one machine): whether every machine's players have
the characters, from the same level */
static boolean everyone_has_characters(
	void)
{
	short absolute_index;

	if (!custom_characters_available() || (web_custom_rules() & _custom_master_chief_only))
		return FALSE;
	if (game_connection() == _game_connection_local)
		return TRUE;
	for (absolute_index = 0; absolute_index < MAXIMUM_TRACKED_PLAYERS; absolute_index++)
	{
		struct player_datum *player = distributed_player(absolute_index);

		if (!player || player->local_player_index != NONE)
			continue;
		if (multiplayer_characters.reported[absolute_index].time == NONE ||
			game_time_get() - multiplayer_characters.reported[absolute_index].time > CHARACTER_REPORT_LIFETIME_TICKS ||
			!multiplayer_characters.reported[absolute_index].available ||
			multiplayer_characters.reported[absolute_index].checksum != custom_characters_checksum())
		{
			return FALSE;
		}
	}
	return TRUE;
}

/* the biped of the character a player asked for, where everyone in the game
can have it (NONE: the Master Chief); tell says why not to this machine's
player */
static long multiplayer_character_biped(
	long player_index,
	boolean tell)
{
	struct player_datum *player = player_get(player_index);
	short absolute_index = (short)DATUM_INDEX_TO_ABSOLUTE_INDEX(player_index);
	long character, biped;

	if (player->local_player_index != NONE)
		character = web_custom_character();
	else if (absolute_index >= 0 && absolute_index < MAXIMUM_TRACKED_PLAYERS &&
		multiplayer_characters.reported[absolute_index].time != NONE)
		character = multiplayer_characters.reported[absolute_index].character;
	else
		character = _character_default;
	if (character <= _character_master_chief)
		return NONE;
	tell = tell && player->local_player_index != NONE && !multiplayer_characters.told_unavailable;
	if (!everyone_has_characters())
	{
		if (tell)
		{
			multiplayer_characters.told_unavailable = TRUE;
			web_custom_message(!custom_characters_available() ?
				"Characters in multiplayer need the full game's maps: you're the Master Chief." :
				(web_custom_rules() & _custom_master_chief_only) ?
				"This game is Master Chief only." :
				"Someone in this game doesn't have the full game's maps: everyone is the Master Chief.");
		}
		return NONE;
	}
	biped = custom_characters_biped(character);
	if (biped == NONE && tell)
	{
		multiplayer_characters.told_unavailable = TRUE;
		web_custom_message(custom_characters_arena() ?
			"This level doesn't have that character: you're the Master Chief." :
			"In multiplayer you can be an Elite, a Grunt, a Hunter or a Marine.");
	}
	return biped;
}

/* (players.c, player_spawn) the biped a player spawns as in multiplayer */
long custom_content_multiplayer_unit(
	long player_index,
	long definition_index)
{
	long biped;

	if (game_connection() == _game_connection_network_client)
		return definition_index;
	biped = multiplayer_character_biped(player_index, FALSE);
	return biped != NONE ? biped : definition_index;
}

/* the host: a player's unit becomes one of the character, where it stands
(just after it spawned: the players' choices reach the host a moment after
the game starts) */
static void swap_multiplayer_unit(
	long player_index,
	long biped)
{
	struct player_datum *player = player_get(player_index);
	long old_unit_index = player->unit_index;
	struct unit_datum *old_unit = unit_get(old_unit_index);
	struct object_placement_data placement_data;
	real_rgb_color change_color_storage, change_color;
	long unit_index;

	object_placement_data_new(&placement_data, biped, NONE);
	placement_data.position = old_unit->object.position;
	placement_data.forward = old_unit->object.forward;
	placement_data.forward.k = 0.f;
	if (normalize3d(&placement_data.forward) == 0.f)
		placement_data.forward = *global_forward3d;
	placement_data.up = *global_up3d;
	change_color = *game_engine_player_get_change_color(&change_color_storage, player_index);
	placement_data_set_change_color(&placement_data, &change_color);
	unit_index = object_new(&placement_data);
	if (unit_index == NONE)
		return;
	network_player_detach_unit(player_index);
	unit_delete_all_weapons(old_unit_index);
	object_delete(old_unit_index);
	network_player_attach_unit(player_index, unit_index);

	return;
}

/* the host: a character's unit keeps only the weapons it can hold, and has
its own when it has none */
static void arm_multiplayer_characters(
	void)
{
	static char const *const weapons[NUMBER_OF_CHARACTERS] =
	{
		NULL, NULL,
		"weapons\\assault rifle\\assault rifle",
		"weapons\\plasma pistol\\plasma pistol",
		NULL,
		"weapons\\plasma rifle\\plasma rifle",
		"weapons\\fuel rod gun\\hunter fuel rod",
	};
	long default_definition = multiplayer_unit_definition();
	short absolute_index;

	for (absolute_index = 0; absolute_index < MAXIMUM_TRACKED_PLAYERS; absolute_index++)
	{
		struct player_datum *player = distributed_player(absolute_index);
		struct unit_datum *unit;
		short weapon, character;
		boolean unusable = FALSE, armed = FALSE;

		if (!player || player->unit_index == NONE)
			continue;
		unit = unit_get(player->unit_index);
		if (multiplayer_characters.seen_unit[absolute_index] != player->unit_index)
		{
			multiplayer_characters.seen_unit[absolute_index] = player->unit_index;
			multiplayer_characters.seen_time[absolute_index] = game_time_get();
		}
		if (unit->definition_index == default_definition)
		{
			long since_spawn = game_time_get() - multiplayer_characters.seen_time[absolute_index];

			if (since_spawn < SPAWN_SWAP_TICKS && unit->object.type == _object_type_biped &&
				unit->object.parent_object_index == NONE && !TEST_FLAG(unit->object.damage_flags, _object_dead_bit))
			{
				long biped = multiplayer_character_biped(DATUM_INDEX_NEW(absolute_index, player->identifier), FALSE);

				if (biped != NONE)
					swap_multiplayer_unit(DATUM_INDEX_NEW(absolute_index, player->identifier), biped);
			}
			else if (since_spawn == SPAWN_SWAP_TICKS)
			{
				/* (why not, to this machine's player) */
				multiplayer_character_biped(DATUM_INDEX_NEW(absolute_index, player->identifier), TRUE);
			}
			continue;
		}
		if (multiplayer_characters.armed_unit[absolute_index] == player->unit_index ||
			unit->object.type != _object_type_biped)
		{
			continue;
		}
		multiplayer_characters.armed_unit[absolute_index] = player->unit_index;
		for (weapon = 0; weapon < MAXIMUM_WEAPONS_PER_UNIT; weapon++)
		{
			if (unit->unit.weapon_object_indices[weapon] == NONE)
				continue;
			if (unit_can_use_weapon(player->unit_index, unit->unit.weapon_object_indices[weapon]))
				armed = TRUE;
			else
				unusable = TRUE;
		}
		if (armed && !unusable)
			continue;
		unit_delete_all_weapons(player->unit_index);
		for (character = _character_marine; character < NUMBER_OF_CHARACTERS; character++)
		{
			if (weapons[character] && custom_characters_biped(character) == unit->definition_index)
			{
				long definition = tag_loaded(WEAPON_DEFINITION_TAG, weapons[character]);
				struct object_placement_data placement_data;
				long weapon_index;

				if (definition == NONE)
					break;
				object_placement_data_new(&placement_data, definition, player->unit_index);
				weapon_index = object_new(&placement_data);
				if (weapon_index != NONE &&
					!unit_add_weapon_to_inventory(player->unit_index, weapon_index, _unit_add_weapon_replace))
				{
					object_delete(weapon_index);
				}
				break;
			}
		}
	}

	return;
}

/* the page's status line: whether this machine's first player plays the
character it asked for */
static void report_multiplayer_character(
	void)
{
	short local_player_index = local_player_get_next(NONE);
	long unit_index = local_player_index != NONE ? player_control_get_unit_index(local_player_index) : NONE;
	long character = web_custom_character();
	long biped = custom_characters_biped(character);

	web_custom_set_character_status(unit_index != NONE && biped != NONE && unit_get(unit_index)->definition_index == biped ?
		_character_status_playing : _character_status_none);
}

static void update_multiplayer_characters(
	void)
{
	report_multiplayer_character();
	if (!game_engine_running() || main_menu_is_active())
		return;
	if (game_connection() == _game_connection_network_client)
		send_characters();
	else if (custom_characters_available())
		arm_multiplayer_characters();

	return;
}

void custom_content_new_map(
	void)
{
	custom_globals.looked_up_character = NONE;
	custom_globals.character_definition_index = NONE;
	custom_globals.reported_character = NONE;
	custom_globals.status = NONE;
	custom_globals.swapped = FALSE;
	{
		short index;

		for (index = 0; index < MAXIMUM_TRACKED_PLAYERS; index++)
		{
			multiplayer_characters.reported[index].time = NONE;
			multiplayer_characters.armed_unit[index] = NONE;
			multiplayer_characters.seen_unit[index] = NONE;
		}
		multiplayer_characters.told_unavailable = FALSE;
	}

	return;
}

/* each frame, before the players' controls and the game's tick */
void custom_content_update(
	void)
{
	long rules = web_custom_rules();
	long changed = rules ^ custom_globals.applied_rules;
	boolean campaign = !game_engine_running();

	if (!custom_globals.base_gravity_known)
	{
		custom_globals.base_gravity = global_gravity;
		custom_globals.base_gravity_known = TRUE;
	}

	/* only the rules that changed: the game's own cheats stay as they are */
	if (changed & _custom_infinite_ammo)
	{
		cheat.infinite_ammo = (rules & _custom_infinite_ammo) != 0;
		cheat.bottomless_clip = cheat.infinite_ammo;
	}
	if (changed & _custom_super_jump)
		cheat.super_jump = (rules & _custom_super_jump) != 0;
	if (changed & _custom_one_shot_kills)
		cheat.omnipotent = (rules & _custom_one_shot_kills) != 0;
	{
		boolean invincible = campaign && (rules & _custom_invincible) != 0;

		if (invincible != custom_globals.applied_invincible)
		{
			cheat.deathless_player = invincible;
			custom_globals.applied_invincible = invincible;
		}
	}
	global_gravity = custom_globals.base_gravity * ((rules & _custom_low_gravity) ? LOW_GRAVITY_SCALE : 1.f);
	custom_globals.applied_rules = rules;

	if (game_in_progress())
	{
		update_character();
		update_multiplayer_characters();
	}

	/* captures: a slower game, sped up afterwards */
	if (web_custom_game_speed() > 0 && game_in_progress() && !main_menu_is_active() &&
		game_time_get_speed() != web_custom_game_speed() / 1000.0f)
	{
		game_time_set_speed(web_custom_game_speed() / 1000.0f);
	}

	/* for remote co-op: which part of the screen is the second player's */
	web_custom_set_split_views(!game_in_progress() || main_menu_is_active() ? 0 :
		cinematic_in_progress() || game_engine_force_single_screen() ? 1 : local_player_count());

	if (web_custom_debug())
	{
		static long frame;
		short local_player_index = local_player_get_next(NONE);
		long unit_index = local_player_index != NONE ? player_control_get_unit_index(local_player_index) : NONE;

		if (changed)
			platform_log("custom content: rules %lx, gravity %f, connection %d, game engine %d",
				rules, global_gravity, (int)game_connection(), (int)game_engine_running());
		if (unit_index != NONE)
		{
			/* a jump's height, and the fastest step on foot */
			static real ground_z, peak_z, top_speed;
			static long air_frames;
			struct unit_datum *unit = unit_get(unit_index);
			real speed = (real)sqrt(unit->object.translational_velocity.i * unit->object.translational_velocity.i +
				unit->object.translational_velocity.j * unit->object.translational_velocity.j);

			if (unit->object.translational_velocity.k != 0.f)
			{
				if (!air_frames++)
					peak_z = ground_z = unit->object.position.z;
				peak_z = MAX(peak_z, unit->object.position.z);
			}
			else if (air_frames)
			{
				platform_log("custom content: %s jumped %.3f in %ld frames",
					tag_get_name(unit->definition_index), peak_z - ground_z, air_frames);
				air_frames = 0;
			}
			top_speed = MAX(top_speed, speed);
			if ((++frame % 60) == 0)
			{
				{
					/* where the camera is, from the unit */
					struct observer_result const *camera = observer_get_camera(local_player_index);

					platform_log("custom content: %s at (%.2f %.2f %.2f), camera (%.2f %.2f %.2f), perspective %d",
						tag_get_name(unit->definition_index), unit->object.position.x, unit->object.position.y,
						unit->object.position.z, camera->position.x, camera->position.y, camera->position.z,
						(int)director_get_perspective(local_player_index));
				}
				if (top_speed > 0.f)
					platform_log("custom content: %s top speed %.4f", tag_get_name(unit->definition_index), top_speed);
				top_speed = 0.f;
			}
		}
	}

	return;
}

real custom_content_speed_scale(
	void)
{
	return (web_custom_rules() & _custom_speed_boost) ? SPEED_BOOST_SCALE : 1.f;
}

void custom_content_postprocess_unit(
	long unit_index,
	real_matrix4x3 *node_matrices)
{
	if (web_custom_rules() & _custom_big_heads)
		scale_head(unit_index, node_matrices);

	return;
}

/* (following_camera.c) how far and how high the camera follows a unit
from, relative to its track: the Elite's is set too high for it */
void custom_content_camera_adjust(
	long unit_index,
	real *distance_scale,
	real *height)
{
	struct unit_datum *unit;

	*distance_scale = 1.f;
	*height = 0.f;
	if (unit_index == NONE)
		return;
	unit = unit_get(unit_index);
	if (unit->object.type == _object_type_biped && unit->object.parent_object_index == NONE &&
		(string_ends_with(tag_get_name(unit->definition_index), "\\elite\\elite") ||
			string_ends_with(tag_get_name(unit->definition_index), "\\elite special")))
	{
		*distance_scale = 1.1f;
		*height = -0.7f;
	}
	return;
}

/* the camera follows the player's unit from behind: asked for, or the
player plays as a character the first-person view was not made for */
boolean custom_content_third_person(
	long unit_index)
{
	struct unit_datum *unit;

	if (unit_index == NONE)
		return FALSE;
	unit = unit_get(unit_index);
	if (unit->object.type != _object_type_biped || unit->object.parent_object_index != NONE)
		return FALSE;
	if (web_custom_rules() & _custom_third_person)
		return TRUE;
	if (!game_engine_running())
	{
		struct game_globals_player_information *player_information = TAG_BLOCK_GET_ELEMENT(
			&scenario_get_game_globals()->player_information,
			0,
			struct game_globals_player_information);

		return unit->definition_index != player_information->player_unit.index;
	}

	/* a character brought into multiplayer */
	if (web_custom_debug())
	{
		static long logged_unit = NONE;

		if (logged_unit != unit_index)
		{
			logged_unit = unit_index;
			platform_log("custom content: camera for %s (multiplayer unit %s)", tag_get_name(unit->definition_index),
				tag_get_name(multiplayer_unit_definition()));
		}
	}
	return unit->definition_index != multiplayer_unit_definition();
}

#endif
