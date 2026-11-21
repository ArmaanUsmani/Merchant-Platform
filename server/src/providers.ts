import crypto from 'node:crypto';
import { CheckType, config } from './config.js';
import { sign } from './security.js';

// ---------------------------------------------------------------------------
// Fake verification providers (PAN, GST, bank, risk).
//
// Real providers work in two steps: we send a request and they reply "received" straight away,
// then a little later they call a URL of ours with the real answer (a "callback" or webhook).
// This file imitates that. The "scenario" picked on the New application page decides how the
// providers misbehave, so every failure case can be shown on demand.
// ---------------------------------------------------------------------------

export const SCENARIOS = [
  { id: 'normal', label: 'Everything works', help: 'All four checks pass and the merchant ID is created.' },
  { id: 'gst_fails', label: 'GST check fails (PAN passes)', help: 'The GST provider rejects the GSTIN, so a person has to review the case.' },
  { id: 'repeated_callbacks', label: 'Provider repeats every answer 3 times', help: 'Only the first copy of each answer should count.' },
  { id: 'late_answer', label: 'Bank answer arrives too late', help: 'The first bank answer comes after our timeout, while a retry is already running.' },
  { id: 'provider_down', label: 'GST provider is down for a moment', help: 'The first two requests fail. The system retries and then succeeds.' },
  { id: 'provider_dead', label: 'GST provider stays down', help: 'Every try fails, so the case goes to a reviewer.' },
  { id: 'high_risk', label: 'Risk check flags the merchant', help: 'The risk score is high, so a person has to review the case.' },
  { id: 'merchant_id_retry', label: 'Merchant ID creation fails twice, then works', help: 'Approval succeeds, creating the ID fails twice, the third try works.' },
  { id: 'merchant_id_fails', label: 'Merchant ID creation keeps failing', help: 'Approved, but the ID cannot be created. Operations must retry.' },
] as const;

export interface ProviderRequest {
  requestId: string;
  appId: string;
  attempt: number;      // 1 for the first try, 2 for the first retry, ...
  scenario: string;
  data: Record<string, string>;
}

export interface Callback {
  eventId: string;
  requestId: string;
  type: CheckType;
  status: 'PASSED' | 'FAILED' | 'NEEDS_REVIEW';
  reason?: string;
}

// When config.autoCallbacks is false (tests), callbacks wait here until a test delivers them.
export const waitingCallbacks: { type: CheckType; body: Callback; raw: string; signature: string }[] = [];

export async function sendToProvider(type: CheckType, req: ProviderRequest): Promise<void> {
  const { scenario, attempt } = req;

  if (type === 'GST' && scenario === 'provider_dead') throw new Error('GST provider unavailable (503)');
  if (type === 'GST' && scenario === 'provider_down' && attempt <= 2) throw new Error('GST provider unavailable (503)');

  let status: Callback['status'] = 'PASSED';
  let reason: string | undefined;
  if (type === 'GST' && scenario === 'gst_fails') { status = 'FAILED'; reason = 'The registered business name does not match the legal name.'; }
  if (type === 'RISK' && scenario === 'high_risk') { status = 'NEEDS_REVIEW'; reason = 'The risk score is high (82 out of 100).'; }

  let delay = 700 + Math.random() * 600;
  if (type === 'BANK' && scenario === 'late_answer') delay = attempt === 1 ? config.checkTimeoutMs * 1.3 : 6000;
  const copies = scenario === 'repeated_callbacks' ? 3 : 1;

  const body: Callback = { eventId: 'evt_' + crypto.randomBytes(6).toString('hex'), requestId: req.requestId, type, status, reason };
  for (let i = 0; i < copies; i++) deliver(type, body, delay + i * 150);   // same eventId every time
}

// Every callback is signed with a secret that only the provider and we know, so nobody else can send a fake answer.
function deliver(type: CheckType, body: Callback, delay: number) {
  const raw = JSON.stringify(body);
  const signature = sign(raw);
  if (!config.autoCallbacks) { waitingCallbacks.push({ type, body, raw, signature }); return; }
  setTimeout(() => {
    fetch(`${config.callbackBase}/api/callbacks/${type}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': signature }, body: raw,
    }).catch((e) => console.error('callback failed', e.message));
  }, delay);
}

// The internal system that creates merchant IDs. It can fail too.
export function createMerchantId(appId: string, scenario: string, attempt: number): string {
  if (scenario === 'merchant_id_fails') throw new Error('Merchant platform is unavailable (503)');
  if (scenario === 'merchant_id_retry' && attempt <= 2) throw new Error('Merchant platform is unavailable (503)');
  // The same application always gets the same ID, so a retry can never create a second one.
  const n = parseInt(crypto.createHash('sha1').update(appId).digest('hex').slice(0, 8), 16) % 1_000_000_000;
  return 'MID' + String(n).padStart(9, '0');
}
