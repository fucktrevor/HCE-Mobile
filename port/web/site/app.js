/*
APP.JS

The page of the web port (port/web/README.md): it checks that the browser
can run the game, copies the game data out of the player's disc image
(xiso-worker.js), then starts the game (halo.js and halo.wasm, built by
`ninja web`) and serves it on the main thread:

- each frame the game's thread posts as an ImageBitmap goes onto the
  canvas (Module.haloPresent);
- each animation frame advances a counter the game waits on, polls the
  controllers (input.js) and gives the game the canvas's size;
- the game's sound plays through an AudioWorklet (audio-worklet.js).
*/

'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  // the WebAssembly memory the build expects (tools/web_build.py
  // WEB_MEMORY_BYTES): the Xbox memory window ends at 0x88000000
  const MEMORY_PAGES = 0x88000000 / 65536;
  const REQUIRED_BYTES = 2.1e9;

  const state = {
    memory: null,
    audio: null,
    started: false,
    shared: null,
    offsets: null,
    log: [],
    wakeLock: null,
    version: null,
    games: [],       // the installed copies of the game (listGames)
    importing: null, // the id of the copy being imported
  };

  // ---------- settings (this browser's; nothing else depends on them)

  const coarsePointer = matchMedia('(pointer: coarse)').matches;
  const settings = { touch: coarsePointer, touchLayout: 'modern', look: 1.4, vsync: true, glDebug: false, showTiming: false, silentSound: true };
  try {
    Object.assign(settings, JSON.parse(localStorage.getItem('halo-web-settings') || '{}'));
  } catch { /* private browsing: the defaults */ }

  function saveSettings() {
    try { localStorage.setItem('halo-web-settings', JSON.stringify(settings)); } catch { /* not kept */ }
  }

  // ---------- log

  function log(line) {
    const text = String(line);
    state.log.push(text);
    if (state.log.length > 2000) state.log.splice(0, state.log.length - 2000);
    console.log(text);
  }

  async function debugText() {
    try {
      const root = await navigator.storage.getDirectory();
      const file = await (await root.getFileHandle('debug.txt')).getFile();
      const text = await file.text();
      return text.length > 200000 ? text.slice(-200000) : text;
    } catch {
      return '';
    }
  }

  async function fullLog() {
    const debug = await debugText();
    return `${navigator.userAgent}\n\n--- page and console ---\n${state.log.join('\n')}` +
      (debug ? `\n\n--- debug.txt ---\n${debug}` : '');
  }

  function toast(text, milliseconds = 3500) {
    const element = $('toast');
    element.textContent = text;
    element.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { element.hidden = true; }, milliseconds);
  }

  async function fatal(text) {
    log('fatal: ' + text);
    $('fatal-text').textContent = text;
    $('fatal').hidden = false;
    document.body.classList.remove('playing');
  }

  // ---------- checks

  function addCheck(ok, text, level) {
    const element = document.createElement('div');
    element.className = 'check' + (ok ? '' : level === 'warn' ? ' warn' : ' bad');
    element.textContent = text;
    $('checks').appendChild(element);
    return ok;
  }

  async function ensureIsolation() {
    if (!('serviceWorker' in navigator)) return;
    try {
      await navigator.serviceWorker.register('sw.js');
    } catch (error) {
      log('service worker: ' + error);
      return;
    }
    if (window.crossOriginIsolated) return;
    await navigator.serviceWorker.ready;
    // the service worker serves the page with the isolation headers from
    // its next load on
    let reloaded = false;
    try { reloaded = sessionStorage.getItem('halo-web-isolation') === '1'; } catch { /* none */ }
    if (!reloaded) {
      try { sessionStorage.setItem('halo-web-isolation', '1'); } catch { /* none */ }
      location.reload();
      await new Promise(() => {});
    }
  }

  function webgl2InWorkers() {
    try {
      return typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(1, 1).getContext('webgl2');
    } catch {
      return false;
    }
  }

  async function runChecks() {
    let ok = true;
    ok = addCheck(window.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined',
      window.crossOriginIsolated ? 'Threads (SharedArrayBuffer)' :
        'Threads: this page is not cross-origin isolated. Reload it; if this stays, the browser is too old.') && ok;
    ok = addCheck(webgl2InWorkers(), 'WebGL 2 from a worker (OffscreenCanvas; iOS 17 or later)') && ok;
    ok = addCheck(!!(navigator.storage && navigator.storage.getDirectory), 'Private file storage (OPFS)') && ok;
    if (ok) {
      try {
        state.memory = new WebAssembly.Memory({ initial: MEMORY_PAGES, maximum: MEMORY_PAGES, shared: true });
        addCheck(true, 'Memory (2.1 GB of address space)');
      } catch (error) {
        ok = addCheck(false, 'Memory: the browser would not reserve 2.1 GB of address space for the game (' +
          error.message + '). Close other tabs and apps, then reload.');
      }
    }
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        const free = (estimate.quota || 0) - (estimate.usage || 0);
        $('storage-summary').textContent = `Storage: ${(estimate.usage / 1e9).toFixed(2)} GB used of ` +
          `${(estimate.quota / 1e9).toFixed(1)} GB this site may use.`;
        state.freeBytes = free;
      } catch { /* unknown */ }
    }
    return ok;
  }

  // ---------- game data

  // Several copies of the game can be installed, each from its own disc
  // image (a multiplayer disc, a full game, a modded one), and one is chosen
  // to play. The first copy is the "maps" folder at the top of the storage
  // (as before); each one added after it is games/<id>/, with its maps, an
  // info.json (its name), its saved games and its shader cache. The game
  // takes the chosen copy's folder as its data root (src/web_main.c).
  const CAMPAIGN_MAPS = ['a10.map', 'a30.map', 'b30.map', 'c10.map', 'd40.map'];

  async function readJson(directory, name) {
    try {
      return JSON.parse(await (await (await directory.getFileHandle(name)).getFile()).text());
    } catch {
      return null;
    }
  }

  async function listGames() {
    const games = [];
    let root;
    try {
      root = await navigator.storage.getDirectory();
    } catch {
      return games;
    }
    try {
      const complete = await readJson(await root.getDirectoryHandle('maps'), '.complete');
      if (complete) {
        games.push({ id: 'default', name: (settings.gameNames && settings.gameNames.default) || 'Halo',
          files: complete.files, bytes: complete.bytes, added: 0, path: [], dataRoot: '/data' });
      }
    } catch { /* no first copy */ }
    try {
      const folder = await root.getDirectoryHandle('games');
      for await (const [id, handle] of folder.entries()) {
        if (handle.kind !== 'directory' || id === state.importing) continue;
        let complete = null;
        try { complete = await readJson(await handle.getDirectoryHandle('maps'), '.complete'); } catch { /* none */ }
        if (!complete) {
          // a copy that did not finish: its space back
          await folder.removeEntry(id, { recursive: true }).catch(() => {});
          continue;
        }
        const info = (await readJson(handle, 'info.json')) || {};
        games.push({ id, name: info.name || 'Halo', source: info.source, files: complete.files, bytes: complete.bytes,
          added: info.added || 0, path: ['games', id], dataRoot: '/data/games/' + id });
      }
    } catch { /* none added */ }
    games.sort((a, b) => a.added - b.added);
    return games;
  }

  function describeGame(game) {
    const names = (game.files || []).map((name) => name.toLowerCase());
    const campaign = CAMPAIGN_MAPS.some((name) => names.includes(name));
    return `${campaign ? 'Campaign and multiplayer' : 'Multiplayer only'} · ${names.length} maps · ${(game.bytes / 1e9).toFixed(2)} GB`;
  }

  function selectedGame() {
    return state.games.find((game) => game.id === settings.game) || state.games[0] || null;
  }

  async function refreshGames() {
    state.games = await listGames();
    const list = $('games');
    list.textContent = '';
    const chosen = selectedGame();
    for (const game of state.games) {
      const row = document.createElement('div');
      row.className = 'game' + (chosen && game.id === chosen.id ? ' chosen' : '');
      const pick = document.createElement('label');
      pick.className = 'game-pick';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'game';
      radio.checked = !!(chosen && game.id === chosen.id);
      radio.onchange = () => { settings.game = game.id; saveSettings(); refreshGames(); };
      const text = document.createElement('span');
      text.innerHTML = '<strong></strong><small></small>';
      text.querySelector('strong').textContent = game.name;
      text.querySelector('small').textContent = describeGame(game) + (game.source ? ` · ${game.source}` : '');
      pick.append(radio, text);
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'button small-button';
      rename.textContent = 'Rename';
      rename.onclick = () => renameGame(game);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button small-button danger';
      remove.textContent = 'Delete';
      remove.onclick = () => deleteGame(game);
      row.append(pick, rename, remove);
      list.appendChild(row);
    }
    const any = state.games.length > 0;
    $('step-play').hidden = !any;
    $('data-intro').hidden = any;
    $('add-label').textContent = any ? 'Add another disc image…' : 'Choose disc image…';
    $('add-label').classList.toggle('primary', !any);
    if (chosen) $('data-summary').textContent = `Plays ${chosen.name}.`;
  }

  function workerTask(message, onProgress) {
    return new Promise((resolve, reject) => {
      const worker = new Worker('xiso-worker.js');
      worker.onmessage = (event) => {
        const reply = event.data;
        if (reply.type === 'progress') {
          if (onProgress) onProgress(reply);
        } else if (reply.type === 'done') {
          worker.terminate();
          resolve(reply);
        } else if (reply.type === 'error') {
          worker.terminate();
          reject(new Error(reply.message));
        }
      };
      worker.onerror = (event) => {
        worker.terminate();
        reject(new Error(event.message || 'The copy stopped.'));
      };
      worker.postMessage(message);
    });
  }

  async function renameGame(game) {
    const name = (prompt('Name this copy of the game:', game.name) || '').trim().slice(0, 60);
    if (!name || name === game.name) return;
    if (game.id === 'default') {
      settings.gameNames = { ...(settings.gameNames || {}), default: name };
      saveSettings();
    } else {
      try {
        await workerTask({ op: 'rename', target: game.path, name });
      } catch (error) {
        toast('Cannot rename it: ' + error.message);
      }
    }
    refreshGames();
  }

  async function deleteGame(game) {
    if (!confirm(`Delete ${game.name} (${(game.bytes / 1e9).toFixed(2)} GB)? Its saved games go with it.`)) return;
    try {
      const root = await navigator.storage.getDirectory();
      if (game.id === 'default') {
        await root.removeEntry('maps', { recursive: true });
      } else {
        await (await root.getDirectoryHandle('games')).removeEntry(game.id, { recursive: true });
      }
    } catch (error) {
      log('delete: ' + error);
    }
    if (settings.game === game.id) {
      settings.game = null;
      saveSettings();
    }
    refreshGames();
  }

  function extract(file, target, name) {
    const started = Date.now();
    $('progress').hidden = false;
    return workerTask({ file, target, name }, (message) => {
      const fraction = message.total ? message.done / message.total : 0;
      $('progress-fill').style.width = (fraction * 100).toFixed(1) + '%';
      const seconds = (Date.now() - started) / 1000;
      const rate = message.done / Math.max(seconds, 0.1);
      const left = rate > 0 ? (message.total - message.done) / rate : 0;
      $('progress-text').textContent = `Copying maps/${message.file}: ` +
        `${(message.done / 1e9).toFixed(2)} of ${(message.total / 1e9).toFixed(2)} GB` +
        (seconds > 3 ? `, about ${Math.ceil(left / 60)} min left` : '');
    });
  }

  async function onImageChosen(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (state.freeBytes !== undefined && state.freeBytes < REQUIRED_BYTES) {
      toast('There may not be enough free storage for another copy of the game (up to 1.8 GB).', 6000);
    }
    if (navigator.storage && navigator.storage.persist) {
      // keep the data when the device runs low on space
      navigator.storage.persist().catch(() => {});
    }
    // the first copy keeps its place at the top; the others each have a folder
    const first = !state.games.length;
    const id = first ? 'default' : Date.now().toString(36);
    const name = file.name.replace(/\.(x?iso)$/i, '').replace(/[_]+/g, ' ').trim().slice(0, 60) || 'Halo';
    $('iso-file').disabled = true;
    state.importing = id;
    try {
      const result = await extract(file, first ? [] : ['games', id], name);
      log(`extracted ${result.files} files, ${result.bytes} bytes`);
      $('progress-text').textContent = 'Done.';
      if (first) settings.gameNames = { ...(settings.gameNames || {}), default: name };
      settings.game = id;
      saveSettings();
    } catch (error) {
      $('progress-text').textContent = error.message;
      log('extraction failed: ' + error.message);
    } finally {
      state.importing = null;
      $('iso-file').disabled = false;
      refreshGames();
    }
  }

  // ---------- saved games: a .zip of the save folder (stored, not compressed)

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function zip(files) {
    const encoder = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const { name, bytes } of files) {
      const nameBytes = encoder.encode(name);
      const crc = crc32(bytes);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, bytes.length, true);
      local.setUint32(22, bytes.length, true);
      local.setUint16(26, nameBytes.length, true);
      parts.push(new Uint8Array(local.buffer), nameBytes, bytes);
      const entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true);
      entry.setUint16(4, 20, true);
      entry.setUint16(6, 20, true);
      entry.setUint32(16, crc, true);
      entry.setUint32(20, bytes.length, true);
      entry.setUint32(24, bytes.length, true);
      entry.setUint16(28, nameBytes.length, true);
      entry.setUint32(42, offset, true);
      central.push(new Uint8Array(entry.buffer), nameBytes);
      offset += 30 + nameBytes.length + bytes.length;
    }
    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  async function exportSaves() {
    const files = [];
    async function walk(directory, prefix) {
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind === 'directory') await walk(handle, prefix + name + '/');
        else files.push({ name: prefix + name, bytes: new Uint8Array(await (await handle.getFile()).arrayBuffer()) });
      }
    }
    try {
      let root = await navigator.storage.getDirectory();
      const game = selectedGame();
      for (const name of (game ? game.path : [])) root = await root.getDirectoryHandle(name);
      await walk(await root.getDirectoryHandle('save'), 'save/');
      try {
        const config = await (await root.getFileHandle('config.toml')).getFile();
        files.push({ name: 'config.toml', bytes: new Uint8Array(await config.arrayBuffer()) });
      } catch { /* none yet */ }
    } catch {
      toast('There are no saved games yet.');
      return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(zip(files));
    const game = selectedGame();
    link.download = `halo-saves${game && game.id !== 'default' ? '-' + game.name.replace(/[^\w-]+/g, '-') : ''}.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  }

  async function deleteData() {
    if (!state.games.length) return;
    if (!confirm('Delete every copy of the game and the saved games of the copies added after the first?')) return;
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('maps', { recursive: true }).catch(() => {});
      await root.removeEntry('games', { recursive: true }).catch(() => {});
    } catch { /* already gone */ }
    settings.game = null;
    saveSettings();
    refreshGames();
  }

  // ---------- controllers on the start page

  // Browsers show a controller to a page only after one of its buttons is
  // pressed while the page is open: the start page says so, and names the
  // controllers it sees.
  function watchControllers() {
    const view = $('controller-status');
    const update = () => {
      if (state.started) return;
      const names = HaloInput.connectedControllers();
      view.textContent = names.length
        ? `Controller ready: ${names.join(', ')}. It replaces the touch controls while connected.`
        : 'Using a controller? Pair it (Bluetooth) or plug it in, then press any button on it.';
      view.classList.toggle('ready', names.length > 0);
    };
    window.addEventListener('gamepadconnected', update);
    window.addEventListener('gamepaddisconnected', update);
    update();
    setInterval(update, 1000);
  }

  // ---------- the running game

  function landscapeSize() {
    // The game draws 480 lines in the shape of the screen (src/web_main.c).
    // The canvas is that size too: the page scales it up, and each frame
    // that goes from the game's thread to the page is a third of the pixels
    // of the screen's own resolution.
    const long = Math.max(window.innerWidth, window.innerHeight);
    const short = Math.max(1, Math.min(window.innerWidth, window.innerHeight));
    const height = 480;
    const width = Math.min(Math.round(height * long / short), 1440);
    return { width: width & ~1, height };
  }

  function sharedWord(name) {
    return (state.shared + state.offsets[name]) >> 2;
  }

  function readOffsets(module) {
    const pointer = module._web_shared_offsets();
    const words = new Int32Array(state.memory.buffer, pointer, 32);
    const names = ['size', 'eventWrite', 'eventRead', 'events', 'eventSize', 'gamepads', 'gamepadSize',
      'displayWidth', 'displayHeight', 'frameCounter', 'framesPresented', 'vsync', 'audioRate', 'audioOpen',
      'audioWrite', 'audioRead', 'audioUnderruns', 'audioRing', 'audioRingFrames', 'pageHidden', 'gameStarted',
      'eventCapacity', 'gamepadCount', 'netLocalAddress', 'netOutWrite', 'netOutRead', 'netInWrite', 'netInRead',
      'netOut', 'netOutBytes', 'netIn', 'netInBytes'];
    const offsets = {};
    names.forEach((name, index) => { offsets[name] = words[index]; });
    return offsets;
  }

  function updateDisplaySize() {
    const i32 = new Int32Array(state.memory.buffer);
    const { width, height } = landscapeSize();
    Atomics.store(i32, sharedWord('displayWidth'), width);
    Atomics.store(i32, sharedWord('displayHeight'), height);
    $('rotate').hidden = !(state.started && window.innerHeight > window.innerWidth);
  }

  function animationFrame() {
    const i32 = new Int32Array(state.memory.buffer);
    Atomics.add(i32, sharedWord('frameCounter'), 1);
    Atomics.notify(i32, sharedWord('frameCounter'));
    HaloInput.pollGamepads();
    requestAnimationFrame(animationFrame);
  }

  // Settings: "Show the frame rate": frames shown each second, and how many
  // animation frames the page had in that second
  function showFrameRate() {
    const view = $('fps');
    let frames = 0, ticks = 0, last = performance.now();
    view.hidden = false;
    const tick = () => { ticks++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    setInterval(() => {
      const now = performance.now();
      const seconds = (now - last) / 1000;
      const shown = (state.presented || 0) - frames;
      view.textContent = `${Math.round(shown / seconds)} fps · display ${Math.round(ticks / seconds)} Hz` +
        (state.timing ? `\n${state.timing}` : '') + (state.glTiming ? `\n${state.glTiming}` : '');
      frames = state.presented || 0;
      ticks = 0;
      last = now;
    }, 1000);
  }

  function onVisibility() {
    if (!state.shared) return;
    const i32 = new Int32Array(state.memory.buffer);
    const hidden = document.hidden ? 1 : 0;
    Atomics.store(i32, sharedWord('pageHidden'), hidden);
    Atomics.notify(i32, sharedWord('frameCounter'));
    if (state.audio) {
      if (hidden) state.audio.suspend().catch(() => {});
      else state.audio.resume().catch(() => {});
    }
    if (state.silentAudio) {
      if (hidden) state.silentAudio.pause();
      else state.silentAudio.play().catch(() => {});
    }
    if (!hidden) requestWakeLock();
  }

  async function requestWakeLock() {
    try {
      if (navigator.wakeLock && !document.hidden) state.wakeLock = await navigator.wakeLock.request('screen');
    } catch { /* not allowed now */ }
  }

  // iOS plays a page's Web Audio through the ringer: on silent, nothing,
  // whatever the volume. As a media player's sound ("playback"), it plays on
  // silent, as a video's does (and pauses other apps' music, as they do).
  // Safari 17 and later take the Audio Session API; before it, a page that
  // plays an <audio> element has the same audio session, and a silent one,
  // looping, is enough.
  function playThroughSilentSwitch() {
    if (!settings.silentSound) return;
    try {
      if (navigator.audioSession) {
        navigator.audioSession.type = 'playback';
        return;
      }
    } catch { /* not settable */ }
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!ios) return;
    // half a second of silence: 8 kHz, 8 bits, mono
    const samples = 4000;
    const bytes = new Uint8Array(44 + samples);
    const view = new DataView(bytes.buffer);
    const text = (offset, value) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
    text(0, 'RIFF'); view.setUint32(4, 36 + samples, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true); view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
    text(36, 'data'); view.setUint32(40, samples, true); bytes.fill(128, 44);
    const element = document.createElement('audio');
    element.src = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    element.loop = true;
    element.setAttribute('playsinline', '');
    element.play().catch((error) => log('silent switch: ' + error));
    state.silentAudio = element;
  }

  // a call, Siri or another app can stop the sound; the next touch or key
  // starts it again
  function keepAudioRunning() {
    const resume = () => {
      if (state.audio && state.audio.state !== 'running' && !document.hidden) state.audio.resume().catch(() => {});
      if (state.silentAudio && state.silentAudio.paused && !document.hidden) state.silentAudio.play().catch(() => {});
    };
    window.addEventListener('touchstart', resume, { passive: true });
    window.addEventListener('keydown', resume);
    window.addEventListener('pointerdown', resume);
    if (state.audio) state.audio.onstatechange = () => log('audio: ' + state.audio.state);
  }

  async function startAudio() {
    const context = state.audio;
    if (!context) return;
    try {
      await context.audioWorklet.addModule('audio-worklet.js');
      const i32 = new Int32Array(state.memory.buffer);
      const node = new AudioWorkletNode(context, 'halo-audio', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: {
          buffer: state.memory.buffer,
          ring: state.shared + state.offsets.audioRing,
          ringFrames: state.offsets.audioRingFrames,
          write: state.shared + state.offsets.audioWrite,
          read: state.shared + state.offsets.audioRead,
          underruns: state.shared + state.offsets.audioUnderruns,
          rate: 48000,
        },
      });
      node.connect(context.destination);
      Atomics.store(i32, sharedWord('audioOpen'), 1);
      log(`audio: ${context.sampleRate} Hz`);
    } catch (error) {
      log('audio: ' + error);
      toast('Sound is not available: ' + error.message);
    }
  }

  function play() {
    if (state.started) return;
    state.started = true;

    // in the tap: browsers start sound only then
    playThroughSilentSwitch();
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      state.audio = new AudioContextClass({ sampleRate: 48000, latencyHint: 'interactive' });
      state.audio.resume().catch(() => {});
      keepAudioRunning();
    } catch (error) {
      log('audio context: ' + error);
    }
    document.body.classList.add('playing');
    const root = document.documentElement;
    if (root.requestFullscreen && !navigator.standalone) root.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
    requestWakeLock();
    // the system's back gesture or button (Android) backs out of menus, as
    // the controller's B does, instead of leaving the game
    history.pushState({ playing: true }, '');
    window.addEventListener('popstate', () => {
      HaloInput.pressBack();
      history.pushState({ playing: true }, '');
    });

    const canvas = $('screen');
    const context = canvas.getContext('bitmaprenderer');
    // (tests pass extra --NAME=value settings in window.__haloArgs)
    const argumentsList = Array.isArray(window.__haloArgs) ? window.__haloArgs.slice() : [];
    const game = selectedGame();
    if (game && game.id !== 'default') {
      argumentsList.push('--HALO_DATA_ROOT=' + game.dataRoot, '--HALO_SAVE_ROOT=' + game.dataRoot + '/save');
    }
    log('playing ' + (game ? `${game.name} (${game.dataRoot})` : 'nothing'));
    if (!settings.vsync) argumentsList.push('--HALO_NO_VSYNC=1');
    if (settings.glDebug) argumentsList.push('--HALO_GL_DEBUG=1');
    // the frame rate view also counts the WebGL calls and their time
    if (settings.showTiming) argumentsList.push('--HALO_WEB_GL_STATS=1');

    window.Module = {
      wasmMemory: state.memory,
      arguments: argumentsList,
      print: (text) => log(text),
      printErr: (text) => log(text),
      haloPresent: (bitmap) => {
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        context.transferFromImageBitmap(bitmap);
        state.presented = (state.presented || 0) + 1;
      },
      haloMessage: (kind, text) => {
        if (kind === 0) log('game: ' + text);
        else if (kind === 1) toast(text, 5000);
        else if (kind === 2) log('clipboard: ' + text);
        else if (kind === 4) log('thread error: ' + text);
        else if (kind === 6) state.timing = text;
        else if (kind === 7) state.glTiming = text;
        else if (kind === 5) {
          log('game: ' + text);
          $('fatal').querySelector('h2').textContent = 'The game quit';
          fatal(text + ' Reload to start it again.');
        }
        else fatal(text);
      },
      onAbort: (what) => fatal('The game stopped: ' + what),
      onRuntimeInitialized: () => {
        const module = window.Module;
        state.shared = module._web_shared_state();
        state.offsets = readOffsets(module);
        updateDisplaySize();
        HaloInput.attach({
          memory: state.memory,
          base: state.shared,
          offsets: state.offsets,
          canvas,
          touchRoot: $('touch'),
          touch: settings.touch,
          touchLayout: settings.touchLayout,
        });
        HaloInput.setLookSensitivity(settings.look);
        HaloInput.onController((name, connected) => {
          toast(connected ? `Controller connected: ${name}` : 'Controller disconnected', 2500);
        });
        HaloNet.attach({ memory: state.memory, base: state.shared, offsets: state.offsets });
        $('touch').hidden = !settings.touch;
        requestAnimationFrame(animationFrame);
        // controllers are also read between animation frames, so a press
        // shorter than a frame still counts
        setInterval(() => HaloInput.pollGamepads(), 8);
        if (settings.showTiming) showFrameRate();
        startAudio();
        log('runtime ready');
      },
    };

    const script = document.createElement('script');
    script.src = 'halo.js';
    script.onerror = () => fatal('Could not load halo.js.');
    document.body.appendChild(script);
  }

  // ---------- online play (net.js)

  function onlineOptions() {
    const options = {};
    if (settings.turnUrl) {
      options.turn = { urls: settings.turnUrl, username: settings.turnUser || '', credential: settings.turnPassword || '' };
    }
    // (tests name their own broker: ?signal=ws://...)
    const signal = new URLSearchParams(location.search).get('signal');
    if (signal) options.brokers = [signal];
    return options;
  }

  function roomLink(code) {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('room', code);
    return url.toString();
  }

  function showOnline(status) {
    const inRoom = !!status.room;
    $('online-join').hidden = inRoom;
    $('online-room').hidden = !inRoom;
    if (!inRoom) return;
    $('online-code').textContent = status.room;
    const players = status.players === 1 ? '1 other player' : `${status.players} other players`;
    $('online-status').textContent = status.brokers ? `Connected: ${players} in the room.` :
      'Looking for the room… (checking the connection)';
    $('online-names').textContent = status.names.length ? status.names.join(', ') : '';
  }

  async function joinRoom(code) {
    try {
      const joined = await HaloNet.join(code, onlineOptions());
      try { localStorage.setItem('halo-web-room', joined); } catch { /* not kept */ }
    } catch (error) {
      toast(error.message);
    }
  }

  function setUpOnline() {
    HaloNet.on((type, detail) => {
      if (type === 'status') showOnline(detail);
      if (type === 'joined') toast(`${detail.name} joined the room.`);
      if (type === 'left') toast(`${detail.name} left the room.`);
    });
    let name = '';
    try { name = localStorage.getItem('halo-web-player-name') || ''; } catch { /* none */ }
    $('online-name').value = name;
    $('online-name').onchange = (event) => {
      try { localStorage.setItem('halo-web-player-name', event.target.value.trim().slice(0, 24)); } catch { /* none */ }
    };
    $('online-create').onclick = () => joinRoom(HaloNet.newRoomCode());
    $('online-enter').onclick = () => joinRoom($('online-input').value);
    $('online-input').onkeydown = (event) => { if (event.key === 'Enter') joinRoom(event.target.value); };
    $('online-leave').onclick = async () => {
      await HaloNet.leave();
      try { localStorage.removeItem('halo-web-room'); } catch { /* none */ }
    };
    $('online-share').onclick = async () => {
      const link = roomLink(HaloNet.status().room);
      try {
        if (navigator.share) await navigator.share({ title: 'Halo CE room', text: 'Join my Halo game', url: link });
        else {
          await navigator.clipboard.writeText(link);
          toast('The room link is copied.');
        }
      } catch { /* cancelled */ }
    };
    $('online-address').textContent = HaloNet.addressText(HaloNet.address);
    $('opt-turn-url').value = settings.turnUrl || '';
    $('opt-turn-user').value = settings.turnUser || '';
    $('opt-turn-password').value = settings.turnPassword || '';
    for (const [id, key] of [['opt-turn-url', 'turnUrl'], ['opt-turn-user', 'turnUser'], ['opt-turn-password', 'turnPassword']]) {
      $(id).onchange = (event) => { settings[key] = event.target.value.trim(); saveSettings(); };
    }
    // a room link, or the room of last time
    const linked = new URLSearchParams(location.search).get('room');
    let last = null;
    try { last = localStorage.getItem('halo-web-room'); } catch { /* none */ }
    if (linked || last) joinRoom(linked || last);
    showOnline(HaloNet.status());
  }

  // ---------- updates

  async function checkForUpdate() {
    try {
      const current = await (await fetch('version.json')).json();
      state.version = current.version;
      $('version').textContent = 'Build ' + current.version;
      const latest = await (await fetch('version.json?latest=1', { cache: 'no-store' })).json();
      if (latest.version && latest.version !== current.version && navigator.serviceWorker.controller) {
        const element = $('toast');
        element.innerHTML = '';
        element.append('A new version is available. ');
        const button = document.createElement('button');
        button.className = 'button';
        button.textContent = 'Update';
        button.onclick = () => {
          button.disabled = true;
          button.textContent = 'Updating…';
          navigator.serviceWorker.controller.postMessage('update');
        };
        element.append(button);
        element.hidden = false;
      }
    } catch { /* offline */ }
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data === 'updated') location.reload();
      if (event.data === 'update-failed') toast('The update could not be downloaded.');
    });
  }

  // ---------- start

  async function main() {
    window.addEventListener('error', (event) => {
      log(`error: ${event.message} (${event.filename}:${event.lineno})`);
      if (state.started) fatal(event.message || 'An error stopped the game.');
    });
    window.addEventListener('unhandledrejection', (event) => log('unhandled: ' + event.reason));
    window.addEventListener('resize', () => { if (state.shared) updateDisplaySize(); });
    document.addEventListener('visibilitychange', onVisibility);

    $('opt-touch').checked = settings.touch;
    $('opt-look').value = settings.look;
    $('opt-vsync').checked = settings.vsync;
    $('opt-touch').onchange = (event) => { settings.touch = event.target.checked; saveSettings(); };
    $('opt-layout').value = settings.touchLayout;
    $('opt-layout').onchange = (event) => { settings.touchLayout = event.target.value; saveSettings(); };
    $('opt-look').oninput = (event) => {
      settings.look = parseFloat(event.target.value);
      saveSettings();
      HaloInput.setLookSensitivity(settings.look);
    };
    $('opt-vsync').onchange = (event) => { settings.vsync = event.target.checked; saveSettings(); };
    $('opt-fps').checked = settings.showTiming;
    $('opt-fps').onchange = (event) => { settings.showTiming = event.target.checked; saveSettings(); };
    $('opt-silent').checked = settings.silentSound;
    $('opt-silent').onchange = (event) => { settings.silentSound = event.target.checked; saveSettings(); };
    $('opt-gldebug').checked = settings.glDebug;
    $('opt-gldebug').onchange = (event) => { settings.glDebug = event.target.checked; saveSettings(); };
    $('iso-file').onchange = onImageChosen;
    $('play').onclick = play;
    $('export-saves').onclick = exportSaves;
    $('delete-data').onclick = deleteData;
    $('show-log').onclick = async () => {
      $('log-text').textContent = await fullLog();
      $('log-view').hidden = false;
    };
    $('log-close').onclick = () => { $('log-view').hidden = true; };
    $('log-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(await fullLog()); toast('Copied.'); } catch { toast('Could not copy.'); }
    };
    $('fatal-reload').onclick = () => location.reload();
    $('fatal-log').onclick = async () => {
      try { await navigator.clipboard.writeText(await fullLog()); toast('Copied.'); } catch { toast('Could not copy.'); }
    };

    const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches ||
      matchMedia('(display-mode: fullscreen)').matches;
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    $('install-hint').hidden = standalone || !ios;
    // Android (Chrome, Edge, Samsung Internet): the browser's own install
    // prompt when it offers one, otherwise where to find it
    const android = /Android/i.test(navigator.userAgent);
    $('install-android').hidden = standalone || !android;
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      state.installPrompt = event;
      $('install-android').hidden = standalone;
      $('install-button').hidden = false;
      $('install-android-menu').hidden = true;
    });
    $('install-button').onclick = async () => {
      if (!state.installPrompt) return;
      state.installPrompt.prompt();
      const choice = await state.installPrompt.userChoice.catch(() => null);
      state.installPrompt = null;
      if (choice && choice.outcome === 'accepted') $('install-android').hidden = true;
    };
    window.addEventListener('appinstalled', () => { $('install-android').hidden = true; });

    watchControllers();
    await ensureIsolation();
    setUpOnline();
    const ok = await runChecks();
    if (!ok) return;
    await refreshGames();
    checkForUpdate();
  }

  main().catch((error) => {
    log('start: ' + (error && error.stack || error));
    addCheck(false, 'The page could not start: ' + error.message);
  });
})();
