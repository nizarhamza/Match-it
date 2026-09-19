// room.js — Durable Object: one Match It room, keyed by its 6-digit code
// (env.ROOMS.idFromName(code)). WebSocket Hibernation API throughout, same pattern
// as Answer It / Find It, so an idle room costs nothing between messages.
//
// Room lifecycle: lobby -> playing (round loop) -> matched, or host `end` -> lobby.
// No timers, no scoring: a round only advances once every active player has
// submitted, and the only outcome that ends the game is unanimous match (or the
// host force-ending it).

import { checkMatch, newPlayerId } from "./game-core.js";

const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours idle — same alarm pattern as Answer It

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // ---- storage helpers -----------------------------------------------------

  async loadRoom() {
    return (await this.state.storage.get("room")) || null;
  }

  async saveRoom(room) {
    await this.state.storage.put("room", room);
    await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  async alarm() {
    // Idle for 2h straight -> let the room go. A brand new code will be issued
    // next time someone tries to create one that collides with this (very rare).
    await this.state.storage.deleteAll();
  }

  // ---- HTTP entry (upgrade to WS, or the one-time /create) ------------------

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/create") && request.method === "POST") {
      let room = await this.loadRoom();
      if (!room) {
        const { code } = await request.json();
        room = this.freshRoom(code);
        await this.saveRoom(room);
      }
      return new Response(JSON.stringify({ code: room.code }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname.endsWith("/socket")) {
      return this.handleSocketUpgrade(request);
    }

    return new Response("not found", { status: 404 });
  }

  freshRoom(code) {
    return {
      code,
      status: "lobby", // lobby | playing | matched
      hostId: null,
      createdAt: Date.now(),
      round: 0,
      players: {}, // id -> { id, nickname, role, connected }
      history: [], // [{ round, words: {id: word}, matched: bool }]
      submissions: {}, // this round's in-progress words, {id: word}
    };
  }

  // ---- WebSocket lifecycle ---------------------------------------------------

  async handleSocketUpgrade(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 400 });
    }

    const room = await this.loadRoom();
    if (!room) {
      return new Response("room not found", { status: 404 });
    }

    const url = new URL(request.url);
    const nickname = (url.searchParams.get("nickname") || "Player").slice(0, 24);
    const requestedId = url.searchParams.get("pid");
    const playerId = requestedId && requestedId.startsWith("p_") ? requestedId : newPlayerId();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernatable accept: the DO can evict from memory between messages and
    // still find this socket again via state.getWebSockets().
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ playerId });

    const existing = room.players[playerId];
    if (existing) {
      existing.connected = true;
      if (nickname) existing.nickname = nickname;
    } else {
      room.players[playerId] = {
        id: playerId,
        nickname,
        role: room.status === "lobby" ? "player" : "spectator",
        connected: true,
      };
    }
    if (!room.hostId) room.hostId = playerId;

    await this.saveRoom(room);

    this.sendTo(server, { type: "welcome", playerId, code: room.code });
    await this.broadcastState(room);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let data;
    try {
      data = JSON.parse(typeof message === "string" ? message : "");
    } catch {
      return;
    }
    if (!data || typeof data.type !== "string") return;

    const attachment = ws.deserializeAttachment();
    const playerId = attachment && attachment.playerId;
    if (!playerId) return;

    // ping/pong needs no room state and no broadcast.
    if (data.type === "ping") {
      this.sendTo(ws, { type: "pong", t: data.t, serverNow: Date.now() });
      return;
    }

    const room = await this.loadRoom();
    if (!room) return;
    const player = room.players[playerId];
    if (!player) return;

    let changed = false;
    let revealPayload = null;

    switch (data.type) {
      case "role": {
        if (room.status === "lobby" && (data.role === "player" || data.role === "spectator")) {
          player.role = data.role;
          changed = true;
        }
        break;
      }

      case "start": {
        if (playerId !== room.hostId || room.status !== "lobby") break;
        const activeIds = this.activePlayerIds(room);
        if (activeIds.length < 2) {
          this.sendTo(ws, {
            type: "error",
            code: "not_enough_players",
            message: "Need at least 2 players to start.",
          });
          break;
        }
        room.status = "playing";
        room.round = 1;
        room.history = [];
        room.submissions = {};
        changed = true;
        break;
      }

      case "submit": {
        if (room.status !== "playing" || player.role !== "player") break;
        const word = String(data.word || "").slice(0, 40);
        if (!word.trim()) break;

        room.submissions[playerId] = word;
        changed = true;
        revealPayload = this.finalizeRoundIfComplete(room);
        break;
      }

      case "end": {
        if (playerId !== room.hostId) break;
        if (room.status === "playing" || room.status === "matched") {
          room.status = "lobby";
          room.round = 0;
          room.submissions = {};
          changed = true;
        }
        break;
      }

      case "rematch": {
        if (playerId !== room.hostId) break;
        room.status = "lobby";
        room.round = 0;
        room.history = [];
        room.submissions = {};
        for (const p of Object.values(room.players)) p.role = "player";
        changed = true;
        break;
      }

      case "kick": {
        if (playerId !== room.hostId) break;
        const targetId = data.playerId;
        if (targetId && targetId !== room.hostId && room.players[targetId]) {
          delete room.players[targetId];
          delete room.submissions[targetId];
          changed = true;
        }
        break;
      }

      case "leave": {
        delete room.players[playerId];
        delete room.submissions[playerId];
        if (room.hostId === playerId) {
          const next = Object.values(room.players).find((p) => p.connected);
          room.hostId = next ? next.id : null;
        }
        changed = true;
        break;
      }

      default:
        return;
    }

    if (!changed && !revealPayload) return;

    await this.saveRoom(room);
    if (revealPayload) await this.broadcastReveal(room, revealPayload);
    await this.broadcastState(room);
  }

  async webSocketClose(ws) {
    const attachment = ws.deserializeAttachment();
    const playerId = attachment && attachment.playerId;
    if (!playerId) return;

    const room = await this.loadRoom();
    if (!room) return;
    const player = room.players[playerId];
    if (player) player.connected = false;

    if (room.hostId === playerId) {
      const next = Object.values(room.players).find((p) => p.connected && p.id !== playerId);
      if (next) room.hostId = next.id;
    }

    // A disconnect can be the thing that completes a round that was only
    // waiting on this player's word — recheck, same as a real submission.
    const revealPayload = room.status === "playing" ? this.finalizeRoundIfComplete(room) : null;

    await this.saveRoom(room);
    if (revealPayload) await this.broadcastReveal(room, revealPayload);
    await this.broadcastState(room);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  // ---- helpers ----------------------------------------------------------

  // "Active" = who we're actually waiting on right now. A disconnected
  // player can't submit, so they must not block the round from completing —
  // otherwise a closed tab softlocks the whole room.
  activePlayerIds(room) {
    return Object.values(room.players)
      .filter((p) => p.role === "player" && p.connected)
      .map((p) => p.id);
  }

  // Checks whether every currently-active player has a submission in for this
  // round, and if so, resolves it: match -> room finishes; no match -> a
  // fresh round starts. Returns the reveal payload to broadcast, or null if
  // the round isn't complete yet. Called after both a real submission and a
  // disconnect, since either can be the event that completes a round.
  finalizeRoundIfComplete(room) {
    const activeIds = this.activePlayerIds(room);
    const result = checkMatch(room.submissions, activeIds);
    if (!result.complete) return null;

    const entry = {
      round: room.round,
      words: Object.fromEntries(activeIds.map((id) => [id, room.submissions[id]])),
      matched: result.matched,
    };
    room.history.push(entry);

    if (result.matched) {
      room.status = "matched";
    } else {
      room.round += 1;
      room.submissions = {};
    }
    return entry;
  }

  sendTo(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // socket gone; webSocketClose will clean up the room state
    }
  }

  async broadcastState(room) {
    const submittedCount = Object.keys(room.submissions || {}).length;
    const activeCount = this.activePlayerIds(room).length;
    const payload = {
      type: "state",
      status: room.status,
      round: room.round,
      hostId: room.hostId,
      players: Object.values(room.players).map((p) => ({
        id: p.id,
        nickname: p.nickname,
        role: p.role,
        connected: p.connected,
      })),
      submittedCount,
      activeCount,
      history: room.history,
    };
    for (const ws of this.state.getWebSockets()) this.sendTo(ws, payload);
  }

  async broadcastReveal(room, entry) {
    const nicknames = Object.fromEntries(
      Object.values(room.players).map((p) => [p.id, p.nickname])
    );
    const payload = { type: "reveal", ...entry, nicknames };
    for (const ws of this.state.getWebSockets()) this.sendTo(ws, payload);
  }
}
