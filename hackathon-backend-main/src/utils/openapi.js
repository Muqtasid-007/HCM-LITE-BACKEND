import { z } from 'zod';
import { operations } from '../routes/index.js';
export function openapi() {
  const paths={};
  for(const op of operations) {
    const path=`/api/v1${op.path.replace(/:([\w]+)/g,'{$1}')}`,parameters=[];
    for(const match of op.path.matchAll(/:([\w]+)/g))parameters.push({name:match[1],in:'path',required:true,schema:{type:'string'}});
    let json;if(op.schema)json=z.toJSONSchema(op.schema,{unrepresentable:'any',io:'input'});
    if(op.query&&json?.properties)for(const [name,schema]of Object.entries(json.properties))parameters.push({name,in:'query',required:json.required?.includes(name)||false,schema});
    const binary=op.path.endsWith('/pdf')||op.path.endsWith('/export');
    paths[path]||={}; paths[path][op.method]={summary:op.summary,description:`Allowed roles: ${op.access==='public'?'public':op.access.join(', ')}. See docs/API.md for business semantics and response data.`,security:op.access==='public'?[]:[{bearerAuth:[]}],parameters,...(json&&!op.query&&{requestBody:{required:true,content:{'application/json':{schema:json}}}}),responses:{200:{description:'Success',content:{[binary?(op.path.endsWith('/pdf')?'application/pdf':'text/csv'):'application/json']:{schema:binary?{type:'string',format:'binary'}:{$ref:'#/components/schemas/Success'}}}},401:{description:'Authentication/session invalid'},403:{description:'Role, ownership or mandatory password restriction'},409:{description:'Duplicate or state conflict'},422:{description:'Validation or business rule failure',content:{'application/json':{schema:{$ref:'#/components/schemas/Failure'}}}}}};
  }
  return {openapi:'3.1.0',info:{title:'HCM Lite API',version:'1.0.0'},servers:[{url:'/'}],paths,components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer',bearerFormat:'JWT'}},schemas:{Success:{type:'object',required:['success','message','data'],properties:{success:{const:true},message:{type:'string'},data:{},meta:{type:'object'}}},Failure:{type:'object',required:['success','message'],properties:{success:{const:false},message:{type:'string'},errors:{type:'array',items:{type:'object'}},requestId:{type:'string'}}}}}};
}
