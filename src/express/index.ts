import { Response, Request } from "express";
import * as colyseus from "colyseus";
import { matchMaker } from "colyseus";
import cors from "cors";
import { playground } from "@colyseus/playground";
import { monitor } from "@colyseus/monitor";
import basicAuth from "express-basic-auth";
import { Mutex } from "async-mutex";
import { GameApi } from "../cyber/abstract/GameApi";
import { clearIdleTimeout } from "../timeout";
import { verify } from "./authMiddleware";
import { Logger } from "../logger";

const mutex = new Mutex();

const logger = new Logger("Express");

const corsOptions = {
  origin: "*",
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  preflightContinue: false,
  optionsSuccessStatus: 204,
  credentials: true,
};

const isSingleton = process.env.SINGLE_ROOM === "true";

export function initializeExpress(app: any) {
  //

  app.use(cors(corsOptions));

  app.options("*", cors(corsOptions));

  if (process.env.NODE_ENV !== "production") {
    app.use("/", playground);
  }

  app.get("/", (req: Request, res: Response) => {
    res.send("Hello world from cyber!!");
  });

  // Ensure all responses include CORS headers
  app.use((req: Request, res: Response, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Allow-Credentials", "true");
    next();
  });

  app.get("/getRoom", async (req: Request, res: Response) => {
    try {
      const data = await colyseus.matchMaker.query({
        roomId: req.query.roomId as string,
      });

      res.json({ success: true, room: data[0] });
    } catch (err) {
      res.json({
        success: false,
      });
    }
  });

  app.get("/getRooms", async (req: Request, res: Response) => {
    try {
      const data = await colyseus.matchMaker.query();

      data.sort((a, b) => {
        return b.clients - a.clients;
      });

      res.json({ success: true, rooms: data });
    } catch (err) {
      res.json({
        success: false,
      });
    }
  });

  app.post("/join", async (req: Request, res: Response) => {
    //
    clearIdleTimeout();

    try {
      if (!req.body?.gameId || !req.body?.userId) {
        //
        return res.status(400).json({
          success: false,
          message: "Invalid request",
        });
      }

      let { gameId, userId, username } = req.body;

      // token is in X-Auth-Token header
      const token = req.headers["x-auth-token"] as string;

      if (userId !== "anon") {
        //
        if (!token) {
          userId = "anon";
        } else {
          // verify token from cookie
          const decodedToken = verify(token);
          const uid = decodedToken?.uid;

          if (uid?.toLowerCase() !== userId?.toLowerCase()) {
            logger.log("uid mismatch", uid, userId);
            userId = "anon";
          }
        }
      }

      await mutex.runExclusive(async () => {
        //
        let type = "cyber-game";

        try {
          let rooms = await matchMaker.query({
            name: type,
          });

          if (!isSingleton) {
            rooms = rooms
              .filter(
                (room) =>
                  !room.private &&
                  !room.locked &&
                  room.metadata.gameId === req.body.gameId &&
                  room.clients < room.maxClients
              )
              .sort((a, b) => b.clients - a.clients);
          }

          let reservation: matchMaker.SeatReservation = null;

          if (rooms.length > 0) {
            //
            const room = rooms[0];

            if (isSingleton && room.metadata.gameId !== req.body.gameId) {
              return res.status(400).json({
                success: false,
                message: "Room is already in use",
              });
            }

            logger.log("/join existing", gameId, userId, username);

            reservation = await matchMaker.joinById(room.roomId, req.body, {});
            //
          } else {
            const roomOpts = {
              gameId: req.body.gameId,
              userId,
              username: req.body.username,
              roomType: type as string,
              gameData: null,
            };

            logger.log("/join new", gameId, userId, username);

            const gameData = await GameApi.loadGameData({
              id: req.body.gameId,
              draft: req.body.draft ?? true,
            });

            roomOpts.gameData = gameData;

            reservation = await matchMaker.create(type, roomOpts, {});
          }

          // logger.log(
          //   "reservation: ",
          //   reservation.room.roomId,
          //   reservation.sessionId
          // );

          res.json({
            success: true,
            reservation,
          });
        } catch (err) {
          //
          logger.error("/join", err, type, req.body);

          res.status(500).json({
            success: false,
            message: err?.message ?? err ?? "Unexpected Server Error",
          });
        }
      });
    } catch (err) {
      logger.error("/join", err);
      res.status(500).json({
        success: false,
        message: err?.message ?? err ?? "Unexpected Server Error",
      });
    }
  });

  const basicAuthMiddleware = basicAuth({
    users: {
      admin: process.env.MONITOR_PASSWORD,
    },
    challenge: true,
  });

  app.use(
    "/monitor",
    basicAuthMiddleware,
    monitor({
      columns: [
        "roomId",
        "name",
        "clients",
        "maxClients",
        { metadata: "gameId" },
        { metadata: "name" },
        "locked",
        "elapsedTime",
      ],
    })
  );
}
