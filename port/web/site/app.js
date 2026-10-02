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
    roomRules: null, // online: the room host's game rules (custom content)
    roomRulesFrom: '',
  };

  // ---------- settings (this browser's; nothing else depends on them)

  const coarsePointer = matchMedia('(pointer: coarse)').matches;
  const settings = { touch: coarsePointer, touchLayout: 'modern', look: 1.4, vsync: true, glDebug: false, showTiming: false, silentSound: true,
    touchCustom: {}, touchOpacity: 1, customRules: 0, customCharacter: 0, smallTextures: false,
    resolution: 'auto', sharpTextures: !coarsePointer };
  try {
    Object.assign(settings, JSON.parse(localStorage.getItem('halo-web-settings') || '{}'));
  } catch { /* private browsing: the defaults */ }
  // Smaller textures: on by itself where the graphics take no S3TC (most
  // Android phones: the game's textures are decoded, and big), unless chosen
  if (!settings.smallTexturesChosen) {
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      settings.smallTextures = !!gl && !gl.getExtension('WEBGL_compressed_texture_s3tc');
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch { /* the default */ }
  }

  function saveSettings() {
    try { localStorage.setItem('halo-web-settings', JSON.stringify(settings)); } catch { /* not kept */ }
  }

  // ---------- log

  // The page's log is also kept in this browser's storage as it grows, so
  // that when the tab dies (a phone closing it for memory, a hang and a
  // reload) the next visit's log still has what led up to it.
  const SESSION_LOG_KEY = 'halo-web-last-session';
  try {
    state.previousLog = localStorage.getItem(SESSION_LOG_KEY) || '';
  } catch { /* none */ }

  function saveSessionLog() {
    state.logSaveTimer = null;
    try {
      localStorage.setItem(SESSION_LOG_KEY, `${new Date().toISOString()} ${navigator.userAgent}\n` + state.log.slice(-400).join('\n'));
    } catch { /* not kept */ }
  }

  function log(line) {
    const text = String(line);
    state.log.push(text);
    if (state.log.length > 2000) state.log.splice(0, state.log.length - 2000);
    console.log(text);
    if (!state.logSaveTimer) state.logSaveTimer = setTimeout(saveSessionLog, 1000);
  }

  // the game's own log, debug.txt, in the chosen copy's folder: every run
  // adds to it, each starting with a line naming the build
  async function debugFolder() {
    let directory = await navigator.storage.getDirectory();
    const game = selectedGame();
    for (const name of (game && game.path) || []) directory = await directory.getDirectoryHandle(name);
    return directory;
  }

  async function debugText() {
    try {
      const file = await (await (await debugFolder()).getFileHandle('debug.txt')).getFile();
      return await file.text();
    } catch {
      return '';
    }
  }

  // where each run starts in debug.txt
  function debugRuns(text) {
    const starts = [];
    const pattern = /^[^\n]*halobeta xbox [^\n]*$/gm;
    let match;
    while ((match = pattern.exec(text))) starts.push(match.index);
    return starts;
  }

  // debug.txt keeps only its last few runs, so it does not grow for ever
  const DEBUG_RUNS_KEPT = 5;
  async function trimDebugLog() {
    const text = await debugText();
    const starts = debugRuns(text);
    if (starts.length > DEBUG_RUNS_KEPT || text.length > 400000) {
      let kept = text.slice(starts.length > DEBUG_RUNS_KEPT ? starts[starts.length - DEBUG_RUNS_KEPT] : 0);
      if (kept.length > 400000) kept = kept.slice(-400000);
      const game = selectedGame();
      await workerTask({ op: 'write-files', target: (game && game.path) || [],
        files: [{ path: ['debug.txt'], bytes: new TextEncoder().encode(kept) }] }).catch(() => {});
      return kept;
    }
    return text;
  }

  // The log of this run: the page's, and what the game wrote to debug.txt
  // since the page started (before the game has run, the last run's, which
  // is usually what a report is about). The whole log has every run kept.
  async function runLog() {
    const debug = await debugText();
    const parts = [`${navigator.userAgent}  ·  build ${state.version || '?'}`];
    if (state.started) {
      parts.push(`--- this run ---\n${state.log.join('\n')}`);
      const mine = debug.slice(Math.min(state.debugStart || 0, debug.length)).trim();
      if (mine) parts.push(`--- this run's debug.txt ---\n${mine}`);
    } else {
      parts.push(`--- this page ---\n${state.log.join('\n')}`);
      if (state.previousLog) parts.push(`--- the last run ---\n${state.previousLog}`);
      const starts = debugRuns(debug);
      const last = starts.length ? debug.slice(starts[starts.length - 1]).trim() : '';
      if (last) parts.push(`--- the last run's debug.txt ---\n${last}`);
    }
    return parts.join('\n\n');
  }

  async function fullLog() {
    const debug = await debugText();
    return `${navigator.userAgent}  ·  build ${state.version || '?'}\n\n--- page and console ---\n${state.log.join('\n')}` +
      (state.previousLog ? `\n\n--- the session before this one ---\n${state.previousLog}` : '') +
      (debug ? `\n\n--- debug.txt (the last ${DEBUG_RUNS_KEPT} runs) ---\n${debug}` : '');
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
    // Open games compares rooms' maps with the chosen copy's
    if (window.HaloLobby && state.lobbyStarted) {
      HaloLobby.mapsFingerprint(chosen).then((maps) => { state.lobbyMaps = maps; renderLobby(HaloLobby.rooms()); });
    }
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

  // the game's caches of maps: z:\cacheNNN.map, and the campaign level the
  // characters in multiplayer come from (z:\characters-b30.map), and Blood
  // Gulch lending its multiplayer to a campaign level (z:\arena-bloodgulch.map)
  const MAP_CACHE = /^save\/z\/(cache\d+|characters-\w+|arena-\w+)\.map(\.part)?$/i;

  async function exportSaves() {
    const files = [];
    async function walk(directory, prefix) {
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind === 'directory') await walk(handle, prefix + name + '/');
        // not the game's caches of maps (hundreds of MB), which it builds
        // again from the maps
        else if (!MAP_CACHE.test(prefix + name)) {
          files.push({ name: prefix + name, bytes: new Uint8Array(await (await handle.getFile()).arrayBuffer()) });
        }
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

  // ---------- restoring saved games: a .zip from Export saved games (or any
  // .zip holding a save folder), into the chosen copy of the game

  async function unzip(file) {
    const data = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(data.buffer);
    let end = -1;
    for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error('This is not a .zip file.');
    const count = view.getUint16(end + 10, true);
    let entry = view.getUint32(end + 16, true);
    const files = [];
    for (let n = 0; n < count; n++) {
      if (view.getUint32(entry, true) !== 0x02014b50) throw new Error('The .zip file is damaged.');
      const method = view.getUint16(entry + 10, true);
      const compressed = view.getUint32(entry + 20, true);
      const nameLength = view.getUint16(entry + 28, true);
      const extraLength = view.getUint16(entry + 30, true);
      const commentLength = view.getUint16(entry + 32, true);
      const local = view.getUint32(entry + 42, true);
      const name = new TextDecoder().decode(data.subarray(entry + 46, entry + 46 + nameLength));
      entry += 46 + nameLength + extraLength + commentLength;
      if (name.endsWith('/')) continue;
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      let bytes = data.subarray(start, start + compressed);
      if (method === 8) {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      } else if (method !== 0) {
        throw new Error(`${name} is compressed in a way this page cannot read.`);
      }
      files.push({ name, bytes });
    }
    return files;
  }

  async function onSavesChosen(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    const game = selectedGame();
    if (!file || !game) return;
    try {
      const entries = await unzip(file);
      // the save folder wherever it is in the .zip (halo-saves.zip has it at
      // the top), and config.toml beside it
      const files = [];
      for (const { name, bytes } of entries) {
        const parts = name.split('/').filter((part) => part && part !== '.' && part !== '..');
        const at = parts.indexOf('save');
        if (at >= 0 && parts.length > at + 1) {
          if (!MAP_CACHE.test(parts.slice(at).join('/'))) files.push({ path: parts.slice(at), bytes });
        }
        else if (parts[parts.length - 1] === 'config.toml') files.push({ path: ['config.toml'], bytes });
      }
      if (!files.some((f) => f.path[0] === 'save')) throw new Error('The .zip file has no save folder in it.');
      if (!confirm(`Restore ${files.length} files into ${game.name}? Saved games with the same names are replaced.`)) return;
      await workerTask({ op: 'write-files', target: game.path, files });
      toast(`Restored ${files.length} files into ${game.name}.`);
      log(`restored ${files.length} files from ${file.name}`);
    } catch (error) {
      toast('Cannot restore the saved games: ' + error.message, 6000);
      log('restore: ' + error);
    }
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

  // ---------- the touch layout editor and the in-game menu

  function openLayoutEditor(layout, then) {
    const editor = $('layout-editor');
    editor.hidden = false;
    const custom = (settings.touchCustom || {})[layout] || {};
    HaloInput.editTouchLayout(editor, layout, custom, settings.touchOpacity, (places, opacity) => {
      editor.hidden = true;
      settings.touchCustom = { ...(settings.touchCustom || {}), [layout]: places };
      settings.touchOpacity = opacity;
      saveSettings();
      if (then) then();
    });
  }

  function applyTouchLayout() {
    HaloInput.setTouchLayout(settings.touchLayout, (settings.touchCustom || {})[settings.touchLayout], settings.touchOpacity);
  }

  function openGameMenu() {
    $('menu-look').value = settings.look;
    $('menu-coop-row').hidden = !HaloNet.status().room;
    $('menu-coop').checked = HaloCoop.hosting;
    renderCoop();
    $('menu-layout').value = settings.touchLayout;
    $('menu-layout-row').hidden = !HaloInput.isTouchEnabled();
    $('menu-silent').checked = settings.silentSound;
    $('menu-fps').checked = !$('fps').hidden;
    const games = $('menu-game');
    games.textContent = '';
    const current = selectedGame();
    for (const game of state.games) {
      const option = document.createElement('option');
      option.value = game.id;
      option.textContent = game.name;
      option.selected = !!(current && current.id === game.id);
      games.appendChild(option);
    }
    $('menu-game-row').hidden = state.games.length < 2;
    $('game-menu').hidden = false;
  }

  function closeGameMenu() {
    $('game-menu').hidden = true;
  }

  function setUpGameMenu() {
    $('menu-button').hidden = false;
    $('menu-button').onclick = openGameMenu;
    $('menu-resume').onclick = closeGameMenu;
    $('menu-coop').onchange = (event) => HaloCoop.setHosting(event.target.checked);
    $('menu-custom').onclick = () => {
      closeGameMenu();
      openCustom();
    };
    $('game-menu').addEventListener('click', (event) => { if (event.target === $('game-menu')) closeGameMenu(); });
    $('menu-look').oninput = (event) => {
      settings.look = parseFloat(event.target.value);
      saveSettings();
      HaloInput.setLookSensitivity(settings.look);
    };
    $('menu-layout').onchange = (event) => {
      settings.touchLayout = event.target.value;
      saveSettings();
      applyTouchLayout();
    };
    $('menu-edit-layout').onclick = () => {
      closeGameMenu();
      openLayoutEditor(settings.touchLayout, applyTouchLayout);
    };
    $('menu-silent').onchange = (event) => setSilentSound(event.target.checked);
    $('menu-fps').onchange = (event) => {
      settings.showTiming = event.target.checked;
      saveSettings();
      if (event.target.checked) showFrameRate();
      else $('fps').hidden = true;
    };
    $('menu-switch-game').onclick = () => {
      settings.game = $('menu-game').value;
      saveSettings();
      location.reload();
    };
    $('menu-quit').onclick = () => location.reload();
    $('menu-copy-log').onclick = async () => {
      try { await navigator.clipboard.writeText(await runLog()); toast('The log is copied.'); } catch { toast('Could not copy the log.'); }
    };
  }

  // ---------- the start page's background: a frame of the player's own
  // game (its main menu, the first time it runs), kept in this site's storage
  // on this device; until there is one, a starfield and a ring of its own

  const BACKDROP_FILE = 'launcher-background.jpg';
  // about 12 s into the first game, on the main menu (tests set it sooner)
  const BACKDROP_FRAME = window.__haloBackdropFrame || 720;

  async function showBackdrop() {
    try {
      const root = await navigator.storage.getDirectory();
      const file = await (await root.getFileHandle(BACKDROP_FILE)).getFile();
      if (!file.size) return;
      state.hasBackdrop = true;
      const url = URL.createObjectURL(file);
      $('backdrop').style.backgroundImage = `url("${url}")`;
      document.body.classList.add('has-backdrop');
    } catch { /* none yet */ }
  }

  function captureBackdrop(bitmap) {
    try {
      const copy = new OffscreenCanvas(bitmap.width, bitmap.height);
      copy.getContext('2d').drawImage(bitmap, 0, 0);
      state.hasBackdrop = true;
      copy.convertToBlob({ type: 'image/jpeg', quality: 0.82 }).then(async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await workerTask({ op: 'write-files', target: [], files: [{ path: [BACKDROP_FILE], bytes }] });
        log('start page background saved');
      }).catch((error) => log('background: ' + error));
    } catch (error) {
      log('background: ' + error);
    }
  }

  // ---------- the welcome: on the first visit to the site (not in the
  // installed app), a button to install it on each kind of phone. Android's
  // browsers install a site when asked (beforeinstallprompt); iOS lets only
  // the person do it, from the Share sheet, so its button shows how.

  const WELCOMED_KEY = 'halo-web-welcomed';

  function setUpWelcome({ standalone, ios, android }) {
    const welcome = $('welcome');
    const sheets = { ios: $('sheet-ios'), droid: $('sheet-droid') };
    const openSheet = (which) => {
      welcome.hidden = false;
      for (const key in sheets) sheets[key].hidden = key !== which;
      welcome.classList.add('sheet-open');
    };
    const closeSheets = () => {
      for (const key in sheets) sheets[key].hidden = true;
      welcome.classList.remove('sheet-open');
    };
    const installAndroid = async () => {
      if (state.installPrompt) {
        state.installPrompt.prompt();
        const choice = await state.installPrompt.userChoice.catch(() => null);
        state.installPrompt = null;
        if (choice && choice.outcome === 'accepted') {
          $('install-android').hidden = true;
          toast('Installing. Open Halo CE from your home screen.', 6000);
          return;
        }
      }
      openSheet('droid');
    };
    for (const key in sheets) {
      sheets[key].querySelector('[data-close]').onclick = () => {
        closeSheets();
        if (welcome.dataset.from === 'launcher') welcome.hidden = true;
      };
    }
    $('install-ios').onclick = () => openSheet('ios');
    $('install-droid').onclick = installAndroid;
    $('welcome-skip').onclick = () => {
      try { localStorage.setItem(WELCOMED_KEY, '1'); } catch { /* private mode */ }
      welcome.hidden = true;
      closeSheets();
    };
    // the launcher's own hints open the same guides
    $('install-hint-how').onclick = () => { welcome.dataset.from = 'launcher'; openSheet('ios'); };
    $('install-android-how').onclick = () => { welcome.dataset.from = 'launcher'; openSheet('droid'); };
    // the button for this phone first
    if (android) $('install-droid').classList.add('primary');
    else $('install-ios').classList.add('primary');
    const buttons = welcome.querySelector('.install-buttons');
    if (android) buttons.prepend($('install-droid'));
    let welcomed = false;
    try { welcomed = localStorage.getItem(WELCOMED_KEY) === '1'; } catch { /* private mode */ }
    welcome.hidden = standalone || welcomed || !!window.__haloArgs;
    welcome.dataset.from = 'first';
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

  // Settings, Resolution: how many lines of pixels the game draws. The game
  // lays itself out in 480 lines in the shape of the screen (src/web_main.c);
  // more lines draw each of them with more pixels (d3d8_gl.c
  // screen_mode_choose). Phones keep 480: every frame goes from the game's
  // thread to the page, and their graphics memory is small. Computers and
  // Macs get their screen's own resolution, up to 1080 lines.
  function renderLines() {
    // (captures of the start page's art draw more lines: window.__haloLines)
    if (window.__haloLines) return window.__haloLines;
    const short = Math.max(1, Math.min(window.innerWidth, window.innerHeight));
    const native = Math.round(short * (window.devicePixelRatio || 1));
    let lines;
    if (settings.resolution === 'native') lines = native;
    else if (settings.resolution === 'auto') lines = coarsePointer || settings.smallTextures ? 480 : Math.min(native, 1080);
    else lines = Number(settings.resolution) || 480;
    return Math.max(480, Math.min(2160, lines)) & ~1;
  }

  function landscapeSize() {
    // The canvas is the size the game draws: the page scales it to the screen.
    const long = Math.max(window.innerWidth, window.innerHeight);
    const short = Math.max(1, Math.min(window.innerWidth, window.innerHeight));
    const height = renderLines();
    const width = Math.min(Math.round(height * long / short), Math.max(1440, height * 3));
    return { width: width & ~1, height };
  }

  function sharedWord(name) {
    return (state.shared + state.offsets[name]) >> 2;
  }

  function readOffsets(module) {
    const pointer = module._web_shared_offsets();
    const words = new Int32Array(state.memory.buffer, pointer, 37);
    const names = ['size', 'eventWrite', 'eventRead', 'events', 'eventSize', 'gamepads', 'gamepadSize',
      'displayWidth', 'displayHeight', 'frameCounter', 'framesPresented', 'vsync', 'audioRate', 'audioOpen',
      'audioWrite', 'audioRead', 'audioUnderruns', 'audioRing', 'audioRingFrames', 'pageHidden', 'gameStarted',
      'eventCapacity', 'gamepadCount', 'netLocalAddress', 'netOutWrite', 'netOutRead', 'netInWrite', 'netInRead',
      'netOut', 'netOutBytes', 'netIn', 'netInBytes', 'customRules', 'customCharacter', 'customCharacterStatus', 'splitViews', 'coopFullViews'];
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
    // remote co-op: each player's view on a whole screen while one watches
    i32[sharedWord('coopFullViews')] = HaloCoop.fullViews() ? 1 : 0;
    Atomics.add(i32, sharedWord('frameCounter'), 1);
    Atomics.notify(i32, sharedWord('frameCounter'));
    HaloInput.pollGamepads();
    requestAnimationFrame(animationFrame);
  }

  // Settings: "Show the frame rate": frames shown each second, and how many
  // animation frames the page had in that second
  function showFrameRate() {
    const view = $('fps');
    view.hidden = false;
    if (state.frameRateTimer) return;
    let frames = 0, ticks = 0, last = performance.now();
    const tick = () => { ticks++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    state.frameRateTimer = setInterval(() => {
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

  function setSilentSound(on) {
    settings.silentSound = on;
    saveSettings();
    if (on) {
      if (state.silentAudio) state.silentAudio.play().catch(() => {});
      else playThroughSilentSwitch();
    } else {
      try { if (navigator.audioSession) navigator.audioSession.type = 'auto'; } catch { /* not settable */ }
      if (state.silentAudio) state.silentAudio.pause();
    }
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
      state.audioNode = node; // (remote co-op streams it too)
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
      if (!$('custom').hidden) closeCustom();
      else if (!$('chat').hidden) closeChat();
      else if (!$('game-menu').hidden) closeGameMenu();
      else if ($('layout-editor').hidden) HaloInput.pressBack();
      history.pushState({ playing: true }, '');
    });
    setUpGameMenu();

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
    if (settings.smallTextures) argumentsList.push('--HALO_WEB_SMALL_TEXTURES=1');
    // sharper textures on floors and walls seen at an angle
    if (settings.sharpTextures) argumentsList.push('--HALO_WEB_ANISOTROPY=16');
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
        if (state.presented === BACKDROP_FRAME && !state.hasBackdrop) captureBackdrop(bitmap);
        // remote co-op: player 2's part of the frame, to their device
        if (HaloCoop.streaming) HaloCoop.frame(bitmap);
        context.transferFromImageBitmap(bitmap);
        state.presented = (state.presented || 0) + 1;
      },
      // remote co-op: the second player's own view, for their device
      haloPresentView: (bitmap) => HaloCoop.viewFrame(bitmap),
      haloMessage: (kind, text) => {
        if (kind === 0) log('game: ' + text);
        else if (kind === 1) toast(text, Math.max(5000, text.length * 90)); // (long notes stay up longer)
        else if (kind === 2) log('clipboard: ' + text);
        else if (kind === 4) log('thread error: ' + text);
        else if (kind === 6) state.timing = text;
        else if (kind === 7) state.glTiming = text;
        else if (kind === 3 && /graphics context was lost/.test(text)) {
          // next time, textures that need less graphics memory
          settings.smallTextures = true;
          settings.smallTexturesChosen = true;
          // and the lines of a phone
          settings.resolution = 'auto';
          saveSettings();
          fatal(text);
        }
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
          touchCustom: (settings.touchCustom || {})[settings.touchLayout],
          touchOpacity: settings.touchOpacity,
        });
        HaloInput.setLookSensitivity(settings.look);
        HaloInput.onController((name, connected) => {
          toast(connected ? `Controller connected: ${name}` : 'Controller disconnected', 2500);
        });
        HaloNet.attach({ memory: state.memory, base: state.shared, offsets: state.offsets });
        applyCustom();
        $('touch').hidden = !settings.touch;
        requestAnimationFrame(animationFrame);
        // controllers are also read between animation frames, so a press
        // shorter than a frame still counts
        setInterval(() => HaloInput.pollGamepads(), 8);
        if (settings.showTiming) showFrameRate();
        startAudio();
        log('runtime ready');
        // every ten seconds, how the game is doing (in the log kept across a
        // crash: a game that stopped drawing shows as frames that stopped)
        let lastPresented = 0;
        setInterval(() => {
          const i32 = new Int32Array(state.memory.buffer);
          const game = Atomics.load(i32, sharedWord('framesPresented'));
          log(`heartbeat: ${game - lastPresented} frames from the game in 10 s (${state.presented || 0} shown)` +
            (document.hidden ? ', page hidden' : '') + (state.timing ? ` · ${state.timing}` : ''));
          lastPresented = game;
        }, 10000);
      },
    };

    const script = document.createElement('script');
    script.src = 'halo.js';
    script.onerror = () => fatal('Could not load halo.js.');
    document.body.appendChild(script);
  }

  // ---------- custom content (port/linux/game/custom_content.c): game rules
  // and the character to play as, which the game reads from the shared state
  // each frame. Online, the room's host's rules are everyone's.

  const RULE_NAMES = { 1: 'Infinite ammo', 2: 'Low gravity', 4: 'Speed boost', 8: 'Super jump', 16: 'Big heads',
    32: 'One-shot kills', 64: 'Invincible', 128: 'Third-person camera',
    256: 'Master Chief only' };
  // the characters multiplayer has (brought in from a campaign level:
  // port/linux/game/custom_characters.c)
  const MULTIPLAYER_CHARACTERS = [2, 3, 5, 6];
  const CHARACTER_NAMES = ['', 'Master Chief', 'Marine', 'Grunt', 'Jackal', 'Elite', 'Hunter', 'Flood combat form',
    'Flood Elite', 'Infection form', 'Sentinel', '343 Guilty Spark', 'Captain Keyes'];

  // following the host's rules: in a room someone else hosts, once they are heard
  function followingHost() {
    return state.roomRules !== null && state.onlineRole !== 'host' && !!HaloNet.status().room;
  }

  function effectiveRules() {
    const mine = settings.customRules | 0;
    if (!followingHost()) return mine;
    return (state.roomRules & HaloNet.RULES_MASK) | (mine & ~HaloNet.RULES_MASK);
  }

  function characterStatus() {
    if (!state.shared) return 0;
    return Atomics.load(new Int32Array(state.memory.buffer), sharedWord('customCharacterStatus'));
  }

  function renderCustom() {
    const rules = effectiveRules();
    const following = followingHost();
    for (const box of document.querySelectorAll('#custom [data-rule]')) {
      const bit = Number(box.dataset.rule);
      const shared = (bit & HaloNet.RULES_MASK) !== 0;
      box.checked = (rules & bit) !== 0;
      box.disabled = following && shared;
      box.closest('label').classList.toggle('locked', box.disabled);
    }
    const host = $('custom-host');
    host.hidden = !following;
    host.textContent = following ? `You play by ${state.roomRulesFrom || 'the host'}'s rules (the room's host).` : '';
    $('custom-character').value = String(settings.customCharacter | 0);
    const status = $('custom-character-status');
    const character = settings.customCharacter | 0;
    const code = characterStatus();
    status.className = 'small';
    if (!character) status.textContent = '';
    else if (!state.started) status.textContent = MULTIPLAYER_CHARACTERS.includes(character) ?
      `You'll play as the ${CHARACTER_NAMES[character]} in the campaign wherever the level has one, and in multiplayer.` :
      `You'll play as the ${CHARACTER_NAMES[character]} wherever the level has one (in the campaign).`;
    else if (code === 1) {
      status.textContent = `Playing as the ${CHARACTER_NAMES[character]}.`;
      status.classList.add('on');
    } else if (code === 2) {
      status.textContent = `This level has no ${CHARACTER_NAMES[character]}: you're the Master Chief here.`;
      status.classList.add('off');
    } else status.textContent = MULTIPLAYER_CHARACTERS.includes(character) ?
      `You'll play as the ${CHARACTER_NAMES[character]} in the campaign wherever the level has one, and in multiplayer from your next spawn.` :
      `You'll play as the ${CHARACTER_NAMES[character]} in the campaign, wherever the level has one.`;

    // the start page's line
    const names = Object.keys(RULE_NAMES).map(Number).filter((bit) => rules & bit).map((bit) => RULE_NAMES[bit]);
    if (character) names.push(`Play as ${CHARACTER_NAMES[character]}`);
    const summary = $('custom-summary');
    summary.textContent = names.length ? names.join(' · ') + (following ? ' (the room host\'s rules)' : '') :
      'Off: the game as it shipped.';
    summary.classList.toggle('on', names.length > 0);
  }

  function applyCustom() {
    HaloNet.setRules(settings.customRules | 0, state.onlineRole === 'host');
    if (state.shared) {
      const i32 = new Int32Array(state.memory.buffer);
      Atomics.store(i32, sharedWord('customRules'), effectiveRules());
      Atomics.store(i32, sharedWord('customCharacter'), settings.customCharacter | 0);
    }
    renderCustom();
  }

  function openCustom() {
    renderCustom();
    $('custom').hidden = false;
    // (the game's answer about the character comes a frame or so later)
    clearInterval(state.customTimer);
    state.customTimer = setInterval(renderCustom, 500);
  }

  function closeCustom() {
    $('custom').hidden = true;
    clearInterval(state.customTimer);
  }

  function setUpCustom() {
    for (const box of document.querySelectorAll('#custom [data-rule]')) {
      box.onchange = () => {
        const bit = Number(box.dataset.rule);
        settings.customRules = box.checked ? (settings.customRules | bit) : (settings.customRules & ~bit);
        saveSettings();
        applyCustom();
      };
    }
    $('custom-character').onchange = (event) => {
      settings.customCharacter = parseInt(event.target.value, 10) || 0;
      saveSettings();
      applyCustom();
    };
    $('custom-open').onclick = openCustom;
    $('custom-close').onclick = closeCustom;
    HaloNet.on((type, detail) => {
      if (type === 'rules') {
        const changed = state.roomRules !== detail.rules;
        state.roomRules = detail.rules;
        state.roomRulesFrom = detail.name;
        applyCustom();
        if (changed && followingHost() && state.started) {
          const names = Object.keys(RULE_NAMES).map(Number).filter((bit) => detail.rules & bit).map((bit) => RULE_NAMES[bit]);
          toast(`${detail.name}'s rules: ${names.length ? names.join(', ') : 'none'}`);
        }
      } else if (type === 'status' && !detail.room && state.roomRules !== null) {
        state.roomRules = null;
        applyCustom();
      }
    });
    applyCustom();
  }

  // ---------- remote co-op (coop.js): a friend in the room plays the host's
  // game as player 2 from their own device

  state.coopHosts = new Map(); // id -> { name, busy, seen }: the room's co-op hosts

  function renderCoop() {
    const status = HaloCoop.hostStatus();
    let text = '';
    if (status.enabled) {
      if (status.guest && status.connected) text = `${status.guest} is player 2` + (status.rtt !== null ? ` (${status.rtt} ms)` : '') + '.';
      else if (status.guest) text = `${status.guest} is joining…`;
      else text = 'Waiting for a friend in the room to join as player 2.';
    }
    for (const id of ['coop-status', 'menu-coop-status']) {
      $(id).textContent = text;
      $(id).hidden = !text;
    }
    $('coop-host').checked = status.enabled;
    const list = $('coop-hosts');
    list.textContent = '';
    const now = Date.now();
    for (const [id, host] of state.coopHosts) {
      if (now - host.seen > 10000) {
        state.coopHosts.delete(id);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button primary';
      button.textContent = host.busy ? `${host.name}'s co-op is full` : `Join ${host.name}'s game as player 2`;
      button.disabled = host.busy || state.started;
      button.onclick = () => joinCoop(id, host.name);
      list.appendChild(button);
    }
  }

  // the friend's side: the host's game on this screen, and this device's controls
  function joinCoop(id, name) {
    state.coopGuest = true;
    document.body.classList.add('playing', 'coop-guest');
    $('coop-view').hidden = false;
    const root = document.documentElement;
    if (root.requestFullscreen && !navigator.standalone) root.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
    requestWakeLock();
    const video = $('coop-video');
    HaloInput.attachLocal({
      surface: video,
      touchRoot: $('touch'),
      touch: settings.touch,
      touchLayout: settings.touchLayout,
      touchCustom: (settings.touchCustom || {})[settings.touchLayout],
      touchOpacity: settings.touchOpacity,
    });
    HaloInput.setLookSensitivity(settings.look);
    $('touch').hidden = !settings.touch;
    $('coop-part').onchange = (event) => HaloCoop.setView(event.target.value);
    $('coop-leave').onclick = () => {
      HaloCoop.leave();
      location.reload();
    };
    $('coop-friend-status').textContent = `Joining ${name}'s game…`;
    HaloCoop.join(id, name, video);
  }

  function setUpCoop() {
    HaloCoop.configure({
      audio: () => ({ context: state.audio, node: state.audioNode }),
      splitViews: () => (state.shared ? Atomics.load(new Int32Array(state.memory.buffer), sharedWord('splitViews')) : 0),
    });
    $('coop-host').onchange = (event) => HaloCoop.setHosting(event.target.checked);
    HaloCoop.on((type, detail) => {
      if (type === 'host') renderCoop();
      else if (type === 'message') toast(detail);
      else if (type === 'friend') {
        const line = $('coop-friend-status');
        if (detail.state === 'playing') {
          line.textContent = `Player 2 in ${detail.host}'s game` + (detail.rtt !== undefined ? ` · ${detail.rtt} ms` : '');
        } else if (detail.state === 'failed' || detail.state === 'ended') {
          line.textContent = detail.reason;
          toast(detail.reason, 6000);
        }
      }
    });
    HaloNet.on((type, detail) => {
      if (type === 'coop-host') {
        if (detail.coop) state.coopHosts.set(detail.id, { name: detail.name, busy: detail.coop.busy, seen: Date.now() });
        else state.coopHosts.delete(detail.id);
        renderCoop();
      } else if (type === 'status' && !detail.room) {
        state.coopHosts.clear();
        if (HaloCoop.hosting) HaloCoop.setHosting(false);
        renderCoop();
      }
    });
    setInterval(renderCoop, 5000);
    renderCoop();
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
    if (!inRoom) {
      setRole(null);
      return;
    }
    $('online-code').textContent = status.room;
    const players = status.players === 1 ? '1 other player' : `${status.players} other players`;
    $('online-status').textContent = status.brokers ? `Connected: ${players} in the room.` :
      'Looking for the room… (checking the connection)';
    $('online-names').textContent = status.names.length ? status.names.join(', ') : '';
    $('online-public').checked = HaloLobby.isListing();
    $('online-note-row').hidden = !HaloLobby.isListing();
  }

  async function joinRoom(code) {
    try {
      const joined = await HaloNet.join(code, onlineOptions());
      try { localStorage.setItem('halo-web-room', joined); } catch { /* not kept */ }
      // a room listed from this page stays listed only while in it
      if (HaloLobby.isListing() && state.listedCode !== joined) await unlistRoom();
      return joined;
    } catch (error) {
      toast(error.message);
      return null;
    }
  }

  // ---------- text chat: to everyone in the room (net.js sendChat), in a
  // panel opened from the in-game menu or the room, with new messages shown
  // over the game for a few seconds

  const QUICK_CHAT = ['GG', 'Nice shot!', 'Need backup', 'On my way', 'Ready?', 'One more?'];
  const chat = { messages: [], unread: 0 };

  function chatLine(message) {
    const line = document.createElement('div');
    line.className = 'chat-line' + (message.self ? ' self' : '');
    const who = document.createElement('b');
    who.textContent = message.self ? 'You' : message.name;
    line.append(who, document.createTextNode(message.text));
    return line;
  }

  function renderChatLog() {
    const log = $('chat-log');
    log.textContent = '';
    if (!chat.messages.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = HaloNet.status().room ? 'No messages yet. Say hi!' : 'Join a room (Play online) to chat with its players.';
      log.appendChild(empty);
    }
    for (const message of chat.messages) log.appendChild(chatLine(message));
    log.scrollTop = log.scrollHeight;
    const status = HaloNet.status();
    $('chat-room').textContent = status.room ? `Room ${status.room} · ${status.players + 1} in the room` : 'Not in a room';
  }

  // the chat button under the menu button, while the player is in a room
  // (the menu button shows the unread count when it is not there)
  function showChatButton() {
    const inRoom = !!HaloNet.status().room;
    if ($('chat-button').hidden === inRoom) {
      $('chat-button').hidden = !inRoom;
      showUnread();
    }
  }

  function showUnread() {
    const text = chat.unread > 9 ? '9+' : String(chat.unread);
    const onChatButton = !$('chat-button').hidden;
    $('chat-button-unread').hidden = chat.unread === 0 || !onChatButton;
    $('chat-button-unread').textContent = text;
    const badge = $('chat-unread');
    badge.hidden = chat.unread === 0 || onChatButton;
    badge.textContent = text;
    $('online-chat').textContent = chat.unread ? `Chat (${chat.unread})` : 'Chat';
  }

  function feedLine(message) {
    const feed = $('chat-feed');
    const line = chatLine(message);
    feed.appendChild(line);
    while (feed.children.length > 4) feed.firstChild.remove();
    setTimeout(() => line.classList.add('fading'), 6000);
    setTimeout(() => line.remove(), 6800);
  }

  function onChat(message) {
    chat.messages.push(message);
    if (chat.messages.length > 100) chat.messages.shift();
    if (!$('chat').hidden) {
      renderChatLog();
      return;
    }
    if (!message.self) {
      chat.unread++;
      showUnread();
      if (state.started) feedLine(message);
      else toast(`${message.name}: ${message.text}`, 4000);
    }
  }

  function openChat() {
    $('chat').hidden = false;
    chat.unread = 0;
    showUnread();
    renderChatLog();
    // (a touch screen's keyboard opens only when the field is tapped)
    if (!matchMedia('(pointer: coarse)').matches) $('chat-input').focus();
  }

  function closeChat() {
    $('chat').hidden = true;
    $('chat-input').blur();
  }

  async function sendChat(text) {
    if (!HaloNet.status().room) {
      toast('Join a room (Play online) to chat.');
      return false;
    }
    return HaloNet.sendChat(text);
  }

  function setUpChat() {
    HaloNet.on((type, detail) => { if (type === 'chat') onChat(detail); });
    $('chat-close').onclick = closeChat;
    $('online-chat').onclick = openChat;
    $('menu-chat').onclick = () => { closeGameMenu(); openChat(); };
    $('chat-button').onclick = () => { if ($('chat').hidden) openChat(); else closeChat(); };
    showChatButton();
    setInterval(showChatButton, 1000);
    $('chat-form').onsubmit = async (event) => {
      event.preventDefault();
      const input = $('chat-input');
      if (await sendChat(input.value)) input.value = '';
    };
    const quick = $('chat-quick');
    for (const text of QUICK_CHAT) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button';
      button.textContent = text;
      button.onclick = () => sendChat(text);
      quick.appendChild(button);
    }
  }

  // ---------- matchmaking (lobby.js): public rooms, Open games, Quick Match

  const LISTED_KEY = 'halo-web-listed';

  function playerName() {
    try { return localStorage.getItem('halo-web-player-name') || 'Player'; } catch { return 'Player'; }
  }

  async function mapsFingerprint() {
    return HaloLobby.mapsFingerprint(selectedGame());
  }

  function mapsLabel(game) {
    if (!game) return '';
    const names = (game.files || []).map((name) => name.toLowerCase());
    const campaign = CAMPAIGN_MAPS.some((name) => names.includes(name));
    return `${campaign ? 'Full game' : 'Multiplayer disc'} · ${names.length} maps`;
  }

  async function listRoom(code) {
    const maps = await mapsFingerprint();
    const game = selectedGame();
    state.listedCode = code;
    try { localStorage.setItem(LISTED_KEY, code); } catch { /* not kept */ }
    await HaloLobby.advertise(code, () => ({
      code,
      host: playerName(),
      players: (HaloNet.status().players || 0) + 1,
      maps,
      mapsLabel: mapsLabel(game),
      note: $('online-note').value,
    }));
    showOnline(HaloNet.status());
  }

  async function unlistRoom() {
    state.listedCode = null;
    try { localStorage.removeItem(LISTED_KEY); } catch { /* not kept */ }
    await HaloLobby.withdraw();
    showOnline(HaloNet.status());
  }

  function setRole(role, host) {
    state.onlineRole = role;
    if (role === 'host') state.roomRules = null;
    applyCustom();
    const hint = $('online-role');
    if (role === 'host') {
      hint.textContent = 'You host: in Halo, go to Multiplayer, then System Link, and start a game. Everyone in this room sees it there.';
    } else if (role === 'guest') {
      hint.textContent = `You joined ${host}'s room: in Halo, go to Multiplayer, then System Link, and join ${host}'s game.`;
    }
    hint.hidden = !role;
  }

  function renderLobby(rooms) {
    const list = $('lobby-list');
    list.textContent = '';
    const current = HaloNet.status().room;
    const mine = state.lobbyMaps;
    for (const room of rooms) {
      const row = document.createElement('div');
      const sameMaps = !mine || !room.maps || room.maps === mine;
      const here = room.code === current;
      row.className = 'lobby-room' + (sameMaps ? '' : ' other-maps') + (here ? ' mine' : '');
      const who = document.createElement('span');
      who.className = 'who';
      const title = document.createElement('strong');
      title.textContent = `${room.host}'s game`;
      const detail = document.createElement('small');
      detail.textContent = [room.mapsLabel, sameMaps ? '' : 'different maps from yours', room.note].filter(Boolean).join(' · ');
      who.append(title, detail);
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `${room.players}/${HaloLobby.MAX_PLAYERS}`;
      const join = document.createElement('button');
      join.type = 'button';
      join.className = 'button small-button';
      join.textContent = here ? 'Joined' : room.players >= HaloLobby.MAX_PLAYERS ? 'Full' : 'Join';
      join.disabled = here || room.players >= HaloLobby.MAX_PLAYERS;
      join.onclick = async () => {
        if (!sameMaps && !confirm(`${room.host}'s game uses different maps from yours, so you may not be able to play together. Join anyway?`)) return;
        if (await joinRoom(room.code)) setRole('guest', room.host);
      };
      row.append(who, count, join);
      list.appendChild(row);
    }
    $('lobby-empty').hidden = rooms.length > 0;
    $('lobby-count').textContent = rooms.length ? `(${rooms.length})` : '';
  }

  async function quickMatch() {
    if (!selectedGame()) {
      toast('Add a disc image first (Game data).');
      return;
    }
    const button = $('quick-match');
    button.disabled = true;
    button.textContent = 'Searching…';
    try {
      // the open games arrive a moment after the page connects
      const waited = Date.now() - state.lobbyStarted;
      if (waited < 3500) await new Promise((resolve) => setTimeout(resolve, 3500 - waited));
      const maps = await mapsFingerprint();
      const current = HaloNet.status().room;
      const open = HaloLobby.rooms().filter((room) => room.maps === maps && room.code !== current &&
        room.players < HaloLobby.MAX_PLAYERS);
      if (open.length) {
        const room = open[0];
        if (await joinRoom(room.code)) {
          setRole('guest', room.host);
          toast(`Joined ${room.host}'s game.`);
        }
      } else {
        const code = await joinRoom(HaloNet.newRoomCode());
        if (code) {
          await listRoom(code);
          setRole('host');
          toast('No open games with your maps: you opened one. Others can find it in Open games.', 5000);
        }
      }
    } finally {
      button.disabled = false;
      button.textContent = 'Quick Match';
    }
  }

  async function setUpLobby() {
    state.lobbyStarted = Date.now();
    state.lobbyMaps = await mapsFingerprint();
    HaloLobby.on(renderLobby);
    HaloLobby.start(onlineOptions());
    renderLobby(HaloLobby.rooms());
    $('quick-match').onclick = quickMatch;
    $('online-public').onchange = async (event) => {
      const code = HaloNet.status().room;
      if (event.target.checked && code) await listRoom(code);
      else await unlistRoom();
    };
    $('online-note').onchange = () => HaloLobby.refresh();
    // the player count of a listed room follows the room
    HaloNet.on((type) => { if (type === 'joined' || type === 'left') HaloLobby.refresh(); });
    // a room listed before the page was reloaded is listed again
    let listed = null;
    try { listed = localStorage.getItem(LISTED_KEY); } catch { /* none */ }
    if (listed && HaloNet.status().room === listed) {
      await listRoom(listed);
      setRole('host');
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
    $('online-create').onclick = async () => { if (await joinRoom(HaloNet.newRoomCode())) setRole('host'); };
    $('online-enter').onclick = () => joinRoom($('online-input').value);
    $('online-input').onkeydown = (event) => { if (event.key === 'Enter') joinRoom(event.target.value); };
    $('online-leave').onclick = async () => {
      await unlistRoom();
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

  // A new build is looked for when the page starts, every minute after, and
  // whenever the app comes back to the front. On the start page it takes
  // over the page until the player updates (players online need the same
  // build); in a game, a banner offers it, and quitting to the start page
  // brings the same screen. Updating downloads the new build in the
  // service worker and reloads the page into it: no need to close the app.
  const UPDATE_CHECK_MS = 60 * 1000;

  async function checkForUpdate() {
    try {
      if (!state.version) {
        const current = await (await fetch('version.json')).json();
        state.version = current.version;
        $('version').textContent = 'Build ' + current.version;
      }
      if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller || state.updating) return;
      const latest = await (await fetch('version.json?latest=' + Date.now(), { cache: 'no-store' })).json();
      if (latest.version && latest.version !== state.version) showUpdate(latest.version);
    } catch { /* offline */ }
  }

  function showUpdate(version) {
    if (state.updateVersion === version) return;
    state.updateVersion = version;
    log(`update: build ${version} is out (this is ${state.version})`);
    if (state.started) {
      $('update-banner').hidden = false;
    } else {
      $('update-gate').hidden = false;
      $('update-gate-go').focus();
    }
  }

  function startUpdate() {
    state.updating = true;
    for (const id of ['update-gate-go', 'update-banner-go']) {
      $(id).disabled = true;
      $(id).textContent = 'Updating…';
    }
    $('update-gate-status').textContent = 'Downloading the new version…';
    $('update-gate-skip').hidden = true;
    navigator.serviceWorker.controller.postMessage('update');
  }

  function updateFailed() {
    state.updating = false;
    for (const id of ['update-gate-go', 'update-banner-go']) {
      $(id).disabled = false;
      $(id).textContent = 'Try again';
    }
    $('update-gate-status').textContent = 'The update could not be downloaded. Check your connection and try again.';
    $('update-gate-skip').hidden = false;
    if (state.started) toast('The update could not be downloaded.', 5000);
  }

  function setUpUpdates() {
    $('update-gate-go').onclick = startUpdate;
    $('update-banner-go').onclick = startUpdate;
    $('update-banner-later').onclick = () => { $('update-banner').hidden = true; };
    $('update-gate-skip').onclick = () => { $('update-gate').hidden = true; };
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data === 'updated') location.reload();
        if (event.data === 'update-failed') updateFailed();
      });
    }
    setInterval(checkForUpdate, UPDATE_CHECK_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
    window.addEventListener('online', checkForUpdate);
    checkForUpdate();
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
    $('edit-layout').onclick = (event) => {
      event.preventDefault();
      openLayoutEditor($('opt-layout').value);
    };
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
    $('opt-small-textures').checked = settings.smallTextures;
    $('opt-small-textures').onchange = (event) => {
      settings.smallTextures = event.target.checked;
      settings.smallTexturesChosen = true;
      saveSettings();
    };
    for (const id of ['opt-resolution', 'menu-resolution']) {
      $(id).value = settings.resolution;
      $(id).onchange = (event) => {
        settings.resolution = event.target.value;
        $('opt-resolution').value = $('menu-resolution').value = settings.resolution;
        saveSettings();
        // the game takes it up between frames
        if (state.shared) updateDisplaySize();
        log('resolution: ' + settings.resolution + ' (' + renderLines() + ' lines)');
      };
    }
    $('opt-sharp-textures').checked = settings.sharpTextures;
    $('opt-sharp-textures').onchange = (event) => { settings.sharpTextures = event.target.checked; saveSettings(); };
    $('opt-gldebug').checked = settings.glDebug;
    $('opt-gldebug').onchange = (event) => { settings.glDebug = event.target.checked; saveSettings(); };
    $('iso-file').onchange = onImageChosen;
    $('play').onclick = play;
    $('export-saves').onclick = exportSaves;
    $('import-saves-file').onchange = onSavesChosen;
    $('delete-data').onclick = deleteData;
    const showLog = async (whole) => {
      state.logWhole = whole;
      $('log-text').textContent = whole ? await fullLog() : await runLog();
      $('log-whole').textContent = whole ? 'Show this run only' : 'Show the whole log';
      $('log-view').hidden = false;
    };
    $('show-log').onclick = () => showLog(false);
    $('log-whole').onclick = () => showLog(!state.logWhole);
    $('log-close').onclick = () => { $('log-view').hidden = true; };
    $('log-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(state.logWhole ? await fullLog() : await runLog()); toast('Copied.'); } catch { toast('Could not copy.'); }
    };
    $('fatal-reload').onclick = () => location.reload();
    $('fatal-log').onclick = async () => {
      try { await navigator.clipboard.writeText(await runLog()); toast('Copied.'); } catch { toast('Could not copy.'); }
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
    setUpWelcome({ standalone, ios, android });
    showBackdrop();

    watchControllers();
    await ensureIsolation();
    setUpOnline();
    setUpCustom();
    setUpCoop();
    const ok = await runChecks();
    if (!ok) return;
    // all passed: one line, the details a tap away
    if (!$('checks').querySelector('.bad, .warn')) {
      const details = document.createElement('details');
      details.className = 'checks-ok';
      details.innerHTML = '<summary>Ready: this device can run the game</summary>';
      for (const element of [...$('checks').children]) details.appendChild(element);
      $('checks').appendChild(details);
    }
    await refreshGames();
    // (this run's part of debug.txt is what comes after this)
    try { state.debugStart = (await trimDebugLog()).length; } catch { state.debugStart = 0; }
    setUpLobby().catch((error) => log('lobby: ' + error));
    setUpChat();
    setUpUpdates();
  }

  main().catch((error) => {
    log('start: ' + (error && error.stack || error));
    addCheck(false, 'The page could not start: ' + error.message);
  });
})();
