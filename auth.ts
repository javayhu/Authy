import NextAuth from "next-auth"
import GitHub from "next-auth/providers/github"
import Google from "next-auth/providers/google";
import { SanityAdapter } from "./adapters/sanity-adapter"
import sanityClient from "./lib/sanityClient"
import Credentials from "next-auth/providers/credentials"
import { LoginSchema } from "./form-schemas"
import bcrypt from "bcryptjs";

import { getUserById } from "./data/user"
import { getTwoFactorConfirmationByUserId } from "./data/two-factor-confirmation";
import { getAccountByUserId } from "./data/account";


export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
  //unstable update in Beta version
  unstable_update
} = NextAuth({
  debug: process.env.NODE_ENV === "development",
  pages: {
    signIn: "/auth/login",
    error: "/auth/error"
  },
  providers: [
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true
    }),
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true
    }),
    Credentials({
      async authorize(credentials) {
        //if not using zod resolvers validated fields arent necessary
        const validatedFields = LoginSchema.safeParse(credentials);
        if (!validatedFields.success) return null;

        const user_qry = `*[_type == "user" && email== "${credentials?.email}"][0]`;
        const user = await sanityClient.fetch(user_qry);

        if (!user || !user.password) {
          console.error('authorize error: user not found or password invalid');
          return null;
        }

        const passwordsMatch = await bcrypt.compare(credentials?.password as string, user.password);

        if (passwordsMatch) {
          return {
            id: user._id,
            role: user.role,
            ...user
          };
        }

        return null;
      }
    })
  ],
  session: { strategy: "jwt" },
  // TODO: fix type or // @ts-ignore 
  // 类型 "SanityClient" 中的属性 "#private" 引用了不能从类型 "SanityClient" 内访问的其他成员。
  adapter: SanityAdapter(sanityClient),
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider !== "credentials") return true;

      const existingUser = await getUserById(user.id!)

      // prevent signIn without email verification
      if (!existingUser?.emailVerified) return false;

      // 2FA CHECK
      if (existingUser.isTwoFactorEnabled) {
        const twoFactorConfirmation = await getTwoFactorConfirmationByUserId(existingUser._id);

        if (!twoFactorConfirmation) return false;

        // Delete 2FA for next signin
        await sanityClient.delete(twoFactorConfirmation._id);
      }

      return true;
    },
    // @ts-ignore
    async session({ session, token }) {
      if (token.sub && session.user) {
        session.user.id = token.sub;
      }

      // TODO: fix type or // @ts-ignore 
      if (token.role && session.user) {
        session.user.role = token.role;
      }

      if (session.user) {
        session.user.isTwoFactorEnabled = token.isTwoFactorEnabled as boolean;
      }

      if (session.user) {
        session.user.name = token.name;
        // TODO: fix type or // @ts-ignore, add ?? '' for now
        session.user.email = token.email ?? '';
        session.user.isOAuth = token.isOAuth as boolean;
      }

      return session;
    },
    async jwt({ token }) {
      if (!token.sub) return token;

      const existingUser = await getUserById(token.sub);

      if (!existingUser) return token;

      const existingAccount = await getAccountByUserId(existingUser._id);

      token.isOAuth = !!existingAccount;
      token.name = existingUser.name;
      token.email = existingUser.email;
      token.role = existingUser.role;
      token.isTwoFactorEnabled = existingUser.isTwoFactorEnabled;

      return token;
    },
  },
})