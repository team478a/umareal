for (const url of ['http://127.0.0.1:4000/api/v1/health', 'http://localhost:3000']) {
  let ready = false;
  for (let i = 0; i < 45; i++) {
    try { const res = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (res.ok) { ready = true; break; } } catch { /* retry bounded startup */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error(`Service did not start: ${url}`);
}
console.info('Web and API are ready.');
