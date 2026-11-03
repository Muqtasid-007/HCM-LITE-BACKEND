// Keep this module independent of application configuration: even env/import failures
// must reach stderr, including when LOG_LEVEL=silent or Pino cannot initialize.
export function redactStartupText(value) {
  let text = String(value);
  const secrets = new Set();
  for (const [key, raw] of Object.entries(process.env)) {
    if (!raw || !/(?:SECRET|PASSWORD|TOKEN|API_KEY|URI|URL)/i.test(key)) continue;
    secrets.add(raw);
    secrets.add(JSON.stringify(raw).slice(1,-1));
    secrets.add(encodeURIComponent(raw));
    if (/URI|URL/i.test(key)) {
      try {
        const url = new URL(raw);
        for (const part of [url.username, url.password]) if (part) {
          secrets.add(part);
          secrets.add(decodeURIComponent(part));
        }
      } catch { /* Invalid configuration is still redacted verbatim above. */ }
    }
  }
  // Replace complete values first so a shorter password cannot leave a partial URI.
  for (const secret of [...secrets].sort((a,b) => b.length-a.length)) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/\b(?:mongodb(?:\+srv)?|https?|postgres(?:ql)?|redis):\/\/[^\s"'<>]+/gi,'[REDACTED_URL]')
    .replace(/\b(Bearer)\s+[^\s"',}]+/gi,'$1 [REDACTED]')
    .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;}]+/gi,'$1=[REDACTED]');
}

function describeError(error, seen = new Set(), depth = 0) {
  if (!error || typeof error !== 'object') return { message:String(error) };
  if (seen.has(error) || depth > 5) return { message:'Nested error omitted' };
  seen.add(error);
  const result = { name:error.name || 'Error', message:error.message || String(error) };
  if (error.stack) result.stack = String(error.stack);
  if (['string','number'].includes(typeof error.code)) result.code = error.code;
  if (error.cause) result.cause = describeError(error.cause,seen,depth+1);
  if (error.reason instanceof Error) result.reason = describeError(error.reason,seen,depth+1);
  // MongoDB often stores the useful DNS/TLS/socket error in a topology server entry.
  if (error.reason?.servers instanceof Map) {
    result.serverErrors = [...error.reason.servers.values()].filter(server => server.error).map(server => describeError(server.error,seen,depth+1));
  }
  return result;
}

export function logStartupError(error, context) {
  function redact(value) {
    if(typeof value === 'string') return redactStartupText(value);
    if(Array.isArray(value)) return value.map(redact);
    if(value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,redact(item)]));
    return value;
  }
  // Redact strings before JSON encoding, including credentials containing quotes.
  console.error(JSON.stringify(redact({ context, error:describeError(error) }),null,2));
}

export function exitWithError(error, context) {
  logStartupError(error,context);
  process.exit(1);
}

export async function runStartup(context, operation, cleanup = async () => {}) {
  try {
    await operation();
    return true;
  } catch (error) {
    logStartupError(error,context);
    process.exitCode = 1;
    const deadline = setTimeout(() => exitWithError(new Error('Fatal error cleanup exceeded 10 seconds'),context),10000);
    deadline.unref();
    try { await cleanup(); }
    catch (cleanupError) { logStartupError(cleanupError,`${context}: cleanup failed`); }
    finally { clearTimeout(deadline); }
    return false;
  }
}
