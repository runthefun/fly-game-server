import { EventEmitter } from "events";
import { type IncomingMessage } from "http";
import { GameLoop } from "./GameLoop";
import {
  CYBER_MSG,
  PLAYER_ROLES,
  PlayerRole,
  Messages,
  GameActions,
  ClientMessage,
  PlayerData,
  PongMsg,
  PlayerStatePayload,
  RpcHandler,
  NetStateEventPayload,
  NetStateEventMsg,
  NetStateSnapshotMsg,
} from "./types";
import { NetState, RoomState } from "../schema/RoomState";
import { calcLatencyIPDTV } from "./utils";
import { PlayerState } from "../schema/PlayerState";
import type { SpaceProxy } from "../ServerSpace/thread/SpaceProxy";
import { Logger } from "../../logger";

const defaults = {
  autoStart: false,
  serverEngine: false,
  authoritativePosition: false,
  reconnectTimeout: 0,
  patchRate: 20, // fps
  tickRate: 20, // fps
  maxPlayers: 500,
};

export type RoomParams = typeof defaults;

const mins = {
  reconnectTimeout: 0,
  patchRate: 1,
  tickRate: 1,
  maxPlayers: 2,
};

const maxs = {
  reconnectTimeout: 60,
  patchRate: 20,
  tickRate: 60,
  maxPlayers: 500,
};

function setMinMax(value: number, def: number, min: number, max: number) {
  // if not a number or NaN, return default
  if (typeof value !== "number" || value !== value) {
    return def;
  }
  return Math.min(Math.max(value, min), max);
}

export interface GameRoomCtx {
  gameId: string;
  gameData: any;

  sendMsg: (type: any, msg: any, sessionId: string) => void;
  broadcastMsg: (type: any, msg: any, options?: { except?: string[] }) => void;
  onMsg(type: any, callback: (msg: any, sessionId: string) => void): () => void;

  disconnectPlayer: (sessionId: string) => void;
  nbConnected: number;
  setState: (state: any) => void;
  disconnect: () => void;

  get logger(): Logger;
}

export const EVENTS = {
  //
  join: "join",
  leave: "leave",
  message: "message",
  dispose: "dispose",
} as const;

export type RoomEvent = keyof typeof EVENTS;

export abstract class GameSession<
  State extends RoomState = RoomState,
  ClientMsg = any,
  RoomMsg = any
> {
  private _emitter = new EventEmitter();

  private _gameLoop = new GameLoop();

  Schema: any = class extends RoomState {};

  state: State;

  tickRate = defaults.tickRate;

  patchRate = defaults.patchRate;

  simulatedLatency?: number;

  maxPlayers = 500;

  pingInterval = 5000;

  autoStart = false;

  joinAfterStart = true;

  reconnectTimeout = 0;

  serverEngine = {
    enabled: false,
  };

  authoritativePosition = false;

  spaceProxy: SpaceProxy = null;

  spawn: any = null;

  constructor(public ctx: GameRoomCtx) {
    //
    this.ctx.onMsg(CYBER_MSG, this._CALLBACKS_.cyberMsg);

    (this.ctx as any).onMessage("*", (client, type, message) => {
      this.spaceProxy?.onMessage(type, message, client.sessionId);
    });
  }

  get logger() {
    return this.ctx.logger;
  }

  on(event: RoomEvent, cb: (...args: any[]) => void): () => void {
    //
    this._emitter.on(event, cb);

    return () => {
      this._emitter.off(event, cb);
    };
  }

  off(event: RoomEvent, cb: (...args: any[]) => void) {
    this._emitter.off(event, cb);
  }

  get gameId() {
    return this.ctx.gameId;
  }

  get gameData() {
    return this.ctx.gameData;
  }

  get status() {
    return this._gameLoop.status;
  }

  startGame(countdownSecs: number) {
    this.logger.log("Starting game in", countdownSecs, "seconds");
    const countdownMillis = countdownSecs * 1000;

    // notift all players after countdown, take into account player's latency
    this.state.players.forEach((player) => {
      const latency = player.latency ?? 0;
      const delay = Math.max(0, countdownMillis - latency);
      this.ctx.sendMsg(
        CYBER_MSG,
        {
          type: Messages.ROOM_GAME_ACTION,
          action: GameActions.START,
          data: delay / 1000,
        },
        player.sessionId
      );
    });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        //
        this._gameLoop.start();
        this.spaceProxy?.startGame();
        resolve();
      }, countdownMillis);
    });
  }

  stopGame() {
    this._gameLoop.stop();
    this.spaceProxy?.stopGame();
    this.ctx.broadcastMsg(CYBER_MSG, {
      type: Messages.ROOM_GAME_ACTION,
      action: GameActions.STOP,
    });
  }

  disconnectPlayer(sessionId: string) {
    this.ctx.disconnectPlayer(sessionId);

    this._CALLBACKS_.leave(sessionId);
  }

  private _pendingPings = {} as Record<
    string,
    { time: number; sessionId: string }
  >;

  private _autoInc = 1;

  _PING_ = {
    _timeouts: {} as Record<string, NodeJS.Timeout>,

    _LATENCY_BUFFER_SIZE: 10,

    // buffer of last pings
    _latencyBuffer: {} as Record<string, number[]>,

    _clearPingLoop: (sessionId: string) => {
      const timeout = this._PING_._timeouts[sessionId];

      if (timeout) {
        delete this._PING_._timeouts[sessionId];

        clearTimeout(timeout);
      }
    },

    _clearAllPingLoops: () => {
      Object.values(this._PING_._timeouts).forEach((timeout) => {
        this._PING_._clearPingLoop(timeout.toString());
      });
    },

    _pingLoop: (sessionId: string) => {
      //
      const playerData = this._getPlayer(sessionId);

      if (playerData == null) {
        return;
      }

      let pingInterval = this._gameLoop.isRunning ? this.pingInterval : 1000;

      this._PING_._sendPing(playerData);

      this._PING_._timeouts[sessionId] = setTimeout(() => {
        //
        this._PING_._pingLoop(sessionId);
      }, pingInterval);
    },

    _sendPing: async (playerData: PlayerData) => {
      //
      const pingId = this._autoInc++;

      this._pendingPings[pingId] = {
        time: Date.now(),
        sessionId: playerData.sessionId,
      };

      this.ctx.sendMsg(
        CYBER_MSG,
        { type: Messages.PING, data: pingId },
        playerData.sessionId
      );
    },

    _onPong: (msg: PongMsg, sessionId: string) => {
      //
      const pingId = msg.data;

      const pending = this._pendingPings[pingId];

      if (pending == null || pending.sessionId !== sessionId) {
        this.logger.error("No pending ping for player", sessionId);
        return;
      }

      const playerData = this._getPlayer(sessionId);

      if (playerData == null) {
        return;
      }

      // add to latency buffer
      let buffer = this._PING_._latencyBuffer[sessionId];

      if (buffer == null) {
        buffer = this._PING_._latencyBuffer[sessionId] = [];
      }

      buffer.push((Date.now() - pending.time) / 2);

      if (buffer.length > this._PING_._LATENCY_BUFFER_SIZE) {
        buffer.shift();
      }

      const { latency, jitter } = calcLatencyIPDTV(buffer);

      playerData.latency = latency;
      playerData.jitter = jitter;

      // playerData.latency = (Date.now() - pending.time) / 2;

      delete this._pendingPings[playerData.sessionId];
    },
  };

  private _getPlayer(sessionId: string) {
    //
    const player = this.state.players.get(sessionId);

    if (player == null) {
      this.logger.error("Player not found", sessionId);
    }

    return player;
  }

  sendCyberMsg(msg: any, sessionId: string) {
    this.ctx.sendMsg(CYBER_MSG, msg, sessionId);
  }

  sendRpcMsg(msg: any, sessionId: string) {
    this.sendCyberMsg({ type: Messages.RPC, ...msg }, sessionId);
  }

  broadcastCyberMsg(msg: any, options?: { except?: string[] }) {
    this.ctx.broadcastMsg(CYBER_MSG, msg, options);
  }

  broadcastRpcMsg(msg: any, options?: { except?: string[] }) {
    this.broadcastCyberMsg({ type: Messages.RPC, ...msg }, options);
  }

  /**
   * internal callbacks
   */
  _CALLBACKS_ = {
    create: async () => {
      //
      this.spawn = this.gameData.components["spawn"];

      const mulitplayer = this.gameData.components["multiplayer"] ?? {};

      let settings = Object.assign({}, defaults, mulitplayer);

      this.serverEngine.enabled =
        settings.serverEngine ?? defaults.serverEngine;
      this.autoStart = settings.autoStart && defaults.autoStart;
      this.authoritativePosition =
        settings.authoritativePosition ?? defaults.authoritativePosition;

      this.maxPlayers = setMinMax(
        settings.maxPlayers,
        defaults.maxPlayers,
        mins.maxPlayers,
        maxs.maxPlayers
      );
      this.patchRate = setMinMax(
        settings.patchRate,
        defaults.patchRate,
        mins.patchRate,
        maxs.patchRate
      );
      this.reconnectTimeout = setMinMax(
        settings.reconnectTimeout,
        defaults.reconnectTimeout,
        mins.reconnectTimeout,
        maxs.reconnectTimeout
      );

      if (this.serverEngine.enabled) {
        //
        const noServerSpace = process.env.NO_SERVER_SIDE_PHYSICS;

        if (noServerSpace) {
          //
          this.logger.error(
            "Server side physics is disabled in this environment"
          );
        } else {
          //
          const SpaceProxy =
            require("../ServerSpace/thread/SpaceProxy").SpaceProxy;
          this.spaceProxy = new SpaceProxy();

          try {
            // We must run the server space, so that the space scripts
            // can attach their schemas to the room state
            this.logger.log("Server simulation enabled. Creating server space");

            await this.spaceProxy.init({
              session: this,
              debugPhysics: true,
              isDraft: true,
            });

            this.logger.log("Server space created");
          } catch (e) {
            //
            this.logger.error("Error creating server space", e);
            throw e;
          }
        }
      }

      await this.onPreload();

      this.state ??= new this.Schema();
      (this as any).ctx.setState(this.state);

      const tickRate = this.tickRate || defaults.tickRate;
      const patchRate = this.patchRate || defaults.patchRate;
      this._gameLoop.tickRate = tickRate;
      this.state.settings.reconnectTimeout = this.reconnectTimeout;
      this.state.settings.tickRate = tickRate;
      this.state.settings.patchRate = patchRate;

      await this.spaceProxy?.sync({
        state: this.state.toJSON(),
        params: {
          authoritativePosition: this.authoritativePosition,
          maxPlayers: this.maxPlayers,
          tickRate,
          patchRate,
        },
      });

      this.state.stats.start();

      this.logger.log("Room created", this.gameId);
    },

    join: async (params: object) => {
      //
      const playerData = this.getPlayerData(params);
      this.validateJoin(playerData);
      this._emitter.emit(EVENTS.join, playerData);
      //
      if (this.authoritativePosition && this.spawn) {
        //
        playerData.position = structuredClone(this.spawn.position);
        playerData.rotation = structuredClone(this.spawn.rotation);
      }
      //
      const player = this.state.addPlayer(playerData);
      await Promise.resolve(this.onJoin(player));
      this.spaceProxy?.onJoin(player.toJSON());
      // send ping to client to measure latency
      this._PING_._pingLoop(playerData.sessionId);
      this.logger.log("player joined", playerData.sessionId);
    },

    disconnect: (sessionId: string) => {
      //
      const player = this._getPlayer(sessionId);

      if (player != null) {
        player.connected = false;
      }

      return this.reconnectTimeout;
    },

    reconnect: (sessionId: string) => {
      //
      const player = this._getPlayer(sessionId);

      if (player != null) {
        player.connected = true;
      }
    },

    leave: async (sessionId: string) => {
      //
      const player = this.state.players.get(sessionId);
      if (player == null) {
        this.logger.error("Player not found", sessionId);
        return;
      }

      this.logger.log("player left", sessionId);

      this._PING_._clearPingLoop(sessionId);

      this.state.removePlayer(sessionId);

      if (player.role === PLAYER_ROLES.host) {
        const newManager = this.state.players.values().next().value;

        if (newManager) {
          newManager.role = PLAYER_ROLES.host;
        }
      }

      this.onLeave(player);
      this.spaceProxy?.onLeave(player);
      this._emitter.emit(EVENTS.leave, player);
    },

    prevTimestamp: Date.now(),

    beforePatch: () => {
      //
      this.spaceProxy?.onBeforePatch();
      this.state.snapshotId = Math.random().toString(36).substring(2, 7);
      this.state.timestamp = Date.now();
    },

    cyberMsg: (message: ClientMessage<any>, sessionId: string) => {
      // compat for broadcast/send messages
      // that were sent as GAME_MESSAGE type

      if (message.type === Messages.RPC) {
        let handlers = this._rpcRecipients[message.rpcId];

        if (handlers != null) {
          //
          handlers.forEach((handler) => {
            handler(message, sessionId);
          });
        }
      } else if (message.type === Messages.PONG) {
        //
        this._PING_._onPong(message, sessionId);
        //
      } else {
        //
        const msg = message;

        const player = this.state.players.get(sessionId);

        if (player == null) {
          this.logger.error(`Player ${sessionId} not found`);
          return;
        }

        // this.logInfo("message", message, msg.type, msg.type == ClientProtocol.GAME_REQUEST)
        if (msg.type == Messages.PLAYER_STATE) {
          // player state message
          const [
            posX,
            posY,
            posZ,
            rotX,
            rotY,
            rotZ,
            animation,
            scale,
            vrmUrl,
            text,
            input,
          ] = msg.data;

          const payload: PlayerStatePayload = {
            position: { x: posX, y: posY, z: posZ },
            rotation: { x: rotX, y: rotY, z: rotZ },
            animation,
            scale,
            vrmUrl,
            text,
            input,
            extra: null, // for now
          };

          this.onPlayerStateMsg(payload, player);

          this.spaceProxy?.onPlayerState(player.toJSON());
          //
        } else if (msg.type === Messages.NET_STATE_EVENT) {
          //
          this.onNetStateEventMsg(msg, player);
        } else if (msg.type === Messages.NET_STATE_SNAPSHOT) {
          //
          this.onNetStateSnapshotMsg(msg, player);
        } else if (msg.type == Messages.GAME_MESSAGE) {
          //
          this.onMessage(msg.data, player);

          // this.broadcastMsg({ type: "state", state: this.room.state })
        } else if (msg.type == Messages.GAME_REQUEST) {
          //
          switch (msg.action) {
            case GameActions.START:
              this.onRequestStart(msg.data);
              break;
          }
        } else {
          //
          this.logger.error("Unknown message type", (msg as any).type);
        }
      }
    },

    shutdown: () => {
      //
      this._PING_._clearAllPingLoops();
      this.state.stats.stop();
      this._gameLoop.stop();
      this.spaceProxy?.dispose();
      this.onDispose();
    },
  };

  getPlayerData(params: object): PlayerData {
    //
    let id = params["id"];
    let userId = params["userId"] ?? "anon";
    let name = params["username"] ?? "Anonymous";
    let avatarUrl = params["avatarUrl"] ?? "";
    let vrmUrl = params["vrmUrl"] ?? "";
    let isAnonymous = params["isAnonymous"] ?? true;
    let role: PlayerRole = PLAYER_ROLES.player;

    if (this.state.players.size === 0) {
      role = PLAYER_ROLES.host;
    }

    return {
      sessionId: id,
      userId,
      name,
      avatarUrl,
      vrmUrl,
      isAnonymous,
      role,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: 1,
      animation: "idle",
      latency: 0,
      jitter: 0,
      plugins: "",
      text: "",
    };
  }

  validateJoin(playerData: PlayerData) {
    try {
      if (!this.joinAfterStart && this.status != "idle") {
        throw new Error("Game already started");
      }

      const nbPlayers = this.state.players.size;

      if (nbPlayers >= this.maxPlayers) {
        throw new Error("Room is full " + nbPlayers + " >= " + this.maxPlayers);
      }
    } catch (e) {
      this.logger.error("validateJoin", e);
      throw e;
    }
  }

  async onPreload() {}

  static async onAuth(token: string, request: IncomingMessage) {}

  onJoin(player: PlayerData) {}

  onLeave(player: PlayerData) {}

  onPlayerStateMsg(payload: PlayerStatePayload, player: PlayerState) {
    //
    const excludeTransform = this.authoritativePosition;

    player.update(payload, {
      position: excludeTransform,
      rotation: excludeTransform,
    });
  }

  onNetStateEventMsg(msg: NetStateEventMsg, player: PlayerData) {
    //
    // console.log("onNetStateEventMsg", msg);
    let netState = this.state.netStates.get(msg.id);

    if (netState == null) {
      netState = new NetState();
      netState.id = msg.id;
      this.state.netStates.set(msg.id, netState);
    }

    netState.addEvents(msg.events, player.sessionId);
  }

  onNetStateSnapshotMsg(msg: NetStateSnapshotMsg, player: PlayerData) {
    //
    // console.log("onNetStateSnapshotMsg", msg);
    let netState = this.state.netStates.get(msg.id);
    if (netState == null) {
      netState = new NetState();
      netState.id = msg.id;
      this.state.netStates.set(msg.id, netState);
    }
    netState.applySnapshot(msg.snapshot);
  }

  onMessage(msg: ClientMsg, player: PlayerData) {
    //

    let message = msg as any;

    if (message.type === "broadcast" || message.type === "@awe/broadcast") {
      //
      const { exclude, ...data } = message;

      if (
        exclude &&
        (!Array.isArray(exclude) ||
          exclude.some((sessionId) => typeof sessionId !== "string"))
      ) {
        this.logger.warn("invalid exclude argument");
        return;
      }

      this.ctx.broadcastMsg(
        CYBER_MSG,
        {
          type: Messages.ROOM_MESSAGE,
          data,
        },
        { except: exclude }
      );
    } else if (message.type === "send") {
      //
      if (
        message.playerId &&
        typeof message.playerId === "string" &&
        this.state.players.has(message.playerId)
      ) {
        this.ctx.sendMsg(
          CYBER_MSG,
          {
            type: Messages.ROOM_MESSAGE,
            data: message.data,
          },
          message.playerId
        );
      }
    } else if (message.type === "@awe/relay") {
      //
      const { target, ...data } = message;
      if (
        target &&
        typeof target === "string" &&
        this.state.players.has(target)
      ) {
        this.ctx.sendMsg(
          CYBER_MSG,
          {
            type: Messages.ROOM_MESSAGE,
            data,
          },
          target
        );
      }
    }
  }

  private _rpcRecipients: Record<string, Set<RpcHandler>> = {};

  onRpc(rpcId: string, handler: RpcHandler) {
    if (this._rpcRecipients[rpcId] == null) {
      this._rpcRecipients[rpcId] = new Set();
    }

    this._rpcRecipients[rpcId].add(handler);

    return () => {
      this._rpcRecipients[rpcId].delete(handler);
    };
  }

  onRequestStart(data: any) {
    this.startGame(data.countdown ?? 0);
  }

  onUpdate(dt: number) {}

  onDispose() {
    //
  }
}
