/*
LOBBY.JS

Matchmaking without a server of our own: public rooms list themselves on the
MQTT brokers net.js finds players through, and every page lists them.

A room is public when a player in it lists it (the page's Quick Match does,
for the room it makes). Its advert is a retained message on
halo-web/v1/lobby/<room id>: the room's code (public, so anyone can join),
the host's name, the number of players, a fingerprint of the maps of the
host's copy of the game (players with other maps, a modded disc say, cannot
play together) and a note. The advert is sent again every ten seconds and
cleared (an empty retained message) when its room is left; an advert older
than a minute is ignored, since a page that closes cannot clear it.

Adverts are public and anyone can send one: the page shows their text as
text, cut to length, and a room still needs its code's key to be joined.
*/

'use strict';

const HaloLobby = (() => {
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt',
  ];
  const PREFIX = 'halo-web/v1/lobby/';
  const ADVERT_INTERVAL = 10000;
  const ADVERT_AGE = 60000;       // an advert this old is gone
  const ROOM_SILENCE = 35000;     // a room not heard from for this long is gone
  const MAX_PLAYERS = 16;

  const state = {
    brokers: [],
    rooms: new Map(),   // room id -> { code, host, players, maps, mapsLabel, note, heard }
    listeners: new Set(),
    advert: null,       // { id, build() } while this page lists a room
    advertTimer: null,
    sweepTimer: null,
  };

  // ---------- MQTT 3.1.1 over WebSockets (QoS 0), as in net.js

  function encodeLength(length) {
    const bytes = [];
    do {
      let byte = length % 128;
      length = Math.floor(length / 128);
      if (length > 0) byte |= 128;
      bytes.push(byte);
    } while (length > 0);
    return bytes;
  }

  function mqttString(text) {
    const bytes = new TextEncoder().encode(text);
    return [bytes.length >> 8, bytes.length & 255, ...bytes];
  }

  function mqttPacket(type, body) {
    return new Uint8Array([type, ...encodeLength(body.length), ...body]);
  }

  function connect(url) {
    const broker = { url, socket: null, ready: false, buffer: new Uint8Array(0), ping: null, retry: null };
    const start = () => {
      let socket;
      try {
        socket = new WebSocket(url, 'mqtt');
      } catch {
        return;
      }
      broker.socket = socket;
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        const id = 'halo-lobby-' + Math.floor(Math.random() * 1e9).toString(36);
        socket.send(mqttPacket(0x10, [...mqttString('MQTT'), 4, 0x02, 0, 60, ...mqttString(id)]));
      };
      socket.onmessage = (event) => {
        const incoming = new Uint8Array(event.data);
        const joined = new Uint8Array(broker.buffer.length + incoming.length);
        joined.set(broker.buffer);
        joined.set(incoming, broker.buffer.length);
        broker.buffer = joined;
        parse(broker);
      };
      socket.onclose = () => {
        broker.ready = false;
        clearInterval(broker.ping);
        if (state.brokers.includes(broker)) broker.retry = setTimeout(start, 8000);
      };
      socket.onerror = () => {};
    };
    start();
    return broker;
  }

  function parse(broker) {
    for (;;) {
      const bytes = broker.buffer;
      if (bytes.length < 2) return;
      let length = 0, multiplier = 1, index = 1, byte;
      do {
        if (index >= bytes.length) return;
        byte = bytes[index++];
        length += (byte & 127) * multiplier;
        multiplier *= 128;
      } while (byte & 128);
      if (bytes.length < index + length) return;
      const type = bytes[0] & 0xF0;
      const body = bytes.slice(index, index + length);
      broker.buffer = bytes.slice(index + length);
      if (type === 0x20) {
        broker.socket.send(mqttPacket(0x82, [0, 1, ...mqttString(PREFIX + '+'), 0]));
        broker.ready = true;
        broker.ping = setInterval(() => {
          if (broker.socket.readyState === 1) broker.socket.send(new Uint8Array([0xC0, 0]));
        }, 30000);
        if (state.advert) sendAdvert();
      } else if (type === 0x30) {
        const topicLength = (body[0] << 8) | body[1];
        const topic = new TextDecoder().decode(body.slice(2, 2 + topicLength));
        let offset = 2 + topicLength;
        if (bytes[0] & 0x06) offset += 2;
        received(topic.slice(PREFIX.length), body.slice(offset));
      }
    }
  }

  function send(topic, payload, retain) {
    const packet = mqttPacket(retain ? 0x31 : 0x30, [...mqttString(topic), ...payload]);
    for (const broker of state.brokers) {
      if (broker.ready && broker.socket.readyState === 1) broker.socket.send(packet);
    }
  }

  // ---------- adverts

  const text = (value, length) => String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, '').trim().slice(0, length);

  function received(id, payload) {
    if (!/^[0-9a-f]{8,32}$/.test(id)) return;
    if (!payload.length) {
      if (state.rooms.delete(id)) emit();
      return;
    }
    let advert;
    try {
      advert = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return;
    }
    if (!advert || advert.v !== 1 || typeof advert.ts !== 'number' || Date.now() - advert.ts > ADVERT_AGE) return;
    const code = text(advert.code, 16).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) return;
    state.rooms.set(id, {
      id,
      code,
      host: text(advert.host, 24) || 'Player',
      players: Math.max(1, Math.min(MAX_PLAYERS, parseInt(advert.players, 10) || 1)),
      maps: text(advert.maps, 16),
      mapsLabel: text(advert.mapsLabel, 40),
      note: text(advert.note, 48),
      heard: Date.now(),
    });
    emit();
  }

  function sweep() {
    let changed = false;
    for (const [id, room] of state.rooms) {
      if (Date.now() - room.heard > ROOM_SILENCE) {
        state.rooms.delete(id);
        changed = true;
      }
    }
    if (changed) emit();
  }

  function sendAdvert() {
    if (!state.advert) return;
    const advert = { v: 1, ts: Date.now(), ...state.advert.build() };
    send(PREFIX + state.advert.id, new TextEncoder().encode(JSON.stringify(advert)), true);
  }

  function emit() {
    for (const listener of state.listeners) listener(rooms());
  }

  // ---------- the page's interface

  function start(options = {}) {
    if (state.brokers.length) return;
    const brokers = options.brokers && options.brokers.length ? options.brokers : BROKERS;
    state.brokers = brokers.map(connect);
    state.sweepTimer = setInterval(sweep, 5000);
  }

  // the rooms listed, most players first
  function rooms() {
    return [...state.rooms.values()].sort((a, b) => b.players - a.players || b.heard - a.heard);
  }

  // an id for a room's advert: its code's hash (the same for everyone)
  async function roomId(code) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('halo-web-lobby-v1:' + code)));
    return Array.from(digest.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // list a room: build() gives { code, host, players, maps, mapsLabel, note }
  async function advertise(code, build) {
    await withdraw();
    state.advert = { id: await roomId(code), build };
    sendAdvert();
    state.advertTimer = setInterval(sendAdvert, ADVERT_INTERVAL);
  }

  async function withdraw() {
    if (!state.advert) return;
    clearInterval(state.advertTimer);
    send(PREFIX + state.advert.id, new Uint8Array(0), true);
    state.rooms.delete(state.advert.id);
    state.advert = null;
    emit();
  }

  function refresh() {
    sendAdvert();
  }

  function on(listener) {
    state.listeners.add(listener);
  }

  // a short fingerprint of a copy of the game's maps: players need the same
  async function mapsFingerprint(game) {
    if (!game) return '';
    const names = (game.files || []).map((name) => name.toLowerCase()).sort().join('|');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(names + '#' + game.bytes)));
    return Array.from(digest.slice(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  return { start, rooms, advertise, withdraw, refresh, on, mapsFingerprint, isListing: () => !!state.advert, MAX_PLAYERS };
})();
