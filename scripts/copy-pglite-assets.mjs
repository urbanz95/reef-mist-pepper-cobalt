// Nitro relocates PGlite's JS into _libs. Its WASM loader resolves these files
// relative to that JS, so package them alongside it for no-credential previews.
import {copyFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
const require=createRequire(import.meta.url);
const source=dirname(require.resolve('@electric-sql/pglite'));
const target=new URL('../.vercel/output/functions/__server.func/_libs/',import.meta.url);
await mkdir(target,{recursive:true});
for(const name of ['pglite.data','pglite.wasm','initdb.wasm'])await copyFile(join(source,name),new URL(name,target));
console.log('[build] Packaged PGlite runtime assets');
