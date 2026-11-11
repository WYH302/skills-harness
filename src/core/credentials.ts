import type { Settings } from '../shared/types';
export function endpointIdentity(endpoint:string):string {
  try {const url=new URL(endpoint);return url.href.replace(/\/$/,'');}catch{return '';}
}
export interface BoundCredential {endpoint:string;mode:'local'|'remote';key:string}
export function credentialFor(bound:BoundCredential|undefined,settings:Settings):string {
  return bound&&bound.mode===settings.analysisMode&&endpointIdentity(bound.endpoint)===endpointIdentity(settings.endpoint)?bound.key:'';
}
export function consentForSettings(previous:Settings,update:Partial<Settings>,confirmedEndpoint?:string):Pick<Settings,'remoteConsent'|'remoteConsentEndpoint'> {
  const next={...previous,...update};
  if(next.analysisMode!=='remote')return {remoteConsent:false,remoteConsentEndpoint:undefined};
  const identity=endpointIdentity(next.endpoint);
  const changed=endpointIdentity(previous.endpoint)!==identity||previous.analysisMode!==next.analysisMode;
  const explicitlyConfirmed=update.remoteConsent===true&&identity!==''&&endpointIdentity(confirmedEndpoint||'')===identity;
  if(explicitlyConfirmed)return {remoteConsent:true,remoteConsentEndpoint:identity};
  if(!changed&&update.remoteConsent!==false&&previous.remoteConsent&&previous.remoteConsentEndpoint===identity)return {remoteConsent:true,remoteConsentEndpoint:identity};
  return {remoteConsent:false,remoteConsentEndpoint:undefined};
}
