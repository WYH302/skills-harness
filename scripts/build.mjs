import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { realpathSync } from 'node:fs';
import { mkdir, copyFile } from 'node:fs/promises';
await build({entryPoints:['src/main/main.ts'],bundle:true,platform:'node',target:'node24',format:'cjs',outfile:'dist/main/main.cjs',external:['electron'],logLevel:'info'});
await build({entryPoints:['src/main/preload.ts'],bundle:true,platform:'node',target:'node24',format:'cjs',outfile:'dist/main/preload.cjs',external:['electron'],logLevel:'info'});
await viteBuild({root:realpathSync(process.cwd())});
await mkdir('dist/branding',{recursive:true});
await copyFile('src/branding/icon.png','dist/branding/icon.png');
