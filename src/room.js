// room.js — Durable Object: one Match It room, keyed by its 6-digit code
// (env.ROOMS.idFromName(code)). WebSocket Hibernation API throughout, same pattern
// as Answer It / Find It, so an idle room costs nothing between messages.
//
// Room lifecycle: lobby -> playing (round loop) -> matched, or host `end` -> lobby.
// No timers, no scoring: a round only advances once every active player has
// submitted, and the only outcome that ends the game is unanimous match (or the
// host force-ending it).

import { checkMatch, groupWords, newPlayerId } from "./game-core.js";

const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours idle — same alarm pattern as Answer It
// A socket nobody has heard from in this long is treated as gone. Clients ping
// every 20s; a phone that lost signal or locked its screen often never sends
// a close, and without this the round would wait on that ghost forever.
const DEFAULT_STALE_SOCKET_MS = 90 * 1000;
const MAX_PLAYERS = 16; // friend-group scale; keeps a publicly shared link from turning into a flood

// Close codes the client treats as final — stop auto-reconnecting.
export const CLOSE_ROOM_NOT_FOUND = 4404;
export const CLOSE_ROOM_FULL = 4409;
export const CLOSE_KICKED = 4403;

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
    // Idle for 2h straight -> let the room go, so its code can be issued again.
    await this.state.storage.deleteAll();
  }

  // ---- HTTP entry (upgrade to WS, or the one-time /create) ------------------

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/create") && request.method === "POST") {
      // A live room already owns this code: tell the Worker to roll another
      // one rather than dropping a second group into someone else's room.
      if (await this.loadRoom()) {
        return new Response(JSON.stringify({ error: "code_taken" }), { status: 409 });
      }
      const { code } = await request.json();
      const room = this.freshRoom(code);
      await this.saveRoom(room);
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
      history: [], // [{ round, words: {id: word}, names: {id: nickname}, groups: [[id]], matched }]
      submissions: {}, // this round's in-progress words, {id: word}
    };
  }

  // ---- WebSocket lifecycle ---------------------------------------------------

  async handleSocketUpgrade(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 400 });
    }

    const url = new URL(request.url);
    const nickname = (url.searchParams.get("nickname") || "").trim().slice(0, 24) || "Player";
    const requestedId = url.searchParams.get("pid");
    const playerId = requestedId && /^p_[0-9a-f]{12}$/.test(requestedId) ? requestedId : newPlayerId();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Refusals still go over an accepted socket: a failed HTTP upgrade is
    // indistinguishable from a network drop in the browser, so the client
    // would just retry forever. A close code it recognises lets it give up.
    const room = await this.loadRoom();
    const refusal = !room
      ? { code: "room_not_found", message: "That room doesn't exist (or has expired).", close: CLOSE_ROOM_NOT_FOUND }
      : !room.players[playerId] && Object.keys(room.players).length >= MAX_PLAYERS
        ? { code: "room_full", message: `That room is full (${MAX_PLAYERS} max).`, close: CLOSE_ROOM_FULL }
        : null;
    if (refusal) {
      server.accept();
      this.sendTo(server, { type: "error", code: refusal.code, message: refusal.message });
      server.close(refusal.close, refusal.code);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Hibernatable accept: the DO can evict from memory between messages and
    // still find this socket again via state.getWebSockets().
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ playerId, lastSeen: Date.now() });

    const existing = room.players[playerId];
    if (existing) {
      existing.connected = true;
      existing.nickname = nickname;
    } else {
      room.players[playerId] = {
        id: playerId,
        nickname,
        role: room.status === "lobby" ? "player" : "spectator",
        connected: true,
      };
    }
    if (!room.players[room.hostId]) room.hostId = playerId;

    // Everyone reconnects at once after a restart; clear out whoever didn't.
    this.markOrphansDisconnected(room);
    const revealPayload = room.status === "playing" ? this.finalizeRoundIfComplete(room) : null;

    await this.saveRoom(room);

    this.sendTo(server, { type: "welcome", playerId, code: room.code });
    if (revealPayload) await this.broadcastReveal(room, revealPayload);
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
    ws.serializeAttachment({ ...attachment, lastSeen: Date.now() });

    // Pings double as the room's heartbeat: while anyone is still here, each
    // one sweeps out sockets that have gone silent.
    if (data.type === "ping") {
      this.sendTo(ws, { type: "pong", t: data.t, serverNow: Date.now() });
      await this.sweepStaleSockets();
      return;
    }

    const room = await this.loadRoom();
    if (!room) return;
    const player = room.players[playerId];
    if (!player) return;
    const isHost = playerId === this.effectiveHost(room);

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
        if (!isHost || room.status !== "lobby") break;
        const activeIds = this.activePlayerIds(room);
        if (activeIds.length < 2) {
          this.sendTo(ws, {
            type: "error",
            code: "not_enough_players",
            message: "Need at least 2 players to start.",
          });
          break;
        }
        // Anyone who wandered off during the lobby is dropped rather than left
        // as a grey row for the whole game; reconnecting rejoins as a watcher.
        for (const p of Object.values(room.players)) {
          if (!p.connected) delete room.players[p.id];
        }
        if (!room.players[room.hostId]) room.hostId = playerId;
        room.status = "playing";
        room.round = 1;
        room.history = [];
        room.submissions = {};
        changed = true;
        break;
      }

      case "submit": {
        if (room.status !== "playing" || player.role !== "player") break;
        const word = String(data.word || "").trim().slice(0, 40);
        if (!word) break;
        // One word per round — no peeking at the count and changing your mind.
        if (room.submissions[playerId] !== undefined) break;

        room.submissions[playerId] = word;
        changed = true;
        revealPayload = this.finalizeRoundIfComplete(room);
        break;
      }

      case "end": {
        if (!isHost) break;
        if (room.status === "playing" || room.status === "matched") {
          room.status = "lobby";
          room.round = 0;
          room.submissions = {};
          changed = true;
        }
        break;
      }

      case "rematch": {
        if (!isHost) break;
        room.status = "lobby";
        room.round = 0;
        room.history = [];
        room.submissions = {};
        for (const p of Object.values(room.players)) p.role = "player";
        changed = true;
        break;
      }

      case "kick": {
        if (!isHost) break;
        const targetId = data.playerId;
        if (targetId && targetId !== playerId && room.players[targetId]) {
          delete room.players[targetId];
          if (room.hostId === targetId) room.hostId = playerId;
          delete room.submissions[targetId];
          for (const sock of this.socketsFor(targetId)) {
            this.sendTo(sock, { type: "error", code: "kicked", message: "The host removed you from the room." });
            try { sock.close(CLOSE_KICKED, "kicked"); } catch {}
          }
          changed = true;
          // The round may have been waiting on exactly this player.
          if (room.status === "playing") revealPayload = this.finalizeRoundIfComplete(room);
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
        if (room.status === "playing") revealPayload = this.finalizeRoundIfComplete(room);
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
    await this.reconcileConnections([ws]);
  }

  async sweepStaleSockets() {
    const limit = Number(this.env.STALE_SOCKET_MS) || DEFAULT_STALE_SOCKET_MS;
    const cutoff = Date.now() - limit;
    const stale = this.state.getWebSockets().filter((sock) => {
      const att = sock.deserializeAttachment();
      if (!att) return false;
      // Sockets accepted before heartbeats existed have no timestamp yet:
      // start their clock now rather than dropping them unseen.
      if (att.lastSeen === undefined) {
        sock.serializeAttachment({ ...att, lastSeen: Date.now() });
        return false;
      }
      return att.lastSeen < cutoff;
    });
    for (const sock of stale) {
      try { sock.close(4000, "stale"); } catch {}
    }
    await this.reconcileConnections(stale);
  }

  // Sync half of reconcileConnections: flags connected players with no live
  // socket. Returns whether anything changed.
  markOrphansDisconnected(room, closing = []) {
    const live = new Set();
    for (const sock of this.state.getWebSockets()) {
      if (closing.includes(sock)) continue;
      const att = sock.deserializeAttachment();
      if (att && att.playerId) live.add(att.playerId);
    }
    let changed = false;
    for (const player of Object.values(room.players)) {
      if (player.connected && !live.has(player.id)) {
        player.connected = false;
        changed = true;
      }
    }
    return changed;
  }

  // A player is connected iff they have a live socket. Brings stored state in
  // line with that — `closing` are sockets on their way out that still show
  // up in getWebSockets(). Also catches players whose socket vanished without
  // a close event at all (a deploy or runtime restart drops every socket),
  // who would otherwise sit "connected" forever and block the round.
  async reconcileConnections(closing = []) {
    const room = await this.loadRoom();
    if (!room) return;
    if (!this.markOrphansDisconnected(room, closing)) return;
    // Host isn't reassigned here: a refresh closes the old socket before the
    // new one opens, and the room's creator shouldn't lose host to a reload.
    // effectiveHost() lets someone else act while they're away.

    // A disconnect can be the thing that completes a round that was only
    // waiting on this player's word — recheck, same as a real submission.
    const revealPayload = room.status === "playing" ? this.finalizeRoundIfComplete(room) : null;

    await this.saveRoom(room);
    if (revealPayload) await this.broadcastReveal(room, revealPayload);
    await this.broadcastState(room, closing);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  // ---- helpers ----------------------------------------------------------

  // Who can act as host right now: the room's owner (creator, or whoever it
  // was handed to on leave) when connected, otherwise the longest-standing
  // connected player. The owner gets control back when they reconnect.
  effectiveHost(room) {
    const owner = room.players[room.hostId];
    if (owner && owner.connected) return owner.id;
    const next = Object.values(room.players).find((p) => p.connected);
    return next ? next.id : room.hostId;
  }

  // Open sockets belonging to a player.
  socketsFor(playerId) {
    return this.state.getWebSockets().filter((sock) => {
      const att = sock.deserializeAttachment();
      return att && att.playerId === playerId;
    });
  }

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
  // the round isn't complete yet. Called after a submission, a disconnect, a
  // leave, and a kick, since any of them can be the event that completes a round.
  finalizeRoundIfComplete(room) {
    const activeIds = this.activePlayerIds(room);
    const result = checkMatch(room.submissions, activeIds);
    if (!result.complete) return null;

    const words = Object.fromEntries(activeIds.map((id) => [id, room.submissions[id]]));
    const entry = {
      round: room.round,
      words,
      // Names frozen at reveal time, so the thread still reads right after
      // someone leaves or is kicked.
      names: Object.fromEntries(activeIds.map((id) => [id, room.players[id].nickname])),
      groups: groupWords(words),
      matched: result.matched,
    };
    room.history.push(entry);

    if (result.matched) {
      room.status = "matched";
    } else {
      room.round += 1;
    }
    room.submissions = {};
    return entry;
  }

  sendTo(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // socket gone; webSocketClose will clean up the room state
    }
  }

  async broadcastState(room, skip = []) {
    const activeIds = this.activePlayerIds(room);
    const activeCount = activeIds.length;
    // A word from someone who has since dropped doesn't count toward "N of M in".
    const submittedIds = activeIds.filter((id) => room.submissions[id] !== undefined);
    const payload = {
      type: "state",
      status: room.status,
      round: room.round,
      hostId: this.effectiveHost(room),
      players: Object.values(room.players).map((p) => ({
        id: p.id,
        nickname: p.nickname,
        role: p.role,
        connected: p.connected,
      })),
      // Who is in, never what they wrote — words only appear in history.
      submittedIds,
      submittedCount: submittedIds.length,
      activeCount,
      history: room.history,
    };
    for (const ws of this.state.getWebSockets()) if (!skip.includes(ws)) this.sendTo(ws, payload);
  }

  async broadcastReveal(room, entry) {
    const payload = { type: "reveal", ...entry, nicknames: entry.names };
    for (const ws of this.state.getWebSockets()) this.sendTo(ws, payload);
  }
}
