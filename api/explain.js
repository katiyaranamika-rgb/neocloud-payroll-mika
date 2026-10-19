// Vercel serverless function: POST /api/explain
// Turns sanitized pre-payroll audit findings into Controller commentary using Claude.
// The API key is read from the server environment and never sent to the browser.
// Returns 501 when ANTHROPIC_API_KEY is not set, and the UI falls back to a template.

const SYSTEM = `You are a senior payroll specialist reviewing a pre-payroll audit for NeoCloud's US pay runs.
Write concise commentary (max 250 words) for the Payroll Manager and Controller:
1) does the headcount roll forward (last run + joiners - leavers = this run; less unpaid leave and no time = to be paid) and tie to the register;
2) what needs action before approval; 3) what is expected and explained; 4) a one-line recommendation.
Rules: use only facts and numbers that appear in the input. Do not add, subtract or estimate new numbers.
Refer to workers only by their token (W001, W002...). Never guess identities. Plain text, short bullets.`;

const ALLOWED_TOP = ['period', 'headcount', 'findings', 'parallel'];
const ALLOWED_FINDING = ['ref', 'check', 'rule', 'severity', 'worker', 'payGroup', 'current', 'prior'];

/** Server-side allow-list: reject anything outside the schema or carrying real worker IDs. */
function checkPayload(p) {
  if (!p || typeof p !== 'object') return 'payload must be an object';
  for (const k of Object.keys(p)) if (!ALLOWED_TOP.includes(k)) return `field not allowed: ${k}`;
  for (const f of p.findings ?? []) for (const k of Object.keys(f)) if (!ALLOWED_FINDING.includes(k)) return `finding field not allowed: ${k}`;
  if (/\bE\d{4}\b/.test(JSON.stringify(p))) return 'worker IDs must be pseudonymized';
  return '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(501).json({ error: 'not_configured' });
    return;
  }
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
  if (body.length > 200000) {
    res.status(413).json({ error: 'payload too large' });
    return;
  }
  let parsed;
  try { parsed = JSON.parse(body); } catch { res.status(400).json({ error: 'invalid JSON' }); return; }
  const bad = checkPayload(parsed);
  if (bad) { res.status(400).json({ error: bad }); return; }
  // Defensive scrub: drop anything that looks like an SSN, bank account or email before sending.
  const scrubbed = body
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted]')
    .replace(/\b\d{9,17}\b/g, '[redacted]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[redacted]');
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 800, system: SYSTEM, messages: [{ role: 'user', content: `Pre-payroll audit (JSON):\n${scrubbed}` }] }),
    });
    const j = await r.json();
    if (!r.ok) {
      res.status(502).json({ error: j?.error?.message || `upstream ${r.status}` });
      return;
    }
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    res.status(200).json({ text, model, usage: j.usage });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
}
