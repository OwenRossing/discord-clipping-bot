let csrfToken = null;

export function setCsrfToken(value) { if (value) csrfToken = value; }
export function getCsrfToken() { return csrfToken; }

export async function apiFetch(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const headers = { ...(options.body ? { 'Content-Type':'application/json' } : {}), ...(unsafe && csrfToken ? { 'X-CSRF-Token':csrfToken } : {}), ...(options.headers || {}) };
  const response = await fetch(url, { ...options, method, headers });
  let body = null;
  if (response.status !== 204) {
    const type = response.headers.get('content-type') || '';
    body = type.includes('application/json') ? await response.json() : await response.text();
  }
  if (body?.csrfToken) setCsrfToken(body.csrfToken);
  if (!response.ok) {
    const error = new Error(body?.error || body || `Request failed (${response.status}).`);
    error.status = response.status; error.code = body?.code; error.body = body;
    throw error;
  }
  return body;
}
