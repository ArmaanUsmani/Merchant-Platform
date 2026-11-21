import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import { changeBank, formOf, resubmit, retryMerchantId, reviewApplication, submitApplication } from './applications.js';
import { HttpError } from './errors.js';
import { goodDocs, buildExamples } from './examples.js';
import { metrics } from './metrics.js';
import { Application } from './models.js';
import { SCENARIOS } from './providers.js';
import { verify } from './security.js';
import { counts, listApplications, toView } from './views.js';
import { handleCallback } from './workflow.js';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);   // send async errors to the error handler

async function load(id: string) {
  const app: any = await Application.findById(id).lean();
  if (!app) throw new HttpError(404, 'Application not found.');
  return app;
}

export function createApp() {
  const app = express();
  app.use(cors());
  // `verify` keeps the exact bytes we received: the callback signature is checked against them.
  app.use(express.json({ limit: '10mb', verify: (req: any, _res, buf) => { req.rawBody = buf; } }));

  // --- merchants and operators ---
  app.post('/api/applications', wrap(async (req, res) => {
    const id = await submitApplication(req.body);
    res.status(201).json(toView(await load(id)));
  }));
  app.get('/api/applications', wrap(async (req, res) => res.json({ rows: await listApplications(req.query.group as string), counts: await counts() })));
  app.get('/api/applications/:id', wrap(async (req, res) => res.json(toView(await load(req.params.id)))));
  app.post('/api/applications/:id/fix', wrap(async (req, res) => { await resubmit(req.params.id, req.body); res.json(toView(await load(req.params.id))); }));
  app.post('/api/applications/:id/bank', wrap(async (req, res) => { await changeBank(req.params.id, req.body); res.json(toView(await load(req.params.id))); }));
  app.post('/api/applications/:id/review', wrap(async (req, res) => { await reviewApplication(req.params.id, req.body); res.json(toView(await load(req.params.id))); }));
  app.post('/api/applications/:id/retry-merchant-id', wrap(async (req, res) => { await retryMerchantId(req.params.id, req.body?.by); res.json(toView(await load(req.params.id))); }));

  // --- verification providers call this when they have an answer ---
  app.post('/api/callbacks/:type', wrap(async (req: any, res) => {
    if (!verify(req.rawBody, req.header('x-signature'))) throw new HttpError(401, 'The callback signature is missing or wrong.');
    try { res.json({ result: await handleCallback({ ...req.body, type: req.params.type.toUpperCase() }) }); }
    catch (e: any) { throw new HttpError(400, e.message); }
  }));

  // --- helpers for the web page ---
  app.get('/api/metrics', wrap(async (_req, res) => res.json(await metrics())));
  app.get('/api/scenarios', (_req, res) => res.json(SCENARIOS));
  app.get('/api/examples', (_req, res) => res.json(buildExamples()));

  // --- demo helpers (not part of the real workflow) ---
  app.post('/api/demo/merchant-fix/:id', wrap(async (req, res) => {
    // Plays the merchant: sends correct documents that match the application on file.
    const a = await load(req.params.id);
    await resubmit(req.params.id, { documents: goodDocs(formOf(a)) });
    res.json(toView(await load(req.params.id)));
  }));
  app.post('/api/demo/reset', wrap(async (_req, res) => { await Application.deleteMany({}); res.json({ ok: true }); }));

  // --- the web page ---
  const dist = path.resolve(process.cwd(), '../client/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (/cannot go from/.test(err.message)) return res.status(409).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side.' });
  });
  return app;
}
