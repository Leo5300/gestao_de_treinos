import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { openAPI } from "better-auth/plugins";

import {
  authSessionCookieName,
  cookieDomain,
  isSecureContext,
  trustedOrigins,
} from "./app-config.js";
import { prisma } from "./db.js";
import { env } from "./env.js";

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,

  trustedOrigins,

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
      ...(cookieDomain ? { domain: cookieDomain } : {}),
      secure: isSecureContext,
      sameSite: isSecureContext ? "none" : "lax",
      httpOnly: true,
      path: "/",
    },

    cookies: {
      sessionToken: {
        name: authSessionCookieName,
        attributes: {
          httpOnly: true,
          secure: isSecureContext,
          sameSite: isSecureContext ? "none" : "lax",
          ...(cookieDomain ? { domain: cookieDomain } : {}),
          path: "/",
        },
      },
    },
  },
});
