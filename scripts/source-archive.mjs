import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';
import path from 'node:path';
const {version}=JSON.parse(await readFile('package.json','utf8'));
const roots=['src','extension','third_party','tests','scripts','docs','examples','.github'];
const top=['package.json','package-lock.json','tsconfig.json','vite.config.ts','playwright.config.ts','index.html','README.md','README.en.md','LICENSE','OPEN_SOURCE_ATTRIBUTIONS.md','WORK_STATUS.md','.gitignore'];
const files={};
async function walk(dir){for(const ent of await readdir(dir,{withFileTypes:true})){if(ent.isSymbolicLink())throw new Error('Source package cannot include symlinks');const p=path.join(dir,ent.name);if(ent.isDirectory())await walk(p);else if(ent.isFile()){if(/\.(?:db|sqlite|log)(?:-|$)/i.test(ent.name)||ent.name.startsWith('.env'))throw new Error('Private data extension in source package');files['SkillHarbor-source/'+p.replaceAll('\\','/')]=new Uint8Array(await readFile(p));}}}
for(const root of roots)await walk(root);
for(const name of top)files['SkillHarbor-source/'+name]=new Uint8Array(await readFile(name));
files['SkillHarbor-source/SOURCE_ARCHIVE.txt']=strToU8('Whitelist-built source archive. Does not include .git, node_modules, application data, diagnostic logs, credentials or private histories. Example histories and screenshots are synthetic.\n');
await mkdir('release',{recursive:true});await writeFile(`release/SkillHarbor-${version}-source.zip`,zipSync(files,{level:6}));
const extension={};async function addExtension(dir){for(const ent of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,ent.name);if(ent.isDirectory())await addExtension(p);else if(ent.isFile())extension[p.replaceAll('\\','/')]=new Uint8Array(await readFile(p));}}await addExtension('extension');await writeFile(`release/SkillHarbor-${version}-browser-extension.zip`,zipSync(extension,{level:6}));
process.stdout.write(`Packaged ${Object.keys(files).length} source files and ${Object.keys(extension).length} extension files.\n`);
