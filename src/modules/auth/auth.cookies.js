import { env } from '#config/env.js';

/**
 * Cookies stay first-party on the frontend origin (Next.js rewrites /api/* → Express), so:
 * no Domain attribute, SameSite=Lax for the access cookie (normal navigation works) and
 * Strict + path-scoped for the refresh cookie (only ever sent to /api/v1/auth).
 */
export const ACCESS_COOKIE = 'pp_at';
export const REFRESH_COOKIE = 'pp_rt';
const REFRESH_PATH = '/api/v1/auth';

const base = () => ({ httpOnly: true, secure: env.isProd, path: '/' });

export function setAuthCookies(res, { accessToken, refreshToken, refreshExpiresAt }) {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...base(),
    sameSite: 'lax',
    maxAge: env.ACCESS_TOKEN_TTL_MIN * 60_000,
  });
  if (refreshToken) {
    res.cookie(REFRESH_COOKIE, refreshToken, {
      ...base(),
      path: REFRESH_PATH,
      sameSite: 'strict',
      expires: refreshExpiresAt,
    });
  }
}

export function setAccessCookie(res, accessToken) {
  setAuthCookies(res, { accessToken });
}

export function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { ...base(), sameSite: 'lax' });
  res.clearCookie(REFRESH_COOKIE, { ...base(), path: REFRESH_PATH, sameSite: 'strict' });
}
