// Shared helpers: load the recogniser (pose.js from a checkout of the main code, path in
// $POSE) and the recordings in ../recordings (gzipped or plain JSON).
import fs from 'fs';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';

if (!process.env.POSE) throw new Error('Set POSE to fighter/pose.js in a checkout of the main branch, e.g. POSE=../tools/fighter/pose.js');
export const pose = await import(path.resolve(process.env.POSE));
export const REC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'recordings');

/** Recordings whose file name matches `re`, as [{f, s}] (f = file name, s = parsed session). */
export const load = (re = /./) => fs.readdirSync(REC_DIR).filter((f) => /\.json(\.gz)?$/.test(f) && re.test(f)).sort()
  .map((f) => {
    const raw = fs.readFileSync(path.join(REC_DIR, f));
    return { f, s: JSON.parse(f.endsWith('.gz') ? zlib.gunzipSync(raw) : raw) };
  });
