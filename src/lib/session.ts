import type { IncomingHttpHeaders } from "node:http";

import { fromNodeHeaders } from "better-auth/node";
import type { FastifyReply, FastifyRequest } from "fastify";

import { auth } from "./auth.js";
import {
  clearSessionCookies,
  hasDuplicatedSessionCookies,
  normalizeSessionCookieHeader,
} from "./auth-cookies.js";

export const getRequestSession = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const cookieHeader = request.raw.headers.cookie ?? "";
  const duplicateSessionCookie = hasDuplicatedSessionCookies(cookieHeader);
  const normalizedCookieHeader = normalizeSessionCookieHeader(cookieHeader);

  if (duplicateSessionCookie) {
    clearSessionCookies(reply);
  }

  const headers: IncomingHttpHeaders = {
    ...request.raw.headers,
    cookie: normalizedCookieHeader,
  };

  const session = await auth.api.getSession({
    headers: fromNodeHeaders(headers),
  });

  return {
    duplicateSessionCookie,
    session,
  };
};
