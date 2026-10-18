export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://ops:ops@localhost:5432/ops',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  port: Number(process.env.PORT ?? 3000),
};
