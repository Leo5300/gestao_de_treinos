import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { openAPI } from "better-auth/plugins";

import { prisma } from "./db.js";
import { env } from "./env.js";

const appOrigin = env.WEB_APP_BASE_URL.replace(/\/$/, "");

const wwwOrigin = appOrigin.startsWith("https://www.")
  ? appOrigin
  : appOrigin.replace("https://", "https://www.");

const cookieDomain = ".leomarchi.com.br";

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
      secure: true,
      sameSite: "none",
      httpOnly: true,
      path: "/",
    },

    cookies: {
      sessionToken: {
        attributes: {
          domain: cookieDomain,
          secure: true,
          sameSite: "none",
          httpOnly: true,
          path: "/",
        },
      },

      state: {
        attributes: {
          domain: cookieDomain,
          secure: true,
          sameSite: "none",
          httpOnly: true,
          path: "/",
        },
      },
    },
  },
});
