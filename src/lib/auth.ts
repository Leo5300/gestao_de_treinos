import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { openAPI } from "better-auth/plugins";

import { prisma } from "./db.js";
import { env } from "./env.js";

const isProduction = env.NODE_ENV === "production";

const appOrigin = env.WEB_APP_BASE_URL.replace(/\/$/, "");
const wwwOrigin = appOrigin.startsWith("https://www.")
  ? appOrigin
  : appOrigin.replace("https://", "https://www.");

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
    cookies: {
      sessionToken: {
        attributes: {
          httpOnly: true,
          secure: isProduction,
          sameSite: isProduction ? "none" : "lax",
          path: "/",
          ...(isProduction ? { domain: ".leomarchi.com.br" } : {}),
        },
      },

      state: {
        attributes: {
          httpOnly: true,
          secure: isProduction,
          sameSite: isProduction ? "none" : "lax",
          path: "/",
          ...(isProduction ? { domain: ".leomarchi.com.br" } : {}),
        },
      },
    },
  },
});