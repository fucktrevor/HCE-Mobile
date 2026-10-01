/*
CUSTOM_CHARACTERS.C

The web port's characters in multiplayer (port/web/README.md, "Custom
content"): the multiplayer maps have only the Master Chief, so as one loads,
the Elite, the Grunt, the Hunter and the Marine are brought in from a
campaign level, The Silent Cartographer (b30), which has all four.

The campaign level is decompressed once into z:\characters-b30.map. Its tag
data is read, and the tags the four characters use (their bipeds, models,
animations, collision, shaders, bitmaps, sounds, effects, and the Hunter's
weapon) are copied after the multiplayer map's own; a tag the multiplayer
map has too (a weapon, an effect) is the map's own. The copied tags' tag
blocks, data, references and Direct3D vertex and index buffers point into
their copy, and their tag indices follow the map's, in the campaign level's
order, so every machine that brings them in has them at the same indices.
Their bitmaps' pixels and sounds' samples are read from the decompressed
level (cache_files_windows.c, cache_file_read).

A cache file has no field definitions: what is a pointer, a tag block, a tag
data or a tag reference is found by its shape. A tag's data runs from where
it starts to where the next tag starts, its root first and its blocks and
data after it; a tag data's contents (an animation's frames) are left as
they are. Every one of the four characters' tags is laid out so.

Dialogue (AI speech), actors and actor variants are not brought in: players
do not speak, and multiplayer has no AI.
*/

#ifdef HALO_WEB

#include "cseries.h"
#include "cseries_windows.h"
#include "cache/cache_files.h"
#include "memory/zlib/zlib.h"
#include "ai/ai_scenario_definitions.h"
#include "game/game_engine.h"
#include "game/game_globals.h"
#include "scenario/scenario_definitions.h"
#include "hs/hs_scenario_definitions.h"

#include <math.h>

#include <stdio.h>
#include <string.h>
#include <stdlib.h>

/* ---------- the port's */

void platform_log(char const *format, ...);
void *platform_contiguous_alloc(unsigned long size, unsigned long alignment,
	unsigned long physical_address, unsigned long protect);
void platform_contiguous_free(void *address);
void web_custom_message(char const *text);

#define PLATFORM_ANY_PHYSICAL_ADDRESS 0xffffffffUL
#define CONTIGUOUS_READWRITE 0x04 /* PAGE_READWRITE */
#define D3DCOMMON_TYPE_VERTEXBUFFER 0x00000000
#define D3DCOMMON_TYPE_INDEXBUFFER 0x00010000

/* ---------- constants */

#define TAG_CACHE_BASE 0x803A6000UL
#define CACHE_HEADER_SIZE 0x800

#define TAG(a, b, c, d) (((unsigned long)(a) << 24) | ((unsigned long)(b) << 16) | ((unsigned long)(c) << 8) | (unsigned long)(d))

enum
{
	_donor_unvisited = 0,
	_donor_new,
	_donor_shared,
	_donor_dropped,
};

enum
{
	_relocation_pointer = 0,
	_relocation_handle,
};

/* ---------- structures (cache_files.c's) */

struct cache_instance
{
	unsigned long group_tag;
	unsigned long parent_group_tags[2];
	unsigned long tag_index;
	unsigned long name;
	unsigned long base_address;
	unsigned long unused[2];
};

struct cache_tag_header
{
	struct cache_instance *tag_instances;
	long scenario_tag_index;
	unsigned long checksum;
	long tag_count;
	long vertex_buffer_count;
	unsigned long vertex_buffers;
	long index_buffer_count;
	unsigned long index_buffers;
	unsigned long signature;
};

struct donor_tag
{
	struct cache_instance instance;
	unsigned long end;
	long state;
	/* new: the index among the new tags; shared: the map's tag index */
	long target;
	/* new: where its copy is */
	unsigned long copy;
	/* new: its pointers and tag indices (offsets into it, and kinds) */
	unsigned long *relocations;
	long relocation_count;
};

/* ---------- globals */

/* what a map takes from another: the characters from The Silent
Cartographer for a multiplayer map, or multiplayer's own tags from Blood
Gulch for The Silent Cartographer played as a multiplayer map (custom
arenas, below) */
struct tag_import
{
	char const *map_path;
	char const *cache_path;
	char const *message;
	/* the tags to bring in, and those brought in even where the map has its
	own of the name */
	boolean (*root)(struct donor_tag *tag);
	boolean (*force_new)(struct donor_tag *tag);
	/* with the tags in, and the donor's still read */
	boolean (*after)(struct cache_tag_header *header, long map_count);
};

enum
{
	_import_characters,
	_import_arena,
	NUMBER_OF_IMPORTS
};

extern struct game_variant game_variant_global;

static struct
{
	/* each import's tags, after the map's */
	struct
	{
		long first_new_index;
		long end_new_index;
		void *memory;
		HANDLE file;
	} imports[NUMBER_OF_IMPORTS];
	/* the arena's own memory (its scenario's new blocks) */
	void *arena_memory;
	unsigned long checksum;
	boolean available;
	boolean arena;
	char message[160];
} custom_characters;

/* the donor's tag data while the tags are brought in */
static struct
{
	byte *data;
	unsigned long size;
	unsigned long end;
	struct donor_tag *tags;
	long tag_count;
	unsigned long first_tag_address;
	unsigned long vertex_buffers, index_buffers;
	long vertex_buffer_count, index_buffer_count;
	unsigned long groups[256];
	long group_count;
} donor;

/* ---------- the decompressed level */

static long file_size(FILE *file)
{
	long size;

	fseek(file, 0, SEEK_END);
	size = ftell(file);
	fseek(file, 0, SEEK_SET);
	return size;
}

/* the level, decompressed (Xbox cache files are a header, then the rest
compressed with zlib), once */
static boolean donor_prepare(struct tag_import const *import)
{
	char source_path[1024], cache_path[1024], temporary_path[1100];
	byte header[CACHE_HEADER_SIZE];
	FILE *source, *cache;
	long file_length;
	z_stream stream;
	byte *in, *out;
	boolean ok = FALSE;
	int result = Z_OK;

	/* (the game's fopen, remove and rename take Xbox paths: msvc_crt.c) */
	snprintf(cache_path, sizeof(cache_path), "%s", import->cache_path);
	snprintf(source_path, sizeof(source_path), "%s", import->map_path);
	source = fopen(source_path, "rb");
	if (!source)
	{
		platform_log("custom characters: no %s", import->map_path);
		return FALSE;
	}
	if (fread(header, 1, sizeof(header), source) != sizeof(header) ||
		*(unsigned long *)header != TAG('h', 'e', 'a', 'd'))
	{
		fclose(source);
		return FALSE;
	}
	file_length = *(long *)(header + 8);

	cache = fopen(cache_path, "rb");
	if (cache)
	{
		byte cached_header[CACHE_HEADER_SIZE];
		boolean same = fread(cached_header, 1, sizeof(cached_header), cache) == sizeof(cached_header) &&
			!memcmp(cached_header, header, sizeof(header)) && file_size(cache) == file_length;

		fclose(cache);
		if (same)
		{
			fclose(source);
			return TRUE;
		}
	}

	snprintf(custom_characters.message, sizeof(custom_characters.message), "%s", import->message);
	web_custom_message(custom_characters.message);
	platform_log("custom characters: decompressing %s", import->map_path);
	snprintf(temporary_path, sizeof(temporary_path), "%s.part", cache_path);
	cache = fopen(temporary_path, "wb");
	in = malloc(0x40000);
	out = malloc(0x100000);
	if (cache && in && out && fwrite(header, 1, sizeof(header), cache) == sizeof(header))
	{
		long written = sizeof(header);

		memset(&stream, 0, sizeof(stream));
		if (inflateInit(&stream) == Z_OK)
		{
			while (result != Z_STREAM_END)
			{
				if (!stream.avail_in)
				{
					stream.avail_in = (uInt)fread(in, 1, 0x40000, source);
					stream.next_in = in;
					if (!stream.avail_in)
						break;
				}
				stream.next_out = out;
				stream.avail_out = 0x100000;
				result = inflate(&stream, Z_NO_FLUSH);
				if (result != Z_OK && result != Z_STREAM_END)
					break;
				if (fwrite(out, 1, 0x100000 - stream.avail_out, cache) != 0x100000 - stream.avail_out)
					break;
				written += 0x100000 - stream.avail_out;
			}
			inflateEnd(&stream);
			ok = result == Z_STREAM_END && written == file_length;
		}
	}
	if (in)
		free(in);
	if (out)
		free(out);
	fclose(source);
	if (cache && fclose(cache) != 0)
		ok = FALSE;
	if (ok)
	{
		remove(cache_path);
		ok = rename(temporary_path, cache_path) == 0;
	}
	if (!ok)
		remove(temporary_path);
	platform_log("custom characters: decompressed %s: %s", import->map_path, ok ? "done" : "failed");
	return ok;
}

/* ---------- the donor's tags */

static unsigned long donor_word(unsigned long address)
{
	return *(unsigned long *)(donor.data + (address - TAG_CACHE_BASE));
}

static char const *donor_string(unsigned long address)
{
	return (char const *)(donor.data + (address - TAG_CACHE_BASE));
}

static boolean donor_address(unsigned long address)
{
	return address >= TAG_CACHE_BASE && address < donor.end;
}

/* a donor tag index, or NONE */
static long donor_handle(unsigned long value)
{
	long index = (long)(value & 0xFFFF);

	if (value == 0xFFFFFFFFUL || index >= donor.tag_count || donor.tags[index].instance.tag_index != value)
		return NONE;
	return index;
}

static boolean donor_group(unsigned long value)
{
	long index;

	for (index = 0; index < donor.group_count; index++)
	{
		if (donor.groups[index] == value)
			return TRUE;
	}
	return FALSE;
}

static int compare_addresses(void const *a, void const *b)
{
	unsigned long left = **(unsigned long const **)a, right = **(unsigned long const **)b;

	return left < right ? -1 : left > right;
}

static boolean donor_load(FILE *file)
{
	byte header[CACHE_HEADER_SIZE];
	struct cache_tag_header *tag_header;
	unsigned long **order;
	long offset, index;

	if (fread(header, 1, sizeof(header), file) != sizeof(header))
		return FALSE;
	offset = *(long *)(header + 0x10);
	donor.size = *(unsigned long *)(header + 0x14);
	donor.data = malloc(donor.size);
	if (!donor.data || fseek(file, offset, SEEK_SET) != 0)
		return FALSE;
	{
		/* (in pieces: one large read from the browser's storage is slow) */
		unsigned long done = 0;

		while (done < donor.size)
		{
			unsigned long piece = MIN(donor.size - done, 0x40000UL);

			if (fread(donor.data + done, 1, piece, file) != piece)
				return FALSE;
			done += piece;
		}
	}
	donor.end = TAG_CACHE_BASE + donor.size;
	tag_header = (struct cache_tag_header *)donor.data;
	if (tag_header->signature != TAG('t', 'a', 'g', 's'))
		return FALSE;
	custom_characters.checksum = *(unsigned long *)(header + 0x64);
	donor.tag_count = tag_header->tag_count;
	donor.vertex_buffers = tag_header->vertex_buffers;
	donor.index_buffers = tag_header->index_buffers;
	donor.vertex_buffer_count = tag_header->vertex_buffer_count;
	donor.index_buffer_count = tag_header->index_buffer_count;
	/* (malloc: the game's calloc is the Xbox runtime's, on another heap) */
	donor.tags = malloc(donor.tag_count * sizeof(*donor.tags));
	if (donor.tags)
		memset(donor.tags, 0, donor.tag_count * sizeof(*donor.tags));
	order = malloc(donor.tag_count * sizeof(*order));
	if (!donor.tags || !order)
	{
		if (order)
			free(order);
		return FALSE;
	}
	donor.group_count = 0;
	for (index = 0; index < donor.tag_count; index++)
	{
		struct donor_tag *tag = &donor.tags[index];

		memcpy(&tag->instance, donor.data + ((unsigned long)tag_header->tag_instances - TAG_CACHE_BASE) +
			index * sizeof(struct cache_instance), sizeof(struct cache_instance));
		order[index] = &tag->instance.base_address;
		if (!donor_group(tag->instance.group_tag) && donor.group_count < 256)
			donor.groups[donor.group_count++] = tag->instance.group_tag;
	}
	/* each tag runs to the next */
	qsort(order, donor.tag_count, sizeof(*order), compare_addresses);
	donor.first_tag_address = 0;
	for (index = 0; index < donor.tag_count; index++)
	{
		struct donor_tag *tag = (struct donor_tag *)((byte *)order[index] - offsetof(struct cache_instance, base_address));

		if (!tag->instance.base_address)
			continue;
		if (!donor.first_tag_address)
			donor.first_tag_address = tag->instance.base_address;
		tag->end = index + 1 < donor.tag_count ? *order[index + 1] : donor.end;
	}
	free(order);
	return TRUE;
}

static void donor_dispose(void)
{
	long index;

	/* (malloc and free only, and never free(NULL): the game's calloc is
	the Xbox runtime's, on a heap of its own) */
	if (donor.tags)
	{
		for (index = 0; index < donor.tag_count; index++)
		{
			if (donor.tags[index].relocations)
				free(donor.tags[index].relocations);
		}
		free(donor.tags);
	}
	if (donor.data)
		free(donor.data);
	donor.tags = NULL;
	donor.data = NULL;
	donor.tag_count = 0;
	donor.group_count = 0;
}

static void relocation_add(struct donor_tag *tag, unsigned long offset, unsigned long kind)
{
	if ((tag->relocation_count & 63) == 0)
	{
		tag->relocations = tag->relocations ?
			realloc(tag->relocations, (tag->relocation_count + 64) * sizeof(unsigned long)) :
			malloc(64 * sizeof(unsigned long));
	}
	tag->relocations[tag->relocation_count++] = (offset << 1) | kind;
}

/* finds a tag's pointers and tag indices by their shape (see the top) */
static void donor_scan(struct donor_tag *tag)
{
	unsigned long start = tag->instance.base_address, end = tag->end, address = start;
	unsigned long opaque[512][2];
	long opaque_count = 0, index;

	while (address + 4 <= end)
	{
		unsigned long w[5];
		short count;

		for (index = 0; index < opaque_count; index++)
		{
			if (address >= opaque[index][0] && address < opaque[index][1])
				break;
		}
		if (index < opaque_count)
		{
			address = opaque[index][1];
			continue;
		}
		for (count = 0; count < 5; count++)
			w[count] = address + 4 * count + 4 <= end ? donor_word(address + 4 * count) : 0xDEADBEEFUL;

		/* a tag reference: group, name, (length), index */
		if (address + 16 <= end && donor_group(w[0]) && (donor_handle(w[3]) != NONE || w[3] == 0xFFFFFFFFUL) &&
			(w[1] == 0 || (w[1] >= TAG_CACHE_BASE && w[1] < donor.vertex_buffers)))
		{
			if (w[1])
				relocation_add(tag, address + 4 - start, _relocation_pointer);
			if (w[3] != 0xFFFFFFFFUL)
				relocation_add(tag, address + 12 - start, _relocation_handle);
			address += 16;
			continue;
		}
		/* a tag data: size, flags, file offset, address, (definition) */
		if (address + 20 <= end && w[4] == 0 && w[3] >= start && w[3] < end && w[0] > 0 && w[0] <= end - w[3] &&
			(w[3] & 3) == 0 && w[3] > address)
		{
			if (opaque_count < 512)
			{
				opaque[opaque_count][0] = w[3];
				opaque[opaque_count][1] = w[3] + w[0];
				opaque_count++;
			}
			relocation_add(tag, address + 12 - start, _relocation_pointer);
			address += 20;
			continue;
		}
		/* a tag block: count, address, (definition) */
		if (address + 12 <= end && w[2] == 0 && w[1] >= start && w[1] < end && w[0] > 0 && w[0] < 1000000 &&
			(w[1] & 3) == 0 && w[1] > address)
		{
			relocation_add(tag, address + 4 - start, _relocation_pointer);
			address += 12;
			continue;
		}
		if (donor_handle(w[0]) != NONE)
			relocation_add(tag, address - start, _relocation_handle);
		else if (donor_address(w[0]) && (w[0] & 3) == 0 &&
			((w[0] >= start && w[0] < end) || w[0] < donor.first_tag_address))
		{
			relocation_add(tag, address - start, _relocation_pointer);
		}
		address += 4;
	}
}

/* ---------- bringing the tags in */

/* the map's tag of the group and name, or NONE */
static long map_tag(struct cache_tag_header *header, unsigned long group_tag, char const *name)
{
	long index;

	for (index = 0; index < header->tag_count; index++)
	{
		struct cache_instance *instance = &header->tag_instances[index];

		if (instance->group_tag == group_tag && !_stricmp((char const *)instance->name, name))
			return (long)instance->tag_index;
	}
	return NONE;
}

static boolean dropped_group(unsigned long group_tag)
{
	/* dialogue, actors and actor variants */
	return group_tag == TAG('u', 'd', 'l', 'g') || group_tag == TAG('a', 'c', 't', 'r') ||
		group_tag == TAG('a', 'c', 't', 'v');
}

static boolean root_tag(struct donor_tag *tag)
{
	static char const *const bipeds[] =
	{
		"characters\\elite\\elite",
		"characters\\grunt\\grunt",
		"characters\\hunter\\hunter",
		"characters\\marine_armored\\marine_armored",
	};
	char const *name = donor_string(tag->instance.name);
	short index;

	if (tag->instance.group_tag == TAG('b', 'i', 'p', 'd'))
	{
		for (index = 0; index < NUMBEROF(bipeds); index++)
		{
			if (!_stricmp(name, bipeds[index]))
				return TRUE;
		}
	}
	return tag->instance.group_tag == TAG('w', 'e', 'a', 'p') && !_stricmp(name, "weapons\\fuel rod gun\\hunter fuel rod");
}

static struct tag_import const character_import =
{
	"d:\\maps\\b30.map",
	"z:\\characters-b30.map",
	"Bringing the campaign's characters into multiplayer (only this once)...",
	root_tag,
	NULL,
	NULL,
};

static unsigned long new_handle(long index)
{
	return ((unsigned long)((0xE174 + index) & 0xFFFF) << 16) | (unsigned long)index;
}

/* the vertex or index buffer whose data has the address (they are in order) */
static long buffer_with_data(unsigned long buffers, long count, unsigned long address)
{
	long low = 0, high = count - 1;

	while (low < high)
	{
		long middle = (low + high + 1) / 2;

		if (donor_word(buffers + 12 * middle + 4) <= address)
			low = middle;
		else
			high = middle - 1;
	}
	return low;
}

static unsigned long buffer_data_end(unsigned long buffers, long count, long index, unsigned long end)
{
	return index + 1 < count ? donor_word(buffers + 12 * (index + 1) + 4) : end;
}

struct layout
{
	long new_count;
	/* the donor's vertex and index buffers in use: their copies' indices */
	long *vertex_copy, *index_copy;
	long vertex_copies, index_copies;
	unsigned long strings_size, tags_size, vertex_data_size, index_data_size;
	unsigned long *string_sources;
	long string_count;
};

static unsigned long relocate_pointer(struct layout *layout, struct donor_tag *tag, unsigned long value,
	unsigned long strings, byte *strings_copy, unsigned long vertex_structs, unsigned long index_structs,
	unsigned long *vertex_data, unsigned long *index_data, boolean *ok)
{
	unsigned long vertex_data_start = donor.vertex_buffers + 12 * donor.vertex_buffer_count;
	unsigned long index_data_start = donor.index_buffers + 12 * donor.index_buffer_count;

	if (value >= tag->instance.base_address && value < tag->end)
		return tag->copy + (value - tag->instance.base_address);
	if (value >= TAG_CACHE_BASE && value < donor.vertex_buffers)
	{
		/* a name: copied with the tags' */
		long index;
		unsigned long offset = 0;

		for (index = 0; index < layout->string_count; index++)
		{
			if (layout->string_sources[index] == value)
				return strings + offset;
			offset += strlen(donor_string(layout->string_sources[index])) + 1;
		}
		*ok = FALSE;
		return value;
	}
	if (value >= donor.vertex_buffers && value < vertex_data_start && (value - donor.vertex_buffers) % 12 == 0)
		return vertex_structs + 12 * layout->vertex_copy[(value - donor.vertex_buffers) / 12];
	if (value >= donor.index_buffers && value < index_data_start && (value - donor.index_buffers) % 12 == 0)
		return index_structs + 12 * layout->index_copy[(value - donor.index_buffers) / 12];
	if (value >= vertex_data_start && value < donor.index_buffers)
	{
		long buffer = buffer_with_data(donor.vertex_buffers, donor.vertex_buffer_count, value);

		return vertex_data[layout->vertex_copy[buffer]] + (value - donor_word(donor.vertex_buffers + 12 * buffer + 4));
	}
	if (value >= index_data_start && value < donor.first_tag_address)
	{
		long buffer = buffer_with_data(donor.index_buffers, donor.index_buffer_count, value);

		return index_data[layout->index_copy[buffer]] + (value - donor_word(donor.index_buffers + 12 * buffer + 4));
	}
	*ok = FALSE;
	return value;
	(void)strings_copy;
}

static void string_use(struct layout *layout, unsigned long address)
{
	long index;

	for (index = 0; index < layout->string_count; index++)
	{
		if (layout->string_sources[index] == address)
			return;
	}
	if ((layout->string_count & 255) == 0)
	{
		layout->string_sources = layout->string_sources ?
			realloc(layout->string_sources, (layout->string_count + 256) * sizeof(unsigned long)) :
			malloc(256 * sizeof(unsigned long));
	}
	layout->string_sources[layout->string_count++] = address;
	layout->strings_size += strlen(donor_string(address)) + 1;
}

static boolean inject(struct cache_tag_header *header, struct tag_import const *import, short slot)
{
	struct layout layout;
	long *stack, stack_count = 0, index, relocation;
	long map_count = header->tag_count;
	unsigned long total, cursor, strings, tags, vertex_structs, index_structs;
	unsigned long *vertex_data = NULL, *index_data = NULL;
	byte *memory;
	struct cache_instance *instances;
	boolean ok = TRUE;
	long anomalies = 0;

	memset(&layout, 0, sizeof(layout));
	stack = malloc(donor.tag_count * 64 * sizeof(long));
	if (!stack)
		return FALSE;
	for (index = 0; index < donor.tag_count; index++)
	{
		if (import->root(&donor.tags[index]))
			stack[stack_count++] = index;
	}
	if (import == &character_import && stack_count != 5)
	{
		free(stack);
		platform_log("custom characters: the level has %ld of the 5 tags", stack_count);
		return FALSE;
	}
	/* the tags the characters use, through their references */
	while (stack_count)
	{
		struct donor_tag *tag = &donor.tags[stack[--stack_count]];

		if (tag->state != _donor_unvisited)
			continue;
		tag->target = import->force_new && import->force_new(tag) ? NONE :
			map_tag(header, tag->instance.group_tag, donor_string(tag->instance.name));
		if (tag->target != NONE)
		{
			tag->state = _donor_shared;
			continue;
		}
		if (dropped_group(tag->instance.group_tag) || !tag->instance.base_address)
		{
			tag->state = _donor_dropped;
			continue;
		}
		tag->state = _donor_new;
		donor_scan(tag);
		for (relocation = 0; relocation < tag->relocation_count; relocation++)
		{
			unsigned long entry = tag->relocations[relocation];

			if ((entry & 1) == _relocation_handle && stack_count < donor.tag_count * 64)
			{
				long referenced = donor_handle(donor_word(tag->instance.base_address + (entry >> 1)));

				if (referenced != NONE && donor.tags[referenced].state == _donor_unvisited)
					stack[stack_count++] = referenced;
			}
		}
	}
	free(stack);

	/* where everything goes: the instances (the map's and the new tags'),
	the names, the tags, the vertex and index buffers, their data */
	layout.vertex_copy = malloc(donor.vertex_buffer_count * sizeof(long));
	layout.index_copy = malloc(donor.index_buffer_count * sizeof(long));
	if (!layout.vertex_copy || !layout.index_copy)
		ok = FALSE;
	for (index = 0; ok && index < donor.vertex_buffer_count; index++)
		layout.vertex_copy[index] = NONE;
	for (index = 0; ok && index < donor.index_buffer_count; index++)
		layout.index_copy[index] = NONE;
	for (index = 0; ok && index < donor.tag_count; index++)
	{
		struct donor_tag *tag = &donor.tags[index];

		if (tag->state != _donor_new)
			continue;
		tag->target = layout.new_count++;
		tag->copy = layout.tags_size;
		layout.tags_size += (tag->end - tag->instance.base_address + 15) & ~15UL;
		string_use(&layout, tag->instance.name);
		for (relocation = 0; relocation < tag->relocation_count; relocation++)
		{
			unsigned long entry = tag->relocations[relocation];
			unsigned long value = donor_word(tag->instance.base_address + (entry >> 1));
			unsigned long vertex_data_start = donor.vertex_buffers + 12 * donor.vertex_buffer_count;
			unsigned long index_data_start = donor.index_buffers + 12 * donor.index_buffer_count;
			long buffer = NONE;

			if ((entry & 1) != _relocation_pointer || (value >= tag->instance.base_address && value < tag->end))
				continue;
			if (value >= TAG_CACHE_BASE && value < donor.vertex_buffers)
				string_use(&layout, value);
			else if (value >= donor.vertex_buffers && value < vertex_data_start)
				buffer = (long)((value - donor.vertex_buffers) / 12);
			else if (value >= vertex_data_start && value < donor.index_buffers)
				buffer = buffer_with_data(donor.vertex_buffers, donor.vertex_buffer_count, value);
			if (buffer != NONE && layout.vertex_copy[buffer] == NONE)
			{
				layout.vertex_copy[buffer] = layout.vertex_copies++;
				layout.vertex_data_size += (buffer_data_end(donor.vertex_buffers, donor.vertex_buffer_count, buffer,
					donor.index_buffers) - donor_word(donor.vertex_buffers + 12 * buffer + 4) + 15) & ~15UL;
			}
			buffer = NONE;
			if (value >= donor.index_buffers && value < index_data_start)
				buffer = (long)((value - donor.index_buffers) / 12);
			else if (value >= index_data_start && value < donor.first_tag_address)
				buffer = buffer_with_data(donor.index_buffers, donor.index_buffer_count, value);
			if (buffer != NONE && layout.index_copy[buffer] == NONE)
			{
				layout.index_copy[buffer] = layout.index_copies++;
				layout.index_data_size += (buffer_data_end(donor.index_buffers, donor.index_buffer_count, buffer,
					donor.first_tag_address) - donor_word(donor.index_buffers + 12 * buffer + 4) + 15) & ~15UL;
			}
		}
	}
	if (!ok || !layout.new_count)
		goto done;

	total = ((map_count + layout.new_count) * sizeof(struct cache_instance) + 15) & ~15UL;
	strings = total;
	total += (layout.strings_size + 15) & ~15UL;
	tags = total;
	total += layout.tags_size;
	vertex_structs = total;
	total += (12 * layout.vertex_copies + 15) & ~15UL;
	index_structs = total;
	total += (12 * layout.index_copies + 15) & ~15UL;
	cursor = total;
	total += layout.vertex_data_size + layout.index_data_size;
	memory = platform_contiguous_alloc(total, 0x1000, PLATFORM_ANY_PHYSICAL_ADDRESS, CONTIGUOUS_READWRITE);
	if (!memory)
	{
		platform_log("custom characters: no memory for %lu bytes", total);
		ok = FALSE;
		goto done;
	}
	memset(memory, 0, total);
	strings += (unsigned long)memory;
	tags += (unsigned long)memory;
	vertex_structs += (unsigned long)memory;
	index_structs += (unsigned long)memory;
	cursor += (unsigned long)memory;

	/* the names */
	{
		unsigned long offset = 0;

		for (index = 0; index < layout.string_count; index++)
		{
			char const *string = donor_string(layout.string_sources[index]);

			strcpy((char *)(strings + offset), string);
			offset += strlen(string) + 1;
		}
	}
	/* the vertex and index buffers, and their data */
	vertex_data = malloc((layout.vertex_copies + 1) * sizeof(unsigned long));
	index_data = malloc((layout.index_copies + 1) * sizeof(unsigned long));
	if (!vertex_data || !index_data)
	{
		ok = FALSE;
		platform_contiguous_free(memory);
		goto done;
	}
	for (index = 0; index < donor.vertex_buffer_count; index++)
	{
		long copy = layout.vertex_copy[index];
		unsigned long data, size;

		if (copy == NONE)
			continue;
		data = donor_word(donor.vertex_buffers + 12 * index + 4);
		size = buffer_data_end(donor.vertex_buffers, donor.vertex_buffer_count, index, donor.index_buffers) - data;
		vertex_data[copy] = cursor;
		memcpy((void *)cursor, donor.data + (data - TAG_CACHE_BASE), size);
		memcpy((void *)(vertex_structs + 12 * copy), donor.data + (donor.vertex_buffers + 12 * index - TAG_CACHE_BASE), 12);
		((unsigned long *)(vertex_structs + 12 * copy))[1] = cursor;
		cursor += (size + 15) & ~15UL;
	}
	for (index = 0; index < donor.index_buffer_count; index++)
	{
		long copy = layout.index_copy[index];
		unsigned long data, size;

		if (copy == NONE)
			continue;
		data = donor_word(donor.index_buffers + 12 * index + 4);
		size = buffer_data_end(donor.index_buffers, donor.index_buffer_count, index, donor.first_tag_address) - data;
		index_data[copy] = cursor;
		memcpy((void *)cursor, donor.data + (data - TAG_CACHE_BASE), size);
		memcpy((void *)(index_structs + 12 * copy), donor.data + (donor.index_buffers + 12 * index - TAG_CACHE_BASE), 12);
		((unsigned long *)(index_structs + 12 * copy))[1] = cursor;
		cursor += (size + 15) & ~15UL;
	}
	/* the tags, at their copies */
	for (index = 0; index < donor.tag_count; index++)
	{
		struct donor_tag *tag = &donor.tags[index];

		if (tag->state == _donor_new)
		{
			tag->copy += tags;
			memcpy((void *)tag->copy, donor.data + (tag->instance.base_address - TAG_CACHE_BASE),
				tag->end - tag->instance.base_address);
		}
	}
	for (index = 0; index < donor.tag_count; index++)
	{
		struct donor_tag *tag = &donor.tags[index];

		if (tag->state != _donor_new)
			continue;
		for (relocation = 0; relocation < tag->relocation_count; relocation++)
		{
			unsigned long entry = tag->relocations[relocation];
			unsigned long *field = (unsigned long *)(tag->copy + (entry >> 1));

			if ((entry & 1) == _relocation_pointer)
			{
				boolean relocated = TRUE;

				*field = relocate_pointer(&layout, tag, *field, strings, NULL, vertex_structs, index_structs,
					vertex_data, index_data, &relocated);
				if (!relocated)
					anomalies++;
			}
			else if (donor_handle(*field) != NONE)
			{
				struct donor_tag *referenced = &donor.tags[donor_handle(*field)];

				*field = referenced->state == _donor_new ? new_handle(map_count + referenced->target) :
					referenced->state == _donor_shared ? (unsigned long)referenced->target : 0xFFFFFFFFUL;
			}
		}
	}
	/* the instances: the map's, then the new tags' */
	instances = (struct cache_instance *)memory;
	memcpy(instances, header->tag_instances, map_count * sizeof(struct cache_instance));
	for (index = 0; index < donor.tag_count; index++)
	{
		struct donor_tag *tag = &donor.tags[index];
		struct cache_instance *instance;
		boolean relocated = TRUE;

		if (tag->state != _donor_new)
			continue;
		instance = &instances[map_count + tag->target];
		*instance = tag->instance;
		instance->tag_index = new_handle(map_count + tag->target);
		instance->name = relocate_pointer(&layout, tag, tag->instance.name, strings, NULL, vertex_structs,
			index_structs, vertex_data, index_data, &relocated);
		instance->base_address = tag->copy;
	}
	/* Direct3D's (cache_files_windows.c, tags_header_register_vertex_and_index_buffers) */
	for (index = 0; index < layout.vertex_copies; index++)
	{
		unsigned long *buffer = (unsigned long *)(vertex_structs + 12 * index);

		buffer[0] = D3DCOMMON_TYPE_VERTEXBUFFER | 1;
		D3DResource_Register((D3DResource *)buffer, NULL);
	}
	for (index = 0; index < layout.index_copies; index++)
		((unsigned long *)(index_structs + 12 * index))[0] = D3DCOMMON_TYPE_INDEXBUFFER | 1;

	header->tag_instances = instances;
	header->tag_count = map_count + layout.new_count;
	custom_characters.imports[slot].memory = memory;
	custom_characters.imports[slot].first_new_index = map_count;
	custom_characters.imports[slot].end_new_index = map_count + layout.new_count;
	platform_log("custom characters: %ld tags brought in (%lu KB, %ld vertex and %ld index buffers), %ld odd pointers",
		layout.new_count, total / 1024, layout.vertex_copies, layout.index_copies, anomalies);

done:
	if (vertex_data)
		free(vertex_data);
	if (index_data)
		free(index_data);
	if (layout.vertex_copy)
		free(layout.vertex_copy);
	if (layout.index_copy)
		free(layout.index_copy);
	if (layout.string_sources)
		free(layout.string_sources);
	return ok;
}

/* ---------- custom arenas: The Silent Cartographer as a multiplayer map

A multiplayer game on b30 (its entry in the multiplayer map list) plays the
level's island. As its tags load, Blood Gulch lends it what multiplayer needs
and a campaign level has not: the multiplayer globals (the flag, the ball,
the hill's shader, the multiplayer biped, vehicles and announcer), the
weapon list, the item collections the game types spawn, and the multiplayer
menus. The level becomes a multiplayer scenario: players start where the
level's AI squads stand outside, on two sides of the island for team games;
weapons and powerups wait near some of them; everyone starts with Blood
Gulch's equipment; and the level's AI, scripts, placed characters and its
switch to the interior are left out. */

#define ARENA_MAP_NAME "b30"
#define MAXIMUM_ARENA_STARTS 40
#define ARENA_START_SPACING 5.0f
#define MAXIMUM_ARENA_FLAGS 24
/* a game type entry that matches every game type (game_engine.c,
match_game_type) */
#define ALL_GAME_TYPES 12

static boolean arena_root(struct donor_tag *tag)
{
	unsigned long group = tag->instance.group_tag;

	return group == TAG('m', 'a', 't', 'g') || group == TAG('i', 't', 'm', 'c') || group == TAG('v', 'e', 'h', 'i') ||
		(group == TAG('S', 'o', 'u', 'l') && !_stricmp(donor_string(tag->instance.name), "ui\\shell\\multiplayer"));
}

static boolean arena_force_new(struct donor_tag *tag)
{
	/* Blood Gulch's globals, whose multiplayer blocks the level takes */
	return tag->instance.group_tag == TAG('m', 'a', 't', 'g');
}

/* a donor tag index as the map's (NONE where it was not brought in) */
static unsigned long donor_remap(unsigned long value, long map_count)
{
	long index = donor_handle(value);
	struct donor_tag *tag;

	if (index == NONE)
		return 0xFFFFFFFFUL;
	tag = &donor.tags[index];
	return tag->state == _donor_new ? new_handle(map_count + tag->target) :
		tag->state == _donor_shared ? (unsigned long)tag->target : 0xFFFFFFFFUL;
}

/* a tag reference copied from the donor, as the map's */
static void remap_reference(struct cache_tag_header *header, unsigned long *reference, long map_count)
{
	unsigned long index = donor_remap(reference[3], map_count);

	reference[3] = index;
	reference[1] = index != 0xFFFFFFFFUL ? header->tag_instances[(short)index].name : 0;
}

static long arena_tag(struct cache_tag_header *header, unsigned long group, char const *name)
{
	long index;

	for (index = 0; index < header->tag_count; index++)
	{
		if (header->tag_instances[index].group_tag == group &&
			!_stricmp((char const *)header->tag_instances[index].name, name))
		{
			return index;
		}
	}
	return NONE;
}

/* a game type's place by a start, so far off it */
static void arena_flag(struct scenario_netgame_flag *flags, short *count,
	struct encounter_player_starting_location const *start, short type, short team_index, real dx, real dy)
{
	struct scenario_netgame_flag *flag;

	if (*count >= MAXIMUM_ARENA_FLAGS)
		return;
	flag = &flags[(*count)++];
	csmemset(flag, 0, sizeof(*flag));
	flag->position = start->position;
	flag->position.x += dx;
	flag->position.y += dy;
	flag->facing = start->facing;
	flag->type = type;
	flag->team_index = team_index;
}

static boolean arena_after(struct cache_tag_header *header, long map_count)
{
	static char const *const items[] =
	{
		"item collections\\single weapons\\rocket launcher",
		"item collections\\single weapons\\sniper rifle",
		"item collections\\single weapons\\shotgun",
		"item collections\\powerups\\powerup super shield",
		"item collections\\single weapons\\plasma rifle",
		"item collections\\powerups\\shield-invisibility",
		"item collections\\single weapons\\frag grenades",
		"item collections\\powerups\\powerup health pack",
		"item collections\\single weapons\\plasma grenades",
		"item collections\\single weapons\\plasma pistol",
	};
	long map_globals = NONE, copied_globals = NONE, index, donor_scenario = NONE;
	struct scenario *scenario;
	struct scenario_starting_equipment const *donor_equipment;
	long donor_equipment_count;
	struct encounter_player_starting_location *starts;
	struct scenario_netgame_equipment *equipment;
	struct scenario_starting_equipment *starting_equipment;
	struct scenario_netgame_flag *flags;
	short start_count = 0, equipment_count = 0, flag_count = 0, encounter_index;
	real mean_x = 0.f;
	byte *memory;
	unsigned long size;

	for (index = 0; index < header->tag_count; index++)
	{
		if (header->tag_instances[index].group_tag != TAG('m', 'a', 't', 'g'))
			continue;
		if (index < map_count)
			map_globals = index;
		else
			copied_globals = index;
	}
	for (index = 0; index < donor.tag_count; index++)
	{
		if (donor.tags[index].instance.group_tag == TAG('s', 'c', 'n', 'r'))
			donor_scenario = index;
	}
	if (map_globals == NONE || copied_globals == NONE || donor_scenario == NONE)
		return FALSE;

	/* the multiplayer globals and weapon list, Blood Gulch's */
	{
		byte *globals = (byte *)header->tag_instances[map_globals].base_address;
		byte const *copied = (byte const *)header->tag_instances[copied_globals].base_address;

		csmemcpy(globals + offsetof(struct game_globals, multiplayer_information),
			copied + offsetof(struct game_globals, multiplayer_information), sizeof(struct tag_block));
		csmemcpy(globals + offsetof(struct game_globals, weapon_list),
			copied + offsetof(struct game_globals, weapon_list), sizeof(struct tag_block));
	}

	scenario = (struct scenario *)header->tag_instances[(short)header->scenario_tag_index].base_address;
	{
		struct scenario const *donor_definition =
			(struct scenario const *)(donor.data + (donor.tags[donor_scenario].instance.base_address - TAG_CACHE_BASE));

		donor_equipment_count = donor_definition->scenario_starting_equipment.count;
		donor_equipment = (struct scenario_starting_equipment const *)(donor.data +
			((unsigned long)donor_definition->scenario_starting_equipment.address - TAG_CACHE_BASE));
	}

	size = MAXIMUM_ARENA_STARTS * sizeof(*starts) + MAXIMUM_ARENA_STARTS * sizeof(*equipment) +
		donor_equipment_count * sizeof(*starting_equipment) + MAXIMUM_ARENA_FLAGS * sizeof(*flags);
	memory = platform_contiguous_alloc(size, 0x1000, PLATFORM_ANY_PHYSICAL_ADDRESS, CONTIGUOUS_READWRITE);
	if (!memory)
		return FALSE;
	csmemset(memory, 0, size);
	custom_characters.arena_memory = memory;
	starts = (struct encounter_player_starting_location *)memory;
	equipment = (struct scenario_netgame_equipment *)(starts + MAXIMUM_ARENA_STARTS);
	starting_equipment = (struct scenario_starting_equipment *)(equipment + MAXIMUM_ARENA_STARTS);
	flags = (struct scenario_netgame_flag *)(starting_equipment + donor_equipment_count);

	/* where players start: the level's own, and where the AI's squads
	stand outside on the island, apart from each other */
	for (index = 0; index < scenario->players.count && start_count < MAXIMUM_ARENA_STARTS; index++)
	{
		struct encounter_player_starting_location const *start = (struct encounter_player_starting_location const *)
			((byte const *)scenario->players.address + index * sizeof(*start));

		starts[start_count].position = start->position;
		starts[start_count].facing = start->facing;
		start_count++;
	}
	for (encounter_index = 0; encounter_index < scenario->ai_encounters.count; encounter_index++)
	{
		struct encounter_definition const *encounter = (struct encounter_definition const *)
			((byte const *)scenario->ai_encounters.address + encounter_index * sizeof(struct encounter_definition));
		short squad_index;

		/* (outside: the beach, the valley and the crash site; the island's
		structure has the facility's first floors too) */
		if (encounter->runtime_structure_bsp_reference_index != 0 ||
			(strncmp(encounter->name, "beach", 5) && strncmp(encounter->name, "valley", 6) &&
				strncmp(encounter->name, "downed", 6)) ||
			/* (in the air, in their Banshees) */
			!strcmp(encounter->name, "beach_banshee"))
		{
			continue;
		}
		for (squad_index = 0; squad_index < encounter->squads.count; squad_index++)
		{
			struct squad_definition const *squad = (struct squad_definition const *)
				((byte const *)encounter->squads.address + squad_index * sizeof(struct squad_definition));
			short location_index;

			for (location_index = 0; location_index < squad->starting_locations.count && start_count < MAXIMUM_ARENA_STARTS;
				location_index++)
			{
				struct actor_starting_location const *location = (struct actor_starting_location const *)
					((byte const *)squad->starting_locations.address + location_index * sizeof(struct actor_starting_location));
				short other;

				for (other = 0; other < start_count; other++)
				{
					if (distance_squared3d(&starts[other].position, &location->position) <
						ARENA_START_SPACING * ARENA_START_SPACING)
					{
						break;
					}
				}
				if (other < start_count)
					continue;
				starts[start_count].position = location->position;
				starts[start_count].facing = location->facing;
				start_count++;
			}
		}
	}
	for (index = 0; index < start_count; index++)
		mean_x += starts[index].position.x / start_count;
	for (index = 0; index < start_count; index++)
	{
		/* red on the beach's west, blue east; every game type */
		starts[index].team_index = starts[index].position.x < mean_x ? 0 : 1;
		starts[index].game_types[0] = ALL_GAME_TYPES;
	}

	/* the game types' places: each team's flag at its side's furthest start,
	the balls and two hills round starts in the middle, and a race track
	across the island */
	if (start_count >= 4)
	{
		short west = 0, east = 0, middle[2] = { NONE, NONE };
		real best[2] = { 1.0e9f, 1.0e9f };

		for (index = 0; index < start_count; index++)
		{
			real offset = (real)fabs(starts[index].position.x - mean_x);

			if (starts[index].position.x < starts[west].position.x)
				west = (short)index;
			if (starts[index].position.x > starts[east].position.x)
				east = (short)index;
			if (offset < best[0])
			{
				best[1] = best[0];
				middle[1] = middle[0];
				best[0] = offset;
				middle[0] = (short)index;
			}
			else if (offset < best[1])
			{
				best[1] = offset;
				middle[1] = (short)index;
			}
		}
		arena_flag(flags, &flag_count, &starts[west], _netgame_flag_ctf_flag, 0, 0.f, 0.f);
		arena_flag(flags, &flag_count, &starts[east], _netgame_flag_ctf_flag, 1, 0.f, 0.f);
		for (index = 0; index < 2; index++)
		{
			short corner;

			arena_flag(flags, &flag_count, &starts[middle[index]], _netgame_flag_oddball_ball_spawn, (short)index, 0.f, 0.f);
			for (corner = 0; corner < 4; corner++)
			{
				arena_flag(flags, &flag_count, &starts[middle[index]], _netgame_flag_hill, (short)index,
					(corner & 1) ? 3.f : -3.f, (corner & 2) ? 3.f : -3.f);
			}
		}
		arena_flag(flags, &flag_count, &starts[west], _netgame_flag_race_track, 0, 0.f, 0.f);
		arena_flag(flags, &flag_count, &starts[middle[0]], _netgame_flag_race_track, 1, 0.f, 0.f);
		arena_flag(flags, &flag_count, &starts[east], _netgame_flag_race_track, 2, 0.f, 0.f);
		arena_flag(flags, &flag_count, &starts[middle[1]], _netgame_flag_race_track, 3, 0.f, 0.f);
	}

	/* weapons and powerups near every third start */
	for (index = 0; index < start_count && equipment_count < (short)NUMBEROF(items); index += 3)
	{
		long collection = arena_tag(header, TAG('i', 't', 'm', 'c'), items[equipment_count]);
		struct scenario_netgame_equipment *item = &equipment[equipment_count];

		if (collection == NONE)
			break;
		item->game_type[0] = ALL_GAME_TYPES;
		item->run_time_spawned_item_index = NONE;
		item->position = starts[index].position;
		item->position.x += (real)cos(starts[index].facing) * 1.5f;
		item->position.y += (real)sin(starts[index].facing) * 1.5f;
		item->position.z += 0.2f;
		item->facing = starts[index].facing;
		item->item_collection.group_tag = TAG('i', 't', 'm', 'c');
		item->item_collection.index = (long)header->tag_instances[collection].tag_index;
		item->item_collection.name = (char *)header->tag_instances[collection].name;
		equipment_count++;
	}

	/* what everyone starts with: Blood Gulch's */
	for (index = 0; index < donor_equipment_count; index++)
	{
		short reference;

		starting_equipment[index] = donor_equipment[index];
		for (reference = 0; reference < NUMBEROF(starting_equipment[index].item_collection); reference++)
			remap_reference(header, (unsigned long *)&starting_equipment[index].item_collection[reference], map_count);
	}

	scenario->type = _scenario_type_multiplayer;
	scenario->players.count = start_count;
	scenario->players.address = starts;
	scenario->netgame_equipment.count = equipment_count;
	scenario->netgame_equipment.address = equipment;
	scenario->scenario_starting_equipment.count = donor_equipment_count;
	scenario->scenario_starting_equipment.address = starting_equipment;
	scenario->netgame_flags.count = flag_count;
	scenario->netgame_flags.address = flags;
	/* no campaign: no AI placed, no script run by itself, no placed
	characters, no switch inside */
	for (index = 0; index < scenario->ai_encounters.count; index++)
	{
		struct encounter_definition *encounter = (struct encounter_definition *)
			((byte *)scenario->ai_encounters.address + index * sizeof(struct encounter_definition));

		SET_FLAG(encounter->flags, 0 /* not initially created */, TRUE);
	}
	for (index = 0; index < scenario->hs_scripts.count; index++)
	{
		struct hs_script *script = (struct hs_script *)((byte *)scenario->hs_scripts.address + index * sizeof(struct hs_script));

		script->script_type = _hs_script_static;
	}
	scenario->bipeds.count = 0;
	scenario->bsp_switch_trigger_volumes.count = 0;
	platform_log("custom arena: %s as a multiplayer map, %d starts, %d weapon spawns", ARENA_MAP_NAME,
		(int)start_count, (int)equipment_count);
	return TRUE;
}

static struct tag_import const arena_import =
{
	"d:\\maps\\bloodgulch.map",
	"z:\\arena-bloodgulch.map",
	"Making The Silent Cartographer a multiplayer map (only this once)...",
	arena_root,
	arena_force_new,
	arena_after,
};

/* ---------- public code */

/* brings in an import's tags; FALSE if it could not */
static boolean import_tags(struct cache_tag_header *header, struct tag_import const *import, short slot)
{
	long map_count = header->tag_count;
	boolean ok = FALSE;
	FILE *file;

	if (!donor_prepare(import))
		return FALSE;
	file = fopen(import->cache_path, "rb");
	if (!file)
		return FALSE;
	if (donor_load(file) && inject(header, import, slot))
	{
		ok = !import->after || import->after(header, map_count);
	}
	fclose(file);
	donor_dispose();
	if (ok && custom_characters.imports[slot].file == INVALID_HANDLE_VALUE)
	{
		custom_characters.imports[slot].file = CreateFileA(import->cache_path, GENERIC_READ, 0, NULL,
			OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
	}
	return ok && custom_characters.imports[slot].file != INVALID_HANDLE_VALUE;
}

/* (cache_files.c, scenario_tags_load) a map's tags are loaded */
void custom_characters_tags_loaded(
	void *tag_header,
	char const *map_name)
{
	static boolean initialized = FALSE;
	struct cache_tag_header *header = tag_header;
	short slot;

	if (!initialized)
	{
		for (slot = 0; slot < NUMBER_OF_IMPORTS; slot++)
			custom_characters.imports[slot].file = INVALID_HANDLE_VALUE;
		initialized = TRUE;
	}
	custom_characters.available = FALSE;
	custom_characters.arena = FALSE;
	for (slot = 0; slot < NUMBER_OF_IMPORTS; slot++)
		custom_characters.imports[slot].first_new_index = custom_characters.imports[slot].end_new_index = NONE;
	platform_log("custom characters: map %s", map_name ? map_name : "(none)");
	if (!map_name || !map_name[0] || !_stricmp(map_name, "ui"))
		return;
	/* The Silent Cartographer in a multiplayer game: an arena, with the
	characters its own */
	if (!_stricmp(map_name, ARENA_MAP_NAME) && game_variant_global.game_engine_index != 0)
	{
		custom_characters.arena = import_tags(header, &arena_import, _import_arena);
		custom_characters.available = custom_characters.arena;
		custom_characters.checksum = header->checksum;
		return;
	}
	/* the other campaign levels have their own */
	if (map_name[1] >= '0' && map_name[1] <= '9')
		return;
	custom_characters.available = import_tags(header, &character_import, _import_characters);
}

/* (cache_files.c, scenario_tags_unload) after the caches let go of them */
void custom_characters_tags_unloaded(
	void)
{
	short slot;

	for (slot = 0; slot < NUMBER_OF_IMPORTS; slot++)
	{
		if (custom_characters.imports[slot].memory)
			platform_contiguous_free(custom_characters.imports[slot].memory);
		custom_characters.imports[slot].memory = NULL;
		custom_characters.imports[slot].first_new_index = custom_characters.imports[slot].end_new_index = NONE;
	}
	if (custom_characters.arena_memory)
		platform_contiguous_free(custom_characters.arena_memory);
	custom_characters.arena_memory = NULL;
	custom_characters.available = FALSE;
	custom_characters.arena = FALSE;
}

/* (cache_files_windows.c) which import's file a tag's raw data (pixels,
samples) is read from: 1 + the import, or 0 for the map's own */
int custom_characters_file_for_tag(
	long tag_index)
{
	short absolute_index = (short)tag_index;
	short slot;

	if (tag_index == NONE)
		return 0;
	for (slot = 0; slot < NUMBER_OF_IMPORTS; slot++)
	{
		if (custom_characters.imports[slot].first_new_index != NONE &&
			absolute_index >= custom_characters.imports[slot].first_new_index &&
			absolute_index < custom_characters.imports[slot].end_new_index)
		{
			return slot + 1;
		}
	}
	return 0;
}

/* (cache_files_windows.c) that file */
HANDLE custom_characters_donor_handle(
	int file)
{
	return file >= 1 && file <= NUMBER_OF_IMPORTS ? custom_characters.imports[file - 1].file : INVALID_HANDLE_VALUE;
}

/* the characters were brought into this map, or are its own (an arena) */
boolean custom_characters_available(
	void)
{
	return custom_characters.available;
}

/* the map plays as a multiplayer arena (The Silent Cartographer) */
boolean custom_characters_arena(
	void)
{
	return custom_characters.arena;
}

/* which campaign level they came from (the machines in a game compare it) */
unsigned long custom_characters_checksum(
	void)
{
	return custom_characters.available ? custom_characters.checksum : 0;
}

/* (ui_widget_event_handler_functions.c) whether The Silent Cartographer can
be played as a multiplayer map: the copy of the game has it and Blood
Gulch */
boolean custom_arena_available(
	void)
{
	static int available = -1;

	if (available < 0)
	{
		FILE *level = fopen("d:\\maps\\b30.map", "rb");
		FILE *gulch = fopen("d:\\maps\\bloodgulch.map", "rb");

		available = level && gulch;
		platform_log("custom arena: %s", available ? "The Silent Cartographer can be played as a multiplayer map" : "no campaign");
		if (level)
			fclose(level);
		if (gulch)
			fclose(gulch);
	}
	return available != 0;
}

/* (text_group.c) The Silent Cartographer's name and description in the
multiplayer map lists (the 14th, after the game's 13), or NULL */
wchar_t *custom_arena_string(
	char const *list_name,
	short string_index)
{
	if (string_index != 13 || !list_name || !custom_arena_available())
		return NULL;
	if (!_stricmp(list_name, "ui\\shell\\main_menu\\mp_map_list"))
		return L"Cartographer";
	if (!_stricmp(list_name, "ui\\shell\\main_menu\\multiplayer_type_select\\mp_map_select\\map_data"))
		return L"Covenant Island\r\nUnder Siege\r\n\r\n2-16 players";
	return NULL;
}

/* the biped of a character brought in (custom_content.c's numbers), or NONE */
long custom_characters_biped(
	long character)
{
	static char const *const names[] =
	{
		NULL, NULL,
		"characters\\marine_armored\\marine_armored",
		"characters\\grunt\\grunt",
		NULL,
		"characters\\elite\\elite",
		"characters\\hunter\\hunter",
	};

	if (!custom_characters.available || character < 0 || character >= NUMBEROF(names) || !names[character])
		return NONE;
	return tag_loaded(TAG('b', 'i', 'p', 'd'), names[character]);
}

#endif
