import { fromNodeHeaders } from "better-auth/node";
import type { FastifyReply, FastifyRequest } from "fastify";

import { auth } from "./auth.js";
import {
  clearSessionCookies,
  hasDuplicatedSessionCookies,
} from "./auth-cookies.js";

export const getRequestSession = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const cookieHeader = request.raw.headers.cookie ?? "";

  if (hasDuplicatedSessionCookies(cookieHeader)) {
    clearSessionCookies(reply);

    return {
      duplicateSessionCookie: true,
      session: null,
    };
  }

  const session = await auth.api.getSession({
    headers: fromNodeHeaders(request.raw.headers),
  });

  return {
    duplicateSessionCookie: false,
    session,
  };
};
