import request from 'supertest';
import { createApp } from '../src/app.js';
import { advanceClock, config, resetClock } from '../src/config.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { buildExamples } from '../src/examples.js';
import { Application, ProcessedEvent } from '../src/models.js';
import { waitingCallbacks } from '../src/providers.js';
import { sign } from '../src/security.js';
import { sweep } from '../src/workflow.js';

export { advanceClock, config, sweep, waitingCallbacks };
export const server = () => request(createAppOnce());

let app: ReturnType<typeof createApp>;
const createAppOnce = () => (app ??= createApp());

export async function startTests() {
  config.autoCallbacks = false;   // we deliver the providers' callbacks ourselves, when we choose
  await connectDb();
}
export const stopTests = disconnectDb;

const defaults = { required: [...config.requiredChecks], heal: config.demoAutoHeal, timeout: config.checkTimeoutMs };
export async function resetTests() {
  await Application.deleteMany({});
  await ProcessedEvent.deleteMany({});
  waitingCallbacks.length = 0;
  resetClock();
  config.requiredChecks = [...defaults.required];
  config.demoAutoHeal = defaults.heal;
}

/** Submit one of the built-in examples ('good', 'mismatch', 'blurry', 'missing', 'unsure'). */
export async function submit(example = 'good', scenario = 'normal', change?: (ex: any) => void) {
  const ex = buildExamples().find((e) => e.id === example)!;
  change?.(ex);
  const res = await server().post('/api/applications').send({ form: ex.form, documents: ex.documents, scenario });
  return { id: res.body.id as string, form: ex.form, documents: ex.documents, res };
}

export const getApp = (id: string): Promise<any> => Application.findById(id).lean() as any;
export const view = async (id: string) => (await server().get(`/api/applications/${id}`)).body;
export const check = async (id: string, type: string) => (await getApp(id)).checks.find((c: any) => c.type === type);
export const audit = async (id: string) => (await getApp(id)).audit.map((e: any) => e.message as string);
export const auditCount = async (id: string, text: RegExp) => (await audit(id)).filter((m: string) => text.test(m)).length;

/** Deliver the callbacks the fake providers have queued (all of them, or only those matching). */
export async function deliver(filter: (body: any) => boolean = () => true): Promise<string[]> {
  const results: string[] = [];
  for (const item of [...waitingCallbacks]) {
    if (!filter(item.body)) continue;
    waitingCallbacks.splice(waitingCallbacks.indexOf(item), 1);
    results.push((await server().post(`/api/callbacks/${item.type}`).set('content-type', 'application/json').set('x-signature', item.signature).send(item.raw)).body.result);
  }
  return results;
}

/** Keep doing the periodic work and delivering callbacks until nothing is left to do. */
export async function settle() {
  for (let i = 0; i < 40; i++) {
    await sweep();
    const delivered = await deliver();
    const apps: any[] = await Application.find().lean();
    const waitingForRetry = apps.some((a) => a.checks.some((c: any) => c.status === 'RETRYING') || (a.state === 'APPROVED' && a.merchant?.nextAttemptAt));
    if (!delivered.length && !waitingForRetry) return;
    if (!delivered.length) advanceClock(2500);   // skip the short wait between retries
  }
  throw new Error('settle(): still busy after 40 rounds');
}

/** Sends a callback the way a provider would (correctly signed, unless told otherwise). */
export function callback(type: string, body: object, signature?: string | null) {
  const raw = JSON.stringify(body);
  const req = server().post(`/api/callbacks/${type}`).set('content-type', 'application/json');
  if (signature !== null) req.set('x-signature', signature ?? sign(raw));
  return req.send(raw);
}

/** A document that is an uploaded file. */
export const fileDoc = (type: string, name: string, bytes: Buffer) => ({ type, file: { name, data: bytes.toString('base64') } });
