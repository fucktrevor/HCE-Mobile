# Web (iPhone, iPad, Android and desktop browsers): Halo CE Mobile

Halo CE Mobile is built on
[cybersecurity/halo-ce-universal](https://github.com/cybersecurity/halo-ce-universal),
the Linux, Windows and Android ports of the Halo: Combat Evolved
decompilation, which starts from [bnunu/halo-1](https://github.com/bnunu/halo-1),
a fork of [punpckhdq/halo](https://github.com/punpckhdq/halo). The web port
(this folder) adds the WebAssembly build, the installable page, touch and
controller input, online play over WebRTC, and the rest described here.

`ninja web` builds the game as WebAssembly, with a page that installs as a
home-screen web app: `build/web/site`. The first visit to the site (not the
installed app) welcomes the player with a button for each kind of phone:
*Install on Android* asks the browser to install it (its install prompt), or
shows where its menu does; *Install on iPhone / iPad* shows the steps (Share,
then *Add to Home Screen*), which iOS lets only the person take. The
installed app runs full screen and works offline.

The start page is themed as a UNSC terminal, with Orbitron and Rajdhani
(`site/fonts`, SIL Open Font License) over `site/art/ring.jpg`: the ring
from the scene behind Halo's main menu, a frame of the game drawn with its
menus hidden (`HALO_WEB_HIDE_MENUS=1`) at three times the pixels
(`HALO_WEB_RENDER_SCALE=3`, with `window.__haloLines = 1440` on the page),
used under Microsoft's Game Content Usage Rules, whose notice the page
carries. Once the player's own game has run, a frame of its main menu
(about 12 seconds in) becomes the start page's background, kept in the
site's storage on that device only.

The GitHub Actions workflow `.github/workflows/web.yml` builds the site for
each commit and publishes the build of `main` on GitHub Pages (in the
repository's settings: Pages > Source: GitHub Actions).

The web build uses the platform layer of the Linux build (`port/linux/src`)
and the code paths of the Android build (OpenGL ES 3, the display's shape).
Refer to [port/linux/README.md](../linux/README.md) and
[port/android/README.md](../android/README.md).

## Requirements

To play:

- iOS or iPadOS 17 or later (Safari, or the installed web app), Android with
  a recent Chrome, or a recent Chrome, Edge or Firefox on a computer. The browser needs WebGL 2 in a worker
  (OffscreenCanvas), SharedArrayBuffer and the Origin Private File System.
- About 2 GB of free storage for the game data.
- An Xbox disc image (`.iso` or `.xiso`) of Halo: Combat Evolved, any version.

To build:

- Python and ninja.
- Emscripten 6 or later: `emcc` on the `PATH`, or the SDK in `~/emsdk`
  (`configure.py --web-emcc` names another). Install it with
  [emsdk](https://emscripten.org/docs/getting_started/downloads.html).
- A network connection for the first build: `configure.py` downloads the
  SDL 3.4.16 headers to `build/web/third_party`.

```
python configure.py --release
ninja web
```

To try the site on a computer, serve `build/web/site` over HTTP, for example
with `python -m http.server -d build/web/site`, and open
`http://localhost:8000`. The page reloads once while its service worker
starts (see "Cross-origin isolation").

## Game data

1. Open the app. It checks what the browser supports.
2. Push *Choose disc image* and select the disc image. On an iPhone, it can
   be in the Files app (iCloud Drive, On My iPhone, a USB drive).
3. Wait while the page copies the `maps` folder (about 1.8 GB) into the
   app's private storage. The disc image is read in place and not changed.
4. Push *Play*.

Several disc images can be installed at once (a multiplayer disc, a full
game, a modded one): *Add another disc image* copies each into its own
folder, and the list under *Game data* chooses the one *Play* starts, with
*Rename* and *Delete* for each. The first copy is the `maps` folder at the
top of the storage; each one added after it is `games/<id>/`, with its
`maps`, an `info.json` (its name), and its own saved games, `config.toml`,
`debug.txt` and shader cache: the page passes that folder to the game as
`HALO_DATA_ROOT` and `HALO_SAVE_ROOT`. Players in an online room need the
same maps.

*Settings and data* > *Export saved games* makes a `.zip` of the chosen
copy's saved games and `config.toml`; *Restore saved games* puts such a
`.zip` (or any `.zip` with a `save` folder in it) back into the chosen copy.

In the game, the menu button (top left) sets the aim sensitivity, the touch
layout (and edits it), the sound on silent and the frame rate view while
the game runs, restarts the game with another copy, or goes back to the
start page. The system's back gesture closes the menu.

The copy is kept in the site's Origin Private File System. The saved games
(`z:\`, `u:\`) and `config.toml` are there too. *Settings and data* can
export the saved games as a `.zip` and delete the game data. On iOS, data of
a site that is not installed can be removed by the system after some weeks
without use: install the app to keep it.

## Controls

- A controller, over Bluetooth or a cable (USB-C or Lightning): Xbox,
  PlayStation, Switch Pro, MFi and Backbone-style controllers, and most
  Android ones, as on Android. Pair it in the system's Bluetooth settings or
  plug it in, then push any of its buttons: browsers show a controller to a
  page only after that. The start page names the controllers it sees; in the
  game a notice says when one connects or disconnects, and the touch
  controls hide while one is connected. Controllers the browser does not
  describe with its standard mapping are read in the usual order of generic
  controllers (triggers as buttons or axes, the d-pad as buttons, axes or a
  hat). Up to four controllers are players 1 to 4 in split screen. Controllers
  are read every 8 ms as well as at each animation frame.
- Touch, in one of two layouts (*Settings and data* > *Touch layout*):
  - *Modern* (the default), as in mobile shooters: a large fire button
    under the right thumb that also aims while held, the other actions as
    icons around it (zoom, melee, reload, grenade and grenade type, weapon
    swap, crouch, jump, flashlight), a second fire button above the stick,
    and pause and score at the top. In the menus, the stick moves the
    selection, and Jump and Melee (marked A and B) select and go back.
  - *Original Xbox controller*: the Controller S, with A, B, X and Y, the
    white and black buttons, the triggers, back and start, the d-pad and
    the stick clicks.

  *Edit layout* (on the start page, or in the game's menu) moves any
  control, the d-pad and the stick's resting place included, by dragging it,
  sizes the one picked, and sets the controls' opacity; each layout keeps
  its own edits.

  In both, a touch anywhere on the left side is a stick for moving, and a
  drag on the right side aims. The touch controls hide while a controller
  is connected. *Settings and data* sets the aim sensitivity, or turns the
  touch controls off. A press counts once even when it is shorter than one
  of the game's frames (`web_gamepad.pressed`).
- A keyboard and mouse (iPad or computer): as on Linux. Click the game to lock
  the pointer; Esc releases it.

## Resolution

The game lays itself out in 480 lines, the Xbox's, at the shape of the screen.
*Settings and data* > *Resolution* picks how many pixels it draws them with:
*Automatic* keeps 480 on phones and tablets (every frame goes from the game's
thread to the page, and their graphics memory is small) and on computers and
Macs uses the screen's own resolution, Retina included, up to 1080 lines. 720,
1080, 1440 and the screen's own can be chosen anywhere, also from the in-game
menu, and take effect at the next frame. More lines than the screen has
smooth the edges, as supersampling does.

*Sharper textures at an angle*, on by default on computers, adds 16x
anisotropic filtering (or as much as the graphics allow), so floors and walls
seen at an angle stay sharp. It takes effect at the next start.

## Sound

iOS plays a page's Web Audio through the ringer: with the phone on silent,
nothing, whatever the volume. The page makes its sound a media player's
(the Audio Session API's `playback`, or before Safari 17, a silent looping
`<audio>` element), so it plays on silent as a video does, and pauses music
from other apps as a video does. *Settings and data* > *Sound when the phone
is on silent* turns this off. After a call or Siri, the sound comes back at
the next touch or key.

## Online play

Players who install the app can play together over the internet, with the
game's own system link:

1. Each player opens *Play online* on the launcher page. One pushes *New
   room*, then *Share link*; the others open the link (or type the room's
   code and push *Join*). The page shows who is in the room.
2. In the game, one player hosts from *Multiplayer* > *System Link Play*
   (A or Y to start a game); the others see the game in that list and join.

Matchmaking (`site/lobby.js`): *Quick Match* joins the open game with the
most players whose host has the same maps (a fingerprint of the copy of the
game's maps), or opens a room and lists it. *Open games* lists the public
rooms, with their host, players, maps and note, each with *Join*; *List this
room in Open games* lists any room. A listed room is a retained MQTT message
on `halo-web/v1/lobby/<id>` on the same brokers, sent again every ten seconds
and cleared when the room is left (an advert older than a minute is
ignored). The page then says who hosts: the host starts a game from
*Multiplayer* > *System Link*, the others join it there. Adverts are public;
the page shows their text as text, cut to length.

Text chat: *Chat* in the game's menu (or in the room, on the start page)
opens the room's chat, with quick messages (GG, Nice shot!, Need backup, and
others). New messages show over the game for a few seconds, and the menu
button counts the unread ones. A message goes to everyone in the room on
the room's topic, encrypted as the rest; it is shown as text, at most 200
characters, and a player sends a few a second at most.

Everyone in a room is on one network, as on a LAN: up to the game's limits
of machines and players, split screen on each machine included.

How it works (`site/net.js`, `src/web_net.c`):

- Each copy of the game has an address on the room's network, 10.x.y.z, kept
  in the browser. The game's sockets put what they send to other addresses
  in a ring in the shared memory, and take what arrives from another ring.
- The page carries those packets over WebRTC to each other player: a
  reliable, ordered data channel for the game's connections and an
  unreliable one for its datagrams. Broadcasts (system link's discovery) go
  to every player. The connections are direct between the players; no server
  carries the game.
- Players find each other through public MQTT brokers over secure WebSockets
  (broker.emqx.io, broker.hivemq.com and test.mosquitto.org, all at once), in
  a topic derived from the room's code. Everything sent there is encrypted
  (AES-GCM) with a key derived from the code, so only those who have the code
  can read the room's messages.
- WebRTC crosses most home networks with STUN (Google's and Cloudflare's
  public servers). Some networks, mobile carriers' especially, need a TURN
  relay: *Settings and data* can name one.

The web build does not play with the desktop and Android builds' internet
play, which uses UDP.

## Custom content

*Custom content* (on the start page, and in the game's menu at the top
left) changes the game while it runs:

- Game rules, in the campaign and in multiplayer: infinite ammo, low gravity,
  speed boost, super jump, big heads and one-shot kills. Online, everyone in
  a room plays by its host's rules (the page of whoever opened the room sends
  them to the others, who cannot change them while they are there).
- Invincible, in the campaign.
- Play as another character in the campaign: a Marine, a Grunt, a Jackal, an
  Elite, a Hunter, a Flood combat form or Elite, an Infection form, a
  Sentinel, 343 Guilty Spark or Captain Keyes. The player becomes that
  character where they stand, armed as the level arms it, with the camera
  following from behind. A level has only the characters it uses: where the
  character is missing the player stays the Master Chief, and the page says
  so. Covenant and Flood characters have no HUD.
- Play as an Elite, a Grunt, a Hunter or a Marine in multiplayer (see below).
  The host can make a game *Master Chief only*.
- A third-person camera, just for the player who turns it on.

The page writes its choices into the memory it shares with the game
(`src/web_shared.h`, `src/web_custom.c`); each frame the game applies them
(`port/linux/game/custom_content.c`, with small `HALO_WEB` hooks in
`game/cheats.c`, `units/bipeds.c`, `units/units.c` and `camera/director.c`).
The rules use the game's own cheats where it has them (infinite ammo,
bottomless clip, super jump, the one-hit-kill "omnipotent" cheat,
deathless player); gravity scales the game's gravity, speed the player's
running speed, and big heads scale each biped's head node and those below
it. Playing another character swaps the player's unit for a new one of that
biped, as the game's own "bump possession" cheat does.

### Characters in multiplayer

The multiplayer maps have only the Master Chief, so as one loads the game
brings the Elite, the Grunt, the Hunter and the Marine in from The Silent
Cartographer (`port/linux/game/custom_characters.c`), when the copy of the
game has the campaign:

- The level is decompressed once into `z:\characters-b30.map` (left out of
  exported saves). Its tag data is read, and the tags the four characters
  use (bipeds, models, animations, collision, shaders, bitmaps, sounds,
  effects, and the Hunter's weapon) are copied after the map's own, about
  4 MB; a tag the map has too (a weapon, an effect) stays the map's. A cache
  file has no field definitions, so the copy finds tag blocks, tag data,
  tag references, pointers and Direct3D vertex and index buffers by their
  shape and points them at the copy; tag indices follow the map's in the
  level's order, so every machine that brings them in has them at the same
  indices. Bitmaps' pixels and sounds' samples are read from the level
  (`cache/cache_files_windows.c`). Dialogue, actors and actor variants are
  left out.
- A player spawns as the character they picked (*Play as*), or becomes it
  in the first three seconds after spawning, when the choice reaches the
  host a moment after the game starts (`game/players.c`,
  `custom_content.c`). A change takes effect at the next spawn. A character
  keeps the weapons it can hold and is given its own when it has none
  (plasma rifle, plasma pistol, assault rifle, the Hunter's fuel rod
  cannon); it cannot pick up weapons it has no animations for.
- Online the host decides: each client tells it its players' characters
  and whether it has the characters, from which level (a message of the
  distributed netcode's own, `_distributed_message_characters`), and the
  host's game spawns them; its objects reach the clients as any others. If
  anyone in the game does not have them (a multiplayer-only copy),
  everyone is the Master Chief and the page says why.
- The camera follows a character from behind; the Elite's from lower than
  its camera track (`camera/following_camera.c`).

## The Silent Cartographer as a multiplayer map

With the campaign in the copy of the game, the multiplayer map list ends with
*Cartographer*: The Silent Cartographer's island as a multiplayer map, for
split screen and System Link (`port/linux/game/custom_characters.c`, with
`HALO_WEB` hooks in the map list, `interface/ui_widget_event_handler_functions.c`,
and its text, `text/text_group.c`). As the level loads for a multiplayer
game:

- Blood Gulch lends it what multiplayer needs and a campaign level has not,
  the same way the characters are brought in: the multiplayer globals (flag,
  ball, hill shader, multiplayer biped, vehicles, announcer), the weapon
  list, the item collections, and the multiplayer menus. Blood Gulch is
  decompressed once into `z:\arena-bloodgulch.map`.
- The level becomes a multiplayer scenario. Players start where the level's
  AI squads stand outside (the beach, the valley, the crash site), red on the
  island's west and blue on its east; each team's flag is at its side's
  furthest start, the oddballs and two hills in the middle, a race track
  across. Weapons and powerups (rocket launcher, sniper rifle, shotgun,
  overshield, camouflage, ...) wait near every third start, and everyone
  starts with Blood Gulch's equipment.
- The campaign stays out: no AI is placed, no script runs by itself, there
  are no placed characters and no switch to the interior.
- The characters (Elite, Grunt, Hunter, Marine) are the level's own.

Everyone in the game needs the campaign too.

## Multiplayer maps alone

A split screen game starts with one player: Multiplayer > Split Screen, pick
a profile, a map and a game type, and start it to play or explore a
multiplayer map alone (the original game waits for a second player; in
`networking/network_server_manager.c` and the pregame screen's text, under
`HALO_WEB`). A system link game still waits for a second machine, so that
the others in a room have time to join.

## Remote co-op

A friend in the room can play the host's game as its second player from
their own device, as on one console with two controllers: the campaign's
co-op (Multiplayer > Cooperative Play, with the full game) or a split screen
multiplayer game. The host turns on *Host co-op* in the room (or in the
game's menu); the others in the room see *Join Alpha's game as player 2*.
The friend's device runs no game and needs no game data.

- The friend's controls (touch controls, a controller, or the keyboard and
  mouse) go to the host over a WebRTC data channel sixty times a second; the
  host's page hands them to the game as a controller of its own, the last
  slot of the shared state (`src/web_shared.h`), which the game's controller
  code never merges with the host's keyboard (`port/linux/src/xinput_sdl.c`).
  Aiming by dragging or with a mouse goes as motion, which the game adds to
  that player's aim as it does the host's mouse.
- The host's page streams the friend's view back as WebRTC video, with the
  game's sound. While the friend watches, the game does not split the
  screen: it draws each player's view on a whole screen of its own, in the
  screen's shape, as on each player's own console (`main_game_render` in
  `main/main.c`, under `HALO_WEB`): first the friend's, which goes to their
  device (`haloPresentView`), then the host's, which the host sees. The
  friend can watch the host's screen instead.
- Their connection is signalled over the room's encrypted topic, apart from
  the room's own connections (`site/coop.js`).

## How the port operates

### WebAssembly

wasm32 is an ILP32 target: `int`, `long` and pointers have 32 bits, as the
game's data formats need, and the game runs as it does on the other ports.

- The WebAssembly memory is 0x88000000 bytes and does not grow. Its top
  128 MB is the Xbox memory window at 0x80000000 (`port/linux/src/platform.h`),
  so the tag cache and the game state get the fixed addresses of their files.
  The C heap stays below it (`src/web_main.c`, `emscripten_get_heap_size`).
- The game and the platform layer are compiled with link-time optimisation.
  C89 code calls functions declared differently from their definitions,
  which x86 tolerates and WebAssembly traps on; with the whole program in one
  module, LLVM gives each such call a wrapper that adapts the arguments.
- The multivalue ABI (`-target-abi experimental-mv`) passes and returns small
  structures and unions as values, as Win32 returns them in registers:
  `hs_runtime.c` calls functions that return unions through pointers typed as
  returning `long`.
- `-mnontrapping-fptoint`: a float that does not fit an integer converts as
  on x86 instead of trapping.
- Calls whose declarations disagree with the definition in a way LLVM cannot
  adapt (integer widths, since its wrappers only bitcast), and function
  pointers called with another signature, are repaired in `#ifdef HALO_WEB`:
  local prototypes that now match their definitions (`hs.c`, `rasterizer.c`,
  `ui_widget_event_handler_functions.c` and others), the cache thread's start
  routine (`cache_files_windows.c`), the stub game engine's callbacks
  (`game_engine_stub.c`), `weapon_preprocess_node_orientations`, a `va_list`
  (`terminal.c`), and two globals defined in a header (`object_lists.h`;
  WebAssembly has no common symbols). An unoptimised link
  (`-Wl,--lto-O0`) names any call LLVM could not adapt
  `<function>_bitcast_invalid`; only libtiff's remain, which the game does not
  use.

### Threads and the page

The game runs on a pthread (Emscripten's `PROXY_TO_PTHREAD`), a Web Worker,
so it can block as a native program does. It never returns to its event loop.
The page's main thread (`site/app.js`, `site/input.js`) serves it through
memory both share (`src/web_shared.h`):

- Graphics: the game's WebGL 2 context draws into an OffscreenCanvas of its
  own thread (`src/web_library.js`). Each frame is taken out with
  `transferToImageBitmap` and posted to the page, which shows it on its
  canvas. The page advances a counter each animation frame; the game waits for
  it after each frame (`display.vsync`).
- Input: the page writes keyboard, mouse and focus events into a ring that
  `SDL_PollEvent` reads, and the state of the controllers (Gamepad API, and
  the touch controls as one more controller).
- Sound: a thread of the game fills a ring of 48 kHz samples with the mixer of
  `dsound_sdl.c`; an AudioWorklet (`site/audio-worklet.js`) plays it.
- Network: split screen is a network game whose host and clients are the
  same machine. `src/web_net.c` gives the Winsock layer (`port/linux/src/xnet.c`)
  sockets that reach each other inside the page: datagrams to the loopback,
  local or a broadcast address go to the socket bound to their port, and
  stream sockets connect through queues. `HALO_NET_DEBUG=1` logs the traffic.
- Time: `GetTickCount` and `QueryPerformanceCounter` count from the start, as
  an Xbox counts from its boot. A browser's monotonic clock counts from 1970,
  past 2^31 milliseconds, and the network code compares tick counts as
  signed longs.
- Files: WasmFS mounts the Origin Private File System at `/data`, the data
  root (`HALO_DATA_ROOT`); the saved games go to `/data/save`.

`src/web_sdl.c` gives the platform layer the SDL3 functions it calls (the
Android guest's list, `port/android/guest/runtime/guest_sdl.c`).

### WebGL 2

The renderer takes its OpenGL ES 3.0 path (port/android/README.md), with
these differences for WebGL 2 (`#ifdef HALO_WEB` in `xbox_textures.c` and
`src/web_host.c`):

- WebGL has no texture swizzle: decoded textures are turned from BGRA to RGBA
  on the CPU.
- S3TC textures go to the GPU only as 2D textures whose sides are multiples of
  four; the others are decoded. iOS has no S3TC: all are decoded.
- The visibility tests (lens flares) report every sample visible: WebGL gives
  query results only between tasks, which the game's thread never reaches.
- Buffer writes are `glBufferSubData`, which copies: there are no fences.
- Strides are at most 255 bytes, less than an immediate mode vertex (16
  attributes of 4 floats). The attributes whose value is the same for every
  vertex of a draw become constant attributes; the others go up interleaved,
  a whole number of vertices into the buffer, so the attribute pointers stay
  as they were and the draw starts at a first vertex. Safari runs WebGL in
  another process, and each call costs a message: this takes the menus from
  about 2,300 calls a frame to 700.

WebGL cannot keep compiled shaders, and a browser compiles one the first
time a draw needs it; Safari translates each to Metal in another process,
and the draw waits. `src/web_shader_cache.c` records the source of each
shader the renderer compiles and each pair it links in `shader-cache.txt`,
next to `maps`. When the game starts, it compiles and links all of them at
once (in parallel with `KHR_parallel_shader_compile`), so an effect, menu
or map that was seen before does not stutter the first time it shows again.

The Xbox memory cannot be write-protected in WebAssembly. The memory watch
(`src/web_memory_watch.c`) keeps a hash of each page the renderer caches, and
a changed hash counts as a write. A page is hashed at most once a frame,
unless it has been seen to change. Textures of 128 KB or less, which the game
rewrites between draws (the text renderer's character cache), are checked at
every use; larger ones change through file reads, which announce themselves.

### Cross-origin isolation

SharedArrayBuffer needs the page to be cross-origin isolated
(`Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers).
Static hosts such as GitHub Pages cannot send headers, so the service worker
(`site/sw.js`) adds them. The first visit reloads the page once. The service
worker also keeps the site for use offline; a new build replaces it as a
whole when the player accepts the update.

### The game data

`site/xiso-worker.js` reads the XDVDFS file system of the disc image as
`port/linux/src/xiso.c` does and writes the files of `maps` with the OPFS
synchronous access handles. It writes `maps/.complete` last; the page starts
the game only when it is there.

## Limits

- The WebAssembly memory needs 2.1 GB of address space. If the browser does
  not give it, the page says so. Close other apps and tabs.
- System link is between copies of the web build in one room ("Online
  play"), not with Xboxes or the other ports on the local network: browsers
  have no UDP.
- Bink video is not available. The game skips the movies.
- Lens flares show through walls (see "WebGL 2").
- Performance depends on the device. See "Resolution".

## Find problems

*Settings and data* > *Show the frame rate* shows, over the game, the
frames drawn each second and the display's rate, where each frame's time
goes (the game's work, presenting, waiting for the display), the bytes the
memory watch hashed, and the WebGL calls of each frame and their time.

*Settings and data* > *Show log* shows the page's log and `debug.txt`, the
game's log, and can copy them for a report. *Log graphics errors* sets
`debug.gl_debug`. When the game stops, the page shows why.

For development, `window.__haloArgs` (set before *Play*) passes environment
variables to the game: `--HALO_WEB_GL_STATS=1` logs the WebGL calls of each
frame, `--HALO_WEB_NO_S3TC=1` decodes compressed textures as iOS does.
