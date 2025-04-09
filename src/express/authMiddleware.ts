// import jwt from "jsonwebtoken";

// export function verify(token): { uid: string; privyId: string } {
//   //
//   try {
//     // console.log("verify token", token);
//     const decodedToken = jwt.verify(token, process.env.SECRET_JWT_KEY) as any;
//     // console.log("decodedToken", decodedToken);

//     return decodedToken;
//   } catch (e) {
//     console.error("verify token error", e);
//     return null;
//   }
// }

const AUTH_API_URL = "https://awe.box/api/xauthenticate";

export async function verify(token): Promise<{ uid: string; privyId: string }> {
  //
  try {
    // console.log("verify token", token);
    const response = await fetch(AUTH_API_URL, {
      method: "POST",
      body: JSON.stringify({
        token,
      }),
    });

    if (!response.ok) {
      throw new Error("Failed to verify token");
    }

    const result = await response.json();

    if (result.error) {
      throw new Error(result.error);
    }

    // console.log("decodedToken", decodedToken);
    return {
      uid: result.uid,
      privyId: result.privyId,
    };
  } catch (e) {
    console.error("verify token error", e);
    return null;
  }
}
