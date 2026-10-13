// Mirror this policy in netlify.toml; tests verify the deployment/local contract.
const securityHeaders = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self' https://cluxbeysuboablzeawnm.supabase.co; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; frame-src 'none'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};
module.exports = securityHeaders;
