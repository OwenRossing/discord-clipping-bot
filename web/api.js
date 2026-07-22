let csrfToken = null;

export function setCsrfToken(value) { if (value) csrfToken = value; }
export function getCsrfToken() { return csrfToken; }

export async function apiFetch(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const headers = { ...(options.body ? { 'Content-Type':'application/json' } : {}), ...(unsafe && csrfToken ? { 'X-CSRF-Token':csrfToken } : {}), ...(options.headers || {}) };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), options.timeout ?? 15_000);
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once:true });
  let response;
  try { response = await fetch(url, { ...options, method, headers, signal:controller.signal, credentials:'same-origin' }); }
  catch (cause) {
    const error = new Error(cause?.name === 'TimeoutError' || controller.signal.reason?.name === 'TimeoutError' ? 'The request timed out. Try again.' : cause?.name === 'AbortError' ? 'Request cancelled.' : 'Could not reach ClipThat. Check your connection and try again.');
    error.code = cause?.name === 'AbortError' ? 'REQUEST_ABORTED' : 'NETWORK_ERROR';
    error.cause = cause;
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
  let body = null;
  if (response.status !== 204) {
    const type = response.headers.get('content-type') || '';
    const raw = await response.text();
    if (type.includes('application/json') && raw) { try { body = JSON.parse(raw); } catch { body = null; } }
    else body = raw;
  }
  if (body?.csrfToken) setCsrfToken(body.csrfToken);
  if (!response.ok) {
    const error = new Error(body?.error || body || `Request failed (${response.status}).`);
    error.status = response.status; error.code = body?.code; error.body = body; error.requestId = body?.requestId || response.headers.get('x-request-id');
    throw error;
  }
  return body;
}
