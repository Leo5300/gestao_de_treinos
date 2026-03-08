import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { openAPI } from "better-auth/plugins";

import { prisma } from "./db.js";
import { env } from "./env.js";

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,

  // frontend autorizado a usar a auth API
  trustedOrigins: [
    env.WEB_APP_BASE_URL,
  ],

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

  plugins: [
    openAPI(),
  ],

  advanced: {
    cookies: {

      // cookie de sessão do usuário
      sessionToken: {
        attributes: {
          httpOnly: true,
          secure: true,
          sameSite: "none",
          path: "/",
        },
      },

      // cookie usado no OAuth (state)
      state: {
        attributes: {
          httpOnly: true,
          secure: true,
          sameSite: "none",
          path: "/",
        },
      },

    },
  },
});