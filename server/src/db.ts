import path from 'node:path';
import fs from 'node:fs';
import mongoose from 'mongoose';
import { config } from './config.js';

let memoryServer: { stop: (o?: any) => Promise<any> } | null = null;
let keepData = false;

/**
 * Connects to MongoDB. Use your own with MONGO_URI (Atlas, Docker, local).
 * Without it, a private MongoDB is started for you and its data is kept in the .data folder.
 */
export async function connectDb(opts: { keepData?: boolean } = {}) {
  keepData = !!opts.keepData;
  let uri = config.mongoUri;
  if (!uri) {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    // The extra setting lets MongoDB start on laptops that are almost out of disk space.
    const args = ['--setParameter', 'indexBuildMinAvailableDiskSpaceMB=10'];
    let dbPath: string | undefined;
    if (opts.keepData) { dbPath = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), '../.data')); fs.mkdirSync(dbPath, { recursive: true }); }
    const server = await MongoMemoryServer.create({ instance: { args, ...(dbPath && { dbPath }) } });
    memoryServer = server;
    uri = server.getUri();
  }
  await mongoose.connect(uri, { dbName: 'onboarding' });
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));   // create the indexes
}

export async function disconnectDb() {
  await mongoose.disconnect();
  if (memoryServer) await memoryServer.stop({ doCleanup: !keepData });   // tests: delete the files. Normal running: keep them.
  memoryServer = null;
}
