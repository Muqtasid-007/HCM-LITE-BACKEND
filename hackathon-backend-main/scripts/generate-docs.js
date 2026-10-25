import { mkdirSync,writeFileSync } from 'node:fs';
// Schema generation does not connect to a database or call an AI provider.
process.env.MONGODB_URI ||= 'mongodb://localhost/docs';
process.env.JWT_SECRET ||= 'documentation-only-placeholder-secret';
const {openapi}=await import('../src/utils/openapi.js');
mkdirSync('docs',{recursive:true});writeFileSync('docs/openapi.json',JSON.stringify(openapi(),null,2)+'\n');console.log('Generated docs/openapi.json');
