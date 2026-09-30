/*
WEB_SHARED.H

The state the page (port/web/site/app.js, on the browser's main thread)
shares with the game (a pthread, in a Web Worker) through the WebAssembly
memory. The page finds it with web_shared_state() and reads and writes it
through typed arrays at the offsets below: every member is a 32-bit word,
so the layout is the same on both sides.

- events: keyboard, mouse and focus events, a ring the page writes and
  SDL_PollEvent reads (web_sdl.c);
- gamepads: the state of up to WEB_GAMEPAD_COUNT controllers (the page
  polls the Gamepad API each animation frame; the touch controls are one
  more controller);
- display: the size of the page's canvas in device pixels, and a counter
  the page advances each animation frame, which paces the game's frames;
- audio: a ring of interleaved stereo float samples the game's mixer
  fills and the page's AudioWorklet plays.
*/

#ifndef __HALO_WEB_SHARED_H
#define __HALO_WEB_SHARED_H

#include <stdint.h>

#define WEB_SHARED_MAGIC 0x42455748u /* 'HWEB' */
#define WEB_SHARED_VERSION 1

#define WEB_EVENT_CAPACITY 256
#define WEB_GAMEPAD_COUNT 6
/* the last slot: the second player of a remote co-op game (site/coop.js),
whose controller is on another device */
#define WEB_REMOTE_GAMEPAD_SLOT 5
#define WEB_REMOTE_GAMEPAD_ID 2000
#define WEB_AUDIO_RING_FRAMES 8192 /* a power of two */
/* the rings of packets to and from the other players (web_net.c, net.js) */
#define WEB_NET_OUT_BYTES (1024 * 1024) /* powers of two */
#define WEB_NET_IN_BYTES (2 * 1024 * 1024)

enum
{
	WEB_EVENT_NONE,
	WEB_EVENT_KEY,          /* a: scancode, b: down, c: repeat, d: keycode */
	WEB_EVENT_MOUSE_MOTION, /* x, y: relative motion in pixels */
	WEB_EVENT_MOUSE_BUTTON, /* a: SDL button, b: down */
	WEB_EVENT_MOUSE_WHEEL,  /* y: notches */
	WEB_EVENT_FOCUS,        /* a: gained */
	WEB_EVENT_GAMEPAD_ADDED,/* a: id */
	WEB_EVENT_QUIT,
};

struct web_event
{
	int32_t type;
	int32_t a, b, c, d;
	float x, y;
	int32_t reserved;
};

/* the SDL_GamepadButton bits and SDL_GamepadAxis values */
struct web_gamepad
{
	int32_t connected;
	int32_t id;          /* the SDL_JoystickID, never 0 */
	int32_t type;        /* SDL_GamepadType */
	uint32_t buttons;    /* 1 << SDL_GamepadButton */
	int32_t axes[6];     /* SDL_GamepadAxis order, -32768..32767 (triggers 0..32767) */
	int32_t rumble_low, rumble_high; /* written by the game, 0..65535 */
	int32_t rumble_serial;           /* advanced with each rumble request */
	int32_t rumble_milliseconds;
	/* presses the game has not read yet: the page sets a button's bit when
	it goes down, the game clears it when it reads the button, so a tap
	between two of the game's frames still counts once (bits 30 and 31: the
	left and right triggers) */
	uint32_t pressed;
	/* aiming by dragging or with a mouse on another device (remote co-op):
	motion in sixteenths of a pixel, which the page adds and the game takes */
	int32_t look_x, look_y;
};

struct web_shared_state
{
	uint32_t magic;
	uint32_t version;
	uint32_t size;                  /* sizeof(struct web_shared_state) */

	/* events: the page writes at event_write, the game reads at
	event_read; both count without wrapping */
	volatile int32_t event_write;
	volatile int32_t event_read;
	struct web_event events[WEB_EVENT_CAPACITY];

	struct web_gamepad gamepads[WEB_GAMEPAD_COUNT];

	/* the canvas in device pixels, and the animation frame counter */
	volatile int32_t display_width;
	volatile int32_t display_height;
	volatile int32_t frame_counter;
	/* frames the game presented, and whether it waits for each animation
	frame (display.vsync) */
	volatile int32_t frames_presented;
	volatile int32_t vsync;

	/* audio: sample rate, and the ring (WEB_AUDIO_RING_FRAMES stereo
	frames); the game writes at audio_write, the worklet reads at
	audio_read, both counting frames without wrapping */
	volatile int32_t audio_rate;
	volatile int32_t audio_open;
	volatile int32_t audio_write;
	volatile int32_t audio_read;
	volatile int32_t audio_underruns;
	float audio_ring[WEB_AUDIO_RING_FRAMES * 2];

	/* the page's state for the game: nonzero while it is hidden */
	volatile int32_t page_hidden;
	/* the game's state for the page: 1 once the game's window opened */
	volatile int32_t game_started;
	/* custom content (port/linux/game/custom_content.c): the page's game
	rules (WEB_CUSTOM_* bits) and the character to play as in the campaign
	(WEB_CHARACTER_*); the game answers with how the last choice of
	character went (WEB_CHARACTER_STATUS_*) */
	volatile int32_t custom_rules;
	volatile int32_t custom_character;
	volatile int32_t custom_character_status;
	/* the game's state for the page: the views on the screen (the local
	players of a split screen game, 0 in the menus), for remote co-op */
	volatile int32_t split_views;
	volatile int32_t reserved[12];

	/* online play (web_net.c, port/web/site/net.js): this machine's address
	on the players' network (network byte order, from the page), and the
	packets the game sends to other machines and receives from them; each
	ring counts bytes without wrapping */
	volatile int32_t net_local_address;
	volatile int32_t net_out_write;
	volatile int32_t net_out_read;
	volatile int32_t net_in_write;
	volatile int32_t net_in_read;
	unsigned char net_out[WEB_NET_OUT_BYTES];
	unsigned char net_in[WEB_NET_IN_BYTES];
};

/* custom content: game rules (the room's host's, online) */
enum
{
	WEB_CUSTOM_INFINITE_AMMO = 1 << 0,
	WEB_CUSTOM_LOW_GRAVITY = 1 << 1,
	WEB_CUSTOM_SPEED_BOOST = 1 << 2,
	WEB_CUSTOM_SUPER_JUMP = 1 << 3,
	WEB_CUSTOM_BIG_HEADS = 1 << 4,
	WEB_CUSTOM_ONE_SHOT_KILLS = 1 << 5,
	WEB_CUSTOM_INVINCIBLE = 1 << 6,      /* the campaign only */
	WEB_CUSTOM_THIRD_PERSON = 1 << 7,    /* this player's camera */
};

/* the characters to play as in the campaign (0: the level's own) */
enum
{
	WEB_CHARACTER_DEFAULT,
	WEB_CHARACTER_MASTER_CHIEF,
	WEB_CHARACTER_MARINE,
	WEB_CHARACTER_GRUNT,
	WEB_CHARACTER_JACKAL,
	WEB_CHARACTER_ELITE,
	WEB_CHARACTER_HUNTER,
	WEB_CHARACTER_FLOOD_HUMAN,
	WEB_CHARACTER_FLOOD_ELITE,
	WEB_CHARACTER_INFECTION_FORM,
	WEB_CHARACTER_SENTINEL,
	WEB_CHARACTER_MONITOR,
	WEB_CHARACTER_KEYES,
	NUMBER_OF_WEB_CHARACTERS
};

enum
{
	WEB_CHARACTER_STATUS_NONE,       /* nothing asked, or not in a campaign level */
	WEB_CHARACTER_STATUS_PLAYING,    /* playing as the character asked for */
	WEB_CHARACTER_STATUS_NOT_HERE,   /* the level has no such character */
};

/* a packet in the rings: this header, then the payload, padded to 4 bytes;
addresses and ports in network byte order */
enum
{
	WEB_PACKET_DATAGRAM = 1,
	WEB_PACKET_OPEN,    /* a stream connects */
	WEB_PACKET_DATA,    /* a stream's bytes */
	WEB_PACKET_CLOSE,   /* a stream's end closed */
	WEB_PACKET_REFUSE,  /* nothing listens where a stream connected */
};

struct web_packet_header
{
	uint32_t size;      /* the whole packet, padded */
	uint32_t kind;
	uint32_t source_ip;
	uint32_t destination_ip;
	uint16_t source_port;
	uint16_t destination_port;
	uint32_t length;    /* of the payload */
};

struct web_shared_state *web_shared_state(void);

#endif
