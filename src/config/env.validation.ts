export function validateEnv(env: Record<string, unknown>) {
  const errors: string[] = [];
  const secret = String(env.JWT_SECRET ?? '');

  const etimsProvider = String(env.ETIMS_PROVIDER ?? 'disabled')
    .trim()
    .toLowerCase();
  const etimsTin = String(env.ETIMS_TIN ?? '').trim();

  if (!env.DATABASE_URL) errors.push('DATABASE_URL is required');
  if (!secret) errors.push('JWT_SECRET is required');

  if (!['disabled', 'mock', 'oscu'].includes(etimsProvider)) {
    errors.push('ETIMS_PROVIDER must be disabled, mock, or oscu');
  }

  // OSCU needs the real seller TIN; never substitute a fake value.
  if (etimsProvider === 'oscu' && !etimsTin) {
    errors.push('ETIMS_TIN is required when ETIMS_PROVIDER=oscu');
  }

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
