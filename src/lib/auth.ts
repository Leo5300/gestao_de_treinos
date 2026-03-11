import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { openAPI } from "better-auth/plugins";

import { prisma } from "./db.js";
import { env } from "./env.js";

const isProduction =
  env.NODE_ENV === "production" ||
  env.BETTER_AUTH_URL.startsWith("https://");

const appOrigin = env.WEB_APP_BASE_URL.replace(/\/$/, "");

const wwwOrigin = appOrigin.startsWith("https://www.")
  ? appOrigin
  : appOrigin.replace("https://", "https://www.");

const appHostname = new URL(appOrigin).hostname.replace(/^www\./, "");

const cookieDomain =
  appHostname === "localhost" || appHostname.includes(":")
    ? undefined
    : `.${appHostname}`;

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,

  trustedOrigins: [appOrigin, wwwOrigin],

  emailAndPassword: {
    enabled: true,
  },

  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    },
  },

  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),

  plugins: [openAPI()],

  advanced: {
    defaultCookieAttributes: {
      domain: cookieDomain,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      httpOnly: true,
      path: "/",
    },

    cookies: {
      sessionToken: {
        attributes: {
          httpOnly: true,
          secure: isProduction,
          sameSite: isProduction ? "none" : "lax",
          path: "/",
          domain: cookieDomain,
        },
      },

      state: {
        attributes: {
          httpOnly: true,
          secure: isProduction,
          sameSite: isProduction ? "none" : "lax",
          path: "/",
          domain: cookieDomain,
        },
      },
    },
  },
});