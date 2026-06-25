/**
 * Registration entry point for the path-loader resolve hook.
 * Used with: node --import ./tests/helpers/register-loader.js
 */
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(path.join(__dirname, 'path-loader.js')).href, import.meta.url);
