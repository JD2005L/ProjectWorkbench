const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const ANSI = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g;

export function redactOutput(text, privateValues = []) {
  let result = String(text).replace(ANSI, '');
  for (const secret of [...new Set(privateValues.filter(value => typeof value === 'string')
    .flatMap(value => value.replace(ANSI, '').split(/\r?\n/)).filter(Boolean))]
    .sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join('[redacted]');
  }
  return result.replace(EMAIL, '[redacted-address]')
    .replace(/(authorization\s*[:=]\s*)(?:bearer|basic)\s+\S+/gi, '$1[redacted]')
    .replace(/((?:password|passwd|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/:\/\/[^/\s:@]+:[^@\s/]+@/g, '://[redacted]@');
}

export function lineRedactor(privateValues, emit) {
  let pending = '';
  let discarding = false;
  return {
    write(chunk) {
      pending += String(chunk);
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!discarding) emit(redactOutput(line, privateValues));
        discarding = false;
      }
      if (pending.length > 65536) {
        if (!discarding) emit('[oversized output line omitted]');
        pending = '';
        discarding = true;
      }
    },
    end() {
      if (pending && !discarding) emit(redactOutput(pending, privateValues));
      pending = '';
    },
  };
}
