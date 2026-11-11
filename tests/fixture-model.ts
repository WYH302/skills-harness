import { createServer } from 'node:http';
import { procedureSteps } from '../src/core/mining';

// Deterministic protocol fixture only. This is not an inference engine or a
// membership-usage demonstration, and must never ship as a production generator.
export async function fixtureModel(options:{beforeReply?:()=>Promise<void>;english?:boolean}={}){
  let calls=0;
  const server=createServer(async(req,res)=>{
    if(req.url==='/v1/models'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'deterministic-ui-fixture'}]}));return;}
    calls++;let body='';for await(const chunk of req)body+=chunk;
    const request=JSON.parse(body);const historical=JSON.parse(request.messages[1].content);const messages=historical.messages as {id:string;role:string;text:string}[];
    await options.beforeReply?.();
    const episodes=messages.filter(m=>m.role==='assistant'&&procedureSteps(m.text).length>=3).map(m=>{
      const prefix=m.id.split(':')[0];const users=messages.filter(u=>u.role==='user'&&u.id.startsWith(prefix+':'));
      const requirement=users.find(u=>/验收(?:标准|要求)/.test(u.text));const rubric=requirement?.text.split('\n').find(line=>/^验收(?:标准|要求)/.test(line));
      return {goal:options.english?'Evaluate open-source tools with evidence':(users[0]?.text.split('\n')[0]||'复用有依据的历史方法').slice(0,220),inputs:[options.english?'Repository and intended use':'当前任务与输入材料'],outputs:[options.english?'Evidence comparison and recommendation':'有原文依据的交付物'],steps:procedureSteps(m.text).map((text,i)=>({text:options.english?['Confirm user requirements and cost limits.','Read the repository documentation and license.','Separate claims from supported capabilities.','Compare setup and maintenance requirements.','Record recommendations and unverified capabilities.'][i%5]:text,messageId:m.id,quote:text})),preferences:[],corrections:[],quality:rubric?{rubric:{text:rubric,messageId:requirement!.id,quote:rubric},checks:[]}:null,outcome:'accepted',scope:'general'};
    });
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({episodes})}}],usage:{prompt_tokens:100,completion_tokens:100}}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {endpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,calls:()=>calls,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
