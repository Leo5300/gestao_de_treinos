import { env } from "./env.js";

const stripTrailingSlash = (value: string): string => value.replace(/\/$/, "");

const getOriginVariants = (origin: string): string[] => {
  const url = new URL(origin);
  const hostname = url.hostname.toLowerCase();

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)
  ) {
    return [origin];
  }

  if (hostname.startsWith("www.")) {
    const withoutWww = hostname.slice(4);

    return [
      origin,
      `${url.protocol}//${withoutWww}${url.port ? `:${url.port}` : ""}`,
    ];
  }

  return [
    origin,
    `${url.protocol}//www.${hostname}${url.port ? `:${url.port}` : ""}`,
  ];
};

const getCookieDomain = (origin: string): string | undefined => {
  const hostname = new URL(origin).hostname.toLowerCase();

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)
  ) {
    return undefined;
  }

  return `.${hostname.replace(/^www\./, "")}`;
};

export const webAppOrigin = stripTrailingSlash(env.WEB_APP_BASE_URL);
export const apiOrigin = stripTrailingSlash(env.API_BASE_URL);
export const betterAuthOrigin = stripTrailingSlash(env.BETTER_AUTH_URL);

export const trustedOrigins = Array.from(
  new Set(getOriginVariants(webAppOrigin)),
);

export const isSecureContext = [webAppOrigin, apiOrigin, betterAuthOrigin].some(
  (origin) => new URL(origin).protocol === "https:",
);

export const cookieDomain = getCookieDomain(webAppOrigin);

export const authSessionCookieName = isSecureContext
  ? "__Secure-better-auth.session_token"
  : "better-auth.session_token";
