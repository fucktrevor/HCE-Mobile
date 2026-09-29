/*
WEB_SHADER_CACHE.C

The shaders a player's game has used, compiled while the game starts.

WebGL cannot keep compiled programs, and a browser compiles a shader when it
is first drawn with: in Safari, which translates each shader to Metal in
another process, the draw that needs a new one waits for it, and the game
stutters the first time an effect, a menu or a map shows. The renderer
(d3d8_gl.c) records the source of each shader it compiles and each pair it
links in shader-cache.txt, in the game data's folder. The next time the game
starts, all of them are compiled and linked at once (in parallel, where the
browser has KHR_parallel_shader_compile), before the first frame; the
renderer then finds them here instead of compiling.

The file holds records one after another:
	S <type> <hash> <length>\n<source>\n
	P <vertex hash> <fragment hash>\n
*/

#include <GLES3/gl3.h>
#include <emscripten.h>
#include <emscripten/html5_webgl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "platform.h"

#define CACHE_FILE_NAME "shader-cache.txt"
#define SHADER_SLOTS 4096
#define PROGRAM_SLOTS 8192

struct cached_shader
{
	unsigned long long hash;
	GLuint shader;
	GLenum type;
	BOOL recorded;
};

struct cached_program
{
	GLuint vertex_shader, fragment_shader, program;
	BOOL recorded;
};

static struct cached_shader shaders[SHADER_SLOTS];
static unsigned long shader_count;
static struct cached_program programs[PROGRAM_SLOTS];
static unsigned long program_count;
static FILE *cache_file;

static unsigned long long source_hash(const char *source)
{
	unsigned long long hash = 1469598103934665603ULL;

	while (*source)
		hash = (hash ^ (unsigned char)*source++) * 1099511628211ULL;
	return hash;
}

static struct cached_shader *shader_by_hash(unsigned long long hash, GLenum type)
{
	unsigned long index;

	for (index = 0; index < shader_count; index++)
	{
		if (shaders[index].hash == hash && shaders[index].type == type)
			return &shaders[index];
	}
	return NULL;
}

static struct cached_shader *shader_by_id(GLuint shader)
{
	unsigned long index;

	for (index = 0; index < shader_count; index++)
	{
		if (shaders[index].shader == shader)
			return &shaders[index];
	}
	return NULL;
}

static struct cached_program *program_by_shaders(GLuint vertex_shader, GLuint fragment_shader)
{
	unsigned long index;

	for (index = 0; index < program_count; index++)
	{
		if (programs[index].vertex_shader == vertex_shader && programs[index].fragment_shader == fragment_shader)
			return &programs[index];
	}
	return NULL;
}

static void cache_path(char *path, size_t size)
{
	snprintf(path, size, "%s/%s", platform_data_root(), CACHE_FILE_NAME);
}

static FILE *cache_append(void)
{
	char path[512];

	if (!cache_file)
	{
		cache_path(path, sizeof(path));
		cache_file = fopen(path, "ab");
	}
	return cache_file;
}

void web_shader_cache_prewarm(void)
{
	char path[512];
	FILE *file;
	long size;
	char *text, *cursor, *end;
	unsigned long index, failed = 0;
	double started = emscripten_get_now();

	cache_path(path, sizeof(path));
	file = fopen(path, "rb");
	if (!file)
		return;
	fseek(file, 0, SEEK_END);
	size = ftell(file);
	fseek(file, 0, SEEK_SET);
	text = size > 0 ? malloc((size_t)size + 1) : NULL;
	if (!text || fread(text, 1, (size_t)size, file) != (size_t)size)
	{
		free(text);
		fclose(file);
		return;
	}
	fclose(file);
	text[size] = '\0';

	/* the compiler threads start on each shader and program as soon as it
	is asked for; nothing asks for a result until all have been */
	emscripten_webgl_enable_extension(emscripten_webgl_get_current_context(), "KHR_parallel_shader_compile");
	cursor = text;
	end = text + size;
	while (cursor < end)
	{
		unsigned int type;
		unsigned long long hash, vertex_hash, fragment_hash;
		unsigned long length;
		int consumed = 0;

		if (sscanf(cursor, "S %u %llx %lu\n%n", &type, &hash, &length, &consumed) == 3 && consumed)
		{
			char *source = cursor + consumed;
			char saved;

			if (source + length > end)
				break;
			cursor = source + length;
			if (cursor < end && *cursor == '\n')
				cursor++;
			if (shader_count == SHADER_SLOTS || shader_by_hash(hash, type))
				continue;
			saved = source[length];
			source[length] = '\0';
			shaders[shader_count].hash = hash;
			shaders[shader_count].type = type;
			shaders[shader_count].recorded = TRUE;
			shaders[shader_count].shader = glCreateShader(type);
			glShaderSource(shaders[shader_count].shader, 1, (const char *const *)&source, NULL);
			glCompileShader(shaders[shader_count].shader);
			source[length] = saved;
			shader_count++;
		}
		else if (sscanf(cursor, "P %llx %llx\n%n", &vertex_hash, &fragment_hash, &consumed) == 2 && consumed)
		{
			struct cached_shader *vertex = shader_by_hash(vertex_hash, GL_VERTEX_SHADER);
			struct cached_shader *fragment = shader_by_hash(fragment_hash, GL_FRAGMENT_SHADER);

			cursor += consumed;
			if (!vertex || !fragment || program_count == PROGRAM_SLOTS ||
				program_by_shaders(vertex->shader, fragment->shader))
			{
				continue;
			}
			programs[program_count].vertex_shader = vertex->shader;
			programs[program_count].fragment_shader = fragment->shader;
			programs[program_count].recorded = TRUE;
			programs[program_count].program = glCreateProgram();
			glAttachShader(programs[program_count].program, vertex->shader);
			glAttachShader(programs[program_count].program, fragment->shader);
			glLinkProgram(programs[program_count].program);
			program_count++;
		}
		else
		{
			/* a record cut short: the rest of the file is dropped */
			break;
		}
	}
	free(text);

	/* now wait for them all */
	for (index = 0; index < program_count; index++)
	{
		GLint status = 0;

		glGetProgramiv(programs[index].program, GL_LINK_STATUS, &status);
		if (!status)
		{
			glDeleteProgram(programs[index].program);
			programs[index].program = 0;
			failed++;
		}
	}
	for (index = 0; index < shader_count; index++)
	{
		GLint status = 0;

		glGetShaderiv(shaders[index].shader, GL_COMPILE_STATUS, &status);
		if (!status)
		{
			glDeleteShader(shaders[index].shader);
			/* compiled again, and recorded again, when it is next needed */
			shaders[index].shader = 0;
			shaders[index].hash = 0;
			shaders[index].type = 0;
			failed++;
		}
	}
	platform_log("shader cache: %lu shaders and %lu programs in %.0f ms (%lu failed)",
		shader_count, program_count, emscripten_get_now() - started, failed);
}

GLuint web_shader_cache_find(GLenum type, const char *source, unsigned long long *hash)
{
	struct cached_shader *cached;

	*hash = source_hash(source);
	cached = shader_by_hash(*hash, type);
	return cached ? cached->shader : 0;
}

void web_shader_cache_record_shader(GLuint shader, GLenum type, unsigned long long hash, const char *source)
{
	FILE *file;

	if (!shader || shader_count == SHADER_SLOTS || shader_by_hash(hash, type))
		return;
	shaders[shader_count].hash = hash;
	shaders[shader_count].type = type;
	shaders[shader_count].shader = shader;
	shaders[shader_count].recorded = TRUE;
	shader_count++;
	if ((file = cache_append()) != NULL)
	{
		fprintf(file, "S %u %016llx %lu\n", (unsigned int)type, hash, (unsigned long)strlen(source));
		fputs(source, file);
		fputc('\n', file);
		fflush(file);
	}
}

GLuint web_shader_cache_program(GLuint vertex_shader, GLuint fragment_shader)
{
	struct cached_program *cached = program_by_shaders(vertex_shader, fragment_shader);

	return cached ? cached->program : 0;
}

void web_shader_cache_record_program(GLuint vertex_shader, GLuint fragment_shader, GLuint program)
{
	struct cached_shader *vertex = shader_by_id(vertex_shader);
	struct cached_shader *fragment = shader_by_id(fragment_shader);
	FILE *file;

	if (!vertex || !fragment || program_count == PROGRAM_SLOTS || program_by_shaders(vertex_shader, fragment_shader))
		return;
	programs[program_count].vertex_shader = vertex_shader;
	programs[program_count].fragment_shader = fragment_shader;
	programs[program_count].program = program;
	programs[program_count].recorded = TRUE;
	program_count++;
	if ((file = cache_append()) != NULL)
	{
		fprintf(file, "P %016llx %016llx\n", vertex->hash, fragment->hash);
		fflush(file);
	}
}
