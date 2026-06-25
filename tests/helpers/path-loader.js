/**
 * Node.js module resolve hook that remaps browser-style absolute imports
 * (`/engine/...`, `/editors/...`, `/data/...`, `/game/...`) to real filesystem
 * paths, so engine/client code written for the browser loads in Node tests.
 * Mirrors Sub Game's shared-loader, generalized to the engine's mount points.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../');

const MOUNTS = ['/engine/', '/editors/', '/data/', '/game/'];

export function resolve(specifier, context, nextResolve) {
  if (MOUNTS.some(m => specifier.startsWith(m))) {
    const filePath = path.join(projectRoot, specifier.slice(1));
    return { url: pathToFileURL(filePath).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
