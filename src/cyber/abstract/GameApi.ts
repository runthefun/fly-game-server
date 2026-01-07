//const BASE_URL = "http://localhost:3001";
const BASE_URL = "https://v3-oncyber.vercel.app";
const GAME_API_URL = `${BASE_URL}/api/games/awe`;

const AWE_BASE_URL = "https://oo.gg";
const AWE_GAME_API_URL = `${AWE_BASE_URL}/api/games`;

const GAME_SERVER_KEY = process.env.GAME_SERVER_KEY;

delete process.env.GAME_SERVER_KEY;

export class GameApi {
  //
  static async loadGameData(opts: { id: string; draft?: boolean }) {
    // load concurrently from both endpoints and whoever returns first and not error wins
    return new Promise((resolve, reject) => {
      //
      let results = {
        awe: undefined,
        vibe: undefined,
      };
      let settled = false;

      const trySettle = () => {
        if (settled) return;
        // if both are null, we need to reject
        if (results.awe === null && results.vibe === null) {
          reject(new Error("failed to load game data"));
        }
        // one of them is resolved
        Object.keys(results).forEach((key) => {
          const value = results[key];
          if (value) {
            settled = true;
            resolve(value);
          }
        });
      };

      GameApi.loadGameDataAwe(opts).then(
        (aweResult) => {
          results.awe = aweResult;
          trySettle();
        },
        (err) => {
          // console.error(err);
          results.awe = null;
          trySettle();
        }
      );

      GameApi.loadGameDataVibe(opts).then(
        (vibeResult) => {
          //
          results.vibe = vibeResult;
          trySettle();
        },
        (err) => {
          // console.error(err);
          results.vibe = null;
          trySettle();
        }
      );
    });
  }

  static async loadGameDataVibe(opts: { id: string; draft?: boolean }) {
    // fetch the space here...
    const url = `${GAME_API_URL}?gameId=${opts.id}&draft=${opts.draft}`;
    // console.log("url", url);
    const reponse = await fetch(url, {
      headers: {
        "x-server-key": GAME_SERVER_KEY,
      },
    });

    if (!reponse.ok) {
      throw new Error("failed to load game data (vibe)");
    }

    const result = await reponse.json();

    return result;
  }

  static async loadGameDataAwe(opts: { id: string; draft?: boolean }) {
    // fetch the space here...
    const reponse = await fetch(
      `${AWE_GAME_API_URL}/${opts.id}?draft=${opts.draft}`,
      {
        headers: {
          "x-server-key": GAME_SERVER_KEY,
        },
      }
    );

    if (!reponse.ok) {
      throw new Error("failed to load game data");
    }

    const result = await reponse.json();

    return result;
  }

  static async auth(token: string) {
    const response = await fetch(`${GAME_API_URL}/auth/${token}`);

    if (!response.ok) {
      return null;
    }

    const result = await response.json();

    return result.data?.userId;
  }
}
