const authConfig = {
  providers: [
    {
      // Clerk frontend API URL - the JWT issuer for the "convex" JWT template.
      domain: process.env.CLERK_FRONTEND_API_URL!,
      applicationID: "convex",
    },
  ],
};

export default authConfig;
