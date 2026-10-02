/*
COOP.JS

Remote co-op: a friend plays the host's game as its second player from
their own device, as in a split screen game on one console. The host's game
runs a two-player game (Multiplayer > Cooperative Play for the campaign, or
Split Screen); the friend's device runs no game at all.

- The friend's controls (touch, a controller, or the keyboard and mouse) go
  to the host over a WebRTC data channel sixty times a second, and the host's
  page hands them to the game as a controller of its own (input.js
  remoteInput, web_shared.h WEB_REMOTE_GAMEPAD_SLOT), aiming included.
- The host's page streams the friend's part of the screen (the lower view of
  the split screen, or all of it in the menus) and the game's sound back as
  WebRTC video and audio.

The two find each other in the room (net.js): the host's hello says it
takes a second player, and their connection is signalled over the room's
encrypted topic, apart from the room's own connections.
*/

'use strict';

const HaloCoop = (() => {
  const STREAM_WIDTH = 1280;
  const INPUT_WORDS = 11; // seq, buttons, pressed, six axes, look x, look y
  const JOIN_TIMEOUT = 20000;

  const listeners = new Set();
  function emit(type, detail) {
    for (const listener of listeners) listener(type, detail);
  }

  function iceConfig() {
    return { iceServers: HaloNet.iceServers() };
  }

  // ---------- the host

  const host = {
    enabled: false,
    guest: null,          // { id, name, pc, input, control, view, pending, lastSeq, rtt }
    canvas: null,
    context: null,
    stream: null,
    audio: null,          // () => { context, node } of the game's sound
    splitViews: () => 0,  // the game's views on the screen (web_shared.h split_views)
    lastFrame: 0,
    lastViewFrame: 0,     // when the game last drew the second player's own view
  };

  function hostStatus() {
    const guest = host.guest;
    return {
      enabled: host.enabled,
      guest: guest ? guest.name : null,
      connected: !!(guest && guest.connected),
      rtt: guest ? guest.rtt : null,
    };
  }

  function setHosting(enabled) {
    host.enabled = !!enabled;
    if (!host.enabled && host.guest) endGuest('The host stopped co-op.');
    HaloNet.setCoopHost(host.enabled ? { busy: !!host.guest } : null);
    emit('host', hostStatus());
  }

  function streamCanvas() {
    if (!host.canvas) {
      host.canvas = document.createElement('canvas');
      host.canvas.width = STREAM_WIDTH;
      host.canvas.height = 720;
      host.context = host.canvas.getContext('2d', { alpha: false });
      host.context.fillStyle = '#000';
      host.context.fillRect(0, 0, host.canvas.width, host.canvas.height);
      host.context.fillStyle = '#9fb7c9';
      host.context.font = '32px sans-serif';
      host.context.textAlign = 'center';
      host.context.fillText('Waiting for the host to start the game…', host.canvas.width / 2, host.canvas.height / 2);
    }
    return host.canvas;
  }

  async function startGuest(id, name) {
    const guest = { id, name, pc: null, input: null, control: null, view: 'auto', pending: [], lastSeq: -1, rtt: null,
      connected: false };
    host.guest = guest;
    HaloNet.setCoopHost({ busy: true });
    emit('host', hostStatus());
    const pc = new RTCPeerConnection(iceConfig());
    guest.pc = pc;
    guest.input = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
    guest.input.binaryType = 'arraybuffer';
    guest.control = pc.createDataChannel('control');
    guest.input.onmessage = (event) => onGuestInput(guest, event.data);
    guest.control.onmessage = (event) => onGuestControl(guest, event.data);
    guest.control.onopen = () => {
      guest.connected = true;
      emit('host', hostStatus());
      emit('message', `${name} is player 2.`);
    };

    const canvas = streamCanvas();
    const stream = canvas.captureStream(0);
    host.stream = stream;
    const video = stream.getVideoTracks()[0];
    if ('contentHint' in video) video.contentHint = 'motion';
    const videoSender = pc.addTrack(video, stream);
    const sound = host.audio && host.audio();
    if (sound && sound.context && sound.node) {
      try {
        guest.audioDestination = sound.context.createMediaStreamDestination();
        sound.node.connect(guest.audioDestination);
        const track = guest.audioDestination.stream.getAudioTracks()[0];
        if (track) pc.addTrack(track, stream);
      } catch { /* no sound for the friend */ }
    }
    requestFrame();

    pc.onicecandidate = (event) => {
      if (event.candidate) HaloNet.coopSignal(id, { kind: 'candidate', candidate: event.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (host.guest !== guest) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') endGuest(`${name} left co-op.`);
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    HaloNet.coopSignal(id, { kind: 'offer', sdp: pc.localDescription.sdp });
    // a sharp, steady picture for fast motion: frames over detail
    try {
      const parameters = videoSender.getParameters();
      parameters.encodings = parameters.encodings && parameters.encodings.length ? parameters.encodings : [{}];
      parameters.encodings[0].maxBitrate = 3500000;
      parameters.encodings[0].maxFramerate = 60;
      parameters.degradationPreference = 'maintain-framerate';
      await videoSender.setParameters(parameters);
    } catch { /* the browser's defaults */ }
  }

  function endGuest(message) {
    const guest = host.guest;
    if (!guest) return;
    host.guest = null;
    try { HaloNet.coopSignal(guest.id, { kind: 'end' }); } catch { /* gone */ }
    try { guest.pc.close(); } catch { /* closed */ }
    if (guest.audioDestination) {
      try { host.audio().node.disconnect(guest.audioDestination); } catch { /* disconnected */ }
    }
    HaloInput.remoteDisconnect();
    HaloNet.setCoopHost(host.enabled ? { busy: false } : null);
    emit('host', hostStatus());
    if (message) emit('message', message);
  }

  function onGuestInput(guest, data) {
    if (host.guest !== guest || !(data instanceof ArrayBuffer) || data.byteLength !== INPUT_WORDS * 4) return;
    const words = new Int32Array(data);
    const seq = words[0];
    // an older state that arrived late: its presses and aiming still count
    const newer = seq > guest.lastSeq || guest.lastSeq - seq > 1e6;
    if (newer) guest.lastSeq = seq;
    const axes = Array.from(words.subarray(3, 9));
    if (newer) HaloInput.remoteInput(words[1] >>> 0, words[2] >>> 0, axes, words[9], words[10]);
    else HaloInput.remoteInput(guest.lastButtons || 0, words[2] >>> 0, guest.lastAxes || axes, words[9], words[10]);
    if (newer) {
      guest.lastButtons = words[1] >>> 0;
      guest.lastAxes = axes;
    }
  }

  function onGuestControl(guest, data) {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.view && ['auto', 'top', 'bottom', 'whole'].includes(message.view)) guest.view = message.view;
    if (typeof message.ping === 'number') guest.control.send(JSON.stringify({ pong: message.ping }));
    if (typeof message.rtt === 'number') {
      guest.rtt = Math.round(message.rtt);
      emit('host', hostStatus());
    }
  }

  function requestFrame() {
    const track = host.stream && host.stream.getVideoTracks()[0];
    if (track && track.requestFrame) track.requestFrame();
  }

  // Whether the game should draw the second player's view on a whole screen
  // of its own (web_shared.h coop_full_views): as it would on their console,
  // the shape of the screen, rather than half of the host's split screen
  function fullViews() {
    return !!(host.guest && host.guest.connected && host.guest.view === 'auto');
  }

  // a frame of the second player's own view (Module.haloPresentView)
  function viewFrame(bitmap) {
    const guest = host.guest;
    if (guest && guest.connected) {
      host.lastViewFrame = performance.now();
      draw(bitmap, 0, bitmap.height);
    }
    bitmap.close();
  }

  function draw(bitmap, sy, sh) {
    const width = bitmap.width;
    const canvas = streamCanvas();
    const targetWidth = Math.min(STREAM_WIDTH, width);
    const targetHeight = Math.max(2, Math.round(targetWidth * sh / width) & ~1);
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }
    host.context.drawImage(bitmap, 0, sy, width, sh, 0, 0, targetWidth, targetHeight);
    requestFrame();
    const rumble = HaloInput.remoteRumble();
    if (rumble && host.guest.control.readyState === 'open') host.guest.control.send(JSON.stringify({ rumble }));
  }

  // each frame the game presents, before it goes onto the page's canvas
  function frame(bitmap) {
    const guest = host.guest;
    if (!guest || !guest.connected) return;
    const now = performance.now();
    // (the game draws the second player's own view: this frame is the host's)
    // (a slow host draws the friend's view only a few times a second: its own
    // frames stand in only when the friend's have stopped, in a cinematic)
    if (fullViews() && now - host.lastViewFrame < 2000) return;
    if (now - host.lastFrame < 15) return; // 60 a second at most
    host.lastFrame = now;
    const views = host.splitViews();
    let part = guest.view;
    // (while the game draws each player's view on a whole screen, the host's
    // screen is never split: a frame of it is the whole of it)
    if (part === 'auto') part = views >= 2 && !fullViews() ? 'bottom' : 'whole';
    const height = bitmap.height;
    const sy = part === 'bottom' ? Math.floor(height / 2) : 0;
    const sh = part === 'whole' ? height : Math.floor(height / 2);
    draw(bitmap, sy, sh);
  }

  // ---------- the friend (the second player)

  const friend = {
    hostId: null,
    hostName: '',
    pc: null,
    input: null,
    control: null,
    video: null,
    stream: null,
    seq: 0,
    timer: null,
    pingTimer: null,
    joinTimer: null,
    pendingCandidates: [],
    view: 'auto',
    last: null,
    lastSent: 0,
  };

  function join(hostId, hostName, video) {
    friend.hostId = hostId;
    friend.hostName = hostName;
    friend.video = video;
    friend.stream = new MediaStream();
    video.srcObject = friend.stream;
    HaloNet.coopSignal(hostId, { kind: 'join' });
    emit('friend', { state: 'joining', host: hostName });
    friend.joinTimer = setTimeout(() => {
      if (!friend.pc || friend.pc.connectionState !== 'connected') {
        emit('friend', { state: 'failed', host: hostName, reason: `${hostName}'s game did not answer.` });
      }
    }, JOIN_TIMEOUT);
  }

  async function onHostOffer(sdp) {
    if (friend.pc) {
      try { friend.pc.close(); } catch { /* closed */ }
    }
    const pc = new RTCPeerConnection(iceConfig());
    friend.pc = pc;
    pc.ontrack = (event) => {
      friend.stream.addTrack(event.track);
      friend.video.play().catch(() => {});
    };
    pc.ondatachannel = (event) => {
      const channel = event.channel;
      if (channel.label === 'input') {
        channel.binaryType = 'arraybuffer';
        friend.input = channel;
      } else if (channel.label === 'control') {
        friend.control = channel;
        channel.onopen = () => {
          clearTimeout(friend.joinTimer);
          channel.send(JSON.stringify({ view: friend.view }));
          emit('friend', { state: 'playing', host: friend.hostName });
        };
        channel.onmessage = (message) => onHostControl(message.data);
      }
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) HaloNet.coopSignal(friend.hostId, { kind: 'candidate', candidate: event.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (friend.pc !== pc) return;
      if (pc.connectionState === 'failed') {
        emit('friend', { state: 'failed', host: friend.hostName, reason: `The connection to ${friend.hostName} failed.` });
      }
    };
    await pc.setRemoteDescription({ type: 'offer', sdp });
    for (const candidate of friend.pendingCandidates.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    HaloNet.coopSignal(friend.hostId, { kind: 'answer', sdp: pc.localDescription.sdp });
    clearInterval(friend.timer);
    friend.timer = setInterval(sendInput, 16);
    clearInterval(friend.pingTimer);
    friend.pingTimer = setInterval(() => {
      if (friend.control && friend.control.readyState === 'open') friend.control.send(JSON.stringify({ ping: performance.now() }));
    }, 1000);
  }

  function onHostControl(data) {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (typeof message.pong === 'number') {
      const rtt = performance.now() - message.pong;
      emit('friend', { state: 'playing', host: friend.hostName, rtt: Math.round(rtt) });
      friend.control.send(JSON.stringify({ rtt }));
    }
    if (Array.isArray(message.rumble)) HaloInput.rumbleLocal(message.rumble[0], message.rumble[1], message.rumble[2]);
  }

  // this device's controls, to the host: when they change, when there is
  // aiming or a press to send, and ten times a second anyway
  function sendInput() {
    const channel = friend.input;
    if (!channel || channel.readyState !== 'open') return;
    const input = HaloInput.readLocal();
    if (!input) return;
    const now = performance.now();
    const key = input.buttons + ',' + input.axes.join(',');
    if (key === friend.last && !input.pressed && !input.lookX && !input.lookY && now - friend.lastSent < 100) return;
    friend.last = key;
    friend.lastSent = now;
    const words = new Int32Array(INPUT_WORDS);
    words[0] = ++friend.seq;
    words[1] = input.buttons | 0;
    words[2] = input.pressed | 0;
    for (let i = 0; i < 6; i++) words[3 + i] = input.axes[i] | 0;
    words[9] = input.lookX | 0;
    words[10] = input.lookY | 0;
    // (a full channel: this state is late anyway, the next one follows)
    if (channel.bufferedAmount < 16384) channel.send(words.buffer);
  }

  function setView(view) {
    friend.view = view;
    if (friend.control && friend.control.readyState === 'open') friend.control.send(JSON.stringify({ view }));
  }

  function leave() {
    if (friend.hostId) HaloNet.coopSignal(friend.hostId, { kind: 'leave' }).catch(() => {});
    clearInterval(friend.timer);
    clearInterval(friend.pingTimer);
    clearTimeout(friend.joinTimer);
    try { friend.pc && friend.pc.close(); } catch { /* closed */ }
    friend.pc = null;
    friend.hostId = null;
  }

  // ---------- signalling (net.js 'coop' messages)

  HaloNet.on((type, detail) => {
    if (type !== 'coop') return;
    const { from, name, data } = detail;
    if (data.kind === 'join') {
      if (!host.enabled) HaloNet.coopSignal(from, { kind: 'refuse', reason: 'not hosting' });
      else if (host.guest && host.guest.id !== from) HaloNet.coopSignal(from, { kind: 'refuse', reason: 'busy' });
      else {
        if (host.guest) endGuest(null);
        startGuest(from, name).catch((error) => {
          emit('message', 'Co-op could not start: ' + error.message);
          endGuest(null);
        });
      }
    } else if (data.kind === 'answer' && host.guest && host.guest.id === from && typeof data.sdp === 'string') {
      host.guest.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp }).then(async () => {
        for (const candidate of host.guest.pending.splice(0)) await host.guest.pc.addIceCandidate(candidate).catch(() => {});
      }).catch(() => {});
    } else if (data.kind === 'candidate' && data.candidate) {
      if (host.guest && host.guest.id === from) {
        if (host.guest.pc.remoteDescription) host.guest.pc.addIceCandidate(data.candidate).catch(() => {});
        else host.guest.pending.push(data.candidate);
      } else if (friend.hostId === from) {
        if (friend.pc && friend.pc.remoteDescription) friend.pc.addIceCandidate(data.candidate).catch(() => {});
        else friend.pendingCandidates.push(data.candidate);
      }
    } else if (data.kind === 'leave' && host.guest && host.guest.id === from) {
      endGuest(`${host.guest.name} left co-op.`);
    } else if (data.kind === 'offer' && friend.hostId === from && typeof data.sdp === 'string') {
      onHostOffer(data.sdp).catch((error) => emit('friend', { state: 'failed', host: friend.hostName, reason: error.message }));
    } else if (data.kind === 'refuse' && friend.hostId === from) {
      emit('friend', { state: 'failed', host: friend.hostName,
        reason: data.reason === 'busy' ? `${friend.hostName} already has a player 2.` : `${friend.hostName} is not hosting co-op now.` });
    } else if (data.kind === 'end' && friend.hostId === from) {
      emit('friend', { state: 'ended', host: friend.hostName, reason: `${friend.hostName} ended co-op.` });
    }
  });

  function on(listener) {
    listeners.add(listener);
  }

  function configure(options) {
    if (options.audio) host.audio = options.audio;
    if (options.splitViews) host.splitViews = options.splitViews;
  }

  return { setHosting, frame, viewFrame, fullViews, join, leave, setView, on, configure, hostStatus,
    get hosting() { return host.enabled; }, get streaming() { return !!(host.guest && host.guest.connected); } };
})();
