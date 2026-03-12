import type { FastifyReply } from "fastify";

import {
  apiOrigin,
  authSessionCookieName,
  betterAuthOrigin,
  cookieDomain,
  isSecureContext,
  webAppOrigin,
} from "./app-config.js";

const authSessionCookieNames = Array.from(
  new Set([
    authSessionCookieName,
    "__Secure-better-auth.session_token",
    "better-auth.session_token",
  ]),
);

const cookieDomains = Array.from(
  new Set(
    [
      cookieDomain,
      new URL(apiOrigin).hostname,
      new URL(betterAuthOrigin).hostname,
      new URL(webAppOrigin).hostname,
    ].filter((value): value is string => Boolean(value)),
  ),
);

const expiredCookieDate = "Thu, 01 Jan 1970 00:00:00 GMT";
const sameSite = isSecureContext ? "None" : "Lax";

const serializeExpiredCookie = (
  name: string,
  domain?: string,
): string => {
  const segments = [
    `${name}=`,
    "Path=/",
    `Expires=${expiredCookieDate}`,
    "Max-Age=0",
    "HttpOnly",
    `SameSite=${sameSite}`,
  ];

  if (isSecureContext) {
    segments.push("Secure");
  }

  if (domain) {
    segments.push(`Domain=${domain}`);
  }

  return segments.join("; ");
};

export const hasDuplicatedSessionCookies = (cookieHeader: string): boolean => {
  if (!cookieHeader) {
    return false;
  }

  const cookieNames = cookieHeader
    .split(";")
    .map((chunk) => chunk.trim().split("=")[0])
    .filter(Boolean);

  const totalSessionCookies = cookieNames.filter((name) =>
    authSessionCookieNames.includes(name),
  ).length;

  return totalSessionCookies > 1;
};

const splitCookieHeader = (cookieHeader: string): string[] =>
  cookieHeader
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean);

const getCookieName = (cookieEntry: string): string =>
  cookieEntry.split("=")[0] ?? "";

const getCookiePriority = (cookieName: string): number => {
  if (cookieName === authSessionCookieName) {
    return 3;
  }

  if (cookieName === "__Secure-better-auth.session_token") {
    return 2;
  }

  if (cookieName === "better-auth.session_token") {
    return 1;
  }

  return 0;
};

export const normalizeSessionCookieHeader = (cookieHeader: string): string => {
  if (!cookieHeader) {
    return cookieHeader;
  }

  const cookieEntries = splitCookieHeader(cookieHeader);
  const sessionCookies = cookieEntries.filter((entry) =>
    authSessionCookieNames.includes(getCookieName(entry)),
  );

  if (sessionCookies.length <= 1) {
    return cookieEntries.join("; ");
  }

  const preferredSessionCookie = [...sessionCookies].sort((a, b) => {
    const priorityDiff =
      getCookiePriority(getCookieName(b)) - getCookiePriority(getCookieName(a));

    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    return sessionCookies.lastIndexOf(b) - sessionCookies.lastIndexOf(a);
  })[0];

  const normalizedEntries = cookieEntries.filter((entry) => {
    const cookieName = getCookieName(entry);

    if (!authSessionCookieNames.includes(cookieName)) {
      return true;
    }

    return entry === preferredSessionCookie;
  });

  return normalizedEntries.join("; ");
};

export const buildClearSessionCookieHeaders = (): string[] => {
  const headers: string[] = [];

  for (const name of authSessionCookieNames) {
    headers.push(serializeExpiredCookie(name));

    for (const domain of cookieDomains) {
      headers.push(serializeExpiredCookie(name, domain));
    }
  }

  return headers;
};

export const appendSetCookieHeaders = (
  reply: FastifyReply,
  setCookies: string[],
): void => {
  if (setCookies.length === 0) {
    return;
  }

  const currentHeader = reply.raw.getHeader("set-cookie");
  const currentCookies = Array.isArray(currentHeader)
    ? currentHeader
    : typeof currentHeader === "string"
      ? [currentHeader]
      : [];

  reply.raw.setHeader("set-cookie", [...currentCookies, ...setCookies]);
};

export const clearSessionCookies = (reply: FastifyReply): void => {
  appendSetCookieHeaders(reply, buildClearSessionCookieHeaders());
};
