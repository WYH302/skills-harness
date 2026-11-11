// Export the application's existing, original vector mark for native app packaging.
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const svg=await readFile('src/branding/harbor.svg','utf8');
const executablePath=[process.env.SKILLHARBOR_CHROMIUM,chromium.executablePath(),path.join(process.env.LOCALAPPDATA||'','ms-playwright','chromium-1217','chrome-win64','chrome.exe'),'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(candidate=>candidate&&existsSync(candidate));
if(!executablePath)throw new Error('An installed Chromium/Chrome/Edge is needed only to regenerate the bundled icon assets');
const browser=await chromium.launch({executablePath,headless:true});
try {
  const page=await browser.newPage({viewport:{width:256,height:256},deviceScaleFactor:1});
  const entries=[];
  for(const size of [16,32,48,64,128,256]) {
    await page.setContent(`<style>body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    const png=await page.locator('svg').screenshot({omitBackground:true});entries.push({size,png});
    if(size===256)await writeFile('src/branding/icon.png',png);
  }
  const header=Buffer.alloc(6+16*entries.length);header.writeUInt16LE(1,2);header.writeUInt16LE(entries.length,4);
  let offset=header.length;
  for(const [index,{size,png}] of entries.entries()) {
    const at=6+index*16;header[at]=size===256?0:size;header[at+1]=size===256?0:size;
    header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(png.length,at+8);header.writeUInt32LE(offset,at+12);offset+=png.length;
  }
  await writeFile('src/branding/icon.ico',Buffer.concat([header,...entries.map(entry=>entry.png)]));
  process.stdout.write('Exported original application mark as PNG and six-size Windows ICO.\n');
}finally{await browser.close();}
