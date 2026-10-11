export function validateEnv(env: Record<string, unknown>) {
  const errors: string[] = [];
  const secret = String(env.JWT_SECRET ?? '');

  if (!env.DATABASE_URL) errors.push('DATABASE_URL is required');
  if (!secret) errors.push('JWT_SECRET is required');

  if (env.NODE_ENV === 'production') {
    if (secret.length < 32)
      errors.push('JWT_SECRET must be at least 32 characters in production');
    if (/change-me/i.test(secret))
      errors.push('JWT_SECRET is still the placeholder value');
    if (!env.FRONTEND_ORIGIN)
      errors.push('FRONTEND_ORIGIN is required in production');
    if (
      env.MPESA_CALLBACK_SECRET &&
      String(env.MPESA_CALLBACK_SECRET).length < 24
    ) {
      errors.push(
        'MPESA_CALLBACK_SECRET must be at least 24 characters in production',
      );
    }
  }

  if (errors.length)
    throw new Error(`Invalid environment:\n - ${errors.join('\n - ')}`);
  return env;
}
