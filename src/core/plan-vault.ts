import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { PlanAccount, PlanVault } from './plan-auth';

export function encryptedPlanVault(directory:string,crypto:{available:()=>boolean;encrypt:(text:string)=>Buffer;decrypt:(value:Buffer)=>string}):PlanVault&{erase:()=>void}{
  const file=path.join(directory,'plan-accounts.bin');
  return {read:()=>{
    if(!existsSync(file))return [];if(!crypto.available())throw new Error('OS credential encryption unavailable / 系统凭据保护暂不可用');
    try{const data=JSON.parse(crypto.decrypt(readFileSync(file)));if(!Array.isArray(data))throw new Error();return data as PlanAccount[];}catch{throw new Error('Protected account store could not be opened / 无法读取受保护账号，请检查系统凭据访问');}
  },write:accounts=>{
    if(!crypto.available())throw new Error('OS credential encryption unavailable / 系统凭据保护暂不可用');
    const temporary=file+'.tmp';writeFileSync(temporary,crypto.encrypt(JSON.stringify(accounts)),{mode:0o600});renameSync(temporary,file);
  },erase:()=>{for(const target of [file,file+'.tmp'])if(existsSync(target))unlinkSync(target);}};
}
