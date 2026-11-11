import { SOURCE_IDS, type SourceId } from '../shared/types';

export interface CollectionPreferences {sources:SourceId[];range:boolean;from:string;to:string}
export function parseCollectionPreferences(raw:string|null):CollectionPreferences|undefined {
  if(!raw)return;
  try {
    const value=JSON.parse(raw);
    if(!value||typeof value!=='object'||!Array.isArray(value.sources))return;
    const date=(input:unknown)=>typeof input==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(input)?input:'';
    return {sources:[...new Set<SourceId>(value.sources.filter((source:unknown):source is SourceId=>SOURCE_IDS.includes(source as SourceId)))],range:value.range===true,from:date(value.from),to:date(value.to)};
  }catch{return;}
}
export function readCollectionPreferences(demo:boolean):CollectionPreferences|undefined {
  try{return parseCollectionPreferences(localStorage.getItem(`skillharbor.collection.${demo?'demo':'personal'}`));}catch{return;}
}
export function saveCollectionPreferences(demo:boolean,value:CollectionPreferences):void {
  // Only source choices and dates. Never persist transcripts, consent or keys in browser storage.
  try{localStorage.setItem(`skillharbor.collection.${demo?'demo':'personal'}`,JSON.stringify(value));}catch{/* The workflow remains usable if UI storage is unavailable. */}
}
