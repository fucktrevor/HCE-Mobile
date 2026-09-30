/*
INPUT.JS

The player's input, gathered on the page's main thread and handed to the
game through the shared state (port/web/src/web_shared.h):

- the keyboard and the mouse (with the pointer locked), as SDL events,
  which the Linux port's keyboard-and-mouse controls read
  (port/linux/README.md, "Controls");
- game controllers (Bluetooth or wired), through the Gamepad API: its
  standard mapping, or the usual order of generic controllers;
- touch controls for phones and tablets without a controller: a stick for
  moving, dragging for aiming (as the mouse does) and the controller's
  buttons, drawn over the game.
*/

'use strict';

const HaloInput = (() => {
  const EVENT = { KEY: 1, MOUSE_MOTION: 2, MOUSE_BUTTON: 3, MOUSE_WHEEL: 4, FOCUS: 5, GAMEPAD_ADDED: 6 };
  // SDL_GamepadButton
  const BUTTON = {
    SOUTH: 0, EAST: 1, WEST: 2, NORTH: 3, BACK: 4, GUIDE: 5, START: 6, LEFT_STICK: 7, RIGHT_STICK: 8,
    LEFT_SHOULDER: 9, RIGHT_SHOULDER: 10, DPAD_UP: 11, DPAD_DOWN: 12, DPAD_LEFT: 13, DPAD_RIGHT: 14,
  };
  const GAMEPAD_TYPE_XBOXONE = 3;
  const GAMEPAD_TYPE_PS4 = 5;
  const GAMEPAD_TYPE_PS5 = 6;
  const TOUCH_SLOT = 4;
  const TOUCH_ID = 1000;

  // KeyboardEvent.code -> SDL_Scancode (USB HID usage)
  const SCANCODES = {};
  'abcdefghijklmnopqrstuvwxyz'.split('').forEach((c, i) => { SCANCODES['Key' + c.toUpperCase()] = 4 + i; });
  '1234567890'.split('').forEach((c, i) => { SCANCODES['Digit' + c] = 30 + i; });
  Object.assign(SCANCODES, {
    Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46, BracketLeft: 47,
    BracketRight: 48, Backslash: 49, Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56,
    CapsLock: 57, PrintScreen: 70, ScrollLock: 71, Pause: 72, Insert: 73, Home: 74, PageUp: 75, Delete: 76,
    End: 77, PageDown: 78, ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82, NumLock: 83,
    NumpadDivide: 84, NumpadMultiply: 85, NumpadSubtract: 86, NumpadAdd: 87, NumpadEnter: 88,
    Numpad1: 89, Numpad2: 90, Numpad3: 91, Numpad4: 92, Numpad5: 93, Numpad6: 94, Numpad7: 95, Numpad8: 96,
    Numpad9: 97, Numpad0: 98, NumpadDecimal: 99, ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227,
    ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231,
  });
  for (let i = 1; i <= 12; i++) SCANCODES['F' + i] = 57 + i;

  let shared = null; // { i32, f32, offsets, base }
  let touchEnabled = false;
  let touchUsed = false;
  let lookSensitivity = 1.4;
  const gamepadIds = new Map(); // Gamepad.index -> slot
  let nextGamepadId = 1;
  // tapped: buttons pressed since the last poll, so a tap between two polls
  // still counts
  const touchPad = { buttons: 0, axes: [0, 0, 0, 0, 0, 0], tapped: 0, tappedAxes: [0, 0] };
  // the buttons and triggers each slot last had, to flag new presses
  const lastPressed = [];
  const rumbleSeen = [0, 0, 0, 0, 0];

  function word(offset) { return (shared.base + offset) >> 2; }

  function pushEvent(type, a = 0, b = 0, c = 0, d = 0, x = 0, y = 0, extra = 0) {
    if (!shared) return;
    const { i32, f32, offsets } = shared;
    const writeIndex = word(offsets.eventWrite);
    const readIndex = word(offsets.eventRead);
    const write = Atomics.load(i32, writeIndex);
    const read = Atomics.load(i32, readIndex);
    if (write - read >= offsets.eventCapacity) return;
    const slot = word(offsets.events + (write % offsets.eventCapacity) * offsets.eventSize);
    i32[slot] = type;
    i32[slot + 1] = a;
    i32[slot + 2] = b;
    i32[slot + 3] = c;
    i32[slot + 4] = d;
    f32[slot + 5] = x;
    f32[slot + 6] = y;
    i32[slot + 7] = extra;
    Atomics.store(i32, writeIndex, write + 1);
  }

  // ---------- keyboard

  function keycode(event, scancode) {
    if (event.key && event.key.length === 1) return event.key.toLowerCase().codePointAt(0);
    const named = { Enter: 13, Escape: 27, Backspace: 8, Tab: 9, ' ': 32, Delete: 127 };
    if (named[event.key] !== undefined) return named[event.key];
    return (scancode | (1 << 30)) >>> 0;
  }

  function modifiers(event) {
    let mod = 0;
    if (event.shiftKey) mod |= 0x0001;
    if (event.ctrlKey) mod |= 0x0040;
    if (event.altKey) mod |= 0x0100;
    if (event.metaKey) mod |= 0x0400;
    if (event.getModifierState && event.getModifierState('CapsLock')) mod |= 0x2000;
    return mod;
  }

  function onKey(event, down) {
    if (!shared) return;
    // typing in the page's own fields (the chat) is not for the game
    const target = event.target;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    const scancode = SCANCODES[event.code];
    if (scancode === undefined) return;
    // keep the browser's shortcuts (reload, developer tools) with Ctrl/Cmd
    if (!(event.metaKey || (event.ctrlKey && event.code !== 'ControlLeft' && event.code !== 'ControlRight'))) {
      event.preventDefault();
    }
    pushEvent(EVENT.KEY, scancode, down ? 1 : 0, event.repeat ? 1 : 0, keycode(event, scancode) | 0, 0, 0,
      modifiers(event));
  }

  // ---------- mouse (with the pointer locked on the game)

  function mouseButton(button) {
    return [1, 2, 3, 4, 5][button] || 0; // left, middle, right, back, forward
  }

  function attachMouse(canvas) {
    canvas.addEventListener('click', () => {
      if (!document.pointerLockElement && canvas.requestPointerLock && matchMedia('(pointer: fine)').matches) {
        try { canvas.requestPointerLock(); } catch { /* not allowed here */ }
      }
    });
    document.addEventListener('mousemove', (event) => {
      if (document.pointerLockElement !== canvas) return;
      pushEvent(EVENT.MOUSE_MOTION, 0, 0, 0, 0, event.movementX || 0, event.movementY || 0);
    });
    document.addEventListener('mousedown', (event) => {
      if (document.pointerLockElement !== canvas) return;
      pushEvent(EVENT.MOUSE_BUTTON, mouseButton(event.button), 1);
    });
    document.addEventListener('mouseup', (event) => {
      if (document.pointerLockElement !== canvas) return;
      pushEvent(EVENT.MOUSE_BUTTON, mouseButton(event.button), 0);
    });
    document.addEventListener('wheel', (event) => {
      if (document.pointerLockElement !== canvas) return;
      pushEvent(EVENT.MOUSE_WHEEL, 0, 0, 0, 0, 0, event.deltaY < 0 ? 1 : event.deltaY > 0 ? -1 : 0);
    }, { passive: true });
  }

  // ---------- controllers

  function gamepadType(gamepad) {
    const id = (gamepad.id || '').toLowerCase();
    if (id.includes('dualsense') || id.includes('0ce6')) return GAMEPAD_TYPE_PS5;
    if (id.includes('dualshock') || id.includes('054c')) return GAMEPAD_TYPE_PS4;
    return GAMEPAD_TYPE_XBOXONE;
  }

  function axis(value) {
    return Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
  }

  function writeGamepad(slot, connected, id, type, buttons, axes) {
    const { i32, offsets } = shared;
    const base = word(offsets.gamepads + slot * offsets.gamepadSize);
    const wasConnected = i32[base] !== 0;
    i32[base + 1] = id;
    i32[base + 2] = type;
    i32[base + 3] = buttons;
    for (let i = 0; i < 6; i++) i32[base + 4 + i] = axes[i];
    // new presses stay flagged until the game reads them (web_shared.h):
    // at a low frame rate a tap can begin and end between two of its reads
    const down = (buttons & 0x3fffffff) | (axes[4] > 16384 ? 1 << 30 : 0) | (axes[5] > 16384 ? 1 << 31 : 0);
    const fresh = connected ? down & ~(lastPressed[slot] || 0) : 0;
    lastPressed[slot] = connected ? down : 0;
    if (fresh) Atomics.or(i32, base + 14, fresh);
    Atomics.store(i32, base, connected ? 1 : 0);
    if (connected && !wasConnected) pushEvent(EVENT.GAMEPAD_ADDED, id);
  }

  function rumble(slot, gamepad) {
    const { i32, offsets } = shared;
    const base = word(offsets.gamepads + slot * offsets.gamepadSize);
    const serial = i32[base + 12];
    if (serial === rumbleSeen[slot]) return;
    rumbleSeen[slot] = serial;
    const actuator = gamepad && gamepad.vibrationActuator;
    if (!actuator || !actuator.playEffect) return;
    const strong = i32[base + 10] / 65535;
    const weak = i32[base + 11] / 65535;
    const duration = Math.min(i32[base + 13] || 1000, 5000);
    if (strong <= 0 && weak <= 0) {
      actuator.reset?.();
      return;
    }
    actuator.playEffect('dual-rumble', { duration, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
  }

  let physicalCount = 0;

  // A controller's buttons and axes as the game's (SDL's) bits and axes.
  // Browsers describe most controllers (Xbox, PlayStation, Switch Pro, MFi,
  // most Android ones, over Bluetooth or a cable) with the "standard"
  // mapping. For the others, the usual order of generic HID controllers: the
  // face buttons, the shoulders, the triggers as buttons or as axes 4 and 5,
  // and the d-pad as buttons 12 to 15, as axes 6 and 7, or as a hat (axis 9).
  function readGamepad(gamepad) {
    const b = gamepad.buttons;
    const a = gamepad.axes;
    const pressed = (i) => (b[i] ? (b[i].pressed || b[i].value > 0.5) : false);
    const value = (i) => (b[i] ? Math.max(0, Math.min(1, b[i].value || (b[i].pressed ? 1 : 0))) : 0);
    let buttons = 0;
    const map = [
      [0, BUTTON.SOUTH], [1, BUTTON.EAST], [2, BUTTON.WEST], [3, BUTTON.NORTH], [4, BUTTON.LEFT_SHOULDER],
      [5, BUTTON.RIGHT_SHOULDER], [8, BUTTON.BACK], [9, BUTTON.START], [10, BUTTON.LEFT_STICK],
      [11, BUTTON.RIGHT_STICK], [12, BUTTON.DPAD_UP], [13, BUTTON.DPAD_DOWN], [14, BUTTON.DPAD_LEFT],
      [15, BUTTON.DPAD_RIGHT], [16, BUTTON.GUIDE],
    ];
    for (const [index, bit] of map) if (pressed(index)) buttons |= 1 << bit;
    let left = value(6), right = value(7);
    if (gamepad.mapping !== 'standard') {
      // triggers on axes 4 and 5 (-1 at rest) when there are no trigger buttons
      if (b.length < 8 && a.length >= 6) {
        left = Math.max(0, (a[4] + 1) / 2);
        right = Math.max(0, (a[5] + 1) / 2);
      }
      if (b.length < 13) {
        let x = 0, y = 0;
        if (a.length >= 10 && Math.abs(a[9]) <= 1.01) {
          // a hat: -1 up, then clockwise in steps of 2/7; above 1 at rest
          const step = Math.round((a[9] + 1) * 3.5);
          x = [0, 1, 1, 1, 0, -1, -1, -1][step] || 0;
          y = [-1, -1, 0, 1, 1, 1, 0, -1][step] || 0;
        } else if (a.length >= 8) {
          x = Math.round(a[6]);
          y = Math.round(a[7]);
        }
        if (y < 0) buttons |= 1 << BUTTON.DPAD_UP;
        if (y > 0) buttons |= 1 << BUTTON.DPAD_DOWN;
        if (x < 0) buttons |= 1 << BUTTON.DPAD_LEFT;
        if (x > 0) buttons |= 1 << BUTTON.DPAD_RIGHT;
      }
    }
    const trigger = (v) => Math.round(v * 32767);
    return [buttons, [axis(a[0] || 0), axis(a[1] || 0), axis(a[2] || 0), axis(a[3] || 0), trigger(left), trigger(right)]];
  }

  // told when a controller comes or goes: (name, connected)
  let controllerListener = null;

  function controllerName(gamepad) {
    // "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)"
    return (gamepad.id || 'Controller').replace(/\s*\(.*$/, '').replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '').trim() || 'Controller';
  }

  function connectedControllers() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    return [...pads].filter((pad) => pad && pad.connected).map(controllerName);
  }

  function pollGamepads() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const used = new Set();
    physicalCount = 0;
    for (const gamepad of pads) {
      if (!gamepad || !gamepad.connected) continue;
      let slot = gamepadIds.get(gamepad.index);
      if (slot === undefined) {
        for (let s = 0; s < TOUCH_SLOT; s++) {
          if (![...gamepadIds.values()].includes(s)) { slot = s; break; }
        }
        if (slot === undefined) continue;
        gamepadIds.set(gamepad.index, slot);
        slot = gamepadIds.get(gamepad.index);
        if (controllerListener) controllerListener(controllerName(gamepad), true);
        shared.ids = shared.ids || [];
        shared.ids[slot] = nextGamepadId++;
      }
      used.add(slot);
      physicalCount++;
      const [buttons, axes] = readGamepad(gamepad);
      writeGamepad(slot, true, shared.ids[slot], gamepadType(gamepad), buttons, axes);
      rumble(slot, gamepad);
    }
    for (const [index, slot] of [...gamepadIds.entries()]) {
      if (!used.has(slot)) {
        gamepadIds.delete(index);
        if (controllerListener) controllerListener('', false);
        writeGamepad(slot, false, 0, 0, 0, [0, 0, 0, 0, 0, 0]);
      }
    }
    // the touch controls are a controller of their own while no other is
    const touchActive = touchEnabled && touchUsed && physicalCount === 0;
    const touchAxes = touchPad.axes.slice();
    if (touchPad.tappedAxes[0]) touchAxes[4] = 32767;
    if (touchPad.tappedAxes[1]) touchAxes[5] = 32767;
    writeGamepad(TOUCH_SLOT, touchActive, TOUCH_ID, GAMEPAD_TYPE_XBOXONE, touchPad.buttons | touchPad.tapped, touchAxes);
    touchPad.tapped = 0;
    touchPad.tappedAxes[0] = touchPad.tappedAxes[1] = 0;
    document.body.classList.toggle('has-controller', physicalCount > 0);
  }

  // ---------- touch controls

  // Line icons for the modern layout (24 by 24, drawn with the current colour)
  const ICON = {
    fire: '<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
    scope: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 4v5M12 15v5M4 12h5M15 12h5"/>',
    jump: '<path d="M12 19V6M6 11l6-6 6 6"/><path d="M5 21h14"/>',
    crouch: '<path d="M12 4v11M6 10l6 6 6-6"/><path d="M5 21h14"/>',
    reload: '<path d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M19 4v4h-4"/>',
    grenade: '<circle cx="12" cy="14" r="6"/><path d="M10 8V5h4v3M14 5l4-2"/>',
    grenadeSwap: '<circle cx="9" cy="14" r="5"/><path d="M8 9V6h2v3"/><path d="M16 5h5M19 3l2 2-2 2M21 11h-5M18 9l-2 2 2 2"/>',
    melee: '<path d="M7 13V8a1.5 1.5 0 0 1 3 0v3M10 11V6.5a1.5 1.5 0 0 1 3 0V11M13 11V7.5a1.5 1.5 0 0 1 3 0V12M16 12V9.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a5 5 0 0 1-5-5v-2a1.5 1.5 0 0 1 0-3"/>',
    swap: '<path d="M4 8h14M14 4l4 4-4 4"/><path d="M20 16H6M10 12l-4 4 4 4"/>',
    light: '<path d="M4 9h7l5-4v14l-5-4H4z"/><path d="M19 8l2-1M19 12h3M19 16l2 1"/>',
    pause: '<path d="M9 5v14M15 5v14"/>',
    score: '<path d="M4 20v-7h5v7M9.5 20V5h5v15M15 20v-4h5v4"/>',
  };

  function icon(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
  }

  // [id, label (text, or an icon: {icon}), button bit or trigger axis, class, caption, badge]
  const TOUCH_LAYOUTS = {
    // the original Xbox controller's layout (the Controller S): gem-coloured
    // A, B, X and Y in a diamond with the white and black buttons below
    // them, the L and R triggers above each side, back and start between
    // the thumbs, and the d-pad under the left thumb
    xbox: [
      ['a', 'A', { bit: BUTTON.SOUTH }, 'face face-a', 'Jump'],
      ['b', 'B', { bit: BUTTON.EAST }, 'face face-b', 'Melee'],
      ['x', 'X', { bit: BUTTON.WEST }, 'face face-x', 'Reload'],
      ['y', 'Y', { bit: BUTTON.NORTH }, 'face face-y', 'Swap'],
      ['white', '', { bit: BUTTON.LEFT_SHOULDER }, 'duo duo-white', 'Light'],
      ['black', '', { bit: BUTTON.RIGHT_SHOULDER }, 'duo duo-black', 'Grenade'],
      ['fire', 'R', { axis: 5 }, 'trigger right-side', 'Fire'],
      ['lt', 'L', { axis: 4 }, 'trigger left-side', 'Throw'],
      ['ls', '', { bit: BUTTON.LEFT_STICK }, 'stick-click left-click', 'Crouch'],
      ['rs', '', { bit: BUTTON.RIGHT_STICK }, 'stick-click right-click', 'Zoom'],
      ['back', 'BACK', { bit: BUTTON.BACK }, 'system back', ''],
      ['start', 'START', { bit: BUTTON.START }, 'system start', ''],
      ['up', '', { bit: BUTTON.DPAD_UP }, 'dpad up', ''],
      ['down', '', { bit: BUTTON.DPAD_DOWN }, 'dpad down', ''],
      ['left', '', { bit: BUTTON.DPAD_LEFT }, 'dpad left', ''],
      ['right', '', { bit: BUTTON.DPAD_RIGHT }, 'dpad right', ''],
    ],
    // a modern mobile shooter's layout: a large fire button under the right
    // thumb that also aims while held, the actions around it as icons, a
    // second fire button for the left thumb, and pause and score at the top.
    // In the menus the stick moves and Jump (A) and Melee (B) select and go
    // back, as their badges say.
    modern: [
      ['fire', { icon: 'fire' }, { axis: 5 }, 'm m-fire', ''],
      ['fire2', { icon: 'fire' }, { axis: 5 }, 'm m-fire2', ''],
      ['rs', { icon: 'scope' }, { bit: BUTTON.RIGHT_STICK }, 'm m-zoom', 'Zoom'],
      ['a', { icon: 'jump' }, { bit: BUTTON.SOUTH }, 'm m-jump', 'Jump', 'A'],
      ['ls', { icon: 'crouch' }, { bit: BUTTON.LEFT_STICK }, 'm m-crouch', 'Crouch'],
      ['b', { icon: 'melee' }, { bit: BUTTON.EAST }, 'm m-melee', 'Melee', 'B'],
      ['x', { icon: 'reload' }, { bit: BUTTON.WEST }, 'm m-reload', 'Reload', 'X'],
      ['lt', { icon: 'grenade' }, { axis: 4 }, 'm m-grenade', 'Grenade'],
      ['black', { icon: 'grenadeSwap' }, { bit: BUTTON.RIGHT_SHOULDER }, 'm m-grenade-type', 'Type'],
      ['y', { icon: 'swap' }, { bit: BUTTON.NORTH }, 'm m-swap', 'Swap', 'Y'],
      ['white', { icon: 'light' }, { bit: BUTTON.LEFT_SHOULDER }, 'm m-light', 'Light'],
      ['back', { icon: 'score' }, { bit: BUTTON.BACK }, 'm m-top m-score', 'Score'],
      ['start', { icon: 'pause' }, { bit: BUTTON.START }, 'm m-top m-pause', 'Pause'],
    ],
  };

  // Moves and resizes a control (a button, the d-pad, the stick's resting
  // place) as the layout editor left it: its centre as fractions of the
  // screen, and a scale. The individual translate and scale properties
  // compose with the transform a pressed button takes.
  function placeControl(element, place) {
    if (!place) {
      for (const property of ['left', 'top', 'right', 'bottom', 'translate', 'scale']) element.style[property] = '';
      return;
    }
    if (place.x !== undefined) {
      element.style.left = (place.x * 100).toFixed(2) + '%';
      element.style.top = (place.y * 100).toFixed(2) + '%';
      element.style.right = 'auto';
      element.style.bottom = 'auto';
      element.style.translate = '-50% -50%';
    }
    element.style.scale = place.s && place.s !== 1 ? String(place.s) : '';
  }

  // options: custom ({ control: { x, y, s } }), opacity, editor (no game input)
  function buildTouchControls(root, layoutName, options = {}) {
    const layoutKey = TOUCH_LAYOUTS[layoutName] ? layoutName : 'modern';
    const layout = TOUCH_LAYOUTS[layoutKey];
    const custom = options.custom || {};
    root.classList.remove('modern', 'xbox');
    root.classList.add(layoutKey);
    root.style.opacity = options.opacity && options.opacity < 1 ? String(options.opacity) : '';
    const held = new Map(); // touch identifier -> control
    const buttonState = new Map(); // control id -> count of touches
    const stick = { id: null, x: 0, y: 0, element: null, knob: null };
    const look = { id: null, x: 0, y: 0 };

    const stickBase = document.createElement('div');
    stickBase.className = 'touch-stick';
    const knob = document.createElement('div');
    knob.className = 'touch-knob';
    stickBase.appendChild(knob);
    root.appendChild(stickBase);
    stick.element = stickBase;
    stick.knob = knob;

    const controls = {};
    const dpad = document.createElement('div');
    dpad.className = 'touch-dpad';
    if (layout.some(([, , , cls]) => cls.startsWith('dpad'))) root.appendChild(dpad);
    for (const [id, label, action, cls, caption, badge] of layout) {
      const element = document.createElement('div');
      element.className = 'touch-button ' + cls;
      element.dataset.control = id;
      element.setAttribute('aria-label', caption || id);
      if (label) {
        const glyph = document.createElement('span');
        glyph.className = 'glyph';
        if (label.icon) glyph.innerHTML = icon(label.icon);
        else glyph.textContent = label;
        element.appendChild(glyph);
      }
      if (badge) {
        const mark = document.createElement('span');
        mark.className = 'badge badge-' + badge.toLowerCase();
        mark.textContent = badge;
        element.appendChild(mark);
      }
      if (caption) {
        const hint = document.createElement('span');
        hint.className = 'caption';
        hint.textContent = caption;
        element.appendChild(hint);
      }
      (cls.startsWith('dpad') ? dpad : root).appendChild(element);
      controls[id] = { element, action };
    }

    dpad.dataset.control = 'dpad';
    stickBase.dataset.control = 'stick';
    for (const element of root.querySelectorAll('[data-control]')) {
      if (element.parentElement === dpad) continue;
      placeControl(element, custom[element.dataset.control]);
    }
    const stickRest = custom.stick;
    if (options.editor) return { root, layoutKey, dpad, stickBase };

    function refreshButtons() {
      let buttons = 0;
      touchPad.axes[4] = 0;
      touchPad.axes[5] = 0;
      for (const [id, count] of buttonState) {
        if (count <= 0) continue;
        const { action } = controls[id];
        if (action.bit !== undefined) buttons |= 1 << action.bit;
        if (action.axis !== undefined) touchPad.axes[action.axis] = 32767;
      }
      touchPad.tapped |= buttons & ~touchPad.buttons;
      if (touchPad.axes[4]) touchPad.tappedAxes[0] = 1;
      if (touchPad.axes[5]) touchPad.tappedAxes[1] = 1;
      touchPad.buttons = buttons;
      for (const id in controls) controls[id].element.classList.toggle('pressed', (buttonState.get(id) || 0) > 0);
    }

    const STICK_RADIUS = 56;

    function start(event) {
      touchUsed = true;
      for (const touch of event.changedTouches) {
        const target = document.elementFromPoint(touch.clientX, touch.clientY);
        const control = target && target.closest && target.closest('.touch-button');
        if (control) {
          const id = control.dataset.control;
          held.set(touch.identifier, { kind: 'button', id });
          buttonState.set(id, (buttonState.get(id) || 0) + 1);
          // aiming while firing: a touch on the fire button also aims
          if (id === 'fire' && look.id === null) {
            look.id = touch.identifier;
            look.x = touch.clientX;
            look.y = touch.clientY;
          }
          continue;
        }
        if (touch.clientX < window.innerWidth * (layoutKey === 'modern' ? 0.45 : 0.4) && stick.id === null) {
          stick.id = touch.identifier;
          stick.x = touch.clientX;
          stick.y = touch.clientY;
          const half = (stick.element.offsetWidth / 2 || 64);
          stick.element.style.translate = 'none';
          stick.element.style.left = (touch.clientX - half) + 'px';
          stick.element.style.top = (touch.clientY - half) + 'px';
          stick.element.style.right = 'auto';
          stick.element.style.bottom = 'auto';
          stick.element.classList.add('active');
          held.set(touch.identifier, { kind: 'stick' });
        } else if (look.id === null) {
          look.id = touch.identifier;
          look.x = touch.clientX;
          look.y = touch.clientY;
          held.set(touch.identifier, { kind: 'look' });
        }
      }
      refreshButtons();
      event.preventDefault();
    }

    function move(event) {
      for (const touch of event.changedTouches) {
        if (touch.identifier === stick.id) {
          let dx = touch.clientX - stick.x;
          let dy = touch.clientY - stick.y;
          const length = Math.hypot(dx, dy);
          if (length > STICK_RADIUS) {
            dx *= STICK_RADIUS / length;
            dy *= STICK_RADIUS / length;
          }
          stick.knob.style.transform = `translate(${dx}px, ${dy}px)`;
          touchPad.axes[0] = axis(dx / STICK_RADIUS);
          touchPad.axes[1] = axis(dy / STICK_RADIUS);
        }
        if (touch.identifier === look.id) {
          const dx = touch.clientX - look.x;
          const dy = touch.clientY - look.y;
          look.x = touch.clientX;
          look.y = touch.clientY;
          pushEvent(EVENT.MOUSE_MOTION, 0, 0, 0, 0, dx * lookSensitivity * 2, dy * lookSensitivity * 2);
        }
      }
      event.preventDefault();
    }

    function end(event) {
      for (const touch of event.changedTouches) {
        const entry = held.get(touch.identifier);
        held.delete(touch.identifier);
        if (entry && entry.kind === 'button') {
          buttonState.set(entry.id, Math.max(0, (buttonState.get(entry.id) || 0) - 1));
        }
        if (touch.identifier === stick.id) {
          stick.id = null;
          stick.knob.style.transform = '';
          stick.element.classList.remove('active');
          // back to its resting place
          placeControl(stick.element, null);
          placeControl(stick.element, stickRest);
          touchPad.axes[0] = 0;
          touchPad.axes[1] = 0;
        }
        if (touch.identifier === look.id) look.id = null;
      }
      refreshButtons();
      event.preventDefault();
    }

    root.addEventListener('touchstart', start, { passive: false });
    root.addEventListener('touchmove', move, { passive: false });
    root.addEventListener('touchend', end, { passive: false });
    root.addEventListener('touchcancel', end, { passive: false });
  }

  // ---------- setup

  let touchRoot = null;

  function attach({ memory, base, offsets, canvas, touchRoot: root, touch, touchLayout, touchCustom, touchOpacity }) {
    touchRoot = root;
    const buffer = memory.buffer;
    shared = { i32: new Int32Array(buffer), f32: new Float32Array(buffer), base, offsets, ids: [] };
    window.addEventListener('keydown', (event) => onKey(event, true));
    window.addEventListener('keyup', (event) => onKey(event, false));
    window.addEventListener('blur', () => pushEvent(EVENT.FOCUS, 0));
    window.addEventListener('focus', () => pushEvent(EVENT.FOCUS, 1));
    attachMouse(canvas);
    touchEnabled = touch;
    if (touch) {
      buildTouchControls(touchRoot, touchLayout, { custom: touchCustom, opacity: touchOpacity });
      touchUsed = true;
    }
  }

  function setLookSensitivity(value) {
    lookSensitivity = value;
  }

  // the controller's B for a moment (the system's back gesture): the
  // keyboard's Backspace, which the controller emulation reads as B
  function pressBack() {
    pushEvent(EVENT.KEY, 42, 1, 0, 8);
    setTimeout(() => pushEvent(EVENT.KEY, 42, 0, 0, 8), 120);
  }

  // a new layout, or the same one edited, while the game runs: the controls
  // are built again on a fresh element (which drops the old one's listeners)
  function setTouchLayout(layoutName, custom, opacity) {
    if (!touchRoot || !touchEnabled) return;
    const fresh = touchRoot.cloneNode(false);
    touchRoot.replaceWith(fresh);
    touchRoot = fresh;
    touchPad.buttons = 0;
    touchPad.tapped = 0;
    touchPad.axes.fill(0);
    buildTouchControls(fresh, layoutName, { custom, opacity });
  }

  // The layout editor: the controls of a layout, in container, to drag
  // (move) and to size. onDone(custom, opacity) when Done is pushed.
  function editTouchLayout(container, layoutName, custom, opacity, onDone) {
    const places = JSON.parse(JSON.stringify(custom || {}));
    let alpha = opacity || 1;
    container.textContent = '';
    const stage = document.createElement('div');
    stage.className = 'touch-layer';
    container.appendChild(stage);
    const built = buildTouchControls(stage, layoutName, { custom: places, opacity: alpha, editor: true });
    const bar = document.createElement('div');
    bar.className = 'editor-bar';
    bar.innerHTML = `<span class="editor-hint">Drag a control to move it. Pick one to size it.</span>
      <label>Size <input type="range" min="0.6" max="1.8" step="0.05" value="1" data-size disabled></label>
      <label>Opacity <input type="range" min="0.25" max="1" step="0.05" data-opacity></label>
      <button type="button" class="button small-button" data-reset>Reset</button>
      <button type="button" class="button small-button primary" data-done>Done</button>`;
    container.appendChild(bar);
    const size = bar.querySelector('[data-size]');
    const fade = bar.querySelector('[data-opacity]');
    fade.value = alpha;
    let selected = null;
    const units = [...stage.querySelectorAll('[data-control]')].filter((element) => element.parentElement !== built.dpad);

    function select(element) {
      if (selected) selected.classList.remove('editing');
      selected = element;
      if (!element) {
        size.disabled = true;
        return;
      }
      element.classList.add('editing');
      size.disabled = false;
      size.value = (places[element.dataset.control] && places[element.dataset.control].s) || 1;
    }

    for (const element of units) {
      element.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        select(element);
        element.setPointerCapture(event.pointerId);
        const move = (next) => {
          const id = element.dataset.control;
          const x = Math.min(0.98, Math.max(0.02, next.clientX / window.innerWidth));
          const y = Math.min(0.98, Math.max(0.02, next.clientY / window.innerHeight));
          places[id] = { ...(places[id] || {}), x, y };
          placeControl(element, places[id]);
        };
        const up = () => {
          element.removeEventListener('pointermove', move);
          element.removeEventListener('pointerup', up);
          element.removeEventListener('pointercancel', up);
        };
        element.addEventListener('pointermove', move);
        element.addEventListener('pointerup', up);
        element.addEventListener('pointercancel', up);
      });
    }
    stage.addEventListener('pointerdown', (event) => { if (event.target === stage) select(null); });
    size.oninput = () => {
      if (!selected) return;
      const id = selected.dataset.control;
      places[id] = { ...(places[id] || {}), s: parseFloat(size.value) };
      placeControl(selected, places[id]);
    };
    fade.oninput = () => {
      alpha = parseFloat(fade.value);
      stage.style.opacity = alpha < 1 ? String(alpha) : '';
    };
    bar.querySelector('[data-reset]').onclick = () => {
      for (const key of Object.keys(places)) delete places[key];
      for (const element of units) placeControl(element, null);
      alpha = 1;
      fade.value = 1;
      stage.style.opacity = '';
      select(null);
    };
    bar.querySelector('[data-done]').onclick = () => {
      container.textContent = '';
      onDone(places, alpha);
    };
  }

  function onController(listener) {
    controllerListener = listener;
  }

  return { attach, pollGamepads, setLookSensitivity, pressBack, onController, connectedControllers, setTouchLayout,
    editTouchLayout, isTouchEnabled: () => touchEnabled };
})();
